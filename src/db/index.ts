import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

const require = createRequire(import.meta.url);
const { pushSQLiteSchema } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

let db: ReturnType<typeof createDb> | null = null;

function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema });
}

export function getDb(dbPath = './cutflow.db') {
  if (!db) {
    db = createDb(dbPath);
  }
  return db;
}

export async function initDb(dbPath = './cutflow.db') {
  const instance = getDb(dbPath);
  const { statementsToExecute } = await pushSQLiteSchema(schema, instance as any);
  for (let statement of statementsToExecute) {
    // drizzle-kit may generate CREATE INDEX without IF NOT EXISTS after column renames
    statement = statement.replace(/^CREATE (UNIQUE )?INDEX (?!IF)/g, 'CREATE $1INDEX IF NOT EXISTS ');
    instance.run(sql.raw(statement));
  }
  return instance;
}

export type CutFlowDb = ReturnType<typeof getDb>;
