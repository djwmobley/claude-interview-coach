// @ts-check
/**
 * src/apply/linkedin-button-prepare.js (auto-apply GAP 1): the integration layer wiring the read-only
 * Capability (goto/readJson) + the click probe + src/core/apply-target-persist.js, against fake
 * client/cap/session/budget -- no real database, no real browser. Lives under src/apply/ (not src/core/)
 * because it constructs a raw-Playwright click adapter -- test/safety.test.js's structural safety lint
 * forbids any `.click(` call surface outside src/apply/.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLinkedInListing } from '../src/apply/linkedin-button-prepare.js';
import { registryFrom } from '../src/apply/probe-registry.js';

const REGISTRY = registryFrom(['boards.greenhouse.io']);
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const ADAPTER_CFG = { dailyPages: 100, dailyDetails: 100 };

function fakeClient() {
  /** @type {any[]} */
  const queries = [];
  return { queries, async query(text, params) { queries.push({ text, params }); return { rows: [], rowCount: 0 }; } };
}

function baseDeps(overrides = {}) {
  return {
    adapterCfg: ADAPTER_CFG,
    probeRegistry: REGISTRY,
    reprobeAfterHours: 48,
    now: new Date('2026-09-03T12:00:00Z'),
    dryRun: false,
    lookup: publicLookup,
    log: () => {},
    reserveBudget: async () => ({ ok: true, remainingPages: 99, remainingDetails: 99 }),
    sleep: async () => {},
    ...overrides,
  };
}

const LISTING = { id: 1, url: null, url_normalized: 'https://www.linkedin.com/jobs/view/1/', apply_probed_at: null, probe_attempts: 0 };

describe('prepareLinkedInListing: anchor-href postings never click', () => {
  test('an anchor href never invokes the probe session at all', async () => {
    const client = fakeClient();
    let probeSessionTouched = false;
    const cap = {
      goto: async () => {},
      readJson: async () => ({ href: 'https://boards.greenhouse.io/acme/jobs/123', buttonOnly: false }),
    };
    const probeSession = {
      page: { url: async () => { probeSessionTouched = true; return ''; }, click: async () => { probeSessionTouched = true; } },
      session: { listTargets: async () => { probeSessionTouched = true; return []; }, closeTarget: async () => {} },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession }));
    assert.equal(result.outcome, 'resolved');
    assert.equal(probeSessionTouched, false);
    // Resolved against the anchor href itself, never the LinkedIn listing URL.
    assert.match(client.queries[0].text, /apply_url = \$2/);
    assert.equal(client.queries[0].params[1], 'https://boards.greenhouse.io/acme/jobs/123');
  });
});

describe('prepareLinkedInListing: button-only new_target', () => {
  test('a new target opening resolves apply_url/apply_ats', async () => {
    const client = fakeClient();
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    let listCalls = 0;
    const probeSession = {
      page: {
        url: async () => 'https://www.linkedin.com/jobs/view/1/',
        click: async () => {},
      },
      session: {
        listTargets: async () => {
          listCalls++;
          return listCalls === 1 ? [] : [{ id: 'new', url: 'https://boards.greenhouse.io/acme/jobs/123' }];
        },
        closeTarget: async () => {},
      },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession }));
    assert.equal(result.outcome, 'resolved');
    assert.equal(client.queries[0].params[1], 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(client.queries[0].params[2], 'greenhouse');
  });
});

describe('prepareLinkedInListing: button-only hint capture', () => {
  test('a same-tab hint is stored, apply_ats stays null', async () => {
    const client = fakeClient();
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    let urlCalls = 0;
    const probeSession = {
      page: {
        url: async () => {
          urlCalls++;
          return urlCalls === 1
            ? 'https://www.linkedin.com/jobs/view/1/'
            : 'https://www.linkedin.com/jobs/view/1/?applicantTrackingSystemName=workday&companyName=Acme';
        },
        click: async () => {},
      },
      session: { listTargets: async () => [], closeTarget: async () => {} },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession }));
    assert.equal(result.outcome, 'unresolved');
    const [{ text, params }] = client.queries;
    assert.doesNotMatch(text, /apply_ats = /);
    assert.match(text, /apply_ats_hint/);
    assert.match(JSON.stringify(params), /applicantTrackingSystemName.*workday/);
  });
});

describe('prepareLinkedInListing: timeout leaves apply_ats null, increments probe_attempts', () => {
  test('no new target, no hint within the deadline', async () => {
    const client = fakeClient();
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    const probeSession = {
      page: { url: async () => 'https://www.linkedin.com/jobs/view/1/', click: async () => {} },
      session: { listTargets: async () => [], closeTarget: async () => {} },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession, probeTimeoutMs: 5 }));
    assert.equal(result.outcome, 'unresolved');
    const [{ text, params }] = client.queries;
    assert.doesNotMatch(text, /apply_ats = /);
    assert.match(text, /probe_attempts = probe_attempts \+ 1/);
    assert.equal(params[0], LISTING.id);
  });
});

describe('prepareLinkedInListing: budget/session guards', () => {
  test('budget exhausted: never clicks, never writes, no probe_attempts increment', async () => {
    const client = fakeClient();
    let clicked = false;
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    const probeSession = {
      page: { url: async () => '', click: async () => { clicked = true; } },
      session: { listTargets: async () => [], closeTarget: async () => {} },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({
      cap, probeSession, reserveBudget: async () => ({ ok: false, remainingPages: 0, remainingDetails: 0 }),
    }));
    assert.equal(result.outcome, 'skipped_no_candidate');
    assert.equal(clicked, false);
    assert.equal(client.queries.length, 0);
  });

  test('no probe session available at all: never throws, skips cleanly', async () => {
    const client = fakeClient();
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession: null }));
    assert.equal(result.outcome, 'skipped_no_candidate');
    assert.equal(client.queries.length, 0);
  });

  test('dry run: never clicks even for a button-only listing', async () => {
    const client = fakeClient();
    let clicked = false;
    const cap = { goto: async () => {}, readJson: async () => ({ href: null, buttonOnly: true }) };
    const probeSession = {
      page: { url: async () => '', click: async () => { clicked = true; } },
      session: { listTargets: async () => [], closeTarget: async () => {} },
    };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession, dryRun: true }));
    assert.equal(clicked, false);
    assert.equal(result.outcome, 'skipped_dry_run');
    assert.equal(client.queries.length, 0);
  });

  test('cap.goto throwing (page unreachable) never throws out, skips cleanly', async () => {
    const client = fakeClient();
    const cap = { goto: async () => { throw new Error('nav failed'); }, readJson: async () => ({}) };
    const result = await prepareLinkedInListing(client, LISTING, baseDeps({ cap, probeSession: null }));
    assert.equal(result.outcome, 'skipped_no_candidate');
  });
});
