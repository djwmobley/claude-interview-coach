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
import { alertSendersSchema, GMAIL_PARSER_NAMES, loadConfig, triageSchema, atsApplySchema, CONFIG_FILES, computeConfigHash, loadTriageCandidateSummary } from '../src/core/config.js';
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
  test('CONFIG_FILES includes triage.json, triage-candidate.md, triage-output-schema.json, triage-mcp-empty.json', () => {
    for (const name of ['triage.json', 'triage-candidate.md', 'triage-output-schema.json', 'triage-mcp-empty.json']) {
      assert.ok(CONFIG_FILES.includes(name), `${name} must be in CONFIG_FILES`);
    }
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
