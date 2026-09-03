#!/usr/bin/env node
// @ts-check
/**
 * Config lock helper (spec section 6/8).
 *
 *   node bin/config-lock.js          check: exit 0 when config/*.json matches config.lock.json, 2 otherwise
 *   node bin/config-lock.js --write  validate config with zod, then write config.lock.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkConfigLock, writeConfigLock, loadConfig, writeTriageCandidateLock, triageCandidatePresent } from '../src/core/config.js';
import { errFields } from '../src/core/errors.js';
import { lintNoiseFixtures } from '../src/core/noise.js';

/**
 * Run config/noise-rules.json against config/noise-fixtures.json (spec R2, decision 8): a config-lock
 * write or check fails when a fixture's expected class no longer holds under the current rule set, so a
 * rule-order or matcher edit that silently changes behavior for a known case is caught here, not just at
 * hash-mismatch time.
 * @param {import('../src/core/config.js').LoadedConfig} cfg
 */
function lintNoise(cfg) {
  const fixturesPath = path.join(cfg.configDir, 'noise-fixtures.json');
  let fixtures;
  try {
    fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  } catch (err) {
    process.stdout.write(`noise-fixtures.json missing or invalid: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
  const knownSources = new Set(Object.keys(cfg.adapters.adapters));
  const result = lintNoiseFixtures(cfg.noiseRules, fixtures, { knownSources });
  if (!result.ok) {
    process.stdout.write(`noise-rules.json FAILED ${result.failures.length} fixture(s) in noise-fixtures.json:\n`);
    for (const f of result.failures) process.stdout.write(`  ${f.name}: expected ${f.expected}, got ${f.actual}\n`);
    return false;
  }
  process.stdout.write(`noise-rules.json: ${fixtures.length} fixture(s) in noise-fixtures.json all match\n`);
  return true;
}

function main() {
  const write = process.argv.includes('--write');
  /** @type {import('../src/core/config.js').LoadedConfig} */
  let cfg;
  try {
    cfg = loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`config invalid: ${f.err_code}: ${f.err_message}\n`);
    process.exit(1);
  }
  if (!lintNoise(cfg)) {
    process.exit(1);
  }
  if (write) {
    let hash;
    try {
      hash = writeConfigLock();
    } catch (err) {
      const f = errFields(err);
      process.stdout.write(`config.lock.json NOT written: ${f.err_code}: ${f.err_message}\n`);
      process.exit(1);
    }
    process.stdout.write(`config.lock.json written: ${hash}\n`);
    // Rubric sidecar (spec section 5, "rubric out of the tracked lock"): never part of config.lock.json --
    // its own gitignored triage-candidate.lock tracks it instead. Skipped silently (with a printed note,
    // not an error) when the rubric itself is absent, since a fresh worktree or CI checkout never has it.
    if (triageCandidatePresent(cfg.configDir)) {
      const rubricHash = writeTriageCandidateLock(cfg.configDir);
      process.stdout.write(`triage-candidate.lock written: ${rubricHash}\n`);
    } else {
      process.stdout.write('triage-candidate.md not present: triage-candidate.lock skipped\n');
    }
    process.exit(0);
  }
  const r = checkConfigLock();
  process.stdout.write(`config lock ${r.ok ? 'OK' : 'MISMATCH'}: expected=${r.expected ?? 'none'} actual=${r.actual}\n`);
  if (r.missing.length) process.stdout.write(`missing: ${r.missing.join(', ')}\n`);
  process.exit(r.ok ? 0 : 2);
}

main();
