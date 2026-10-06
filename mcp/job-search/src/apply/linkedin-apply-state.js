// @ts-check
/**
 * LinkedIn apply state from the page itself (spec v1 F1.1/F1.2, v2 addendum B2/B3/B4/B12). Two pure steps
 * and one thin browser step:
 *
 *   buildLinkedInApplyObservation({ url, html, loadError, httpStatus })   pure: HTML in, plain snapshot out
 *   classifyLinkedInApplyState(obs)                                        pure: snapshot in, branch out
 *   observeLinkedInPage(cap, page, url)                                   navigates, reads the HTML, builds
 *
 * The classifier is a TOTAL classification. Branches are checked in this order and the first match wins:
 *
 *   load_failure     navigation failed, HTTP >= 400 (other than the rate-limit codes), or no HTML at all
 *   challenge        captcha or security check (URL or page markers), HTTP 429/999
 *   auth_wall        sign-in wall (URL or page markers)
 *   unknown          the page language is not English (spec v2 B4: localized text maps to unknown)
 *   unknown          the top card cannot be located (spec v2 B2)
 *   closed           "No longer accepting applications" inside the top card
 *   already_applied  an applied badge inside the top card (spec v2 B4)
 *   unknown          a suspicious apply control (denied term, unexpected Easy Apply label), a disabled-only
 *                    apply control, an external target on a linkedin.com host (spec v2 B12), Easy Apply and
 *                    an external Apply together, or more than one distinct control of either kind
 *   easy_apply       exactly one distinct Easy Apply control (same accessible name counts once, spec v2 B3)
 *   external         exactly one distinct external Apply control (an off-LinkedIn href, or a button the
 *                    caller may click: `control.path` is a precise locator, `control.name` its name)
 *   no_control       no apply control at all in the top card
 *   unknown          the default
 *
 * Scope (spec v2 B2): the observation is built ONLY from the job-details container around the one job-title
 * h1. The container is found by climbing from the h1 while the next ancestor stays free of links to OTHER job
 * ids, of a second h1, and of main/body/aside. That is a content rule, not a position rule: the similar-jobs
 * rail and promoted cards always link to other jobs, so the climb stops below them wherever they sit in the
 * DOM. LinkedIn's current server-driven layout (live 2026-10-06) has NO h1 (the title is a styled <p>); there
 * the climb starts from each apply control and each closed/applied marker instead, and a climbed scope is kept
 * only when it contains the job title read from <title> (anchoredScope). Inside the container, dialogs, hidden subtrees, and the description body are skipped. Matching uses
 * accessible names and text only, never class names (logged-in pages use hashed classes) and never sibling
 * order or adjacency (spec v1 F1.2).
 *
 * The Easy Apply name rule mirrors src/apply/easy-apply-driver.js's open_dialog: visible text normalizes to
 * exactly "easy apply", an aria-label (when present) is "easy apply" or starts "easy apply to ", and no
 * submit/send/done term appears.
 */
import * as cheerio from 'cheerio';
import { normalizeName } from './assisted/guard.js';
import { LINKEDIN_RULES } from './assisted/profiles/linkedin.js';
import { decodeLinkedInSafetyGo } from './apply-target.js';

/** Closed branch list, in check order. */
export const LINKEDIN_APPLY_BRANCHES = Object.freeze([
  'load_failure', 'challenge', 'auth_wall', 'closed', 'already_applied', 'easy_apply', 'external', 'no_control', 'unknown',
]);

const CHALLENGE_URL = /\/checkpoint\/(?!lg\/)|[?&]captcha/i;
const AUTH_URL = /\/(?:authwall|login|signup|uas\/login|uas\/|checkpoint\/lg\/)(?:[/?#]|$)/i;
const DENY = /\b(?:submit|send|done)\b/i;
const CLOSED_RE = /\bno longer accepting applications\b/i;
const APPLIED_RE = new RegExp(LINKEDIN_RULES.appliedEvidence.match.source, LINKEDIN_RULES.appliedEvidence.match.flags);
const LINKEDIN_HOSTS = Object.freeze(['linkedin.com', 'lnkd.in']);
const MAX_CLIMB = 15;
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'svg']);

/**
 * True when the URL parses and its host is linkedin.com, lnkd.in, or a subdomain of either.
 * @param {unknown} u
 */
