// @ts-check
/**
 * src/tools/easy_apply.js (assisted Easy Apply, spec B2, G5, G6, G7, G8, G11): every call validates the
 * lease; answer refuses non-field refs and resolves values server-side; non-exact questions park and end
 * the session; advance requires every field visited and read back; driver refusals stop the session;
 * "application sent" and challenge pages trip the breaker; finish fails on an alert, an unverified ledger,
 * or a missing review value, and succeeds only at Review with everything verified. Real test database for
 * leases/applications; a scripted fake driver stands in for the browser (the real driver is covered
 * against fixtures in test/easy-apply-driver.test.js). Also: src/server.js registers easy_apply only in
 * lease mode, and then nothing else.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createApplication } from '../src/core/applications.js';
import { issueLease, getLease, breakerStatus, clearBreakerForTests, LEASE_ENV } from '../src/core/easy-apply-state.js';
import { parseAnswerBank } from '../src/apply/answers.js';
import { makeEasyApplyTool, schema } from '../src/tools/easy_apply.js';
import { toolsForEnv, TOOLS } from '../src/server.js';

const CO = `ZZ-TEST-EASYTOOL-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];
const BANK = parseAnswerBank(['## first_name', 'type: text', 'value: Damian', '## phone', 'type: text', 'value: 7135550100',
  '## sponsorship_needed', 'type: boolean', 'value: false', 'learned: Will you now or in the future require sponsorship?'].join('\n'));

async function cleanup() {
  await clearBreakerForTests(client);
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
  await closePool();
});
beforeEach(cleanup);

/** @param {{ outputRoot?: string, resumeBytes?: Buffer, hashOverride?: string }} [o] */
async function setup(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url)
     VALUES ('Easy Tool Test', $1, 'linkedin', $2, 'listing', $3, 'easy tool test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-easytool-${process.pid}:${n}`, `easy tool co ${n}`, `zz-easytool-hash-${n}`, `https://www.linkedin.com/jobs/view/${n}/`],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const app = await createApplication(client, { listingId, atsType: 'linkedin_easy', applyUrl: `https://www.linkedin.com/jobs/view/${n}/`, floors: { texas_or_remote: 1, relocation: 1 } });
  await client.query(`UPDATE ic_job_applications SET state = 'submitting', account_email = 'owner@example.com' WHERE id = $1`, [app.id]);
  if (o.outputRoot) {
    const bytes = o.resumeBytes ?? Buffer.from('resume bytes');
    fs.mkdirSync(path.join(o.outputRoot, 'resumes'), { recursive: true });
    fs.writeFileSync(path.join(o.outputRoot, 'resumes', 'Damian Mobley - CTO.docx'), bytes);
    const d = await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', 'resumes/Damian Mobley - CTO.docx', 'mcp') RETURNING id`, [listingId]);
    const hash = o.hashOverride ?? crypto.createHash('sha256').update(bytes).digest('hex');
    await client.query('UPDATE ic_job_applications SET resume_doc_id = $2, resume_hash = $3 WHERE id = $1', [app.id, Number(d.rows[0].id), hash]);
  }
  const lease = await issueLease(client, { applicationId: app.id, trigger: 'dashboard', targetId: 'TAB-X', ttlMs: 600000 });
  return { appId: app.id, ...lease };
}

/**
 * Scripted fake driver. `steps` are snapshot objects; advance(ref) consults `onAdvance`.
 * @param {any[]} steps
 * @param {{ onAdvance?: (ref: string, d: any) => any, readBackOverride?: (ref: string, v: string) => string }} [o]
 */
