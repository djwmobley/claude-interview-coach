// @ts-check
/**
 * Interactive verification for blocked detail pages (S6). When a detail fetch comes back blocked:* and
 * the run is interactive (dashboard or mcp trigger; the existing `interactive` flag in scan-run.js),
 * the source's own scan-Chrome page is already sitting on the blocked URL. "Pop" means: bring that
 * page to the front of the scan Chrome window so Damian can click the verification, show a notice, and
 * poll the page text every 15 s with classifyDetail until it stops classifying as blocked.
 *
 * Why the scan Chrome page and not the OS browser (google reauth's launchOsBrowser): clearing a
 * Cloudflare or Indeed challenge sets a clearance cookie in the browser profile that makes the
 * following fetches. The scan profile is the one that fetches, and only a page we hold can be polled.
 *
 * Limits: at most one pop per source per run, 10 minutes of total waiting per run across all sources.
 * Unattended runs never pop: they defer. Everything time-related is injected so the logic is testable
 * with fakes (no real sleeping, no browser).
 */
import { classifyDetail, isBlockedClass } from '../browser/detail-classify.js';

export const VERIFY_POLL_MS = 15000;
export const VERIFY_TOTAL_CAP_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} VerifyDeps
 * @property {boolean} interactive
 * @property {(source: string) => Promise<any>} capFor scan-Chrome capability for the source (null when no browser)
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(source: string, message: string) => (void|Promise<void>)} notify dashboard notice hook
 * @property {(f: any) => void} [log]
 * @property {number} [pollMs]
 * @property {number} [totalCapMs]
 * @property {AbortSignal} [signal]
 */

/**
 * @param {VerifyDeps} deps
 */
export function createVerifyCoordinator(deps) {
  const pollMs = deps.pollMs ?? VERIFY_POLL_MS;
  const totalCapMs = deps.totalCapMs ?? VERIFY_TOTAL_CAP_MS;
  const log = deps.log ?? (() => {});
  /** @type {Set<string>} */
  const popped = new Set();
  /** @type {Set<string>} */
  const deferred = new Set();
  let waitedMs = 0;

  /**
   * One blocked detail fetch for `source`. Resolves 'cleared' (caller retries the fetch once) or
   * 'deferred' (caller stops this source's detail fetches for the run).
   * @param {string} source
   * @param {{ url?: string|null, reason: string }} info
   * @returns {Promise<'cleared'|'deferred'>}
   */
  async function onBlocked(source, info) {
    if (!deps.interactive || popped.has(source) || deferred.has(source) || waitedMs >= totalCapMs) {
      deferred.add(source);
      return 'deferred';
    }
    popped.add(source);
    const cap = await deps.capFor(source);
    if (!cap) {
      deferred.add(source);
      return 'deferred';
    }
    const label = source.charAt(0).toUpperCase() + source.slice(1);
    try {
      if (typeof cap.bringToFront === 'function') await cap.bringToFront();
    } catch {
      /* best effort: the page is still open in the scan Chrome window */
    }
    await deps.notify(source, `${label} needs verification`);
    log({ evt: 'detail_verify_popped', source, reason: info.reason, url: info.url ?? null });
    while (waitedMs < totalCapMs) {
      if (deps.signal?.aborted) break;
      const slice = Math.min(pollMs, totalCapMs - waitedMs);
      await deps.sleep(slice);
      waitedMs += slice;
      let cls = 'blocked:captcha';
      try {
        const text = /** @type {string} */ (await cap.readJson('bodyText'));
        /** @type {any} */
        let markers = null;
        try {
          markers = await cap.readJson('wallMarkers');
        } catch {
          markers = null;
        }
        cls = classifyDetail({ text, url: markers?.url ?? info.url ?? null, wallSignals: markers });
      } catch {
        /* the page may be mid-navigation after the click: keep polling */
      }
      if (!isBlockedClass(cls)) {
        log({ evt: 'detail_verify_cleared', source, waited_ms: waitedMs });
        return 'cleared';
      }
    }
    deferred.add(source);
    log({ evt: 'detail_verify_timeout', source, waited_ms: waitedMs });
    return 'deferred';
  }

  /** The retry after 'cleared' blocked again: defer, never pop a second time. @param {string} source */
  function markDeferred(source) {
    deferred.add(source);
  }

  return {
    onBlocked,
    markDeferred,
    isDeferred: (/** @type {string} */ source) => deferred.has(source),
    get waitedMs() { return waitedMs; },
    get poppedSources() { return [...popped]; },
  };
}
