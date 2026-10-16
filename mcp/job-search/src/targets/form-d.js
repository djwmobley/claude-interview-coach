// @ts-check
/**
 * Target finder source B: EDGAR Form D (plan 14.4 B as amended by 15.2 items 1, 8, 9, 10, 11).
 *
 * Discovery is the EDGAR full-text search JSON, ONE request per form type (D, then D/A; PR2b: the live probe
 * showed a combined or single request does not return both). "Form D JSON" is not a feed. Each kept hit's
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
  validCik, validAdsh, indexUrl, docUrl, submissionsUrl, daysBefore,
} from './edgar-client.js';
import { discoverByForm, formsToRequests, primaryFiler } from './edgar-shared.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash, DOC_READ_MAX,
} from './signal-text.js';
import { parseLooseDate } from './text-extract.js';
import { normalizeCompany } from '../core/normalize.js';

export const FORM_D_SOURCE = 'edgar_form_d';
export const FORM_D_PARSER_VERSION = 'form_d-2';
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
 * @property {string[]} previous_names raw values, every one (filtered by splitPreviousNames)
 * @property {string} industry_group
 * @property {string} revenue_range
 * @property {string} total_offering_amount
 * @property {string} date_of_first_sale
 * @property {boolean} is_amendment
 * @property {string} previous_accession
 * @property {string} nav_range aggregateNetAssetValueRange text ('' when absent): a fund signal
 * @property {Array<{ name: string, is_entity: boolean, kind: 'entity'|'unclassified_party' }>} related
 * @property {string[]} free_text
 */

// ---------------------------------------------------------------------------
// Related parties (PR2b rule D) and previous names (rule C)
// ---------------------------------------------------------------------------

const HAS_LETTER_RE = /\p{L}/u;
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u;
/** Whole-word entity markers. L.L.C. / L.P. may carry a trailing period; matching is case-insensitive. */
const ENTITY_MARKER_RE = /(?<![\p{L}\p{N}])(?:L\.L\.C\.?|L\.P\.?|LLC|LP|LLP|INC\.?|CORP\.?|LTD\.?|FUND|PARTNERS|CAPITAL|HOLDINGS|MANAGEMENT|TRUST|GP)(?![\p{L}\p{N}])/iu;

/**
 * relatedPersonName to a party. Entity when firstName (trimmed) has no letter ("-", empty), the name then
 * being lastName plus middleName if present; also an entity when the joined name has a whole-word entity
 * marker. Every other name is an unclassified_party: kept, scanned, never discarded.
 * @param {{ first: string, middle: string, last: string, fallback?: string }} n
 * @returns {{ name: string, is_entity: boolean, kind: 'entity'|'unclassified_party' }}
 */
export function classifyParty({ first, middle, last, fallback = '' }) {
  const f = first.trim();
  if (!HAS_LETTER_RE.test(f)) {
    const name = [last, middle].map((x) => x.trim()).filter(Boolean).join(' ') || fallback.trim();
    return { name, is_entity: Boolean(name), kind: name ? 'entity' : 'unclassified_party' };
  }
  const joined = [f, middle, last].map((x) => x.trim()).filter(Boolean).join(' ');
  if (ENTITY_MARKER_RE.test(joined)) return { name: joined, is_entity: true, kind: 'entity' };
  return { name: joined, is_entity: false, kind: 'unclassified_party' };
}

/**
 * Previous names: the raw values were already put through exclusion by the caller. A value is dropped when,
 * after trim, it has no letter or digit, or equals none / n/a case-insensitively. Survivors become aliases.
 * @param {string[]} raw
 * @returns {{ kept: string[], dropped: number }}
 */
