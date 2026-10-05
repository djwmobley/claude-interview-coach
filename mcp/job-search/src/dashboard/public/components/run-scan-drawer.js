// @ts-check
/**
 * "Run scan" options drawer (Home's action bar). The primary "Run scan" button opens this drawer rather
 * than starting a scan directly -- the single-primary-button-per-page rule (action-bar.js's own doc
 * comment) still holds, because the drawer's "Start" button is the one control that actually starts a
 * scan. Source checkboxes come from GET /api/profiles' `sources` field (config/adapters.json's own keys,
 * the same set src/core/scan-run.js's resolveSources() validates against), default all checked; "Dry
 * run" defaults off. POST /api/scans body is `{ sources, dryRun }`, built by the pure
 * lib/scan-options.js#buildScanRequestBody so the request shape is unit-testable without a DOM.
 *
 * Google auth row (spec A9, extended 2026-09-17 incident follow-up): ALWAYS rendered, branching on
 * GET /api/google/auth's `category` field (never the raw `state` string -- see computeGoogleAuthBadgeState
 * below). A "Recheck" button (re-GETs /api/google/auth) is always present; a "Re-authorize Google" button
 * (POSTs /api/google/reauth) is added alongside it only when category is not 'ok' -- spec: "ok -> ...
 * Recheck button only; broken -> ... plus enabled Re-authorize Google button; anything else -> ... plus
 * enabled Re-authorize Google button".
 *
 * The badge/button classification and the post-click classification are both pure, DOM-free functions
 * (this codebase has no jsdom -- see test/dashboard-public-linksafety.test.js's note on
 * hApplicationScreenshot for the house convention: an `h()`-calling render function itself is exercised
 * through the running app, not a unit test; the pure halves that decide WHAT to render are what get
 * unit-tested here, same split as components/background-banner.js's
 * dismissKeyFor()/visibleBackgroundItems()).
 */
import { h, hLink, setChildren } from '../lib/dom.js';
import { openableConsentUrl } from '../lib/consent-url.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { sourceLabel, hhmm } from '../lib/format.js';
import { drawer } from './drawer.js';
import { buildScanRequestBody } from '../lib/scan-options.js';

/**
 * Pure classification of a GET /api/google/auth response body into everything the auth row needs to
 * render. Branches on `category` (a total classification the server itself computes), never on the raw
 * `state` string -- 'ok' -> green/ok tone, no Re-authorize button; 'broken' -> red/error tone with the
 * state text and an enabled Re-authorize button; anything else (an unrecognized category, a missing
 * `category` field, or `body === null` for a failed GET) folds into the same neutral "state unknown"
 * branch with an enabled Re-authorize button -- never a blank/absent row.
 * @param {{ category?: string, state?: string, reauth?: any }|null} body the parsed GET
 *   /api/google/auth body on success, or null when the GET itself failed (network error, unparsable
 *   body, non-2xx status).
 * @returns {{
 *   tone: 'ok'|'error'|'neutral',
 *   message: string,
 *   showReauthButton: boolean,
 *   reauthButtonEnabled: boolean,
 *   runningLine: string|null,
 *   lastAttemptLine: string|null,
 *   consentUrl: string|null,
 * }}
 */
