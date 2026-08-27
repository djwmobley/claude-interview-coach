#!/usr/bin/env node
// @ts-check
/**
 * Playwright screenshot capture for dashboard PR 3 verification (design reconciliation "Verification"
 * item 1 / noodle handoff doc). Boots createDashboardServer against the isolated test database (same
 * bootstrap this package's own test suite uses), seeds a small set of synthetic fixture rows so every
 * page has something to show, then walks every route at 1440x960 and 1100x900 with playwright-core
 * driving the system-installed Chrome (no browser download required), saving PNGs to test/screenshots/
 * (gitignored) and printing any console errors encountered.
 *
 * Deliberately NOT named *.test.js and NOT under test/: node --test's default file discovery would
 * otherwise try to run this as a test file. Invoke directly: `node scripts/capture-dashboard-screenshots.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { bootstrapTestDb } from '../bin/bootstrap-test-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'test', 'screenshots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findBrowserExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Routes to capture: name -> hash. Detail routes use ids seeded below. */
function buildRoutes(ids) {
  return [
    ['home', '#/'],
    ['jobs', '#/jobs'],
    ['job-detail', `#/jobs/${ids.listingId}`],
    ['pipeline', '#/pipeline'],
    ['followups', '#/followups'],
    ['review', '#/review'],
    ['runs', '#/runs'],
    ['run-detail', `#/runs/${ids.runId}`],
    ['reports', '#/reports'],
    ['report-view', `#/reports/${new Date().toISOString().slice(0, 10)}`],
    ['calendar', '#/calendar'],
    ['analytics', '#/analytics'],
    ['companies', '#/companies'],
    ['company-detail', `#/companies/${ids.companyNorm}`],
  ];
}

