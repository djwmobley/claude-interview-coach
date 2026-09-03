// @ts-check
/**
 * Auto-apply run summary file (auto-apply PR B, GAP 2): the durable record bin/remind.js's daily digest
 * reads to render the Auto-apply report section, mirroring src/core/watchdog-state.js's own
 * defaultWatchdogStateFile/readWatchdogState pattern exactly -- a single, stable, overwritten-every-run
 * JSON file (never the dated `--json` file bin/auto-apply.js also optionally writes on request), read
 * with the same "any failure means no data, never a thrown error or a fabricated status" discipline.
 *
 * File location: <JOBSEARCH_LOG_DIR>/auto-apply-latest.json, alongside the dated auto-apply-YYYY-MM-DD.log
 * file -- already covered by the repo's existing `mcp/job-search/logs/` gitignore entry.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} logDir
 * @returns {string}
 */
export function defaultAutoApplySummaryFile(logDir) {
  return path.join(logDir, 'auto-apply-latest.json');
}

/**
 * Read the summary file. Returns null on ANY failure (missing file, unreadable, not valid JSON, not an
 * object) -- src/core/report.js's collectAutoApply() renders that as the "no auto-apply run recorded
 * today" empty state, never a thrown error and never a fabricated summary.
 * @param {string} file
 * @returns {import('./report.js').AutoApplySummary|null}
 */
export function readAutoApplySummary(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Write the summary file (bin/auto-apply.js calls this at the end of every run, dry run included, so the
 * digest always reflects the most recent attempt regardless of whether `--json` was also passed).
 * @param {string} file
 * @param {import('./report.js').AutoApplySummary} summary
 */
export function writeAutoApplySummary(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
}
