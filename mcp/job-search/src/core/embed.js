// @ts-check
/**
 * Embeddings via Ollama's OpenAI-compatible endpoint (spec section 7).
 *
 * Parity with tools/ic_memory.py:
 *   endpoint  POST ${OLLAMA_URL}/v1/embeddings  {model, input: [texts]}
 *   text      `${title} at ${company}. ${notes ?? ''}`
 *   dims      1024, every component finite
 *   literal   `[a,b,...]` cast with ::vector by the caller
 *
 * Ollama down or a malformed response never throws out of `embedSafe`; it
 * returns nulls so the scan continues and reports `unembedded`.
 */
import { getEnv } from './config.js';
import { JobSearchError } from './errors.js';

export const VECTOR_DIM = 1024;
export const BATCH_SIZE = 32;

/**
 * Exactly the Python formula: f"{title} at {company}. {notes or ''}".
 * Python's `notes or ''` treats '' and None the same; so does `?? ''` plus the falsy check.
 * @param {{ title: string, company: string, notes?: string|null }} row
 */
export function embeddingText(row) {
  const notes = row.notes ? String(row.notes) : '';
  return `${row.title} at ${row.company}. ${notes}`;
}

/**
 * pgvector literal. Uses JS number formatting, same as Python's str(float)
 * for finite values (both shortest round-trip repr).
 * @param {number[]} vec
 */
export function toVectorLiteral(vec) {
  return '[' + vec.join(',') + ']';
}

/**
 * @param {unknown} vec
 * @returns {vec is number[]}
 */
export function isValidVector(vec) {
  return Array.isArray(vec) && vec.length === VECTOR_DIM && vec.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * @typedef {Object} EmbedOptions
 * @property {string} [ollamaUrl]
 * @property {string} [model]
 * @property {typeof fetch} [fetch] injectable for tests
 * @property {number} [timeoutMs] default 60000
 */

/**
 * Embed up to BATCH_SIZE texts in one request. Throws JobSearchError
 * EMBED_UNAVAILABLE (network/HTTP) or EMBED_INVALID (bad dims/values).
 * @param {string[]} texts
 * @param {EmbedOptions} [opts]
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, opts = {}) {
  if (texts.length === 0) return [];
  if (texts.length > BATCH_SIZE) throw new JobSearchError('VALIDATION', `embedBatch accepts at most ${BATCH_SIZE} texts`);
  const env = getEnv();
  const url = `${(opts.ollamaUrl ?? env.OLLAMA_URL).replace(/\/+$/, '')}/v1/embeddings`;
  const model = opts.model ?? env.OLLAMA_MODEL;
  const f = opts.fetch ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60000);
  /** @type {Response} */
  let res;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new JobSearchError('EMBED_UNAVAILABLE', `Ollama unreachable at ${url}`, { details: { model } });
  }
  clearTimeout(timer);
  if (!res.ok) throw new JobSearchError('EMBED_UNAVAILABLE', `Ollama HTTP ${res.status}`, { details: { model, http_status: res.status } });
  /** @type {{ data?: Array<{ index: number, embedding: unknown }> }} */
  let body;
  try {
    body = await res.json();
  } catch {
    throw new JobSearchError('EMBED_INVALID', 'Ollama returned non-JSON body', { details: { model } });
  }
  if (!body || !Array.isArray(body.data) || body.data.length !== texts.length) {
    throw new JobSearchError('EMBED_INVALID', 'Ollama returned wrong number of embeddings', { details: { model, expected: texts.length, got: body?.data?.length ?? 0 } });
  }
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  const out = sorted.map((d) => d.embedding);
  for (let i = 0; i < out.length; i++) {
    if (!isValidVector(out[i])) throw new JobSearchError('EMBED_INVALID', `embedding ${i} is not a finite ${VECTOR_DIM}-vector`, { details: { model, index: i } });
  }
  return /** @type {number[][]} */ (out);
}

/**
 * Embed any number of texts in batches of BATCH_SIZE. Throws on the first failing batch.
 * @param {string[]} texts
 * @param {EmbedOptions} [opts]
 */
export async function embedTexts(texts, opts = {}) {
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const vecs = await embedBatch(chunk, opts);
    out.push(...vecs);
  }
  return out;
}

/**
 * Non-throwing variant for the scan loop: returns a vector literal per text
 * or null for every text when Ollama is down/invalid, plus a warning.
 * @param {string[]} texts
 * @param {EmbedOptions} [opts]
 * @returns {Promise<{ literals: Array<string|null>, unembedded: number, warning: string|null }>}
 */
export async function embedSafe(texts, opts = {}) {
  try {
    const vecs = await embedTexts(texts, opts);
    return { literals: vecs.map(toVectorLiteral), unembedded: 0, warning: null };
  } catch (err) {
    const code = err instanceof JobSearchError ? err.code : 'EMBED_UNAVAILABLE';
    return { literals: texts.map(() => null), unembedded: texts.length, warning: `${code}: embeddings skipped for ${texts.length} rows` };
  }
}
