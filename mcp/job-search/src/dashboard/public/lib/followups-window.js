// @ts-check
/**
 * Fetch open/snoozed follow-ups due within a window, independent of Google Calendar connectivity.
 *
 * Two reasons this exists rather than trusting GET /api/calendar/agenda's embedded `followups` array:
 * 1. That route's "calendar not connected" branch (src/dashboard/routes/calendar.js) returns
 *    `{connected:false, events:[], followups:[]}` -- it drops follow-up data entirely whenever Google
 *    Calendar is not connected, even though follow-ups have nothing to do with that connection. This is
 *    a real, observed PR 2 server behavior (found while capturing the Playwright screenshots for this
 *    PR, with no Google token configured), out of scope for this front-end PR to fix server-side, so the
 *    front end works around it here instead of silently showing an empty agenda whenever Google is not
 *    connected.
 * 2. Even when connected, pr3-spec-decisions.md section 9 item 13 already established that server-side
 *    `from`/`to` filtering on GET /api/followups happens AFTER its 25-row page limit, so any window view
 *    needs to offset-paginate the full status-filtered set and bucket by due date client-side, exactly
 *    like pages/followups.js does.
 * @param {{ fromIso: string, toIso: string, getJson: typeof import('./api.js').getJson, handleOutcome: typeof import('./outcome.js').handleOutcome, maxPages?: number }} opts
 * @returns {Promise<any[]>}
 */
export async function fetchFollowupsInWindow(opts) {
  const maxPages = opts.maxPages ?? 8;
  const fromMs = new Date(opts.fromIso).getTime();
  const toMs = new Date(opts.toIso).getTime();
  /** @type {any[]} */
  const inWindow = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const outcome = opts.handleOutcome(await opts.getJson('/api/followups', { status: 'open,snoozed', offset }), { silenceNotFound: true });
    if (outcome.kind !== 'ok') break;
    for (const row of outcome.body.rows) {
      const dueMs = new Date(row.due_at).getTime();
      if (dueMs >= fromMs && dueMs <= toMs) inWindow.push(row);
    }
    if (outcome.body.rows.length < 25) break;
    offset += 25;
  }
  return inWindow;
}
