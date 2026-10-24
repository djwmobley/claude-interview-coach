// @ts-check
/**
 * The markdown report escapes control characters in untrusted sender, subject and snippet text so a message
 * cannot inject links, images, emphasis, headings, tables or HTML (sql/029).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailIntakeLines, escapeMarkdown } from '../src/core/mail-intake-report.js';

const evil = {
  message_id: 'a1b2c3d4e5f60001', thread_id: 't1', bucket: 'recruiter_like', signal: 'strong', from_addr: 'a_b@x.test', from_name: '[Click](https://evil.example) *bold*',
  reply_to: 'r@x.test', reply_to_differs: true, subject: '# Heading `code` | table | <b>x</b>', snippet: '![img](https://evil.example/p.png) _em_ ~~s~~',
  msg_date: '2026-10-23T15:00:00.000Z', labels: ['INBOX'], spam: false, body_unreadable: false,
};
const data = /** @type {any} */ ({ ran: true, items: [evil], more: 0, counts: {}, topUnsorted: [['a_b@x.test', 1]], topBulk: [], notReadBeyondCap: 0, metadataUnread: 0, outcomes: [] });

test('sender, subject and snippet control characters are backslash-escaped in the markdown report', () => {
  const md = mailIntakeLines(data, { markdown: true }).join('\n');
  assert.ok(md.includes('\\[Click\\]\\(https://evil.example\\) \\*bold\\*'), md);
  assert.ok(md.includes('\\# Heading \\`code\\` \\| table \\| \\<b\\>x\\</b\\>'), md);
  assert.ok(md.includes('\\!\\[img\\]\\(https://evil.example/p.png\\) \\_em\\_ \\~\\~s\\~\\~'), md);
  assert.ok(md.includes('a\\_b@x.test'), md);
  assert.doesNotMatch(md, /(^|[^\\])\[Click\]\(/m, 'no live markdown link from message text');
  assert.doesNotMatch(md, /(^|[^\\])!\[img\]/m, 'no live markdown image from message text');
});

test('the only live link in the markdown item is the Open in Gmail link built from the message id', () => {
  const md = mailIntakeLines(data, { markdown: true }).join('\n');
  const links = md.match(/(?<!\\)\]\(https?:[^)]*\)/g) ?? [];
  assert.deepEqual(links, ['](https://mail.google.com/mail/u/0/#all/a1b2c3d4e5f60001)']);
});

test('escapeMarkdown leaves ordinary text alone and handles null and rule lines', () => {
  assert.equal(escapeMarkdown('Plain words, 2026-10-23.'), 'Plain words, 2026-10-23.');
  assert.equal(escapeMarkdown(null), '');
  assert.equal(escapeMarkdown('----'), '\\----');
});

test('the plain-text report is not escaped (it is not markdown)', () => {
  assert.ok(mailIntakeLines(data).join('\n').includes('[Click](https://evil.example) *bold*'));
});
