import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATERING_POLICY,
  parsePlantRegistry,
  plantProfileSchema,
  wateringPolicySchema,
} from './plant.js';

const VALID_PROFILE = {
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

describe('plantProfileSchema', () => {
  it('accepts a well-formed profile', () => {
    expect(plantProfileSchema.parse(VALID_PROFILE)).toMatchObject({ id: 'monstera' });
  });

  it('rejects ids that are not slug-safe', () => {
    for (const id of ['Monstera', 'my plant', 'plant_1', '']) {
      expect(plantProfileSchema.safeParse({ ...VALID_PROFILE, id }).success).toBe(false);
    }
  });

  it('rejects an inverted target range', () => {
    const bad = {
      ...VALID_PROFILE,
      targets: { ...VALID_PROFILE.targets, moisture: { min: 60, max: 20 } },
    };
    expect(plantProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('requires every target range to be present', () => {
    const { vpd: _vpd, ...withoutVpd } = VALID_PROFILE.targets;
    const bad = { ...VALID_PROFILE, targets: withoutVpd };
    expect(plantProfileSchema.safeParse(bad).success).toBe(false);
  });
});

describe('wateringPolicySchema', () => {
  it('accepts the conservative defaults', () => {
    expect(wateringPolicySchema.parse(DEFAULT_WATERING_POLICY)).toEqual(DEFAULT_WATERING_POLICY);
  });

  it('caps a single run at 10 minutes to bound hardware failure', () => {
    const tooLong = { ...DEFAULT_WATERING_POLICY, maxSeconds: 601 };
    expect(wateringPolicySchema.safeParse(tooLong).success).toBe(false);
  });

  it('rejects a non-integer or non-positive duration', () => {
    for (const maxSeconds of [0, -5, 12.5]) {
      expect(
        wateringPolicySchema.safeParse({ ...DEFAULT_WATERING_POLICY, maxSeconds }).success,
      ).toBe(false);
    }
  });

  it('caps runs per day', () => {
    const tooMany = { ...DEFAULT_WATERING_POLICY, maxRunsPerDay: 13 };
    expect(wateringPolicySchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('parsePlantRegistry', () => {
  it('parses a list of profiles', () => {
    const registry = parsePlantRegistry([
      VALID_PROFILE,
      { ...VALID_PROFILE, id: 'fern', name: 'Fern' },
    ]);
    expect(registry).toHaveLength(2);
  });

  it('rejects duplicate plant ids', () => {
    // Duplicate ids would silently shadow one plant's history in storage.
    expect(() => parsePlantRegistry([VALID_PROFILE, VALID_PROFILE])).toThrow();
  });

  it('accepts an empty registry', () => {
    expect(parsePlantRegistry([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(() => parsePlantRegistry({ id: 'monstera' })).toThrow();
  });
});