export function splitPreviousNames(raw) {
  /** @type {string[]} */
  const kept = [];
  let dropped = 0;
  for (const v of raw) {
    const t = String(v ?? '').trim();
    if (!HAS_ALNUM_RE.test(t) || /^(?:none|n\/a)$/i.test(t)) { dropped += 1; continue; }
    kept.push(t);
  }
  return { kept, dropped };
}

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
    const legacyEntity = text($, n, 'entityName');
    const own = n.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    return classifyParty({ first, middle, last, fallback: legacyEntity || own });
  }).filter((r) => r.name);
  // Previous names: EVERY value under issuerPreviousNameList and edgarPreviousNameList (raw, untouched).
  const previous = root.find('issuerPreviousNameList, edgarPreviousNameList').find('value').toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim());
  return {
    submission_type: text($, root, 'submissionType'),
    issuer_name: text($, issuer, 'entityName'),
    entity_type: text($, issuer, 'entityType'),
    previous_names: previous,
    industry_group: text($, offering, 'industryGroupType'),
    revenue_range: text($, offering, 'revenueRange'),
    nav_range: text($, offering, 'aggregateNetAssetValueRange'),
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
 * @param {{ params: { fund_name_tokens: string[], fund_industry_groups?: string[] } }} ctx.rules
 * @param {string[]} ctx.blocked blocked entries (built-ins plus affiliates)
 * @param {number} [ctx.blockedMinLength]
 * @param {{ start: string, end: string }} [ctx.window] one-day slice from the runner (YYYY-MM-DD, ET); default is the last FORM_D_WINDOW_DAYS days
 * @param {number} [ctx.maxPages] pages per form request (default FORM_D_MAX_PAGES)
 * @param {(adsh: string) => boolean} [ctx.covered] true when the accession is already stored with a read document (resume)
 */
export async function runFormD(ctx) {
  const c = createCollector(FORM_D_SOURCE, FORM_D_REASONS, FORM_D_PARSER_VERSION);
  if (!ctx.edgar) { c.skip('sec_contact_missing'); return { items: c.items, stats: c.stats }; }
  if (ctx.edgar.blocked) { c.skip('sec_blocked'); return { items: c.items, stats: c.stats }; }
  const edgar = ctx.edgar;
  const fundTokens = new Set(ctx.rules.params.fund_name_tokens.map((t) => t.toLowerCase()));
  const fundGroups = (ctx.rules.params.fund_industry_groups ?? []).map((g) => g.toLowerCase());
  const enddt = ctx.window?.end ?? daysBefore(ctx.now, 0);
  const startdt = ctx.window?.start ?? daysBefore(ctx.now, FORM_D_WINDOW_DAYS);

  // One request per form type: D, then D/A. The live probe of 2026-10-15 showed forms=D returns almost only
  // originals and forms=D/A only amendments, so neither request stands in for the other. Hits are merged by
  // accession. Discovery comes from the source's own reserved budget.
  const disc = await discoverByForm({
    edgar,
    forms: formsToRequests('D,D/A'),
    params: { dateRange: 'custom', startdt, enddt },
    budget: 'discovery_form_d',
    maxPages: ctx.maxPages ?? FORM_D_MAX_PAGES,
  });
  c.stats.overflow = disc.overflow;
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

  for (const hit of disc.hits) {
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
    // Primary filer CIK rule (edgar-shared.js primaryFiler): ciks[0] with its own display name; the rest are
    // co-registrants (aliases and exclusion parties, never the identity).
    const who = primaryFiler([hit]);
    const cik = validCik(who.cik);
    if (!cik) { c.add('unparseable', 'cik_malformed', { key: adsh }); return; }
    const key = adsh;
    if (ctx.covered?.(adsh)) { c.bump('covered_skip'); return; }
    // D5: exclusion runs over ALL display names; the 5-name cap applies only to what is stored.
    const allNames = who.all_names;
    const rawNames = allNames.slice(0, 5);
    const cleaned = rawNames.map(cleanDisplayName).filter(Boolean);
    const baseExtracted = { accession: adsh, cik, form: hit.form, file_date: hit.file_date, display_names: rawNames };

    const fundish = cleaned.find((n) => n.toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).some((w) => fundTokens.has(w)));
    if (fundish) {
      // The prefilter skips the document fetch, but exclusion still runs on the names and the hits are kept.
      const pre = findBlockedHits(allNames.join(' \n '), ctx.blocked, { minLength: ctx.blockedMinLength });
      c.add('out_of_scope', 'fund_like_name_prefilter', { key, url: indexUrl(cik, adsh), extracted: { ...baseExtracted, matched_name: fundish, blocked_hits: pre.hits.map((h) => h.entry) } });
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

    // Optional submissions fetch for SIC and former names (counts against the Form D budget). The search
    // index's own `sics` is the fallback so a SIC is not lost when the cap is hit.
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
    if (!sic) {
      const fromIndex = hit.sics.map((x) => x.trim()).find((x) => /^\d{4}$/.test(x));
      if (fromIndex) { sic = fromIndex; c.bump('sic_from_search_index'); }
    }

    // Previous names (rule C): exclusion on the RAW values first, then drop non-names, then aliases.
    const rawPrev = d.previous_names;
    const prev = splitPreviousNames(rawPrev);
    if (prev.dropped > 0) c.bump('prev_names_dropped', prev.dropped);
    const plain = doc.text.replace(/<[^>]+>/g, ' ');
    const partyNames = d.related.map((r) => r.name);
    const scan = findBlockedHits([plain, ...allNames, ...rawPrev, ...partyNames].join(' \n '), ctx.blocked, { minLength: ctx.blockedMinLength });
    const entities = d.related.filter((r) => r.is_entity);
    const firstEntity = entities[0];
    const industry = sanitizeText(d.industry_group, 120);
    const size = sizeFromRevenueRange(d.revenue_range);
    const eventDate = parseLooseDate(d.date_of_first_sale);
    const aliases = dedupStrings([issuer.value, ...prev.kept.map((n) => sanitizeText(n, 200)), ...formerNames, ...cleaned, ...rawNames.map((n) => sanitizeText(n, 400))]);
    const partyLine = `related persons: ${d.related.map((r) => `${r.name}${r.kind === 'unclassified_party' ? ' (unclassified_party)' : ' (entity)'}`).join('; ')}`;
    const text = buildSignalText(scan.hits, [
      industry, d.entity_type, partyLine, ...d.free_text.map((f) => sanitizeText(f, 500)),
    ]);
    // Fund signals (rule E): both present means a pooled fund; exactly one is a conflict the classifier sends
    // to review; neither means an operating company whose size is whatever Item 5 says (possibly unknown).
    const navPresent = d.nav_range.trim() !== '';
    const lowerIndustry = industry.toLowerCase();
    const pooledGroup = lowerIndustry !== '' && fundGroups.some((g) => lowerIndustry.includes(g));
    const isAmendment = d.is_amendment || /\/A$/i.test(String(hit.form ?? '')) || /\/A$/i.test(d.submission_type);
    const prevAcc = validAdsh(d.previous_accession);
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
      issuer: { name: issuer.value, sic, industry_group: industry || null, fund_signals: { nav_range: navPresent, pooled_group: pooledGroup } },
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
        nav_range_present: navPresent,
        pooled_group: pooledGroup,
        offering_amount: d.total_offering_amount,
        event_date: eventDate,
        filing_date: filingDate,
        amendment: isAmendment,
        supersedes_accession: prevAcc,
        previous_names_raw: rawPrev,
        prev_names_dropped: prev.dropped,
        parties: d.related.map((r) => ({ name: r.name, kind: r.kind })),
        sponsor_candidates: entities.map((r) => r.name),
        co_registrants: who.co_names,
        blocked_hits: scan.hits.map((h) => h.entry),
        scanned_chars: scan.scanned_chars,
        doc_truncated: doc.truncated,
      }),
      ...(isAmendment && prevAcc ? { supersedes: { source: FORM_D_SOURCE, key: prevAcc } } : {}),
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
