import { describe, expect, it } from 'vitest';
import {
  conductivityAtMoisture,
  dailyLightIntegral,
  daysUntilMoisture,
  dryDownRate,
  median,
  vapourPressureDeficit,
} from './metrics.js';
import type { Series } from './signals.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/** Build a series with samples spaced `stepMs` apart, oldest first. */
function series(values: readonly number[], stepMs = HOUR, start = T0): Series {
  return values.map((value, i) => ({ value, at: start + i * stepMs }));
}

describe('vapourPressureDeficit', () => {
  it('returns 0 at full saturation regardless of temperature', () => {
    expect(vapourPressureDeficit(25, 100)).toBe(0);
    expect(vapourPressureDeficit(10, 100)).toBe(0);
  });

  it('distinguishes identical temperatures at different humidity', () => {
    // The whole reason VPD exists: same temp, very different plant environment.
    const dry = vapourPressureDeficit(25, 40);
    const humid = vapourPressureDeficit(25, 80);
    expect(dry).not.toBeNull();
    expect(humid).not.toBeNull();
    expect(dry as number).toBeGreaterThan(humid as number);
  });

  it('matches the Tetens equation at a known point', () => {
    // es(25 C) = 0.6108 * exp(17.27*25/262.3) ~= 3.167 kPa; at 50% RH, VPD ~= 1.584
    expect(vapourPressureDeficit(25, 50)).toBeCloseTo(1.584, 2);
  });

  it('rejects impossible humidity and non-finite input', () => {
    expect(vapourPressureDeficit(20, 101)).toBeNull();
    expect(vapourPressureDeficit(20, -1)).toBeNull();
    expect(vapourPressureDeficit(Number.NaN, 50)).toBeNull();
  });
});

describe('dryDownRate', () => {
  it('is negative while soil dries', () => {
    // 40% -> 34% over 24 hourly samples is about -6 points/day.
    const moisture = series([
      40, 39.7, 39.5, 39.2, 39, 38.7, 38.5, 38.2, 38, 37.7, 37.5, 37.2, 37, 36.7, 36.5, 36.2, 36,
      35.7, 35.5, 35.2, 35, 34.7, 34.5, 34.2,
    ]);
    const rate = dryDownRate(moisture);
    expect(rate).not.toBeNull();
    expect(rate as number).toBeCloseTo(-6, 0);
  });

  it('is near zero for stable soil', () => {
    const rate = dryDownRate(series([30, 30, 30, 30, 30]));
    expect(rate).toBeCloseTo(0, 6);
  });

  it('is positive after watering', () => {
    const rate = dryDownRate(series([20, 25, 32, 40]));
    expect(rate as number).toBeGreaterThan(0);
  });

  it('needs at least two samples', () => {
    expect(dryDownRate([])).toBeNull();
    expect(dryDownRate(series([30]))).toBeNull();
  });

  it('returns null when all samples share a timestamp', () => {
    expect(dryDownRate(series([30, 31, 32], 0))).toBeNull();
  });
});

describe('daysUntilMoisture', () => {
  it('projects the crossing of a threshold', () => {
    // Drying 12 points/day from 36%; reaching 24% should take about one day.
    const moisture = series([48, 42, 36], 12 * HOUR);
    expect(daysUntilMoisture(moisture, 24)).toBeCloseTo(1, 1);
  });

  it('returns null when soil is not drying', () => {
    expect(daysUntilMoisture(series([20, 25, 30]), 15)).toBeNull();
  });

  it('returns null when already below the threshold', () => {
    expect(daysUntilMoisture(series([20, 15, 10]), 15)).toBeNull();
  });

  it('returns null without data', () => {
    expect(daysUntilMoisture([], 20)).toBeNull();
  });
});

describe('dailyLightIntegral', () => {
  it('integrates a constant light level over time', () => {
    // 10,000 lux for 12 h at the default factor:
    // 10000 * 0.0185 = 185 umol/m2/s * 43200 s = 7.992e6 umol = ~7.99 mol
    const lux = series([10_000, 10_000], 12 * HOUR);
    expect(dailyLightIntegral(lux)).toBeCloseTo(7.992, 2);
  });

  it('scales with the conversion factor', () => {
    const lux = series([10_000, 10_000], 12 * HOUR);
    const base = dailyLightIntegral(lux, 0.0185) as number;
    const doubled = dailyLightIntegral(lux, 0.037) as number;
    expect(doubled).toBeCloseTo(base * 2, 3);
  });

  it('returns null for darkness and for too few samples', () => {
    expect(dailyLightIntegral(series([0, 0, 0]))).toBeNull();
    expect(dailyLightIntegral(series([500]))).toBeNull();
  });

  it('ignores samples that go backwards in time', () => {
    const out = dailyLightIntegral([
      { value: 1000, at: T0 },
      { value: 1000, at: T0 - HOUR },
    ]);
    expect(out).toBeNull();
  });
});

describe('conductivityAtMoisture', () => {
  const readings = [
    { conductivity: 500, moisture: 30, at: T0 },
    { conductivity: 520, moisture: 31, at: T0 + HOUR },
    { conductivity: 480, moisture: 29, at: T0 + 2 * HOUR },
    // Taken in bone-dry soil: EC collapses even though fertility is unchanged.
    { conductivity: 40, moisture: 8, at: T0 + 3 * HOUR },
  ];

  it('excludes readings outside the moisture band', () => {
    // The 40 uS/cm dry-soil reading must not drag the result down.
    expect(conductivityAtMoisture(readings, 30)).toBe(500);
  });

  it('returns null when too few readings fall inside the band', () => {
    expect(conductivityAtMoisture(readings, 80)).toBeNull();
  });

  it('honours a widened tolerance', () => {
    const result = conductivityAtMoisture(readings, 20, 25);
    expect(result).not.toBeNull();
    // With all four readings in band the median sits between the dry and wet values.
    expect(result as number).toBeLessThan(500);
  });
});

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('returns NaN for an empty list', () => {
    expect(median([])).toBeNaN();
  });
});
