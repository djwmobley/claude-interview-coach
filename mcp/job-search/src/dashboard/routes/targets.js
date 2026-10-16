// @ts-check
/**
 * Target finder routes (plan 18). Read: list, options, tile summary, detail. Write: reclassify, discard,
 * restore. Nothing here drafts, sends or fetches anything.
 *
 * Every read runs in BEGIN READ ONLY (inReadOnlyTx) and every string passes the blocked-affiliate leak guard
 * (src/targets/leak-guard.js: exact redaction plus a squashed second pass for slugs and encodings). A
 * blocked row (effective.js) shows the company as "[blocked]" and withholds its evidence URL, contact, PE firm,
 * excerpts and signals everywhere: list, detail, counts, filter options, and the q search (which never matches
 * a blocked row). Blocked-affiliate names appear in no response.
 *
 * Writes reuse the dashboard's existing guards (checkHost, checkContentType, checkOrigin run for every non-GET
 * under /api/ in server.js) and add no route-local exemption. The actor is the literal 'damian'; a request body
 * cannot set it. Version, state table and audit are in src/targets/decisions.js.
 */
import { DashboardError, sendJson } from '../http.js';
import { loadBlockedAffiliates } from '../../core/target-exclusion.js';
import { checkEvidence } from '../../core/target-evidence.js';
import { inReadOnlyTx, safeInputs } from '../../tools/targets.js';
import { makeLeakGuard } from '../../targets/leak-guard.js';
import { blockedSql, effectiveClassSql, CLASSES } from '../../targets/effective.js';
import { applyDecision, stateOf, allowedActions, DecisionError, REASONS } from '../../targets/decisions.js';
import { closedReason } from '../../targets/coverage.js';

export const STATUS_FILTERS = Object.freeze(['active', 'open', 'reclassified', 'discarded', 'approved', 'any']);
const KINDS = Object.freeze(['pe_deal', 'exec_departure', 'leadership_gap']);
const SIZE_STATES = Object.freeze(['verified', 'unverified', 'unknown']);
const SOURCE_RE = /^[a-z0-9_]{1,40}$/;
const Q_MAX = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 100_000;
const SIGNALS_IN_DETAIL = 20;
const EXCERPT_CHARS = 1000;
const HISTORY_ROWS = 50;
const TILE_FALLBACK_DAYS = 7;
const BLOCKED_LABEL = '[blocked]';

const EFF = effectiveClassSql('t');
const BLK = blockedSql('t');

const LIST_COLS = `t.id, t.company, t.class, t.verdict_rule, t.trigger_kind, t.trigger_date, t.pe_firm, t.size_verified, t.size_confidence,
  t.decision, t.decision_class, t.decision_version, t.new_evidence_at, t.stale_evidence_at, t.updated_at,
  ${EFF} AS eff_class, ${BLK} AS is_blocked,
  (SELECT s.source FROM ic_target_signals s WHERE s.target_id = t.id ORDER BY s.id DESC LIMIT 1) AS evidence_source`;

/** @param {unknown} d @returns {string|null} */
function isoDay(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return typeof d === 'string' && d ? d : null;
}
/** @param {unknown} d @returns {string|null} */
function isoTime(d) {
  if (d instanceof Date) return d.toISOString();
  return typeof d === 'string' && d ? d : null;
}

/** @param {string} s @returns {string} */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * @param {string|undefined} raw
 * @param {number} dflt
 * @param {number} max
 * @param {string} name
 */
