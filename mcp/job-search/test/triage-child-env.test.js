// @ts-check
/**
 * execFileWithStdin honors opts.env: a real child gets only the env it is handed (no sentinel secret).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileWithStdin } from '../src/core/triage.js';
import { buildChildEnv } from '../src/core/claude-spawn.js';

test('a real spawned child does not see a sentinel secret from the parent env', async () => {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'triage-env-')), 'print-env.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ s: process.env.ZZ_CHILD_SENTINEL_SECRET ?? null }));\n');
  process.env.ZZ_CHILD_SENTINEL_SECRET = 'sentinel-value';
  try {
    const res = await execFileWithStdin(process.execPath, [script], { input: '', timeout: 20000, env: buildChildEnv(process.env) });
    assert.deepEqual(JSON.parse(res.stdout), { s: null });
  } finally {
    delete process.env.ZZ_CHILD_SENTINEL_SECRET;
  }
});
