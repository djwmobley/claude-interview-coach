// @ts-check
/**
 * Indeed adapter (CDP scan profile via the frozen capability object).
 *
 *   list    GET https://www.indeed.com/jobs?q=<term>&l=<loc>&fromage=<days>&sort=date&start=<N>
 *   detail  GET https://www.indeed.com/viewjob?jk=<jk>
 *
 * List parsing: the named `indeedMosaicJobs` extractor (window.mosaic
 * provider data) with the `indeedDomJobs` DOM fallback. When a list renders
 * zero cards the adapter emits a `wall` event with the wall markers and
 * empty-state flag; the run loop classifies it. Pagination is URL
 * construction only (start=10, 20, ...). Results are date-sorted so the
 * scheduler may stop a query on stale results.
 */
import { defineAdapter, rawListing, searchTerms, searchLocations, isoDate } from './base.js';

const BASE = 'https://www.indeed.com';
export const PAGE_SIZE = 10;

/**
 * @param {string} term
 * @param {string} location
 * @param {number} days
 * @param {number} pageIndex 1-based
 */
export function listUrl(term, location, days, pageIndex) {
  const u = new URL(`${BASE}/jobs`);
  u.searchParams.set('q', term);
  if (location) u.searchParams.set('l', location);
  u.searchParams.set('fromage', String(Math.max(1, Math.min(30, days))));
  u.searchParams.set('sort', 'date');
  if (pageIndex > 1) u.searchParams.set('start', String((pageIndex - 1) * PAGE_SIZE));
  return u.toString();
}

/**
 * Map a card from either extractor to a RawListing. Exported for tests.
 * @param {any} card
 */
export function mapCard(card) {
  const jk = card && typeof card.jobkey === 'string' ? card.jobkey.toLowerCase() : null;
  if (!jk || !/^[0-9a-f]{8,}$/.test(jk)) return null;
  const title = String(card.title ?? '').trim();
  if (!title) return null;
  const location = card.location ? String(card.location).trim() : null;
  const remote = card.remote === true || /\bremote\b/i.test(location ?? '');
  return rawListing({
    source: 'indeed',
    externalId: jk,
    url: `${BASE}/viewjob?jk=${jk}`,
    title,
    company: String(card.company ?? '').trim(),
    location,
    remoteMode: remote ? 'remote' : null,
    remoteDeclared: card.remote === true,
    postedAt: typeof card.postedMs === 'number' ? isoDate(card.postedMs) : null,
    salaryRaw: card.salaryText ? String(card.salaryText).slice(0, 200) : null,
    description: null,
  });
}

export const indeed = defineAdapter({
  name: 'indeed',
  needsBrowser: true,
  dateOrdered: true,
  domains: ['indeed.com', 'www.indeed.com'],
  pathPatterns: ['^/jobs(\\?|$)', '^/viewjob(\\?|$)', '^/m/jobs(\\?|$)'],
  blindSpots: [
    'the mosaic provider-data shape and the DOM fallback selectors are from prior knowledge; a markup change yields zero cards, which the wall classifier reports as UNRECOGNIZED_PAGE',
    'list cards carry no description; detail fetches (prescore gate, details budget) appear as job views on the scan profile',
    'sponsored cards and duplicate-company reposts are indistinguishable on the list; dedup handles them after the fact',
  ],
  async *search(profile, ctx) {
    const cap = await ctx.capFor('indeed');
    if (!cap) {
      yield { kind: 'warning', code: 'BROWSER_UNAVAILABLE', message: 'indeed: scan Chrome unreachable; source skipped' };
      return;
    }
    const terms = searchTerms(profile);
    const locations = searchLocations(profile);
    const days = Math.max(1, Number(profile.posted_within_days || 7));
    for (const term of terms) {
      for (const location of locations) {
        const query = `${term}|${location}`;
        for (let pageIndex = 1; pageIndex <= ctx.maxPages; pageIndex++) {
          await ctx.reservePage();
          const nav = await cap.goto(listUrl(term, location, days, pageIndex));
          let cards = /** @type {any[]|null} */ (await cap.readJson('indeedMosaicJobs'));
          if (!Array.isArray(cards) || cards.length === 0) {
            const dom = /** @type {any[]} */ (await cap.readJson('indeedDomJobs'));
            cards = Array.isArray(dom) ? dom : [];
          }
          if (cards.length === 0) {
            const markers = /** @type {any} */ (await cap.readJson('wallMarkers'));
            const emptyState = Boolean(await cap.readJson('indeedEmptyState'));
            yield { kind: 'wall', query, pageIndex, signals: { parsed: 0, status: nav.status, cfMitigated: nav.cfMitigated, url: nav.url, challengeCloudflare: !!markers.challengeCloudflare, challengeForm: !!markers.challengeForm, recaptcha: !!markers.recaptcha, emptyState } };
            yield { kind: 'batch', query, pageIndex, parsed: 0, status: nav.status, url: nav.url };
            break;
          }
          let parsed = 0;
          let stop = false;
          for (const card of cards) {
            const l = mapCard(card);
            if (!l) continue;
            parsed++;
            const d = yield { kind: 'listing', query, pageIndex, listing: l };
            if (d && d.stopQuery) {
              stop = true;
              break;
            }
          }
          ctx.log({ evt: 'indeed_list', term, location, page_index: pageIndex, cards: cards.length, parsed });
          const d = yield { kind: 'batch', query, pageIndex, parsed, status: nav.status, url: nav.url };
          if (stop || (d && d.stopQuery) || cards.length < PAGE_SIZE) break;
        }
      }
    }
  },
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    if (!url) return { description: null };
    const cap = await ctx.capFor('indeed');
    if (!cap) return { description: null };
    await ctx.reserveDetail();
    await cap.goto(url);
    // Auto-apply PR B: Indeed's own Easy Apply ("applystart") flow never navigates externally -- observed
    // here, never clicked. An "Apply on company site" anchor off indeed.com is surfaced as externalApplyUrl.
    /** @type {any} */
    let applyState = null;
    try {
      applyState = await cap.readJson('indeedApplyState');
    } catch {
      applyState = null;
    }
    const externalApplyUrl = applyState && typeof applyState.href === 'string' ? applyState.href : null;
    const easyApplyOnly = Boolean(applyState ? applyState.easyApplyOnly : true);
    const docs = /** @type {any[]} */ (await cap.readJson('readJsonLd'));
    for (const d of Array.isArray(docs) ? docs : []) {
      const nodes = Array.isArray(d) ? d : [d];
      for (const n of nodes) {
        if (n && n['@type'] === 'JobPosting' && typeof n.description === 'string' && n.description.trim()) {
          return { description: n.description, externalApplyUrl, easyApplyOnly };
        }
      }
    }
    const text = /** @type {string} */ (await cap.readJson('bodyText'));
    return { description: text && text.trim() ? text : null, externalApplyUrl, easyApplyOnly };
  },
});
