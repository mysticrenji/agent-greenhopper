import { describe, expect, it } from 'vitest';
import type { AlertAction, AlertInput, AlertPolicy, AlertState } from './alerts.js';
import { DEFAULT_ALERT_POLICY, inQuietHours, planAlerts } from './alerts.js';
import type { Finding, FindingCode, Severity } from './assess.js';

const HOUR = 3_600_000;
/** 2026-06-15T12:00:00Z — midday UTC, comfortably outside default quiet hours. */
const NOON = Date.UTC(2026, 5, 15, 12, 0, 0);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    code: 'MOISTURE_LOW',
    severity: 'warn',
    message: 'Soil moisture 20% is below the target minimum.',
    ...overrides,
  };
}

function state(overrides: Partial<AlertState> = {}): AlertState {
  return {
    plantId: 'monstera',
    code: 'MOISTURE_LOW',
    firstSeenAt: NOON - 10 * HOUR,
    lastNotifiedAt: NOON - 10 * HOUR,
    peakSeverity: 'warn',
    ...overrides,
  };
}

function input(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    now: NOON,
    policy: DEFAULT_ALERT_POLICY,
    findingsByPlant: new Map([['monstera', [finding()]]]),
    previousStates: [],
    ...overrides,
  };
}

const kinds = (actions: readonly AlertAction[]) => actions.map((a) => a.kind);

describe('planAlerts — first occurrence', () => {
  it('notifies on a newly observed warning', () => {
    const { actions } = planAlerts(input());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'notify',
      plantId: 'monstera',
      code: 'MOISTURE_LOW',
      channel: 'push',
      trigger: 'new',
    });
  });

  it('records state so the next run can suppress', () => {
    const { nextStates } = planAlerts(input());
    expect(nextStates).toEqual([
      {
        plantId: 'monstera',
        code: 'MOISTURE_LOW',
        firstSeenAt: NOON,
        lastNotifiedAt: NOON,
        peakSeverity: 'warn',
      },
    ]);
  });

  it('routes info findings to the digest rather than pushing', () => {
    const info = finding({ code: 'AIR_SENSOR_MISSING', severity: 'info' });
    const { actions } = planAlerts(input({ findingsByPlant: new Map([['monstera', [info]]]) }));
    expect(actions[0]).toMatchObject({ kind: 'notify', channel: 'digest' });
  });
});

describe('planAlerts — suppression', () => {
  it('stays quiet about an unchanged warning inside the re-notify interval', () => {
    // Told 10h ago; the warn interval is 72h.
    const { actions } = planAlerts(input({ previousStates: [state()] }));
    expect(actions[0]).toMatchObject({ kind: 'suppress', reason: 'within-interval' });
  });

  it('reminds once the interval has elapsed', () => {
    const old = state({ lastNotifiedAt: NOON - 80 * HOUR });
    const { actions } = planAlerts(input({ previousStates: [old] }));
    expect(actions[0]).toMatchObject({ kind: 'notify', trigger: 'reminder' });
  });

  it('preserves the original firstSeenAt across a suppressed run', () => {
    const previous = state();
    const { nextStates } = planAlerts(input({ previousStates: [previous] }));
    expect(nextStates[0]?.firstSeenAt).toBe(previous.firstSeenAt);
    expect(nextStates[0]?.lastNotifiedAt).toBe(previous.lastNotifiedAt);
  });

  it('does not let 24 hourly runs produce 24 notifications', () => {
    // The behaviour the whole module exists for.
    let previousStates: readonly AlertState[] = [];
    let notifications = 0;

    for (let hour = 0; hour < 24; hour += 1) {
      const plan = planAlerts(input({ now: NOON + hour * HOUR, previousStates }));
      notifications += plan.actions.filter((a) => a.kind === 'notify').length;
      previousStates = plan.nextStates;
    }

    expect(notifications).toBe(1);
  });
});

