// @ts-check
/**
 * Pure, DOM-free client-side validation for the Add opportunity and New follow-up drawers, mirroring
 * the server's own rules closely enough to give inline errors before a round trip, never as a substitute
 * for the server's own authoritative checks (src/core/manual.js's createManualListing and
 * src/core/followups.js's createFollowup). CHANNELS is a hand-maintained mirror of
 * src/core/followups.js's own CHANNELS export, the same "browser can't import server code" pattern
 * components/chips.js already uses for src/core/statuses.js et al, cross-checked by
 * test/dashboard-public-validate.test.js against the real export.
 */

/** Mirror of src/core/followups.js's CHANNELS. */
export const CHANNELS = Object.freeze(['phone', 'email', 'linkedin', 'other']);

/** Mirror of src/dashboard/routes/listings.js's PIPELINE_STATUSES-or-null acceptance for manual create. */
export const MANUAL_STATUS_OPTIONS = Object.freeze(['new', 'maybe', 'shortlisted', 'applied']);

/**
 * @typedef {{ ok: true, value: Record<string, any> } | { ok: false, errors: Record<string, string> }} ValidationResult
 */

/**
 * POST /api/listings (manual create). Required: title, company (both non-empty after trim, matching
 * createManualListing's own rule). Everything else is optional and passed through trimmed, or null.
 * @param {{ title?: unknown, company?: unknown, url?: unknown, location?: unknown, status?: unknown, via?: unknown }} input
 * @returns {ValidationResult}
 */
export function validateManualListing(input) {
  /** @type {Record<string, string>} */
  const errors = {};
  const title = String(input.title ?? '').trim();
  if (!title) errors.title = 'Title is required.';
  const company = String(input.company ?? '').trim();
  if (!company) errors.company = 'Company is required.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const url = String(input.url ?? '').trim();
  const location = String(input.location ?? '').trim();
  const via = String(input.via ?? '').trim();
  const status = input.status ? String(input.status) : 'new';
  return {
    ok: true,
    value: { title, company, url: url || null, location: location || null, status, via: via || null },
  };
}

/**
 * POST /api/followups. Required: contact, action_text, channel (one of CHANNELS), due_at (non-empty;
 * full ISO calendar-validity is enforced server-side by parseIsoDate, not duplicated here).
 * @param {{ contact?: unknown, org?: unknown, listing_id?: unknown, due_at?: unknown, channel?: unknown, action_text?: unknown, notify?: unknown }} input
 * @returns {ValidationResult}
 */
export function validateFollowup(input) {
  /** @type {Record<string, string>} */
  const errors = {};
  const contact = String(input.contact ?? '').trim();
  if (!contact) errors.contact = 'Contact is required.';
  const action_text = String(input.action_text ?? '').trim();
  if (!action_text) errors.action_text = 'Action is required.';
  if (!CHANNELS.includes(/** @type {any} */ (input.channel))) errors.channel = `Channel must be one of ${CHANNELS.join(', ')}.`;
  const due_at = String(input.due_at ?? '').trim();
  if (!due_at) errors.due_at = 'Due date is required.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const org = String(input.org ?? '').trim();
  return {
    ok: true,
    value: {
      contact,
      org: org || null,
      listing_id: input.listing_id != null ? Number(input.listing_id) : null,
      due_at,
      channel: input.channel,
      action_text,
      notify: Array.isArray(input.notify) ? input.notify : undefined,
    },
  };
}
