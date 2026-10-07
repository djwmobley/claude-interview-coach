// @ts-check
/**
 * src/core/manual-lock.js (R8, A1, A2): the manual-only lockout. Pure matching (company/title, normalized
 * target URL, dedup root, placeholder companies keyed on title plus link or location) and the DB helpers
 * (write once per listing, hand back, lookup) against the shared test database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import {
  isPlaceholderCompany, lockSubjectFromRow, lockMatches, writeManualLocks, findManualLock, handBackManualLock, loadActiveManualLocks, loadLockSubject,
} from '../src/core/manual-lock.js';

/** @param {Partial<ReturnType<typeof lockSubjectFromRow>>} o */
const subj = (o) => ({ listingId: 1, rootListingId: 1, companyNorm: 'acme', titleNorm: 'cto', locationNorm: 'state-tx', placeholder: false, urlKeys: [], ...o });

describe('isPlaceholderCompany', () => {
  test('blank, stoplisted, confidential, and recruiter-shaped names are placeholders', () => {
    assert.equal(isPlaceholderCompany('', ''), true);
    assert.equal(isPlaceholderCompany('Confidential', 'confidential:abc'), true);
    assert.equal(isPlaceholderCompany('Undisclosed', 'undisclosed'), true);
    assert.equal(isPlaceholderCompany('Apex Executive Search', 'apex executive search'), true);
    assert.equal(isPlaceholderCompany('Robert Half Staffing', 'robert half staffing'), true);
    assert.equal(isPlaceholderCompany('Acme Recruiting', 'acme recruiting'), true);
  });
  test('an ordinary employer is not', () => {
    assert.equal(isPlaceholderCompany('Acme Corp', 'acme'), false);
  });
});

describe('lockMatches', () => {
  test('same listing or same dedup root matches', () => {
    assert.equal(lockMatches(subj({ listingId: 5, rootListingId: 5 }), subj({ listingId: 5, rootListingId: 5, companyNorm: 'x', titleNorm: 'y' })), true);
    assert.equal(lockMatches(subj({ listingId: 6, rootListingId: 5 }), subj({ listingId: 9, rootListingId: 5, companyNorm: 'x', titleNorm: 'y' })), true);
  });
  test('same company and title matches across listings (A2)', () => {
    assert.equal(lockMatches(subj({ listingId: 1, rootListingId: 1 }), subj({ listingId: 2, rootListingId: 2, locationNorm: 'remote-us' })), true);
  });
  test('same normalized target URL matches even with different company text', () => {
    const lock = subj({ listingId: 1, rootListingId: 1, companyNorm: 'acme', urlKeys: ['careers.acme.com/j/1'] });
    assert.equal(lockMatches(lock, subj({ listingId: 2, rootListingId: 2, companyNorm: 'acme holdings', titleNorm: 'other', urlKeys: ['careers.acme.com/j/1'] })), true);
  });
  test('placeholder companies never match on company/title alone; they need title plus link or location', () => {
    const lock = subj({ listingId: 1, rootListingId: 1, companyNorm: 'confidential:a', placeholder: true, locationNorm: 'state-tx' });
    assert.equal(lockMatches(lock, subj({ listingId: 2, rootListingId: 2, companyNorm: 'confidential:a', placeholder: true, locationNorm: 'state-ca' })), false);
    assert.equal(lockMatches(lock, subj({ listingId: 2, rootListingId: 2, companyNorm: 'confidential:b', placeholder: true, locationNorm: 'state-tx' })), true);
    assert.equal(lockMatches(lock, subj({ listingId: 2, rootListingId: 2, companyNorm: 'confidential:b', titleNorm: 'cio', placeholder: true, locationNorm: 'state-tx' })), false);
  });
  test('an unusable location never matches a placeholder', () => {
    const lock = subj({ listingId: 1, rootListingId: 1, placeholder: true, locationNorm: 'absent' });
    assert.equal(lockMatches(lock, subj({ listingId: 2, rootListingId: 2, placeholder: true, locationNorm: 'absent' })), false);
  });
  test('different company and title, no shared URL: no match', () => {
    assert.equal(lockMatches(subj({}), subj({ listingId: 2, rootListingId: 2, companyNorm: 'beta' })), false);
  });
});

describe('manual-lock DB helpers', () => {
  const SRC = `zz-test-mlock-${process.pid}`;
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const ids = [];
  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    const ins = `INSERT INTO ic_job_listings (source, external_id, url, title, title_norm, company, company_norm, location_norm) VALUES ($1, $2, $3, 'CTO', 'cto', $4, $5, 'state-tx') RETURNING id`;
    ids.push(Number((await client.query(ins, [SRC, `${SRC}-1`, 'https://careers.acme.com/j/1', 'Acme', `acme${process.pid}`])).rows[0].id));
    ids.push(Number((await client.query(ins, [SRC, `${SRC}-2`, 'https://www.indeed.com/viewjob?jk=abcdef12345678', 'Acme', `acme${process.pid}`])).rows[0].id));
    ids.push(Number((await client.query(ins, [SRC, `${SRC}-3`, 'https://careers.beta.com/j/1', 'Beta', `beta${process.pid}`])).rows[0].id));
  });
  after(async () => {
    await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
    await client.end();
  });

  test('a lock is written once per listing; a sibling with the same company/title inherits it', async () => {
    const s0 = await loadLockSubject(client, ids[0]);
    assert.ok(s0);
    const n1 = await writeManualLocks(client, [{ subject: /** @type {any} */ (s0), bucket: 'ready_to_apply' }], new Date());
    assert.equal(n1, 1);
    const n2 = await writeManualLocks(client, [{ subject: /** @type {any} */ (s0), bucket: 'ready_to_apply' }], new Date());
    assert.equal(n2, 0, 'second write for the same listing is a no-op');
    assert.ok(await findManualLock(client, ids[0]));
    assert.ok(await findManualLock(client, ids[1]), 'same company/title sibling is locked too');
    assert.equal(await findManualLock(client, ids[2]), null);
  });

  test('hand back releases every matching lock, logs a listing event, and is never re-locked for that listing', async () => {
    const r = await handBackManualLock(client, ids[1], { actor: 'dashboard', now: new Date() });
    assert.equal(r.released, 1);
    assert.equal(await findManualLock(client, ids[0]), null);
    const ev = await client.query(`SELECT note FROM ic_job_events WHERE listing_id = $1 AND kind = 'note' ORDER BY id DESC LIMIT 1`, [ids[1]]);
    assert.match(ev.rows[0].note, /handed back/i);
    const s0 = await loadLockSubject(client, ids[0]);
    const again = await writeManualLocks(client, [{ subject: /** @type {any} */ (s0), bucket: 'ready_to_apply' }], new Date());
    assert.equal(again, 0, 'a released lock row still counts as the first display');
    const active = (await loadActiveManualLocks(client)).filter((l) => ids.includes(l.listingId));
    assert.equal(active.length, 0);
  });
});
