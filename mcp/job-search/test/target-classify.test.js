// @ts-check
/**
 * src/core/target-classify.js (target finder PR1). Pure, no DB. Covers totality, exclusions, dates, size,
 * Form D issuers, the gap trigger, and dedup. The exclusion wrapper and evidence registry have their own
 * files (target-exclusion.test.js, target-evidence.test.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySignal, loadTargetRules, EMITTABLE_RULES, TARGET_CLASSES, isCtoLevelTitle, isHiringLeadershipTitle,
  parseDay, effectiveConfidence, sizeFromHeadcount, dedupSignals, countByClass, SIZE_CONFIDENCES,
} from '../src/core/target-classify.js';
import { classifyTitle } from '../src/core/title-gate.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = '2026-10-15';
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null };

const BASE = Object.freeze({
  trigger_kind: 'pe_deal',
  company: 'Northwind Logistics',
  acquirer: 'Example Capital',
  event_date: '2026-09-20',
  evidence_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/0001234567-26-000042-index.htm',
  evidence_source: 'edgar_8k',
  size: { low: 120_000_000, high: 300_000_000, basis: 'stated', confidence: 'high' },
  text: 'Example Capital completed its acquisition of Northwind Logistics.',
});

/** @param {Record<string, any>} [patch] @param {Partial<import('../src/core/target-classify.js').ClassifyOptions>} [opts] */
function run(patch = {}, opts = {}) {
  /** @type {Record<string, any>} */
  const sig = { ...BASE };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete sig[k]; else sig[k] = v;
  }
  return classifySignal(sig, { rules: RULES, now: NOW, blocked: OK_LIST, ...opts });
}

