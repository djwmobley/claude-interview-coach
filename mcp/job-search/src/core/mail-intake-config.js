// @ts-check
/**
 * Defaults accessor for config/mail-intake.json (personal mail intake, sql/029). The schema itself lives in
 * src/core/config.js next to the other config schemas (so config.js stays free of mail-named imports); this
 * file only re-exports it and builds the defaults object for callers whose config predates the key.
 */
import { mailIntakeSchema, DEFAULT_SEARCH_FIRM_DOMAINS, DEFAULT_LINKEDIN_INMAIL_SENDERS } from './config.js';

export { mailIntakeSchema, DEFAULT_SEARCH_FIRM_DOMAINS, DEFAULT_LINKEDIN_INMAIL_SENDERS };

/** @typedef {import('zod').infer<typeof mailIntakeSchema>} MailIntakeConfig */

/** The defaults, for callers whose config object predates this key (hand-built test configs). */
export function defaultMailIntakeConfig() {
  return mailIntakeSchema.parse({});
}
