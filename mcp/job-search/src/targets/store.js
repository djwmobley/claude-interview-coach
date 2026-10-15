// @ts-check
/**
 * Target finder signal persistence (plan 14.2 "Dedup key" and "Persistence", 15.2 items 6 and 10).
 *
 *   persistItems         upsert on url_hash = sha256("<source>|<stable key>"). A new item is inserted. A
 *                        re-seen item refreshes fetched_at; its excerpt / extracted / signal / contact are
 *                        rewritten ONLY when parser_version or the content hash changed. id and target_id
 *                        are never changed. A superseded_by marker set by a newer amendment survives a
 *                        rewrite. An item that supersedes an earlier one (amendment) marks that row.
 *   recordSourceState    last-attempt / last-success watermark per source.
 *
 * Takes any pg client (or pool): the caller owns the transaction.
 */
import { urlHash } from './outcomes.js';
import { contentHash, boundExtracted, makeExcerpt, sanitizeText } from './signal-text.js';

/** @typedef {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[], rowCount: number|null }> }} Queryable */

/**
 * @param {Queryable} client
 * @param {Array<import('./outcomes.js').TargetItem>} items
 * @returns {Promise<{ inserted: number, rewritten: number, touched: number, superseded: number }>}
 */
export async function persistItems(client, items) {
  const out = { inserted: 0, rewritten: 0, touched: 0, superseded: 0 };
  for (const item of items) {
    const hash = urlHash(item.source, item.key);
    const extracted = boundExtracted(item.extracted);
    const excerpt = makeExcerpt(item.excerpt);
    const signal = item.signal ? JSON.stringify(item.signal) : null;
    const contact = item.contact ? JSON.stringify(item.contact) : null;
    const chash = contentHash({ outcome: item.outcome, reason: item.reason, signal: item.signal, contact: item.contact, excerpt, extracted });
    const url = item.url ? sanitizeText(item.url, 2048) : null;

    const existing = await client.query(
      `SELECT id, content_hash, extracted->>'parser_version' AS parser_version FROM ic_target_signals WHERE url_hash = $1`, [hash],
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO ic_target_signals (url_hash, source, url, excerpt, extracted, parse_outcome, parse_reason, content_hash, signal, contact, fetched_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, now())`,
        [hash, item.source, url, excerpt, JSON.stringify(extracted), item.outcome, item.reason, chash, signal, contact],
      );
      out.inserted += 1;
    } else if (existing.rows[0].content_hash !== chash || existing.rows[0].parser_version !== extracted.parser_version) {
      await client.query(
        `UPDATE ic_target_signals SET
           fetched_at = now(), url = $2, excerpt = $3,
           extracted = $4::jsonb || CASE WHEN extracted ? 'superseded_by' THEN jsonb_build_object('superseded_by', extracted->'superseded_by') ELSE '{}'::jsonb END,
           parse_outcome = $5, parse_reason = $6, content_hash = $7, signal = $8::jsonb, contact = $9::jsonb
         WHERE url_hash = $1`,
        [hash, url, excerpt, JSON.stringify(extracted), item.outcome, item.reason, chash, signal, contact],
      );
      out.rewritten += 1;
    } else {
      await client.query(`UPDATE ic_target_signals SET fetched_at = now() WHERE url_hash = $1`, [hash]);
      out.touched += 1;
    }

    if (item.supersedes) {
      const r = await client.query(
        `UPDATE ic_target_signals SET extracted = extracted || jsonb_build_object('superseded_by', $2::text) WHERE url_hash = $1`,
        [urlHash(item.supersedes.source, item.supersedes.key), sanitizeText(item.key, 200)],
      );
      out.superseded += r.rowCount ?? 0;
    }
  }
  return out;
}

/**
 * @param {Queryable} client
 * @param {string} source
 * @param {{ ok: boolean, status: string, watermark?: string|null }} state
 */
export async function recordSourceState(client, source, state) {
  await client.query(
    `INSERT INTO ic_target_source_state (source, last_success_at, last_attempt_at, last_status, watermark, updated_at)
     VALUES ($1, CASE WHEN $2::boolean THEN now() ELSE NULL END, now(), $3, $4, now())
     ON CONFLICT (source) DO UPDATE SET
       last_success_at = CASE WHEN $2::boolean THEN now() ELSE ic_target_source_state.last_success_at END,
       last_attempt_at = now(),
       last_status = $3,
       watermark = CASE WHEN $2::boolean AND $4::text IS NOT NULL THEN $4::text ELSE ic_target_source_state.watermark END,
       updated_at = now()`,
    [source, state.ok, sanitizeText(state.status, 80), state.watermark ?? null],
  );
}
