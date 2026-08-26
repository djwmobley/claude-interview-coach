// @ts-check
/**
 * LinkedIn Jobs adapter (CDP scan profile, logged in, via the frozen
 * capability object). Hard cap 3 list pages per query (adapters.json
 * maxPagesPerQuery).
 *
 *   list    GET https://www.linkedin.com/jobs/search/?keywords=<term>&location=<loc>&f_TPR=r<secs>&sortBy=DD[&f_WT=2]&start=<N>
 *   detail  GET https://www.linkedin.com/jobs/view/<id>
 *
 * The list is scrolled through the capability (a read of the rendered
 * list, no clicks) and parsed with the named `linkedinJobCards` extractor.
 * Zero cards yields a `wall` event (login wall, authwall, challenge, or
 * empty state) for the run loop to classify. Detail fetches appear as job
 * views on the logged-in account; they run only under the prescore gate
 * and the details budget.
 */
import { defineAdapter, rawListing, searchTerms, searchLocations, isoDate } from './base.js';

const BASE = 'https://www.linkedin.com';
export const PAGE_SIZE = 25;

/**
 * @param {string} term
 * @param {string} location
 * @param {number} days
 * @param {number} pageIndex 1-based
 * @param {string} remote profile remote setting
 */
export function listUrl(term, location, days, pageIndex, remote = 'any') {
  const u = new URL(`${BASE}/jobs/search/`);
  u.searchParams.set('keywords', term);
  if (location) u.searchParams.set('location', location);
  u.searchParams.set('f_TPR', `r${Math.max(1, Math.min(30, days)) * 86400}`);
  u.searchParams.set('sortBy', 'DD');
  if (remote === 'remote') u.searchParams.set('f_WT', '2');
  else if (remote === 'hybrid') u.searchParams.set('f_WT', '3');
  else if (remote === 'onsite') u.searchParams.set('f_WT', '1');
  if (pageIndex > 1) u.searchParams.set('start', String((pageIndex - 1) * PAGE_SIZE));
  return u.toString();
}

/**
 * Map one card from the `linkedinJobCards` extractor. Exported for tests.
 * @param {any} card
 */
export function mapCard(card) {
  const id = card && typeof card.id === 'string' && /^\d{6,}$/.test(card.id) ? card.id : null;
  const title = String(card && card.title ? card.title : '').trim();
  if (!id || !title) return null;
  const location = card.location ? String(card.location).replace(/\s+/g, ' ').trim() : null;
  const remote = /\bremote\b/i.test(location ?? '') ? 'remote' : /\bhybrid\b/i.test(location ?? '') ? 'hybrid' : null;
  return rawListing({
    source: 'linkedin',
    externalId: id,
    url: `${BASE}/jobs/view/${id}`,
    title,
    company: String(card.company ?? '').replace(/\s+/g, ' ').trim(),
    location: location ? location.replace(/\s*\((remote|hybrid|on-site)\)\s*$/i, '').trim() || null : null,
    remoteMode: remote,
    remoteDeclared: remote !== null,
    postedAt: card.datetime ? isoDate(card.datetime) : null,
    description: null,
  });
}

export const linkedin = defineAdapter({
  name: 'linkedin',
  needsBrowser: true,
  dateOrdered: true,
  domains: ['linkedin.com', 'www.linkedin.com'],
  pathPatterns: ['^/jobs/search/?(\\?|$)', '^/jobs/view/\\d+/?(\\?|$)'],
  blindSpots: [
    'card selectors in the linkedinJobCards extractor are from prior knowledge; a markup change yields zero cards and the wall classifier reports UNRECOGNIZED_PAGE rather than a login wall',
    'a logged-out profile lands on the authwall; the source is then disabled for 24 h by the cross-run backoff',
    'list cards carry no description or salary; detail fetches count as job views on the account',
    'the hard cap of 3 pages x 25 cards per query bounds recall for broad terms',
  ],
  async *search(profile, ctx) {
    const cap = await ctx.capFor('linkedin');
    if (!cap) {
      yield { kind: 'warning', code: 'BROWSER_UNAVAILABLE', message: 'linkedin: scan Chrome unreachable; source skipped' };
      return;
    }
    const terms = searchTerms(profile);
    const locations = searchLocations(profile);
    const days = Math.max(1, Number(profile.posted_within_days || 7));
    const maxPages = Math.min(3, ctx.maxPages);
    for (const term of terms) {
      for (const location of locations) {
        const query = `${term}|${location}`;
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
          await ctx.reservePage();
          const nav = await cap.goto(listUrl(term, location, days, pageIndex, profile.remote));
          await cap.scrollToBottom(6);
          const cardsRaw = /** @type {any[]} */ (await cap.readJson('linkedinJobCards'));
          const cards = Array.isArray(cardsRaw) ? cardsRaw : [];
          if (cards.length === 0) {
            const markers = /** @type {any} */ (await cap.readJson('wallMarkers'));
            const emptyState = Boolean(await cap.readJson('linkedinEmptyState'));
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
          ctx.log({ evt: 'linkedin_list', term, location, page_index: pageIndex, cards: cards.length, parsed });
          const d = yield { kind: 'batch', query, pageIndex, parsed, status: nav.status, url: nav.url };
          if (stop || (d && d.stopQuery) || cards.length < PAGE_SIZE) break;
        }
      }
    }
  },
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    if (!url) return { description: null };
    const cap = await ctx.capFor('linkedin');
    if (!cap) return { description: null };
    await ctx.reserveDetail();
    await cap.goto(url);
    const d = /** @type {any} */ (await cap.readJson('linkedinJobDetail'));
    if (d && typeof d.description === 'string' && d.description.trim()) return { description: d.description };
    const docs = /** @type {any[]} */ (await cap.readJson('readJsonLd'));
    for (const doc of Array.isArray(docs) ? docs : []) {
      if (doc && doc['@type'] === 'JobPosting' && typeof doc.description === 'string' && doc.description.trim()) return { description: doc.description };
    }
    return { description: null };
  },
});
