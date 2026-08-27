// @ts-check
/**
 * Re-embed helper (dashboard PR 2: factored out of src/tools/mark_jobs.js's inline re-embed block, per
 * plan, so the dashboard's status/notes routes reuse the identical Ollama call shape instead of a second
 * copy). Best effort: an Ollama outage leaves the old vector in place and is surfaced as a warning, never
 * a thrown error -- a status/notes write already committed by the time this runs.
 */
import { embedSafe, embeddingText } from './embed.js';

/**
 * @param {{ withClient: <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>, env: { OLLAMA_URL: string, OLLAMA_MODEL: string }, fetch?: typeof fetch }} deps
 * @param {number[]} ids
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function reembedRows(deps, ids) {
  if (!ids || ids.length === 0) return { warnings: [] };
  const rows = await deps.withClient((c) => c.query('SELECT id, title, company, notes FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]));
  const texts = rows.rows.map((r) => embeddingText(r));
  const e = await embedSafe(texts, { ollamaUrl: deps.env.OLLAMA_URL, model: deps.env.OLLAMA_MODEL, fetch: deps.fetch });
  await deps.withClient(async (c) => {
    for (let i = 0; i < rows.rows.length; i++) {
      if (e.literals[i]) await c.query('UPDATE ic_job_listings SET embedding = $2::vector WHERE id = $1', [rows.rows[i].id, e.literals[i]]);
    }
  });
  return { warnings: e.unembedded ? [`${e.unembedded} row(s) not re-embedded (embedding service unavailable)`] : [] };
}
