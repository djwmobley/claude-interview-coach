// @ts-check
/**
 * ic_mail_intake persistence and queries (sql/029). All SQL for the personal mail intake lives here. The
 * ledger is separate from ic_gmail_processed_messages, which belongs to bin/confirm.js.
 *
 * Nothing here talks to a model; the rows are read by the report, the dashboard and tests only.
 */
import { DETAIL_BUCKETS, SURFACED_BUCKETS } from './mail-intake.js';

/** Rows older than this are not consulted when deciding which ids to skip. */
const KNOWN_WINDOW_DAYS = 60;

/**
 * Message ids the intake pass can skip: classified at the CURRENT rules_version, or settled in a bucket a rules
 * change does not reopen. Unsorted and bulk_noise rows from an older rules_version are NOT skipped, so a rules
 * change reprocesses exactly the rows it could newly match.
 * @param {import('pg').ClientBase} client
 * @param {string} rulesVersion
 * @returns {Promise<Set<string>>}
 */
export async function loadKnownMailIds(client, rulesVersion) {
  const r = await client.query(
    `SELECT message_id FROM ic_mail_intake
     WHERE last_seen_at > now() - ($2::int * interval '1 day')
       AND (rules_version = $1 OR bucket NOT IN ('unsorted','bulk_noise'))`,
    [rulesVersion, KNOWN_WINDOW_DAYS],
  );
  return new Set(r.rows.map((x) => String(x.message_id)));
}

/**
 * @typedef {Object} IntakeRow
 * @property {string} message_id
 * @property {string|null} thread_id
 * @property {string} bucket
 * @property {string|null} signal
 * @property {string|null} from_addr
 * @property {string|null} from_name
 * @property {string|null} reply_to
 * @property {boolean} reply_to_differs
 * @property {string|null} subject
 * @property {string|null} snippet
 * @property {string|null} msg_date ISO
 * @property {string[]} labels
 * @property {boolean} spam
 * @property {boolean} body_unreadable
 */

/**
 * Upsert the pass's rows in one statement. first_seen_at, surfaced_run_id and status survive a reprocess; the
 * bucket, signal and display fields follow the newest rules. Display fields are kept only for the buckets that
 * surface (DETAIL_BUCKETS); every other bucket stores the sender address and counts.
 * @param {import('pg').ClientBase} client
 * @param {IntakeRow[]} rows
 * @param {string} rulesVersion
 * @returns {Promise<number>} rows written
 */
export async function persistMailIntake(client, rows, rulesVersion) {
  if (rows.length === 0) return 0;
  const prepared = rows.map((r) => {
    const detail = DETAIL_BUCKETS.includes(/** @type {any} */ (r.bucket));
    return {
      message_id: r.message_id, thread_id: r.thread_id, bucket: r.bucket, signal: r.signal, from_addr: r.from_addr,
      from_name: detail ? r.from_name : null, reply_to: detail ? r.reply_to : null, reply_to_differs: detail ? r.reply_to_differs : false,
      subject: detail ? r.subject : null, snippet: detail ? r.snippet : null, msg_date: r.msg_date,
      labels: detail ? r.labels : [], spam: r.spam, body_unreadable: r.body_unreadable,
    };
  });
  const res = await client.query(
    `INSERT INTO ic_mail_intake (message_id, thread_id, bucket, rules_version, signal, from_addr, from_name, reply_to, reply_to_differs, subject, snippet, msg_date, labels, spam, body_unreadable)
     SELECT x.message_id, x.thread_id, x.bucket, $2, x.signal, x.from_addr, x.from_name, x.reply_to, x.reply_to_differs, x.subject, x.snippet, x.msg_date::timestamptz,
            coalesce(ARRAY(SELECT jsonb_array_elements_text(x.labels)), '{}'), x.spam, x.body_unreadable
     FROM jsonb_to_recordset($1::jsonb) AS x(message_id text, thread_id text, bucket text, signal text, from_addr text, from_name text, reply_to text,
          reply_to_differs boolean, subject text, snippet text, msg_date text, labels jsonb, spam boolean, body_unreadable boolean)
     ON CONFLICT (message_id) DO UPDATE SET
       thread_id = EXCLUDED.thread_id, bucket = EXCLUDED.bucket, rules_version = EXCLUDED.rules_version, signal = EXCLUDED.signal,
       from_addr = EXCLUDED.from_addr, from_name = EXCLUDED.from_name, reply_to = EXCLUDED.reply_to, reply_to_differs = EXCLUDED.reply_to_differs,
       subject = EXCLUDED.subject, snippet = EXCLUDED.snippet, msg_date = EXCLUDED.msg_date, labels = EXCLUDED.labels, spam = EXCLUDED.spam,
       body_unreadable = EXCLUDED.body_unreadable, last_seen_at = now()`,
    [JSON.stringify(prepared), rulesVersion],
  );
  return res.rowCount ?? 0;
}

