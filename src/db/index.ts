import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

const require = createRequire(import.meta.url);
const { pushSQLiteSchema } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

let db: ReturnType<typeof createDb> | null = null;
let sqlite: Database.Database | null = null;

function createDb(dbPath: string) {
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema });
}

export function getDb(dbPath = './montai.db') {
  if (!db) {
    db = createDb(dbPath);
  }
  return db;
}

export async function initDb(dbPath = './montai.db') {
  const instance = getDb(dbPath);

  // Suppress drizzle-kit's "[✓] Pulling schema from database..." message
  // but pass through any other output (e.g. interactive conflict resolution prompts)
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
  // Disable FK checks during migration: Drizzle recreates tables (CREATE __new_* → INSERT →
  // DROP → RENAME) and the intermediate state can violate FK constraints temporarily.
  instance.run(sql.raw('PRAGMA foreign_keys = OFF'));
  for (let statement of statementsToExecute) {
    // drizzle-kit may generate CREATE INDEX without IF NOT EXISTS after column renames
    statement = statement.replace(/^CREATE (UNIQUE )?INDEX (?!IF)/g, 'CREATE $1INDEX IF NOT EXISTS ');

    // drizzle-kit bug: INSERT INTO __new_* SELECT may reference columns not yet in
    // source table. Each attempt reports only the first missing column, so retry
    // until none are left — adding several columns at once needs more than one pass.
    const added = new Set<string>();
    for (;;) {
      try {
        instance.run(sql.raw(statement));
        break;
      } catch (err: any) {
        const colMatch = err?.cause?.code === 'SQLITE_ERROR' && err?.cause?.message?.match(/no such column: "(\w+)"/);
        const tableMatch = statement.match(/^INSERT INTO `__new_\w+`\(.+\)\s*SELECT\s+.+\s+FROM `(\w+)`/);
        if (!colMatch || !tableMatch || added.has(colMatch[1])) throw err;
        added.add(colMatch[1]);
        instance.run(sql.raw(`ALTER TABLE \`${tableMatch[1]}\` ADD COLUMN \`${colMatch[1]}\``));
      }
    }
  }
  instance.run(sql.raw('PRAGMA foreign_keys = ON'));
  return instance;
}

export function closeDbForTests() {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export type MontaiDb = ReturnType<typeof getDb>;