function intParam(raw, dflt, max, name) {
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d{1,9}$/.test(raw)) throw new DashboardError(400, 'INVALID_QUERY', `${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n > max) throw new DashboardError(400, 'INVALID_QUERY', `${name} is limited to ${max}`);
  return n;
}

/**
 * @param {Record<string, string>} query
 * @returns {{ where: string[], params: unknown[], limit: number, offset: number }}
 */
export function parseListQuery(query) {
  /** @type {string[]} */
  const where = [];
  /** @type {unknown[]} */
  const params = [];
  const add = (/** @type {string} */ sql, /** @type {unknown} */ v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  const status = query.status ?? 'active';
  if (!STATUS_FILTERS.includes(status)) throw new DashboardError(400, 'INVALID_QUERY', 'status is not in the closed list');
  if (status === 'active') where.push(`(t.decision IS NULL OR t.decision = 'reclassified')`);
  else if (status === 'open') where.push('t.decision IS NULL');
  else if (status !== 'any') add('t.decision = ?', status);
  const cls = query.class;
  if (cls === undefined || cls === '') {
    if (status === 'active') where.push(`${EFF} IN ('target', 'needs-review')`);
  } else if (cls !== 'all') {
    if (!CLASSES.includes(cls)) throw new DashboardError(400, 'INVALID_QUERY', 'class is not in the closed list');
    add(`${EFF} = ?`, cls);
  }
  if (query.trigger_kind) {
    if (!KINDS.includes(query.trigger_kind)) throw new DashboardError(400, 'INVALID_QUERY', 'trigger_kind is not in the closed list');
    add('t.trigger_kind = ?', query.trigger_kind);
  }
  if (query.source) {
    if (!SOURCE_RE.test(query.source)) throw new DashboardError(400, 'INVALID_QUERY', 'source is not a valid token');
    add('EXISTS (SELECT 1 FROM ic_target_signals s WHERE s.target_id = t.id AND s.source = ?)', query.source);
  }
  if (query.size_verified) {
    if (!SIZE_STATES.includes(query.size_verified)) throw new DashboardError(400, 'INVALID_QUERY', 'size_verified is not in the closed list');
    if (query.size_verified === 'verified') where.push('t.size_verified IS TRUE');
    else if (query.size_verified === 'unverified') where.push('t.size_verified IS FALSE');
    else where.push('t.size_verified IS NULL');
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const q = query.q.trim();
    if (q.length > Q_MAX) throw new DashboardError(400, 'INVALID_QUERY', `q is limited to ${Q_MAX} characters`);
    params.push(`%${escapeLike(q)}%`);
    const n = `$${params.length}`;
    // A blocked row never matches a search, whatever it contains.
    where.push(`(NOT ${BLK} AND (t.company ILIKE ${n} ESCAPE '\\' OR coalesce(t.pe_firm, '') ILIKE ${n} ESCAPE '\\' OR coalesce(t.contact_name, '') ILIKE ${n} ESCAPE '\\' OR coalesce(t.contact_role, '') ILIKE ${n} ESCAPE '\\'))`);
  }
  const limit = Math.max(1, intParam(query.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit'));
  const offset = intParam(query.offset, 0, MAX_OFFSET, 'offset');
  return { where, params, limit, offset };
}

/**
 * @param {any} r a LIST_COLS row
 * @param {ReturnType<typeof makeLeakGuard>} g
 */
function formatListRow(r, g) {
  const blocked = Boolean(r.is_blocked);
  return {
    id: Number(r.id),
    company: blocked ? BLOCKED_LABEL : (g.text(r.company) ?? ''),
    class: r.eff_class,
    status: r.decision ?? 'open',
    blocked,
    verdict_rule: r.verdict_rule,
    trigger_kind: r.trigger_kind,
    trigger_date: isoDay(r.trigger_date),
    evidence_source: r.evidence_source ?? null,
    size_verified: r.size_verified,
    size_confidence: r.size_confidence,
    new_evidence: Boolean(r.new_evidence_at),
    stale_evidence: Boolean(r.stale_evidence_at),
    decision_version: Number(r.decision_version),
    updated_at: isoTime(r.updated_at),
  };
}

/** @param {any} q @returns {Promise<Record<string, number>>} */
async function loadCounts(q) {
  const r = await q.query(
    `SELECT
       count(*) FILTER (WHERE t.decision IS DISTINCT FROM 'discarded' AND ${EFF} = 'target')::int AS target,
       count(*) FILTER (WHERE t.decision IS DISTINCT FROM 'discarded' AND ${EFF} = 'needs-review')::int AS needs_review,
       count(*) FILTER (WHERE t.decision IS DISTINCT FROM 'discarded' AND ${EFF} = 'not-target')::int AS not_target,
       count(*) FILTER (WHERE t.decision = 'discarded')::int AS discarded,
       count(*) FILTER (WHERE ${BLK})::int AS blocked,
       count(*)::int AS total
     FROM ic_targets t`,
  );
  const c = r.rows[0];
  return { target: c.target, 'needs-review': c.needs_review, 'not-target': c.not_target, discarded: c.discarded, blocked: c.blocked, total: c.total };
}

/**
 * The detail view of one target, redacted. Used by GET /:id and returned after every action.
 * @param {any} q a read connection
 * @param {number} id
 */
async function loadDetail(q, id) {
  const r = await q.query(
    `SELECT ${LIST_COLS}, t.reason, t.verdict_inputs, t.evidence_url, t.contact_role, t.contact_name, t.size_low, t.size_high, t.size_basis,
            t.listing_ids, t.decision_reason, t.decided_at
     FROM ic_targets t WHERE t.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * @param {any} q
 * @param {number} id
 * @param {ReturnType<typeof makeLeakGuard>} g
 */
async function buildDetail(q, id, g) {
  const r = await loadDetail(q, id);
  if (!r) return null;
  const base = formatListRow(r, g);
  const blocked = base.blocked;
  const state = stateOf(r);
  const sig = blocked
    ? { rows: [] }
    : await q.query(
      `SELECT id, source, url, excerpt, parse_outcome, parse_reason, fetched_at, extracted->>'doc_fetch' AS doc_fetch
       FROM ic_target_signals WHERE target_id = $1 ORDER BY id DESC LIMIT $2`,
      [id, SIGNALS_IN_DETAIL],
    );
  const hist = await q.query(
    `SELECT id, at, action, from_class, to_class, reason_code, note, decision_version
     FROM ic_target_decisions WHERE target_id = $1 ORDER BY id DESC LIMIT $2`,
    [id, HISTORY_ROWS],
  );
  /** @type {Record<string, unknown>} */
  const inputs = {};
  for (const [k, v] of Object.entries(safeInputs(r.verdict_inputs))) inputs[k] = typeof v === 'string' ? g.text(v) : v;
  let evidence = { text: /** @type {string|null} */ (null), url: /** @type {string|null} */ (null), url_ok: false, host: /** @type {string|null} */ (null) };
  if (!blocked && typeof r.evidence_url === 'string' && r.evidence_url) {
    const text = g.url(r.evidence_url);
    const chk = checkEvidence(r.evidence_url, r.evidence_source);
    const intact = text === r.evidence_url;
    evidence = { text, url: chk.ok && intact && chk.url?.startsWith('https:') ? chk.url : null, url_ok: Boolean(chk.ok && intact && chk.url?.startsWith('https:')), host: chk.host };
  }
  return {
    ...base,
    machine_class: r.class,
    reason: r.reason,
    inputs,
    evidence,
    contact_role: blocked ? null : g.text(r.contact_role),
    contact_name: blocked ? null : g.text(r.contact_name),
    pe_firm: blocked ? null : g.text(r.pe_firm),
    size: { low: r.size_low === null ? null : Number(r.size_low), high: r.size_high === null ? null : Number(r.size_high), basis: r.size_basis, confidence: r.size_confidence, verified: r.size_verified },
    listing_ids: r.listing_ids ?? [],
    decision: { status: base.status, class: r.decision_class, reason: r.decision_reason, decided_at: isoTime(r.decided_at) },
    allowed: allowedActions(state),
    signals_withheld: blocked,
    signals: sig.rows.map((/** @type {any} */ s) => ({
      id: Number(s.id),
      source: s.source,
      parse_outcome: s.parse_outcome,
      parse_reason: s.parse_reason,
      doc_fetch: s.doc_fetch ?? null,
      url: g.url(s.url),
      excerpt: g.text(String(s.excerpt ?? '').slice(0, EXCERPT_CHARS)),
      fetched_at: isoTime(s.fetched_at),
    })),
    history: hist.rows.map((/** @type {any} */ h) => ({
      id: Number(h.id),
      at: isoTime(h.at),
      action: h.action,
      from_class: h.from_class,
      to_class: h.to_class,
      reason_code: h.reason_code,
      note: g.text(h.note),
      decision_version: Number(h.decision_version),
    })),
  };
}

/**
 * The tile (plan 18.4, O5).
 * @param {any} q
 */
async function buildSummary(q) {
  const st = await q.query('SELECT last_report_sent_at FROM ic_report_state WHERE id = true');
  const sent = st.rows[0]?.last_report_sent_at ?? null;
  const since = sent instanceof Date ? sent : new Date(Date.now() - TILE_FALLBACK_DAYS * 86_400_000);
  const nw = await q.query(
    `SELECT count(*) FILTER (WHERE ${EFF} = 'target')::int AS new_targets, count(*) FILTER (WHERE ${EFF} = 'needs-review')::int AS new_needs_review
     FROM ic_targets t WHERE t.created_at > $1::timestamptz AND t.decision IS DISTINCT FROM 'discarded' AND NOT ${BLK}`,
    [since],
  );
  const open = await q.query(
    `SELECT count(*) FILTER (WHERE ${EFF} = 'target')::int AS targets, count(*) FILTER (WHERE ${EFF} = 'needs-review')::int AS needs_review
     FROM ic_targets t WHERE (t.decision IS NULL OR t.decision = 'reclassified') AND NOT ${BLK}`,
  );
  const run = await q.query(`SELECT id, status, trigger, started_at, finished_at, details->'sources' AS sources FROM ic_target_runs ORDER BY id DESC LIMIT 1`);
  const lr = run.rows[0] ?? null;
  /** @type {Array<{ name: string, status: string, reason: string|null, backlog_days: number|null }>} */
  const sources = [];
  if (lr && lr.sources && typeof lr.sources === 'object') {
    // jsonb does not keep key order: the documented sources first, in their fixed order, then any other by name.
    const order = ['form_d', '8k', 'fts', 'alerts', 'gap'];
    const entries = Object.entries(lr.sources).sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99) || a[0].localeCompare(b[0]));
    for (const [name, v] of entries) {
      const s = /** @type {any} */ (v);
      if (!s || typeof s !== 'object' || s.status === 'disabled') continue;
      const backlog = s.backlog_days === null || s.backlog_days === undefined ? NaN : Number(s.backlog_days);
      sources.push({
        name: String(name).slice(0, 40),
        status: typeof s.status === 'string' ? s.status.slice(0, 20) : 'unknown',
        reason: s.reason ? closedReason(s.reason) : null,
        backlog_days: Number.isFinite(backlog) ? backlog : null,
      });
    }
  }
  return {
    since: since.toISOString(),
    since_basis: sent instanceof Date ? 'last_digest' : 'last_7_days',
    new_targets: nw.rows[0].new_targets,
    new_needs_review: nw.rows[0].new_needs_review,
    open: { targets: open.rows[0].targets, needs_review: open.rows[0].needs_review },
    last_run: lr ? { id: Number(lr.id), status: lr.status, trigger: lr.trigger, started_at: isoTime(lr.started_at), finished_at: isoTime(lr.finished_at) } : null,
    sources,
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  const guard = () => makeLeakGuard(loadBlockedAffiliates(deps.env?.JOBSEARCH_CONFIG_DIR || undefined).entries);

  /** @param {string} raw @returns {number} */
  function idParam(raw) {
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1 || Number(raw) > 2_147_483_647) throw new DashboardError(400, 'INVALID_ID', 'id must be a positive integer');
    return Number(raw);
  }

  router.register('GET', '/api/targets', async (ctx) => {
    const { where, params, limit, offset } = parseListQuery(ctx.query);
    const g = guard();
    const out = await deps.withClient((c) => inReadOnlyTx(c, async (q) => {
      const rows = await q.query(
        `SELECT ${LIST_COLS} FROM ic_targets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE ${EFF} WHEN 'target' THEN 0 WHEN 'needs-review' THEN 1 ELSE 2 END, t.trigger_date DESC NULLS LAST, t.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      const total = await q.query(`SELECT count(*)::int AS n FROM ic_targets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
      return { rows: rows.rows, total: total.rows[0].n, counts: await loadCounts(q) };
    }));
    sendJson(ctx.res, 200, { ok: true, total: out.total, limit, offset, counts: out.counts, rows: out.rows.map((/** @type {any} */ r) => formatListRow(r, g)) });
  });

  router.register('GET', '/api/targets/options', async (ctx) => {
    const out = await deps.withClient((c) => inReadOnlyTx(c, async (q) => {
      const kinds = await q.query(`SELECT DISTINCT t.trigger_kind AS v FROM ic_targets t WHERE t.trigger_kind IS NOT NULL ORDER BY 1`);
      const sources = await q.query(`SELECT DISTINCT s.source AS v FROM ic_target_signals s WHERE s.target_id IS NOT NULL ORDER BY 1`);
      const sizes = await q.query(`SELECT DISTINCT CASE WHEN t.size_verified IS TRUE THEN 'verified' WHEN t.size_verified IS FALSE THEN 'unverified' ELSE 'unknown' END AS v FROM ic_targets t`);
      return { kinds: kinds.rows, sources: sources.rows, sizes: sizes.rows, counts: await loadCounts(q) };
    }));
    sendJson(ctx.res, 200, {
      ok: true,
      classes: [...CLASSES],
      statuses: [...STATUS_FILTERS],
      trigger_kinds: out.kinds.map((/** @type {any} */ r) => r.v).filter((/** @type {string} */ v) => KINDS.includes(v)),
      sources: out.sources.map((/** @type {any} */ r) => r.v).filter((/** @type {string} */ v) => SOURCE_RE.test(v)),
      size_verified: SIZE_STATES.filter((s) => out.sizes.some((/** @type {any} */ r) => r.v === s)),
      counts: out.counts,
      reasons: { to_target: [...REASONS.to_target], to_not_target: [...REASONS.to_not_target], discard: [...REASONS.discard] },
    });
  });

  router.register('GET', '/api/targets/summary', async (ctx) => {
    const out = await deps.withClient((c) => inReadOnlyTx(c, buildSummary));
    sendJson(ctx.res, 200, { ok: true, ...out });
  });

  router.register('GET', '/api/targets/:id', async (ctx) => {
    const id = idParam(ctx.params.id);
    const g = guard();
    const detail = await deps.withClient((c) => inReadOnlyTx(c, (q) => buildDetail(q, id, g)));
    if (!detail) throw new DashboardError(404, 'NOT_FOUND', 'target not found');
    sendJson(ctx.res, 200, { ok: true, target: detail });
  });

  /** @param {'reclassify'|'discard'|'restore'} action */
  function actionRoute(action) {
    router.register('POST', `/api/targets/:id/${action}`, async (ctx) => {
      const id = idParam(ctx.params.id);
      const g = guard();
      /** @type {{ noop: boolean, decision_version: number }} */
      let res;
      try {
        res = await deps.withClient((c) => applyDecision(c, id, action, ctx.body));
      } catch (err) {
        if (err instanceof DecisionError) throw new DashboardError(err.status, err.code, err.message, { details: err.details });
        throw err;
      }
      const detail = await deps.withClient((c) => inReadOnlyTx(c, (q) => buildDetail(q, id, g)));
      sendJson(ctx.res, 200, { ok: true, noop: res.noop, decision_version: res.decision_version, target: detail });
    });
  }
  actionRoute('reclassify');
  actionRoute('discard');
  actionRoute('restore');
}
