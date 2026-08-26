// @ts-check
/**
 * Per-sender parser unit tests (spec: gmail-adapter-brief.md item 12) against
 * real captured, R14-scrubbed Gmail messages (test/fixtures/adapters/gmail-*.json).
 * Counts, tenant-qualified ids via normalizeUrl, url rewrites, salary/location
 * extraction, and the adversary cases: a spoofed display name with a
 * different address is never parsed (covered in gmail.test.js, which owns
 * sender dispatch); a non-registered host is never fetched (parsers never
 * fetch anything, they are pure text/html -> RawListing[] functions); a
 * message with two jobs sharing a title but different companies yields two
 * distinct rows (Lensa's duplicated "Senior Director, Cloud & Data Center
 * Infra & FinOps" / "... (Spring)" pair below).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkedin, parseIndeedAlert, parseIndeedMatch, parseLensa, parseLadders, identityHash, PARSERS, PARSER_INPUT } from '../src/adapters/gmail-parsers.js';
import { normalizeListing } from '../src/core/normalize.js';
import { readGmailFixture } from './helpers/scan-fixtures.js';

describe('gmail-parsers: PARSERS / PARSER_INPUT registry', () => {
  test('every parser name in PARSERS has an input-shape entry and vice versa', () => {
    assert.deepEqual(Object.keys(PARSERS).sort(), Object.keys(PARSER_INPUT).sort());
    assert.deepEqual(Object.keys(PARSERS).sort(), ['indeed-alert', 'indeed-match', 'ladders', 'lensa', 'linkedin']);
  });
});

describe('parseLinkedin', () => {
  test('digest with badges and preamble text: 6 jobs, badges never leak into title/company/location', () => {
    const { text, now } = readGmailFixture('adapters/gmail-linkedin-alert-1.json');
    assert.ok(text);
    const listings = parseLinkedin(/** @type {string} */ (text), now);
    assert.equal(listings.length, 6);
    for (const l of listings) {
      assert.doesNotMatch(l.title, /top applicant|actively hiring|apply with resume/i);
      assert.doesNotMatch(l.company ?? '', /top applicant|actively hiring|apply with resume/i);
      assert.doesNotMatch(l.location ?? '', /top applicant|actively hiring|apply with resume/i);
    }
    const cio = listings.find((l) => l.title === 'Chief Information Officer' && l.company === 'Archwell Capital');
    assert.ok(cio);
    assert.equal(cio.location, 'United States');
    assert.equal(cio.url, 'https://www.linkedin.com/jobs/view/4458294744');
    assert.equal(cio.externalId, null);
    assert.equal(cio.postedAt, '2026-08-25');
    const n = normalizeListing(cio);
    assert.equal(n.external_id, 'linkedin:4458294744');
    assert.equal(n.url_normalized, 'https://www.linkedin.com/jobs/view/4458294744');
  });

  test('"Jobs that match your profile" template: badge-free bare city locations', () => {
    const { text, now } = readGmailFixture('adapters/gmail-linkedin-jobsnoreply-1.json');
    const listings = parseLinkedin(/** @type {string} */ (text), now);
    assert.equal(listings.length, 6);
    const sysco = listings.find((l) => l.company === 'Sysco');
    assert.ok(sysco);
    assert.equal(sysco.title, 'Business Unit Chief Information Officer');
    assert.equal(sysco.location, 'Houston');
    assert.equal(sysco.postedAt, '2026-08-24');
  });

  test('single-job "your job alert for..." digest', () => {
    const { text, now } = readGmailFixture('adapters/gmail-linkedin-multi-1.json');
    const listings = parseLinkedin(/** @type {string} */ (text), now);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].title, 'VP, Information Technology Engineering');
    assert.equal(listings[0].company, 'Bestow');
    assert.equal(listings[0].location, 'Dallas, TX');
    assert.equal(listings[0].url, 'https://www.linkedin.com/jobs/view/4411293056');
  });

  test('no "View job:" lines at all yields zero listings, never throws', () => {
    assert.deepEqual(parseLinkedin('nothing to see here', new Date()), []);
  });
});

