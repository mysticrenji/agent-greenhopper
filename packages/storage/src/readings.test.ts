import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_MS, bucketStart } from './d1.js';
import { type ReadingRow, ReadingsRepository, rollupSeries } from './readings.js';
import { createTestDatabase, type TestDatabase } from './testing/sqlite.js';

const T0 = bucketStart(Date.UTC(2026, 5, 15, 12, 0, 0));

let database: TestDatabase;
let repo: ReadingsRepository;

beforeEach(() => {
  database = createTestDatabase();
  repo = new ReadingsRepository(database.d1);
});

afterEach(() => database.close());

function row(overrides: Partial<ReadingRow> = {}): ReadingRow {
  return {
    plantId: 'monstera',
    bucketStart: T0,
    moisturePct: 35,
    soilTempC: 21,
    lux: 8000,
    ecUsCm: 800,
    batteryPct: 85,
    airTempC: 22,
    humidityPct: 55,
    ...overrides,
  };
}

describe('bucketStart', () => {
  it('floors a timestamp to its bucket', () => {
    const base = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(bucketStart(base + 60_000)).toBe(base);
    expect(bucketStart(base + 14 * 60_000)).toBe(base);
    expect(bucketStart(base + BUCKET_MS)).toBe(base + BUCKET_MS);
  });

  it('is stable, which is what makes upsert idempotent', () => {
    const base = Date.UTC(2026, 5, 15, 12, 7, 31);
    expect(bucketStart(base)).toBe(bucketStart(base + 1));
  });
});

describe('ReadingsRepository.upsert', () => {
  it('stores a bucket and reads it back', async () => {
    await repo.upsert([row()]);
    const latest = await repo.latest('monstera');

    expect(latest).toMatchObject({ plantId: 'monstera', bucketStart: T0, moisturePct: 35 });
  });

  it('is idempotent for the same bucket', async () => {
    await repo.upsert([row()]);
    await repo.upsert([row()]);

    const count = database.raw.prepare('SELECT COUNT(*) AS n FROM readings').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('updates values on conflict', async () => {
    await repo.upsert([row({ moisturePct: 35 })]);
    await repo.upsert([row({ moisturePct: 28 })]);

    expect((await repo.latest('monstera'))?.moisturePct).toBe(28);
  });

  it('does not erase an existing value when the new row omits it', async () => {
    // Battery arrives once a day while soil signals arrive every minute, so most
    // updates legitimately carry no battery reading. COALESCE protects it.
    await repo.upsert([row({ batteryPct: 85 })]);
    await repo.upsert([row({ batteryPct: null, moisturePct: 30 })]);

    const latest = await repo.latest('monstera');
    expect(latest?.batteryPct).toBe(85);
    expect(latest?.moisturePct).toBe(30);
  });

  it('aligns unaligned timestamps onto bucket boundaries', async () => {
    await repo.upsert([row({ bucketStart: T0 + 7 * 60_000 })]);
    expect((await repo.latest('monstera'))?.bucketStart).toBe(T0);
  });

  it('accepts an empty batch without touching the database', async () => {
    expect(await repo.upsert([])).toBe(0);
  });

  it('keeps plants separate', async () => {
    await repo.upsert([row(), row({ plantId: 'fern', moisturePct: 12 })]);

    expect((await repo.latest('monstera'))?.moisturePct).toBe(35);
    expect((await repo.latest('fern'))?.moisturePct).toBe(12);
  });
});

describe('ReadingsRepository.series', () => {
  beforeEach(async () => {
    await repo.upsert([
      row({ bucketStart: T0, moisturePct: 40 }),
      row({ bucketStart: T0 + BUCKET_MS, moisturePct: 38 }),
      row({ bucketStart: T0 + 2 * BUCKET_MS, moisturePct: 36 }),
    ]);
  });

  it('returns a domain series oldest first', async () => {
    const series = await repo.series('monstera', 'moisture', T0, T0 + 2 * BUCKET_MS);

    expect(series).toEqual([
      { value: 40, at: T0 },
      { value: 38, at: T0 + BUCKET_MS },
      { value: 36, at: T0 + 2 * BUCKET_MS },
    ]);
  });

  it('respects the window bounds inclusively', async () => {
    const series = await repo.series('monstera', 'moisture', T0 + BUCKET_MS, T0 + BUCKET_MS);
    expect(series).toHaveLength(1);
  });

  it('omits buckets where the signal is null rather than emitting zeros', async () => {
    // A gap must stay a gap: a fabricated 0 would corrupt every derived metric.
    await repo.upsert([row({ bucketStart: T0 + 3 * BUCKET_MS, moisturePct: null })]);
    const series = await repo.series('monstera', 'moisture', T0, T0 + 3 * BUCKET_MS);

    expect(series).toHaveLength(3);
  });

  it('maps every storable signal onto a real column', async () => {
    // Guards against a typo in SIGNAL_COLUMN, which SQLite would reject at runtime.
    const signals = [
      'moisture',
      'soilTemp',
      'lux',
      'conductivity',
      'battery',
      'airTemp',
      'humidity',
    ] as const;

    for (const signal of signals) {
      const series = await repo.series('monstera', signal, T0, T0 + 2 * BUCKET_MS);
      expect(series.length).toBeGreaterThan(0);
    }
  });
});

describe('ReadingsRepository.window and pruneBefore', () => {
  it('returns full rows across a window', async () => {
    await repo.upsert([row({ bucketStart: T0 }), row({ bucketStart: T0 + BUCKET_MS })]);
    const rows = await repo.window('monstera', T0, T0 + BUCKET_MS);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ soilTempC: 21, humidityPct: 55 });
  });

  it('deletes buckets older than the cutoff and keeps the rest', async () => {
    await repo.upsert([row({ bucketStart: T0 - 10 * BUCKET_MS }), row({ bucketStart: T0 })]);
    await repo.pruneBefore(T0);

    const rows = await repo.window('monstera', 0, T0 + BUCKET_MS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bucketStart).toBe(T0);
  });
});

