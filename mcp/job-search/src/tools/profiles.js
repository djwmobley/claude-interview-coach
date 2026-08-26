// @ts-check
/**
 * profiles (spec section 5): list or upsert search profiles. Upsert echoes
 * the normalized stored values and the new rev.
 */
import { z } from 'zod';
import { computeProfileRev } from '../core/upsert.js';
import { JobSearchError } from '../core/errors.js';

const KEYWORD = /^[\p{L}\p{N} .,+'/&-]{1,80}$/u;

export const schema = {
  action: z.enum(['list', 'upsert']),
  profile: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase slug'),
    keywords: z.array(z.string().max(80)).max(30).optional(),
    phrases: z.array(z.string().max(80)).max(30).optional(),
    exclude_terms: z.array(z.string().max(80)).max(30).optional(),
    locations: z.array(z.string().max(80)).max(10).optional(),
    remote: z.enum(['any', 'remote', 'hybrid', 'onsite']).optional(),
    posted_within_days: z.number().int().min(1).max(30).optional(),
    max_pages: z.number().int().min(1).max(5).optional(),
    sources: z.array(z.string().max(40)).max(10).optional(),
  }).optional(),
};

const COLS = 'name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev, updated_at';

/** @param {string[]} arr @param {string} field */
function cleanTerms(arr, field) {
  const out = [];
  for (const s of arr) {
    const t = String(s).trim();
    if (!t) continue;
    if (!KEYWORD.test(t)) throw new JobSearchError('VALIDATION', `${field} entry rejected (letters, digits, space . , + ' / & - only, max 80): ${t.slice(0, 40)}`);
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'profiles',
  description: 'List search profiles, or upsert one (name plus keywords/phrases/exclude_terms/locations/remote/posted_within_days/max_pages/sources). Upsert echoes the stored values and the new rev.',
  schema,
  async handler(a, deps) {
    if (a.action === 'list') {
      const r = await deps.withClient((c) => c.query(`SELECT ${COLS} FROM ic_search_profiles ORDER BY name`));
      return { ok: true, profiles: r.rows.map((p) => ({ ...p, rev: String(p.rev).slice(0, 12), updated_at: new Date(p.updated_at).toISOString().slice(0, 10) })) };
    }
    if (!a.profile) throw new JobSearchError('VALIDATION', 'profile is required for upsert');
    const p = a.profile;
    const existing = await deps.withClient((c) => c.query(`SELECT ${COLS} FROM ic_search_profiles WHERE name = $1`, [p.name]));
    const base = existing.rows[0] ?? { keywords: [], phrases: [], exclude_terms: [], locations: [], remote: 'any', posted_within_days: 7, max_pages: 3, sources: [] };
    const merged = {
      name: p.name,
      keywords: cleanTerms(p.keywords ?? base.keywords, 'keywords'),
      phrases: cleanTerms(p.phrases ?? base.phrases, 'phrases'),
      exclude_terms: cleanTerms(p.exclude_terms ?? base.exclude_terms, 'exclude_terms'),
      locations: cleanTerms(p.locations ?? base.locations, 'locations'),
      remote: p.remote ?? base.remote,
      posted_within_days: p.posted_within_days ?? base.posted_within_days,
      max_pages: p.max_pages ?? base.max_pages,
      sources: cleanTerms(p.sources ?? base.sources, 'sources').map((s) => s.toLowerCase()),
    };
    if (deps.config) {
      const known = new Set([...Object.keys(deps.config.adapters.adapters), 'exec']);
      for (const s of merged.sources) if (!known.has(s)) throw new JobSearchError('VALIDATION', `unknown source: ${s}`, { hint: `known: ${[...known].join(', ')}` });
    }
    if (merged.keywords.length + merged.phrases.length === 0) throw new JobSearchError('VALIDATION', 'a profile needs at least one keyword or phrase');
    const rev = computeProfileRev(merged);
    const r = await deps.withClient((c) => c.query(
      `INSERT INTO ic_search_profiles (name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (name) DO UPDATE SET keywords = EXCLUDED.keywords, phrases = EXCLUDED.phrases, exclude_terms = EXCLUDED.exclude_terms,
         locations = EXCLUDED.locations, remote = EXCLUDED.remote, posted_within_days = EXCLUDED.posted_within_days, max_pages = EXCLUDED.max_pages,
         sources = EXCLUDED.sources, rev = EXCLUDED.rev, updated_at = now()
       RETURNING ${COLS}`,
      [merged.name, merged.keywords, merged.phrases, merged.exclude_terms, merged.locations, merged.remote, merged.posted_within_days, merged.max_pages, merged.sources, rev],
    ));
    const row = r.rows[0];
    return { ok: true, created: existing.rowCount === 0, profile: { ...row, updated_at: new Date(row.updated_at).toISOString() }, rev_changed: existing.rows[0] ? existing.rows[0].rev !== rev : true };
  },
};
