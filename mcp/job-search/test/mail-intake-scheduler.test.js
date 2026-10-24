// @ts-check
/**
 * The scheduler passes the Gmail source's mail_intake event to its handler (sql/029) without counting it as a
 * listing or a warning, and an adapter's unknown event kind is still counted and reported (total).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch } from '../src/core/scheduler.js';

const ctx = /** @type {any} */ ({ signal: new AbortController().signal, log() {} });
const profile = /** @type {any} */ ({ name: 't' });

/** @param {any[]} events */
const adapterOf = (events) => /** @type {any} */ ({
  name: 'gmail', dateOrdered: false,
  async *search() { for (const e of events) yield e; },
});

test('mail_intake rows reach onMailIntake; no listing, no warning', async () => {
  /** @type {any[]} */
  const got = [];
  const r = await runSearch(adapterOf([
    { kind: 'mail_intake', rows: [{ message_id: 'a' }], rulesVersion: 'v1' },
    { kind: 'source_stats', stats: { x: 1 } },
  ]), profile, ctx, { onListing: async () => {}, onMailIntake: async (ev) => { got.push(ev); } }, { maxPages: 2, windowStart: null });
  assert.equal(got.length, 1);
  assert.equal(got[0].rulesVersion, 'v1');
  assert.equal(r.listings, 0);
  assert.equal(r.warnings, 0);
  assert.equal(r.completed, true);
});

test('without a handler the event is ignored, not warned about', async () => {
  const r = await runSearch(adapterOf([{ kind: 'mail_intake', rows: [], rulesVersion: 'v1' }]), profile, ctx, { onListing: async () => {} }, { maxPages: 2, windowStart: null });
  assert.equal(r.warnings, 0);
});

test('an unknown event kind is still counted as a warning', async () => {
  const r = await runSearch(adapterOf([{ kind: 'mystery' }]), profile, ctx, { onListing: async () => {} }, { maxPages: 2, windowStart: null });
  assert.equal(r.warnings, 1);
});
