// @ts-check
/**
 * Application card (apply pipeline slice 3, extended by slice 4, extended by slice 5, plan section 7
 * "Dashboard human gate"). Slice 5 scope: needs_human shows the latest screenshot (GET /api/applications/
 * :id/screenshot) alongside the existing credential prompt / generic pending-question panel, adds the
 * answer box for `pending_question.kind === 'question'` (Save promotes the label to the bank's `learned:`
 * tier per src/apply/answers.js's save-by-default rule; an "only this once" checkbox opts out), and a
 * universal "I applied by hand" action available from ANY needs_human kind. `failed` shows Retry.
 * `approved`/`submitting` update live over the existing SSE 'changed'/'events' stream (the worker's own
 * progress POSTs already trigger that broadcast; this card does not poll separately) -- see the PR body's
 * design note on why this reuses the existing plumbing instead of a new SSE event type.
 */
import { h, hApplicationScreenshot } from '../lib/dom.js';
import { postJson, getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { chipClassName, applicationStateChip } from './chips.js';
import { credentialPrompt } from './credential-prompt.js';
import { withdrawControl } from './withdraw-control.js';
import { resumeControl, partialDraftWarning } from './resume-control.js';
import { withdrawButtonVisible, resumeButtonVisible } from '../lib/format.js';

/** Apply exclusion gate (src/apply/exclusions.js): branches that are never overridable from the dashboard. */
const HARD_EXCLUSION_BRANCHES = new Set(['blocked_company', 'already_applied_listing', 'already_applied_history']);

/**
 * @param {{ listing: any, application: any|null, ats: any, documents: any[], onChanged: () => void, applyExclusion?: { branch: string|null, reason: string|null, error?: string }|null }} opts
 */
export function applicationCard(opts) {
  const { listing, application, ats, documents, applyExclusion } = opts;
  const excludedHard = Boolean(applyExclusion && applyExclusion.branch && HARD_EXCLUSION_BRANCHES.has(applyExclusion.branch));
  const excludedNeedsHuman = Boolean(applyExclusion && applyExclusion.branch && !excludedHard && applyExclusion.branch !== 'eligible');

  // Apply exclusion gate, NEEDS_HUMAN branch: this card instance's own click-again-to-confirm flag -- the
  // dashboard-wide "no native window.confirm/prompt/alert" rule (test/dashboard-lint.test.js) rules out a
  // modal dialog here too, so a first click on a NEEDS_HUMAN listing shows a toast and arms this flag; a
  // second click sends the explicit override.
  let overrideArmed = false;

  /** POST /api/listings/:id/apply-now, optionally with an explicit override (NEEDS_HUMAN branches only --
   * see routes/applications.js's applyExclusionGate). @param {boolean} [override] */
  async function postApplyNow(override) {
    const outcome = handleOutcome(await postJson(`/api/listings/${listing.id}/apply-now`, override ? { override: true } : {}));
    if (outcome.kind === 'ok') {
      overrideArmed = false;
      showToast({ message: 'Applying: drafting resume.' });
      opts.onChanged();
    } else if (outcome.kind === 'duplicate_application') {
      overrideArmed = false;
      showToast({ message: 'An application already exists for this listing.' });
      opts.onChanged();
    } else if (outcome.kind === 'apply_excluded') {
      overrideArmed = false;
      showToast({ message: `Blocked: ${outcome.reason}`, tone: 'error' });
    } else if (outcome.kind === 'apply_needs_override') {
      overrideArmed = true;
      showToast({ message: `${outcome.reason} Click Apply now again to proceed anyway.`, tone: 'error' });
    }
  }

  // One-click apply (PR A spec item 8): available whenever there is no application yet, or the existing
  // one is still 'drafting' -- the same "create-or-reuse a drafting row" range POST /api/listings/:id/
  // apply-now itself accepts (routes/applications.js). Runs the full resume -> review -> approve -> apply
  // chain; distinct from "Create application" below, which only creates the row for the existing manual
  // /write-resume copy-paste flow. Apply exclusion gate: a HARD branch disables the button entirely and
  // shows the reason in its place; a NEEDS_HUMAN branch keeps the button live but postApplyNow() above
  // handles the server's 409 by asking for an explicit confirm-to-override.
  const applyNowButton = (!application || application.state === 'drafting')
    ? (excludedHard
      ? h('span', { className: 'application-card__excluded', text: `Apply blocked: ${applyExclusion.reason}` })
      : h('button', {
        className: 'btn btn--primary',
        attrs: { type: 'button' },
        text: excludedNeedsHuman ? 'Apply now (needs review)' : 'Apply now',
        on: { click: () => postApplyNow(overrideArmed) },
      }))
    : null;

  if (!application) {
    return h('div', { className: 'application-card' }, [
      h('h3', { text: 'Application' }),
      h('p', { className: 'application-card__hint', text: 'No application started for this listing yet.' }),
      applyNowButton,
      h('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Create application',
        on: {
          click: async () => {
            const outcome = handleOutcome(await postJson(`/api/listings/${listing.id}/application`, {}));
            if (outcome.kind === 'ok') {
              showToast({ message: 'Application created in drafting.' });
              opts.onChanged();
            } else if (outcome.kind === 'duplicate_application') {
              showToast({ message: 'An application already exists for this listing.', tone: 'error' });
            }
          },
        },
      }),
    ]);
  }

  const stateChip = applicationStateChip(application.state);
  const command = `/write-resume ${listing.id}`;

  /** @param {string} label @param {number|null} docId */
  const docRow = (label, docId) => {
    const doc = docId != null ? (documents ?? []).find((d) => Number(d.id) === Number(docId)) : null;
    if (!doc) return h('li', { className: 'application-card__doc application-card__doc--missing', text: `${label}: not linked` });
    return h('li', { className: 'application-card__doc' }, [
      h('span', { text: `${label}: ${doc.rel_path}` }),
      h('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Open',
        on: { click: async () => { handleOutcome(await postJson('/api/documents/open', { path: doc.rel_path })); } },
      }),
    ]);
  };

  const copyRow = h('div', { className: 'application-card__copy-row' }, [
    h('code', { className: 'application-card__copy-code', text: command }),
    h('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Copy',
      on: {
        click: async () => {
          try {
            await navigator.clipboard.writeText(command);
            showToast({ message: 'Copied to clipboard.' });
          } catch {
            showToast({ message: 'Could not copy automatically; select and copy the command.', tone: 'error' });
          }
        },
      },
    }),
  ]);

  const unknownAtsNote = ats && ats.ats === 'unknown'
    ? h('p', { className: 'application-card__note', text: 'Unknown ATS: apply by hand after approving documents.' })
    : null;

  const approveDisabled = application.state !== 'docs_ready' || !application.resume_doc_id;
  const approveButton = h('button', {
    className: 'btn btn--primary',
    attrs: { type: 'button' },
    disabled: approveDisabled,
    text: 'Approve',
    on: {
      click: async () => {
        const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/approve`, {}));
        if (outcome.kind === 'ok') {
          showToast({ message: 'Application approved.' });
          opts.onChanged();
        }
      },
    },
  });

  const appliedByHandButton = h('button', {
    className: 'btn btn--small',
    attrs: { type: 'button' },
    text: 'I applied by hand',
    on: {
      click: async () => {
        const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/applied-by-hand`, {}));
        if (outcome.kind === 'ok') {
          showToast({ message: 'Marked applied.' });
          opts.onChanged();
        }
      },
    },
  });

  const retryButton = h('button', {
    className: 'btn btn--primary',
    attrs: { type: 'button' },
    text: 'Retry',
    on: {
      click: async () => {
        const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/retry`, {}));
        if (outcome.kind === 'ok') {
          showToast({ message: 'Retrying.' });
          opts.onChanged();
        }
      },
    },
  });

  const screenshotEl = h('div', { className: 'application-card__screenshot' }, [
    hApplicationScreenshot({ src: `/api/applications/${application.id}/screenshot`, alt: 'Latest apply-run screenshot', className: 'application-card__screenshot-img' }),
  ]);

  /** @param {{kind:string,label?:string,page_url?:string}} pq */
  function answerBox(pq) {
    const textInput = h('textarea', { className: 'drawer__input', attrs: { placeholder: 'Your answer', rows: 3 } });
    const saveCheckbox = h('input', { className: 'drawer__checkbox', attrs: { type: 'checkbox' }, checked: true });
    const saveButton = h('button', {
      className: 'btn btn--primary',
      attrs: { type: 'button' },
      text: 'Save and Resume',
      on: {
        click: async () => {
          const text = /** @type {HTMLTextAreaElement} */ (textInput).value.trim();
          if (!text) {
            showToast({ message: 'An answer is required.', tone: 'error' });
            return;
          }
          const save = /** @type {HTMLInputElement} */ (saveCheckbox).checked;
          // Resume gate R3: when the card shows the partial-draft warning, saving acknowledges it.
          const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/answer`, {
            text, save, ...(application.partial_draft === true ? { acknowledge_partial_draft: true } : {}),
          }));
          if (outcome.kind === 'ok') {
            showToast({ message: 'Answer saved. Resuming this application.' });
            const warning = /** @type {any} */ (outcome).body?.warning;
            if (typeof warning === 'string' && warning) showToast({ message: warning, tone: 'error' });
            opts.onChanged();
          }
        },
      },
    });
    return h('div', { className: 'credential-prompt' }, [
      h('h4', { text: 'Screening question' }),
      h('p', { className: 'application-card__note', text: pq.label ?? '' }),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Answer' }), textInput]),
      h('label', { className: 'drawer__field drawer__field--inline' }, [saveCheckbox, h('span', { text: 'Save this answer for future applications' })]),
      saveButton,
    ]);
  }

  /**
   * Assisted LinkedIn Easy Apply card (pending_question.kind 'awaiting_submit'): the filled form waits on
   * LinkedIn's Review screen in the scan Chrome. Damian reviews and clicks Submit THERE; nothing here
   * submits. "I submitted" checks LinkedIn's Applied badge first; when it is not found, a
   * confirm-anyway button appears. Abandon needs a second click (no native confirm dialogs).
   * @param {any} pq
   */
  function easyApplyPanel(pq) {
    const ledger = Array.isArray(pq.ledger) ? pq.ledger : [];
    const statusLine = h('p', { className: 'application-card__hint', text: '' });
    getJson('/api/easy-apply/status').then((outcome) => {
      if (outcome.kind === 'ok' && outcome.body && outcome.body.breaker && outcome.body.breaker.tripped) {
        statusLine.textContent = `Easy Apply is paused until ${String(outcome.body.breaker.until ?? '')} (${String(outcome.body.breaker.reason ?? 'breaker')}).`;
      }
    }).catch(() => {});
    const confirmAnyway = h('button', {
      className: 'btn btn--small btn--hidden',
      attrs: { type: 'button' },
      text: 'I did submit: confirm anyway',
      on: {
        click: async () => {
          const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/easy-apply/submitted`, { confirm_anyway: true }));
          if (outcome.kind === 'ok') {
            showToast({ message: 'Marked applied.' });
            opts.onChanged();
          }
        },
      },
    });
    const checkMessage = h('p', { className: 'application-card__note', text: pq.last_check && pq.last_check.message ? String(pq.last_check.message) : '' });
    if (pq.last_check) confirmAnyway.classList.remove('btn--hidden');
    const submittedButton = h('button', {
      className: 'btn btn--primary',
      attrs: { type: 'button' },
      text: 'I submitted',
      on: {
        click: async () => {
          const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/easy-apply/submitted`, {}));
          if (outcome.kind !== 'ok') return;
          const body = /** @type {any} */ (outcome).body ?? {};
          if (body.outcome === 'submitted') {
            showToast({ message: 'LinkedIn shows Applied. Marked applied.' });
            opts.onChanged();
            return;
          }
          checkMessage.textContent = String(body.message ?? 'LinkedIn does not show Applied yet.');
          confirmAnyway.classList.remove('btn--hidden');
          showToast({ message: String(body.message ?? 'LinkedIn does not show Applied yet.'), tone: 'error' });
        },
      },
    });
    const focusButton = h('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Focus tab',
      on: {
        click: async () => {
          const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/focus-tab`, {}));
          if (outcome.kind === 'ok') showToast({ message: 'Switched the scan Chrome to that LinkedIn tab.' });
          else opts.onChanged();
        },
      },
    });
    let abandonArmed = false;
    const abandonButton = h('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Abandon',
      on: {
        click: async () => {
          if (!abandonArmed) {
            abandonArmed = true;
            showToast({ message: 'Click Abandon again to withdraw this application and close its tab.' });
            return;
          }
          const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/easy-apply/abandon`, {}));
          if (outcome.kind === 'ok') {
            showToast({ message: 'Easy Apply abandoned.' });
            opts.onChanged();
          }
        },
      },
    });
    // Assisted Workday (spec v1 clause 10): the same card, named for the application's own site, plus the
    // fields the site itself prefilled (resume parse, saved draft) that no server-side answer wrote.
    const prefilled = Array.isArray(pq.prefilled_unledgered) ? pq.prefilled_unledgered.filter((/** @type {unknown} */ q) => typeof q === 'string') : [];
    return h('div', { className: 'credential-prompt' }, [
      h('h4', { text: `${typeof pq.ats_label === 'string' && pq.ats_label ? pq.ats_label : 'LinkedIn Easy Apply'}: ready for your review` }),
      h('p', { className: 'application-card__note', text: pq.label ? String(pq.label) : '' }),
      pq.stale ? h('p', { className: 'application-card__note', text: 'Waiting more than 24 hours. It stays open until you act on it.' }) : null,
      statusLine,
      h('h4', { text: 'Filled answers' }),
      ledger.length === 0
        ? h('p', { className: 'application-card__hint', text: 'No answers recorded.' })
        : h('ul', { className: 'application-card__ledger' }, ledger.map((/** @type {any} */ e) => h('li', {
          text: `${String(e.question ?? '')} = ${String(e.value ?? '')}${e.bank_key ? ` (bank: ${String(e.bank_key)})` : ''}`,
        }))),
      prefilled.length === 0 ? null : h('h4', { text: 'Prefilled by the site (check these)' }),
      prefilled.length === 0 ? null : h('ul', { className: 'application-card__ledger' }, prefilled.map((/** @type {string} */ q) => h('li', { text: q }))),
      checkMessage,
      h('div', { className: 'application-card__actions' }, [focusButton, submittedButton, confirmAnyway, abandonButton]),
    ]);
  }

  let needsHumanPanel = null;
  if (application.state === 'needs_human' && application.pending_question && application.pending_question.kind === 'awaiting_submit') {
    needsHumanPanel = h('div', { className: 'application-card__needs-human' }, [screenshotEl, easyApplyPanel(application.pending_question)]);
  } else if (application.state === 'needs_human' && application.pending_question) {
    const pq = application.pending_question;
    /** @type {any} */
    let kindPanel;
    if (pq.kind === 'credential') {
      kindPanel = credentialPrompt({ application, pendingQuestion: pq, onChanged: opts.onChanged });
    } else if (pq.kind === 'question') {
      kindPanel = answerBox(pq);
    } else {
      kindPanel = h('div', { className: 'credential-prompt' }, [
        h('h4', { text: 'Needs your attention' }),
        h('p', { className: 'application-card__note', text: pq.label ? String(pq.label) : `Unrecognized pending question kind: ${String(pq.kind)}` }),
        pq.page_url ? h('p', { className: 'application-card__hint', text: String(pq.page_url) }) : null,
      ]);
    }
    // Resume gate R1/R3: Resume (two-click confirm) for kinds the server resumes, carrying the partial-draft
    // warning when set; a card whose own action resumes it (question, credential) shows the warning alone.
    const resumeEl = resumeButtonVisible(application)
      ? resumeControl(application.id, { partialDraft: application.partial_draft === true, onChanged: opts.onChanged })
      : (application.partial_draft === true ? partialDraftWarning() : null);
    needsHumanPanel = h('div', { className: 'application-card__needs-human' }, [screenshotEl, kindPanel, resumeEl, appliedByHandButton]);
  }

  const failedPanel = application.state === 'failed'
    ? h('div', { className: 'application-card__needs-human' }, [
      application.error ? h('p', { className: 'application-card__note', text: String(application.error).slice(0, 300) }) : null,
      retryButton,
    ])
    : null;

  const progressPanel = (application.state === 'approved' || application.state === 'submitting')
    ? h('p', { className: 'application-card__hint', text: application.state === 'submitting' ? 'Submitting -- this updates live as the run progresses.' : 'Approved -- queued to submit.' })
    : null;

  // One-click apply (PR A spec item 6/8): the independent headless review's own findings, shown whenever
  // review_findings is set -- regardless of the application's CURRENT state, so a FAIL/unparseable verdict
  // that parked the application at docs_ready (never auto-approved) stays visible on the card as the
  // reason Approve is still a manual decision, not silently dropped once the application moves on.
  const findingsPanel = Array.isArray(application.review_findings)
    ? h('div', { className: 'application-card__findings' }, [
      h('h4', { text: application.review_verdict === 'PASS' ? 'Review findings' : `Review: ${application.review_verdict ?? 'unparseable'}` }),
      application.review_findings.length === 0
        ? h('p', { className: 'application-card__hint', text: 'No findings.' })
        : h('ul', {}, application.review_findings.map((f) => h('li', { text: `${f.severity ? `${f.severity}: ` : ''}${f.text ?? ''}` }))),
    ])
    : null;

  return h('div', { className: 'application-card' }, [
    h('div', { className: 'application-card__header' }, [
      h('h3', { text: 'Application' }),
      h('span', { className: chipClassName(stateChip), text: stateChip.label }),
    ]),
    application.state === 'drafting' ? applyNowButton : null,
    application.state === 'drafting' ? copyRow : null,
    h('ul', { className: 'application-card__docs' }, [docRow('Resume', application.resume_doc_id), docRow('Cover letter', application.coverletter_doc_id)]),
    unknownAtsNote,
    application.state === 'docs_ready' ? approveButton : null,
    progressPanel,
    findingsPanel,
    needsHumanPanel,
    failedPanel,
    // Withdraw (drafting, failed, parked needs_human; never an awaiting_submit card, which has Abandon).
    withdrawButtonVisible(application) ? withdrawControl(application.id, opts.onChanged) : null,
  ]);
}
