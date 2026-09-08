// @ts-check
/**
 * bin/migrate.js is the attended migration path (`node bin/migrate.js apply`, a deliberate, human-invoked
 * action) and must keep failing loudly on the first bad statement, unlike src/core/schema.js's
 * ensureAuxSchema (the unattended per-startup path, fixed elsewhere in this change to warn-and-continue
 * per file). This is a structural/static check on the source text, not a behavioral one: bin/migrate.js
 * must never import ensureAuxSchema from src/core/schema.js, and must never call it, so it cannot
 * silently inherit that catch-and-continue behavior now or by a future accidental import.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_JS_SOURCE = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');

describe('bin/migrate.js stays independent of ensureAuxSchema', () => {
  test('does not import from src/core/schema.js', () => {
    assert.doesNotMatch(MIGRATE_JS_SOURCE, /from\s+['"][^'"]*core\/schema\.js['"]/);
  });

  test('never references ensureAuxSchema by name (import, call, or re-export)', () => {
    assert.doesNotMatch(MIGRATE_JS_SOURCE, /ensureAuxSchema/);
  });
});
