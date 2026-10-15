// @ts-check
/**
 * Static guarantees for src/targets/ and the target config (target finder PR2, plan sections 10, 14.5, 14.6,
 * 14.7, 15): no send / write verb anywhere, one fetch path, closed reason sets, config lock membership, and
 * no personal contact in tracked files.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILES } from '../src/core/config.js';
import { FORM_D_REASONS } from '../src/targets/form-d.js';
import { EIGHT_K_REASONS } from '../src/targets/edgar-8k.js';
import { FTS_REASONS } from '../src/targets/edgar-fts.js';
import { ALERT_REASONS } from '../src/targets/google-alerts.js';
import { GAP_REASONS } from '../src/targets/gap-source.js';
import { COMMON_REASONS } from '../src/targets/outcomes.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { runFts } from '../src/targets/edgar-fts.js';
import { createReplayFetch, fastTiming, searchJson } from './helpers/targets-replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TARGETS_DIR = path.join(ROOT, 'src', 'targets');
const REPO_ROOT = path.join(ROOT, '..', '..');
const files = fs.readdirSync(TARGETS_DIR).filter((f) => f.endsWith('.js'));
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(TARGETS_DIR, f), 'utf8');

describe('no send path in target code', () => {
  test('src/targets/ contains no POST, PUT, DELETE, PATCH, sendmail, SMTP, or mail-send call', () => {
    assert.ok(files.length >= 10);
    for (const f of files) {
      const src = read(f);
      assert.ok(!/\b(?:POST|PUT|DELETE|PATCH)\b/.test(src), `${f}: write verb`);
      assert.ok(!/sendmail|sendMail|nodemailer|smtp|messages\/send|drafts\.create|users\.messages\.send/i.test(src), `${f}: mail send`);
      assert.ok(!/\bmethod\s*:\s*['"`](?!GET['"`])/.test(src), `${f}: non-GET method literal`);
    }
  });
  test('the only network call site is fetch-guard.js: no other file calls fetch(), http, https, net, or child_process', () => {
    for (const f of files) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (f !== 'fetch-guard.js') assert.ok(!/(?<![.\w])fetch\s*\(/.test(src), `${f}: fetch() call`);
      assert.ok(!/node:(?:http|https|net|tls|dgram|child_process)|require\(['"](?:http|https|net|child_process)/.test(src), `${f}: raw network or process module`);
      assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), `${f}: dynamic code`);
    }
  });
  test('fetch-guard issues exactly one fetch call and always with method GET', () => {
    const src = read('fetch-guard.js').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((src.match(/fetchImpl\(/g) ?? []).length, 1);
    assert.match(src, /method:\s*'GET'/);
  });
  test('the Gmail token refresh stays in the existing auth module: src/targets never imports google-auth-library or touches a token endpoint', () => {
    for (const f of files) {
      const src = read(f);
      assert.ok(!/google-auth-library|oauth2\.googleapis|accounts\.google\.com\/o\/oauth2|refresh_token|OAuth2Client/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), f);
    }
    assert.match(read('google-alerts.js'), /classifyAndConnect/);
  });
  test('regular expressions are built from operator config or blocked entries only, never from document text', () => {
    const where = files.filter((f) => /new RegExp\(/.test(read(f)));
    assert.deepEqual(where.sort(), ['google-alerts.js', 'signal-text.js', 'text-extract.js']);
    const te = read('text-extract.js').split(/\r?\n/).filter((l) => /new RegExp\(/.test(l));
    assert.equal(te.length, 5, 'every dynamic regex in text-extract.js is built from module constants');
    for (const l of te) assert.match(l, /\$\{(?:NAME_RE_SRC|CONTACT_TITLE_SRC|PARTY_NAME)\}/, l);
  });
  test('target code is not wired to any other module that sends: no import of the apply, mail, or reminder senders', () => {
    for (const f of files) assert.ok(!/from '\.\.\/(?:apply|core\/(?:remind|followups|documents|applications))/.test(read(f).replace(/from '\.\.\/apply\/exclusions\.js'/g, '')), f);
  });
});

describe('closed reason sets (plan 14.5)', () => {
  const SETS = { form_d: FORM_D_REASONS, edgar_8k: EIGHT_K_REASONS, edgar_fts: FTS_REASONS, google_alert: ALERT_REASONS, listings: GAP_REASONS };
  for (const [name, set] of Object.entries(SETS)) {
    test(`${name}: a frozen array of unique lowercase snake_case codes`, () => {
      assert.ok(Array.isArray(set) && Object.isFrozen(set));
      assert.equal(new Set(set).size, set.length);
      for (const r of set) assert.match(r, /^[a-z][a-z0-9_]*$/);
      assert.ok(set.includes('unknown_shape') || COMMON_REASONS.includes('unknown_shape'));
    });
  }
  test('the spec-named reasons exist in each adapter', () => {
    for (const r of ['xml_malformed', 'issuer_name_missing', 'accession_malformed', 'unknown_shape', 'fund_like_name_prefilter']) assert.ok(FORM_D_REASONS.includes(r), r);
    for (const r of ['section_not_found', 'no_date_at_all', 'hit_shape_unknown', 'doc_fetch_failed', 'no_cto_class_role', 'appointment_only', 'run_cap']) assert.ok(EIGHT_K_REASONS.includes(r), r);
    for (const r of ['hit_shape_unknown', 'doc_fetch_failed', 'company_missing', 'run_cap', 'query_disabled']) assert.ok(FTS_REASONS.includes(r), r);
    for (const r of ['html_missing', 'no_items_found', 'item_link_missing', 'pattern_matched_no_company', 'unknown_shape', 'label_unmapped', 'no_pattern_matched', 'run_cap']) assert.ok(ALERT_REASONS.includes(r), r);
    for (const r of ['no_hiring_leadership_listing', 'company_unresolved', 'listing_url_missing']) assert.ok(GAP_REASONS.includes(r), r);
    for (const r of ['adapter_exception', 'name_too_long', 'fetch_refused']) assert.ok(COMMON_REASONS.includes(r), r);
  });
  test('the retired gap_departure_not_ruled_out outcome exists nowhere in target code or rules', () => {
    for (const f of files) assert.ok(!read(f).includes('gap_departure_not_ruled_out'), f);
    assert.ok(!fs.readFileSync(path.join(ROOT, 'config', 'target-rules.json'), 'utf8').includes('gap_departure_not_ruled_out'));
  });
});

describe('document truncation is flagged (plan 15.2 item 6)', () => {
  test('a document over the read cap sets doc_truncated in extracted', async () => {
    const big = '<p>' + 'The company is a leader in packaging. '.repeat(12_000) + '</p>';
    assert.ok(big.length > 300 * 1024);
    const replay = createReplayFetch([
      { match: /search-index/, body: searchJson([{ adsh: '0008888888-26-000201', ciks: ['0008888888'], display_names: ['Globex Packaging Inc  (CIK 0008888888)'], file_date: '2026-10-08', form: '8-K', _id: '0008888888-26-000201:ex99.htm' }]) },
      { match: /ex99\.htm/, body: big },
    ]);
    const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: 'T t@corp.test' }), timing: fastTiming().timing });
    const out = await runFts({ edgar, now: new Date('2026-10-15T12:00:00Z'), blocked: ['Advisicon'], queries: [{ id: 'q', priority: 1, q: 'packaging', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true }] });
    assert.equal(out.items[0].outcome, 'parsed');
    assert.equal(out.items[0].extracted.doc_truncated, true);
  });
});

describe('config: lock membership, ignore rules, and no personal contact in tracked files', () => {
  const CONFIG_DIR = path.join(ROOT, 'config');
  test('the two routing files are config-locked; the SEC contact file and the fixtures are not', () => {
    assert.ok(CONFIG_FILES.includes('target-fts-queries.json'));
    assert.ok(CONFIG_FILES.includes('target-alert-patterns.json'));
    assert.ok(!CONFIG_FILES.includes('target-sec-contact.json'));
    assert.ok(!CONFIG_FILES.includes('target-sec-contact.example.json'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.lock.json'), 'utf8'));
    assert.ok(lock.files.includes('target-fts-queries.json') && lock.files.includes('target-alert-patterns.json'));
    assert.ok(!lock.files.includes('target-sec-contact.json'));
  });
  test('target-sec-contact.json is gitignored and the example is not', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(lines.includes('mcp/job-search/config/target-sec-contact.json'));
    assert.ok(!lines.includes('mcp/job-search/config/target-sec-contact.example.json'));
  });
  test('no tracked config, source, or fixture file contains the real SEC contact address', () => {
    const scan = [
      ...fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith('target-') && f !== 'target-sec-contact.json').map((f) => path.join(CONFIG_DIR, f)),
      ...files.map((f) => path.join(TARGETS_DIR, f)),
      path.join(ROOT, 'sql', '024_target_sources.sql'),
    ];
    for (const f of scan) assert.ok(!/djwmobley|gmail\.com/i.test(fs.readFileSync(f, 'utf8')), f);
  });
  test('the shipped routing configs enable nothing (Damian approves the enabled set)', () => {
    for (const f of ['target-fts-queries.json', 'target-alert-patterns.json']) {
      const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
      for (const [k, v] of Object.entries(j)) if (!k.startsWith('_')) assert.equal(/** @type {any} */ (v).enabled, false, `${f}:${k}`);
    }
  });
  test('US English and no em dashes in the new target code, config, SQL, tests, or fixtures', () => {
    const roots = [TARGETS_DIR, path.join(ROOT, 'test', 'fixtures', 'targets'), path.join(ROOT, 'test', 'helpers')];
    /** @type {string[]} */
    const all = [];
    const walk = (/** @type {string} */ d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
    for (const r of roots) walk(r);
    for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((n) => /^(?:targets-|migration-024)/.test(n))) all.push(path.join(ROOT, 'test', f));
    for (const f of fs.readdirSync(CONFIG_DIR).filter((n) => n.startsWith('target-'))) all.push(path.join(CONFIG_DIR, f));
    all.push(path.join(ROOT, 'sql', '024_target_sources.sql'));
    for (const f of all) {
      const t = fs.readFileSync(f, 'utf8');
      assert.ok(!t.includes('\u2014'), `${path.relative(ROOT, f)}: em dash`);
    }
  });
});
