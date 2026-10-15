// @ts-check
/**
 * Target finder source C: EDGAR full-text search (plan 14.4 C, 15.2, 15.3).
 *
 * Queries come from config/target-fts-queries.json (a keyed object with explicit integer priorities,
 * zod-validated, config-locked). Each enabled query is one discovery GET; each kept hit's main document is
 * fetched (read-capped) for an excerpt window and the sentence pattern "acquired by | merger with |
 * investment from <Name>". The FULL document is scanned for blocked names before any truncation.
 *
 * FTS contact rule (15.3): role only, never a name. Dedup key: edgar_fts|<query id>|<adsh>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getEnv } from '../core/config.js';
import { normalizeCompany } from '../core/normalize.js';
import {
  validCik, validAdsh, validFilename, indexUrl, docUrl, searchUrl, daysBefore, parseSearchResponse,
} from './edgar-client.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash,
} from './signal-text.js';
import { htmlToPlain, extractCoverDate, extractParty, analyzeDeparture, queryTerms, windowAround } from './text-extract.js';
import { cleanDisplayName } from './form-d.js';

export const FTS_SOURCE = 'edgar_fts';
export const FTS_PARSER_VERSION = 'fts-1';
export const FTS_REASONS = Object.freeze([
  'hit_shape_unknown', 'doc_fetch_failed', 'company_missing', 'accession_malformed', 'cik_malformed', 'unknown_shape',
  'run_cap', 'query_disabled',
]);
export const FTS_QUERIES_FILE = 'target-fts-queries.json';
export const FTS_WINDOW_CHARS = 1500;

export const ftsQuerySchema = z.object({
  priority: z.number().int(),
  q: z.string().min(1).max(300),
  forms: z.string().min(1).max(40).regex(/^[A-Za-z0-9,/ -]+$/),
  trigger_kind: z.enum(['pe_deal', 'exec_departure', 'leadership_gap']),
  window_days: z.number().int().min(1).max(365),
  enabled: z.boolean(),
});

/**
 * Load the keyed query object. Keys starting with "_" are comments. Invalid => ok:false (adapter skipped).
 * Total over the file: every entry is validated, a priority tie is broken by id, nothing depends on order.
 * @param {string} [configDir]
 * @returns {{ ok: true, queries: Array<{ id: string } & z.infer<typeof ftsQuerySchema>> } | { ok: false, reason: string }}
 */
export function loadFtsQueries(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, FTS_QUERIES_FILE), 'utf8'));
  } catch {
    return { ok: false, reason: 'missing_or_unparseable' };
  }
  return parseFtsQueries(raw);
}

/** @param {unknown} raw */
export function parseFtsQueries(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return /** @type {const} */ ({ ok: false, reason: 'not_an_object' });
  /** @type {Array<{ id: string } & z.infer<typeof ftsQuerySchema>>} */
  const queries = [];
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    if (!/^[a-z0-9_]{1,40}$/.test(id)) return { ok: false, reason: `bad_query_id:${id.slice(0, 40)}` };
    const p = ftsQuerySchema.safeParse(v);
    if (!p.success) return { ok: false, reason: `invalid_query:${id}` };
    queries.push({ id, ...p.data });
  }
  queries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { ok: true, queries };
}

/**
 * @param {Object} ctx
 * @param {import('./edgar-client.js').EdgarClient|null} ctx.edgar
 * @param {Date} ctx.now
 * @param {string[]} ctx.blocked
 * @param {number} [ctx.blockedMinLength]
 * @param {string} [ctx.configDir]
 * @param {Array<{ id: string } & z.infer<typeof ftsQuerySchema>>} [ctx.queries] injected instead of reading the file
 */
