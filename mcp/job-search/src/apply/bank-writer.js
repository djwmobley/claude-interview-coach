// @ts-check
/**
 * Answer-bank writers (answer-fallback spec F6, F7). Every bank write goes through writeBankAtomic: the
 * WHOLE resulting file is parsed with parseAnswerBank first, and only a clean parse replaces the file, via
 * a temp file in the same directory and a rename. On any parse error nothing is written and the error is
 * thrown, so the caller fails the request visibly (never "ignore and log").
 *
 * applyChoiceAnswer is the explicit, parse-validated transform behind the dashboard's answer to a parked
 * CHOICE field (an option the human picked from the options the run captured). Total, first match wins:
 *   - a compensation-shaped label -> refused (compensation answers are never learned);
 *   - a label or option with a control character, or a blank one -> refused (a line break would forge a
 *     bank line);
 *   - the current bank does not parse -> refused (the parse error is the message);
 *   - the label already resolves to key K (learned or alias tier): K must be type enum, else refused;
 *       the option already matches K's value or a ranked fallback -> no value change;
 *       K is in FALLBACK_KEYS -> append `fallback: <highest rank + 1> | <option>` (rank 1 and 2 kept);
 *       otherwise -> K's `value:` line is replaced by the option;
 *     an alias-tier label is rewritten in place as a `learned:` line (one label, one registration);
 *   - otherwise the key is derived from the question (deriveBankKey); an existing key of that name is
 *     updated as above and gets a `learned:` line; no such key -> a new enum section is appended with
 *     `value:` the option and `learned:` the exact label.
 * The result is parsed again and must resolve the label to that key at the learned tier and place the
 * option through the shared matcher (matchCandidates); anything else is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JobSearchError } from '../core/errors.js';
import {
  parseAnswerBank, normalizeText, candidateValues, matchCandidates, FALLBACK_KEYS, SECTION_KEY_RE, SALARY_LABEL_RE, HOURLY_RE,
} from './answers.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const SECTION_RE = /^##\s+(\S+)\s*$/;
const VALUE_LINE_RE = /^value:\s*(.+)$/;
const ALIASES_LINE_RE = /^aliases:\s*(.+?)(?:\s*::\s*(\S+))?\s*$/;

/**
 * Bank key for a question with no bank key yet: `q_` plus normalizeText(question) with every run of
 * non-alphanumerics folded to one underscore, capped at 60 characters. Always matches SECTION_KEY_RE.
 * @param {unknown} question
 * @returns {string}
 */
export function deriveBankKey(question) {
  const slug = normalizeText(question).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60).replace(/_+$/g, '');
  if (!slug) throw new JobSearchError('VALIDATION', `cannot derive a bank key from question "${String(question).slice(0, 120)}"`);
  const key = `q_${slug}`;
  if (!SECTION_KEY_RE.test(key)) throw new JobSearchError('VALIDATION', `cannot derive a bank key from question "${String(question).slice(0, 120)}"`);
  return key;
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @returns {{ start: number, end: number }} section header index and the index just past its block
 */
function sectionBounds(lines, key) {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i].trim());
    if (!m) continue;
    if (start === -1 && m[1] === key) {
      start = i;
      continue;
    }
    if (start !== -1) {
      end = i;
      break;
    }
  }
  if (start === -1) throw new JobSearchError('VALIDATION', `bank key "${key}" not found`, { details: { key } });
  // Keep trailing blank lines after the block's last content line, so an insert sits with its section.
  while (end - 1 > start && !lines[end - 1].trim()) end--;
  return { start, end };
}

/**
 * @param {string} bankText current bank file content ('' when the file does not exist yet)
 * @param {{ label: unknown, option: unknown }} answer the parked question's exact label and the picked option
 * @returns {{ text: string, key: string, created: boolean }}
 */
