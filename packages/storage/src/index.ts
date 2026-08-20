/**
 * @packageDocumentation
 * D1 persistence for agent-greenhopper.
 *
 * Holds the long view of each plant. Home Assistant's recorder purges detail after
 * roughly 10 days, so anything that compares this month to last month reads from
 * here.
 *
 * Like `packages/hass`, this package defines the slice of the D1 API it needs
 * structurally rather than importing Cloudflare types, which is what lets its
 * tests run the real schema against real SQLite. The `node:sqlite` adapter lives
 * behind the separate `@greenhopper/storage/testing` entry point so it never
 * reaches a Worker bundle.
 */

export { AlertStateRepository } from './alertState.js';

export {
  BUCKET_MS,
  bucketStart,
  type D1Like,
  type D1QueryResult,
  type D1Statement,
} from './d1.js';

export {
  type NotificationEntry,
  NotificationLog,
} from './notifications.js';

export {
  type MeasurementColumn,
  type ReadingRow,
  ReadingsRepository,
  rollupSeries,
  SIGNAL_COLUMN,
  type StorableSignal,
} from './readings.js';
