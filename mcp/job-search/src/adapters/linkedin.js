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
import { DETAIL_MIN_CHARS } from '../core/normalize.js';
import { JobSearchError, errFields } from '../core/errors.js';

const BASE = 'https://www.linkedin.com';
export const PAGE_SIZE = 25;

/**
 * Total classifier over every URL form fetchDetail is expected to see (LinkedIn extractor widening item
 * 6c): /jobs/view/<digits>, /jobs/view/<slug>-<digits>, a bare ?currentJobId=<digits> on any path,
 * trailing slash on any of those, and www/mobile/bare linkedin.com hosts. Returns the numeric id as a
 * string, or null for anything else -- an unparseable URL, a non-linkedin.com host, or a recognized host
 * whose path/query carries no extractable id -- which fetchDetail maps to {description:null,
 * reason:'unrecognized_url'} without ever spending a network call or the details budget.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function extractLinkedInJobId(rawUrl) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const q = u.searchParams.get('currentJobId');
  if (q && /^\d+$/.test(q)) return q;
  // Greedy optional "<slug>-" prefix backtracks to the correct split: LinkedIn's own convention is that
  // the id is always the final contiguous digit run in this path segment.
  const m = /^\/jobs\/view\/(?:[a-z0-9-]+-)?(\d+)\/?$/i.exec(u.pathname);
  return m ? m[1] : null;
}

/**
 * Total match check for the voyager response's own id against the id requested (LinkedIn extractor
 * widening item 6c): `jobPostingId` compared as an exact string, or the trailing digit run of
 * `entityUrn` (e.g. "urn:li:fsd_jobPosting:4461489435") compared as an exact string. Neither field
 * present, or neither matching, is a mismatch -- never assumed to match.
 * @param {any} data
 * @param {string} jobId
 */
function voyagerIdMatches(data, jobId) {
  if (data && data.jobPostingId != null && String(data.jobPostingId) === jobId) return true;
  if (data && typeof data.entityUrn === 'string') {
    const m = /(\d+)$/.exec(data.entityUrn);
    if (m && m[1] === jobId) return true;
  }
  return false;
}

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
 * LinkedIn appends its verified-badge text to the title element's accessible text ("<title> with
 * verification"); the linkedinJobCards extractor reads that text.content wholesale, so it arrives here
 * still attached. Stripped at the point the card is parsed (structural fix; normalize.js's
 * cleanTitleText also strips known trailing UI fragments as a config-driven defense in depth for any
 * source, in case this or another adapter ever misses one).
 */
const TITLE_BADGE_RE = /\s+with verification\s*$/i;

/**
 * Map one card from the `linkedinJobCards` extractor. Exported for tests.
 * @param {any} card
 */
