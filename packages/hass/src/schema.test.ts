import { describe, expect, it } from 'vitest';
import { isAbsent, toSample } from './schema.js';

describe('isAbsent', () => {
  it('recognises every Home Assistant "no value" sentinel', () => {
    // A BLE sensor sits in these states routinely between advertisements.
    for (const state of ['unavailable', 'unknown', 'none', '', '  ', 'UNAVAILABLE']) {
      expect(isAbsent(state)).toBe(true);
    }
  });

  it('does not treat a real reading as absent', () => {
    for (const state of ['0', '35.2', '-1.5']) {
      expect(isAbsent(state)).toBe(false);
    }
  });
});

describe('toSample', () => {
  it('parses a numeric state with its timestamp', () => {
    expect(toSample({ state: '35.2', last_updated: '2026-06-15T12:00:00+00:00' })).toEqual({
      value: 35.2,
      at: Date.UTC(2026, 5, 15, 12),
    });
  });

  it('uses last_reported so unchanged sensor values remain fresh', () => {
    expect(
      toSample({
        state: '38',
        last_reported: '2026-06-15T12:05:00Z',
        last_updated: '2026-06-15T10:00:00Z',
        last_changed: '2026-06-15T09:00:00Z',
      }),
    ).toEqual({ value: 38, at: Date.UTC(2026, 5, 15, 12, 5) });
  });

  it('accepts zero, which is a legitimate reading', () => {
    // Conductivity reads ~0 in bone-dry soil; dropping it would hide real data.
    expect(toSample({ state: '0', last_updated: '2026-06-15T12:00:00Z' })).toEqual({
      value: 0,
      at: Date.UTC(2026, 5, 15, 12),
    });
  });

  it('falls back to last_changed when last_updated is absent', () => {
    expect(toSample({ state: '21', last_changed: '2026-06-15T12:00:00Z' })).toEqual({
      value: 21,
      at: Date.UTC(2026, 5, 15, 12),
    });
  });

  it('returns null rather than throwing for absent states', () => {
    expect(toSample({ state: 'unavailable', last_updated: '2026-06-15T12:00:00Z' })).toBeNull();
  });

  it('returns null for non-numeric states', () => {
    expect(toSample({ state: 'on', last_updated: '2026-06-15T12:00:00Z' })).toBeNull();
  });

  it('returns null when no timestamp is present', () => {
    expect(toSample({ state: '35' })).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(toSample({ state: '35', last_updated: 'not-a-date' })).toBeNull();
  });
});
