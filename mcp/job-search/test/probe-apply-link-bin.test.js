// @ts-check
/**
 * bin/probe-apply-link.js (auto-apply PR B): read-only CLI, no database writes at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probeApplyLink } from '../bin/probe-apply-link.js';
import { loadConfig } from '../src/core/config.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('probeApplyLink: no database access at all', () => {
  test('an already-exact greenhouse URL resolves without any fetch/DB call', async () => {
    const config = loadConfig();
    let fetchCalled = false;
    const { decoded, result } = await probeApplyLink('https://boards.greenhouse.io/acme/jobs/123', {
      config, lookup: publicLookup, fetch: async () => { fetchCalled = true; return { status: 200, headers: { get: () => null } }; },
    });
    assert.equal(decoded, null);
    assert.equal(result.resolved, true);
    assert.equal(fetchCalled, false); // an already-exact target needs no redirect chase
  });

  test('decodes a LinkedIn safety/go wrapper for display, still resolving via the same logic', async () => {
    const config = loadConfig();
    const wrapped = 'https://www.linkedin.com/safety/go/?url=' + encodeURIComponent('https://boards.greenhouse.io/acme/jobs/123');
    const { decoded, result } = await probeApplyLink(wrapped, { config, lookup: publicLookup });
    assert.equal(decoded, 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(result.resolved, true);
  });

  test('an unresolvable URL returns resolved:false, never throws', async () => {
    const config = loadConfig();
    const { result } = await probeApplyLink('https://some-random-company.example.com/careers/42', { config, lookup: publicLookup });
    assert.equal(result.resolved, false);
  });

  test('this module never imports src/core/db.js (grep-level proof the CLI is read-only by construction)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const HERE = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(HERE, '..', 'bin', 'probe-apply-link.js'), 'utf8');
    assert.doesNotMatch(src, /core\/db\.js/);
    assert.doesNotMatch(src, /connectDedicated|withClient|getPool/);
  });
});
