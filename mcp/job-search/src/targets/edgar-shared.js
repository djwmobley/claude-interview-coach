// @ts-check
/**
 * Shared EDGAR helpers for the Form D, full-text search, and 8-K adapters (PR2b, plan section 16).
 *
 *   discoverByForm      ONE discovery request per form type (never "D,D/A" in one request: the live probe of
 *                       2026-10-15 showed a combined or single-form request does not reliably return both),
 *                       paged, merged by accession+file, with per-form per-page coverage. A source is complete
 *                       only when every form request returned all its pages; anything else is partial.
 *   formsToRequests     "8-K" -> ["8-K", "8-K/A"]; every base form gets its amendment form requested too.
 *   primaryFiler        the primary filer CIK rule (see its doc comment).
 *   groupByAccession    one group per adsh, in first-seen order, hits kept in hit order.
 *   chooseDocs          up to 3 hit documents per accession: the filing's own form first, then EX-99.*, then the
 *                       rest in hit order.
 *   readDocs            fetch the chosen documents; per-document ok / failure is recorded, and the filing gets a
 *                       fetch status of ok | partial | failed (a partly read filing never passes as clean).
 */
import { validCik, validFilename, docUrl, searchUrl, parseSearchResponse } from './edgar-client.js';
import { contentHash } from './signal-text.js';

export const DISCOVERY_PAGE_SIZE = 100;
export const MAX_DOCS_PER_ACCESSION = 3;

/**
 * Expand configured forms into one request per form type, each base form followed by its amendment form.
 * @param {string} forms comma separated, e.g. "8-K" or "D,D/A"
 * @returns {string[]}
 */
