// @ts-check
/**
 * render_doc (spec 12a): preflight checks plus DOCX rendering through the
 * existing Python converters.
 *
 * Preflight is a TOTAL classification: every check returns exactly one of
 * pass | fail | not-applicable, with line numbers on fail. Any fail blocks
 * rendering unless checkOnly. The checks are lexical; they cannot judge
 * tone, revenue framing, or truth (those stay with the model).
 *
 * Rendering runs the converter via child_process.execFile with file-path
 * arguments only (never inline payloads), writes to the per-kind output
 * directory, refuses to overwrite a DOCX that is open in Word (LOCKED), and
 * never opens the result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot, packageRoot } from './config.js';
import { JobSearchError } from './errors.js';

const execFileP = promisify(execFile);

export const KINDS = Object.freeze(['resume', 'cover_letter', 'cheatsheet']);

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

/** @type {Record<string, { script: string, outDir: string, ext: string[] }>} */
export const KIND_SPEC = Object.freeze({
  resume: { script: path.join('tools', 'md_to_docx.py'), outDir: path.join('output', 'resumes'), ext: ['.md'] },
  cover_letter: { script: path.join('tools', 'cover_letter_to_docx.py'), outDir: path.join('output', 'coverletters'), ext: ['.md', '.txt'] },
  cheatsheet: { script: path.join('tools', 'cheatsheet_to_docx.py'), outDir: path.join('output', 'cheatsheets'), ext: ['.md'] },
});

/**
 * @typedef {Object} CheckResult
 * @property {string} name
 * @property {'pass'|'fail'|'not-applicable'} result
 * @property {number[]} lines 1-based line numbers on fail
 * @property {string} [detail]
 */

/**
 * @typedef {Object} StyleConfig
 * @property {string[]} buzzwords
 * @property {string[]} problemComparisonPatterns
 * @property {string} pmpExact
 * @property {string} jenkonTitle
 * @property {string[]} jenkonForbidden
 */

/** @returns {StyleConfig} */
export function loadStyleConfig(file = path.join(packageRoot(), 'config', 'style-checks.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    buzzwords: Array.isArray(j.buzzwords) ? j.buzzwords.map(String) : [],
    problemComparisonPatterns: Array.isArray(j.problemComparisonPatterns) ? j.problemComparisonPatterns.map(String) : [],
    pmpExact: String(j.pmpExact ?? 'PMP (Expired 2017), Project Management Institute'),
    jenkonTitle: String(j.jenkonTitle ?? 'Director of Program Management'),
    jenkonForbidden: Array.isArray(j.jenkonForbidden) ? j.jenkonForbidden.map(String) : [],
  };
}

/**
 * Company names from data/project-index.md (`**Client:** X` lines).
 * @param {string} [file]
 * @returns {string[]|null} null when the index is unreadable
 */
export function readProjectIndexCompanies(file = path.join(repoRoot(), 'data', 'project-index.md')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const m of text.matchAll(/^\s*-\s*\*\*Client:\*\*\s*(.+?)\s*$/gm)) out.push(m[1].trim());
  return out;
}

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r?\n/);
}

/**
 * Lines matching a predicate, 1-based.
 * @param {string[]} lines
 * @param {(line: string, idx: number) => boolean} pred
 */
function where(lines, pred) {
  const out = [];
  lines.forEach((l, i) => {
    if (pred(l, i)) out.push(i + 1);
  });
  return out;
}

const YEAR_RANGE = /\d{4}\s*\u2013\s*(\d{4}|[Pp]resent)/;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** @param {string[]} lines @returns {CheckResult} */
export function checkEmDash(lines) {
  const hits = where(lines, (l) => l.includes(EM_DASH));
  return { name: 'em_dash', result: hits.length ? 'fail' : 'pass', lines: hits };
}

/**
 * En-dashes are allowed only inside `Year \u2013 Year` ranges. Every en-dash on a
 * line must belong to such a range; a line with one valid range and one stray
 * en-dash still fails.
 * @param {string[]} lines @returns {CheckResult}
 */
export function checkEnDash(lines) {
  const hits = where(lines, (l) => l.replace(new RegExp(YEAR_RANGE.source, 'g'), '').includes(EN_DASH));
  return { name: 'en_dash', result: hits.length ? 'fail' : 'pass', lines: hits, detail: hits.length ? 'en-dash allowed only in Year - Year ranges' : undefined };
}

const SCARE = /(^|[^\w])["“”]([A-Za-z][A-Za-z'\-]*)["“”](?=$|[^\w])/;

