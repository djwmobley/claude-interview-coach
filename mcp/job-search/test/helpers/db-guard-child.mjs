// @ts-check
/**
 * Standalone child script for test/config.test.js's assertTestDbGuard coverage. Spawned as a real
 * separate `node` process (not imported in-process) so it gets its own clean process.env/argv --
 * exactly the conditions the guard actually inspects. Calls pgConnectionConfig(), which calls
 * assertTestDbGuard() internally; if the guard trips it throws and this process exits non-zero with the
 * message on stderr, otherwise it prints OK and exits 0. Never actually connects to a database (the
 * guard fires, or doesn't, before any connection is attempted).
 */
import { pgConnectionConfig } from '../../src/core/config.js';

pgConnectionConfig();
process.stdout.write('OK\n');
