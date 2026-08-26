// @ts-check
/**
 * Dayforce adapter (fetch HTML, cheerio): the candidate portal list per
 * configured client. Postings are anchors to /Posting/View/<id>. When the
 * portal renders nothing server-side (0 anchors and JS-only markers) the
 * adapter emits an UNRENDERABLE warning; there is no headless fallback
 * (playwright-core cannot launch a Chrome of its own).
 *
 *   list  GET https://<host>/CandidatePortal/<lang>/<client>
 */
import * as cheerio from 'cheerio';
import { defineAdapter, rawListing, titleMatches, remoteFromText } from './base.js';
import { normalizeUrl } from '../core/normalize.js';

const JS_ONLY = /<app-root|ng-version=|ng-app|data-ng-|<df-|__NEXT_DATA__|id="root"><\/div>/i;

/**
 * @param {{ host: string, lang: string, client: string }} c
 */
export function listUrl(c) {
  return `https://${c.host}/CandidatePortal/${c.lang}/${c.client}`;
}

/**
 * Parse the portal HTML into RawListings. Exported for tests.
 * @param {string} html
 * @param {{ host: string, lang: string, client: string, displayName: string }} c
 * @returns {{ listings: import('./base.js').RawListing[], jsOnly: boolean }}
 */
export function parseList(html, c) {
  const $ = cheerio.load(html);
  /** @type {import('./base.js').RawListing[]} */
  const listings = [];
  const seen = new Set();
  $('a[href*="/Posting/View/"]').each((_, a) => {
    const href = String($(a).attr('href') ?? '');
    let abs;
    try {
      abs = new URL(href, `https://${c.host}/`).toString();
    } catch {
      return;
    }
    const n = normalizeUrl(abs);
    if (n.kind !== 'canonical' || !n.external_id || seen.has(n.external_id)) return;
    const title = $(a).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(n.external_id);
    // Location: the closest ancestor block's text after the title, when it looks like "City, ST" or a country.
    const block = $(a).closest('li, tr, article, div');
    const blockText = block.length ? block.text().replace(/\s+/g, ' ').trim() : '';
    const after = blockText.includes(title) ? blockText.slice(blockText.indexOf(title) + title.length).trim() : '';
    const locEl = block.length ? block.find('[class*="location" i], [data-location]').first() : null;
    const locText = locEl && locEl.length ? locEl.text().replace(/\s+/g, ' ').trim() : '';
    const locMatch = /([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b(?:,\s*(?:US|USA|CA|UK)\b)?)/.exec(locText || after);
    const location = locText && locText.length <= 80 ? locText : locMatch ? locMatch[1].trim() : null;
    const remote = remoteFromText(`${title} ${after.slice(0, 200)}`);
    listings.push(rawListing({
      source: 'dayforce',
      externalId: n.external_id.replace(/^dayforce:/, ''),
      url: abs,
      title,
      company: c.displayName,
      location,
      remoteMode: remote.remoteMode,
      remoteDeclared: remote.remoteDeclared,
      postedAt: null,
      description: null,
    }));
  });
  return { listings, jsOnly: listings.length === 0 && JS_ONLY.test(html) };
}

export const dayforce = defineAdapter({
  name: 'dayforce',
  needsBrowser: false,
  dateOrdered: false,
  domains: ['dayforcehcm.com'],
  pathPatterns: ['^/CandidatePortal/[a-z]{2}-[A-Za-z]{2}/[A-Za-z0-9_-]+(/Posting/View/\\d+)?/?(\\?|$)'],
  blindSpots: [
    'only clients listed in ats-boards.json are scanned',
    'posted dates are not on the list markup; every listing has postedAt null and cannot be window-filtered or expired by date',
    'location extraction is a heuristic over the text near the link; portals with a different layout yield location null (unknown)',
    'a JS-rendered portal yields nothing (UNRENDERABLE) and stays invisible; there is no rendering fallback',
  ],
  async *search(profile, ctx) {
    const clients = ctx.config.atsBoards.dayforce.filter((c) => c.enabled);
    for (const c of clients) {
      const query = `client:${c.host}/${c.client}`;
      await ctx.reservePage();
      const res = await ctx.fetchText(listUrl(c), { headers: { accept: 'text/html' } });
      if (res.status !== 200) {
        yield { kind: 'warning', code: 'BAD_RESPONSE', message: `dayforce ${c.client}: HTTP ${res.status}`, query };
        yield { kind: 'batch', query, pageIndex: 1, parsed: 0, status: res.status };
        continue;
      }
      const { listings, jsOnly } = parseList(res.text, c);
      if (jsOnly) {
        yield { kind: 'warning', code: 'UNRENDERABLE', message: `dayforce ${c.client}: portal is JS-only; nothing rendered server-side`, query };
      }
      let parsed = 0;
      let stop = false;
      for (const l of listings) {
        if (!titleMatches(l.title, profile)) continue;
        parsed++;
        const d = yield { kind: 'listing', query, pageIndex: 1, listing: l };
        if (d && d.stopQuery) {
          stop = true;
          break;
        }
      }
      ctx.log({ evt: 'dayforce_list', client: c.client, anchors: listings.length, matched: parsed, js_only: jsOnly });
      yield { kind: 'batch', query, pageIndex: 1, parsed, status: res.status };
      if (stop) continue;
    }
  },
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    if (!url) return { description: null };
    await ctx.reserveDetail();
    const res = await ctx.fetchText(url, { headers: { accept: 'text/html' } });
    if (res.status !== 200) return { description: null };
    const $ = cheerio.load(res.text);
    const main = $('main, [role="main"], .posting, #content').first();
    const text = (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim();
    return { description: text ? text.slice(0, 20000) : null };
  },
});
