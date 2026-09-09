// @ts-check
/**
 * In-run Google re-authorization (2026-09-09: an invalid_grant grant on a Testing-mode OAuth app kept
 * killing Gmail scanning silently). This module pops a real Google consent screen, waits for the
 * callback on a local loopback HTTP server, exchanges the code, and merges the result back into the
 * workspace-mcp token file (src/core/google.js's readTokenFile format: token, refresh_token, token_uri,
 * client_id, client_secret, scopes[], expiry as a naive UTC string).
 *
 * reauthorizeGoogle() NEVER throws to its caller -- every failure mode is a branch of the total
 * classification below, returned as `{ outcome, reason }`:
 *
 *   reauthorized     token file updated; the caller can reconnect and proceed
 *   timeout          no consent arrived within timeoutMs (the socket stays bound for a further grace
 *                     window serving a "link expired" page to a late arrival, then closes)
 *   aborted          opts.signal fired
 *   port_unavailable none of the configured redirect URI ports were free on 127.0.0.1
 *   lock_held        another live process already holds logs/google-reauth.lock
 *   state_mismatch   the callback's state param did not match the one this run generated
 *   exchange_failed  Google returned an error/no code, or the code exchange itself failed
 *   no_client_creds  the token file has no usable (string) client_id/client_secret
 *   write_failed     the exchange succeeded but the merged token could not be written back
 *   failed           anything else unexpected (caught, never rethrown)
 *
 * Everything that talks to the network, the filesystem clock, or spawns a browser is either passed in
 * (signal, openUrl, log, now, lockFile) or goes through an injectable `deps` seam (deps.makeOAuthClient,
 * deps.exchangeCode) so tests never open a real browser, never contact Google, and never depend on wall
 * time longer than they choose to wait.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { packageRoot } from './config.js';
import { SCOPE_GMAIL_READONLY } from './google.js';

/** Registered redirect URIs (the Google MCP client itself usually holds 8000; this reauth flow only
 * needs ONE of these five free at any given moment -- it never invents a port outside this set. */
export const DEFAULT_REDIRECT_URIS = Object.freeze([
  'http://localhost:8000/oauth2callback',
  'http://localhost:8001/oauth2callback',
  'http://localhost:8002/oauth2callback',
  'http://localhost:8003/oauth2callback',
  'http://localhost:8004/oauth2callback',
]);

/** Total classification of reauthorizeGoogle's return value (spec A1). */
export const REAUTH_OUTCOMES = Object.freeze([
  'reauthorized', 'timeout', 'aborted', 'port_unavailable', 'lock_held',
  'state_mismatch', 'exchange_failed', 'no_client_creds', 'write_failed', 'failed',
]);

/** How long the bound socket stays alive after timeoutMs to serve a plain "link expired" page (spec A3). */
export const EXPIRED_GRACE_MS = 30000;

const SUCCESS_HTML = '<!doctype html><html><head><title>Google re-authorization</title></head><body><p>Google re-authorization complete. You can close this tab.</p></body></html>';
const STATE_MISMATCH_HTML = '<!doctype html><html><head><title>Google re-authorization</title></head><body><p>This request could not be verified. Close this tab and try again.</p></body></html>';
const EXCHANGE_FAILED_HTML = '<!doctype html><html><head><title>Google re-authorization</title></head><body><p>Something went wrong completing Google re-authorization. Close this tab and try again.</p></body></html>';
const WRITE_FAILED_HTML = '<!doctype html><html><head><title>Google re-authorization</title></head><body><p>Google re-authorization succeeded but the token file could not be updated. Close this tab and check the logs.</p></body></html>';
const EXPIRED_HTML = '<!doctype html><html><head><title>Google re-authorization</title></head><body><p>This link has expired. Close this tab and re-run the reauthorization.</p></body></html>';

/**
 * Comma-separated GOOGLE_OAUTH_REDIRECT_URIS env value -> array, falling back to the five registered
 * defaults when unset/blank.
 * @param {string|undefined|null} envVal
 * @returns {string[]}
 */
