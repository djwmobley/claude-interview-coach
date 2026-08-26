#!/usr/bin/env node
// @ts-check
/**
 * Config lock helper (spec section 6/8).
 *
 *   node bin/config-lock.js          check: exit 0 when config/*.json matches config.lock.json, 2 otherwise
 *   node bin/config-lock.js --write  validate config with zod, then write config.lock.json
 */
import { checkConfigLock, writeConfigLock, loadConfig } from '../src/core/config.js';
import { errFields } from '../src/core/errors.js';

function main() {
  const write = process.argv.includes('--write');
  try {
    loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`config invalid: ${f.err_code}: ${f.err_message}\n`);
    process.exit(1);
  }
  if (write) {
    const hash = writeConfigLock();
    process.stdout.write(`config.lock.json written: ${hash}\n`);
    process.exit(0);
  }
  const r = checkConfigLock();
  process.stdout.write(`config lock ${r.ok ? 'OK' : 'MISMATCH'}: expected=${r.expected ?? 'none'} actual=${r.actual}\n`);
  process.exit(r.ok ? 0 : 2);
}

main();
