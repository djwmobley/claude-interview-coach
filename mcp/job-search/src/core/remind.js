// @ts-check
/**
 * Daily follow-up digest (spec section 6). Pure orchestration so tests can
 * inject the pg client, a fake fetch, and a fixed clock. bin/remind.js is
 * the CLI wrapper.
 *
 * Exit semantics (returned as `code`): 0 ok (including zero due rows, no
 * email), 1 auth or send failure (rows stay un-stamped so tomorrow retries).
 */
import { selectDue, unsnoozeDue, stampReminded, formatFollowup } from './followups.js';
import { googleHttp, gmailSend, buildRfc2822, readTokenFile, tokenInfo } from './google.js';
import { errFields, JobSearchError } from './errors.js';

/**
 * One line per item, plain text.
 * @param {import('./followups.js').FollowupRow[]} rows
 * @param {Date} now
 */
export function buildDigest(rows, now) {
  const lines = rows.map((r) => {
    const due = new Date(r.due_at);
    const overdue = due.getTime() < now.getTime() - 86400000 ? ' (overdue)' : '';
    return `- ${formatFollowup(r)}${overdue}`;
  });
  const subject = `Follow-ups due: ${rows.length}`;
  const body = [`${rows.length} follow-up${rows.length === 1 ? '' : 's'} due by ${new Date(now.getTime() + 86400000).toISOString().slice(0, 10)}:`, '', ...lines, '', 'Mark done with followups({action:"complete", id}) in the job-search MCP.'].join('\n');
  return { subject, body };
}

/**
 * @param {{ client: import('pg').ClientBase, tokenFile: string, to: string, from?: string, dryRun?: boolean, fetch?: typeof fetch, now?: Date, log?: (fields: Record<string, string|number|boolean|null>) => void, googleHttp?: typeof googleHttp }} opts
 * @returns {Promise<{ code: number, due: number, flipped: number, sent: boolean, stamped: number, subject: string|null, reason: string|null, scopes_ok: boolean|null, expiry: string|null }>}
 */
export async function runRemind(opts) {
  if (!opts.tokenFile) {
    throw new JobSearchError('VALIDATION', 'GOOGLE_TOKEN_FILE is not set; add it to mcp/job-search/.env');
  }
  if (!opts.to) {
    throw new JobSearchError('VALIDATION', 'REMINDER_TO is not set; add it to mcp/job-search/.env');
  }
  const now = opts.now ?? new Date();
  const say = opts.log ?? (() => {});
  const flippedIds = await unsnoozeDue(opts.client, now);
  const rows = await selectDue(opts.client, now);
  say({ evt: 'remind_select', due: rows.length, flipped: flippedIds.length, dry_run: Boolean(opts.dryRun) });
  if (rows.length === 0 && !opts.dryRun) {
    return { code: 0, due: 0, flipped: flippedIds.length, sent: false, stamped: 0, subject: null, reason: 'nothing_due', scopes_ok: null, expiry: null };
  }
  const { subject, body } = buildDigest(rows, now);
  if (opts.dryRun) {
    // A dry run always exercises the token file (load + in-memory refresh) even with nothing due, so the
    // scheduled job can be proven healthy without sending anything.
    // Prove the token loads and refreshes, but send nothing and stamp nothing.
    let scopesOk = null;
    let expiry = null;
    try {
      const g = await (opts.googleHttp ?? googleHttp)({ tokenFile: opts.tokenFile, fetch: opts.fetch, need: { gmail: true } });
      scopesOk = g.info.gmail_send_ok;
      expiry = g.expiry;
      say({ evt: 'remind_token_ok', scopes_ok: scopesOk, expiry, has_refresh_token: g.info.has_refresh_token });
    } catch (err) {
      const f = errFields(err);
      // Report what the file itself says about scopes even when the refresh failed (no token values).
      try {
        scopesOk = tokenInfo(readTokenFile(opts.tokenFile)).gmail_send_ok;
      } catch {
        scopesOk = null;
      }
      say({ evt: 'remind_token_failed', ...f, scopes_ok: scopesOk });
      return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, reason: f.err_message, scopes_ok: scopesOk, expiry };
    }
    return { code: 0, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject: rows.length ? subject : null, reason: rows.length ? 'dry_run' : 'nothing_due', scopes_ok: scopesOk, expiry };
  }
  let deps;
  let info;
  let expiry = null;
  try {
    const g = await (opts.googleHttp ?? googleHttp)({ tokenFile: opts.tokenFile, fetch: opts.fetch, need: { gmail: true } });
    deps = g.deps;
    info = g.info;
    expiry = g.expiry;
    say({ evt: 'remind_token_ok', scopes_ok: info.gmail_send_ok, expiry, has_refresh_token: info.has_refresh_token });
  } catch (err) {
    const f = errFields(err);
    say({ evt: 'remind_token_failed', ...f });
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, reason: f.err_message, scopes_ok: false, expiry };
  }
  try {
    const msg = buildRfc2822({ to: opts.to, from: opts.from, subject, body, date: now });
    const id = await gmailSend(deps, msg);
    say({ evt: 'remind_sent', message_id: id, due: rows.length });
  } catch (err) {
    const f = errFields(err);
    say({ evt: 'remind_send_failed', ...f });
    return { code: 1, due: rows.length, flipped: flippedIds.length, sent: false, stamped: 0, subject, reason: f.err_message, scopes_ok: info.gmail_send_ok, expiry };
  }
  const stamped = await stampReminded(opts.client, rows.map((r) => r.id), now);
  return { code: 0, due: rows.length, flipped: flippedIds.length, sent: true, stamped, subject, reason: null, scopes_ok: info.gmail_send_ok, expiry };
}
