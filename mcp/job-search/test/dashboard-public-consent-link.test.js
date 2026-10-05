// @ts-check
/**
 * Client half of the 2026-10-04 consent-link fix (spec S5/S6): the pure decisions behind the
 * Re-authorize click (consentLinkFrom, decideConsentTab), the persistent "Open Google sign-in" link
 * (computeGoogleAuthBadgeState's consentUrl), and the every-page banner (reauthBannerState). The
 * h()-calling render code is exercised in the running app per house convention (no jsdom here).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGoogleAuthBadgeState, consentLinkFrom, decideConsentTab,
  CONSENT_UNAVAILABLE_MESSAGE, POPUP_BLOCKED_MESSAGE,
} from '../src/dashboard/public/components/run-scan-drawer.js';
import { reauthBannerState } from '../src/dashboard/public/lib/reauth-banner.js';

const EXPECT = { clientId: 'cid', state: 's'.repeat(64), port: 8001 };
const GOOD = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ response_type: 'code', client_id: 'cid', redirect_uri: 'http://localhost:8001/oauth2callback', state: EXPECT.state })}`;

describe('consentLinkFrom', () => {
  test('OPEN url + expectation -> the url', () => {
    assert.equal(consentLinkFrom({ consentUrl: GOOD, consentExpect: EXPECT }), GOOD);
  });
  test('REJECT (wrong host, missing expectation, null) -> null', () => {
    assert.equal(consentLinkFrom({ consentUrl: GOOD.replace('accounts.google.com', 'evil.example'), consentExpect: EXPECT }), null);
    assert.equal(consentLinkFrom({ consentUrl: GOOD }), null);
    assert.equal(consentLinkFrom({ consentUrl: null, consentExpect: EXPECT }), null);
    assert.equal(consentLinkFrom(null), null);
  });
});

describe('decideConsentTab (total)', () => {
  test('no helper waiting -> close the blank tab, keep the existing inline text', () => {
    assert.deepEqual(decideConsentTab({ popupOpened: true, consentUrl: null, helperWaiting: false }), { action: 'close', inline: null });
  });
  test('popup blocked -> popup_blocked message, no tab handling', () => {
    assert.deepEqual(decideConsentTab({ popupOpened: false, consentUrl: GOOD, helperWaiting: true }), { action: 'none', inline: POPUP_BLOCKED_MESSAGE });
    assert.deepEqual(decideConsentTab({ popupOpened: false, consentUrl: null, helperWaiting: true }), { action: 'none', inline: POPUP_BLOCKED_MESSAGE });
  });
  test('popup open + OPEN url -> navigate', () => {
    assert.deepEqual(decideConsentTab({ popupOpened: true, consentUrl: GOOD, helperWaiting: true }), { action: 'navigate', inline: null });
  });
  test('popup open + no url after polling -> close with the unavailable message', () => {
    assert.deepEqual(decideConsentTab({ popupOpened: true, consentUrl: null, helperWaiting: true }), { action: 'close', inline: CONSENT_UNAVAILABLE_MESSAGE });
    assert.match(CONSENT_UNAVAILABLE_MESSAGE, /logs\/google-reauth-helper\.out\.log/);
  });
});

describe('computeGoogleAuthBadgeState: persistent sign-in link', () => {
  test('running with an OPEN consentUrl -> consentUrl set', () => {
    const s = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: true, consentUrl: GOOD, consentExpect: EXPECT } });
    assert.equal(s.consentUrl, GOOD);
  });
  test('not running, or a REJECT url -> null', () => {
    assert.equal(computeGoogleAuthBadgeState({ category: 'broken', reauth: { running: false, consentUrl: GOOD, consentExpect: EXPECT } }).consentUrl, null);
    assert.equal(computeGoogleAuthBadgeState({ category: 'broken', reauth: { running: true, consentUrl: 'javascript:alert(1)', consentExpect: EXPECT } }).consentUrl, null);
    assert.equal(computeGoogleAuthBadgeState(null).consentUrl, null);
  });
});

describe('reauthBannerState', () => {
  test('running + OPEN link -> banner with link', () => {
    const b = reauthBannerState({ running: true, consentUrl: GOOD, consentExpect: EXPECT }, null);
    assert.ok(b);
    assert.equal(b.url, GOOD);
  });
  test('running without a valid link -> banner without link', () => {
    const b = reauthBannerState({ running: true, consentUrl: null }, null);
    assert.ok(b);
    assert.equal(b.url, null);
  });
  test('not running, or a failed GET -> no banner', () => {
    assert.equal(reauthBannerState({ running: false }, null), null);
    assert.equal(reauthBannerState(null, null), null);
  });
  test('a dismissed link stays hidden; a new link shows again', () => {
    assert.equal(reauthBannerState({ running: true, consentUrl: GOOD, consentExpect: EXPECT }, GOOD), null);
    assert.ok(reauthBannerState({ running: true, consentUrl: GOOD, consentExpect: EXPECT }, 'something-else'));
  });
});
