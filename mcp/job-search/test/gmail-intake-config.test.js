// @ts-check
/**
 * Gmail intake addendum config (G2, F-G2, B8, B10): config/alert-senders.json registers the four new
 * senders, jobs2web requires `company` (and nothing else may carry it), discovery uses ONE shared keyword
 * list, and config/adapters.json raises gmail dailyPages to 600 and adds the gmail-detail source and the
 * detail routing caps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertSendersSchema, adaptersSchema, GMAIL_PARSER_NAMES, discoverySubjectRegex, DISCOVERY_DEFAULT_KEYWORDS } from '../src/core/config.js';

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(path.join(CONFIG, f), 'utf8'));

describe('alert-senders.json (G2)', () => {
  test('the four new senders are registered and enabled; parsers exist', () => {
    const cfg = alertSendersSchema.parse(read('alert-senders.json'));
    const by = Object.fromEntries(cfg.senders.map((s) => [s.address, s]));
    assert.equal(by['dice@connect.dice.com']?.parser, 'dice');
    assert.equal(by['emails@efinancialcareers.com']?.parser, 'efinancialcareers');
    assert.equal(by['hello@mail.remotehunter.com']?.parser, 'remotehunter');
    assert.equal(by['blackveatch-jobnotification@noreply12.jobs2web.com']?.parser, 'jobs2web');
    assert.equal(by['blackveatch-jobnotification@noreply12.jobs2web.com']?.company, 'Black & Veatch');
    for (const n of ['dice', 'efinancialcareers', 'remotehunter', 'jobs2web']) assert.ok(GMAIL_PARSER_NAMES.includes(n));
  });
  test('jobs2web without company fails; company on another parser fails; an unknown parser fails', () => {
    const one = (/** @type {any} */ s) => alertSendersSchema.safeParse({ senders: [s] }).success;
    assert.equal(one({ address: 'x@jobs2web.com', parser: 'jobs2web' }), false);
    assert.equal(one({ address: 'x@jobs2web.com', parser: 'jobs2web', company: 'Acme' }), true);
    assert.equal(one({ address: 'x@dice.com', parser: 'dice', company: 'Acme' }), false);
    assert.equal(one({ address: 'x@dice.com', parser: 'nope' }), false);
  });
  test('B8: discovery has one shared keyword list; the subject regex is built from it', () => {
    const cfg = alertSendersSchema.parse({ senders: [] });
    assert.deepEqual(cfg.discovery.keywords, [...DISCOVERY_DEFAULT_KEYWORDS]);
    for (const k of ['position', 'positions', 'roles', 'career', 'opportunity', 'hiring', 'jobs']) assert.ok(cfg.discovery.keywords.includes(k), k);
    const re = discoverySubjectRegex(cfg.discovery.keywords);
    assert.ok(re.test('New positions for you'));
    assert.ok(!re.test('Your weekly newsletter'));
    assert.equal(cfg.health.parserBrokenMinEmails, 1);
    assert.ok(cfg.discovery.perSenderMax >= 1);
  });
});

describe('adapters.json gmail (F-G2, G3, B10)', () => {
  test('gmail dailyPages 600; detailRouting caps; gmail-detail source with exact host list', () => {
    const cfg = adaptersSchema.parse(read('adapters.json'));
    const g = /** @type {any} */ (cfg.adapters.gmail);
    assert.equal(g.dailyPages, 600);
    assert.equal(g.detailRouting.detailMaxAttempts, 3);
    assert.equal(g.detailRouting.maxHops, 5);
    assert.equal(g.detailRouting.unwrapPerDay, 300);
    const gd = /** @type {any} */ (cfg.adapters['gmail-detail']);
    assert.ok(gd, 'gmail-detail source present');
    assert.ok(gd.domains.includes('t.ladders.co'));
    assert.ok(!gd.domains.includes('remotehunter.com'), 'F-G3a: RemoteHunter is never a fetch target');
  });
});
