// @ts-check
/**
 * Shared screening-question fill for the single-page and wizard form adapters (Greenhouse, Lever,
 * SmartRecruiters, iCIMS, Dayforce). Before this module each adapter carried an identical copy of
 * answerCustomFields; the unattended submit spec (D3, C5, C10) changes that logic in the same way for all
 * five, so it lives here once.
 *
 * Every value written is recorded in the adapter's fill LEDGER ({ key, selector, label, value, source,
 * bankKey, fallbackUsed, controlType }). src/apply/unattended-submit.js re-reads each ledger selector
 * immediately before the click and compares it (fill drift), checks the source is allowed for the label
 * (learned tier, contact data, account email, the configured salary floor for a pay field, the approved
 * document for an upload), and audits every visible field on the form for an unfilled required one.
 *
 * D3 (fixed here): an UNLABELED required field and a required field the matcher answered but that has no
 * id to target both park; neither is skipped and silently counted as answered any more.
 */
import { classifyCompensationLabel } from '../answers.js';

/**
 * Map one enumerated field's DOM shape (src/apply/apply-capability.js's ElementInfo) to answers.js's
 * CONTROL_TYPES vocabulary. Total: an unrecognized tag/type combination maps to `undefined`, which
 * resolveControl() (src/apply/answers.js) already treats as 'unsupported_control_type' -> parks.
 * @param {{ tagName: string, type: string|null }} f
 */
export function controlTypeFor(f) {
  if (f.tagName === 'select') return 'radio';
  if (f.tagName === 'textarea') return 'text';
  if (f.tagName === 'input') {
    if (f.type === 'checkbox') return 'checkbox-group';
    if (f.type === 'radio') return 'radio';
    if (f.type === null || f.type === 'text' || f.type === 'tel' || f.type === 'email' || f.type === 'number') return 'text';
  }
  return undefined;
}

/**
 * Fill a text field and record it in the ledger.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any[]} ledger
 * @param {{ key: string, selector: string, label: string, value: string, source: string, bankKey?: string|null }} e
 */
export async function fillAndRecord(cap, ledger, e) {
  await cap.fill(e.selector, e.value);
  ledger.push({ key: e.key, selector: e.selector, label: e.label, value: e.value, source: e.source, bankKey: e.bankKey ?? null, controlType: 'text' });
}

/**
 * Upload a document and record it (source 'document': the approved, hash-checked file).
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any[]} ledger
 * @param {{ key: string, selector: string, label: string, relPath: string }} e
 * @returns {Promise<string|null>} the file name the browser registered, or null
 */
export async function uploadAndRecord(cap, ledger, e) {
  const name = await cap.upload(e.selector, e.relPath);
  if (name) ledger.push({ key: e.key, selector: e.selector, label: e.label, value: String(name), source: 'document', controlType: 'file' });
  return name;
}

/**
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {string} label
 * @param {any} [match]
 */
async function parkQuestion(cap, ctx, label, match) {
  const shot = await cap.screenshot();
  return {
    parked: true,
    pendingQuestion: {
      kind: 'question', label, page_url: ctx.applyUrl, screenshot: shot.relPath, suggestion: match?.suggestion ?? null, tier: match?.tier ?? null,
    },
  };
}

/**
 * Answer every enumerated custom screening field. Compensation gate (Damian's ruling, spec item B): a
 * compensation-family label (classifyCompensationLabel) is ALWAYS routed through that gate before the
 * generic bank matcher, and every shape but a plain-text BASE ANNUAL figure with a configured floor always
 * parks. Returns `{ parked: false }` when every required field either auto-answered or was
 * optional-and-unmatched (skipped, logged); returns `{ parked: true, pendingQuestion }` on the FIRST
 * required field that does not auto-answer (never guesses a required answer).
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {string} customFieldsSelector
 * @param {any[]} ledger appended to in place
 */
export async function answerCustomFields(cap, ctx, customFieldsSelector, ledger) {
  const fields = /** @type {any[]} */ (await cap.waitFor(customFieldsSelector, { all: true, timeoutMs: 3000 }));
  let n = 0;
  for (const f of fields ?? []) {
    n++;
    const label = String(f.text ?? '').trim();
    const selector = f.id ? `#${f.id}` : null;
    // D3: an unlabeled field is never silently skipped when it is required.
    if (!label) {
      if (f.required) return parkQuestion(cap, ctx, 'An unlabeled required field is on the form; it cannot be answered automatically.');
      ctx.log({ evt: 'question_unlabeled_optional', index: n });
      continue;
    }
    const controlType = controlTypeFor(f);

    const compClass = classifyCompensationLabel(label, { controlType, floor: ctx.answers.bank?.meta?.salary_floor ?? null });
    if (compClass.category !== 'not_compensation') {
      if (compClass.category === 'fill' && selector) {
        await fillAndRecord(cap, ledger, { key: `q${n}`, selector, label, value: String(compClass.value), source: 'salary_floor' });
        continue;
      }
      return parkQuestion(cap, ctx, label);
    }

    const match = ctx.answers.match(label, controlType, f.options ?? undefined);
    if (match.outcome === 'auto_answer') {
      // D3: an answer with no target is not an answer. A required one parks; an optional one is skipped
      // (and the click-time audit still parks if the page marks it required).
      if (!selector) {
        if (f.required) return parkQuestion(cap, ctx, label, match);
        ctx.log({ evt: 'question_untargetable_optional', label: label.slice(0, 200) });
        continue;
      }
      const base = { key: `q${n}`, selector, label, source: 'learned', bankKey: match.key ?? null };
      if (controlType === 'text') {
        const value = String(match.controlResult?.text ?? match.value ?? '');
        await cap.fill(selector, value);
        ledger.push({ ...base, value, controlType: 'text' });
      } else if (controlType === 'radio' && f.tagName === 'select') {
        const value = String(match.controlResult?.selectedOption ?? '');
        await cap.select(selector, value);
        ledger.push({ ...base, value, controlType: 'select' });
      } else {
        await cap.click(selector);
        ledger.push({ ...base, value: 'checked', controlType: 'check' });
      }
      continue;
    }
    if (f.required) return parkQuestion(cap, ctx, label, match);
    ctx.log({ evt: 'question_unmatched_optional', label: label.slice(0, 200) });
  }
  return { parked: false };
}
