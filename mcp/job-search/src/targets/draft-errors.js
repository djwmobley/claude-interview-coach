// @ts-check
/**
 * Closed refusal codes for the draft actions (edit, preflight, approve, discard, regenerate) and the HTTP
 * status each maps to. Shared by the claim code in src/targets and the dashboard layer.
 */
export const DRAFT_REFUSALS = Object.freeze({
  INVALID_BODY: 400,
  INVALID_ID: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  DRAFT_VERSION_CONFLICT: 409,
  WRONG_STATE: 409,
  BLOCKED_NOT_ELIGIBLE: 409,
  DISCARDED: 409,
  DECISION_LOCKED: 409,
  DRAFT_STATE: 409,
  DRAFT_LIVE: 409,
  TEXT_CHANGED: 409,
  GATES_FAILED: 409,
  GATES_UNAVAILABLE: 409,
  CAP_REACHED: 409,
  FACTS_UNAVAILABLE: 409,
});

export class DraftError extends Error {
  /**
   * @param {keyof typeof DRAFT_REFUSALS} code
   * @param {string} message
   * @param {Record<string, string|number|boolean|null>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
    this.status = DRAFT_REFUSALS[code];
    this.details = details;
  }
}
