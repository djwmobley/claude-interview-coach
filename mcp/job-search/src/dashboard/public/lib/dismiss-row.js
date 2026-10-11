// @ts-check
/**
 * Optimistic row removal for the Jobs page Dismiss button. The row element leaves the DOM at once; if the
 * server call reports anything but success (or throws), the same element goes back where it was.
 * DOM-light on purpose (parentNode, nextSibling, insertBefore, remove) so it is unit-testable with fakes.
 */

/**
 * @param {{ parentNode: any, nextSibling: any, remove: () => void }} tr the row element
 * @param {() => Promise<boolean>} send performs the server call; resolves true only on success
 * @returns {Promise<boolean>} true when the dismissal stuck, false when the row was restored
 */
export async function dismissRowOptimistic(tr, send) {
  const parent = tr.parentNode;
  const next = tr.nextSibling;
  tr.remove();
  let ok = false;
  try {
    ok = (await send()) === true;
  } catch {
    ok = false;
  }
  if (!ok && parent) {
    // If the old next sibling is gone (a re-render raced us) append instead of throwing.
    const anchor = next && next.parentNode === parent ? next : null;
    parent.insertBefore(tr, anchor);
  }
  return ok;
}
