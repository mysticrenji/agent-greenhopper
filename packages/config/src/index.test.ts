import { describe, expect, it } from 'vitest';
import { ENTITY_REGISTRY, PLANT_REGISTRY, parsePlantConfiguration } from './index.js';

describe('plant configuration', () => {
  it('derives matching plant and entity registries from the YAML source', () => {
    expect(PLANT_REGISTRY.map((plant) => plant.id)).toEqual(['monstera', 'curry-leaves']);
    expect(ENTITY_REGISTRY.map((entity) => entity.plantId)).toEqual(['monstera', 'curry-leaves']);
  });

  it('rejects a plant without a Home Assistant entity mapping', () => {
    expect(() =>
      parsePlantConfiguration({
        plants: [PLANT_REGISTRY[0]],
        entities: [],
      }),
    ).toThrow("Missing entity mapping for plant 'monstera'.");
  });

  it('rejects an entity mapping without a plant profile', () => {
    expect(() =>
      parsePlantConfiguration({
        plants: [],
        entities: [ENTITY_REGISTRY[0]],
      }),
    ).toThrow("Entity mapping 'monstera' has no plant profile.");
  });
});
