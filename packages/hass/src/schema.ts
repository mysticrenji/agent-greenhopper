/**
 * Schemas for the Home Assistant REST responses this project reads.
 *
 * Home Assistant reports every sensor value as a *string*, and uses the literal
 * strings `unavailable`, `unknown` and `''` for "no reading". Those are the normal
 * state of a BLE sensor between advertisements, not an error — so parsing has to
 * distinguish "absent" from "malformed" and drop the former quietly.
 */

import { z } from 'zod';

/** Sentinel state values Home Assistant uses to mean "no value right now". */
const ABSENT_STATES = new Set(['unavailable', 'unknown', 'none', '']);

export const hassStateSchema = z.object({
  entity_id: z.string(),
  state: z.string(),
  last_reported: z.string().optional(),
  last_updated: z.string().optional(),
  last_changed: z.string().optional(),
});

export const hassStatesSchema = z.array(hassStateSchema);

/**
 * A history entry. Requesting history with `minimal_response` omits `entity_id`
 * on all but the first item of each series, so it is optional here.
 */
export const hassHistoryEntrySchema = z.object({
  entity_id: z.string().optional(),
  state: z.string(),
  last_reported: z.string().optional(),
  last_updated: z.string().optional(),
  last_changed: z.string().optional(),
});

/** `/api/history/period` returns one array of entries per requested entity. */
export const hassHistorySchema = z.array(z.array(hassHistoryEntrySchema));

export type HassState = z.infer<typeof hassStateSchema>;
export type HassHistoryEntry = z.infer<typeof hassHistoryEntrySchema>;

/** True when Home Assistant is reporting "no reading" rather than a number. */
export function isAbsent(state: string): boolean {
  return ABSENT_STATES.has(state.trim().toLowerCase());
}

/**
 * Convert a Home Assistant state entry into a numeric sample.
 *
 * Returns null for absent states and for anything non-numeric. A BLE sensor is
 * `unavailable` routinely, so this must not throw.
 */
export function toSample(entry: HassHistoryEntry): { value: number; at: number } | null {
  if (isAbsent(entry.state)) return null;

  const value = Number(entry.state);
  if (!Number.isFinite(value)) return null;

  // Home Assistant advances last_reported even when a sensor reports the same
  // value. last_updated may remain unchanged, which would make a healthy, stable
  // probe look stale.
  const timestamp = entry.last_reported ?? entry.last_updated ?? entry.last_changed;
  if (!timestamp) return null;

  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return null;

  return { value, at };
}
