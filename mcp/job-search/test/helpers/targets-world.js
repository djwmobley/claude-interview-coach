// @ts-check
/**
 * A synthetic EDGAR for the runner tests (PR3). No network: a fake fetch that answers the Form D day search
 * (forms=D and forms=D/A with startdt = enddt = one business day, paged by `from`), the primary_doc.xml of
 * every hit, and the submissions lookup (404). It FAILS THE TEST on a non-GET method or any host outside the
 * target fetch registry, like test/helpers/targets-replay.js.
 *
 * By default every business day has exactly one operating-company filing, so no day is empty. A test
 * overrides `hitsFor(day, form)` to shape a day (empty, overflowing, failing documents).
 */
import { TARGET_FETCH_HOSTS } from '../../src/targets/fetch-guard.js';
import { searchJson, fixture } from './targets-replay.js';

/** @param {{ name: string, cik: string, revenue?: string, firstSale?: string }} o */
export function formDXml({ name, cik, revenue = 'Over $100,000,000', firstSale = '2026-10-05' }) {
  return `<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>${cik}</cik>
    <entityName>${name}</entityName>
    <entityType>Corporation</entityType>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Jane</firstName><lastName>Doe</lastName></relatedPersonName>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup>
    <issuerSize><revenueRange>${revenue}</revenueRange></issuerSize>
    <typeOfFiling>
      <newOrAmendment><isAmendment>false</isAmendment></newOrAmendment>
      <dateOfFirstSale><value>${firstSale}</value></dateOfFirstSale>
    </typeOfFiling>
  </offeringData>
</edgarSubmission>`;
}

/**
 * The default filing for a day: unique accession, CIK, and name per day.
 * @param {string} day YYYY-MM-DD
 * @param {number} [n] nth filing of the day
 */
export function defaultFiling(day, n = 1) {
  const mmdd = day.slice(5).replace('-', '');
  const num = 1_000_000 + Number(mmdd) * 10 + n;
  const cik = String(num).padStart(10, '0');
  const adsh = `${cik}-26-${String(Number(mmdd) * 10 + n).padStart(6, '0')}`;
  return { adsh, cik, name: `Zzrun Co ${mmdd}-${n} Inc`, sics: ['7372'] };
}

/**
 * @typedef {{ adsh: string, cik: string, name: string, sics?: string[], revenue?: string }} Filing
 */

/**
 * @param {Object} [o]
 * @param {(day: string, form: string) => Filing[]} [o.hitsFor] hits for one day and form (forms=D or D/A)
 * @param {(adsh: string) => number} [o.docStatus] HTTP status for a primary_doc.xml (default 200)
 * @param {(day: string, form: string) => number} [o.searchStatus] HTTP status for a day search (default 200)
 * @param {(url: string) => Response|null} [o.extra] answers anything else first (alerts, other hosts)
 * @param {(day: string) => Filing[]} [o.k8For] 8-K Item 5.02 filings of a day (the document is the departure.htm fixture)
 * @param {number} [o.delayMs] real delay before every search answer (heartbeat tests)
 */
export function makeWorld(o = {}) {
  /** @type {Array<{ method: string, url: string }>} */
  const calls = [];
  /** @type {Map<string, Filing>} */
  const byAdsh = new Map();
  const hitsFor = o.hitsFor ?? ((/** @type {string} */ day, /** @type {string} */ form) => (form === 'D' ? [defaultFiling(day)] : []));
  /** @type {any} */
  const impl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    if (method !== 'GET') throw new Error(`world: non-GET ${method} ${url}`);
    const u = new URL(String(url));
    if (!TARGET_FETCH_HOSTS.includes(u.hostname)) throw new Error(`world: host outside the registry ${u.hostname}`);
    const extra = o.extra?.(String(url));
    if (extra) return extra;
    if (u.hostname === 'efts.sec.gov') {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      const form = u.searchParams.get('forms') ?? '';
      const day = u.searchParams.get('startdt') ?? '';
      const from = Number(u.searchParams.get('from') ?? 0);
      const status = o.searchStatus?.(day, form) ?? 200;
      if (status !== 200) return new Response('', { status });
      if (form === '8-K' || form === '8-K/A') {
        const k8 = form === '8-K' && o.k8For ? o.k8For(day) : [];
        const k8page = k8.slice(from, from + 100);
        return new Response(searchJson(k8page.map((f) => ({
          _id: `${f.adsh}:form8k.htm`, adsh: f.adsh, ciks: [f.cik], display_names: [`${f.name}  (CIK ${f.cik})`], file_date: day, form, file_type: '8-K', items: ['5.02'],
        })), k8.length), { status: 200 });
      }
      const all = hitsFor(day, form);
      for (const f of all) byAdsh.set(f.adsh, f);
      const page = all.slice(from, from + 100);
      return new Response(searchJson(page.map((f) => ({
        adsh: f.adsh, ciks: [f.cik], display_names: [`${f.name}  (CIK ${f.cik})`], file_date: day, form, sics: f.sics ?? [],
      })), all.length), { status: 200 });
    }
    if (u.hostname === 'data.sec.gov') return new Response('', { status: 404 });
    if (/\/form8k\.htm$/.test(u.pathname)) return new Response(fixture('edgar_8k/departure.htm'), { status: 200 });
    const m = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/primary_doc\.xml$/.exec(u.pathname);
    if (m) {
      const adsh = `${m[2].slice(0, 10)}-${m[2].slice(10, 12)}-${m[2].slice(12)}`;
      const f = byAdsh.get(adsh);
      const status = o.docStatus?.(adsh) ?? 200;
      if (!f || status !== 200) return new Response('', { status: f ? status : 404 });
      return new Response(formDXml({ name: f.name, cik: f.cik, revenue: f.revenue }), { status: 200 });
    }
    throw new Error(`world: no route for ${url}`);
  };
  return {
    fetch: /** @type {typeof fetch} */ (impl),
    calls,
    searches: () => calls.filter((c) => c.url.includes('search-index')),
    docs: () => calls.filter((c) => c.url.includes('primary_doc.xml')),
  };
}
