// @ts-check
/**
 * Indeed verification park (sql/032): an unattended scan that meets an Indeed challenge records the park (no
 * wall), leaves that tab open, makes no further Indeed requests, reports it, and pings once. Fakes only: no real
 * claude, browser, or powershell.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFakeSession, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { reenableSource } from '../src/browser/wall.js';
import { INDEED_PING_PROMPT, indeedPingArgs } from '../src/core/claude-spawn.js';

const PROFILE = `zz-test-indeedpark-${process.pid}`;
/** @type {import('pg').Client} */
let client;

async function resetState() {
  await client.query("DELETE FROM ic_source_state WHERE source IN ('indeed', 'indeed:detail')");
}

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: [] });
  await resetState();
  await upsertTestProfile(client, PROFILE, { sources: ['indeed'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
});
after(async () => {
  try {
    await resetState();
    await cleanupScan(client, { profile: PROFILE, companies: [] });
  } finally {
    await client.end();
  }
});

/**
 * Fake session whose Indeed pages show a verification challenge; records goto calls, kept target ids, closes.
 * @param {{ challenge?: boolean }} [o]
 */
function challengeSession(o = {}) {
  const challenge = o.challenge ?? true;
  /** @type {Array<{ method: string, url: string }>} */
  const gotos = [];
  const base = makeFakeSession({ recorder: gotos });
  const kept = /** @type {string[]} */ ([]);
  const closedAll = { count: 0 };
  const connectSession = async () => {
    const inner = /** @type {any} */ (await base.connectSession());
    const pageIds = new Map();
    return {
      ...inner,
      async attachPage() {
        const page = await inner.attachPage();
        const origEval = page.evaluate.bind(page);
        page.evaluate = async (/** @type {Function} */ fn, /** @type {unknown} */ arg) => {
          if (fn.name === 'indeedChallengeProbe') return challenge ? { challengeForm: true, bodyText: 'Additional Verification Required' } : { bodyText: '' };
          return origEval(fn, arg);
        };
        pageIds.set(page, `target-${pageIds.size + 1}`);
        return page;
      },
      async targetIdOf(/** @type {any} */ page) {
        return pageIds.get(page) ?? null;
      },
      keepOpen(/** @type {string} */ id) {
        kept.push(id);
      },
      async closeAll() {
        closedAll.count++;
      },
    };
  };
  return { connectSession, gotos, kept, closedAll };
}

/** @param {{ calls: any[], result?: any, throws?: boolean }} o */
function fakePing(o) {
  return async (/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    o.calls.push({ bin, args, opts });
    if (o.throws) throw new Error('spawn exploded');
    return o.result ?? { ok: true, stdout: '{}' };
  };
}

const parkRow = async () => (await client.query("SELECT parked_at, park_url, park_target_id, consecutive_walls, disabled_until, manual_disable FROM ic_source_state WHERE source = 'indeed'")).rows[0];
const run = (/** @type {any} */ deps, /** @type {string} */ trigger = 'cli') => runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: false, wait: true }, deps, { trigger: /** @type {any} */ (trigger), log: () => {}, now: FIXTURE_NOW });

describe('Indeed verification park', () => {
  test('unattended challenge: parks, no wall, keeps the tab, stops requests, reports it, pings exactly once', async () => {
    await resetState();
    const sess = challengeSession();
    const ping = { calls: /** @type {any[]} */ ([]) };
    const r = await run(offlineDeps({ connectSession: sess.connectSession, indeedPingRun: fakePing(ping) }));
    const row = await parkRow();
    assert.ok(row.parked_at, 'parked_at set');
    assert.match(row.park_url, /indeed\.com/);
    assert.equal(row.park_target_id, 'target-1');
    assert.equal(Number(row.consecutive_walls), 0, 'no wall counted');
    assert.equal(row.disabled_until, null, 'no 24 h / 72 h pause');
    assert.equal(row.manual_disable, false);
    assert.deepEqual(sess.kept, ['target-1'], 'the tab target id is exempted from closeAll');
    assert.equal(sess.gotos.length, 1, 'no further Indeed requests after the challenge');
    assert.ok(r.errors.some((e) => e.message === 'Indeed is waiting for your click.'), JSON.stringify(r.errors));
    assert.equal(r.errors.some((e) => e.code === 'LOGIN_WALL'), false);
    assert.equal(ping.calls.length, 1, 'one ping');
    assert.equal(ping.calls[0].opts.input, INDEED_PING_PROMPT);
    assert.deepEqual(ping.calls[0].args.slice(0, 4), ['-p', '--model', 'haiku', '--output-format']);
  });

  test('a later run while parked skips Indeed: no requests, no new ping, report line kept', async () => {
    const sess = challengeSession();
    const ping = { calls: /** @type {any[]} */ ([]) };
    const r = await run(offlineDeps({ connectSession: sess.connectSession, indeedPingRun: fakePing(ping) }));
    assert.equal(sess.gotos.length, 0);
    assert.equal(ping.calls.length, 0);
    assert.ok(r.errors.some((e) => e.message === 'Indeed is waiting for your click.'));
  });

  test('re-enable (indeed or indeed:detail) clears the three park columns', async () => {
    await reenableSource(client, 'indeed:detail');
    const row = await parkRow();
    assert.equal(row.parked_at, null);
    assert.equal(row.park_url, null);
    assert.equal(row.park_target_id, null);
    // and a scan after re-enable goes back to Indeed
    const sess = challengeSession({ challenge: false });
    await run(offlineDeps({ connectSession: sess.connectSession, indeedPingRun: fakePing({ calls: [] }) }));
    assert.ok(sess.gotos.length >= 1);
  });

  test('a ping that throws or fails does not fail the scan', async () => {
    await resetState();
    const sess = challengeSession();
    const r = await run(offlineDeps({ connectSession: sess.connectSession, indeedPingRun: fakePing({ calls: [], throws: true }) }));
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.ok((await parkRow()).parked_at);
    await resetState();
    const sess2 = challengeSession();
    const r2 = await run(offlineDeps({ connectSession: sess2.connectSession, indeedPingRun: fakePing({ calls: [], result: { ok: false, reason: 'spawn' } }) }));
    assert.ok(['ok', 'partial'].includes(r2.status), JSON.stringify(r2.errors));
  });

  test('an interactive run behaves as before: wall recorded, no park, no ping', async () => {
    await resetState();
    const sess = challengeSession();
    const ping = { calls: /** @type {any[]} */ ([]) };
    const r = await run(offlineDeps({ connectSession: sess.connectSession, indeedPingRun: fakePing(ping) }), 'mcp');
    const row = await parkRow();
    assert.equal(row.parked_at, null);
    assert.equal(Number(row.consecutive_walls), 1);
    assert.equal(ping.calls.length, 0);
    assert.deepEqual(sess.kept, []);
    assert.ok(r.errors.some((e) => e.code === 'LOGIN_WALL'));
  });

  test('the ping argv names haiku, PushNotification only, and no shell or web tool', () => {
    const args = indeedPingArgs({ configDir: 'C:/x' });
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed, ['PushNotification', 'ToolSearch']);
    assert.ok(args.includes('Bash'));
  });
});