describe('parseIndeedAlert', () => {
  test('real jobalert.indeed.com digest: visible jk rewritten to /viewjob, salary and relative date extracted', () => {
    const { text, now } = readGmailFixture('adapters/gmail-indeed-jobalert-1.json');
    const listings = parseIndeedAlert(/** @type {string} */ (text), now);
    assert.equal(listings.length, 1);
    const l = listings[0];
    // Real captured title text contains an em-dash; written as a \u2014 escape (never a literal em-dash
    // character in this source file) so the repo-wide no-em-dash safety check stays clean while still
    // comparing the real byte-for-byte value the parser must preserve (source data, not authored prose).
    assert.equal(l.title, 'Fractional Chief Technology Officer (CTO) \u2014 Founding Team');
    assert.equal(l.company, 'Kolek');
    assert.equal(l.location, 'Remote');
    assert.equal(l.salaryRaw, '$75,000 - $100,000 a year');
    assert.equal(l.url, 'https://www.indeed.com/viewjob?jk=76413b8d35383832');
    assert.equal(l.externalId, null);
    assert.equal(l.postedAt, '2026-08-23', '"2 days ago" from 2026-08-25 message date');
    const n = normalizeListing(l);
    assert.equal(n.external_id, 'indeed:76413b8d35383832');
    assert.equal(n.salary_min, 75000);
    assert.equal(n.salary_max, 100000);
  });

  test('second real fixture: different job, same shape', () => {
    const { text, now } = readGmailFixture('adapters/gmail-indeed-jobalert-2.json');
    const listings = parseIndeedAlert(/** @type {string} */ (text), now);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].title, 'Chief Technology Officer');
    assert.equal(listings[0].company, 'Buggcy');
    assert.equal(listings[0].url, 'https://www.indeed.com/viewjob?jk=a8294cbe06bf4208');
  });

  test('zero-width characters are stripped before matching', () => {
    const text = 'Title​Line\nCompany - Remote\n$50,000 - $60,000 a year\ntoday\nhttps://www.indeed.com/rc/clk/dl?jk=aaaaaaaaaaaaaaaa';
    const listings = parseIndeedAlert(text, new Date('2026-08-25T00:00:00Z'));
    assert.equal(listings.length, 1);
    assert.equal(listings[0].title, 'Title​Line'.replace(/[​­͏]/g, ''));
  });

  test('a click link with no jk query param is not parsed as a job', () => {
    const text = 'Some Title\nSome Company - Remote\nhttps://www.indeed.com/rc/clk/dl?nojk=1';
    assert.deepEqual(parseIndeedAlert(text, new Date()), []);
  });
});

describe('parseIndeedMatch', () => {
  test('real match.indeed.com email: Benefits-anchored title/company/location, "Minimum base pay" salary, opaque residual url, indeed-mail hash id', () => {
    const { text, now } = readGmailFixture('adapters/gmail-indeed-match-1.json');
    const listings = parseIndeedMatch(/** @type {string} */ (text), now);
    assert.equal(listings.length, 1);
    const l = listings[0];
    assert.equal(l.title, 'VP, AI Transformation and Operational Excellence');
    assert.equal(l.company, 'Avalara');
    assert.equal(l.location, 'Remote');
    assert.equal(l.salaryRaw, '$250,000 a year');
    assert.ok(l.url && l.url.startsWith('https://cts.indeed.com/v3/'));
    const expectedHash = identityHash(l.title, l.company, l.location);
    assert.equal(l.externalId, `indeed-mail:${expectedHash}`);
    const n = normalizeListing(l);
    assert.equal(n.external_id, `gmail:indeed-mail:${expectedHash}`, 'residual url means normalizeListing falls back to raw.source-prefixed externalId');
    assert.equal(n.url_kind, 'residual');
  });

  test('no Benefits: and no View job: anchor yields zero listings', () => {
    assert.deepEqual(parseIndeedMatch('Hi there\n\nNothing structured here.', new Date()), []);
  });
});

