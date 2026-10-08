// @ts-check
/**
 * A fixture data/profile.md with FAKE values only, in the real file's shape (`- **Label:** value` under
 * `## Section` headings), for the resume private-data gate tests.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FAKE = Object.freeze({
  name: 'Pat Q. Example',
  email: 'pat.example@example.invalid',
  phone: '555-010-0199',
  street: '4821 Imaginary Hollow Ln',
  zip: '99991',
  dob: 'January 2, 1901',
  salaryA: '$777,000',
  salaryDigits: '777000',
  bonus: '$55,500',
  secret: 'ZZ-fixture-private-note',
});

export const FIXTURE_PROFILE = `# Profile

- **Name:** ${FAKE.name}
- **Title:** Example Executive
- **Address:** ${FAKE.street}, Nowhereville, TX ${FAKE.zip}
- **Mobile:** ${FAKE.phone}
- **E-Mail:** ${FAKE.email}
- **LinkedIn:** https://www.linkedin.com/in/pat-example
- **Date of Birth:** ${FAKE.dob}
- **Passport Note (private):** ${FAKE.secret}

## Summary

An example summary.

## Compensation

- **Houston area:** ${FAKE.salaryA} base
- **Bonus expectation:** ${FAKE.bonus}
- **Equity:** none
`;

/** Write the fixture to <root>/data/profile.md and return its path. @param {string} root @param {string} [content] */
export function writeFixtureProfile(root, content = FIXTURE_PROFILE) {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'profile.md');
  fs.writeFileSync(p, content);
  return p;
}
