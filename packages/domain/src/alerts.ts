/**
 * Alert policy.
 *
 * This is the heart of an alert-only system. The agent runs hourly, but a plant
 * that is too dry stays too dry for days — so naively notifying on every finding
 * would send the same message 24 times a day and train you to ignore it. Alert
 * fatigue, not missed detection, is the failure mode that kills monitoring
 * systems.
 *
 * The policy therefore decides, per (plant, finding) pair:
 *   - notify now,
 *   - stay quiet because you were told recently,
 *   - or announce that something previously reported has recovered.
 *
 * Pure and deterministic: the same inputs and stored state always produce the
 * same plan, which makes the behaviour testable without sending anything.
 */

import type { Finding, FindingCode, Severity } from './assess.js';
import { severityRank } from './assess.js';

/** Where a message goes. `digest` is batched into a daily summary. */
export type AlertChannel = 'push' | 'digest';

/**
 * Persisted state for one (plant, finding) pair. The agent loads these before a
 * run and saves the returned successors afterwards.
 */
export interface AlertState {
  readonly plantId: string;
  readonly code: FindingCode;
  /** When this condition was first observed in the current episode. */
  readonly firstSeenAt: number;
  /** When a message was last actually sent, or null if never. */
  readonly lastNotifiedAt: number | null;
  /** Worst severity seen during this episode, used to detect escalation. */
  readonly peakSeverity: Severity;
}

export interface AlertPolicy {
  /** Minimum gap before repeating a message about an unchanged condition. */
  readonly reNotifyIntervalMs: Readonly<Record<Severity, number>>;
  /** Findings below this severity go to the digest instead of a push. */
  readonly pushMinSeverity: Severity;
  /**
   * Local hours during which only critical findings may push. Half-open
   * interval [start, end); a wrapping range such as 22->7 is supported.
   */
  readonly quietHours: { readonly startHour: number; readonly endHour: number } | null;
  /** IANA time zone used to evaluate `quietHours`. */
  readonly timeZone: string;
}

export type AlertAction =
  | {
      readonly kind: 'notify';
      readonly plantId: string;
      readonly code: FindingCode;
      readonly channel: AlertChannel;
      readonly severity: Severity;
      readonly message: string;
      /** Why the policy allowed this through, for audit and debugging. */
      readonly trigger: 'new' | 'escalated' | 'reminder';
    }
  | {
      readonly kind: 'suppress';
      readonly plantId: string;
      readonly code: FindingCode;
      readonly reason: 'within-interval' | 'quiet-hours';
    }
  | {
      readonly kind: 'resolve';
      readonly plantId: string;
      readonly code: FindingCode;
      readonly channel: AlertChannel;
      readonly message: string;
    };

export interface AlertPlan {
  readonly actions: readonly AlertAction[];
  /** State to persist. Resolved conditions are absent, clearing their history. */
  readonly nextStates: readonly AlertState[];
}

const HOUR_MS = 3_600_000;

/**
 * Sensible defaults: critical conditions repeat daily, warnings every three
 * days, and informational findings never push. A plant problem takes days to
 * develop and days to fix, so hourly reminders carry no new information.
 *
 * `timeZone` is an IANA name rather than a fixed UTC offset so that quiet hours
 * follow local wall-clock time across daylight-saving transitions. Europe/Amsterdam
 * shifts between CET and CEST twice a year; a hard-coded +01:00 would silently
 * move quiet hours by an hour for half the year.
 */
export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  reNotifyIntervalMs: {
    critical: 24 * HOUR_MS,
    warn: 72 * HOUR_MS,
    info: 7 * 24 * HOUR_MS,
    ok: Number.POSITIVE_INFINITY,
  },
  pushMinSeverity: 'warn',
  quietHours: { startHour: 22, endHour: 7 },
  timeZone: 'Europe/Amsterdam',
};

export interface AlertInput {
  readonly now: number;
  readonly policy: AlertPolicy;
  /** Findings from the current run, keyed by plant. */
  readonly findingsByPlant: ReadonlyMap<string, readonly Finding[]>;
  /** Alert state persisted from previous runs. */
  readonly previousStates: readonly AlertState[];
}

