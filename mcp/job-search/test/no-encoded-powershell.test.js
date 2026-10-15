// @ts-check
/**
 * Guard (2026-10-15): Windows Defender blocks and alerts on `powershell.exe ... -EncodedCommand <base64>`.
 * Nothing under mcp/job-search src/, bin/ or test/ may use -EncodedCommand (or its -enc abbreviation as a
 * PowerShell flag), and no test may spawn powershell/pwsh. Classification is total: every scanned file is
 * either clean or a violation, and a file that cannot be read is a violation (friction, never a silent skip).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const SCAN_DIRS = ['src', 'bin', 'test'];

/** -EncodedCommand, or -enc / -ec / -encodedcommand style abbreviations used as a PowerShell flag. */
const ENCODED_FLAG = /(?:^|[\s'"`,[(])-(?:enc(?:odedcommand)?|ec)(?=[\s'"`,\])]|$)/i;
/** A spawn-family call whose first argument is powershell / pwsh (with or without .exe). */
const SPAWN_POWERSHELL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*['"`](?:[^'"`]*[\\/])?(?:powershell|pwsh)(?:\.exe)?['"`]/i;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    out.push(`${dir}\0UNREADABLE_DIR`);
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(?:[cm]?js|ts|json|ps1|cmd|bat|sh)$/i.test(e.name)) out.push(p);
  }
}

/**
 * Total classification of one file's text.
 * @param {string} text
 * @param {boolean} isTestFile
 * @returns {string[]} violation reasons (empty = clean)
 */
export function classify(text, isTestFile) {
  const reasons = [];
  if (/-EncodedCommand/i.test(text)) reasons.push('contains -EncodedCommand');
  if (ENCODED_FLAG.test(text)) reasons.push('contains -enc style PowerShell flag');
  if (isTestFile && SPAWN_POWERSHELL.test(text)) reasons.push('test spawns powershell/pwsh');
  return reasons;
}

test('classify: the guard patterns catch the known bad shapes and pass clean text', () => {
  assert.ok(classify("args: ['-EncodedCommand', x]", false).length > 0);
  assert.ok(classify("powershell -enc ABCD", false).length > 0);
  assert.ok(classify("['-NoProfile', '-enc', blob]", false).length > 0);
  assert.ok(classify("spawn('powershell.exe', ['-Command', 'x'])", true).length > 0);
  assert.ok(classify('execFile("pwsh", [])', true).length > 0);
  assert.equal(classify("spawn('powershell.exe', [])", false).length, 0, 'spawn rule only applies to test files');
  assert.equal(classify("const cmd = 'explorer.exe'; // --encoding utf8, -encrypt", true).length, 0);
  assert.equal(classify("fake('powershell.exe', args)", true).length, 0, 'a fake runner name is not a spawn');
});

test('no file under src/, bin/, test/ uses -EncodedCommand or spawns powershell/pwsh from a test', () => {
  /** @type {string[]} */
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  assert.ok(files.length > 50, `scanner found suspiciously few files (${files.length})`);
  /** @type {string[]} */
  const violations = [];
  for (const f of files) {
    if (f.endsWith('\0UNREADABLE_DIR')) {
      violations.push(f.replace('\0', ': '));
      continue;
    }
    if (path.resolve(f) === SELF) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (err) {
      violations.push(`${path.relative(ROOT, f)}: unreadable (${/** @type {any} */ (err).code ?? 'error'})`);
      continue;
    }
    const rel = path.relative(ROOT, f);
    const isTestFile = rel.split(path.sep)[0] === 'test';
    for (const reason of classify(text, isTestFile)) violations.push(`${rel}: ${reason}`);
  }
  assert.deepEqual(violations, [], `Defender-triggering PowerShell usage found:\n${violations.join('\n')}`);
});
