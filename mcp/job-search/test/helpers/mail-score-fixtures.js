// @ts-check
/**
 * Shared builders for the recruiter-mail scoring tests (src/core/mail-score.js).
 */
import { buildScoreText } from '../../src/adapters/gmail-intake.js';

/** A well-typed, fully grounded scoring answer for TEXT below. @param {Record<string, any>} [over] */
export function goodScore(over = {}) {
  return {
    is_opportunity: true, roles_found: 1, recruiter_firm: 'Forsyth Barnes', recruiter_name: 'Simon Wilkinson', employer: 'Orbit Systems',
    role_title: 'Chief Information Officer', level: 'c_suite',
    client_clues: { industry: 'logistics', size: '2,000 employees', ownership: 'private equity', location: 'Houston', remote: 'hybrid' },
    comp_range: { min: 300000, max: 350000, currency: 'USD', period: 'year' },
    fit_score: 82, fit_reason: 'Chief Information Officer scope at a private-equity logistics company matches the summary.', ...over,
  };
}

export const TEXT = buildScoreText(
  { from: 'Simon Wilkinson <simon@forsythbarnes.com>', subject: 'Exciting New Opportunity - Lets Catch Up', date: 'Fri, 23 Oct 2026 10:00:00 -0500' },
  'Hi Damian, I am a partner at Forsyth Barnes. My client Orbit Systems, a private equity owned logistics company with 2,000 employees in Houston, is hiring a Chief Information Officer (hybrid). Base is $300,000 to $350,000 per year.',
);

/** The claude --output-format json envelope around a structured answer. @param {unknown} structured */
export const envelope = (structured) => JSON.stringify({ type: 'result', is_error: false, structured_output: structured });
