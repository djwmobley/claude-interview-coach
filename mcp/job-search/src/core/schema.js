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
import { log } from './logger.js';
import { errFields } from './errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', '..', 'sql');

export const AUX_MIGRATIONS = Object.freeze(['007_mark_meta.sql', '008_noise_and_report.sql', '009_pipeline_events_documents.sql', '011_triage_actor.sql', '012_applications.sql', '013_confirm_mail.sql', '014_application_salary_floor.sql', '015_listing_apply_target.sql', '016_listing_salary_period.sql', '017_detail_outcome.sql']);

/**
 * Applies each aux-migration file in its own try/catch so one file's failure never blocks the rest.
 * This is the unattended path (server/dashboard startup, via src/core/startup.js's startupDb -- see
 * that file's own doc comment: a DB problem at startup is logged, never fatal) and warn-and-proceed is
 * the correct behavior for it, same as before this change. This is NOT the behavior for the attended
 * path: bin/migrate.js's `node bin/migrate.js apply` is a deliberate, human-invoked action and must
 * keep failing loudly on the first bad statement rather than silently skipping it -- it does not import
 * this function and must not gain this catch-and-continue.
 *
 * On a failure, the client is left in an aborted transaction by that file's own BEGIN/COMMIT (each aux
 * SQL file wraps itself in BEGIN...COMMIT); ROLLBACK here clears that before the next file's query runs
 * on the same client, and again before this client is eventually released (src/core/db.js's withClient
 * also unconditionally rolls back in its own finally, as a second, redundant layer directly on that
 * chokepoint -- this one exists so the very next file in this same loop, on this same client, is not
 * itself doomed to run inside an already-aborted transaction).
 * @param {import('pg').ClientBase} client
 * @returns {Promise<string[]>} files applied
 */
export async function ensureAuxSchema(client) {
  const applied = [];
  for (const f of AUX_MIGRATIONS) {
    try {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      await client.query(sql);
      applied.push(f);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection is already gone or otherwise unusable; the next file's query will surface that */
      }
      log.warn({ evt: 'aux_schema_file_failed', file: f, ...errFields(err) });
    }
  }
  return applied;
}
