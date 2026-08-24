import { describe, expect, it } from 'vitest';
import type { Finding, FindingCode, PlantObservation } from './assess.js';
import { assess } from './assess.js';
import { DEFAULT_WATERING_POLICY, type PlantProfile } from './plant.js';
import type { Series } from './signals.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const PROFILE: PlantProfile = {
  id: 'monstera',
  name: 'Monstera',
  species: 'Monstera deliciosa',
  room: 'living-room',
  targets: {
    moisture: { min: 25, max: 45 },
    soilTemp: { min: 16, max: 28 },
    dli: { min: 2, max: 12 },
    vpd: { min: 0.4, max: 1.4 },
    conductivity: { min: 300, max: 1500 },
  },
  watering: DEFAULT_WATERING_POLICY,
};

/**
 * Recent, healthy, in-range series. `endAt` controls the newest sample so tests
 * can build deliberately stale series.
 */
function fresh(value: number, count = 20, stepMs = MINUTE, endAt = NOW): Series {
  return Array.from({ length: count }, (_, i) => ({
    value,
    at: endAt - (count - 1 - i) * stepMs,
  }));
}

/**
 * A lux series spanning a 12-hour photoperiod. DLI is an integral, so a series
 * covering only a few minutes yields a near-zero value regardless of brightness —
 * fixtures must span a realistic day.
 */
function luxDay(value: number): Series {
  return fresh(value, 13, HOUR, NOW);
}

function observation(overrides: Partial<PlantObservation> = {}): PlantObservation {
  return {
    profile: PROFILE,
    now: NOW,
    moisture: fresh(35),
    soilTemp: fresh(21),
    lux: luxDay(8_000),
    conductivity: fresh(800),
    battery: [{ value: 85, at: NOW - 6 * HOUR }],
    airTemp: fresh(22),
    humidity: fresh(55),
    pairedConductivity: Array.from({ length: 5 }, (_, i) => ({
      conductivity: 800,
      moisture: 35,
      at: NOW - i * HOUR,
    })),
    lastWateredAt: null,
    ...overrides,
  };
}

const codes = (findings: readonly Finding[]): FindingCode[] => findings.map((f) => f.code);

describe('assess — healthy baseline', () => {
  it('reports ok with no findings when everything is in range', () => {
    const result = assess(observation());
    expect(result.findings).toEqual([]);
    expect(result.severity).toBe('ok');
    expect(result.escalate).toBe(false);
  });

  it('derives all five signal groups', () => {
    const { derived } = assess(observation());
    expect(derived.moisture).toBe(35);
    expect(derived.soilTemp).toBe(21);
    expect(derived.vpd).toBeGreaterThan(0);
    expect(derived.dli).toBeGreaterThan(0);
    expect(derived.conductivityNormalised).toBe(800);
  });
});

