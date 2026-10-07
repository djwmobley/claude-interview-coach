// @ts-check
/**
 * Description phase for gmail-sourced listings (Gmail intake addendum G3, adversary amendments B1, B2, B3,
 * B10). Gmail rows never carried a description, so under unblock-auto-apply A2 none could ever become
 * eligible; this phase runs inside a scan after every source's detail pass and before triage (so the same
 * run's triage scores or rescores what it fetched), and from bin/backfill-detail.js --source=gmail.
 *
 * resolveGmailTarget (pure, total, first match wins):
 *   url null                                               no_link            count only
 *   external_id or url canonical to linkedin:/indeed:      linkedin / indeed  routed: the scan's own
 *                                                                             LinkedIn/Indeed fit sweep fetches
 *                                                                             it with that source's guard,
 *                                                                             browser, and budget
 *                                                                             (src/core/detail-fit-sweep.js)
 *   external_id or url canonical to greenhouse:/workday:/  ats                routed the same way
 *     dayforce:
 *   decodes offline (Mailgun /c/ on a lensa.com host;      decoded            the table again on the decoded
 *     Customer.io /e/c/<base64 JSON>)                                          url (depth 3; deeper: unwrap_loop)
 *   tracker host (lensa SendGrid / Customer.io, Ladders,   network_unwrap     unwrapTracker, then the table
 *     spmailtechnolo, Dice elinks, Customer.io) or                             again on the final url with no
 *     lensa.com/cgw/                                                           further unwrap
 *   path names an account action (unsubscribe, settings,   denied_link        count only, never fetched
 *     profile, login, ...)
 *   remotehunter.com/apply-with-ai/                        denied_apply_link  count only (fork F-G3a)
 *   a dice/lever/oracle canonical id, an eFC .id<digits>   generic            JSON-LD fetch below
 *     job page, a jobs2web /job/<slug>/<digits>/ page
 *   anything else                                          unknown_target     count only
 *   the classification threw                               classify_error     count only
 *
 * unwrapTracker: cookie-less single GETs (never the scan Chrome, so a tracker link never acts as the
 * signed-in user). Before EVERY hop (B3): the host must be exactly a guard domain or a dot-subdomain of one
 * (B10), the path and query must not name an account action (unsubscribe|optout|apply|confirm|verify|
 * preferences|manage...), and one hop is charged to the gmail-route:unwrap daily pool (B10). A Location
 * that leaves the tracker hosts is the destination and is NOT requested. Outcomes (total): resolved,
 * unwrap_loop, too_many_hops, http_<status>, blocked_by_guard, denied_hop, skipped_budget, timeout, error.
 *
 * B1: a listing's own external_id and url_normalized are never rewritten. The resolution lives in
 * ic_gmail_targets (sql/021), cached by the original tracker URL so the same link is never unwrapped twice.
 * Dedupe before spending a detail: when another live listing already carries the canonical id (or url), the
 * gmail row is merged into it (duplicate_of); a description fetched for a match without one is written to
 * that listing, not the gmail row.
 *
 * B2: a row that can never get a description here (no_link, denied_*, unknown_target, a failed unwrap, a
 * routed target with no listing of its own, or empty after detailMaxAttempts) is never silently permanent:
 * at fit 60 or more it is listed in the daily report as a manual-apply item with its job link
 * (collectGmailManualApply) and counted as "stuck ineligible".
 */
import * as cheerio from 'cheerio';
import { normalizeUrl, DETAIL_MIN_CHARS, htmlToText } from './normalize.js';
import { decodeMailgunHref, isLensaHost } from '../adapters/gmail-parsers.js';
import { jobPostingsFromJsonLd } from '../adapters/exec-generic.js';
import { reserveBudget as defaultReserveBudget, refundBudget } from './budget.js';
import { errFields } from './errors.js';

