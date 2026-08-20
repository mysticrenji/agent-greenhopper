/**
 * Notification audit log.
 *
 * Append-only record of every alert action, including suppressions. Recording
 * what was *not* sent is the point: the question this answers is "why was I never
 * told about this?", and an alert policy you cannot audit is one you cannot trust.
 */

import type { AlertAction } from '@greenhopper/domain';
import type { D1Like } from './d1.js';

export interface NotificationEntry {
  readonly id: number;
  readonly at: number;
  readonly plantId: string;
  readonly code: string;
  readonly kind: 'notify' | 'suppress' | 'resolve';
  readonly channel: string | null;
  readonly severity: string | null;
  readonly trigger: string | null;
  readonly message: string;
}

interface NotificationRecord {
  id: number;
  at: number;
  plant_id: string;
  code: string;
  kind: string;
  channel: string | null;
  severity: string | null;
  trigger: string | null;
  message: string;
}

export class NotificationLog {
  constructor(private readonly db: D1Like) {}

  /** Record every action from one alert planning run. */
  async append(actions: readonly AlertAction[], atMs: number): Promise<number> {
    if (actions.length === 0) return 0;

    const sql =
      'INSERT INTO notifications (at, plant_id, code, kind, channel, severity, trigger, message) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

    const statements = actions.map((action) => {
      const row = describe(action);
      return this.db
        .prepare(sql)
        .bind(
          atMs,
          action.plantId,
          action.code,
          action.kind,
          row.channel,
          row.severity,
          row.trigger,
          row.message,
        );
    });

    await this.db.batch(statements);
    return actions.length;
  }

  /** Most recent entries, newest first. */
  async recent(limit = 50): Promise<NotificationEntry[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM notifications ORDER BY at DESC, id DESC LIMIT ?')
      .bind(limit)
      .all<NotificationRecord>();

    return results.map(toEntry);
  }

  /** Entries for one plant, newest first. */
  async forPlant(plantId: string, limit = 50): Promise<NotificationEntry[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM notifications WHERE plant_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .bind(plantId, limit)
      .all<NotificationRecord>();

    return results.map(toEntry);
  }

  /** Count of entries by kind since a timestamp — useful for spotting alert storms. */
  async countsSince(sinceMs: number): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM notifications WHERE at >= ? GROUP BY kind')
      .bind(sinceMs)
      .all<{ kind: string; n: number }>();

    return Object.fromEntries(results.map((row) => [row.kind, row.n]));
  }

  async pruneBefore(cutoffMs: number): Promise<void> {
    await this.db.prepare('DELETE FROM notifications WHERE at < ?').bind(cutoffMs).run();
  }
}

interface Described {
  readonly channel: string | null;
  readonly severity: string | null;
  readonly trigger: string | null;
  readonly message: string;
}

/** Flatten the discriminated union into the log's column shape. */
function describe(action: AlertAction): Described {
  switch (action.kind) {
    case 'notify':
      return {
        channel: action.channel,
        severity: action.severity,
        trigger: action.trigger,
        message: action.message,
      };
    case 'suppress':
      return {
        channel: null,
        severity: null,
        trigger: action.reason,
        message: `Suppressed (${action.reason}).`,
      };
    case 'resolve':
      return {
        channel: action.channel,
        severity: null,
        trigger: 'resolved',
        message: action.message,
      };
  }
}

function toEntry(record: NotificationRecord): NotificationEntry {
  return {
    id: record.id,
    at: record.at,
    plantId: record.plant_id,
    code: record.code,
    kind: record.kind as NotificationEntry['kind'],
    channel: record.channel,
    severity: record.severity,
    trigger: record.trigger,
    message: record.message,
  };
}
