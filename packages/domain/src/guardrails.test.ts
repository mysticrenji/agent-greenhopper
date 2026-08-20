import { describe, expect, it } from 'vitest';
import type { WateringContext, WateringRequest } from './guardrails.js';
import { evaluateWatering } from './guardrails.js';
import { DEFAULT_WATERING_POLICY } from './plant.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;

function request(overrides: Partial<WateringRequest> = {}): WateringRequest {
  return { plantId: 'monstera', seconds: 10, dryRun: false, ...overrides };
}

/** A context in which watering is permitted, so each test varies one thing. */
function context(overrides: Partial<WateringContext> = {}): WateringContext {
  return {
    now: NOW,
    policy: DEFAULT_WATERING_POLICY,
    moisture: { value: 18, at: NOW - 60_000 },
    wateringHistory: [],
    killSwitchEngaged: false,
    sensorFault: false,
    ...overrides,
  };
}

describe('evaluateWatering', () => {
  it('allows a well-formed request in a healthy context', () => {
    const decision = evaluateWatering(request(), context());
    expect(decision).toEqual({ allowed: true, seconds: 10, dryRun: false });
  });

  it('clamps duration to the policy maximum', () => {
    const decision = evaluateWatering(request({ seconds: 9999 }), context());
    expect(decision).toMatchObject({ allowed: true, seconds: DEFAULT_WATERING_POLICY.maxSeconds });
  });

  it('preserves the dry-run flag so callers cannot lose it', () => {
    const decision = evaluateWatering(request({ dryRun: true }), context());
    expect(decision).toMatchObject({ allowed: true, dryRun: true });
  });

  describe('absolute stops', () => {
    it('denies when the kill switch is engaged, before anything else', () => {
      // Kill switch must win even when every other input is also invalid.
      const decision = evaluateWatering(
        request({ seconds: -5 }),
        context({ killSwitchEngaged: true, moisture: null, sensorFault: true }),
      );
      expect(decision).toMatchObject({ allowed: false, code: 'KILL_SWITCH_ENGAGED' });
    });

    it('denies a non-positive or fractional duration', () => {
      for (const seconds of [0, -1, 2.5]) {
        expect(evaluateWatering(request({ seconds }), context())).toMatchObject({
          allowed: false,
          code: 'INVALID_DURATION',
        });
      }
    });

    it('denies when a sensor fault is present', () => {
      expect(evaluateWatering(request(), context({ sensorFault: true }))).toMatchObject({
        allowed: false,
        code: 'SENSOR_FAULT_PRESENT',
      });
    });
  });

  describe('never waters blind', () => {
    it('denies when moisture data is missing', () => {
      expect(evaluateWatering(request(), context({ moisture: null }))).toMatchObject({
        allowed: false,
        code: 'MOISTURE_DATA_MISSING',
      });
    });

    it('denies when the moisture reading is stale', () => {
      const stale = { value: 18, at: NOW - 60 * 60_000 };
      expect(evaluateWatering(request(), context({ moisture: stale }))).toMatchObject({
        allowed: false,
        code: 'MOISTURE_DATA_STALE',
      });
    });

    it('denies when the moisture reading is physically impossible', () => {
      const bad = { value: 137, at: NOW - 60_000 };
      expect(evaluateWatering(request(), context({ moisture: bad }))).toMatchObject({
        allowed: false,
        code: 'MOISTURE_DATA_IMPLAUSIBLE',
      });
    });

    it('denies when soil is already at or above the ceiling', () => {
      const wet = { value: DEFAULT_WATERING_POLICY.moistureCeiling, at: NOW - 60_000 };
      expect(evaluateWatering(request(), context({ moisture: wet }))).toMatchObject({
        allowed: false,
        code: 'MOISTURE_ABOVE_CEILING',
      });
    });
  });

  describe('rate limiting', () => {
    it('denies inside the cooldown window', () => {
      const recent = NOW - 2 * HOUR;
      const decision = evaluateWatering(request(), context({ wateringHistory: [recent] }));
      expect(decision).toMatchObject({ allowed: false, code: 'COOLDOWN_ACTIVE' });
    });

    it('allows once the cooldown has elapsed', () => {
      const old = NOW - (DEFAULT_WATERING_POLICY.minIntervalHours + 1) * HOUR;
      expect(evaluateWatering(request(), context({ wateringHistory: [old] }))).toMatchObject({
        allowed: true,
      });
    });

    it('denies once the rolling 24h run limit is reached', () => {
      // Both runs are inside 24h but outside the cooldown, isolating the daily cap.
      const policy = { ...DEFAULT_WATERING_POLICY, minIntervalHours: 1, maxRunsPerDay: 2 };
      const history = [NOW - 20 * HOUR, NOW - 10 * HOUR];
      expect(
        evaluateWatering(request(), context({ policy, wateringHistory: history })),
      ).toMatchObject({ allowed: false, code: 'DAILY_LIMIT_REACHED' });
    });

    it('ignores runs older than 24h when counting the daily limit', () => {
      const policy = { ...DEFAULT_WATERING_POLICY, minIntervalHours: 1, maxRunsPerDay: 2 };
      const history = [NOW - 40 * HOUR, NOW - 30 * HOUR, NOW - 10 * HOUR];
      expect(
        evaluateWatering(request(), context({ policy, wateringHistory: history })),
      ).toMatchObject({ allowed: true });
    });
  });

  it('is deterministic for identical inputs', () => {
    const req = request();
    const ctx = context();
    expect(evaluateWatering(req, ctx)).toEqual(evaluateWatering(req, ctx));
  });
});
