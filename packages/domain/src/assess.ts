/**
 * Deterministic assessment rules.
 *
 * These run before any LLM is consulted. They produce the baseline verdict, and
 * only their output decides whether escalating to a model is worth the cost. Two
 * consequences worth keeping in mind when editing:
 *
 *   - Every rule here is cheap, explainable and testable. Prefer adding a rule
 *     over widening the LLM's remit.
 *   - Sensor faults are assessed *first*. Reasoning about plant health from a
 *     dead probe is worse than reporting nothing.
 */

import type { ConductivityReading } from './metrics.js';
import {
  conductivityAtMoisture,
  dailyLightIntegral,
  dryDownRate,
  latest,
  vapourPressureDeficit,
} from './metrics.js';
import type { PlantProfile } from './plant.js';
import type { Series, Signal, SoilSignal } from './signals.js';
import { isPinnedAtRangeLimit, isPlausible, isStale, SIGNALS } from './signals.js';

export type Severity = 'ok' | 'info' | 'warn' | 'critical';

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  ok: 0,
  info: 1,
  warn: 2,
  critical: 3,
};

/** Ordinal rank of a severity, for comparison. Higher is worse. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}

type SignalScopedSensorFaultCode =
  | `SENSOR_STALE:${Signal}`
  | `SENSOR_IMPLAUSIBLE:${Signal}`
  | `SENSOR_PINNED:${SoilSignal}`;

export type FindingCode =
  // Sensor health. Sensor faults include the signal so alert state can track
  // independently failing probes without colliding on (plant_id, code).
  | SignalScopedSensorFaultCode
  | 'PROBE_UNRESPONSIVE'
  | 'BATTERY_LOW'
  | 'AIR_SENSOR_MISSING'
  // Plant condition
  | 'MOISTURE_LOW'
  | 'MOISTURE_HIGH'
  | 'DRY_SOON'
  | 'DRAINAGE_POOR'
  | 'SOIL_TEMP_LOW'
  | 'SOIL_TEMP_HIGH'
  | 'VPD_HIGH'
  | 'VPD_LOW'
  | 'DLI_LOW'
  | 'DLI_HIGH'
  | 'EC_LOW'
  | 'EC_HIGH'
  | 'INSUFFICIENT_DATA';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly message: string;
  readonly observed?: number;
  readonly expected?: string;
}

export interface PlantObservation {
  readonly profile: PlantProfile;
  readonly now: number;
  readonly moisture: Series;
  readonly soilTemp: Series;
  readonly lux: Series;
  readonly conductivity: Series;
  /** Absent when Home Assistant exposes no battery telemetry for the probe. */
  readonly battery?: Series;
  readonly airTemp: Series;
  readonly humidity: Series;
  /** Conductivity paired with the moisture reading taken at the same time. */
  readonly pairedConductivity: readonly ConductivityReading[];
  /** Unix ms of the last watering, if any is on record. */
  readonly lastWateredAt: number | null;
}

export interface Derived {
  readonly moisture: number | null;
  readonly dryRatePerDay: number | null;
  readonly soilTemp: number | null;
  readonly vpd: number | null;
  readonly dli: number | null;
  readonly conductivityNormalised: number | null;
}

export interface Assessment {
  readonly plantId: string;
  readonly severity: Severity;
  readonly findings: readonly Finding[];
  readonly derived: Derived;
  /** True when an LLM opinion is likely to add value beyond these rules. */
  readonly escalate: boolean;
}

/** Moisture must rise by this much within the window to prove the probe works. */
const PROBE_RESPONSE_THRESHOLD = 5;
const PROBE_RESPONSE_WINDOW_MS = 30 * 60_000;
const BATTERY_LOW_PCT = 15;
const DLI_WINDOW_MS = 24 * 60 * 60_000;
// A one-hour tolerance accommodates reporting jitter without treating a partial day as a DLI.
const DLI_MIN_COVERAGE_MS = 23 * 60 * 60_000;
const DLI_MAX_GAP_MS = 2 * 60 * 60_000;

