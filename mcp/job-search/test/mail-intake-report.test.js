// @ts-check
/**
 * The Recruiter mail section of the scan report (sql/029): placement at the top, escaping, URL stripping,
 * the privacy rule for the emailed and markdown report, and the 25-item cap wording.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { persistMailIntake } from '../src/core/mail-intake-store.js';
import { collectMailIntakeReport, mailIntakeLines, mailIntakeHtml } from '../src/core/mail-intake-report.js';
import { renderReportText, renderReportHtml, renderReportMarkdown, escapeHtml, buildScanReport } from '../src/core/report.js';

const P = `zzmr${process.pid}x`;
/** @type {pg.Client} */
let client;

/** @param {string} n @param {Partial<import('../src/core/mail-intake-store.js').IntakeRow>} [over] @returns {import('../src/core/mail-intake-store.js').IntakeRow} */
function row(n, over = {}) {
  return {
    message_id: `${P}${n}`.replace(/[^0-9a-z]/g, ''), thread_id: `${P}t${n}`, bucket: 'recruiter_like', signal: 'strong', from_addr: `s${n}@firm.example`, from_name: 'Sam Roe',
    reply_to: null, reply_to_differs: false, subject: `Subject ${n}`, snippet: `Snippet ${n}`, msg_date: '2026-10-23T12:00:00.000Z',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], spam: false, body_unreadable: false, ...over,
  };
}

/** A real report object (empty database window) with the intake fields replaced. @param {any} mailIntake @param {string|null} [capLine] */
async function reportData(mailIntake, capLine = null) {
  const base = await buildScanReport(client, { now: new Date('2026-10-24T12:00:00Z'), sinceOverride: null });
  return { ...base, mailIntake, googleCapabilityLine: capLine };
}
const registry = { entries: [], httpAllowedHosts: new Set() };

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
});
beforeEach(async () => { await client.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P.replace(/[^0-9a-z]/g, '')}%`]); });
after(async () => {
  await client.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P.replace(/[^0-9a-z]/g, '')}%`]);
  await client.end();
});

const runWithStats = (/** @type {any} */ mailIntake) => [{ run_id: 1, stats: { gmail: { mail_intake: mailIntake } } }];

describe('collectMailIntakeReport', () => {
  test('aggregates the counts and top senders across runs and reports the newest run overflow numbers', async () => {
    const runs = [
      ...runWithStats({ outcome: 'ok', counts: { bulk_noise: 5, unsorted: 2, self: 1 }, top_unsorted: [['u@x.test', 2]], top_bulk: [['b@x.test', 5]], not_read_beyond_cap: 9, metadata_unread: 4 }),
      ...runWithStats({ outcome: 'partial_budget', counts: { bulk_noise: 3 }, top_unsorted: [['u@x.test', 1]], top_bulk: [['b@x.test', 3], ['c@x.test', 1]], not_read_beyond_cap: 3, metadata_unread: 0 }),
    ];
    const d = await collectMailIntakeReport(client, runs, { cap: 25 });
    assert.equal(d.counts.bulk_noise, 8);
    assert.equal(d.counts.self, 1);
    assert.deepEqual(d.topBulk[0], ['b@x.test', 8]);
    assert.deepEqual(d.topUnsorted, [['u@x.test', 3]]);
    assert.equal(d.notReadBeyondCap, 3, 'not additive across runs: the newest run stands');
    assert.deepEqual(d.outcomes, ['partial_budget']);
    assert.equal(d.ran, true);
  });

  test('top senders are limited to 10', async () => {
    const top = Array.from({ length: 15 }, (_, i) => [`s${i}@x.test`, 20 - i]);
    const d = await collectMailIntakeReport(client, runWithStats({ counts: { bulk_noise: 100 }, top_bulk: top, top_unsorted: top }), {});
    assert.equal(d.topBulk.length, 10);
    assert.equal(d.topUnsorted.length, 10);
  });

  test('no run carrying intake stats means ran: false', async () => {
    const d = await collectMailIntakeReport(client, [{ run_id: 1, stats: {} }], {});
    assert.equal(d.ran, false);
  });

  test('PRIVACY end to end: unsorted and bulk subjects stored in the ledger never reach the text, HTML or markdown report', async () => {
    await persistMailIntake(client, [
      row('2001', { bucket: 'unsorted', signal: null, subject: 'Lunch with the aunt on Sunday', snippet: 'secret family snippet' }),
      row('2002', { bucket: 'bulk_noise', signal: null, subject: 'Daily digest subject', snippet: 'digest snippet' }),
      row('2003', { subject: 'Chief Information Officer role', snippet: 'visible recruiter snippet' }),
    ], 'v1');
    const d = await collectMailIntakeReport(client, runWithStats({ counts: { unsorted: 1, bulk_noise: 1, recruiter_like: 1 }, top_unsorted: [['aunt@family.example', 1]], top_bulk: [['news@daily.example', 1]] }), {});
    const rendered = [mailIntakeLines(d).join('\n'), mailIntakeHtml(d, escapeHtml).join('\n'), mailIntakeLines(d, { markdown: true }).join('\n')].join('\n');
    assert.doesNotMatch(rendered, /Lunch with the aunt|secret family snippet|Daily digest subject|digest snippet/);
    assert.match(rendered, /visible recruiter snippet/, 'the recruiter-like item itself is shown');
    assert.match(rendered, /aunt@family\.example \(1\)/, 'top senders are shown');
  });

  test('the cap: 25 items listed, the rest a count', async () => {
    await persistMailIntake(client, Array.from({ length: 30 }, (_, i) => row(String(i + 1000))), 'v1');
    const d = await collectMailIntakeReport(client, [], { cap: 25 });
    const text = mailIntakeLines(d).join('\n');
    assert.equal(d.items.length, 25);
    assert.match(text, new RegExp(`${d.more} more on the dashboard Review page`));
    assert.match(text, /25 to look at/);
  });
});

