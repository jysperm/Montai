import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import type { MontaiDb } from './index.js';

const require = createRequire(import.meta.url);
const { pushSQLiteSchema } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Snapshot {
  tables: Record<string, { columns: Record<string, unknown> }>;
}

export async function applyMigrations(instance: MontaiDb, sqlite: Database.Database) {
  await baselineLegacyDb(instance, sqlite);
  await repairSquashedMigration(instance, sqlite);

  // A migration that recreates a table needs foreign keys off, and the `PRAGMA foreign_keys`
  // statements drizzle-kit writes into it are no-ops inside migrate()'s transaction.
  sqlite.pragma('foreign_keys = OFF');
  migrate(instance, { migrationsFolder });
  sqlite.pragma('foreign_keys = ON');
}

// Databases created before migrations existed have no `__drizzle_migrations` table. Record the
// release their schema already matches, so only the migrations they actually miss run.
async function baselineLegacyDb(instance: MontaiDb, sqlite: Database.Database) {
  if (hasMigrationsTable(sqlite)) return;

  const journal = readJournal();

  let baseline: JournalEntry | undefined;
  for (const entry of journal.entries) {
    if (matchesSnapshot(sqlite, readSnapshot(entry))) baseline = entry;
  }

  if (!baseline) {
    const isEmpty = !sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .get();
    if (isEmpty) return;

    // Matching no release means an unreleased build pushed it, or it was edited by hand.
    await pushCurrentSchema(instance, sqlite);
    baseline = journal.entries[journal.entries.length - 1];
  }

  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  sqlite
    .prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)')
    .run(hashMigration(baseline), baseline.when);
}

// A database that applied a head migration squashed away at release time records a hash no file
// has any more, and sits at a schema no migration can express. One whose record is newer than every
// migration comes from a later release and is left alone.
async function repairSquashedMigration(instance: MontaiDb, sqlite: Database.Database) {
  if (!hasMigrationsTable(sqlite)) return;

  const last = sqlite
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { hash: string; created_at: number } | undefined;
  if (!last) return;

  const { entries } = readJournal();
  const latest = entries[entries.length - 1];
  if (last.created_at > latest.when) return;
  if (entries.some((entry) => hashMigration(entry) === last.hash)) return;

  await pushCurrentSchema(instance, sqlite);
  sqlite
    .prepare('UPDATE __drizzle_migrations SET hash = ?, created_at = ? WHERE created_at = ?')
    .run(hashMigration(latest), latest.when, last.created_at);
}

function hasMigrationsTable(sqlite: Database.Database) {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`).get();
}

function readJournal() {
  const path = join(migrationsFolder, 'meta', '_journal.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { entries: JournalEntry[] };
}

function hashMigration(entry: JournalEntry) {
  const sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
  return createHash('sha256').update(sql).digest('hex');
}

function readSnapshot(entry: JournalEntry) {
  const path = join(migrationsFolder, 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

// A database matches a release when its tables and columns are exactly the ones it declared.
function matchesSnapshot(sqlite: Database.Database, snapshot: Snapshot) {
  const tables = (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string;
    }[]
  ).map((table) => table.name);

  if (tables.length !== Object.keys(snapshot.tables).length) return false;

  return tables.every((table) => {
    const expected = snapshot.tables[table];
    if (!expected) return false;
    const columns = sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
    return (
      columns.length === Object.keys(expected.columns).length && columns.every((column) => column.name in expected.columns)
    );
  });
}

async function pushCurrentSchema(instance: MontaiDb, sqlite: Database.Database) {
  // Suppress drizzle-kit's "[✓] Pulling schema from database..." message but pass through any
  // other output (e.g. interactive conflict resolution prompts)
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalConsoleLog = console.log.bind(console);
  process.stdout.write = function (chunk: any, ...args: any[]) {
    if (typeof chunk === 'string' && chunk.includes('Pulling schema from database')) return true;
    return originalStdoutWrite(chunk, ...args);
  } as typeof process.stdout.write;
  console.log = function (...args: any[]) {
    const msg = args.map(String).join(' ');
    if (msg.includes('Pulling schema from database')) return;
    originalConsoleLog(...args);
  };

  let statementsToExecute: string[];
  try {
    ({ statementsToExecute } = await pushSQLiteSchema(schema, instance as any));
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
  }

  sqlite.pragma('foreign_keys = OFF');
  for (const statement of statementsToExecute) {
    sqlite.exec(statement);
  }
  sqlite.pragma('foreign_keys = ON');
}
