// @ts-check
/**
 * config/alert-senders.json schema (spec: gmail-adapter-brief.md item 12):
 * malformed addresses are rejected; every entry's `parser` must be one of
 * the closed enum of parser names that actually exist in gmail-parsers.js
 * (config.js validates against the same enum it exports, GMAIL_PARSER_NAMES,
 * which is kept in sync with src/adapters/gmail-parsers.js PARSERS by hand;
 * a cross-check test below catches the two ever drifting apart).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import {
  alertSendersSchema, GMAIL_PARSER_NAMES, loadConfig, triageSchema, atsApplySchema, CONFIG_FILES, computeConfigHash,
  loadTriageCandidateSummary, checkConfigLock, writeConfigLock, missingConfigFiles,
  triageCandidatePresent, computeTriageCandidateHash, triageCandidateLockPath, checkTriageCandidateLock, writeTriageCandidateLock,
} from '../src/core/config.js';
import { PARSERS } from '../src/adapters/gmail-parsers.js';
import { CONFIG_DIR } from './helpers/scan-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_CHILD = path.join(HERE, 'helpers', 'db-guard-child.mjs');

/**
 * Spawns test/helpers/db-guard-child.mjs as a real, separate `node` process. Starts from this test
 * process's own env (so PATH/SystemRoot/TEMP etc. are intact on every OS) but explicitly strips
 * NODE_TEST_CONTEXT, JOBSEARCH_TEST_GUARD, and PG_DSN first -- this test process is itself running
 * under `node --test` (possibly via bin/run-tests.js, which also sets JOBSEARCH_TEST_GUARD and a real
 * PG_DSN), and none of that should leak into the child uncontrolled. `overrides` then sets exactly the
 * variables each sub-test below cares about.
 * @param {Record<string, string>} overrides
 */
function runGuardChild(overrides) {
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  delete base.JOBSEARCH_TEST_GUARD;
  delete base.PG_DSN;
  return spawnSync(process.execPath, [GUARD_CHILD], { env: { ...base, ...overrides }, encoding: 'utf8' });
}

describe('alertSendersSchema', () => {
  test('the real config/alert-senders.json (via the test fixture config dir) validates and every parser name exists in gmail-parsers.js', () => {
    const cfg = loadConfig({ dir: CONFIG_DIR, fresh: true });
    assert.ok(Array.isArray(cfg.alertSenders) && cfg.alertSenders.length > 0);
    for (const s of cfg.alertSenders) {
      assert.ok(PARSERS[s.parser], `parser ${s.parser} for ${s.address} has no implementation`);
    }
  });

  test('GMAIL_PARSER_NAMES (the schema enum) matches PARSERS exactly (no drift)', () => {
    assert.deepEqual([...GMAIL_PARSER_NAMES].sort(), Object.keys(PARSERS).sort());
  });

  test('a well-formed sender list parses', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'linkedin', enabled: true, comment: 'x' }] });
    assert.equal(r.success, true);
  });

  test('enabled defaults to true when omitted', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'linkedin' }] });
    assert.equal(r.success, true);
    assert.equal(r.success && r.data.senders[0].enabled, true);
  });

  test('rejects a malformed address', () => {
    for (const bad of ['not-an-email', 'missing-domain@', '@missing-local.com', 'Uppercase@Linkedin.com', 'spaces in@address.com', '']) {
      const r = alertSendersSchema.safeParse({ senders: [{ address: bad, parser: 'linkedin' }] });
      assert.equal(r.success, false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test('rejects a parser name outside the closed enum (CONFIG_INVALID path, never a silent unknown parser)', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'not-a-real-parser' }] });
    assert.equal(r.success, false);
  });

  test('rejects a missing senders key and a non-array senders value', () => {
    assert.equal(alertSendersSchema.safeParse({}).success, false);
    assert.equal(alertSendersSchema.safeParse({ senders: 'nope' }).success, false);
  });

  test('an empty senders array is valid (gmail with no configured senders yields zero listings, not a config error)', () => {
    assert.equal(alertSendersSchema.safeParse({ senders: [] }).success, true);
  });
});

