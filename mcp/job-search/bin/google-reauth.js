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
 * launchOsBrowser's OS-level open fails or nobody is at a screen to see the popped tab.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../src/core/config.js';
import { reauthorizeGoogle, resolveRedirectUris } from '../src/core/google-reauth.js';
import { launchOsBrowser } from '../src/core/open-dashboard.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { waitMs: 600000, tokenFile: /** @type {string|undefined} */ (undefined), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--wait-ms') out.waitMs = Number(next());
    else if (a === '--token-file') out.tokenFile = String(next());
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = 'usage: node bin/google-reauth.js [--wait-ms N] [--token-file path]';

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

  const result = await reauthorizeGoogle({
    tokenFile,
    redirectUris: resolveRedirectUris(process.env.GOOGLE_OAUTH_REDIRECT_URIS),
    timeoutMs: Number.isFinite(args.waitMs) && args.waitMs > 0 ? args.waitMs : 600000,
    signal: controller.signal,
    log,
    async openUrl(url) {
      // Fallback first (spec A7): the URL is always on stdout regardless of whether the OS-level open
      // below succeeds, since this process may be running detached with nobody watching for a popped tab.
      console.log(url);
      try {
        await launchOsBrowser({ dashboardUrl: url, spawnImpl: spawn, platform: process.platform });
      } catch (err) {
        log({ evt: 'open_url_failed', err_message: String(err instanceof Error ? err.message : err).slice(0, 200) });
      }
    },
  });

  log({ evt: 'google_reauth_finished', outcome: result.outcome, reason: result.reason });
  console.log(JSON.stringify({ ok: result.outcome === 'reauthorized', ...result }));
  process.exit(result.outcome === 'reauthorized' ? 0 : 2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
