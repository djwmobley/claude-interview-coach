// @ts-check
/**
 * classifyApplyUrl() (src/apply/ats-detect.js, apply pipeline slice 2). Table-driven over the
 * spec-adversary amendments S1-S13: every canonical shape per ATS, the spoof set, regional Greenhouse
 * hosts, the embed/gh_jid confidence tiers, the myworkdaysite.com/dayforce-no-portal/tenant-null cases,
 * the html-iframe ambiguity rules, the total-input-guard garbage set, and tenant lowercasing. Pure
 * function, no DB or HTTP needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApplyUrl, CONFIDENCE_LEVELS, _resetAtsOptionsCache, hostsForAts } from '../src/apply/ats-detect.js';
import { ATS_TYPES } from '../src/core/applications.js';

/** @param {string} url @param {{html?:string}} [opts] */
function classify(url, opts) {
  return classifyApplyUrl(url, opts);
}

describe('classifyApplyUrl(): canonical exact shapes per ATS', () => {
  test('Greenhouse: boards.greenhouse.io/<tenant>/jobs/<id>', () => {
    assert.deepEqual(classify('https://boards.greenhouse.io/acme/jobs/12345'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
  });

  test('Greenhouse: v1/boards API path shape', () => {
    assert.deepEqual(classify('https://boards.greenhouse.io/v1/boards/acme/jobs/12345'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
  });

  test('Greenhouse: regional/API hosts (job-boards, boards.eu, boards-api, my)', () => {
    assert.deepEqual(classify('https://job-boards.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
    assert.deepEqual(classify('https://boards.eu.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
    assert.deepEqual(classify('https://boards-api.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
    assert.deepEqual(classify('https://my.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
  });

  test('Lever: jobs.lever.co/<tenant>/<uuid>', () => {
    assert.deepEqual(
      classify('https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555'),
      { ats: 'lever', tenant: 'acme', confidence: 'exact' },
    );
  });

  test('Lever: v0/postings API path shape and trailing /apply', () => {
    assert.deepEqual(
      classify('https://jobs.lever.co/v0/postings/acme/11111111-2222-3333-4444-555555555555'),
      { ats: 'lever', tenant: 'acme', confidence: 'exact' },
    );
    assert.deepEqual(
      classify('https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555/apply'),
      { ats: 'lever', tenant: 'acme', confidence: 'exact' },
    );
  });

  test('Lever: api.lever.co host', () => {
    assert.deepEqual(
      classify('https://api.lever.co/acme/11111111-2222-3333-4444-555555555555'),
      { ats: 'lever', tenant: 'acme', confidence: 'exact' },
    );
  });

  test('Workday: tenant.wdN.myworkdayjobs.com', () => {
    assert.deepEqual(classify('https://acme.wd5.myworkdayjobs.com/en-US/External/job/req123'), { ats: 'workday', tenant: 'acme', confidence: 'exact' });
    assert.deepEqual(classify('https://acme.wd12.myworkdayjobs.com/careers'), { ats: 'workday', tenant: 'acme', confidence: 'exact' });
  });

  test('LinkedIn: /jobs/view/ path', () => {
    assert.deepEqual(classify('https://www.linkedin.com/jobs/view/4378403522'), { ats: 'linkedin_easy', tenant: null, confidence: 'exact' });
  });

  test('LinkedIn: currentJobId query param', () => {
    assert.deepEqual(classify('https://www.linkedin.com/jobs/search/?currentJobId=4378403522'), { ats: 'linkedin_easy', tenant: null, confidence: 'exact' });
  });

  test('Indeed: viewjob?jk=', () => {
    assert.deepEqual(classify('https://www.indeed.com/viewjob?jk=abcdef0123456789'), { ats: 'indeed_easy', tenant: null, confidence: 'exact' });
  });

  test('Indeed: apply.indeed.com host', () => {
    assert.deepEqual(classify('https://apply.indeed.com/some/apply/path'), { ats: 'indeed_easy', tenant: null, confidence: 'exact' });
  });
});

describe('classifyApplyUrl(): confidence tiers (S6)', () => {
  test('Greenhouse embed for= is inferred, never exact', () => {
    const r = classify('https://boards.greenhouse.io/embed/job_app?for=acme&token=123');
    assert.deepEqual(r, { ats: 'greenhouse', tenant: 'acme', confidence: 'inferred' });
  });

  test('gh_jid on an arbitrary non-greenhouse host is greenhouse, tenant null, low', () => {
    const r = classify('https://careers.somecompany.com/apply?gh_jid=999888');
    assert.deepEqual(r, { ats: 'greenhouse', tenant: null, confidence: 'low' });
  });

  test('a registered Greenhouse host with no recognized path is greenhouse, tenant null, low', () => {
    const r = classify('https://boards.greenhouse.io/some/other/path');
    assert.deepEqual(r, { ats: 'greenhouse', tenant: null, confidence: 'low' });
  });

  test('a Greenhouse host embed with no usable for= param is low, never guesses a tenant', () => {
    const r = classify('https://boards.greenhouse.io/embed/job_app?token=123');
    assert.deepEqual(r, { ats: 'greenhouse', tenant: null, confidence: 'low' });
  });

  test('SmartRecruiters: ats certain, tenant always null (S5, no prior art)', () => {
    assert.deepEqual(classify('https://jobs.smartrecruiters.com/Acme/12345'), { ats: 'smartrecruiters', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://careers.smartrecruiters.com/Acme/12345'), { ats: 'smartrecruiters', tenant: null, confidence: 'low' });
  });

  test('iCIMS: any *.icims.com host, including careers-<x>/jobs-<x> prefixes, tenant always null (S5)', () => {
    assert.deepEqual(classify('https://acme.icims.com/jobs/123/job'), { ats: 'icims', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://careers-acme.icims.com/jobs/123/job'), { ats: 'icims', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://jobs-acme.icims.com/jobs/123/job'), { ats: 'icims', tenant: null, confidence: 'low' });
  });

  test('Dayforce host with no CandidatePortal path shape is low, tenant null', () => {
    const r = classify('https://acme.dayforcehcm.com/some/other/path');
    assert.deepEqual(r, { ats: 'dayforce', tenant: null, confidence: 'low' });
  });

  test('Dayforce CandidatePortal shape is inferred, tenant is the client segment', () => {
    const r = classify('https://acme.dayforcehcm.com/CandidatePortal/en-US/acmeclient/Posting/View/12345');
    assert.deepEqual(r, { ats: 'dayforce', tenant: 'acmeclient', confidence: 'inferred' });
  });
});

describe('classifyApplyUrl(): spoof / total-input-guard set (S1/S2)', () => {
  test('the userinfo trick resolves the host as the part AFTER @, not before -- unknown', () => {
    assert.deepEqual(classify('https://boards.greenhouse.io@evil.com/x'), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('a suffix-spoofed host is never treated as a subdomain of the real one', () => {
    assert.deepEqual(classify('https://evil-greenhouse.io/acme/jobs/1'), { ats: 'unknown', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://greenhouse.io.example.com/acme/jobs/1'), { ats: 'unknown', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://notdayforcehcm.com/CandidatePortal/en-US/x/Posting/View/1'), { ats: 'unknown', tenant: null, confidence: 'low' });
    assert.deepEqual(classify('https://evilicims.com/jobs/1/job'), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('myworkdaysite.com is explicitly NOT Workday', () => {
    assert.deepEqual(classify('https://acme.myworkdaysite.com/en-US/careers/job/req123'), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('a garbage/non-URL/non-string input never throws and always classifies unknown', () => {
    /** @type {unknown[]} */
    const garbage = [null, undefined, 123, '', '   ', 'mailto:x@y', 'javascript:void(0)', '//scheme-relative', 'not a url\n', {}, [], true];
    for (const g of garbage) {
      assert.doesNotThrow(() => classifyApplyUrl(g), `should not throw for ${JSON.stringify(g)}`);
      assert.deepEqual(classifyApplyUrl(g), { ats: 'unknown', tenant: null, confidence: 'low' }, `expected unknown for ${JSON.stringify(g)}`);
    }
  });

  test('http (not https) still classifies normally -- only the URL shape is total-guarded, not the scheme', () => {
    assert.deepEqual(classify('http://boards.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
  });
});

describe('classifyApplyUrl(): html iframe detection (S7)', () => {
  test('exactly one distinct Greenhouse iframe tenant is inferred', () => {
    const html = '<div><iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=1"></iframe></div>';
    assert.deepEqual(classify('https://careers.acme.com/cto', { html }), { ats: 'greenhouse', tenant: 'acme', confidence: 'inferred' });
  });

  test('two or more distinct iframe tenants on one page is unknown, never first-match-wins', () => {
    const html = [
      '<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=1"></iframe>',
      '<iframe src="https://boards.greenhouse.io/embed/job_app?for=widgetco&token=2"></iframe>',
    ].join('\n');
    assert.deepEqual(classify('https://aggregator.example.com/cto', { html }), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('the same tenant repeated across multiple iframes is still a single distinct tenant -- inferred', () => {
    const html = [
      '<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=1"></iframe>',
      '<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=2"></iframe>',
    ].join('\n');
    assert.deepEqual(classify('https://careers.acme.com/cto', { html }), { ats: 'greenhouse', tenant: 'acme', confidence: 'inferred' });
  });

  test('zero iframe matches falls through to the gh_jid rule, then unknown', () => {
    const html = '<div>no iframes here</div>';
    assert.deepEqual(
      classify('https://careers.acme.com/cto?gh_jid=555', { html }),
      { ats: 'greenhouse', tenant: null, confidence: 'low' },
    );
    assert.deepEqual(classify('https://careers.acme.com/cto', { html }), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('a non-Greenhouse iframe host is ignored, not counted toward ambiguity', () => {
    const html = '<iframe src="https://example.com/widget"></iframe>';
    assert.deepEqual(classify('https://careers.acme.com/cto', { html }), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('a malformed/relative iframe src never throws and is skipped, not guessed at', () => {
    const html = '<iframe src="/relative/path"></iframe><iframe src="not a url at all"></iframe>';
    assert.doesNotThrow(() => classify('https://careers.acme.com/cto', { html }));
    assert.deepEqual(classify('https://careers.acme.com/cto', { html }), { ats: 'unknown', tenant: null, confidence: 'low' });
  });

  test('html option is ignored on a URL that already resolves via a registered ATS host', () => {
    const html = '<iframe src="https://boards.greenhouse.io/embed/job_app?for=widgetco&token=1"></iframe>';
    assert.deepEqual(
      classify('https://boards.greenhouse.io/acme/jobs/1', { html }),
      { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' },
    );
  });
});

describe('classifyApplyUrl(): tenant is always lowercase (S10)', () => {
  test('an uppercase/mixed-case Greenhouse tenant segment is lowercased', () => {
    assert.deepEqual(classify('https://boards.greenhouse.io/ACME-Corp/jobs/1'), { ats: 'greenhouse', tenant: 'acme-corp', confidence: 'exact' });
  });

  test('an uppercase/mixed-case Lever tenant segment is lowercased', () => {
    assert.deepEqual(
      classify('https://jobs.lever.co/ACME/11111111-2222-3333-4444-555555555555'),
      { ats: 'lever', tenant: 'acme', confidence: 'exact' },
    );
  });

  test('an uppercase Workday subdomain tenant is lowercased', () => {
    assert.deepEqual(classify('https://ACME.wd5.myworkdayjobs.com/en-US/careers'), { ats: 'workday', tenant: 'acme', confidence: 'exact' });
  });

  test('an uppercase Greenhouse embed for= tenant is lowercased', () => {
    assert.deepEqual(
      classify('https://boards.greenhouse.io/embed/job_app?for=ACME'),
      { ats: 'greenhouse', tenant: 'acme', confidence: 'inferred' },
    );
  });

  test('an uppercase Dayforce client segment is lowercased', () => {
    assert.deepEqual(
      classify('https://acme.dayforcehcm.com/CandidatePortal/en-US/AcmeClient/Posting/View/1'),
      { ats: 'dayforce', tenant: 'acmeclient', confidence: 'inferred' },
    );
  });
});

describe('classifyApplyUrl(): totality against ATS_TYPES and CONFIDENCE_LEVELS', () => {
  test('every result this module can return has an ats in the real ATS_TYPES enum (src/core/applications.js), never a locally-redeclared copy', () => {
    const urls = [
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555',
      'https://acme.wd5.myworkdayjobs.com/careers',
      'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/1',
      'https://jobs.smartrecruiters.com/Acme/1',
      'https://acme.icims.com/jobs/1/job',
      'https://www.linkedin.com/jobs/view/1234567',
      'https://www.indeed.com/viewjob?jk=abc123',
      'https://totally-unrecognized.example.com/x',
    ];
    for (const url of urls) {
      const r = classify(url);
      assert.ok(ATS_TYPES.includes(r.ats), `${r.ats} (from ${url}) must be in ATS_TYPES`);
      assert.ok(CONFIDENCE_LEVELS.includes(r.confidence), `${r.confidence} (from ${url}) must be in CONFIDENCE_LEVELS`);
      assert.ok(r.tenant === null || typeof r.tenant === 'string', `tenant must be null or a string (from ${url})`);
    }
  });

  test('CONFIDENCE_LEVELS is exactly the closed three-value enum', () => {
    assert.deepEqual([...CONFIDENCE_LEVELS].sort(), ['exact', 'inferred', 'low']);
  });
});

describe('classifyApplyUrl(): _resetAtsOptionsCache test hook exists and is callable', () => {
  test('does not throw and does not change built-in classification results', () => {
    assert.doesNotThrow(() => _resetAtsOptionsCache());
    assert.deepEqual(classify('https://boards.greenhouse.io/acme/jobs/1'), { ats: 'greenhouse', tenant: 'acme', confidence: 'exact' });
  });
});

describe('hostsForAts (apply pipeline slice 5, per-page route policy widening)', () => {
  test('greenhouse and lever return their full registered host lists', () => {
    assert.deepEqual(hostsForAts('greenhouse'), ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'boards-api.greenhouse.io', 'my.greenhouse.io']);
    assert.deepEqual(hostsForAts('lever'), ['jobs.lever.co', 'api.lever.co']);
  });
  test('an ATS with no registry entry (workday, unknown) returns an empty array, never throws', () => {
    assert.deepEqual(hostsForAts('workday'), []);
    assert.deepEqual(hostsForAts('unknown'), []);
    assert.deepEqual(hostsForAts(/** @type {any} */ ('not-a-real-ats')), []);
  });
});