export function derive(observation: PlantObservation): Derived {
  const referenceMoisture =
    (observation.profile.targets.moisture.min + observation.profile.targets.moisture.max) / 2;

  return {
    moisture: latest(observation.moisture)?.value ?? null,
    dryRatePerDay: dryDownRate(observation.moisture),
    soilTemp: latest(observation.soilTemp)?.value ?? null,
    vpd: deriveVpd(observation),
    dli: deriveDli(observation.lux, observation.now),
    conductivityNormalised: conductivityAtMoisture(
      observation.pairedConductivity,
      referenceMoisture,
    ),
  };
}

function deriveDli(lux: Series, now: number): number | null {
  const windowStart = now - DLI_WINDOW_MS;
  const rollingDay = lux.filter((sample) => sample.at >= windowStart && sample.at <= now);
  const first = rollingDay[0];
  const last = latest(rollingDay);
  if (!first || !last || last.at - first.at < DLI_MIN_COVERAGE_MS) return null;
  if (
    rollingDay.some((sample, index) => {
      const previous = rollingDay[index - 1];
      return previous ? sample.at - previous.at > DLI_MAX_GAP_MS : false;
    })
  ) {
    return null;
  }
  return dailyLightIntegral(rollingDay);
}

function deriveVpd(observation: PlantObservation): number | null {
  const airTemp = latest(observation.airTemp);
  const humidity = latest(observation.humidity);
  if (!airTemp || !humidity) return null;
  return vapourPressureDeficit(airTemp.value, humidity.value);
}

export function assess(observation: PlantObservation): Assessment {
  const derived = derive(observation);
  const sensorFindings = assessSensors(observation);
  const unusableSignals = sensorFindings.reduce<Set<Signal>>((signals, finding) => {
    const signal = signalFromSensorFault(finding.code);
    if (signal) signals.add(signal);
    return signals;
  }, new Set());
  const conditionFindings = assessCondition(observation, derived, unusableSignals);
  const findings = [...sensorFindings, ...conditionFindings];

  const severity = findings.reduce<Severity>(
    (worst, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst] ? f.severity : worst),
    'ok',
  );

  return {
    plantId: observation.profile.id,
    severity,
    findings,
    derived,
    escalate: shouldEscalate(findings, severity),
  };
}

function signalFromSensorFault(code: FindingCode): Signal | null {
  if (code === 'PROBE_UNRESPONSIVE') return 'moisture';
  if (!isSignalScopedSensorFaultCode(code)) return null;
  return SIGNALS.find((signal) => code.endsWith(`:${signal}`)) ?? null;
}

/**
 * Escalate only when the rules found something actionable but not when the cause
 * is a broken sensor — a dead probe needs a new battery, not an LLM.
 */
function shouldEscalate(findings: readonly Finding[], severity: Severity): boolean {
  if (SEVERITY_ORDER[severity] < SEVERITY_ORDER.warn) return false;
  return findings.some((f) => !isSensorFaultCode(f.code) && f.severity !== 'info');
}

export function isSensorFaultCode(code: FindingCode): boolean {
  return (
    isSignalScopedSensorFaultCode(code) ||
    code === 'PROBE_UNRESPONSIVE' ||
    code === 'BATTERY_LOW' ||
    code === 'AIR_SENSOR_MISSING'
  );
}

function isSignalScopedSensorFaultCode(code: FindingCode): code is SignalScopedSensorFaultCode {
  return (
    code.startsWith('SENSOR_STALE:') ||
    code.startsWith('SENSOR_IMPLAUSIBLE:') ||
    code.startsWith('SENSOR_PINNED:')
  );
}