function fakeDriver(steps, o = {}) {
  const d = {
    i: 0, values: /** @type {Record<string,string>} */ ({}), calls: /** @type {any[]} */ ([]), uploaded: /** @type {string|null} */ (null),
    async snapshot() {
      const s = JSON.parse(JSON.stringify(steps[d.i]));
      for (const f of s.fields) if (d.values[f.ref] !== undefined) { f.value = d.values[f.ref]; f.filled = f.value !== ''; }
      if (d.uploaded && s.resumeCards) s.resumeCards = [{ name: 'Old.pdf', selected: false }, { name: d.uploaded, selected: true }];
      return s;
    },
    async readField(/** @type {string} */ ref) {
      const f = steps[d.i].fields.find((/** @type {any} */ x) => x.ref === ref);
      const v = d.values[ref] ?? f?.value ?? '';
      return { ok: true, value: o.readBackOverride ? o.readBackOverride(ref, v) : v };
    },
    async typeText(/** @type {string} */ ref, /** @type {string} */ v) { d.calls.push(['typeText', ref, v]); d.values[ref] = v; return { ok: true, readBack: v }; },
    async chooseOption(/** @type {string} */ ref, /** @type {string} */ v) { d.calls.push(['chooseOption', ref, v]); d.values[ref] = v; return { ok: true, readBack: v }; },
    async chooseRadio(/** @type {string} */ ref, /** @type {string} */ v) { d.calls.push(['chooseRadio', ref, v]); d.values[ref] = v; return { ok: true, readBack: v }; },
    async setCheckbox(/** @type {string} */ ref, /** @type {boolean} */ v) { d.calls.push(['setCheckbox', ref, v]); d.values[ref] = v ? 'checked' : ''; return { ok: true }; },
    async uploadFile(/** @type {string} */ p) { d.calls.push(['uploadFile', p]); d.uploaded = path.basename(p); return { ok: true, fileName: path.basename(p) }; },
    async advance(/** @type {string} */ ref) {
      d.calls.push(['advance', ref]);
      const r = o.onAdvance ? o.onAdvance(ref, d) : { clicked: true };
      if (r.clicked) d.i++;
      return r;
    },
    async screenshot() { return Buffer.from('png-bytes'); },
  };
  return d;
}

/** @param {any} o */
const step = (o) => ({ step: { kind: 'form' }, progressValues: [50], header: 'Apply to Acme', buttons: [{ ref: 'e9-next', name: 'next', allowed: true }], fields: [], alerts: [], resumeCards: [], dialogText: '', stepKey: 'k0', ...o });
const contactStep = step({
  stepKey: 'contact',
  fields: [
    { ref: 'e1-a', kind: 'text', question: 'First name', required: true, options: [], value: 'Damain', filled: true },
    { ref: 'e2-b', kind: 'text', question: 'Mobile phone number', required: true, options: [], value: '', filled: false },
  ],
});
const reviewStep = (/** @type {any} */ o = {}) => step({ step: { kind: 'review' }, stepKey: 'review', progressValues: [100], buttons: [{ ref: 'e7-sub', name: 'submit application', allowed: false }], dialogText: 'Review your application Damian 713-555-0100', ...o });

/** @param {any} drv @param {{ token: string, outputRoot?: string }} o */
function toolFor(drv, o) {
  return makeEasyApplyTool({ leaseToken: () => o.token, openDriver: async () => ({ driver: drv, close: async () => {} }), bank: BANK, outputRoot: o.outputRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'easytool-out-')) });
}
const deps = /** @type {any} */ ({ withClient });

describe('server lease mode', () => {
  test('easy_apply is the ONLY tool with a lease token, and absent without one', () => {
    assert.deepEqual(toolsForEnv({ [LEASE_ENV]: '1.abc' }).map((t) => t.name), ['easy_apply']);
    assert.ok(!toolsForEnv({}).some((t) => t.name === 'easy_apply'));
    assert.equal(toolsForEnv({}), TOOLS);
  });
  test('the schema carries no value field: the model can only pass an action, a ref, and a park label hint (never filled)', () => {
    assert.deepEqual(Object.keys(schema).sort(), ['action', 'label', 'ref']);
  });
});

