// @ts-check
/**
 * Workday verify-email lookup (apply pipeline slice 6, plan section 3: "verify-email via the existing
 * Gmail token"). Reuses src/core/google.js's OWN auth path exactly the way src/adapters/gmail.js (the
 * scan source) already does: classifyAndConnect() with need: {gmailRead: true}, then a plain GET against
 * the same Gmail REST endpoints (GMAIL_MESSAGES_URL, messages.list then messages.get). There is no new
 * OAuth flow, no new token file, and no new scope here -- this is the SAME read-only Gmail access the
 * scan pipeline already has, reused to find an account-verification code/link instead of a job alert.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): the query and the code/link regexes below are
 * this build's best understanding of what a Workday tenant's verification email looks like -- they have
 * not been verified against a real Workday verification email in this sandboxed environment (no live
 * Gmail access here either: the Google refresh grant is currently invalid_grant, being re-authed
 * separately). The failure mode on a miss is safe by construction: no match returns `{ ok: true, code:
 * null, link: null }` (never a guessed code), and the caller (src/apply/adapters/workday.js) treats that
 * the same as "not found yet" -- it retries a bounded number of times, then parks in needs_human rather
 * than entering a wrong code (which risks a tenant-side lockout after repeated failed attempts).
 */
import { classifyAndConnect } from '../core/google.js';

export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/**
 * A verification code is only trusted when it appears near an explicit context word ("code",
 * "verification", "verify", "confirm", "pin") within the same short window of text -- never a bare
 * `\d{4,8}` scan of the whole email body, which would false-positive on a phone number, a zip code, an
 * order/tracking id, or a line from the email's own boilerplate footer.
 */
