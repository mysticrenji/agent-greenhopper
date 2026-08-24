/**
 * A `D1Like` implementation backed by `node:sqlite`, for tests and local tooling.
 *
 * **Not exported from the package root on purpose.** It imports `node:sqlite`,
 * which does not exist in the Workers runtime, so pulling it in from `index.ts`
 * would break any Worker that imports this package. Reach it via the
 * `@greenhopper/storage/testing` entry point instead.
 *
 * The value of this over a hand-written mock: D1 *is* SQLite, so tests execute the
 * real migration DDL and the real queries. A mistyped column or a broken
 * `ON CONFLICT` clause fails the test suite rather than production.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Like, D1QueryResult, D1Statement } from '../d1.js';

class SqliteStatement implements D1Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: readonly unknown[]): D1Statement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async all<T>(): Promise<D1QueryResult<T>> {
    const results = this.db.prepare(this.sql).all(...(this.values as never[])) as T[];
    return { results, success: true };
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.values as never[]));
    return (row ?? null) as T | null;
  }

  async run(): Promise<D1QueryResult<unknown>> {
    this.db.prepare(this.sql).run(...(this.values as never[]));
    return { results: [], success: true };
  }
}

class SqliteD1 implements D1Like {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): D1Statement {
    return new SqliteStatement(this.db, query);
  }

  /**
   * Runs statements inside a transaction, matching D1's all-or-nothing batch
   * semantics closely enough that ordering mistakes surface in tests.
   */
  async batch(statements: readonly D1Statement[]): Promise<readonly D1QueryResult<unknown>[]> {
    this.db.exec('BEGIN');
    try {
      const results: D1QueryResult<unknown>[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface TestDatabase {
  readonly d1: D1Like;
  /** Escape hatch for assertions that are easier to express in raw SQL. */
  readonly raw: DatabaseSync;
  close(): void;
}

/** Every migration file, in filename order. */
export function migrationSql(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, '..', '..', 'migrations');
  // Listed explicitly rather than globbed so that adding a migration is a visible
  // change here, and ordering can never depend on filesystem iteration order.
  return ['0001_init.sql', '0002_run_lock.sql'].map((file) =>
    readFileSync(join(migrationsDir, file), 'utf8'),
  );
}

/** In-memory database with all migrations applied. */
export function createTestDatabase(): TestDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of migrationSql()) db.exec(sql);

  return {
    d1: new SqliteD1(db),
    raw: db,
    close: () => db.close(),
  };
}
