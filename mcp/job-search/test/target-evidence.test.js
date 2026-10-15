// @ts-check
/**
 * src/core/target-evidence.js: the evidence-source registry (separate from the job-board urlguard).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, unwrapGoogleAlertUrl, EVIDENCE_SOURCES } from '../src/core/target-evidence.js';

const ACC18 = 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/primary_doc.xml';
const ACC_DASHED = 'https://www.sec.gov/Archives/edgar/data/1234567/0001234567-26-000042.txt';

describe('EDGAR', () => {
  test('both accession forms on sec.gov pass for every edgar source', () => {
    for (const src of ['edgar_form_d', 'edgar_8k', 'edgar_fts']) {
      for (const u of [ACC18, ACC_DASHED, 'https://sec.gov/Archives/edgar/data/9/000123456726000042']) {
        const r = checkEvidence(u, src);
        assert.equal(r.ok, true, `${src} ${u}`);
      }
    }
  });
  test('refusals: scheme, host, path, accession shape', () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      [ACC18.replace('https', 'http'), 'edgar_requires_https'],
      ['https://example.com/Archives/edgar/data/1/000123456726000042/x', 'edgar_host_mismatch'],
      ['https://sec.gov.evil.com/Archives/edgar/data/1/000123456726000042/x', 'edgar_host_mismatch'],
      ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1', 'edgar_path_mismatch'],
      ['https://www.sec.gov/Archives/edgar/data/1/12345/x', 'edgar_path_mismatch'],
      ['https://www.sec.gov/Archives/edgar/data/abc/000123456726000042/x', 'edgar_path_mismatch'],
      ['https://www.sec.gov/news/press-release/2026-1', 'edgar_path_mismatch'],
    ];
    for (const [u, reason] of cases) {
      const r = checkEvidence(u, 'edgar_8k');
      assert.equal(r.ok, false, u);
      assert.equal(r.reason, reason, u);
    }
  });
  test('an edgar URL is not valid evidence for a non-edgar source type claim of the wrong host', () => {
    assert.equal(checkEvidence('https://news.example.com/story', 'edgar_form_d').ok, false);
  });
});

describe('Google Alert redirects', () => {
  const wrapped = 'https://www.google.com/url?rct=j&sa=t&url=https%3A%2F%2Fnews.example.com%2Fstory%3Fid%3D1%26x%3D2&ct=ga&cd=abc&usg=xyz';
  test('unwrapGoogleAlertUrl returns the destination, preserving its own query string', () => {
    assert.equal(unwrapGoogleAlertUrl(wrapped), 'https://news.example.com/story?id=1&x=2');
    assert.equal(unwrapGoogleAlertUrl('https://www.google.com/url?q=https://a.example.com/p&sa=U'), 'https://a.example.com/p');
    assert.equal(unwrapGoogleAlertUrl('https://news.example.com/story'), null);
    assert.equal(unwrapGoogleAlertUrl('https://www.google.com/url?sa=t'), null);
    assert.equal(unwrapGoogleAlertUrl('garbage'), null);
  });
  test('a wrapped URL is accepted once and canonicalized to the destination', () => {
    const r = checkEvidence(wrapped, 'google_alert');
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://news.example.com/story?id=1&x=2');
    assert.equal(r.host, 'news.example.com');
  });
  test('a bare destination URL is accepted for google_alert', () => {
    assert.equal(checkEvidence('https://news.example.com/story', 'google_alert').ok, true);
  });
  test('refusals: no destination, redirect chain, private destination, non-http scheme', () => {
    assert.equal(checkEvidence('https://www.google.com/url?sa=t', 'google_alert').reason, 'google_redirect_without_destination');
    const chain = 'https://www.google.com/url?url=' + encodeURIComponent(wrapped);
    assert.equal(checkEvidence(chain, 'google_alert').reason, 'google_redirect_chain');
    assert.equal(checkEvidence('https://www.google.com/url?url=' + encodeURIComponent('http://127.0.0.1/admin'), 'google_alert').ok, false);
    assert.equal(checkEvidence('https://www.google.com/url?url=' + encodeURIComponent('javascript:alert(1)'), 'google_alert').ok, false);
    assert.equal(checkEvidence('https://www.google.com/url?url=' + encodeURIComponent('file:///etc/passwd'), 'google_alert').ok, false);
  });
  test('a google redirect is not unwrapped for other source types', () => {
    assert.equal(checkEvidence(wrapped, 'listings').ok, true);
    assert.equal(checkEvidence(wrapped, 'listings').host, 'www.google.com');
    assert.equal(checkEvidence(wrapped, 'edgar_8k').ok, false);
  });
});

describe('totality and public-URL hygiene', () => {
  test('non-string, blank, and oversized input never throw', () => {
    for (const u of [undefined, null, 5, {}, [], '', '   ', 'x'.repeat(3000), 'not a url', '//example.com']) {
      const r = checkEvidence(u, 'listings');
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, 'string');
    }
  });
  test('unknown, missing, and prototype-key source types are refused', () => {
    for (const s of [undefined, null, '', 'edgar', 'constructor', 'GOOGLE_ALERT', 5]) {
      assert.equal(checkEvidence('https://news.example.com/s', s).reason, 'unknown_source');
    }
  });
  test('IP literals, localhost, credentials, internal suffixes, and single-label hosts are refused', () => {
    for (const u of ['http://127.0.0.1/a', 'http://[::1]/a', 'http://localhost/a', 'https://user:pw@news.example.com/a', 'https://intranet/a', 'https://printer.local/a', 'ftp://news.example.com/a', 'http://10.0.0.5/a']) {
      assert.equal(checkEvidence(u, 'listings').ok, false, u);
    }
  });
  test('a fragment is dropped from the canonical URL', () => {
    assert.equal(checkEvidence('https://news.example.com/s#frag', 'listings').url, 'https://news.example.com/s');
  });
  test('the source list is the closed set the classifier relies on', () => {
    assert.deepEqual([...EVIDENCE_SOURCES], ['edgar_form_d', 'edgar_8k', 'edgar_fts', 'google_alert', 'listings']);
  });
});
