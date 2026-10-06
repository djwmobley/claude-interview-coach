// @ts-check
/**
 * Assisted LinkedIn Easy Apply: the awaiting_submit TAB set (spec B5, G12). Kept separate from
 * src/core/easy-apply-state.js and free of any src/core/applications.js or src/apply/ import, because the
 * scan side (src/browser/session.js) reads it: every scan path must know which CDP target ids belong to an
 * application parked at LinkedIn's Review screen (needs_human, pending_question.kind = 'awaiting_submit')
 * so it never attaches to, selects, navigates, brings to front, or closes them.
 *
 * Everything here is plain SQL on ic_job_applications plus an audit row in ic_job_application_events
 * (written directly: there is no needs_human -> needs_human edge in the application state machine, and a
 * demotion or stale flag only rewrites pending_question on a row that stays in needs_human).
 */

/** pending_question.kind for an application whose Easy Apply form sits filled at the Review screen. */
export const AWAITING_SUBMIT_KIND = 'awaiting_submit';
/** pending_question.kind after its tab is known gone (Chrome restarted, tab closed). */
export const ABANDONED_TAB_KIND = 'abandoned_tab';

/** The assisted ATS types whose awaiting_submit tabs this set protects (LinkedIn Easy Apply and Workday). */
const AWAITING_WHERE = `ats_type IN ('linkedin_easy', 'workday') AND state = 'needs_human' AND pending_question->>'kind' = '${AWAITING_SUBMIT_KIND}'`;

/**
 * @param {import('pg').ClientBase} client
 * @returns {Promise<Array<{ applicationId: number, targetId: string|null, ats: string }>>}
 */
export async function listAwaitingTargets(client) {
  const r = await client.query(`SELECT id, ats_type, pending_question->>'target_id' AS target_id FROM ic_job_applications WHERE ${AWAITING_WHERE} ORDER BY id`);
  return r.rows.map((row) => ({ applicationId: Number(row.id), targetId: typeof row.target_id === 'string' && row.target_id ? row.target_id : null, ats: String(row.ats_type) }));
}

/**
 * Demote awaiting_submit rows whose tab is gone to needs_human kind 'abandoned_tab'. `aliveTargetIds`
 * null means "every awaiting tab is gone" (the scan Chrome was killed and relaunched); otherwise only rows
 * whose stored target id is NOT in the set are demoted. A row with no stored target id is treated as gone.
 * Returns the demoted application ids. Never closes or touches any browser target.
 * @param {import('pg').ClientBase} client
 * @param {{ aliveTargetIds: Set<string>|null, reason: string }} opts
 * @returns {Promise<number[]>}
 */
export async function demoteAbandonedTabs(client, opts) {
  const rows = await listAwaitingTargets(client);
  /** @type {number[]} */
  const demoted = [];
  for (const row of rows) {
    if (opts.aliveTargetIds && row.targetId && opts.aliveTargetIds.has(row.targetId)) continue;
    const label = 'The browser tab holding this filled application form is gone (the scan Chrome restarted or the tab was closed). Check the site for an applied confirmation; if it is not there, retry or apply by hand.';
    const upd = await client.query(
      `UPDATE ic_job_applications
          SET pending_question = jsonb_build_object('kind', '${ABANDONED_TAB_KIND}', 'label', $2::text, 'previous_target_id', pending_question->>'target_id', 'reason', $3::text, 'page_url', pending_question->>'page_url'),
              updated_at = now()
        WHERE id = $1 AND ${AWAITING_WHERE}
        RETURNING id`,
      [row.applicationId, label, opts.reason],
    );
    if (upd.rowCount === 0) continue;
    await client.query(
      `INSERT INTO ic_job_application_events (application_id, kind, actor, note, meta) VALUES ($1, 'note', 'apply', $2, $3::jsonb)`,
      [row.applicationId, `easy apply awaiting_submit demoted to ${ABANDONED_TAB_KIND}: ${opts.reason}`, JSON.stringify({ target_id: row.targetId })],
    );
    demoted.push(row.applicationId);
  }
  return demoted;
}

/**
 * Flag awaiting_submit rows older than `staleHours` with pending_question.stale = true. Never closes,
 * withdraws, or demotes them (spec G12: "marked stale, never auto-closed"). Returns how many rows were
 * newly flagged.
 * @param {import('pg').ClientBase} client
 * @param {Date} now
 * @param {number} staleHours
 */
export async function markStaleAwaiting(client, now, staleHours) {
  const r = await client.query(
    `UPDATE ic_job_applications
        SET pending_question = pending_question || '{"stale": true}'::jsonb
      WHERE ${AWAITING_WHERE}
        AND coalesce((pending_question->>'stale')::boolean, false) = false
        AND coalesce(nullif(pending_question->>'awaiting_since', ''), updated_at::text)::timestamptz < $1::timestamptz - ($2::text || ' hours')::interval
      RETURNING id`,
    [now, String(staleHours)],
  );
  return r.rowCount ?? 0;
}