export function applyChoiceAnswer(bankText, answer) {
  const label = typeof answer.label === 'string' ? answer.label.trim() : '';
  const option = typeof answer.option === 'string' ? answer.option.trim() : '';
  if (!label || !option) throw new JobSearchError('VALIDATION', 'a choice answer needs the question label and the picked option');
  if (CONTROL_CHAR_RE.test(label) || CONTROL_CHAR_RE.test(option)) throw new JobSearchError('VALIDATION', 'the question label or option contains a control character; not written to the bank');
  if (SALARY_LABEL_RE.test(label) || HOURLY_RE.test(label)) throw new JobSearchError('VALIDATION', 'compensation questions are never learned into the bank; answer this one by hand');
  if (typeof bankText !== 'string') throw new JobSearchError('VALIDATION', 'bank text must be a string');

  const bank = parseAnswerBank(bankText);
  const norm = normalizeText(label);
  const hit = bank.labels.get(norm);
  const key = hit ? hit.key : deriveBankKey(label);
  const fact = bank.facts.get(key);
  const lines = bankText.replace(/\r\n/g, '\n').split('\n');

  if (!fact) {
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    const block = [`## ${key}`, 'type: enum', `value: ${option}`, `learned: ${label}`];
    const text = [...lines, ...(lines.length > 0 ? [''] : []), ...block, ''].join('\n');
    return { text: verify(text, key, norm, option), key, created: true };
  }

  if (fact.type !== 'enum') throw new JobSearchError('VALIDATION', `bank key "${key}" is type ${fact.type}, not type enum; a picked option cannot be written to it. Edit the bank by hand.`, { details: { key } });

  const { start } = sectionBounds(lines, key);
  const already = matchCandidates(candidateValues(fact), [option], key).ok;
  if (!already) {
    const { end } = sectionBounds(lines, key);
    if (FALLBACK_KEYS.includes(key)) {
      const next = Math.max(1, ...(fact.fallbacks ?? []).map((f) => f.rank)) + 1;
      lines.splice(end, 0, `fallback: ${next} | ${option}`);
    } else {
      let replaced = false;
      for (let i = start + 1; i < end; i++) {
        if (VALUE_LINE_RE.test(lines[i].trim())) {
          lines[i] = `value: ${option}`;
          replaced = true;
          break;
        }
      }
      if (!replaced) throw new JobSearchError('VALIDATION', `bank key "${key}" has no value: line to update`, { details: { key } });
    }
  }

  if (!hit || hit.tier !== 'learned') {
    let rewritten = false;
    if (hit) {
      const { end } = sectionBounds(lines, key);
      for (let i = start + 1; i < end; i++) {
        const m = ALIASES_LINE_RE.exec(lines[i].trim());
        if (m && normalizeText(m[1]) === norm) {
          lines[i] = `learned: ${label}`;
          rewritten = true;
          break;
        }
      }
    }
    if (!rewritten) {
      const { end } = sectionBounds(lines, key);
      lines.splice(end, 0, `learned: ${label}`);
    }
  }
  return { text: verify(lines.join('\n'), key, norm, option), key, created: false };
}

/**
 * Parse the result and check it does what the answer meant; throws otherwise.
 * @param {string} text
 * @param {string} key
 * @param {string} norm normalized label
 * @param {string} option
 */
function verify(text, key, norm, option) {
  const bank = parseAnswerBank(text);
  const entry = bank.labels.get(norm);
  const fact = bank.facts.get(key);
  if (!entry || entry.key !== key || entry.tier !== 'learned' || !fact) {
    throw new JobSearchError('VALIDATION', `bank write for key "${key}" did not produce a learned label`, { details: { key } });
  }
  if (!matchCandidates(candidateValues(fact), [option], key).ok) {
    throw new JobSearchError('VALIDATION', `bank write for key "${key}" would not place the picked option`, { details: { key } });
  }
  return text;
}

/**
 * Replace the bank file atomically after parse-validating the WHOLE new content (spec F7). On a parse
 * error nothing is written and the JobSearchError is thrown. The temp file lives next to the target so the
 * rename never crosses a volume; it is removed if the rename fails.
 * @param {string} file
 * @param {string} text
 */
export function writeBankAtomic(file, text) {
  parseAnswerBank(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
