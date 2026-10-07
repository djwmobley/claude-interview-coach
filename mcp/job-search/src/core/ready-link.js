// @ts-check
/**
 * Ready to apply list: link handling (spec 7.1, amended by A8). Replaces report.js's source-domain
 * registry check (urlPassesRegistry) for the Ready section only, because a recruiter or company career
 * site never passes that registry and is exactly the link this list exists to show.
 *
 * readyLinkCheck() is a TOTAL classification, first match wins:
 *   no_link            null, non-string, or blank
 *   (LinkedIn safety/go wrapper: decoded first, then the destination goes through every check below;
 *    a wrapper that does not decode is redirector_host)
 *   invalid_url        does not parse
 *   too_long           more than 2048 characters
 *   bad_scheme         anything but http: or https: (A8: http(s) only)
 *   credentials_in_url a username or password in the URL
 *   private_host       an IP literal, localhost, or a .local/.internal name
 *   tracker_host       a known email tracker host (src/core/gmail-detail.js TRACKER_HOSTS, Lensa /cgw/)
 *   redirector_host    a URL shortener or click-redirect host (REDIRECTOR_HOSTS, or a first label in
 *                      REDIRECTOR_LABELS); A8: no redirector is allowlisted
 *   denied_path        an account or tracking path (A8 denylist)
 *   ok
 * UNSAFE_LINK_REASONS are the ones the list shows WITHOUT a link and counts (bucket held_unsafe_link);
 * no_link and invalid_url are simply "no usable link" (held_no_link).
 *
 * normalizeTargetKey() is the shared URL identity for the manual-only lockout (A2) and the list's dedup
 * (A7): src/core/normalize.js's normalizeUrl (canonical LinkedIn/Indeed job ids, tracking params dropped,
 * case and trailing slash folded) without its scheme.
 */
import { normalizeUrl } from './normalize.js';
import { TRACKER_HOSTS } from './gmail-detail.js';
import { decodeLinkedInSafetyGo } from '../apply/apply-target.js';

export const READY_LINK_REASONS = Object.freeze([
  'no_link', 'invalid_url', 'too_long', 'bad_scheme', 'credentials_in_url', 'private_host', 'tracker_host', 'redirector_host', 'denied_path',
]);

/** Reasons a link is refused as unsafe (shown without the link, counted as held_unsafe_link). */
export const UNSAFE_LINK_REASONS = Object.freeze(['too_long', 'bad_scheme', 'credentials_in_url', 'private_host', 'tracker_host', 'redirector_host', 'denied_path']);

/** URL shorteners and mail-security rewriters: exact host or any subdomain. */
export const REDIRECTOR_HOSTS = Object.freeze([
  't.co', 'bit.ly', 'lnkd.in', 'tinyurl.com', 'ow.ly', 'goo.gl', 'buff.ly', 'rebrand.ly', 'is.gd', 'cutt.ly', 'shorturl.at',
  'safelinks.protection.outlook.com', 'urldefense.com', 'urldefense.proofpoint.com', 'linksynergy.com', 'sendgrid.net',
  'mailchimp.com', 'list-manage.com', 'hubspotlinks.com', 'mandrillapp.com', 'mailgun.org',
]);

/** A first host label that marks a click-tracking subdomain (click.mail.acme.com, links.acme.com). */
export const REDIRECTOR_LABELS = Object.freeze(['click', 'clicks', 'links', 'link', 'trk', 'track', 'tracking', 'redirect', 'url', 'email', 'mail', 'em']);

const PATH_DENY_RE = /(?:^|[^a-z])(unsubscribe|optout|opt-out|preferences|one-click|oneclick|confirm|verify)(?:[^a-z]|$)/i;
const PATH_SEGMENT_DENY_RE = /(?:^|\/)(?:track|click)(?:[/._-]|$)/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_LINK_CHARS = 2048;

/** @param {string} host @param {string} domain */
function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, url: string, host: string } | { ok: false, reason: typeof READY_LINK_REASONS[number] }}
 */
export function readyLinkCheck(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'no_link' };
  let raw = input.trim();
  if (/^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/safety\/go/i.test(raw)) {
    const decoded = decodeLinkedInSafetyGo(raw);
    if (!decoded) return { ok: false, reason: 'redirector_host' };
    raw = decoded;
  }
  /** @type {URL} */
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (raw.length > MAX_LINK_CHARS) return { ok: false, reason: 'too_long' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'bad_scheme' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'invalid_url' };
  if (host.startsWith('[') || host.includes(':') || IPV4_RE.test(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, reason: 'private_host' };
  }
  if (TRACKER_HOSTS.includes(host) || ((host === 'lensa.com' || host === 'www.lensa.com') && u.pathname.startsWith('/cgw/'))) return { ok: false, reason: 'tracker_host' };
  if (REDIRECTOR_HOSTS.some((d) => hostIs(host, d))) return { ok: false, reason: 'redirector_host' };
  const labels = host.split('.');
  if (labels.length > 2 && REDIRECTOR_LABELS.includes(labels[0])) return { ok: false, reason: 'redirector_host' };
  const path = (() => {
    try {
      return decodeURIComponent(u.pathname);
    } catch {
      return u.pathname;
    }
  })();
  if (PATH_DENY_RE.test(path) || PATH_SEGMENT_DENY_RE.test(path)) return { ok: false, reason: 'denied_path' };
  return { ok: true, url: raw, host };
}

/**
 * Shared URL identity (scheme dropped). Null for anything that does not parse as http(s).
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeTargetKey(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const n = normalizeUrl(input.trim());
  if (!n.url_normalized) {
    try {
      const u = new URL(input.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      return `${host}${u.pathname.toLowerCase().replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  }
  return n.url_normalized.replace(/^https?:\/\//i, '').replace(/^www\./, '').toLowerCase();
}