/** @param {string[]} lines @returns {CheckResult} */
export function checkScareQuotes(lines) {
  const hits = where(lines, (l) => SCARE.test(l));
  return { name: 'scare_quotes', result: hits.length ? 'fail' : 'pass', lines: hits, detail: hits.length ? 'single word wrapped in double quotes' : undefined };
}

/** @param {string[]} lines @param {string[]} words @returns {CheckResult} */
export function checkBuzzwords(lines, words) {
  if (words.length === 0) return { name: 'buzzwords', result: 'not-applicable', lines: [] };
  const re = new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const found = new Set();
  const hits = where(lines, (l) => {
    let any = false;
    for (const m of l.matchAll(re)) {
      found.add(m[1].toLowerCase());
      any = true;
    }
    return any;
  });
  return { name: 'buzzwords', result: hits.length ? 'fail' : 'pass', lines: hits, detail: hits.length ? [...found].join(', ') : undefined };
}

/** @param {string} text @param {string[]} lines @param {string[]} patterns @returns {CheckResult} */
export function checkProblemComparison(text, lines, patterns) {
  if (patterns.length === 0) return { name: 'problem_comparison', result: 'not-applicable', lines: [] };
  const flat = text.replace(/\r?\n/g, ' ');
  const hitLines = new Set();
  for (const p of patterns) {
    const re = new RegExp(p, 'gi');
    for (const m of flat.matchAll(re)) {
      // Map the match offset back to a line number.
      let pos = 0;
      for (let i = 0; i < lines.length; i++) {
        const end = pos + lines[i].length + 1;
        if (m.index !== undefined && m.index >= pos && m.index < end) {
          hitLines.add(i + 1);
          break;
        }
        pos = end;
      }
    }
  }
  const hits = [...hitLines].sort((a, b) => a - b);
  return { name: 'problem_comparison', result: hits.length ? 'fail' : 'pass', lines: hits };
}

/**
 * Split on `---` separator lines; returns blocks with their starting line index (0-based).
 * @param {string[]} lines
 */
export function splitBlocks(lines) {
  /** @type {Array<{ start: number, lines: string[] }>} */
  const blocks = [];
  let cur = { start: 0, lines: /** @type {string[]} */ ([]) };
  lines.forEach((l, i) => {
    if (/^---\s*$/.test(l)) {
      blocks.push(cur);
      cur = { start: i + 1, lines: [] };
    } else cur.lines.push(l);
  });
  blocks.push(cur);
  return blocks;
}

const COMPANY_LINE = /^[^|]+\|[^|]+\|\s*\d{4}\s*\u2013\s*(\d{4}|[Pp]resent)\s*$/;
/** A company-shaped line whose year range uses a hyphen, em-dash, or "to" instead of the en-dash md_to_docx.py expects. */
const COMPANY_LINE_BAD_DASH = /^[^|]+\|[^|]+\|\s*\d{4}\s*(?:-|\u2014|to)\s*(\d{4}|[Pp]resent)\s*$/i;
/** Windows reserved device names cannot be file names. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Resume structure for md_to_docx.py (spec 12a).
 * @param {string[]} lines
 * @returns {CheckResult}
 */