export async function runFts(ctx) {
  const c = createCollector(FTS_SOURCE, FTS_REASONS, FTS_PARSER_VERSION);
  if (!ctx.edgar) { c.skip('sec_contact_missing'); return { items: c.items, stats: c.stats }; }
  if (ctx.edgar.blocked) { c.skip('sec_blocked'); return { items: c.items, stats: c.stats }; }
  const edgar = ctx.edgar;
  let queries = ctx.queries;
  if (!queries) {
    const loaded = loadFtsQueries(ctx.configDir);
    if (!loaded.ok) { c.skip(`config_invalid:${loaded.reason}`); return { items: c.items, stats: c.stats }; }
    queries = loaded.queries;
  }
  const enddt = daysBefore(ctx.now, 0);
  let discoveryTotal = 0;

  for (const q of queries) {
    if (!q.enabled) {
      c.add('out_of_scope', 'query_disabled', { key: `${q.id}|query`, extracted: { query_id: q.id } });
      continue;
    }
    if (edgar.blocked) { c.warn(`query_skipped_blocked:${q.id}`); continue; }
    const r = await edgar.search(searchUrl({ q: q.q, forms: q.forms, dateRange: 'custom', startdt: daysBefore(ctx.now, q.window_days), enddt }), 'discovery');
    if (!r.ok) { c.warn(`discovery_${r.reason ?? 'failed'}:${q.id}`); continue; }
    const parsed = parseSearchResponse(r.text);
    if (!parsed.ok) { c.add('unparseable', 'hit_shape_unknown', { key: `${q.id}|discovery`, extracted: { query_id: q.id } }); continue; }
    discoveryTotal += parsed.total ?? parsed.hits.length;
    if (parsed.total !== null && parsed.total > parsed.hits.length) c.bump('discovery_not_read', parsed.total - parsed.hits.length);
    for (const hit of parsed.hits) {
      c.stats.read += 1;
      const badKey = `${q.id}|bad:${contentHash(hit).slice(0, 16)}`;
      await c.guard(badKey, () => processHit(q, hit, badKey));
    }
  }
  c.stats.discovery_total = discoveryTotal;
  c.stats.warnings.push(...edgar.warnings.filter((w) => !c.stats.warnings.includes(w)));
  return { items: c.items, stats: c.stats };

  /**
   * @param {{ id: string } & z.infer<typeof ftsQuerySchema>} q
   * @param {import('./edgar-client.js').SearchHit} hit
   * @param {string} badKey
   */
  async function processHit(q, hit, badKey) {
    if (!hit.shape_ok) { c.add('unparseable', 'hit_shape_unknown', { key: badKey, extracted: { query_id: q.id } }); return; }
    const adsh = validAdsh(hit.adsh);
    if (!adsh) { c.add('unparseable', 'accession_malformed', { key: badKey, extracted: { query_id: q.id } }); return; }
    const cik = validCik(hit.ciks[0]);
    if (!cik) { c.add('unparseable', 'cik_malformed', { key: `${q.id}|${adsh}`, extracted: { query_id: q.id } }); return; }
    const key = `${q.id}|${adsh}`;
    const rawNames = hit.display_names.slice(0, 5);
    const cleaned = rawNames.map(cleanDisplayName).filter(Boolean);
    const base = { query_id: q.id, accession: adsh, cik, form: hit.form, file_date: hit.file_date, display_names: rawNames };
    const companyName = sanitizeName(cleaned[0] ?? '');
    if (!companyName.value) { c.add('unparseable', 'company_missing', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    if ([...cleaned, ...rawNames].map(sanitizeName).some((n) => n.too_long)) {
      c.add('unparseable', 'name_too_long', { key, url: indexUrl(cik, adsh), extracted: base });
      return;
    }
    const filename = validFilename(hit.filename);
    if (!filename) { c.add('unparseable', 'hit_shape_unknown', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'filename_missing_or_invalid' } }); return; }
    if (!edgar.hasBudget('fts')) { c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base }); return; }
    const doc = await edgar.document(docUrl(cik, adsh, filename), 'fts');
    if (!doc.ok) {
      if (doc.reason === 'capped') c.add('out_of_scope', 'run_cap', { key, url: indexUrl(cik, adsh), extracted: base });
      else c.add('unparseable', 'doc_fetch_failed', { key, url: indexUrl(cik, adsh), extracted: { ...base, fetch_reason: doc.reason, status: doc.status } });
      return;
    }
    const filingDate = typeof hit.file_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hit.file_date) ? hit.file_date : null;
    if (!filingDate) { c.add('unparseable', 'unknown_shape', { key, url: indexUrl(cik, adsh), extracted: { ...base, issue: 'filing_date_missing' } }); return; }
    const plain = htmlToPlain(doc.text);
    const scan = findBlockedHits(plain, ctx.blocked, { minLength: ctx.blockedMinLength });
    const window = sanitizeText(windowAround(plain, queryTerms(q.q), FTS_WINDOW_CHARS), FTS_WINDOW_CHARS);
    const party = extractParty(plain);
    let role = null;
    let ambiguous = false;
    if (q.trigger_kind === 'exec_departure') {
      const a = analyzeDeparture(plain);
      role = a.role;
      ambiguous = a.kind !== 'departure';
    }
    const aliases = [...new Set([...cleaned.slice(1), ...rawNames.map((n) => sanitizeText(n, 400))])];
    const signal = {
      trigger_kind: q.trigger_kind,
      company: companyName.value,
      aliases,
      acquirer: party?.kind === 'acquirer' ? party.name : null,
      investor: party?.kind === 'investor' ? party.name : null,
      pe_firm: null,
      text: buildSignalText(scan.hits, [window]),
      evidence_url: indexUrl(cik, adsh),
      evidence_source: 'edgar_fts',
      event_date: extractCoverDate(plain),
      filing_date: filingDate,
      role,
      ...(q.trigger_kind === 'exec_departure' ? { departure_ambiguous: ambiguous } : {}),
    };
    c.add('parsed', 'ok', {
      key,
      signal,
      contact: role ? { role, name: null } : null,
      url: signal.evidence_url,
      excerpt: makeExcerpt(window),
      extracted: boundExtracted({
        ...base,
        trigger_kind: q.trigger_kind,
        company: companyName.value,
        company_norm: normalizeCompany(companyName.value).company_norm,
        alias_norms: aliases.map((a) => normalizeCompany(a).company_norm).filter(Boolean).slice(0, 10),
        event_date: signal.event_date,
        filing_date: filingDate,
        party: party ?? null,
        blocked_hits: scan.hits.map((h) => h.entry),
        scanned_chars: scan.scanned_chars,
        doc_truncated: doc.truncated,
        amendment: /\/A$/i.test(String(hit.form ?? '')),
      }),
    });
  }
}
