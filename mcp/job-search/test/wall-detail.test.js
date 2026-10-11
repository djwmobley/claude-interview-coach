// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDetail, normalizeDetailText, DETAIL_BLOCK_REASONS, detailWallKey } from '../src/browser/wall.js';

const SAMPLE_12921 = 'Additional Verification Required Your Ray ID for this request is a401b81afaf76bd8 Return home -> Troubleshooting Cloudflare Errors';

const JOB_SENTENCE = 'The Chief Information Security Officer will own the security program, report to the CEO, and lead a team of twelve engineers across cloud, identity and governance. ';
/** @param {number} n */
function legit(n) {
  let s = 'About the role. Responsibilities include strategy and delivery. Requirements: ten years of experience. ';
  while (s.length < n) s += JOB_SENTENCE;
  return s.slice(0, n);
}

describe('normalizeDetailText', () => {
  test('strips tags, script/style, entities and collapses whitespace', () => {
    const out = normalizeDetailText('<style>.a{}</style><script>var x=1;</script><p>Hello&nbsp;&amp;   <b>world</b></p>\n\n<p>&#65;&lt;</p>');
    assert.equal(out, 'Hello & world A<');
  });
  test('non-string is empty', () => {
    assert.equal(normalizeDetailText(null), '');
    assert.equal(normalizeDetailText(undefined), '');
  });
});

describe('classifyDetail: total classification', () => {
  test('the real 12921 sample is blocked', () => {
    const v = classifyDetail({ text: SAMPLE_12921 });
    assert.ok(v.startsWith('blocked:'), v);
  });
  test('12921 wrapped in HTML is still blocked', () => {
    assert.match(classifyDetail({ text: `<html><body><h1>Additional Verification Required</h1><p>Your Ray ID for this request is a401b81afaf76bd8</p><a>Return home</a><p>Troubleshooting Cloudflare Errors</p></body></html>` }), /^blocked:/);
  });
  test('padded block page (Ray ID in first 300 chars, total 1500) is blocked', () => {
    const padded = `${SAMPLE_12921} ${'Lorem ipsum dolor sit amet. '.repeat(55)}`;
    assert.ok(padded.length > 1200);
    assert.match(classifyDetail({ text: padded }), /^blocked:/);
  });
  test('indeed verification text -> indeed_verification', () => {
    assert.equal(classifyDetail({ text: 'Additional Verification Required. Please verify you are a human to continue.' }), 'blocked:indeed_verification');
  });
  test('cloudflare text -> cloudflare_challenge', () => {
    assert.equal(classifyDetail({ text: 'Just a moment... Checking your browser before accessing the site.' }), 'blocked:cloudflare_challenge');
  });
  test('captcha text -> captcha', () => {
    assert.equal(classifyDetail({ text: 'Please complete the CAPTCHA to prove you are not a robot.' }), 'blocked:captcha');
  });
  test('sign in to continue -> login_wall', () => {
    assert.equal(classifyDetail({ text: 'Sign in to continue to your account.' }), 'blocked:login_wall');
  });
  test('long CISO posting mentioning access denied and unusual traffic late is ok', () => {
    const body = `${legit(1400)} We monitor for unusual traffic from your network edge and manage access denied events in the SOC. ${legit(600)}`;
    assert.equal(classifyDetail({ text: body }), 'ok');
  });
  test('a long posting with the phrase inside the first 300 chars is blocked', () => {
    const body = `Access denied. ${legit(2000)}`;
    assert.match(classifyDetail({ text: body }), /^blocked:/);
  });
  test('cloudflare word in a long posting after 300 chars is ok, in a short stub is blocked', () => {
    assert.equal(classifyDetail({ text: `${legit(1500)} We run on Cloudflare and AWS. ${legit(300)}` }), 'ok');
    assert.match(classifyDetail({ text: 'Cloudflare is checking your connection, please wait.' }), /^blocked:/);
  });
  test('attention required and too many requests are not signatures', () => {
    assert.equal(classifyDetail({ text: `${legit(1500)} Attention required: too many requests are handled by the team.` }), 'ok');
    assert.equal(classifyDetail({ text: `Attention required for ${legit(260)}` }), 'too_short');
  });
  test('250-char legit stub is too_short', () => {
    assert.equal(classifyDetail({ text: legit(250) }), 'too_short');
  });
  test('299 chars too_short, 300 chars with markers is not too_short', () => {
    assert.equal(classifyDetail({ text: legit(299) }), 'too_short');
    assert.equal(classifyDetail({ text: legit(300) }), 'ok');
  });
  test('300..1199 chars without a job-shape marker is unverified', () => {
    const noMarker = 'Lorem ipsum dolor sit amet consectetur. '.repeat(20);
    assert.ok(noMarker.length >= 300 && noMarker.length < 1200);
    assert.equal(classifyDetail({ text: noMarker }), 'unverified');
  });
  test('300..1199 chars with a marker is ok', () => {
    assert.equal(classifyDetail({ text: legit(900) }), 'ok');
  });
  test('1200+ chars without a marker is ok', () => {
    assert.equal(classifyDetail({ text: 'Lorem ipsum dolor sit amet consectetur. '.repeat(40) }), 'ok');
  });
  test('empty and null text', () => {
    assert.equal(classifyDetail({ text: '' }), 'empty');
    assert.equal(classifyDetail({ text: null }), 'empty');
    assert.equal(classifyDetail({ text: '   <p> </p> ' }), 'empty');
    assert.equal(classifyDetail({}), 'empty');
  });
  test('script-only html is empty', () => {
    assert.equal(classifyDetail({ text: '<script>window.x = "Ray ID"</script>' }), 'empty');
  });
});

