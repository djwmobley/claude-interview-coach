// @ts-check
/**
 * Lever adapter (fetch): api.lever.co postings JSON per configured company,
 * client-side title filter. Pages of 100 via skip/limit; the API orders
 * postings alphabetically by title, so the scheduler must not apply the
 * stale-stop rule (dateOrdered false).
 *
 *   list  GET https://api.lever.co/v0/postings/<company>?mode=json&limit=100&skip=N
 */
import { defineAdapter, rawListing, titleMatches, isoDate, remoteFromText } from './base.js';

const API = 'https://api.lever.co/v0/postings';
export const PAGE_SIZE = 100;

/**
 * @param {string} company
 * @param {number} skip
 */
export function listUrl(company, skip) {
  const u = new URL(`${API}/${encodeURIComponent(company)}`);
  u.searchParams.set('mode', 'json');
  u.searchParams.set('limit', String(PAGE_SIZE));
  if (skip > 0) u.searchParams.set('skip', String(skip));
  return u.toString();
}

/**
 * Map one posting to a RawListing. Exported for tests.
 * @param {any} p
 * @param {{ company: string, displayName: string }} c
 */
export function mapPosting(p, c) {
  const id = p && typeof p.id === 'string' ? p.id.toLowerCase() : null;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const cats = p.categories && typeof p.categories === 'object' ? p.categories : {};
  const location = typeof cats.location === 'string' ? cats.location.trim() : null;
  const wt = typeof p.workplaceType === 'string' ? p.workplaceType.toLowerCase() : '';
  const remote = wt === 'remote' ? { remoteMode: /** @type {const} */ ('remote'), remoteDeclared: true }
    : wt === 'hybrid' ? { remoteMode: /** @type {const} */ ('hybrid'), remoteDeclared: true }
      : wt === 'onsite' || wt === 'on-site' ? { remoteMode: /** @type {const} */ ('onsite'), remoteDeclared: true }
        : remoteFromText(`${p.text ?? ''} ${location ?? ''}`);
  let salaryRaw = null;
  let salaryMin = null;
  let salaryMax = null;
  if (p.salaryRange && typeof p.salaryRange === 'object') {
    const sr = p.salaryRange;
    if (Number.isFinite(Number(sr.min)) && Number.isFinite(Number(sr.max)) && String(sr.interval ?? 'per-year-salary').includes('year')) {
      salaryMin = Math.round(Number(sr.min));
      salaryMax = Math.round(Number(sr.max));
      salaryRaw = `${sr.currency ?? 'USD'} ${salaryMin}-${salaryMax} ${sr.interval ?? ''}`.trim();
    }
  } else if (typeof p.salaryDescriptionPlain === 'string' && p.salaryDescriptionPlain.trim()) {
    salaryRaw = p.salaryDescriptionPlain.trim().slice(0, 300);
  }
  const hosted = typeof p.hostedUrl === 'string' && /^https:\/\/jobs\.lever\.co\//i.test(p.hostedUrl) ? p.hostedUrl : `https://jobs.lever.co/${c.company}/${id}`;
  return rawListing({
    source: 'lever',
    externalId: `${c.company}/${id}`,
    url: hosted,
    title: String(p.text ?? ''),
    company: c.displayName,
    location,
    remoteMode: remote.remoteMode,
    remoteDeclared: remote.remoteDeclared,
    postedAt: isoDate(typeof p.createdAt === 'number' ? p.createdAt : null),
    salaryRaw,
    salaryMin,
    salaryMax,
    description: typeof p.descriptionPlain === 'string' && p.descriptionPlain.trim() ? p.descriptionPlain : null,
  });
}

export const lever = defineAdapter({
  name: 'lever',
  needsBrowser: false,
  dateOrdered: false,
  domains: ['api.lever.co', 'jobs.lever.co'],
  pathPatterns: ['^/v0/postings/[a-z0-9-]+(\\?|$)', '^/[a-z0-9-]+/[0-9a-f-]{36}/?(\\?|$)'],
  blindSpots: [
    'only companies listed in ats-boards.json are scanned',
    'postings are alphabetical, so a company with more than maxPages x 100 postings is scanned only through its first pages',
    'title filter is a substring match; salary appears only when the posting carries a structured salaryRange',
  ],
  async *search(profile, ctx) {
    const companies = ctx.config.atsBoards.lever.filter((c) => c.enabled);
    for (const c of companies) {
      const query = `company:${c.company}`;
      for (let pageIndex = 1; pageIndex <= ctx.maxPages; pageIndex++) {
        await ctx.reservePage();
        const res = await ctx.fetchJson(listUrl(c.company, (pageIndex - 1) * PAGE_SIZE));
        const postings = Array.isArray(res.json) ? res.json : null;
        if (res.status !== 200 || !postings) {
          yield { kind: 'warning', code: res.status === 404 ? 'BOARD_NOT_FOUND' : 'BAD_RESPONSE', message: `lever company ${c.company}: HTTP ${res.status}`, query };
          yield { kind: 'batch', query, pageIndex, parsed: 0, status: res.status };
          break;
        }
        let parsed = 0;
        let stop = false;
        for (const p of postings) {
          const l = mapPosting(p, c);
          if (!l || !titleMatches(l.title, profile)) continue;
          parsed++;
          const d = yield { kind: 'listing', query, pageIndex, listing: l };
          if (d && d.stopQuery) {
            stop = true;
            break;
          }
        }
        ctx.log({ evt: 'lever_page', company: c.company, page_index: pageIndex, postings: postings.length, matched: parsed });
        const d = yield { kind: 'batch', query, pageIndex, parsed, status: res.status };
        if (stop || (d && d.stopQuery) || postings.length < PAGE_SIZE) break;
      }
    }
  },
});