const CODE_CONTEXT_RE = /(?:verif(?:y|ication)|confirm(?:ation)?|security|access|one-time|login|sign-?in)[^\d]{0,40}\b(\d{4,8})\b/i;
/** Fallback: a clearly-labeled "code:" or "PIN:" line, still context-anchored. */
const CODE_LABEL_RE = /\b(?:code|pin)\s*[:#]?\s*(\d{4,8})\b/i;
/** A verification/confirm/activate link inside the message body. */
const LINK_RE = /https?:\/\/[^\s"'<>]*(?:verify|verification|confirm|activate)[^\s"'<>]*/i;

/**
 * base64url (Gmail body.data) -> utf8 text. Duplicated (not imported) from src/adapters/gmail.js
 * deliberately: that module lives on the scan side, and this apply-side module intentionally does not
 * take a dependency on it (test/apply-lint.test.js's existing lint rule already keeps the scan side from
 * importing src/apply/*; this is the same separation held in the other direction, and it keeps this
 * ~5-line decode self-contained rather than coupling two otherwise-unrelated pipelines over a shared
 * private helper).
 * @param {string} s
 */
function base64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * Recursively walk a Gmail message payload to any depth, collecting the first text/plain and first
 * text/html leaf found.
 * @param {any} part
 * @param {{ text: string|null, html: string|null }} out
 */
function collectBodyParts(part, out) {
  if (!part) return;
  if (part.mimeType === 'text/plain' && !out.text && part.body && typeof part.body.data === 'string') {
    out.text = base64urlDecode(part.body.data);
  }
  if (part.mimeType === 'text/html' && !out.html && part.body && typeof part.body.data === 'string') {
    out.html = base64urlDecode(part.body.data);
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectBodyParts(p, out);
  }
}

/**
 * Strip HTML tags down to plain-ish text so the code/link regexes can scan an HTML-only email body the
 * same way they scan a text/plain one. Not a real HTML parser (this module has no DOM); good enough for
 * regex matching, never used for anything security-sensitive beyond that.
 * @param {string} html
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ');
}

/**
 * Extract a code and/or link from one message's decoded body. Total: no match in either part yields
 * `{ code: null, link: null }`, never a throw.
 * @param {{ text: string|null, html: string|null }} parts
 */
export function extractVerification(parts) {
  const text = parts.text ?? '';
  const htmlText = parts.html ? stripTags(parts.html) : '';
  const combined = `${text}\n${htmlText}`;
  const codeMatch = CODE_CONTEXT_RE.exec(combined) ?? CODE_LABEL_RE.exec(combined);
  const linkMatch = LINK_RE.exec(parts.html ?? '') ?? LINK_RE.exec(text);
  return { code: codeMatch ? codeMatch[1] : null, link: linkMatch ? linkMatch[0] : null };
}

/**
 * @typedef {{ ok: true, code: string|null, link: string|null } | { ok: false, reason: string }} VerifyResult
 */

/**
 * Search the owner's Gmail inbox for a Workday tenant's verification email sent after `sentAfter`, and
 * extract a code and/or link from the newest matching message. Never throws for an auth or network
 * problem -- every failure is a typed `{ ok: false, reason }` the caller parks on, exactly like
 * src/adapters/gmail.js's own AUTH_UNAVAILABLE treatment for the scan pipeline.
 * @param {{ tokenFile: string, tenantHost: string, sentAfter: Date, fetch?: typeof fetch,
 *   deps?: { readTokenFile?: Function, makeOAuthClient?: Function, getAccessToken?: Function } }} o
 * @returns {Promise<VerifyResult>}
 */
export async function findVerificationMessage(o) {
  if (typeof o.tokenFile !== 'string' || !o.tokenFile) return { ok: false, reason: 'no_token_file' };
  const { state, accessToken } = await classifyAndConnect(o.tokenFile, { gmailRead: true }, o.deps ?? {});
  if (state.state !== 'ok' || !accessToken) return { ok: false, reason: `gmail_auth_${state.state}` };

  const fetchFn = o.fetch ?? fetch;
  const afterEpoch = Math.floor(o.sentAfter.getTime() / 1000);
  // Workday tenant senders are not a fixed, curated list the way config/alert-senders.json is for the
  // scan pipeline (every tenant runs its own instance and picks its own From address) -- so this searches
  // broadly on subject/body wording plus the tenant's own subdomain token, rather than a from: allowlist.
  const tenantToken = String(o.tenantHost).split('.')[0].replace(/[^a-z0-9-]/gi, '');
  const q = `newer_than:1d after:${afterEpoch} (subject:verif OR subject:confirm OR from:workday OR from:myworkdayjobs${tenantToken ? ` OR from:${tenantToken}` : ''})`;
  const listUrl = new URL(GMAIL_MESSAGES_URL);
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('maxResults', '5');
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  let listRes;
  try {
    listRes = await fetchFn(listUrl.toString(), { headers: authHeader });
  } catch (err) {
    return { ok: false, reason: `gmail_list_network_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
  if (listRes.status === 401) return { ok: false, reason: 'gmail_list_401' };
  if (listRes.status !== 200) return { ok: false, reason: `gmail_list_http_${listRes.status}` };
  /** @type {any} */
  let listJson;
  try {
    listJson = await listRes.json();
  } catch {
    return { ok: false, reason: 'gmail_list_bad_json' };
  }
  const ids = Array.isArray(listJson.messages) ? listJson.messages.map((/** @type {any} */ m) => String(m.id)) : [];

  for (const id of ids) {
    let getRes;
    try {
      getRes = await fetchFn(`${GMAIL_MESSAGES_URL}/${id}?format=full`, { headers: authHeader });
    } catch {
      continue; // one message failing to fetch never aborts the whole search
    }
    if (getRes.status === 401) return { ok: false, reason: 'gmail_get_401' };
    if (getRes.status !== 200) continue;
    /** @type {any} */
    let msg;
    try {
      msg = await getRes.json();
    } catch {
      continue;
    }
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms) && ms > 0 && ms < o.sentAfter.getTime() - 60000) continue; // stale message, well before the account-creation attempt (1 min slack for clock skew)
    /** @type {{ text: string|null, html: string|null }} */
    const parts = { text: null, html: null };
    collectBodyParts(msg.payload, parts);
    const { code, link } = extractVerification(parts);
    if (code || link) return { ok: true, code, link };
  }
  return { ok: true, code: null, link: null };
}