/** @param {number} n days before NOW as YYYY-MM-DD */
function daysAgo(n) {
  const d = new Date(Date.parse(NOW) - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe('totality', () => {
  test('the base signal is a target', () => {
    const v = run();
    assert.equal(v.class, 'target');
    assert.equal(v.rule, 'target_all_checks_passed');
  });

  const GARBAGE = [undefined, null, '', 0, -1, NaN, Infinity, true, false, {}, [], [[]], 'x'.repeat(5000), '​', '­', {}.constructor, () => 1, Symbol('s'), 10n, new Date('nope'), { toString() { throw new Error('boom'); } }];
  const FIELDS = ['trigger_kind', 'company', 'aliases', 'acquirer', 'investor', 'pe_firm', 'text', 'evidence_url', 'evidence_source', 'event_date', 'filing_date', 'size', 'employees', 'offering_amount', 'issuer', 'role', 'listings', 'departure_signal'];

  for (const kind of ['pe_deal', 'exec_departure', 'leadership_gap']) {
    test(`garbage in every field of a ${kind} signal yields exactly one valid class and a registered rule`, () => {
      let count = 0;
      for (const field of FIELDS) {
        for (const g of GARBAGE) {
          const v = run({ trigger_kind: kind, [field]: g });
          count += 1;
          assert.ok(TARGET_CLASSES.includes(v.class), `${field}: bad class ${v.class}`);
          assert.ok(EMITTABLE_RULES.includes(v.rule), `${field}: unregistered rule ${v.rule}`);
          assert.equal(typeof v.inputs, 'object');
          JSON.stringify(v.inputs);
        }
      }
      assert.ok(count > 300);
    });
  }

  test('non-object signals are needs-review invalid_input', () => {
    for (const s of [null, undefined, 5, 'str', [], [1], true, () => 1]) {
      const v = classifySignal(s, { rules: RULES, now: NOW, blocked: OK_LIST });
      assert.equal(v.class, 'needs-review');
      assert.equal(v.rule, 'invalid_input');
    }
  });

  test('nested garbage inside size, issuer, and listings never escapes the classification', () => {
    for (const g of GARBAGE) {
      for (const patch of [{ size: { low: g, high: g, basis: g, confidence: g } }, { issuer: { name: g, sic: g }, evidence_source: 'edgar_form_d' }, { trigger_kind: 'leadership_gap', listings: [g, { title: g, description: g }], departure_signal: false }]) {
        const v = run(patch);
        assert.ok(TARGET_CLASSES.includes(v.class));
        assert.ok(EMITTABLE_RULES.includes(v.rule));
      }
    }
  });

  test('a rule the config does not declare with the same class degrades to needs-review, never target', () => {
    const rules = { ...RULES, verdict_rules: RULES.verdict_rules.map((r) => (r.rule === 'target_all_checks_passed' ? { ...r, class: /** @type {const} */ ('needs-review') } : r)) };
    const v = classifySignal({ ...BASE }, { rules, now: NOW, blocked: OK_LIST });
    assert.equal(v.class, 'needs-review');
    assert.equal(v.rule, 'classifier_error');
  });

  test('a step the code has no handler for is needs-review classifier_error', () => {
    const rules = { ...RULES, steps: [...RULES.steps, { id: 'mystery', priority: 50 }] };
    const v = classifySignal({ ...BASE }, { rules, now: NOW, blocked: OK_LIST });
    assert.equal(v.rule, 'classifier_error');
  });

  test('step order follows priority numbers, not file position', () => {
    // Swap the priorities of date and size: a stale date and a missing size now report size first.
    const swapped = RULES.steps.map((s) => (s.id === 'date' ? { ...s, priority: 500 } : s.id === 'size' ? { ...s, priority: 400 } : s));
    const rules = { ...RULES, steps: [...swapped].reverse() };
    const v = classifySignal({ ...BASE, event_date: daysAgo(400), size: null }, { rules, now: NOW, blocked: OK_LIST });
    assert.equal(v.rule, 'size_none');
  });

  test('every verdict carries its inputs', () => {
    const v = run();
    assert.equal(v.inputs.company, 'Northwind Logistics');
    assert.equal(v.inputs.trigger_kind, 'pe_deal');
    assert.equal(v.inputs.trigger_date, '2026-09-20');
  });
});

describe('trigger kind', () => {
  for (const k of [undefined, null, '', 'PE_DEAL', 'rumor', 5, {}]) {
    test(`unrecognized trigger kind ${JSON.stringify(k) ?? 'undefined'} is needs-review`, () => {
      const v = run({ trigger_kind: k });
      assert.equal(v.class, 'needs-review');
      assert.equal(v.rule, 'trigger_kind_unrecognized');
    });
  }
});

describe('exclusion through the classifier', () => {
  test('Advisicon Holdings is not-target', () => {
    const v = run({ company: 'Advisicon Holdings' });
    assert.equal(v.class, 'not-target');
    assert.equal(v.rule, 'excl_blocked_company');
  });
  test('NFKC full-width and zero-width forms of a blocked company are not-target', () => {
    for (const name of ['Ａdvisicon', 'Adv​isicon LLC', 'Advi­sicon', 'ADVISICON‍ Inc']) {
      assert.equal(run({ company: name }).class, 'not-target', name);
    }
  });
  test('a space-stripped-only form is needs-review, never target and never not-target', () => {
    for (const name of ['Ad visicon', 'A d v i s i c o n Corp', 'Advis-icon']) {
      const v = run({ company: name });
      assert.equal(v.class, 'needs-review', name);
      assert.equal(v.rule, 'excl_blocked_suspect', name);
    }
  });
  test('a blocked affiliate in the acquirer field is needs-review; in the company field not-target', () => {
    const blocked = { entries: [...BUILT_IN_BLOCKED, 'Zenith Parent Group'], status: /** @type {const} */ ('ok'), error: null };
    assert.equal(run({ acquirer: 'Zenith Parent Group LLC' }, { blocked }).rule, 'excl_blocked_suspect');
    assert.equal(run({ company: 'Zenith Parent Group' }, { blocked }).rule, 'excl_blocked_company');
    assert.equal(run({ investor: 'Zenith​ Parent Group' }, { blocked }).class, 'needs-review');
    assert.equal(run({ pe_firm: 'Zenith Parent Group' }, { blocked }).class, 'needs-review');
  });
  test('a blocked name in an alias is the same company: not-target', () => {
    assert.equal(run({ aliases: ['Northwind', 'Advisicon Holdings'] }).class, 'not-target');
  });
  test('a blocked name in the excerpt is needs-review', () => {
    assert.equal(run({ text: 'Formerly a client of Advisicon.' }).class, 'needs-review');
  });
  test('blank, confidential, and placeholder companies are needs-review unknown_company', () => {
    for (const c of [undefined, null, '', '   ', 'Confidential', 'n/a', 'TBD', 'X']) {
      const v = run({ company: c });
      assert.equal(v.class, 'needs-review');
      assert.equal(v.rule, 'excl_unknown_company');
    }
  });
  test('an unavailable blocklist keeps a clean signal out of target', () => {
    for (const status of /** @type {const} */ (['missing', 'invalid'])) {
      const v = run({}, { blocked: { entries: [...BUILT_IN_BLOCKED], status, error: 'x' } });
      assert.equal(v.class, 'needs-review');
      assert.equal(v.rule, 'excl_blocklist_unavailable');
    }
    // built-ins still apply while the list is unavailable
    assert.equal(run({ company: 'Advisicon' }, { blocked: { entries: [...BUILT_IN_BLOCKED], status: 'missing', error: null } }).class, 'not-target');
  });
  test('an omitted blocked option behaves as an unavailable list (never target)', () => {
    const v = classifySignal({ ...BASE }, { rules: RULES, now: NOW });
    assert.equal(v.rule, 'excl_blocklist_unavailable');
  });
  test('an applied-company match is needs-review', () => {
    assert.equal(run({}, { appliedCompanies: ['Northwind Logistics Inc'] }).rule, 'excl_applied_before');
  });
});

describe('trigger date', () => {
  test('null, missing, and empty-string event dates are needs-review date_missing', () => {
    for (const d of [null, undefined, '']) assert.equal(run({ event_date: d, filing_date: undefined }).rule, 'date_missing');
  });
  test('invalid dates are needs-review date_invalid', () => {
    for (const d of ['not a date', '2026-02-30', '2026-13-01', '10/15/2026', 20261015, {}, [], '2026-1-5']) {
      assert.equal(run({ event_date: d }).rule, 'date_invalid', String(d));
    }
  });
  test('an invalid event date is not papered over by a valid filing date', () => {
    assert.equal(run({ event_date: 'garbage', filing_date: '2026-10-01' }).rule, 'date_invalid');
  });
  test('the event date wins over the filing date; the filing date is the fallback', () => {
    assert.equal(run({ event_date: '2026-10-10', filing_date: '2026-01-01' }).class, 'target');
    const v = run({ event_date: undefined, filing_date: '2026-10-10' });
    assert.equal(v.class, 'target');
    assert.equal(v.inputs.date_source, 'filing_date');
  });
  test('future dates: 7 days allowed, 8 days needs-review', () => {
    assert.equal(run({ event_date: '2026-10-22' }).class, 'target');
    const v = run({ event_date: '2026-10-23' });
    assert.equal(v.class, 'needs-review');
    assert.equal(v.rule, 'date_future');
  });
  test('stale per window: 120 days for pe_deal and exec_departure, 60 for leadership_gap', () => {
    assert.equal(run({ event_date: daysAgo(120) }).class, 'target');
    assert.equal(run({ event_date: daysAgo(121) }).rule, 'date_stale');
    assert.equal(run({ event_date: daysAgo(121) }).class, 'not-target');
    const dep = { trigger_kind: 'exec_departure', role: 'CTO' };
    assert.equal(run({ ...dep, event_date: daysAgo(120) }).class, 'target');
    assert.equal(run({ ...dep, event_date: daysAgo(121) }).rule, 'date_stale');
    const gap = { trigger_kind: 'leadership_gap', evidence_source: 'listings', evidence_url: 'https://boards.example.com/n/jobs/1', listings: [{ title: 'VP of Engineering' }], departure_signal: false };
    assert.equal(run({ ...gap, event_date: daysAgo(60) }).class, 'target');
    assert.equal(run({ ...gap, event_date: daysAgo(61) }).rule, 'date_stale');
  });
  test('parseDay is strict', () => {
    assert.equal(parseDay('2026-02-29'), null);
    assert.equal(parseDay('2028-02-29'), Date.UTC(2028, 1, 29));
    assert.equal(parseDay('2026-10-15T12:00:00Z'), Date.UTC(2026, 9, 15));
    assert.equal(parseDay('2026-10-15Tgarbage'), null);
    assert.equal(parseDay(null), null);
  });
});

describe('evidence step', () => {
  test('missing and registry-failing evidence are needs-review', () => {
    assert.equal(run({ evidence_url: undefined }).rule, 'evidence_missing');
    assert.equal(run({ evidence_url: '  ' }).rule, 'evidence_missing');
    assert.equal(run({ evidence_url: 'https://evil.example.com/Archives/edgar/data/1/000123456726000042/x' }).rule, 'evidence_invalid');
    assert.equal(run({ evidence_source: 'carrier_pigeon' }).rule, 'evidence_invalid');
  });
});

describe('size', () => {
  const sz = (/** @type {any} */ low, /** @type {any} */ high, /** @type {any} */ basis, /** @type {any} */ confidence) => ({ size: { low, high, basis, confidence } });
  test('missing size and confidence none are size_none', () => {
    assert.equal(run({ size: undefined }).rule, 'size_none');
    assert.equal(run(sz(1e8, 2e8, 'stated', 'none')).rule, 'size_none');
    assert.equal(run(sz(null, null, 'stated', 'high')).rule, 'size_none');
  });
  test('the confidence enum is a total mapping: unknown values behave as none', () => {
    for (const c of ['HIGH', 'certain', '', null, undefined, 5, {}, []]) assert.equal(effectiveConfidence(c, 'stated', {}), 'none');
    for (const c of SIZE_CONFIDENCES) assert.equal(effectiveConfidence(c, 'stated', {}), c);
  });
  test('confidence x position table', () => {
    /** @type {Array<[string, number, number, string, string]>} */
    const table = [
      ['high', 1e8, 3e8, 'target', 'target_all_checks_passed'],
      ['medium', 1e8, 3e8, 'target', 'target_all_checks_passed'],
      ['low', 1e8, 3e8, 'needs-review', 'size_low_confidence'],
      ['high', 1e6, 5e6, 'not-target', 'size_out_of_band'],
      ['high', 2e9, 5e9, 'not-target', 'size_out_of_band'],
      ['medium', 1e6, 5e6, 'needs-review', 'size_not_clearly_in_band'],
      ['low', 2e9, 5e9, 'needs-review', 'size_not_clearly_in_band'],
      ['high', 1e7, 2e8, 'needs-review', 'size_not_clearly_in_band'],
      ['high', 5e8, 2e9, 'needs-review', 'size_not_clearly_in_band'],
    ];
    for (const [conf, lo, hi, cls, rule] of table) {
      const v = run(sz(lo, hi, 'stated', conf));
      assert.deepEqual([v.class, v.rule], [cls, rule], `${conf} ${lo}-${hi}`);
    }
  });
  test('band edges are inclusive', () => {
    assert.equal(run(sz(5e7, 1e9, 'stated', 'high')).class, 'target');
  });
  test('one bound known, reversed bounds, and non-numeric bounds are needs-review', () => {
    assert.equal(run(sz(1e8, null, 'stated', 'high')).rule, 'size_one_bound');
    assert.equal(run(sz(null, 1e8, 'stated', 'high')).rule, 'size_one_bound');
    assert.equal(run(sz(3e8, 1e8, 'stated', 'high')).rule, 'size_invalid');
    assert.equal(run(sz('100M', 2e8, 'stated', 'high')).rule, 'size_invalid');
    assert.equal(run(sz(-1, 2e8, 'stated', 'high')).rule, 'size_invalid');
    assert.equal(run(sz(NaN, 2e8, 'stated', 'high')).rule, 'size_invalid');
  });
  test('a Form D offering amount is never size', () => {
    // as a basis: forced to none even at claimed high confidence
    assert.equal(run(sz(1e8, 2e8, 'form_d_offering_amount', 'high')).rule, 'size_none');
    // as a stray field: never read, so a signal with only an offering amount has no size
    const v = run({ size: undefined, offering_amount: 150_000_000 });
    assert.equal(v.rule, 'size_none');
    // an out-of-band offering amount must not produce a not-target either
    assert.equal(run({ size: undefined, offering_amount: 1_000 }).class, 'needs-review');
  });
  test('a Form D revenue range is capped at medium: in band passes, out of band is only needs-review', () => {
    assert.equal(run(sz(1e8, 2e8, 'form_d_revenue_range', 'high')).class, 'target');
    const out = run(sz(1e6, 5e6, 'form_d_revenue_range', 'high'));
    assert.equal(out.class, 'needs-review');
    assert.equal(out.inputs.size_confidence, 'medium');
  });
  test('headcount conversion is capped at low and never reaches target', () => {
    const conv = sizeFromHeadcount(400, RULES.params.headcount_revenue_per_employee);
    assert.deepEqual(conv, { low: 60_000_000, high: 160_000_000, basis: 'headcount', confidence: 'low' });
    const v = run({ size: undefined, employees: 400 });
    assert.equal(v.class, 'needs-review');
    assert.equal(v.rule, 'size_low_confidence');
    assert.equal(run(sz(6e7, 1.6e8, 'headcount', 'high')).rule, 'size_low_confidence');
    assert.equal(run({ size: undefined, employees: 2 }).class, 'needs-review');
    assert.equal(sizeFromHeadcount(0, RULES.params.headcount_revenue_per_employee), null);
    assert.equal(sizeFromHeadcount('400', RULES.params.headcount_revenue_per_employee), null);
  });
});

describe('Form D issuer', () => {
  const formD = (/** @type {any} */ issuer) => ({ evidence_source: 'edgar_form_d', issuer });
  test('fund-like names are needs-review', () => {
    for (const name of ['Northwind Growth Fund II LP', 'Northwind Partners Fund', 'Northwind Opportunity SPV', 'Northwind L.P.', 'Northwind Funds Inc', 'NORTHWIND FUND']) {
      const v = run(formD({ name, sic: '7372' }));
      assert.equal(v.rule, 'form_d_fund_issuer', name);
    }
  });
  test('SIC 6799 is needs-review even with an operating-sounding name', () => {
    assert.equal(run(formD({ name: 'Northwind Logistics Holdings', sic: '6799' })).rule, 'form_d_fund_issuer');
    assert.equal(run(formD({ name: 'Northwind Logistics Holdings', sic: 6799 })).rule, 'form_d_fund_issuer');
  });
  test('a missing issuer name on a Form D signal is needs-review', () => {
    assert.equal(run(formD({ sic: '7372' })).rule, 'form_d_issuer_unknown');
    assert.equal(run({ evidence_source: 'edgar_form_d' }).rule, 'form_d_issuer_unknown');
  });
  test('an operating-company issuer passes', () => {
    assert.equal(run(formD({ name: 'Northwind Logistics Inc', sic: '4731' })).class, 'target');
  });
});

describe('CTO-level title test (reuses the triage title floor)', () => {
  const CTO_LEVEL = ['Chief Technology Officer', 'CTO', 'Chief Information Officer', 'Chief Digital Officer', 'Chief Data Officer', 'Chief AI Officer', 'Head of Technology', 'Head of IT', 'Field CTO', 'SVP and CIO'];
  const NOT_CTO_LEVEL = ['VP of Engineering', 'Director of Engineering', 'Head of Engineering', 'Chief Financial Officer', 'Chief Marketing Officer', 'Chief of Staff to the CTO', 'Deputy CTO', 'Chief Product Officer', 'Software Engineer', '', 'Head of Sales'];
  test('CTO-level titles, including Head of Technology and Chief Digital Officer', () => {
    for (const t of CTO_LEVEL) assert.equal(isCtoLevelTitle(t), true, t);
  });
  test('non CTO-level titles', () => {
    for (const t of NOT_CTO_LEVEL) assert.equal(isCtoLevelTitle(t), false, t);
    for (const t of [null, undefined, 5, {}]) assert.equal(isCtoLevelTitle(t), false);
  });
  test('every CTO-level title passes the SAME floor triage uses; a floor drop is never CTO-level', () => {
    for (const t of CTO_LEVEL) assert.equal(classifyTitle(t).verdict, 'pass', t);
    for (const t of ['Director of IT', 'Chief Financial Officer', 'Associate Director, Data']) {
      assert.equal(classifyTitle(t).verdict, 'drop', t);
      assert.equal(isCtoLevelTitle(t), false, t);
    }
  });
  test('hiring leadership titles', () => {
    for (const t of ['VP of Engineering', 'Director of Engineering', 'Head of Engineering', 'VP, Software Platform', 'Senior Director, Technology']) assert.equal(isHiringLeadershipTitle(t), true, t);
    for (const t of ['Chief Technology Officer', 'Head of Technology', 'VP, Sales', 'Software Engineer', 'Director of Marketing', 'Chief Financial Officer', '']) assert.equal(isHiringLeadershipTitle(t), false, t);
  });
});

describe('gap trigger and departure role', () => {
  const GAP = { trigger_kind: 'leadership_gap', evidence_source: 'listings', evidence_url: 'https://boards.example.com/n/jobs/1', event_date: '2026-10-01', departure_signal: false };
  test('a hiring VP engineering listing, no CTO-level listing, no departure signal is a target', () => {
    assert.equal(run({ ...GAP, listings: [{ title: 'VP of Engineering' }] }).class, 'target');
  });
  test('a CTO-level listing present is needs-review', () => {
    assert.equal(run({ ...GAP, listings: [{ title: 'VP of Engineering' }, { title: 'Chief Digital Officer' }] }).rule, 'gap_cto_level_listing_present');
  });
  test('no hiring-leadership listing is needs-review, even with a reports-to-CEO hint', () => {
    assert.equal(run({ ...GAP, listings: [] }).rule, 'gap_no_hiring_listing');
    assert.equal(run({ ...GAP, listings: undefined }).rule, 'gap_no_hiring_listing');
    const v = run({ ...GAP, listings: [{ title: 'Senior Software Engineer', description: 'This role reports directly to the CEO.' }] });
    assert.equal(v.rule, 'gap_no_hiring_listing');
    assert.equal(v.inputs.reports_to_ceo_hint, true);
  });
  test('the reports-to-CEO hint is recorded but never sufficient and never required', () => {
    const v = run({ ...GAP, listings: [{ title: 'Head of Engineering', description: 'Reports to the CEO' }] });
    assert.equal(v.class, 'target');
    assert.equal(v.inputs.reports_to_ceo_hint, true);
  });
  test('a departure signal, or an unknown one, is needs-review', () => {
    for (const d of [true, undefined, null, 'no', 0]) {
      assert.equal(run({ ...GAP, listings: [{ title: 'VP of Engineering' }], departure_signal: d }).rule, 'gap_departure_not_ruled_out', String(d));
    }
  });
  test('an exec_departure must name a CTO-level role', () => {
    assert.equal(run({ trigger_kind: 'exec_departure', role: 'Chief Financial Officer' }).rule, 'departure_role_not_cto_level');
    assert.equal(run({ trigger_kind: 'exec_departure', role: undefined }).rule, 'departure_role_not_cto_level');
    assert.equal(run({ trigger_kind: 'exec_departure', role: 'Chief Information Officer' }).class, 'target');
  });
});

describe('dedup after classification', () => {
  test('the fresh signal survives; the stale one is collapsed and logged', () => {
    const { kept, collapsed } = dedupSignals([
      { id: 1, company: 'Acme Inc', class: /** @type {const} */ ('not-target'), trigger_date: '2026-01-01' },
      { id: 2, company: 'ACME', class: /** @type {const} */ ('target'), trigger_date: '2026-10-01' },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, 2);
    assert.deepEqual(kept[0].collapsed_ids, [1]);
    assert.deepEqual(collapsed, [{ kept_id: 2, company_norm: 'acme', collapsed_ids: [1] }]);
  });
  test('same class keeps the newest date; null and invalid dates sort oldest; ties keep the higher id', () => {
    const c = /** @type {const} */ ('target');
    const { kept } = dedupSignals([
      { id: 1, company: 'Acme', class: c, trigger_date: null },
      { id: 2, company: 'Acme', class: c, trigger_date: '2026-09-01' },
      { id: 3, company: 'Acme', class: c, trigger_date: '2026-10-01' },
      { id: 4, company: 'Acme', class: c, trigger_date: 'garbage' },
      { id: 5, company: 'Acme', class: c, trigger_date: '2026-10-01' },
    ]);
    assert.equal(kept[0].id, 5);
    assert.deepEqual([...kept[0].collapsed_ids].sort(), [1, 2, 3, 4]);
  });
  test('best outcome beats newer date: an older needs-review beats a newer not-target', () => {
    const { kept } = dedupSignals([
      { id: 1, company: 'Acme', class: /** @type {const} */ ('needs-review'), trigger_date: '2026-06-01' },
      { id: 2, company: 'Acme', class: /** @type {const} */ ('not-target'), trigger_date: '2026-10-10' },
    ]);
    assert.equal(kept[0].id, 1);
  });
  test('different companies, blank companies, and confidential companies never group', () => {
    const c = /** @type {const} */ ('target');
    const { kept } = dedupSignals([
      { id: 1, company: 'Acme', class: c, trigger_date: '2026-10-01' },
      { id: 2, company: 'Beta', class: c, trigger_date: '2026-10-01' },
      { id: 3, company: '', class: c, trigger_date: '2026-10-01' },
      { id: 4, company: '', class: c, trigger_date: '2026-10-01' },
      { id: 5, company: 'Confidential', class: c, trigger_date: '2026-10-01' },
      { id: 6, company: 'Confidential', class: c, trigger_date: '2026-10-01' },
    ]);
    assert.equal(kept.length, 6);
  });
  test('zero-width and suffix variants group together', () => {
    const c = /** @type {const} */ ('target');
    const { kept } = dedupSignals([
      { id: 1, company: 'Acme​ Corp', class: c, trigger_date: '2026-10-01' },
      { id: 2, company: 'Acme, Inc.', class: c, trigger_date: '2026-10-02' },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, 2);
  });
  test('countByClass gives the weekly not-target count', () => {
    assert.deepEqual(countByClass([{ class: 'target' }, { class: 'not-target' }, { class: 'not-target' }, { class: 'needs-review' }, { class: 'bogus' }]), { 'target': 1, 'needs-review': 1, 'not-target': 2 });
  });
});
