// @ts-check
/**
 * Gmail intake addendum (G1, G2; adversary amendments B3, B4, B5, B6, B9): the version-2 parsers and the
 * four new senders against the 2026-10 sanitized fixtures (test/fixtures/adapters/gmail-*-2.json). Each
 * fixture yields exactly the expected count and first-card fields; markers and incomplete counts are
 * independent of the card grammar.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  PARSER_SPECS, PARSERS, PARSER_INPUT, analyzeLinkedin, analyzeLensa, analyzeLadders, analyzeDice, analyzeEfinancialcareers,
  analyzeRemotehunter, analyzeJobs2web, decodeMailgunHref, isLensaHost, stripModeSuffix, identityHash,
} from '../src/adapters/gmail-parsers.js';
import { normalizeListing } from '../src/core/normalize.js';
import { readGmailFixture } from './helpers/scan-fixtures.js';

/** @param {string} name */
function fx(name) {
  return readGmailFixture(`adapters/gmail-${name}-2.json`);
}

/** @param {string} name @param {string} parser @param {any} [ctx] */
function run(name, parser, ctx = {}) {
  const f = fx(name);
  const spec = /** @type {any} */ (PARSER_SPECS)[parser];
  const body = spec.input === 'html' ? f.html : (f.text ?? '');
  return spec.analyze(body, f.now, { html: f.html, ...ctx });
}

describe('registry', () => {
  test('PARSER_SPECS drives PARSERS and PARSER_INPUT; the four new senders are registered', () => {
    assert.deepEqual(Object.keys(PARSERS).sort(), Object.keys(PARSER_SPECS).sort());
    assert.deepEqual(Object.keys(PARSER_INPUT).sort(), Object.keys(PARSER_SPECS).sort());
    for (const n of ['dice', 'efinancialcareers', 'remotehunter', 'jobs2web']) assert.ok(n in PARSER_SPECS, n);
    for (const spec of Object.values(PARSER_SPECS)) assert.ok(Number.isInteger(spec.version));
  });
});

describe('fixture counts and first cards (section 0 / 6 tables)', () => {
  const cases = /** @type {Array<[string, string, number, string|null, string|null, string|null]>} */ ([
    ['lensa-jobalert-digest', 'lensa', 22, 'VP Pharmacy Services - Remote', 'Martin\'s Point Health Care', null],
    ['lensa-jobalert-single', 'lensa', 22, 'Chief Information Officer (CIO)', 'Expert Executive Recruiters (EER Global)', null],
    ['lensa-aggregated', 'lensa', 22, 'Chief Technology & Transformation Officer - Healthcare (Remote)', 'NTT DATA, Inc․', null],
    ['lensa24', 'lensa', 16, 'Executive Chief Technology Officer, Defense (Remote Considered)', 'Ainabl', null],
    ['ladders-new-jobs', 'ladders', 1, 'Vice President of Product and Technology PMO', 'Workiva, Inc', 'Remote'],
    ['ladders-work-remotely', 'ladders', 10, 'Program Director for Construction Management (CCM)', 'Parsons', null],
    ['ladders-single-offer', 'ladders', 10, 'Client Transformation Director', 'Kraken', null],
    ['dice-intellisearch', 'dice', 1, null, 'DMS Vision Inc.', 'Remote'],
    ['dice-marketing', 'dice', 3, 'Chief Technology Officer', 'AmeriSave Mortgage Corporation', 'Remote'],
    ['efinancialcareers-jobs', 'efinancialcareers', 10, 'Technology Director, Managing Director', 'State Street Corporation', 'Princeton, United States'],
    ['remotehunter-weekly', 'remotehunter', 5, 'Senior Director, Head of Enterprise Clinical AI & Technology - Remote - The Cigna Group', 'Cigna Healthcare', null],
    ['linkedin-alert-control', 'linkedin', 6, 'Chief Technology Officer', 'Scratch Financial', 'United States'],
    ['indeed-alert-control', 'indeed-alert', 6, 'Chief Technology Officer (CTO)', 'Internet Sciences Inc', 'Remote'],
  ]);
  for (const [name, parser, count, title, company, location] of cases) {
    test(`${name}: ${count} listings`, () => {
      const r = run(name, parser);
      assert.equal(r.listings.length, count, JSON.stringify(r.listings.map((/** @type {any} */ l) => l.title)));
      const first = r.listings[0];
      if (title !== null) assert.equal(first.title, title);
      else assert.match(first.title, /^SAP OM&E Consultant \/ Solution Architect/);
      assert.equal(first.company, company);
      if (location !== null || name.startsWith('lensa') || name === 'ladders-work-remotely' || name === 'ladders-single-offer' || name === 'remotehunter-weekly') {
        if (name !== 'ladders-single-offer') assert.equal(first.location, location);
      }
      assert.ok(r.markers >= r.listings.length);
    });
  }
  test('jobs2web-blackveatch: 10 listings, company from the sender entry', () => {
    const r = run('jobs2web-blackveatch', 'jobs2web', { sender: { company: 'Black & Veatch' } });
    assert.equal(r.listings.length, 10);
    assert.equal(r.listings[0].title, 'Integrated BESS Execution Director');
    assert.equal(r.listings[0].company, 'Black & Veatch');
    assert.equal(r.listings[0].location, 'Overland Park, KS, US');
    assert.match(String(r.listings[0].externalId), /^jobs2web:careers\.bv\.com\/\d+$/);
    assert.doesNotMatch(String(r.listings[0].url), /\?/);
  });
  test('non-alert mail has no job markers: Ladders Resume Report and eFC news', () => {
    for (const [name, parser] of [['ladders-resume-report', 'ladders'], ['efinancialcareers-news', 'efinancialcareers']]) {
      const r = run(name, parser);
      assert.equal(r.listings.length, 0, name);
      assert.equal(r.markers, 0, name);
    }
  });
});

