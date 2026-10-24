// @ts-check
/**
 * Structural guard (detail-block fix, S4): every SQL write to ic_job_listings.description must live in a
 * file on the explicit routed list below, which is where the description classifier runs. A new file that
 * writes the column fails this test until someone routes it through src/core/store-description.js (or the
 * payload screen upsert.js uses) and adds it here on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files allowed to write the description column, with how each is routed. */
const ROUTED = Object.freeze({
  'src/core/store-description.js': 'the chokepoint itself (storeDescription, purgeJunkDescription, clearRejectedDescription)',
  'src/core/upsert.js': 'insertListing/updateListing screen the payload with screenPayload() before the SQL runs; covers the scan detail pass, the fit sweep and bin/backfill-detail.js',
  'src/core/mail-score.js': 'inserts recruiter_mail listings WITHOUT a description (the column stays NULL; the email body is never stored on a listing)',
});

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** @param {string} src */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
}

const WRITE_PATTERNS = [
  /UPDATE\s+ic_job_listings\s+SET\b[^`]*?\bdescription\s*=/i,
  /INSERT\s+INTO\s+ic_job_listings\b/i,
  /coalesce\s*\([^)]*\bdescription\b/i,
];

test('only routed files write ic_job_listings.description', () => {
  const offenders = [];
  const seen = new Set();
  for (const dir of ['src', 'bin']) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (WRITE_PATTERNS.some((re) => re.test(text))) {
        seen.add(rel);
        if (!Object.hasOwn(ROUTED, rel)) offenders.push(rel);
      }
    }
  }
  assert.deepEqual(offenders, [], `these files write ic_job_listings.description outside the routed list: ${offenders.join(', ')}`);
  for (const rel of Object.keys(ROUTED)) assert.ok(seen.has(rel), `${rel} is on the routed list but no longer writes the column; remove it`);
});

test('callers that do not write SQL themselves are wired to the chokepoint', () => {
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('src/tools/get_job.js'), /storeDescription\(/);
  assert.match(read('src/core/gmail-detail.js'), /storeDescription\(/);
  assert.match(read('bin/repair-blocked-descriptions.js'), /clearRejectedDescription\(/);
  assert.match(read('bin/backfill-detail.js'), /updateListing\(/);
  assert.match(read('src/core/scan-run.js'), /classifyFetchedDetail\(/);
  assert.match(read('src/core/upsert.js'), /screenPayload\(/);
});