export function resolveRedirectUris(envVal) {
  if (typeof envVal === 'string' && envVal.trim()) {
    const uris = envVal.split(',').map((s) => s.trim()).filter(Boolean);
    if (uris.length) return uris;
  }
  return [...DEFAULT_REDIRECT_URIS];
}

/**
 * login_hint (spec A3): the token filename IS the account email (see .env.example's
 * GOOGLE_TOKEN_FILE=...\<your-google-email>.json convention) -- used only when it actually looks like
 * one; never guessed otherwise.
 * @param {string} tokenFile
 * @returns {string|undefined}
 */
export function loginHintFromFilename(tokenFile) {
  try {
    const base = path.basename(tokenFile).replace(/\.json$/i, '');
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(base) ? base : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} text */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {string} text @returns {any} */
function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Naive UTC "YYYY-MM-DDTHH:MM:SS" (no offset, no "Z"), matching the Python writer's own expiry format
 * (google.js's expiryMs() reads it back by appending "Z" when no zone is present).
 * @param {number|null|undefined} epochMs
 * @returns {string|null}
 */
export function naiveUtcExpiry(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const d = new Date(/** @type {number} */ (epochMs));
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Merge a fresh token exchange into the existing token-file JSON (spec A4): preserves every unknown
 * key, unions scopes (old file scopes + the granted token's scope string + the scopes this run
 * requested), keeps the OLD refresh_token when Google omits one (a re-consent without prompt=consent's
 * forced grant sometimes does), and writes the field names the base file already used (`scopes` array
 * vs a legacy `scope` string; `token` vs `access_token`) so round-tripping never changes the file's own
 * shape for a field this run did not need to touch.
 * @param {any} base parsed existing JSON (or {} if unreadable/missing)
 * @param {{ access_token?: string|null, refresh_token?: string|null, scope?: string|null, expiry_date?: number|null }} tokens google-auth-library's Credentials
 * @param {string[]} requestScopes the scopes this run's consent URL asked for
 * @returns {any}
 */
export function mergeToken(base, tokens, requestScopes) {
  const b = base && typeof base === 'object' ? base : {};
  const oldScopes = Array.isArray(b.scopes) ? b.scopes.map(String) : (typeof b.scope === 'string' ? b.scope.split(/\s+/).filter(Boolean) : []);
  const tokenScopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  const unionScopes = Array.from(new Set([...oldScopes, ...tokenScopes, ...(requestScopes ?? [])]));
  const merged = { ...b };
  if (Object.prototype.hasOwnProperty.call(b, 'scope') && !Object.prototype.hasOwnProperty.call(b, 'scopes')) {
    merged.scope = unionScopes.join(' ');
  } else {
    merged.scopes = unionScopes;
  }
  merged.refresh_token = tokens.refresh_token || b.refresh_token || null;
  if (Object.prototype.hasOwnProperty.call(b, 'access_token') && !Object.prototype.hasOwnProperty.call(b, 'token')) {
    merged.access_token = tokens.access_token || b.access_token || null;
  } else {
    merged.token = tokens.access_token || b.token || b.access_token || null;
  }
  const newExpiry = naiveUtcExpiry(/** @type {any} */ (tokens).expiry_date ?? null);
  merged.expiry = newExpiry ?? b.expiry ?? null;
  return merged;
}

/**
 * Read the token file fresh right before writing, compare its content hash against the one taken at
 * the start of this reauth attempt, and re-merge against whatever is actually on disk NOW (spec A4:
 * "if different re-read and re-merge") before an atomic rename. Throws on any failure; the caller maps
 * that to outcome write_failed.
 * @param {string} tokenFile
 * @param {any} startTokens
 * @param {string[]} requestScopes
 * @param {string} startHash
 * @param {any} startBase
 */
export function writeMergedToken(tokenFile, startTokens, requestScopes, startHash, startBase) {
  let latestText;
  try {
    latestText = fs.readFileSync(tokenFile, 'utf8');
  } catch (err) {
    throw new Error(`token file not readable at write time: ${err instanceof Error ? err.message : String(err)}`);
  }
  const latestHash = sha256(latestText);
  const base = latestHash === startHash ? startBase : (parseJsonSafe(latestText) ?? startBase);
  const merged = mergeToken(base, startTokens, requestScopes);
  const dir = path.dirname(tokenFile);
  const tmp = path.join(dir, `${path.basename(tokenFile)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, tokenFile);
}

/** @param {number} pid */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it -- still alive.
    return Boolean(err) && /** @type {any} */ (err).code === 'EPERM';
  }
}

/**
 * @param {string} lockFile
 * @param {Date} nowDate
 * @returns {{ ok: boolean }}
 */
function acquireLock(lockFile, nowDate) {
  try {
    const cur = parseJsonSafe(fs.readFileSync(lockFile, 'utf8'));
    if (cur && isPidAlive(Number(cur.pid))) return { ok: false };
  } catch {
    /* missing or unreadable -> nothing alive to contend with */
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: nowDate.toISOString() }));
  return { ok: true };
}

/**
 * @param {string} lockFile
 */
function releaseOwnLock(lockFile) {
  try {
    const cur = parseJsonSafe(fs.readFileSync(lockFile, 'utf8'));
    if (cur && Number(cur.pid) === process.pid) fs.unlinkSync(lockFile);
  } catch {
    /* already gone, or never ours */
  }
}

/**
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
function bindServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    const onError = (/** @type {unknown} */ err) => {
      srv.removeAllListeners();
      reject(err);
    };
    srv.once('error', onError);
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', onError);
      resolve(srv);
    });
  });
}

/**
 * @param {{
 *   tokenFile: string,
 *   extraScopes?: string[],
 *   redirectUris?: string[],
 *   timeoutMs?: number,
 *   signal: AbortSignal,
 *   openUrl?: (url: string) => (void|Promise<void>),
 *   log?: (fields: Record<string, string|number|boolean|null>) => void,
 *   now?: Date,
 *   lockFile?: string,
 *   deps?: {
 *     makeOAuthClient?: (clientId: string, clientSecret: string, redirectUri: string) => any,
 *     exchangeCode?: (client: any, code: string, redirectUri: string) => Promise<any>,
 *   },
 * }} opts
 * @returns {Promise<{ outcome: string, reason: string|null }>}
 */
export async function reauthorizeGoogle(opts) {
  const o = opts || /** @type {any} */ ({});
  const tokenFile = o.tokenFile;
  const extraScopes = Array.isArray(o.extraScopes) ? o.extraScopes : [];
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 600000;
  const signal = o.signal;
  const openUrl = typeof o.openUrl === 'function' ? o.openUrl : null;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const nowDate = o.now instanceof Date ? o.now : new Date();
  const lockFile = o.lockFile || path.join(packageRoot(), 'logs', 'google-reauth.lock');
  const uris = Array.isArray(o.redirectUris) && o.redirectUris.length ? o.redirectUris : resolveRedirectUris(process.env.GOOGLE_OAUTH_REDIRECT_URIS);
  const deps = o.deps || {};
  const makeOAuthClient = deps.makeOAuthClient || ((/** @type {string} */ clientId, /** @type {string} */ clientSecret, /** @type {string} */ redirectUri) => new OAuth2Client({ clientId, clientSecret, redirectUri }));
  const exchangeCode = deps.exchangeCode || (async (/** @type {any} */ client, /** @type {string} */ code, /** @type {string} */ redirectUri) => {
    const r = await client.getToken({ code, redirect_uri: redirectUri });
    return r.tokens;
  });

  if (!signal || typeof signal.addEventListener !== 'function') {
    return { outcome: 'failed', reason: 'signal (AbortSignal) is required' };
  }
  if (signal.aborted) {
    return { outcome: 'aborted', reason: 'signal was already aborted' };
  }

  let startText = '';
  let startBase = {};
  try {
    startText = fs.readFileSync(tokenFile, 'utf8');
    startBase = parseJsonSafe(startText) ?? {};
  } catch {
    startBase = {};
  }
  const clientId = startBase && typeof (/** @type {any} */ (startBase).client_id) === 'string' ? /** @type {any} */ (startBase).client_id : null;
  const clientSecret = startBase && typeof (/** @type {any} */ (startBase).client_secret) === 'string' ? /** @type {any} */ (startBase).client_secret : null;
  if (!clientId || !clientSecret) {
    return { outcome: 'no_client_creds', reason: 'token file lacks a string client_id/client_secret' };
  }
  const startHash = sha256(startText);

  let server = /** @type {import('node:http').Server|null} */ (null);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      server && server.close();
    } catch {
      /* already closed */
    }
    releaseOwnLock(lockFile);
  };

  try {
    const lock = acquireLock(lockFile, nowDate);
    if (!lock.ok) return { outcome: 'lock_held', reason: 'another google-reauth process holds logs/google-reauth.lock' };

    if (signal.aborted) {
      cleanup();
      return { outcome: 'aborted', reason: 'aborted before a port could be bound' };
    }

    let chosenUri = /** @type {string|null} */ (null);
    for (const uri of uris) {
      let port;
      try {
        port = Number(new URL(uri).port) || 80;
      } catch {
        continue;
      }
      try {
        server = await bindServer(port);
        chosenUri = uri;
        break;
      } catch {
        continue;
      }
    }
    if (!server || !chosenUri) {
      cleanup();
      return { outcome: 'port_unavailable', reason: `none of ${uris.length} configured redirect URI port(s) are free on 127.0.0.1` };
    }
    // Best-effort: record the actual bound port on the lock file (never fatal if this fails).
    try {
      const cur = parseJsonSafe(fs.readFileSync(lockFile, 'utf8'));
      if (cur && Number(cur.pid) === process.pid) fs.writeFileSync(lockFile, JSON.stringify({ ...cur, port: Number(new URL(chosenUri).port) }));
    } catch {
      /* non-fatal */
    }

    const boundPath = new URL(chosenUri).pathname;
    const state = crypto.randomBytes(32).toString('hex');
    const loginHint = loginHintFromFilename(tokenFile);
    const oldScopes = Array.isArray(/** @type {any} */ (startBase).scopes) ? /** @type {any} */ (startBase).scopes.map(String) : (typeof (/** @type {any} */ (startBase).scope) === 'string' ? /** @type {any} */ (startBase).scope.split(/\s+/).filter(Boolean) : []);
    const requestScopes = Array.from(new Set([...oldScopes, SCOPE_GMAIL_READONLY, ...extraScopes]));
    const client = makeOAuthClient(clientId, clientSecret, chosenUri);
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: requestScopes,
      state,
      redirect_uri: chosenUri,
      ...(loginHint ? { login_hint: loginHint } : {}),
    });

    log({ evt: 'google_reauth_consent_url', url: authUrl, port: Number(new URL(chosenUri).port) });

    let expired = false;
    /** @type {{ done: boolean }} */
    const handledRef = { done: false };

    const result = await new Promise((resolve) => {
      let settled = false;
      /** @type {NodeJS.Timeout} */
      let mainTimer;

      /** @param {{ outcome: string, reason: string|null }} outcomeObj @param {{ deferCleanup?: boolean }} [flags] */
      const finish = (outcomeObj, flags = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(mainTimer);
        signal.removeEventListener('abort', onAbort);
        if (flags.deferCleanup) {
          // The caller already has its answer ('timeout') by the time this fires; the extra 30s the
          // socket stays bound (spec A3) is a courtesy to a straggling browser tab, never something
          // worth keeping THIS process alive on its own -- unref both the server and the grace timer so
          // a caller with nothing else pending (a test process, a short-lived CLI) can still exit.
          server.unref();
          const graceTimer = setTimeout(cleanup, EXPIRED_GRACE_MS);
          graceTimer.unref?.();
        } else {
          cleanup();
        }
        resolve(outcomeObj);
      };

      const onAbort = () => {
        expired = true;
        finish({ outcome: 'aborted', reason: 'run aborted' });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // The 'request' listener and the timeout timer are attached BEFORE openUrl is ever invoked (even
      // though openUrl is awaited below): a test double (or a real browser navigating instantly) that
      // hits the callback the moment the tab opens must never race an as-yet-unattached listener --
      // Node drops an 'emit' with zero listeners rather than queuing it, so a request arriving before
      // this point would hang the caller forever waiting for a response nothing ever sends.
      server.on('request', (req, res) => {
        (async () => {
          let url;
          try {
            url = new URL(/** @type {string} */ (req.url), `http://127.0.0.1:${Number(new URL(chosenUri).port)}`);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (url.pathname !== boundPath) {
            res.writeHead(404).end();
            return;
          }
          if (expired) {
            res.writeHead(200, { 'content-type': 'text/html' }).end(EXPIRED_HTML);
            return;
          }
          if (handledRef.done) {
            res.writeHead(200, { 'content-type': 'text/html' }).end(EXPIRED_HTML);
            return;
          }
          handledRef.done = true;

          const respState = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          const errorParam = url.searchParams.get('error');

          if (respState !== state) {
            res.writeHead(400, { 'content-type': 'text/html' }).end(STATE_MISMATCH_HTML);
            finish({ outcome: 'state_mismatch', reason: 'callback state did not match the consent request' });
            return;
          }
          if (errorParam || !code) {
            res.writeHead(200, { 'content-type': 'text/html' }).end(EXCHANGE_FAILED_HTML);
            finish({ outcome: 'exchange_failed', reason: errorParam ? `google returned error=${errorParam}` : 'no authorization code in callback' });
            return;
          }

          let tokens;
          try {
            tokens = await exchangeCode(client, code, chosenUri);
          } catch (err) {
            res.writeHead(200, { 'content-type': 'text/html' }).end(EXCHANGE_FAILED_HTML);
            finish({ outcome: 'exchange_failed', reason: String(err instanceof Error ? err.message : err).slice(0, 200) });
            return;
          }

          try {
            writeMergedToken(tokenFile, tokens, requestScopes, startHash, startBase);
          } catch (err) {
            res.writeHead(200, { 'content-type': 'text/html' }).end(WRITE_FAILED_HTML);
            finish({ outcome: 'write_failed', reason: String(err instanceof Error ? err.message : err).slice(0, 200) });
            return;
          }

          res.writeHead(200, { 'content-type': 'text/html' }).end(SUCCESS_HTML);
          finish({ outcome: 'reauthorized', reason: null });
        })().catch((err) => {
          try {
            res.writeHead(500).end();
          } catch {
            /* response already sent */
          }
          finish({ outcome: 'failed', reason: String(err instanceof Error ? err.message : err).slice(0, 200) });
        });
      });

      mainTimer = setTimeout(() => {
        expired = true;
        finish({ outcome: 'timeout', reason: `no consent received within ${timeoutMs}ms` }, { deferCleanup: true });
      }, Math.max(0, timeoutMs));

      // Only now (listener + timer already attached) is it safe to hand the consent URL to openUrl --
      // deliberately NOT awaited here so a synchronous or fast test double can complete its own callback
      // hit without this executor function itself blocking (a Promise executor cannot usefully be
      // awaited by its caller anyway; errors are caught and logged, never left unhandled).
      if (openUrl) {
        Promise.resolve(openUrl(authUrl)).catch((err) => {
          log({ evt: 'google_reauth_open_url_failed', err_message: String(err instanceof Error ? err.message : err).slice(0, 200) });
        });
      }
    });

    return result;
  } catch (err) {
    cleanup();
    return { outcome: 'failed', reason: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}
