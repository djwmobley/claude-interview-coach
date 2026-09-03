// @ts-check
/**
 * fetchDetail widening (auto-apply PR B plan step 5): every scan adapter's fetchDetail now MAY return
 * externalApplyUrl/easyApplyOnly/applyProbe alongside description, but the legacy `{ description }` shape
 * (no new fields at all) must remain valid everywhere those fields cannot be determined. Exercised against
 * fully scripted fake ctx objects -- no real network, no live browser/DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { linkedin } from '../src/adapters/linkedin.js';
import { indeed } from '../src/adapters/indeed.js';
import { greenhouse } from '../src/adapters/greenhouse.js';
import { workday } from '../src/adapters/workday.js';
import { dayforce } from '../src/adapters/dayforce.js';
import { exec } from '../src/adapters/exec-generic.js';

/** @param {Record<string, any>} readJsonResponses */
function fakeCap(readJsonResponses = {}) {
  return {
    async goto() {},
    async readJson(name) {
      if (name in readJsonResponses) return readJsonResponses[name];
      return null;
    },
  };
}

function baseCtx(overrides = {}) {
  return {
    reserveDetail: async () => {},
    fetchJson: async () => ({ status: 404, url: '', json: null }),
    fetchText: async () => ({ status: 404, url: '', text: '', contentType: null }),
    capFor: async () => null,
    config: { execBoards: { boards: [] } },
    log: () => {},
    ...overrides,
  };
}

describe('fetchDetail widening: legacy shape stays valid', () => {
  test('linkedin: no capability available still returns a bare { description: null }', async () => {
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/123/', source: 'linkedin' }, baseCtx());
    assert.deepEqual(r, { description: null });
  });

  test('indeed: no url returns a bare { description: null }', async () => {
    const r = await indeed.fetchDetail({ url: null, source: 'indeed' }, baseCtx());
    assert.deepEqual(r, { description: null });
  });
});

describe('linkedin.js: anchor decoded / button-only hint only', () => {
  test('an anchor Apply href is surfaced as externalApplyUrl, easyApplyOnly false', async () => {
    const cap = fakeCap({
      linkedinApplyLink: { href: 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123', buttonOnly: false },
      linkedinJobDetail: { description: 'A great role.' },
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/123/', source: 'linkedin' }, ctx);
    assert.equal(r.description, 'A great role.');
    assert.equal(r.externalApplyUrl, 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123');
    assert.equal(r.easyApplyOnly, false);
  });

  test('an Easy Apply button with no href sets easyApplyOnly, never externalApplyUrl', async () => {
    const cap = fakeCap({
      linkedinApplyLink: { href: null, buttonOnly: true },
      linkedinJobDetail: { description: 'A great role.' },
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/123/', source: 'linkedin' }, ctx);
    assert.equal(r.externalApplyUrl, null);
    assert.equal(r.easyApplyOnly, true);
  });

  test('readJson throwing (extractor not wired in some capability build) never crashes fetchDetail', async () => {
    const cap = {
      async goto() {},
      async readJson(name) {
        if (name === 'linkedinApplyLink') throw new Error('boom');
        if (name === 'linkedinJobDetail') return { description: 'ok' };
        return null;
      },
    };
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/123/', source: 'linkedin' }, ctx);
    assert.equal(r.description, 'ok');
    assert.equal(r.externalApplyUrl, null);
    assert.equal(r.easyApplyOnly, false);
  });
});

describe('indeed.js: applystart is easy-only', () => {
  test('no external anchor found -> easyApplyOnly true (Indeed applystart flow)', async () => {
    const cap = fakeCap({
      indeedApplyState: { href: null, easyApplyOnly: true },
      readJsonLd: [],
      bodyText: 'A great role at Acme.',
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc123', source: 'indeed' }, ctx);
    assert.equal(r.easyApplyOnly, true);
    assert.equal(r.externalApplyUrl, null);
  });

  test('an "Apply on company site" anchor off indeed.com is surfaced as externalApplyUrl', async () => {
    const cap = fakeCap({
      indeedApplyState: { href: 'https://boards.greenhouse.io/acme/jobs/123', easyApplyOnly: false },
      readJsonLd: [],
      bodyText: 'A great role at Acme.',
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc123', source: 'indeed' }, ctx);
    assert.equal(r.easyApplyOnly, false);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
  });
});

describe('greenhouse.js / workday.js / dayforce.js: own listing URL surfaced as externalApplyUrl', () => {
  test('greenhouse: externalApplyUrl equals the listing URL', async () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/123';
    const ctx = baseCtx({ fetchJson: async () => ({ status: 200, url, json: { content: 'Job content' } }) });
    const r = await greenhouse.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.externalApplyUrl, url);
  });

  test('workday: externalApplyUrl equals the listing URL even when the description fetch fails', async () => {
    const url = 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Houston-TX/Director_R-12345';
    const ctx = baseCtx({ fetchJson: async () => ({ status: 500, url, json: null }) });
    const r = await workday.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.description, null);
    assert.equal(r.externalApplyUrl, url);
  });

  test('dayforce: externalApplyUrl equals the listing URL', async () => {
    const url = 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/12345';
    const ctx = baseCtx({ fetchText: async () => ({ status: 200, url, text: '<html><body>Great role</body></html>', contentType: 'text/html' }) });
    const r = await dayforce.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.externalApplyUrl, url);
  });
});

describe('exec-generic.js: HTML anchor apply-link extraction', () => {
  test('an anchor with "Apply" text is surfaced as a resolved absolute externalApplyUrl candidate', async () => {
    const url = 'https://execboard.example.com/jobs/42';
    const html = '<html><body><h1>CTO</h1><a href="https://boards.greenhouse.io/acme/jobs/123">Apply Now</a></body></html>';
    const ctx = baseCtx({
      fetchText: async () => ({ status: 200, url, text: html, contentType: 'text/html' }),
      config: { execBoards: { boards: [{ slug: 'execboard', mode: 'fetch' }] } },
    });
    const r = await exec.fetchDetail({ url, url_normalized: url, source: 'exec:execboard' }, ctx);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
  });

  test('no Apply-shaped anchor at all -> externalApplyUrl null, description still returned', async () => {
    const url = 'https://execboard.example.com/jobs/42';
    const html = '<html><body><h1>CTO</h1><p>A great role.</p></body></html>';
    const ctx = baseCtx({
      fetchText: async () => ({ status: 200, url, text: html, contentType: 'text/html' }),
      config: { execBoards: { boards: [{ slug: 'execboard', mode: 'fetch' }] } },
    });
    const r = await exec.fetchDetail({ url, url_normalized: url, source: 'exec:execboard' }, ctx);
    assert.equal(r.externalApplyUrl, null);
    assert.match(r.description, /A great role/);
  });
});