export function checkResumeStructure(lines) {
  /** @type {number[]} */
  const hits = [];
  /** @type {string[]} */
  const problems = [];
  const blocks = splitBlocks(lines);
  if (blocks.length < 4) {
    return { name: 'resume_structure', result: 'fail', lines: [1], detail: `expected at least 4 blocks separated by ---, found ${blocks.length}` };
  }
  const header = blocks[0].lines.filter((l) => l.trim() !== '');
  if (header.length < 3) {
    hits.push(blocks[0].start + 1);
    problems.push('header block needs name, contact, and tagline lines');
  } else {
    if (header[0].trim().startsWith('#')) {
      hits.push(blocks[0].start + 1);
      problems.push('name line must not start with #');
    }
    if (!header[2].includes('|')) {
      hits.push(blocks[0].start + 3);
      problems.push('tagline line must use | separators');
    }
  }
  for (const bi of [1, 2]) {
    blocks[bi].lines.forEach((l, i) => {
      if (/^\s*#/.test(l)) {
        hits.push(blocks[bi].start + i + 1);
        problems.push(`block ${bi} must not contain a # heading (script injects it)`);
      }
    });
  }
  for (let bi = 3; bi < blocks.length; bi++) {
    const b = blocks[bi];
    b.lines.forEach((l, i) => {
      const n = b.start + i + 1;
      if (/^\s*#/.test(l)) {
        hits.push(n);
        problems.push('body uses ALL CAPS labels, not # headings');
      }
      if (/^\s*[-*]\s+/.test(l)) {
        hits.push(n);
        problems.push('bullets must use the middle dot, not - or *');
      }
      if (/^\s*\|/.test(l) || /\|\s*-{3,}\s*\|/.test(l)) {
        hits.push(n);
        problems.push('tables are not allowed');
      }
      if (COMPANY_LINE_BAD_DASH.test(l)) {
        hits.push(n);
        problems.push('company line year range must use the en-dash (Year \u2013 Year)');
      }
      if (COMPANY_LINE.test(l) || COMPANY_LINE_BAD_DASH.test(l)) {
        const parts = l.split('|').map((p) => p.trim());
        if (parts.length !== 3) {
          hits.push(n);
          problems.push('company line must be Company | City, ST | Year - Year');
        }
        const title = (b.lines[i - 1] ?? '').trim();
        if (!title) {
          hits.push(n);
          problems.push('company line must follow a role title line');
        } else if (title.includes(',')) {
          hits.push(b.start + i);
          problems.push('no commas in role titles');
        }
      }
    });
  }
  const uniq = [...new Set(hits)].sort((a, b) => a - b);
  return { name: 'resume_structure', result: uniq.length ? 'fail' : 'pass', lines: uniq, detail: uniq.length ? [...new Set(problems)].join('; ') : undefined };
}

/**
 * @param {string} text
 * @param {string[]|null} companies from project-index.md
 * @param {string[]} allowMissing
 * @returns {CheckResult}
 */
export function checkRoleInclusion(text, companies, allowMissing) {
  if (companies === null) return { name: 'role_inclusion', result: 'fail', lines: [], detail: 'data/project-index.md not readable' };
  if (companies.length === 0) return { name: 'role_inclusion', result: 'not-applicable', lines: [] };
  const lower = text.toLowerCase();
  const allow = new Set(allowMissing.map((s) => s.toLowerCase()));
  const missing = companies.filter((c) => !lower.includes(c.toLowerCase()) && !allow.has(c.toLowerCase()));
  return { name: 'role_inclusion', result: missing.length ? 'fail' : 'pass', lines: [], detail: missing.length ? `missing roles: ${missing.join(', ')}` : undefined };
}

/**
 * PMP wording. In a resume every PMP line must carry the exact expired
 * wording (a bare "PMP" implies an active certification, which it is not).
 * In cover letters and cheat sheets only a variant wording (Lapsed, or a
 * certification-style line that is not the exact form) fails.
 * @param {string[]} lines @param {string} exact @param {string} [kind] @returns {CheckResult}
 */
export function checkPmpWording(lines, exact, kind = 'resume') {
  const pmpLines = where(lines, (l) => /\bPMP\b/.test(l));
  if (pmpLines.length === 0) return { name: 'pmp_wording', result: 'not-applicable', lines: [] };
  const bad = pmpLines.filter((n) => {
    const l = lines[n - 1];
    if (l.includes(exact)) return false;
    if (kind === 'resume') return true;
    // Non-resume: a certification-style entry (line starts with PMP, or names the institute) or the Lapsed variant.
    return /lapsed/i.test(l) || /project management institute|\bpmi\b/i.test(l) || /^\s*[·*-]?\s*PMP\b/.test(l);
  });
  return { name: 'pmp_wording', result: bad.length ? 'fail' : 'pass', lines: bad, detail: bad.length ? `expected exactly: ${exact}` : undefined };
}

/**
 * @param {string[]} lines
 * @param {string} kind
 * @param {StyleConfig} cfg
 * @returns {CheckResult}
 */
export function checkJenkonTitle(lines, kind, cfg) {
  const jenkon = where(lines, (l) => /jenkon/i.test(l));
  if (jenkon.length === 0) return { name: 'jenkon_title', result: 'not-applicable', lines: [] };
  const bad = where(lines, (l) => cfg.jenkonForbidden.some((f) => l.includes(f)));
  if (bad.length) return { name: 'jenkon_title', result: 'fail', lines: bad, detail: `use ${cfg.jenkonTitle}` };
  if (kind === 'resume' && !lines.some((l) => l.includes(cfg.jenkonTitle))) {
    return { name: 'jenkon_title', result: 'fail', lines: jenkon, detail: `Jenkon role title must read ${cfg.jenkonTitle}` };
  }
  return { name: 'jenkon_title', result: 'pass', lines: [] };
}

