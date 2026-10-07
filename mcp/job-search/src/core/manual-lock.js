// @ts-check
/**
 * Manual-only lockout (Ready to apply list R8, amendments A1, A2, A4). Once a listing has been DISPLAYED
 * to Damian in the Ready list (ready or held, A1), he may apply to it by hand at any moment, so no
 * unattended path may submit to it afterwards: not the scheduled auto-apply select, not the click-time
 * submit gate, not the assisted Easy Apply worker or its draft step. Only Damian lifts it, with the
 * dashboard's explicit "hand back" button, which is logged as a listing event.
 *
 * Matching (lockMatches, A2), any one is enough:
 *   - the same listing, or the same dedup root (rows collapsed by duplicate_of inherit the lock);
 *   - a shared normalized target URL (src/core/ready-link.js normalizeTargetKey over the listing URL,
 *     apply_url, manual_apply_url, and the Gmail final URL);
 *   - for real employers: the same company_norm AND title_norm;
 *   - for placeholder companies (blank, stoplisted, confidential, recruiter-shaped; isPlaceholderCompany):
 *     never company/title alone; the same title_norm AND (a shared URL key OR the same usable location).
 *
 * One lock row per listing, ever: writeManualLocks skips a listing that already has ANY lock row (active
 * or released), so a handed-back listing is not re-locked by its own next display. Hand back releases
 * every active lock that matches the listing and leaves a released marker row for it.
 */
import { isUnknownCompany, walkDuplicateRoot } from '../apply/exclusions.js';
import { recordEvent } from './events.js';
import { normalizeTargetKey } from './ready-link.js';

/** Recruiter or staffing-agency company names: the real employer is hidden behind them (A2). Heuristic. */
const RECRUITER_RE = /\b(recruit(?:ing|ers?|ment)?|staffing|headhunt\w*|executive search|search (?:group|partners|firm)|talent (?:partners|solutions|acquisition))\b/i;

/**
 * @param {string|null|undefined} company
 * @param {string|null|undefined} companyNorm
 * @returns {boolean}
 */
export function isPlaceholderCompany(company, companyNorm) {
  const norm = String(companyNorm ?? '');
  if (isUnknownCompany(company ?? null, norm)) return true;
  return RECRUITER_RE.test(String(company ?? '')) || RECRUITER_RE.test(norm);
}

/** @param {string|null|undefined} loc */
function usableLocation(loc) {
  const l = String(loc ?? '').trim().toLowerCase();
  return Boolean(l) && l !== 'absent' && l !== 'legacy-unknown' && !l.startsWith('unknown:');
}

/**
 * @typedef {Object} LockSubject
 * @property {number} listingId
 * @property {number} rootListingId
 * @property {string|null} companyNorm
 * @property {string|null} titleNorm
 * @property {string|null} locationNorm
 * @property {boolean} placeholder
 * @property {string[]} urlKeys
 */

/**
 * @param {{ id: number|string, root_listing_id?: number|string|null, duplicate_of?: number|string|null, company?: string|null, company_norm?: string|null,
 *   title_norm?: string|null, location_norm?: string|null, urls?: Array<string|null|undefined> }} row
 * @returns {LockSubject}
 */
export function lockSubjectFromRow(row) {
  const id = Number(row.id);
  const root = row.root_listing_id !== null && row.root_listing_id !== undefined ? Number(row.root_listing_id)
    : row.duplicate_of !== null && row.duplicate_of !== undefined ? Number(row.duplicate_of) : id;
  const keys = new Set();
  for (const u of row.urls ?? []) {
    const k = normalizeTargetKey(u ?? null);
    if (k) keys.add(k);
  }
  return {
    listingId: id,
    rootListingId: root,
    companyNorm: row.company_norm ?? null,
    titleNorm: row.title_norm ?? null,
    locationNorm: row.location_norm ?? null,
    placeholder: isPlaceholderCompany(row.company ?? null, row.company_norm ?? null),
    urlKeys: [...keys],
  };
}

/**
 * @param {LockSubject} lock
 * @param {LockSubject} s
 * @returns {boolean}
 */
export function lockMatches(lock, s) {
  if (lock.listingId === s.listingId) return true;
  const lockIds = [lock.listingId, lock.rootListingId];
  if (lockIds.includes(s.listingId) || lockIds.includes(s.rootListingId)) return true;
  const sharedUrl = lock.urlKeys.some((k) => s.urlKeys.includes(k));
  if (sharedUrl) return true;
  const sameTitle = Boolean(lock.titleNorm) && lock.titleNorm === s.titleNorm;
  if (!sameTitle) return false;
  if (lock.placeholder || s.placeholder) {
    return usableLocation(lock.locationNorm) && lock.locationNorm === s.locationNorm;
  }
  return Boolean(lock.companyNorm) && lock.companyNorm === s.companyNorm;
}

