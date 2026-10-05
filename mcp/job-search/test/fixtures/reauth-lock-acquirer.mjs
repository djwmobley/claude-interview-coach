// Test fixture (not a test file): one process that waits for a shared start instant, then tries to
// acquire the reauth lock once and prints "ok" or "held". Used by test/reauth-lock.test.js to race
// real, separate processes against the same lock file.
import { acquireReauthLock } from '../../src/core/google-reauth.js';

const [lockFile, startAtStr, nonce] = process.argv.slice(2);
const startAt = Number(startAtStr);
while (Date.now() < startAt) { /* spin to line up both processes on the same instant */ }
const r = acquireReauthLock(lockFile, new Date(), 600000, nonce);
process.stdout.write(r.ok ? 'ok' : 'held');
// Stay alive a while: a winner that exits at once leaves a dead-pid lock, which the other process
// would then (correctly) reclaim as stale, masking the race this fixture exists to exercise.
setTimeout(() => process.exit(0), 1500);
