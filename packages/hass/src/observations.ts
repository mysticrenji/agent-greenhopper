/**
 * Assembles the domain's `PlantObservation` from Home Assistant data.
 *
 * This is the seam between adapter and domain: everything Home-Assistant-shaped
 * stops here, and what continues inward is plain numbers and timestamps.
 */

import type {
  ConductivityReading,
  PlantObservation,
  PlantProfile,
  Series,
} from '@greenhopper/domain';
import { latest } from '@greenhopper/domain';
import type { PlantEntities } from './entities.js';

export interface ObservationSources {
  readonly profile: PlantProfile;
  readonly entities: PlantEntities;
  /** Series keyed by entity ID, as returned by `HassReader.history`. */
  readonly history: ReadonlyMap<string, Series>;
  readonly now: number;
}

const EMPTY: Series = [];

/** Conductivity and moisture must be sampled within this window to be paired. */
const PAIRING_TOLERANCE_MS = 5 * 60_000;

/** A moisture rise of at least this many points implies the plant was watered. */
const WATERING_RISE_PCT = 8;

type ReadingUnit = '%' | 'C' | 'lx' | 'uS/cm';

export interface CurrentReading<Unit extends ReadingUnit> {
  readonly value: number;
  readonly unit: Unit;
  readonly observedAt: number;
  readonly ageMinutes: number;
}

export interface CurrentReadings {
  readonly moisture: CurrentReading<'%'> | null;
  readonly soilTemperature: CurrentReading<'C'> | null;
  readonly illuminance: CurrentReading<'lx'> | null;
  readonly conductivity: CurrentReading<'uS/cm'> | null;
  readonly battery: CurrentReading<'%'> | null;
  readonly airTemperature: CurrentReading<'C'> | null;
  readonly humidity: CurrentReading<'%'> | null;
}

export function buildObservation(sources: ObservationSources): PlantObservation {
  const { entities, history, profile, now } = sources;
  const series = (entityId: string): Series => history.get(entityId) ?? EMPTY;

  const moisture = series(entities.moisture);
  const conductivity = series(entities.conductivity);

  return {
    profile,
    now,
    moisture,
    soilTemp: series(entities.soilTemp),
    lux: series(entities.lux),
    conductivity,
    ...(entities.battery ? { battery: series(entities.battery) } : {}),
    airTemp: series(entities.airTemp),
    humidity: series(entities.humidity),
    pairedConductivity: pairConductivityWithMoisture(conductivity, moisture),
    lastWateredAt: inferLastWatering(moisture),
  };
}

/** Raw latest values, kept separate from derived metrics so app readings remain comparable. */
export function currentReadings(observation: PlantObservation): CurrentReadings {
  return {
    moisture: currentReading(observation.moisture, '%', observation.now),
    soilTemperature: currentReading(observation.soilTemp, 'C', observation.now),
    illuminance: currentReading(observation.lux, 'lx', observation.now),
    conductivity: currentReading(observation.conductivity, 'uS/cm', observation.now),
    battery: currentReading(observation.battery ?? EMPTY, '%', observation.now),
    airTemperature: currentReading(observation.airTemp, 'C', observation.now),
    humidity: currentReading(observation.humidity, '%', observation.now),
  };
}

function currentReading<Unit extends ReadingUnit>(
  series: Series,
  unit: Unit,
  now: number,
): CurrentReading<Unit> | null {
  const sample = latest(series);
  if (!sample) return null;
  return {
    value: sample.value,
    unit,
    observedAt: sample.at,
    ageMinutes: Math.max(0, Math.round((now - sample.at) / 60_000)),
  };
}

/**
 * Pair each conductivity reading with the moisture reading taken closest in time.
 *
 * Required because a conductivity probe measures the conductivity of soil *water*,
 * so a reading is only interpretable alongside the water content at that moment.
 * Readings with no nearby moisture sample are dropped rather than paired with a
 * distant one, since a stale pairing would reintroduce the very confound this
 * exists to remove.
 */
export function pairConductivityWithMoisture(
  conductivity: Series,
  moisture: Series,
  toleranceMs = PAIRING_TOLERANCE_MS,
): ConductivityReading[] {
  if (moisture.length === 0) return [];

  const paired: ConductivityReading[] = [];
  let moistureIndex = 0;

  for (const ec of conductivity) {
    while (moistureIndex + 1 < moisture.length) {
      const current = moisture[moistureIndex];
      const next = moisture[moistureIndex + 1];
      if (!current || !next || Math.abs(next.at - ec.at) >= Math.abs(current.at - ec.at)) break;
      moistureIndex += 1;
    }
    const nearest = moisture[moistureIndex];
    if (!nearest || Math.abs(nearest.at - ec.at) > toleranceMs) continue;
    paired.push({ conductivity: ec.value, moisture: nearest.value, at: ec.at });
  }

  return paired;
}

/**
 * Infer when the plant was last watered from a sharp rise in soil moisture.
 *
 * Necessary because this system does not water plants (ADR 0003), so no watering
 * is ever recorded — a human does it, unannounced. A jump of several points inside
 * one sampling interval has no other plausible cause for an indoor pot.
 *
 * Known limitation: a completely dead probe reports no rise, so no watering is
 * inferred and the probe-response check in `assess()` cannot fire. Detecting that
 * case needs a different signal (a flat line over many hours), which is tracked
 * separately — this function is not a substitute for it.
 */
export function inferLastWatering(moisture: Series, minRise = WATERING_RISE_PCT): number | null {
  let lastWateredAt: number | null = null;

  for (let i = 1; i < moisture.length; i += 1) {
    const previous = moisture[i - 1];
    const current = moisture[i];
    if (!previous || !current) continue;

    if (current.value - previous.value >= minRise) lastWateredAt = current.at;
  }

  return lastWateredAt;
}
