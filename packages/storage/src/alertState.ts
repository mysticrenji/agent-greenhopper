/**
 * Alert state persistence.
 *
 * Round-trips the domain's `AlertState` without translation, so `planAlerts()` can
 * be handed exactly what it stored on the previous run. Any mismatch here would
 * silently break suppression, which fails in the worst direction: a flood of
 * duplicate notifications.
 */

import type { AlertState, FindingCode, Severity } from '@greenhopper/domain';
import type { D1Like } from './d1.js';

interface AlertStateRecord {
  plant_id: string;
  code: string;
  first_seen_at: number;
  last_notified_at: number | null;
  peak_severity: string;
}

export class AlertStateRepository {
  constructor(private readonly db: D1Like) {}

  /** All persisted alert state. */
  async loadAll(): Promise<AlertState[]> {
    const { results } = await this.db.prepare('SELECT * FROM alert_state').all<AlertStateRecord>();
    return results.map(toAlertState);
  }

  /** Alert state for specific plants only. */
  async loadForPlants(plantIds: readonly string[]): Promise<AlertState[]> {
    if (plantIds.length === 0) return [];

    const placeholders = plantIds.map(() => '?').join(', ');
    const { results } = await this.db
      .prepare(`SELECT * FROM alert_state WHERE plant_id IN (${placeholders})`)
      .bind(...plantIds)
      .all<AlertStateRecord>();

    return results.map(toAlertState);
  }

  /**
   * Replace all state for the given plants with `states`.
   *
   * Scoped to the plants processed in this run rather than truncating the table:
   * a run that only handled some plants must not wipe the suppression history of
   * the others. Replace-and-insert (rather than upsert) is what implements
   * resolution — `planAlerts` omits cleared conditions from `nextStates`, and
   * their rows must therefore disappear so a recurrence reads as new.
   */
  async replaceForPlants(
    plantIds: readonly string[],
    states: readonly AlertState[],
  ): Promise<void> {
    if (plantIds.length === 0) return;

    const placeholders = plantIds.map(() => '?').join(', ');
    const statements = [
      this.db
        .prepare(`DELETE FROM alert_state WHERE plant_id IN (${placeholders})`)
        .bind(...plantIds),
      ...states
        .filter((state) => plantIds.includes(state.plantId))
        .map((state) =>
          this.db
            .prepare(
              'INSERT INTO alert_state ' +
                '(plant_id, code, first_seen_at, last_notified_at, peak_severity) ' +
                'VALUES (?, ?, ?, ?, ?)',
            )
            .bind(
              state.plantId,
              state.code,
              state.firstSeenAt,
              state.lastNotifiedAt,
              state.peakSeverity,
            ),
        ),
    ];

    await this.db.batch(statements);
  }
}

function toAlertState(record: AlertStateRecord): AlertState {
  return {
    plantId: record.plant_id,
    code: record.code as FindingCode,
    firstSeenAt: record.first_seen_at,
    lastNotifiedAt: record.last_notified_at,
    peakSeverity: record.peak_severity as Severity,
  };
}
