import { type PlantRegistry, plantRegistrySchema } from '@greenhopper/domain';
import { type EntityRegistry, entityRegistrySchema } from '@greenhopper/hass';
import { z } from 'zod';
import { plantConfiguration } from './plants.generated.js';

const configurationSchema = z
  .object({
    plants: plantRegistrySchema,
    entities: entityRegistrySchema,
  })
  .superRefine(({ plants, entities }, context) => {
    const entityIds = new Set(entities.map((entity) => entity.plantId));

    for (const [index, plant] of plants.entries()) {
      if (!entityIds.has(plant.id)) {
        context.addIssue({
          code: 'custom',
          message: `Missing entity mapping for plant '${plant.id}'.`,
          path: ['plants', index, 'id'],
        });
      }
    }

    const plantIds = new Set(plants.map((plant) => plant.id));
    for (const [index, entity] of entities.entries()) {
      if (!plantIds.has(entity.plantId)) {
        context.addIssue({
          code: 'custom',
          message: `Entity mapping '${entity.plantId}' has no plant profile.`,
          path: ['entities', index, 'plantId'],
        });
      }
    }
  });

export interface PlantConfiguration {
  readonly plants: PlantRegistry;
  readonly entities: EntityRegistry;
}

export function parsePlantConfiguration(input: unknown): PlantConfiguration {
  return configurationSchema.parse(input);
}

function flattenPlants(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('plants' in input)) return input;

  const { plants, ...rest } = input as { plants: unknown; [key: string]: unknown };
  if (!Array.isArray(plants)) return input;

  return {
    ...rest,
    plants: plants.map(({ entities, ...plant }) => plant),
    entities: plants.map(({ entities, id }) => ({ plantId: id, ...entities })),
  };
}

export const PLANT_CONFIGURATION = parsePlantConfiguration(flattenPlants(plantConfiguration));
export const PLANT_REGISTRY = PLANT_CONFIGURATION.plants;
export const ENTITY_REGISTRY = PLANT_CONFIGURATION.entities;