describe('planAlerts — escalation', () => {
  it('notifies immediately when severity worsens, ignoring the interval', () => {
    const worse = finding({ severity: 'critical', message: 'Soil moisture 10% is critical.' });
    const { actions } = planAlerts(
      input({
        findingsByPlant: new Map([['monstera', [worse]]]),
        previousStates: [state()],
      }),
    );
    expect(actions[0]).toMatchObject({ kind: 'notify', trigger: 'escalated', channel: 'push' });
  });

  it('does not re-escalate on a subsequent run at the same severity', () => {
    const critical = finding({ severity: 'critical' });
    const first = planAlerts(
      input({
        findingsByPlant: new Map([['monstera', [critical]]]),
        previousStates: [state()],
      }),
    );
    const second = planAlerts(
      input({
        now: NOON + HOUR,
        findingsByPlant: new Map([['monstera', [critical]]]),
        previousStates: first.nextStates,
      }),
    );
    expect(second.actions[0]).toMatchObject({ kind: 'suppress' });
  });

  it('remembers peak severity so an improvement does not re-trigger', () => {
    const critical = finding({ severity: 'critical' });
    const escalated = planAlerts(input({ findingsByPlant: new Map([['monstera', [critical]]]) }));
    // Condition improves to warn but is still present: no new notification.
    const improved = planAlerts(
      input({
        now: NOON + HOUR,
        findingsByPlant: new Map([['monstera', [finding()]]]),
        previousStates: escalated.nextStates,
      }),
    );
    expect(improved.actions[0]).toMatchObject({ kind: 'suppress' });
    expect(improved.nextStates[0]?.peakSeverity).toBe('critical');
  });
});

