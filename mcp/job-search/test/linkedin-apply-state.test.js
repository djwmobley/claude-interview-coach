// @ts-check
/**
 * src/apply/linkedin-apply-state.js (spec v1 F1.1/F1.2, v2 B2/B3/B4/B12): the pure page-state classifier.
 * Snapshot in, branch out: every case builds an observation from an HTML fixture (or a hand-built
 * observation) and classifies it with no browser, no database, and no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLinkedInApplyObservation, classifyLinkedInApplyState, LINKEDIN_APPLY_BRANCHES, isLinkedInHostUrl,
} from '../src/apply/linkedin-apply-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'linkedin-apply-state');
const JOB_URL = 'https://www.linkedin.com/jobs/view/4100000001/';

/** @param {string} name */
function html(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

/**
 * @param {string} markup
 * @param {{ url?: string, loadError?: string|null, httpStatus?: number|null }} [o]
 */
function classifyHtml(markup, o = {}) {
  const obs = buildLinkedInApplyObservation({ url: o.url ?? JOB_URL, html: markup, loadError: o.loadError ?? null, httpStatus: o.httpStatus ?? 200 });
  return classifyLinkedInApplyState(obs);
}

describe('classifyLinkedInApplyState: one fixture per branch (positive)', () => {
  test('the top card Easy Apply button classifies easy_apply, ignoring the rail, promoted card, and description', () => {
    const r = classifyHtml(html('easy-apply.html'));
    assert.equal(r.branch, 'easy_apply');
  });

  test('the sticky-header duplicate (same accessible name) counts as one control: easy_apply (spec v2 B3)', () => {
    assert.equal(classifyHtml(html('sticky-duplicate.html')).branch, 'easy_apply');
  });

  test('rail and promoted Easy Apply buttons for other jobs never count: no_control (spec v2 B2)', () => {
    assert.equal(classifyHtml(html('rail-promoted-only.html')).branch, 'no_control');
  });

  test('"No longer accepting applications" next to a disabled Easy Apply button: closed', () => {
    assert.equal(classifyHtml(html('closed.html')).branch, 'closed');
  });

  test('an "Applied 3 days ago" badge in the top card: already_applied (spec v2 B4)', () => {
    assert.equal(classifyHtml(html('applied.html')).branch, 'already_applied');
  });

  test('a sign-in wall rendered on the job URL: auth_wall', () => {
    assert.equal(classifyHtml(html('auth-wall.html')).branch, 'auth_wall');
  });

  test('a captcha security check rendered on the job URL: challenge', () => {
    assert.equal(classifyHtml(html('challenge.html')).branch, 'challenge');
  });

  test('a button-only external Apply: external, carrying a precise locator and its accessible name (spec v2 B5)', () => {
    const r = classifyHtml(html('external-apply.html'));
    assert.equal(r.branch, 'external');
    assert.ok(r.control, 'the external control is identified');
    assert.equal(r.control.href, null);
    assert.match(String(r.control.path), /^html > body > /);
    assert.match(String(r.control.name), /^apply to chief technology officer on company website$/);
  });

  test('an external Apply anchor with an off-LinkedIn href: external with that href, no click needed', () => {
    const markup = html('external-apply.html').replace(
      /<button type="button" class="jobs-apply-button h8e2dd"[^>]*>[\s\S]*?<\/button>/,
      '<a class="jobs-apply-button" href="https://boards.greenhouse.io/acme/jobs/123">Apply</a>',
    );
    const r = classifyHtml(markup);
    assert.equal(r.branch, 'external');
    assert.equal(r.control && r.control.href, 'https://boards.greenhouse.io/acme/jobs/123');
  });

  test('a navigation failure: load_failure', () => {
    const obs = buildLinkedInApplyObservation({ url: JOB_URL, html: null, loadError: 'TIMEOUT', httpStatus: null });
    assert.equal(classifyLinkedInApplyState(obs).branch, 'load_failure');
  });

  test('an HTTP 5xx: load_failure', () => {
    assert.equal(classifyHtml(html('easy-apply.html'), { httpStatus: 503 }).branch, 'load_failure');
  });

  test('a navigation that landed on /authwall (the URL guard refuses it) is auth_wall, not load_failure', () => {
    const obs = buildLinkedInApplyObservation({ url: 'https://www.linkedin.com/authwall?trk=x', html: null, loadError: 'URL_REJECTED', httpStatus: null });
    assert.equal(classifyLinkedInApplyState(obs).branch, 'auth_wall');
  });

  test('a navigation that landed on /checkpoint/challenge is challenge, checked before auth_wall', () => {
    const obs = buildLinkedInApplyObservation({ url: 'https://www.linkedin.com/checkpoint/challenge/abc', html: null, loadError: 'URL_REJECTED', httpStatus: null });
    assert.equal(classifyLinkedInApplyState(obs).branch, 'challenge');
  });
});

describe('classifyLinkedInApplyState: reordered DOM (no positional or adjacency assumptions)', () => {
  test('the reordered page classifies exactly like the original', () => {
    assert.equal(classifyHtml(html('reordered.html')).branch, 'easy_apply');
  });

  test('every fixture keeps its branch when the top card controls are wrapped in extra containers', () => {
    for (const [name, branch] of [['easy-apply.html', 'easy_apply'], ['external-apply.html', 'external'], ['closed.html', 'closed'], ['applied.html', 'already_applied']]) {
      const wrapped = html(name).replace(/<div class="k3m9qq">/, '<div class="k3m9qq"><section><div class="w1"></div></section>');
      assert.equal(classifyHtml(wrapped).branch, branch, name);
    }
  });
});

describe('classifyLinkedInApplyState: negative cases never set easy_apply', () => {
  test('no h1 and no usable job title in <title>: no top card, unknown', () => {
    const markup = html('easy-apply.html').replace(/<h1[^>]*>[\s\S]*?<\/h1>/, '<div>Chief Technology Officer</div>').replace(/<title>[^<]*<\/title>/, '<title>LinkedIn</title>');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('two job-title h1 elements (ambiguous top card) is unknown', () => {
    const markup = html('easy-apply.html').replace('<h1 class="t-24 f9x2rl">Chief Technology Officer</h1>', '<h1>Chief Technology Officer</h1><h1>Other</h1>');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('an h1 inside a dialog only is not a top card: unknown', () => {
    const markup = '<html lang="en"><body><div role="dialog"><h1>Apply to Acme</h1><button>Easy Apply</button></div></body></html>';
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('Applied Materials as the company name with no badge is not already_applied', () => {
    const markup = html('applied.html').replace('<div class="ok1"><span>Applied 3 days ago</span></div>', '')
      .replace(/<a href="https:\/\/www\.linkedin\.com\/jobs\/view\/4100000001\/application\/">See application<\/a>/, '<button type="button" aria-label="Easy Apply to Chief Technology Officer at Applied Materials"><span>Easy Apply</span></button>');
    assert.equal(classifyHtml(markup).branch, 'easy_apply');
  });

  test('a localized page (lang de) is unknown even with a recognizable control', () => {
    const markup = html('easy-apply.html').replace('<html lang="en">', '<html lang="de">');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('localized control text with no lang attribute is no_control, never easy_apply', () => {
    const markup = html('easy-apply.html').replace('<html lang="en">', '<html>')
      .replace('aria-label="Easy Apply to Chief Technology Officer at Acme Corp" id="ember42"><span class="artdeco-button__text">Easy Apply</span>', 'aria-label="Einfach bewerben" id="ember42"><span class="artdeco-button__text">Einfach bewerben</span>');
    const r = classifyHtml(markup);
    assert.notEqual(r.branch, 'easy_apply');
  });

  test('every branch value is in the closed branch list', () => {
    for (const f of fs.readdirSync(FIX).filter((n) => n.endsWith('.html'))) assert.ok(LINKEDIN_APPLY_BRANCHES.includes(classifyHtml(html(f)).branch), f);
  });
});

describe('classifyLinkedInApplyState: adversarial', () => {
  test('two Easy Apply buttons with DIFFERENT accessible names inside the top card: unknown', () => {
    const markup = html('easy-apply.html').replace(
      '<button type="button" class="jobs-save-button"',
      '<button type="button" aria-label="Easy Apply to VP Engineering at Beta"><span>Easy Apply</span></button><button type="button" class="jobs-save-button"',
    );
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('the only Easy Apply button is disabled (no closed text): unknown, never easy_apply', () => {
    const markup = html('easy-apply.html').replace('id="ember42"', 'id="ember42" disabled');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('aria-disabled="true" counts as disabled', () => {
    const markup = html('easy-apply.html').replace('id="ember42"', 'id="ember42" aria-disabled="true"');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('closed text next to an ENABLED Easy Apply button: closed wins (checked first)', () => {
    const markup = html('easy-apply.html').replace('<div class="k3m9qq">', '<div class="k3m9qq"><span>No longer accepting applications</span>');
    assert.equal(classifyHtml(markup).branch, 'closed');
  });

  test('closed text only in the description body is NOT closed (top card only, spec v2 B4)', () => {
    // easy-apply.html's description already says "no longer accepting paper resumes" and "Applied 3 days ago".
    assert.equal(classifyHtml(html('easy-apply.html')).branch, 'easy_apply');
  });

  test('an Easy Apply button whose aria-label contains Submit: unknown', () => {
    const markup = html('easy-apply.html').replace('aria-label="Easy Apply to Chief Technology Officer at Acme Corp"', 'aria-label="Submit application"');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('an Easy Apply text with an aria-label that does not start with "Easy Apply to": unknown', () => {
    const markup = html('easy-apply.html').replace('aria-label="Easy Apply to Chief Technology Officer at Acme Corp"', 'aria-label="Continue"');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('an external Apply whose aria-label contains Submit: unknown', () => {
    const markup = html('external-apply.html').replace('aria-label="Apply to Chief Technology Officer on company website"', 'aria-label="Apply and Submit"');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('Easy Apply and an external Apply together in the top card: unknown (spec v2 B3)', () => {
    const markup = html('easy-apply.html').replace(
      '<button type="button" class="jobs-save-button"',
      '<button type="button" aria-label="Apply to Chief Technology Officer on company website"><span>Apply</span></button><button type="button" class="jobs-save-button"',
    );
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('two different external Apply controls: unknown', () => {
    const markup = html('external-apply.html').replace(
      '<button type="button" aria-label="Save',
      '<a href="https://jobs.lever.co/acme/1">Apply now</a><button type="button" aria-label="Save',
    );
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('an Easy Apply button hidden by the hidden attribute or aria-hidden never counts', () => {
    const hidden = html('easy-apply.html').replace('id="ember42"', 'id="ember42" hidden');
    assert.equal(classifyHtml(hidden).branch, 'no_control');
    const ariaHidden = html('easy-apply.html').replace('<div class="k3m9qq">', '<div class="k3m9qq" aria-hidden="true">');
    assert.equal(classifyHtml(ariaHidden).branch, 'no_control');
  });

  test('an Easy Apply button inside an open dialog in the top card never counts', () => {
    const markup = html('rail-promoted-only.html').replace(
      '<div class="k3m9qq">',
      '<div class="k3m9qq"><div role="dialog"><button type="button" aria-label="Easy Apply to Chief Technology Officer at Acme Corp">Easy Apply</button></div>',
    );
    assert.equal(classifyHtml(markup).branch, 'no_control');
  });

  test('an external href on a linkedin.com host is unknown, not external (spec v2 B12)', () => {
    const markup = html('external-apply.html').replace(
      /<button type="button" class="jobs-apply-button h8e2dd"[^>]*>[\s\S]*?<\/button>/,
      '<a href="https://www.linkedin.com/jobs/view/4100000001/apply/">Apply</a>',
    );
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });

  test('a /safety/go/ href that decodes off LinkedIn is external with the decoded URL; one that decodes back to LinkedIn is unknown', () => {
    const off = html('external-apply.html').replace(
      /<button type="button" class="jobs-apply-button h8e2dd"[^>]*>[\s\S]*?<\/button>/,
      `<a href="https://www.linkedin.com/safety/go/?url=${encodeURIComponent('https://boards.greenhouse.io/acme/jobs/9')}">Apply</a>`,
    );
    const r = classifyHtml(off);
    assert.equal(r.branch, 'external');
    assert.equal(r.control && r.control.href, 'https://boards.greenhouse.io/acme/jobs/9');
    const back = html('external-apply.html').replace(
      /<button type="button" class="jobs-apply-button h8e2dd"[^>]*>[\s\S]*?<\/button>/,
      `<a href="https://www.linkedin.com/safety/go/?url=${encodeURIComponent('https://www.linkedin.com/jobs/view/1/')}">Apply</a>`,
    );
    assert.equal(classifyHtml(back).branch, 'unknown');
  });

  test('auth wall beats an Easy Apply button on the same page', () => {
    const markup = html('easy-apply.html').replace('<main class="q8z1pw">', '<main class="q8z1pw"><div class="authwall"></div>');
    assert.equal(classifyHtml(markup).branch, 'auth_wall');
  });

  test('a null or empty snapshot is unknown or load_failure, never easy_apply', () => {
    assert.equal(classifyLinkedInApplyState(/** @type {any} */ (null)).branch, 'unknown');
    assert.equal(classifyHtml('').branch, 'unknown');
  });
});

describe('live snapshots 2026-10-06: the server-driven layout with no h1 (sanitized)', () => {
  const LIVE = path.join(FIX, 'live-2026-10-06');
  const expected = { 9698: 'external', 9709: 'closed', 6709: 'external', 14581: 'easy_apply', 11960: 'easy_apply', 14007: 'external' };
  for (const [id, branch] of Object.entries(expected)) {
    test(`listing ${id} classifies ${branch}`, () => {
      const markup = fs.readFileSync(path.join(LIVE, `${id}.html`), 'utf8');
      assert.doesNotMatch(markup, /<h1[\s>]/i, 'the live layout really has no h1');
      const r = classifyHtml(markup);
      assert.equal(r.branch, branch, `${id}: ${r.reason}`);
      if (branch === 'external') {
        assert.ok(r.control && r.control.href && !/linkedin\.com/.test(r.control.href), 'the safety/go href decodes off LinkedIn');
      }
    });
  }

  test('a sticky duplicate of the live Easy Apply button (same name) still classifies easy_apply', () => {
    const markup = fs.readFileSync(path.join(LIVE, '14581.html'), 'utf8')
      .replace('<button type="button" aria-label="Easy Apply to this job">', '<button type="button" aria-label="Easy Apply to this job">Easy Apply</button><button type="button" aria-label="Easy Apply to this job">');
    assert.equal(classifyHtml(markup).branch, 'easy_apply');
  });

  test('live Easy Apply plus an external Apply in the same scope is unknown', () => {
    const markup = fs.readFileSync(path.join(LIVE, '14581.html'), 'utf8')
      .replace('<button type="button" aria-label="Easy Apply to this job">', '<a href="https://boards.greenhouse.io/x/jobs/1" aria-label="Apply on company website">Apply</a><button type="button" aria-label="Easy Apply to this job">');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });
});

describe('no-h1 layout: the scope is anchored on the apply controls, never on a rail or promoted card', () => {
  const shell = (/** @type {string} */ inner) => `<!doctype html><html lang="en"><head><title>Chief Technology Officer | Acme Corp | LinkedIn</title></head><body><main>${inner}</main></body></html>`;
  const topCard = (/** @type {string} */ controls) => `<section aria-label="Primary content"><div><div><p>Acme Corp</p><p>Chief Technology Officer</p><span>Houston, TX</span></div><div>${controls}</div></div></section>`;
  const railCard = '<aside><ul><li><a href="https://www.linkedin.com/jobs/view/4999000111/">VP Engineering</a><button type="button" aria-label="Easy Apply to VP Engineering at Beta">Easy Apply</button></li></ul></aside>';
  const inlineCard = '<div><a href="https://www.linkedin.com/jobs/view/4999000222/">Chief Technology Officer</a><button type="button" aria-label="Easy Apply to this job">Easy Apply</button></div>';

  test('a top card with Easy Apply next to a rail card with Easy Apply: easy_apply from the top card only', () => {
    assert.equal(classifyHtml(shell(topCard('<button type="button" aria-label="Easy Apply to this job">Easy Apply</button>') + railCard)).branch, 'easy_apply');
  });

  test('only rail or promoted cards carry an apply control: never easy_apply', () => {
    assert.notEqual(classifyHtml(shell(topCard('<button type="button">Save</button>') + railCard)).branch, 'easy_apply');
    assert.notEqual(classifyHtml(shell(topCard('<button type="button">Save</button>') + inlineCard)).branch, 'easy_apply');
  });

  test('an apply control whose scope does not contain the job title (from <title>) is not used', () => {
    const markup = shell('<div><p>Something else</p><button type="button" aria-label="Easy Apply to this job">Easy Apply</button></div>');
    assert.notEqual(classifyHtml(markup).branch, 'easy_apply');
  });

  test('two disjoint scopes each with the job title and an Easy Apply button: unknown', () => {
    const one = topCard('<button type="button" aria-label="Easy Apply to this job">Easy Apply</button>');
    assert.equal(classifyHtml(shell(`${one}<aside></aside>${one}`.replace('<aside></aside>', '<a href="https://www.linkedin.com/jobs/view/4999000555/">x</a>'))).branch, 'unknown');
  });

  test('closed text with no control in the title scope: closed', () => {
    assert.equal(classifyHtml(shell(topCard('<div aria-live="assertive"><p>No longer accepting applications</p></div>'))).branch, 'closed');
  });

  test('no h1 and no title in <title>: unknown', () => {
    const markup = shell(topCard('<button type="button" aria-label="Easy Apply to this job">Easy Apply</button>')).replace(/<title>[^<]*<\/title>/, '');
    assert.equal(classifyHtml(markup).branch, 'unknown');
  });
});

describe('isLinkedInHostUrl', () => {
  test('linkedin.com and subdomains, including /safety/go/, are LinkedIn; anything else is not', () => {
    assert.equal(isLinkedInHostUrl('https://www.linkedin.com/safety/go/?url=x'), true);
    assert.equal(isLinkedInHostUrl('https://linkedin.com/jobs/view/1/'), true);
    assert.equal(isLinkedInHostUrl('https://lnkd.in/abc'), true);
    assert.equal(isLinkedInHostUrl('https://boards.greenhouse.io/acme/jobs/1'), false);
    assert.equal(isLinkedInHostUrl('https://notlinkedin.com/x'), false);
    assert.equal(isLinkedInHostUrl('not a url'), false);
  });
});
