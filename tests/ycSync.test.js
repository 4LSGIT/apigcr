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
// _sniff — app_settings (Slice 2)
//
// The bus carries the RAW STORED STRING and nothing else. Everything
// downstream (applyFeSetting) parses. These tests pin that contract, because
// the temptation to "helpfully" JSON.parse in the transport is real and would
// make the message shape depend on the row's type.
// ─────────────────────────────────────────────────────────────

describe('_sniff — app_settings', () => {
  function spy(w, addr) {
    const seen = [];
    w.YC.on(addr, '*', (f, m) => seen.push({ fields: f, origin: m.origin, addr: m.addr }));
    return seen;
  }

  test('PUT /api/app-settings/:key emits setting:<key> with the raw string', () => {
    const w = mkWindow();
    const seen = spy(w, 'setting:fe-case_types');
    const raw = '{"Bankruptcy":["Chapter 7","Chapter 13"]}';
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types', {
      status: 'success',
      setting: { key: 'fe-case_types', value: raw, updated_at: '2026-08-23T12:00:00.000Z' },
    });
    expect(seen).toEqual([{
      fields: { value: raw },
      origin: 'auto:PUT /api/app-settings/fe-case_types',
      addr:   'setting:fe-case_types',
    }]);
  });

  test('the value is NOT parsed by the bus — structured settings stay strings', () => {
    // If this ever fails, someone moved JSON.parse into the transport and every
    // subscriber's contract changed underneath it.
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    w.YC._sniff('PUT', '/api/app-settings/fe-event_types',
                { setting: { key: 'fe-event_types', value: '["Hearing"]' } });
    expect(typeof seen[0].fields.value).toBe('string');
    expect(seen[0].fields.value).toBe('["Hearing"]');
  });

  test('an empty-string value still emits — blanking a setting is a real change', () => {
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    w.YC._sniff('PUT', '/api/app-settings/fe-lead_sources',
                { setting: { key: 'fe-lead_sources', value: '' } });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({ value: '' });
  });

  test('a NON-STRING setting.value emits nothing', () => {
    // The route refuses non-strings (400), so this shape can only arrive from a
    // future/altered response. Fail closed rather than broadcast an object.
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types',
                { setting: { key: 'fe-case_types', value: { a: 1 } } });
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types',
                { setting: { key: 'fe-case_types', value: null } });
    expect(seen).toEqual([]);
  });

  test('an absent setting.value — or no setting key at all — emits nothing', () => {
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types', { setting: { key: 'fe-case_types' } });
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types', { status: 'success' });
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types', null);
    expect(seen).toEqual([]);
  });

  test('PATCH to the same path emits nothing — the matcher is PUT-only', () => {
    // The method gate was WIDENED for PUT, not removed. app-settings has
    // exactly one per-key writer and it is a PUT; a PATCH reaching this path
    // is not a settings write and must not announce one.
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    const body = { setting: { key: 'fe-case_types', value: '{}' } };
    w.YC._sniff('PATCH', '/api/app-settings/fe-case_types', body);
    w.YC._sniff('POST',  '/api/app-settings/fe-case_types', body);
    w.YC._sniff('GET',   '/api/app-settings/fe-case_types', body);
    expect(seen).toEqual([]);
  });

  test('POST /api/app-settings (create) addresses from the BODY, not the URL', () => {
    // Was asserted silent through Slice 2 — the bare path has no :key segment,
    // so the PUT matcher structurally cannot reach it. Slice 2b gives it its own
    // capture-less matcher whose getter reads the key out of the response, which
    // is close-out Finding 2: a newly created fe-* row now reaches open frames.
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    w.YC._sniff('POST', '/api/app-settings',
                { status: 'success', setting: { key: 'fe-new_thing', value: '[]' } });
    expect(seen).toEqual([{
      fields: { value: '[]' },
      origin: 'auto:POST /api/app-settings',
      addr:   'setting:fe-new_thing',
    }]);
  });

  test('KEY CHARSET: dots, hyphens and underscores all round-trip in the address', () => {
    const w = mkWindow();
    const seen = spy(w, 'setting:*');
    for (const key of ['dropbox_case_folder_templates', 'fe-firm_site_url', 'some.dotted.key']) {
      w.YC._sniff('PUT', '/api/app-settings/' + key, { setting: { key, value: 'v' } });
    }
    expect(seen.map(s => s.addr)).toEqual([
      'setting:dropbox_case_folder_templates',
      'setting:fe-firm_site_url',
      'setting:some.dotted.key',
    ]);
  });

  test("'setting:*' does not pick up case/contact traffic, and vice versa", () => {
    const w = mkWindow();
    const settings = spy(w, 'setting:*');
    const cases = spy(w, 'case:*');
    w.YC._sniff('PUT', '/api/app-settings/fe-case_types',
                { setting: { key: 'fe-case_types', value: '{}' } });
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    expect(settings.map(s => s.addr)).toEqual(['setting:fe-case_types']);
    expect(cases.map(s => s.addr)).toEqual(['case:AAAA']);
  });

  test('THE ORIGINAL FOUR are unchanged by the widened gate', () => {
    // Regression fence for the gate widening: PATCH and POST must still reach
    // the pre-Slice-2 matchers exactly as before, and GET must still not.
    const w = mkWindow();
    const seen = spy(w, 'case:*');
    const contacts = spy(w, 'contact:*');
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    w.YC._sniff('PATCH', '/api/contacts/5', { data: { changes: { contact_phone: '2' } } });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket', { changes: { case_number: '24-1' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/pipeline/advance', { changes: { pipeline_phase: 'case' } });
    w.YC._sniff('GET',   '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    expect(seen.map(s => s.origin)).toEqual([
      'auto:PATCH /api/cases/AAAA',
      'auto:PATCH /api/cases/AAAA/docket',
      'auto:POST /api/cases/AAAA/pipeline/advance',
    ]);
    expect(contacts.length).toBe(1);
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

