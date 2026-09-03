// @ts-check
/**
 * Named read-only page.evaluate bodies (spec section 1). These functions run
 * INSIDE the browser page via capability.js; they must be self-contained
 * (no closures over module state), take at most one serializable argument,
 * and return only JSON-serializable values. They never dispatch events,
 * never call focus/submit/click, and are never sourced from config.
 *
 * Adapters never call these directly; they use the frozen capability object.
 * The registry at the bottom is what capability.js exposes by name.
 */

/**
 * Text of the first <script> matching a selector, parsed as JSON.
 * Returns null when absent or unparseable.
 * @param {string} selector
 */
export function readScriptJson(selector) {
  const el = document.querySelector(selector);
  if (!el || !el.textContent) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

/**
 * Every JSON-LD block on the page, parsed; unparseable blocks are skipped.
 * @returns {unknown[]}
 */
export function readJsonLd() {
  const out = [];
  const nodes = document.querySelectorAll('script[type="application/ld+json"]');
  for (const n of nodes) {
    try {
      out.push(JSON.parse(n.textContent || ''));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Wall markers (spec section 4). Booleans only.
 */
export function wallMarkers() {
  return {
    challengeCloudflare: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    challengeForm: !!document.querySelector('#challenge-form'),
    recaptcha: !!document.querySelector('iframe[title*="recaptcha"]'),
    title: String(document.title || '').slice(0, 120),
    url: String(location.href).split('?')[0].slice(0, 300),
  };
}

/**
 * Scroll one viewport down and report whether the document grew or the
 * bottom was reached. Scrolling is a read of the rendered list, not an
 * interaction with any control.
 */
export function scrollStep() {
  const before = document.documentElement.scrollHeight;
  window.scrollBy(0, window.innerHeight);
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  return { before, after: document.documentElement.scrollHeight, atBottom };
}

/**
 * Indeed: the mosaic provider data embedded as window.mosaic.providerData,
 * reduced to the job-card list when present. Returns null when the shape is
 * not recognized so the adapter can fall back to the DOM extractor.
 */
export function indeedMosaicJobs() {
  try {
    // @ts-ignore browser global
    const mosaic = window.mosaic;
    const provider = mosaic && mosaic.providerData && mosaic.providerData['mosaic-provider-jobcards'];
    const results = provider && provider.metaData && provider.metaData.mosaicProviderJobCardsModel && provider.metaData.mosaicProviderJobCardsModel.results;
    if (!Array.isArray(results)) return null;
    return results.map((r) => ({
      jobkey: r.jobkey ? String(r.jobkey) : null,
      title: r.title ? String(r.title) : null,
      company: r.company ? String(r.company) : null,
      location: r.formattedLocation ? String(r.formattedLocation) : null,
      remote: r.remoteLocation === true,
      postedMs: typeof r.pubDate === 'number' ? r.pubDate : null,
      salaryText: r.salarySnippet && r.salarySnippet.text ? String(r.salarySnippet.text) : null,
      snippet: r.snippet ? String(r.snippet).slice(0, 600) : null,
    }));
  } catch {
    return null;
  }
}

/**
 * Indeed DOM fallback: job cards by data-jk attribute.
 */
export function indeedDomJobs() {
  const cards = document.querySelectorAll('[data-jk]');
  const out = [];
  for (const c of cards) {
    const jk = c.getAttribute('data-jk');
    if (!jk) continue;
    const title = c.querySelector('h2, [id^="jobTitle"]');
    const company = c.querySelector('[data-testid="company-name"]');
    const loc = c.querySelector('[data-testid="text-location"]');
    out.push({
      jobkey: jk,
      title: title ? String(title.textContent || '').trim() : null,
      company: company ? String(company.textContent || '').trim() : null,
      location: loc ? String(loc.textContent || '').trim() : null,
    });
  }
  return out;
}

/**
 * Indeed empty-state marker for wall classification.
 */
export function indeedEmptyState() {
  return !!document.querySelector('.jobsearch-NoResult-messageContainer, [data-testid="no-results"]');
}

/**
 * LinkedIn job cards from the search results list.
 */
export function linkedinJobCards() {
  const cards = document.querySelectorAll('[data-job-id], [data-occludable-job-id]');
  const out = [];
  for (const c of cards) {
    const id = c.getAttribute('data-job-id') || c.getAttribute('data-occludable-job-id');
    if (!id || !/^\d+$/.test(id)) continue;
    const title = c.querySelector('a[href*="/jobs/view/"] strong, .job-card-list__title, a.job-card-container__link');
    const company = c.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name');
    const loc = c.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
    const time = c.querySelector('time');
    out.push({
      id,
      title: title ? String(title.textContent || '').trim() : null,
      company: company ? String(company.textContent || '').trim() : null,
      location: loc ? String(loc.textContent || '').trim() : null,
      datetime: time ? time.getAttribute('datetime') : null,
    });
  }
  return out;
}

/**
 * LinkedIn empty-state marker.
 */
export function linkedinEmptyState() {
  return !!document.querySelector('.jobs-search-no-results-banner, .jobs-search-no-results, [class*="no-results"]');
}

/**
 * LinkedIn job detail: title, company, location, description text.
 */
export function linkedinJobDetail() {
  const q = (/** @type {string} */ sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.textContent || '').trim() : null;
  };
  return {
    title: q('.job-details-jobs-unified-top-card__job-title, h1'),
    company: q('.job-details-jobs-unified-top-card__company-name, .topcard__org-name-link'),
    location: q('.job-details-jobs-unified-top-card__bullet, .topcard__flavor--bullet'),
    description: (() => {
      const el = document.querySelector('#job-details, .jobs-description__content, .description__text');
      return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000) : null;
    })(),
  };
}

/**
 * LinkedIn apply affordance (auto-apply PR B, docs/auto-apply-spec.md): looks for the job detail page's
 * own Apply control WITHOUT clicking it. Total: an anchor-shaped "Apply"/"Apply on company site" link
 * (an <a href> whose href is not itself an in-app '#'/javascript: no-op) is reported as `href` for
 * src/apply/apply-target.js to decode/classify; an Easy Apply BUTTON with no navigable href is reported
 * as `buttonOnly: true` and never clicked here -- a real button click (when the caller decides to spend
 * one) is a separate capability action, this extractor only observes the DOM as it already rendered.
 */
export function linkedinApplyLink() {
  const anchor = /** @type {HTMLAnchorElement|null} */ (document.querySelector(
    'a.jobs-apply-button, a[data-control-name="jobdetails_topcard_iapply"], a.job-apply-button, a[href*="/safety/go/"]',
  ));
  if (anchor && anchor.href && !/^(javascript:|#)/i.test(anchor.getAttribute('href') || '')) {
    return { href: anchor.href, buttonOnly: false };
  }
  const button = document.querySelector('button.jobs-apply-button, button[aria-label*="Easy Apply" i]');
  if (button) return { href: null, buttonOnly: true };
  return { href: null, buttonOnly: false };
}

/**
 * Indeed apply affordance (auto-apply PR B): mirrors linkedinApplyLink()'s shape. Indeed's own Easy Apply
 * ("applystart") flow never navigates to an external href at all, so a same-origin/`indeed.com` href (or
 * no href) is reported as easyApplyOnly; an "Apply on company site" anchor pointing OFF indeed.com is
 * reported as `href` for resolution.
 */
export function indeedApplyState() {
  const anchor = /** @type {HTMLAnchorElement|null} */ (document.querySelector('a[id*="applyButton" i], a.ia-IndeedApplyButton, a[href*="applystart"]'));
  if (anchor && anchor.href) {
    let host = '';
    try {
      host = new URL(anchor.href, location.href).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (host && host !== 'indeed.com' && !host.endsWith('.indeed.com')) {
      return { href: anchor.href, easyApplyOnly: false };
    }
  }
  return { href: null, easyApplyOnly: true };
}

/**
 * Generic: plain text of the page body, bounded.
 */
export function bodyText() {
  return String(document.body ? document.body.innerText || document.body.textContent || '' : '').slice(0, 20000);
}

/**
 * Generic list extractor for exec boards: selectors validated by config.js
 * (no text=/:has-text/>>/xpath=). Returns hrefs and text only.
 * @param {{ item: string, title?: string, link?: string, location?: string }} sel
 */
export function genericListItems(sel) {
  const items = document.querySelectorAll(sel.item);
  const out = [];
  for (const it of items) {
    const linkEl = sel.link ? it.querySelector(sel.link) : it.querySelector('a[href]');
    const titleEl = sel.title ? it.querySelector(sel.title) : linkEl;
    const locEl = sel.location ? it.querySelector(sel.location) : null;
    out.push({
      href: linkEl ? linkEl.getAttribute('href') : null,
      title: titleEl ? String(titleEl.textContent || '').trim() : null,
      location: locEl ? String(locEl.textContent || '').trim() : null,
    });
  }
  return out;
}

/** Registry exposed to capability.js. Keys are the only names adapters may ask for. */
export const EXTRACTORS = Object.freeze({
  readScriptJson,
  readJsonLd,
  wallMarkers,
  scrollStep,
  indeedMosaicJobs,
  indeedDomJobs,
  indeedEmptyState,
  linkedinJobCards,
  linkedinEmptyState,
  linkedinJobDetail,
  linkedinApplyLink,
  indeedApplyState,
  bodyText,
  genericListItems,
});

/** @typedef {keyof typeof EXTRACTORS} ExtractorName */
