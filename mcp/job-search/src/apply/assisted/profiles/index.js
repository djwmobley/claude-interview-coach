// @ts-check
/**
 * Assisted apply profile registry. Total classification over an application's ats_type: an exact own-key
 * hit returns that profile; every other value (unknown ATS, wrong case, non-string, inherited object keys)
 * returns null, and callers treat null as "no assisted path" (the tool stops with unsupported_ats).
 * LinkedIn Easy Apply is the only profile in this release.
 */
import { LINKEDIN_PROFILE } from './linkedin.js';

/** ats_type -> profile. Frozen; own keys only. */
export const PROFILES = Object.freeze({ linkedin_easy: LINKEDIN_PROFILE });

/**
 * @param {unknown} ats
 * @returns {typeof LINKEDIN_PROFILE | null}
 */
export function profileForAts(ats) {
  if (typeof ats !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILES, ats)) return null;
  return /** @type {any} */ (PROFILES)[ats];
}
