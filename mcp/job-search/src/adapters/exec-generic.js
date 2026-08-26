// @ts-check
/**
 * Exec-search board adapter, driven by config/exec-boards.json. JSON-LD
 * (JobPosting) is read first; then the board's configured selectors; then a
 * generic anchor scan limited to the board's own pathPatterns. Boards with
 * mode 'fetch' are read over guarded HTTP and parsed with cheerio; boards
 * with mode 'browser' run through the dedicated scan profile via the frozen
 * capability object (`ctx.capFor('exec:<slug>')`), no headless fallback.
 *
 * Exec boards rarely name the client: company is "Confidential" with
 * `confidentialFirm=<slug>` so normalize.js keys it as
 * `confidential:<slug>` and dedup uses the description hash as identity.
 */
import * as cheerio from 'cheerio';
import { defineAdapter, rawListing, titleMatches, isoDate, remoteFromText } from './base.js';

/**
 * @typedef {import('../core/config.js').LoadedConfig['execBoards']['boards'][number]} ExecBoard
 */

/**
 * @param {ExecBoard} b
 * @param {string} href
 */
function absolute(b, href) {
  try {
    const u = new URL(href, b.listUrl);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (!b.domains.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()))) return null;
    if (!b.pathPatterns.some((p) => new RegExp(p).test(u.pathname + u.search))) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Flatten JSON-LD documents into JobPosting objects (handles @graph, ItemList, arrays).
 * @param {unknown[]} docs
 * @returns {any[]}
 */
export function jobPostingsFromJsonLd(docs) {
  /** @type {any[]} */
  const out = [];
  const visit = (/** @type {any} */ node, /** @type {number} */ depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const type = node['@type'];
    const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
    if (types.includes('JobPosting')) out.push(node);
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (node.itemListElement) visit(node.itemListElement, depth + 1);
    if (node.item) visit(node.item, depth + 1);
    if (node.mainEntity) visit(node.mainEntity, depth + 1);
  };
  visit(docs, 0);
  return out;
}

/**
 * @param {any} jp JSON-LD JobPosting
 * @param {ExecBoard} b
 */
export function mapJsonLd(jp, b) {
  const url = typeof jp.url === 'string' ? absolute(b, jp.url) : null;
  const title = String(jp.title ?? jp.name ?? '').trim();
  if (!title) return null;
  const orgRaw = jp.hiringOrganization && typeof jp.hiringOrganization === 'object' ? String(jp.hiringOrganization.name ?? '').trim() : '';
  const org = /^(confidential|undisclosed|private|our client|client)\b/i.test(orgRaw) ? '' : orgRaw;
  const loc = jp.jobLocation && typeof jp.jobLocation === 'object' ? (Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation) : null;
  const addr = loc && loc.address && typeof loc.address === 'object' ? loc.address : null;
  const location = addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).map(String).join(', ') || null : (typeof jp.jobLocation === 'string' ? jp.jobLocation : null);
  const jlt = String(jp.jobLocationType ?? '');
  const remote = /telecommute/i.test(jlt) ? { remoteMode: /** @type {const} */ ('remote'), remoteDeclared: true } : remoteFromText(`${title} ${location ?? ''}`);
  let salaryMin = null;
  let salaryMax = null;
  let salaryRaw = null;
  const bs = jp.baseSalary && typeof jp.baseSalary === 'object' ? jp.baseSalary : null;
  const val = bs && bs.value && typeof bs.value === 'object' ? bs.value : null;
  if (val && (val.minValue != null || val.maxValue != null)) {
    salaryMin = val.minValue != null ? Math.round(Number(val.minValue)) : null;
    salaryMax = val.maxValue != null ? Math.round(Number(val.maxValue)) : null;
    salaryRaw = `${bs.currency ?? ''} ${salaryMin ?? ''}-${salaryMax ?? ''} ${val.unitText ?? ''}`.trim();
  }
  const description = typeof jp.description === 'string' && jp.description.trim() ? jp.description : null;
  return rawListing({
    source: `exec:${b.slug}`,
    externalId: url ? null : `${b.slug}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')}`,
    url,
    title,
    company: org || 'Confidential',
    confidentialFirm: org ? null : b.slug,
    location,
    remoteMode: remote.remoteMode,
    remoteDeclared: remote.remoteDeclared,
    postedAt: isoDate(jp.datePosted ?? null),
    salaryRaw,
    salaryMin,
    salaryMax,
    description,
  });
}