describe('lease validation on every call', () => {
  test('no token and a forged token are refused before any page access', async () => {
    const { token, appId } = await setup();
    let opened = 0;
    const mk = (/** @type {string|undefined} */ t) => makeEasyApplyTool({ leaseToken: () => t, openDriver: async () => { opened++; return { driver: fakeDriver([contactStep]), close: async () => {} }; }, bank: BANK });
    await assert.rejects(mk(undefined).handler({ action: 'snapshot' }, deps), /lease_missing/);
    const forged = `${appId}.${'ab'.repeat(24)}`;
    assert.notEqual(forged, token);
    await assert.rejects(mk(forged).handler({ action: 'snapshot' }, deps), /lease_invalid/);
    assert.equal(opened, 0);
  });
  test('an expired lease is refused', async () => {
    const { token, leaseId } = await setup();
    await client.query(`UPDATE ic_easy_apply_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [leaseId]);
    await assert.rejects(toolFor(fakeDriver([contactStep]), { token }).handler({ action: 'snapshot' }, deps), /lease_expired/);
  });
});

describe('answer (G6)', () => {
  test('snapshot wraps employer text as untrusted; answer refuses a button ref; contact fields fill from the bank (prefilled mismatch overwritten)', async () => {
    const { token, leaseId } = await setup();
    const drv = fakeDriver([contactStep]);
    const t = toolFor(drv, { token });
    const snap = /** @type {any} */ (await t.handler({ action: 'snapshot' }, deps));
    assert.match(snap.employer_text, /UNTRUSTED|untrusted/i);
    assert.ok(!('question' in snap.fields[0]));
    const refused = /** @type {any} */ (await t.handler({ action: 'answer', ref: 'e9-next' }, deps));
    assert.equal(refused.ok, false);
    await t.handler({ action: 'answer', ref: 'e1-a' }, deps);
    await t.handler({ action: 'answer', ref: 'e2-b' }, deps);
    assert.deepEqual(drv.calls, [['typeText', 'e1-a', 'Damian'], ['typeText', 'e2-b', '7135550100']]);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.ledger.length, 2);
    assert.equal(lease.ledger[0].bank_key, 'first_name');
  });
  test('a non-exact required question parks and ends the session; further calls are refused', async () => {
    const { token, leaseId } = await setup();
    const q = step({ fields: [{ ref: 'e3-c', kind: 'radio', question: 'Will you now, or in the future, require sponsorship?', required: true, options: ['Yes', 'No'], value: '', filled: false }] });
    const t = toolFor(fakeDriver([q]), { token });
    const r = /** @type {any} */ (await t.handler({ action: 'answer', ref: 'e3-c' }, deps));
    assert.equal(r.stopped, true);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'parked');
    assert.match(lease.finish_result.park.question, /sponsorship/);
    await assert.rejects(t.handler({ action: 'snapshot' }, deps), /lease_closed/);
  });
  test('park with a ref not in the snapshot is refused once (re-snapshot), then parks with the label hint and no question', async () => {
    const { token, leaseId } = await setup();
    const t = toolFor(fakeDriver([contactStep]), { token });
    const first = /** @type {any} */ (await t.handler({ action: 'park', ref: 'e99-zz', label: 'Cover note box' }, deps));
    assert.equal(first.ok, false);
    assert.equal(first.error, 'unknown_ref');
    assert.notEqual(first.stopped, true);
    assert.equal((await getLease(client, leaseId)).stop_reason, null);
    const second = /** @type {any} */ (await t.handler({ action: 'park', ref: 'e98-yy', label: 'Cover note box' }, deps));
    assert.equal(second.stopped, true);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'parked');
    assert.equal(lease.finish_result.park.question, null);
    assert.equal(lease.finish_result.park.label_hint, 'Cover note box');
  });
  test('park with a real ref after a refused one parks with the question text', async () => {
    const { token, leaseId } = await setup();
    const t = toolFor(fakeDriver([contactStep]), { token });
    await t.handler({ action: 'park', ref: 'e99-zz' }, deps);
    const r = /** @type {any} */ (await t.handler({ action: 'park', ref: 'e2-b' }, deps));
    assert.equal(r.stopped, true);
    assert.equal((await getLease(client, leaseId)).finish_result.park.question, 'Mobile phone number');
  });
  test('two failed read-backs park', async () => {
    const { token, leaseId } = await setup();
    const t = toolFor(fakeDriver([contactStep], { readBackOverride: () => 'garbled' }), { token });
    await t.handler({ action: 'answer', ref: 'e1-a' }, deps);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'parked');
    assert.equal(lease.finish_result.park.reason, 'readback_mismatch_after_two_attempts');
  });
});

describe('advance', () => {
  test('unvisited fields stop the session without clicking', async () => {
    const { token, leaseId } = await setup();
    const drv = fakeDriver([contactStep, reviewStep()]);
    const t = toolFor(drv, { token });
    await t.handler({ action: 'advance', ref: 'e9-next' }, deps);
    assert.ok(!drv.calls.some((c) => c[0] === 'advance'));
    assert.equal((await getLease(client, leaseId)).stop_reason, 'unvisited_fields');
  });
  test('a driver uncertain_last_step refusal stops with that reason and records allVerified', async () => {
    const { token, leaseId } = await setup();
    const drv = fakeDriver([contactStep], { onAdvance: () => ({ clicked: false, reason: 'uncertain_last_step' }) });
    const t = toolFor(drv, { token });
    await t.handler({ action: 'answer', ref: 'e1-a' }, deps);
    await t.handler({ action: 'answer', ref: 'e2-b' }, deps);
    await t.handler({ action: 'advance', ref: 'e9-next' }, deps);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'uncertain_last_step');
    assert.equal(lease.state.allVerified, true);
  });
  test('a denied/unknown button stops with unknown_button', async () => {
    const { token, leaseId } = await setup();
    const t = toolFor(fakeDriver([step({})], { onAdvance: () => ({ clicked: false, reason: 'denied_term' }) }), { token });
    await t.handler({ action: 'advance', ref: 'e9-next' }, deps);
    assert.equal((await getLease(client, leaseId)).stop_reason, 'unknown_button');
  });
});

describe('G5 / G11', () => {
  test('an application-sent confirmation stops with unexpected_submit and trips the breaker', async () => {
    const { token, leaseId } = await setup();
    const t = toolFor(fakeDriver([step({ step: { kind: 'sent' } })]), { token });
    const r = /** @type {any} */ (await t.handler({ action: 'snapshot' }, deps));
    assert.equal(r.stop_reason, 'unexpected_submit');
    assert.equal((await getLease(client, leaseId)).stop_reason, 'unexpected_submit');
    assert.equal((await withClient((c) => breakerStatus(c))).tripped, true);
  });
  test('a challenge page stops and trips the breaker', async () => {
    const { token } = await setup();
    const t = toolFor(fakeDriver([step({ step: { kind: 'challenge' } })]), { token });
    assert.equal(/** @type {any} */ (await t.handler({ action: 'snapshot' }, deps)).stop_reason, 'challenge');
    assert.equal((await withClient((c) => breakerStatus(c))).reason, 'challenge');
  });
});

describe('upload_resume (G7)', () => {
  test('hash mismatch stops before any upload', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easytool-out-'));
    const { token, leaseId } = await setup({ outputRoot, hashOverride: 'f'.repeat(64) });
    const drv = fakeDriver([step({ resumeCards: [{ name: 'Old.pdf', selected: true }], fields: [{ ref: 'e4-f', kind: 'file', question: 'Upload resume', required: false, options: [], value: '', filled: false }] })]);
    await toolFor(drv, { token, outputRoot }).handler({ action: 'upload_resume' }, deps);
    assert.ok(!drv.calls.some((c) => c[0] === 'uploadFile'));
    assert.equal((await getLease(client, leaseId)).stop_reason, 'resume_hash_mismatch');
  });
  test('verified upload marks the resume uploaded', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easytool-out-'));
    const { token, leaseId } = await setup({ outputRoot });
    const drv = fakeDriver([step({ resumeCards: [{ name: 'Old.pdf', selected: true }], fields: [{ ref: 'e4-f', kind: 'file', question: 'Upload resume', required: false, options: [], value: '', filled: false }] })]);
    const r = /** @type {any} */ (await toolFor(drv, { token, outputRoot }).handler({ action: 'upload_resume' }, deps));
    assert.equal(r.result, 'uploaded');
    assert.equal((await getLease(client, leaseId)).state.resumeUploaded, 'Damian Mobley - CTO.docx');
  });
});

describe('finish (G8)', () => {
  /** Walk contact -> review through the tool. @param {any} drv @param {any} t */
  async function walk(drv, t) {
    await t.handler({ action: 'answer', ref: 'e1-a' }, deps);
    await t.handler({ action: 'answer', ref: 'e2-b' }, deps);
    return t.handler({ action: 'advance', ref: 'e9-next' }, deps);
  }
  test('verified finish at Review records ok with a screenshot', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easytool-out-'));
    const { token, leaseId, appId } = await setup();
    const drv = fakeDriver([contactStep, reviewStep()]);
    const t = toolFor(drv, { token, outputRoot });
    const adv = /** @type {any} */ (await walk(drv, t));
    assert.equal(adv.step, 'review');
    const r = /** @type {any} */ (await t.handler({ action: 'finish' }, deps));
    assert.equal(r.result, 'finished', JSON.stringify(r));
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'finished');
    assert.equal(lease.finish_result.ok, true);
    assert.match(lease.finish_result.screenshot_rel_path, new RegExp(`^applications/${appId}/`));
    assert.ok(!drv.calls.some((c) => c[0] === 'advance' && c[1] === 'e7-sub'));
  });
  test('an alert on the Review screen and a value missing from the review fail finish', async () => {
    const { token, leaseId } = await setup();
    const drv = fakeDriver([contactStep, reviewStep({ alerts: ['Please enter a valid answer'], dialogText: 'Review your application Damian' })]);
    const t = toolFor(drv, { token });
    await walk(drv, t);
    await t.handler({ action: 'finish' }, deps);
    const lease = await getLease(client, leaseId);
    assert.equal(lease.stop_reason, 'finish_failed');
    assert.ok(lease.finish_result.problems.includes('validation_alert_present'));
    assert.ok(lease.finish_result.problems.some((/** @type {string} */ p) => p.startsWith('review_missing_value:phone')));
  });
  test('finish before the Review screen stops without success', async () => {
    const { token, leaseId } = await setup();
    await toolFor(fakeDriver([contactStep]), { token }).handler({ action: 'finish' }, deps);
    assert.equal((await getLease(client, leaseId)).stop_reason, 'finish_not_at_review_form');
  });
});
