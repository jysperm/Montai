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

export function getDb(dbPath = './montai.db') {
  if (!db) {
    db = createDb(dbPath);
  }
  return db;
}

export async function initDb(dbPath = './montai.db') {
  const instance = getDb(dbPath);
  const { statementsToExecute } = await pushSQLiteSchema(schema, instance as any);
  for (let statement of statementsToExecute) {
    // drizzle-kit may generate CREATE INDEX without IF NOT EXISTS after column renames
    statement = statement.replace(/^CREATE (UNIQUE )?INDEX (?!IF)/g, 'CREATE $1INDEX IF NOT EXISTS ');

    try {
      instance.run(sql.raw(statement));
    } catch (err: any) {
      // drizzle-kit bug: INSERT INTO __new_* SELECT may reference columns not yet in source table
      const colMatch = err?.cause?.code === 'SQLITE_ERROR' && err?.cause?.message?.match(/no such column: "(\w+)"/);
      const tableMatch = statement.match(/^INSERT INTO `__new_\w+`\(.+\)\s*SELECT\s+.+\s+FROM `(\w+)`/);
      if (colMatch && tableMatch) {
        instance.run(sql.raw(`ALTER TABLE \`${tableMatch[1]}\` ADD COLUMN \`${colMatch[1]}\``));
        instance.run(sql.raw(statement));
      } else {
        throw err;
      }
    }
  }
  return instance;
}

export type MontaiDb = ReturnType<typeof getDb>;