const DATESTAMP = /(^|[^\d])(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}_\d{2}_\d{2})([^\d]|$)/;
const OUTNAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._&()'+-]{0,79}$/;

/**
 * @param {string} kind
 * @param {string|undefined} outName
 * @param {string} sourceBase
 * @returns {CheckResult & { name: 'output_name' }}
 */
export function checkOutputName(kind, outName, sourceBase) {
  const outward = kind === 'resume' || kind === 'cover_letter';
  if (outName === undefined || outName === '') {
    if (outward) return { name: 'output_name', result: 'fail', lines: [], detail: 'outName is required for resumes and cover letters (human name, e.g. Jordan Reyes - CTO)' };
    if (DATESTAMP.test(sourceBase) || OUTNAME_OK.test(sourceBase)) return { name: 'output_name', result: 'pass', lines: [], detail: sourceBase };
    return { name: 'output_name', result: 'fail', lines: [], detail: 'source basename is not a usable output name; pass outName' };
  }
  const n = String(outName).trim();
  if (n.toLowerCase().endsWith('.docx')) return { name: 'output_name', result: 'fail', lines: [], detail: 'outName must not include the .docx extension' };
  if (/[\\/:*?"<>|]/.test(n) || !OUTNAME_OK.test(n)) return { name: 'output_name', result: 'fail', lines: [], detail: 'outName contains characters not allowed in a file name' };
  if (RESERVED_NAME.test(n) || n.endsWith('.')) return { name: 'output_name', result: 'fail', lines: [], detail: 'outName is a reserved Windows device name or ends with a dot' };
  if (outward && DATESTAMP.test(n)) return { name: 'output_name', result: 'fail', lines: [], detail: 'datestamped slugs are refused for resumes and cover letters' };
  return { name: 'output_name', result: 'pass', lines: [], detail: n };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RenderRequest
 * @property {string} kind
 * @property {string} source repo-relative path
 * @property {string} [outName]
 * @property {boolean} [checkOnly]
 * @property {boolean} [force]
 * @property {string[]} [allowMissing]
 */

/**
 * Resolve and validate the source path inside the repo. Throws VALIDATION.
 * @param {string} source
 * @param {string} kind
 * @param {string} root
 */
export function resolveSource(source, kind, root) {
  if (!KINDS.includes(kind)) throw new JobSearchError('VALIDATION', `kind must be one of ${KINDS.join(', ')}`);
  const s = String(source ?? '').trim();
  if (!s) throw new JobSearchError('VALIDATION', 'source is required');
  if (path.isAbsolute(s)) throw new JobSearchError('VALIDATION', 'source must be repo-relative');
  const abs = path.resolve(root, s);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new JobSearchError('VALIDATION', 'source must stay inside the repo');
  const ext = path.extname(abs).toLowerCase();
  if (!KIND_SPEC[kind].ext.includes(ext)) throw new JobSearchError('VALIDATION', `source for ${kind} must be one of ${KIND_SPEC[kind].ext.join(', ')}`);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new JobSearchError('NOT_FOUND', `source not found: ${s}`);
  return abs;
}

/**
 * Run every preflight check. Total: each check returns pass/fail/not-applicable.
 * @param {RenderRequest} req
 * @param {{ root?: string, style?: StyleConfig, companies?: string[]|null }} [opts]
 * @returns {{ checks: CheckResult[], ok: boolean, sourceAbs: string, outName: string }}
 */
export function preflight(req, opts = {}) {
  const root = opts.root ?? repoRoot();
  const style = opts.style ?? loadStyleConfig();
  const sourceAbs = resolveSource(req.source, req.kind, root);
  const text = fs.readFileSync(sourceAbs, 'utf8');
  const lines = splitLines(text);
  const isResume = req.kind === 'resume';
  const na = (/** @type {string} */ name) => /** @type {CheckResult} */ ({ name, result: 'not-applicable', lines: [] });
  const companies = opts.companies !== undefined ? opts.companies : isResume ? readProjectIndexCompanies(path.join(root, 'data', 'project-index.md')) : null;
  const sourceBase = path.basename(sourceAbs, path.extname(sourceAbs));
  const nameCheck = checkOutputName(req.kind, req.outName, sourceBase);
  /** @type {CheckResult[]} */
  const checks = [
    checkEmDash(lines),
    checkEnDash(lines),
    checkScareQuotes(lines),
    checkBuzzwords(lines, style.buzzwords),
    checkProblemComparison(text, lines, style.problemComparisonPatterns),
    isResume ? checkResumeStructure(lines) : na('resume_structure'),
    isResume ? checkRoleInclusion(text, companies, req.allowMissing ?? []) : na('role_inclusion'),
    checkPmpWording(lines, style.pmpExact, req.kind),
    checkJenkonTitle(lines, req.kind, style),
    nameCheck,
  ];
  const ok = checks.every((c) => c.result !== 'fail');
  const outName = nameCheck.result === 'pass' ? (req.outName && req.outName.trim() ? req.outName.trim() : sourceBase) : '';
  return { checks, ok, sourceAbs, outName };
}

// ---------------------------------------------------------------------------
// Lock detection and rendering
// ---------------------------------------------------------------------------

/**
 * Is the DOCX open in Word? Word drops a `~$<name>.docx` owner file beside
 * the document and holds the file with a share lock; either signal counts.
 * Total: missing target -> not locked.
 * @param {string} target absolute .docx path
 * @returns {{ locked: boolean, reason: string }}
 */
export function detectLocked(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const owner = path.join(dir, '~$' + base.slice(Math.min(2, base.length)));
  const ownerAlt = path.join(dir, '~$' + base);
  if (fs.existsSync(owner) || fs.existsSync(ownerAlt)) return { locked: true, reason: 'word_owner_file' };
  if (!fs.existsSync(target)) return { locked: false, reason: 'no_target' };
  let fd = null;
  try {
    fd = fs.openSync(target, 'r+');
    return { locked: false, reason: 'writable' };
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err ?? {}).code ?? '';
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { locked: true, reason: `open_${code}` };
    return { locked: false, reason: `open_${code || 'error'}` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * @param {RenderRequest} req
 * @param {{ root?: string, python?: string, style?: StyleConfig, companies?: string[]|null, execFile?: typeof execFileP, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, code?: string, checks: CheckResult[], output_path?: string, bytes?: number, hint?: string, message?: string }>}
 */
export async function renderDoc(req, opts = {}) {
  const root = opts.root ?? repoRoot();
  const pf = preflight(req, { root, style: opts.style, companies: opts.companies });
  if (req.checkOnly) return { ok: pf.ok, checks: pf.checks };
  if (!pf.ok) {
    return { ok: false, code: 'PREFLIGHT_FAILED', checks: pf.checks, hint: 'fix the failing checks (or pass allowMissing for approved role omissions) and call again' };
  }
  const spec = KIND_SPEC[req.kind];
  const outDir = path.join(root, spec.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${pf.outName}.docx`);
  const lock = detectLocked(target);
  if (lock.locked) {
    return {
      ok: false,
      code: 'LOCKED',
      checks: pf.checks,
      output_path: path.relative(root, target),
      hint: 'the DOCX is open in Word; ask whether to close it (then call again) or to edit the document directly. Never regenerate over a hand-edited DOCX.',
    };
  }
  if (fs.existsSync(target) && !req.force) {
    return {
      ok: false,
      code: 'EXISTS',
      checks: pf.checks,
      output_path: path.relative(root, target),
      hint: 'target exists; pass force:true to overwrite (only if it has not been hand-edited)',
    };
  }
  const script = path.join(root, spec.script);
  if (!fs.existsSync(script)) throw new JobSearchError('NOT_FOUND', `converter missing: ${spec.script}`);
  const run = opts.execFile ?? execFileP;
  try {
    await run(opts.python ?? 'python', [script, pf.sourceAbs, target], { cwd: root, timeout: opts.timeoutMs ?? 120000, windowsHide: true, maxBuffer: 1 << 20 });
  } catch (err) {
    const e = /** @type {{ code?: unknown, stderr?: unknown, message?: unknown }} */ (err ?? {});
    const stderr = typeof e.stderr === 'string' ? e.stderr.slice(-300) : '';
    return { ok: false, code: 'RENDER_FAILED', checks: pf.checks, message: `${String(e.message ?? '').slice(0, 200)}${stderr ? ' | ' + stderr : ''}` };
  }
  if (!fs.existsSync(target)) return { ok: false, code: 'RENDER_FAILED', checks: pf.checks, message: 'converter exited without writing the target' };
  const bytes = fs.statSync(target).size;
  return { ok: true, checks: pf.checks, output_path: path.relative(root, target), bytes };
}