/** Hosts whose links are click trackers to unwrap over the network (never destinations). */
export const TRACKER_HOSTS = Object.freeze(['sg3email.lensa.com', 'email.lensa.com', 't.ladders.co', 'post.spmailtechnolo.com', 'elinks.dice.com', 'e.customeriomail.com']);
/** B3: an account or action word anywhere in a hop's path or query refuses the hop. */
export const ACTION_DENY_RE = /(?:^|[^a-z])(unsubscribe|optout|opt-out|apply|easyapply|confirm|verify|preferences|manage)(?:[^a-z]|$)/i;
/** Row 7: a destination path naming an account page. */
const DENIED_PATH_RE = /(unsubscribe|preferences|settings|opt-?out|profile|account|login|signin)/i;
/** Branches that can never produce a description here (B2). */
export const TERMINAL_OUTCOMES = Object.freeze([
  'no_link', 'denied_link', 'denied_apply_link', 'unknown_target', 'classify_error', 'routed_pending',
  'unwrap_loop', 'too_many_hops', 'blocked_by_guard', 'denied_hop',
]);
const MAX_DECODE_DEPTH = 3;

/**
 * B10: exact host or a dot-subdomain of an allowed domain; never a substring.
 * @param {string} host
 * @param {readonly string[]} domains
 */
export function hostAllowed(host, domains) {
  const h = String(host ?? '').toLowerCase();
  return domains.some((d) => {
    const dd = String(d).toLowerCase();
    return h === dd || h.endsWith(`.${dd}`);
  });
}

/**
 * Customer.io click link `/e/c/<base64url JSON>/<sig>` -> the JSON's `href`, or null.
 * @param {string} url
 * @returns {string|null}
 */
export function decodeCustomerIo(url) {
  try {
    const u = new URL(url);
    const m = /^\/e\/c\/([A-Za-z0-9_-]+={0,2})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    const json = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json?.href === 'string' && /^https?:\/\//i.test(json.href) ? json.href : null;
  } catch {
    return null;
  }
}

/** @param {string} url */
function offlineDecode(url) {
  try {
    const u = new URL(url);
    if (isLensaHost(u.hostname) && u.pathname.startsWith('/c/')) return decodeMailgunHref(url);
    if (u.pathname.startsWith('/e/c/')) return decodeCustomerIo(url);
  } catch {
    return null;
  }
  return null;
}

