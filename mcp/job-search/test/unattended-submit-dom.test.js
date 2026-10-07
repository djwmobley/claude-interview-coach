// @ts-check
/**
 * Unattended submit against REAL DOM fixtures (test/fixtures/unattended-submit/, served to a throwaway
 * headless Chrome), the real apply capability (pageState, clickSingle), the real adapters, and the real
 * isolated test DB for the marker. Covers spec v1 Tests and spec v2 C1-C6, C11:
 *   positive   Greenhouse, Lever, iCIMS (adapters end to end), Dayforce's review step, Workday's Review page,
 *              and the worker path (runApplyWorker -> adapter -> ctx.submit) reach confirmed;
 *   negative   an unrecognized review page, a missing required answer, two submit controls, a consent box,
 *              a hash drift, an excluded company at click time, the cap exhausted, the kill switch off, an
 *              ATS switched off, a Workday step other than Review: each parks with NO click and NO marker;
 *   adversarial a pre-existing thank-you heading, a stale thanks apply URL, a toast then an error, an iframe-
 *              only confirmation, Workday's Save and Continue Later next to Submit, two workers on one
 *              application (exactly one click), and a crash after the marker (submit_unconfirmed, never a
 *              second click, never resumable, never "applied by hand").
 * Every click is counted by the fixture page itself (window.__clicks), not inferred.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright-core';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  createApplication, getApplication, reconcileStale, reserveSubmitMarker, markAppliedByHand, transition, hasSubmitRequestSentEver,
  listApplicationEvents, submitMarkersToday,
} from '../src/core/applications.js';
import { makeApplyCapability } from '../src/apply/apply-capability.js';
import { runGuardedSubmit, clickTimeExclusionCheck, EXCLUSION_LOCK_NAMESPACE } from '../src/apply/unattended-submit.js';
import { runApplyWorker, EXCLUSION_LOCK_NAMESPACE as WORKER_EXCLUSION_NS } from '../src/apply/worker.js';
import { greenhouse } from '../src/apply/adapters/greenhouse.js';
import { lever } from '../src/apply/adapters/lever.js';
import { smartrecruiters } from '../src/apply/adapters/smartrecruiters.js';
import { icims } from '../src/apply/adapters/icims.js';
import { resumeParkedApplication } from '../src/apply/resume-gate.js';
import { loadExclusionConfig } from '../src/apply/exclusions.js';
import { launchHeadlessChrome, findChromeBinary } from './helpers/headless-chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'unattended-submit');
const SKIP = findChromeBinary() ? false : 'no Chrome/Edge binary on this machine';
const CO = `ZZ-TEST-UNATTENDED-${process.pid}`;
const ALL_ATS = ['greenhouse', 'lever', 'smartrecruiters', 'icims', 'dayforce', 'workday'];

/** @type {any} */
let chrome = null;
/** @type {import('playwright-core').Browser|null} */
let browser = null;
/** @type {import('playwright-core').BrowserContext} */
let context;
/** @type {pg.Client} */
let db;
/** @type {string} */
let outputRoot;
/** @type {string} */
let resumeHash;
/** @type {number[]} */
const listingIds = [];

