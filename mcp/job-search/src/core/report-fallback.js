// @ts-check
/**
 * Non-Gmail report delivery (spec G). When the report cannot be emailed (Google auth broken, or the send
 * failed), bin/remind.js still writes output/reports/<day>.md and .html, and ALSO:
 *   - shows a Windows toast naming the problem and the report path, and
 *   - opens the HTML report in the default browser,
 * both done by scripts/report-fallback.ps1 through one plain `powershell -NoProfile -File <script> <payload>`
 * spawn (never an encoded command; the payload travels in a small JSON file, not on the command line). The exit
 * code of the remind run stays nonzero; the delivery path used is returned to the caller to record.
 *
 * The spawner is injectable. With the real child_process.spawn under the test runner the call throws
 * real_shell_blocked_in_tests BEFORE anything launches (src/core/test-guard.js; no opt-in), so a test that
 * forgets to inject cannot start powershell, a toast, or a browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { packageRoot } from './config.js';
import { assertRealShellAllowed } from './test-guard.js';
import { errFields } from './errors.js';

/** Toast text is short; the path is the part that matters. */
const TOAST_MESSAGE_MAX = 240;

/** @param {string|null} reportFile the .md path writeReportFile returned */
export function htmlSiblingOf(reportFile) {
  if (!reportFile) return null;
  const html = reportFile.replace(/\.md$/i, '.html');
  return html !== reportFile && fs.existsSync(html) ? html : null;
}

/**
 * @param {{ problem: string, reportFile: string|null }} o
 * @returns {{ title: string, message: string, html: string|null }}
 */
export function buildToastPayload(o) {
  const where = o.reportFile ? ` Report: ${o.reportFile}` : ' No report file was written.';
  return {
    title: 'Job scan report not emailed',
    message: `${o.problem}.${where}`.slice(0, TOAST_MESSAGE_MAX),
    html: htmlSiblingOf(o.reportFile),
  };
}

/**
 * @typedef {{ path: 'toast_browser'|'none', spawned: boolean, html_opened: boolean, error: string|null, reason: string|null }} FallbackResult
 */

/**
 * Total: never throws (a failure is a `path: 'none'` result with the error).
 * @param {{ problem: string, reportFile: string|null, spawnImpl?: typeof realSpawn, platform?: NodeJS.Platform, scriptPath?: string, tmpDir?: string, now?: Date }} o
 * @returns {Promise<FallbackResult>}
 */
export async function deliverFallback(o) {
  const spawnImpl = o.spawnImpl ?? realSpawn;
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return { path: 'none', spawned: false, html_opened: false, error: null, reason: 'not_windows' };
  try {
    if (spawnImpl === realSpawn) assertRealShellAllowed('show the report fallback toast and open the report');
    const payload = buildToastPayload(o);
    const stamp = (o.now ?? new Date()).getTime();
    const payloadPath = path.join(o.tmpDir ?? os.tmpdir(), `jobsearch-report-fallback-${stamp}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const script = o.scriptPath ?? path.join(packageRoot(), 'scripts', 'report-fallback.ps1');
    const child = spawnImpl('powershell', ['-NoProfile', '-File', script, payloadPath], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once?.('error', () => {});
    child.unref?.();
    return { path: 'toast_browser', spawned: true, html_opened: payload.html !== null, error: null, reason: null };
  } catch (err) {
    return { path: 'none', spawned: false, html_opened: false, error: errFields(err).err_message.slice(0, 200), reason: 'spawn_failed' };
  }
}
