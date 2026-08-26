// @ts-check
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { classifyPage, suspectedThrottle, backoffFor, recordWall, recordClean, sourceEnabled, KINDS } from '../src/browser/wall.js';
import { routeDecision } from '../src/browser/session.js';
import { pgConnectionConfig } from '../src/core/config.js';

describe('wall classification (total)', () => {
  test('parsed > 0 is ok regardless of other signals', () => {
    const v = classifyPage({ parsed: 3, status: 403, challengeForm: true });
    assert.equal(v.kind, 'ok');
    assert.equal(v.stopSource, false);
  });
  test('zero parsed with empty-state marker is empty', () => {
    assert.equal(classifyPage({ parsed: 0, emptyState: true }).kind, 'empty');
  });
  const walls = [
    [{ parsed: 0, status: 403 }, 'http_403'],
    [{ parsed: 0, status: 429 }, 'http_429'],
    [{ parsed: 0, cfMitigated: 'challenge' }, 'cf_mitigated'],
    [{ parsed: 0, challengeCloudflare: true }, 'cloudflare_challenge'],
    [{ parsed: 0, challengeForm: true }, 'challenge_form'],
    [{ parsed: 0, recaptcha: true }, 'recaptcha'],
    [{ parsed: 0, url: 'https://www.linkedin.com/login?x=1' }, 'wall_path'],
    [{ parsed: 0, url: 'https://www.linkedin.com/checkpoint/challenge' }, 'wall_path'],
    [{ parsed: 0, url: 'https://www.linkedin.com/authwall' }, 'wall_path'],
    [{ parsed: 0, url: 'https://www.linkedin.com/uas/login' }, 'wall_path'],
  ];
  for (const [sig, reason] of walls) {
    test(`wall: ${reason}`, () => {
      const v = classifyPage(/** @type {any} */ (sig));
      assert.equal(v.kind, 'wall');
      assert.equal(v.reason, reason);
      assert.equal(v.code, 'LOGIN_WALL');
      assert.equal(v.stopSource, true);
    });
  }
  test('otherwise unrecognized, treated as wall (stopSource)', () => {
    const v = classifyPage({ parsed: 0, status: 200, url: 'https://www.indeed.com/jobs?q=cto' });
    assert.equal(v.kind, 'unrecognized');
    assert.equal(v.code, 'UNRECOGNIZED_PAGE');
    assert.equal(v.stopSource, true);
  });
  test('description text is never consulted (no such input exists)', () => {
    const v = classifyPage(/** @type {any} */ ({ parsed: 0, emptyState: true, description: 'please log in to continue /login' }));
    assert.equal(v.kind, 'empty');
  });
  test('every verdict kind is one of KINDS', () => {
    for (const sig of [{ parsed: 1 }, { parsed: 0, emptyState: true }, { parsed: 0, status: 403 }, { parsed: 0 }]) {
      assert.ok(KINDS.includes(classifyPage(sig).kind));
    }
  });
  test('throttle heuristic', () => {
    assert.equal(suspectedThrottle(3, 20, 0.4), true);
    assert.equal(suspectedThrottle(10, 20, 0.4), false);
    assert.equal(suspectedThrottle(0, null, 0.4), false);
    assert.equal(suspectedThrottle(0, 0, 0.4), false);
  });
  test('backoff ladder 24h / 72h / manual', () => {
    assert.deepEqual(backoffFor(1), { hours: 24, manual: false });
    assert.deepEqual(backoffFor(2), { hours: 72, manual: false });
    assert.deepEqual(backoffFor(3), { hours: null, manual: true });
    assert.deepEqual(backoffFor(9), { hours: null, manual: true });
  });
});

describe('route decision (page.route handler policy)', () => {
  test('GET allowed, images/fonts/media/stylesheets blocked', () => {
    assert.equal(routeDecision({ method: 'GET', resourceType: 'document', url: 'https://www.indeed.com/jobs' }).allow, true);
    assert.equal(routeDecision({ method: 'GET', resourceType: 'image', url: 'https://www.indeed.com/x.png' }).allow, false);
    assert.equal(routeDecision({ method: 'GET', resourceType: 'font', url: 'https://www.indeed.com/x.woff' }).allow, false);
  });
  test('non-GET denied except the path-scoped POST exceptions', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.linkedin.com/voyager/api/graphql' }).allow, true);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.linkedin.com/voyager/api/voyagerJobsDashJobSearch' }).allow, true);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.linkedin.com/voyager/api/messaging/conversations' }).allow, false);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.indeed.com/apply' }).allow, false);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs' }).allow, true);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://evil.example/voyager/api/graphql' }).allow, false);
    assert.equal(routeDecision({ method: 'PUT', resourceType: 'xhr', url: 'https://www.linkedin.com/voyager/api/graphql' }).allow, false);
    assert.equal(routeDecision({ method: 'DELETE', resourceType: 'xhr', url: 'https://www.indeed.com/x' }).allow, false);
  });
});

describe('cross-run backoff in ic_source_state (real DB)', () => {
  const source = `zz-test-wall-${process.pid}`;
  /** @type {pg.Client} */
  let client;
  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await client.query('DELETE FROM ic_source_state WHERE source = $1', [source]);
  });
  after(async () => {
    await client.query('DELETE FROM ic_source_state WHERE source = $1', [source]);
    await client.end();
  });
  test('one wall 24h, two 72h, three manual; enable resets', async () => {
    const now = new Date('2026-08-24T12:00:00Z');
    let r = await recordWall(client, source, now);
    assert.equal(r.consecutiveWalls, 1);
    assert.equal(r.hours, 24);
    let s = await sourceEnabled(client, source, now);
    assert.equal(s.enabled, false);
    assert.equal(s.reason, 'backoff');
    assert.equal((await sourceEnabled(client, source, new Date(now.getTime() + 25 * 3600000))).enabled, true);
    r = await recordWall(client, source, now);
    assert.equal(r.hours, 72);
    r = await recordWall(client, source, now);
    assert.equal(r.manual, true);
    s = await sourceEnabled(client, source, new Date(now.getTime() + 999 * 3600000));
    assert.equal(s.enabled, false);
    assert.equal(s.reason, 'manual_disable');
    // recordClean does not lift a manual disable
    await recordClean(client, source);
    assert.equal((await sourceEnabled(client, source)).enabled, false);
    assert.equal((await sourceEnabled(client, 'zz-unknown-source')).enabled, true);
  });
});