/**
 * Parse a board's list HTML: JSON-LD first, then selectors, then anchors.
 * Exported for tests.
 * @param {string} html
 * @param {ExecBoard} b
 * @returns {{ listings: import('./base.js').RawListing[], method: 'jsonld'|'selectors'|'anchors'|'none' }}
 */
export function parseBoardHtml(html, b) {
  const $ = cheerio.load(html);
  /** @type {unknown[]} */
  const docs = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      docs.push(JSON.parse($(s).text()));
    } catch {
      /* skip */
    }
  });
  const jps = jobPostingsFromJsonLd(docs);
  if (jps.length > 0) {
    const listings = jps.map((jp) => mapJsonLd(jp, b)).filter((x) => x !== null);
    if (listings.length > 0) return { listings: /** @type {any} */ (listings), method: 'jsonld' };
  }
  if (b.selectors && b.selectors.item) {
    const sel = b.selectors;
    const items = [];
    $(sel.item).each((_, it) => {
      const linkEl = sel.link ? $(it).find(sel.link).first() : $(it).find('a[href]').first();
      const titleEl = sel.title ? $(it).find(sel.title).first() : linkEl;
      const locEl = sel.location ? $(it).find(sel.location).first() : null;
      items.push({ href: linkEl.attr('href') ?? null, title: titleEl.text().replace(/\s+/g, ' ').trim(), location: locEl ? locEl.text().replace(/\s+/g, ' ').trim() : null });
    });
    const listings = itemsToListings(items, b);
    if (listings.length > 0) return { listings, method: 'selectors' };
  }
  const items = [];
  $('a[href]').each((_, a) => {
    items.push({ href: String($(a).attr('href') ?? ''), title: $(a).text().replace(/\s+/g, ' ').trim(), location: null });
  });
  const listings = itemsToListings(items, b);
  return { listings, method: listings.length > 0 ? 'anchors' : 'none' };
}

/**
 * Convert {href,title,location} items (from cheerio or the genericListItems
 * extractor) into RawListings; only links inside the board's own
 * pathPatterns survive, and the list page itself is excluded.
 * @param {Array<{ href: string|null, title: string|null, location: string|null }>} items
 * @param {ExecBoard} b
 */
export function itemsToListings(items, b) {
  /** @type {import('./base.js').RawListing[]} */
  const out = [];
  const seen = new Set();
  const listPath = new URL(b.listUrl).pathname.replace(/\/+$/, '');
  for (const it of items) {
    if (!it.href || !it.title || it.title.length < 4) continue;
    const url = absolute(b, it.href);
    if (!url) continue;
    const path = new URL(url).pathname.replace(/\/+$/, '');
    if (path === listPath || seen.has(url)) continue;
    seen.add(url);
    const remote = remoteFromText(`${it.title} ${it.location ?? ''}`);
    out.push(rawListing({
      source: `exec:${b.slug}`,
      url,
      title: it.title,
      company: 'Confidential',
      confidentialFirm: b.slug,
      location: it.location || null,
      remoteMode: remote.remoteMode,
      remoteDeclared: remote.remoteDeclared,
      postedAt: null,
      description: null,
    }));
  }
  return out;
}