/** @param {{ cap?: number, enabled?: boolean, ats?: Record<string, boolean>, atsAllow?: string[], submitMode?: string }} [o] */
function configOn(o = {}) {
  /** @type {Record<string, boolean>} */
  const ats = {};
  for (const a of ALL_ATS) ats[a] = true;
  return {
    autoApply: {
      atsAllow: o.atsAllow ?? ALL_ATS, workday: { submitMode: o.submitMode ?? 'unattended' },
      unattendedSubmit: { enabled: o.enabled ?? true, ats: { ...ats, ...(o.ats ?? {}) }, dailySubmitCap: o.cap ?? 1000 },
    },
  };
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await db.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await db.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await db.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await db.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await db.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await db.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await db.query('UPDATE ic_job_listings SET duplicate_of = NULL WHERE id = ANY($1::int[])', [listingIds]);
  await db.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

/**
 * A listing (unique company per call, so the exclusion gate never sees another test's rows) and an
 * application on it in state `state`, with an approved resume hash.
 * @param {{ ats?: string, applyUrl?: string, state?: string, company?: string, title?: string, duplicateOf?: number|null }} [o]
 */
async function seedApp(o = {}) {
  const n = crypto.randomBytes(6).toString('hex');
  const company = o.company ?? `${CO}-${n}`;
  const r = await db.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of)
     VALUES ($1, $2, $3, $4, 'listing', $5, $6, 'legacy-unknown', $7, now(), $8) RETURNING id`,
    [o.title ?? 'Chief Technology Officer', company, `zz-test-unattended-${process.pid}`, `zz-test-unattended-${process.pid}:${n}`, company.toLowerCase(), (o.title ?? 'Chief Technology Officer').toLowerCase(), `zz-unattended-${n}`, o.duplicateOf ?? null],
  );
  const listingId = Number(r.rows[0].id);
  listingIds.push(listingId);
  const ats = o.ats ?? 'greenhouse';
  const applyUrl = o.applyUrl ?? 'https://boards.greenhouse.io/acme/jobs/123';
  const created = await createApplication(db, { listingId, atsType: ats, applyUrl, accountEmail: 'jordan@example.com', actor: 'mcp', floors: { texas_or_remote: 225000, relocation: 275000 } });
  const doc = await db.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', 'resumes/resume.docx', 'mcp') RETURNING id`, [listingId]);
  await db.query('UPDATE ic_job_applications SET state = $2, resume_hash = $3, resume_doc_id = $4 WHERE id = $1', [created.id, o.state ?? 'submitting', resumeHash, Number(doc.rows[0].id)]);
  return { id: Number(created.id), listing_id: listingId, apply_url: applyUrl, ats_type: ats, resume_hash: resumeHash };
}

/** @param {string} urlPath */
async function openPage(urlPath) {
  const page = await context.newPage();
  await page.goto(`${chrome.baseUrl}${urlPath}`);
  return page;
}

