// @ts-check
/**
 * Target finder source D: EDGAR 8-K Item 5.02 (plan 14.4 D, 15.2 items 1, 5, 8, 10).
 *
 * Discovery: full-text search for "Item 5.02" on forms 8-K and 8-K/A, last 30 days, up to 3 pages. Hits
 * whose `items` include 5.02 are kept; the main document is fetched (read-capped) and the text between a
 * line starting "Item 5.02" and the next "Item N.NN" heading is cut.
 *
 * Departure vs appointment (src/targets/text-extract.js analyzeDeparture): a departure verb counts only
 * when the title NEAREST to it is a CTO-class role. A departure verb that binds to nothing, or a section
 * with both a bound departure and a bound appointment, sets departure_ambiguous (the classifier sends it to
 * needs-review). An appointment-only section is out_of_scope. The FULL document is scanned for blocked
 * names before the section is truncated.
 *
 * 8-K/A: ingested as its own signal (its own accession). There is no machine-readable link to the original
 * 8-K, so supersession is by the classification dedup (same company group, newest date) rather than by key.
 */
import { normalizeCompany } from '../core/normalize.js';
import {
  validCik, validAdsh, validFilename, indexUrl, docUrl, searchUrl, daysBefore, parseSearchResponse,
} from './edgar-client.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash, TEXT_MAX,
} from './signal-text.js';
import { htmlToPlain, extractCoverDate, analyzeDeparture, extractContact, cutItem502 } from './text-extract.js';
import { cleanDisplayName } from './form-d.js';

export const EIGHT_K_SOURCE = 'edgar_8k';
export const EIGHT_K_PARSER_VERSION = '8k-1';
export const EIGHT_K_REASONS = Object.freeze([
  'section_not_found', 'no_date_at_all', 'hit_shape_unknown', 'doc_fetch_failed', 'accession_malformed', 'cik_malformed',
  'company_missing', 'unknown_shape', 'no_cto_class_role', 'appointment_only', 'item_not_502', 'run_cap',
]);
export const EIGHT_K_WINDOW_DAYS = 30;
export const EIGHT_K_MAX_PAGES = 3;
export const EIGHT_K_PAGE_SIZE = 100;

/**
 * @param {Object} ctx
 * @param {import('./edgar-client.js').EdgarClient|null} ctx.edgar
 * @param {Date} ctx.now
 * @param {string[]} ctx.blocked
 * @param {number} [ctx.blockedMinLength]
 */
