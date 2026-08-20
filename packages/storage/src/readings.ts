/**
 * Reading rollups.
 *
 * Home Assistant's recorder purges detailed history after about 10 days, so the
 * long view of a plant lives here and nowhere else. That makes this repository the
 * reason statements like "this pot is drying 40% faster than last month" are
 * answerable at all.
 */

import type { Series } from '@greenhopper/domain';
import { bucketStart, type D1Like } from './d1.js';

/** One rollup bucket. Every measurement is optional — sensors drop out. */
export interface ReadingRow {
  readonly plantId: string;
  readonly bucketStart: number;
  readonly moisturePct?: number | null;
  readonly soilTempC?: number | null;
  readonly lux?: number | null;
  readonly ecUsCm?: number | null;
  readonly batteryPct?: number | null;
  readonly airTempC?: number | null;
  readonly humidityPct?: number | null;
}

/** Column names in the order used by insert and select statements. */
const MEASUREMENTS = [
  'moisture_pct',
  'soil_temp_c',
  'lux',
  'ec_us_cm',
  'battery_pct',
  'air_temp_c',
  'humidity_pct',
] as const;

export type MeasurementColumn = (typeof MEASUREMENTS)[number];

/** Maps a domain signal name onto its storage column. */
export const SIGNAL_COLUMN = {
  moisture: 'moisture_pct',
  soilTemp: 'soil_temp_c',
  lux: 'lux',
  conductivity: 'ec_us_cm',
  battery: 'battery_pct',
  airTemp: 'air_temp_c',
  humidity: 'humidity_pct',
} as const satisfies Record<string, MeasurementColumn>;

export type StorableSignal = keyof typeof SIGNAL_COLUMN;

interface ReadingRecord {
  plant_id: string;
  bucket_start: number;
  moisture_pct: number | null;
  soil_temp_c: number | null;
  lux: number | null;
  ec_us_cm: number | null;
  battery_pct: number | null;
  air_temp_c: number | null;
  humidity_pct: number | null;
}

export class ReadingsRepository {
  constructor(private readonly db: D1Like) {}

  /**
   * Insert or update rollup buckets.
   *
   * `COALESCE(excluded.x, readings.x)` on conflict is the important detail: a
   * later write that carries no battery reading must not erase the one already
   * stored. Battery arrives once a day while the other signals arrive every
   * minute, so most updates legitimately have gaps.
   */
  async upsert(rows: readonly ReadingRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const assignments = MEASUREMENTS.map(
      (column) => `${column} = COALESCE(excluded.${column}, readings.${column})`,
    ).join(', ');

    const sql =
      `INSERT INTO readings (plant_id, bucket_start, ${MEASUREMENTS.join(', ')}) ` +
      `VALUES (?, ?, ${MEASUREMENTS.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (plant_id, bucket_start) DO UPDATE SET ${assignments}`;

    const statements = rows.map((row) =>
      this.db
        .prepare(sql)
        .bind(
          row.plantId,
          bucketStart(row.bucketStart),
          row.moisturePct ?? null,
          row.soilTempC ?? null,
          row.lux ?? null,
          row.ecUsCm ?? null,
          row.batteryPct ?? null,
          row.airTempC ?? null,
          row.humidityPct ?? null,
        ),
    );

    await this.db.batch(statements);
    return rows.length;
  }

  /** Series for one signal over [fromMs, toMs], oldest first, gaps omitted. */
  async series(
    plantId: string,
    signal: StorableSignal,
    fromMs: number,
    toMs: number,
  ): Promise<Series> {
    const column = SIGNAL_COLUMN[signal];
    const { results } = await this.db
      .prepare(
        `SELECT bucket_start, ${column} AS value FROM readings ` +
          'WHERE plant_id = ? AND bucket_start >= ? AND bucket_start <= ? ' +
          `AND ${column} IS NOT NULL ORDER BY bucket_start ASC`,
      )
      .bind(plantId, fromMs, toMs)
      .all<{ bucket_start: number; value: number }>();

    return results.map((row) => ({ value: row.value, at: row.bucket_start }));
  }

  /** Full rollup rows for a plant over a window, for multi-signal analysis. */
  async window(plantId: string, fromMs: number, toMs: number): Promise<ReadingRow[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM readings WHERE plant_id = ? AND bucket_start >= ? AND bucket_start <= ? ' +
          'ORDER BY bucket_start ASC',
      )
      .bind(plantId, fromMs, toMs)
      .all<ReadingRecord>();

    return results.map(toReadingRow);
  }

  /** Most recent bucket for a plant, or null when nothing is stored yet. */
  async latest(plantId: string): Promise<ReadingRow | null> {
    const record = await this.db
      .prepare('SELECT * FROM readings WHERE plant_id = ? ORDER BY bucket_start DESC LIMIT 1')
      .bind(plantId)
      .first<ReadingRecord>();

    return record ? toReadingRow(record) : null;
  }

  /**
   * Delete buckets older than a cutoff.
   *
   * Retention is a deliberate decision rather than a default: unbounded growth is
   * cheap in D1 but slows every range scan, and a year of 15-minute buckets is
   * ample for seasonal comparison.
   */
  async pruneBefore(cutoffMs: number): Promise<void> {
    await this.db.prepare('DELETE FROM readings WHERE bucket_start < ?').bind(cutoffMs).run();
  }
}

function toReadingRow(record: ReadingRecord): ReadingRow {
  return {
    plantId: record.plant_id,
    bucketStart: record.bucket_start,
    moisturePct: record.moisture_pct,
    soilTempC: record.soil_temp_c,
    lux: record.lux,
    ecUsCm: record.ec_us_cm,
    batteryPct: record.battery_pct,
    airTempC: record.air_temp_c,
    humidityPct: record.humidity_pct,
  };
}

/**
 * Average samples within each bucket, producing rows ready for `upsert`.
 *
 * Averaging rather than sampling the last value: lux in particular swings wildly
 * inside 15 minutes as clouds pass, and the mean is both a better estimate and
 * what the DLI integral assumes.
 */
export function rollupSeries(
  plantId: string,
  bySignal: Readonly<Partial<Record<StorableSignal, Series>>>,
): ReadingRow[] {
  const buckets = new Map<number, Map<StorableSignal, number[]>>();

  for (const [signal, series] of Object.entries(bySignal) as [StorableSignal, Series][]) {
    for (const sample of series) {
      const key = bucketStart(sample.at);
      const bucket = buckets.get(key) ?? new Map<StorableSignal, number[]>();
      const values = bucket.get(signal) ?? [];
      values.push(sample.value);
      bucket.set(signal, values);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, bucket]) => ({
      plantId,
      bucketStart: key,
      moisturePct: mean(bucket.get('moisture')),
      soilTempC: mean(bucket.get('soilTemp')),
      lux: mean(bucket.get('lux')),
      ecUsCm: mean(bucket.get('conductivity')),
      batteryPct: mean(bucket.get('battery')),
      airTempC: mean(bucket.get('airTemp')),
      humidityPct: mean(bucket.get('humidity')),
    }));
}

function mean(values: readonly number[] | undefined): number | null {
  if (!values || values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round((total / values.length) * 1000) / 1000;
}
