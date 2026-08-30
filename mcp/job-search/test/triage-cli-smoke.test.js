// @ts-check
/**
 * LIVE=1 auto-triage CLI smoke test (docs/slice3-auto-triage-spec.md section 9, mirroring
 * test/smoke-greenhouse.test.js's own LIVE=1 gate): shells out to the real `claude` binary once, with
 * the exact flag set src/core/triage.js's runModelTriage uses, against a trivial one-listing prompt, and
 * asserts the returned envelope's structured_output.results shape still matches this spec's captured
 * example (test/fixtures/triage/claude-cli-real-output-example.json). Skipped unless LIVE=1 is set
 * explicitly. Exists so a future CLI version that alters the envelope shape is caught by a deliberate,
 * occasional run, not by every production batch failing for weeks before anyone notices (finding 7).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTriagePrompt, validateModelOutput, execFileWithStdin } from '../src/core/triage.js';

const LIVE = process.env.LIVE === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');

describe('LIVE auto-triage CLI smoke', { skip: !LIVE && 'set LIVE=1 to run against the real claude CLI' }, () => {
  test('claude -p --output-format json --json-schema ... --strict-mcp-config returns the expected envelope shape for one trivial listing', async () => {
    const configDir = path.join(PKG, 'config');
    const schemaJson = fs.readFileSync(path.join(configDir, 'triage-output-schema.json'), 'utf8');
    const mcpEmptyPath = path.join(configDir, 'triage-mcp-empty.json');
    const prompt = buildTriagePrompt({
      candidateSummary: 'A CTO with 20 years of experience in e-commerce and payments technology.',
      profile: { keywords: ['CTO'], phrases: [], exclude_terms: [], locations: ['Houston, TX'], remote: 'any' },
      listings: [{ id: 1, title: 'Chief Technology Officer', company: 'Acme Corp', location: 'Houston, TX', salary: 'n/a', description: 'Lead engineering for a mid-size SaaS company.' }],
    });
    const args = [
      '-p', '--model', 'claude-sonnet-5', '--output-format', 'json',
      '--json-schema', schemaJson,
      '--strict-mcp-config', '--mcp-config', mcpEmptyPath,
    ];
    const res = await execFileWithStdin('claude', args, { input: prompt, timeout: 60000, maxBuffer: 1 << 20, windowsHide: true });
    const stdout = String(res.stdout);
    const validated = validateModelOutput({ exitCode: 0, timedOut: false, stdout }, [1], { model: { skipMaxFit: 30 } });
    assert.equal(validated.ok, true, `expected the real CLI's envelope to validate against this spec's captured shape; got: ${stdout.slice(0, 500)}`);
    assert.ok(validated.ok && validated.entries.length === 1, 'exactly one result for the one requested id');
  });
});