describe('atsApplySchema and config/ats-apply.json (apply pipeline slice 2, spec-adversary amendment S11)', () => {
  test('CONFIG_FILES includes ats-apply.json', () => {
    assert.ok(CONFIG_FILES.includes('ats-apply.json'));
  });

  test('the real config/ats-apply.json (via the test fixture config dir) validates', () => {
    const cfg = loadConfig({ dir: CONFIG_DIR, fresh: true });
    assert.ok(Array.isArray(cfg.atsApply.greenhouse.hosts) && cfg.atsApply.greenhouse.hosts.length > 0);
    assert.ok(Array.isArray(cfg.atsApply.lever.hosts) && cfg.atsApply.lever.hosts.length > 0);
    assert.ok(Array.isArray(cfg.atsApply.smartrecruiters.hosts) && cfg.atsApply.smartrecruiters.hosts.length > 0);
    assert.equal(typeof cfg.atsApply.icims.hostSuffix, 'string');
    assert.equal(typeof cfg.atsApply.dayforce.hostSuffix, 'string');
    assert.equal(typeof cfg.atsApply.linkedin.hostSuffix, 'string');
    assert.equal(typeof cfg.atsApply.indeed.hostSuffix, 'string');
  });

  test('a well-formed ats-apply payload parses', () => {
    const r = atsApplySchema.safeParse({
      greenhouse: { hosts: ['boards.greenhouse.io'] },
      lever: { hosts: ['jobs.lever.co'] },
      smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
      icims: { hostSuffix: 'icims.com' },
      dayforce: { hostSuffix: 'dayforcehcm.com' },
      linkedin: { hostSuffix: 'linkedin.com' },
      indeed: { hostSuffix: 'indeed.com' },
    });
    assert.equal(r.success, true);
  });

  test('an empty greenhouse.hosts array is rejected (min 1)', () => {
    const base = {
      greenhouse: { hosts: [] },
      lever: { hosts: ['jobs.lever.co'] },
      smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
      icims: { hostSuffix: 'icims.com' },
      dayforce: { hostSuffix: 'dayforcehcm.com' },
      linkedin: { hostSuffix: 'linkedin.com' },
      indeed: { hostSuffix: 'indeed.com' },
    };
    assert.equal(atsApplySchema.safeParse(base).success, false);
  });

  test('a hostSuffix that is not a bare hostname (has a scheme or a path) is rejected', () => {
    const base = {
      greenhouse: { hosts: ['boards.greenhouse.io'] },
      lever: { hosts: ['jobs.lever.co'] },
      smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
      icims: { hostSuffix: 'https://icims.com' },
      dayforce: { hostSuffix: 'dayforcehcm.com' },
      linkedin: { hostSuffix: 'linkedin.com' },
      indeed: { hostSuffix: 'indeed.com' },
    };
    assert.equal(atsApplySchema.safeParse(base).success, false);
  });

  test('a missing top-level key (e.g. dayforce) is rejected', () => {
    const r = atsApplySchema.safeParse({
      greenhouse: { hosts: ['boards.greenhouse.io'] },
      lever: { hosts: ['jobs.lever.co'] },
      smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
      icims: { hostSuffix: 'icims.com' },
      linkedin: { hostSuffix: 'linkedin.com' },
      indeed: { hostSuffix: 'indeed.com' },
    });
    assert.equal(r.success, false);
  });

  test('a malformed (invalid JSON) ats-apply.json throws CONFIG_INVALID at loadConfig()', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-apply-config-badjson-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      fs.writeFileSync(path.join(tmp, 'ats-apply.json'), '{not valid json');
      assert.throws(() => loadConfig({ dir: tmp, fresh: true }), (err) => err.code === 'CONFIG_INVALID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a MISSING ats-apply.json throws CONFIG_INVALID at loadConfig() -- unlike triage.json, this file is required, never tolerantly defaulted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-apply-config-missing-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      assert.throws(() => loadConfig({ dir: tmp, fresh: true }), (err) => err.code === 'CONFIG_INVALID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a SCHEMA-INVALID ats-apply.json (empty greenhouse.hosts) throws CONFIG_INVALID at loadConfig()', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-apply-config-schema-invalid-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      fs.writeFileSync(path.join(tmp, 'ats-apply.json'), JSON.stringify({
        greenhouse: { hosts: [] },
        lever: { hosts: ['jobs.lever.co'] },
        smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
        icims: { hostSuffix: 'icims.com' },
        dayforce: { hostSuffix: 'dayforcehcm.com' },
        linkedin: { hostSuffix: 'linkedin.com' },
        indeed: { hostSuffix: 'indeed.com' },
      }));
      assert.throws(() => loadConfig({ dir: tmp, fresh: true }), (err) => err.code === 'CONFIG_INVALID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ats-apply.json round-trips through computeConfigHash: a content change changes the hash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-apply-config-hash-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      const hashBefore = computeConfigHash(tmp);
      fs.writeFileSync(path.join(tmp, 'ats-apply.json'), JSON.stringify({
        greenhouse: { hosts: ['boards.greenhouse.io', 'a-new-host.example.com'] },
        lever: { hosts: ['jobs.lever.co'] },
        smartrecruiters: { hosts: ['jobs.smartrecruiters.com'] },
        icims: { hostSuffix: 'icims.com' },
        dayforce: { hostSuffix: 'dayforcehcm.com' },
        linkedin: { hostSuffix: 'linkedin.com' },
        indeed: { hostSuffix: 'indeed.com' },
      }));
      const hashAfter = computeConfigHash(tmp);
      assert.notEqual(hashBefore, hashAfter, 'an ats-apply.json content change must change the config-lock hash');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('config.lock.json freshness against the REAL config dir (guardurl fix: smartrecruiters entry)', () => {
  test('checkConfigLock() with no dir override (mcp/job-search/config, not the CONFIG_DIR test fixture) reports ok', () => {
    // No `dir` argument here on purpose: checkConfigLock() falls back to getEnv().JOBSEARCH_CONFIG_DIR,
    // which resolves to the real mcp/job-search/config directory unless a caller sets the env var (the
    // spawned-child tests elsewhere in this suite do that for isolation; this in-process test does not).
    // This must fail if someone edits config/adapters.json without re-running `node bin/config-lock.js --write`.
    // scan-never-skip fix: triage-candidate.md (the rubric) is no longer a CONFIG_FILES member, so this
    // test needs no gitignored file copied into a fresh worktree to pass any more -- that was exactly the
    // PRs #35/#36/#38 incident (a worktree lacking the rubric produced a lock that mismatched main's, and
    // the next unattended scan refused with no run row and no reason shown). The rubric's own integrity is
    // now tracked by its own gitignored sidecar (see the "rubric integrity sidecar" describe block below),
    // which an unattended scan warns about instead of ever refusing to run.
    const r = checkConfigLock();
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.missing, [], `CONFIG_FILES entries missing on disk: ${r.missing.join(', ')} -- ${r.detail}`);
  });
});

describe('rubric integrity sidecar (scan-never-skip fix: config/triage-candidate.md tracked outside config.lock.json)', () => {
  function withTmpDir(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-sidecar-'));
    try {
      return fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('rubric absent: triageCandidatePresent false, checkTriageCandidateLock reports {present:false, ok:true}, writeTriageCandidateLock is a no-op', () => {
    withTmpDir((tmp) => {
      assert.equal(triageCandidatePresent(tmp), false);
      const r = checkTriageCandidateLock(tmp);
      assert.deepEqual(r, { present: false, ok: true, expected: null, actual: null });
      assert.equal(writeTriageCandidateLock(tmp), null);
      assert.equal(fs.existsSync(triageCandidateLockPath(tmp)), false, 'no sidecar file should be created when the rubric is absent');
    });
  });

  test('rubric present, sidecar missing: checkTriageCandidateLock reports {present:true, ok:false}', () => {
    withTmpDir((tmp) => {
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'Damian Mobley, CTO, Houston TX.\n');
      const r = checkTriageCandidateLock(tmp);
      assert.equal(r.present, true);
      assert.equal(r.ok, false);
      assert.equal(r.expected, null);
      assert.equal(r.actual, computeTriageCandidateHash(tmp));
    });
  });

  test('rubric present, sidecar written then matches: writeTriageCandidateLock -> checkTriageCandidateLock reports {present:true, ok:true}', () => {
    withTmpDir((tmp) => {
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'Damian Mobley, CTO, Houston TX.\n');
      const hash = writeTriageCandidateLock(tmp);
      assert.equal(typeof hash, 'string');
      assert.equal(fs.existsSync(triageCandidateLockPath(tmp)), true);
      const r = checkTriageCandidateLock(tmp);
      assert.deepEqual(r, { present: true, ok: true, expected: hash, actual: hash });
    });
  });

  test('rubric edited after the sidecar was written: checkTriageCandidateLock reports {present:true, ok:false}', () => {
    withTmpDir((tmp) => {
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'original content\n');
      writeTriageCandidateLock(tmp);
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'edited content\n');
      const r = checkTriageCandidateLock(tmp);
      assert.equal(r.ok, false);
      assert.notEqual(r.expected, r.actual);
    });
  });

  test('the sidecar is never a CONFIG_FILES member and never changes computeConfigHash()', () => {
    withTmpDir((tmp) => {
      for (const name of CONFIG_FILES) fs.writeFileSync(path.join(tmp, name), `placeholder for ${name}\n`);
      const hashBefore = computeConfigHash(tmp);
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'rubric content\n');
      writeTriageCandidateLock(tmp);
      const hashAfter = computeConfigHash(tmp);
      assert.equal(hashBefore, hashAfter, 'writing the rubric and its sidecar must never change the tracked config-lock hash');
    });
  });
});

