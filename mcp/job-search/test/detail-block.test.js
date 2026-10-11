// @ts-check
/**
 * Detail-block fix: per-key wall state (S5), the interactive verification coordinator (S6, with fakes),
 * and the report line.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { recordWall, recordClean, sourceEnabled, detailWallKey } from '../src/browser/wall.js';
import { createVerifyCoordinator, VERIFY_POLL_MS, VERIFY_TOTAL_CAP_MS } from '../src/core/detail-verify.js';
import { blockedDetailLine } from '../src/core/report.js';

describe('per-key detail wall state (real DB)', () => {
  /** @type {pg.Client} */
  let client;
  const SRC = `zz-detailwall-${process.pid}`;
  const KEY = detailWallKey(SRC);

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await client.query('DELETE FROM ic_source_state WHERE source = ANY($1::text[])', [[SRC, KEY]]);
  });
  after(async () => {
    await client.query('DELETE FROM ic_source_state WHERE source = ANY($1::text[])', [[SRC, KEY]]);
    await client.end();
  });

  test('a detail wall disables only the <source>:detail key, never the source', async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    const w = await recordWall(client, KEY, now);
    assert.equal(w.consecutiveWalls, 1);
    assert.equal((await sourceEnabled(client, KEY, now)).enabled, false);
    assert.equal((await sourceEnabled(client, SRC, now)).enabled, true, 'list scans and apply paths keep running');
  });

  test('recordClean resets per key: cleaning the source key leaves the detail key walled, and vice versa', async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    await recordWall(client, SRC, now);
    await recordClean(client, SRC);
    assert.equal((await sourceEnabled(client, KEY, now)).enabled, false, 'detail key still backed off');
    await recordClean(client, KEY);
    assert.equal((await sourceEnabled(client, KEY, now)).enabled, true);
    const rows = (await client.query('SELECT source, consecutive_walls FROM ic_source_state WHERE source = ANY($1::text[]) ORDER BY source', [[SRC, KEY]])).rows;
    assert.deepEqual(rows.map((r) => Number(r.consecutive_walls)), [0, 0]);
  });

  test('the detail key has its own escalating backoff', async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    await recordClean(client, KEY);
    const a = await recordWall(client, KEY, now);
    const b = await recordWall(client, KEY, now);
    assert.equal(a.hours, 24);
    assert.equal(b.hours, 72);
  });
});