/** @param {any} r @returns {LockSubject & { id: number, bucket: string }} */
function lockFromRow(r) {
  return {
    id: Number(r.id), bucket: String(r.bucket),
    listingId: Number(r.listing_id), rootListingId: Number(r.root_listing_id),
    companyNorm: r.company_norm ?? null, titleNorm: r.title_norm ?? null, locationNorm: r.location_norm ?? null,
    placeholder: Boolean(r.placeholder), urlKeys: Array.isArray(r.url_keys) ? r.url_keys.map(String) : [],
  };
}

/**
 * @param {import('pg').ClientBase} client
 * @returns {Promise<Array<LockSubject & { id: number, bucket: string }>>}
 */
export async function loadActiveManualLocks(client) {
  const r = await client.query('SELECT * FROM ic_manual_only_locks WHERE released_at IS NULL ORDER BY id');
  return r.rows.map(lockFromRow);
}

/** SQL selecting every field lockSubjectFromRow needs, for listing alias l. */
export const LOCK_SUBJECT_SELECT = `l.id, l.duplicate_of, l.company, l.company_norm, l.title_norm, l.location_norm, l.url, l.url_normalized, l.apply_url, l.manual_apply_url,
  (SELECT t.final_url FROM ic_gmail_targets t WHERE t.listing_id = l.id) AS gmail_final_url`;

/** @param {any} row */
export function lockSubjectFromListingRow(row) {
  return lockSubjectFromRow({ ...row, urls: [row.url_normalized, row.url, row.apply_url, row.manual_apply_url, row.gmail_final_url] });
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @returns {Promise<LockSubject|null>}
 */
export async function loadLockSubject(client, listingId) {
  const r = await client.query(`SELECT ${LOCK_SUBJECT_SELECT} FROM ic_job_listings l WHERE l.id = $1`, [listingId]);
  if (r.rowCount === 0) return null;
  const s = lockSubjectFromListingRow(r.rows[0]);
  if (r.rows[0].duplicate_of !== null && r.rows[0].duplicate_of !== undefined) s.rootListingId = await walkDuplicateRoot(client, listingId);
  return s;
}

/**
 * The active lock covering `listingId`, or null. Locks may be passed in when the caller already loaded them.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {Array<LockSubject & { id: number, bucket: string }>} [locks]
 */
export async function findManualLock(client, listingId, locks) {
  const subject = await loadLockSubject(client, listingId);
  if (!subject) return null;
  const all = locks ?? await loadActiveManualLocks(client);
  return all.find((l) => lockMatches(l, subject)) ?? null;
}

/**
 * Write a lock for each entry whose listing has never had one (A1: first display). Returns rows written.
 * @param {import('pg').ClientBase} client
 * @param {Array<{ subject: LockSubject, bucket: string }>} entries
 * @param {Date} now
 */
export async function writeManualLocks(client, entries, now) {
  let written = 0;
  for (const e of entries) {
    const s = e.subject;
    const r = await client.query(
      `INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, company_norm, title_norm, location_norm, placeholder, url_keys, bucket, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7::text[], $8, $9
        WHERE NOT EXISTS (SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1)
       ON CONFLICT DO NOTHING`,
      [s.listingId, s.rootListingId, s.companyNorm, s.titleNorm, s.locationNorm, s.placeholder, s.urlKeys, e.bucket, now],
    );
    written += r.rowCount ?? 0;
  }
  return written;
}

/**
 * Damian's explicit hand back (R8): releases every active lock matching the listing, leaves a released
 * marker row for the listing itself, and records a listing event. Returns how many active locks it released.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {{ actor: 'dashboard'|'cli'|'mcp', now: Date, note?: string }} o
 */
export async function handBackManualLock(client, listingId, o) {
  const subject = await loadLockSubject(client, listingId);
  if (!subject) return { released: 0, found: false };
  const locks = await loadActiveManualLocks(client);
  const matching = locks.filter((l) => lockMatches(l, subject));
  const note = o.note ?? 'manual-only lockout handed back from the dashboard';
  if (matching.length) {
    await client.query(
      'UPDATE ic_manual_only_locks SET released_at = $2, released_by = $3, release_note = $4 WHERE id = ANY($1::int[]) AND released_at IS NULL',
      [matching.map((l) => l.id), o.now, o.actor, note],
    );
  }
  await client.query(
    `INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, company_norm, title_norm, location_norm, placeholder, url_keys, bucket, created_at, released_at, released_by, release_note)
     SELECT $1, $2, $3, $4, $5, $6, $7::text[], 'handed_back', $8, $8, $9, $10
      WHERE NOT EXISTS (SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1)`,
    [subject.listingId, subject.rootListingId, subject.companyNorm, subject.titleNorm, subject.locationNorm, subject.placeholder, subject.urlKeys, o.now, o.actor, note],
  );
  await recordEvent(client, { listingId, kind: 'note', note: `${note} (released ${matching.length} lock${matching.length === 1 ? '' : 's'}: ${matching.map((l) => `#${l.listingId}`).join(', ') || 'none active'})`, actor: o.actor });
  return { released: matching.length, found: true, lockedListingIds: matching.map((l) => l.listingId) };
}
