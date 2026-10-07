// @ts-check
/**
 * Resume gate (POST /api/applications/:id/resume, src/apply/resume-gate.js) and the durable A10 marker
 * (src/core/applications.js hasAssistedNextClickEver). Covers the total classification by
 * pending_question.kind (every named kind plus unknown ones), the submit_request_sent refusal for each
 * allowed kind, the lock-time recheck, the per-ATS breaker, in-flight slot and daily budget, a closed
 * listing, the partial-draft acknowledgment, R2 (POST /api/credentials kind and target match), the
 * automatic resume refusal, and reconcileStale with a Next click from an earlier attempt. Real isolated
 * test DB, fake runners; never a real application row.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';
import {
  createApplication, getApplication, listApplicationEvents, recordAssistedNextClick, recordSubmitRequestSent,
  hasAssistedNextClickThisAttempt, hasAssistedNextClickEver, reconcileStale, transition, resumeAutomatic,
  PARTIAL_DRAFT_WARNING,
} from '../src/core/applications.js';
import {
  classifyResume, resumeParkedApplication, resumeForCredential, RESUME_APPROVE_KINDS, RESUME_REFUSAL_REASONS,
  RESUME_RUNNER_FAILURE_REASONS, RESUME_RUNNER_PARK_LABELS, isResumeRunnerPark, humanizeParkReason, resumeEligible,
} from '../src/apply/resume-gate.js';
import { issueLease } from '../src/core/easy-apply-state.js';

const CO = `ZZ-TEST-RESUMEGATE-${process.pid}`;
/** @type {pg.Client} */
let c;
/** @type {any} */
let app;
/** @type {number} */
let port;
/** @type {number[]} */
const listingIds = [];
/** @type {number[]} */
const started = [];
/** @type {Map<string, {username:string,password:string}>} */
const credStore = new Map();

/** Config with budgets nobody can exhaust, so only the budget test decides budget_exhausted. */
const ROOMY = {
  autoApply: { workday: { assistedDaily: 1_000_000 }, linkedin: { easyApplyDaily: 1_000_000 } },
  adapters: { adapters: { linkedin: { dailyPages: 1_000_000, dailyDetails: 1_000_000 } } },
};

