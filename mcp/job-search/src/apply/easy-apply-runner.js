// @ts-check
/**
 * Assisted LinkedIn Easy Apply runner: LinkedIn-bound entry point. The implementation moved to
 * src/apply/assisted/runner.js (profile-driven); this module keeps the pre-refactor API. Invocation for
 * LinkedIn is unchanged (test/easy-apply-runner.test.js pins it): the LinkedIn profile's prompt, the
 * easy_apply alias tool, and JOBSEARCH_EASY_APPLY_LEASE.
 */
import { createAssistedRunner } from './assisted/runner.js';
import { LINKEDIN_PROFILE, LINKEDIN_PROMPT } from './assisted/profiles/linkedin.js';

/** @typedef {import('./assisted/runner.js').EasyApplyRunnerDeps} EasyApplyRunnerDeps */

export const EASY_APPLY_PROMPT = LINKEDIN_PROMPT;

/** @param {EasyApplyRunnerDeps & { profile?: import('./assisted/runner.js').RunnerProfile }} deps */
export function createEasyApplyRunner(deps) {
  return createAssistedRunner({ ...deps, profile: deps.profile ?? LINKEDIN_PROFILE });
}