export function isLinkedInHostUrl(u) {
  try {
    const host = new URL(String(u)).hostname.toLowerCase();
    return LINKEDIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** @param {unknown} u @returns {string|null} */
function jobIdFromUrl(u) {
  try {
    const url = new URL(String(u));
    const m = /\/jobs\/view\/(\d+)/i.exec(url.pathname);
    if (m) return m[1];
    const q = url.searchParams.get('currentJobId');
    return q && /^\d+$/.test(q) ? q : null;
  } catch {
    return null;
  }
}

/** @param {any} n */
const isEl = (n) => Boolean(n) && (n.type === 'tag' || n.type === 'script' || n.type === 'style');
/** @param {any} n @param {string} k */
const attr = (n, k) => (n && n.attribs && typeof n.attribs[k] === 'string' ? n.attribs[k] : null);
/** @param {any} n */
const classOf = (n) => String(attr(n, 'class') ?? '').toLowerCase();

/** @param {any} n */
function isDialog(n) {
  const role = String(attr(n, 'role') ?? '').toLowerCase();
  return n.name === 'dialog' || role === 'dialog' || role === 'alertdialog' || String(attr(n, 'aria-modal') ?? '').toLowerCase() === 'true';
}

/** @param {any} n */
function isHiddenSelf(n) {
  if (attr(n, 'hidden') !== null) return true;
  if (String(attr(n, 'aria-hidden') ?? '').toLowerCase() === 'true') return true;
  if (n.name === 'input' && String(attr(n, 'type') ?? '').toLowerCase() === 'hidden') return true;
  const style = String(attr(n, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden/.test(style);
}

/** The description body (spec v2 B2): skipped inside the top-card scope. @param {any} n */
function isDescription(n) {
  if (n.name === 'article') return true;
  if (String(attr(n, 'id') ?? '').toLowerCase() === 'job-details') return true;
  const c = classOf(n);
  return /(?:^|[\s_-])description(?:[\s_-]|$)|jobs-description|description__text|show-more-less-html/.test(c);
}

/** @param {any} n */
function skipSubtree(n) {
  return SKIP_TAGS.has(n.name) || isDialog(n) || isHiddenSelf(n) || isDescription(n);
}

/** @param {any} n */
function insideDialogOrHidden(n) {
  for (let cur = n; cur && isEl(cur); cur = cur.parent) {
    if (isDialog(cur) || isHiddenSelf(cur)) return true;
  }
  return false;
}

/**
 * Depth-first walk of element descendants, skipping script/style and (when `prune` says so) whole subtrees.
 * @param {any} root
 * @param {(n: any) => boolean} prune
 * @param {(n: any) => void} visit
 */
function walk(root, prune, visit) {
  const stack = [...(root.children ?? [])].reverse();
  while (stack.length) {
    const n = stack.pop();
    if (!isEl(n)) continue;
    if (prune(n)) continue;
    visit(n);
    const kids = n.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/**
 * Text of a subtree with a space between text nodes (so adjacent elements never fuse into one word),
 * skipping pruned subtrees. Normalized with the shared button-name normalizer's whitespace rules.
 * @param {any} root
 * @param {(n: any) => boolean} prune
 */
function textOf(root, prune) {
  /** @type {string[]} */
  const parts = [];
  /** @param {any} n */
  const rec = (n) => {
    for (const c of n.children ?? []) {
      if (c.type === 'text') parts.push(String(c.data ?? ''));
      else if (isEl(c) && !SKIP_TAGS.has(c.name) && !prune(c)) rec(c);
    }
  };
  rec(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** A precise CSS locator for one element: the nth-child chain from <html>. @param {any} n */
function cssPath(n) {
  /** @type {string[]} */
  const segs = [];
  for (let cur = n; cur && isEl(cur); cur = cur.parent) {
    if (cur.name === 'html' || cur.name === 'body') {
      segs.unshift(cur.name);
      continue;
    }
    const siblings = (cur.parent && cur.parent.children ? cur.parent.children : []).filter(isEl);
    segs.unshift(`${cur.name}:nth-child(${siblings.indexOf(cur) + 1})`);
  }
  return segs.join(' > ');
}

/**
 * @param {any} n
 * @param {string|null} jobId
 * @param {string} baseUrl
 */
function linksToOtherJob(n, jobId, baseUrl) {
  let found = false;
  walk({ children: [n] }, () => found, (el) => {
    if (found || el.name !== 'a') return;
    const href = attr(el, 'href');
    if (!href) return;
    let id = null;
    try {
      id = jobIdFromUrl(new URL(href, baseUrl).toString());
    } catch {
      id = null;
    }
    if (id && id !== jobId) found = true;
  });
  return found;
}

/** @param {any} n */
function countH1(n) {
  let k = 0;
  walk({ children: [n] }, (el) => isDialog(el) || isHiddenSelf(el), (el) => { if (el.name === 'h1') k++; });
  return k;
}

/** @param {any} n */
function isDisabled(n) {
  if (attr(n, 'disabled') !== null) return true;
  if (String(attr(n, 'aria-disabled') ?? '').toLowerCase() === 'true') return true;
  for (let cur = n.parent; cur && isEl(cur); cur = cur.parent) {
    if (cur.name === 'fieldset' && attr(cur, 'disabled') !== null) return true;
  }
  return false;
}

/** @param {any} n */
function isControl(n) {
  if (n.name === 'button') return true;
  if (n.name === 'a' && attr(n, 'href') !== null) return true;
  if (n.name === 'input' && /^(?:button|submit)$/i.test(String(attr(n, 'type') ?? ''))) return true;
  return String(attr(n, 'role') ?? '').toLowerCase() === 'button';
}

/**
 * Climb from `start` while the next ancestor stays free of links to other job ids and of a second h1, and
 * is not main/body/html/aside. Returns the highest ancestor reached (or `start` itself).
 * @param {any} start
 * @param {string|null} jobId
 * @param {string} base
 */
function climbScope(start, jobId, base) {
  let scope = start;
  let cur = start.parent;
  for (let depth = 0; cur && isEl(cur) && depth < MAX_CLIMB; depth++) {
    const role = String(attr(cur, 'role') ?? '').toLowerCase();
    if (cur.name === 'html' || cur.name === 'body' || cur.name === 'main' || cur.name === 'aside' || role === 'main' || role === 'complementary') break;
    if (linksToOtherJob(cur, jobId, base) || countH1(cur) > 1) break;
    scope = cur;
    cur = cur.parent;
  }
  return scope;
}

/**
 * @param {any} n
 * @param {string} base
 * @returns {ObservedControl}
 */
function describeControl(n, base) {
  const ariaLabel = normalizeName(attr(n, 'aria-label') ?? '');
  const visible = n.name === 'input' ? normalizeName(attr(n, 'value') ?? '') : normalizeName(textOf(n, skipSubtree));
  const rawHref = n.name === 'a' ? attr(n, 'href') : null;
  let href = null;
  if (rawHref && !/^\s*(?:javascript:|#)/i.test(rawHref)) {
    try {
      href = new URL(rawHref, base).toString();
    } catch {
      href = rawHref;
    }
  }
  return {
    tag: n.name === 'a' ? 'link' : 'button', name: ariaLabel || visible, ariaLabel, text: visible, href,
    disabled: isDisabled(n), path: cssPath(n),
  };
}

/**
 * The job title from the document <title> ("<job title> | <company> | LinkedIn", optionally prefixed by a
 * notification count "(3) "). Null when it cannot be read.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string|null}
 */
function jobTitleFromDocument($) {
  const raw = String($('title').first().text() ?? '').replace(/\s+/g, ' ').trim().replace(/^\(\d+\)\s*/, '');
  if (!raw) return null;
  const parts = raw.split(' | ');
  const title = (parts.length >= 3 ? parts.slice(0, -2).join(' | ') : parts[0]).trim();
  if (!title || /^linkedin$/i.test(title)) return null;
  return normalizeName(title);
}

/**
 * No-h1 layout scope: every apply-ish control and every closed/applied marker outside rails, dialogs, hidden
 * subtrees, and the description is an anchor; each anchor climbs with climbScope; a climbed scope counts only
 * when its text contains the job title. A rail or promoted card's control climbs no further than its own card
 * (the card links to another job), which never contains this job's title, so it is dropped. Nested scopes
 * collapse to the outermost; two or more disjoint scopes are ambiguous.
 * @param {import('cheerio').CheerioAPI} $
 * @param {any} root
 * @param {string|null} jobId
 * @param {string} base
 * @returns {{ scope: any, missing: string|null }}
 */
function anchoredScope($, root, jobId, base) {
  const title = jobTitleFromDocument($);
  if (!title) return { scope: null, missing: 'no_title' };
  /** @type {any[]} */
  const anchors = [];
  const pruneAnchor = (/** @type {any} */ n) => skipSubtree(n) || n.name === 'aside' || String(attr(n, 'role') ?? '').toLowerCase() === 'complementary';
  walk(root, pruneAnchor, (n) => {
    if (isControl(n)) {
      if (controlKind(describeControl(n, base)) !== 'other') anchors.push(n);
      return;
    }
    const own = (n.children ?? []).filter((/** @type {any} */ c) => c.type === 'text').map((/** @type {any} */ c) => String(c.data ?? '')).join(' ').replace(/\s+/g, ' ');
    if (CLOSED_RE.test(own) || APPLIED_RE.test(own)) anchors.push(n);
  });
  if (anchors.length === 0) return { scope: null, missing: 'no_anchor' };
  /** @type {any[]} */
  const scopes = [];
  for (const a of anchors) {
    const s = climbScope(a, jobId, base);
    if (!normalizeName(textOf(s, skipSubtree)).includes(title)) continue;
    if (!scopes.includes(s)) scopes.push(s);
  }
  /** @param {any} inner @param {any} outer */
  const within = (inner, outer) => {
    for (let cur = inner.parent; cur && isEl(cur); cur = cur.parent) if (cur === outer) return true;
    return false;
  };
  const outermost = scopes.filter((s) => !scopes.some((o) => o !== s && within(s, o)));
  if (outermost.length === 0) return { scope: null, missing: 'no_titled_scope' };
  if (outermost.length > 1) return { scope: null, missing: 'ambiguous_scope' };
  return { scope: outermost[0], missing: null };
}

/**
 * @typedef {Object} ObservedControl
 * @property {'button'|'link'} tag
 * @property {string} name accessible name, normalized: the aria-label when present, else the visible text
 * @property {string} ariaLabel normalized aria-label ('' when absent)
 * @property {string} text normalized visible text
 * @property {string|null} href absolute href for a navigable link, else null
 * @property {boolean} disabled
 * @property {string} path precise CSS locator (nth-child chain from <html>)
 */

/**
 * @typedef {Object} LinkedInApplyObservation
 * @property {string|null} url the landed URL
 * @property {string|null} loadError navigation/read failure code, or null
 * @property {number|null} httpStatus
 * @property {string|null} lang the document's lang attribute, lowercased
 * @property {boolean} challengeMarker
 * @property {boolean} authMarker
 * @property {string|null} topCardMissing 'no_document' | 'no_title' | 'ambiguous_title' when no top card
 * @property {{ closed: boolean, applied: boolean, controls: ObservedControl[] }|null} topCard
 */

/**
 * Pure: build the snapshot the classifier reads. Never throws for any input.
 * @param {{ url?: string|null, html?: string|null, loadError?: string|null, httpStatus?: number|null }} input
 * @returns {LinkedInApplyObservation}
 */
export function buildLinkedInApplyObservation(input) {
  const url = typeof input?.url === 'string' ? input.url : null;
  /** @type {LinkedInApplyObservation} */
  const obs = {
    url, loadError: input?.loadError ?? null, httpStatus: typeof input?.httpStatus === 'number' ? input.httpStatus : null,
    lang: null, challengeMarker: false, authMarker: false, topCardMissing: 'no_document', topCard: null,
  };
  if (typeof input?.html !== 'string') return obs;
  /** @type {import('cheerio').CheerioAPI} */
  let $;
  try {
    $ = cheerio.load(input.html);
  } catch {
    return obs;
  }
  const root = /** @type {any} */ ($.root()[0]);
  const base = url ?? 'https://www.linkedin.com/';
  const htmlEl = $('html')[0];
  obs.lang = htmlEl ? (attr(htmlEl, 'lang') ?? '').toLowerCase() || null : null;

  walk(root, () => false, (n) => {
    const id = String(attr(n, 'id') ?? '').toLowerCase();
    const c = classOf(n);
    if (n.name === 'iframe') {
      const s = `${attr(n, 'src') ?? ''} ${attr(n, 'title') ?? ''}`.toLowerCase();
      if (/captcha|challenges\.cloudflare\.com/.test(s)) obs.challengeMarker = true;
    }
    if (id === 'captcha-internal' || id === 'challenge-form') obs.challengeMarker = true;
    if (n.name === 'form' && /\/checkpoint\/challenge/i.test(String(attr(n, 'action') ?? ''))) obs.challengeMarker = true;
    if (/authwall/.test(c) || /authwall/i.test(String(attr(n, 'data-tracking-control-name') ?? ''))) obs.authMarker = true;
    if (n.name === 'form' && /(?:^|\s)login__form(?:\s|$)/.test(c)) obs.authMarker = true;
    if (n.name === 'input' && (id === 'session_key' || attr(n, 'name') === 'session_key')) obs.authMarker = true;
  });

  /** @type {any[]} */
  const h1s = [];
  walk(root, (n) => isDialog(n) || isHiddenSelf(n), (n) => { if (n.name === 'h1') h1s.push(n); });
  if (h1s.length > 1) {
    obs.topCardMissing = 'ambiguous_title';
    return obs;
  }
  const jobId = jobIdFromUrl(url);
  /** @type {any} */
  let scope = null;
  if (h1s.length === 1) {
    // Older layout: the top card is the container around the one job-title h1.
    scope = climbScope(h1s[0], jobId, base);
  } else {
    // Current server-driven layout (live 2026-10-06): no h1 at all, the title is a styled <p>. The scope is
    // anchored on the apply controls and the closed/applied markers instead, each climbed with the same
    // rule, and kept only when it also contains the job title from <title>.
    const anchored = anchoredScope($, root, jobId, base);
    if (!anchored.scope) {
      obs.topCardMissing = anchored.missing;
      return obs;
    }
    scope = anchored.scope;
  }

  const text = textOf(scope, skipSubtree);
  /** @type {ObservedControl[]} */
  const controls = [];
  walk(scope, skipSubtree, (n) => {
    if (isControl(n)) controls.push(describeControl(n, base));
  });
  obs.topCardMissing = null;
  obs.topCard = { closed: CLOSED_RE.test(text), applied: APPLIED_RE.test(text), controls };
  return obs;
}

/**
 * Kind of one observed control. Total: every control is easy | external | suspicious | other.
 * @param {ObservedControl} c
 * @returns {'easy'|'external'|'suspicious'|'other'}
 */
function controlKind(c) {
  const all = `${c.ariaLabel} ${c.text}`;
  if (/easy\s*apply/.test(all)) {
    const ariaOk = c.ariaLabel === '' || c.ariaLabel === 'easy apply' || c.ariaLabel.startsWith('easy apply to ');
    if (c.text === 'easy apply' && ariaOk && !DENY.test(all)) return 'easy';
    return 'suspicious';
  }
  if (/^apply\b/.test(c.text) || /^apply\b/.test(c.ariaLabel)) return DENY.test(all) ? 'suspicious' : 'external';
  if (/\bapply\b/.test(all) && DENY.test(all)) return 'suspicious';
  return 'other';
}

/**
 * @typedef {Object} LinkedInApplyVerdict
 * @property {typeof LINKEDIN_APPLY_BRANCHES[number]} branch
 * @property {string} reason
 * @property {{ tag: 'button'|'link', name: string, href: string|null, path: string }|null} control the
 *   identified external control (external branch only)
 */

/**
 * Pure: classify a snapshot. Never throws; anything unrecognized is 'unknown'.
 * @param {LinkedInApplyObservation|null|undefined} obs
 * @returns {LinkedInApplyVerdict}
 */
export function classifyLinkedInApplyState(obs) {
  /** @param {LinkedInApplyVerdict['branch']} branch @param {string} reason */
  const out = (branch, reason, control = null) => ({ branch, reason, control });
  if (!obs || typeof obs !== 'object') return out('unknown', 'no_observation');
  const url = typeof obs.url === 'string' ? obs.url : '';
  const urlPath = (() => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  })();
  const status = typeof obs.httpStatus === 'number' ? obs.httpStatus : null;

  if (obs.loadError) {
    if (CHALLENGE_URL.test(urlPath)) return out('challenge', 'challenge_url');
    if (AUTH_URL.test(urlPath)) return out('auth_wall', 'auth_url');
    return out('load_failure', `load_error_${String(obs.loadError).toLowerCase()}`);
  }
  if (status === 429 || status === 999) return out('challenge', `http_${status}`);
  if (status !== null && status >= 400) return out('load_failure', `http_${status}`);
  if (obs.topCardMissing === 'no_document' && !obs.topCard && !obs.challengeMarker && !obs.authMarker) return out('load_failure', 'no_document');
  if (obs.challengeMarker || CHALLENGE_URL.test(urlPath)) return out('challenge', obs.challengeMarker ? 'challenge_marker' : 'challenge_url');
  if (obs.authMarker || AUTH_URL.test(urlPath)) return out('auth_wall', obs.authMarker ? 'auth_marker' : 'auth_url');
  if (obs.lang && !/^en(?:-|$)/.test(obs.lang)) return out('unknown', 'localized_page');
  const card = obs.topCard;
  if (!card) return out('unknown', `top_card_${obs.topCardMissing ?? 'missing'}`);
  if (card.closed) return out('closed', 'closed_marker');
  if (card.applied) return out('already_applied', 'applied_marker');

  /** @type {Map<string, ObservedControl>} */
  const easy = new Map();
  /** @type {Map<string, ObservedControl>} */
  const external = new Map();
  let disabledApply = 0;
  for (const c of Array.isArray(card.controls) ? card.controls : []) {
    const kind = controlKind(c);
    if (kind === 'other') continue;
    if (kind === 'suspicious') return out('unknown', 'suspicious_apply_control');
    if (c.disabled) {
      disabledApply++;
      continue;
    }
    if (kind === 'easy') easy.set(c.name, c);
    else external.set(`${c.name}|${c.href ?? ''}`, c);
  }
  if (easy.size > 0 && external.size > 0) return out('unknown', 'easy_and_external');
  if (easy.size > 1) return out('unknown', 'ambiguous_easy_apply');
  if (external.size > 1) return out('unknown', 'ambiguous_external');
  if (easy.size === 1) return out('easy_apply', 'one_easy_apply_control');
  if (external.size === 1) {
    const c = /** @type {ObservedControl} */ ([...external.values()][0]);
    let href = c.href;
    if (href && isLinkedInHostUrl(href)) {
      const decoded = decodeLinkedInSafetyGo(href);
      if (!decoded || isLinkedInHostUrl(decoded)) return out('unknown', 'external_on_linkedin_host');
      href = decoded;
    }
    if (href) {
      try {
        const p = new URL(href).protocol;
        if (p !== 'https:' && p !== 'http:') return out('unknown', 'external_bad_scheme');
      } catch {
        return out('unknown', 'external_bad_href');
      }
    }
    return out('external', href ? 'external_href' : 'external_button', { tag: c.tag, name: c.name, href, path: c.path });
  }
  if (disabledApply > 0) return out('unknown', 'disabled_apply_control_only');
  return out('no_control', 'no_apply_control');
}

/**
 * Navigate to one LinkedIn job URL and build its observation. Never throws: a navigation or read failure is
 * recorded as `loadError` (the classifier maps it to load_failure, or to challenge/auth_wall when the landed
 * URL says so -- the URL guard refuses /authwall and /checkpoint landings, so the landed URL is read back
 * from the raw page when available).
 * @param {{ goto: (url: string) => Promise<{ status: number|null, url: string }>, readHtml: () => Promise<string> }} cap
 * @param {{ url: () => Promise<string> }|null} page
 * @param {string} url
 * @returns {Promise<LinkedInApplyObservation>}
 */
export async function observeLinkedInPage(cap, page, url) {
  /** @type {string|null} */
  let loadError = null;
  /** @type {number|null} */
  let httpStatus = null;
  let landed = url;
  /** @type {string|null} */
  let html = null;
  const pageUrl = async () => {
    if (!page) return null;
    try {
      return await page.url();
    } catch {
      return null;
    }
  };
  try {
    const g = await cap.goto(url);
    httpStatus = g && typeof g.status === 'number' ? g.status : null;
    landed = (await pageUrl()) ?? (g && typeof g.url === 'string' ? g.url : url);
  } catch (err) {
    loadError = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : 'NAVIGATION_FAILED';
    landed = (await pageUrl()) ?? url;
  }
  if (!loadError) {
    try {
      html = await cap.readHtml();
    } catch {
      loadError = 'READ_FAILED';
    }
  }
  return buildLinkedInApplyObservation({ url: landed, html, loadError, httpStatus });
}
