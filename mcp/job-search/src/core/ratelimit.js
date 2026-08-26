// @ts-check
/**
 * Rate limiting (spec section 4): per-domain concurrency 1, jittered delays
 * from config, and exponential backoff on 429/503 up to maxDelayMs for
 * `retries` attempts, after which the adapter is aborted for the run.
 *
 * Pure scheduling logic: `sleep` and `random` are injectable so tests run
 * without waiting. Every wait honors an AbortSignal.
 */
import { JobSearchError } from './errors.js';

/** Base delay for the first backoff step (doubles each retry, capped by maxDelayMs). */
export const BACKOFF_BASE_MS = 5000;

/**
 * Abortable sleep.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new JobSearchError('CANCELLED', 'aborted before wait'));
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(t);
      reject(new JobSearchError('CANCELLED', 'aborted during wait'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Jittered delay in [min, max].
 * @param {[number, number]} range
 * @param {() => number} random
 */
export function jitter(range, random = Math.random) {
  const [min, max] = range;
  if (max <= min) return min;
  return Math.floor(min + random() * (max - min));
}

/**
 * Backoff delay for attempt n (0-based): base * 2^n capped, unless the
 * server sent a usable Retry-After (seconds), which wins when it is smaller
 * than the cap.
 * @param {number} attempt
 * @param {{ maxDelayMs: number, baseMs?: number }} cfg
 * @param {string|null} [retryAfter]
 */
export function backoffDelay(attempt, cfg, retryAfter = null) {
  const base = cfg.baseMs ?? BACKOFF_BASE_MS;
  let ms = Math.min(cfg.maxDelayMs, base * Math.pow(2, Math.max(0, attempt)));
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) ms = Math.min(cfg.maxDelayMs, Math.max(ms, secs * 1000));
  }
  return ms;
}

/**
 * True when an HTTP status calls for backoff (not abort).
 * @param {number|null|undefined} status
 */
export function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

/**
 * @typedef {Object} RateLimiterOptions
 * @property {[number, number]} delayMs jittered delay between requests on the same key
 * @property {{ maxDelayMs: number, retries: number, baseMs?: number }} backoff
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {() => number} [now]
 */

/**
 * @typedef {Object} RateLimiter
 * @property {(key: string, signal?: AbortSignal) => Promise<void>} wait serialize per key and enforce the jittered gap
 * @property {<T extends { status: number|null, retryAfter?: string|null }>(key: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal, onRetry?: (f: { attempt: number, delay_ms: number, status: number|null }) => void }) => Promise<T>} withRetry run fn under wait(); back off on 429/503; abort after retries
 * @property {() => { waits: number, retries: number, aborted: number }} stats
 */

/**
 * @param {RateLimiterOptions} opts
 * @returns {RateLimiter}
 */
export function makeRateLimiter(opts) {
  const doSleep = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  /** @type {Map<string, number>} */
  const lastAt = new Map();
  const stats = { waits: 0, retries: 0, aborted: 0 };

  /**
   * @param {string} key
   * @param {AbortSignal} [signal]
   */
  async function wait(key, signal) {
    const prev = chains.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const mine = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    chains.set(key, prev.then(() => mine));
    await prev;
    try {
      const last = lastAt.get(key);
      const gap = jitter(opts.delayMs, random);
      if (last !== undefined) {
        const due = last + gap;
        const remaining = due - now();
        if (remaining > 0) await doSleep(remaining, signal);
      }
      lastAt.set(key, now());
      stats.waits++;
    } finally {
      release();
    }
  }

  /**
   * @template {{ status: number|null, retryAfter?: string|null }} T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @param {{ signal?: AbortSignal, onRetry?: (f: { attempt: number, delay_ms: number, status: number|null }) => void }} [o]
   * @returns {Promise<T>}
   */
  async function withRetry(key, fn, o = {}) {
    const retries = opts.backoff.retries;
    for (let attempt = 0; ; attempt++) {
      await wait(key, o.signal);
      const res = await fn();
      if (!isRetryableStatus(res.status)) return res;
      if (attempt >= retries) {
        stats.aborted++;
        throw new JobSearchError('ADAPTER_ABORTED', `gave up after ${retries} retries on HTTP ${res.status}`, {
          details: { key, status: res.status, retries },
          hint: 'the source is rate limiting; it is aborted for this run',
        });
      }
      const delay = backoffDelay(attempt, opts.backoff, res.retryAfter ?? null);
      stats.retries++;
      if (o.onRetry) o.onRetry({ attempt, delay_ms: delay, status: res.status });
      await doSleep(delay, o.signal);
    }
  }

  return { wait, withRetry, stats: () => ({ ...stats }) };
}
