// @ts-check
/**
 * Idempotent auxiliary schema applied at server start (sql/007+). The main
 * migration is bin/migrate.js; this only covers ADD COLUMN IF NOT EXISTS /
 * CREATE TABLE IF NOT EXISTS files that later stages introduced, so a server
 * started against a DB migrated by an earlier stage still works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', '..', 'sql');

export const AUX_MIGRATIONS = Object.freeze(['007_mark_meta.sql']);

/**
 * @param {import('pg').ClientBase} client
 * @returns {Promise<string[]>} files applied
 */
export async function ensureAuxSchema(client) {
  const applied = [];
  for (const f of AUX_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
    await client.query(sql);
    applied.push(f);
  }
  return applied;
}