/** Health checks for one signal's series: presence, freshness, plausibility, pinning. */
function checkSignalHealth(
  signal: Signal,
  series: Series,
  now: number,
  pinnedSignal: SoilSignal | null = null,
): Finding[] {
  const current = latest(series);
  if (!current) {
    return [
      {
        code: `SENSOR_STALE:${signal}`,
        severity: 'warn',
        message: `No ${signal} readings available.`,
      },
    ];
  }

  const findings: Finding[] = [];

  if (isStale(current, signal, now)) {
    findings.push({
      code: `SENSOR_STALE:${signal}`,
      severity: 'warn',
      message: `${signal} reading is stale (last seen ${formatAge(now - current.at)} ago).`,
    });
  }
  if (!isPlausible(current.value, signal)) {
    findings.push({
      code: `SENSOR_IMPLAUSIBLE:${signal}`,
      severity: 'critical',
      message: `${signal} value ${current.value} is outside the physically possible range.`,
      observed: current.value,
    });
  }
  if (pinnedSignal && isPinnedAtRangeLimit(series, pinnedSignal)) {
    findings.push({
      code: `SENSOR_PINNED:${pinnedSignal}`,
      severity: 'critical',
      message: `${signal} has been pinned at its range limit — probe likely corroded.`,
      observed: current.value,
    });
  }

  return findings;
}

function checkBattery(battery: Series | undefined): Finding[] {
  if (!battery) return [];
  const current = latest(battery);
  if (!current || current.value >= BATTERY_LOW_PCT) return [];
  return [
    {
      code: 'BATTERY_LOW',
      severity: 'warn',
      message: `Battery at ${current.value}% — replace the CR2032 soon.`,
      observed: current.value,
      expected: `>= ${BATTERY_LOW_PCT}%`,
    },
  ];
}

function checkAirSensor(observation: PlantObservation): Finding[] {
  if (latest(observation.airTemp) && latest(observation.humidity)) return [];
  return [
    {
      code: 'AIR_SENSOR_MISSING',
      severity: 'info',
      message:
        'No air temperature/humidity reading for this room, so VPD cannot be computed. ' +
        'Mi Flora cannot measure humidity; a separate room sensor is required.',
    },
  ];
}

function assessSensors(observation: PlantObservation): Finding[] {
  const soilSeries: ReadonlyArray<readonly [SoilSignal, Series]> = [
    ['moisture', observation.moisture],
    ['soilTemp', observation.soilTemp],
    ['lux', observation.lux],
    ['conductivity', observation.conductivity],
  ];

  const batteryFindings = observation.battery
    ? checkSignalHealth('battery', observation.battery, observation.now)
    : [];

  return [
    ...soilSeries.flatMap(([signal, series]) =>
      checkSignalHealth(signal, series, observation.now, signal),
    ),
    ...assessAirSensors(observation),
    ...batteryFindings,
    ...checkBattery(observation.battery),
    ...checkAirSensor(observation),
    ...probeFailedToRespond(observation),
  ];
}

function assessAirSensors(observation: PlantObservation): Finding[] {
  if (!latest(observation.airTemp) || !latest(observation.humidity)) return [];
  return [
    ...checkSignalHealth('airTemp', observation.airTemp, observation.now),
    ...checkSignalHealth('humidity', observation.humidity, observation.now),
  ];
}

/**
 * The most reliable dead-probe test available: if a watering was logged and
 * moisture did not rise within the response window, the probe is not reading the
 * soil.
 */
function probeFailedToRespond(observation: PlantObservation): Finding[] {
  const { lastWateredAt, moisture, now } = observation;
  if (lastWateredAt === null) return [];

  const windowEnd = lastWateredAt + PROBE_RESPONSE_WINDOW_MS;
  if (now < windowEnd) return [];

  const before = moisture.filter((s) => s.at <= lastWateredAt).at(-1);
  const after = moisture.filter((s) => s.at > lastWateredAt && s.at <= windowEnd);
  if (!before || after.length === 0) return [];

  const peak = Math.max(...after.map((s) => s.value));
  const rise = peak - before.value;
  if (rise >= PROBE_RESPONSE_THRESHOLD) return [];

  return [
    {
      code: 'PROBE_UNRESPONSIVE',
      severity: 'critical',
      message:
        `Moisture rose only ${round(rise)} points after watering ` +
        `(expected >= ${PROBE_RESPONSE_THRESHOLD}). The probe is probably dead.`,
      observed: round(rise),
    },
  ];
}

