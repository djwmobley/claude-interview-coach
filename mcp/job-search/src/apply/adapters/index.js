// @ts-check
/**
 * Apply adapter registry (apply pipeline slices 5-6, 8). Keys match src/core/applications.js's ATS_TYPES.
 * `dayforce` and `icims` are registered here as of slice 8 (src/apply/adapters/dayforce.js and icims.js).
 * src/apply/worker.js's own total lookup (`adapterRegistry[app.ats_type]`) still treats any FUTURE missing
 * key the same way: "no automated adapter for this ATS yet" parks the application in needs_human, never a
 * throw or an assumed-ok skip -- that totality guarantee is unchanged by adding these two entries.
 */
import { greenhouse } from './greenhouse.js';
import { lever } from './lever.js';
import { workday } from './workday.js';
import { smartrecruiters } from './smartrecruiters.js';
import { indeedEasy } from './indeed-easy.js';
import { linkedinEasy } from './linkedin-easy.js';
import { icims } from './icims.js';
import { dayforce } from './dayforce.js';

/** @type {Readonly<Record<string, any>>} */
export const ADAPTERS = Object.freeze({
  greenhouse,
  lever,
  workday,
  smartrecruiters,
  indeed_easy: indeedEasy,
  linkedin_easy: linkedinEasy,
  icims,
  dayforce,
});
