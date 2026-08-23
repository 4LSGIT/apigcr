/**
 * tests/ycSync.test.js
 *
 * Executes public/js/yc-sync.js FOR REAL, in jsdom, exactly the way the shipped
 * <script> tag does. Not a re-implementation — the file is read from disk and
 * evaluated in the window, so a typo in the shipped bus fails here.
 *
 * What is actually worth testing in ~250 lines of transport:
 *
 *   · NORMALIZE. Two callers send two different shapes — caseService's
 *     `{field:{from,to}}` API diff and the plain `{field: value}` the new
 *     advance/docket `changes` keys carry. Subscribers must never have to know
 *     which one arrived.
 *   · THE QUERY STRIP. `PATCH /api/contacts/:id?force=true` is the 409
 *     cross-contact transfer retry — the save most likely to have just moved a
 *     phone number from one contact to another, and the one a bare regex
 *     silently drops. This is the highest-value assertion in the file.
 *   · THE DIRTY FENCES. bindValue must not eat what the user is typing.
 *   · CROSS-WINDOW delivery, which is the entire reason the transport is
 *     BroadcastChannel and not a postMessage hub.
 *
 *   npx jest tests/ycSync.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];

/**
 * Boot one window with the real yc-sync evaluated inside it.
 *
 * The polyfill goes on THE WINDOW before evaluation, so yc-sync's
 * `new BroadcastChannel(...)` resolves against it rather than against Node's
 * process-global one. See tests/helpers/bcPolyfill.js.
 *
 * @param {boolean} withBc false → exercise the no-BroadcastChannel degrade
 */
