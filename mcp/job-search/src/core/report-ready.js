// @ts-check
/**
 * Report section "Ready to apply" (spec section 8, R4, R5, A8, A9, A10). Re-exported by src/core/report.js.
 *
 * collectReadyToApply() classifies the list live at send time (src/core/ready-to-apply.js), refreshes the
 * ledger, and, when the caller is really showing it (a real send, not a dry run), writes the manual-only
 * locks for the listed rows (A1). Any failure becomes { error } and renders as a visible
 * "[READY LIST ERROR]" line under the section header: the section is ALWAYS rendered, never omitted.
 *
 * Links here deliberately skip report.js's source-domain registry (urlPassesRegistry): a recruiter or
 * company career site never passes it, and those are the links this list exists to show. Every link was
 * already checked by readyLinkCheck (A8); an unsafe one is withheld (held_unsafe_link). HTML anchors carry
 * rel="noopener noreferrer", every field is escaped, and the host is printed as text beside the link.
 */
import { classifyReadyList, refreshReadyLedger, readyConfig, HELD_BUCKETS } from './ready-to-apply.js';
import { errFields } from './errors.js';

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const CHANNEL_LABELS = Object.freeze({
  linkedin_easy: 'LinkedIn Easy Apply', linkedin_page: 'LinkedIn', indeed_easy: 'Indeed Easy Apply', indeed_page: 'Indeed',
  external_manual: 'company site', ats_manual: 'company ATS', ats_inferred: 'company ATS (unverified target)',
  ats_exact: 'company ATS', listing_page: 'listing page', easy_other: 'Easy Apply',
});

export const FLAG_LABELS = Object.freeze({
  manual_only: 'manual only (shown on this list)', no_apply_control_seen: 'no Apply button was seen; check the page',
  external_target_unknown: 'applies off LinkedIn; target not captured', probe_state_unknown: 'apply target not checked',
  unverified_target: 'unverified target', fit_unverified: 'fit unverified',
});

export const HELD_LABELS = Object.freeze({
  held_applied_company_other_role: 'applied to another role at this company',
  held_blocked_company_suspect: 'a blocked employer may be behind this listing',
  held_unknown_company: 'company unknown or a placeholder',
  held_fit_unverified: 'fit unverified (no description)',
  held_location_unknown: 'location unknown',
  held_no_description: 'no description yet',
  held_not_probed: 'apply target not checked yet',
  held_awaiting_reprobe: 'awaiting re-probe (no Apply button seen once)',
  held_no_link: 'no usable apply link',
  held_unsafe_link: 'unsafe link withheld',
  held_markup_drift: 'LinkedIn page markup may have changed; not locked',
  held_auto_stalled: 'auto-apply has not submitted it in 2 morning runs',
  held_stale_application: 'application parked waiting on you',
  held_unknown: 'unclassified',
});

/**
 * View model shared by the report and the dashboard API.
 * @param {Awaited<ReturnType<typeof classifyReadyList>>} res
 * @param {{ now: Date, dashboardUrl?: string|null }} o
 */
export function readyView(res, o) {
  const rc = res.config;
  const dayMs = 86400000;
  const ready = res.ready.map((r) => {
    const fl = r.row.firstListedAt ? new Date(r.row.firstListedAt).getTime() : null;
    const resume = r.row.resume ?? { status: 'none', relPath: null, reviewVerdict: null, lastError: null, docId: null, attempts: 0 };
    return {
      listingId: r.listingId, fit: r.row.fitScore, title: r.row.title, company: r.row.company, source: r.row.source,
      channel: r.channel, channelLabel: CHANNEL_LABELS[/** @type {keyof typeof CHANNEL_LABELS} */ (r.channel)] ?? String(r.channel ?? 'unknown'),
      alsoOn: r.alsoOn, link: r.link, host: r.host, isNew: fl === null || o.now.getTime() - fl < dayMs, firstListedAt: r.row.firstListedAt ?? null,
      flags: r.flags, flagLabels: r.flags.map((f) => FLAG_LABELS[/** @type {keyof typeof FLAG_LABELS} */ (f)] ?? f), handedBack: Boolean(r.row.handedBack),
      resume: {
        status: r.resumeEligible ? resume.status : 'skipped_no_description', relPath: resume.relPath ?? null, docId: resume.docId ?? null,
        verdict: resume.reviewVerdict ?? null, lastError: resume.lastError ?? null, attempts: resume.attempts ?? 0, eligible: r.resumeEligible,
      },
    };
  });
  const held = res.held.map((r) => ({
    listingId: r.listingId, fit: r.row.fitScore, title: r.row.title, company: r.row.company, source: r.row.source, bucket: r.bucket,
    bucketLabel: HELD_LABELS[/** @type {keyof typeof HELD_LABELS} */ (r.bucket)] ?? r.bucket, reason: r.reason, link: r.link, host: r.host,
    applicationId: r.applicationId, handedBack: Boolean(r.row.handedBack),
  }));
  const resumeCounts = { ready: 0, pending: 0, failed: 0, gaveUp: 0, noDescription: 0 };
  for (const r of ready) {
    const s = r.resume.status;
    if (s === 'ready') resumeCounts.ready++;
    else if (s === 'failed') resumeCounts.failed++;
    else if (s === 'gave_up') resumeCounts.gaveUp++;
    else if (s === 'skipped_no_description') resumeCounts.noDescription++;
    else resumeCounts.pending++;
  }
  const excluded = Object.values(res.excludedCounts).reduce((a, b) => a + b, 0);
  return {
    enabled: true,
    generatedAt: /** @type {any} */ (res).generatedAt ?? o.now.toISOString(),
    autoSubmitCount: res.autoSubmitCount,
    counts: { ready: ready.length, held: held.length, excluded },
    bucketCounts: res.counts,
    total: res.total,
    resumeCounts,
    ready,
    held,
    excludedCounts: res.excludedCounts,
    drift: res.drift,
    dashboardUrl: o.dashboardUrl ?? null,
    maxRows: rc?.reportMaxRows ?? 40,
    heldMaxRows: rc?.heldReportMaxRows ?? 20,
  };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ config: any, now: Date, display: boolean, dashboardUrl?: string|null }} o
 */
