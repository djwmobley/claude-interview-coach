// @ts-check
/**
 * src/core/remind.js's auto-apply digest wiring (auto-apply GAP 2, docs/auto-apply-spec.md section 9):
 * the daily digest body always carries the Auto-apply section -- real counts when a summary file exists,
 * a distinct empty state when it does not, and no throw for a missing/corrupt file.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { runRemind } from '../src/core/remind.js';
import { writeAutoApplySummary } from '../src/core/auto-apply-state.js';

/** @type {pg.Client} */
let client;
let tmp = '';
const CO = `ZZ-TEST-REMINDAA-${process.pid}`;
/** @type {number[]} */
const listingIds = [];

async function insertListing(source = 'linkedin') {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, url_normalized)
     VALUES ('Remind Auto-Apply Test', $1, $2, $3, 'listing', 'remindaa test co', 'remindaa test', 'legacy-unknown', $4, now(), $5, $5) RETURNING id`,
    [CO, source, `zz-test-remindaa-${process.pid}:${n}`, `zz-remindaa-hash-${n}`, `https://www.linkedin.com/jobs/view/${n}/`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-aa-test-'));
});
after(async () => {
  if (listingIds.length) await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  await client.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fakeGoogle = (/** @type {any} */ fetchImpl) => async () => ({
  deps: { fetch: fetchImpl, accessToken: 'fake-token' },
  info: { has_refresh_token: true, gmail_send_ok: true, calendar_ok: true, expiry: null, scope_count: 2 },
  expiry: '2026-08-25T00:00:00.000Z',
});
function fetchStub() {
  return async () => ({ ok: true, status: 200, json: async () => ({ id: 'msg-1' }) });
}

describe('runRemind: auto-apply section is always present in the digest body', () => {
  test('a real summary file: the digest contains the section with real counts', async () => {
    const listingId = await insertListing('linkedin');
    const summaryFile = path.join(tmp, 'auto-apply-latest.json');
    writeAutoApplySummary(summaryFile, {
      dry_run: false,
      select: { results: [{ listingId, reason: 'apply_target_unresolved' }, { listingId: 999999, reason: 'daily_cap' }], cap_used: 2, cap_remaining: 3 },
      applied: [{ listingId: 1234, applicationId: 1, outcome: 'applied' }],
    });
    const now = new Date('2026-09-03T12:00:00Z');
    const f = fetchStub();
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true,
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)),
      autoApplySummaryFile: summaryFile,
    });
    assert.equal(r.code, 0);
    assert.ok(r.body);
    assert.match(r.body, /== Auto-apply ==/);
    assert.match(r.body, /applied 1/);
    assert.match(r.body, /capped 1/);
    assert.match(r.body, /apply_target_unresolved=1/);
  });

  test('no summary file configured at all: the empty state still renders, never omitted', async () => {
    const now = new Date('2026-09-03T12:00:00Z');
    const f = fetchStub();
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true,
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)),
    });
    assert.equal(r.code, 0);
    assert.ok(r.body);
    assert.match(r.body, /== Auto-apply ==/);
    assert.match(r.body, /no auto-apply run recorded today/);
  });

  test('a missing/corrupt summary file path never throws: behaves exactly like the feature not existing', async () => {
    const now = new Date('2026-09-03T12:00:00Z');
    const f = fetchStub();
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true,
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)),
      autoApplySummaryFile: path.join(tmp, 'does-not-exist.json'),
    });
    assert.equal(r.code, 0);
    assert.ok(r.body);
    assert.match(r.body, /no auto-apply run recorded today/);
  });

  test('a corrupt (non-JSON) summary file never throws either', async () => {
    const badFile = path.join(tmp, 'auto-apply-corrupt.json');
    fs.writeFileSync(badFile, 'not valid json{{{');
    const now = new Date('2026-09-03T12:00:00Z');
    const f = fetchStub();
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true,
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)),
      autoApplySummaryFile: badFile,
    });
    assert.equal(r.code, 0);
    assert.ok(r.body);
    assert.match(r.body, /no auto-apply run recorded today/);
  });
});
