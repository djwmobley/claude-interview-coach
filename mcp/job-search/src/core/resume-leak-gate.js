// @ts-check
/**
 * Deterministic post-generation check for a generated resume (resume-runner and ready-resume-runner).
 * A job listing is untrusted text; an injected listing can tell the resume run to copy private profile
 * data (home street address, ZIP, compensation, date of birth) into the resume, which is then submitted
 * to the listing owner's ATS. This gate runs on the finished markdown, before anything can render or
 * submit it, and it cannot be talked out of anything: it is plain string and number comparison.
 *
 * Private values are loaded at runtime from data/profile.md; nothing personal is written in this file.
 * Profile lines look like `- **Label:** value`, under `## Section` headings. A line is read wherever it
 * appears (no position or adjacency assumption). Classification of profile lines:
 *   - label is an address: the street line (first comma part holding a digit) and every ZIP are private
 *   - label is a birth date: the whole value is private
 *   - any line under a heading about compensation, salary or pay, or whose label says so: every number of
 *     10,000 or more in the value (plain, comma-grouped, or K/M suffixed) is private
 *   - label or heading says private or confidential: the whole value is private
 * Everything else (name, email, phone, city, LinkedIn URL) is not private and always passes.
 *
 * Total classification, fail closed: an unreadable profile, a profile with no `- **Label:** value` lines,
 * or one with no address line is `private_data_profile_unreadable`, never a skipped check.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEAK_REASON = 'private_data_leak';
export const PROFILE_REASON = 'private_data_profile_unreadable';

const FIELD_RE = /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*:?\s*(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const ADDRESS_LABEL_RE = /address|street|residen|home\s*location/i;
const BIRTH_LABEL_RE = /birth|\bdob\b|\bborn\b/i;
const COMP_RE = /compens|salary|\bpay\b|bonus|equity|\bcomp\b|\brate\b|wage|remunerat/i;
const PRIVATE_RE = /private|confidential|do not (share|include|disclose)|never (share|include|disclose)/i;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/g;

/** Compensation shaped text in a resume, wherever it appears: $ amount with K, or 6+ digits. */
const COMP_PATTERNS = [
  /\$\s*\d[\d,]*(?:\.\d+)?\s*[kK]\b/,
  /\$\s*\d{6,}/,
  /\$\s*\d{1,3}(?:,\d{3}){2,}/,
  /\$\s*\d{3},\d{3}\b/,
];

/** @param {string} s */
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Every number worth protecting in a text, as an integer string: "225,000", "225000", "$225K", "1.5M".
 * @param {string} text
 * @param {number} min
 * @returns {Set<string>}
 */
export function amountsIn(text, min = 10000) {
  const out = new Set();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?![\w])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
    const n = Math.round(base * mult);
    if (n >= min) out.add(String(n));
  }
  return out;
}

/**
 * @param {string} markdown profile.md content
 * @returns {{ phrases: string[], amounts: Set<string>, zips: Set<string> }}
 */
export function parsePrivateFields(markdown) {
  /** @type {string[]} */
  const phrases = [];
  const amounts = new Set();
  const zips = new Set();
  let heading = '';
  let fieldLines = 0;
  let sawAddress = false;
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = HEADING_RE.exec(line);
    if (h) { heading = h[1]; continue; }
    const f = FIELD_RE.exec(line);
    if (!f) continue;
    fieldLines++;
    const label = f[1].trim();
    const value = f[2].trim();
    const privateSection = PRIVATE_RE.test(heading);
    if (ADDRESS_LABEL_RE.test(label) && !COMP_RE.test(label)) {
      sawAddress = true;
      for (const z of value.match(ZIP_RE) ?? []) zips.add(z.slice(0, 5));
      const street = value.split(/[,;]/).map((p) => p.trim()).find((p) => /\d/.test(p) && /[a-z]/i.test(p) && !/^\D*\d{5}(-\d{4})?\D*$/.test(p));
      if (street) phrases.push(street);
    }
    if (BIRTH_LABEL_RE.test(label) && value) phrases.push(value);
    if (COMP_RE.test(heading) || COMP_RE.test(label)) for (const a of amountsIn(value)) amounts.add(a);
    if ((PRIVATE_RE.test(label) || privateSection) && value.length >= 4) phrases.push(value);
  }
  if (fieldLines === 0 || !sawAddress) {
    throw new Error('profile has no recognizable address line');
  }
  return { phrases: [...new Set(phrases)], amounts, zips };
}

/**
 * @param {string} profilePath
 * @returns {{ ok: true, fields: ReturnType<typeof parsePrivateFields> } | { ok: false, reason: string, detail: string }}
 */
export function loadPrivateFields(profilePath) {
  try {
    return { ok: true, fields: parsePrivateFields(fs.readFileSync(profilePath, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: PROFILE_REASON, detail: String(/** @type {any} */ (err)?.message ?? err).slice(0, 120) };
  }
}

/**
 * Pure check of resume markdown against parsed private fields. `detail` names the KIND of hit only (never the value).
 * @param {string} resumeMarkdown
 * @param {ReturnType<typeof parsePrivateFields>} fields
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
export function scanResume(resumeMarkdown, fields) {
  const text = String(resumeMarkdown);
  const flat = ` ${squash(text)} `;
  for (const p of fields.phrases) {
    const sq = squash(p);
    if (sq && flat.includes(` ${sq} `)) return { ok: false, reason: LEAK_REASON, detail: 'private_profile_value' };
  }
  for (const z of fields.zips) {
    if (new RegExp(`(?<![\\d])${z}(?:-\\d{4})?(?![\\d])`).test(text)) return { ok: false, reason: LEAK_REASON, detail: 'zip' };
  }
  if (COMP_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: LEAK_REASON, detail: 'compensation_pattern' };
  if (fields.amounts.size) {
    for (const a of amountsIn(text)) if (fields.amounts.has(a)) return { ok: false, reason: LEAK_REASON, detail: 'compensation_value' };
  }
  return { ok: true };
}

/**
 * Read the profile and the resume markdown from disk and classify. Every outcome is ok or a reasoned block.
 * @param {{ repoRoot: string, markdownPath: string, profilePath?: string }} o markdownPath is repo-relative or absolute
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
export function checkResumeFile(o) {
  const loaded = loadPrivateFields(o.profilePath ?? path.join(o.repoRoot, 'data', 'profile.md'));
  if (!loaded.ok) return loaded;
  let md;
  try {
    md = fs.readFileSync(path.isAbsolute(o.markdownPath) ? o.markdownPath : path.join(o.repoRoot, ...o.markdownPath.split('/')), 'utf8');
  } catch (err) {
    return { ok: false, reason: PROFILE_REASON, detail: `resume markdown unreadable: ${String(/** @type {any} */ (err)?.code ?? 'error')}` };
  }
  return scanResume(md, loaded.fields);
}