/** @param {string} url */
function isTracker(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (TRACKER_HOSTS.includes(host)) return true;
    if ((host === 'lensa.com' || host === 'www.lensa.com') && u.pathname.startsWith('/cgw/')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {{ url: string|null, external_id?: string|null }} row
 * @param {{ depth?: number, noUnwrap?: boolean }} [opts]
 * @returns {{ branch: string, url: string|null, canonical?: string|null }}
 */
export function resolveGmailTarget(row, opts = {}) {
  try {
    const depth = opts.depth ?? 0;
    const url = row.url ?? null;
    if (!url) return { branch: 'no_link', url: null };
    const ext = String(row.external_id ?? '');
    const n = normalizeUrl(url);
    const canon = n && n.kind === 'canonical' ? String(n.external_id ?? '') : '';
    const pick = (/** @type {string} */ id) => (id.startsWith('linkedin:') ? 'linkedin' : id.startsWith('indeed:') ? 'indeed'
      : /^(greenhouse|workday|dayforce):/.test(id) ? 'ats' : null);
    const routed = pick(ext) ?? pick(canon);
    if (routed) return { branch: routed, url: n && n.url_normalized ? n.url_normalized : url, canonical: (pick(ext) ? ext : canon) || null };
    const decoded = offlineDecode(url);
    if (decoded) {
      if (depth >= MAX_DECODE_DEPTH) return { branch: 'unwrap_loop', url };
      return resolveGmailTarget({ url: decoded, external_id: null }, { ...opts, depth: depth + 1 });
    }
    if (isTracker(url)) return opts.noUnwrap ? { branch: 'unknown_target', url } : { branch: 'network_unwrap', url };
    const u = new URL(url);
    if (DENIED_PATH_RE.test(u.pathname)) return { branch: 'denied_link', url };
    if (/(^|\.)remotehunter\.com$/i.test(u.hostname) && u.pathname.startsWith('/apply-with-ai/')) return { branch: 'denied_apply_link', url };
    if (/^(dice|lever|oracle):/.test(canon)) return { branch: 'generic', url: n.url_normalized ?? url, canonical: canon };
    if (/(^|\.)efinancialcareers\.com$/i.test(u.hostname) && /\/jobs-[^/]*\.id\d+$/i.test(u.pathname)) return { branch: 'generic', url: `${u.origin}${u.pathname}`, canonical: null };
    if (/^\/(?:[A-Z]+\/)?job\/[^/]+\/\d+\/?$/.test(u.pathname)) return { branch: 'generic', url: `${u.origin}${u.pathname}`, canonical: null };
    return { branch: 'unknown_target', url };
  } catch {
    return { branch: 'classify_error', url: null };
  }
}

/**
 * @typedef {(url: string) => Promise<{ status: number, location: string|null, text: string }>} FetchOnce
 *   one cookie-less GET with redirect: 'manual'; never follows anything itself
 */

/**
 * Follow a tracker link to its destination (see the module doc comment for every rule).
 * @param {string} url
 * @param {{ fetchOnce: FetchOnce, maxHops: number, guardDomains: readonly string[], chargeHop: () => Promise<boolean> }} o
 * @returns {Promise<{ outcome: string, finalUrl: string|null, hops: number }>}
 */
export async function unwrapTracker(url, o) {
  let current = url;
  let hops = 0;
  let metaUsed = false;
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) return { outcome: 'unwrap_loop', finalUrl: null, hops };
    seen.add(current);
    if (hops >= o.maxHops) return { outcome: 'too_many_hops', finalUrl: null, hops };
    /** @type {URL} */
    let u;
    try {
      u = new URL(current);
    } catch {
      return { outcome: 'error', finalUrl: null, hops };
    }
    if (!hostAllowed(u.hostname, o.guardDomains)) return { outcome: 'blocked_by_guard', finalUrl: null, hops };
    if (ACTION_DENY_RE.test(`${u.pathname}${u.search}`)) return { outcome: 'denied_hop', finalUrl: null, hops };
    if (!(await o.chargeHop())) return { outcome: 'skipped_budget', finalUrl: null, hops };
    /** @type {{ status: number, location: string|null, text: string }} */
    let r;
    try {
      r = await o.fetchOnce(current);
    } catch (err) {
      return { outcome: /timeout|abort/i.test(String(errFields(err).err_message ?? '')) ? 'timeout' : 'error', finalUrl: null, hops };
    }
    hops++;
    /** @type {string|null} */
    let next = null;
    if (r.status >= 300 && r.status < 400 && r.location) {
      next = new URL(r.location, current).toString();
    } else if (r.status === 200 && !metaUsed) {
      const m = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i.exec(r.text ?? '');
      if (m) {
        metaUsed = true;
        next = new URL(m[1], current).toString();
      } else {
        return { outcome: 'resolved', finalUrl: current, hops };
      }
    } else if (r.status === 200) {
      return { outcome: 'resolved', finalUrl: current, hops };
    } else {
      return { outcome: `http_${r.status}`, finalUrl: null, hops };
    }
    // B10: a Customer.io-style wrapped Location is decoded and the guard re-checked on the decoded url.
    const decoded = offlineDecode(next);
    if (decoded) next = decoded;
    if (!isTracker(next)) return { outcome: 'resolved', finalUrl: next, hops };
    current = next;
  }
}

/**
 * The first JSON-LD JobPosting description in a page, as plain text; null when none.
 * @param {string} html
 */
export function jobPostingDescription(html) {
  const $ = cheerio.load(String(html ?? ''));
  /** @type {unknown[]} */
  const docs = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      docs.push(JSON.parse($(el).text()));
    } catch {
      /* a malformed block is skipped */
    }
  });
  const jp = jobPostingsFromJsonLd(docs).find((p) => typeof p.description === 'string' && p.description.trim());
  return jp ? htmlToText(String(jp.description)).replace(/[ \t]+/g, ' ').trim() : null;
}

/**
 * @typedef {Object} GmailDetailDeps
 * @property {any} config loaded config (adapters.gmail.detailRouting, adapters['gmail-detail'].domains)
 * @property {Date} now
 * @property {(f: Record<string, unknown>) => void} log
 * @property {FetchOnce} fetchOnce cookie-less single GET (production: the URL guard plus fetch, redirect manual)
 * @property {typeof defaultReserveBudget} [reserveBudget]
 * @property {number} [limit] candidates per call (default 200)
 */

/**
 * The description phase (see the module doc comment). Returns stats.gmail_detail.
 * @param {import('pg').ClientBase} client
 * @param {GmailDetailDeps} deps
 */