describe('rendering', () => {
  const item = (over = {}) => ({
    message_id: 'a1b2c3d4e5f60001', thread_id: 't1', bucket: 'recruiter_like', signal: 'strong', from_addr: 'simon.wilkinson@forsythbarnes.com', from_name: 'Simon Wilkinson',
    reply_to: null, reply_to_differs: false, subject: 'Exciting New Opportunity - Lets Catch Up', snippet: 'Recruiting for a Chief Information Officer role.',
    msg_date: '2026-10-23T15:00:00.000Z', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], spam: false, body_unreadable: false, ...over,
  });
  const data = (/** @type {any[]} */ items, extra = {}) => ({
    ran: true, items, more: 0, counts: { self: 1, registered_alert: 2, application_mail: 0, internal: 0, thread_reply: 0, recruiter_like: items.length, bulk_noise: 4, unsorted: 1 },
    topUnsorted: [['lonely@x.test', 1]], topBulk: [['news@x.test', 4]], notReadBeyondCap: 0, metadataUnread: 0, outcomes: [], ...extra,
  });

  test('an item shows sender, subject, date, Gmail tab, signal and a message link', () => {
    const t = mailIntakeLines(data([item()])).join('\n');
    assert.match(t, /Simon Wilkinson <simon\.wilkinson@forsythbarnes\.com>/);
    assert.match(t, /Exciting New Opportunity/);
    assert.match(t, /2026-10-23/);
    assert.match(t, /Promotions/);
    assert.match(t, /recruiter_like\/strong/);
    assert.match(t, /https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/a1b2c3d4e5f60001/);
  });

  test('From and Reply-To are both shown when they differ', () => {
    const t = mailIntakeLines(data([item({ reply_to: 'harvest@collector.example', reply_to_differs: true })])).join('\n');
    assert.match(t, /From simon\.wilkinson@forsythbarnes\.com but Reply-To harvest@collector\.example/);
  });

  test('spam-folder items get their own subsection', () => {
    const t = mailIntakeLines(data([item(), item({ message_id: 'a1b2c3d4e5f60002', spam: true, labels: ['SPAM'] })])).join('\n');
    assert.match(t, /1 to look at:/);
    assert.match(t, /Spam folder \(1; treat as unverified\)/);
    const h = mailIntakeHtml(data([item({ spam: true, labels: ['SPAM'] })]), escapeHtml).join('');
    assert.match(h, /Spam folder \(1; treat as unverified\)/);
  });

  test('HTML output escapes every dynamic string and never carries a script or an unescaped quote', () => {
    const hostile = item({ subject: '<script>alert(1)</script>"x"', snippet: '<img src=x onerror=alert(1)> & more', from_name: '<b>Evil</b>', from_addr: 'a@b.test' });
    const h = mailIntakeHtml(data([hostile]), escapeHtml).join('');
    assert.doesNotMatch(h, /<script|<img|<b>Evil/);
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;x&quot;/);
    assert.match(h, /&amp; more/);
  });

  test('a message id that is not a Gmail hex id produces no link', () => {
    const t = mailIntakeLines(data([item({ message_id: '../../evil' })])).join('\n');
    assert.doesNotMatch(t, /mail\.google\.com/);
  });

  test('PRIVACY: only counts and top senders appear for unsorted and bulk mail; no subject-level detail', () => {
    const d = data([item()]);
    const all = [mailIntakeLines(d).join('\n'), mailIntakeHtml(d, escapeHtml).join('\n'), mailIntakeLines(d, { markdown: true }).join('\n')].join('\n');
    assert.match(all, /Top unsorted senders: lonely@x\.test \(1\)\. Subjects are on the dashboard/);
    assert.match(all, /Top bulk senders: news@x\.test \(4\)/);
    assert.match(all, /Mail intake counts: self 1, registered_alert 2/);
    // The data object handed to the renderers carries no unsorted or bulk subjects at all.
    assert.equal(JSON.stringify(d).includes('Lunch'), false);
  });

  test('the beyond-the-cap wording is present when bodies were left unread', () => {
    const t = mailIntakeLines(data([], { notReadBeyondCap: 7, metadataUnread: 3, outcomes: ['partial_budget'] })).join('\n');
    assert.match(t, /7 not read beyond the cap\./);
    assert.match(t, /3 messages not listed beyond the metadata cap\./);
    assert.match(t, /Mail intake outcome: partial_budget\./);
  });

  test('nothing new, and intake did not run, are both stated rather than omitted', () => {
    assert.match(mailIntakeLines(data([])).join('\n'), /No new recruiter-like mail or replies\./);
    assert.match(mailIntakeLines(data([], { ran: false })).join('\n'), /Mail intake did not run in this report window\./);
    assert.match(mailIntakeLines({ error: 'relation missing' }).join('\n'), /unavailable \(relation missing\)/);
    assert.deepEqual(mailIntakeLines(null), []);
  });

  test('markdown wraps the Gmail link', () => {
    assert.match(mailIntakeLines(data([item()]), { markdown: true }).join('\n'), /\[Open in Gmail\]\(https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/a1b2c3d4e5f60001\)/);
  });
});

