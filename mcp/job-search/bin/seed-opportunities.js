#!/usr/bin/env node
// @ts-check
/**
 * Seed opportunities (dashboard PR 2, plan lines 111-123). Loads a JSON array of entries describing
 * outside opportunities that never came from a scan (a recruiter call, a role already known before this
 * repo tracked it) and creates or updates the matching listing rows, replays their event history, links
 * documents, and attaches follow-ups. Idempotent: a second run against the same file finds each entry's
 * listing by its deterministic `manual:<key>` external_id (see createManualListing's `key` option) and
 * only applies updates, never creates a second row for the same key.
 *
 *   node bin/seed-opportunities.js [--file data/job-search/opportunities.json] [--dry-run]
 *
 * The default file lives under the gitignored data/ directory and is NOT committed; see
 * seed/opportunities.example.json for the entry shape with synthetic data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../src/core/config.js';
import { connectDedicated, closePool } from '../src/core/db.js';
import { createManualListing } from '../src/core/manual.js';
import { applyMark } from '../src/tools/mark_jobs.js';
import { recordEvent } from '../src/core/events.js';
import { linkDocument, resolveOutputPath } from '../src/core/documents.js';
import { getFollowup, createFollowup } from '../src/core/followups.js';
import { errFields } from '../src/core/errors.js';

const KIND_FOR_DIR = Object.freeze({ resumes: 'resume', coverletters: 'coverletter', cheatsheets: 'cheatsheet', markdown: 'markdown', research: 'research', reports: 'report' });

const USAGE = 'usage: node bin/seed-opportunities.js [--file path] [--dry-run]';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { file: path.join(repoRoot(), 'data', 'job-search', 'opportunities.json'), dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = path.resolve(argv[++i] ?? out.file);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {string} key
 */
async function findExistingByKey(client, key) {
  const r = await client.query(`SELECT id FROM ic_job_listings WHERE source = 'manual' AND external_id = $1`, [`manual:${key}`]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {any} entry
 * @param {{ dryRun: boolean, outputRoot: string }} opts
 */
export async function seedOneEntry(client, entry, opts) {
  const now = new Date();
  /** @type {string[]} */
  const warnings = [];
  /** @type {number|null} */
  let listingId = null;
  let created = false;

  if (entry.match_listing_id) {
    const r = await client.query('SELECT id FROM ic_job_listings WHERE id = $1', [entry.match_listing_id]);
    if (r.rowCount === 0) return { key: entry.key, ok: false, error: `match_listing_id ${entry.match_listing_id} not found` };
    listingId = Number(entry.match_listing_id);
  } else {
    listingId = await findExistingByKey(client, entry.key);
    if (listingId == null) {
      if (opts.dryRun) return { key: entry.key, ok: true, would_create: true };
      const result = await createManualListing(client, {
        title: entry.title, company: entry.company, url: entry.url ?? null, status: entry.status ?? null, via: entry.via ?? null, key: entry.key,
      }, { actor: 'seed', now });
      if (!result.created) return { key: entry.key, ok: false, error: 'unexpected duplicate candidate on first creation', candidates: result.candidates };
      listingId = result.id;
      created = true;
    }
  }

  if (opts.dryRun) return { key: entry.key, ok: true, listing_id: listingId, created: false, would_update: true };

  if (!created && entry.status !== undefined) {
    await applyMark(client, { id: listingId, status: entry.status, ...(entry.notes !== undefined ? { notes: entry.notes } : {}) }, { now, explicit: true, actor: 'seed' });
  } else if (created && entry.notes !== undefined) {
    await applyMark(client, { id: listingId, notes: entry.notes }, { now, explicit: true, actor: 'seed' });
  }

  // Replay events (actor 'seed', `at` honored). Idempotence guard mirrors sql/009's own backfill pattern:
  // an exact (listing, status, to_status, at) match already present means this replay adds nothing.
  for (const ev of entry.events ?? []) {
    const at = new Date(ev.at);
    if (Number.isNaN(at.getTime())) {
      warnings.push(`event not replayed (invalid at): ${JSON.stringify(ev)}`);
      continue;
    }
    const existing = await client.query(
      `SELECT id FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' AND to_status = $2 AND at = $3`,
      [listingId, ev.to_status, at],
    );
    if (existing.rowCount === 0) {
      await recordEvent(client, { listingId, kind: 'status', toStatus: ev.to_status, note: ev.note ?? null, actor: 'seed', at });
    }
  }

  // Documents: the file must exist under output/; a missing or invalid path warns, never fails the entry.
  for (const relPath of entry.documents ?? []) {
    const resolved = resolveOutputPath(opts.outputRoot, relPath);
    if (!resolved.ok) {
      warnings.push(`document not linked (${resolved.reason}): ${relPath}`);
      continue;
    }
    const dir = resolved.relPath.split('/')[0];
    await linkDocument(client, opts.outputRoot, { listingId, relPath: resolved.relPath, kind: KIND_FOR_DIR[dir] ?? 'other', actor: 'seed' });
  }

  // Follow-up: attach an existing one by id, or create a new one from the given fields.
  if (entry.followup) {
    if (entry.followup.link_id) {
      const existing = await getFollowup(client, entry.followup.link_id);
      if (!existing) warnings.push(`follow-up ${entry.followup.link_id} not found; not linked`);
      else if (existing.listing_id !== listingId) await client.query('UPDATE ic_followups SET listing_id = $2, updated_at = now() WHERE id = $1', [existing.id, listingId]);
    } else {
      const { contact, due_at, channel, action, org, notify } = entry.followup;
      const { warnings: fwWarnings } = await createFollowup(client, { contact, org: org ?? null, listing_id: listingId, due_at, channel, action, notify, created_from: 'seed' });
      warnings.push(...fwWarnings);
    }
  }

  return { key: entry.key, ok: true, listing_id: listingId, created, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(args.file, 'utf8');
  } catch {
    console.log(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: `seed file not readable: ${args.file}` }));
    process.exit(1);
    return;
  }
  /** @type {any} */
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ ok: false, code: 'VALIDATION', message: `seed file is not valid JSON: ${args.file}` }));
    process.exit(1);
    return;
  }
  if (!Array.isArray(entries)) {
    console.log(JSON.stringify({ ok: false, code: 'VALIDATION', message: 'seed file must be a JSON array of entries' }));
    process.exit(1);
    return;
  }

  const outputRoot = path.join(repoRoot(), 'output');
  const client = await connectDedicated();
  let exitCode = 0;
  try {
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || !entry.key) {
        console.log(JSON.stringify({ ok: false, error: 'entry missing a string key', entry }));
        exitCode = 1;
        continue;
      }
      try {
        const result = await seedOneEntry(client, entry, { dryRun: args.dryRun, outputRoot });
        console.log(JSON.stringify(result));
        if (!result.ok) exitCode = 1;
      } catch (err) {
        const f = errFields(err);
        console.log(JSON.stringify({ key: entry.key, ok: false, ...f }));
        exitCode = 1;
      }
    }
  } finally {
    await client.end();
    await closePool();
  }
  process.exit(exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
