import { describe, expect, it } from 'vitest';
import { allEntityIds, entityIdsOf, entityRegistrySchema, miFloraEntities } from './entities.js';

describe('miFloraEntities', () => {
  const entities = miFloraEntities({
    plantId: 'monstera',
    deviceSlug: 'monstera_flower_care',
    airSensorSlug: 'living_room_climate',
  });

  it('maps the four passive soil signals plus battery', () => {
    expect(entities).toMatchObject({
      moisture: 'sensor.monstera_flower_care_moisture',
      soilTemp: 'sensor.monstera_flower_care_temperature',
      lux: 'sensor.monstera_flower_care_illuminance',
      conductivity: 'sensor.monstera_flower_care_conductivity',
      battery: 'sensor.monstera_flower_care_battery',
    });
  });

  it('takes air temperature and humidity from a separate device', () => {
    // Mi Flora cannot measure humidity, and its `_temperature` is soil, not air —
    // so the two must not collapse onto one slug.
    expect(entities.airTemp).toBe('sensor.living_room_climate_temperature');
    expect(entities.humidity).toBe('sensor.living_room_climate_humidity');
    expect(entities.airTemp).not.toBe(entities.soilTemp);
  });

  it('allows installations without a battery entity', () => {
    const withoutBattery = { ...entities, battery: undefined };
    expect(entityRegistrySchema.safeParse([withoutBattery]).success).toBe(true);
    expect(entityIdsOf(withoutBattery)).toHaveLength(6);
  });
});

describe('entityIdsOf', () => {
  it('lists every entity without the plant id', () => {
    const ids = entityIdsOf(
      miFloraEntities({ plantId: 'fern', deviceSlug: 'fern_fc', airSensorSlug: 'hall_climate' }),
    );
    expect(ids).toHaveLength(7);
    expect(ids).not.toContain('fern');
  });
});

describe('allEntityIds', () => {
  it('deduplicates a shared room climate sensor across plants', () => {
    const registry = [
      miFloraEntities({ plantId: 'monstera', deviceSlug: 'm_fc', airSensorSlug: 'lr_climate' }),
      miFloraEntities({ plantId: 'fern', deviceSlug: 'f_fc', airSensorSlug: 'lr_climate' }),
    ];

    // 5 soil entities each, plus one shared pair of air entities.
    expect(allEntityIds(registry)).toHaveLength(12);
  });
});

describe('entityRegistrySchema', () => {
  const one = miFloraEntities({ plantId: 'a', deviceSlug: 'a_fc', airSensorSlug: 'c' });

  it('accepts a valid registry', () => {
    expect(entityRegistrySchema.parse([one])).toHaveLength(1);
  });

  it('rejects duplicate plant ids', () => {
    expect(entityRegistrySchema.safeParse([one, one]).success).toBe(false);
  });

  it('rejects an empty entity id', () => {
    expect(entityRegistrySchema.safeParse([{ ...one, moisture: '' }]).success).toBe(false);
  });
});
