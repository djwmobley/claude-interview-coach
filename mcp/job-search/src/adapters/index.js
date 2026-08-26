// @ts-check
/**
 * Adapter registry. Names match the keys of config/adapters.json `adapters`.
 */
import { greenhouse } from './greenhouse.js';
import { lever } from './lever.js';
import { workday } from './workday.js';
import { dayforce } from './dayforce.js';
import { indeed } from './indeed.js';
import { linkedin } from './linkedin.js';
import { exec } from './exec-generic.js';
import { gmail } from './gmail.js';
import { JobSearchError } from '../core/errors.js';

/** @type {Readonly<Record<string, import('./base.js').Adapter>>} */
export const ADAPTERS = Object.freeze({ greenhouse, lever, workday, dayforce, indeed, linkedin, exec, gmail });

/** Sources that need no scan Chrome (a genuinely offline first run). gmail needs no scan Chrome either (needsBrowser:false); it needs the Google OAuth token instead. */
export const OFFLINE_SOURCES = Object.freeze(['greenhouse', 'lever', 'workday', 'gmail']);

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

/**
 * @param {string} name
 * @returns {import('./base.js').Adapter}
 */
export function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) throw new JobSearchError('VALIDATION', `unknown source: ${String(name).slice(0, 40)}`, { hint: `known sources: ${adapterNames().join(', ')}` });
  return a;
}