/** @param {any} r */
function viewOf(r) {
  return {
    message_id: String(r.message_id),
    thread_id: r.thread_id ?? null,
    bucket: String(r.bucket),
    signal: r.signal ?? null,
    from_addr: r.from_addr ?? null,
    from_name: r.from_name ?? null,
    reply_to: r.reply_to ?? null,
    reply_to_differs: Boolean(r.reply_to_differs),
    subject: r.subject ?? null,
    snippet: r.snippet ?? null,
    msg_date: r.msg_date ? new Date(r.msg_date).toISOString() : null,
    labels: Array.isArray(r.labels) ? r.labels.map(String) : [],
    spam: Boolean(r.spam),
    body_unreadable: Boolean(r.body_unreadable),
  };
}

/** Review items: open recruiter_like and thread_reply, one per Gmail thread (the newest message), newest first. */
const OPEN_ITEMS_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (coalesce(thread_id, message_id)) *
    FROM ic_mail_intake
    WHERE bucket = ANY($1::text[]) AND status = 'open' __UNSURFACED__
    ORDER BY coalesce(thread_id, message_id), msg_date DESC NULLS LAST, message_id DESC
  ) t ORDER BY msg_date DESC NULLS LAST, message_id DESC`;

/**
 * Review items for the report: open, not yet listed in a sent report, one per thread, capped. The rest are a
 * count (they stay unsurfaced and appear in the next report and on the dashboard).
 * @param {import('pg').ClientBase} client
 * @param {number} cap
 */
export async function collectUnsurfacedItems(client, cap) {
  const r = await client.query(OPEN_ITEMS_SQL.replace('__UNSURFACED__', 'AND surfaced_run_id IS NULL'), [SURFACED_BUCKETS]);
  const all = r.rows.map(viewOf);
  return { items: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length };
}

/**
 * Record that a SENT report listed these messages (and the rest of their threads), so the next report skips them.
 * @param {import('pg').ClientBase} client
 * @param {string[]} messageIds
 * @param {number|null} runId
 */
export async function markSurfaced(client, messageIds, runId) {
  if (messageIds.length === 0 || runId == null) return 0;
  const r = await client.query(
    `UPDATE ic_mail_intake SET surfaced_run_id = $2
     WHERE surfaced_run_id IS NULL AND bucket = ANY($3::text[])
       AND (message_id = ANY($1::text[]) OR thread_id IN (SELECT thread_id FROM ic_mail_intake WHERE message_id = ANY($1::text[]) AND thread_id IS NOT NULL))`,
    [messageIds, runId, SURFACED_BUCKETS],
  );
  return r.rowCount ?? 0;
}

/**
 * Dashboard data: every open review item (one per thread), the subject-level unsorted list for the last 14
 * days (dashboard only; never in the emailed report) and 14-day counts per bucket.
 * @param {import('pg').ClientBase} client
 * @param {{ itemLimit?: number, unsortedLimit?: number }} [opts]
 */
export async function listMailIntakeForDashboard(client, opts = {}) {
  const itemLimit = opts.itemLimit ?? 100;
  const unsortedLimit = opts.unsortedLimit ?? 100;
  const items = (await client.query(OPEN_ITEMS_SQL.replace('__UNSURFACED__', ''), [SURFACED_BUCKETS])).rows.map(viewOf);
  const unsorted = (await client.query(
    `SELECT * FROM ic_mail_intake WHERE bucket = 'unsorted' AND status = 'open' AND first_seen_at > now() - interval '14 days'
     ORDER BY msg_date DESC NULLS LAST, message_id DESC LIMIT $1`, [unsortedLimit],
  )).rows.map(viewOf);
  const counts = (await client.query(
    `SELECT bucket, count(*)::int AS n FROM ic_mail_intake WHERE first_seen_at > now() - interval '14 days' GROUP BY bucket`,
  )).rows;
  return {
    items: items.slice(0, itemLimit),
    items_total: items.length,
    unsorted,
    counts: Object.fromEntries(counts.map((c) => [c.bucket, c.n])),
  };
}

/**
 * Dismiss a message and the rest of its thread (the Review page's Dismiss button).
 * @param {import('pg').ClientBase} client
 * @param {string} messageId
 * @returns {Promise<number>} rows dismissed
 */
export async function dismissMailIntake(client, messageId) {
  const r = await client.query(
    `UPDATE ic_mail_intake SET status = 'dismissed', dismissed_at = now()
     WHERE status = 'open' AND (message_id = $1 OR (thread_id IS NOT NULL AND thread_id = (SELECT thread_id FROM ic_mail_intake WHERE message_id = $1)))`,
    [messageId],
  );
  return r.rowCount ?? 0;
}
