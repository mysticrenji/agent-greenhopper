import {
  type AlertState,
  DEFAULT_ALERT_POLICY,
  type Finding,
  planAlerts,
} from '@greenhopper/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertStateRepository } from './alertState.js';
import { createTestDatabase, type TestDatabase } from './testing/sqlite.js';

const NOON = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;

let database: TestDatabase;
let repo: AlertStateRepository;

beforeEach(() => {
  database = createTestDatabase();
  repo = new AlertStateRepository(database.d1);
});

afterEach(() => database.close());

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

describe('AlertStateRepository', () => {
  it('round-trips state without altering any field', async () => {
    // Any drift here silently breaks suppression, which fails in the worst
    // direction: a flood of duplicate notifications.
    const original = state();
    await repo.replaceForPlants(['monstera'], [original]);

    expect(await repo.loadAll()).toEqual([original]);
  });

  it('preserves a null lastNotifiedAt', async () => {
    // Distinguishes "seen but never reported" from "reported", which is what stops
    // a recovery notice for something the owner was never told about.
    await repo.replaceForPlants(['monstera'], [state({ lastNotifiedAt: null })]);

    expect((await repo.loadAll())[0]?.lastNotifiedAt).toBeNull();
  });

  it('stores multiple findings per plant independently', async () => {
    await repo.replaceForPlants(
      ['monstera'],
      [state(), state({ code: 'DLI_LOW', peakSeverity: 'critical' })],
    );

    const loaded = await repo.loadAll();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.code).sort()).toEqual(['DLI_LOW', 'MOISTURE_LOW']);
  });

  it('replaces only the named plants, leaving others untouched', async () => {
    // A run that handled some plants must not wipe the suppression history of the
    // rest, or unrelated conditions would re-alert as new.
    await repo.replaceForPlants(['monstera'], [state()]);
    await repo.replaceForPlants(['fern'], [state({ plantId: 'fern', code: 'BATTERY_LOW' })]);

    await repo.replaceForPlants(['monstera'], [state({ peakSeverity: 'critical' })]);

    const loaded = await repo.loadAll();
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.plantId === 'fern')?.code).toBe('BATTERY_LOW');
    expect(loaded.find((s) => s.plantId === 'monstera')?.peakSeverity).toBe('critical');
  });

  it('deletes rows for a plant whose conditions have all cleared', async () => {
    // This is how resolution is implemented: planAlerts omits cleared conditions
    // from nextStates, so their rows must disappear for a recurrence to read as new.
    await repo.replaceForPlants(['monstera'], [state()]);
    await repo.replaceForPlants(['monstera'], []);

    expect(await repo.loadAll()).toEqual([]);
  });

  it('ignores states belonging to plants outside the replace scope', async () => {
    await repo.replaceForPlants(['monstera'], [state(), state({ plantId: 'fern' })]);

    const loaded = await repo.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.plantId).toBe('monstera');
  });

  it('loads state for specific plants only', async () => {
    await repo.replaceForPlants(['monstera'], [state()]);
    await repo.replaceForPlants(['fern'], [state({ plantId: 'fern' })]);

    expect(await repo.loadForPlants(['fern'])).toHaveLength(1);
    expect(await repo.loadForPlants([])).toEqual([]);
  });

  it('treats replaceForPlants with no plants as a no-op', async () => {
    await repo.replaceForPlants(['monstera'], [state()]);
    await repo.replaceForPlants([], []);

    expect(await repo.loadAll()).toHaveLength(1);
  });
});

describe('integration with planAlerts', () => {
  const finding: Finding = {
    code: 'MOISTURE_LOW',
    severity: 'warn',
    message: 'Soil moisture 20% is below the target minimum.',
  };

  it('suppresses across a persisted round trip', async () => {
    // The behaviour that matters end to end: state survives storage, so the
    // second run stays quiet rather than repeating itself.
    const first = planAlerts({
      now: NOON,
      policy: DEFAULT_ALERT_POLICY,
      findingsByPlant: new Map([['monstera', [finding]]]),
      previousStates: [],
    });
    expect(first.actions[0]).toMatchObject({ kind: 'notify' });

    await repo.replaceForPlants(['monstera'], first.nextStates);

    const second = planAlerts({
      now: NOON + HOUR,
      policy: DEFAULT_ALERT_POLICY,
      findingsByPlant: new Map([['monstera', [finding]]]),
      previousStates: await repo.loadForPlants(['monstera']),
    });

    expect(second.actions[0]).toMatchObject({ kind: 'suppress', reason: 'within-interval' });
  });

  it('re-alerts as new after a resolution round trip', async () => {
    const first = planAlerts({
      now: NOON,
      policy: DEFAULT_ALERT_POLICY,
      findingsByPlant: new Map([['monstera', [finding]]]),
      previousStates: [],
    });
    await repo.replaceForPlants(['monstera'], first.nextStates);

    // Condition clears: state is dropped.
    const resolved = planAlerts({
      now: NOON + 2 * HOUR,
      policy: DEFAULT_ALERT_POLICY,
      findingsByPlant: new Map([['monstera', []]]),
      previousStates: await repo.loadForPlants(['monstera']),
    });
    expect(resolved.actions[0]).toMatchObject({ kind: 'resolve' });
    await repo.replaceForPlants(['monstera'], resolved.nextStates);
    expect(await repo.loadAll()).toEqual([]);

    // Recurrence must be treated as new, not suppressed.
    const recurrence = planAlerts({
      now: NOON + 3 * HOUR,
      policy: DEFAULT_ALERT_POLICY,
      findingsByPlant: new Map([['monstera', [finding]]]),
      previousStates: await repo.loadForPlants(['monstera']),
    });

    expect(recurrence.actions[0]).toMatchObject({ kind: 'notify', trigger: 'new' });
  });
});