export function computeGoogleAuthBadgeState(body) {
  const category = body && typeof body.category === 'string' ? body.category : null;
  const reauth = body && body.reauth && typeof body.reauth === 'object' ? body.reauth : {};
  const running = Boolean(reauth.running);

  /** @type {'ok'|'error'|'neutral'} */
  let tone;
  /** @type {string} */
  let message;
  let showReauthButton;
  if (category === 'ok') {
    tone = 'ok';
    message = 'Google auth is connected.';
    showReauthButton = false;
  } else if (category === 'broken') {
    tone = 'error';
    const stateText = body && typeof body.state === 'string' ? body.state : 'broken';
    message = `Google auth needs consent (${stateText}).`;
    showReauthButton = true;
  } else {
    tone = 'neutral';
    const raw = body && typeof body.state === 'string' ? body.state : 'no response';
    message = `Google auth state unknown (${raw}).`;
    showReauthButton = true;
  }

  const runningLine = running
    ? `Consent helper running since ${hhmm(reauth.startedAt)}${Number.isFinite(reauth.pid) ? ` (pid ${reauth.pid})` : ''}, waits until ${hhmm(reauth.waitsUntil)}`
    : null;
  // Only shown when NOT currently running and the token is not already ok (spec: "If reauth.lastOutcome
  // is set and category is not ok").
  const lastAttemptLine = (!running && category !== 'ok' && reauth.lastOutcome)
    ? `Last attempt: ${reauth.lastOutcome} at ${hhmm(reauth.lastOutcomeAt)}`
    : null;

  // Persistent "Open Google sign-in" link (2026-10-04, spec S6): whenever a helper is waiting and the
  // server handed back a consent URL that ALSO classifies OPEN here, so lock_held and scan-spawned
  // helpers complete with one click.
  const consentUrl = running ? consentLinkFrom(reauth) : null;

  return { tone, message, showReauthButton, reauthButtonEnabled: showReauthButton && !running, runningLine, lastAttemptLine, consentUrl };
}

export const CONSENT_UNAVAILABLE_MESSAGE = 'Consent link unavailable; check logs/google-reauth-helper.out.log';
export const POPUP_BLOCKED_MESSAGE = 'Popup blocked: use the Open Google sign-in link';

/**
 * The consent URL carried on an API body (`consentUrl` + `consentExpect`), only when it classifies OPEN
 * (lib/consent-url.js, the same total classification the server ran). Anything else -> null.
 * @param {any} obj
 * @returns {string|null}
 */
export function consentLinkFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return openableConsentUrl(obj.consentUrl, obj.consentExpect);
}

/**
 * Total decision for the blank tab the click opened synchronously (spec S6).
 *   no helper waiting (not started, not lock_held)  -> close it; the existing inline text explains why
 *   popup blocked (window.open returned null)        -> no tab handling; point at the persistent link
 *   an OPEN consent URL                               -> navigate the tab to it
 *   anything else (REJECT, or polling timed out)      -> close it with the unavailable message
 * @param {{ popupOpened: boolean, consentUrl: string|null, helperWaiting: boolean }} o
 * @returns {{ action: 'navigate'|'close'|'none', inline: string|null }}
 */
export function decideConsentTab(o) {
  if (!o.helperWaiting) return { action: 'close', inline: null };
  if (!o.popupOpened) return { action: 'none', inline: POPUP_BLOCKED_MESSAGE };
  if (o.consentUrl) return { action: 'navigate', inline: null };
  return { action: 'close', inline: CONSENT_UNAVAILABLE_MESSAGE };
}

/** Spec S6: when POST returns no link yet, keep polling GET /api/google/auth every 1 s for up to 30 s. */
const CONSENT_POLL_INTERVAL_MS = 1000;
const CONSENT_POLL_MAX_MS = 30000;

/** @returns {Promise<string|null>} */
async function pollForConsentUrl() {
  const deadline = Date.now() + CONSENT_POLL_MAX_MS;
  let notRunningStreak = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONSENT_POLL_INTERVAL_MS));
    const o = await getJson('/api/google/auth');
    if (o.kind !== 'ok') continue;
    const reauth = /** @type {any} */ (o.body)?.reauth;
    const url = reauth && reauth.running ? consentLinkFrom(reauth) : null;
    if (url) return url;
    // Three consecutive "no helper running" answers: the helper exited, nothing more will appear.
    notRunningStreak = reauth && reauth.running === false ? notRunningStreak + 1 : 0;
    if (notRunningStreak >= 3) return null;
  }
  return null;
}

/**
 * Pure classification of what the Re-authorize button's click handler does once POST
 * /api/google/reauth's lib/api.js#classify()-shaped outcome comes back. Total: every `outcome.kind` maps
 * to an action, so the button can never be left silently disabled with no explanation and no way to
 * retry.
 * @param {{ kind: string, body?: any }} outcome
 * @returns {{ reenable: boolean, toast: string|null, inline: string|null }}
 */
