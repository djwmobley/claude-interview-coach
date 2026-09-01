// @ts-check
/**
 * bin/triage-backfill.js's leftover fit-scoring pass (auto_new band model scoring PR, SHOULD-FIXes
 * B8 and B10): historical rows the deterministic step already marked status='new' (actor='auto') but
 * that never got a fit_score.
 *
 * Deliberately --dry-run only, matching the restraint test/triage-backfill.test.js's own header
 * comment states for this script: RUN_IDS_QUERY (the pre-existing replay loop) is global, unscoped to
 * any test-owned run_id, so a LIVE invocation of this CLI against the shared test database risks
 * picking up and mutating another concurrently-running test file's in-flight rows. --dry-run performs
 * zero writes regardless of what either query matches (the primary loop's RUN_IDS_QUERY or this pass's
 * own LEFTOVER_FIT_QUERY), so it is the only invocation shape that is safe to run here. The live
 * fit-only apply path itself (runModelTriage() with ids and autoNewIds both set to the same leftover
 * list) is exactly the path test/triage.test.js's "runModelTriage: auto_new fit-only apply path"
 * describe block already exercises directly and thoroughly against the real DB; this file adds no
 * duplicate coverage of that, only of the leftover pass's own query predicate and its --dry-run gating
 * (the one thing that pass changes about bin/triage-backfill.js).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newClient, upsertTestProfile, CONFIG_DIR } from './helpers/scan-fixtures.js';
import { recordEvent } from '../src/core/events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const SCRIPT = path.join(PKG, 'bin', 'triage-backfill.js');
const FAKE_CLAUDE_JS = path.join(HERE, 'fixtures', 'triage', 'fake-claude.js');
const BASE_CONFIG_FILES = ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json'];

const CO = `ZZ-TEST-TRIAGE-BACKFILL-LEFTOVER-${process.pid}`;
const SRC = `zz-test-triage-backfill-leftover-${process.pid}`;
const PROFILE = `zz-test-triage-backfill-leftover-${process.pid}`;

/** @type {import('pg').Client} */
let client;

/**
 * @param {{ status: string|null, fitScore: number|null }} o
 */
async function insertListing(o) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, url, url_normalized, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
       status, noise_class, prescore, fit_score, first_seen, last_seen, description)
     VALUES ('Backfill Leftover Test CTO', $1, $2, $2, $3, $4, 'listing', lower($1), 'backfill leftover test cto', 'legacy-unknown', md5($2),
       $5, 'ok', 55, $6, now(), now(), 'A test description for the leftover fit-scoring pass.')
     RETURNING id`,
    [CO, `https://boards.greenhouse.io/zztestbackfillleftover/jobs/${n}`, SRC, `${SRC}:${n}`, o.status, o.fitScore],
  );
  return Number(r.rows[0].id);
}

/**
 * Build a temp config dir: the six base fixture config files, a triage.json with the deterministic
 * step enabled (required to pass the script's exit-2 refusal gate) and the model step enabled, the two
 * config-locked model-step support files copied from the real shipped config/ dir, and a non-blank
 * triage-candidate.md.
 */
function buildConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-backfill-leftover-config-'));
  for (const name of BASE_CONFIG_FILES) fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(dir, name));
  fs.copyFileSync(path.join(PKG, 'config', 'triage-output-schema.json'), path.join(dir, 'triage-output-schema.json'));
  fs.copyFileSync(path.join(PKG, 'config', 'triage-mcp-empty.json'), path.join(dir, 'triage-mcp-empty.json'));
  fs.writeFileSync(path.join(dir, 'triage-candidate.md'), 'A CTO with 20 years of experience.');
  fs.writeFileSync(path.join(dir, 'triage.json'), JSON.stringify({ deterministic: { enabled: true, floor: 40, ceiling: 70 }, model: { enabled: true } }));
  return dir;
}

/**
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: PKG, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => r.id);
  if (ids.length) {
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
}

before(async () => {
  client = await newClient();
  await cleanup();
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'] });
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('bin/triage-backfill.js: leftover fit-scoring pass (--dry-run only, see file header)', () => {
  test('dry-run reports exactly the auto-marked, fit_score-NULL candidate, excludes a human-marked row, and performs zero writes', async () => {
    // Matches LEFTOVER_FIT_QUERY: status='new', fit_score NULL, most recent status event actor='auto'.
    const autoId = await insertListing({ status: 'new', fitScore: null });
    await recordEvent(client, { listingId: autoId, kind: 'status', fromStatus: null, toStatus: 'new', actor: 'auto', note: 'auto-triage: prescore 90 >= ceiling 70' });

    // Control: status='new', fit_score NULL, but the most recent status event's actor is a human
    // (dashboard), never actor='auto' -- must be excluded, an unattended backfill must never fit-score
    // a row a human explicitly set to 'new'.
    const humanId = await insertListing({ status: 'new', fitScore: null });
    await recordEvent(client, { listingId: humanId, kind: 'status', fromStatus: null, toStatus: 'new', actor: 'dashboard' });

    // Control: already fit-scored -- fit_score IS NULL excludes it even though actor='auto'.
    const alreadyScoredId = await insertListing({ status: 'new', fitScore: 81 });
    await recordEvent(client, { listingId: alreadyScoredId, kind: 'status', fromStatus: null, toStatus: 'new', actor: 'auto' });

    const dir = buildConfigDir();
    const env = {
      ...process.env,
      JOBSEARCH_CONFIG_DIR: dir,
      JOBSEARCH_TRIAGE_CLAUDE_BIN: process.execPath,
      JOBSEARCH_TRIAGE_CLAUDE_SCRIPT: FAKE_CLAUDE_JS,
    };
    const r = await runCli(['--profile', PROFILE, '--dry-run'], env);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stdout=${r.out} stderr=${r.err}`);

    const leftoverLine = r.out.split('\n').find((l) => l.includes('leftover fit-scoring pass:') && l.includes('candidate(s)'));
    assert.ok(leftoverLine, `no leftover-pass line in stdout: ${r.out}`);
    const ids = JSON.parse(leftoverLine.slice(leftoverLine.indexOf('[')));
    assert.ok(ids.includes(autoId), 'the auto-marked, unscored row is a candidate');
    assert.ok(!ids.includes(humanId), 'a human-marked row is never a candidate for this pass');
    assert.ok(!ids.includes(alreadyScoredId), 'an already fit-scored row is never a candidate for this pass');

    assert.match(r.out, /leftover fit-scoring pass: dry-run, no writes performed\./);

    const rows = await client.query('SELECT id, fit_score FROM ic_job_listings WHERE id = ANY($1::int[])', [[autoId, humanId, alreadyScoredId]]);
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row]));
    assert.equal(byId.get(autoId).fit_score, null, 'dry-run performs zero writes for this pass');
    assert.equal(byId.get(humanId).fit_score, null);
    assert.equal(byId.get(alreadyScoredId).fit_score, 81, 'unchanged');
  });
});
