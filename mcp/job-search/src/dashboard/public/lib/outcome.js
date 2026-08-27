// @ts-check
/**
 * Shared error-side-effect handler for the classify() outcomes in lib/api.js (pr3-spec-decisions.md
 * section 4's table). Branches with exactly one fixed UI behavior are handled here so every page gets
 * them for free; branches that need page-specific handling (not_found, duplicate_candidate,
 * db_unavailable, validation with an inline field target, ok) are left for the caller to inspect via
 * `outcome.kind`, which this function always returns unchanged.
 */
import { showToast, setBanner } from './toast.js';

let mutationsDisabled = false;

/** @returns {boolean} true once a BAD_HOST/BAD_ORIGIN response has been seen this session. */
export function areMutationsDisabled() {
  return mutationsDisabled;
}

/**
 * @param {import('./api.js').ApiOutcome} outcome
 * @param {{ silenceNotFound?: boolean }} [opts]
 * @returns {import('./api.js').ApiOutcome}
 */
export function handleOutcome(outcome, opts = {}) {
  switch (outcome.kind) {
    case 'network_error':
      showToast({ message: 'Network error. Try again.', tone: 'error' });
      break;
    case 'unparsable':
      showToast({ message: 'Unexpected response from the server.', tone: 'error' });
      console.error('dashboard: unparsable response body', outcome.raw);
      break;
    case 'rejected_request':
      mutationsDisabled = true;
      setBanner('rejected-request', {
        tone: 'error',
        message: `Unexpected request rejected (${outcome.code}). Check dashboard configuration.`,
      });
      console.error('dashboard: rejected request', outcome);
      break;
    case 'client_bug':
      showToast({ message: 'Something went wrong on this page. Reload and try again.', tone: 'error', code: outcome.code });
      console.error('dashboard: client bug surfaced a server rejection', outcome);
      break;
    case 'locked':
      showToast({ message: 'A scan is already running.', tone: 'error' });
      break;
    case 'config_lock_mismatch':
      setBanner('config-lock', { tone: 'error', message: 'Config lock mismatch. Scans are blocked until this is resolved.' });
      break;
    case 'payload_too_large':
      showToast({ message: 'Too much text. Shorten it and try again.', tone: 'error' });
      break;
    case 'internal':
      showToast({ message: `Internal error.${outcome.requestId ? ` Reference: ${outcome.requestId}` : ''}`, tone: 'error', code: outcome.code ?? 'INTERNAL' });
      break;
    case 'not_found':
      if (!opts.silenceNotFound) {
        // Generic fallback for a not_found the caller did not specifically handle: quiet toast, never a
        // thrown error. Detail pages should pass silenceNotFound:true and render their own empty state.
        showToast({ message: 'Not found.', tone: 'error' });
      }
      break;
    case 'db_unavailable':
      setBanner('db-unavailable', { tone: 'error', message: 'The database is unavailable right now. This view will recover automatically.' });
      break;
    default:
      break;
  }
  return outcome;
}
