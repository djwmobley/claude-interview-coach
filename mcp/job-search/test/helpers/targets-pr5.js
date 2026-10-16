// @ts-check
/**
 * Fixtures for the PR5 tests (plan 19): a golden draft that passes every gate, a gate context, and the facts
 * and config files the DB tests need. No network, no real claude process, no shell.
 *
 * Source files in this repo use \u{...} escapes (never a raw look-alike character) for non-ASCII input.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COMPANY = 'Acme Robotics Inc';
export const EXCERPT_101 = 'Acme Robotics announced that Harbor Capital Partners acquired a majority stake in the company on October 8, 2026. Acme Robotics builds warehouse automation software for mid-market retailers. See harbor.example for details.';

export const FACTS = Object.freeze([
  { id: 'c1', text: 'I led a platform consolidation that moved 12 retail brands onto one commerce stack.', tags: ['operations'] },
  { id: 'c2', text: 'I have run product and engineering teams through two ownership changes.', tags: ['leadership'] },
]);

export const GOLDEN_FIELDS = Object.freeze({
  hook: 'Harbor Capital Partners acquired a majority stake in Acme Robotics on October 8, 2026.',
  bridge: 'I have run product and engineering teams through two ownership changes.',
  claim: 'I led a platform consolidation that moved 12 retail brands onto one commerce stack.',
  ask: 'Would a short call about how Acme Robotics plans its technology leadership be useful?',
});

export const GOLDEN_SENTENCES = Object.freeze([
  { text: GOLDEN_FIELDS.hook, src: 'e101' },
  { text: GOLDEN_FIELDS.bridge, src: 'c2' },
  { text: GOLDEN_FIELDS.claim, src: 'c1' },
  { text: GOLDEN_FIELDS.ask, src: 'ask' },
]);

/** @returns {import('../../src/targets/draft-gates.js').GateContext} */
export function goldenCtx(over = {}) {
  return {
    company: COMPANY,
    triggerKind: 'pe_deal',
    blockedEntries: ['Immunotec', 'Advisicon', 'Zorbco Holdings'],
    style: {
      buzzwords: ['leverage', 'leveraged', 'cutting-edge', 'game changer', 'robust', 'seamless', 'synergy', 'unlock'],
      problemComparisonPatterns: [
        '\\bless about [^.;!?]{1,60}?[,;]?\\s+(?:and )?more about\\b',
        "\\b(?:isn't|is not|wasn't|was not|aren't|are not)\\s+(?:just |only |really |simply |merely )?[^.;!?]{1,60}?[,;]\\s*(?:it's|it is|this is|that's|that is)\\b",
      ],
    },
    evidence: { 101: EXCERPT_101 },
    facts: FACTS.map((f) => ({ ...f, tags: [...f.tags] })),
    denylist: ['Project Falcon'],
    candidateNames: ['Pat Candidate'],
    personNames: ['Robin Signal'],
    contactName: 'Jane Doe',
    ...over,
  };
}

/**
 * @param {Partial<Record<'hook'|'bridge'|'claim'|'ask', string>>} [fields]
 * @param {Array<{ text: string, src: string }>|((s: Array<{ text: string, src: string }>) => Array<{ text: string, src: string }>)} [sentences]
 */
export function goldenInput(fields = {}, sentences = undefined, ctx = goldenCtx(), mode = /** @type {'machine'|'edited'} */ ('machine')) {
  const f = { ...GOLDEN_FIELDS, ...fields };
  let s;
  if (typeof sentences === 'function') s = sentences(GOLDEN_SENTENCES.map((x) => ({ ...x })));
  else if (sentences) s = sentences;
  else s = [f.hook, f.bridge, f.claim, f.ask].map((text, i) => ({ text, src: GOLDEN_SENTENCES[i].src }));
  return { fields: f, sentences: s, ctx, mode };
}

/**
 * The text of a field replaced everywhere (field and its sentence) so only the gate under test changes.
 * @param {'hook'|'bridge'|'claim'|'ask'} key
 * @param {string} text
 */
export function withField(key, text) {
  return goldenInput({ [key]: text });
}

/** Write a facts file (and optionally blocked-affiliates) into a fresh temp config dir. */
export function makeConfigDir(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr5-cfg-'));
  const facts = opts.facts === undefined ? { facts: FACTS, signoff: 'Best,\nPat Candidate', candidate_names: ['Pat Candidate'], denylist: ['Project Falcon'] } : opts.facts;
  if (facts !== null) fs.writeFileSync(path.join(dir, 'target-pitch-facts.json'), typeof facts === 'string' ? facts : JSON.stringify(facts));
  const blocked = opts.blocked === undefined ? ['Zorbco Holdings'] : opts.blocked;
  if (blocked !== null) fs.writeFileSync(path.join(dir, 'blocked-affiliates.json'), JSON.stringify({ blocked_affiliates: blocked }));
  fs.writeFileSync(path.join(dir, 'triage-mcp-empty.json'), JSON.stringify({ mcpServers: {} }));
  return dir;
}

/** The model reply a well-behaved drafter returns for the golden draft (the claude --output-format json wrapper). */
export function draftEnvelope(over = {}) {
  const reply = { ...GOLDEN_FIELDS, sentences: GOLDEN_SENTENCES.map((x) => ({ ...x })), ...over };
  return JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: reply });
}

/** @param {string} nonce @param {'PASS'|'FAIL'} v @param {string[]} [reasons] */
export function reviewEnvelope(nonce, v, reasons = []) {
  return JSON.stringify({ type: 'result', is_error: false, result: `VERDICT[${nonce}]: ${v}\n\`\`\`json\n${JSON.stringify({ reasons })}\n\`\`\`\n` });
}

/** Pull the nonce out of a review prompt (the test stub plays the reviewer). */
export function nonceOf(prompt) {
  const m = /VERDICT\[([0-9a-f]+)\]: PASS/.exec(prompt);
  return m ? m[1] : '';
}
