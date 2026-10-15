// @ts-check
/**
 * Target finder source B: EDGAR Form D (plan 14.4 B as amended by 15.2 items 1, 8, 9, 10, 11).
 *
 * Discovery is the EDGAR full-text search JSON (forms=D,D/A; "Form D JSON" is not a feed). Each kept hit's
 * body is primary_doc.xml, parsed here with the DTD and entities DISABLED by construction: a document that
 * mentions <!DOCTYPE or <!ENTITY at all is xml_malformed, tag balance is checked before parsing, and
 * the parser (cheerio xmlMode) never expands entities or fetches anything.
 *
 * Total outcomes (every raw item gets exactly one), closed reason set in FORM_D_REASONS.
 * The adapter makes no operating-company judgment; the classifier does (fund name tokens, fund industry
 * groups, SIC 6799, absent SIC). The issuer legal name always goes into aliases beside every raw display
 * name, so a blocked name that only appears there still reaches the exclusion step.
 */
import { load } from 'cheerio';
import {
  validCik, validAdsh, indexUrl, docUrl, submissionsUrl, searchUrl, daysBefore, parseSearchResponse,
} from './edgar-client.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash, DOC_READ_MAX,
} from './signal-text.js';
import { parseLooseDate } from './text-extract.js';
import { normalizeCompany } from '../core/normalize.js';

export const FORM_D_SOURCE = 'edgar_form_d';
export const FORM_D_PARSER_VERSION = 'form_d-1';
export const FORM_D_REASONS = Object.freeze([
  'xml_malformed', 'issuer_name_missing', 'accession_malformed', 'cik_malformed', 'unknown_shape', 'hit_shape_unknown',
  'doc_fetch_failed', 'fund_like_name_prefilter', 'run_cap',
]);
export const FORM_D_PAGE_SIZE = 100;
export const FORM_D_MAX_PAGES = 3;
export const FORM_D_WINDOW_DAYS = 14;

const FREE_TEXT_ELEMENTS = Object.freeze(['descriptionOfOtherType', 'clarificationOfResponse', 'otherDescription']);

// ---------------------------------------------------------------------------
// XML safety and parsing
// ---------------------------------------------------------------------------

/**
 * Well-formedness check without a DTD-capable parser. Returns null when the document is acceptable, else a
 * short code. A DOCTYPE or ENTITY declaration anywhere is refused outright.
 * @param {string} xml
 * @returns {string|null}
 */
export function xmlProblem(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return 'empty';
  if (xml.length > DOC_READ_MAX) return 'too_long';
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) return 'doctype';
  let s = xml;
  if (/<!--/.test(s)) {
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    if (s.includes('<!--')) return 'unterminated_comment';
  }
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (s.includes('<![CDATA[')) return 'unterminated_cdata';
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  /** @type {string[]} */
  const stack = [];
  let tags = 0;
  let roots = 0;
  let m;
  while ((m = tagRe.exec(s)) !== null) {
    tags += 1;
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) return 'mismatched_tag';
    } else if (m[4] !== '/') {
      if (stack.length === 0) roots += 1;
      stack.push(m[2]);
    } else if (stack.length === 0) {
      roots += 1;
    }
  }
  if (stack.length !== 0) return 'unclosed_tag';
  if (roots !== 1) return 'root_count';
  if ((s.match(/</g) ?? []).length !== tags) return 'stray_angle_bracket';
  return null;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} scope
 * @param {string} sel
 * @returns {string}
 */
