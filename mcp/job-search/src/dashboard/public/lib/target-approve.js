// @ts-check
/**
 * The copy-and-approve flow for a target note (plan 19.6, F11). The only module in the dashboard that touches
 * the clipboard; it sends nothing anywhere.
 *
 * Order, always:
 *   1. preflight   GET: the server re-checks eligibility (blocked first, versions, checks) and returns the
 *                  exact text and its hash. A refused preflight copies nothing.
 *   2. copy        the browser writes the server's text to the clipboard. If the copy fails, nothing is posted.
 *   3. approve     POST with the hash and both versions. If the server refuses it, the clipboard is cleared, so
 *                  a refused approval never leaves a note on the clipboard.
 *
 * Pure apart from the injected functions, so it is unit-tested without a DOM.
 */

/**
 * @typedef {Object} FlowDeps
 * @property {() => Promise<import('./api.js').ApiOutcome>} preflight GET preflight (resolves a classified outcome)
 * @property {(text: string) => Promise<void>} writeClipboard
 * @property {() => Promise<void>} clearClipboard
 * @property {(pre: any) => Promise<import('./api.js').ApiOutcome>} approve POST approve, built from the preflight body
 */

/**
 * @param {FlowDeps} d
 * @returns {Promise<{ status: 'approved', outcome: import('./api.js').ApiOutcome } | { status: 'refused_preflight'|'copy_failed'|'refused_approve', outcome: import('./api.js').ApiOutcome|null }>}
 */
export async function approveFlow(d) {
  const pre = await d.preflight();
  if (pre.kind !== 'ok' || !pre.body || typeof pre.body.text !== 'string' || pre.body.text === '') return { status: 'refused_preflight', outcome: pre };
  try {
    await d.writeClipboard(pre.body.text);
  } catch {
    return { status: 'copy_failed', outcome: null };
  }
  let res;
  try {
    res = await d.approve(pre.body);
  } catch {
    res = /** @type {import('./api.js').ApiOutcome} */ ({ kind: 'network_error' });
  }
  if (res.kind !== 'ok') {
    try {
      await d.clearClipboard();
    } catch { /* best effort: the page tells the person the approval failed */ }
    return { status: 'refused_approve', outcome: res };
  }
  return { status: 'approved', outcome: res };
}

/** The browser clipboard, behind two small functions the page passes to approveFlow. */
export const browserClipboard = Object.freeze({
  /** @param {string} text */
  write: (text) => navigator.clipboard.writeText(text),
  clear: () => navigator.clipboard.writeText(''),
});
