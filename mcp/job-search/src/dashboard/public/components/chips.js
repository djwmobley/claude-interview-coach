// @ts-check
/**
 * Closed chip/badge color tables (design reconciliation "Chip and badge mapping", extended by
 * pr3-spec-decisions.md sections 9.2 and 9.17). Every function here is a TOTAL classification: every
 * input this app can ever produce, including `null`/unrecognized values, returns a defined
 * `{label, fg, bg, style}` tuple, never `undefined`. `fg`/`bg` are CSS custom-property names (e.g.
 * `--purple`); `chipClassName()` turns a tuple into the CSS classes actually defined in app.css. This
 * file cannot import src/core/statuses.js (browser-only, no bundler): its tables are a hand-maintained
 * mirror, cross-checked for completeness by test/dashboard-chips.test.js against the real source lists.
 */

/** @typedef {{ label: string, fg: string, bg: string, style: 'outline'|'filled' }} Chip */

const O = 'outline';
const F = 'filled';

/** @param {string} status */
export function stageChip(status) {
  /** @type {Record<string, Chip>} */
  const table = {
    new: { label: 'New', fg: '--muted', bg: '--tag-bg', style: O },
    maybe: { label: 'Maybe', fg: '--purple', bg: '--purple-dim', style: O },
    shortlisted: { label: 'Shortlisted', fg: '--cyan', bg: '--cyan-dim', style: O },
    applied: { label: 'Applied', fg: '--accent', bg: '--accent-dim', style: O },
    interviewing: { label: 'Interviewing', fg: '--yellow', bg: '--yellow-dim', style: O },
    offer: { label: 'Offer', fg: '--green', bg: '--green-dim', style: O },
    accepted: { label: 'Accepted', fg: '--bg', bg: '--green', style: F },
    passed: { label: 'Passed', fg: '--muted', bg: '--tag-bg', style: O },
    lost: { label: 'Lost', fg: '--red', bg: '--red-dim', style: O },
    skip: { label: 'Skip', fg: '--muted-2', bg: '--tag-bg', style: O },
    dead: { label: 'Dead', fg: '--muted-2', bg: '--tag-bg', style: O },
    review: { label: 'Review', fg: '--pink', bg: '--pink-dim', style: O },
  };
  if (status === null || status === undefined) return { label: 'Untriaged', fg: '--muted-2', bg: '--tag-bg', style: O };
  return table[status] ?? { label: 'Unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/** @param {string} actor */
export function actorBadge(actor) {
  /** @type {Record<string, Chip>} */
  const table = {
    dashboard: { label: 'you', fg: '--accent', bg: '--accent-dim', style: O },
    mcp: { label: 'claude', fg: '--purple', bg: '--purple-dim', style: O },
    cli: { label: 'cli', fg: '--muted', bg: '--tag-bg', style: O },
    seed: { label: 'seed', fg: '--muted-2', bg: '--tag-bg', style: O },
    migration: { label: 'migration', fg: '--muted-2', bg: '--tag-bg', style: O },
  };
  return table[actor] ?? { label: 'unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/** @param {string} kind */
export function documentChip(kind) {
  /** @type {Record<string, Chip>} */
  const table = {
    resume: { label: 'Resume', fg: '--accent', bg: '--accent-dim', style: O },
    coverletter: { label: 'Cover letter', fg: '--purple', bg: '--purple-dim', style: O },
    cheatsheet: { label: 'Cheat sheet', fg: '--yellow', bg: '--yellow-dim', style: O },
    markdown: { label: 'Markdown', fg: '--muted', bg: '--tag-bg', style: O },
    research: { label: 'Research', fg: '--cyan', bg: '--cyan-dim', style: O },
    report: { label: 'Report', fg: '--green', bg: '--green-dim', style: O },
    other: { label: 'Other', fg: '--muted-2', bg: '--tag-bg', style: O },
  };
  return table[kind] ?? { label: 'Other', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/**
 * Run status chip. `status='failed'` with an `errors` entry `{code:'CANCELLED'}` derives Canceled
 * (pr3-spec-decisions.md section 9 item 2); plain `failed` (no such entry) stays Failed. `locked` is one
 * of the five DB CHECK values but has no design mapping, so it gets its own defined entry here rather
 * than falling through to Unknown. Anything else (a future DB value) maps to the Unknown fallback.
 * @param {{ status: string, errors?: Array<{code?:string}> }} run
 */
export function runStatusChip(run) {
  const errors = Array.isArray(run.errors) ? run.errors : [];
  if (run.status === 'failed' && errors.some((e) => e && e.code === 'CANCELLED')) {
    return { label: 'Canceled', fg: '--muted', bg: '--tag-bg', style: O };
  }
  /** @type {Record<string, Chip>} */
  const table = {
    ok: { label: 'Ok', fg: '--green', bg: '--green-dim', style: O },
    partial: { label: 'Partial', fg: '--yellow', bg: '--yellow-dim', style: O },
    failed: { label: 'Failed', fg: '--red', bg: '--red-dim', style: O },
    running: { label: 'Running', fg: '--accent', bg: '--accent-dim', style: O },
    locked: { label: 'Locked', fg: '--muted', bg: '--tag-bg', style: O },
  };
  return table[run.status] ?? { label: 'Unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/** @param {string} trigger */
export function triggerBadge(trigger) {
  /** @type {Record<string, Chip>} */
  const table = {
    cli: { label: 'cli', fg: '--muted', bg: '--tag-bg', style: O },
    mcp: { label: 'mcp', fg: '--purple', bg: '--purple-dim', style: O },
    dashboard: { label: 'dashboard', fg: '--accent', bg: '--accent-dim', style: O },
  };
  return table[trigger] ?? { label: trigger ?? 'unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/**
 * Run item outcome chip. CORRECTION to the design reconciliation's mapping (its `inserted`/`seen`/
 * `review`/`noise` labels do not exist in the database): `ic_scan_run_items.outcome`'s actual CHECK
 * constraint (sql/003_scan_runs.sql) is the closed set `new`, `update`, `cross_source_dup`, `repost`,
 * `ambiguous`. Found while seeding fixture data for the Playwright screenshot pass; fixed here rather
 * than shipping a chip table that can never match a real row.
 * @param {string} outcome
 */
export function runItemOutcomeChip(outcome) {
  /** @type {Record<string, Chip>} */
  const table = {
    new: { label: 'New', fg: '--green', bg: '--green-dim', style: O },
    update: { label: 'Updated', fg: '--accent', bg: '--accent-dim', style: O },
    cross_source_dup: { label: 'Duplicate', fg: '--purple', bg: '--purple-dim', style: O },
    repost: { label: 'Repost', fg: '--yellow', bg: '--yellow-dim', style: O },
    ambiguous: { label: 'Ambiguous', fg: '--pink', bg: '--pink-dim', style: O },
  };
  return table[outcome] ?? { label: outcome ?? 'Unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/** @param {number|null} days */
export function agingChip(days) {
  if (days === null || days === undefined || days < 7) return { label: days == null ? 'unknown age' : `${days}d`, fg: '--muted', bg: '--tag-bg', style: O };
  if (days <= 14) return { label: `${days}d`, fg: '--yellow', bg: '--yellow-dim', style: O };
  return { label: `${days}d`, fg: '--red', bg: '--red-dim', style: O };
}

/** @param {number|null|undefined} score */
export function scoreChip(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return { label: 'no score', fg: '--muted', bg: '--tag-bg', style: O };
  const n = Number(score);
  if (n >= 85) return { label: String(n), fg: '--green', bg: '--green-dim', style: O };
  if (n >= 70) return { label: String(n), fg: '--yellow', bg: '--yellow-dim', style: O };
  return { label: String(n), fg: '--muted', bg: '--tag-bg', style: O };
}

/**
 * Analytics source series color (section 9 item 17, chart-colors totality test). Fixed order of the
 * seven known sources; any other value gets the closed fallback rather than an undefined DOM attribute.
 * @param {string|null|undefined} source
 */
export function sourceChip(source) {
  /** @type {Record<string, Chip>} */
  const table = {
    greenhouse: { label: 'Greenhouse', fg: '--accent', bg: '--accent-dim', style: O },
    lever: { label: 'Lever', fg: '--cyan', bg: '--cyan-dim', style: O },
    linkedin: { label: 'LinkedIn', fg: '--purple', bg: '--purple-dim', style: O },
    indeed: { label: 'Indeed', fg: '--yellow', bg: '--yellow-dim', style: O },
    builtin: { label: 'BuiltIn', fg: '--green', bg: '--green-dim', style: O },
    ziprecruiter: { label: 'ZipRecruiter', fg: '--pink', bg: '--pink-dim', style: O },
    manual: { label: 'Manual', fg: '--purple', bg: '--purple-dim', style: O },
  };
  return table[source ?? ''] ?? { label: source ?? 'Unknown', fg: '--muted-2', bg: '--tag-bg', style: O };
}

/** Turn a token slug like "--purple-dim" into the CSS class suffix "purple-dim". @param {string} token */
function slug(token) {
  return String(token).replace(/^--/, '');
}

/**
 * The only place a Chip tuple becomes a className string, consumed by `h({className: chipClassName(c)})`.
 * @param {Chip} chip
 * @param {string} [extra]
 */
export function chipClassName(chip, extra) {
  return ['chip', `chip--${chip.style}`, `fg-${slug(chip.fg)}`, `bg-${slug(chip.bg)}`, extra].filter(Boolean).join(' ');
}