/** @param {import('playwright-core').Page} page @param {number} appId */
function capFor(page, appId) {
  return makeApplyCapability(page, { signal: new AbortController().signal, applicationId: appId, outputRoot });
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * runGuardedSubmit with test timing and permissive defaults (each overridable).
 * @param {any} app @param {any} cap @param {Record<string, any>} [extra]
 */
function guarded(app, cap, extra = {}) {
  return runGuardedSubmit({
    client: db, app, cap, mode: 'form', ledger: [],
    loadConfig: () => configOn(), exclusionCheck: async () => ({ branch: 'eligible' }), resumeHash: () => resumeHash,
    sleep, log: () => {}, pollMs: 40, maxPolls: 20, settleMs: 250,
    ...extra,
  });
}

/** @param {any} app @param {any} cap @param {Record<string, any>} [extra] */
function ctxFor(app, cap, extra = {}) {
  return {
    applicationId: app.id, applyUrl: app.apply_url,
    profile: { fullName: 'Jordan Reyes', email: 'jordan@example.com', emailSource: 'contact', phone: '555-0100' },
    documents: { resumePath: 'resumes/resume.docx', coverletterPath: null },
    answers: { bank: { meta: { salary_floor: null } }, match: () => ({ outcome: 'needs_human_no_match', tier: 'none' }) },
    log: () => {}, credentials: { target: 'jobsearch:test' },
    submit: (/** @type {any} */ o) => guarded(app, cap, { ...o, ...extra }),
  };
}

/** @param {import('playwright-core').Page} page */
const clicksOf = (page) => page.evaluate(() => /** @type {any} */ (window).__clicks);

before(async () => {
  db = new pg.Client(pgConnectionConfig());
  await db.connect();
  await ensureAuxSchema(db);
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-submit-out-'));
  fs.mkdirSync(path.join(outputRoot, 'resumes'));
  const bytes = Buffer.from('PK fake docx bytes for the unattended submit tests');
  fs.writeFileSync(path.join(outputRoot, 'resumes', 'resume.docx'), bytes);
  resumeHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (SKIP) return;
  chrome = await launchHeadlessChrome(FIXTURES);
  browser = await chromium.connectOverCDP(chrome.wsUrl);
  context = browser.contexts()[0] ?? await browser.newContext();
});
after(async () => {
  await cleanup();
  await db.end();
  if (browser) await browser.close().catch(() => {});
  if (chrome) await chrome.close();
  try {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  } catch {
    /* temp cleaner gets it */
  }
});

describe('positive: each adapter reaches confirmed on a real DOM', { skip: SKIP }, () => {
  test('Greenhouse: fills, uploads, passes the gate, clicks once, confirmed by new sent text', async () => {
    const app = await seedApp();
    const page = await openPage('/acme/jobs/123/gh-form.html');
    const cap = capFor(page, app.id);
    const r = await greenhouse.run(cap, ctxFor(app, cap));
    assert.equal(r.outcome, 'submitted', JSON.stringify(r));
    assert.equal(await clicksOf(page), 1);
    assert.equal(await hasSubmitRequestSentEver(db, app.id), true);
    const ev = await listApplicationEvents(db, app.id);
    assert.equal(ev.filter((e) => e.note === 'submit_request_sent').length, 1);
    await page.close();
  });

  test('Lever: confirmed by the CURRENT URL changing to an anchored /thanks segment', async () => {
    const app = await seedApp({ ats: 'lever', applyUrl: 'https://jobs.lever.co/acme/1234/apply' });
    const page = await openPage('/acme/1234/apply/lever-form.html');
    const cap = capFor(page, app.id);
    const r = await lever.run(cap, ctxFor(app, cap));
    assert.equal(r.outcome, 'submitted', JSON.stringify(r));
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('iCIMS: confirmed by the sent text', async () => {
    const app = await seedApp({ ats: 'icims', applyUrl: 'https://careers-acme.icims.com/jobs/12345/job' });
    const page = await openPage('/jobs/12345/icims-form.html');
    const cap = capFor(page, app.id);
    const r = await icims.run(cap, ctxFor(app, cap));
    assert.equal(r.outcome, 'submitted', JSON.stringify(r));
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('Dayforce: the review step submits through the gate and confirms', async () => {
    const app = await seedApp({ ats: 'dayforce', applyUrl: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/1' });
    const page = await openPage('/CandidatePortal/dayforce-review.html');
    const cap = capFor(page, app.id);
    const r = await guarded(app, cap, { submitSelector: '[data-automation="submitButton"], button[data-automation="submit"]', scopeSelector: '[data-automation="wizardStep"], .candidate-portal-step, main[data-automation="applyWizard"]' });
    assert.equal(r.outcome, 'submitted', JSON.stringify(r));
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('Workday: after a verified Review page the scripted step clicks ONLY Submit (never Save and Continue Later) and confirms', async () => {
    const app = await seedApp({ ats: 'workday', state: 'approved', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Houston/CTO_R1' });
    const page = await openPage('/en-US/careers/job/Houston/CTO_R1/apply/wd-review.html');
    const cap = capFor(page, app.id);
    const r = await guarded(app, cap, {
      mode: 'workday', expectedResume: 'resume.docx', prefilledUnledgered: [],
      ledger: [{ question: 'City', value: 'Houston', kind: 'text', source: 'contact' }, { question: 'Phone Number', value: '(713) 555-0100', kind: 'text', source: 'contact' }],
    });
    assert.equal(r.outcome, 'submitted', JSON.stringify(r));
    assert.deepEqual(await clicksOf(page), ['pageFooterNextButton']);
    await page.close();
  });

  test('the worker path: runApplyWorker -> Greenhouse adapter -> ctx.submit -> submitted', async () => {
    const app = await seedApp({ state: 'approved' });
    const page = await context.newPage();
    const proxied = new Proxy(page, {
      get(t, k) {
        if (k === 'goto') return () => t.goto(`${chrome.baseUrl}/acme/jobs/123/gh-form.html`);
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const result = await runApplyWorker(app.id, workerDeps(proxied, configOn()));
    assert.equal(result.status, 'submitted');
    assert.equal((await getApplication(db, app.id)).state, 'submitted');
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });
});

/**
 * @param {any} page the (proxied) page the fake session hands the worker
 * @param {any} freshConfig what the click-time config read returns
 */
function workerDeps(page, freshConfig) {
  return {
    config: loadConfig(),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connectDedicated: async () => { const c = new pg.Client(pgConnectionConfig()); await c.connect(); return c; },
    connectSession: async () => ({
      attachPage: async () => page, reconcile: async () => 0, reconcileTargets: async () => ({ attempted: 0, closed: 0 }),
      writeTargetMarker: async () => {}, closeAll: async () => {}, openPages: () => 1,
    }),
    log: () => {}, progress: () => {}, outputRoot,
    answerBank: { facts: new Map([['email', { value: 'jordan@example.com' }], ['full_name', { value: 'Jordan Reyes' }], ['phone', { value: '555-0100' }]]), meta: {}, sections: new Map() },
    targetMarkerFile: path.join(outputRoot, 'target-marker.json'),
    preSubmitExclusionRecheck: async (/** @type {any} */ client, /** @type {any} */ a) => {
      await transition(client, a.id, 'submitting', { actor: 'apply', note: 'worker started' });
      return { branch: 'eligible', reason: 'test', evidence: {} };
    },
    loadFreshConfig: () => freshConfig,
    clickTimeExclusionCheck: async () => ({ branch: 'eligible' }),
    submitTiming: { pollMs: 40, maxPolls: 20, settleMs: 250 },
  };
}

describe('negative: each parks with no click and no marker', { skip: SKIP }, () => {
  /**
   * Fill the Greenhouse fixture through the real adapter, then assert the gate parked.
   * @param {Record<string, any>} extra runGuardedSubmit overrides
   * @param {string} reason expected gate reason
   * @param {string} [fixture]
   */
  async function expectPark(extra, reason, fixture = 'gh-form.html') {
    const app = await seedApp();
    const page = await openPage(`/acme/jobs/123/${fixture}`);
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await greenhouse.run(cap, ctxFor(app, cap, extra)));
    assert.equal(r.outcome, 'needs_human', JSON.stringify(r));
    assert.equal(r.pendingQuestion.kind, 'submit_gate');
    assert.equal(r.pendingQuestion.gate_reason, reason, JSON.stringify(r.pendingQuestion));
    assert.equal(await clicksOf(page), 0);
    assert.equal(await hasSubmitRequestSentEver(db, app.id), false);
    await page.close();
    return r;
  }

  test('the kill switch off', () => expectPark({ loadConfig: () => configOn({ enabled: false }) }, 'kill_switch'));
  test('this ATS switched off', () => expectPark({ loadConfig: () => configOn({ ats: { greenhouse: false } }) }, 'ats_disabled'));
  test('this ATS not in atsAllow', () => expectPark({ loadConfig: () => configOn({ atsAllow: ['lever'] }) }, 'ats_not_allowed'));
  test('a hash drift (the linked resume changed on disk)', () => expectPark({ resumeHash: () => 'f'.repeat(64) }, 'resume_hash_mismatch'));
  test('an excluded company at click time', () => expectPark({ exclusionCheck: async () => ({ branch: 'blocked_company', reason: 'blocked company' }) }, 'exclusion'));
  test('a config file that cannot be read at click time', () => expectPark({ loadConfig: () => { throw new Error('bad json'); } }, 'unrecognized_state'));
  test('an unchecked consent checkbox', () => expectPark({}, 'audit_failed', 'gh-consent.html'));

  test('the cap exhausted (the DB submit count at click time)', async () => {
    const used = await submitMarkersToday(db);
    const other = await seedApp();
    await reserveSubmitMarker(db, { applicationId: other.id, dailyCap: 1000 });
    await expectPark({ loadConfig: () => configOn({ cap: used + 1 }) }, 'cap_exhausted');
  });

  test('a missing required answer (email left empty)', async () => {
    const app = await seedApp();
    const page = await openPage('/acme/jobs/123/gh-form.html');
    const cap = capFor(page, app.id);
    await cap.fill('#first_name', 'Jordan');
    await cap.fill('#last_name', 'Reyes');
    await cap.upload('#resume_upload_input', 'resumes/resume.docx');
    const r = /** @type {any} */ (await guarded(app, cap, {
      submitSelector: '#submit_app, button[type="submit"]', scopeSelector: '#application_form',
      ledger: [
        { key: 'first_name', selector: '#first_name', label: 'First name', value: 'Jordan', source: 'contact', controlType: 'text' },
        { key: 'last_name', selector: '#last_name', label: 'Last name', value: 'Reyes', source: 'contact', controlType: 'text' },
        { key: 'resume', selector: '#resume_upload_input', label: 'Resume', value: 'resume.docx', source: 'document', controlType: 'file' },
      ],
    }));
    assert.equal(r.pendingQuestion.gate_reason, 'audit_failed');
    assert.match(r.pendingQuestion.gate_detail, /required_empty:Email/);
    assert.equal(await clicksOf(page), 0);
    await page.close();
  });

  test('an unrecognized review page (the form is not there)', async () => {
    const app = await seedApp();
    const page = await openPage('/acme/jobs/123/dayforce-review.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await guarded(app, cap, { submitSelector: '#submit_app, button[type="submit"]', scopeSelector: '#application_form' }));
    assert.equal(r.pendingQuestion.gate_reason, 'review_unverified');
    assert.equal(await clicksOf(page), 0);
    await page.close();
  });

  test('two submit controls on the form', async () => {
    const app = await seedApp({ ats: 'icims', applyUrl: 'https://careers-acme.icims.com/jobs/12345/job' });
    const page = await openPage('/jobs/12345/icims-two-submit.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await icims.run(cap, ctxFor(app, cap)));
    assert.equal(r.pendingQuestion.gate_reason, 'review_unverified');
    assert.match(r.pendingQuestion.gate_detail, /submit_controls_2/);
    assert.equal(await clicksOf(page), 0);
    await page.close();
  });

  test('Workday: an unchecked certify checkbox on Review parks', async () => {
    const app = await seedApp({ ats: 'workday', state: 'approved', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Houston/CTO_R1' });
    const page = await openPage('/x/wd-review-consent.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await guarded(app, cap, { mode: 'workday', expectedResume: 'resume.docx', prefilledUnledgered: [], ledger: [{ question: 'City', value: 'Houston', kind: 'text', source: 'contact' }] }));
    assert.equal(r.pendingQuestion.gate_reason, 'review_unverified');
    assert.equal(r.pendingQuestion.gate_detail, 'consent_unchecked');
    assert.deepEqual(await clicksOf(page), []);
    await page.close();
  });

  test('Workday: a step other than Review (Save and Continue Later and Submit both shown) parks', async () => {
    const app = await seedApp({ ats: 'workday', state: 'approved', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Houston/CTO_R1' });
    const page = await openPage('/x/wd-not-review.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await guarded(app, cap, { mode: 'workday', expectedResume: 'resume.docx', prefilledUnledgered: [], ledger: [] }));
    assert.equal(r.pendingQuestion.gate_reason, 'review_unverified');
    assert.match(r.pendingQuestion.gate_detail, /^step_/);
    assert.deepEqual(await clicksOf(page), []);
    await page.close();
  });

  test('Workday: prefilled answers nobody ledgered park', async () => {
    const app = await seedApp({ ats: 'workday', state: 'approved', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Houston/CTO_R1' });
    const page = await openPage('/x/wd-review.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await guarded(app, cap, { mode: 'workday', expectedResume: 'resume.docx', prefilledUnledgered: ['Phone Extension'], ledger: [{ question: 'City', value: 'Houston', kind: 'text', source: 'contact' }] }));
    assert.equal(r.pendingQuestion.gate_reason, 'prefilled_unledgered');
    assert.deepEqual(await clicksOf(page), []);
    await page.close();
  });

  test('the worker path with the kill switch off: needs_human submit_gate, no click', async () => {
    const app = await seedApp({ state: 'approved' });
    const page = await context.newPage();
    const proxied = new Proxy(page, {
      get(t, k) {
        if (k === 'goto') return () => t.goto(`${chrome.baseUrl}/acme/jobs/123/gh-form.html`);
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const result = await runApplyWorker(app.id, workerDeps(proxied, configOn({ enabled: false })));
    assert.equal(result.status, 'needs_human');
    const row = await getApplication(db, app.id);
    assert.equal(row.pending_question.kind, 'submit_gate');
    assert.equal(row.pending_question.gate_reason, 'kill_switch');
    assert.equal(await clicksOf(page), 0);
    await page.close();
  });
});

describe('adversarial confirmation cases', { skip: SKIP }, () => {
  test('a pre-existing "thank you" heading never confirms: clicked, submit_unconfirmed', async () => {
    const app = await seedApp();
    const page = await openPage('/acme/jobs/123/gh-prethanks.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await greenhouse.run(cap, ctxFor(app, cap)));
    assert.equal(r.outcome, 'needs_human');
    assert.equal(r.pendingQuestion.kind, 'submit_unconfirmed');
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('a stale apply URL that already contains /thanks never confirms', async () => {
    const app = await seedApp({ ats: 'lever', applyUrl: 'https://jobs.lever.co/acme/1234/thanks' });
    const page = await openPage('/acme/1234/thanks/lever-stale.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await lever.run(cap, ctxFor(app, cap)));
    assert.equal(r.pendingQuestion.kind, 'submit_unconfirmed');
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('a toast then an error is submit_error (never retried)', async () => {
    const app = await seedApp({ ats: 'smartrecruiters', applyUrl: 'https://jobs.smartrecruiters.com/Acme/1234-cto' });
    const page = await openPage('/Acme/1234-cto/sr-toast-error.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await smartrecruiters.run(cap, ctxFor(app, cap)));
    assert.equal(r.pendingQuestion.kind, 'submit_error', JSON.stringify(r));
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });

  test('a confirmation only inside an iframe is submit_unconfirmed', async () => {
    const app = await seedApp({ ats: 'icims', applyUrl: 'https://careers-acme.icims.com/jobs/12345/job' });
    const page = await openPage('/jobs/12345/icims-iframe.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await icims.run(cap, ctxFor(app, cap)));
    assert.equal(r.pendingQuestion.kind, 'submit_unconfirmed');
    assert.equal(await clicksOf(page), 1);
    await page.close();
  });
});

describe('idempotency: one click, ever', { skip: SKIP }, () => {
  test('two workers on the same application give exactly one click', async () => {
    const app = await seedApp();
    const second = new pg.Client(pgConnectionConfig());
    await second.connect();
    try {
      const pageA = await openPage('/acme/jobs/123/gh-form.html');
      const pageB = await openPage('/acme/jobs/123/gh-form.html');
      const capA = capFor(pageA, app.id);
      const capB = capFor(pageB, app.id);
      const ctxA = ctxFor(app, capA);
      const ctxB = { ...ctxFor(app, capB), submit: (/** @type {any} */ o) => runGuardedSubmit({ client: second, app, cap: capB, mode: 'form', ledger: [], loadConfig: () => configOn(), exclusionCheck: async () => ({ branch: 'eligible' }), resumeHash: () => resumeHash, sleep, log: () => {}, pollMs: 40, maxPolls: 20, settleMs: 250, ...o }) };
      const [ra, rb] = await Promise.all([greenhouse.run(capA, ctxA), greenhouse.run(capB, ctxB)]);
      const total = Number(await clicksOf(pageA)) + Number(await clicksOf(pageB));
      assert.equal(total, 1, `${JSON.stringify(ra)} ${JSON.stringify(rb)}`);
      const outcomes = [ra.outcome, rb.outcome].sort();
      assert.deepEqual(outcomes, ['needs_human', 'submitted']);
      const parked = /** @type {any} */ (ra.outcome === 'needs_human' ? ra : rb);
      assert.ok(['application_locked', 'marker_exists'].includes(parked.pendingQuestion.gate_reason), JSON.stringify(parked));
      const ev = await listApplicationEvents(db, app.id);
      assert.equal(ev.filter((e) => e.note === 'submit_request_sent').length, 1);
      await pageA.close();
      await pageB.close();
    } finally {
      await second.end();
    }
  });

  test('a crash after the marker: reconcileStale gives submit_unconfirmed, and nothing ever clicks again', async () => {
    const app = await seedApp();
    const reserved = await reserveSubmitMarker(db, { applicationId: app.id, dailyCap: 1000 });
    assert.equal(reserved.ok, true);
    await db.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [app.id]);
    await reconcileStale(db, { maxAgeMinutes: 10 });
    const row = await getApplication(db, app.id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'submit_unconfirmed');
    // Resume, Retry-style re-arm, and "I applied by hand" are all refused.
    const resumed = await resumeParkedApplication(db, app.id, { config: { autoApply: {} } });
    assert.equal(resumed.outcome, 'refused');
    await assert.rejects(() => transition(db, app.id, 'approved', { actor: 'dashboard' }), /never re-armed/);
    await assert.rejects(() => markAppliedByHand(db, app.id, { actor: 'dashboard' }), /Already submitted \(unconfirmed\)/);
    // Even a direct second run of the gate never clicks.
    await db.query(`UPDATE ic_job_applications SET state = 'submitting' WHERE id = $1`, [app.id]);
    const page = await openPage('/acme/jobs/123/gh-form.html');
    const cap = capFor(page, app.id);
    const r = /** @type {any} */ (await greenhouse.run(cap, ctxFor(app, cap)));
    assert.equal(r.pendingQuestion.gate_reason, 'marker_exists');
    assert.equal(await clicksOf(page), 0);
    await page.close();
  });
});

describe('click-time exclusion check (D4, C11)', () => {
  const exclusionConfig = () => loadExclusionConfig(loadConfig().configDir);

  test('uses the same dedup-root lock namespace as the claim-time recheck', () => {
    assert.equal(EXCLUSION_LOCK_NAMESPACE, WORKER_EXCLUSION_NS);
  });

  test("the application's own row never counts against itself", async () => {
    const app = await seedApp();
    const v = await clickTimeExclusionCheck(db, app, exclusionConfig());
    assert.equal(v.branch, 'eligible', JSON.stringify(v));
  });

  test('a built-in blocked company parks at click time', async () => {
    const app = await seedApp({ company: 'Immunotec' });
    const v = await clickTimeExclusionCheck(db, app, exclusionConfig());
    assert.equal(v.branch, 'blocked_company');
  });

  test('a duplicate listing that was already applied to parks (already_applied_listing)', async () => {
    const first = await seedApp({ state: 'submitted' });
    const dup = await seedApp({ duplicateOf: first.listing_id });
    const v = await clickTimeExclusionCheck(db, dup, exclusionConfig());
    assert.equal(v.branch, 'already_applied_listing');
  });

  test('the same company with a similar title parks', async () => {
    const company = `${CO}-samerole-${crypto.randomBytes(4).toString('hex')}`;
    await seedApp({ company, title: 'Chief Technology Officer', state: 'submitted' });
    const second = await seedApp({ company, title: 'Chief Technology Officer (CTO)' });
    const v = await clickTimeExclusionCheck(db, second, exclusionConfig());
    assert.notEqual(v.branch, 'eligible', JSON.stringify(v));
  });
});
