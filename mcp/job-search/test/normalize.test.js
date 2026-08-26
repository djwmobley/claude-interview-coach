// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl, normalizeCompany, normalizeTitle, normalizeLocation, parseLocation, dedupHash, descriptionHash,
  parseSalary, normalizeListing, normalizeLegacyRow, titleTokenKey, isLocationEligible, sha1, DEFAULT_TRACKING_PARAMS,
} from '../src/core/normalize.js';
import { prescore } from '../src/core/prescore.js';

/** @type {import('../src/core/normalize.js').NormalizeOptions} */
const OPTS = {
  trackingParams: DEFAULT_TRACKING_PARAMS,
  greenhouseBoards: [{ board: 'acme', hosts: ['careers.acme.com'] }],
  aliases: { 'baker tilly advisory group': 'baker tilly', 'kpmg us': 'kpmg', hpe: 'hewlett packard enterprise' },
};

describe('normalizeUrl: invalid inputs', () => {
  for (const v of ['', '   ', null, undefined, 42, 'mailto:talent@deliveryassociates.com', 'ftp://x.com/a', 'not a url', 'http://']) {
    test(`invalid -> nulls: ${JSON.stringify(v)}`, () => {
      const r = normalizeUrl(v, OPTS);
      assert.equal(r.kind, 'invalid');
      assert.equal(r.url_normalized, null);
      assert.equal(r.external_id, null);
    });
  }
});

describe('normalizeUrl: the five live host shapes from the DB', () => {
  test('LinkedIn slug URL', () => {
    const r = normalizeUrl('https://www.linkedin.com/jobs/view/cto-at-evona-4289469969', OPTS);
    assert.deepEqual(r, { url_normalized: 'https://www.linkedin.com/jobs/view/4289469969', external_id: 'linkedin:4289469969', kind: 'canonical', source: 'linkedin' });
  });
  test('LinkedIn numeric URL with trailing slash', () => {
    const r = normalizeUrl('https://www.linkedin.com/jobs/view/4381041325/', OPTS);
    assert.equal(r.external_id, 'linkedin:4381041325');
    assert.equal(r.url_normalized, 'https://www.linkedin.com/jobs/view/4381041325');
  });
  test('Indeed viewjob', () => {
    const r = normalizeUrl('https://www.indeed.com/viewjob?jk=d9b188507102064e&from=serp&vjs=3', OPTS);
    assert.equal(r.external_id, 'indeed:d9b188507102064e');
    assert.equal(r.url_normalized, 'https://www.indeed.com/viewjob?jk=d9b188507102064e');
    assert.equal(r.kind, 'canonical');
  });
  test('Dice job-detail', () => {
    const r = normalizeUrl('https://www.dice.com/job-detail/314E10F8-39d9-44b3-a155-f2cbbde82f1e?src=x', OPTS);
    assert.equal(r.external_id, 'dice:314e10f8-39d9-44b3-a155-f2cbbde82f1e');
    assert.equal(r.source, 'dice');
  });
  test('Oracle HCM', () => {
    const r = normalizeUrl('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210710939', OPTS);
    assert.equal(r.external_id, 'oracle:jpmc.fa.oraclecloud.com/210710939');
    assert.equal(r.source, 'oracle');
    assert.equal(r.kind, 'canonical');
  });
});