export function formsToRequests(forms) {
  const base = String(forms ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  /** @type {string[]} */
  const out = [];
  for (const f of base) {
    if (!out.includes(f)) out.push(f);
    if (!/\/A$/i.test(f)) {
      const a = `${f}/A`;
      if (!base.includes(a) && !out.includes(a)) out.push(a);
    }
  }
  // Amendment forms listed explicitly keep their configured position after their base.
  for (const f of base) if (!out.includes(f)) out.push(f);
  return out;
}

/**
 * @typedef {Object} FormCoverage
 * @property {'complete'|'partial'|'none'} status
 * @property {number|null} total hits the index says exist for this form request
 * @property {number} read hits actually read (raw count over pages)
 * @property {number} distinct distinct hits (accession and file) actually seen
 * @property {Array<{ from: number, hits: number, ok: boolean, reason: string|null }>} pages
 */

/**
 * @typedef {Object} Discovery
 * @property {Array<import('./edgar-client.js').SearchHit>} hits merged and de-duplicated
 * @property {{ source: 'complete'|'partial', forms: Record<string, FormCoverage> }} coverage
 * @property {number} total sum of the per-form totals the index reported
 * @property {number} notRead sum over forms of (total - read), never negative
 * @property {boolean} blockedFirst the very first request was blocked (the source should be skipped)
 * @property {string[]} problems machine-readable problems (discovery_<reason>, hit_shape_unknown:<form>)
 * @property {boolean} overflow some form has more hits than maxPages pages can hold (plan 17.2 day_overflow)
 */

/**
 * @param {Object} o
 * @param {import('./edgar-client.js').EdgarClient} o.edgar
 * @param {string[]} o.forms one request per entry
 * @param {Record<string, string|number|undefined>} o.params search parameters except forms/from
 * @param {string} o.budget the source's own discovery budget
 * @param {number} o.maxPages pages per form (always paged from offset 0)
 * @param {string} [o.label] prefix for the coverage keys (full-text query id)
 * @returns {Promise<Discovery>}
 */
export async function discoverByForm({ edgar, forms, params, budget, maxPages, label = '' }) {
  /** @type {Discovery['hits']} */
  const hits = [];
  const seen = new Set();
  /** @type {Record<string, FormCoverage>} */
  const cov = {};
  /** @type {string[]} */
  const problems = [];
  let total = 0;
  let notRead = 0;
  let blockedFirst = false;
  let anyRequest = false;
  let overflow = false;

  for (const form of forms) {
    const key = label ? `${label}:${form}` : form;
    /** @type {FormCoverage} */
    const fc = { status: 'none', total: null, read: 0, distinct: 0, pages: [] };
    cov[key] = fc;
    let allPagesOk = true;
    let exhausted = false;
    const seenInForm = new Set();
    for (let page = 0; page < maxPages; page += 1) {
      const from = page * DISCOVERY_PAGE_SIZE;
      const r = await edgar.search(searchUrl({ ...params, forms: form, from }), budget);
      if (!r.ok) {
        fc.pages.push({ from, hits: 0, ok: false, reason: r.reason ?? 'failed' });
        problems.push(`discovery_${r.reason ?? 'failed'}`);
        if (!anyRequest && page === 0 && r.reason === 'blocked') blockedFirst = true;
        allPagesOk = false;
        break;
      }
      anyRequest = true;
      const parsed = parseSearchResponse(r.text);
      if (!parsed.ok) {
        fc.pages.push({ from, hits: 0, ok: false, reason: 'hit_shape_unknown' });
        problems.push(`hit_shape_unknown:${form}`);
        allPagesOk = false;
        break;
      }
      fc.pages.push({ from, hits: parsed.hits.length, ok: true, reason: null });
      // The FINAL total (plan 17.2): the index total can move while we page, so the last page's total is the
      // one the distinct hit count must equal.
      fc.total = parsed.total;
      fc.read += parsed.hits.length;
      for (const h of parsed.hits) {
        const k = h.adsh ? `${h.adsh}|${h.filename ?? ''}` : `bad:${contentHash(h)}`;
        seenInForm.add(k);
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(h);
      }
      fc.distinct = seenInForm.size;
      if (parsed.hits.length < DISCOVERY_PAGE_SIZE || (fc.total !== null && fc.read >= fc.total)) { exhausted = true; break; }
    }
    if (!exhausted && allPagesOk && fc.total !== null && fc.total > fc.read) overflow = true;
    const okPages = fc.pages.filter((p) => p.ok).length;
    if (okPages === 0) fc.status = 'none';
    else if (allPagesOk && (fc.total !== null ? fc.distinct === fc.total : exhausted)) fc.status = 'complete';
    else fc.status = 'partial';
    if (fc.total !== null) {
      total += fc.total;
      notRead += Math.max(0, fc.total - fc.distinct);
    }
  }
  const complete = Object.values(cov).length > 0 && Object.values(cov).every((c) => c.status === 'complete');
  return { hits, coverage: { source: complete ? 'complete' : 'partial', forms: cov }, total, notRead, blockedFirst, problems, overflow };
}

/**
 * Merge several discoveries (full-text search: one per query) into one coverage record.
 * @param {Array<{ source: 'complete'|'partial', forms: Record<string, FormCoverage> }>} parts
 * @returns {{ source: 'complete'|'partial', forms: Record<string, FormCoverage> }}
 */
export function mergeCoverage(parts) {
  /** @type {Record<string, FormCoverage>} */
  const forms = {};
  for (const p of parts) Object.assign(forms, p.forms);
  const all = Object.values(forms);
  return { source: all.length > 0 && all.every((c) => c.status === 'complete') ? 'complete' : 'partial', forms };
}

// ---------------------------------------------------------------------------
// Accession grouping and identity
// ---------------------------------------------------------------------------

/**
 * @param {Array<import('./edgar-client.js').SearchHit>} hits
 * @returns {Map<string, Array<import('./edgar-client.js').SearchHit>>} adsh -> hits in hit order
 */
export function groupByAccession(hits) {
  /** @type {Map<string, Array<import('./edgar-client.js').SearchHit>>} */
  const m = new Map();
  for (const h of hits) {
    const k = h.adsh ?? '';
    const list = m.get(k);
    if (list) list.push(h);
    else m.set(k, [h]);
  }
  return m;
}

/** Pull the CIK out of a display name's "(CIK 0000123456)" suffix. @param {string} name @returns {string|null} */
export function cikInDisplayName(name) {
  const m = /\(\s*CIK\s*0*(\d{1,10})\s*\)/i.exec(String(name ?? ''));
  return m ? m[1] : null;
}

/**
 * Primary filer CIK rule (derived from the 2026-10-15 live captures, plan section 16):
 *   - every search hit carries `ciks` and a parallel `display_names`, each name ending in "(CIK n)";
 *   - the SEC lists the primary registrant FIRST in `ciks` (VICI Properties Inc. before VICI Properties L.P.;
 *     the lead Unpopular Ventures fund before its QP sibling);
 *   - so the primary filer CIK is ciks[0] of the first hit that has a valid one, and the company name is the
 *     display name whose "(CIK n)" equals that CIK (fallback: display_names[0]);
 *   - every other CIK / display name in any hit of the accession is a co-registrant: it goes to aliases and to
 *     exclusion, never to the company identity;
 *   - if hits of the same accession disagree on the primary CIK, the first one wins and `conflict` is true.
 * @param {Array<import('./edgar-client.js').SearchHit>} hits
 * @returns {{ cik: string|null, primary_name: string, co_names: string[], all_names: string[], conflict: boolean }}
 */
export function primaryFiler(hits) {
  /** @type {string|null} */
  let cik = null;
  let conflict = false;
  for (const h of hits) {
    const c = validCik(h.ciks[0]);
    if (!c) continue;
    if (cik === null) cik = c;
    else if (cik !== c) conflict = true;
  }
  /** @type {string[]} */
  const all = [];
  for (const h of hits) for (const n of h.display_names) if (!all.includes(n)) all.push(n);
  let primary = '';
  if (cik) {
    primary = all.find((n) => cikInDisplayName(n) === cik) ?? '';
  }
  if (!primary) primary = hits.find((h) => h.display_names.length > 0)?.display_names[0] ?? '';
  return { cik, primary_name: primary, co_names: all.filter((n) => n !== primary), all_names: all, conflict };
}

// ---------------------------------------------------------------------------
// Document selection and reading
// ---------------------------------------------------------------------------

/**
 * @param {Array<import('./edgar-client.js').SearchHit>} hits hits of ONE accession, in hit order
 * @returns {{ chosen: Array<{ filename: string, doc_type: string }>, unread: number, invalid: number }}
 */
export function chooseDocs(hits) {
  const form = hits.find((h) => h.form)?.form ?? null;
  /** @type {Array<{ filename: string, doc_type: string, rank: number, order: number }>} */
  const docs = [];
  let invalid = 0;
  hits.forEach((h, order) => {
    const filename = validFilename(h.filename);
    if (!filename) { invalid += 1; return; }
    if (docs.some((d) => d.filename === filename)) return;
    const type = h.file_type ?? '';
    const rank = form && type === form ? 0 : (/^EX-99(\.|$)/i.test(type) ? 1 : 2);
    docs.push({ filename, doc_type: type || 'unknown', rank, order });
  });
  docs.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {
    chosen: docs.slice(0, MAX_DOCS_PER_ACCESSION).map((d) => ({ filename: d.filename, doc_type: d.doc_type })),
    unread: Math.max(0, docs.length - MAX_DOCS_PER_ACCESSION),
    invalid,
  };
}

/**
 * Final fetch status of a filing (plan 17.7, D6). A hit document with an invalid filename can never be read,
 * so it makes an otherwise clean filing partial (needs-review); documents left unread only because of the
 * 3-per-accession cap stay informational. A failed filing stays failed.
 * @param {'ok'|'partial'|'failed'} readStatus
 * @param {number} invalid hit documents with an invalid filename
 * @returns {'ok'|'partial'|'failed'}
 */
export function fetchStatusWithInvalid(readStatus, invalid) {
  return readStatus === 'ok' && invalid > 0 ? 'partial' : readStatus;
}

/**
 * @typedef {Object} DocRead
 * @property {string} filename
 * @property {string} doc_type
 * @property {boolean} ok
 * @property {string|null} reason
 * @property {number|null} status
 * @property {string} text raw body ('' when not ok)
 * @property {boolean} truncated
 */

/**
 * Fetch the chosen documents in order. A budget that runs out mid-way is a fetch failure for the rest
 * (reason "capped"), so the filing comes out partial, never silently clean.
 * @param {import('./edgar-client.js').EdgarClient} edgar
 * @param {string} budget
 * @param {string} cik
 * @param {string} adsh
 * @param {Array<{ filename: string, doc_type: string }>} chosen
 * @returns {Promise<{ docs: DocRead[], status: 'ok'|'partial'|'failed' }>}
 */
export async function readDocs(edgar, budget, cik, adsh, chosen) {
  /** @type {DocRead[]} */
  const docs = [];
  for (const c of chosen) {
    const r = await edgar.document(docUrl(cik, adsh, c.filename), budget);
    docs.push({ filename: c.filename, doc_type: c.doc_type, ok: r.ok, reason: r.reason, status: r.status, text: r.ok ? r.text : '', truncated: r.truncated });
  }
  const okCount = docs.filter((d) => d.ok).length;
  const status = docs.length > 0 && okCount === docs.length ? 'ok' : (okCount === 0 ? 'failed' : 'partial');
  return { docs, status };
}

/** Per-document evidence record: doc type and filename (plan B). @param {DocRead[]} docs */
export function evidenceOf(docs) {
  return docs.map((d) => ({ doc_type: d.doc_type, filename: d.filename, ok: d.ok, reason: d.reason, truncated: d.truncated }));
}