// ─────────────────────────────────────────────────────────────
// Getter contract v2 (Slice 2b) — multi-emit
//
// A getter may now return an ARRAY of {addr, fields} instead of a single fields
// object. Two matchers need it: the contacts matcher (a transfer changes TWO
// contacts, and the second one is not in the URL) and the app-settings CREATE
// route (no :key segment at all — the address is in the body).
//
// The regression fence matters as much as the new behaviour: four of the six
// matchers still return a plain object, and their emit path must be untouched.
// ─────────────────────────────────────────────────────────────

describe('getter contract v2 — legacy object return is untouched', () => {
  function spy(w, addr) {
    const seen = [];
    w.YC.on(addr, '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  test('the FIVE object-returning matchers emit exactly one message each, keyed off the URL', () => {
    // The four originals plus the app-settings PUT. If a refactor of _sniff ever
    // routes one of these down the array branch, the addr or the count moves.
    const w = mkWindow();
    const seen = [];
    for (const t of ['case', 'contact', 'setting']) {
      w.YC.on(t + ':*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    }

    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_stage: { from: 'Open', to: 'Filed' } } } });
    w.YC._sniff('PATCH', '/api/contacts/5', { data: { changes: { contact_fname: { from: 'A', to: 'B' } } } });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket', { changes: { case_number: '24-1' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/pipeline/advance', { changes: { pipeline_phase: 'case' } });
    w.YC._sniff('PUT',   '/api/app-settings/fe-case_types', { setting: { key: 'fe-case_types', value: '{}' } });

    expect(seen).toEqual([
      { addr: 'case:AAAA',              fields: { case_stage: 'Filed' },   origin: 'auto:PATCH /api/cases/AAAA' },
      { addr: 'contact:5',              fields: { contact_fname: 'B' },    origin: 'auto:PATCH /api/contacts/5' },
      { addr: 'case:AAAA',              fields: { case_number: '24-1' },   origin: 'auto:PATCH /api/cases/AAAA/docket' },
      { addr: 'case:AAAA',              fields: { pipeline_phase: 'case' }, origin: 'auto:POST /api/cases/AAAA/pipeline/advance' },
      { addr: 'setting:fe-case_types',  fields: { value: '{}' },           origin: 'auto:PUT /api/app-settings/fe-case_types' },
    ]);
  });

  test('an object getter returning empty / null / a non-object still emits nothing', () => {
    const w = mkWindow();
    const seen = spy(w, 'case:*');
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: {} } });
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: {} });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket', { changes: null });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket', { changes: 'nope' });
    expect(seen).toEqual([]);
  });
});