function text($, scope, sel) {
  return scope.find(sel).first().text().replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {Object} FormDDoc
 * @property {string} submission_type
 * @property {string} issuer_name
 * @property {string} entity_type
 * @property {string[]} previous_names
 * @property {string} industry_group
 * @property {string} revenue_range
 * @property {string} total_offering_amount
 * @property {string} date_of_first_sale
 * @property {boolean} is_amendment
 * @property {string} previous_accession
 * @property {Array<{ name: string, is_entity: boolean }>} related
 * @property {string[]} free_text
 */

/**
 * @param {string} xml already checked by xmlProblem()
 * @returns {FormDDoc|null} null when the root is not an edgarSubmission
 */
export function parseFormDXml(xml) {
  const $ = load(xml, { xml: true });
  const root = $('edgarSubmission').first();
  if (root.length === 0) return null;
  const issuer = root.find('primaryIssuer').first();
  const offering = root.find('offeringData').first();
  const related = root.find('relatedPersonInfo').toArray().map((el) => {
    const n = $(el).find('relatedPersonName').first();
    const first = text($, n, 'firstName');
    const middle = text($, n, 'middleName');
    const last = text($, n, 'lastName');
    const entity = text($, n, 'entityName');
    const own = n.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    const person = [first, middle, last].filter(Boolean).join(' ');
    if (person) return { name: person, is_entity: false };
    const eName = entity || own;
    return { name: eName, is_entity: Boolean(eName) };
  }).filter((r) => r.name);
  return {
    submission_type: text($, root, 'submissionType'),
    issuer_name: text($, issuer, 'entityName'),
    entity_type: text($, issuer, 'entityType'),
    previous_names: issuer.find('previousName').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim()).filter(Boolean),
    industry_group: text($, offering, 'industryGroupType'),
    revenue_range: text($, offering, 'revenueRange'),
    total_offering_amount: text($, offering, 'totalOfferingAmount'),
    date_of_first_sale: text($, offering, 'dateOfFirstSale'),
    is_amendment: /^true$/i.test(text($, offering, 'isAmendment')),
    previous_accession: text($, offering, 'previousAccessionNumber'),
    related,
    free_text: FREE_TEXT_ELEMENTS.map((e) => text($, root, e)).filter(Boolean),
  };
}

/**
 * Item 5 revenue range to a size. Offering amounts are never read here.
 * @param {string} range
 * @returns {{ low: number|null, high: number|null, basis: 'form_d_revenue_range', confidence: 'medium'|'none', recognized: boolean }}
 */
export function sizeFromRevenueRange(range) {
  const none = { low: null, high: null, basis: /** @type {const} */ ('form_d_revenue_range'), confidence: /** @type {const} */ ('none') };
  const r = String(range ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!r) return { ...none, recognized: true };
  if (/decline to disclose|not applicable|^n\/a$/.test(r)) return { ...none, recognized: true };
  if (/^no revenues?$/.test(r)) return { low: 0, high: 0, basis: 'form_d_revenue_range', confidence: 'medium', recognized: true };
  let m = /^over\s+\$?\s*([\d,]{1,15})$/.exec(r);
  if (m) return { low: Number(m[1].replace(/,/g, '')), high: null, basis: 'form_d_revenue_range', confidence: 'medium', recognized: true };
  m = /^\$?\s*([\d,]{1,15})\s*(?:-|to|\u2013|\u2014)\s*\$?\s*([\d,]{1,15})$/.exec(r);
  if (m) {
    const low = Number(m[1].replace(/,/g, ''));
    const high = Number(m[2].replace(/,/g, ''));
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) return { low, high, basis: 'form_d_revenue_range', confidence: 'medium', recognized: true };
  }
  return { ...none, recognized: false };
}

/** Display name minus the trailing "(CIK ...)" and ticker text. @param {string} raw */
export function cleanDisplayName(raw) {
  return sanitizeText(String(raw ?? '').replace(/\(\s*CIK[^)]*\)/gi, ' ').replace(/\(\s*[A-Z][A-Z0-9.,\s-]{0,14}\)/g, ' '), 400);
}

/**
 * @param {Object} ctx
 * @param {import('./edgar-client.js').EdgarClient|null} ctx.edgar null when the SEC contact is missing
 * @param {Date} ctx.now
 * @param {{ params: { fund_name_tokens: string[] } }} ctx.rules
 * @param {string[]} ctx.blocked blocked entries (built-ins plus affiliates)
 * @param {number} [ctx.blockedMinLength]
 */
