import type { AlertAction } from '@greenhopper/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationLog } from './notifications.js';
import { createTestDatabase, type TestDatabase } from './testing/sqlite.js';

const NOON = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;

let database: TestDatabase;
let log: NotificationLog;

beforeEach(() => {
  database = createTestDatabase();
  log = new NotificationLog(database.d1);
});

afterEach(() => database.close());

const notify: AlertAction = {
  kind: 'notify',
  plantId: 'monstera',
  code: 'MOISTURE_LOW',
  channel: 'push',
  severity: 'warn',
  message: 'Soil moisture 20% is below the target minimum.',
  trigger: 'new',
};

const suppress: AlertAction = {
  kind: 'suppress',
  plantId: 'monstera',
  code: 'MOISTURE_LOW',
  reason: 'within-interval',
};

const resolve: AlertAction = {
  kind: 'resolve',
  plantId: 'fern',
  code: 'BATTERY_LOW',
  channel: 'push',
  message: 'fern: BATTERY_LOW has cleared.',
};

describe('NotificationLog.append', () => {
  it('records a sent notification with its full context', async () => {
    await log.append([notify], NOON);
    const [entry] = await log.recent();

    expect(entry).toMatchObject({
      at: NOON,
      plantId: 'monstera',
      code: 'MOISTURE_LOW',
      kind: 'notify',
      channel: 'push',
      severity: 'warn',
      trigger: 'new',
    });
  });

  it('records suppressions too', async () => {
    // The question this log exists to answer is "why was I never told?", which
    // requires the silences to be visible.
    await log.append([suppress], NOON);
    const [entry] = await log.recent();

    expect(entry).toMatchObject({ kind: 'suppress', trigger: 'within-interval', channel: null });
    expect(entry?.message).toContain('within-interval');
  });

  it('records resolutions', async () => {
    await log.append([resolve], NOON);
    const [entry] = await log.recent();

    expect(entry).toMatchObject({ kind: 'resolve', plantId: 'fern', trigger: 'resolved' });
  });

  it('handles a mixed batch from one planning run', async () => {
    await log.append([notify, suppress, resolve], NOON);
    expect(await log.recent()).toHaveLength(3);
  });

  it('accepts an empty batch', async () => {
    expect(await log.append([], NOON)).toBe(0);
    expect(await log.recent()).toEqual([]);
  });

  it('assigns increasing ids so ordering within a timestamp is stable', async () => {
    await log.append([notify, suppress], NOON);
    const entries = await log.recent();

    expect(entries[0]?.id).toBeGreaterThan(entries[1]?.id ?? 0);
  });
});

describe('NotificationLog queries', () => {
  beforeEach(async () => {
    await log.append([notify], NOON - 2 * HOUR);
    await log.append([suppress], NOON - HOUR);
    await log.append([resolve], NOON);
  });

  it('returns entries newest first', async () => {
    const entries = await log.recent();
    expect(entries.map((e) => e.kind)).toEqual(['resolve', 'suppress', 'notify']);
  });

  it('honours the limit', async () => {
    expect(await log.recent(2)).toHaveLength(2);
  });

  it('filters by plant', async () => {
    const entries = await log.forPlant('monstera');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.plantId === 'monstera')).toBe(true);
  });

  it('counts by kind, which is how an alert storm becomes visible', async () => {
    const counts = await log.countsSince(NOON - 3 * HOUR);
    expect(counts).toEqual({ notify: 1, suppress: 1, resolve: 1 });
  });

  it('respects the since bound when counting', async () => {
    expect(await log.countsSince(NOON)).toEqual({ resolve: 1 });
  });

  it('prunes entries older than a cutoff', async () => {
    await log.pruneBefore(NOON - HOUR);
    const entries = await log.recent();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(['resolve', 'suppress']);
  });
});