async function seedFixtures(withClient, createFollowup) {
  const ids = await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const listingRes = await c.query(
        `INSERT INTO ic_job_listings
           (title, company, company_norm, title_norm, location, location_norm, remote_mode, source, url, url_normalized,
            external_id, dedup_hash, status, prescore, noise_class, first_seen, last_seen, times_seen, record_kind, search_profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ok', now() - interval '3 days', now(), 1, 'listing', 'exec-default')
         RETURNING id`,
        ['Director of Platform Engineering', 'Acme Rivers Group', 'acme-rivers-group', 'director platform engineering',
          'Austin, TX', 'austin-tx', 'hybrid', 'greenhouse', 'https://boards.greenhouse.io/acmerivers/jobs/1000',
          'https://boards.greenhouse.io/acmerivers/jobs/1000', 'gh:1000', 'zz-screenshot-hash-1', 'interviewing', 82],
      );
      const listingId = Number(listingRes.rows[0].id);

      await c.query(
        `INSERT INTO ic_job_listings
           (title, company, company_norm, title_norm, location, location_norm, remote_mode, source, url, url_normalized,
            external_id, dedup_hash, status, prescore, noise_class, first_seen, last_seen, times_seen, record_kind, search_profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ok', now() - interval '10 days', now(), 1, 'listing', 'exec-default')`,
        ['VP of Digital Transformation', 'Northfield Logistics', 'northfield-logistics', 'vp digital transformation',
          'Remote', 'remote-us', 'remote', 'lever', 'https://jobs.lever.co/northfield/2000',
          'https://jobs.lever.co/northfield/2000', 'lv:2000', 'zz-screenshot-hash-2', 'new', 74],
      );

      await c.query(
        `INSERT INTO ic_job_events (listing_id, at, kind, from_status, to_status, actor)
         VALUES ($1, now() - interval '2 days', 'status', 'new', 'interviewing', 'dashboard')`,
        [listingId],
      );

      const runRes = await c.query(
        `INSERT INTO ic_scan_runs (profile, profile_rev, trigger, status, dry_run, config_hash, started_at, finished_at, stats, pages_by_source, errors)
         VALUES ('exec-default', 'fixturerev01', 'dashboard', 'ok', false, 'fixturehash01', now() - interval '1 hour', now() - interval '50 minutes',
                 '{"inserted":3,"seen":12}'::jsonb, '{"greenhouse":4,"lever":3}'::jsonb, '[]'::jsonb)
         RETURNING id`,
      );
      const runId = Number(runRes.rows[0].id);

      await c.query(
        `INSERT INTO ic_scan_run_items (run_id, listing_id, source, outcome, page_index) VALUES ($1,$2,$3,'new',1)`,
        [runId, listingId, 'greenhouse'],
      );

      await c.query('COMMIT');
      return { listingId, runId, companyNorm: 'acme-rivers-group' };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });

  // createFollowup (src/core/followups.js) owns the notify text[] shape and its own validation, so this
  // reuses it rather than hand-rolling the insert (the earlier hand-rolled attempt passed a boolean into
  // the text[] column and failed).
  await withClient((c) => createFollowup(c, {
    contact: 'Sample Recruiter', org: 'Acme Rivers Group', listing_id: ids.listingId,
    due_at: new Date(Date.now() + 86400000).toISOString(), channel: 'email',
    action: 'Follow up after interview', created_from: 'dashboard',
  }, { calendar: null }));

  return ids;
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    process.stdout.write('capture-dashboard-screenshots: no system Chrome/Edge executable found; skipping capture explicitly (not silently).\n');
    process.exitCode = 1;
    return;
  }

  const { testDsn, testDbName } = await bootstrapTestDb({ log: (m) => process.stdout.write(m + '\n') });
  process.env.PG_DSN = testDsn;
  process.env.JOBSEARCH_TEST_GUARD = '1';

  const { withClient, closePool } = await import('../src/core/db.js');
  const { createFollowup } = await import('../src/core/followups.js');
  const { ensureAuxSchema } = await import('../src/core/schema.js');
  const { loadConfig } = await import('../src/core/config.js');
  const { createDashboardServer } = await import('../src/dashboard/server.js');
  const { createCalendarCache } = await import('../src/dashboard/calendar-cache.js');

  process.stdout.write(`capture-dashboard-screenshots: seeding fixtures into "${testDbName}"\n`);
  await withClient((c) => ensureAuxSchema(c));
  const ids = await seedFixtures(withClient, createFollowup);

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-dashboard-screenshots-'));
  for (const dir of ['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports']) {
    fs.mkdirSync(path.join(outputRoot, dir), { recursive: true });
  }

  const deps = {
    withClient,
    config: loadConfig(),
    env: {
      OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
      GOOGLE_TOKEN_FILE: '', REMINDER_TO: 'reports@example.com',
      SCAN_CDP_URL: 'http://127.0.0.1:1', SCAN_PROFILE_DIR: outputRoot, CHROME_EXECUTABLE: null,
      JOBSEARCH_LOG_DIR: outputRoot, JOBSEARCH_CONFIG_DIR: outputRoot, LOG_LEVEL: 'silent', PG_DSN: testDsn,
    },
    calendar: async () => null,
    calendarCache: createCalendarCache(),
    scanRunner: {
      async start() { return { runId: ids.runId, pid: 1234 }; },
      status() { return { running: false, runId: null, pid: null, startedAt: null }; },
      armCancelBackstop() { return { forced_kill_available: false }; },
    },
    outputRoot,
    version: 'screenshot-capture',
    startedAt: new Date().toISOString(),
    healthBanner: [],
  };

  const app = createDashboardServer(deps);
  await app.listen(0, '127.0.0.1');
  const port = app.server.address().port;
  process.stdout.write(`capture-dashboard-screenshots: dashboard listening on http://127.0.0.1:${port}/\n`);

  const browser = await chromium.launch({ executablePath, headless: true });
  const consoleErrors = [];
  const viewports = [
    { label: '1440x960', width: 1440, height: 960 },
    { label: '1100x900', width: 1100, height: 900 },
  ];

  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      let currentRouteName = '(none)';
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push({ viewport: viewport.label, route: currentRouteName, text: `${msg.text()} @ ${JSON.stringify(msg.location())}` });
      });
      page.on('requestfailed', (request) => {
        consoleErrors.push({ viewport: viewport.label, route: currentRouteName, text: `requestfailed: ${request.url()} (${request.failure()?.errorText})` });
      });
      page.on('response', (response) => {
        if (response.status() >= 400) consoleErrors.push({ viewport: viewport.label, route: currentRouteName, text: `HTTP ${response.status()}: ${response.url()}` });
      });
      page.on('pageerror', (err) => {
        consoleErrors.push({ viewport: viewport.label, route: currentRouteName, text: `pageerror: ${err.message}\n${err.stack ?? ''}` });
      });

      for (const [name, hash] of buildRoutes(ids)) {
        currentRouteName = name;
        const url = `http://127.0.0.1:${port}/${hash}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        const outPath = path.join(SCREENSHOT_DIR, `${name}-${viewport.label}.png`);
        await page.screenshot({ path: outPath });
        process.stdout.write(`captured ${name} at ${viewport.label} -> ${path.relative(ROOT, outPath)}\n`);
      }
      await page.close();
    }

    // Keyboard walk / focus ring check (design reconciliation "Verification" item 4): Tab through Home
    // end to end and confirm a visible focus ring (the shared :focus-visible rule) actually appears on
    // each focusable control, not just that the CSS rule exists in the stylesheet.
    const kbPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await kbPage.goto(`http://127.0.0.1:${port}/#/`, { waitUntil: 'networkidle' });
    await kbPage.waitForTimeout(300);
    /** @type {Array<{ tag: string, outlineWidth: string, outlineStyle: string }>} */
    const focusSamples = [];
    for (let i = 0; i < 10; i++) {
      await kbPage.keyboard.press('Tab');
      const sample = await kbPage.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
      });
      if (sample) focusSamples.push(sample);
    }
    await kbPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'keyboard-focus-walk.png') });
    await kbPage.close();
    const noRing = focusSamples.filter((s) => s.outlineStyle === 'none' || s.outlineWidth === '0px');
    process.stdout.write(`\nkeyboard walk: ${focusSamples.length} focusable control(s) tabbed through, ${focusSamples.length - noRing.length} showed a visible outline.\n`);
    if (noRing.length > 0) {
      process.stdout.write(`  no visible focus ring on: ${noRing.map((s) => s.tag).join(', ')}\n`);
      consoleErrors.push({ viewport: '1440x960', route: 'home (keyboard walk)', text: `${noRing.length} focusable control(s) had no visible focus ring: ${noRing.map((s) => s.tag).join(', ')}` });
    }

    // Row-level / detail-level kbaction interaction pass (independent review comment 5440498360,
    // blocking finding 1 and its own stated blind spot: the original screenshot pass never actually
    // exercised j/k/Enter/digit/quick-stage shortcuts, only a Tab-focus walk on Home). Real key presses
    // via Playwright, real DOM/CSS class assertions, real API calls to confirm server-side effect.
    const kbCheck = { failures: [] };
    const interactPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    interactPage.on('pageerror', (err) => kbCheck.failures.push(`pageerror during kbaction pass: ${err.message}`));

    // 1) Jobs: bare j cursors the first row (visible .row-cursor class); Enter opens it (hash changes to
    // #/jobs/<id>).
    await interactPage.goto(`http://127.0.0.1:${port}/#/jobs`, { waitUntil: 'networkidle' });
    await interactPage.waitForTimeout(300);
    await interactPage.keyboard.press('j');
    await interactPage.waitForTimeout(100);
    const cursoredAfterJ = await interactPage.evaluate(() => Boolean(document.querySelector('.job-row.row-cursor')));
    if (!cursoredAfterJ) kbCheck.failures.push('Jobs: pressing j did not add .row-cursor to any row');
    await interactPage.keyboard.press('Enter');
    await interactPage.waitForTimeout(300);
    const hashAfterEnter = await interactPage.evaluate(() => location.hash);
    if (!/^#\/jobs\/\d+$/.test(hashAfterEnter)) kbCheck.failures.push(`Jobs: pressing Enter after j did not navigate to a job-detail hash (got "${hashAfterEnter}")`);

    // 2) Job detail: digit 3 sets stage to Shortlisted (button gains stage-btn--active + correct label);
    // n focuses the notes textarea.
    await interactPage.goto(`http://127.0.0.1:${port}/#/jobs/${ids.listingId}`, { waitUntil: 'networkidle' });
    await interactPage.waitForTimeout(300);
    await interactPage.keyboard.press('3');
    await interactPage.waitForTimeout(400);
    const shortlistedActive = await interactPage.evaluate(() => {
      const btn = document.querySelector('.stage-btn--active .stage-btn__label');
      return btn ? btn.textContent : null;
    });
    if (shortlistedActive !== 'Shortlisted') kbCheck.failures.push(`Job detail: pressing 3 did not activate the Shortlisted stage button (active label was "${shortlistedActive}")`);
    await interactPage.keyboard.press('n');
    await interactPage.waitForTimeout(100);
    const notesFocused = await interactPage.evaluate(() => document.activeElement?.classList.contains('notes-textarea') ?? false);
    if (!notesFocused) kbCheck.failures.push('Job detail: pressing n did not focus the notes textarea');

    // 3) Pipeline: j cursors the first active-group row; m quick-sets it to Maybe, surfacing the undo toast.
    await interactPage.goto(`http://127.0.0.1:${port}/#/pipeline`, { waitUntil: 'networkidle' });
    await interactPage.waitForTimeout(300);
    await interactPage.keyboard.press('j');
    await interactPage.waitForTimeout(100);
    const pipelineCursored = await interactPage.evaluate(() => Boolean(document.querySelector('.pipeline-active-groups .row-cursor')));
    if (!pipelineCursored) kbCheck.failures.push('Pipeline: pressing j did not add .row-cursor to any active-group row');
    else {
      await interactPage.keyboard.press('m');
      await interactPage.waitForTimeout(400);
      const undoToastShown = await interactPage.evaluate(() => Boolean(document.querySelector('.toast--undo')));
      if (!undoToastShown) kbCheck.failures.push('Pipeline: pressing m after j did not surface the undo toast (stage-set likely did not fire)');
    }

    await interactPage.close();
    if (kbCheck.failures.length > 0) {
      process.stdout.write(`\nkbaction interaction pass: ${kbCheck.failures.length} failure(s):\n`);
      for (const f of kbCheck.failures) process.stdout.write(`  ${f}\n`);
      for (const f of kbCheck.failures) consoleErrors.push({ viewport: '1440x960', route: 'kbaction interaction pass', text: f });
    } else {
      process.stdout.write('\nkbaction interaction pass: all row-nav/row-open/digit/notes-focus/row-stage checks passed.\n');
    }
  } finally {
    await browser.close();
    await app.close();
    await closePool();
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  if (consoleErrors.length > 0) {
    process.stdout.write(`\ncapture-dashboard-screenshots: ${consoleErrors.length} console error(s) captured:\n`);
    for (const e of consoleErrors) process.stdout.write(`  [${e.viewport} / ${e.route}] ${e.text}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\ncapture-dashboard-screenshots: no console errors across any page or viewport.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`capture-dashboard-screenshots FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