describe('getter contract v2 — array return', () => {
  /* The array branch is exercised through the two shipped matchers rather than
     an injected fake: MATCHERS is closed over inside the IIFE, so a test that
     reached in to add a synthetic matcher would be testing a fixture. These
     cover the branch's own semantics — N emits, empty array, per-entry empty
     fields — using the contacts matcher as the vehicle. */
  function spy(w, addr) {
    const seen = [];
    w.YC.on(addr, '*', (f, m) => seen.push({ addr: m.addr, fields: f }));
    return seen;
  }

  test('N entries produce N emits, each with the same auto: origin', () => {
    const w = mkWindow();
    const seen = [];
    w.YC.on('contact:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: { contact_phone: { from: '1', to: '2' } },
        transferred_from: [
          { kind: 'phone', from_contact_id: 77, from_contact_name: 'Don', phone: '2' },
          { kind: 'email', from_contact_id: 88, from_contact_name: 'Eve', email: 'e@x.com' },
        ],
      },
    });
    expect(seen).toEqual([
      { addr: 'contact:5',  fields: { contact_phone: '2' }, origin: 'auto:PATCH /api/contacts/5?force=true' },
      { addr: 'contact:77', fields: { yc_refetch: 1 },      origin: 'auto:PATCH /api/contacts/5?force=true' },
      { addr: 'contact:88', fields: { yc_refetch: 1 },      origin: 'auto:PATCH /api/contacts/5?force=true' },
    ]);
  });

  test('an EMPTY array emits nothing and logs nothing', () => {
    const w = mkWindow();
    const seen = spy(w, 'contact:*');
    // No changes, no transfers → the getter returns [].
    w.YC._sniff('PATCH', '/api/contacts/5', { data: { changes: {}, transferred_from: [] } });
    expect(seen).toEqual([]);
    expect(w.YC._log.length).toBe(0);
  });

  test('an entry whose fields are empty is skipped, the rest still emit', () => {
    const w = mkWindow();
    const seen = spy(w, 'contact:*');
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: {},                                       // recipient entry never built
        transferred_from: [{ kind: 'phone', from_contact_id: 77, phone: '2' }],
      },
    });
    expect(seen).toEqual([{ addr: 'contact:77', fields: { yc_refetch: 1 } }]);
  });

  test('each entry is an independent message in _log', () => {
    const w = mkWindow();
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: { contact_phone: '2' },
        transferred_from: [{ kind: 'phone', from_contact_id: 77, phone: '2' }],
      },
    });
    expect(w.YC._log.map(m => m.addr)).toEqual(['contact:5', 'contact:77']);
  });
});

// ─────────────────────────────────────────────────────────────
// The contacts matcher (Slice 2b) — transfer donors
//
// B7: a cross-contact transfer moves a phone/email row OFF a donor contact. The
// donor's change is an ABSENCE, which has no {column: value} form, so it rides
// the bus as the reserved `yc_refetch` field. This is the ONE sanctioned
// invalidation on an otherwise values-only bus.
// ─────────────────────────────────────────────────────────────

