// @ts-check
/**
 * Report section for the personal mail intake (sql/029): "Recruiter mail" at the TOP of the scan report, under
 * the Google capability line. Pure rendering over data collected by collectMailIntakeReport.
 *
 * PRIVACY (the emailed and markdown report): subject-level detail appears ONLY for recruiter_like and
 * thread_reply items (the review items). Every other bucket is a count, and unsorted and bulk_noise add their
 * top senders (addresses and counts, no subjects). Subject-level unsorted mail is on the dashboard only.
 * Every rendered string is sanitized text; the HTML renderer escapes it, and links come only from
 * gmailMessageUrl (a hex message id on mail.google.com).
 */
import { BUCKETS, gmailMessageUrl, gmailTab } from './mail-intake.js';
import { collectUnsurfacedItems } from './mail-intake-store.js';

export const DEFAULT_REVIEW_CAP = 25;

/**
 * @param {any[]} runs
 * @returns {Array<any>} stats.gmail.mail_intake of each run that carries one
 */
function intakeStatsOf(runs) {
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const m = r && r.stats && r.stats.gmail ? r.stats.gmail.mail_intake : null;
    if (m && typeof m === 'object') out.push(m);
  }
  return out;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {any[]} runs report runs (their stats carry the per-run counts)
 * @param {{ cap?: number, topSenders?: number }} [opts]
 */
