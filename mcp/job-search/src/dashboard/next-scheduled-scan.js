// @ts-check
/**
 * Next scheduled scan (dashboard PR 2, pr2-spec-decisions.md "Next scheduled scan"). Total classification:
 * found and parsed -> ISO timestamp; multiple triggers -> earliest upcoming; not registered, command
 * missing, timeout, unparseable -> null with a reason. Never throws.
 */
import { execFile as defaultExecFile } from 'node:child_process';
import { SCAN_TASK_NAME } from './task-names.js';

const TIMEOUT_MS = 3000;
const DAY_INDEX = Object.freeze({ Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 });

/**
 * @param {(cmd: string, args: string[], opts: object, cb: (err: Error|null, stdout: string, stderr: string) => void) => import('node:child_process').ChildProcess} execFileFn
 * @param {string[]} args
 */
function runSchtasks(execFileFn, args) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    try {
      child = execFileFn('schtasks', args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (done) return;
        done = true;
        resolve({ err, stdout: String(stdout ?? '') });
      });
    } catch (err) {
      resolve({ err: /** @type {Error} */ (err), stdout: '' });
      return;
    }
    const guard = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ err: new Error('schtasks timed out'), stdout: '' });
    }, TIMEOUT_MS + 500);
    guard.unref?.();
  });
}

/** @param {string} xml */
export function parseNextFromXml(xml) {
  const blocks = xml.match(/<CalendarTrigger>[\s\S]*?<\/CalendarTrigger>/g) ?? [];
  const now = new Date();
  /** @type {Date|null} */
  let earliest = null;
  for (const block of blocks) {
    const startMatch = /<StartBoundary>([^<]+)<\/StartBoundary>/.exec(block);
    if (!startMatch) continue;
    const start = new Date(startMatch[1]);
    if (Number.isNaN(start.getTime())) continue;
    const daysMatch = /<DaysOfWeek>([\s\S]*?)<\/DaysOfWeek>/.exec(block);
    if (daysMatch) {
      const dayNames = [...daysMatch[1].matchAll(/<(\w+)\s*\/>/g)].map((m) => m[1]);
      const targetDays = dayNames.map((d) => DAY_INDEX[d]).filter((d) => d !== undefined);
      if (targetDays.length === 0) continue;
      for (let add = 0; add < 14; add++) {
        const candidate = new Date(now);
        candidate.setDate(candidate.getDate() + add);
        candidate.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
        if (candidate.getTime() <= now.getTime()) continue;
        if (targetDays.includes(candidate.getDay())) {
          if (!earliest || candidate < earliest) earliest = candidate;
          break;
        }
      }
    } else if (start.getTime() > now.getTime()) {
      if (!earliest || start < earliest) earliest = start;
    }
  }
  return earliest;
}

/** @param {string} line */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** @param {string} csv */
export function parseNextFromCsv(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = header.indexOf('next run time');
  if (idx === -1) return null;
  const row = parseCsvLine(lines[1]);
  const raw = (row[idx] ?? '').trim();
  if (!raw || raw.toUpperCase() === 'N/A') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {{ execFile?: typeof defaultExecFile, taskName?: string }} [opts]
 * @returns {Promise<{ next_run: string|null, reason: string|null }>}
 */
export async function nextScheduledScan(opts = {}) {
  const execFileFn = opts.execFile ?? defaultExecFile;
  const taskName = opts.taskName ?? SCAN_TASK_NAME;
  try {
    const xml = await runSchtasks(execFileFn, ['/query', '/tn', taskName, '/xml']);
    if (!xml.err && xml.stdout) {
      const next = parseNextFromXml(xml.stdout);
      if (next) return { next_run: next.toISOString(), reason: null };
    }
    const csv = await runSchtasks(execFileFn, ['/query', '/tn', taskName, '/fo', 'csv', '/v']);
    if (!csv.err && csv.stdout) {
      const next = parseNextFromCsv(csv.stdout);
      if (next) return { next_run: next.toISOString(), reason: null };
    }
    if (xml.err) return { next_run: null, reason: 'not_registered_or_unavailable' };
    return { next_run: null, reason: 'unparseable' };
  } catch {
    return { next_run: null, reason: 'error' };
  }
}
