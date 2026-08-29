// @ts-check
/**
 * Manual opportunities (dashboard PR 1, plan line 56): create a listing row for a role that never came
 * from a scan (a recruiter call, a referral, a role Damian heard about directly). Goes through the exact
 * same normalizeListing/classify() path a scanned row goes through, so a manual entry can never silently
 * duplicate an existing scanned row and never needs its own separate dedup logic -- it either becomes a
 * new row, or the caller is told which existing row(s) it looks like and must explicitly `force` past
 * that (the review tool's merge/separate path is not reused here; force insertion is deliberate: an
 * opportunity a human has confirmed is real is not something this layer should silently drop or refuse
 * outright, only flag).
 */
import { normalizeListing } from './normalize.js';
import { classify, makePgLookups } from './dedup.js';
import { insertListing } from './upsert.js';
import { recordEvent } from './events.js';
import { prescore } from './prescore.js';
import { JobSearchError } from './errors.js';

const COMBINING_DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

/** @param {string} s */
function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS_RE, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @typedef {Object} ManualListingInput
 * @property {string} title
 * @property {string} company
 * @property {string|null} [url]
 * @property {string|null} [location]
 * @property {string|null} [status] pipeline status to set on create (src/core/statuses.js
 *   PIPELINE_STATUSES, or null for untriaged). Defaults to 'new' -- a manually entered opportunity is
 *   already a deliberate human action, unlike a scan-inserted row, so it starts in triage rather than
 *   untriaged unless the caller says otherwise.
 * @property {string|null} [via] recruiter/referral name; recorded on the 'created' event's note, never
 *   silently dropped even though there is no dedicated column for it.
 * @property {string} [profile] search profile to prescore against; default 'exec-default'.
 * @property {string} [key] stable identifier for the external_id (dashboard PR 2's bin/seed-opportunities.js):
 *   when given, external_id becomes `manual:<slugified key>` verbatim, with no random suffix, so a caller
 *   that first looks up that exact external_id (as the seed script does) gets a deterministic id back.
 *   Re-running the same entry never risks a second createManualListing call colliding with the unique
 *   (source, external_id) index -- the caller is expected to check for an existing row by that id first
 *   and call applyMark on it instead of calling this function again for the same key.
 */

/**
 * @typedef {Object} CreateManualListingResult
 * @property {boolean} created
 * @property {number|null} id
 * @property {number[]} candidates non-empty only when created is false
 */

/**
 * @param {import('pg').ClientBase} client
 * @param {ManualListingInput} input
 * @param {{ actor?: 'dashboard'|'mcp'|'cli'|'migration'|'seed', force?: boolean, now?: Date, classifyOpts?: import('./dedup.js').ClassifyOptions }} [opts]
 * @returns {Promise<CreateManualListingResult>}
 */
export async function createManualListing(client, input, opts = {}) {
  const actor = opts.actor ?? 'mcp';
  const now = opts.now ?? new Date();
  const title = String(input?.title ?? '').trim();
  if (!title) throw new JobSearchError('VALIDATION', 'title is required');
  const company = String(input?.company ?? '').trim();
  if (!company) throw new JobSearchError('VALIDATION', 'company is required');

  const rec = normalizeListing({ source: 'manual', url: input.url ?? null, title, company, location: input.location ?? null, description: null });
  // A URL that resolves to a canonical id (e.g. a real greenhouse/lever/linkedin posting pasted in by
  // hand) already gave normalizeListing/normalizeUrl a real external_id, so a manual entry with a real
  // job-board URL dedups exactly like a scanned row from that board would. Only fabricate an id when the
  // URL was absent, unparseable, or residual.
  if (!rec.external_id) {
    if (input.key) {
      const slug = slugify(input.key) || 'entry';
      rec.external_id = `manual:${slug}`;
    } else {
      const slug = slugify(`${company}-${title}`) || 'entry';
      rec.external_id = `manual:${slug}-${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  const lookups = makePgLookups(client);
  const decision = await classify(rec, lookups, opts.classifyOpts ?? {});
  const force = Boolean(opts.force);
  if (decision.outcome !== 'new' && !force) {
    /** @type {number[]} */
    const candidates = [];
    if (decision.target && decision.target.id != null) candidates.push(decision.target.id);
    for (const m of decision.matches ?? []) if (!candidates.includes(m)) candidates.push(m);
    return { created: false, id: null, candidates };
  }

  const profileRow = (await client.query(
    'SELECT keywords, phrases, exclude_terms, locations, remote FROM ic_search_profiles WHERE name = $1',
    [input.profile ?? 'exec-default'],
  )).rows[0] ?? {};
  const prescoreRaw = prescore(rec, profileRow);

  const status = Object.prototype.hasOwnProperty.call(input, 'status') ? (input.status ?? null) : 'new';
  // Manual entries always land here as a brand-new row (outcome 'new'), never through the classify()
  // decision's own update/repost/dup branch -- even under `force`, this is a fresh row the human is
  // deliberately adding, not an update of whatever classify() happened to match.
  const insertDecision = { ...decision, outcome: /** @type {const} */ ('new'), inherit: { status, queueReason: null }, rootId: null, repostOf: null, queue: false, reason: null };
  const inserted = await insertListing(client, rec, insertDecision, {
    runId: null, prescore: prescoreRaw, prescoreRaw, noiseClass: 'ok_manual', now,
  });
  const id = inserted.id;

  if (force && decision.outcome !== 'new') {
    // The row was created despite classify() finding a likely match: queue it for human reconciliation
    // rather than silently letting two rows for the same role coexist unflagged.
    const candidates = [decision.target?.id, ...(decision.matches ?? [])].filter((x, i, arr) => x != null && arr.indexOf(x) === i);
    await client.query(
      `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, $2::int[], 'manual_duplicate_forced', $3)`,
      [id, candidates, status],
    );
  } else if (inserted.conflictAnchor !== null) {
    // classify() said 'new' (no candidates above), yet the physical insert still collided with a live
    // row's url_normalized/(source, external_id) and insertListing had to auto-anchor duplicate_of to
    // it -- same defense-in-depth as scan-run.js's applyDecision. Should not happen once classify() and
    // insertListing agree, but never leaves it silent if it does.
    await client.query(
      `INSERT INTO ic_job_review_queue (candidate_id, matches, reason, status_at_create) VALUES ($1, $2::int[], 'insert_conflict_auto_anchored', $3)`,
      [id, [inserted.conflictAnchor], status],
    );
  }

  await recordEvent(client, { listingId: id, kind: 'created', note: input.via ? `via ${String(input.via).slice(0, 200)}` : 'manual entry', actor, at: now });
  if (status !== null) {
    await recordEvent(client, { listingId: id, kind: 'status', fromStatus: null, toStatus: status, actor, at: now });
  }
  return { created: true, id, candidates: [] };
}
