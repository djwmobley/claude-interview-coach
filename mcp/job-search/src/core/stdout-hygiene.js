// @ts-check
/**
 * stdout hygiene (spec section 1). Imported FIRST by server.js so it runs
 * before any other module can print. ESM hoists imports, so this lives in
 * its own module rather than in "first lines" of server.js.
 *
 *   - NO_COLOR=1; DEBUG and PWDEBUG removed (playwright and pino-pretty
 *     would otherwise decorate or chatter).
 *   - console.log/info/debug/warn/error/trace are reassigned to the pino
 *     logger, which writes to fd 2 only.
 *   - process.stdout is left to the JSON-RPC transport alone.
 */
process.env.NO_COLOR = '1';
delete process.env.DEBUG;
delete process.env.PWDEBUG;
delete process.env.FORCE_COLOR;

import { log, scalars } from './logger.js';

/** @param {unknown[]} args */
function fields(args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(scalars(/** @type {any} */ (a) ?? {})))).join(' ');
  return { evt: 'console', msg: msg.slice(0, 300) };
}

console.log = (...args) => log.info(fields(args));
console.info = (...args) => log.info(fields(args));
console.debug = (...args) => log.debug(fields(args));
console.warn = (...args) => log.warn(fields(args));
console.error = (...args) => log.error(fields(args));
console.trace = (...args) => log.warn(fields(args));

export const STDOUT_HYGIENE = true;
