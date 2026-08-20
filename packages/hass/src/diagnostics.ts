/**
 * Setup diagnostics.
 *
 * Answers "is my hardware and configuration actually working?" empirically,
 * instead of asking the owner to verify things by hand.
 *
 * Notably this settles the Mi Flora firmware question without opening the Flower
 * Care app. Home Assistant's documentation states that firmware below 3.2.1 "won't
 * send the right BLE beacons", so the device produces no usable entities at all.
 * The contrapositive is the useful part: **if all four soil signals report numeric
 * values, the firmware is adequate by definition.** No version string needed.
 *
 * It also catches the mistakes that are otherwise silent for days — a mistyped
 * entity ID, a renamed device, or a missing room climate sensor which quietly
 * means no VPD.
 */

import type { EntityRegistry, PlantEntities } from './entities.js';
import { entityIdsOf } from './entities.js';
import type { HassReader } from './reader.js';
import { type HassState, isAbsent } from './schema.js';

export type EntityStatus =
  /** Entity exists and currently reports a number. */
  | 'ok'
  /** Entity exists but reports `unavailable`/`unknown` — normal briefly for BLE. */
  | 'absent'
  /** Entity exists but its state is not a number. */
  | 'non-numeric'
  /** Home Assistant has never heard of this entity ID. */
  | 'missing';

export interface EntityReport {
  readonly entityId: string;
  readonly signal: keyof Omit<PlantEntities, 'plantId'>;
  readonly status: EntityStatus;
  readonly state?: string;
}

export interface PlantReport {
  readonly plantId: string;
  readonly entities: readonly EntityReport[];
  /** All four Mi Flora soil signals report numbers, so firmware is >= 3.2.1. */
  readonly soilSignalsHealthy: boolean;
  /** An air sensor is reporting, so VPD is computable for this plant. */
  readonly vpdAvailable: boolean;
  /** Entity IDs Home Assistant does not know — almost always a config typo. */
  readonly unknownEntities: readonly string[];
}

const SOIL_SIGNALS = ['moisture', 'soilTemp', 'lux', 'conductivity'] as const;

/**
 * Check every configured entity against Home Assistant's current state.
 *
 * Deliberately uses a single `/api/states` call rather than one request per
 * entity: over a tunnel, round trips dominate.
 */
export async function checkSetup(
  reader: HassReader,
  registry: EntityRegistry,
): Promise<PlantReport[]> {
  const states = await reader.states();
  return registry.map((entities) => reportForPlant(entities, states));
}

function reportForPlant(
  entities: PlantEntities,
  states: ReadonlyMap<string, HassState>,
): PlantReport {
  const { plantId: _plantId, ...signals } = entities;

  const reports: EntityReport[] = Object.entries(signals).map(([signal, entityId]) => ({
    entityId,
    signal: signal as EntityReport['signal'],
    ...classify(states.get(entityId)),
  }));

  const statusOf = (signal: string): EntityStatus | undefined =>
    reports.find((r) => r.signal === signal)?.status;

  return {
    plantId: entities.plantId,
    entities: reports,
    soilSignalsHealthy: SOIL_SIGNALS.every((signal) => statusOf(signal) === 'ok'),
    vpdAvailable: statusOf('airTemp') === 'ok' && statusOf('humidity') === 'ok',
    unknownEntities: reports.filter((r) => r.status === 'missing').map((r) => r.entityId),
  };
}

function classify(state: HassState | undefined): { status: EntityStatus; state?: string } {
  if (!state) return { status: 'missing' };
  if (isAbsent(state.state)) return { status: 'absent', state: state.state };
  if (!Number.isFinite(Number(state.state))) {
    return { status: 'non-numeric', state: state.state };
  }
  return { status: 'ok', state: state.state };
}

/** Human-readable summary for startup logs or an MCP diagnostic tool. */
export function summarise(reports: readonly PlantReport[]): string[] {
  const lines: string[] = [];

  for (const report of reports) {
    if (report.unknownEntities.length > 0) {
      lines.push(
        `${report.plantId}: ${report.unknownEntities.length} unknown entity ID(s) — ` +
          `check for typos or a renamed device: ${report.unknownEntities.join(', ')}`,
      );
    }

    if (report.soilSignalsHealthy) {
      lines.push(
        `${report.plantId}: all four soil signals reporting — Mi Flora firmware is adequate.`,
      );
    } else {
      const bad = report.entities
        .filter((e) => SOIL_SIGNALS.includes(e.signal as (typeof SOIL_SIGNALS)[number]))
        .filter((e) => e.status !== 'ok');
      lines.push(
        `${report.plantId}: soil signals not fully reporting (` +
          `${bad.map((e) => `${e.signal}=${e.status}`).join(', ')}). If this persists, ` +
          'check Mi Flora firmware is >= 3.2.1 and that a BLE proxy is in range.',
      );
    }

    if (!report.vpdAvailable) {
      lines.push(
        `${report.plantId}: no air temperature/humidity reading, so VPD is unavailable. ` +
          'Mi Flora cannot measure humidity; add a room climate sensor.',
      );
    }
  }

  return lines;
}

/** Total entity IDs a registry expects Home Assistant to know about. */
export function expectedEntityCount(registry: EntityRegistry): number {
  return new Set(registry.flatMap(entityIdsOf)).size;
}
