/**
 * Derived metrics.
 *
 * Three of the five monitored signals are misleading when compared raw against a
 * threshold. This module converts them into the quantities that actually
 * describe plant conditions:
 *
 *   - moisture     -> dry-down slope (%/day) and projected time to threshold
 *   - lux          -> daily light integral (relative)
 *   - temp + RH    -> vapour pressure deficit
 *   - conductivity -> value normalised to a reference moisture level
 *
 * All functions are pure and total: they return `null` rather than throwing when
 * the input is insufficient, so callers handle "not enough data yet" explicitly.
 */

import type { Sample, Series } from './signals.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1_000;

/**
 * Vapour pressure deficit in kPa, via the Tetens equation.
 *
 * VPD drives transpiration and is a function of both temperature and humidity:
 * 25 C at 40% RH and 25 C at 80% RH are entirely different environments for a
 * plant, which is why neither input is useful alone.
 */
export function vapourPressureDeficit(airTempC: number, humidityPct: number): number | null {
  if (!Number.isFinite(airTempC) || !Number.isFinite(humidityPct)) return null;
  if (humidityPct < 0 || humidityPct > 100) return null;

  const saturated = 0.6108 * Math.exp((17.27 * airTempC) / (airTempC + 237.3));
  const actual = saturated * (humidityPct / 100);
  return round(saturated - actual, 3);
}

/** Least-squares slope of `value` against time, expressed per day. */
function slopePerDay(series: Series): number | null {
  if (series.length < 2) return null;

  let n = 0;
  let sumT = 0;
  let sumV = 0;
  let sumTT = 0;
  let sumTV = 0;

  const origin = series[0]?.at ?? 0;
  for (const { value, at } of series) {
    if (!Number.isFinite(value)) continue;
    const t = (at - origin) / MS_PER_DAY;
    n += 1;
    sumT += t;
    sumV += value;
    sumTT += t * t;
    sumTV += t * value;
  }
  if (n < 2) return null;

  const denominator = n * sumTT - sumT * sumT;
  if (denominator === 0) return null;

  return (n * sumTV - sumT * sumV) / denominator;
}

/**
 * Rate of soil drying in percentage points per day. Negative means drying.
 *
 * A single moisture reading cannot distinguish "just watered and draining" from
 * "stable and healthy"; the slope can. A steepening slope suggests rising
 * transpiration or a root-bound pot, while a flat slope near saturation suggests
 * poor drainage.
 */
export function dryDownRate(moisture: Series): number | null {
  const slope = slopePerDay(moisture);
  return slope === null ? null : round(slope, 3);
}

/**
 * Days until moisture is projected to fall to `threshold`, based on the current
 * dry-down rate. Returns null when the soil is not drying or is already below
 * the threshold — in both cases a projection would be meaningless.
 */
export function daysUntilMoisture(moisture: Series, threshold: number): number | null {
  const latest = moisture.at(-1);
  if (!latest) return null;

  const rate = dryDownRate(moisture);
  if (rate === null || rate >= 0) return null;
  if (latest.value <= threshold) return null;

  return round((latest.value - threshold) / -rate, 2);
}

/**
 * Default lux -> PPFD factor for daylight (umol/m2/s per lux).
 *
 * Only valid as an order of magnitude. A Mi Flora sits at soil level facing up,
 * well below canopy height, so the absolute figure understates true canopy PAR.
 * Treat the resulting DLI as a relative index for day-over-day comparison, not
 * as a value to check against published per-species DLI tables.
 */
export const DAYLIGHT_LUX_TO_PPFD = 0.0185;

/**
 * Daily light integral in mol/m2/day, trapezoidally integrated over the series.
 *
 * Instantaneous lux is nearly useless for plant health because it swings orders
 * of magnitude as clouds pass. The integrated daily dose is what plants respond
 * to.
 */
export function dailyLightIntegral(lux: Series, luxToPpfd = DAYLIGHT_LUX_TO_PPFD): number | null {
  if (lux.length < 2) return null;

  let micromoles = 0;
  let hasMeasuredInterval = false;
  for (let i = 1; i < lux.length; i += 1) {
    const previous = lux[i - 1];
    const current = lux[i];
    if (!previous || !current) continue;

    const seconds = (current.at - previous.at) / MS_PER_SECOND;
    if (seconds <= 0) continue;

    hasMeasuredInterval = true;
    const meanPpfd = ((previous.value + current.value) / 2) * luxToPpfd;
    micromoles += meanPpfd * seconds;
  }

  return hasMeasuredInterval ? round(micromoles / 1_000_000, 3) : null;
}

export interface ConductivityReading {
  readonly conductivity: number;
  readonly moisture: number;
  readonly at: number;
}

/**
 * Median conductivity restricted to readings taken near a reference moisture.
 *
 * Soil conductivity probes measure the conductivity of soil *water*, so the
 * reading moves with water content. Comparing a value from dry soil against one
 * taken just after watering shows a fertility "crash" that is really just the
 * pot drying out. Restricting comparison to a narrow moisture band removes the
 * confound; returns null when too few readings fall inside the band.
 */
export function conductivityAtMoisture(
  readings: readonly ConductivityReading[],
  referenceMoisture: number,
  tolerance = 3,
  minSamples = 3,
): number | null {
  const inBand = readings
    .filter((r) => Math.abs(r.moisture - referenceMoisture) <= tolerance)
    .map((r) => r.conductivity)
    .filter((v) => Number.isFinite(v));

  if (inBand.length < minSamples) return null;
  return round(median(inBand), 1);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  return low === undefined || high === undefined ? Number.NaN : (low + high) / 2;
}

export function latest(series: Series): Sample | null {
  return series.at(-1) ?? null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