export async function runFormD(ctx) {
  const c = createCollector(FORM_D_SOURCE, FORM_D_REASONS, FORM_D_PARSER_VERSION);
  if (!ctx.edgar) { c.skip('sec_contact_missing'); return { items: c.items, stats: c.stats }; }
  if (ctx.edgar.blocked) { c.skip('sec_blocked'); return { items: c.items, stats: c.stats }; }
  const edgar = ctx.edgar;
  const fundTokens = new Set(ctx.rules.params.fund_name_tokens.map((t) => t.toLowerCase()));
  const enddt = daysBefore(ctx.now, 0);
  const startdt = daysBefore(ctx.now, FORM_D_WINDOW_DAYS);

  /** @type {Array<import('./edgar-client.js').SearchHit>} */
  const hits = [];
  const seen = new Set();
  for (let page = 0; page < FORM_D_MAX_PAGES; page += 1) {
    const r = await edgar.search(searchUrl({ forms: 'D,D/A', dateRange: 'custom', startdt, enddt, from: page * FORM_D_PAGE_SIZE }), 'discovery');
    if (!r.ok) {
      c.warn(`discovery_${r.reason ?? 'failed'}`);
      if (page === 0) c.skip(r.reason === 'blocked' ? 'sec_blocked' : `discovery_${r.reason ?? 'failed'}`);
      break;
    }
    const parsed = parseSearchResponse(r.text);
    if (!parsed.ok) {
      c.add('unparseable', 'hit_shape_unknown', { key: `discovery:page${page}`, extracted: { page } });
      break;
    }
    if (page === 0) c.stats.discovery_total = parsed.total;
    for (const h of parsed.hits) {
      const k = h.adsh ?? `n${hits.length}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push(h);
    }
    if (parsed.hits.length < FORM_D_PAGE_SIZE) break;
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
    if (!cik) { c.add('unparseable', 'cik_malformed', { key: adsh }); return; }
    const key = adsh;
    const rawNames = hit.display_names.slice(0, 5);
    const cleaned = rawNames.map(cleanDisplayName).filter(Boolean);
    const baseExtracted = { accession: adsh, cik, form: hit.form, file_date: hit.file_date, display_names: rawNames };

    const fundish = cleaned.find((n) => n.toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).some((w) => fundTokens.has(w)));
    if (fundish) {
      c.add('out_of_scope', 'fund_like_name_prefilter', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, matched_name: fundish } });
      return;
    }
    if (!edgar.hasBudget('form_d')) { c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: baseExtracted }); return; }

    const doc = await edgar.document(docUrl(cik, adsh, 'primary_doc.xml'), 'form_d');
    if (!doc.ok) {
      if (doc.reason === 'capped') c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: baseExtracted });
      else c.add('unparseable', 'doc_fetch_failed', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, fetch_reason: doc.reason, status: doc.status } });
      return;
    }
    const problem = xmlProblem(doc.text);
    if (problem) { c.add('unparseable', 'xml_malformed', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, xml_problem: problem } }); return; }
    const d = parseFormDXml(doc.text);
    if (!d) { c.add('unparseable', 'unknown_shape', { key, url: indexUrl(cik, adsh), extracted: baseExtracted }); return; }

    // Names: every one is bounded; an oversized name is a visible unparseable, never a truncated lookalike.
    const issuer = sanitizeName(d.issuer_name);
    if (!issuer.value) { c.add('unparseable', 'issuer_name_missing', { key, url: indexUrl(cik, adsh), extracted: baseExtracted }); return; }
    const nameChecks = [issuer, ...d.previous_names.map(sanitizeName), ...d.related.map((r) => sanitizeName(r.name)), ...rawNames.map(sanitizeName)];
    if (nameChecks.some((n) => n.too_long)) { c.add('unparseable', 'name_too_long', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, issuer_name: issuer.value } }); return; }
    const filingDate = parseLooseDate(hit.file_date ?? '');
    if (!filingDate) { c.add('unparseable', 'unknown_shape', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, issue: 'filing_date_missing' } }); return; }

    // Optional submissions fetch for SIC and former names (counts against the Form D budget).
    let sic = null;
    /** @type {string[]} */
    let formerNames = [];
    if (edgar.hasBudget('form_d')) {
      const sub = await edgar.document(submissionsUrl(cik), 'form_d');
      if (sub.ok) {
        try {
          const j = JSON.parse(sub.text);
          if (j && typeof j.sic === 'string' && /^\d{4}$/.test(j.sic.trim())) sic = j.sic.trim();
          if (j && Array.isArray(j.formerNames)) formerNames = j.formerNames.map((f) => (f && typeof f.name === 'string' ? sanitizeText(f.name, 200) : '')).filter(Boolean).slice(0, 10);
        } catch { c.bump('submissions_unparseable'); }
      } else c.bump('submissions_unavailable');
    } else c.bump('submissions_skipped_cap');

    const plain = doc.text.replace(/<[^>]+>/g, ' ');
    const scan = findBlockedHits([plain, ...rawNames].join(' \n '), ctx.blocked, { minLength: ctx.blockedMinLength });
    const firstEntity = d.related.find((r) => r.is_entity);
    const industry = sanitizeText(d.industry_group, 120);
    const size = sizeFromRevenueRange(d.revenue_range);
    const eventDate = parseLooseDate(d.date_of_first_sale);
    const aliases = dedupStrings([issuer.value, ...d.previous_names.map((n) => sanitizeText(n, 200)), ...formerNames, ...cleaned, ...rawNames.map((n) => sanitizeText(n, 400))]);
    const text = buildSignalText(scan.hits, [
      industry, d.entity_type, `related persons: ${d.related.map((r) => r.name).join('; ')}`, ...d.free_text.map((f) => sanitizeText(f, 500)),
    ]);
    const isAmendment = d.is_amendment || /\/A$/i.test(String(hit.form ?? '')) || /\/A$/i.test(d.submission_type);
    const prev = validAdsh(d.previous_accession);
    const signal = {
      trigger_kind: 'pe_deal',
      company: issuer.value,
      aliases,
      acquirer: null,
      investor: firstEntity ? sanitizeName(firstEntity.name).value : null,
      pe_firm: null,
      text,
      evidence_url: indexUrl(cik, adsh),
      evidence_source: 'edgar_form_d',
      event_date: eventDate,
      filing_date: filingDate,
      size: { low: size.low, high: size.high, basis: size.basis, confidence: size.confidence },
      employees: null,
      issuer: { name: issuer.value, sic, industry_group: industry || null },
      role: null,
    };
    const norm = normalizeCompany(issuer.value).company_norm;
    c.add('parsed', 'ok', {
      key,
      signal,
      contact: null,
      url: signal.evidence_url,
      excerpt: makeExcerpt(`${issuer.value}: ${text}`),
      extracted: boundExtracted({
        ...baseExtracted,
        trigger_kind: 'pe_deal',
        company: issuer.value,
        company_norm: norm,
        alias_norms: aliases.map((a) => normalizeCompany(a).company_norm).filter(Boolean).slice(0, 10),
        entity_type: d.entity_type,
        industry_group: industry,
        sic,
        revenue_range: d.revenue_range,
        revenue_range_recognized: size.recognized,
        offering_amount: d.total_offering_amount,
        event_date: eventDate,
        filing_date: filingDate,
        amendment: isAmendment,
        supersedes_accession: prev,
        blocked_hits: scan.hits.map((h) => h.entry),
        scanned_chars: scan.scanned_chars,
        doc_truncated: doc.truncated,
      }),
      ...(isAmendment && prev ? { supersedes: { source: FORM_D_SOURCE, key: prev } } : {}),
    });
  }
}

/** @param {string[]} list @returns {string[]} */
function dedupStrings(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 20);
}
