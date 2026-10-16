// @ts-check
/**
 * Fixtures for the PR4 tests (plan 18): seed ic_targets rows in every state of the decision table, signals and
 * audit rows, and clean them up by tag. The database is the throwaway "_test" one (pgConnectionConfig() refuses
 * anything else). No network, no child process.
 */

/** The fixture blocked names. They must never appear in any dashboard output. */
export const BLOCKED_NAME = 'Zorbco Holdings';
export const BLOCKED_NAME_2 = 'Qwxy Affiliate Group';

/**
 * @typedef {Object} SeedOpts
 * @property {string} tag unique tag for this test file
 * @property {string} n suffix, unique within the tag
 * @property {string} [company]
 * @property {string} [cls] machine class
 * @property {string} [rule] verdict_rule
 * @property {Record<string, unknown>} [inputs]
 * @property {string} [kind]
 * @property {string} [date]
 * @property {string|null} [decision]
 * @property {string|null} [decisionClass]
 * @property {number} [version]
 * @property {boolean|null} [sizeVerified]
 * @property {string|null} [evidence]
 * @property {string|null} [pe]
 * @property {string|null} [contact]
 * @property {string|null} [role]
 * @property {string|null} [newEvidenceAt]
 * @property {string|null} [staleEvidenceAt]
 * @property {string|null} [createdAt]
 */

/**
 * @param {import('pg').ClientBase} client
 * @param {SeedOpts} o
 * @returns {Promise<number>}
 */
export async function seedTarget(client, o) {
  const r = await client.query(
    `INSERT INTO ic_targets (company, company_norm, class, verdict_rule, verdict_inputs, trigger_kind, trigger_date, evidence_url, contact_role, contact_name,
       pe_firm, size_verified, decision, decision_class, decision_version, new_evidence_at, stale_evidence_at, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz, coalesce($18::timestamptz, now()))
     RETURNING id`,
    [
      o.company ?? `Zz ${o.tag} ${o.n} Co`, `${o.tag}-${o.n}`, o.cls ?? 'needs-review', o.rule ?? 'size_not_clearly_in_band',
      JSON.stringify(o.inputs ?? { trigger_kind: 'pe_deal', age_days: 5 }), o.kind ?? 'pe_deal', o.date ?? '2026-10-08',
      o.evidence === undefined ? 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm' : o.evidence,
      o.role ?? null, o.contact ?? null, o.pe ?? null, o.sizeVerified === undefined ? false : o.sizeVerified, o.decision ?? null, o.decisionClass ?? null, o.version ?? 0,
      o.newEvidenceAt ?? null, o.staleEvidenceAt ?? null, o.createdAt ?? null,
    ],
  );
  return Number(r.rows[0].id);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {string} tag
 * @param {string} excerpt
 * @param {{ source?: string, url?: string|null, extracted?: Record<string, unknown>, fetchedAt?: string|null }} [o]
 */
export async function seedSignal(client, targetId, tag, excerpt, o = {}) {
  const hash = `${tag}-${targetId}-${Math.random().toString(36).slice(2)}`;
  const r = await client.query(
    `INSERT INTO ic_target_signals (url_hash, source, url, excerpt, extracted, target_id, parse_outcome, parse_reason, fetched_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'parsed', 'ok', coalesce($7::timestamptz, now())) RETURNING id`,
    [hash, o.source ?? 'edgar_8k', o.url === undefined ? 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm' : o.url,
      excerpt, JSON.stringify(o.extracted ?? {}), targetId, o.fetchedAt ?? null],
  );
  return Number(r.rows[0].id);
}

/**
 * Remove every row a test file seeded (targets cascade to the audit table; signals are unlinked first).
 * @param {import('pg').ClientBase} client
 * @param {string} tag
 */
export async function cleanup(client, tag) {
  await client.query(`DELETE FROM ic_target_signals WHERE url_hash LIKE $1 OR target_id IN (SELECT id FROM ic_targets WHERE company_norm LIKE $2)`, [`${tag}-%`, `${tag}-%`]);
  await client.query(`DELETE FROM ic_targets WHERE company_norm LIKE $1`, [`${tag}-%`]);
}