function mkWindow({ withBc = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/',
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  if (withBc) TEARDOWNS.push(bcPolyfill.install(window));
  else window.BroadcastChannel = undefined;

  window.console.warn = () => {};    // the degrade path warns once; don't spam
  window.eval(SRC);
  return window;
}

/** Let queueMicrotask deliveries land. */
const settle = () => new Promise(r => setTimeout(r, 0));

afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

// ─────────────────────────────────────────────────────────────
// Normalize
// ─────────────────────────────────────────────────────────────

describe('normalize', () => {
  test('the API {from,to} diff shape delivers the NEW value', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', { case_stage: { from: 'Open', to: 'Filed' } }, 't');
    expect(seen).toEqual([{ case_stage: 'Filed' }]);
  });

  test('a plain {field: value} object passes through unchanged', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', { case_stage: 'Filed', case_rec: '' }, 't');
    expect(seen).toEqual([{ case_stage: 'Filed', case_rec: '' }]);
  });

  test('mixed shapes in one message both normalize', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', { a: { from: 1, to: 2 }, b: 'plain' }, 't');
    expect(seen).toEqual([{ a: 2, b: 'plain' }]);
  });

  test('a null new value survives — clearing a column is a real change', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', { case_caption: { from: 'x', to: null } }, 't');
    expect(seen).toEqual([{ case_caption: null }]);
  });

  test('an empty changes object emits nothing at all', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', {}, 't');
    expect(seen).toEqual([]);
    expect(w.YC._log.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Subscription matching
// ─────────────────────────────────────────────────────────────

describe('subscription matching', () => {
  test('a field subscriber is silent for a message that omits its field', () => {
    const w = mkWindow();
    const x = [], y = [];
    w.YC.on('case:AAAA', 'x', f => x.push(f));
    w.YC.on('case:AAAA', 'y', f => y.push(f));
    w.YC.emit('case:AAAA', { y: 1 }, 't');
    expect(x).toEqual([]);
    expect(y).toEqual([{ y: 1 }]);
  });

  test("'case:*' matches any case but NEVER a contact", () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:*', '*', (f, m) => seen.push(m.addr));
    w.YC.emit('case:AAAA', { a: 1 }, 't');
    w.YC.emit('case:BBBB', { a: 1 }, 't');
    w.YC.emit('contact:1', { a: 1 }, 't');
    expect(seen).toEqual(['case:AAAA', 'case:BBBB']);
  });

  test("a contact wildcard does not pick up 'contact_group:…'-style prefixes", () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('contact:*', '*', (f, m) => seen.push(m.addr));
    w.YC.emit('contact:5', { a: 1 }, 't');
    w.YC.emit('contactgroup:5', { a: 1 }, 't');
    expect(seen).toEqual(['contact:5']);
  });

  test('an exact subscriber and a wildcard subscriber both fire once', () => {
    const w = mkWindow();
    let exact = 0, wild = 0;
    w.YC.on('case:AAAA', '*', () => exact++);
    w.YC.on('case:*',    '*', () => wild++);
    w.YC.emit('case:AAAA', { a: 1 }, 't');
    expect([exact, wild]).toEqual([1, 1]);
  });

  test('unsubscribe detaches, and is idempotent', () => {
    const w = mkWindow();
    const seen = [];
    const off = w.YC.on('case:AAAA', '*', f => seen.push(f));
    w.YC.emit('case:AAAA', { a: 1 }, 't');
    off();
    off();                                   // double-call must not throw
    w.YC.emit('case:AAAA', { a: 2 }, 't');
    expect(seen).toEqual([{ a: 1 }]);
  });

  test('a throwing handler does not cost the other subscribers their message', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', () => { throw new Error('boom'); });
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    expect(() => w.YC.emit('case:AAAA', { a: 1 }, 't')).not.toThrow();
    expect(seen).toEqual([{ a: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────
// bindValue — the dirty fences
// ─────────────────────────────────────────────────────────────

describe('bindValue', () => {
  function mkInput(w) {
    const el = w.document.createElement('input');
    w.document.body.appendChild(el);
    return el;
  }

  test('a clean, unfocused element IS overwritten', () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.value = 'old';
    w.YC.bindValue('case:AAAA', 'case_status', el);
    w.YC.emit('case:AAAA', { case_status: 'new' }, 't');
    expect(el.value).toBe('new');
  });

  test('the FOCUSED element is left alone', () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.value = 'typing';
    el.focus();
    expect(w.document.activeElement).toBe(el);
    w.YC.bindValue('case:AAAA', 'case_status', el);
    w.YC.emit('case:AAAA', { case_status: 'new' }, 't');
    expect(el.value).toBe('typing');
  });

  test("data-yc-dirty='1' is left alone even when unfocused", () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.value = 'unsaved draft';
    el.dataset.ycDirty = '1';
    w.YC.bindValue('case:AAAA', 'case_status', el);
    w.YC.emit('case:AAAA', { case_status: 'new' }, 't');
    expect(el.value).toBe('unsaved draft');
  });

  test('a cleared dirty flag lets the next message through', () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.dataset.ycDirty = '1';
    w.YC.bindValue('case:AAAA', 'case_status', el);
    w.YC.emit('case:AAAA', { case_status: 'blocked' }, 't');
    el.dataset.ycDirty = '';
    w.YC.emit('case:AAAA', { case_status: 'through' }, 't');
    expect(el.value).toBe('through');
  });

  test('null renders as empty string, not the literal "null"', () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.value = 'old';
    w.YC.bindValue('case:AAAA', 'case_caption', el);
    w.YC.emit('case:AAAA', { case_caption: { from: 'old', to: null } }, 't');
    expect(el.value).toBe('');
  });

  test('a message for a different field does not touch the element', () => {
    const w = mkWindow();
    const el = mkInput(w);
    el.value = 'old';
    w.YC.bindValue('case:AAAA', 'case_status', el);
    w.YC.emit('case:AAAA', { case_stage: 'Filed' }, 't');
    expect(el.value).toBe('old');
  });
});

// ─────────────────────────────────────────────────────────────
// _sniff — the shell hook
// ─────────────────────────────────────────────────────────────

describe('_sniff', () => {
  function spy(w, addr) {
    const seen = [];
    w.YC.on(addr, '*', (f, m) => seen.push({ fields: f, origin: m.origin }));
    return seen;
  }

  test('PATCH /api/cases/:id with data.changes emits on case:<id>', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:AAAA');
    w.YC._sniff('PATCH', '/api/cases/AAAA',
                { data: { changes: { case_stage: { from: 'Open', to: 'Filed' } } } });
    expect(seen).toEqual([
      { fields: { case_stage: 'Filed' }, origin: 'auto:PATCH /api/cases/AAAA' },
    ]);
  });

  test('THE QUERY STRIP: PATCH /api/contacts/5?force=true emits on contact:5', () => {
    // The 409 cross-contact transfer retry (contact-form.html:696). Without
    // split('?')[0] the regex misses it and the transfer goes unannounced —
    // the single most consequential save on the page.
    const w = mkWindow();
    const seen = spy(w, 'contact:5');
    w.YC._sniff('PATCH', '/api/contacts/5?force=true',
                { data: { changes: { contact_phone: { from: '1', to: '2' } } } });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({ contact_phone: '2' });
    // The origin keeps the RAW endpoint, query string and all — that is the
    // traceability point of the string.
    expect(seen[0].origin).toBe('auto:PATCH /api/contacts/5?force=true');
  });

  test('POST pipeline/advance reads TOP-LEVEL changes', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:AAAA');
    w.YC._sniff('POST', '/api/cases/AAAA/pipeline/advance', {
      noop: false, skipped: false,
      changes: { case_stage: 'Filed', case_status: 'Petition filed',
                 case_rec: '', pipeline_phase: 'case' },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({
      case_stage: 'Filed', case_status: 'Petition filed',
      case_rec: '', pipeline_phase: 'case',
    });
  });

  test('PATCH /docket reads TOP-LEVEL changes, not data.changes', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:AAAA');
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket', {
      data: { case_id: 'AAAA' },                       // the case row, no changes here
      changes: { case_number: { from: null, to: '24-31852' } },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({ case_number: '24-31852' });
  });

  test('GET is ignored even on a matching path with a changes body', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:AAAA');
    w.YC._sniff('GET', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    expect(seen).toEqual([]);
  });

  test('an unmatched sub-path is ignored', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:*');
    w.YC._sniff('PATCH', '/api/cases/AAAA/other', { data: { changes: { a: 1 } } });
    w.YC._sniff('PATCH', '/api/cases/AAAA/contacts', { data: { changes: { a: 1 } } });
    expect(seen).toEqual([]);
  });

  test('an EMPTY changes object emits nothing', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:*');
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: {} } });
    expect(seen).toEqual([]);
  });

  test('a response with no changes key at all emits nothing', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:*');
    w.YC._sniff('PATCH', '/api/cases/AAAA', { status: 'success', data: {} });
    w.YC._sniff('POST', '/api/cases/AAAA/pipeline/advance', { noop: true, skipped: false });
    expect(seen).toEqual([]);
  });

  test('a non-numeric contact id does not match the contacts matcher', () => {
    const w = mkWindow();
    const seen = spy(w, 'contact:*');
    w.YC._sniff('PATCH', '/api/contacts/abc', { data: { changes: { a: 1 } } });
    expect(seen).toEqual([]);
  });

  test('lowercase method still sniffs', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:AAAA');
    w.YC._sniff('patch', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    expect(seen.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────

describe('transport', () => {
  test('CROSS-WINDOW: an emit in A is dispatched in B', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('case:AAAA', '*', (f, m) => seenB.push({ fields: f, origin: m.origin }));

    a.YC.emit('case:AAAA', { case_stage: { from: 'Open', to: 'Filed' } }, 'test:A');
    await settle();

    expect(seenB).toEqual([{ fields: { case_stage: 'Filed' }, origin: 'test:A' }]);
  });

  test('the SENDING window dispatches locally, exactly once', async () => {
    // BroadcastChannel never echoes to the sender, so yc-sync dispatches
    // locally itself. If both happened the writing frame would repaint twice.
    const a = mkWindow();
    const b = mkWindow();
    const seenA = [];
    a.YC.on('case:AAAA', '*', f => seenA.push(f));
    b.YC.on('case:AAAA', '*', () => {});

    a.YC.emit('case:AAAA', { case_stage: 'Filed' }, 't');
    await settle();

    expect(seenA).toEqual([{ case_stage: 'Filed' }]);
  });

  test('a third window also receives — no hub, no fanout', async () => {
    const a = mkWindow(), b = mkWindow(), c = mkWindow();
    const hits = [];
    b.YC.on('case:*', '*', () => hits.push('b'));
    c.YC.on('case:*', '*', () => hits.push('c'));
    a.YC.emit('case:AAAA', { x: 1 }, 't');
    await settle();
    expect(hits.sort()).toEqual(['b', 'c']);
  });

  test('NO BroadcastChannel → local-only degrade, still functional', async () => {
    const a = mkWindow({ withBc: false });
    const seen = [];
    a.YC.on('case:AAAA', '*', f => seen.push(f));
    expect(() => a.YC.emit('case:AAAA', { case_stage: 'Filed' }, 't')).not.toThrow();
    expect(seen).toEqual([{ case_stage: 'Filed' }]);
  });

  test('_log is a ring buffer capped at 50', () => {
    const w = mkWindow();
    for (let i = 0; i < 60; i++) w.YC.emit('case:AAAA', { n: i }, 't');
    expect(w.YC._log.length).toBe(50);
    expect(w.YC._log[0].fields.n).toBe(10);
    expect(w.YC._log[49].fields.n).toBe(59);
    expect(w.YC._log[49].addr).toBe('case:AAAA');
    expect(typeof w.YC._log[49].ts).toBe('number');
  });

  test('double-load is idempotent — live subscriptions survive', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('case:AAAA', '*', f => seen.push(f));
    const first = w.YC;
    w.eval(SRC);                                  // a second <script> tag
    expect(w.YC).toBe(first);
    w.YC.emit('case:AAAA', { a: 1 }, 't');
    expect(seen).toEqual([{ a: 1 }]);
  });
});
