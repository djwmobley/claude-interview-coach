// @ts-check
/**
 * LinkedIn Easy Apply -- classify-only stub (apply pipeline slice 5, plan section 8: "Deliberately not
 * automated"). Never touches a browser page: src/apply/worker.js checks `classifyOnly` BEFORE attaching
 * any session/page, so `run(cap, ctx)` is called with `cap === null`. Always parks in needs_human
 * immediately -- ToS, fingerprinting, and the risk of a LinkedIn ban (which would cost Damian the network
 * that produces executive interviews) rule this out by deliberate policy, per the plan.
 */

export const linkedinEasy = {
  ats: 'linkedin_easy',
  requires: [],
  classifyOnly: true,
  uploadHosts: [],
  /**
   * @param {null} cap unused -- classify-only adapters never receive a real capability
   * @param {{ applicationId: number, applyUrl: string|null, atsType: string }} ctx
   */
  async run(cap, ctx) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'not_automated',
        label: 'LinkedIn Easy Apply is never automated by policy (ToS, fingerprinting, and ban risk). Apply by hand, then mark applied.',
        page_url: ctx.applyUrl ?? null,
      },
    };
  },
};