describe('LinkedIn v2 (positional blocks, B5)', () => {
  test('the control fixture yields the exact six titles', () => {
    const r = run('linkedin-alert-control', 'linkedin');
    assert.deepEqual(r.listings.map((/** @type {any} */ l) => l.title), [
      'Chief Technology Officer', 'Chief Technology Officer', 'VP of Product', 'VP, Global Technology Services',
      'Senior Vice President of Engineering', 'Operating Executive of AI & Software Engineering',
    ]);
    assert.deepEqual(r.listings.map((/** @type {any} */ l) => l.company), ['Scratch Financial', 'Journal Technologies', 'Curri', 'Shift Paradigm', 'Koalafi', 'Burtch Works']);
  });
  const card = (/** @type {string[]} */ lines, /** @type {string} */ id) => ['----------------------', ...lines, `View job: https://www.linkedin.com/comm/jobs/view/${id}/?x=1`].join('\n');
  test('a card with two lines is incomplete; an unseen badge is ignored', () => {
    const text = [card(['Only Title', 'Only Company'], '1234567'), card(['CTO', 'Acme', 'Austin, TX', 'Hiring fast'], '7654321')].join('\n');
    const r = analyzeLinkedin(text, new Date());
    assert.equal(r.incomplete, 1);
    assert.equal(r.listings.length, 1);
    assert.deepEqual([r.listings[0].title, r.listings[0].company, r.listings[0].location], ['CTO', 'Acme', 'Austin, TX']);
    assert.equal(r.markers, 2);
  });
  test('B5: a parsed title that does not match the HTML anchor text for the same job is dropped and counted', () => {
    const text = card(['Wrong Title', 'Acme', 'Austin, TX'], '7654321');
    const html = '<a href="https://www.linkedin.com/comm/jobs/view/7654321/?x=1">Chief Technology Officer</a>';
    const r = analyzeLinkedin(text, new Date(), { html });
    assert.equal(r.listings.length, 0);
    assert.equal(r.dropped.card_misaligned, 1);
    const ok = analyzeLinkedin(card(['Chief Technology Officer', 'Acme', 'Austin, TX'], '7654321'), new Date(), { html });
    assert.equal(ok.listings.length, 1);
  });
});

describe('Lensa v2 (any lensa.com ESP, B4, B9)', () => {
  test('Mailgun cards store the decoded lensa.com/cgw/<id> url; SendGrid cards keep the /ls/click href', () => {
    const digest = run('lensa-jobalert-digest', 'lensa');
    assert.match(String(digest.listings[0].url), /^https:\/\/lensa\.com\/cgw\/[a-z0-9]+$/);
    const single = run('lensa-jobalert-single', 'lensa');
    assert.match(String(single.listings[0].url), /^https:\/\/sg3email\.lensa\.com\/ls\/click/);
  });
  test('B9: a cgw card identity is token + mode-stripped title; a token-less card keeps the hash', () => {
    const digest = run('lensa-jobalert-digest', 'lensa');
    const first = digest.listings[0];
    assert.notEqual(first.externalId, `lensa:${identityHash(first.title, first.company, first.location)}`);
    const single = run('lensa-jobalert-single', 'lensa');
    const s0 = single.listings[0];
    assert.equal(s0.externalId, `lensa:${identityHash(s0.title, s0.company, s0.location)}`);
    assert.equal(stripModeSuffix('VP Pharmacy Services - Remote'), 'VP Pharmacy Services');
    assert.equal(stripModeSuffix('CTO (Remote Considered)'), 'CTO');
  });
  test('an anchor on evillensa.com wrapping a valid card table is rejected; host check is exact or dot-suffix', () => {
    const cardTable = '<table><tbody><tr><td><table><tbody><tr><td>x</td><td>Acme</td></tr><tr><td>CTO</td></tr></tbody></table></td></tr><tr><td>$1K-$2K / yr.</td></tr></tbody></table>';
    assert.equal(analyzeLensa(`<a href="https://evillensa.com/c/abc">${cardTable}</a>`, new Date()).listings.length, 0);
    assert.equal(analyzeLensa(`<a href="https://email.mg9.lensa.com/c/abc">${cardTable}</a>`, new Date()).listings.length, 1);
    assert.equal(isLensaHost('evillensa.com'), false);
    assert.equal(isLensaHost('lensa.com.evil.test'), false);
  });
  test('B4: a lensa anchor with a table but no title/company rows is a marker counted incomplete', () => {
    const r = analyzeLensa('<a href="https://email.mg3.lensa.com/c/abc"><table><tbody><tr><td>banner</td></tr></tbody></table></a>', new Date());
    assert.equal(r.markers, 1);
    assert.equal(r.incomplete, 1);
    assert.equal(r.listings.length, 0);
  });
  test('decodeMailgunHref: a valid token decodes; garbage is null, never a throw', () => {
    const form = 'd=x&l=' + encodeURIComponent('https://lensa.com/cgw/abc123?x=1');
    const tok = zlib.deflateSync(Buffer.from(form)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeMailgunHref(`https://email.mg1.lensa.com/c/${tok}`), 'https://lensa.com/cgw/abc123?x=1');
    assert.equal(decodeMailgunHref('https://email.mg1.lensa.com/c/notbase64!!'), null);
    assert.equal(decodeMailgunHref('not a url'), null);
  });
});

