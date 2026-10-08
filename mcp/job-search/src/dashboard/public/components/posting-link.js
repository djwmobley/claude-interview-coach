// @ts-check
/** "Open posting" link to a listing's own URL. http(s) only, built through hLink's guarded path. */
import { h, hLink } from '../lib/dom.js';
import { manualPostingUrl } from '../lib/format.js';

/** @param {any} listing @returns {HTMLElement|null} */
export function postingLink(listing) {
  const url = manualPostingUrl(listing);
  if (!url) return null;
  return h('p', { className: 'application-card__hint' }, [hLink({ url, urlOk: true, text: 'Open posting', target: '_blank' })]);
}
