// @ts-check
/**
 * Dashboard routes for the personal mail intake (sql/029): GET /api/mail-intake, POST /api/mail-intake/:id/dismiss,
 * GET /api/google/capabilities. Handlers are driven through the real router against the isolated test
 * database; no HTTP server, no network. Also checks the front-end wiring files for the lint rules that apply to
 * them (no innerHTML, textContent only).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { withClient } from '../src/core/db.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createRouter } from '../src/dashboard/router.js';
import { register } from '../src/dashboard/routes/mail-intake.js';
import { persistMailIntake } from '../src/core/mail-intake-store.js';
import { recordCapabilityOutcomes } from '../src/core/google-capability.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = `abcdef${String(process.pid).padStart(6, '0')}`.slice(0, 12);
/** @type {pg.Client} */
let c;
const router = createRouter();
/** @type {string[]} */
const notified = [];
register(router, /** @type {any} */ ({ withClient }), /** @type {any} */ ({ notifyChanged: (/** @type {string} */ k) => notified.push(k) }));

/** @param {string} method @param {string} url @returns {Promise<{ status: number, body: any }>} */
async function call(method, url) {
  const d = router.dispatch(new URL(url, 'http://x').pathname, method);
  assert.ok(d && 'route' in d, `route ${method} ${url}`);
  /** @type {{ status: number, body: any }} */
  const out = { status: 0, body: null };
  const res = /** @type {any} */ ({ statusCode: 0, setHeader() {}, end(/** @type {string} */ t) { out.status = res.statusCode; out.body = JSON.parse(t); } });
  try {
    await d.route.handler(/** @type {any} */ ({ req: {}, res, params: d.params, body: {}, query: new URL(url, 'http://x').searchParams }));
  } catch (err) {
    return { status: /** @type {any} */ (err).code === 'VALIDATION' ? 400 : 500, body: { error: String(/** @type {any} */ (err).message) } };
  }
  return out;
}

before(async () => {
  c = new pg.Client(pgConnectionConfig());
  await c.connect();
  await ensureAuxSchema(c);
});
beforeEach(async () => {
  await c.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P}%`]);
  await c.query('DELETE FROM ic_google_capability');
  notified.length = 0;
});
after(async () => {
  await c.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P}%`]);
  await c.query('DELETE FROM ic_google_capability');
  await c.end();
});

const row = (/** @type {string} */ n, /** @type {any} */ over = {}) => ({
  message_id: `${P}${n}`, thread_id: `th${P}${n}`, bucket: 'recruiter_like', signal: 'strong', from_addr: 's@firm.example', from_name: 'Sam', reply_to: null, reply_to_differs: false,
  subject: `Role ${n}`, snippet: 'Recruiting for a CIO.', msg_date: '2026-10-23T12:00:00.000Z', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], spam: false, body_unreadable: false, ...over,
});

describe('GET /api/mail-intake', () => {
  test('returns review items with the Gmail tab and a link, the unsorted list with subjects, and counts', async () => {
    await persistMailIntake(c, [row('aa'), row('bb', { bucket: 'unsorted', signal: null, subject: 'Lunch?' }), row('cc', { spam: true, labels: ['SPAM'] })], 'v1');
    const r = await call('GET', '/api/mail-intake');
    assert.equal(r.status, 200);
    const mine = r.body.items.filter((/** @type {any} */ i) => i.message_id.startsWith(P));
    assert.equal(mine.length, 2);
    const inbox = mine.find((/** @type {any} */ i) => !i.spam);
    assert.equal(inbox.tab, 'Promotions');
    assert.equal(inbox.link, `https://mail.google.com/mail/u/0/#all/${P}aa`);
    assert.equal(mine.find((/** @type {any} */ i) => i.spam).tab, 'Spam');
    assert.equal(r.body.unsorted.filter((/** @type {any} */ i) => i.message_id.startsWith(P))[0].subject, 'Lunch?');
    assert.ok(r.body.counts.recruiter_like >= 2);
  });
});

describe('POST /api/mail-intake/:id/dismiss', () => {
  test('dismisses the message and its thread, and tells the Review page to refresh', async () => {
    await persistMailIntake(c, [row('aa', { thread_id: `th${P}shared` }), row('bb', { thread_id: `th${P}shared` })], 'v1');
    const r = await call('POST', `/api/mail-intake/${P}aa/dismiss`);
    assert.equal(r.status, 200);
    assert.equal(r.body.dismissed, 2);
    assert.deepEqual(notified, ['review']);
    const after_ = await call('GET', '/api/mail-intake');
    assert.equal(after_.body.items.filter((/** @type {any} */ i) => i.message_id.startsWith(P)).length, 0);
  });

  test('an id that is not a Gmail message id is refused', async () => {
    const r = await call('POST', '/api/mail-intake/..%2Fevil/dismiss');
    assert.notEqual(r.status, 200);
  });
});

describe('GET /api/google/capabilities', () => {
  test('nothing recorded or nothing broken: broken false, no line', async () => {
    const empty = await call('GET', '/api/google/capabilities');
    assert.deepEqual([empty.body.broken, empty.body.line], [false, null]);
    await recordCapabilityOutcomes(c, [{ capability: 'read', ok: true, state: 'ok', missing: [] }], new Date());
    const ok = await call('GET', '/api/google/capabilities');
    assert.equal(ok.body.broken, false);
  });

  test('a broken capability: the line names it and the rows are returned', async () => {
    await recordCapabilityOutcomes(c, [
      { capability: 'read', ok: true, state: 'ok', missing: [] },
      { capability: 'send', ok: false, state: 'broken_invalid_grant', missing: [] },
    ], new Date());
    const r = await call('GET', '/api/google/capabilities');
    assert.equal(r.body.broken, true);
    assert.match(r.body.line, /^Gmail send BROKEN since \d{4}-\d{2}-\d{2} \(0 days\): read OK, last good send never\. Re-authorize on dashboard\.$/);
    assert.equal(r.body.capabilities.length, 2);
  });
});

describe('front-end files', () => {
  const files = ['components/mail-intake-section.js', 'components/google-capability-banner.js'].map((f) => path.join(HERE, '..', 'src', 'dashboard', 'public', f));

  test('use textContent-only DOM building: no innerHTML, outerHTML, insertAdjacentHTML, document.write, srcdoc', () => {
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|srcdoc/.test(text), false, f);
    }
  });

  test('the Gmail link goes through hLink only, and the section imports no raw anchor builder', () => {
    const text = fs.readFileSync(files[0], 'utf8');
    assert.match(text, /hLink\(/);
    assert.equal(/h\('a'/.test(text), false);
  });

  test('the Home banner reuses the existing Re-authorize control instead of building a second flow', () => {
    const text = fs.readFileSync(files[1], 'utf8');
    assert.match(text, /renderGoogleAuthRow/);
    assert.equal(/\/api\/google\/reauth/.test(text), false);
  });
});