export async function runGmailDetail(client, deps) {
  const routing = deps.config?.adapters?.adapters?.gmail?.detailRouting ?? null;
  const guardDomains = deps.config?.adapters?.adapters?.['gmail-detail']?.domains ?? [];
  const stats = {
    enabled: Boolean(routing && routing.enabled !== false), candidates: 0,
    fetched_by: { linkedin: 0, indeed: 0, ats: 0, generic: 0 }, routed: { linkedin: 0, indeed: 0, ats: 0 },
    deduped: 0, empty: 0, error: 0, unwrap_failed: /** @type {Record<string, number>} */ ({}), denied: 0, no_link: 0, unknown: 0,
    deferred: /** @type {Record<string, number>} */ ({}), cache_hits: 0, stuck_ineligible: 0,
  };
  if (!stats.enabled) return stats;
  const reserve = deps.reserveBudget ?? defaultReserveBudget;
  const maxAttempts = routing.detailMaxAttempts ?? 3;
  const genericRun = { used: 0, max: routing.generic?.perRun ?? 30 };
  const bump = (/** @type {Record<string, number>} */ m, /** @type {string} */ k) => { m[k] = (m[k] ?? 0) + 1; };
  const chargeHop = async () => (await reserve(client, 'gmail-route:unwrap', { details: 1 }, { dailyPages: 0, dailyDetails: routing.unwrapPerDay ?? 300 }, deps.now)).ok;

  const rows = (await client.query(
    `SELECT l.id, l.url, l.external_id, l.fit_score, l.detail_attempts
       FROM ic_job_listings l
      WHERE l.source = 'gmail' AND coalesce(l.record_kind,'listing') = 'listing' AND l.duplicate_of IS NULL AND l.expired_at IS NULL
        AND (l.status IS NULL OR l.status IN ('new','maybe','shortlisted'))
        AND (l.description IS NULL OR btrim(l.description) = '')
        AND l.detail_attempts < $1
        AND NOT EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id AND a.state <> 'withdrawn')
      ORDER BY l.fit_score DESC NULLS LAST, l.prescore DESC NULLS LAST, l.first_seen DESC NULLS LAST, l.id ASC
      LIMIT $2`,
    [maxAttempts, deps.limit ?? 200],
  )).rows;
  stats.candidates = rows.length;

  for (const row of rows) {
    const id = Number(row.id);
    /** @type {{ final: string|null, branch: string, canonical: string|null, outcome: string }} */
    const rec = { final: null, branch: 'unknown_target', canonical: null, outcome: 'unknown_target' };
    try {
      let t = resolveGmailTarget({ url: row.url, external_id: row.external_id });
      if (t.branch === 'network_unwrap') {
        const cached = (await client.query(
          `SELECT final_url FROM ic_gmail_targets WHERE original_url = $1 AND final_url IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [row.url],
        )).rows[0];
        /** @type {string|null} */
        let final = cached ? String(cached.final_url) : null;
        if (final) stats.cache_hits++;
        else {
          const u = await unwrapTracker(String(t.url), { fetchOnce: deps.fetchOnce, maxHops: routing.maxHops ?? 5, guardDomains, chargeHop });
          if (u.outcome !== 'resolved' || !u.finalUrl) {
            rec.branch = 'network_unwrap';
            rec.outcome = u.outcome;
            if (u.outcome === 'skipped_budget') bump(stats.deferred, 'unwrap_budget');
            else bump(stats.unwrap_failed, u.outcome);
            await saveTarget(client, id, row.url, rec);
            continue;
          }
          final = u.finalUrl;
        }
        rec.final = final;
        t = resolveGmailTarget({ url: final, external_id: null }, { noUnwrap: true });
      }
      rec.branch = t.branch;
      rec.canonical = t.canonical ?? null;
      rec.final = rec.final ?? t.url;

      if (t.branch === 'no_link') { stats.no_link++; rec.outcome = 'no_link'; await saveTarget(client, id, row.url, rec); continue; }
      if (t.branch === 'denied_link' || t.branch === 'denied_apply_link') { stats.denied++; rec.outcome = t.branch; await saveTarget(client, id, row.url, rec); continue; }
      if (t.branch === 'unknown_target' || t.branch === 'classify_error' || t.branch === 'unwrap_loop') {
        if (t.branch === 'unwrap_loop') bump(stats.unwrap_failed, 'unwrap_loop'); else stats.unknown++;
        rec.outcome = t.branch;
        await saveTarget(client, id, row.url, rec);
        continue;
      }

      // Dedupe on the canonical id or url before spending a detail (B1: never rewrite this row's ids).
      const match = await findCanonicalMatch(client, id, rec.canonical, rec.final);
      if (match && match.has_description) {
        await mergeInto(client, id, Number(match.id));
        stats.deduped++;
        rec.outcome = 'deduped_existing';
        await saveTarget(client, id, row.url, rec);
        continue;
      }
      if (t.branch === 'linkedin' || t.branch === 'indeed' || t.branch === 'ats') {
        stats.routed[t.branch]++;
        if (match) {
          // The matching listing has no description yet: its own source's detail pass fetches it; this
          // gmail row merges into it so the job is one row.
          await mergeInto(client, id, Number(match.id));
          stats.deduped++;
          rec.outcome = 'deduped_existing';
        } else {
          // A row whose own external_id is canonical is fetched by that source's fit sweep; an unwrapped
          // target with no listing of its own cannot be fetched from here (B2 lists it at fit 60+).
          rec.outcome = rec.canonical && row.external_id === rec.canonical ? 'routed_sweep' : 'routed_pending';
          if (rec.outcome === 'routed_pending') bump(stats.deferred, 'routed_no_listing');
        }
        await saveTarget(client, id, row.url, rec);
        continue;
      }

      // generic: per-run then per-day caps, then one cookie-less fetch of the job page.
      if (genericRun.used >= genericRun.max) { bump(stats.deferred, 'skipped_run_cap'); rec.outcome = 'skipped_run_cap'; await saveTarget(client, id, row.url, rec); continue; }
      const day = await reserve(client, 'gmail-route:generic', { details: 1 }, { dailyPages: 0, dailyDetails: routing.generic?.perDay ?? 60 }, deps.now);
      if (!day.ok) { bump(stats.deferred, 'skipped_budget'); rec.outcome = 'skipped_budget'; await saveTarget(client, id, row.url, rec); continue; }
      genericRun.used++;
      const targetId = match ? Number(match.id) : id;
      const page = new URL(String(rec.final));
      if (!hostAllowed(page.hostname, guardDomains) || ACTION_DENY_RE.test(`${page.pathname}${page.search}`)) {
        await refundBudget(client, 'gmail-route:generic', { details: 1 }, deps.now);
        bump(stats.unwrap_failed, 'blocked_by_guard');
        rec.outcome = 'blocked_by_guard';
        await saveTarget(client, id, row.url, rec);
        continue;
      }
      /** @type {string|null} */
      let description = null;
      let failed = false;
      try {
        const r = await deps.fetchOnce(String(rec.final));
        if (r.status === 200) description = jobPostingDescription(r.text);
        else failed = true;
      } catch (err) {
        failed = true;
        deps.log({ evt: 'gmail_detail_fetch_failed', listing_id: id, ...errFields(err) });
      }
      const outcome = failed ? 'error' : description && description.length >= DETAIL_MIN_CHARS ? 'fetched' : 'empty';
      await client.query(
        `UPDATE ic_job_listings SET description = CASE WHEN $2 = 'fetched' THEN $3 ELSE description END, detail_outcome = $2,
                detail_attempts = detail_attempts + 1 WHERE id = $1`,
        [targetId, outcome, description],
      );
      if (targetId !== id) {
        await client.query('UPDATE ic_job_listings SET detail_attempts = detail_attempts + 1 WHERE id = $1', [id]);
        if (outcome === 'fetched') await mergeInto(client, id, targetId);
      }
      if (outcome === 'fetched') stats.fetched_by.generic++;
      else if (outcome === 'empty') stats.empty++;
      else stats.error++;
      rec.outcome = outcome;
      await saveTarget(client, id, row.url, rec);
    } catch (err) {
      deps.log({ evt: 'gmail_detail_row_failed', listing_id: id, ...errFields(err) });
      bump(stats.deferred, 'row_error');
    }
  }
  stats.stuck_ineligible = (await collectGmailManualApply(client, { limit: 1000 })).length;
  return stats;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {string|null} originalUrl
 * @param {{ final: string|null, branch: string, canonical: string|null, outcome: string }} rec
 */
async function saveTarget(client, listingId, originalUrl, rec) {
  await client.query(
    `INSERT INTO ic_gmail_targets (listing_id, original_url, final_url, canonical_external_id, branch, outcome, attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, now())
     ON CONFLICT (listing_id) DO UPDATE SET original_url = EXCLUDED.original_url, final_url = coalesce(EXCLUDED.final_url, ic_gmail_targets.final_url),
       canonical_external_id = coalesce(EXCLUDED.canonical_external_id, ic_gmail_targets.canonical_external_id), branch = EXCLUDED.branch,
       outcome = EXCLUDED.outcome, attempts = ic_gmail_targets.attempts + 1, updated_at = now()`,
    [listingId, originalUrl, rec.final, rec.canonical, rec.branch, rec.outcome],
  );
}

/**
 * Another live listing with the same canonical id or url, if any.
 * @param {import('pg').ClientBase} client
 * @param {number} selfId
 * @param {string|null} canonical
 * @param {string|null} url
 */
async function findCanonicalMatch(client, selfId, canonical, url) {
  if (!canonical && !url) return null;
  const r = await client.query(
    `SELECT id, (description IS NOT NULL AND btrim(description) <> '') AS has_description FROM ic_job_listings
      WHERE id <> $1 AND duplicate_of IS NULL AND expired_at IS NULL AND coalesce(record_kind,'listing') = 'listing'
        AND (($2::text IS NOT NULL AND external_id = $2) OR ($3::text IS NOT NULL AND url_normalized = $3))
      ORDER BY (source <> 'gmail') DESC, id ASC LIMIT 1`,
    [selfId, canonical, url],
  );
  return r.rows[0] ?? null;
}

/**
 * Merge a gmail row into the listing that already represents the same job (duplicate_of), with an event.
 * @param {import('pg').ClientBase} client
 * @param {number} gmailId
 * @param {number} intoId
 */
async function mergeInto(client, gmailId, intoId) {
  await client.query('UPDATE ic_job_listings SET duplicate_of = $2 WHERE id = $1 AND duplicate_of IS NULL', [gmailId, intoId]);
  await client.query(
    `INSERT INTO ic_job_events (listing_id, kind, note, actor) VALUES ($1, 'note', $2, 'auto')`,
    [gmailId, `gmail detail: same job as listing ${intoId} (canonical match); merged`],
  ).catch(() => {});
}

/**
 * B2: gmail rows that cannot get a description here and are worth a human look (fit 60+): every terminal
 * resolve outcome, or empty/error after the attempt cap. Listed in the daily report with the job link.
 * @param {import('pg').ClientBase} client
 * @param {{ limit?: number, fitFloor?: number, maxAttempts?: number }} [o]
 * @returns {Promise<Array<{ id: number, title: string|null, company: string|null, fit: number|null, link: string|null, outcome: string }>>}
 */
export async function collectGmailManualApply(client, o = {}) {
  const r = await client.query(
    `SELECT l.id, l.title, l.company, l.fit_score, coalesce(t.final_url, l.url) AS link, coalesce(t.outcome, l.detail_outcome, 'unknown') AS outcome
       FROM ic_job_listings l LEFT JOIN ic_gmail_targets t ON t.listing_id = l.id
      WHERE l.source = 'gmail' AND coalesce(l.record_kind,'listing') = 'listing' AND l.duplicate_of IS NULL AND l.expired_at IS NULL
        AND (l.status IS NULL OR l.status IN ('new','maybe','shortlisted')) AND l.fit_score >= $1
        AND (l.description IS NULL OR btrim(l.description) = '')
        AND NOT EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id AND a.state <> 'withdrawn')
        AND (t.outcome = ANY($2::text[]) OR t.outcome LIKE 'http_%' OR (l.detail_attempts >= $3 AND coalesce(l.detail_outcome,'') IN ('empty','error')))
      ORDER BY l.fit_score DESC, l.id ASC LIMIT $4`,
    [o.fitFloor ?? 60, [...TERMINAL_OUTCOMES], o.maxAttempts ?? 3, o.limit ?? 50],
  );
  return r.rows.map((x) => ({ id: Number(x.id), title: x.title ?? null, company: x.company ?? null, fit: x.fit_score === null ? null : Number(x.fit_score), link: x.link ?? null, outcome: String(x.outcome) }));
}
