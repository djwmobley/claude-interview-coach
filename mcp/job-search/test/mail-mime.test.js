// @ts-check
/**
 * Body decoding for the personal mail intake (sql/029): multipart walking, base64url, quoted-printable,
 * charsets, HTML-only mail, the 4 KB cap, and the decode-failure path that flags body_unreadable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessageBody, decodeQuotedPrintable, decodeCharset, charsetOf, BODY_MAX_CHARS } from '../src/core/mail-mime.js';
import { b64url } from './helpers/mail-intake-fixtures.js';

/** @param {string} mime @param {string} data @param {Record<string, string>} [headers] */
const leaf = (mime, data, headers = {}) => ({
  mimeType: mime, headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data },
});

describe('decodeMessageBody', () => {
  test('a single text/plain part (base64url)', () => {
    const d = decodeMessageBody({ mimeType: 'text/plain', body: { data: b64url('Hello Damian, recruiting for a CIO role.') } });
    assert.equal(d.text, 'Hello Damian, recruiting for a CIO role.');
    assert.equal(d.source, 'plain');
    assert.equal(d.unreadable, false);
  });

  test('nested multipart: text/plain wins over text/html even when the html comes first', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [leaf('text/html', b64url('<p>HTML <b>copy</b></p>')), leaf('text/plain', b64url('Plain copy'))] },
        leaf('application/pdf', b64url('%PDF')),
      ],
    };
    const d = decodeMessageBody(payload);
    assert.equal(d.text, 'Plain copy');
    assert.equal(d.source, 'plain');
  });

  test('HTML-only mail is stripped to text', () => {
    const d = decodeMessageBody({ mimeType: 'multipart/alternative', parts: [leaf('text/html', b64url('<style>p{}</style><p>Looking for a <b>Chief Technology Officer</b>&nbsp;now</p><script>x()</script>'))] });
    assert.equal(d.source, 'html');
    assert.match(d.text, /Looking for a Chief Technology Officer/);
    assert.doesNotMatch(d.text, /<|script|p\{\}/);
  });

  test('quoted-printable text, with soft breaks and a utf-8 multibyte escape', () => {
    const qp = 'Caf=C3=A9 recruiting for a CIO=\r\n role';
    const d = decodeMessageBody(leaf('text/plain', b64url(qp), { 'Content-Transfer-Encoding': 'quoted-printable', 'Content-Type': 'text/plain; charset=utf-8' }));
    assert.equal(d.text, 'Café recruiting for a CIO role');
  });

  test('a part already decoded by Gmail but still labeled quoted-printable is left alone', () => {
    const d = decodeMessageBody(leaf('text/plain', b64url('Plain words, no escapes'), { 'Content-Transfer-Encoding': 'quoted-printable' }));
    assert.equal(d.text, 'Plain words, no escapes');
  });

  test('charset conversion: iso-8859-1 bytes', () => {
    const data = Buffer.from([0x43, 0x61, 0x66, 0xe9]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const d = decodeMessageBody(leaf('text/plain', data, { 'Content-Type': 'text/plain; charset="iso-8859-1"' }));
    assert.equal(d.text, 'Café');
  });

  test('an unknown charset falls back to utf-8 instead of failing', () => {
    const d = decodeMessageBody(leaf('text/plain', b64url('plain'), { 'Content-Type': 'text/plain; charset=x-made-up' }));
    assert.equal(d.text, 'plain');
  });

  test('a text/calendar part sets the calendar flag', () => {
    const d = decodeMessageBody({ mimeType: 'multipart/alternative', parts: [leaf('text/plain', b64url('Invite')), leaf('text/calendar', b64url('BEGIN:VCALENDAR'))] });
    assert.equal(d.calendar, true);
  });

  test('the decoded text is truncated to 4 KB AFTER decoding', () => {
    const d = decodeMessageBody(leaf('text/plain', b64url('a'.repeat(BODY_MAX_CHARS * 3))));
    assert.equal(d.text.length, BODY_MAX_CHARS);
  });

  test('decode failure: undecodable data marks the body unreadable', () => {
    const d = decodeMessageBody(leaf('text/plain', '!!! not base64url !!!'));
    assert.deepEqual([d.text, d.unreadable, d.source], ['', true, 'none']);
  });

  test('an empty body, or one with no text part, is unreadable', () => {
    assert.equal(decodeMessageBody({ mimeType: 'text/plain', body: { data: '' } }).unreadable, true);
    assert.equal(decodeMessageBody({ mimeType: 'multipart/mixed', parts: [leaf('image/png', b64url('x'))] }).unreadable, true);
    assert.equal(decodeMessageBody(null).unreadable, true);
    assert.equal(decodeMessageBody(leaf('text/plain', b64url('   \n  '))).unreadable, true);
  });

  test('a deeply nested tree does not recurse forever', () => {
    /** @type {any} */
    let node = leaf('text/plain', b64url('deep'));
    for (let i = 0; i < 60; i++) node = { mimeType: 'multipart/mixed', parts: [node] };
    assert.equal(decodeMessageBody(node).unreadable, true, 'beyond the depth limit nothing is read');
  });
});

describe('helpers', () => {
  test('charsetOf', () => {
    assert.equal(charsetOf('text/plain; charset="UTF-8"'), 'utf-8');
    assert.equal(charsetOf('text/plain'), null);
    assert.equal(charsetOf(null), null);
  });

  test('decodeQuotedPrintable leaves a bare = alone', () => {
    assert.equal(decodeQuotedPrintable(Buffer.from('a = b')).toString('latin1'), 'a = b');
  });

  test('decodeCharset', () => {
    assert.equal(decodeCharset(Buffer.from('ok'), null), 'ok');
  });
});
