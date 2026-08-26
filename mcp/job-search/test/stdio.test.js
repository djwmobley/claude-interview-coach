// @ts-check
/**
 * stdio hygiene (spec section 1): spawn the real server, send initialize,
 * initialized, tools/list, and one tools/call; assert every stdout line
 * parses as exactly one JSON-RPC frame and nothing else reaches stdout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.js');
const ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * @param {object[]} frames
 * @param {number} waitMs
 */
function runServer(frames, waitMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      // DEBUG/PWDEBUG set on purpose: the server must scrub them and stay silent on stdout.
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, DEBUG: 'pw:api', PWDEBUG: '1', FORCE_COLOR: '1' },
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    for (const f of frames) child.stdin.write(JSON.stringify(f) + '\n');
    setTimeout(() => {
      child.kill();
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    }, waitMs);
  });
}

describe('stdio hygiene', () => {
  test('every stdout byte is exactly one JSON-RPC frame per line; tools/list shows 10 tools', async () => {
    const r = /** @type {{ stdout: string, stderr: string }} */ (await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      // An unknown source is refused before any DB or network access, so the frame test never starts a real scan.
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_jobs', arguments: { sources: ['zz-no-such-source'] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'render_doc', arguments: { kind: 'resume', source: 'does/not/exist.md', outName: 'X' } } },
    ], 8000));
    assert.ok(r.stdout.length > 0, 'server produced stdout');
    // No byte outside frames: the whole stdout is newline-terminated JSON lines.
    assert.ok(r.stdout.endsWith('\n'), 'stdout ends with newline');
    const lines = r.stdout.split('\n');
    assert.equal(lines[lines.length - 1], '', 'trailing segment empty');
    const frames = lines.slice(0, -1).map((l, i) => {
      let j;
      try {
        j = JSON.parse(l);
      } catch {
        assert.fail(`stdout line ${i + 1} is not JSON: ${l.slice(0, 80)}`);
      }
      assert.equal(j.jsonrpc, '2.0', 'frame has jsonrpc 2.0');
      assert.ok('id' in j || 'method' in j, 'frame is a response or notification');
      return j;
    });
    const byId = new Map(frames.filter((f) => f.id !== undefined).map((f) => [f.id, f]));
    assert.ok(byId.get(1)?.result?.serverInfo?.name === 'job-search');
    const tools = byId.get(2)?.result?.tools ?? [];
    assert.equal(tools.length, 10, 'ten tools');
    assert.deepEqual(tools.map((t) => t.name), ['search_jobs', 'query_jobs', 'get_job', 'mark_jobs', 'profiles', 'scans', 'review', 'render_doc', 'followups', 'scan_report']);
    const stub = JSON.parse(byId.get(3).result.content[0].text);
    assert.equal(stub.code, 'VALIDATION');
    assert.equal(stub.ok, false);
    const nf = JSON.parse(byId.get(4).result.content[0].text);
    assert.equal(nf.ok, false);
    assert.equal(nf.code, 'NOT_FOUND');
    // Diagnostics went to stderr, never stdout.
    assert.ok(r.stderr.includes('server_started'), 'stderr carries the pino start line');
    assert.ok(!r.stdout.includes('server_started'));
  });
});
