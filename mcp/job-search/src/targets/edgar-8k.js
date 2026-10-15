// @ts-check
/**
 * Target finder source D: EDGAR 8-K Item 5.02 (plan 14.4 D, 15.2 items 1, 5, 8, 10; PR2b, plan section 16).
 *
 * Discovery (PR2b): one search request per form type (8-K, then 8-K/A), each paged, merged by accession and
 * file, with per-form per-page coverage in stats.coverage. The source is complete only when every form request
 * returned all its pages. Discovery requests come from the source's own reserved budget (discovery_8k).
 *
 * Grouping (PR2b): ONE signal per accession. Up to 3 hit documents are read per accession (the filing's own
 * form first, then EX-99.*, then the rest in hit order); each piece of evidence records its doc type and
 * filename. If any chosen document fails to fetch the signal carries doc_fetch = failed | partial and the
 * classifier sends it to needs-review (doc_fetch_failed / doc_fetch_failed_partial): a partly read filing never
 * passes as clean and is never dropped as out_of_scope. Company identity is the primary filer CIK (see
 * primaryFiler in edgar-shared.js); every other display name is an alias and an exclusion party.
 *
 * Departure vs appointment (src/targets/text-extract.js analyzeDeparture): a departure verb counts only
 * when the title NEAREST to it is a CTO-class role. A departure verb that binds to nothing, or a section
 * with both a bound departure and a bound appointment, sets departure_ambiguous (the classifier sends it to
 * needs-review). An appointment-only section is out_of_scope. Every document read is scanned in FULL for
 * blocked names before the section is truncated.
 *
 * 8-K/A: ingested as its own signal (its own accession). There is no machine-readable link to the original
 * 8-K, so supersession is by the classification dedup (same company group, newest date) rather than by key.
 */
import { normalizeCompany } from '../core/normalize.js';
import { validCik, validAdsh, indexUrl, daysBefore } from './edgar-client.js';
import {
  discoverByForm, formsToRequests, groupByAccession, primaryFiler, chooseDocs, readDocs, evidenceOf,
} from './edgar-shared.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash, TEXT_MAX,
} from './signal-text.js';
import { htmlToPlain, extractCoverDate, analyzeDeparture, extractContact, cutItem502 } from './text-extract.js';
import { cleanDisplayName } from './form-d.js';