describe('rollupSeries', () => {
  it('averages samples inside a bucket', () => {
    // Lux swings by orders of magnitude inside 15 minutes as clouds pass, so the
    // mean is both a better estimate and what the DLI integral assumes.
    const rows = rollupSeries('monstera', {
      lux: [
        { value: 1000, at: T0 + 60_000 },
        { value: 3000, at: T0 + 120_000 },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucketStart: T0, lux: 2000 });
  });

  it('splits samples across bucket boundaries', () => {
    const rows = rollupSeries('monstera', {
      moisture: [
        { value: 40, at: T0 + 60_000 },
        { value: 38, at: T0 + BUCKET_MS + 60_000 },
      ],
    });

    expect(rows.map((r) => r.bucketStart)).toEqual([T0, T0 + BUCKET_MS]);
  });

  it('leaves absent signals null rather than zero', () => {
    const rows = rollupSeries('monstera', { moisture: [{ value: 40, at: T0 }] });

    expect(rows[0]?.moisturePct).toBe(40);
    expect(rows[0]?.batteryPct).toBeNull();
    expect(rows[0]?.lux).toBeNull();
  });

  it('returns rows sorted oldest first', () => {
    const rows = rollupSeries('monstera', {
      moisture: [
        { value: 30, at: T0 + 2 * BUCKET_MS },
        { value: 40, at: T0 },
      ],
    });

    expect(rows.map((r) => r.bucketStart)).toEqual([T0, T0 + 2 * BUCKET_MS]);
  });

  it('produces rows that upsert cleanly', async () => {
    const rows = rollupSeries('monstera', {
      moisture: [{ value: 33, at: T0 }],
      humidity: [{ value: 51, at: T0 }],
    });
    await repo.upsert(rows);

    const latest = await repo.latest('monstera');
    expect(latest).toMatchObject({ moisturePct: 33, humidityPct: 51 });
  });

  it('returns nothing for no input', () => {
    expect(rollupSeries('monstera', {})).toEqual([]);
  });
});
