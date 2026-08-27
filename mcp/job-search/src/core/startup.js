// @ts-check
/**
 * Shared startup DB work (dashboard PR 1: moved out of src/server.js so bin/dashboard.js can run the
 * same aux-schema-and-seed step without importing src/server.js or src/core/stdout-hygiene.js).
 * Best-effort: a DB that is down at startup is logged, never fatal -- both the MCP server and the
 * dashboard are expected to come up and report an unhealthy DB rather than refuse to start.
 */
import { withClient } from './db.js';
import { ensureAuxSchema } from './schema.js';
import { seedExecDefault } from './profile-seed.js';
import { log } from './logger.js';
import { errFields } from './errors.js';

/** Applies the idempotent aux-schema migrations and seeds the exec-default search profile if absent. */
export async function startupDb() {
  try {
    await withClient(async (c) => {
      const applied = await ensureAuxSchema(c);
      const seed = await seedExecDefault(c);
      log.info({ evt: 'startup_db', aux_applied: applied.length, profile_seeded: seed.seeded, profile_from: seed.from });
    });
  } catch (err) {
    log.warn({ evt: 'startup_db_failed', ...errFields(err) });
  }
}