export async function collectMailIntakeReport(client, runs, opts = {}) {
  const cap = opts.cap ?? DEFAULT_REVIEW_CAP;
  const top = opts.topSenders ?? 10;
  const { items, more } = await collectUnsurfacedItems(client, cap);
  const stats = intakeStatsOf(runs);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  /** @type {Record<string, Map<string, number>>} */
  const senders = { unsorted: new Map(), bulk: new Map() };
  const add = (/** @type {Map<string, number>} */ m, /** @type {any} */ list) => {
    for (const e of Array.isArray(list) ? list : []) m.set(String(e[0]), (m.get(String(e[0])) ?? 0) + Number(e[1] ?? 0));
  };
  for (const s of stats) {
    for (const b of BUCKETS) counts[b] += Number(s.counts?.[b] ?? 0);
    add(senders.unsorted, s.top_unsorted);
    add(senders.bulk, s.top_bulk);
  }
  const topOf = (/** @type {Map<string, number>} */ m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
  const last = stats[stats.length - 1] ?? null;
  return {
    ran: stats.length > 0,
    items,
    more,
    counts,
    topUnsorted: topOf(senders.unsorted),
    topBulk: topOf(senders.bulk),
    // Not additive across runs: unread candidates are retried by the next run, so the newest run's number stands.
    notReadBeyondCap: last ? Number(last.not_read_beyond_cap ?? 0) : 0,
    metadataUnread: last ? Number(last.metadata_unread ?? 0) : 0,
    outcomes: [...new Set(stats.map((s) => String(s.outcome ?? 'ok')).filter((o) => o !== 'ok'))],
  };
}

/**
 * @typedef {Awaited<ReturnType<typeof collectMailIntakeReport>>|{ error: string }} MailIntakeReport
 */

/** @param {any} it */
function itemHeader(it) {
  const who = it.from_name ? `${it.from_name} <${it.from_addr ?? 'unknown'}>` : (it.from_addr ?? 'unknown sender');
  const date = it.msg_date ? String(it.msg_date).slice(0, 10) : 'undated';
  const kind = it.signal ? `${it.bucket}/${it.signal}` : it.bucket;
  return { who, date, kind, tab: gmailTab(it.labels), subject: it.subject || '(no subject)', link: gmailMessageUrl(String(it.message_id)) };
}

/**
 * Plain-text section lines (also used by the markdown renderer, which wraps links).
 * @param {MailIntakeReport|null|undefined} data
 * @param {{ markdown?: boolean }} [opts]
 * @returns {string[]}
 */
export function mailIntakeLines(data, opts = {}) {
  if (!data) return [];
  const md = Boolean(opts.markdown);
  const lines = [md ? '## Recruiter mail' : '== Recruiter mail =='];
  if ('error' in data) {
    lines.push(`Recruiter mail: unavailable (${data.error})`, '');
    return lines;
  }
  const inbox = data.items.filter((i) => !i.spam);
  const spam = data.items.filter((i) => i.spam);
  const itemLines = (/** @type {any[]} */ list) => {
    const out = [];
    for (const it of list) {
      const h = itemHeader(it);
      out.push(`- ${h.date} | ${h.who} | ${h.subject} | ${h.tab} | ${h.kind}`);
      if (it.reply_to_differs && it.reply_to) out.push(`  From ${it.from_addr ?? 'unknown'} but Reply-To ${it.reply_to}`);
      if (it.body_unreadable) out.push('  body unreadable: review by hand');
      if (it.snippet) out.push(`  ${it.snippet}`);
      if (h.link) out.push(md ? `  [Open in Gmail](${h.link})` : `  ${h.link}`);
    }
    return out;
  };
  if (!data.ran) lines.push('Mail intake did not run in this report window.');
  else if (data.items.length === 0) lines.push('No new recruiter-like mail or replies.');
  if (inbox.length) lines.push(`${inbox.length} to look at:`, ...itemLines(inbox));
  if (spam.length) lines.push('', `Spam folder (${spam.length}; treat as unverified):`, ...itemLines(spam));
  if (data.more > 0) lines.push(`${data.more} more on the dashboard Review page.`);
  if (data.notReadBeyondCap > 0) lines.push(`${data.notReadBeyondCap} not read beyond the cap.`);
  if (data.metadataUnread > 0) lines.push(`${data.metadataUnread} messages not listed beyond the metadata cap.`);
  if (data.outcomes.length) lines.push(`Mail intake outcome: ${data.outcomes.join(', ')}.`);
  if (data.ran) {
    lines.push(`Mail intake counts: ${BUCKETS.map((b) => `${b} ${data.counts[b] ?? 0}`).join(', ')}.`);
    const fmt = (/** @type {Array<[string, number]>} */ l) => l.map(([a, n]) => `${a} (${n})`).join(', ');
    if (data.topUnsorted.length) lines.push(`Top unsorted senders: ${fmt(data.topUnsorted)}. Subjects are on the dashboard.`);
    if (data.topBulk.length) lines.push(`Top bulk senders: ${fmt(data.topBulk)}.`);
  }
  lines.push('');
  return lines;
}

/**
 * HTML fragment; every dynamic string is escaped.
 * @param {MailIntakeReport|null|undefined} data
 * @param {(s: unknown) => string} esc
 * @returns {string[]}
 */
export function mailIntakeHtml(data, esc) {
  if (!data) return [];
  const parts = ['<h3>Recruiter mail</h3>'];
  if ('error' in data) {
    parts.push(`<p>Recruiter mail: unavailable (${esc(data.error)})</p>`);
    return parts;
  }
  const li = (/** @type {any} */ it) => {
    const h = itemHeader(it);
    const bits = [`<strong>${esc(h.subject)}</strong>`, esc(h.who), esc(h.date), esc(h.tab), esc(h.kind)];
    let s = `<li>${bits.join(' | ')}`;
    if (it.reply_to_differs && it.reply_to) s += `<br>From ${esc(it.from_addr ?? 'unknown')} but Reply-To ${esc(it.reply_to)}`;
    if (it.body_unreadable) s += '<br>body unreadable: review by hand';
    if (it.snippet) s += `<br>${esc(it.snippet)}`;
    if (h.link) s += `<br><a href="${esc(h.link)}">Open in Gmail</a>`;
    return `${s}</li>`;
  };
  const inbox = data.items.filter((i) => !i.spam);
  const spam = data.items.filter((i) => i.spam);
  if (!data.ran) parts.push('<p>Mail intake did not run in this report window.</p>');
  else if (data.items.length === 0) parts.push('<p>No new recruiter-like mail or replies.</p>');
  if (inbox.length) parts.push(`<p>${inbox.length} to look at:</p>`, `<ul>${inbox.map(li).join('')}</ul>`);
  if (spam.length) parts.push(`<p>Spam folder (${spam.length}; treat as unverified):</p>`, `<ul>${spam.map(li).join('')}</ul>`);
  if (data.more > 0) parts.push(`<p>${data.more} more on the dashboard Review page.</p>`);
  if (data.notReadBeyondCap > 0) parts.push(`<p>${data.notReadBeyondCap} not read beyond the cap.</p>`);
  if (data.metadataUnread > 0) parts.push(`<p>${data.metadataUnread} messages not listed beyond the metadata cap.</p>`);
  if (data.outcomes.length) parts.push(`<p>Mail intake outcome: ${esc(data.outcomes.join(', '))}.</p>`);
  if (data.ran) {
    parts.push(`<p>Mail intake counts: ${esc(BUCKETS.map((b) => `${b} ${data.counts[b] ?? 0}`).join(', '))}.</p>`);
    const fmt = (/** @type {Array<[string, number]>} */ l) => esc(l.map(([a, n]) => `${a} (${n})`).join(', '));
    if (data.topUnsorted.length) parts.push(`<p>Top unsorted senders: ${fmt(data.topUnsorted)}. Subjects are on the dashboard.</p>`);
    if (data.topBulk.length) parts.push(`<p>Top bulk senders: ${fmt(data.topBulk)}.</p>`);
  }
  return parts;
}
