/**
 * @packageDocumentation
 * Home Assistant adapter — **read-only** except for notification delivery.
 *
 * Depends on `@greenhopper/domain` and nothing infrastructural: no Cloudflare
 * types, no `fetch` global. The composition root injects an `HttpFetch`, which in
 * production is a one-line wrapper over a Workers VPC binding.
 *
 * There is no generic service-call capability anywhere in this package. That
 * absence is the primary safety property of the system (ADR 0003).
 */

export {
  checkSetup,
  type EntityReport,
  type EntityStatus,
  expectedEntityCount,
  type PlantReport,
  summarise,
} from './diagnostics.js';

export {
  allEntityIds,
  type EntityRegistry,
  entityIdsOf,
  entityRegistrySchema,
  type MiFloraEntityArgs,
  miFloraEntities,
  type PlantEntities,
  plantEntitiesSchema,
} from './entities.js';

export { assertNotifyService, HassNotifier, type Notification } from './notifier.js';

export {
  buildObservation,
  inferLastWatering,
  type ObservationSources,
  pairConductivityWithMoisture,
} from './observations.js';

export { HassReader } from './reader.js';
export {
  type HassHistoryEntry,
  type HassState,
  hassHistoryEntrySchema,
  hassHistorySchema,
  hassStateSchema,
  hassStatesSchema,
  isAbsent,
  toSample,
} from './schema.js';
export {
  describeResolution,
  FALLBACK_NOTIFY_SERVICE,
  listNotifyServices,
  type NotifyResolution,
  resolveNotifyTarget,
} from './services.js';

export {
  type HassConfig,
  HassError,
  type HttpFetch,
  type HttpRequestInit,
  type HttpResponse,
  requestJson,
} from './transport.js';