/** Decide what to send, what to hold back, and what has recovered. */
export function planAlerts(input: AlertInput): AlertPlan {
  const previous = new Map(input.previousStates.map((s) => [key(s.plantId, s.code), s]));
  const actions: AlertAction[] = [];
  const nextStates: AlertState[] = [];
  const stillPresent = new Set<string>();

  for (const [plantId, findings] of input.findingsByPlant) {
    for (const finding of findings) {
      const stateKey = key(plantId, finding.code);
      stillPresent.add(stateKey);

      const outcome = evaluateFinding(plantId, finding, previous.get(stateKey), input);
      actions.push(outcome.action);
      nextStates.push(outcome.state);
    }
  }

  // Anything we previously reported that is now absent has recovered.
  for (const [stateKey, state] of previous) {
    if (stillPresent.has(stateKey)) continue;
    if (state.lastNotifiedAt === null) continue; // never told them, nothing to retract
    actions.push({
      kind: 'resolve',
      plantId: state.plantId,
      code: state.code,
      channel: 'push',
      message: `${state.plantId}: ${state.code} has cleared.`,
    });
  }

  return { actions, nextStates };
}

interface FindingOutcome {
  readonly action: AlertAction;
  readonly state: AlertState;
}

function evaluateFinding(
  plantId: string,
  finding: Finding,
  previous: AlertState | undefined,
  input: AlertInput,
): FindingOutcome {
  const { now, policy } = input;
  const trigger = classify(finding, previous, now, policy);

  if (trigger === null) {
    return {
      action: { kind: 'suppress', plantId, code: finding.code, reason: 'within-interval' },
      state: carryForward(plantId, finding, previous, now, false),
    };
  }

  const channel = chooseChannel(finding, policy, now);
  if (channel === null) {
    return {
      action: { kind: 'suppress', plantId, code: finding.code, reason: 'quiet-hours' },
      state: carryForward(plantId, finding, previous, now, false),
    };
  }

  return {
    action: {
      kind: 'notify',
      plantId,
      code: finding.code,
      channel,
      severity: finding.severity,
      message: finding.message,
      trigger,
    },
    state: carryForward(plantId, finding, previous, now, true),
  };
}

/** Returns why this finding may notify, or null if it should stay quiet. */
function classify(
  finding: Finding,
  previous: AlertState | undefined,
  now: number,
  policy: AlertPolicy,
): 'new' | 'escalated' | 'reminder' | null {
  if (!previous || previous.lastNotifiedAt === null) return 'new';

  // A condition getting worse is new information and overrides the interval.
  if (severityRank(finding.severity) > severityRank(previous.peakSeverity)) return 'escalated';

  const elapsed = now - previous.lastNotifiedAt;
  return elapsed >= policy.reNotifyIntervalMs[finding.severity] ? 'reminder' : null;
}

/**
 * Pick a delivery channel, or null when quiet hours block delivery entirely.
 * Critical findings always push — quiet hours must not hide a dying plant.
 */
function chooseChannel(finding: Finding, policy: AlertPolicy, now: number): AlertChannel | null {
  if (severityRank(finding.severity) < severityRank(policy.pushMinSeverity)) return 'digest';
  if (finding.severity === 'critical') return 'push';
  return inQuietHours(now, policy) ? null : 'push';
}

export function inQuietHours(now: number, policy: AlertPolicy): boolean {
  const { quietHours, timeZone } = policy;
  if (!quietHours) return false;

  const hour = localHour(now, timeZone);
  const { startHour, endHour } = quietHours;

  // A range such as 22->7 wraps past midnight.
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

function localHour(now: number, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date(now));
  // 'en-GB' renders midnight as '24'; normalise it.
  return Number.parseInt(formatted, 10) % 24;
}

function carryForward(
  plantId: string,
  finding: Finding,
  previous: AlertState | undefined,
  now: number,
  notified: boolean,
): AlertState {
  const peakSeverity =
    previous && severityRank(previous.peakSeverity) > severityRank(finding.severity)
      ? previous.peakSeverity
      : finding.severity;

  return {
    plantId,
    code: finding.code,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastNotifiedAt: notified ? now : (previous?.lastNotifiedAt ?? null),
    peakSeverity,
  };
}

function key(plantId: string, code: FindingCode): string {
  return `${plantId}::${code}`;
}