export async function run8k(ctx) {
  const c = createCollector(EIGHT_K_SOURCE, EIGHT_K_REASONS, EIGHT_K_PARSER_VERSION);
  if (!ctx.edgar) { c.skip('sec_contact_missing'); return { items: c.items, stats: c.stats }; }
  if (ctx.edgar.blocked) { c.skip('sec_blocked'); return { items: c.items, stats: c.stats }; }
  const edgar = ctx.edgar;
  const enddt = daysBefore(ctx.now, 0);
  const startdt = daysBefore(ctx.now, EIGHT_K_WINDOW_DAYS);

  /** @type {Array<import('./edgar-client.js').SearchHit>} */
  const hits = [];
  const seen = new Set();
  for (let page = 0; page < EIGHT_K_MAX_PAGES; page += 1) {
    const r = await edgar.search(searchUrl({ q: '"Item 5.02"', forms: '8-K,8-K/A', dateRange: 'custom', startdt, enddt, from: page * EIGHT_K_PAGE_SIZE }), 'discovery');
    if (!r.ok) {
      c.warn(`discovery_${r.reason ?? 'failed'}`);
      if (page === 0) c.skip(r.reason === 'blocked' ? 'sec_blocked' : `discovery_${r.reason ?? 'failed'}`);
      break;
    }
    const parsed = parseSearchResponse(r.text);
    if (!parsed.ok) { c.add('unparseable', 'hit_shape_unknown', { key: `discovery:page${page}`, extracted: { page } }); break; }
    if (page === 0) c.stats.discovery_total = parsed.total;
    for (const h of parsed.hits) {
      const k = `${h.adsh ?? `n${hits.length}`}|${h.filename ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push(h);
    }
    if (parsed.hits.length < EIGHT_K_PAGE_SIZE) break;
  }
  if (c.stats.discovery_total !== null && c.stats.discovery_total > hits.length) c.bump('discovery_not_read', c.stats.discovery_total - hits.length);

  for (const hit of hits) {
    c.stats.read += 1;
    const badKey = `bad:${contentHash(hit).slice(0, 16)}`;
    await c.guard(badKey, () => processHit(hit, badKey));
  }
  c.stats.warnings.push(...edgar.warnings.filter((w) => !c.stats.warnings.includes(w)));
  return { items: c.items, stats: c.stats };

  /**
   * @param {import('./edgar-client.js').SearchHit} hit
   * @param {string} badKey
   */
  async function processHit(hit, badKey) {
    if (!hit.shape_ok) { c.add('unparseable', 'hit_shape_unknown', { key: badKey }); return; }
    const adsh = validAdsh(hit.adsh);
    if (!adsh) { c.add('unparseable', 'accession_malformed', { key: badKey }); return; }
    const cik = validCik(hit.ciks[0]);
    if (!cik) { c.add('unparseable', 'cik_malformed', { key: `${adsh}|5.02` }); return; }
    const key = `${adsh}|5.02`;
    const rawNames = hit.display_names.slice(0, 5);
    const cleaned = rawNames.map(cleanDisplayName).filter(Boolean);
    const base = { accession: adsh, cik, form: hit.form, file_date: hit.file_date, display_names: rawNames, items: hit.items };
    if (hit.items === null) { c.add('unparseable', 'hit_shape_unknown', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'items_field_absent' } }); return; }
    if (!hit.items.some((i) => i.trim() === '5.02')) { c.add('out_of_scope', 'item_not_502', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const company = sanitizeName(cleaned[0] ?? '');
    if (!company.value) { c.add('unparseable', 'company_missing', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    if ([...cleaned, ...rawNames].map(sanitizeName).some((n) => n.too_long)) { c.add('unparseable', 'name_too_long', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const filename = validFilename(hit.filename);
    if (!filename) { c.add('unparseable', 'hit_shape_unknown', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'filename_missing_or_invalid' } }); return; }
    if (!edgar.hasBudget('8k')) { c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const doc = await edgar.document(docUrl(cik, adsh, filename), '8k');
    if (!doc.ok) {
      if (doc.reason === 'capped') c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base });
      else c.add('unparseable', 'doc_fetch_failed', { key, url: indexUrl(cik, adsh), extracted: { ...base, fetch_reason: doc.reason, status: doc.status } });
      return;
    }
    const plain = htmlToPlain(doc.text);
    const section = cutItem502(plain);
    if (!section) { c.add('unparseable', 'section_not_found', { key, url: indexUrl(cik, adsh), extracted: { ...base, doc_truncated: doc.truncated } }); return; }
    const filingDate = typeof hit.file_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hit.file_date) ? hit.file_date : null;
    const eventDate = extractCoverDate(plain);
    if (!filingDate && !eventDate) { c.add('unparseable', 'no_date_at_all', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const a = analyzeDeparture(section);
    if (a.kind === 'no_role') { c.add('out_of_scope', 'no_cto_class_role', { key, url: indexUrl(cik, adsh), extracted: { ...base, event_date: eventDate } }); return; }
    if (a.kind === 'appointment_only') { c.add('out_of_scope', 'appointment_only', { key, url: indexUrl(cik, adsh), extracted: { ...base, role: a.role, event_date: eventDate } }); return; }

    const scan = findBlockedHits(plain, ctx.blocked, { minLength: ctx.blockedMinLength });
    const aliases = [...new Set([...cleaned.slice(1), ...rawNames.map((n) => sanitizeText(n, 400))])];
    const sectionText = sanitizeText(section, TEXT_MAX);
    const contact = extractContact(section);
    const signal = {
      trigger_kind: 'exec_departure',
      company: company.value,
      aliases,
      acquirer: null,
      investor: null,
      pe_firm: null,
      text: buildSignalText(scan.hits, [sectionText]),
      evidence_url: indexUrl(cik, adsh),
      evidence_source: 'edgar_8k',
      event_date: eventDate,
      filing_date: filingDate,
      role: a.role,
      departure_ambiguous: a.ambiguous,
    };
    c.add('parsed', 'ok', {
      key,
      signal,
      contact,
      url: signal.evidence_url,
      excerpt: makeExcerpt(sectionText),
      extracted: boundExtracted({
        ...base,
        trigger_kind: 'exec_departure',
        company: company.value,
        company_norm: normalizeCompany(company.value).company_norm,
        alias_norms: aliases.map((x) => normalizeCompany(x).company_norm).filter(Boolean).slice(0, 10),
        role: a.role,
        departure_kind: a.kind,
        departure_ambiguous: a.ambiguous,
        event_date: eventDate,
        filing_date: filingDate,
        blocked_hits: scan.hits.map((h) => h.entry),
        scanned_chars: scan.scanned_chars,
        doc_truncated: doc.truncated,
        section_truncated: section.length > TEXT_MAX,
        amendment: /\/A$/i.test(String(hit.form ?? '')),
      }),
    });
  }
}
