// @ts-check
/**
 * Workday adapter (fetch, POST): the candidate-experience search endpoint
 * per configured tenant/site, one query per profile term, pages of 20.
 *
 *   list    POST https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 *           body {appliedFacets:{}, limit:20, offset:N, searchText:"<term>"}
 *   detail  GET  https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
 *
 * The POST is the only non-GET this adapter issues and it is one of the two
 * path-scoped exceptions in urlguard.POST_ALLOWED. Bodies are JSON.stringify
 * of a typed object, never string-built. Results come back in relevance
 * order for a search term, so dateOrdered is false.
 */
import { defineAdapter, rawListing, searchTerms, relativeDate, remoteFromText } from './base.js';
import { normalizeUrl } from '../core/normalize.js';

export const PAGE_SIZE = 20;

/**
 * @param {{ tenant: string, site: string, wd: string }} t
 */
export function hostOf(t) {
  return `${t.tenant}.${t.wd}.myworkdayjobs.com`;
}

/**
 * @param {{ tenant: string, site: string, wd: string }} t
 */
export function searchUrl(t) {
  return `https://${hostOf(t)}/wday/cxs/${t.tenant}/${t.site}/jobs`;
}

/**
 * @param {string} term
 * @param {number} offset
 */
export function searchBody(term, offset) {
  /** @type {{ appliedFacets: Record<string, string[]>, limit: number, offset: number, searchText: string }} */
  const body = { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: term };
  return JSON.stringify(body);
}

/**
 * Map one jobPostings entry to a RawListing. Exported for tests.
 * @param {any} jp
 * @param {{ tenant: string, site: string, wd: string, displayName: string }} t
 * @param {Date} now
 */
export function mapPosting(jp, t, now) {
  const ext = typeof jp.externalPath === 'string' ? jp.externalPath : '';
  if (!ext.startsWith('/') || !ext.includes('/job/')) return null;
  const url = `https://${hostOf(t)}/${t.site}${ext}`;
  const n = normalizeUrl(url);
  if (n.kind !== 'canonical') return null;
  const location = typeof jp.locationsText === 'string' ? jp.locationsText.trim() : null;
  const remote = remoteFromText(`${jp.title ?? ''} ${location ?? ''}`);
  const bullets = Array.isArray(jp.bulletFields) ? jp.bulletFields.map(String) : [];
  return rawListing({
    source: 'workday',
    externalId: n.external_id ? n.external_id.replace(/^workday:/, '') : null,
    url,
    title: String(jp.title ?? ''),
    company: t.displayName,
    location,
    remoteMode: remote.remoteMode,
    remoteDeclared: remote.remoteDeclared,
    postedAt: relativeDate(typeof jp.postedOn === 'string' ? jp.postedOn : null, now),
    description: null,
    salaryRaw: bullets.find((b) => /\$\s?\d/.test(b)) ?? null,
  });
}

export const workday = defineAdapter({
  name: 'workday',
  needsBrowser: false,
  dateOrdered: false,
  domains: ['myworkdayjobs.com'],
  pathPatterns: ['^/wday/cxs/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/jobs(\\?|$)', '^/wday/cxs/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/job/.+$', '^/(?:[a-z]{2}-[A-Za-z]{2}/)?[A-Za-z0-9_-]+/job/.+$'],
  blindSpots: [
    'only tenants listed in ats-boards.json are scanned',
    'postedOn is relative text ("Posted 3 Days Ago"); the date is approximate and "30+ Days Ago" becomes 30 days',
    'location facets are not applied; the search term alone drives the query and results are relevance-ordered',
    'the cxs endpoint shape (externalPath, jobPostingInfo) is from prior knowledge and unverified against a live tenant',
  ],
  async *search(profile, ctx) {
    const tenants = ctx.config.atsBoards.workday.filter((t) => t.enabled);
    const terms = searchTerms(profile);
    for (const t of tenants) {
      for (const term of terms) {
        const query = `tenant:${t.tenant}/${t.site}|${term}`;
        for (let pageIndex = 1; pageIndex <= ctx.maxPages; pageIndex++) {
          await ctx.reservePage();
          const res = await ctx.fetchJson(searchUrl(t), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: searchBody(term, (pageIndex - 1) * PAGE_SIZE),
          });
          const j = /** @type {any} */ (res.json);
          const postings = j && Array.isArray(j.jobPostings) ? j.jobPostings : null;
          if (res.status !== 200 || !postings) {
            yield { kind: 'warning', code: res.status === 404 ? 'BOARD_NOT_FOUND' : 'BAD_RESPONSE', message: `workday ${t.tenant}/${t.site}: HTTP ${res.status}`, query };
            yield { kind: 'batch', query, pageIndex, parsed: 0, status: res.status };
            break;
          }
          let parsed = 0;
          let stop = false;
          for (const jp of postings) {
            const l = mapPosting(jp, t, ctx.now);
            if (!l) continue;
            parsed++;
            const d = yield { kind: 'listing', query, pageIndex, listing: l };
            if (d && d.stopQuery) {
              stop = true;
              break;
            }
          }
          ctx.log({ evt: 'workday_page', tenant: t.tenant, page_index: pageIndex, postings: postings.length, total: Number(j.total ?? 0) });
          const d = yield { kind: 'batch', query, pageIndex, parsed, status: res.status };
          const total = Number(j.total ?? 0);
          if (stop || (d && d.stopQuery) || postings.length < PAGE_SIZE || pageIndex * PAGE_SIZE >= total) break;
        }
      }
    }
  },
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    if (!url) return { description: null };
    let u;
    try {
      u = new URL(url);
    } catch {
      return { description: null };
    }
    const m = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(u.hostname);
    const segs = u.pathname.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    if (!m || jobIdx < 1) return { description: null };
    const tenant = m[1].toLowerCase();
    const site = segs[jobIdx - 1];
    const externalPath = '/' + segs.slice(jobIdx).join('/');
    await ctx.reserveDetail();
    const res = await ctx.fetchJson(`https://${u.hostname.toLowerCase()}/wday/cxs/${tenant}/${site}${externalPath}`, { headers: { accept: 'application/json' } });
    const j = /** @type {any} */ (res.json);
    const info = j && j.jobPostingInfo;
    // Auto-apply PR B: a Workday listing's own URL IS the posting/apply page (it already carries the
    // `/job/...` segment src/apply/apply-target.js's isExactTarget() requires) -- surfaced regardless of
    // whether the description fetch itself succeeded.
    if (res.status !== 200 || !info || typeof info.jobDescription !== 'string') return { description: null, externalApplyUrl: url };
    return { description: info.jobDescription, externalApplyUrl: url };
  },
});