describe('Ladders v2 (templates A/B/C, B6)', () => {
  test('B and C store the tracker href as url; A keeps url null', () => {
    assert.match(String(run('ladders-new-jobs', 'ladders').listings[0].url), /^https:\/\/t\.ladders\.co\/f\/a\//);
    assert.match(String(run('ladders-work-remotely', 'ladders').listings[0].url), /^https:\/\/t\.ladders\.co\/f\/a\//);
    assert.equal(run('ladders-single-offer', 'ladders').listings[0].url, null);
    assert.equal(run('ladders-work-remotely', 'ladders').listings[0].salaryRaw, '$157K - $283K');
  });
  test('a mail with A and B cards counts each card once', () => {
    const a = '<table><tr><td><a href="https://t.ladders.co/f/a/x~~/y~/z" class="jobTitle">CTO</a><br><span class="jobCompanyAndLocation">| Acme | Remote</span></td></tr><tr><td><span id="jobs-company-container">Acme | Remote | $200K</span></td></tr></table>';
    const r = analyzeLadders(a, new Date());
    assert.equal(r.listings.length, 1);
    assert.equal(r.markers, 1);
  });
  test('B6: a title anchor off the Ladders tracker is incomplete; a company part with "$" is incomplete', () => {
    const off = '<td><a href="https://evil.test/f/a/x" class="jobTitle">CTO</a><span class="jobCompanyAndLocation">| Acme | Remote</span></td>';
    assert.equal(analyzeLadders(off, new Date()).incomplete, 1);
    const dollar = '<td><a class="mobileLink" href="https://t.ladders.co/f/a/x~~/y~/z">CTO</a> | $200K - $300K* </td>';
    const r = analyzeLadders(dollar, new Date());
    assert.equal(r.listings.length, 0);
    assert.equal(r.dropped.company_incomplete, 1);
  });
});

describe('new senders: grammar details', () => {
  test('Dice: job-detail url canonicalizes to dice:<uuid>', () => {
    const l = run('dice-intellisearch', 'dice').listings[0];
    assert.equal(normalizeListing(l).external_id, `dice:${String(l.url).split('/').pop()}`);
  });
  test('eFC: "Competitive" salary is null; url has no query; externalId efc:<id>', () => {
    const l = run('efinancialcareers-jobs', 'efinancialcareers').listings[0];
    assert.equal(l.salaryRaw, null);
    assert.doesNotMatch(String(l.url), /\?/);
    assert.match(String(l.externalId), /^efc:\d+$/);
  });
  test('RemoteHunter: Apply Now lines are never cards; deduped by uuid; remote declared', () => {
    const r = run('remotehunter-weekly', 'remotehunter');
    assert.equal(new Set(r.listings.map((/** @type {any} */ l) => l.externalId)).size, r.listings.length);
    assert.ok(r.listings.every((/** @type {any} */ l) => l.remoteDeclared === true));
    assert.equal(r.listings[0].salaryRaw, '$322.1k/yr');
    assert.ok(analyzeRemotehunter('Apply Now ( https://www.remotehunter.com/apply-with-ai/8f85d1da-1dec-4472-8505-1ae13f3d76bc )', new Date()).listings.length === 0);
  });
  test('jobs2web without a configured company is incomplete, never a listing with an empty company', () => {
    const r = analyzeJobs2web('<a href="http://careers.bv.com/job/X-Title-KS-1/123/">Title - Overland Park, KS, US</a>', new Date(), {});
    assert.equal(r.listings.length, 0);
    assert.equal(r.incomplete, 1);
  });
  test('analyzers never throw on empty input', () => {
    for (const fn of [analyzeDice, analyzeEfinancialcareers, analyzeRemotehunter, analyzeJobs2web, analyzeLadders, analyzeLensa, analyzeLinkedin]) {
      assert.deepEqual(fn('', new Date()).listings, []);
    }
  });
});