describe('config-lock missing-file handling (config-lock rubric incident: PRs #35/#36 --write with the rubric absent)', () => {
  /**
   * Seed every CONFIG_FILES entry into `dir`, skipping any name in `skip`. triage-candidate.md (gitignored
   * personal data) is deliberately NOT a CONFIG_FILES member any more (see config.js's CONFIG_FILES
   * comment), so this never needs to special-case it: every remaining CONFIG_FILES entry is present in
   * CONFIG_DIR (the test fixture config dir), and any absent one falls back to a placeholder below.
   */
  function seedConfigDir(dir, skip = []) {
    for (const name of CONFIG_FILES) {
      if (skip.includes(name)) continue;
      const src = path.join(CONFIG_DIR, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
      else fs.writeFileSync(path.join(dir, name), `placeholder content for ${name}\n`);
    }
  }

  test('writeConfigLock() refuses when a CONFIG_FILES entry is missing, naming the file and the copy remedy', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-write-missing-'));
    const prevDir = process.env.JOBSEARCH_CONFIG_DIR;
    const prevLock = process.env.JOBSEARCH_CONFIG_LOCK;
    try {
      // noise-rules.json is present in CONFIG_DIR; leave it out of the tmp dir on purpose.
      seedConfigDir(tmp, ['noise-rules.json']);
      process.env.JOBSEARCH_CONFIG_DIR = tmp;
      process.env.JOBSEARCH_CONFIG_LOCK = path.join(tmp, 'config.lock.json');
      assert.throws(
        () => writeConfigLock(),
        (err) => {
          assert.equal(err.code, 'CONFIG_INVALID');
          assert.match(err.message, /noise-rules\.json/);
          assert.match(err.message, /copy the gitignored file from the main checkout into this worktree's config\/ then rerun/);
          return true;
        },
      );
      assert.equal(fs.existsSync(path.join(tmp, 'config.lock.json')), false, 'a refused write must not create config.lock.json');
    } finally {
      if (prevDir === undefined) delete process.env.JOBSEARCH_CONFIG_DIR; else process.env.JOBSEARCH_CONFIG_DIR = prevDir;
      if (prevLock === undefined) delete process.env.JOBSEARCH_CONFIG_LOCK; else process.env.JOBSEARCH_CONFIG_LOCK = prevLock;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkConfigLock() reports missing file names in both r.missing and r.detail', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-check-missing-'));
    const prevDir = process.env.JOBSEARCH_CONFIG_DIR;
    const prevLock = process.env.JOBSEARCH_CONFIG_LOCK;
    try {
      seedConfigDir(tmp, ['ats-apply.json']);
      process.env.JOBSEARCH_CONFIG_DIR = tmp;
      process.env.JOBSEARCH_CONFIG_LOCK = path.join(tmp, 'no-such-lock.json'); // never written in this test
      const r = checkConfigLock();
      assert.deepEqual(r.missing, ['ats-apply.json']);
      assert.match(r.detail, /ats-apply\.json/);
      assert.match(r.detail, /copy the gitignored file from the main checkout into this worktree's config\/ then rerun/);
      assert.equal(missingConfigFiles(tmp).includes('ats-apply.json'), true);
    } finally {
      if (prevDir === undefined) delete process.env.JOBSEARCH_CONFIG_DIR; else process.env.JOBSEARCH_CONFIG_DIR = prevDir;
      if (prevLock === undefined) delete process.env.JOBSEARCH_CONFIG_LOCK; else process.env.JOBSEARCH_CONFIG_LOCK = prevLock;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing file\'s hash sentinel does not collide with a real file whose content is the sentinel text', () => {
    // dirA: triage.json genuinely absent (hashed via the missing-file presence-byte branch; triage.json is
    // loaded tolerantly by loadConfig() but still a CONFIG_FILES member, so computeConfigHash() still
    // covers it the same as every other config file).
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-sentinel-absent-'));
    // dirB: triage.json PRESENT on disk, its content literally the missing-marker text.
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-sentinel-literal-'));
    try {
      seedConfigDir(dirA, ['triage.json']);
      seedConfigDir(dirB);
      fs.writeFileSync(path.join(dirB, 'triage.json'), '<missing:triage.json>');
      const hashA = computeConfigHash(dirA);
      const hashB = computeConfigHash(dirB);
      assert.notEqual(hashA, hashB, 'a present file whose content equals the missing-marker text must not hash identically to the file being absent');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('a leading UTF-8 BOM and bare-CR line endings hash identically to the clean LF file', () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-normalize-clean-'));
    const bom = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-normalize-bom-'));
    const cr = fs.mkdtempSync(path.join(os.tmpdir(), 'config-lock-normalize-cr-'));
    try {
      seedConfigDir(clean);
      seedConfigDir(bom);
      seedConfigDir(cr);
      // The real fixture file is already CRLF on disk (Windows checkout); normalize to LF first so
      // ".replace(/\n/g, '\r\n')" below doesn't double up an existing \r into \r\r\n.
      const raw = fs.readFileSync(path.join(CONFIG_DIR, 'noise-rules.json'), 'utf8');
      const original = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      fs.writeFileSync(path.join(clean, 'noise-rules.json'), original);
      fs.writeFileSync(path.join(bom, 'noise-rules.json'), '\uFEFF' + original.replace(/\n/g, '\r\n'));
      fs.writeFileSync(path.join(cr, 'noise-rules.json'), original.replace(/\n/g, '\r'));
      const hashClean = computeConfigHash(clean);
      const hashBom = computeConfigHash(bom);
      const hashCr = computeConfigHash(cr);
      assert.equal(hashBom, hashClean, 'a leading BOM plus CRLF must hash identically to the clean LF file');
      assert.equal(hashCr, hashClean, 'bare-CR line endings must hash identically to the clean LF file');
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
      fs.rmSync(bom, { recursive: true, force: true });
      fs.rmSync(cr, { recursive: true, force: true });
    }
  });
});

describe('assertTestDbGuard (scan-report-fixes item: structural test-isolation guard)', () => {
  test('trips when NODE_TEST_CONTEXT is set and the DSN does not resolve to a "_test" database', () => {
    const r = runGuardChild({ NODE_TEST_CONTEXT: 'child-v8', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not end in "_test"/);
    assert.match(r.stderr, /bin\/run-tests\.js/);
  });

  test('trips when JOBSEARCH_TEST_GUARD=1 is set, even with NODE_TEST_CONTEXT absent', () => {
    const r = runGuardChild({ JOBSEARCH_TEST_GUARD: '1', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not end in "_test"/);
  });

  test('does NOT trip when the DSN resolves to a database ending in "_test", even under NODE_TEST_CONTEXT', () => {
    const r = runGuardChild({ NODE_TEST_CONTEXT: 'child-v8', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context_test' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });

  test('does NOT trip when neither NODE_TEST_CONTEXT nor JOBSEARCH_TEST_GUARD is set (normal CLI/production usage is unaffected)', () => {
    const r = runGuardChild({ PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

describe('triageSchema and triage.json loading (slice 3 auto-triage, docs/slice3-auto-triage-spec.md section 3)', () => {
  test('CONFIG_FILES includes triage.json, triage-output-schema.json, triage-mcp-empty.json', () => {
    for (const name of ['triage.json', 'triage-output-schema.json', 'triage-mcp-empty.json']) {
      assert.ok(CONFIG_FILES.includes(name), `${name} must be in CONFIG_FILES`);
    }
  });

  test('CONFIG_FILES deliberately excludes triage-candidate.md (scan-never-skip fix: rubric out of the tracked lock, tracked by its own gitignored sidecar instead)', () => {
    assert.ok(!CONFIG_FILES.includes('triage-candidate.md'));
  });

  test('the test fixture config dir\'s triage.json (deterministic and model both off) parses and loadConfig sets present=true', () => {
    const cfg = loadConfig({ dir: CONFIG_DIR, fresh: true });
    assert.equal(cfg.triage.present, true);
    assert.equal(cfg.triage.deterministic.enabled, false);
    assert.equal(cfg.triage.model.enabled, false);
  });

  test('a MISSING triage.json loads successfully with present=false and every field at its schema default (finding 11 fix, never CONFIG_INVALID)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-config-missing-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      const cfg = loadConfig({ dir: tmp, fresh: true });
      assert.equal(cfg.triage.present, false);
      assert.equal(cfg.triage.deterministic.enabled, false);
      assert.equal(cfg.triage.deterministic.floor, 40);
      assert.equal(cfg.triage.deterministic.ceiling, 70);
      assert.equal(cfg.triage.model.enabled, false);
      assert.equal(cfg.triage.model.batchSize, 15);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a MALFORMED triage.json (floor > ceiling) still throws CONFIG_INVALID, same as a malformed noise-rules.json does today', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-config-malformed-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      fs.writeFileSync(path.join(tmp, 'triage.json'), JSON.stringify({ deterministic: { enabled: true, floor: 80, ceiling: 20 }, model: {} }));
      assert.throws(() => loadConfig({ dir: tmp, fresh: true }), (err) => err.code === 'CONFIG_INVALID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a triage.json with invalid JSON also throws CONFIG_INVALID', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-config-badjson-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      fs.writeFileSync(path.join(tmp, 'triage.json'), '{not valid json');
      assert.throws(() => loadConfig({ dir: tmp, fresh: true }), (err) => err.code === 'CONFIG_INVALID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('triage.json round-trips through computeConfigHash: a content change changes the hash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-config-hash-'));
    try {
      for (const name of ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json']) {
        fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      }
      const hashWithoutFile = computeConfigHash(tmp);
      fs.writeFileSync(path.join(tmp, 'triage.json'), JSON.stringify({ deterministic: { enabled: true, floor: 40, ceiling: 70 }, model: {} }));
      const hashWithFile = computeConfigHash(tmp);
      assert.notEqual(hashWithoutFile, hashWithFile, 'an absent-vs-present triage.json changes the config-lock hash (config drift must be deliberate)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('triageSchema', () => {
    test('floor > ceiling is rejected', () => {
      const r = triageSchema.safeParse({ deterministic: { floor: 71, ceiling: 70 }, model: {} });
      assert.equal(r.success, false);
    });
    test('floor === ceiling is accepted', () => {
      const r = triageSchema.safeParse({ deterministic: { floor: 50, ceiling: 50 }, model: {} });
      assert.equal(r.success, true);
    });
    test('empty object parses to every default', () => {
      const r = triageSchema.safeParse({});
      assert.equal(r.success, true);
    });
  });

  describe('loadTriageCandidateSummary', () => {
    test('missing file returns null', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-candidate-missing-'));
      try {
        assert.equal(loadTriageCandidateSummary(tmp), null);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
    test('a blank (whitespace-only) file returns null, not a silent default description', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-candidate-blank-'));
      try {
        fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), '   \n\n  ');
        assert.equal(loadTriageCandidateSummary(tmp), null);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
    test('a real file returns its text verbatim', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-candidate-real-'));
      try {
        fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'A CTO with 20 years of experience.');
        assert.equal(loadTriageCandidateSummary(tmp), 'A CTO with 20 years of experience.');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