describe('classifyDetail: status and signal precedence', () => {
  test('403 -> blocked:http_403 even with good text', () => {
    assert.equal(classifyDetail({ text: legit(2000), httpStatus: 403 }), 'blocked:http_403');
  });
  test('cfMitigated -> blocked:cloudflare_challenge', () => {
    assert.equal(classifyDetail({ text: legit(2000), cfMitigated: 'challenge' }), 'blocked:cloudflare_challenge');
  });
  test('403 wins over cfMitigated', () => {
    assert.equal(classifyDetail({ text: '', httpStatus: 403, cfMitigated: 'challenge' }), 'blocked:http_403');
  });
  test('429 and 503 are transient, never blocked', () => {
    assert.equal(classifyDetail({ text: '', httpStatus: 429 }), 'transient');
    assert.equal(classifyDetail({ text: legit(2000), httpStatus: 503 }), 'transient');
    assert.equal(classifyDetail({ text: SAMPLE_12921, httpStatus: 429 }), 'transient');
  });
  test('wall signals map to reasons', () => {
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: { challengeCloudflare: true } }), 'blocked:cloudflare_challenge');
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: { challengeForm: true } }), 'blocked:cloudflare_challenge');
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: { recaptcha: true } }), 'blocked:captcha');
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: { loginForm: true } }), 'blocked:login_wall');
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: { guestInterstitial: true } }), 'blocked:login_wall');
    assert.equal(classifyDetail({ text: legit(2000), url: 'https://www.linkedin.com/authwall?x=1' }), 'blocked:login_wall');
  });
  test('wall signals with an empty body are blocked, not empty', () => {
    assert.equal(classifyDetail({ text: '', wallSignals: { recaptcha: true } }), 'blocked:captcha');
  });
  test('never uses classifyPage unrecognized as a block: no signals, good text is ok', () => {
    assert.equal(classifyDetail({ text: legit(2000), wallSignals: {}, httpStatus: 200 }), 'ok');
  });
  test('other statuses (404, 500) fall through to text analysis', () => {
    assert.equal(classifyDetail({ text: '', httpStatus: 404 }), 'empty');
    assert.equal(classifyDetail({ text: legit(2000), httpStatus: 500 }), 'ok');
  });
  test('every result is in the closed set', () => {
    const allowed = new Set(['ok', 'transient', 'empty', 'too_short', 'unverified', ...DETAIL_BLOCK_REASONS.map((r) => `blocked:${r}`)]);
    const samples = [SAMPLE_12921, '', legit(250), legit(900), legit(3000), 'captcha', 'sign in to continue', 'x'];
    for (const text of samples) for (const httpStatus of [undefined, 200, 403, 429, 503, 404]) {
      assert.ok(allowed.has(classifyDetail({ text, httpStatus })), `${text.slice(0, 20)} ${httpStatus}`);
    }
  });
});

describe('detailWallKey', () => {
  test('is source:detail', () => {
    assert.equal(detailWallKey('indeed'), 'indeed:detail');
  });
});