export async function collectReadyToApply(client, o) {
  try {
    if (!o.config) return { error: 'config could not be loaded' };
    if (!readyConfig(o.config).enabled) return { enabled: false };
    const res = await classifyReadyList(client, { config: o.config, now: o.now });
    await refreshReadyLedger(client, res, o.now, { display: o.display });
    return readyView(res, o);
  } catch (err) {
    return { error: errFields(err).err_message };
  }
}

/** @param {any} r */
function resumeText(r) {
  const s = r.resume ?? {};
  if (!s.eligible || s.status === 'skipped_no_description') return 'no resume (no description)';
  if (s.status === 'ready') return `output/${s.relPath ?? '(file)'} (${s.verdict ? `review ${s.verdict}` : 'not reviewed'})`;
  if (s.status === 'running') return 'drafting now';
  if (s.status === 'failed') return s.verdict === 'FAIL' ? `review FAIL (${s.lastError ?? 'review_failed'}), will retry` : `failed (${s.lastError ?? 'unknown'}), will retry`;
  if (s.status === 'gave_up') return s.verdict === 'FAIL' ? `gave up, review FAIL (${s.lastError ?? 'review_failed'})` : `gave up (${s.lastError ?? 'unknown'})`;
  return 'pending';
}

/** @param {any} r */
function readyHeadParts(r) {
  const channel = r.alsoOn && r.alsoOn.length ? `${r.channelLabel}, also on ${r.alsoOn.join(', ')}` : r.channelLabel;
  const parts = [`[fit ${r.fit ?? '?'}] ${r.title ?? 'n/a'}`, r.company ?? 'n/a', channel];
  if (r.host) parts.push(r.host);
  if (r.isNew) parts.push('NEW');
  if (r.flagLabels && r.flagLabels.length) parts.push(`note: ${r.flagLabels.join('; ')}`);
  return parts;
}

/** @param {any} h */
function heldLine(h) {
  const parts = [`[fit ${h.fit ?? '?'}] ${h.title ?? 'n/a'}`, h.company ?? 'n/a', h.bucketLabel];
  if (h.applicationId) parts.push(`application #${h.applicationId}`);
  if (h.link) parts.push(h.link);
  return parts.join(' | ');
}

/** @param {any} d */
function countsLine(d) {
  const rc = d.resumeCounts;
  return `auto-submit path ${d.autoSubmitCount} | ready ${d.counts.ready} | held ${d.counts.held} | excluded ${d.counts.excluded} | resumes ready ${rc.ready}, pending ${rc.pending}, failed ${rc.failed}, gave up ${rc.gaveUp}, no description ${rc.noDescription}`;
}

/** @param {any} d */
function driftLine(d) {
  return d.drift && d.drift.tripped
    ? `[MARKUP DRIFT] ${d.drift.driftRows} of ${d.drift.probedRows} probed LinkedIn pages showed no Apply control; those rows are held and not locked`
    : null;
}

/** @param {any} d */
function excludedLine(d) {
  const parts = Object.entries(d.excludedCounts ?? {}).map(([k, n]) => `${k} ${n}`);
  return `-- Excluded (${d.counts.excluded}) --${parts.length ? ` ${parts.join(', ')}` : ''}`;
}

/** @param {any} d @returns {string|null} a terminal line for the error/disabled states */
function terminalState(d) {
  if (!d || typeof d !== 'object') return '[READY LIST ERROR]: no data';
  if (d.error) return `[READY LIST ERROR]: ${String(d.error).slice(0, 300)}`;
  if (d.enabled === false) return '(disabled in config)';
  return null;
}

