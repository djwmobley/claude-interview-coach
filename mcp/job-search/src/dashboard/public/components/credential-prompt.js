// @ts-check
/**
 * Credential prompt (apply pipeline slice 4, plan section "5a. Credential prompt"). Rendered by
 * application-card.js when an application is in needs_human with `pending_question.kind === 'credential'`.
 * Shows the site (from the target name), a username field prefilled from account_email (editable), a
 * password field with a Generate button (client-side crypto.getRandomValues, 24 chars, shown once with a
 * copy button so it can be pasted into the site if Damian is creating the account by hand), and Save.
 * Save posts to POST /api/credentials, which writes the credential and resumes the application
 * (needs_human -> approved); the card updates over the existing SSE mechanism via `onChanged()`, no page
 * reload.
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';

/** Letters + digits + a small, unambiguous symbol set. 24 chars (spec: "24 chars"). */
const GENERATE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_+=';
const GENERATE_LENGTH = 24;

/** @returns {string} */
export function generatePassword() {
  const bytes = new Uint8Array(GENERATE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < GENERATE_LENGTH; i++) out += GENERATE_CHARSET[bytes[i] % GENERATE_CHARSET.length];
  return out;
}

/**
 * @param {{ application: any, pendingQuestion: { kind: 'credential', target: string, username?: string, page_url?: string }, onChanged: () => void }} opts
 */
export function credentialPrompt(opts) {
  const { application, pendingQuestion, onChanged } = opts;
  const site = typeof pendingQuestion.target === 'string' ? pendingQuestion.target.replace(/^ic-jobsearch\//, '') : 'unknown site';

  const usernameInput = h('input', {
    className: 'drawer__input', attrs: { type: 'text', placeholder: 'Username / email' },
    value: pendingQuestion.username ?? application.account_email ?? '',
  });
  const passwordInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Password' } });
  const hintEl = h('p', { className: 'application-card__hint', text: 'Enter or generate a password, then Save.' });

  const generateButton = h('button', {
    className: 'btn btn--small',
    attrs: { type: 'button' },
    text: 'Generate',
    on: {
      click: async () => {
        const pw = generatePassword();
        /** @type {HTMLInputElement} */ (passwordInput).value = pw;
        try {
          await navigator.clipboard.writeText(pw);
          hintEl.textContent = 'Generated a password and copied it to the clipboard. Shown once here -- Save now, or use Copy below before leaving this page.';
        } catch {
          hintEl.textContent = 'Generated a password. Shown once here -- copy it (Copy below) before leaving this page.';
        }
      },
    },
  });

  const copyButton = h('button', {
    className: 'btn btn--small',
    attrs: { type: 'button' },
    text: 'Copy',
    on: {
      click: async () => {
        const pw = /** @type {HTMLInputElement} */ (passwordInput).value;
        if (!pw) return;
        try {
          await navigator.clipboard.writeText(pw);
          showToast({ message: 'Password copied to clipboard.' });
        } catch {
          showToast({ message: 'Could not copy automatically; select and copy the password field.', tone: 'error' });
        }
      },
    },
  });

  const saveButton = h('button', {
    className: 'btn btn--primary',
    attrs: { type: 'button' },
    text: 'Save',
    on: {
      click: async () => {
        const username = /** @type {HTMLInputElement} */ (usernameInput).value.trim();
        const password = /** @type {HTMLInputElement} */ (passwordInput).value;
        if (!username || !password) {
          showToast({ message: 'Username and password are both required.', tone: 'error' });
          return;
        }
        const outcome = handleOutcome(await postJson('/api/credentials', {
          applicationId: application.id, target: pendingQuestion.target, username, password,
        }));
        if (outcome.kind === 'ok') {
          showToast({ message: 'Credential saved. Resuming this application.' });
          onChanged();
        }
      },
    },
  });

  return h('div', { className: 'credential-prompt' }, [
    h('h4', { text: 'Credential needed' }),
    h('p', { className: 'application-card__note', text: site }),
    h('label', { className: 'drawer__field' }, [h('span', { text: 'Username' }), usernameInput]),
    h('label', { className: 'drawer__field' }, [h('span', { text: 'Password' }), passwordInput]),
    h('div', { className: 'credential-prompt__actions' }, [generateButton, copyButton, saveButton]),
    hintEl,
  ]);
}