export function mapCard(card) {
  const id = card && typeof card.id === 'string' && /^\d{6,}$/.test(card.id) ? card.id : null;
  const title = String(card && card.title ? card.title : '').replace(TITLE_BADGE_RE, '').trim();
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
  pathPatterns: [
    '^/jobs/search/?(\\?|$)', '^/jobs/view/\\d+/?(\\?|$)',
    // Detail-fetch sources A and B (LinkedIn extractor widening item 6b): the logged-in voyager API and
    // the logged-out jobs-guest HTML page, each path-anchored at both ends, digits-only, no query.
    '^/voyager/api/jobs/jobPostings/\\d+/?$', '^/jobs-guest/jobs/api/jobPosting/\\d+/?$',
  ],
  blindSpots: [
    'card selectors in the linkedinJobCards extractor are from prior knowledge; a markup change yields zero cards and the wall classifier reports UNRECOGNIZED_PAGE rather than a login wall',
    'a logged-out profile lands on the authwall; the source is then disabled for 24 h by the cross-run backoff',
    'list cards carry no description or salary; detail fetches count as job views on the account',
    'the hard cap of 3 pages x 25 cards per query bounds recall for broad terms',
    // LinkedIn extractor widening (item 6): the logged-in jobs/view/<id> page now renders with hashed
    // per-build classes and no h1/JSON-LD (confirmed live against job 4461489435), so fetchDetail no
    // longer reads that page's DOM at all. Source A is the logged-in voyager API
    // (/voyager/api/jobs/jobPostings/<id>), read via cap.fetchAuthedJson so the real browser cookie jar
    // supplies the session; source B is the logged-OUT jobs-guest HTML page, read via cap.goto + DOM.
    'source A (voyager) is a private API with no published contract: field names/shape (data.description.text, data.jobPostingId vs data.entityUrn, data.applyMethod) are from a single observed response and could change without notice; a shape drift silently falls through to B rather than throwing',
    'source A requires a JSESSIONID cookie already granted by a real logged-in session; this adapter never signs in and never refreshes an expiring session -- a stale/expired cookie reads as cookieState "valid" (it is present and well-formed) but the API call itself will fail, which this code treats the same as any other non-200/malformed A result: fall back to B',
    'source B (jobs-guest) selectors (.description__text, .show-more-less-html__markup, h2.top-card-layout__title) and the authwall/captcha markers are confirmed against one live document; LinkedIn varying that document by geography, A/B test, or a later markup change is not covered here',
    'the guest apply-link selector was never verified live in this brief (only the description/title selectors were); a markup change there silently yields no externalApplyUrl rather than a crash',
    'neither source is exercised end to end against live LinkedIn by the test suite; tests mock both response shapes from the verified facts, not a real network capture',
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
  /**
   * Total two-source strategy (LinkedIn extractor widening item 6c): the id is extracted from the URL by
   * a closed classifier (extractLinkedInJobId, exported above); an unrecognized URL form never spends a
   * network call or the details budget. Otherwise exactly one detail-budget slot is reserved up front,
   * covering whichever of A/B (or both) this call ends up attempting. Source A (the logged-in voyager
   * API) is attempted only when the session's own JSESSIONID cookie classifies 'valid'; any other cookie
   * state, or an A response that fails ANY of (status 200, JSON parses, its own id equals the requested
   * id, description.text is a string >= DETAIL_MIN_CHARS), falls back to source B (the logged-out
   * jobs-guest HTML page) rather than failing outright.
   * @param {{ url: string|null, url_normalized: string|null }} listing
   * @param {import('./base.js').AdapterCtx} ctx
   */
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    const jobId = url ? extractLinkedInJobId(url) : null;
    if (!jobId) return { description: null, reason: 'unrecognized_url' };
    const cap = await ctx.capFor('linkedin');
    if (!cap) return { description: null };
    await ctx.reserveDetail();

    // Source A: logged-in voyager API, fetched inside the page's own context (cap.fetchAuthedJson) so
    // the real browser cookie jar supplies the session; capability.js classifies the JSESSIONID cookie
    // state itself (this adapter never reads a raw cookie value).
    const voyagerUrl = `${BASE}/voyager/api/jobs/jobPostings/${jobId}`;
    const a = await cap.fetchAuthedJson(voyagerUrl, {
      headers: { accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' },
    });
    if (a.cookieState === 'valid' && a.ok && a.status === 200 && a.json) {
      const data = /** @type {any} */ (a.json.data ?? a.json);
      const descText = data && data.description && typeof data.description.text === 'string' ? data.description.text : null;
      if (voyagerIdMatches(data, jobId) && typeof descText === 'string' && descText.length >= DETAIL_MIN_CHARS) {
        const applyMethod = data.applyMethod ?? {};
        const companyApplyUrl = typeof applyMethod.companyApplyUrl === 'string' ? applyMethod.companyApplyUrl : null;
        const easyApplyUrl = typeof applyMethod.easyApplyUrl === 'string' ? applyMethod.easyApplyUrl : null;
        return {
          description: descText,
          externalApplyUrl: companyApplyUrl,
          easyApplyOnly: Boolean(easyApplyUrl && !companyApplyUrl),
        };
      }
    }

    // Source B: logged-out jobs-guest HTML page, read via a normal navigation + DOM extractor. Total
    // classification of every way this can resolve (item 6 follow-up fix: the adapter must never throw
    // for a fetchable URL -- cap.goto/cap.readJson are not guaranteed-safe the way cap.fetchAuthedJson is):
    //   2xx, selectors matched                          -> description (existing happy/thin-data path)
    //   2xx, zero selectors matched, or authwall/captcha -> reason 'guest_blocked'
    //   404/410, or a goto error mentioning              -> reason 'not_found' (job genuinely gone; a
    //     ERR_HTTP_RESPONSE_CODE_FAILURE                     malformed-body error status can throw instead
    //                                                        of returning a normal Response, observed live)
    //   any other goto/readJson error                    -> reason 'guest_error' with the message
    const guestUrl = `${BASE}/jobs-guest/jobs/api/jobPosting/${jobId}`;
    /** @type {{ status: number|null }|null} */
    let nav = null;
    try {
      nav = await cap.goto(guestUrl);
    } catch (err) {
      if (err instanceof JobSearchError && err.code === 'CANCELLED') throw err;
      const msg = errFields(err).err_message;
      if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(msg)) return { description: null, reason: 'not_found' };
      return { description: null, reason: `guest_error: ${msg}` };
    }
    if (nav && (nav.status === 404 || nav.status === 410)) {
      return { description: null, reason: 'not_found' };
    }
    /** @type {any} */
    let g = null;
    try {
      g = await cap.readJson('linkedinGuestJobDetail');
    } catch (err) {
      if (err instanceof JobSearchError && err.code === 'CANCELLED') throw err;
      return { description: null, reason: `guest_error: ${errFields(err).err_message}` };
    }
    if (!g || g.blocked || !g.matched) {
      return { description: null, reason: 'guest_blocked' };
    }
    const externalApplyUrl = typeof g.applyHref === 'string' ? g.applyHref : null;
    return { description: g.description ?? null, externalApplyUrl, easyApplyOnly: false };
  },
});