/** @param {any} d */
export function renderReadyToApplyText(d) {
  const term = terminalState(d);
  if (term) return ['== Ready to apply ==', term].join('\n');
  const lines = [`== Ready to apply (${d.counts.ready}) ==`, countsLine(d)];
  const drift = driftLine(d);
  if (drift) lines.push(drift);
  if (d.ready.length === 0) lines.push('(none)');
  d.ready.slice(0, d.maxRows).forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    lines.push(` ${i + 1}. ${readyHeadParts(r).join(' | ')}`);
    lines.push(r.link ? `    apply: ${r.link}` : '    apply: (no usable link)');
    lines.push(`    resume: ${resumeText(r)}`);
  });
  if (d.ready.length > d.maxRows) lines.push(` and ${d.ready.length - d.maxRows} more on the dashboard`);
  if (d.dashboardUrl) lines.push(`dashboard: ${d.dashboardUrl}`);
  lines.push(`-- Held (${d.held.length}) --`);
  for (const h of d.held.slice(0, d.heldMaxRows)) lines.push(`  ${heldLine(h)}`);
  if (d.held.length > d.heldMaxRows) lines.push(`  and ${d.held.length - d.heldMaxRows} more on the dashboard`);
  lines.push(excludedLine(d));
  return lines.join('\n');
}

/** @param {any} d */
export function renderReadyToApplyHtml(d) {
  const term = terminalState(d);
  if (term) return `<h3>Ready to apply</h3><p>${esc(term)}</p>`;
  const parts = [`<h3>Ready to apply (${d.counts.ready})</h3>`, `<p>${esc(countsLine(d))}</p>`];
  const drift = driftLine(d);
  if (drift) parts.push(`<p><strong>${esc(drift)}</strong></p>`);
  if (d.ready.length === 0) parts.push('<p>(none)</p>');
  else {
    parts.push('<ol>');
    for (const r of d.ready.slice(0, d.maxRows)) {
      const link = r.link ? `apply: <a href="${esc(r.link)}" rel="noopener noreferrer">${esc(r.link)}</a> (${esc(r.host ?? '')})` : 'apply: (no usable link)';
      parts.push(`<li>${esc(readyHeadParts(r).join(' | '))}<br>${link}<br>resume: ${esc(resumeText(r))}</li>`);
    }
    parts.push('</ol>');
  }
  if (d.ready.length > d.maxRows) parts.push(`<p>and ${d.ready.length - d.maxRows} more on the dashboard</p>`);
  if (d.dashboardUrl) parts.push(`<p>dashboard: <a href="${esc(d.dashboardUrl)}" rel="noopener noreferrer">${esc(d.dashboardUrl)}</a></p>`);
  parts.push(`<h4>Held (${d.held.length})</h4>`);
  if (d.held.length) {
    parts.push('<ul>');
    for (const h of d.held.slice(0, d.heldMaxRows)) {
      const base = [`[fit ${h.fit ?? '?'}] ${h.title ?? 'n/a'}`, h.company ?? 'n/a', h.bucketLabel, ...(h.applicationId ? [`application #${h.applicationId}`] : [])].join(' | ');
      parts.push(`<li>${esc(base)}${h.link ? ` | <a href="${esc(h.link)}" rel="noopener noreferrer">${esc(h.host ?? h.link)}</a>` : ''}</li>`);
    }
    parts.push('</ul>');
  }
  if (d.held.length > d.heldMaxRows) parts.push(`<p>and ${d.held.length - d.heldMaxRows} more on the dashboard</p>`);
  parts.push(`<p>${esc(excludedLine(d))}</p>`);
  return parts.join('\n');
}

/** @param {any} d */
export function renderReadyToApplyMarkdown(d) {
  const term = terminalState(d);
  if (term) return ['## Ready to apply', '', term].join('\n');
  const lines = [`## Ready to apply (${d.counts.ready})`, '', countsLine(d), ''];
  const drift = driftLine(d);
  if (drift) lines.push(`**${drift}**`, '');
  if (d.ready.length === 0) lines.push('(none)');
  d.ready.slice(0, d.maxRows).forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    lines.push(`${i + 1}. ${readyHeadParts(r).join(' | ')}`);
    lines.push(r.link ? `   - apply: ${r.link}` : '   - apply: (no usable link)');
    lines.push(`   - resume: ${resumeText(r)}`);
  });
  if (d.ready.length > d.maxRows) lines.push('', `and ${d.ready.length - d.maxRows} more on the dashboard`);
  if (d.dashboardUrl) lines.push('', `dashboard: ${d.dashboardUrl}`);
  lines.push('', `### Held (${d.held.length})`, '');
  for (const h of d.held.slice(0, d.heldMaxRows)) lines.push(`- ${heldLine(h)}`);
  if (d.held.length > d.heldMaxRows) lines.push(`- and ${d.held.length - d.heldMaxRows} more on the dashboard`);
  lines.push('', excludedLine(d));
  return lines.join('\n');
}

/** Held bucket list re-exported for the dashboard client contract. */
export { HELD_BUCKETS };