function assessCondition(
  observation: PlantObservation,
  derived: Derived,
  unusableSignals: ReadonlySet<Signal>,
): Finding[] {
  const { targets } = observation.profile;
  const findings = assessMoisture(derived, targets.moisture, !unusableSignals.has('moisture'));

  if (!unusableSignals.has('soilTemp')) {
    findings.push(
      ...rangeFinding(
        'SOIL_TEMP_LOW',
        'SOIL_TEMP_HIGH',
        'Soil temperature',
        'C',
        derived.soilTemp,
        targets.soilTemp,
      ),
    );
  }
  if (!unusableSignals.has('airTemp') && !unusableSignals.has('humidity')) {
    findings.push(...rangeFinding('VPD_LOW', 'VPD_HIGH', 'VPD', 'kPa', derived.vpd, targets.vpd));
  }
  if (!unusableSignals.has('lux')) {
    findings.push(
      ...rangeFinding(
        'DLI_LOW',
        'DLI_HIGH',
        'Daily light integral',
        'mol/m2/day',
        derived.dli,
        targets.dli,
      ),
    );
  }
  if (!unusableSignals.has('moisture') && !unusableSignals.has('conductivity')) {
    findings.push(
      ...rangeFinding(
        'EC_LOW',
        'EC_HIGH',
        'Fertility (EC)',
        'uS/cm',
        derived.conductivityNormalised,
        targets.conductivity,
      ),
    );
  }

  return findings;
}

function assessMoisture(
  derived: Derived,
  target: { min: number; max: number },
  usable: boolean,
): Finding[] {
  if (derived.moisture === null) {
    return [
      {
        code: 'INSUFFICIENT_DATA',
        severity: 'info',
        message: 'No moisture data, so plant condition cannot be assessed.',
      },
    ];
  }
  if (!usable) return [];
  if (derived.moisture < target.min) {
    return [
      {
        code: 'MOISTURE_LOW',
        severity: derived.moisture < target.min / 2 ? 'critical' : 'warn',
        message: `Soil moisture ${derived.moisture}% is below the target minimum.`,
        observed: derived.moisture,
        expected: `>= ${target.min}%`,
      },
    ];
  }
  if (derived.moisture > target.max) {
    const findings: Finding[] = [
      {
        code: 'MOISTURE_HIGH',
        severity: 'warn',
        message: `Soil moisture ${derived.moisture}% is above the target maximum.`,
        observed: derived.moisture,
        expected: `<= ${target.max}%`,
      },
    ];

    // Saturated soil that is not drying points at drainage, not watering habits.
    if (derived.dryRatePerDay !== null && Math.abs(derived.dryRatePerDay) < 0.5) {
      findings.push({
        code: 'DRAINAGE_POOR',
        severity: 'warn',
        message: 'Soil is wet and barely drying — check drainage and pot compaction.',
        observed: derived.dryRatePerDay,
      });
    }
    return findings;
  }
  return [];
}

function rangeFinding(
  lowCode: FindingCode,
  highCode: FindingCode,
  label: string,
  unit: string,
  value: number | null,
  target: { min: number; max: number },
): Finding[] {
  if (value === null) return [];
  if (value < target.min) {
    return [
      {
        code: lowCode,
        severity: 'warn',
        message: `${label} ${value} ${unit} is below target.`,
        observed: value,
        expected: `>= ${target.min} ${unit}`,
      },
    ];
  }
  if (value > target.max) {
    return [
      {
        code: highCode,
        severity: 'warn',
        message: `${label} ${value} ${unit} is above target.`,
        observed: value,
        expected: `<= ${target.max} ${unit}`,
      },
    ];
  }
  return [];
}

function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${round(hours)}h`;
  return `${round(hours / 24)}d`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
