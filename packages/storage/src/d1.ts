/**
 * Structural D1 types.
 *
 * Mirrors the subset of Cloudflare's `D1Database` this package uses, rather than
 * importing `@cloudflare/workers-types`. Same reasoning as `packages/hass`
 * (AGENTS.md section 4): the adapter stays free of runtime-specific types, so it
 * compiles with `lib: ES2022` and can be tested against real SQLite via
 * `node:sqlite` instead of a mock.
 *
 * A real `D1Database` satisfies `D1Like` structurally — no cast needed at the
 * composition root.
 */

export interface D1QueryResult<T> {
  readonly results: T[];
  readonly success: boolean;
}

export interface D1Statement {
  bind(...values: readonly unknown[]): D1Statement;
  all<T>(): Promise<D1QueryResult<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<D1QueryResult<unknown>>;
}

export interface D1Like {
  prepare(query: string): D1Statement;
  batch(statements: readonly D1Statement[]): Promise<readonly D1QueryResult<unknown>[]>;
}

/** Length of a rollup bucket. 15 minutes keeps ~96 rows/plant/day. */
export const BUCKET_MS = 15 * 60_000;

/**
 * Floor a timestamp to the start of its bucket.
 *
 * Alignment matters: it is what makes the rollup upsert idempotent. Two runs that
 * observe the same window must target the same primary key, or history grows
 * duplicate near-identical rows.
 */
export function bucketStart(atMs: number, bucketMs: number = BUCKET_MS): number {
  return Math.floor(atMs / bucketMs) * bucketMs;
}
