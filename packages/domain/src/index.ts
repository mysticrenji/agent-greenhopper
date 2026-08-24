/**
 * @packageDocumentation
 * Pure domain logic for plant monitoring.
 *
 * This package has no dependency on Cloudflare Workers, Home Assistant, or any
 * other infrastructure — only on `zod` for schema definition. That constraint is
 * deliberate: it keeps the rules and safety logic fast to test and reusable from
 * any runtime. Adapters depend on the domain; the domain depends on nothing.
 */

export {
  type AlertAction,
  type AlertChannel,
  type AlertInput,
  type AlertPlan,
  type AlertPolicy,
  type AlertState,
  DEFAULT_ALERT_POLICY,
  inQuietHours,
  planAlerts,
} from './alerts.js';
export {
  type Assessment,
  assess,
  type Derived,
  derive,
  type Finding,
  type FindingCode,
  isSensorFaultCode,
  type PlantObservation,
  type Severity,
  severityRank,
} from './assess.js';

export {
  type ConductivityReading,
  conductivityAtMoisture,
  DAYLIGHT_LUX_TO_PPFD,
  dailyLightIntegral,
  daysUntilMoisture,
  dryDownRate,
  latest,
  median,
  vapourPressureDeficit,
} from './metrics.js';

export {
  DEFAULT_WATERING_POLICY,
  type PlantProfile,
  type PlantRegistry,
  parsePlantRegistry,
  plantProfileSchema,
  plantRegistrySchema,
  type WateringPolicy,
  wateringPolicySchema,
} from './plant.js';

export {
  AIR_SIGNALS,
  type AirSignal,
  isPinnedAtRangeLimit,
  isPlausible,
  isStale,
  PLAUSIBLE_RANGE,
  type Sample,
  type Series,
  SIGNALS,
  type Signal,
  SOIL_SIGNALS,
  type SoilSignal,
  STALENESS_BUDGET_MS,
} from './signals.js';
