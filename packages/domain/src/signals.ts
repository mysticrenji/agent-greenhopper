/**
 * The measurable signals in the system, and how fresh each one is expected to be.
 *
 * Cadence differs sharply by signal on Xiaomi Mi Flora hardware: moisture, soil
 * temperature, illuminance and conductivity are broadcast passively roughly once
 * a minute, while battery can only be read over an active BLE connection that
 * Home Assistant makes once per day. A single staleness threshold across all
 * signals would therefore raise constant false alarms on battery.
 */

/** Signals read directly from a Mi Flora (HHCCJCY01) unit. */
export const SOIL_SIGNALS = ['moisture', 'soilTemp', 'lux', 'conductivity', 'battery'] as const;

/** Signals that require a separate air sensor (Mi Flora cannot measure them). */
export const AIR_SIGNALS = ['airTemp', 'humidity'] as const;

export const SIGNALS = [...SOIL_SIGNALS, ...AIR_SIGNALS] as const;

export type SoilSignal = (typeof SOIL_SIGNALS)[number];
export type AirSignal = (typeof AIR_SIGNALS)[number];
export type Signal = (typeof SIGNALS)[number];

/** A single measurement at a point in time. `at` is unix milliseconds. */
export interface Sample {
  readonly value: number;
  readonly at: number;
}

/** An ordered series of samples, oldest first. */
export type Series = readonly Sample[];

/**
 * How old a reading may be before it is considered stale, per signal.
 *
 * Battery gets a 48h budget because Home Assistant only polls it once daily;
 * anything tighter would flag every healthy sensor. Air signals are looser than
 * soil signals because a room's climate sensor may report less frequently.
 */
export const STALENESS_BUDGET_MS: Readonly<Record<Signal, number>> = {
  moisture: 10 * 60_000,
  soilTemp: 10 * 60_000,
  lux: 10 * 60_000,
  conductivity: 10 * 60_000,
  battery: 48 * 60 * 60_000,
  airTemp: 30 * 60_000,
  humidity: 30 * 60_000,
};

/** Physically possible ranges. Values outside these indicate a faulty probe. */
export const PLAUSIBLE_RANGE: Readonly<Record<Signal, readonly [number, number]>> = {
  moisture: [0, 100],
  soilTemp: [-20, 60],
  lux: [0, 200_000],
  conductivity: [0, 10_000],
  battery: [0, 100],
  airTemp: [-20, 60],
  humidity: [0, 100],
};

export function isStale(sample: Sample, signal: Signal, now: number): boolean {
  return now - sample.at > STALENESS_BUDGET_MS[signal];
}

export function isPlausible(value: number, signal: Signal): boolean {
  const [min, max] = PLAUSIBLE_RANGE[signal];
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * True when every sample sits at one end of the sensor's range, which is the
 * signature of a corroded or disconnected Mi Flora probe rather than a real
 * reading. Requires a minimum sample count so a brief gap cannot trigger it.
 */
export function isPinnedAtRangeLimit(series: Series, signal: Signal, minSamples = 12): boolean {
  if (series.length < minSamples) return false;
  const [min, max] = PLAUSIBLE_RANGE[signal];
  return series.every((s) => s.value === min) || series.every((s) => s.value === max);
}
