#!/usr/bin/env node
// @ts-check
/**
 * Read-only apply-link probe CLI (auto-apply PR B, docs/auto-apply-spec.md): prints the resolution chain
 * for one URL using the exact same src/apply/apply-target.js#resolveApplyTarget + src/apply/
 * probe-registry.js machinery bin/auto-apply.js's prepare phase uses -- WITHOUT ever writing to the
 * database (no ic_job_listings UPDATE, unlike src/core/apply-target-persist.js's own persistence path).
 * Useful for diagnosing why a specific listing's apply target did or did not resolve, or for checking a
 * candidate URL before it is ever scanned.
 *
 *   node bin/probe-apply-link.js <url>
 *
 * Exit 0 when the URL resolves to an exact apply target, 1 otherwise (unresolved, invalid, or an error).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { buildProbeRegistryFromAtsApply } from '../src/apply/probe-registry.js';
import { resolveApplyTarget, decodeLinkedInSafetyGo, INTERMEDIARY_HOSTS } from '../src/apply/apply-target.js';
import { errFields } from '../src/core/errors.js';

const USAGE = 'usage: node bin/probe-apply-link.js <url>';

/**
 * Resolve one URL, read-only. Never touches the database or writes anything. Exported for tests -- import
 * this instead of spawning the CLI as a child process.
 * @param {string} url
 * @param {{ config?: import('../src/core/config.js').LoadedConfig, fetch?: typeof fetch, lookup?: import('../src/core/urlguard.js').Lookup }} [deps]
 * @returns {Promise<{ decoded: string|null, result: import('../src/apply/apply-target.js').ApplyTargetResult }>}
 */
export async function probeApplyLink(url, deps = {}) {
  const config = deps.config ?? loadConfig();
  const registry = buildProbeRegistryFromAtsApply(config.atsApply, INTERMEDIARY_HOSTS);
  const decoded = decodeLinkedInSafetyGo(url);
  const result = await resolveApplyTarget(url, registry, { fetch: deps.fetch, lookup: deps.lookup });
  return { decoded, result };
}

async function main() {
  const url = process.argv[2];
  if (!url || url === '--help' || url === '-h') {
    console.log(USAGE);
    process.exit(url ? 0 : 1);
    return;
  }
  try {
    const { decoded, result } = await probeApplyLink(url);
    if (decoded) console.log(`decoded LinkedIn safety/go wrapper -> ${decoded}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.resolved ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ resolved: false, ...errFields(err) }, null, 2));
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
