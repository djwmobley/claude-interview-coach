// @ts-check
/**
 * PostgreSQL access. One shared Pool per process plus helpers for
 * transactions and savepoints. The advisory-lock client used by scans is
 * deliberately NOT the pool: callers that need a dedicated connection use
 * `connectDedicated()` and release it in `finally`.
 */
import pg from 'pg';
import { pgConnectionConfig } from './config.js';
import { wrapDbError } from './errors.js';

const { Pool, Client } = pg;

/** @type {import('pg').Pool | null} */
let pool = null;

/**
 * @param {{ dsn?: string|null, max?: number }} [opts]
 * @returns {import('pg').Pool}
 */
export function getPool(opts = {}) {
  if (pool) return pool;
  pool = new Pool({ ...pgConnectionConfig(opts.dsn ?? null), max: opts.max ?? 4, idleTimeoutMillis: 30000 });
  pool.on('error', () => {
    /* idle client errors are surfaced on next query; nothing to log here without an object */
  });
  return pool;
}

/** Close the shared pool (CLIs call this before exit). */
export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/**
 * Open a dedicated, non-pooled client (advisory lock holder, migrations).
 * @param {{ dsn?: string|null }} [opts]
 * @returns {Promise<import('pg').Client>}
 */
export async function connectDedicated(opts = {}) {
  const client = new Client(pgConnectionConfig(opts.dsn ?? null));
  try {
    await client.connect();
  } catch (err) {
    throw wrapDbError(err, 'connect');
  }
  return client;
}

/**
 * Run `fn` with a pooled client, releasing it afterwards.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withClient(fn) {
  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    throw wrapDbError(err, 'connect');
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside BEGIN/COMMIT on the given client; ROLLBACK on throw.
 * @template T
 * @param {import('pg').ClientBase} client
 * @param {(client: import('pg').ClientBase) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is gone; original error wins */
    }
    throw err;
  }
}

let savepointSeq = 0;

/**
 * Run `fn` inside a SAVEPOINT; on throw roll back to it and rethrow, so the
 * enclosing transaction survives (spec 2.2 step 5: per-row adoption).
 * @template T
 * @param {import('pg').ClientBase} client
 * @param {(client: import('pg').ClientBase) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSavepoint(client, fn) {
  const name = `sp_${++savepointSeq}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn(client);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/**
 * True when a pg error is a unique-violation (SQLSTATE 23505).
 * @param {unknown} err
 */
export function isUniqueViolation(err) {
  return Boolean(err && typeof err === 'object' && /** @type {{ code?: string }} */ (err).code === '23505');
}

/**
 * Convenience: single query on the pool.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function query(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    throw wrapDbError(err, 'query');
  }
}
