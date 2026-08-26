#!/usr/bin/env node
// @ts-check
/**
 * Backfill NULL embeddings in ic_job_listings using the Python-parity formula
 * (spec section 7). Keyset paging on id, batches of 32, one transaction per
 * batch. Safe to re-run; only rows with embedding IS NULL are touched.
 *
 *   node bin/backfill-embeddings.js [--limit N] [--dry-run] [--all]
 *
 * --all re-embeds every row (use after an Ollama model update when you do not
 * want to run tools/reembed_all.py). Exit 0 ok, 1 Ollama or DB failure.
 */
import { connectDedicated } from '../src/core/db.js';
import { embedBatch, embeddingText, toVectorLiteral, BATCH_SIZE } from '../src/core/embed.js';
import { errFields } from '../src/core/errors.js';

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { limit: Infinity, dryRun: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = parseInt(argv[++i] ?? '0', 10) || Infinity;
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--all') out.all = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connectDedicated();
  let done = 0;
  let lastId = 0;
  let code = 0;
  try {
    for (;;) {
      if (done >= args.limit) break;
      const take = Math.min(BATCH_SIZE, args.limit - done);
      const where = args.all ? 'id > $1' : 'id > $1 AND embedding IS NULL';
      const r = await client.query(`SELECT id, title, company, notes FROM ic_job_listings WHERE ${where} ORDER BY id LIMIT $2`, [lastId, take]);
      if (r.rowCount === 0) break;
      lastId = r.rows[r.rows.length - 1].id;
      const texts = r.rows.map((row) => embeddingText(row));
      if (args.dryRun) {
        done += r.rows.length;
        process.stdout.write(`dry-run: would embed ids ${r.rows[0].id}..${lastId} (${r.rows.length})\n`);
        continue;
      }
      const vecs = await embedBatch(texts);
      await client.query('BEGIN');
      try {
        for (let i = 0; i < r.rows.length; i++) {
          await client.query('UPDATE ic_job_listings SET embedding = $2::vector WHERE id = $1', [r.rows[i].id, toVectorLiteral(vecs[i])]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      done += r.rows.length;
      process.stdout.write(`embedded ids ${r.rows[0].id}..${lastId} (${r.rows.length}), total ${done}\n`);
    }
    process.stdout.write(`backfill complete: ${done} rows\n`);
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`backfill failed after ${done} rows: ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
