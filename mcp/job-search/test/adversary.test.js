// @ts-check
/**
 * Stage 4 adversarial pass over the validation logic written by earlier
 * stages. Every case here is an input that must be REFUSED or routed to
 * ambiguous/review. Cases marked "found" were accepted by the code as
 * handed over and are covered by fixes in the same commit:
 *
 *   normalize: a declared hybrid/onsite work mode (or the words "hybrid" /
 *              "on-site" in a title) collapsed the location to remote-us,
 *              so a Houston onsite role and a Houston remote role shared a
 *              dedup hash and a cross-source pair could never corroborate.
 *   urlguard:  a registered host on a non-default port was allowed.
 *   render:    a line with one valid Year - Year range plus a stray en-dash
 *              passed; "leverages"/"utilizes"/... third-person forms passed;
 *              "This isn't an X problem, it's a Y problem" and "This is not an
 *              X problem. This is a Y problem." passed; a bare "PMP, 2015" in
 *              a resume passed (implies an active certification); a company
 *              line with a hyphen year range skipped the role-title comma
 *              check; Windows reserved device names were accepted as outName.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, makeMemoryLookups } from '../src/core/dedup.js';
import { normalizeListing } from '../src/core/normalize.js';
import { classifyUrl, registryFrom, checkResolvedAddresses, guardedFetch } from '../src/core/urlguard.js';
import { classifyPage } from '../src/browser/wall.js';
import { checkEnDash, checkBuzzwords, checkProblemComparison, checkPmpWording, checkResumeStructure, checkOutputName, checkScareQuotes, loadStyleConfig, preflight } from '../src/core/render.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const DAY = 86400000;

/** @param {Partial<import('../src/core/normalize.js').RawListing> & { source: string, url: string, title: string, company: string }} raw */
function rec(raw) {
  return normalizeListing(/** @type {any} */ ({ location: 'Houston, TX', postedAt: '2026-08-24', ...raw }));
}

/** A stored row built from a raw listing plus overrides. */
function row(/** @type {any} */ raw, /** @type {any} */ over = {}) {
  const n = rec(raw);
  return {
    id: 1, status: null, duplicate_of: null, repost_of: null, expired_at: null, record_kind: 'listing', last_seen: new Date(NOW.getTime() - DAY),
    source: n.source, external_id: n.external_id, url_normalized: n.url_normalized, title: n.title, company: n.company, company_norm: n.company_norm,
    title_norm: n.title_norm, location_norm: n.location_norm, dedup_hash: n.dedup_hash, description_hash: n.description_hash, posted_at: n.posted_at,
    salary_min: n.salary_min, salary_max: n.salary_max, ...over,
  };
}