describe('placement in the full report', () => {
  const items = [{
    message_id: 'a1b2c3d4e5f60001', thread_id: 't1', bucket: 'recruiter_like', signal: 'strong', from_addr: 's@firm.example', from_name: 'S', reply_to: null, reply_to_differs: false,
    subject: 'Role', snippet: 'Recruiting for a CIO.', msg_date: '2026-10-23T15:00:00.000Z', labels: ['INBOX'], spam: false, body_unreadable: false,
  }];
  const mi = { ran: true, items, more: 0, counts: {}, topUnsorted: [], topBulk: [], notReadBeyondCap: 0, metadataUnread: 0, outcomes: [] };
  const cap = 'Gmail send BROKEN since 2026-10-20 (4 days): read OK, last good send 2026-10-19T23:00:00.000Z. Re-authorize on dashboard.';

  test('text: the capability line is the first line, the Recruiter mail section follows, both before everything else', async () => {
    const lines = renderReportText(/** @type {any} */ (await reportData(mi, cap)), registry, undefined, null).split('\n');
    assert.equal(lines[0], cap);
    const recruiter = lines.indexOf('== Recruiter mail ==');
    const heading = lines.findIndex((l) => l.startsWith('Job scan report for'));
    assert.ok(recruiter > 0 && recruiter < heading);
  });

  test('html and markdown: same order', async () => {
    const h = renderReportHtml(/** @type {any} */ (await reportData(mi, cap)), registry, undefined, null);
    assert.ok(h.startsWith(`<p><strong>${escapeHtml(cap)}</strong></p>`));
    assert.ok(h.indexOf('Recruiter mail') < h.indexOf('Job scan report for'));
    const md = renderReportMarkdown(/** @type {any} */ (await reportData(mi, cap)), registry, undefined, null);
    assert.ok(md.startsWith(`**${cap}**`));
    assert.ok(md.indexOf('## Recruiter mail') < md.indexOf('# Job scan report for'));
  });

  test('with nothing broken the Recruiter mail section is still first', async () => {
    const lines = renderReportText(/** @type {any} */ (await reportData(mi, null)), registry, undefined, null).split('\n');
    assert.equal(lines[0], '== Recruiter mail ==');
  });
});