describe('normalizeUrl: id extraction before stripping, query and fragment', () => {
  test('LinkedIn currentJobId in query', () => {
    const r = normalizeUrl('https://www.linkedin.com/jobs/search/?currentJobId=4378403522&keywords=cto&refId=abc', OPTS);
    assert.equal(r.external_id, 'linkedin:4378403522');
    assert.equal(r.url_normalized, 'https://www.linkedin.com/jobs/view/4378403522');
  });
  test('LinkedIn currentJobId in fragment', () => {
    const r = normalizeUrl('https://www.linkedin.com/jobs/collections/recommended/#currentJobId=4378403522', OPTS);
    assert.equal(r.external_id, 'linkedin:4378403522');
  });
  test('Indeed rc/clk with jk resolves; pagead/clk without jk is redirect', () => {
    assert.equal(normalizeUrl('https://www.indeed.com/rc/clk?jk=5ec7510556904267&fccid=1', OPTS).external_id, 'indeed:5ec7510556904267');
    const r = normalizeUrl('https://www.indeed.com/pagead/clk?mo=r&ad=-6NYlbfkN0A', OPTS);
    assert.equal(r.kind, 'redirect');
    assert.equal(r.url_normalized, null);
    assert.equal(r.external_id, null);
  });
  test('Greenhouse boards path, boards-api path, embed for/token, and embedded gh_jid on a registered host', () => {
    assert.equal(normalizeUrl('https://boards.greenhouse.io/acme/jobs/4012345?gh_src=xyz', OPTS).external_id, 'greenhouse:acme/4012345');
    assert.equal(normalizeUrl('https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345', OPTS).external_id, 'greenhouse:acme/4012345');
    assert.equal(normalizeUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345', OPTS).external_id, 'greenhouse:acme/4012345');
    const emb = normalizeUrl('https://careers.acme.com/jobs/#gh_jid=4012345', OPTS);
    assert.equal(emb.external_id, 'greenhouse:acme/4012345');
    assert.equal(emb.url_normalized, 'https://boards.greenhouse.io/acme/jobs/4012345');
    const unreg = normalizeUrl('https://careers.unknown.com/jobs?gh_jid=4012345', OPTS);
    assert.equal(unreg.kind, 'residual');
    assert.equal(unreg.external_id, null);
  });
  test('Lever strips /apply and lowercases; api host maps to jobs host', () => {
    const a = normalizeUrl('https://jobs.lever.co/Acme/9B1D6A2E-1C2D-4E5F-8A9B-0C1D2E3F4A5B/apply?lever-source=x', OPTS);
    assert.equal(a.external_id, 'lever:acme/9b1d6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
    assert.equal(a.url_normalized, 'https://jobs.lever.co/acme/9b1d6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
    assert.equal(normalizeUrl('https://api.lever.co/v0/postings/acme/9b1d6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', OPTS).external_id, a.external_id);
  });
  test('Workday tenant/site/REQ', () => {
    const r = normalizeUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Houston-TX/Chief-Technology-Officer_JR-10442?source=LinkedIn', OPTS);
    assert.equal(r.external_id, 'workday:acme/external/jr-10442');
    assert.equal(r.url_normalized, 'https://acme.wd5.myworkdayjobs.com/en-us/external/job/houston-tx/chief-technology-officer_jr-10442');
  });
  test('Dayforce host/client/id', () => {
    const r = normalizeUrl('https://acme.dayforcehcm.com/CandidatePortal/en-US/Acme/Posting/View/1234', OPTS);
    assert.equal(r.external_id, 'dayforce:acme.dayforcehcm.com/acme/1234');
    assert.equal(r.kind, 'canonical');
  });
});

describe('normalizeUrl: tenant qualification', () => {
  test('same numeric id at two tenants yields different external_id per adapter', () => {
    assert.notEqual(normalizeUrl('https://boards.greenhouse.io/acme/jobs/1', OPTS).external_id, normalizeUrl('https://boards.greenhouse.io/beta/jobs/1', OPTS).external_id);
    assert.notEqual(normalizeUrl('https://a.wd5.myworkdayjobs.com/External/job/x/y_R1', OPTS).external_id, normalizeUrl('https://b.wd5.myworkdayjobs.com/External/job/x/y_R1', OPTS).external_id);
    assert.notEqual(normalizeUrl('https://a.dayforcehcm.com/CandidatePortal/en-US/a/Posting/View/1', OPTS).external_id, normalizeUrl('https://b.dayforcehcm.com/CandidatePortal/en-US/b/Posting/View/1', OPTS).external_id);
    assert.notEqual(normalizeUrl('https://jobs.lever.co/a/9b1d6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', OPTS).external_id, normalizeUrl('https://jobs.lever.co/b/9b1d6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', OPTS).external_id);
    assert.notEqual(normalizeUrl('https://a.fa.oraclecloud.com/x/job/1', OPTS).external_id, normalizeUrl('https://b.fa.oraclecloud.com/x/job/1', OPTS).external_id);
  });
});

describe('normalizeUrl: residual canonicalization', () => {
  test('drops tracking params, sorts, strips fragment and trailing slash, lowercases host and path', () => {
    const r = normalizeUrl('HTTPS://WWW.Example.COM/Jobs/Foo/?utm_source=li&b=2&a=1&ref=x&a=0#section', OPTS);
    assert.equal(r.kind, 'residual');
    assert.equal(r.url_normalized, 'https://example.com/jobs/foo?a=0&a=1&b=2');
    assert.equal(r.external_id, null);
    assert.equal(r.source, 'manual');
  });
  test('percent-decode then re-encode with one encoder', () => {
    const a = normalizeUrl('https://example.com/jobs/senior%20engineer', OPTS);
    const b = normalizeUrl('https://example.com/jobs/senior engineer', OPTS);
    assert.equal(a.url_normalized, b.url_normalized);
  });
});

describe('normalizeCompany', () => {
  const c = (/** @type {string} */ s, /** @type {any} */ o) => normalizeCompany(s, { ...OPTS, ...(o ?? {}) }).company_norm;
  test('suffix boundary: Cisco stays cisco, Tesco stays tesco', () => {
    assert.equal(c('Cisco'), 'cisco');
    assert.equal(c('Tesco'), 'tesco');
  });
  test('suffix strip once, boundary required', () => {
    assert.equal(c('Acme, Inc.'), 'acme');
    assert.equal(c('Acme Co.'), 'acme');
    assert.equal(c('Acme Corp'), 'acme');
    assert.equal(c('Acme GmbH'), 'acme');
    assert.equal(c('Acme Corp Inc'), 'acme corp');
  });
  test('group, holdings, international are name-bearing', () => {
    assert.equal(c('Acme Holdings'), 'acme holdings');
    assert.equal(c('Acme Group'), 'acme group');
    assert.equal(c('Acme International'), 'acme international');
  });
  test('leading the, accents, collapse, no pipe', () => {
    assert.equal(c('The Home Depot'), 'home depot');
    assert.equal(c('Société Générale'), 'societe generale');
    assert.equal(c('Bain & Company'), 'bain company');
    assert.equal(c('A | B'), 'a b');
    assert.ok(!c('X|Y|Z').includes('|'));
  });
  test('parentheticals become company_note', () => {
    const r = normalizeCompany('Robert Half (Madison WI)', OPTS);
    assert.equal(r.company_norm, 'robert half');
    assert.equal(r.company_note, 'Madison WI');
  });
  test('aliases applied, exempt from suffix stripping', () => {
    assert.equal(c('Baker Tilly Advisory Group'), 'baker tilly');
    assert.equal(c('KPMG US'), 'kpmg');
    assert.equal(c('HPE'), 'hewlett packard enterprise');
  });
  test('confidential gets firm slug, applied after collapse', () => {
    assert.equal(c('Confidential', { confidentialFirm: 'East 57th' }), 'confidential:east-57th');
    assert.equal(c('Confidential (health-tech)', { source: 'linkedin' }), 'confidential:linkedin');
    assert.equal(c('Confidential'), 'confidential:unknown');
  });
  test('empty is empty, not a throw', () => {
    assert.equal(c(''), '');
    assert.equal(normalizeCompany(null, OPTS).company_norm, '');
  });
});

describe('normalizeTitle', () => {
  const t = (/** @type {string} */ s) => normalizeTitle(s).title_norm;
  test('acronym dots removed before expansion; unambiguous acronyms expand', () => {
    assert.equal(t('C.T.O.'), 'chief technology officer');
    assert.equal(t('CTO'), t('Chief Technology Officer'));
    assert.equal(t('VP, Engineering'), 'vice president engineering');
    assert.equal(t('SVP of Digital Transformation'), 'senior vice president of digital transformation');
    assert.equal(t('Sr. Director'), 'senior director');
  });
  test('ambiguous acronyms map to distinct tokens', () => {
    assert.equal(t('CDO'), 'acr_cdo');
    assert.notEqual(t('CDO'), t('Chief Digital Officer'));
    assert.notEqual(t('CDO'), t('Chief Data Officer'));
  });
  test('ampersand and artificial intelligence', () => {
    assert.equal(t('Head of AI & Data'), 'head of ai and data');
    assert.equal(t('VP of Artificial Intelligence'), 'vice president of ai');
  });
  test('trailing location segment removed and promoted', () => {
    const r = normalizeTitle('CTO - Houston, TX');
    assert.equal(r.title_norm, 'chief technology officer');
    assert.equal(r.location_from_title, 'Houston, TX');
    assert.equal(normalizeTitle('CTO (Houston, TX)').location_from_title, 'Houston, TX');
    assert.equal(normalizeTitle('CTO | Austin, Texas').title_norm, 'chief technology officer');
  });
  test('remote/hybrid/req-id segments dropped, non-location parentheticals kept', () => {
    assert.equal(t('Director of Engineering (Remote)'), 'director of engineering');
    assert.equal(t('Director of Engineering - Hybrid'), 'director of engineering');
    assert.equal(t('Senior Director - REQ-12345'), 'senior director');
    assert.equal(t('CIO (Contract)'), 'chief information officer contract');
    assert.equal(t('Head of Digital Transformation/CIO (Houston Christian University)'), 'head of digital transformation chief information officer houston christian university');
  });
  test('titleTokenKey drops stopwords and sorts', () => {
    assert.equal(titleTokenKey('director of engineering'), titleTokenKey('engineering director'));
    assert.notEqual(titleTokenKey('director of engineering'), titleTokenKey('director of platform engineering'));
  });
  test('empty', () => {
    assert.equal(t(''), '');
    assert.equal(normalizeTitle(null).title_norm, '');
  });
});

describe('parseLocation and normalizeLocation: total classification', () => {
  test('city-st shapes', () => {
    assert.deepEqual(parseLocation('Houston, TX'), { kind: 'city-st', value: 'houston-tx' });
    assert.deepEqual(parseLocation('Houston, Texas, United States'), { kind: 'city-st', value: 'houston-tx' });
    assert.deepEqual(parseLocation('New York, NY 10001'), { kind: 'city-st', value: 'new-york-ny' });
    assert.deepEqual(parseLocation('Austin TX'), { kind: 'city-st', value: 'austin-tx' });
    assert.deepEqual(parseLocation('Houston, TX (Hybrid)'), { kind: 'city-st', value: 'houston-tx' });
  });
  test('country only', () => {
    assert.deepEqual(parseLocation('United States'), { kind: 'country', iso: 'us' });
    assert.deepEqual(parseLocation('Canada'), { kind: 'country', iso: 'ca' });
  });
  test('unparseable is null', () => {
    assert.equal(parseLocation('Greater Houston Area'), null);
    assert.equal(parseLocation('Remote'), null);
    assert.equal(parseLocation(''), null);
  });
  test('absent when the source supplied no location', () => {
    assert.equal(normalizeLocation(null).location_norm, 'absent');
    assert.equal(normalizeLocation(undefined).location_norm, 'absent');
    assert.equal(normalizeLocation('   ').location_norm, 'absent');
  });
  test('remote-<iso> only when declared', () => {
    assert.equal(normalizeLocation('Houston, TX', true).location_norm, 'remote-us');
    assert.equal(normalizeLocation(null, true).location_norm, 'remote-us');
    assert.equal(normalizeLocation('Remote - Canada', true).location_norm, 'remote-ca');
    assert.equal(normalizeLocation('Remote', false).location_norm, `unknown:${sha1('remote')}`);
  });
  test('inferred remote keeps the city', () => {
    const r = normalizeLocation('Houston, TX', false, true);
    assert.equal(r.location_norm, 'houston-tx');
    assert.equal(r.remote_mode, 'remote');
  });
  test('unknown hash is stable and prefixed; eligibility', () => {
    const a = normalizeLocation('Greater Houston Area').location_norm;
    assert.ok(a.startsWith('unknown:'));
    assert.equal(a, normalizeLocation('  greater houston AREA ').location_norm);
    assert.equal(isLocationEligible(a), false);
    assert.equal(isLocationEligible('absent'), false);
    assert.equal(isLocationEligible('legacy-unknown'), false);
    assert.equal(isLocationEligible('houston-tx'), true);
    assert.equal(isLocationEligible('remote-us'), true);
    assert.equal(isLocationEligible('country-us'), true);
  });
  test('hybrid mode detected', () => {
    assert.equal(normalizeLocation('Houston, TX (Hybrid)').remote_mode, 'hybrid');
  });
});

describe('hashes', () => {
  test('dedupHash is deterministic over the three fields', () => {
    assert.equal(dedupHash('acme', 'cto', 'houston-tx'), dedupHash('acme', 'cto', 'houston-tx'));
    assert.notEqual(dedupHash('acme', 'cto', 'houston-tx'), dedupHash('acme', 'cto', 'absent'));
  });
  test('descriptionHash: HTML, entities, case, whitespace, req-id masking', () => {
    const a = descriptionHash('<p>Lead the  team &amp; grow.</p>  Req 12345');
    const b = descriptionHash('LEAD the team & grow. REQ-99999');
    assert.equal(a.hash, b.hash);
    // text keeps original case/punctuation (post HTML-strip/entity-decode/whitespace-collapse); hash does not.
    assert.equal(a.text, 'Lead the team & grow. Req 12345');
    assert.equal(b.text, 'LEAD the team & grow. REQ-99999');
    const c = descriptionHash('Lead the team & grow. Job 7');
    assert.notEqual(a.hash, c.hash);
  });
  test('descriptionHash: null for empty; first+last 2000 chars', () => {
    assert.deepEqual(descriptionHash(''), { text: null, hash: null });
    assert.deepEqual(descriptionHash(null), { text: null, hash: null });
    const base = 'a'.repeat(3000) + 'MIDDLE' + 'b'.repeat(3000);
    const changedMiddle = 'a'.repeat(3000) + 'XXXXXX' + 'b'.repeat(3000);
    const changedStart = 'z' + 'a'.repeat(2999) + 'MIDDLE' + 'b'.repeat(3000);
    assert.equal(descriptionHash(base).hash, descriptionHash(changedMiddle).hash);
    assert.notEqual(descriptionHash(base).hash, descriptionHash(changedStart).hash);
  });
  test('descriptionHash: two descriptions differing only by case share a hash but keep distinct stored text', () => {
    const mixed = descriptionHash('We Need A Senior CTO to Lead Platform Engineering.');
    const lower = descriptionHash('we need a senior cto to lead platform engineering.');
    assert.equal(mixed.hash, lower.hash);
    assert.notEqual(mixed.text, lower.text);
    assert.equal(mixed.text, 'We Need A Senior CTO to Lead Platform Engineering.');
    assert.equal(lower.text, 'we need a senior cto to lead platform engineering.');
  });
  test('normalizeListing: stores original-case description, hash from lowercased text', () => {
    const mixedRaw = { source: 'greenhouse', url: null, title: 'CTO', company: 'Acme', description: '<p>Own the Platform &amp; Scale the Team.</p>' };
    const lowerRaw = { source: 'greenhouse', url: null, title: 'CTO', company: 'Acme', description: 'own the platform & scale the team.' };
    const mixed = normalizeListing(mixedRaw, OPTS);
    const lower = normalizeListing(lowerRaw, OPTS);
    assert.equal(mixed.description, 'Own the Platform & Scale the Team.');
    assert.equal(lower.description, 'own the platform & scale the team.');
    assert.equal(mixed.description_hash, lower.description_hash);
  });
});

describe('prescore case-insensitivity', () => {
  test('prescore is identical for mixed-case and lowercase descriptions', () => {
    const profile = { keywords: ['platform'], phrases: ['digital transformation'], exclude_terms: ['internship'] };
    const mixed = { title: 'Chief Technology Officer', description: 'Leads Digital Transformation across the Platform team.' };
    const lower = { title: 'Chief Technology Officer', description: 'leads digital transformation across the platform team.' };
    assert.equal(prescore(mixed, profile), prescore(lower, profile));
  });
});

describe('parseSalary', () => {
  test('ranges and units', () => {
    assert.deepEqual(parseSalary('$250,000 - $300,000 a year'), { salary_min: 250000, salary_max: 300000 });
    assert.deepEqual(parseSalary('$250k-$300k'), { salary_min: 250000, salary_max: 300000 });
    assert.deepEqual(parseSalary('Up to $300K'), { salary_min: 300000, salary_max: 300000 });
  });
  test('hourly and empty are null', () => {
    assert.deepEqual(parseSalary('$55 - $65 / hr'), { salary_min: null, salary_max: null });
    assert.deepEqual(parseSalary(''), { salary_min: null, salary_max: null });
    assert.deepEqual(parseSalary(null), { salary_min: null, salary_max: null });
  });
});

describe('normalizeListing and normalizeLegacyRow', () => {
  test('adapter external id is tenant-qualified when the URL has none', () => {
    const r = normalizeListing({ source: 'exec', externalId: 'abc', url: 'https://www.east57th.com/opportunities/cto?utm_source=x', title: 'CTO', company: 'Confidential', location: 'Houston, TX', confidentialFirm: 'east57th' }, OPTS);
    assert.equal(r.external_id, 'exec:abc');
    assert.equal(r.company_norm, 'confidential:east57th');
    assert.equal(r.location_norm, 'houston-tx');
    assert.equal(r.url_kind, 'residual');
    assert.equal(r.dedup_hash, dedupHash(r.company_norm, r.title_norm, r.location_norm));
  });
  test('URL-derived id wins over adapter id; location promoted from title', () => {
    const r = normalizeListing({ source: 'linkedin', externalId: '999', url: 'https://www.linkedin.com/jobs/view/cto-at-x-4289469969', title: 'CTO - Austin, TX', company: 'X Inc', remoteMode: 'hybrid' }, OPTS);
    assert.equal(r.external_id, 'linkedin:4289469969');
    assert.equal(r.location, 'Austin, TX');
    assert.equal(r.location_norm, 'austin-tx');
    assert.equal(r.remote_mode, 'hybrid');
    assert.equal(r.company_norm, 'x');
  });
  test('legacy row: empty URL is NULL, location legacy-unknown, source by host', () => {
    const a = normalizeLegacyRow({ id: 10, title: 'Executive Director, Marketing', company: 'JPMorgan Chase (Chase Auto)', url: '' }, OPTS);
    assert.equal(a.url_normalized, null);
    assert.equal(a.external_id, null);
    assert.equal(a.source, 'manual');
    assert.equal(a.location_norm, 'legacy-unknown');
    const b = normalizeLegacyRow({ id: 2, title: 'CTO', company: 'EVONA', url: 'https://www.linkedin.com/jobs/view/cto-at-evona-4289469969' }, OPTS);
    assert.equal(b.source, 'linkedin');
    assert.equal(b.external_id, 'linkedin:4289469969');
  });
});
