/**
 * Watering guardrails.
 *
 * STATUS: DORMANT. This deployment is alert-only — there is no pump, no actuation
 * path, and this module is deliberately NOT exported from `src/index.ts`. It is
 * retained, tested, and kept correct so that adding actuation later is a wiring
 * change rather than a from-scratch design of safety logic. See ADR 0003.
 *
 * If you are adding actuation: export this from `index.ts`, call it from the
 * composition root immediately before any switch is toggled, and never let a
 * model decide the duration.
 *
 * Every constraint here is enforced in code that the reasoning layer cannot route
 * around. The failure this prevents is not a large bill; it is a loop that waters
 * a plant two hundred times and drowns it.
 *
 * Design rules for anything added here:
 *   1. Deny by default. An unrecognised state must not permit watering.
 *   2. Never water on absent, stale or implausible moisture data. Watering blind
 *      is worse than not watering.
 *   3. Decisions are pure and reproducible: same inputs, same outcome.
 */

import type { WateringPolicy } from './plant.js';
import type { Sample } from './signals.js';
import { isPlausible, isStale } from './signals.js';

export type DenialCode =
  | 'KILL_SWITCH_ENGAGED'
  | 'COOLDOWN_ACTIVE'
  | 'DAILY_LIMIT_REACHED'
  | 'MOISTURE_ABOVE_CEILING'
  | 'MOISTURE_DATA_MISSING'
  | 'MOISTURE_DATA_STALE'
  | 'MOISTURE_DATA_IMPLAUSIBLE'
  | 'SENSOR_FAULT_PRESENT'
  | 'INVALID_DURATION';

export interface WateringRequest {
  readonly plantId: string;
  readonly seconds: number;
  /** When true the decision is evaluated but no actuation should follow. */
  readonly dryRun: boolean;
}

export interface WateringContext {
  readonly now: number;
  readonly policy: WateringPolicy;
  /** Most recent moisture sample, or null when none is available. */
  readonly moisture: Sample | null;
  /** Unix ms timestamps of waterings already performed, most recent last. */
  readonly wateringHistory: readonly number[];
  /** Global stop, held outside the reasoning path (for example, in KV). */
  readonly killSwitchEngaged: boolean;
  /** True when sensor health checks reported a fault for this plant. */
  readonly sensorFault: boolean;
}

export type WateringDecision =
  | {
      readonly allowed: true;
      /** Duration to actually run, clamped to the policy maximum. */
      readonly seconds: number;
      readonly dryRun: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: DenialCode;
      readonly reason: string;
    };

const MS_PER_HOUR = 3_600_000;
const ROLLING_DAY_MS = 86_400_000;

/**
 * Decide whether a watering request may proceed.
 *
 * Checks run cheapest-and-most-absolute first so that the returned denial names
 * the most fundamental reason rather than an incidental one.
 */
export function evaluateWatering(
  request: WateringRequest,
  context: WateringContext,
): WateringDecision {
  const { policy, now } = context;

  if (context.killSwitchEngaged) {
    return deny('KILL_SWITCH_ENGAGED', 'The global watering kill switch is engaged.');
  }

  if (!Number.isInteger(request.seconds) || request.seconds <= 0) {
    return deny(
      'INVALID_DURATION',
      `Requested duration must be a positive whole number of seconds, got ${request.seconds}.`,
    );
  }

  if (context.sensorFault) {
    return deny(
      'SENSOR_FAULT_PRESENT',
      'A sensor fault is present for this plant; refusing to water on untrusted data.',
    );
  }

  const moistureDenial = checkMoisture(context);
  if (moistureDenial) return moistureDenial;

  const lastWatered = context.wateringHistory.at(-1);
  if (lastWatered !== undefined) {
    const elapsedHours = (now - lastWatered) / MS_PER_HOUR;
    if (elapsedHours < policy.minIntervalHours) {
      const remaining = (policy.minIntervalHours - elapsedHours).toFixed(1);
      return deny(
        'COOLDOWN_ACTIVE',
        `Watered ${elapsedHours.toFixed(1)}h ago; ${remaining}h of cooldown remain.`,
      );
    }
  }

  const runsToday = context.wateringHistory.filter((t) => now - t < ROLLING_DAY_MS).length;
  if (runsToday >= policy.maxRunsPerDay) {
    return deny(
      'DAILY_LIMIT_REACHED',
      `Already watered ${runsToday} time(s) in the last 24h (limit ${policy.maxRunsPerDay}).`,
    );
  }

  return {
    allowed: true,
    seconds: Math.min(request.seconds, policy.maxSeconds),
    dryRun: request.dryRun,
  };
}

function checkMoisture(context: WateringContext): WateringDecision | null {
  const { moisture, policy, now } = context;

  if (!moisture) {
    return deny('MOISTURE_DATA_MISSING', 'No moisture reading available; refusing to water blind.');
  }
  if (!isPlausible(moisture.value, 'moisture')) {
    return deny(
      'MOISTURE_DATA_IMPLAUSIBLE',
      `Moisture reading ${moisture.value}% is outside the possible range.`,
    );
  }
  if (isStale(moisture, 'moisture', now)) {
    const ageMinutes = Math.round((now - moisture.at) / 60_000);
    return deny(
      'MOISTURE_DATA_STALE',
      `Moisture reading is ${ageMinutes}m old; refusing to water on stale data.`,
    );
  }
  if (moisture.value >= policy.moistureCeiling) {
    return deny(
      'MOISTURE_ABOVE_CEILING',
      `Moisture ${moisture.value}% is at or above the ${policy.moistureCeiling}% ceiling.`,
    );
  }
  return null;
}

function deny(code: DenialCode, reason: string): WateringDecision {
  return { allowed: false, code, reason };
}
