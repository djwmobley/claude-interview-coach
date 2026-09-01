// @ts-check
/**
 * Apply adapter registry (apply pipeline slices 5-6). Keys match src/core/applications.js's ATS_TYPES.
 * `dayforce`/`icims` have no entry yet (slice 8): src/apply/worker.js's own total lookup
 * (`adapterRegistry[app.ats_type]`) treats a missing key as "no automated adapter for this ATS yet" and
 * parks the application in needs_human, never a throw or an assumed-ok skip.
 */
import { greenhouse } from './greenhouse.js';
import { lever } from './lever.js';
import { workday } from './workday.js';
import { smartrecruiters } from './smartrecruiters.js';
import { indeedEasy } from './indeed-easy.js';
import { linkedinEasy } from './linkedin-easy.js';

/** @type {Readonly<Record<string, any>>} */
export const ADAPTERS = Object.freeze({
  greenhouse,
  lever,
  workday,
  smartrecruiters,
  indeed_easy: indeedEasy,
  linkedin_easy: linkedinEasy,
});