describe('adversary: classify() refusals', () => {
  test('A1 found: a declared onsite role keeps its city (was remote-us) so it cannot silently merge with a remote role', () => {
    const onsite = rec({ source: 'lever', url: 'https://jobs.lever.co/acme/aaaaaaaa-0000-4000-8000-000000000001', title: 'CTO', company: 'Acme', remoteMode: 'onsite', remoteDeclared: true });
    const hybridTitle = rec({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'CTO (Hybrid)', company: 'Acme', remoteMode: 'hybrid', remoteDeclared: true });
    const remote = rec({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'CTO', company: 'Acme', location: 'Remote, US', remoteMode: 'remote', remoteDeclared: true });
    assert.equal(onsite.location_norm, 'houston-tx');
    assert.equal(onsite.remote_mode, 'onsite');
    assert.equal(hybridTitle.location_norm, 'houston-tx');
    assert.equal(hybridTitle.remote_mode, 'hybrid');
    assert.equal(remote.location_norm, 'remote-us');
    assert.notEqual(onsite.dedup_hash, remote.dedup_hash);
  });

  test('A2: same URL reused for a different title with no ids on either side is url_reuse, not an update', async () => {
    const stored = row({ source: 'manual', url: 'https://careers.example.com/jobs/apply?id=77', title: 'Chief Technology Officer', company: 'Acme' }, { external_id: null });
    const cand = rec({ source: 'manual', url: 'https://careers.example.com/jobs/apply?id=77', title: 'Staff Accountant', company: 'Acme' });
    const d = await classify({ ...cand, external_id: null }, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'url_reuse');
    assert.equal(d.queue, true);
  });

  test('A3: cross-source hash match with no corroboration (no description, dates 10 days apart, no salary) is never auto-merged', async () => {
    const stored = row({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'CTO', company: 'Acme', postedAt: '2026-08-10' });
    const cand = rec({ source: 'lever', url: 'https://jobs.lever.co/acme/aaaaaaaa-0000-4000-8000-000000000001', title: 'CTO', company: 'Acme', postedAt: '2026-08-24' });
    const d = await classify(cand, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'cross_source_uncorroborated');
  });

  test('A4: hash match where the stored side has an unknown location is ambiguous even with corroborating dates', async () => {
    const stored = row({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'CTO', company: 'Acme' }, { location_norm: 'legacy-unknown' });
    const cand = rec({ source: 'lever', url: 'https://jobs.lever.co/acme/aaaaaaaa-0000-4000-8000-000000000001', title: 'CTO', company: 'Acme' });
    // Different location strings hash differently; force the stored hash to the candidate's to simulate the legacy backfill.
    stored.dedup_hash = cand.dedup_hash;
    const d = await classify(cand, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'hash_location_unknown');
  });

  test('A5: same source, same hash, different id, seen 5 days ago is ambiguous (within the repost gap), not a repost', async () => {
    const stored = row({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'CTO', company: 'Acme' }, { last_seen: new Date(NOW.getTime() - 5 * DAY) });
    const cand = rec({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'CTO', company: 'Acme' });
    const d = await classify(cand, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'same_source_hash_within_gap');
  });

  test('A6: "C.T.O." at the same company as "Chief Technology Officer" in another city is title_similar_same_company', async () => {
    const stored = row({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Chief Technology Officer', company: 'Acme Inc.' });
    const cand = rec({ source: 'lever', url: 'https://jobs.lever.co/acme/aaaaaaaa-0000-4000-8000-000000000001', title: 'C.T.O.', company: 'Acme', location: 'Dallas, TX' });
    const d = await classify(cand, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'title_similar_same_company');
  });

  test('A7: external id match plus a URL that belongs to a different stored row is branch1_conflict', async () => {
    const a = row({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'CTO', company: 'Acme' }, { id: 1 });
    const b = row({ source: 'manual', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'CIO', company: 'Beta' }, { id: 2, external_id: null });
    const cand = rec({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'CTO', company: 'Acme' });
    const forced = { ...cand, external_id: a.external_id };
    const d = await classify(forced, makeMemoryLookups([a, b]), { now: NOW });
    assert.equal(d.branch, '4-ambiguous');
    assert.equal(d.reason, 'branch1_conflict');
    assert.deepEqual(d.matches, [1, 2]);
  });

  test('A8: a confidential exec-board listing with no description and a stored same-title row is queued (confidential_no_description)', async () => {
    const stored = row({ source: 'exec:east57th', url: 'https://www.east57th.com/opportunities/cto-1', title: 'Chief Technology Officer', company: 'Confidential', confidentialFirm: 'east57th' });
    const cand = rec({ source: 'exec:east57th', url: 'https://www.east57th.com/opportunities/cto-2', title: 'Chief Technology Officer', company: 'Confidential', confidentialFirm: 'east57th' });
    assert.ok(cand.company_norm.startsWith('confidential:'));
    const d = await classify(cand, makeMemoryLookups([stored]), { now: NOW });
    assert.equal(d.branch, '5-new');
    assert.equal(d.reason, 'confidential_no_description');
    assert.equal(d.queue, true);
  });
});

describe('adversary: URL guard refusals', () => {
  const reg = registryFrom([
    { source: 'linkedin', domains: ['linkedin.com'], pathPatterns: ['^/jobs/(search|view)/'] },
    { source: 'greenhouse', domains: ['boards-api.greenhouse.io', 'boards.greenhouse.io'], pathPatterns: ['^/v1/boards/[a-z0-9-]+/jobs(/\\d+)?(\\?|$)', '^/[a-z0-9-]+/jobs/\\d+/?(\\?|$)'] },
  ]);

  test('U1 found: a registered host on a non-default port is refused', () => {
    assert.equal(classifyUrl('https://www.linkedin.com:8443/jobs/view/1', reg).reason, 'nonstandard_port');
    assert.equal(classifyUrl('https://www.linkedin.com:443/jobs/view/1', reg).allowed, true, 'the default port is normalized away by the URL parser');
  });

  test('U2: look-alike hosts (suffix trick, embedded credentials, IDN dot, trailing dot) are refused', () => {
    assert.equal(classifyUrl('https://www.linkedin.com.evil.example/jobs/view/1', reg).reason, 'host_not_registered');
    assert.equal(classifyUrl('https://www.linkedin.com@evil.example/jobs/view/1', reg).reason, 'credentials_in_url');
    assert.equal(classifyUrl('https://www.linkedin.com。evil.example/jobs/view/1', reg).allowed, false);
    assert.equal(classifyUrl('https://www.linkedin.com./jobs/view/1', reg).reason, 'host_trailing_dot');
  });

  test('U3: IP literals in every spelling are refused before DNS', () => {
    for (const u of ['https://127.0.0.1/jobs/view/1', 'https://[::1]/jobs/view/1', 'https://0x7f000001/jobs/view/1', 'https://2130706433/jobs/view/1', 'https://[::ffff:127.0.0.1]/jobs/view/1']) {
      const v = classifyUrl(u, reg);
      assert.equal(v.allowed, false, u);
      assert.match(v.reason, /ip_literal|invalid_url/, u);
    }
  });

  test('U4: path traversal is normalized then refused; encoded slashes never match a pattern', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1/../../login', reg).reason, 'path_not_matching');
    assert.equal(classifyUrl('https://www.linkedin.com/jobs%2Fview/1', reg).reason, 'path_not_matching');
    assert.equal(classifyUrl('https://boards-api.greenhouse.io/v1/boards/acme/jobs/1/apply', reg).reason, 'path_not_matching');
  });

  test('U5: methods other than GET are refused everywhere except the listed POST paths; HEAD and PUT are refused', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { method: 'HEAD' }).reason, 'method_not_allowed');
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { method: 'PUT' }).reason, 'method_not_allowed');
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { method: 'POST' }).reason, 'post_not_allowed_for_path');
    assert.equal(classifyUrl('https://boards-api.greenhouse.io/v1/boards/acme/jobs', reg, { method: 'post' }).reason, 'post_not_allowed_for_path');
  });

  test('U6: DNS answers that include one private address anywhere in the list refuse the host', async () => {
    const cases = [
      [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      [{ address: '::ffff:192.168.1.1', family: 6 }],
      [{ address: '100.64.1.1', family: 4 }],
      [{ address: 'fd00::1', family: 6 }],
      [{ address: '64:ff9b::808:808', family: 6 }],
      [{ address: '0.0.0.0', family: 4 }],
    ];
    for (const answers of cases) {
      const r = await checkResolvedAddresses('www.linkedin.com', async () => answers);
      assert.equal(r.ok, false, JSON.stringify(answers));
    }
    assert.equal((await checkResolvedAddresses('www.linkedin.com', async () => [])).reason, 'dns_empty');
    assert.equal((await checkResolvedAddresses('www.linkedin.com', async () => { throw new Error('nx'); })).reason, 'dns_failed');
  });

  test('U7: a redirect from a registered host to an unregistered host, an http scheme, or a non-default port is refused mid-chain', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    for (const loc of ['https://evil.example/jobs/view/1', 'http://www.linkedin.com/jobs/view/1', 'https://www.linkedin.com:8080/jobs/view/1', 'https://www.linkedin.com/login']) {
      const fetchStub = /** @type {any} */ (async () => new Response('', { status: 302, headers: { location: loc } }));
      await assert.rejects(guardedFetch('https://www.linkedin.com/jobs/view/1', reg, { fetch: fetchStub, lookup }), (/** @type {any} */ e) => e.code === 'URL_REJECTED', loc);
    }
  });
});