describe('assess — sensor health', () => {
  it('flags a stale moisture reading', () => {
    // Newest sample is an hour old, well past the 10-minute moisture budget.
    const result = assess(observation({ moisture: fresh(35, 20, MINUTE, NOW - HOUR) }));
    expect(codes(result.findings)).toContain('SENSOR_STALE:moisture');
  });

  it('identifies each stale sensor independently for alert-state persistence', () => {
    const stale = fresh(35, 20, MINUTE, NOW - HOUR);
    const result = assess(observation({ moisture: stale, soilTemp: stale }));

    expect(codes(result.findings)).toEqual(
      expect.arrayContaining([
        'SENSOR_STALE:moisture' as FindingCode,
        'SENSOR_STALE:soilTemp' as FindingCode,
      ]),
    );
  });

  it('does not flag a day-old battery reading', () => {
    const result = assess(observation({ battery: [{ value: 80, at: NOW - 23 * HOUR }] }));
    expect(codes(result.findings)).not.toContain('SENSOR_STALE:battery');
  });

  it('flags a probe pinned at a range limit as critical', () => {
    const result = assess(observation({ moisture: fresh(0) }));
    expect(codes(result.findings)).toContain('SENSOR_PINNED:moisture');
    expect(result.severity).toBe('critical');
  });

  it('flags a low battery', () => {
    const result = assess(observation({ battery: [{ value: 8, at: NOW - HOUR }] }));
    expect(codes(result.findings)).toContain('BATTERY_LOW');
  });

  it('does not report a sensor fault when battery telemetry is not configured', () => {
    const result = assess(observation({ battery: undefined }));
    expect(codes(result.findings)).not.toContain('SENSOR_STALE:battery');
    expect(codes(result.findings)).not.toContain('BATTERY_LOW');
  });

  it('notes missing air data as info, since Mi Flora cannot measure humidity', () => {
    const result = assess(observation({ airTemp: [], humidity: [] }));
    expect(codes(result.findings)).toContain('AIR_SENSOR_MISSING');
    const finding = result.findings.find((f) => f.code === 'AIR_SENSOR_MISSING');
    expect(finding?.severity).toBe('info');
  });

  it('detects a dead probe when moisture ignores a watering', () => {
    const wateredAt = NOW - 2 * HOUR;
    // Flat 20% right across the watering event: the probe is not reading soil.
    const moisture: Series = Array.from({ length: 40 }, (_, i) => ({
      value: 20,
      at: NOW - (40 - i) * (5 * MINUTE),
    }));
    const result = assess(observation({ moisture, lastWateredAt: wateredAt }));
    expect(codes(result.findings)).toContain('PROBE_UNRESPONSIVE');
  });

  it('does not flag the probe when moisture responds to watering', () => {
    const wateredAt = NOW - 2 * HOUR;
    const moisture: Series = Array.from({ length: 40 }, (_, i) => {
      const at = NOW - (40 - i) * (5 * MINUTE);
      return { value: at <= wateredAt ? 20 : 40, at };
    });
    const result = assess(observation({ moisture, lastWateredAt: wateredAt }));
    expect(codes(result.findings)).not.toContain('PROBE_UNRESPONSIVE');
  });
});

describe('assess — plant condition', () => {
  it('flags low moisture as a warning', () => {
    const result = assess(observation({ moisture: fresh(20) }));
    expect(codes(result.findings)).toContain('MOISTURE_LOW');
    expect(result.severity).toBe('warn');
  });

  it('escalates severely dry soil to critical', () => {
    const result = assess(observation({ moisture: fresh(10) }));
    const finding = result.findings.find((f) => f.code === 'MOISTURE_LOW');
    expect(finding?.severity).toBe('critical');
  });

  it('flags wet, non-draining soil as a drainage problem', () => {
    const result = assess(observation({ moisture: fresh(60) }));
    expect(codes(result.findings)).toContain('MOISTURE_HIGH');
    expect(codes(result.findings)).toContain('DRAINAGE_POOR');
  });

  it('flags light and fertility outside target', () => {
    const dark = assess(observation({ lux: luxDay(10) }));
    expect(codes(dark.findings)).toContain('DLI_LOW');

    const paired = Array.from({ length: 5 }, (_, i) => ({
      conductivity: 120,
      moisture: 35,
      at: NOW - i * HOUR,
    }));
    const starved = assess(observation({ pairedConductivity: paired }));
    expect(codes(starved.findings)).toContain('EC_LOW');
  });

  it('reports insufficient data rather than guessing', () => {
    const result = assess(observation({ moisture: [] }));
    expect(codes(result.findings)).toContain('INSUFFICIENT_DATA');
  });
});

describe('assess — escalation policy', () => {
  it('escalates a genuine plant problem', () => {
    expect(assess(observation({ moisture: fresh(20) })).escalate).toBe(true);
  });

  it('does not escalate a pure sensor fault — that needs a battery, not an LLM', () => {
    const result = assess(observation({ moisture: fresh(100) }));
    expect(result.severity).toBe('critical');
    expect(result.escalate).toBe(false);
  });

  it('does not escalate info-only findings', () => {
    const result = assess(observation({ airTemp: [], humidity: [] }));
    expect(result.escalate).toBe(false);
  });
});
