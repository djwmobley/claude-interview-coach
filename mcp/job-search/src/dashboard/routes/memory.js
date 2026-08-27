// @ts-check
/**
 * Memory routes (dashboard PR 2 API table, "Memory"). ic_session_moments and ic_coached_answers are owned
 * by the Python semantic-memory stack (tools/ic_memory.py), not by any sql/*.sql migration in this
 * package -- they exist in the real ic_context database already, and bin/bootstrap-test-db.js's
 * pg_dump-of-the-real-schema step carries them into the test database too. Because this package does not
 * own that schema, every query here is wrapped so a missing table (SQLSTATE 42P01, e.g. a test DB that
 * predates the Python tool ever running) degrades to an empty result with a warning instead of a 500.
 */
import { JobSearchError } from '../../core/errors.js';
import { embedSafe } from '../../core/embed.js';
import { listOutputFiles, tokenize, companyTokensFor } from '../../core/documents.js';
import { sendJson } from '../http.js';

const MISSING_RELATION = '42P01';

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<{ value: T, warning: string|null }>}
 */
async function safely(fn, fallback) {
  try {
    return { value: await fn(), warning: null };
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {{ code?: string }} */ (err).code === MISSING_RELATION) {
      return { value: fallback, warning: 'semantic memory tables are not present in this database' };
    }
    throw err;
  }
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/memory/company', async (ctx) => {
    const q = ctx.query;
    let companyText = q.company ? String(q.company) : null;
    if (!companyText && q.listing_id) {
      const r = await deps.withClient((c) => c.query('SELECT company FROM ic_job_listings WHERE id = $1', [Number(q.listing_id)]));
      companyText = r.rows[0]?.company ?? null;
    }
    if (!companyText) throw new JobSearchError('VALIDATION', 'company or listing_id is required');

    const moments = await safely(() => deps.withClient((c) => c.query(
      `SELECT id, session_date, company, role_type, question, response, tags FROM ic_session_moments WHERE company ILIKE $1 ORDER BY session_date DESC LIMIT 25`,
      [`%${companyText}%`],
    ).then((r) => r.rows)), []);

    const files = listOutputFiles(deps.outputRoot).filter((f) => f.dir === 'research');
    const companyTokens = companyTokensFor(companyText, deps.config?.companyAliases ?? {});
    const research = files.filter((f) => tokenize(`${f.dir}/${f.name}`).some((tok) => companyTokens.has(tok)));

    sendJson(ctx.res, 200, { ok: true, company: companyText, moments: moments.value, research, warnings: [moments.warning].filter(Boolean) });
  });

  router.register('GET', '/api/memory/answers', async (ctx) => {
    const q = ctx.query;
    /** @type {unknown[]} */
    const params = [];
    /** @type {string[]} */
    const where = [];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(question_text ILIKE $${params.length} OR answer_text ILIKE $${params.length})`);
    }
    if (q.tag) {
      params.push(q.tag);
      where.push(`$${params.length} = ANY(tags)`);
    }
    const sql = `SELECT id, question_type, question_text, answer_text, tags FROM ic_coached_answers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 50`;
    const rows = await safely(() => deps.withClient((c) => c.query(sql, params).then((r) => r.rows)), []);
    sendJson(ctx.res, 200, { ok: true, rows: rows.value, warnings: [rows.warning].filter(Boolean) });
  });

  router.register('GET', '/api/companies', async (ctx) => {
    const r = await deps.withClient((c) => c.query(
      `SELECT company, company_norm,
              count(*)::int AS listings,
              count(*) FILTER (WHERE status IN ('applied','interviewing','offer'))::int AS active,
              count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              max(last_seen) AS last_seen
       FROM ic_job_listings
       WHERE coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL
       GROUP BY company, company_norm
       ORDER BY listings DESC, company ASC
       LIMIT 200`,
    ));
    sendJson(ctx.res, 200, { ok: true, rows: r.rows.map((row) => ({ ...row, last_seen: row.last_seen ? new Date(row.last_seen).toISOString() : null })) });
  });

  router.register('POST', '/api/companies/:norm/moments', async (ctx) => {
    const norm = ctx.params.norm;
    const b = /** @type {any} */ (ctx.body);
    if (typeof b.question !== 'string' || !b.question.trim()) throw new JobSearchError('VALIDATION', 'question is required');
    if (typeof b.response !== 'string' || !b.response.trim()) throw new JobSearchError('VALIDATION', 'response is required');
    const companyRow = await deps.withClient((c) => c.query('SELECT company FROM ic_job_listings WHERE company_norm = $1 LIMIT 1', [norm]));
    const company = companyRow.rows[0]?.company ?? norm;
    const e = await embedSafe([`${b.question}\n${b.response}`], { ollamaUrl: deps.env.OLLAMA_URL, model: deps.env.OLLAMA_MODEL, fetch: deps.fetch });
    const embeddingLiteral = e.literals[0] ?? null;
    const tags = Array.isArray(b.tags) ? b.tags.map(String) : [];
    const inserted = await safely(() => deps.withClient((c) => c.query(
      `INSERT INTO ic_session_moments (session_date, company, role_type, question, response, coach_notes, quality_score, tags, embedding)
       VALUES (current_date, $1, $2, $3, $4, $5, $6, $7, $8::vector)
       RETURNING id, session_date, company, role_type, question, response, coach_notes, quality_score, tags`,
      [company, b.role_type ?? 'strategy', b.question, b.response, b.coach_notes ?? null, b.quality_score ?? null, tags, embeddingLiteral],
    ).then((r) => r.rows[0])), null);
    if (inserted.warning) throw new JobSearchError('VALIDATION', inserted.warning);
    const warnings = embeddingLiteral ? [] : ['stored without an embedding (embedding service unavailable); it will not surface in semantic search until re-embedded'];
    sendJson(ctx.res, 201, { ok: true, row: inserted.value, warnings });
  });
}
