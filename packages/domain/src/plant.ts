/**
 * Plant profiles: the per-plant targets and safety policy the rules evaluate
 * against.
 *
 * These live in configuration rather than in a prompt, because a fern and a
 * succulent share no thresholds and an LLM should not be inventing them. The
 * schema is the single source of truth — the MCP tool definitions and the
 * registry loader both derive from it.
 *
 * Note that DLI targets are *relative* to your own observed baseline, not values
 * from published per-species tables. See `dailyLightIntegral` for why.
 */

import { z } from 'zod';

const range = (unit: string) =>
  z
    .object({
      min: z.number().describe(`Lower bound (${unit})`),
      max: z.number().describe(`Upper bound (${unit})`),
    })
    .refine((r) => r.min < r.max, { message: 'min must be less than max' });

export const wateringPolicySchema = z.object({
  /** Hard ceiling on a single watering run. */
  maxSeconds: z.number().int().positive().max(600),
  /** Minimum gap between waterings, regardless of what the reasoning concludes. */
  minIntervalHours: z.number().positive(),
  /** Never water when moisture is already at or above this level. */
  moistureCeiling: z.number().min(0).max(100),
  /** Maximum watering runs permitted in a rolling 24h window. */
  maxRunsPerDay: z.number().int().positive().max(12),
});

export const plantProfileSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'lowercase alphanumeric and dashes only'),
  name: z.string().min(1),
  species: z.string().min(1),
  /** Groups plants that share an air temperature/humidity sensor. */
  room: z.string().min(1),
  targets: z.object({
    moisture: range('%'),
    soilTemp: range('C'),
    /** Relative daily light integral, calibrated from your own baseline. */
    dli: range('mol/m2/day, relative'),
    vpd: range('kPa'),
    conductivity: range('uS/cm'),
  }),
  watering: wateringPolicySchema,
});

export const plantRegistrySchema = z
  .array(plantProfileSchema)
  .refine((plants) => new Set(plants.map((p) => p.id)).size === plants.length, {
    message: 'plant ids must be unique',
  });

export type WateringPolicy = z.infer<typeof wateringPolicySchema>;
export type PlantProfile = z.infer<typeof plantProfileSchema>;
export type PlantRegistry = z.infer<typeof plantRegistrySchema>;

/**
 * Conservative defaults for a generic tropical houseplant. Intended as a
 * starting point to be tuned per plant from observed data, not as horticultural
 * authority.
 */
export const DEFAULT_WATERING_POLICY: WateringPolicy = {
  maxSeconds: 20,
  minIntervalHours: 48,
  moistureCeiling: 35,
  maxRunsPerDay: 2,
};

export function parsePlantRegistry(input: unknown): PlantRegistry {
  return plantRegistrySchema.parse(input);
}
