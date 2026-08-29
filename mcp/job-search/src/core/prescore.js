// @ts-check
/**
 * Prescore: a cheap, deterministic 0-100 signal computed at ingest from the
 * listing and the search profile. It gates detail fetches (>= 40 by default)
 * and orders the compact rows; it is NOT the fit score, which stays with the
 * model (mark_jobs). Pure function, no I/O.
 */

/**
 * @typedef {Object} PrescoreProfile
 * @property {string[]} [keywords]
 * @property {string[]} [phrases]
 * @property {string[]} [exclude_terms]
 * @property {string[]} [locations]
 * @property {string} [remote] any|remote|onsite|hybrid
 */

const SENIORITY = [
  [/\b(chief|cto|cio|coo|cdo|caio|ceo)\b/i, 30],
  [/\b(svp|evp|senior vice president|executive vice president)\b/i, 26],
  [/\b(vp|vice president|head of)\b/i, 22],
  [/\b(managing director|executive director)\b/i, 20],
  [/\b(senior director|sr\.? director)\b/i, 14],
  [/\bdirector\b/i, 10],
];

const JUNIOR = /\b(intern|internship|junior|jr\.?|associate|coordinator|assistant|entry[- ]level|analyst i\b)/i;

/** @param {string} s */
function words(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * @typedef {Object} PrescoreParts
 * @property {number} seniority points from the best single title seniority match (0 if none)
 * @property {number} junior the JUNIOR-title penalty, folded in as its own named, explicit part (0 or -25)
 * @property {number} titleKeywords profile keyword/phrase hits found in the title (capped at 30)
 * @property {number} descKeywords profile keyword/phrase hits found only in the description (capped at 10)
 * @property {number} exclusions profile exclude_terms hits; uncapped, always <= 0
 * @property {number} location location/remote fit signal
 * @property {number} salary executive salary-band signal
 */

/**
 * Named, additive breakdown of a prescore. `sum` is the pre-clamp total of every part; `raw` is `sum`
 * clamped to [0, 100] and rounded, identically to how `prescore()` itself has always computed its
 * result. `prescore()` below calls this and returns `raw`, so "parts sum to the clamped, rounded score"
 * is a structural invariant (there is only one place the arithmetic happens), not a fact that could drift
 * between two independently maintained implementations.
 *
 * The noise_class multiplier is deliberately NOT a part here: it is a separate, later transformation
 * applied by `weightedPrescore()` in noise.js, against the already-clamped `raw` value, not against the
 * pre-clamp `sum`.
 * @param {{ title: string, company?: string, location?: string|null, location_norm?: string|null, remote_mode?: string|null, description?: string|null, salary_max?: number|null }} rec
 * @param {PrescoreProfile} profile
 * @returns {{ parts: PrescoreParts, sum: number, raw: number }}
 */
export function prescoreParts(rec, profile = {}) {
  const title = words(rec.title);
  const desc = words(rec.description ?? '').slice(0, 4000);

  // Seniority signal from the title (best single match), with the JUNIOR-title penalty as its own
  // explicit, named part rather than folded silently into the same accumulator.
  let seniority = 0;
  for (const [re, pts] of SENIORITY) {
    if (re.test(title)) seniority = Math.max(seniority, /** @type {number} */ (pts));
  }
  const junior = JUNIOR.test(title) ? -25 : 0;

  // Profile keywords and phrases in the title (strong) or description (weak).
  const kws = (profile.keywords ?? []).map(words).filter(Boolean);
  const phrases = (profile.phrases ?? []).map(words).filter(Boolean);
  let titleHits = 0;
  let descHits = 0;
  for (const k of [...kws, ...phrases]) {
    if (title.includes(k)) titleHits++;
    else if (desc && desc.includes(k)) descHits++;
  }
  const titleKeywords = Math.min(30, titleHits * 15);
  const descKeywords = Math.min(10, descHits * 3);

  // Exclusions: uncapped and always <= 0, may drive the sum negative on its own (before the floor at 0
  // is applied to the final clamped value).
  let exclusions = 0;
  for (const x of (profile.exclude_terms ?? []).map(words).filter(Boolean)) {
    if (title.includes(x)) exclusions -= 30;
    else if (desc && desc.includes(x)) exclusions -= 8;
  }

  // Location fit.
  let location = 0;
  const locNorm = String(rec.location_norm ?? '');
  const locRaw = words(rec.location ?? '');
  const wantRemote = String(profile.remote ?? 'any').toLowerCase();
  const isRemote = rec.remote_mode === 'remote' || locNorm.startsWith('remote-');
  const profLocs = (profile.locations ?? []).map(words).filter(Boolean);
  if (isRemote) {
    location = wantRemote === 'onsite' ? -10 : 12;
  } else if (profLocs.length) {
    const hit = profLocs.some((l) => {
      const city = l.split(',')[0].trim();
      return city && (locRaw.includes(city) || locNorm.startsWith(city.replace(/\s+/g, '-')));
    });
    if (hit) location = 12;
    else if (locNorm.startsWith('country-') || locRaw.includes('united states')) location = 4;
    else if (locNorm === 'absent' || locNorm === 'legacy-unknown') location = 2;
    else if (wantRemote === 'remote') location = -10;
  }

  // Salary signal (executive band).
  let salary = 0;
  if (typeof rec.salary_max === 'number') {
    if (rec.salary_max >= 250000) salary = 8;
    else if (rec.salary_max >= 180000) salary = 4;
    else if (rec.salary_max < 120000) salary = -10;
  }

  const parts = { seniority, junior, titleKeywords, descKeywords, exclusions, location, salary };
  const sum = seniority + junior + titleKeywords + descKeywords + exclusions + location + salary;
  const raw = Math.max(0, Math.min(100, Math.round(sum)));
  return { parts, sum, raw };
}

/**
 * @param {{ title: string, company?: string, location?: string|null, location_norm?: string|null, remote_mode?: string|null, description?: string|null, salary_max?: number|null }} rec
 * @param {PrescoreProfile} profile
 * @returns {number} integer 0-100
 */
export function prescore(rec, profile = {}) {
  return prescoreParts(rec, profile).raw;
}
