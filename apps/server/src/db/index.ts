import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export { schema };

export interface OpenDbOptions {
  path: string; // ':memory:' for tests
  migrationsFolder?: string;
}

function defaultMigrationsFolder(): string {
  // dist/db/index.js → ../../drizzle ; src/db/index.ts → ../../drizzle
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

export function openDb(opts: OpenDbOptions): { db: Db; sqlite: Database.Database } {
  if (opts.path !== ':memory:') {
    const dir = dirname(opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(opts.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder ?? defaultMigrationsFolder() });
  return { db, sqlite };
}
