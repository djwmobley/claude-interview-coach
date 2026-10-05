// @ts-check
/**
 * LinkedIn Easy Apply -- ASSISTED, never submitted by automation.
 *
 * Policy (operator decision 2026-10-04, reversing the plan's section 8 "Deliberately not automated" for
 * the assisted form ONLY): a headless session fills the Easy Apply form in Damian's real, logged-in scan
 * Chrome and STOPS at LinkedIn's own Review screen. Damian reviews and clicks Submit himself, then confirms
 * with "I submitted" on the dashboard. The ToS, fingerprinting, and ban-risk concerns that motivated the
 * original policy still stand; this path answers them by: never clicking Submit (the driver's G1 deny rule,
 * G2 terminal-step rule, and G3 review rule make it impossible), a daily cap of 5 that also counts against
 * LinkedIn's own budget, morning runs only inside 09:00-19:00 with 20-40 minute jittered spacing, human
 * paced actions (1.5-4 s per action, 60-160 ms per character), no stealth plugins or UA/locale changes,
 * and a persisted 24-hour circuit breaker on any challenge, forced login, 429, or unexpected
 * "application sent". See docs/auto-apply-spec.md "Assisted LinkedIn Easy Apply".
 *
 * src/apply/worker.js checks `assisted` and routes to src/apply/easy-apply-flow.js; it never calls run()
 * below, which exists only so a caller that ignores `assisted` fails loudly instead of doing anything.
 */

export const linkedinEasy = {
  ats: 'linkedin_easy',
  requires: [],
  classifyOnly: false,
  assisted: true,
  uploadHosts: [],
  /**
   * @param {unknown} _cap
   * @param {{ applyUrl: string|null }} ctx
   */
  async run(_cap, ctx) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'easy_apply_stopped',
        label: 'LinkedIn Easy Apply runs only through the assisted flow; this adapter entry point does nothing.',
        page_url: ctx.applyUrl ?? null,
      },
    };
  },
};
