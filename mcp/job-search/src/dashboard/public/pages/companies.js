// @ts-check
/**
 * Companies list. Section 9 item 15: GET /api/companies groups by (company, company_norm), so two rows
 * can share a company_norm with different raw company text. This page rolls those up into one visual
 * row per company_norm with a "(N name variants)" note, rather than presenting them as unrelated companies.
 */
import { h, setChildren } from '../lib/dom.js';
import { getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { dataTable } from '../components/data-table.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 8 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/companies'));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Companies could not be loaded right now.' })]);
      return;
    }
    const rows = outcome.body.rows;
    /** @type {Map<string, any[]>} */
    const byNorm = new Map();
    for (const row of rows) {
      if (!byNorm.has(row.company_norm)) byNorm.set(row.company_norm, []);
      byNorm.get(row.company_norm).push(row);
    }
    const merged = [...byNorm.entries()].map(([norm, variants]) => ({
      norm,
      company: variants[0].company,
      variantCount: variants.length,
      listings: variants.reduce((a, v) => a + v.listings, 0),
      active: variants.reduce((a, v) => a + v.active, 0),
    })).sort((a, b) => b.listings - a.listings);

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Companies' }),
      merged.length === 0 ? emptyState({ message: 'No companies recorded yet.' }) : dataTable({
        columns: ['Company', 'Listings', 'Active'],
        rows: merged.map((c) => h('tr', { attrs: { tabindex: '0' }, on: { click: () => app.navigate('company-detail', { norm: c.norm }) } }, [
          h('td', {}, [h('span', { text: c.company }), c.variantCount > 1 ? h('span', { className: 'badge badge--variants', text: `(${c.variantCount} name variants)` }) : null]),
          h('td', { text: String(c.listings) }),
          h('td', { text: String(c.active) }),
        ])),
      }),
    ]);
  }

  await load();
  return { name: 'companies', refresh: load };
}