describe('_sniff — contacts matcher', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('contact:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f }));
    return seen;
  }

  test('a plain save with `changes` only emits ONE message — Slice 1 behaviour, unchanged', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5',
                { data: { changes: { contact_fname: { from: 'A', to: 'B' } } } });
    expect(seen).toEqual([{ addr: 'contact:5', fields: { contact_fname: 'B' } }]);
  });

  test('ONE donor emit for a phone AND an email from the SAME donor', () => {
    // The dedupe that matters: contactService concatenates the phone plan's and
    // the email plan's transferred_from arrays, so one donor legitimately appears
    // twice. Two refetch messages would cost that page a second round-trip for
    // exactly the same refetch.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: { contact_phone: { from: '1', to: '2' } },
        transferred_from: [
          { kind: 'phone', from_contact_id: 77, from_contact_name: 'Don', phone: '2486000000' },
          { kind: 'email', from_contact_id: 77, from_contact_name: 'Don', email: 'don@x.com' },
        ],
      },
    });
    expect(seen).toEqual([
      { addr: 'contact:5',  fields: { contact_phone: '2' } },
      { addr: 'contact:77', fields: { yc_refetch: 1 } },
    ]);
  });

  test('a donor id EQUAL to the recipient is excluded — nothing was left behind', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: { contact_phone: '2' },
        transferred_from: [{ kind: 'phone', from_contact_id: 5, phone: '2' }],
      },
    });
    expect(seen).toEqual([{ addr: 'contact:5', fields: { contact_phone: '2' } }]);
  });

  test('a STRING donor id equal to the numeric recipient id is also excluded', () => {
    // The URL capture is a string and from_contact_id is a number; the exclusion
    // compares String(...) on both sides so a JSON shape change can't slip a
    // self-refetch through.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: { changes: { contact_phone: '2' }, transferred_from: [{ from_contact_id: '5' }] },
    });
    expect(seen).toEqual([{ addr: 'contact:5', fields: { contact_phone: '2' } }]);
  });

  test('`changes` EMPTY but transfers present → donor emit still fires', () => {
    // The aggregate-only save: repeaters changed, no scalar column did. Before
    // 2b the whole response went unannounced; the donor still needs telling.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: {
        changes: {},
        phones_changed: 1,
        transferred_from: [{ kind: 'phone', from_contact_id: 77, phone: '2' }],
      },
    });
    expect(seen).toEqual([{ addr: 'contact:77', fields: { yc_refetch: 1 } }]);
  });

  test('no `changes` key at all, transfers present → donor emit still fires', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true',
                { data: { transferred_from: [{ from_contact_id: 77 }] } });
    expect(seen).toEqual([{ addr: 'contact:77', fields: { yc_refetch: 1 } }]);
  });

  test('a malformed transferred_from is ignored, not thrown on', () => {
    const w = mkWindow();
    const seen = spy(w);
    for (const tf of [null, 'nope', 42, [{}], [null], [{ from_contact_id: null }], [{ from_contact_id: '' }]]) {
      w.YC._sniff('PATCH', '/api/contacts/9?force=true',
                  { data: { changes: { contact_lname: 'X' }, transferred_from: tf } });
    }
    // Seven calls, seven recipient emits, zero donor emits.
    expect(seen.map(s => s.addr)).toEqual(Array(7).fill('contact:9'));
  });

  test('transferred_from at the TOP LEVEL is ignored — the route nests it under data', () => {
    // routes/api.contacts.js returns the service payload as `data`. Reading the
    // top level would be reading a shape the server never sends.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: { changes: { contact_phone: '2' } },
      transferred_from: [{ from_contact_id: 77 }],
    });
    expect(seen).toEqual([{ addr: 'contact:5', fields: { contact_phone: '2' } }]);
  });

  test('a donor message reaches a contact:<donor> subscriber, not just the wildcard', () => {
    // The entity page subscribes to its OWN address. If the donor emit only ever
    // matched 'contact:*' the whole B7 fix would be dead on arrival.
    const w = mkWindow();
    const donor = [];
    w.YC.on('contact:77', '*', f => donor.push(f));
    w.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: { changes: {}, transferred_from: [{ from_contact_id: 77 }] },
    });
    expect(donor).toEqual([{ yc_refetch: 1 }]);
  });

  test('a donor emit crosses windows like any other message', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('contact:77', '*', f => seenB.push(f));
    a.YC._sniff('PATCH', '/api/contacts/5?force=true', {
      data: { changes: {}, transferred_from: [{ from_contact_id: 77 }] },
    });
    await settle();
    expect(seenB).toEqual([{ yc_refetch: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────
// The app-settings CREATE matcher (Slice 2b) — close-out Finding 2
// ─────────────────────────────────────────────────────────────

describe('_sniff — app-settings create', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('setting:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f }));
    return seen;
  }

  test('a non-string value emits nothing — fail closed, same as the PUT matcher', () => {
    const w = mkWindow();
    const seen = spy(w);
    for (const value of [{ a: 1 }, null, 42, undefined, ['x']]) {
      w.YC._sniff('POST', '/api/app-settings', { setting: { key: 'fe-x', value } });
    }
    expect(seen).toEqual([]);
  });

  test('a missing / non-string / empty key emits nothing', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/app-settings', { setting: { value: 'v' } });
    w.YC._sniff('POST', '/api/app-settings', { setting: { key: 7, value: 'v' } });
    w.YC._sniff('POST', '/api/app-settings', { setting: { key: '', value: 'v' } });
    w.YC._sniff('POST', '/api/app-settings', { status: 'success' });
    w.YC._sniff('POST', '/api/app-settings', null);
    expect(seen).toEqual([]);
  });

  test('an empty-string value still emits — creating a blank setting is a real event', () => {
    // The route defaults an omitted value to ''. That row exists and open frames
    // should know its key.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/app-settings', { setting: { key: 'fe-blank', value: '' } });
    expect(seen).toEqual([{ addr: 'setting:fe-blank', fields: { value: '' } }]);
  });

  test('PUT / PATCH / GET on the BARE path emit nothing — the matcher is POST-only', () => {
    const w = mkWindow();
    const seen = spy(w);
    const body = { setting: { key: 'fe-x', value: 'v' } };
    w.YC._sniff('PUT',   '/api/app-settings', body);
    w.YC._sniff('PATCH', '/api/app-settings', body);
    w.YC._sniff('GET',   '/api/app-settings', body);
    expect(seen).toEqual([]);
  });

  test('the bare-path and per-key matchers do not poach each other', () => {
    const w = mkWindow();
    const seen = spy(w);
    // POST to a per-key path: matches the PUT-only matcher, which refuses POST.
    w.YC._sniff('POST', '/api/app-settings/fe-x', { setting: { key: 'fe-x', value: 'v' } });
    // PUT to a per-key path: still works, unchanged.
    w.YC._sniff('PUT',  '/api/app-settings/fe-y', { setting: { key: 'fe-y', value: 'v' } });
    expect(seen).toEqual([{ addr: 'setting:fe-y', fields: { value: 'v' } }]);
  });

  test('the created key addresses the row, even when the URL knows nothing about it', () => {
    const w = mkWindow();
    const exact = [];
    w.YC.on('setting:fe-lead_sources', '*', f => exact.push(f));
    w.YC._sniff('POST', '/api/app-settings',
                { setting: { key: 'fe-lead_sources', value: '["Web"]', type: 'json_array' } });
    expect(exact).toEqual([{ value: '["Web"]' }]);
  });
});

// ─────────────────────────────────────────────────────────────
// The revive matchers (Slice 2c) — the SECOND transfer endpoint
//
// contact-form.html has two 409-force flows. The aggregate form save
// (PATCH /api/contacts/:id) was covered in 2b; this is the other one —
// reviveRow's POST /api/contact-{phones,emails}, which ends the value on
// whoever currently holds it.
//
// The whole reason this needed its own matcher rather than a shared one is the
// RESPONSE SHAPE, which is different in all three ways that matter:
//
//   PATCH  →  data.transferred_from = [{ from_contact_id, kind, … }]   nested, array, from_contact_id
//   POST   →       transferred_from =  { contact_id, contact_name, … }  top-level, object, contact_id
//
// A getter copied from the contacts matcher reads `undefined` and announces
// nothing — green tests, silent donor. These pin the real shape.
// ─────────────────────────────────────────────────────────────

describe('_sniff — revive matchers', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('contact:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  /** The real 201 body shape, per contactPhoneService.createContactPhone. */
  function phoneBody(over = {}) {
    return {
      status: 'success',
      phone: { id: 9, contact_id: 5, phone: '2485550001', is_primary: 1 },
      auto_promoted: true,
      ...over,
    };
  }

  test('POST /api/contact-phones?force=true announces the DONOR', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true', phoneBody({
      transferred_from: { contact_id: 77, contact_name: 'Don', phone_id: 3 },
    }));
    expect(seen).toEqual([{
      addr: 'contact:77',
      fields: { yc_refetch: 1 },
      origin: 'auto:POST /api/contact-phones?force=true',
    }]);
  });

  test('POST /api/contact-emails?force=true announces the DONOR', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-emails?force=true', {
      email: { id: 4, contact_id: 5, email: 'don@x.com' },
      auto_promoted: false,
      transferred_from: { contact_id: 88, contact_name: 'Eve', email_id: 2 },
    });
    expect(seen).toEqual([{
      addr: 'contact:88',
      fields: { yc_refetch: 1 },
      origin: 'auto:POST /api/contact-emails?force=true',
    }]);
  });

  test('the id key is `contact_id`, NOT `from_contact_id`', () => {
    // The trap, pinned. A getter copied from the contacts matcher reads
    // from_contact_id, gets undefined, and silently announces nothing.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ transferred_from: { from_contact_id: 77, phone_id: 3 } }));
    expect(seen).toEqual([]);
  });

  test('the payload is TOP-LEVEL, not nested under `data`', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ data: { transferred_from: { contact_id: 77 } } }));
    expect(seen).toEqual([]);
  });

  test('the ARRAY shape fails closed — that is the PATCH path\'s payload', () => {
    // Seeing an array here means the route's contract moved. Announcing
    // `contact:[object Object]` would be worse than announcing nothing.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ transferred_from: [{ contact_id: 77 }] }));
    expect(seen).toEqual([]);
  });

  test('a PLAIN revive — no collision, no transfer — announces nothing', () => {
    // The common case by far: reviving a row nobody else holds. `force` is
    // never even reached, and there is no donor to tell.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones', phoneBody());
    w.YC._sniff('POST', '/api/contact-emails', { email: { id: 4, contact_id: 5 }, auto_promoted: false });
    expect(seen).toEqual([]);
  });

  test('a malformed transferred_from is ignored, not thrown on', () => {
    const w = mkWindow();
    const seen = spy(w);
    for (const tf of [null, 'nope', 42, {}, { contact_id: null }, { contact_id: '' }]) {
      w.YC._sniff('POST', '/api/contact-phones?force=true', phoneBody({ transferred_from: tf }));
    }
    expect(seen).toEqual([]);
  });

  test('donor === recipient is excluded', () => {
    // Unreachable through the route (a same-contact collision is a 400 long
    // before the force path), but a self-refetch would be pure noise.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ transferred_from: { contact_id: 5 } }));
    expect(seen).toEqual([]);
  });

  test('a missing row key does not block the donor emit', () => {
    // The recipient id is only used for the self-exclusion. If the response
    // ever stops carrying the row, the donor still gets told.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                { auto_promoted: false, transferred_from: { contact_id: 77 } });
    expect(seen.map(s => s.addr)).toEqual(['contact:77']);
  });

  test('the per-row PATCH and DELETE announce nothing — they cannot transfer', () => {
    // routes/api.contactPhones.js never passes `force` to updateContactPhone,
    // so PATCH has no transfer path. There is deliberately no matcher for it.
    const w = mkWindow();
    const seen = spy(w);
    const body = phoneBody({ transferred_from: { contact_id: 77 } });
    w.YC._sniff('PATCH', '/api/contact-phones/9', body);
    w.YC._sniff('PUT',   '/api/contact-phones',   body);
    w.YC._sniff('PATCH', '/api/contact-phones',   body);
    w.YC._sniff('GET',   '/api/contact-phones',   body);
    expect(seen).toEqual([]);
  });

  test('/api/contact-addresses is NOT matched — addresses cannot transfer', () => {
    // No cross-contact uniqueness on addresses → no force opt, no 409 path, no
    // transferred_from. A matcher there would be dead code pretending to help.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-addresses?force=true',
                { address: { id: 1, contact_id: 5 }, transferred_from: { contact_id: 77 } });
    expect(seen).toEqual([]);
  });

  test('the donor message reaches a contact:<donor> subscriber', () => {
    const w = mkWindow();
    const donor = [];
    w.YC.on('contact:77', '*', f => donor.push(f));
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ transferred_from: { contact_id: 77 } }));
    expect(donor).toEqual([{ yc_refetch: 1 }]);
  });

  test('phones and emails from the same donor are two SEPARATE calls, two messages', () => {
    // Unlike the aggregate PATCH (one response, deduped), revive is one row per
    // request. Two reviving clicks are two refetches on the donor — correct, and
    // idempotent either way.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contact-phones?force=true',
                phoneBody({ transferred_from: { contact_id: 77 } }));
    w.YC._sniff('POST', '/api/contact-emails?force=true',
                { email: { id: 4, contact_id: 5 }, transferred_from: { contact_id: 77 } });
    expect(seen.map(s => s.addr)).toEqual(['contact:77', 'contact:77']);
  });
});