/** @param {{ status?: string|null }} [o] */
async function seedListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await c.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ('Resume Gate Test', $1, 'linkedin', $2, 'listing', $3, 'resume gate test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-resumegate-${process.pid}:${n}`, `resume gate co ${n}`, `zz-resumegate-hash-${n}`, o.status ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/**
 * @param {string} state
 * @param {any} pq
 * @param {{ ats?: string, doc?: boolean, listingStatus?: string|null, error?: string|null }} [o]
 */
async function seed(state, pq, o = {}) {
  const listingId = await seedListing({ status: o.listingStatus ?? null });
  const a = await createApplication(c, { listingId, atsType: o.ats ?? 'greenhouse', applyUrl: `https://example.test/${listingId}`, actor: 'mcp' });
  let docId = null;
  if (o.doc !== false) {
    const d = await c.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`, [listingId, `resumes/rg-${listingId}.docx`]);
    docId = Number(d.rows[0].id);
  }
  await c.query('UPDATE ic_job_applications SET state = $2, pending_question = $3::jsonb, resume_doc_id = $4, error = $5 WHERE id = $1', [a.id, state, pq ? JSON.stringify(pq) : null, docId, o.error ?? null]);
  return Number(a.id);
}

/** A submitting-then-submit_request_sent history, so hasSubmitRequestSentThisAttempt is true. */
async function markSubmitSent(/** @type {number} */ id) {
  await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor) VALUES ($1, 'state', 'approved', 'submitting', 'apply')`, [id]);
  await recordSubmitRequestSent(c, id);
}

async function cleanup() {
  await c.query('DELETE FROM ic_easy_apply_leases WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await c.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await c.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  c = new pg.Client(pgConnectionConfig());
  await c.connect();
  await ensureAuxSchema(c);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resumegate-out-'));
  const config = loadConfig();
  app = createDashboardServer(/** @type {any} */ ({
    withClient,
    config: { ...config, autoApply: { ...config.autoApply, ...ROOMY.autoApply }, adapters: { ...config.adapters, adapters: { ...config.adapters.adapters, ...ROOMY.adapters.adapters } } },
    env: { OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', GOOGLE_TOKEN_FILE: '', REMINDER_TO: '', SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null, JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: null },
    calendar: async () => null, calendarCache: createCalendarCache(),
    scanRunner: { async start() { return { runId: 1, pid: 1 }; }, status() { return { running: false }; }, armCancelBackstop() { return { forced_kill_available: false }; } },
    applyRunner: {
      async start(/** @type {number} */ id) { started.push(id); return { applicationId: id, pid: 1 }; },
      status() { return { running: false, applicationId: null, pid: null, startedAt: null }; },
      armCancelBackstop() { return { forced_kill_available: false }; },
    },
    credentials: {
      read: async (/** @type {string} */ t) => credStore.get(t) ?? null,
      write: async (/** @type {string} */ t, /** @type {string} */ u, /** @type {string} */ p) => { credStore.set(t, { username: u, password: p }); },
      delete: async () => false, list: async () => [],
    },
    outputRoot, version: 'test', startedAt: new Date().toISOString(), healthBanner: [],
  }));
  await app.listen(0, '127.0.0.1');
  port = app.server.address().port;
});
after(async () => {
  await cleanup();
  await c.end();
  await app.close();
  await closePool();
});
beforeEach(async () => {
  await cleanup();
  started.length = 0;
  credStore.clear();
});

/** @param {string} p @param {unknown} [body] */
async function post(p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

const ctxOk = { submitRequestSent: false, leaseHeld: false, applyRunning: false, chainRunning: false, listingClosed: false, breakerTripped: false, slotBusy: false, budgetExhausted: false, partialDraft: false, acknowledgedPartialDraft: false };

describe('classifyResume(): total classification by pending_question.kind', () => {
  test('every named kind maps to its branch; unknown, blank, and missing kinds refuse unknown_kind', () => {
    /** @type {Record<string, string>} */
    const expected = {
      unrecognized_page: 'approve', captcha: 'approve', assisted_stopped: 'approve', assisted_partial: 'approve', email_verification: 'approve',
      // Unattended submit: a pre-click gate park resumes (nothing was clicked); a click without a seen
      // confirmation never does (spec v2 C11).
      submit_gate: 'approve', submit_unconfirmed: 'submit_unconfirmed', submit_error: 'submit_unconfirmed',
      resume_failed: 'redraft',
      question: 'use_answer', credential: 'use_credential_save', awaiting_submit: 'submit_or_abandon', post_submit_uncertain: 'may_be_submitted',
      blocked: 'blocked_not_resume_failure', abandoned_tab: 'unknown_kind', easy_apply_stopped: 'unknown_kind', zz_never_seen: 'unknown_kind', '': 'unknown_kind',
    };
    assert.deepEqual([...RESUME_APPROVE_KINDS].sort(), ['assisted_partial', 'assisted_stopped', 'captcha', 'email_verification', 'submit_gate', 'unrecognized_page']);
    for (const [kind, want] of Object.entries(expected)) {
      const out = classifyResume({ state: 'needs_human', pending_question: { kind, label: 'x' }, resume_doc_id: 1 }, ctxOk);
      const got = out.action === 'refuse' ? out.reason : out.action;
      assert.equal(got, want, `kind "${kind}"`);
      if (out.action === 'refuse') assert.ok(RESUME_REFUSAL_REASONS.includes(out.reason), out.reason);
    }
    for (const pq of [null, undefined, 'captcha', { label: 'no kind' }, { kind: 42 }, []]) {
      const out = classifyResume({ state: 'needs_human', pending_question: pq, resume_doc_id: 1 }, ctxOk);
      assert.equal(out.action === 'refuse' && out.reason, 'unknown_kind', JSON.stringify(pq));
    }
  });

  test('a row not in needs_human is refused not_parked, whatever its kind', () => {
    for (const state of ['drafting', 'docs_ready', 'approved', 'submitting', 'submitted', 'confirmed', 'failed', 'withdrawn', 'zz']) {
      const out = classifyResume({ state, pending_question: { kind: 'captcha' }, resume_doc_id: 1 }, ctxOk);
      assert.equal(out.action === 'refuse' && out.reason, 'not_parked', state);
    }
  });

  test('submit_request_sent refuses every allowed kind, including resume_failed', () => {
    for (const kind of [...RESUME_APPROVE_KINDS, 'resume_failed']) {
      const out = classifyResume({ state: 'needs_human', pending_question: { kind }, resume_doc_id: 1 }, { ...ctxOk, submitRequestSent: true });
      assert.equal(out.action === 'refuse' && out.reason, 'submit_request_sent', kind);
    }
  });

  test('in-flight signals, closed listing, missing resume, breaker, slot, budget, and an unacknowledged partial draft each refuse', () => {
    const row = { state: 'needs_human', pending_question: { kind: 'captcha' }, resume_doc_id: 1 };
    /** @type {[Partial<typeof ctxOk>, string][]} */
    const cases = [
      [{ leaseHeld: true }, 'lease_held'], [{ applyRunning: true }, 'apply_running'], [{ chainRunning: true }, 'chain_running'],
      [{ listingClosed: true }, 'listing_closed'], [{ breakerTripped: true }, 'breaker_tripped'], [{ slotBusy: true }, 'slot_busy'],
      [{ budgetExhausted: true }, 'budget_exhausted'], [{ partialDraft: true }, 'partial_draft_ack_required'],
    ];
    for (const [patch, reason] of cases) {
      const out = classifyResume(row, { ...ctxOk, ...patch });
      assert.equal(out.action === 'refuse' && out.reason, reason, reason);
    }
    const noDoc = classifyResume({ ...row, resume_doc_id: null }, ctxOk);
    assert.equal(noDoc.action === 'refuse' && noDoc.reason, 'no_resume_doc');
    assert.equal(classifyResume(row, { ...ctxOk, partialDraft: true, acknowledgedPartialDraft: true }).action, 'approve');
    // resume_failed goes back to drafting: no resume needed yet, and breaker/slot/budget do not apply.
    const redraft = classifyResume({ state: 'needs_human', pending_question: { kind: 'resume_failed' }, resume_doc_id: null }, { ...ctxOk, breakerTripped: true, slotBusy: true, budgetExhausted: true });
    assert.equal(redraft.action, 'redraft');
  });
});

describe('resumeParkedApplication(): the DB-backed gate', () => {
  test('an allowed kind moves needs_human -> approved with attempt+1 and an event naming the prior kind', async () => {
    const id = await seed('needs_human', { kind: 'unrecognized_page', label: 'Unrecognized page' });
    const out = await resumeParkedApplication(c, id, { config: ROOMY });
    assert.equal(out.outcome, 'approved');
    const row = await getApplication(c, id);
    assert.equal(row.state, 'approved');
    assert.equal(row.attempt, 1);
    assert.equal(row.pending_question, null);
    const ev = (await listApplicationEvents(c, id)).filter((e) => e.to_state === 'approved');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor, 'dashboard');
    assert.match(ev[0].note, /resumed from dashboard/);
    assert.match(ev[0].note, /unrecognized_page/);
    assert.equal(ev[0].meta.prior_kind, 'unrecognized_page');
  });

  test('resume_failed moves to drafting, not approved, and leaves attempt alone', async () => {
    const id = await seed('needs_human', { kind: 'resume_failed', label: 'Resume drafting failed: timeout' }, { doc: false });
    const out = await resumeParkedApplication(c, id, { config: ROOMY });
    assert.equal(out.outcome, 'drafting');
    const row = await getApplication(c, id);
    assert.equal(row.state, 'drafting');
    assert.equal(row.attempt, 0);
  });

  test('an approve kind with no linked resume is refused no_resume_doc', async () => {
    const id = await seed('needs_human', { kind: 'captcha', label: 'captcha' }, { doc: false });
    const out = await resumeParkedApplication(c, id, { config: ROOMY });
    assert.equal(out.outcome, 'refused');
    assert.equal(out.reason, 'no_resume_doc');
    assert.equal((await getApplication(c, id)).state, 'needs_human');
  });

  test('submit_request_sent this attempt refuses each allowed kind and never transitions', async () => {
    for (const kind of [...RESUME_APPROVE_KINDS, 'resume_failed']) {
      const id = await seed('needs_human', { kind, label: kind });
      await markSubmitSent(id);
      const out = await resumeParkedApplication(c, id, { config: ROOMY });
      assert.equal(out.outcome === 'refused' && out.reason, 'submit_request_sent', kind);
      assert.equal((await getApplication(c, id)).state, 'needs_human', kind);
    }
  });

  test('an open lease, the apply runner, and an Apply now chain each refuse', async () => {
    const id = await seed('needs_human', { kind: 'captcha', label: 'captcha' });
    assert.equal((await resumeParkedApplication(c, id, { config: ROOMY, applyRunning: true })).reason, 'apply_running');
    assert.equal((await resumeParkedApplication(c, id, { config: ROOMY, chainRunning: true })).reason, 'chain_running');
    await issueLease(c, { applicationId: id, trigger: 'dashboard', targetId: 'T1', ttlMs: 600000, ats: 'linkedin_easy' });
    assert.equal((await resumeParkedApplication(c, id, { config: ROOMY })).reason, 'lease_held');
  });

  test('a closed listing (every status in the closed group) refuses listing_closed', async () => {
    for (const status of ['accepted', 'passed', 'lost', 'skip', 'dead']) {
      const id = await seed('needs_human', { kind: 'captcha', label: 'captcha' }, { listingStatus: status });
      const out = await resumeParkedApplication(c, id, { config: ROOMY });
      assert.equal(out.outcome === 'refused' && out.reason, 'listing_closed', status);
    }
  });

  test('lock-time recheck: a kind change committed while the resume waits on the row lock is honored', async () => {
    const id = await seed('needs_human', { kind: 'captcha', label: 'captcha' });
    const locker = new pg.Client(pgConnectionConfig());
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM ic_job_applications WHERE id = $1 FOR UPDATE', [id]);
      const pending = withClient((cc) => resumeParkedApplication(cc, id, { config: ROOMY }));
      await new Promise((r) => { setTimeout(r, 300); });
      await locker.query(`UPDATE ic_job_applications SET pending_question = '{"kind":"question","label":"Salary?"}'::jsonb WHERE id = $1`, [id]);
      await locker.query('COMMIT');
      const out = await pending;
      assert.equal(out.outcome, 'refused');
      assert.equal(out.reason, 'use_answer');
    } finally {
      await locker.end();
    }
    assert.equal((await getApplication(c, id)).state, 'needs_human');
  });

  describe('per-ATS breaker, in-flight slot, and daily budget (assisted ATS only)', () => {
    /** @type {any} */
    let savedBreaker = null;
    before(async () => {
      const r = await c.query(`SELECT tripped_until, tripped_at, reason, application_id FROM ic_easy_apply_breaker WHERE ats = 'workday'`);
      savedBreaker = r.rows[0] ?? null;
    });
    after(async () => {
      await c.query(`DELETE FROM ic_easy_apply_breaker WHERE ats = 'workday'`);
      if (savedBreaker) {
        await c.query(`INSERT INTO ic_easy_apply_breaker (ats, tripped_until, tripped_at, reason, application_id) VALUES ('workday', $1, $2, $3, $4)`,
          [savedBreaker.tripped_until, savedBreaker.tripped_at, savedBreaker.reason, savedBreaker.application_id]);
      }
    });
    beforeEach(async () => { await c.query(`DELETE FROM ic_easy_apply_breaker WHERE ats = 'workday'`); });

    test('a tripped Workday breaker refuses breaker_tripped; a greenhouse row ignores breakers', async () => {
      await c.query(`INSERT INTO ic_easy_apply_breaker (ats, tripped_until, tripped_at, reason) VALUES ('workday', now() + interval '2 hours', now(), 'test')`);
      const wd = await seed('needs_human', { kind: 'unrecognized_page', label: 'x' }, { ats: 'workday' });
      assert.equal((await resumeParkedApplication(c, wd, { config: ROOMY })).reason, 'breaker_tripped');
      const gh = await seed('needs_human', { kind: 'unrecognized_page', label: 'x' }, { ats: 'greenhouse' });
      assert.equal((await resumeParkedApplication(c, gh, { config: ROOMY })).outcome, 'approved');
    });

    test('another Workday application holding the in-flight slot refuses slot_busy', async () => {
      const busy = await seed('submitting', null, { ats: 'workday' });
      assert.ok(busy);
      const wd = await seed('needs_human', { kind: 'unrecognized_page', label: 'x' }, { ats: 'workday' });
      const out = await resumeParkedApplication(c, wd, { config: ROOMY });
      assert.equal(out.reason, 'slot_busy');
    });

    test('an exhausted Workday daily budget refuses budget_exhausted; a roomy one approves', async () => {
      const wd = await seed('needs_human', { kind: 'unrecognized_page', label: 'x' }, { ats: 'workday' });
      const out = await resumeParkedApplication(c, wd, { config: { ...ROOMY, autoApply: { ...ROOMY.autoApply, workday: { assistedDaily: 0 } } } });
      assert.equal(out.reason, 'budget_exhausted');
      assert.equal((await resumeParkedApplication(c, wd, { config: ROOMY })).outcome, 'approved');
    });

    test('an exhausted LinkedIn Easy Apply cap refuses budget_exhausted', async () => {
      const li = await seed('needs_human', { kind: 'assisted_stopped', label: 'x' }, { ats: 'linkedin_easy' });
      const out = await resumeParkedApplication(c, li, { config: { ...ROOMY, autoApply: { ...ROOMY.autoApply, linkedin: { easyApplyDaily: 0 } } } });
      assert.equal(out.reason, 'budget_exhausted');
    });
  });
});

describe('D2: resuming a legacy blocked resume-runner park', () => {
  /** @param {unknown} error @param {unknown} label @param {string} [kind] */
  const blockedRow = (error, label, kind = 'blocked') => ({ state: 'needs_human', error, pending_question: { kind, label }, resume_doc_id: null });
  /** @param {any} row */
  const verdictOf = (row) => {
    const out = classifyResume(row, ctxOk);
    return out.action === 'refuse' ? out.reason : out.action;
  };

  test('positive: docx_exists with the generic label redrafts', () => {
    assert.equal(verdictOf(blockedRow('docx_exists', 'Resume drafting stopped: docx_exists')), 'redraft');
  });

  test('positive: the prefixed error form ("resume runner failed: <reason>") redrafts', () => {
    assert.equal(verdictOf(blockedRow('resume runner failed: docx_exists', 'Resume drafting stopped: docx_exists')), 'redraft');
  });

  test('positive: every member of the set redrafts with its frozen label and with the generic label', () => {
    for (const reason of RESUME_RUNNER_FAILURE_REASONS) {
      assert.equal(verdictOf(blockedRow(reason, humanizeParkReason(reason))), 'redraft', `${reason} (humanized label)`);
      assert.equal(verdictOf(blockedRow(reason, `Resume drafting stopped: ${reason}`)), 'redraft', `${reason} (generic label)`);
    }
  });

  test('drift: the set covers every frozen label, holds the named extras, and every refusal reason has a message', () => {
    for (const reason of Object.keys(RESUME_RUNNER_PARK_LABELS)) {
      assert.ok(RESUME_RUNNER_FAILURE_REASONS.includes(reason), `set is missing frozen-label reason ${reason}`);
      assert.equal(humanizeParkReason(reason), RESUME_RUNNER_PARK_LABELS[reason]);
    }
    for (const r of ['no_description', 'timeout', 'spawn_failed', 'listing_mismatch', 'model_asked', 'no_docs_ready', 'markdown_not_found',
      'runner_unavailable', 'docx_exists', 'docx_locked', 'role_inclusion_conflict', 'resume_runner_busy', 'chain_error']) {
      assert.ok(RESUME_RUNNER_FAILURE_REASONS.includes(r), r);
    }
    assert.ok(Object.isFrozen(RESUME_RUNNER_FAILURE_REASONS));
    assert.ok(Object.isFrozen(RESUME_RUNNER_PARK_LABELS));
    assert.ok(RESUME_REFUSAL_REASONS.includes('blocked_not_resume_failure'));
    const refused = classifyResume(blockedRow('zz_unknown', 'Resume drafting stopped: zz_unknown'), ctxOk);
    assert.ok(refused.action === 'refuse' && /resume/i.test(refused.message));
  });

  test('negative: an apply_exclusion park is refused even with a matching error and label', () => {
    assert.equal(verdictOf(blockedRow('docx_exists', 'Resume drafting stopped: docx_exists', 'apply_exclusion')), 'unknown_kind');
  });

  test('negative: blocked with no error, a non-string error, or an unknown reason is refused blocked_not_resume_failure', () => {
    assert.equal(verdictOf(blockedRow(null, 'Resume drafting stopped: docx_exists')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow(undefined, 'Resume drafting stopped: docx_exists')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('', 'Resume drafting stopped: ')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow(42, 'Resume drafting stopped: 42')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('zz_unknown', 'Resume drafting stopped: zz_unknown')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('unknown', 'Resume drafting stopped: unknown')), 'blocked_not_resume_failure');
  });

  test('adversarial: a set reason with a label that does not match is refused', () => {
    assert.equal(verdictOf(blockedRow('docx_exists', 'company is missing from the listing')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('docx_exists', null)), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('docx_exists', '')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('docx_exists', 'Resume drafting stopped: docx_locked')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('docx_exists', 'Resume drafting stopped: docx_exists; please check')), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('timeout', RESUME_RUNNER_PARK_LABELS.no_description)), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow('docx_exists', 'Resume drafting failed: docx_exists')), 'blocked_not_resume_failure');
  });

  test('adversarial: an exclusion-shaped error with its own default label is refused', () => {
    const err = 'company is missing from the listing';
    assert.equal(verdictOf(blockedRow(err, humanizeParkReason(err))), 'blocked_not_resume_failure');
    assert.equal(verdictOf(blockedRow(`resume runner failed: ${err}`, humanizeParkReason(err))), 'blocked_not_resume_failure');
  });

  test('adversarial: near-miss reasons are refused (suffix, prefix, embedded, double prefix)', () => {
    for (const e of ['docx_exists_extra', 'xdocx_exists', 'docx exists', 'docx_exists, timeout', 'resume runner failed: resume runner failed: docx_exists']) {
      assert.equal(verdictOf(blockedRow(e, `Resume drafting stopped: ${e}`)), 'blocked_not_resume_failure', e);
    }
  });

  test('adversarial: mixed-case or padded reasons are normalized and redraft', () => {
    assert.equal(verdictOf(blockedRow('  DOCX_EXISTS ', 'Resume drafting stopped: DOCX_EXISTS')), 'redraft');
    assert.equal(verdictOf(blockedRow('Resume Runner Failed: Docx_Locked', 'Resume drafting stopped: docx_locked')), 'redraft');
    assert.equal(verdictOf(blockedRow('timeout\n', `  ${RESUME_RUNNER_PARK_LABELS.timeout}  `)), 'redraft');
  });

  test('isResumeRunnerPark is false for any non-blocked kind and for malformed rows', () => {
    assert.equal(isResumeRunnerPark(null), false);
    assert.equal(isResumeRunnerPark({}), false);
    assert.equal(isResumeRunnerPark({ error: 'docx_exists', pending_question: null }), false);
    assert.equal(isResumeRunnerPark({ error: 'docx_exists', pending_question: [] }), false);
    for (const kind of ['resume_failed', 'apply_exclusion', 'question', 'Blocked', ' blocked']) {
      assert.equal(isResumeRunnerPark({ error: 'docx_exists', pending_question: { kind, label: 'Resume drafting stopped: docx_exists' } }), false, kind);
    }
  });

  test('a matching legacy park still honors the in-flight and submit_request_sent refusals', () => {
    const row = blockedRow('docx_exists', 'Resume drafting stopped: docx_exists');
    assert.equal(classifyResume(row, { ...ctxOk, chainRunning: true }).action === 'refuse' && classifyResume(row, { ...ctxOk, chainRunning: true }).reason, 'chain_running');
    const sent = classifyResume(row, { ...ctxOk, submitRequestSent: true });
    assert.equal(sent.action === 'refuse' && sent.reason, 'submit_request_sent');
  });

  test('resumeEligible mirrors the gate kinds and the legacy park rule', () => {
    assert.equal(resumeEligible({ state: 'needs_human', pending_question: { kind: 'captcha' } }), true);
    assert.equal(resumeEligible({ state: 'needs_human', pending_question: { kind: 'resume_failed' } }), true);
    assert.equal(resumeEligible(blockedRow('docx_exists', 'Resume drafting stopped: docx_exists')), true);
    assert.equal(resumeEligible(blockedRow('zz', 'Resume drafting stopped: zz')), false);
    assert.equal(resumeEligible({ state: 'needs_human', pending_question: { kind: 'question', label: 'q' } }), false);
    assert.equal(resumeEligible({ state: 'docs_ready', pending_question: { kind: 'captcha' } }), false);
    assert.equal(resumeEligible(null), false);
  });

  test('DB: a legacy docx_exists park moves needs_human -> drafting under the lock', async () => {
    const id = await seed('needs_human', { kind: 'blocked', label: 'Resume drafting stopped: docx_exists' }, { doc: false, error: 'docx_exists' });
    const out = await resumeParkedApplication(c, id, { config: ROOMY });
    assert.equal(out.outcome, 'drafting');
    const row = await getApplication(c, id);
    assert.equal(row.state, 'drafting');
    assert.equal(row.pending_question, null);
    const ev = (await listApplicationEvents(c, id)).find((e) => e.to_state === 'drafting' && e.from_state === 'needs_human');
    assert.equal(ev.actor, 'dashboard');
    assert.equal(ev.meta.prior_kind, 'blocked');
  });

  test('DB: a blocked park with a mismatched label or unknown reason stays parked', async () => {
    const bad = await seed('needs_human', { kind: 'blocked', label: 'company is missing from the listing' }, { doc: false, error: 'docx_exists' });
    const out = await resumeParkedApplication(c, bad, { config: ROOMY });
    assert.equal(out.outcome === 'refused' && out.reason, 'blocked_not_resume_failure');
    assert.equal((await getApplication(c, bad)).state, 'needs_human');
    const excl = await seed('needs_human', { kind: 'apply_exclusion', label: 'Resume drafting stopped: docx_exists' }, { doc: false, error: 'docx_exists' });
    assert.equal((await resumeParkedApplication(c, excl, { config: ROOMY })).reason, 'unknown_kind');
    assert.equal((await getApplication(c, excl)).state, 'needs_human');
  });

  test('DB: an error column changed to an unknown reason while the resume waits on the lock is honored', async () => {
    const id = await seed('needs_human', { kind: 'blocked', label: 'Resume drafting stopped: docx_exists' }, { doc: false, error: 'docx_exists' });
    const locker = new pg.Client(pgConnectionConfig());
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM ic_job_applications WHERE id = $1 FOR UPDATE', [id]);
      const pending = withClient((cc) => resumeParkedApplication(cc, id, { config: ROOMY }));
      await new Promise((r) => { setTimeout(r, 300); });
      await locker.query(`UPDATE ic_job_applications SET error = 'company is missing from the listing' WHERE id = $1`, [id]);
      await locker.query('COMMIT');
      const out = await pending;
      assert.equal(out.outcome === 'refused' && out.reason, 'blocked_not_resume_failure');
    } finally {
      await locker.end();
    }
  });

  test('routes: Resume accepts a legacy park; list rows and the listing detail carry resume_eligible', async () => {
    const good = await seed('needs_human', { kind: 'blocked', label: 'Resume drafting stopped: docx_exists' }, { doc: false, error: 'docx_exists' });
    const bad = await seed('needs_human', { kind: 'blocked', label: 'Resume drafting stopped: zz_other' }, { doc: false, error: 'zz_other' });
    const list = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/api/applications?state=needs_human`)).json());
    assert.equal(list.rows.find((/** @type {any} */ r) => r.application_id === good).resume_eligible, true);
    assert.equal(list.rows.find((/** @type {any} */ r) => r.application_id === bad).resume_eligible, false);
    const goodListing = (await getApplication(c, good)).listing_id;
    const det = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/api/listings/${goodListing}`)).json());
    assert.equal(det.application.resume_eligible, true);

    const refused = await post(`/api/applications/${bad}/resume`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, 'blocked_not_resume_failure');
    const ok = await post(`/api/applications/${good}/resume`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.outcome, 'drafting');
    await new Promise((r) => { setTimeout(r, 50); });
    assert.deepEqual(started, []);
  });
});