describe('verification coordinator (fakes)', () => {
  const BLOCKED_TEXT = 'Additional Verification Required Your Ray ID for this request is a401b81afaf76bd8';
  const OK_TEXT = `About the role. Responsibilities and requirements follow. ${'You will lead a large engineering organization and own the platform roadmap. '.repeat(30)}`;

  /**
   * @param {{ interactive?: boolean, clearAfterPolls?: number|null, totalCapMs?: number }} [o]
   */
  function setup(o = {}) {
    const clearAfter = o.clearAfterPolls === undefined ? 2 : o.clearAfterPolls;
    const state = { polls: 0, sleeps: /** @type {number[]} */ ([]), notices: /** @type {string[]} */ ([]), fronted: 0, capCalls: 0, perSource: /** @type {Record<string, number>} */ ({}) };
    const cap = {
      async bringToFront() { state.fronted++; },
      async readJson(/** @type {string} */ name) {
        if (name === 'wallMarkers') return {};
        state.polls++;
        return clearAfter !== null && state.polls > clearAfter ? OK_TEXT : BLOCKED_TEXT;
      },
    };
    const coord = createVerifyCoordinator({
      interactive: o.interactive ?? true,
      capFor: async () => { state.capCalls++; return cap; },
      sleep: async (ms) => { state.sleeps.push(ms); },
      notify: (source, message) => { state.notices.push(`${source}|${message}`); },
      totalCapMs: o.totalCapMs,
    });
    return { coord, state };
  }

  test('defaults: 15 s poll, 10 minute cap', () => {
    assert.equal(VERIFY_POLL_MS, 15000);
    assert.equal(VERIFY_TOTAL_CAP_MS, 600000);
  });

  test('unattended: never pops, never opens a page, defers', async () => {
    const { coord, state } = setup({ interactive: false });
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:cloudflare_challenge' }), 'deferred');
    assert.equal(state.capCalls, 0);
    assert.equal(state.notices.length, 0);
    assert.equal(state.fronted, 0);
    assert.equal(coord.isDeferred('indeed'), true);
  });

  test('interactive: one notice, page brought to front, polls every 15 s until cleared', async () => {
    const { coord, state } = setup({ clearAfterPolls: 2 });
    assert.equal(await coord.onBlocked('indeed', { url: 'https://www.indeed.com/viewjob?jk=x', reason: 'blocked:indeed_verification' }), 'cleared');
    assert.deepEqual(state.notices, ['indeed|Indeed needs verification']);
    assert.equal(state.fronted, 1);
    assert.deepEqual(state.sleeps, [15000, 15000, 15000]);
    assert.equal(coord.waitedMs, 45000);
  });

  test('at most one pop per source per run: a second block on the same source defers with no new notice', async () => {
    const { coord, state } = setup({ clearAfterPolls: 0 });
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'cleared');
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'deferred');
    assert.equal(state.notices.length, 1);
  });

  test('cleared then blocked again on the retry: markDeferred stops the source, still one pop', async () => {
    const { coord, state } = setup({ clearAfterPolls: 0 });
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'cleared');
    coord.markDeferred('indeed');
    assert.equal(coord.isDeferred('indeed'), true);
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'deferred');
    assert.equal(state.notices.length, 1);
  });

  test('never cleared: waits exactly the cap, then defers; a later source gets no pop at all', async () => {
    const { coord, state } = setup({ clearAfterPolls: null });
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'deferred');
    assert.equal(coord.waitedMs, VERIFY_TOTAL_CAP_MS);
    assert.equal(state.sleeps.length, VERIFY_TOTAL_CAP_MS / VERIFY_POLL_MS);
    assert.equal(await coord.onBlocked('linkedin', { reason: 'blocked:login_wall' }), 'deferred');
    assert.equal(state.notices.length, 1, 'the cap is shared across sources');
    assert.deepEqual(coord.poppedSources, ['indeed']);
  });

  test('the cap is across all sources: time spent on the first source shortens the second', async () => {
    const { coord, state } = setup({ clearAfterPolls: 2, totalCapMs: 90000 });
    assert.equal(await coord.onBlocked('indeed', { reason: 'blocked:captcha' }), 'cleared');
    assert.equal(coord.waitedMs, 45000);
    state.polls = 0;
    const second = await coord.onBlocked('linkedin', { reason: 'blocked:captcha' });
    assert.equal(second, 'cleared');
    assert.equal(coord.waitedMs, 90000);
    assert.equal(await coord.onBlocked('exec', { reason: 'blocked:captcha' }), 'deferred');
  });

  test('no browser capability for the source: defers', async () => {
    const coord = createVerifyCoordinator({ interactive: true, capFor: async () => null, sleep: async () => {}, notify: () => {} });
    assert.equal(await coord.onBlocked('greenhouse', { reason: 'blocked:http_403' }), 'deferred');
  });
});

describe('blockedDetailLine', () => {
  test('null without blocks or on an old run', () => {
    assert.equal(blockedDetailLine(undefined), null);
    assert.equal(blockedDetailLine({}), null);
    assert.equal(blockedDetailLine({ detail_blocked_by_source: {} }), null);
  });
  test('formats a total and source: reason pairs', () => {
    assert.equal(
      blockedDetailLine({ detail_blocked_by_source: { indeed: { cloudflare_challenge: 2 }, linkedin: { login_wall: 1 } } }),
      'Blocked detail pages: 3 (indeed: cloudflare_challenge, linkedin: login_wall)',
    );
  });
});