export function nextGoogleReauthClickState(outcome) {
  if (outcome.kind !== 'ok') {
    // handleOutcome() already surfaced a toast for network_error/unparsable/rejected_request/etc. This
    // click only needs to decide whether the button becomes clickable again.
    return { reenable: true, toast: null, inline: null };
  }
  const body = /** @type {any} */ (outcome.body ?? {});
  if (body.started) {
    return { reenable: false, toast: 'Consent tab opening; approve it, then Recheck', inline: null };
  }
  const reason = typeof body.reason === 'string' ? body.reason : 'unknown';
  if (reason === 'lock_held') {
    // A helper is already running elsewhere (another tab, or the unattended scan policy) -- retrying
    // immediately would just get lock_held again; the row's own Recheck is the way forward here.
    return { reenable: false, toast: null, inline: 'A consent helper is already running.' };
  }
  return { reenable: true, toast: null, inline: `Could not start: ${reason}.` };
}

/**
 * Renders the auth row into `host` (replacing its children) from a GET /api/google/auth outcome.
 * @param {HTMLElement} host
 * @param {import('../lib/api.js').ApiOutcome} authOutcome
 * @param {string|null} [inlineText] message carried over a re-render (e.g. after a Re-authorize click)
 */
function renderGoogleAuthRow(host, authOutcome, inlineText = null) {
  const body = authOutcome.kind === 'ok' ? /** @type {any} */ (authOutcome.body) : null;
  const s = computeGoogleAuthBadgeState(body);

  let recheckInFlight = false;
  let reauthInFlight = false;
  /** @type {HTMLElement} */
  let inlineEl;

  const recheckBtn = h('button', {
    className: 'btn btn--small',
    text: 'Recheck',
    on: {
      click: async () => {
        if (recheckInFlight || reauthInFlight) return; // client-side double-submit guard
        recheckInFlight = true;
        /** @type {any} */ (recheckBtn).disabled = true;
        const next = handleOutcome(await getJson('/api/google/auth'));
        renderGoogleAuthRow(host, next); // re-renders in place, replacing this whole row (including this button)
      },
    },
  });

  const rowChildren = [
    h('p', { className: 'drawer__hint' }, [
      h('span', { className: `badge badge--${s.tone}`, text: s.message }),
      recheckBtn,
    ]),
  ];

  if (s.showReauthButton) {
    const reauthBtn = h('button', {
      className: 'btn btn--small',
      text: 'Re-authorize Google',
      disabled: !s.reauthButtonEnabled,
      on: {
        click: async () => {
          if (reauthInFlight || recheckInFlight) return; // client-side double-submit guard
          // Spec S6 (2026-10-04): open the tab SYNCHRONOUSLY inside the click (the only moment a popup
          // blocker allows it), before any await. No noopener here: this page needs the handle to
          // navigate it once the consent URL is known; opener is cleared right after navigating.
          /** @type {Window|null} */
          let w = null;
          try {
            w = window.open('about:blank');
          } catch {
            w = null;
          }
          reauthInFlight = true;
          /** @type {any} */ (reauthBtn).disabled = true;
          reauthBtn.textContent = 'Opening Google...';
          const outcome = await postJson('/api/google/reauth', {});
          const next = nextGoogleReauthClickState(outcome);
          // POST /api/google/reauth always answers 200 with its own reason/started fields, so
          // outcome.kind is normally 'ok' here; handleOutcome() still runs for the
          // network_error/unparsable/etc. branches nextGoogleReauthClickState() treats as "just re-enable".
          if (outcome.kind !== 'ok') handleOutcome(outcome);
          const body = outcome.kind === 'ok' ? /** @type {any} */ (outcome.body) : null;
          const helperWaiting = Boolean(body && (body.started || body.reason === 'lock_held'));
          let consentUrl = body ? consentLinkFrom(body) : null;
          if (!consentUrl && helperWaiting) {
            reauthBtn.textContent = 'Waiting for Google link...';
            consentUrl = await pollForConsentUrl();
          }
          const tab = decideConsentTab({ popupOpened: Boolean(w), consentUrl, helperWaiting });
          if (tab.action === 'navigate' && w && consentUrl) {
            try {
              w.location.href = consentUrl;
              w.opener = null;
            } catch {
              /* the tab was closed by the operator meanwhile; the persistent link below still works */
            }
          } else if (tab.action === 'close' && w) {
            try {
              w.close();
            } catch {
              /* already closed */
            }
          }
          reauthInFlight = false;
          /** @type {any} */ (reauthBtn).disabled = !next.reenable;
          reauthBtn.textContent = 'Re-authorize Google';
          if (next.toast && tab.action === 'navigate') showToast({ message: next.toast, tone: 'info' });
          const inline = tab.inline ?? next.inline;
          // Re-render from a fresh GET so the persistent "Open Google sign-in" link appears when a
          // helper is waiting, carrying this click's message over.
          if (helperWaiting) {
            renderGoogleAuthRow(host, await getJson('/api/google/auth'), inline);
          } else if (inline) {
            inlineEl.textContent = inline;
          }
        },
      },
    });
    rowChildren[0].appendChild(reauthBtn);
  }

  if (s.runningLine) rowChildren.push(h('p', { className: 'drawer__hint', text: s.runningLine }));
  if (s.consentUrl) {
    // consentUrl already classified OPEN (computeGoogleAuthBadgeState); hLink re-validates the scheme.
    rowChildren.push(h('p', { className: 'drawer__hint' }, [hLink({ url: s.consentUrl, urlOk: true, text: 'Open Google sign-in', target: '_blank' })]));
  }
  if (s.lastAttemptLine) rowChildren.push(h('p', { className: 'drawer__hint', text: s.lastAttemptLine }));
  inlineEl = h('p', { className: 'drawer__hint', text: inlineText ?? '' });
  rowChildren.push(inlineEl);

  setChildren(host, rowChildren);
}

