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
 * @param {{ title: string, company?: string, location?: string|null, location_norm?: string|null, remote_mode?: string|null, description?: string|null, salary_max?: number|null }} rec
 * @param {PrescoreProfile} profile
 * @returns {number} integer 0-100
 */
export function prescore(rec, profile = {}) {
  const title = words(rec.title);
  const desc = words(rec.description ?? '').slice(0, 4000);
  let score = 0;

  // Seniority signal from the title (best single match).
  let sen = 0;
  for (const [re, pts] of SENIORITY) {
    if (re.test(title)) {
      sen = Math.max(sen, /** @type {number} */ (pts));
    }
  }
  score += sen;
  if (JUNIOR.test(title)) score -= 25;

  // Profile keywords and phrases in the title (strong) or description (weak).
  const kws = (profile.keywords ?? []).map(words).filter(Boolean);
  const phrases = (profile.phrases ?? []).map(words).filter(Boolean);
  let titleHits = 0;
  let descHits = 0;
  for (const k of [...kws, ...phrases]) {
    if (title.includes(k)) titleHits++;
    else if (desc && desc.includes(k)) descHits++;
  }
  score += Math.min(30, titleHits * 15);
  score += Math.min(10, descHits * 3);

  // Exclusions.
  for (const x of (profile.exclude_terms ?? []).map(words).filter(Boolean)) {
    if (title.includes(x)) score -= 30;
    else if (desc && desc.includes(x)) score -= 8;
  }

  // Location fit.
  const locNorm = String(rec.location_norm ?? '');
  const locRaw = words(rec.location ?? '');
  const wantRemote = String(profile.remote ?? 'any').toLowerCase();
  const isRemote = rec.remote_mode === 'remote' || locNorm.startsWith('remote-');
  const profLocs = (profile.locations ?? []).map(words).filter(Boolean);
  if (isRemote) score += wantRemote === 'onsite' ? -10 : 12;
  else if (profLocs.length) {
    const hit = profLocs.some((l) => {
      const city = l.split(',')[0].trim();
      return city && (locRaw.includes(city) || locNorm.startsWith(city.replace(/\s+/g, '-')));
    });
    if (hit) score += 12;
    else if (locNorm.startsWith('country-') || locRaw.includes('united states')) score += 4;
    else if (locNorm === 'absent' || locNorm === 'legacy-unknown') score += 2;
    else if (wantRemote === 'remote') score -= 10;
  }

  // Salary signal (executive band).
  if (typeof rec.salary_max === 'number') {
    if (rec.salary_max >= 250000) score += 8;
    else if (rec.salary_max >= 180000) score += 4;
    else if (rec.salary_max < 120000) score -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