export const EIGHT_K_SOURCE = 'edgar_8k';
export const EIGHT_K_PARSER_VERSION = '8k-2';
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

  const disc = await discoverByForm({
    edgar,
    forms: formsToRequests('8-K,8-K/A'),
    params: { q: '"Item 5.02"', dateRange: 'custom', startdt, enddt },
    budget: 'discovery_8k',
    maxPages: EIGHT_K_MAX_PAGES,
  });
  c.stats.coverage = disc.coverage;
  c.stats.discovery_total = disc.total;
  for (const p of disc.problems) c.warn(p);
  if (disc.blockedFirst) {
    c.skip('sec_blocked');
    c.stats.warnings.push(...edgar.warnings.filter((w) => !c.stats.warnings.includes(w)));
    return { items: c.items, stats: c.stats };
  }
  const noneRead = Object.values(disc.coverage.forms).every((f) => f.status === 'none');
  if (noneRead && disc.problems.every((p) => !p.startsWith('hit_shape_unknown'))) {
    c.skip(disc.problems[0] ?? 'discovery_failed');
    return { items: c.items, stats: c.stats };
  }
  for (const [form, fc] of Object.entries(disc.coverage.forms)) {
    if (fc.pages.some((p) => !p.ok && p.reason === 'hit_shape_unknown')) c.add('unparseable', 'hit_shape_unknown', { key: `discovery:${form}`, extracted: { form } });
  }
  if (disc.notRead > 0) c.bump('discovery_not_read', disc.notRead);
  if (disc.coverage.source !== 'complete') c.bump('undercoverage', 1);

  for (const [adsh, group] of groupByAccession(disc.hits)) {
    c.stats.read += 1;
    const badKey = `bad:${contentHash(group[0]).slice(0, 16)}`;
    await c.guard(adsh ? `${adsh}|5.02` : badKey, () => processAccession(adsh, group, badKey));
  }
  c.stats.warnings.push(...edgar.warnings.filter((w) => !c.stats.warnings.includes(w)));
  return { items: c.items, stats: c.stats };

  /**
   * @param {string} adshRaw
   * @param {Array<import('./edgar-client.js').SearchHit>} group all hits of one accession, in hit order
   * @param {string} badKey
   */
  async function processAccession(adshRaw, group, badKey) {
    if (group.some((h) => !h.shape_ok)) { c.add('unparseable', 'hit_shape_unknown', { key: badKey }); return; }
    const adsh = validAdsh(adshRaw);
    if (!adsh) { c.add('unparseable', 'accession_malformed', { key: badKey }); return; }
    const who = primaryFiler(group);
    const cik = validCik(who.cik);
    if (!cik) { c.add('unparseable', 'cik_malformed', { key: `${adsh}|5.02` }); return; }
    const key = `${adsh}|5.02`;
    const rawNames = who.all_names.slice(0, 10);
    const cleaned = rawNames.map(cleanDisplayName).filter(Boolean);
    const itemsAll = group.every((h) => h.items === null) ? null : [...new Set(group.flatMap((h) => h.items ?? []))];
    const form = group.find((h) => h.form)?.form ?? null;
    const fileDate = group.find((h) => h.file_date)?.file_date ?? null;
    const base = { accession: adsh, cik, form, file_date: fileDate, display_names: rawNames, items: itemsAll, hit_count: group.length, cik_conflict: who.conflict };
    if (itemsAll === null) { c.add('unparseable', 'hit_shape_unknown', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'items_field_absent' } }); return; }
    if (!itemsAll.some((i) => i.trim() === '5.02')) { c.add('out_of_scope', 'item_not_502', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const primaryClean = cleanDisplayName(who.primary_name);
    const company = sanitizeName(primaryClean);
    if (!company.value) { c.add('unparseable', 'company_missing', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    if ([...cleaned, ...rawNames].map(sanitizeName).some((n) => n.too_long)) { c.add('unparseable', 'name_too_long', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const chosen = chooseDocs(group);
    if (chosen.chosen.length === 0) { c.add('unparseable', 'hit_shape_unknown', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'filename_missing_or_invalid' } }); return; }
    if (!edgar.hasBudget('8k')) { c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const read = await readDocs(edgar, '8k', cik, adsh, chosen.chosen);
    if (read.status === 'failed' && read.docs.every((d) => d.reason === 'capped')) { c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const evidence = evidenceOf(read.docs);
    const okDocs = read.docs.filter((d) => d.ok).map((d) => ({ ...d, plain: htmlToPlain(d.text) }));
    const filingDate = typeof fileDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fileDate) ? fileDate : null;

    // The Item 5.02 section is cut from the first document (main document first) that has one.
    /** @type {string|null} */
    let section = null;
    let sectionDoc = null;
    for (const d of okDocs) {
      const sec = cutItem502(d.plain);
      if (sec) { section = sec; sectionDoc = d; break; }
    }
    const eventDate = okDocs.map((d) => extractCoverDate(d.plain)).find(Boolean) ?? null;
    const scan = findBlockedHits([...rawNames, ...okDocs.map((d) => d.plain)].join(' \n '), ctx.blocked, { minLength: ctx.blockedMinLength });
    const fetchNote = { doc_fetch: read.status, unread_hit_docs: chosen.unread, evidence };

    if (read.status === 'ok') {
      if (!section) { c.add('unparseable', 'section_not_found', { key, url: indexUrl(cik, adsh), extracted: { ...base, ...fetchNote, doc_truncated: okDocs.some((d) => d.truncated) } }); return; }
      if (!filingDate && !eventDate) { c.add('unparseable', 'no_date_at_all', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
      const a0 = analyzeDeparture(section);
      if (a0.kind === 'no_role') { c.add('out_of_scope', 'no_cto_class_role', { key, url: indexUrl(cik, adsh), extracted: { ...base, ...fetchNote, event_date: eventDate } }); return; }
      if (a0.kind === 'appointment_only') { c.add('out_of_scope', 'appointment_only', { key, url: indexUrl(cik, adsh), extracted: { ...base, ...fetchNote, role: a0.role, event_date: eventDate } }); return; }
    } else if (!filingDate && !eventDate) {
      c.add('unparseable', 'no_date_at_all', { key, url: indexUrl(cik, adsh), extracted: { ...base, ...fetchNote } });
      return;
    }
    // Fully read with a departure, or only partly read: a partly read filing is always emitted (flagged) so
    // the classifier sends it to needs-review. It is never dropped or passed clean.
    const a = section ? analyzeDeparture(section) : { kind: 'unknown', role: null, ambiguous: true };
    const aliases = [...new Set([...cleaned.filter((n) => n !== primaryClean), ...rawNames.map((n) => sanitizeText(n, 400))])];
    const sectionText = sanitizeText(section ?? '', TEXT_MAX);
    const contact = section ? extractContact(section) : null;
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
      doc_fetch: read.status,
      unread_hit_docs: chosen.unread,
    };
    c.add('parsed', 'ok', {
      key,
      signal,
      contact,
      url: signal.evidence_url,
      excerpt: makeExcerpt(sectionText || company.value),
      extracted: boundExtracted({
        ...base,
        ...fetchNote,
        trigger_kind: 'exec_departure',
        company: company.value,
        company_norm: normalizeCompany(company.value).company_norm,
        alias_norms: aliases.map((x) => normalizeCompany(x).company_norm).filter(Boolean).slice(0, 10),
        role: a.role,
        departure_kind: a.kind,
        departure_ambiguous: a.ambiguous,
        event_date: eventDate,
        filing_date: filingDate,
        section_doc: sectionDoc ? { doc_type: sectionDoc.doc_type, filename: sectionDoc.filename } : null,
        blocked_hits: scan.hits.map((h) => h.entry),
        scanned_chars: scan.scanned_chars,
        doc_truncated: okDocs.some((d) => d.truncated),
        section_truncated: (section ?? '').length > TEXT_MAX,
        amendment: /\/A$/i.test(String(form ?? '')),
      }),
    });
  }
}