/** @param {{ onStarted?: () => void }} [opts] */
export async function openRunScanDrawer(opts = {}) {
  const outcome = handleOutcome(await getJson('/api/profiles'));
  const allSources = outcome.kind === 'ok' && Array.isArray(outcome.body.sources) ? outcome.body.sources : [];

  // Google auth row (spec A9, extended 2026-09-17): ALWAYS rendered (never conditional -- a failed GET
  // is its own "state unknown" branch inside computeGoogleAuthBadgeState/renderGoogleAuthRow above), so
  // the operator always knows what will happen to Gmail auth the moment they click Start.
  const authHost = h('div', { className: 'drawer__field' });
  getJson('/api/google/auth').then((authOutcome) => renderGoogleAuthRow(authHost, authOutcome));

  /** @type {Record<string, HTMLInputElement>} */
  const checkboxes = {};
  const sourceRows = allSources.length === 0
    ? [h('p', { className: 'drawer__hint', text: 'No configured sources found.' })]
    : allSources.map((name) => {
        const cb = h('input', { attrs: { type: 'checkbox' }, checked: true });
        checkboxes[name] = /** @type {HTMLInputElement} */ (cb);
        return h('label', { className: 'drawer__checkbox-row' }, [cb, h('span', { text: sourceLabel(name) })]);
      });

  const dryRunCheckbox = h('input', { attrs: { type: 'checkbox' }, checked: false });

  async function start() {
    /** @type {Record<string, boolean>} */
    const checked = {};
    for (const [name, cb] of Object.entries(checkboxes)) checked[name] = cb.checked;
    const body = buildScanRequestBody({ allSources, checked, dryRun: dryRunCheckbox.checked });
    const res = handleOutcome(await postJson('/api/scans', body));
    if (res.kind === 'ok') {
      showToast({ message: body.dryRun ? 'Dry run started.' : 'Scan started.' });
      close();
      opts.onStarted?.();
    }
  }

  const { el, close } = drawer({
    title: 'Run scan',
    body: [
      authHost,
      h('div', { className: 'drawer__field' }, [h('span', { text: 'Sources' }), ...sourceRows]),
      h('label', { className: 'drawer__checkbox-row' }, [dryRunCheckbox, h('span', { text: 'Dry run (no writes)' })]),
      h('div', { className: 'drawer__actions' }, [
        h('button', { className: 'btn btn--primary', text: 'Start', on: { click: start } }),
        h('button', { className: 'btn', text: 'Cancel', on: { click: () => close() } }),
      ]),
    ],
  });
  document.body.appendChild(el);
}
