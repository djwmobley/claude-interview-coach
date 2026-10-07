// @ts-check
/**
 * Cross-process locks for resume generation (Ready to apply list A5).
 *
 * RESUME_SPAWN_LOCK_KEY covers EVERY headless /write-resume spawn: the application-mode resume runner (in
 * the dashboard and in bin/auto-apply.js) and the listing-mode Ready list runner (bin/ready-resumes.js and
 * the dashboard's per-row button). One spawn at a time across all processes, so no runner can mistake
 * another process's draft for its own.
 *
 * READY_RESUME_RUN_LOCK_KEY is the single-flight lock for a whole bin/ready-resumes.js run (a second run
 * exits 'locked').
 *
 * Each lock is a session-level pg advisory lock held on its OWN dedicated connection (never a pooled
 * client), so a crashed holder releases it when its connection drops. 1-key bigint space, distinct from
 * src/core/scan-run.js LOCK_KEY (730193001).
 */
import { connectDedicated } from './db.js';

export const RESUME_SPAWN_LOCK_KEY = 730193021;
export const READY_RESUME_RUN_LOCK_KEY = 730193022;

/**
 * @param {{ key: number, connect?: () => Promise<import('pg').Client>, pollMs?: number, sleep?: (ms: number) => Promise<void> }} o
 */
export function createAdvisoryLock(o) {
  const connect = o.connect ?? (() => connectDedicated());
  const pollMs = o.pollMs ?? 5000;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));

  /** @returns {Promise<{ release: () => Promise<void> }|null>} */
  async function tryAcquire() {
    const client = await connect();
    let ok = false;
    try {
      ok = Boolean((await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [o.key])).rows[0].ok);
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    if (!ok) {
      await client.end().catch(() => {});
      return null;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [o.key]);
        } finally {
          await client.end().catch(() => {});
        }
      },
    };
  }

  /**
   * Poll tryAcquire until it succeeds or waitMs elapses (null).
   * @param {{ waitMs: number }} w
   */
  async function acquire(w) {
    const deadline = Date.now() + Math.max(0, w.waitMs);
    for (;;) {
      const h = await tryAcquire();
      if (h) return h;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  return { tryAcquire, acquire };
}
