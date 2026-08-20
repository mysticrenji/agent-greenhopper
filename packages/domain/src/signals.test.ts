import { describe, expect, it } from 'vitest';
import type { Series } from './signals.js';
import {
  isPinnedAtRangeLimit,
  isPlausible,
  isStale,
  SIGNALS,
  STALENESS_BUDGET_MS,
} from './signals.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const MINUTE = 60_000;

describe('staleness budgets', () => {
  it('defines a budget and a plausible range for every signal', () => {
    for (const signal of SIGNALS) {
      expect(STALENESS_BUDGET_MS[signal]).toBeGreaterThan(0);
      expect(isPlausible(Number.NaN, signal)).toBe(false);
    }
  });

  it('gives battery a far longer budget than passive soil signals', () => {
    // Home Assistant reads Mi Flora battery over an active connection once a day,
    // so a soil-signal threshold would flag every healthy sensor.
    expect(STALENESS_BUDGET_MS.battery).toBeGreaterThan(STALENESS_BUDGET_MS.moisture * 100);
  });

  it('treats a 30m-old moisture reading as stale but the same battery reading as fresh', () => {
    const sample = { value: 42, at: NOW - 30 * MINUTE };
    expect(isStale(sample, 'moisture', NOW)).toBe(true);
    expect(isStale(sample, 'battery', NOW)).toBe(false);
  });
});

describe('isPlausible', () => {
  it('accepts values inside the physical range', () => {
    expect(isPlausible(0, 'moisture')).toBe(true);
    expect(isPlausible(100, 'moisture')).toBe(true);
    expect(isPlausible(1500, 'conductivity')).toBe(true);
  });

  it('rejects values outside it', () => {
    expect(isPlausible(-1, 'moisture')).toBe(false);
    expect(isPlausible(101, 'moisture')).toBe(false);
    expect(isPlausible(Number.POSITIVE_INFINITY, 'lux')).toBe(false);
  });
});

describe('isPinnedAtRangeLimit', () => {
  const pinned = (value: number, count: number): Series =>
    Array.from({ length: count }, (_, i) => ({ value, at: NOW - i * MINUTE }));

  it('flags a series stuck at either end of the range', () => {
    expect(isPinnedAtRangeLimit(pinned(0, 20), 'moisture')).toBe(true);
    expect(isPinnedAtRangeLimit(pinned(100, 20), 'moisture')).toBe(true);
  });

  it('does not flag plausible steady readings', () => {
    expect(isPinnedAtRangeLimit(pinned(35, 20), 'moisture')).toBe(false);
  });

  it('requires a minimum sample count so brief gaps do not trigger it', () => {
    expect(isPinnedAtRangeLimit(pinned(0, 3), 'moisture')).toBe(false);
  });
});