describe('adversary: wall classification', () => {
  test('W1: zero parsed rows on a 200 with no empty-state marker is unrecognized and stops the source (never silently ok)', () => {
    const v = classifyPage({ parsed: 0, status: 200, url: 'https://www.linkedin.com/jobs/search/?keywords=cto' });
    assert.equal(v.kind, 'unrecognized');
    assert.equal(v.stopSource, true);
    assert.equal(v.code, 'UNRECOGNIZED_PAGE');
  });

  test('W2: login-wall paths in every spelling are walls; a query string mentioning login is not', () => {
    for (const u of ['https://www.linkedin.com/login', 'https://www.linkedin.com/uas/login?session_redirect=x', 'https://www.linkedin.com/checkpoint/challenge/', 'https://www.linkedin.com/authwall?trk=x', 'https://www.linkedin.com/LOGIN']) {
      assert.equal(classifyPage({ parsed: 0, status: 200, url: u }).kind, 'wall', u);
    }
    assert.equal(classifyPage({ parsed: 0, status: 200, url: 'https://www.linkedin.com/jobs/search/?redirect=/login', emptyState: true }).kind, 'empty');
  });

  test('W3: HTTP 403 and 429 are walls even with a 200-looking body; 401/503 with nothing parsed are still stopped', () => {
    assert.equal(classifyPage({ parsed: 0, status: 403 }).kind, 'wall');
    assert.equal(classifyPage({ parsed: 0, status: 429 }).kind, 'wall');
    assert.equal(classifyPage({ parsed: 0, status: 401 }).stopSource, true);
    assert.equal(classifyPage({ parsed: 0, status: 503 }).stopSource, true);
  });

  test('W4: NaN, negative, and string parsed counts are treated as zero, never as ok', () => {
    assert.notEqual(classifyPage(/** @type {any} */ ({ parsed: Number.NaN, status: 200 })).kind, 'ok');
    assert.notEqual(classifyPage(/** @type {any} */ ({ parsed: -3, status: 200 })).kind, 'ok');
    assert.notEqual(classifyPage(/** @type {any} */ ({ parsed: '5', status: 200 })).kind, 'ok');
  });

  test('W5: challenge markers are walls regardless of status; an empty cf-mitigated header is not a wall by itself', () => {
    assert.equal(classifyPage({ parsed: 0, status: 200, challengeCloudflare: true }).reason, 'cloudflare_challenge');
    assert.equal(classifyPage({ parsed: 0, status: 200, challengeForm: true }).reason, 'challenge_form');
    assert.equal(classifyPage({ parsed: 0, status: 200, recaptcha: true }).reason, 'recaptcha');
    assert.equal(classifyPage({ parsed: 0, status: 200, cfMitigated: 'challenge' }).reason, 'cf_mitigated');
    assert.equal(classifyPage({ parsed: 0, status: 200, cfMitigated: '' }).kind, 'unrecognized');
  });
});