describe('parseLensa', () => {
  test('real jobalert@lensa.com digest: 22 cards, salary K-abbreviation preserved raw, remote-only card with no location row', () => {
    const { html, now } = readGmailFixture('adapters/gmail-lensa-jobalert-1.json');
    const listings = parseLensa(/** @type {string} */ (html), now);
    assert.equal(listings.length, 22);
    const vp = listings.find((l) => l.company === 'Hobbsnews');
    assert.ok(vp);
    assert.equal(vp.title, 'Vice President, Professional Services Delivery North America');
    assert.equal(vp.location, 'Spring, TX');
    assert.equal(vp.salaryRaw, '$187K-$429K / yr.');
    const n = normalizeListing(vp);
    assert.equal(n.salary_min, 187000);
    assert.equal(n.salary_max, 429000);
    // Cotiviti's "Remote SVP..." card has no location row in the real markup (goes straight from salary to the flags row).
    const cotiviti = listings.find((l) => l.company === 'Cotiviti');
    assert.ok(cotiviti);
    assert.equal(cotiviti.location, null, 'no location row present in this card; must not be misread as the first flag word');
    assert.equal(cotiviti.remoteMode, 'remote');
    assert.equal(cotiviti.remoteDeclared, true);
  });

  test('real lensa24@lensa.com digest: some cards carry only a "Posted N ago" cell and no location', () => {
    const { html, now } = readGmailFixture('adapters/gmail-lensa24-1.json');
    const listings = parseLensa(/** @type {string} */ (html), now);
    assert.equal(listings.length, 16);
    const usajobs = listings.find((l) => l.company === 'USAJOBS');
    assert.ok(usajobs);
    assert.equal(usajobs.location, null);
    assert.equal(usajobs.postedAt, '2026-08-24', '"Posted 1 hour ago" from a message dated 2026-08-24T11:00Z');
  });

  test('two jobs sharing a title but different companies yield two distinct rows with different identity hashes', () => {
    const { html, now } = readGmailFixture('adapters/gmail-lensa-aggregated-1.json');
    const listings = parseLensa(/** @type {string} */ (html), now);
    const swift = listings.filter((l) => /Senior Director, Cloud & Data Center Infra & FinOps/.test(l.title));
    assert.ok(swift.length >= 2, 'the aggregated fixture repeats this title under two distinct postings');
    const ids = new Set(swift.map((l) => l.externalId));
    assert.equal(ids.size, swift.length, 'each distinct posting gets its own identity hash');
  });

  test('a link to a non-lensa.com host is never treated as a job card', () => {
    const html = '<a href="https://example.com/ls/click?upn=x"><table><tbody><tr><td><table><tbody><tr><td colspan="2">Co</td></tr><tr><td>Title</td></tr></tbody></table></td></tr></tbody></table></a>';
    assert.deepEqual(parseLensa(html, new Date()), []);
  });

  test('a non-job lensa.com link (fewer than 2 outer rows, e.g. "edit settings") is skipped', () => {
    const html = '<a href="https://sg3email.lensa.com/ls/click?upn=x">edit settings</a>';
    assert.deepEqual(parseLensa(html, new Date()), []);
  });
});

describe('parseLadders', () => {
  test('real jobs@my.theladders.com digest (no text/plain part): 10 cards via the jobs-company-container span', () => {
    const { html, now } = readGmailFixture('adapters/gmail-ladders-1.json');
    const listings = parseLadders(/** @type {string} */ (html), now);
    assert.equal(listings.length, 10);
    const nov = listings.find((l) => l.company === 'NOV, Inc.');
    assert.ok(nov);
    assert.equal(nov.title, 'Project Engineer');
    assert.equal(nov.location, 'Houston, TX');
    assert.equal(nov.salaryRaw, '$85K - $100K', 'trailing asterisk stripped');
    assert.equal(nov.url, null, 'no per-job link; brief item 6');
    const n = normalizeListing(nov);
    assert.equal(n.salary_min, 85000);
    assert.equal(n.salary_max, 100000);
    assert.ok(n.external_id && n.external_id.startsWith('gmail:ladders:'));
  });

  test('a card with only a single salary figure (no range) still parses', () => {
    const { html, now } = readGmailFixture('adapters/gmail-ladders-1.json');
    const listings = parseLadders(/** @type {string} */ (html), now);
    const single = listings.find((l) => l.salaryRaw === '$145K');
    assert.ok(single, 'at least one real card in the fixture has a single-figure salary');
  });

  test('no jobs-company-container spans at all yields zero listings', () => {
    assert.deepEqual(parseLadders('<html><body>nothing here</body></html>', new Date()), []);
  });
});

describe('identityHash (R5)', () => {
  test('normalizes before hashing: case/whitespace differences collapse to the same hash', () => {
    const a = identityHash('  Chief Technology   Officer ', 'Acme Inc.', 'Houston, TX');
    const b = identityHash('chief technology officer', 'ACME, INC', 'houston,  tx');
    assert.equal(a, b);
  });

  test('a different normalized field changes the hash', () => {
    const a = identityHash('CTO', 'Acme', 'Houston, TX');
    const b = identityHash('CTO', 'Acme', 'Dallas, TX');
    assert.notEqual(a, b);
  });
});
