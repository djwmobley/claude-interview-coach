#!/usr/bin/env node
// @ts-check
/**
 * Standalone Google re-authorization CLI (spec A7), a thin wrapper over src/core/google-reauth.js's
 * reauthorizeGoogle(). Two callers:
 *
 *   - the unattended-scan policy (src/core/scan-run.js, spec A6) spawns this detached and fire-and-forget
 *     when Gmail's token is broken_* on a cli-triggered run, with a long --wait-ms (2 hours) so the
 *     operator has time to notice and click through the consent page whenever they get to a screen;
 *   - run by hand: `node bin/google-reauth.js [--wait-ms N] [--token-file path]`.
 *
 * Exit 0 on outcome 'reauthorized', 2 otherwise (never 1 -- this is a best-effort side process, not a
 * scan run; a non-zero-but-not-1 exit keeps it out of any "build failed" interpretation a caller might
 * apply to exit 1). The consent URL is always printed to stdout as a fallback (spec A7) in case
 * the OS-level open fails or nobody is at a screen to see the popped tab. The URL is also written to
 * logs/google-reauth.consent.json (src/core/reauth-consent.js) for the dashboard; --no-launch skips the
 * OS-level open when the dashboard's own tab is the delivery channel.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../src/core/config.js';
import { reauthorizeGoogle, resolveRedirectUris } from '../src/core/google-reauth.js';
import crypto from 'node:crypto';
import { launchOsBrowserDiagnosed } from '../src/core/open-dashboard.js';
import { consentFileFor, deleteOwnConsentFile } from '../src/core/reauth-consent.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { waitMs: 600000, tokenFile: /** @type {string|undefined} */ (undefined), help: false, noLaunch: false, nonce: /** @type {string|undefined} */ (undefined) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--wait-ms') out.waitMs = Number(next());
    else if (a === '--token-file') out.tokenFile = String(next());
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--nonce') out.nonce = String(next());
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * The openUrl handed to reauthorizeGoogle (2026-10-04 consent-link fix). The URL always goes to stdout
 * first (spec A7 fallback; the dashboard spawn redirects stdout to logs/google-reauth-helper.out.log).
 * --no-launch (dashboard-initiated runs, where the operator's own click already opened a tab that the
 * dashboard navigates to the consent URL) skips the OS-level launch entirely. Otherwise the launch is
 * attempted best-effort and its exit code and stderr are logged, so a launch that "succeeds" at the
 * spawn level but never shows a tab leaves evidence behind.
 * @param {{
 *   noLaunch: boolean,
 *   write: (s: string) => void,
 *   log: (f: Record<string, string|number|boolean|null>) => void,
 *   launch: (url: string) => Promise<{ spawned: boolean, exitCode: number|null, signal: string|null, stderr: string, error: string|null, timedOut: boolean }>,
 * }} o
 */
export function makeOpenUrl(o) {
  return async (/** @type {string} */ url) => {
    o.write(url);
    if (o.noLaunch) {
      o.log({ evt: 'google_reauth_launch_skipped', reason: 'no_launch_flag' });
      return;
    }
    try {
      const r = await o.launch(url);
      o.log({
        evt: 'google_reauth_launch_result',
        spawned: r.spawned,
        exit_code: r.exitCode,
        signal: r.signal,
        timed_out: r.timedOut,
        error: r.error,
        stderr: r.stderr ? r.stderr.replace(/\s+/g, ' ').trim().slice(0, 280) : null,
      });
    } catch (err) {
      o.log({ evt: 'open_url_failed', err_message: String(err instanceof Error ? err.message : err).slice(0, 200) });
    }
  };
}

const USAGE = 'usage: node bin/google-reauth.js [--wait-ms N] [--token-file path] [--no-launch] [--nonce hex]';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const env = getEnv();
  const tokenFile = args.tokenFile || env.GOOGLE_TOKEN_FILE;
  if (!tokenFile) {
    console.log(JSON.stringify({ ok: false, outcome: 'failed', reason: 'no token file: pass --token-file or set GOOGLE_TOKEN_FILE' }));
    process.exit(2);
  }

  pruneLogs(env.JOBSEARCH_LOG_DIR, 'google-reauth', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'google-reauth'), name: 'google-reauth' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);

  const controller = new AbortController();
  const onSignal = (/** @type {string} */ sig) => {
    log({ evt: 'signal', signal: sig });
    controller.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // Per-run nonce: the dashboard passes its own (so it can match the lock it just caused); any other
  // caller gets a fresh one. reauthorizeGoogle validates the format and substitutes its own if invalid.
  const nonce = args.nonce && /^[A-Za-z0-9_-]{16,128}$/.test(args.nonce) ? args.nonce : crypto.randomBytes(16).toString('hex');
  // Belt and braces for the consent file: reauthorizeGoogle deletes its own on every exit path it sees,
  // but process.exit() below can cut a timeout's grace window short; this removes it only if it is ours.
  process.on('exit', () => deleteOwnConsentFile(consentFileFor(), nonce));

  const result = await reauthorizeGoogle({
    tokenFile,
    redirectUris: resolveRedirectUris(process.env.GOOGLE_OAUTH_REDIRECT_URIS),
    timeoutMs: Number.isFinite(args.waitMs) && args.waitMs > 0 ? args.waitMs : 600000,
    signal: controller.signal,
    log,
    nonce,
    openUrl: makeOpenUrl({
      noLaunch: args.noLaunch,
      write: (s) => console.log(s),
      log,
      launch: (url) => launchOsBrowserDiagnosed({ url, spawnImpl: spawn, platform: process.platform }),
    }),
  });

  log({ evt: 'google_reauth_finished', outcome: result.outcome, reason: result.reason });
  console.log(JSON.stringify({ ok: result.outcome === 'reauthorized', ...result }));
  process.exit(result.outcome === 'reauthorized' ? 0 : 2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
