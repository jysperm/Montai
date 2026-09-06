import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyMigrations } from './migrate.js';
import * as schema from './schema.js';

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
  await applyMigrations(instance, sqlite!);
  return instance;
}

export function closeDbForTests() {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export type MontaiDb = ReturnType<typeof getDb>;
