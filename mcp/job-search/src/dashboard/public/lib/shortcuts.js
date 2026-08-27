// @ts-check
/**
 * Keyboard chord state machine (pr3-spec-decisions.md section 8), extracted as a pure
 * `(state, event) -> {state, action}` reducer so the chord-arming timer and dispatch table are
 * unit-testable without a real DOM (section 12 item 7). `app.js` owns the actual `keydown` listener,
 * `document.activeElement` classification, and wall-clock `Date.now()`; this module only reasons about
 * the already-classified event shape below.
 *
 * JUDGMENT CALL (documented in the PR body's blind spots): the plan names row-level single-key shortcuts
 * `j/k/Enter/m/s/p/a/x` for list views but never defines what `p`, `a`, and `x` individually do beyond
 * "row down/up". This reducer maps them to quick stage-set actions (m=maybe, s=shortlisted, a=applied,
 * p=passed, x=skip) as the closest reading of the plan's own stage vocabulary; a page is free to ignore
 * an action it does not support (e.g. these are inert outside Jobs/Pipeline/Follow-ups/Review/Runs).
 */

/** @typedef {{ chordArmedUntil: number|null, helpOpen: boolean }} KbState */
/** @typedef {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, inInput: boolean, now: number }} KbEvent */
/** @typedef {{ type: string, [k: string]: any }|null} KbAction */

export const CHORD_WINDOW_MS = 600;

const NAV_KEYS = Object.freeze({ h: 'home', j: 'jobs', p: 'pipeline', f: 'followups', r: 'review' });
const ROW_ACTION_KEYS = Object.freeze({ m: 'maybe', s: 'shortlisted', a: 'applied', p: 'passed', x: 'skip' });

export function initialKbState() {
  return { chordArmedUntil: null, helpOpen: false };
}

/**
 * @param {KbState} state
 * @param {KbEvent} event
 * @returns {{ state: KbState, action: KbAction }}
 */
export function reduceKeyboard(state, event) {
  // Rule 2: modifier keys are never intercepted, in either focus context.
  if (event.ctrlKey || event.metaKey || event.altKey) return { state, action: null };

  // Rule 6: while the ? overlay is open, every key except Escape and ? itself is swallowed.
  if (state.helpOpen) {
    if (event.key === 'Escape' || event.key === '?') return { state: { ...state, helpOpen: false }, action: { type: 'close-help' } };
    return { state, action: null };
  }

  // Rule 1: focused input/textarea/select/contentEditable disables every shortcut except Escape.
  if (event.inInput) {
    if (event.key === 'Escape') return { state, action: { type: 'blur' } };
    return { state, action: null };
  }

  if (event.key === '?') return { state: { ...state, helpOpen: true }, action: { type: 'open-help' } };

  // Rule 3: 'g' arms a 600ms chord window. Rule 4: the next key, if h/j/p/f/r, navigates; anything else
  // (including a repeat 'g', which restarts the window rather than double-firing) disarms with no action,
  // except a fresh 'g' which re-arms below.
  const chordActive = state.chordArmedUntil !== null && event.now <= state.chordArmedUntil;
  if (chordActive) {
    if (event.key === 'g') return { state: { ...state, chordArmedUntil: event.now + CHORD_WINDOW_MS }, action: null };
    const disarmed = { ...state, chordArmedUntil: null };
    if (Object.prototype.hasOwnProperty.call(NAV_KEYS, event.key)) {
      return { state: disarmed, action: { type: 'navigate', route: NAV_KEYS[event.key] } };
    }
    return { state: disarmed, action: null };
  }

  if (event.key === 'g') return { state: { ...state, chordArmedUntil: event.now + CHORD_WINDOW_MS }, action: null };

  // Rule 4 continued: bare j/k (no g prefix) are row-nav, a different sequence from `g j`.
  if (event.key === 'j') return { state, action: { type: 'row-nav', dir: 1 } };
  if (event.key === 'k') return { state, action: { type: 'row-nav', dir: -1 } };
  if (event.key === 'Enter') return { state, action: { type: 'row-open' } };
  if (event.key === '/') return { state, action: { type: 'focus-search' } };
  if (event.key === 'n') return { state, action: { type: 'shortcut', name: 'notes-focus' } };

  if (Object.prototype.hasOwnProperty.call(ROW_ACTION_KEYS, event.key)) {
    return { state, action: { type: 'row-stage', status: ROW_ACTION_KEYS[event.key] } };
  }

  if (/^[0-9]$/.test(event.key)) return { state, action: { type: 'digit', digit: event.key } };

  return { state, action: null };
}
