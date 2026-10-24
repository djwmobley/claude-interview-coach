// @ts-check
/**
 * Behavioral half of the no-model rule (companion to test/mail-intake-no-model.test.js): the MCP tool outputs a
 * Claude session receives carry no intake text (sender, subject, snippet). Builds a real report with a
 * recruiter item whose sender, subject and snippet are unique sentinels, calls the scan_report tool handler, and
 * asserts none appears; the scans tool's run stats lose the intake sender lists.
 *
 * BLIND SPOTS: covers the tools that exist today (scan_report, scans); a new tool that reads ic_mail_intake or
 * renders the report is caught only by the source scan in the last test, which is name based.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { persistMailIntake } from '../src/core/mail-intake-store.js';
import { collectMailIntakeReport, mailIntakeLines, redactMailIntakeForModel, redactRunStatsForModel } from '../src/core/mail-intake-report.js';
import { tool as scanReport } from '../src/tools/scan_report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `ZZNOMODEL${process.pid}`;
const SENT_SUBJECT = `${TAG}SUBJECT`;
const SENT_SNIPPET = `${TAG}SNIPPET`;
const SENT_SENDER = `${TAG.toLowerCase()}@sentinel.example`;
const SENT_NAME = `${TAG}NAME`;
const ID = `fe${String(process.pid).padStart(6, '0')}ab`;
/** @type {pg.Client} */
let client;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await client.query('DELETE FROM ic_mail_intake WHERE message_id = $1', [ID]);
  await persistMailIntake(client, [{
    message_id: ID, thread_id: `th${ID}`, bucket: 'recruiter_like', signal: 'strong', from_addr: SENT_SENDER, from_name: SENT_NAME, reply_to: null, reply_to_differs: false,
    subject: SENT_SUBJECT, snippet: SENT_SNIPPET, msg_date: '2026-10-23T12:00:00.000Z', labels: ['INBOX'], spam: false, body_unreadable: false,
  }], 'v1');
});
after(async () => {
  await client.query('DELETE FROM ic_mail_intake WHERE message_id = $1', [ID]);
  await client.end();
});

describe('MCP tool outputs never carry intake text', () => {
  test('control: the unredacted report section DOES carry the sentinels (so the checks below mean something)', async () => {
    const d = await collectMailIntakeReport(client, [], { cap: 25 });
    const text = mailIntakeLines(d).join('\n');
    assert.ok(text.includes(SENT_SUBJECT) && text.includes(SENT_SNIPPET) && text.includes(SENT_SENDER));
  });

  test('scan_report: the whole tool response has none of the sentinels and points to the dashboard Review page', async () => {
    const deps = /** @type {any} */ ({ withClient: async (/** @type {any} */ fn) => fn(client), config: null });
    const r = await scanReport.handler({ profile: 'exec-default' }, deps);
    const out = JSON.stringify(r);
    for (const s of [SENT_SUBJECT, SENT_SNIPPET, SENT_SENDER, SENT_NAME]) assert.equal(out.includes(s), false, `leaked ${s}`);
    assert.match(out, /waiting; see dashboard Review/);
    assert.match(out, /Mail intake counts:/);
  });

  test('redactMailIntakeForModel keeps counts and drops every item and sender list', async () => {
    const stats = { gmail: { mail_intake: { counts: { bulk_noise: 3 }, top_bulk: [[SENT_SENDER, 3]], top_unsorted: [[SENT_SENDER, 1]] } } };
    const d = await collectMailIntakeReport(client, [{ run_id: 1, stats }], { cap: 25 });
    const red = redactMailIntakeForModel(d);
    assert.equal(JSON.stringify(red).includes(TAG.toLowerCase()), false);
    assert.equal(JSON.stringify(red).includes(TAG), false);
    assert.equal(red.counts.bulk_noise, 3);
    assert.ok(red.waiting >= 1);
    assert.deepEqual(redactMailIntakeForModel({ error: `boom with ${SENT_SUBJECT}` }), { error: 'unavailable' });
    assert.equal(redactMailIntakeForModel(null), null);
  });

  test('the scans tool strips the intake sender lists and error text from run stats (counts stay)', () => {
    const stats = { fetched: 4, gmail: { by_sender: { 'a@b.test': { emails: 1 } }, mail_intake: { outcome: 'ok', counts: { bulk_noise: 2 }, top_bulk: [[SENT_SENDER, 2]], top_unsorted: [[SENT_SENDER, 1]], error: SENT_SUBJECT } } };
    const red = redactRunStatsForModel(stats);
    assert.equal(JSON.stringify(red).includes(TAG), false);
    assert.equal(JSON.stringify(red).includes(TAG.toLowerCase()), false);
    assert.equal(red.gmail.mail_intake.counts.bulk_noise, 2);
    assert.equal(red.fetched, 4);
    assert.deepEqual(redactRunStatsForModel({ fetched: 1 }), { fetched: 1 });
  });

  test('every src/tools module that renders the report or reads the ledger goes through the redaction; none returns raw run stats', () => {
    const dir = path.join(ROOT, 'src', 'tools');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const touchesReport = /renderReport(?:Text|Html|Markdown)\(|ic_mail_intake|mail-intake-store|collectMailIntakeReport/.test(text);
      if (touchesReport) assert.match(text, /redactMailIntakeForModel/, `${f} renders the report without redaction`);
      assert.equal(/stats:\s*r\.stats\b/.test(text), false, `${f} returns raw run stats`);
    }
  });
});