describe('adversary: render_doc preflight', () => {
  const style = loadStyleConfig();

  test('R1 found: a line with a valid Year - Year range and a stray en-dash fails', () => {
    const r = checkEnDash(['Acme | Houston, TX | 2019 \u2013 2021', '· Supported 2019 \u2013 2021 growth \u2013 wrote the plan']);
    assert.equal(r.result, 'fail');
    assert.deepEqual(r.lines, [2]);
  });

  test('R2 found: third-person buzzword forms are caught', () => {
    for (const w of ['leverages', 'utilizes', 'orchestrates', 'champions', 'spearheads', 'unlocks', 'harnessing', 'utilization']) {
      assert.equal(checkBuzzwords([`· ${w} the platform`], style.buzzwords).result, 'fail', w);
    }
  });

  test('R3 found: problem-comparison reframes in their common variants are caught', () => {
    const cases = [
      "This isn't a technology problem, it's a people problem.",
      'This is not a technology problem. This is a people problem.',
      "It is no longer a tooling issue; it's a leadership issue.",
      'Growth was not a sales challenge but rather a systems challenge.',
      'This is less a technology problem than an operating model problem.',
    ];
    for (const c of cases) {
      const lines = ['x', c, 'y'];
      const r = checkProblemComparison(lines.join('\n'), lines, style.problemComparisonPatterns);
      assert.equal(r.result, 'fail', c);
      assert.deepEqual(r.lines, [2], c);
    }
    const clean = ['Cut ticket backlog by 40 percent; the problem was staffing.'];
    assert.equal(checkProblemComparison(clean.join('\n'), clean, style.problemComparisonPatterns).result, 'pass');
  });

  test('R4 found: in a resume any PMP line without the exact expired wording fails; cheat sheets may mention PMP in prose', () => {
    assert.equal(checkPmpWording(['PMP, Project Management Institute, 2015'], style.pmpExact, 'resume').result, 'fail');
    assert.equal(checkPmpWording(['Certified PMP'], style.pmpExact, 'resume').result, 'fail');
    assert.equal(checkPmpWording(['PMP (expired 2017), Project Management Institute'], style.pmpExact, 'resume').result, 'fail', 'case matters');
    assert.equal(checkPmpWording(['PMP (Expired 2017), Project Management Institute'], style.pmpExact, 'resume').result, 'pass');
    assert.equal(checkPmpWording(['If asked about the PMP: say it expired in 2017 and move on.'], style.pmpExact, 'cheatsheet').result, 'pass');
    assert.equal(checkPmpWording(['PMP (Lapsed 2017)'], style.pmpExact, 'cheatsheet').result, 'fail');
  });

  test('R5 found: a company line with a hyphen year range fails and still triggers the role-title comma check', () => {
    const lines = ['Jordan Reyes', 'contact', 'CTO | CIO', '---', 'summary', '---', 'a · b', '---', 'EXPERIENCE', 'Director, Program Management', 'Acme | Houston, TX | 2019 - 2021'];
    const r = checkResumeStructure(lines);
    assert.equal(r.result, 'fail');
    assert.ok(r.lines.includes(11), 'hyphen company line');
    assert.ok(r.lines.includes(10), 'comma in the title above it');
    assert.match(String(r.detail), /en-dash/);
    assert.match(String(r.detail), /commas/);
  });

  test('R6 found: reserved device names and dot-terminated names are refused as outName', () => {
    for (const n of ['CON', 'nul', 'COM1', 'lpt3', 'Jordan Reyes.']) {
      assert.equal(checkOutputName('resume', n, 'x').result, 'fail', n);
    }
    assert.equal(checkOutputName('resume', 'Jordan Reyes - CTO', 'x').result, 'pass');
  });

  test('R7: scare quotes with curly double quotes and inside parentheses are caught', () => {
    assert.equal(checkScareQuotes(['He was “aligned” with the board']).result, 'fail');
    assert.equal(checkScareQuotes(['Ran the program ("transformation") end to end']).result, 'fail');
    assert.equal(checkScareQuotes(['He said "we ship on Friday" and meant it']).result, 'pass', 'multi-word quotations are not scare quotes');
  });

  test('R8: a resume with a table, a # summary heading, and a - bullet fails preflight even with checkOnly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-render-'));
    const src = path.join(dir, 'bad.md');
    fs.writeFileSync(src, ['# Jordan Reyes', 'contact', 'CTO | CIO', '---', '## Summary', 'text', '---', 'a · b', '---', 'EXPERIENCE', 'CTO', 'Acme | Houston, TX | 2019 \u2013 2021', '- did things', '| a | b |', '|---|---|'].join('\n'));
    const pf = preflight({ kind: 'resume', source: 'bad.md', outName: 'Jordan Reyes - CTO', checkOnly: true }, { root: dir, style, companies: ['Acme'] });
    assert.equal(pf.ok, false);
    const structure = pf.checks.find((c) => c.name === 'resume_structure');
    assert.ok(structure && structure.result === 'fail');
    assert.match(String(structure.detail), /must not start with #/);
    assert.match(String(structure.detail), /# heading/);
    assert.match(String(structure.detail), /middle dot/);
    assert.match(String(structure.detail), /tables/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