describe('A10: the durable partial-draft marker', () => {
  test('a Next click persists across attempts and across a resume; this-attempt scoping alone would lose it', async () => {
    const id = await seed('needs_human', { kind: 'assisted_partial', label: 'x' }, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    await new Promise((r) => { setTimeout(r, 5); });
    await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor) VALUES ($1, 'state', 'approved', 'submitting', 'apply')`, [id]);
    assert.equal(await hasAssistedNextClickThisAttempt(c, id), false, 'the per-attempt helper resets');
    assert.equal(await hasAssistedNextClickEver(c, id), true, 'the durable marker does not');

    const refused = await resumeParkedApplication(c, id, { config: ROOMY });
    assert.equal(refused.reason, 'partial_draft_ack_required');
    const out = await resumeParkedApplication(c, id, { config: ROOMY, acknowledgePartialDraft: true });
    assert.equal(out.outcome, 'approved');
    assert.equal(out.warning, PARTIAL_DRAFT_WARNING);
    const ev = (await listApplicationEvents(c, id)).find((e) => e.to_state === 'approved');
    assert.equal(ev.meta.partial_draft, true);
    assert.equal(ev.meta.partial_draft_acknowledged, true);
    assert.match(ev.note, /partial draft/);

    await transition(c, id, 'submitting', { actor: 'apply' });
    await transition(c, id, 'needs_human', { actor: 'apply', pending_question: { kind: 'captcha', label: 'c' } });
    assert.equal(await hasAssistedNextClickEver(c, id), true, 'still set after leaving and re-entering needs_human');
  });

  test('resumeAutomatic refuses a marked application and resumes an unmarked one', async () => {
    const marked = await seed('needs_human', { kind: 'credential', target: 'ic-jobsearch/a.example', username: 'u' }, { ats: 'workday' });
    await recordAssistedNextClick(c, marked);
    await assert.rejects(resumeAutomatic(c, marked, { actor: 'apply', note: 'auto' }), (err) => /** @type {any} */ (err).details?.reason === 'requires_human_retry');
    assert.equal((await getApplication(c, marked)).state, 'needs_human');
    const plain = await seed('needs_human', { kind: 'credential', target: 'ic-jobsearch/a.example', username: 'u' });
    const row = await resumeAutomatic(c, plain, { actor: 'apply', note: 'auto' });
    assert.equal(row.state, 'approved');
  });

  test('reconcileStale parks a stale row whose Next click came on an EARLIER attempt (never failed)', async () => {
    const id = await seed('submitting', null, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    await new Promise((r) => { setTimeout(r, 5); });
    await c.query(`INSERT INTO ic_job_application_events (application_id, kind, from_state, to_state, actor) VALUES ($1, 'state', 'approved', 'submitting', 'apply')`, [id]);
    await c.query(`UPDATE ic_job_applications SET updated_at = now() - interval '25 minutes' WHERE id = $1`, [id]);
    await reconcileStale(c, { maxAgeMinutes: 10 });
    const row = await getApplication(c, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'assisted_partial');
  });
});

describe('R2: resumeForCredential matches kind and target', () => {
  test('kind mismatch and target mismatch do not resume; a match does', async () => {
    const q = await seed('needs_human', { kind: 'question', label: 'q' });
    assert.deepEqual((await resumeForCredential(c, q, 'ic-jobsearch/a.example', {})).resumed, false);
    assert.equal((await resumeForCredential(c, q, 'ic-jobsearch/a.example', {})).reason, 'kind_mismatch');
    const cr = await seed('needs_human', { kind: 'credential', target: 'ic-jobsearch/a.example', username: 'u' });
    const mis = await resumeForCredential(c, cr, 'ic-jobsearch/b.example', {});
    assert.equal(mis.resumed, false);
    assert.equal(mis.reason, 'target_mismatch');
    assert.equal((await getApplication(c, cr)).state, 'needs_human');
    const ok = await resumeForCredential(c, cr, 'ic-jobsearch/a.example', {});
    assert.equal(ok.resumed, true);
    assert.equal((await getApplication(c, cr)).state, 'approved');
  });
});

describe('routes', () => {
  test('POST /api/applications/:id/resume: 200 approves and starts the runner; 409 RESUME_REFUSED names the reason', async () => {
    const id = await seed('needs_human', { kind: 'email_verification', label: 'verify' });
    const ok = await post(`/api/applications/${id}/resume`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.outcome, 'approved');
    assert.equal(ok.body.warning, null);
    await new Promise((r) => { setTimeout(r, 50); });
    assert.deepEqual(started, [id]);

    const unk = await seed('needs_human', { kind: 'zz_unknown', label: 'x' });
    const refused = await post(`/api/applications/${unk}/resume`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'RESUME_REFUSED');
    assert.equal(refused.body.reason, 'unknown_kind');
    assert.equal(typeof refused.body.message, 'string');
  });

  test('POST /api/applications/:id/resume with the marker needs the acknowledgment and returns the warning', async () => {
    const id = await seed('needs_human', { kind: 'assisted_partial', label: 'x' }, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    const first = await post(`/api/applications/${id}/resume`);
    assert.equal(first.status, 409);
    assert.equal(first.body.reason, 'partial_draft_ack_required');
    const second = await post(`/api/applications/${id}/resume`, { acknowledge_partial_draft: true });
    assert.equal(second.status, 200);
    assert.equal(second.body.warning, PARTIAL_DRAFT_WARNING);
  });

  test('POST /api/applications/:id/resume: resume_failed returns drafting and does not start the apply runner', async () => {
    const id = await seed('needs_human', { kind: 'resume_failed', label: 'x' }, { doc: false });
    const out = await post(`/api/applications/${id}/resume`);
    assert.equal(out.status, 200);
    assert.equal(out.body.outcome, 'drafting');
    await new Promise((r) => { setTimeout(r, 50); });
    assert.deepEqual(started, []);
  });

  test('POST /api/applications/:id/answer on a marked application carries the warning and records the acknowledgment', async () => {
    const id = await seed('needs_human', { kind: 'question', label: 'Notice period?' }, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    const out = await post(`/api/applications/${id}/answer`, { text: 'Two weeks', save: false, acknowledge_partial_draft: true });
    assert.equal(out.status, 200);
    assert.equal(out.body.warning, PARTIAL_DRAFT_WARNING);
    const ev = (await listApplicationEvents(c, id)).find((e) => e.to_state === 'approved');
    assert.equal(ev.meta.partial_draft, true);
    assert.equal(ev.meta.partial_draft_acknowledged, true);
  });

  test('POST /api/credentials (R2): a kind or target mismatch saves the credential and says it did not resume', async () => {
    const q = await seed('needs_human', { kind: 'question', label: 'q' });
    const r1 = await post('/api/credentials', { applicationId: q, target: 'ic-jobsearch/a.example', username: 'u@x.com', password: 'pw1' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.resumed, false);
    assert.equal(r1.body.reason, 'kind_mismatch');
    assert.ok(credStore.has('ic-jobsearch/a.example'));
    assert.equal((await getApplication(c, q)).state, 'needs_human');

    const cr = await seed('needs_human', { kind: 'credential', target: 'ic-jobsearch/a.example', username: 'u' }, { ats: 'workday' });
    const r2 = await post('/api/credentials', { applicationId: cr, target: 'ic-jobsearch/b.example', username: 'u@x.com', password: 'pw2' });
    assert.equal(r2.body.resumed, false);
    assert.equal(r2.body.reason, 'target_mismatch');
    assert.equal((await getApplication(c, cr)).state, 'needs_human');

    await recordAssistedNextClick(c, cr);
    const r3 = await post('/api/credentials', { applicationId: cr, target: 'ic-jobsearch/a.example', username: 'u@x.com', password: 'pw3' });
    assert.equal(r3.body.resumed, true);
    assert.equal(r3.body.row.state, 'approved');
    assert.equal(r3.body.warning, PARTIAL_DRAFT_WARNING);
  });

  test('GET /api/applications and GET /api/listings/:id carry partial_draft', async () => {
    const id = await seed('needs_human', { kind: 'assisted_partial', label: 'x' }, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    const res = await fetch(`http://127.0.0.1:${port}/api/applications?state=needs_human`);
    const body = /** @type {any} */ (await res.json());
    const row = body.rows.find((/** @type {any} */ r) => r.application_id === id);
    assert.equal(row.partial_draft, true);
    const listingId = (await getApplication(c, id)).listing_id;
    const det = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/api/listings/${listingId}`)).json());
    assert.equal(det.application.partial_draft, true);
  });

  test('POST /api/applications/:id/retry: an unmarked failed row retries with no acknowledgment and no warning', async () => {
    const id = await seed('failed', null);
    const out = await post(`/api/applications/${id}/retry`);
    assert.equal(out.status, 200);
    assert.equal(out.body.row.state, 'approved');
    assert.equal(out.body.warning, null);
  });

  test('POST /api/applications/:id/retry with the marker: 409 partial_draft_ack_required without the acknowledgment, then 200 with it, recorded on the event', async () => {
    const id = await seed('failed', null, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    const refused = await post(`/api/applications/${id}/retry`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'RETRY_REFUSED');
    assert.equal(refused.body.reason, 'partial_draft_ack_required');
    assert.equal((await getApplication(c, id)).state, 'failed');
    const ok = await post(`/api/applications/${id}/retry`, { acknowledge_partial_draft: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.row.state, 'approved');
    assert.equal(ok.body.warning, PARTIAL_DRAFT_WARNING);
    const ev = (await listApplicationEvents(c, id)).find((e) => e.to_state === 'approved');
    assert.equal(ev.meta.partial_draft, true);
    assert.equal(ev.meta.partial_draft_acknowledged, true);
    assert.match(ev.note, /acknowledged/);
  });

  test('the dashboard credential auto-resume tick leaves a marked application parked', async () => {
    const id = await seed('needs_human', { kind: 'credential', target: 'ic-jobsearch/auto.example', username: 'u' }, { ats: 'workday' });
    await recordAssistedNextClick(c, id);
    credStore.set('ic-jobsearch/auto.example', { username: 'u', password: 'p' });
    await app.streamHub.checkCredentialResumes();
    assert.equal((await getApplication(c, id)).state, 'needs_human');
  });
});
