// @ts-check
/**
 * Target finder source adapters (PR2). The PR3 runner wires these together:
 *
 *   const net = createTargetNetwork({ configDir });            // guard + EDGAR client (or edgar:null)
 *   const fd  = await runFormD({ edgar: net.edgar, now, rules, blocked });
 *   const k8  = await run8k({ edgar: net.edgar, now, blocked });
 *   const fts = await runFts({ edgar: net.edgar, now, blocked, configDir });
 *   const al  = await runGoogleAlerts({ guard: net.guard, getAccessToken: makeGmailTokenProvider(tokenFile), now, blocked });
 *   const gap = await runGapSource({ query, departureFeeds: { fts: fts.stats, k8: k8.stats } });
 *   await persistItems(client, [...fd.items, ...k8.items, ...fts.items, ...al.items, ...gap.items]);
 *
 * Every adapter returns { items, stats }: items carry exactly one outcome each (parsed / unparseable /
 * out_of_scope) and stats count every raw item. Nothing here sends anything anywhere.
 */
import { createFetchGuard } from './fetch-guard.js';
import { createEdgarClient, secContactOrSkip } from './edgar-client.js';

export { runFormD } from './form-d.js';
export { run8k } from './edgar-8k.js';
export { runFts, loadFtsQueries } from './edgar-fts.js';
export { runGoogleAlerts, loadAlertPatterns, makeGmailTokenProvider } from './google-alerts.js';
export { runGapSource, departureFeedsRanClean } from './gap-source.js';
export { persistItems, recordSourceState } from './store.js';
export { DRAFTER_INPUT_FIELDS, pickDrafterInput } from './signal-text.js';
export { OUTCOMES, urlHash, summarizeStats } from './outcomes.js';

/**
 * One guard for the whole run (global request counter). The SEC contact comes from the gitignored
 * config/target-sec-contact.json; with no valid contact, `edgar` is null and every EDGAR adapter skips
 * itself with sec_contact_missing (zero requests) while the run proceeds.
 * @param {{ configDir?: string, fetch?: typeof fetch, maxRequests?: number, timing?: Parameters<typeof createEdgarClient>[0]['timing'], control?: { deadlineAt?: number|null, signal?: AbortSignal|null } }} [opts]
 */
export function createTargetNetwork(opts = {}) {
  const sec = secContactOrSkip(opts.configDir);
  const guard = createFetchGuard({
    fetch: opts.fetch ?? globalThis.fetch,
    userAgent: sec.ok ? sec.userAgent : null,
    ...(opts.maxRequests ? { maxRequests: opts.maxRequests } : {}),
  });
  const edgar = sec.ok ? createEdgarClient({ guard, timing: opts.timing, control: opts.control }) : null;
  return { guard, edgar, sec };
}
