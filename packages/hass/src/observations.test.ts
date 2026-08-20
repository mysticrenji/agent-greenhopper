import { DEFAULT_WATERING_POLICY, type PlantProfile, type Series } from '@greenhopper/domain';
import { describe, expect, it } from 'vitest';
import { miFloraEntities } from './entities.js';
import {
  buildObservation,
  inferLastWatering,
  pairConductivityWithMoisture,
} from './observations.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 15, 6, 0, 0);

const PROFILE: PlantProfile = {
  id: 'monstera',
  name: 'Monstera',
  species: 'Monstera deliciosa',
  room: 'living-room',
  targets: {
    moisture: { min: 25, max: 45 },
    soilTemp: { min: 16, max: 28 },
    dli: { min: 2, max: 12 },
    vpd: { min: 0.4, max: 1.4 },
    conductivity: { min: 300, max: 1500 },
  },
  watering: DEFAULT_WATERING_POLICY,
};

const ENTITIES = miFloraEntities({
  plantId: 'monstera',
  deviceSlug: 'monstera_fc',
  airSensorSlug: 'lr_climate',
});

function series(values: readonly number[], stepMs = HOUR, start = T0): Series {
  return values.map((value, i) => ({ value, at: start + i * stepMs }));
}

describe('pairConductivityWithMoisture', () => {
  it('pairs each reading with the nearest moisture sample', () => {
    const conductivity = series([800, 810], HOUR);
    const moisture = series([35, 34], HOUR);
    const paired = pairConductivityWithMoisture(conductivity, moisture);

    expect(paired).toEqual([
      { conductivity: 800, moisture: 35, at: T0 },
      { conductivity: 810, moisture: 34, at: T0 + HOUR },
    ]);
  });

  it('drops readings with no moisture sample close enough in time', () => {
    // A stale pairing would reintroduce the moisture confound this exists to remove.
    const conductivity = [{ value: 800, at: T0 }];
    const moisture = [{ value: 35, at: T0 + 6 * HOUR }];
    expect(pairConductivityWithMoisture(conductivity, moisture)).toEqual([]);
  });

  it('honours a widened tolerance', () => {
    const conductivity = [{ value: 800, at: T0 }];
    const moisture = [{ value: 35, at: T0 + 10 * MINUTE }];

    expect(pairConductivityWithMoisture(conductivity, moisture)).toEqual([]);
    expect(pairConductivityWithMoisture(conductivity, moisture, 15 * MINUTE)).toHaveLength(1);
  });

  it('returns nothing when moisture is unavailable', () => {
    expect(pairConductivityWithMoisture(series([800]), [])).toEqual([]);
  });
});

describe('inferLastWatering', () => {
  it('detects a sharp moisture rise', () => {
    // No watering is ever recorded — a human waters unannounced (ADR 0003), so
    // the event has to be read out of the moisture curve.
    const moisture = series([20, 19, 40, 38]);
    expect(inferLastWatering(moisture)).toBe(T0 + 2 * HOUR);
  });

  it('returns the most recent event when there are several', () => {
    const moisture = series([20, 35, 30, 25, 45]);
    expect(inferLastWatering(moisture)).toBe(T0 + 4 * HOUR);
  });

  it('ignores gradual drift', () => {
    expect(inferLastWatering(series([30, 31, 32, 33]))).toBeNull();
  });

  it('ignores drying', () => {
    expect(inferLastWatering(series([40, 36, 32, 28]))).toBeNull();
  });

  it('returns null without enough data', () => {
    expect(inferLastWatering([])).toBeNull();
    expect(inferLastWatering(series([30]))).toBeNull();
  });

  it('respects a custom rise threshold', () => {
    const moisture = series([20, 25]);
    expect(inferLastWatering(moisture)).toBeNull();
    expect(inferLastWatering(moisture, 4)).toBe(T0 + HOUR);
  });
});

describe('buildObservation', () => {
  const history = new Map<string, Series>([
    [ENTITIES.moisture, series([35, 34, 33])],
    [ENTITIES.soilTemp, series([21, 21, 21])],
    [ENTITIES.lux, series([0, 8000, 0])],
    [ENTITIES.conductivity, series([800, 810, 790])],
    [ENTITIES.battery, [{ value: 85, at: T0 }]],
    [ENTITIES.airTemp, series([22, 22, 22])],
    [ENTITIES.humidity, series([55, 55, 55])],
  ]);

  it('maps every entity onto its domain signal', () => {
    const observation = buildObservation({
      profile: PROFILE,
      entities: ENTITIES,
      history,
      now: T0 + 3 * HOUR,
    });

    expect(observation.moisture).toHaveLength(3);
    expect(observation.humidity).toHaveLength(3);
    expect(observation.profile.id).toBe('monstera');
    expect(observation.now).toBe(T0 + 3 * HOUR);
  });

  it('produces paired conductivity readings for EC normalisation', () => {
    const observation = buildObservation({
      profile: PROFILE,
      entities: ENTITIES,
      history,
      now: T0 + 3 * HOUR,
    });

    expect(observation.pairedConductivity).toHaveLength(3);
    expect(observation.pairedConductivity[0]).toMatchObject({ conductivity: 800, moisture: 35 });
  });

  it('yields empty series for missing entities rather than throwing', () => {
    // A dead or newly-added sensor must degrade to a staleness finding downstream.
    const observation = buildObservation({
      profile: PROFILE,
      entities: ENTITIES,
      history: new Map(),
      now: T0,
    });

    expect(observation.moisture).toEqual([]);
    expect(observation.battery).toEqual([]);
    expect(observation.lastWateredAt).toBeNull();
  });

  it('infers lastWateredAt from the moisture series', () => {
    const watered = new Map(history);
    watered.set(ENTITIES.moisture, series([20, 19, 40]));

    const observation = buildObservation({
      profile: PROFILE,
      entities: ENTITIES,
      history: watered,
      now: T0 + 3 * HOUR,
    });

    expect(observation.lastWateredAt).toBe(T0 + 2 * HOUR);
  });
});
