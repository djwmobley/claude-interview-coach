// @ts-check
/**
 * Keyboard chord state machine tests (pr3-spec-decisions.md section 12 item 7): the pure
 * (state, event) -> (state, action) reducer from lib/shortcuts.js, independent of any real DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initialKbState, reduceKeyboard, CHORD_WINDOW_MS } from '../src/dashboard/public/lib/shortcuts.js';

function ev(key, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, inInput: false, now: 0, ...extra };
}

describe('modifier keys are never intercepted (rule 2)', () => {
  test('ctrl/meta/alt held: no action, in or out of an input', () => {
    const s = initialKbState();
    assert.equal(reduceKeyboard(s, ev('j', { ctrlKey: true })).action, null);
    assert.equal(reduceKeyboard(s, ev('r', { metaKey: true })).action, null);
    assert.equal(reduceKeyboard(s, ev('f', { altKey: true, inInput: true })).action, null);
  });
});

describe('input focus disables every shortcut except Escape (rule 1)', () => {
  test('a plain key in an input produces no action', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('j', { inInput: true }));
    assert.equal(action, null);
  });

  test('Escape in an input still blurs', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('Escape', { inInput: true }));
    assert.deepEqual(action, { type: 'blur' });
  });
});

describe('g chord prefix (rules 3-4)', () => {
  test('g arms a 600ms window; h/j/p/f/r within it navigates', () => {
    let state = initialKbState();
    const armed = reduceKeyboard(state, ev('g', { now: 1000 }));
    assert.equal(armed.action, null);
    assert.equal(armed.state.chordArmedUntil, 1000 + CHORD_WINDOW_MS);

    const nav = reduceKeyboard(armed.state, ev('h', { now: 1000 + CHORD_WINDOW_MS - 1 }));
    assert.deepEqual(nav.action, { type: 'navigate', route: 'home' });
    assert.equal(nav.state.chordArmedUntil, null);
  });

  test('any other key disarms with no action', () => {
    const armed = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const disarmed = reduceKeyboard(armed.state, ev('z', { now: 100 }));
    assert.equal(disarmed.action, null);
    assert.equal(disarmed.state.chordArmedUntil, null);
  });

  test('the window expiring (now past chordArmedUntil) disarms without navigating', () => {
    const armed = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const late = reduceKeyboard(armed.state, ev('h', { now: CHORD_WINDOW_MS + 1 }));
    assert.equal(late.action, null);
  });

  test('pressing g again while armed restarts the window rather than double-firing or getting stuck', () => {
    const armed1 = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const armed2 = reduceKeyboard(armed1.state, ev('g', { now: 100 }));
    assert.equal(armed2.action, null);
    assert.equal(armed2.state.chordArmedUntil, 100 + CHORD_WINDOW_MS);
  });

  test('Escape while armed disarms with no action', () => {
    const armed = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const escaped = reduceKeyboard(armed.state, ev('Escape', { now: 50 }));
    assert.equal(escaped.action, null);
    assert.equal(escaped.state.chordArmedUntil, null);
  });
});

describe('named conflict: bare j/k (row-nav) versus g j (navigate) are two different sequences (rule 4)', () => {
  test('bare j with no g prefix is row-nav, not navigation', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('j'));
    assert.deepEqual(action, { type: 'row-nav', dir: 1 });
  });

  test('bare k is row-nav up', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('k'));
    assert.deepEqual(action, { type: 'row-nav', dir: -1 });
  });

  test('g then j navigates to Jobs, a distinct sequence from bare j', () => {
    const armed = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const { action } = reduceKeyboard(armed.state, ev('j', { now: 10 }));
    assert.deepEqual(action, { type: 'navigate', route: 'jobs' });
  });

  test('bare f (Job detail add-followup) is a distinct sequence from g f (navigate to Follow-ups)', () => {
    const bare = reduceKeyboard(initialKbState(), ev('f'));
    assert.deepEqual(bare.action, { type: 'shortcut', name: 'add-followup' });

    const armed = reduceKeyboard(initialKbState(), ev('g', { now: 0 }));
    const chorded = reduceKeyboard(armed.state, ev('f', { now: 10 }));
    assert.deepEqual(chorded.action, { type: 'navigate', route: 'followups' });
  });
});

describe('Job-detail-only shortcuts: n (notes-focus) and f (add-followup)', () => {
  test('n produces a notes-focus shortcut action', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('n'));
    assert.deepEqual(action, { type: 'shortcut', name: 'notes-focus' });
  });

  test('f produces an add-followup shortcut action', () => {
    const { action } = reduceKeyboard(initialKbState(), ev('f'));
    assert.deepEqual(action, { type: 'shortcut', name: 'add-followup' });
  });
});

describe('? overlay (rule 6)', () => {
  test('? opens the overlay', () => {
    const { state, action } = reduceKeyboard(initialKbState(), ev('?'));
    assert.equal(state.helpOpen, true);
    assert.deepEqual(action, { type: 'open-help' });
  });

  test('while open, every key except Escape and ? is swallowed', () => {
    const opened = reduceKeyboard(initialKbState(), ev('?'));
    const swallowed = reduceKeyboard(opened.state, ev('j'));
    assert.equal(swallowed.action, null);
    assert.equal(swallowed.state.helpOpen, true);
  });

  test('Escape closes it', () => {
    const opened = reduceKeyboard(initialKbState(), ev('?'));
    const closed = reduceKeyboard(opened.state, ev('Escape'));
    assert.equal(closed.state.helpOpen, false);
    assert.deepEqual(closed.action, { type: 'close-help' });
  });

  test('? again also closes it', () => {
    const opened = reduceKeyboard(initialKbState(), ev('?'));
    const closed = reduceKeyboard(opened.state, ev('?'));
    assert.equal(closed.state.helpOpen, false);
  });
});

describe('digit shortcuts pass through as a digit action', () => {
  test('digits 0-9 all produce a digit action', () => {
    for (const d of '0123456789') {
      const { action } = reduceKeyboard(initialKbState(), ev(d));
      assert.deepEqual(action, { type: 'digit', digit: d });
    }
  });
});

describe('unrecognized keys are a defined no-op, never a thrown error', () => {
  test('an arbitrary key with no mapping produces no action', () => {
    assert.doesNotThrow(() => reduceKeyboard(initialKbState(), ev('%')));
    assert.equal(reduceKeyboard(initialKbState(), ev('%')).action, null);
  });
});