describe('planAlerts — resolution', () => {
  it('announces recovery when a reported condition disappears', () => {
    const { actions } = planAlerts(
      input({
        findingsByPlant: new Map([['monstera', []]]),
        previousStates: [state()],
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'resolve', code: 'MOISTURE_LOW' });
  });

  it('clears state on resolution so a recurrence alerts as new', () => {
    const { nextStates } = planAlerts(
      input({ findingsByPlant: new Map([['monstera', []]]), previousStates: [state()] }),
    );
    expect(nextStates).toEqual([]);
  });

  it('does not announce recovery for something never reported', () => {
    // Suppressed by quiet hours or digest policy and then cleared: stay silent.
    const unreported = state({ lastNotifiedAt: null });
    const { actions } = planAlerts(
      input({ findingsByPlant: new Map([['monstera', []]]), previousStates: [unreported] }),
    );
    expect(actions).toEqual([]);
  });
});

describe('quiet hours', () => {
  const policy: AlertPolicy = {
    ...DEFAULT_ALERT_POLICY,
    timeZone: 'UTC',
    quietHours: { startHour: 22, endHour: 7 },
  };
  const at = (hour: number) => Date.UTC(2026, 5, 15, hour, 0, 0);
  it('recognises a range that wraps past midnight', () => {
    expect(inQuietHours(at(23), policy)).toBe(true);
    expect(inQuietHours(at(3), policy)).toBe(true);
    expect(inQuietHours(at(12), policy)).toBe(false);
  });

  it('treats the boundaries as a half-open interval', () => {
    expect(inQuietHours(at(22), policy)).toBe(true);
    expect(inQuietHours(at(7), policy)).toBe(false);
  });

  it('handles a non-wrapping range', () => {
    const daytime: AlertPolicy = { ...policy, quietHours: { startHour: 9, endHour: 17 } };
    expect(inQuietHours(at(12), daytime)).toBe(true);
    expect(inQuietHours(at(20), daytime)).toBe(false);
  });

  it('is disabled when no range is configured', () => {
    expect(inQuietHours(at(3), { ...policy, quietHours: null })).toBe(false);
  });

  it('respects the configured time zone', () => {
    // 03:00 UTC is 12:00 in Tokyo, which is outside quiet hours there.
    expect(inQuietHours(at(3), { ...policy, timeZone: 'Asia/Tokyo' })).toBe(false);
  });

  it('suppresses a warning during quiet hours', () => {
    const { actions } = planAlerts(input({ now: at(23), policy }));
    expect(actions[0]).toMatchObject({ kind: 'suppress', reason: 'quiet-hours' });
  });

  it('still pushes critical findings during quiet hours', () => {
    // Quiet hours must never hide a dying plant.
    const critical = finding({ severity: 'critical' });
    const { actions } = planAlerts(
      input({ now: at(23), policy, findingsByPlant: new Map([['monstera', [critical]]]) }),
    );
    expect(actions[0]).toMatchObject({ kind: 'notify', channel: 'push' });
  });
});

describe('planAlerts — multiple plants and findings', () => {
  it('tracks each (plant, finding) pair independently', () => {
    const findings = new Map<string, readonly Finding[]>([
      ['monstera', [finding(), finding({ code: 'DLI_LOW', message: 'Not enough light.' })]],
      ['fern', [finding({ code: 'BATTERY_LOW', message: 'Battery at 8%.' })]],
    ]);
    const { actions, nextStates } = planAlerts(input({ findingsByPlant: findings }));

    expect(kinds(actions)).toEqual(['notify', 'notify', 'notify']);
    expect(nextStates).toHaveLength(3);
    expect(new Set(nextStates.map((s) => s.plantId))).toEqual(new Set(['monstera', 'fern']));
  });

  it('suppresses one finding while notifying another on the same plant', () => {
    const findings = new Map<string, readonly Finding[]>([
      ['monstera', [finding(), finding({ code: 'DLI_LOW' as FindingCode, message: 'Dark.' })]],
    ]);
    const { actions } = planAlerts(input({ findingsByPlant: findings, previousStates: [state()] }));
    expect(kinds(actions)).toEqual(['suppress', 'notify']);
  });

  it('produces no actions when nothing is wrong', () => {
    const plan = planAlerts(input({ findingsByPlant: new Map([['monstera', []]]) }));
    expect(plan.actions).toEqual([]);
    expect(plan.nextStates).toEqual([]);
  });
});

describe('DEFAULT_ALERT_POLICY', () => {
  it('repeats critical findings more often than warnings', () => {
    const { reNotifyIntervalMs } = DEFAULT_ALERT_POLICY;
    const order: Severity[] = ['critical', 'warn', 'info'];
    for (let i = 1; i < order.length; i += 1) {
      const previous = order[i - 1] as Severity;
      const current = order[i] as Severity;
      expect(reNotifyIntervalMs[previous]).toBeLessThan(reNotifyIntervalMs[current]);
    }
  });

  it('uses an IANA zone so quiet hours survive daylight saving', () => {
    // 21:30 UTC is 23:30 in Amsterdam during CEST (summer) and 22:30 during CET
    // (winter). Both are inside 22:00-07:00 local, which a fixed offset would
    // get wrong for half the year.
    expect(DEFAULT_ALERT_POLICY.timeZone).toBe('Europe/Amsterdam');

    const summerNight = Date.UTC(2026, 6, 15, 21, 30); // July, CEST (+02:00)
    const winterNight = Date.UTC(2026, 0, 15, 21, 30); // January, CET (+01:00)
    expect(inQuietHours(summerNight, DEFAULT_ALERT_POLICY)).toBe(true);
    expect(inQuietHours(winterNight, DEFAULT_ALERT_POLICY)).toBe(true);

    // 20:30 UTC is 22:30 local in summer (quiet) but 21:30 in winter (not quiet).
    const summerEdge = Date.UTC(2026, 6, 15, 20, 30);
    const winterEdge = Date.UTC(2026, 0, 15, 20, 30);
    expect(inQuietHours(summerEdge, DEFAULT_ALERT_POLICY)).toBe(true);
    expect(inQuietHours(winterEdge, DEFAULT_ALERT_POLICY)).toBe(false);
  });
});
