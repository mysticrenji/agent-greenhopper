/**
 * Mapping from a plant to the Home Assistant entity IDs that carry its signals.
 *
 * Entity IDs are configuration, not something to guess at runtime. `xiaomi_ble`
 * derives them from the device name you set when the sensor is discovered, and
 * users rename devices. `miFloraEntities` offers the conventional default so the
 * common case is one line, while every field stays individually overridable.
 *
 * Air temperature and humidity come from a *different* device — Mi Flora cannot
 * measure humidity (ADR 0005) — and are shared by every plant in a room.
 */

import { z } from 'zod';

export const plantEntitiesSchema = z.object({
  plantId: z.string().min(1),
  moisture: z.string().min(1),
  soilTemp: z.string().min(1),
  lux: z.string().min(1),
  conductivity: z.string().min(1),
  /** Optional: some BLE integrations expose no battery entity. */
  battery: z.string().min(1).optional(),
  airTemp: z.string().min(1),
  humidity: z.string().min(1),
});

export type PlantEntities = z.infer<typeof plantEntitiesSchema>;

export const entityRegistrySchema = z
  .array(plantEntitiesSchema)
  .refine((entries) => new Set(entries.map((e) => e.plantId)).size === entries.length, {
    message: 'plantId must be unique in the entity registry',
  });

export type EntityRegistry = z.infer<typeof entityRegistrySchema>;

export interface MiFloraEntityArgs {
  readonly plantId: string;
  /**
   * Device slug as it appears in entity IDs, for example `monstera_flower_care`
   * yields `sensor.monstera_flower_care_moisture`.
   */
  readonly deviceSlug: string;
  /** Slug of the room's air temperature/humidity sensor, e.g. `living_room_climate`. */
  readonly airSensorSlug: string;
}

/**
 * Conventional entity IDs created by `xiaomi_ble` for an HHCCJCY01 plus a
 * companion climate sensor.
 *
 * Note that Mi Flora's soil temperature entity is named `_temperature`, the same
 * suffix the air sensor uses — hence two distinct slugs rather than one.
 */
export function miFloraEntities(args: MiFloraEntityArgs): PlantEntities {
  const { plantId, deviceSlug, airSensorSlug } = args;
  return {
    plantId,
    moisture: `sensor.${deviceSlug}_moisture`,
    soilTemp: `sensor.${deviceSlug}_temperature`,
    lux: `sensor.${deviceSlug}_illuminance`,
    conductivity: `sensor.${deviceSlug}_conductivity`,
    battery: `sensor.${deviceSlug}_battery`,
    airTemp: `sensor.${airSensorSlug}_temperature`,
    humidity: `sensor.${airSensorSlug}_humidity`,
  };
}

/** Every entity ID referenced by a plant, deduplicated. */
export function entityIdsOf(entities: PlantEntities): string[] {
  const { plantId: _plantId, ...ids } = entities;
  return [...new Set(Object.values(ids).filter((id): id is string => id !== undefined))];
}

/** Every entity ID across a registry, deduplicated — shared air sensors collapse. */
export function allEntityIds(registry: EntityRegistry): string[] {
  return [...new Set(registry.flatMap(entityIdsOf))];
}