export const exec = defineAdapter({
  name: 'exec',
  needsBrowser: false,
  dateOrdered: false,
  domains: [],
  pathPatterns: [],
  blindSpots: [
    'board URLs, rendering modes, and selectors in exec-boards.json are unverified until a live run; a wrong listUrl refuses the run (fail closed)',
    'most exec boards hide the client, so company is confidential:<firm> and dedup relies on the description hash; list pages without descriptions queue confidential_no_description',
    'posted dates exist only when the board publishes JSON-LD datePosted; otherwise listings cannot be window-filtered',
    'the generic anchor scan can pick up navigation links that happen to sit under the board path; the title filter is the only guard',
  ],
  async *search(profile, ctx) {
    const boards = ctx.config.execBoards.boards.filter((b) => b.enabled);
    for (const b of boards) {
      const query = `board:${b.slug}`;
      const source = `exec:${b.slug}`;
      await ctx.reservePage();
      /** @type {{ listings: import('./base.js').RawListing[], method: string }} */
      let parsedList;
      /** @type {number|null} */
      let status = null;
      if (b.mode === 'fetch') {
        const res = await ctx.fetchText(b.listUrl, { headers: { accept: 'text/html' }, source });
        status = res.status;
        if (res.status !== 200) {
          yield { kind: 'wall', query, pageIndex: 1, signals: { parsed: 0, status: res.status, url: res.url, emptyState: false } };
          yield { kind: 'batch', query, pageIndex: 1, parsed: 0, status: res.status };
          continue;
        }
        parsedList = parseBoardHtml(res.text, b);
      } else {
        const cap = await ctx.capFor(source);
        if (!cap) {
          yield { kind: 'warning', code: 'BROWSER_UNAVAILABLE', message: `exec board ${b.slug} needs the scan profile; skipped`, query };
          yield { kind: 'batch', query, pageIndex: 1, parsed: 0, status: null };
          continue;
        }
        const nav = await cap.goto(b.listUrl);
        status = nav.status;
        const docs = /** @type {unknown[]} */ (await cap.readJson('readJsonLd'));
        const jps = jobPostingsFromJsonLd(Array.isArray(docs) ? docs : []);
        let listings = jps.map((jp) => mapJsonLd(jp, b)).filter((x) => x !== null);
        let method = 'jsonld';
        if (listings.length === 0 && b.selectors && b.selectors.item) {
          const items = /** @type {any[]} */ (await cap.readJson('genericListItems', b.selectors));
          listings = itemsToListings(Array.isArray(items) ? items : [], b);
          method = 'selectors';
        }
        if (listings.length === 0) {
          const html = await cap.readHtml();
          const r = parseBoardHtml(html, b);
          listings = r.listings;
          method = r.method;
        }
        if (listings.length === 0) {
          const markers = /** @type {any} */ (await cap.readJson('wallMarkers'));
          yield { kind: 'wall', query, pageIndex: 1, signals: { parsed: 0, status: nav.status, cfMitigated: nav.cfMitigated, url: nav.url, challengeCloudflare: !!markers.challengeCloudflare, challengeForm: !!markers.challengeForm, recaptcha: !!markers.recaptcha, emptyState: false } };
          yield { kind: 'batch', query, pageIndex: 1, parsed: 0, status: nav.status };
          continue;
        }
        parsedList = { listings: /** @type {any} */ (listings), method };
      }
      let parsed = 0;
      let stop = false;
      for (const l of parsedList.listings) {
        if (!titleMatches(l.title, profile)) continue;
        parsed++;
        const d = yield { kind: 'listing', query, pageIndex: 1, listing: l };
        if (d && d.stopQuery) {
          stop = true;
          break;
        }
      }
      ctx.log({ evt: 'exec_board', board: b.slug, method: parsedList.method, found: parsedList.listings.length, matched: parsed });
      if (parsedList.listings.length === 0) {
        yield { kind: 'wall', query, pageIndex: 1, signals: { parsed: 0, status, url: b.listUrl, emptyState: false } };
      }
      yield { kind: 'batch', query, pageIndex: 1, parsed, status };
      if (stop) continue;
    }
  },
  async fetchDetail(listing, ctx) {
    const url = listing.url_normalized ?? listing.url ?? null;
    const src = String(listing.source ?? '');
    const slug = src.startsWith('exec:') ? src.slice(5) : null;
    const b = slug ? ctx.config.execBoards.boards.find((x) => x.slug === slug) : null;
    if (!url || !b) return { description: null };
    await ctx.reserveDetail();
    /** @type {string} */
    let html;
    if (b.mode === 'fetch') {
      const res = await ctx.fetchText(url, { headers: { accept: 'text/html' }, source: src });
      if (res.status !== 200) return { description: null };
      html = res.text;
    } else {
      const cap = await ctx.capFor(src);
      if (!cap) return { description: null };
      await cap.goto(url);
      html = await cap.readHtml();
    }
    const $ = cheerio.load(html);
    /** @type {unknown[]} */
    const docs = [];
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        docs.push(JSON.parse($(s).text()));
      } catch {
        /* skip */
      }
    });
    const jp = jobPostingsFromJsonLd(docs)[0];
    if (jp && typeof jp.description === 'string' && jp.description.trim()) return { description: jp.description };
    const main = $('main, article, [role="main"], #content').first();
    const text = (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim();
    return { description: text ? text.slice(0, 20000) : null };
  },
});
