// @ts-check
/**
 * Home's action bar. One primary action per the density rule: the primary button toggles between
 * "Run scan" and "Cancel scan" depending on live-scan state (design reconciliation, adopted verbatim)
 * rather than showing two separate buttons.
 */
import { h } from '../lib/dom.js';
import { confirmButton } from './confirm-button.js';

/**
 * @param {{ running: boolean, disabled: boolean, onRunScan: () => void, onCancelScan: () => void,
 *   onPreviewReport: () => void, onSendReport: () => void, onAddOpportunity: () => void, onNewFollowup: () => void }} opts
 */
export function actionBar(opts) {
  const primary = opts.running
    ? confirmButton({ label: 'Cancel scan', confirmLabel: 'Confirm cancel', className: 'btn--primary btn--danger', onConfirm: opts.onCancelScan })
    : h('button', { className: 'btn btn--primary', disabled: opts.disabled, attrs: { type: 'button' }, text: 'Run scan', on: { click: opts.onRunScan } });
  return h('div', { className: 'action-bar' }, [
    primary,
    h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Preview report', on: { click: opts.onPreviewReport } }),
    h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Send report', on: { click: opts.onSendReport } }),
    h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Add opportunity', on: { click: opts.onAddOpportunity } }),
    h('button', { className: 'btn', attrs: { type: 'button' }, text: 'New follow-up', on: { click: opts.onNewFollowup } }),
  ]);
}
