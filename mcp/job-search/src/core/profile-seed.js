// @ts-check
/**
 * Seed the exec-default search profile from data/profile.md (spec 2.3).
 * profile.md is gitignored and personal; this module only reads the
 * "Target Roles" bullets and the location lines and never copies anything
 * else (no contact details, no compensation) into the database.
 *
 * Falls back to a role-agnostic executive default when the file is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './config.js';
import { computeProfileRev } from './upsert.js';

/**
 * @typedef {Object} SearchProfile
 * @property {string} name
 * @property {string[]} keywords
 * @property {string[]} phrases
 * @property {string[]} exclude_terms
 * @property {string[]} locations
 * @property {string} remote
 * @property {number} posted_within_days
 * @property {number} max_pages
 * @property {string[]} sources
 */

/** @type {SearchProfile} */
export const FALLBACK_PROFILE = Object.freeze({
  name: 'exec-default',
  keywords: ['CTO', 'CIO', 'Chief Technology Officer', 'Chief Information Officer', 'Chief Digital Officer', 'Chief AI Officer', 'COO'],
  phrases: ['SVP Digital Transformation', 'VP E-Commerce', 'VP Payments Strategy', 'VP Technology', 'Head of Technology'],
  exclude_terms: ['intern', 'junior', 'analyst', 'coordinator', 'sales representative'],
  locations: ['Houston, TX', 'Dallas, TX', 'Austin, TX', 'United States'],
  remote: 'any',
  posted_within_days: 7,
  max_pages: 3,
  sources: ['greenhouse', 'lever', 'workday', 'indeed', 'linkedin'],
});

const STATE_ABBR = /** @type {Record<string, string>} */ ({ texas: 'TX', california: 'CA', 'new york': 'NY', florida: 'FL', washington: 'WA', illinois: 'IL', georgia: 'GA', colorado: 'CO', arizona: 'AZ' });

/** @param {string} s */
function tidyLocation(s) {
  const t = s.replace(/\s*[\u2014\u2013-]\s.*$/, '').trim(); // drop trailing commentary after a dash
  const m = /^([^,]+),\s*([A-Za-z .]+)$/.exec(t);
  if (!m) return t;
  const state = m[2].trim();
  const abbr = STATE_ABBR[state.toLowerCase()] ?? (state.length === 2 ? state.toUpperCase() : state);
  return `${m[1].trim()}, ${abbr}`;
}

/**
 * Parse profile.md text into keywords/phrases/locations. Pure.
 * @param {string} text
 * @returns {{ keywords: string[], phrases: string[], locations: string[] }}
 */
export function parseProfileMarkdown(text) {
  const keywords = new Set();
  const phrases = new Set();
  const locations = new Set();
  const lines = text.split(/\r?\n/);
  let inTargets = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+Target Roles/i.test(line)) {
      inTargets = true;
      continue;
    }
    if (inTargets && /^##\s+/.test(line)) inTargets = false;
    if (inTargets) {
      if (/^\*\*Not target roles/i.test(line)) {
        inTargets = false;
        continue;
      }
      const m = /^-\s*\*\*(.+?)\*\*\s*(?:[\u2014\u2013-]+\s*(.+))?$/.exec(line);
      if (!m) continue;
      const head = m[1].trim();
      const tail = (m[2] ?? '').replace(/\s*\(.*$/, '').trim();
      const heads = head.split('/').map((s) => s.trim()).filter(Boolean);
      if (heads.every((h) => /^[A-Z]{2,5}$/.test(h))) {
        for (const h of heads) keywords.add(h);
        if (tail) keywords.add(tail);
      } else {
        // "SVP / VP E-Commerce / Digital Commerce" -> expand prefixes x suffixes
        const prefixes = [];
        const suffixes = [];
        for (const h of heads) {
          if (/^(SVP|VP|EVP|Head of|Director)$/i.test(h)) prefixes.push(h);
          else suffixes.push(h.replace(/^(SVP|VP|EVP|Head of)\s+/i, (p) => { prefixes.push(p.trim()); return ''; }).trim());
        }
        const uniqP = [...new Set(prefixes)];
        const uniqS = [...new Set(suffixes)].filter(Boolean);
        if (uniqP.length === 0) for (const s of uniqS) phrases.add(s);
        for (const p of uniqP) for (const s of uniqS) phrases.add(`${p} ${s}`);
      }
    }
    const addr = /^-\s*\*\*Address:\*\*\s*(.+)$/.exec(line);
    if (addr) locations.add(tidyLocation(addr[1]));
    const sec = /^-\s*\*\*Secondary Location\*\*:?\s*(.+)$/.exec(line);
    if (sec) locations.add(tidyLocation(sec[1]));
  }
  return { keywords: [...keywords], phrases: [...phrases], locations: [...locations] };
}

/**
 * Build the seed profile from data/profile.md, merged over the fallback.
 * @param {string} [file]
 * @returns {{ profile: SearchProfile, from: 'profile.md'|'fallback' }}
 */
export function buildSeedProfile(file = path.join(repoRoot(), 'data', 'profile.md')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { profile: { ...FALLBACK_PROFILE }, from: 'fallback' };
  }
  const p = parseProfileMarkdown(text);
  if (p.keywords.length === 0 && p.phrases.length === 0) return { profile: { ...FALLBACK_PROFILE }, from: 'fallback' };
  const locations = [...new Set([...p.locations, 'United States'])];
  return {
    profile: {
      ...FALLBACK_PROFILE,
      keywords: p.keywords.length ? p.keywords : FALLBACK_PROFILE.keywords,
      phrases: p.phrases.length ? p.phrases : FALLBACK_PROFILE.phrases,
      locations,
    },
    from: 'profile.md',
  };
}

/**
 * Insert exec-default when absent. Never overwrites an existing row.
 * @param {import('pg').ClientBase} client
 * @param {string} [file]
 * @returns {Promise<{ seeded: boolean, from: string }>}
 */
export async function seedExecDefault(client, file) {
  const exists = await client.query(`SELECT 1 FROM ic_search_profiles WHERE name = 'exec-default'`);
  if ((exists.rowCount ?? 0) > 0) return { seeded: false, from: 'existing' };
  const { profile, from } = buildSeedProfile(file);
  const rev = computeProfileRev(profile);
  await client.query(
    `INSERT INTO ic_search_profiles (name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (name) DO NOTHING`,
    [profile.name, profile.keywords, profile.phrases, profile.exclude_terms, profile.locations, profile.remote, profile.posted_within_days, profile.max_pages, profile.sources, rev],
  );
  return { seeded: true, from };
}
