// @ts-check
/**
 * Pure request-body builder for the Home "Run scan" options drawer's POST /api/scans call
 * (components/run-scan-drawer.js). Kept free of DOM access, matching pr3-spec-decisions.md section 12
 * item 2's rule that pure logic lives in lib/ so it runs identically under node:test and in the browser.
 */

/**
 * @param {{ allSources: string[], checked?: Record<string, boolean>, dryRun?: boolean }} opts
 * @returns {{ sources: string[], dryRun: boolean }}
 */
export function buildScanRequestBody(opts) {
  const allSources = Array.isArray(opts.allSources) ? opts.allSources.filter((s) => typeof s === 'string' && s) : [];
  const checked = opts.checked && typeof opts.checked === 'object' ? opts.checked : {};
  // Default = every known source enabled: a source only drops out of the request when its checkbox has
  // been explicitly unchecked (checked[name] === false), never merely by being absent from `checked`.
  // This matches the drawer's own default (every checkbox starts checked) without the drawer needing to
  // populate `checked` for sources the user never touched.
  const sources = allSources.filter((name) => checked[name] !== false);
  return { sources, dryRun: Boolean(opts.dryRun) };
}
