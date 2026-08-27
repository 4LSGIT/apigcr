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
    // `/api/cases/:id/contacts` USED TO BE the second example here, chosen in
    // Slice 1 precisely because it was a real route the bus deliberately did
    // not watch. Slice 3c watches it (case_relate is where the Primary contact
    // lives), so it moved to its own describe block below and this test keeps
    // only paths that genuinely have no matcher.
    w.YC._sniff('PATCH', '/api/cases/AAAA/tasks', { data: { changes: { a: 1 } } });
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

// ─────────────────────────────────────────────────────────────
// Appt / event matchers (Slice 3)
// ─────────────────────────────────────────────────────────────

/**
 * These eight matchers RETIRE the appt-updated / event-updated postMessage
 * system, so between them they have to cover every client-side write path that
 * system covered — plus the ones it never did. What is worth pinning:
 *
 *   · EVERY WRITE ENDPOINT IS COVERED. A gap here is not a degraded refresh,
 *     it is a list that silently stops updating. The endpoint census below is
 *     the actual contract.
 *   · THE TWO BODY-ADDRESSED ROUTES. `POST /api/appts/cancel` and
 *     `/reschedule` name their appointment in the REQUEST body, which the
 *     sniff never sees — routes/api.appts.js echoes `appt_id` back purely so
 *     these matchers can address it. If that key is ever dropped from the
 *     route, cancel goes unannounced and nothing else fails. These tests are
 *     the tripwire.
 *   · FAIL CLOSED. A create response missing its id must announce NOTHING
 *     rather than `appt:undefined` — an address no subscriber can act on, in a
 *     log that then lies about coverage.
 *   · THE MARKER, NOT VALUES. Readers are query views; a matcher that started
 *     emitting real columns would quietly change what `appt:*` means.
 */
describe('_sniff — appt / event matchers', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('appt:*',  '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    w.YC.on('event:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  const MARKER = { yc_refetch: 1 };

  test('THE CENSUS: every client-side appt/event write endpoint announces', () => {
    // Verified against routes/api.appts.js + routes/api.events.js and every
    // caller in public/ on 2026-08-24. A new write endpoint with a client
    // caller belongs in this list AND in MATCHERS.
    const w = mkWindow();
    const seen = spy(w);

    w.YC._sniff('PATCH', '/api/appts/55',              { status: 'success', updated_fields: ['appt_note'] });
    w.YC._sniff('POST',  '/api/appts/55/attended',     { status: 'success' });
    w.YC._sniff('POST',  '/api/appts/55/no-show',      { status: 'success' });
    w.YC._sniff('POST',  '/api/appts',                 { data: { appt_id: 56 } });
    w.YC._sniff('POST',  '/api/appts/cancel',          { status: 'success', appt_id: 57 });
    w.YC._sniff('POST',  '/api/appts/reschedule',      { status: 'success', appt_id: 58, new_appt_id: 59 });
    w.YC._sniff('PATCH', '/api/events/12',             { data: { event_id: 12 } });
    w.YC._sniff('PATCH', '/api/events/12/complete',    { data: { event_id: 12 } });
    w.YC._sniff('PATCH', '/api/events/12/cancel',      { data: { event_id: 12 } });
    w.YC._sniff('POST',  '/api/events',                { data: { event_id: 13 } });

    expect(seen.map(s => s.addr)).toEqual([
      'appt:55', 'appt:55', 'appt:55', 'appt:56', 'appt:57', 'appt:58', 'appt:59',
      'event:12', 'event:12', 'event:12', 'event:13',
    ]);
    // Marker only — never a column value, on any of them.
    expect(seen.every(s => JSON.stringify(s.fields) === JSON.stringify(MARKER))).toBe(true);
  });

  test('the id comes from the URL where the URL has one', () => {
    const w = mkWindow();
    const seen = spy(w);
    // A response body naming a DIFFERENT row must not win over the URL.
    w.YC._sniff('PATCH', '/api/appts/55', { data: { appt_id: 999 } });
    expect(seen.map(s => s.addr)).toEqual(['appt:55']);
  });

  test('CANCEL: the appt id comes from the response body the route echoes', () => {
    // routes/api.appts.js adds `appt_id` to this response for this matcher and
    // nothing else. Drop it there and cancel goes silently unannounced.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts/cancel', { status: 'success', title: 'Appointment Canceled', appt_id: 57 });
    expect(seen).toEqual([
      { addr: 'appt:57', fields: MARKER, origin: 'auto:POST /api/appts/cancel' },
    ]);
  });

  test('CANCEL fails closed when the route stops echoing appt_id', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts/cancel', { status: 'success', message: 'Canceled' });
    expect(seen).toEqual([]);
  });

  test('RESCHEDULE announces BOTH appointments — the old one and its successor', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts/reschedule', { appt_id: 58, new_appt_id: 59 });
    expect(seen.map(s => s.addr)).toEqual(['appt:58', 'appt:59']);
  });

  test('RESCHEDULE LATER has no successor — one message', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts/reschedule', { appt_id: 58 });
    expect(seen.map(s => s.addr)).toEqual(['appt:58']);
  });

  test('RESCHEDULE dedupes if the two ids ever coincide', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts/reschedule', { appt_id: 58, new_appt_id: '58' });
    expect(seen.map(s => s.addr)).toEqual(['appt:58']);
  });

  test('CREATE fails closed on a malformed response', () => {
    // No `appt:undefined` / `event:undefined`: an address no subscriber can act
    // on, logged as if it were coverage.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/appts',  { status: 'success' });          // no data
    w.YC._sniff('POST', '/api/appts',  { data: {} });                   // no appt_id
    w.YC._sniff('POST', '/api/appts',  { data: { appt_id: null } });
    w.YC._sniff('POST', '/api/appts',  { data: { appt_id: '' } });
    w.YC._sniff('POST', '/api/events', { status: 'success' });
    w.YC._sniff('POST', '/api/events', { data: { event_title: 'no id' } });
    expect(seen).toEqual([]);
  });

  test('GET announces nothing on any of them — this is what stops the loop', () => {
    // §3.6: every reader answers these messages with a GET. If GET could sniff,
    // the bus would eat the browser.
    const w = mkWindow();
    const seen = spy(w);
    for (const url of ['/api/appts/55', '/api/appts', '/api/appts/cancel',
                       '/api/events/12', '/api/events']) {
      w.YC._sniff('GET', url, { data: { appt_id: 55, event_id: 12 }, appt_id: 55 });
    }
    expect(seen).toEqual([]);
  });

  test('the method gates hold — no route accepts the verb these reject', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST',  '/api/appts/55',           { data: { appt_id: 55 } });  // PATCH-only
    w.YC._sniff('PATCH', '/api/appts',              { data: { appt_id: 56 } });  // POST-only
    w.YC._sniff('PATCH', '/api/appts/cancel',       { appt_id: 57 });            // POST-only
    w.YC._sniff('POST',  '/api/events/12',          { data: { event_id: 12 } }); // PATCH-only
    w.YC._sniff('POST',  '/api/events/12/complete', { data: { event_id: 12 } }); // PATCH-only
    w.YC._sniff('PUT',   '/api/events',             { data: { event_id: 13 } }); // POST-only
    expect(seen).toEqual([]);
  });

  test('DELETE reaches no APPT/EVENT matcher — the prediction, resolved', () => {
    /* THIS TEST MADE A PREDICTION IN SLICE 3 AND SLICE 3c CASHED IT.

       It used to read: "neither resource has a DELETE route… if a real DELETE
       route ever appears, _sniff's global method gate has to admit it FIRST —
       this test is the reminder that the gate, not the matcher, is the thing to
       change." That day came. `DELETE /api/cases/:id/contacts/:contactId` is
       the app's first sniffed delete, the gate was widened for it, and the
       reminder did its job.

       What it asserts now is narrower and still worth having: appts and events
       STILL have no DELETE route (cancel is the delete analogue on both,
       verified 2026-08-24), so their matchers stay PATCH/POST-only and reject
       the verb the gate now lets through. The gate is no longer what protects
       them — their own method lists are. */
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('DELETE', '/api/appts/55',  { status: 'success' });
    w.YC._sniff('DELETE', '/api/events/12', { status: 'success' });
    expect(seen).toEqual([]);
  });

  test('/api/events/batch is NOT matched — it has no client-side caller', () => {
    // Workflows and the court pipeline call it server-side, where there is no
    // apiSend to sniff. A matcher here would be dead code pretending to help;
    // server-side writers wait for the Slice-4 change feed.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/events/batch',
                { created: 2, results: [{ ok: true, event_id: 1 }, { ok: true, event_id: 2 }] });
    expect(seen).toEqual([]);
  });

  test('appt and event address spaces do not poach each other', () => {
    const w = mkWindow();
    const appts = [], events = [];
    w.YC.on('appt:*',  '*', (f, m) => appts.push(m.addr));
    w.YC.on('event:*', '*', (f, m) => events.push(m.addr));
    w.YC._sniff('PATCH', '/api/appts/55',  { status: 'success' });
    w.YC._sniff('PATCH', '/api/events/55', { data: { event_id: 55 } });
    expect(appts).toEqual(['appt:55']);
    expect(events).toEqual(['event:55']);
  });

  test('a marker reaches an entity-scoped subscriber, not just the wildcard', () => {
    const w = mkWindow();
    const one = [];
    w.YC.on('appt:55', '*', f => one.push(f));
    w.YC._sniff('POST', '/api/appts/55/attended', { status: 'success' });
    expect(one).toEqual([{ yc_refetch: 1 }]);
  });

  test('checklistView value emits COEXIST with sniff markers on the same address', () => {
    // A note save produces BOTH: the sniff's marker (the PATCH is sniffed) and
    // checklistView's own value emit. Wildcard readers must treat either as
    // "refetch" — which is why they must never branch on field names.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/appts/55', { status: 'success', updated_fields: ['appt_note'] });
    w.YC.emit('appt:55', { appt_note: 'called client' }, 'checklistView:saveBody');
    expect(seen.map(s => s.fields)).toEqual([
      { yc_refetch: 1 },
      { appt_note: 'called client' },
    ]);
  });

  test('the query strip applies here too', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/appts/55?foo=1', { status: 'success' });
    expect(seen.map(s => s.addr)).toEqual(['appt:55']);
  });

  test('a non-numeric id does not match the per-row matchers', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/appts/abc',  { status: 'success' });
    w.YC._sniff('PATCH', '/api/events/abc', { data: {} });
    expect(seen).toEqual([]);
  });

  test('a marker crosses windows like any other message', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('appt:*', '*', (f, m) => seenB.push({ addr: m.addr, fields: f }));
    a.YC._sniff('POST', '/api/appts/cancel', { appt_id: 57 });
    await settle();
    expect(seenB).toEqual([{ addr: 'appt:57', fields: { yc_refetch: 1 } }]);
  });

  test('THE PRE-SLICE-3 MATCHERS are untouched', () => {
    // Regression fence: the appt/event patterns are all anchored, so none of
    // them may shadow a case/contact/setting endpoint.
    const w = mkWindow();
    const cases = [], contacts = [], settings = [];
    w.YC.on('case:*',    '*', (f, m) => cases.push(m.addr));
    w.YC.on('contact:*', '*', (f, m) => contacts.push(m.addr));
    w.YC.on('setting:*', '*', (f, m) => settings.push(m.addr));
    w.YC._sniff('PATCH', '/api/cases/AAAA',                    { data: { changes: { case_stage: 'Filed' } } });
    w.YC._sniff('PATCH', '/api/contacts/5',                    { data: { changes: { contact_phone: '2' } } });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket',             { changes: { case_number: '24-1' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/pipeline/advance',   { changes: { pipeline_phase: 'case' } });
    w.YC._sniff('PUT',   '/api/app-settings/fe-case_types',    { setting: { value: '[]' } });
    w.YC._sniff('POST',  '/api/app-settings',                  { setting: { key: 'fe-x', value: '1' } });
    w.YC._sniff('POST',  '/api/contact-phones?force=true',
                { phone: { id: 1, contact_id: 5 }, transferred_from: { contact_id: 77 } });
    expect(cases).toEqual(['case:AAAA', 'case:AAAA', 'case:AAAA']);
    expect(contacts).toEqual(['contact:5', 'contact:77']);
    expect(settings).toEqual(['setting:fe-case_types', 'setting:fe-x']);
  });
});

// ─────────────────────────────────────────────────────────────
// Case merge (Slice 3b)
//
// The endpoint that serves BOTH the preview and the real thing, with the same
// 200 shape. `data.dry_run` is the only thing separating "nothing happened" from
// "eleven log rows and three appointments just moved onto this case", so it is
// the assertion that matters most in this block.
// ─────────────────────────────────────────────────────────────

describe('_sniff — case merge', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('case:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  /** The route's real envelope: res.json({status, data: <plan>}). */
  const body = (over = {}) => ({
    status: 'success',
    data: {
      dry_run: false,
      survivor_id: 'AAAA',
      loser_id: 'BBBB',
      docket: { adopted: {} },
      fields: { filled: ['case_dropbox'], survivor_wins: [], conflicts: [] },
      notes_appended: true, alerts_appended: false, dropbox_noted: false,
      children: { appts: 3, log: 11 },
      ...over,
    },
  });

  test('a REAL merge announces the survivor, once, with a marker', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body());
    expect(seen).toEqual([{
      addr: 'case:AAAA',
      fields: { yc_refetch: 1 },
      origin: 'auto:POST /api/cases/AAAA/merge',
    }]);
  });

  test('THE DRY RUN ANNOUNCES NOTHING — same endpoint, same 200, no writes', () => {
    // The preview dialog runs this on every "Preview merge" click. If it
    // announced, opening the dialog and cancelling would still cost every open
    // Cases tab, Kanban board and case file a refetch.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body({ dry_run: true }));
    expect(seen).toEqual([]);
    expect(w.YC._log).toEqual([]);
  });

  test('THE ABSORBED CASE IS NEVER ADDRESSED — accepted gap, pinned', () => {
    // Manager decision (design v2.4): a remote page on the loser would answer a
    // refetch with a GET for a deleted row and land in a 404 error state, which
    // is worse than stale. If this ever starts failing, someone has added a
    // loser emit and the "deleted" bus concept needs designing first.
    const w = mkWindow();
    const loser = [];
    w.YC.on('case:BBBB', '*', f => loser.push(f));
    const seen = spy(w);
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body());
    expect(loser).toEqual([]);
    expect(seen.map(s => s.addr)).toEqual(['case:AAAA']);
  });

  test('the address comes from the BODY, not the URL capture', () => {
    // They agree by construction (the route builds survivor_id from
    // req.params.id). Pinned so the getter cannot quietly regress to the URL:
    // the body is the server's account of what it actually merged.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/cases/FROMURL/merge', body({ survivor_id: 'FROMBODY' }));
    expect(seen.map(s => s.addr)).toEqual(['case:FROMBODY']);
  });

  test('SHAPE SURPRISES FAIL CLOSED — no survivor, no data', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body({ survivor_id: '' }));
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body({ survivor_id: null }));
    w.YC._sniff('POST', '/api/cases/AAAA/merge', { status: 'success' });
    w.YC._sniff('POST', '/api/cases/AAAA/merge', { status: 'success', data: null });
    w.YC._sniff('POST', '/api/cases/AAAA/merge', null);
    // A truthy non-boolean dry_run is still a dry run as far as this is concerned.
    w.YC._sniff('POST', '/api/cases/AAAA/merge', body({ dry_run: 1 }));
    expect(seen).toEqual([]);
  });

  test('A MISSING dry_run KEY NOW ANNOUNCES — the asymmetry, flipped in 3c', () => {
    // Slice 3b required `dry_run === false` and went SILENT on a plan that had
    // lost the key, on the theory that a shape change should not be guessed at.
    // Third-pass review reversed it, and the reasoning is that the two failure
    // modes are not comparable: a missing emit on a real merge reopens the
    // exact HIGH this matcher exists to close (a survivor absorbing another
    // case, silently, on every open surface), while a wrong emit on a preview
    // costs one idempotent refetch of correct data that nobody perceives as a
    // bug. So an unrecognised shape now defaults to announcing.
    //
    // The dry-run silence itself is unchanged and is pinned by the test above:
    // it keys on the flag being present and truthy, which is what the producer
    // actually sends (pinned at the producer in
    // tests/caseMergeShapes.test.js).
    const w = mkWindow();
    const seen = spy(w);
    const d = body().data;
    delete d.dry_run;
    w.YC._sniff('POST', '/api/cases/AAAA/merge', { status: 'success', data: d });
    expect(seen.map(s => s.addr)).toEqual(['case:AAAA']);
    expect(seen[0].fields).toEqual({ yc_refetch: 1 });
  });

  test('dry_run false in every falsy spelling still announces', () => {
    // The getter is a truthy check now, so these are all "not a dry run".
    const w = mkWindow();
    const seen = spy(w);
    for (const v of [false, 0, null, undefined, '']) {
      w.YC._sniff('POST', '/api/cases/AAAA/merge', body({ dry_run: v }));
    }
    expect(seen.map(s => s.addr)).toEqual(
      ['case:AAAA', 'case:AAAA', 'case:AAAA', 'case:AAAA', 'case:AAAA']);
  });

  test('the merge matcher is POST-only and does not shadow the bare case matcher', () => {
    const w = mkWindow();
    const seen = spy(w);
    // PATCH to the same path: the 4th element rejects it.
    w.YC._sniff('PATCH', '/api/cases/AAAA/merge', body());
    expect(seen).toEqual([]);
    // And the anchored bare-case matcher still owns its own path.
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    expect(seen.map(s => s.fields)).toEqual([{ case_stage: 'Filed' }]);
  });

  test('a merge crosses windows — the survivor open in a second window hears it', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('case:AAAA', '*', (f, m) => seenB.push({ addr: m.addr, fields: f }));
    a.YC._sniff('POST', '/api/cases/AAAA/merge', body());
    await settle();
    expect(seenB).toEqual([{ addr: 'case:AAAA', fields: { yc_refetch: 1 } }]);
  });
});

// ─────────────────────────────────────────────────────────────
// Intake create / update (Slice 3b)
//
// Response shapes read off routes/api.intake.js on 2026-08-24. Both handlers
// return `{status:'success', action, id, …}` on their success paths; every
// other branch is a 4xx/5xx that apiSend throws on before the sniff runs.
//
//   /api/intake/contact  :353  action 'updated'  → id, contact_id, name
//   /api/intake/contact  :426  action 'created'  → id, contact_id, name
//   /api/intake/case     :597  action 'found'    → id            ← NO WRITES
//   /api/intake/case     :677  action 'created'  → id, case_relate
// ─────────────────────────────────────────────────────────────

describe('_sniff — intake matchers', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('case:*',    '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    w.YC.on('contact:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  const MARKER = { yc_refetch: 1 };

  test('THE CENSUS: every writing success shape announces, and `found` does not', () => {
    const w = mkWindow();
    const seen = spy(w);

    w.YC._sniff('POST', '/api/intake/contact',
      { status: 'success', message: 'client 1001 found and updated',
        action: 'updated', id: 1001, contact_id: 1001, name: 'Ann Applebaum' });
    w.YC._sniff('POST', '/api/intake/contact',
      { status: 'success', message: 'client 1002 added',
        action: 'created', id: 1002, contact_id: 1002, name: 'Bob Baum' });
    w.YC._sniff('POST', '/api/intake/case',
      { status: 'success', message: 'case created',
        action: 'created', id: 'CCCC', case_relate: 91 });
    w.YC._sniff('POST', '/api/intake/case',
      { status: 'success', message: 'case found', action: 'found', id: 'DDDD' });

    expect(seen.map(s => s.addr)).toEqual(['contact:1001', 'contact:1002', 'case:CCCC']);
    expect(seen.map(s => s.fields)).toEqual([MARKER, MARKER, MARKER]);
  });

  test("action 'found' WRITES NOTHING, so it announces nothing", () => {
    // The endpoint's third success shape: an active case of the same type
    // already existed and its id is being returned. A refetch on every open
    // surface for a row that did not change is pure cost.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/intake/case',
      { status: 'success', message: 'case found', action: 'found', id: 'DDDD' });
    expect(seen).toEqual([]);
    expect(w.YC._log).toEqual([]);
  });

  test('an UPDATE announces as loudly as a create — intake/contact is an upsert', () => {
    // It matches on phone/email and updates the contact it finds. That write
    // lands on a contact that may be open in three frames.
    const w = mkWindow();
    const seen = [];
    w.YC.on('contact:1001', '*', f => seen.push(f));
    w.YC._sniff('POST', '/api/intake/contact',
      { status: 'success', action: 'updated', id: 1001, contact_id: 1001, name: 'Ann' });
    expect(seen).toEqual([MARKER]);
  });

  test('the origin string names the endpoint, for _log traceability', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/intake/case', { status: 'success', action: 'created', id: 'CCCC' });
    expect(seen[0].origin).toBe('auto:POST /api/intake/case');
  });

  test('MALFORMED FAILS CLOSED — no id, empty id, no action, unknown action, no body', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/intake/case',    { status: 'success', action: 'created' });
    w.YC._sniff('POST', '/api/intake/case',    { status: 'success', action: 'created', id: '' });
    w.YC._sniff('POST', '/api/intake/case',    { status: 'success', action: 'created', id: null });
    w.YC._sniff('POST', '/api/intake/contact', { status: 'success', id: 1001 });
    w.YC._sniff('POST', '/api/intake/contact', { status: 'success', action: 'merged', id: 1001 });
    w.YC._sniff('POST', '/api/intake/contact', { status: 'success', action: 'created', id: '' });
    w.YC._sniff('POST', '/api/intake/case',    null);
    w.YC._sniff('POST', '/api/intake/case',    'not an object');
    expect(seen).toEqual([]);
  });

  test('a numeric-zero id is not treated as missing', () => {
    // 0 is not a real contact_id, but `!id` would drop it while `id == null`
    // does not — pinning which rule the getter uses.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/intake/contact',
      { status: 'success', action: 'created', id: 0, contact_id: 0 });
    expect(seen.map(s => s.addr)).toEqual(['contact:0']);
  });

  test('the intake matchers are POST-only and do not cross-address', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/intake/contact', { status: 'success', action: 'created', id: 1 });
    w.YC._sniff('PUT',   '/api/intake/case',    { status: 'success', action: 'created', id: 'X' });
    expect(seen).toEqual([]);
    // The contact endpoint never produces a case address, and vice versa.
    const cases = [], contacts = [];
    w.YC.on('case:*',    '*', (f, m) => cases.push(m.addr));
    w.YC.on('contact:*', '*', (f, m) => contacts.push(m.addr));
    w.YC._sniff('POST', '/api/intake/contact', { status: 'success', action: 'created', id: 7 });
    w.YC._sniff('POST', '/api/intake/case',    { status: 'success', action: 'created', id: 'ZZZZ' });
    expect(cases).toEqual(['case:ZZZZ']);
    expect(contacts).toEqual(['contact:7']);
  });

  test('a sub-path under /api/intake is not matched', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/intake/contact/merge', { status: 'success', action: 'created', id: 1 });
    w.YC._sniff('POST', '/api/intake',               { status: 'success', action: 'created', id: 1 });
    expect(seen).toEqual([]);
  });

  test('an intake create crosses windows — window B\'s Cases tab hears it', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('case:*', '*', (f, m) => seenB.push({ addr: m.addr, fields: f }));
    a.YC._sniff('POST', '/api/intake/case', { status: 'success', action: 'created', id: 'CCCC' });
    await settle();
    expect(seenB).toEqual([{ addr: 'case:CCCC', fields: { yc_refetch: 1 } }]);
  });
});

// ─────────────────────────────────────────────────────────────
// Regression fence for the whole matcher table (Slice 3b, extended 3c)
// ─────────────────────────────────────────────────────────────

describe('_sniff — every matcher in the table, no shadowing', () => {
  test('THE FULL TABLE, one call each, exact addresses', () => {
    // Every matcher in the file, in table order. Anchoring is the property
    // under test: no pattern may shadow another's path. The Slice-3c additions
    // make this sharper than it was — `/api/cases/:id/contacts` sits under the
    // same prefix as four other case matchers, and the booking-link path sits
    // under `/api/contacts/:id`, which is anchored and must not swallow it.
    const w = mkWindow();
    const seen = [];
    ['case:*', 'contact:*', 'setting:*', 'appt:*', 'event:*',
     'document:*', 'doclink:*'].forEach(a =>
      w.YC.on(a, '*', (f, m) => seen.push(m.addr)));

    w.YC._sniff('PATCH', '/api/cases/AAAA',                  { data: { changes: { case_stage: 'Filed' } } });
    w.YC._sniff('PATCH', '/api/contacts/5',                  { data: { changes: { contact_phone: '2' } } });
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket',           { changes: { case_number: '24-1' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/pipeline/advance', { changes: { pipeline_phase: 'case' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/merge',            { status: 'success', data: { dry_run: false, survivor_id: 'AAAA', loser_id: 'BBBB' } });
    w.YC._sniff('PUT',   '/api/app-settings/fe-case_types',  { setting: { value: '[]' } });
    w.YC._sniff('POST',  '/api/app-settings',                { setting: { key: 'fe-x', value: '1' } });
    w.YC._sniff('POST',  '/api/contact-phones?force=true',   { phone: { id: 1, contact_id: 5 }, transferred_from: { contact_id: 77 } });
    w.YC._sniff('POST',  '/api/contact-emails?force=true',   { email: { id: 1, contact_id: 5 }, transferred_from: { contact_id: 78 } });
    w.YC._sniff('PATCH', '/api/appts/55',                    { status: 'success' });
    w.YC._sniff('POST',  '/api/appts/55/attended',           { status: 'success' });
    w.YC._sniff('POST',  '/api/appts',                       { data: { appt_id: 56 } });
    w.YC._sniff('POST',  '/api/appts/cancel',                { status: 'success', appt_id: 57 });
    w.YC._sniff('POST',  '/api/appts/reschedule',            { status: 'success', appt_id: 58, new_appt_id: 59 });
    w.YC._sniff('PATCH', '/api/events/12',                   { data: { event_id: 12 } });
    w.YC._sniff('PATCH', '/api/events/12/complete',          { data: { event_id: 12 } });
    w.YC._sniff('POST',  '/api/events',                      { data: { event_id: 13 } });
    w.YC._sniff('POST',  '/api/intake/contact',              { status: 'success', action: 'created', id: 1002 });
    w.YC._sniff('POST',  '/api/intake/case',                 { status: 'success', action: 'created', id: 'CCCC' });
    // Slice 3c additions.
    w.YC._sniff('POST',   '/api/cases/AAAA/contacts',        { status: 'success' });
    w.YC._sniff('PATCH',  '/api/cases/AAAA/contacts/1001',   { status: 'success' });
    w.YC._sniff('DELETE', '/api/cases/AAAA/contacts/1001',   { status: 'success' });
    w.YC._sniff('POST',   '/api/contacts/1001/booking-link', { success: true, token: 'abc123' });
    // Documents S3. The three matchers sit under a shared `/api/documents/:id`
    // prefix and the bare one is anchored ($), so it must not swallow /share
    // or /links.
    w.YC._sniff('PATCH',  '/api/documents/412',       { document: { id: 412, title: 'Petition', doc_type: null, tags: 'court', status: 'active' } });
    w.YC._sniff('POST',   '/api/documents/412/share', { shared_link: 'https://www.dropbox.com/s/abc' });
    w.YC._sniff('POST',   '/api/documents/412/links', { links: [], link_type: 'case', link_id: 'AAAA' });
    w.YC._sniff('DELETE', '/api/documents/412/links', { removed: true, link_type: 'contact', link_id: '22' });

    expect(seen).toEqual([
      'case:AAAA', 'contact:5', 'case:AAAA', 'case:AAAA', 'case:AAAA',
      'setting:fe-case_types', 'setting:fe-x',
      'contact:77', 'contact:78',
      'appt:55', 'appt:55', 'appt:56', 'appt:57', 'appt:58', 'appt:59',
      'event:12', 'event:12', 'event:13',
      'contact:1002', 'case:CCCC',
      'case:AAAA', 'case:AAAA', 'case:AAAA', 'contact:1001',
      'document:412', 'document:412',
      'doclink:case:AAAA', 'doclink:contact:22',
    ]);
  });

  test('GET is still dropped by the gate; DELETE is dropped by the matcher', () => {
    // The gate admits DELETE as of Slice 3c (see the case_relate block), so
    // what keeps a DELETE off these two addresses is now the intake matchers'
    // own ['POST'] lists, not the gate. GET remains gate-dropped, and that is
    // the load-bearing half: every subscriber answers with a GET.
    const w = mkWindow();
    const seen = [];
    ['case:*', 'contact:*'].forEach(a => w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    w.YC._sniff('GET',    '/api/cases/AAAA/merge',  { status: 'success', data: { dry_run: false, survivor_id: 'AAAA' } });
    w.YC._sniff('DELETE', '/api/intake/contact',    { status: 'success', action: 'created', id: 1 });
    expect(seen).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// _sniff — documents (Documents S3)
//
// TWO address types, and the split is the whole design:
//
//   document:<id>              a `documents` ROW — title/doc_type/tags/status,
//                              or a freshly minted shared_link. REAL VALUES,
//                              so a view holding the row repaints with NO
//                              fetch.
//   doclink:<type>:<id>        a TARGET'S LINK SET. Linking writes a
//                              `document_links` row and does not touch
//                              `documents` at all, so announcing it on the
//                              document would be a lie — and announcing it as
//                              `case:AAAA` would cost every open case file a
//                              full-payload refetch for a table it does not
//                              read.
//
// The practical payoff: the GLOBAL documents page subscribes to `document:*`
// only, so a link change anywhere costs it nothing, while a case's Documents
// widget also holds its own exact `doclink:case:AAAA`.
// ─────────────────────────────────────────────────────────────

describe('_sniff — documents matchers', () => {
  function spy(w, addr) {
    const seen = [];
    w.YC.on(addr, '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  test('PATCH carries the four human-owned columns as VALUES, not a marker', () => {
    // The payoff of values-not-invalidations: two open views, one PATCH, zero
    // extra GETs.
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('PATCH', '/api/documents/412', {
      status: 'success',
      document: {
        id: 412, name: 'Petition.pdf', title: 'Petition',
        doc_type: 'court-notice', tags: 'court,filed', status: 'active',
        path: '/x/y', rev: 'abc', content_hash: 'deadbeef',
      },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({
      title: 'Petition', doc_type: 'court-notice', tags: 'court,filed', status: 'active',
    });
    expect(seen[0].origin).toBe('auto:PATCH /api/documents/412');
  });

  test('PATCH does NOT put sync-owned churn on the bus', () => {
    // path / rev / content_hash / server_modified change on every re-sync and
    // no S3 surface renders them. Carrying them would make the bus noisy for
    // subscribers that would then have to ignore them.
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('PATCH', '/api/documents/412', {
      document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active',
                  path: '/p', path_lower: '/p', rev: 'r', content_hash: 'c',
                  size: 1, server_modified: 'x', external_id: 'id:1' },
    });
    expect(Object.keys(seen[0].fields).sort())
      .toEqual(['doc_type', 'status', 'tags', 'title']);
  });

  test('status rides along — it is how a row LEAVES an active-only list', () => {
    // A reader that merged the other three but not this one would keep a
    // deleted document on screen looking perfectly normal.
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('PATCH', '/api/documents/412', {
      document: { id: 412, title: null, doc_type: null, tags: null, status: 'deleted' },
    });
    expect(seen[0].fields.status).toBe('deleted');
  });

  test('PATCH announces STATE, so an all-null row still emits (nulls are values)', () => {
    // documentService.update returns the row, not a `changes` diff, so a PATCH
    // that cleared every field must still announce — otherwise clearing a
    // title is the one edit that never propagates. `emit`'s empty-guard drops
    // an empty OBJECT, not an object of nulls.
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('PATCH', '/api/documents/412', {
      document: { id: 412, title: null, doc_type: null, tags: null, status: 'active' },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({
      title: null, doc_type: null, tags: null, status: 'active',
    });
  });

  test('PATCH fails closed on a body with no document', () => {
    const w = mkWindow();
    const seen = spy(w, 'document:*');
    w.YC._sniff('PATCH', '/api/documents/412', { status: 'success' });
    w.YC._sniff('PATCH', '/api/documents/412', { document: null });
    w.YC._sniff('PATCH', '/api/documents/412', null);
    w.YC._sniff('PATCH', '/api/documents/412', { document: 'nope' });
    expect(seen).toEqual([]);
  });

  test('/share carries the stored shared_link as a value', () => {
    // shared_link IS the column and the response IS what setSharedLink
    // persisted (post-clamp), so the "public link exists" marker lights up in
    // every open view with no fetch.
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('POST', '/api/documents/412/share',
                { status: 'success', shared_link: 'https://www.dropbox.com/s/abc' });
    expect(seen.length).toBe(1);
    expect(seen[0].fields).toEqual({ shared_link: 'https://www.dropbox.com/s/abc' });
  });

  test('/share fails closed on a non-string or empty link', () => {
    // Announcing undefined would CLEAR the public-link marker on every open
    // view — worse than saying nothing.
    const w = mkWindow();
    const seen = spy(w, 'document:*');
    w.YC._sniff('POST', '/api/documents/412/share', { shared_link: null });
    w.YC._sniff('POST', '/api/documents/412/share', { shared_link: '' });
    w.YC._sniff('POST', '/api/documents/412/share', { shared_link: { url: 'x' } });
    w.YC._sniff('POST', '/api/documents/412/share', {});
    expect(seen).toEqual([]);
  });

  test('link/unlink address the TARGET, never the document', () => {
    // THE central assertion of this block. A link write does not change the
    // `documents` row, so `document:412` would be the wrong address and would
    // make the global page refetch for a change it cannot see.
    const w = mkWindow();
    const docSeen  = spy(w, 'document:*');
    const linkSeen = spy(w, 'doclink:*');

    w.YC._sniff('POST', '/api/documents/412/links',
                { status: 'success', created: true, links: [], link_type: 'case', link_id: 'aB3xY9' });
    w.YC._sniff('DELETE', '/api/documents/412/links',
                { status: 'success', removed: true, link_type: 'contact', link_id: '22' });

    expect(docSeen).toEqual([]);
    expect(linkSeen.map(s => s.addr))
      .toEqual(['doclink:case:aB3xY9', 'doclink:contact:22']);
    expect(linkSeen[0].fields).toEqual({ yc_refetch: 1 });
    expect(linkSeen[1].fields).toEqual({ yc_refetch: 1 });
  });

  test('DELETE reaches the matcher — the gate admits it and the 4th element lists it', () => {
    // The detach is the destructive half and the half a stale widget renders
    // most wrongly (a removed document keeps showing).
    const w = mkWindow();
    const seen = spy(w, 'doclink:case:AAAA');
    w.YC._sniff('DELETE', '/api/documents/9/links',
                { removed: true, link_type: 'case', link_id: 'AAAA' });
    expect(seen.length).toBe(1);
    expect(seen[0].origin).toBe('auto:DELETE /api/documents/9/links');
  });

  test('the link getter fails closed on a missing echo', () => {
    // This is the shape the route used to return. An address built from
    // `undefined` reaches no subscriber and buries a contract change in a log
    // nobody reads — so say nothing instead, and let the route test catch it.
    const w = mkWindow();
    const seen = spy(w, 'doclink:*');
    w.YC._sniff('DELETE', '/api/documents/9/links', { status: 'success', removed: true });
    w.YC._sniff('DELETE', '/api/documents/9/links', { removed: true, link_type: 'case' });
    w.YC._sniff('DELETE', '/api/documents/9/links', { removed: true, link_id: 'AAAA' });
    w.YC._sniff('DELETE', '/api/documents/9/links', { removed: true, link_type: '', link_id: 'AAAA' });
    w.YC._sniff('DELETE', '/api/documents/9/links', { removed: true, link_type: 'case', link_id: '' });
    w.YC._sniff('POST',   '/api/documents/9/links', { links: [] });
    expect(seen).toEqual([]);
  });

  // ── S4: the staff upload commit ────────────────────────────────────────────

  test('upload-commit announces the TARGET, not the brand-new row', () => {
    // The row is new, so NOBODY is holding its id — announcing `document:78`
    // would reach no subscriber by definition. What other frames must react to
    // is that the CASE's document set is now one file longer. The uploader's
    // own frame needs no message at all; it has the row in the response.
    const w = mkWindow();
    const docSeen  = spy(w, 'document:*');
    const linkSeen = spy(w, 'doclink:*');

    w.YC._sniff('POST', '/api/documents/upload-commit', {
      status: 'success',
      document: { id: 78, name: 'statement.pdf', status: 'active' },
      link_type: 'case', link_id: 'aB3xY9', relation: 'path',
    });

    expect(docSeen).toEqual([]);
    expect(linkSeen.map(s => s.addr)).toEqual(['doclink:case:aB3xY9']);
    expect(linkSeen[0].fields).toEqual({ yc_refetch: 1 });
    expect(linkSeen[0].origin).toBe('auto:POST /api/documents/upload-commit');
  });

  test('a CONTACT-scoped upload announces the contact', () => {
    const w = mkWindow();
    const seen = spy(w, 'doclink:contact:1001');
    w.YC._sniff('POST', '/api/documents/upload-commit', {
      document: { id: 79 }, link_type: 'contact', link_id: '1001', relation: 'upload',
    });
    expect(seen.length).toBe(1);
  });

  test('a GLOBAL upload announces NOTHING — no target changed', () => {
    // An unattached file changed no case's and no contact's document set, so
    // there is no frame that would act on a message. docLinkGetter's
    // fail-closed on a missing link_type is exactly the right behaviour here,
    // not a degradation: the route deliberately echoes no target.
    const w = mkWindow();
    const seen = spy(w, '*');
    w.YC._sniff('POST', '/api/documents/upload-commit', {
      status: 'success', document: { id: 80, name: 'loose.pdf' },
    });
    expect(seen).toEqual([]);
  });

  test('only POST reaches the upload-commit matcher', () => {
    const w = mkWindow();
    const seen = spy(w, 'doclink:*');
    w.YC._sniff('GET', '/api/documents/upload-commit',
                { document: { id: 78 }, link_type: 'case', link_id: 'AAAA' });
    expect(seen).toEqual([]);
  });

  test('upload-LINK is not a matcher — issuing a link writes nothing', () => {
    // /upload-link mints a Dropbox URL and a ticket. No row, no link, no
    // change any view could render. Announcing it would make every file in a
    // batch cost every open frame a refetch for a file not yet uploaded.
    const w = mkWindow();
    const seen = spy(w, '*');
    w.YC._sniff('POST', '/api/documents/upload-link', {
      status: 'success', link: 'https://content.dropboxapi.com/apitul/1/x',
      path: '/cases/smith/x.pdf', placement: 'case', ticket: 'abc.def',
    });
    expect(seen).toEqual([]);
  });

  test('a numeric echoed link_id addresses the same place as a string one', () => {
    // The address is built by concatenation; 22 and '22' must not become two
    // addresses for one contact.
    const w = mkWindow();
    const seen = spy(w, 'doclink:contact:22');
    w.YC._sniff('DELETE', '/api/documents/9/links',
                { removed: true, link_type: 'contact', link_id: 22 });
    expect(seen.length).toBe(1);
  });

  test('doclink:* is a PREFIX match on the type — document:* never sees it', () => {
    // typeOf() splits on the FIRST colon, so 'doclink:case:AAAA' has type
    // 'doclink' and the second colon is just part of the id.
    const w = mkWindow();
    const docWild  = spy(w, 'document:*');
    const linkWild = spy(w, 'doclink:*');
    const exact    = spy(w, 'doclink:case:AAAA');
    w.YC._sniff('POST', '/api/documents/1/links',
                { links: [], link_type: 'case', link_id: 'AAAA' });
    expect(docWild).toEqual([]);
    expect(linkWild.length).toBe(1);
    expect(exact.length).toBe(1);
  });

  test('a scoped widget on ANOTHER target hears nothing', () => {
    // The whole point of addressing the target: case BBBB's widget must not
    // refetch because case AAAA gained a document.
    const w = mkWindow();
    const mine   = spy(w, 'doclink:case:AAAA');
    const theirs = spy(w, 'doclink:case:BBBB');
    w.YC._sniff('POST', '/api/documents/1/links',
                { links: [], link_type: 'case', link_id: 'AAAA' });
    expect(mine.length).toBe(1);
    expect(theirs).toEqual([]);
  });

  test('the bare /api/documents/:id matcher is anchored — /share and /links escape it', () => {
    const w = mkWindow();
    const seen = spy(w, 'document:*');
    // These two are handled by their own matchers, asserted above. What is
    // under test here is that neither produced a `document:412` VALUES emit
    // from the bare pattern.
    w.YC._sniff('POST', '/api/documents/412/links',
                { document: { id: 412, title: 'x', doc_type: null, tags: null, status: 'active' },
                  link_type: 'case', link_id: 'AAAA' });
    expect(seen).toEqual([]);
  });

  test('POST /api/documents/register announces nothing', () => {
    // Deliberate: its callers are admin/debug and the S2 smoke test, and the
    // row it creates is one no open view is holding.
    const w = mkWindow();
    const seen = [];
    ['document:*', 'doclink:*', 'case:*', 'contact:*'].forEach(a =>
      w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    w.YC._sniff('POST', '/api/documents/register',
                { status: 'success', created: true, document: { id: 9, title: null, doc_type: null, tags: null, status: 'active' } });
    expect(seen).toEqual([]);
  });

  test('GET on any documents path is dropped by the gate', () => {
    // Load-bearing: every documents subscriber answers with a GET, so a GET
    // that could announce would be a loop.
    const w = mkWindow();
    const seen = [];
    ['document:*', 'doclink:*'].forEach(a => w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    w.YC._sniff('GET', '/api/documents/412', { document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active' } });
    w.YC._sniff('GET', '/api/documents/412/links', { link_type: 'case', link_id: 'AAAA' });
    w.YC._sniff('GET', '/api/documents', { documents: [], total: 0 });
    expect(seen).toEqual([]);
  });

  test('the wrong verb on the right path announces nothing', () => {
    // Each matcher names its own verbs, so a future route on one of these
    // paths cannot inherit an emit by accident.
    const w = mkWindow();
    const seen = [];
    ['document:*', 'doclink:*'].forEach(a => w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    w.YC._sniff('POST',   '/api/documents/412',       { document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active' } });
    w.YC._sniff('PUT',    '/api/documents/412',       { document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active' } });
    w.YC._sniff('DELETE', '/api/documents/412',       { document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active' } });
    w.YC._sniff('PATCH',  '/api/documents/412/share', { shared_link: 'https://x' });
    w.YC._sniff('DELETE', '/api/documents/412/share', { shared_link: 'https://x' });
    w.YC._sniff('PATCH',  '/api/documents/412/links', { link_type: 'case', link_id: 'AAAA' });
    expect(seen).toEqual([]);
  });

  test('a query string on a documents write is stripped before matching', () => {
    const w = mkWindow();
    const seen = spy(w, 'document:412');
    w.YC._sniff('PATCH', '/api/documents/412?x=1',
                { document: { id: 412, title: 't', doc_type: null, tags: null, status: 'active' } });
    expect(seen.length).toBe(1);
    expect(seen[0].origin).toBe('auto:PATCH /api/documents/412?x=1');
  });
});

// ─────────────────────────────────────────────────────────────
// _sniff — case ↔ contact links (case_relate), Slice 3c
//
// The Primary contact is not a column on `cases`; it is the case_relate row
// whose type is 'Primary'. So the case's client name and phone, its Cases-tab
// row and its Kanban card headline all derive from a table the bus did not
// watch until this slice — and changing a Primary wrote nothing to `cases`,
// announced nothing, and left every other open surface naming the wrong person.
//
// This is also the app's FIRST SNIFFED DELETE, which is why _sniff's global
// method gate had to be widened. The gate tests below are the other half.
// ─────────────────────────────────────────────────────────────

describe('_sniff — case_relate matcher', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('case:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f, origin: m.origin }));
    return seen;
  }

  test('POST (attach) announces a marker addressed to the CASE', () => {
    const w = mkWindow();
    const seen = spy(w);
    // The real response is the service result; the getter never reads it — the
    // URL names the entity whose readers care.
    w.YC._sniff('POST', '/api/cases/AAAA/contacts',
                { status: 'success', case_relate_id: 9, contact_id: 1001 });
    expect(seen).toEqual([{
      addr: 'case:AAAA',
      fields: { yc_refetch: 1 },
      origin: 'auto:POST /api/cases/AAAA/contacts',
    }]);
  });

  test('PATCH (relate_type change) announces — the Primary swap', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/cases/AAAA/contacts/1001',
                { status: 'success', message: 'Relation updated to Primary' });
    expect(seen.map(s => s.addr)).toEqual(['case:AAAA']);
    expect(seen[0].fields).toEqual({ yc_refetch: 1 });
  });

  test('DELETE (detach) announces — the destructive half, and the point of the gate widening', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('DELETE', '/api/cases/AAAA/contacts/1001',
                { status: 'success', message: 'Contact removed from case' });
    expect(seen.map(s => s.addr)).toEqual(['case:AAAA']);
    expect(seen[0].fields).toEqual({ yc_refetch: 1 });
  });

  test('GET is silent — the listing route shares the path with the writers', () => {
    // §3.6 in miniature: every reader answers these messages by re-reading the
    // case, which hits exactly this path. If GET could sniff, the bus would eat
    // the browser.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('GET', '/api/cases/AAAA/contacts',      { contacts: [] });
    w.YC._sniff('GET', '/api/cases/AAAA/contacts/1001', { contacts: [] });
    expect(seen).toEqual([]);
  });

  test('PUT is silent — the matcher names three verbs and PUT is not one', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PUT', '/api/cases/AAAA/contacts/1001', { status: 'success' });
    expect(seen).toEqual([]);
  });

  test('the contactId segment is optional AND numeric-only', () => {
    const w = mkWindow();
    const seen = spy(w);
    // Both live shapes match…
    w.YC._sniff('POST',   '/api/cases/AAAA/contacts',      { status: 'success' });
    w.YC._sniff('DELETE', '/api/cases/AAAA/contacts/7',    { status: 'success' });
    expect(seen.length).toBe(2);
    // …and a deeper or non-numeric path does not. `contactId` is read with
    // parseInt-free `req.params.contactId` against an integer PK column;
    // widening this to [^/]+ would let a future sub-resource announce as if it
    // were a link change.
    seen.length = 0;
    w.YC._sniff('DELETE', '/api/cases/AAAA/contacts/7/notes', { status: 'success' });
    w.YC._sniff('PATCH',  '/api/cases/AAAA/contacts/abc',     { status: 'success' });
    expect(seen).toEqual([]);
  });

  test('it does not shadow — or get shadowed by — the other four case matchers', () => {
    const w = mkWindow();
    const seen = spy(w);
    // The bare case matcher is anchored, so it cannot swallow /contacts…
    w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_stage: 'Filed' } } });
    // …and /contacts cannot swallow /docket, /merge or /pipeline/advance.
    w.YC._sniff('PATCH', '/api/cases/AAAA/docket',           { changes: { case_number: '24-1' } });
    w.YC._sniff('POST',  '/api/cases/AAAA/pipeline/advance', { changes: { pipeline_phase: 'case' } });
    expect(seen.map(s => s.fields)).toEqual([
      { case_stage: 'Filed' },
      { case_number: '24-1' },
      { pipeline_phase: 'case' },
    ]);
  });

  test('a relate change crosses windows — the case open elsewhere hears it', async () => {
    const a = mkWindow();
    const b = mkWindow();
    const seenB = [];
    b.YC.on('case:AAAA', '*', (f, m) => seenB.push({ addr: m.addr, fields: f }));
    a.YC._sniff('PATCH', '/api/cases/AAAA/contacts/1001', { status: 'success' });
    await settle();
    expect(seenB).toEqual([{ addr: 'case:AAAA', fields: { yc_refetch: 1 } }]);
  });
});

// ─────────────────────────────────────────────────────────────
// _sniff — booking link (Slice 3c)
//
// One of the few writes that can honestly carry its own change: contact_token
// IS the column and the response IS the written value, so a contact file merges
// it with no refetch at all.
// ─────────────────────────────────────────────────────────────

describe('_sniff — booking-link matcher', () => {
  function spy(w) {
    const seen = [];
    w.YC.on('contact:*', '*', (f, m) => seen.push({ addr: m.addr, fields: f }));
    return seen;
  }

  test('a minted token announces the REAL VALUE, not a marker', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contacts/1001/booking-link',
                { success: true, token: 'deadbeefcafe' });
    expect(seen).toEqual([{
      addr: 'contact:1001',
      fields: { contact_token: 'deadbeefcafe' },
    }]);
  });

  test('FAILS CLOSED on a missing, empty or non-string token', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true });
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true, token: '' });
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true, token: null });
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true, token: 123 });
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', null);
    expect(seen).toEqual([]);
  });

  test('POST-only, and the anchored contacts matcher does not swallow the path', () => {
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('PATCH', '/api/contacts/1001/booking-link', { success: true, token: 'x' });
    w.YC._sniff('GET',   '/api/contacts/1001/booking-link', { success: true, token: 'x' });
    expect(seen).toEqual([]);
    // And the bare contacts matcher still owns its own path, unchanged.
    w.YC._sniff('PATCH', '/api/contacts/1001', { data: { changes: { contact_fname: 'A' } } });
    expect(seen).toEqual([{ addr: 'contact:1001', fields: { contact_fname: 'A' } }]);
  });

  test('MINT AND RETURN ARE INDISTINGUISHABLE — accepted, pinned', () => {
    // All three success branches of the route return the same
    // {success:true, token}: already had one, minted one, lost the mint race
    // and re-read the winner's. A get-or-mint that WROTE NOTHING therefore
    // announces too. Harmless by idempotence — a contact file merges a value it
    // already holds — but it does cost the shell's Contacts tab a wildcard
    // refetch. If this ever needs fixing, fix it at the ROUTE (echo a `minted`
    // flag); a getter cannot tell them apart, and this test says so.
    const w = mkWindow();
    const seen = spy(w);
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true, token: 'same' });
    w.YC._sniff('POST', '/api/contacts/1001/booking-link', { success: true, token: 'same' });
    expect(seen.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// _sniff — the method gate after Slice 3c
// ─────────────────────────────────────────────────────────────

describe('_sniff — method gate', () => {
  test('GET and HEAD never reach a matcher — this is what makes §3.6 structural', () => {
    const w = mkWindow();
    const seen = [];
    ['case:*', 'contact:*', 'setting:*', 'appt:*', 'event:*'].forEach(a =>
      w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      w.YC._sniff(m, '/api/cases/AAAA',                  { data: { changes: { a: 1 } } });
      w.YC._sniff(m, '/api/cases/AAAA/contacts/1',       { status: 'success' });
      w.YC._sniff(m, '/api/contacts/1/booking-link',     { success: true, token: 't' });
    }
    expect(seen).toEqual([]);
  });

  test('DELETE now passes the GATE and is stopped only by per-matcher verb lists', () => {
    // The distinction matters: before 3c the gate was the whole defence, and
    // widening it would have opened every matcher that omitted a verb list.
    // Every matcher names its verbs now, so the gate can admit DELETE without
    // admitting it anywhere it is not wanted.
    const w = mkWindow();
    const seen = [];
    ['case:*', 'contact:*', 'setting:*'].forEach(a => w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    w.YC._sniff('DELETE', '/api/cases/AAAA',            { data: { changes: { case_stage: 'Filed' } } });
    w.YC._sniff('DELETE', '/api/contacts/5',            { data: { changes: { contact_fname: 'B' } } });
    w.YC._sniff('DELETE', '/api/cases/AAAA/docket',     { changes: { case_number: '24-1' } });
    w.YC._sniff('DELETE', '/api/app-settings/fe-x',     { setting: { key: 'fe-x', value: 'v' } });
    expect(seen).toEqual([]);
    // …and the one path that DOES want it.
    w.YC._sniff('DELETE', '/api/cases/AAAA/contacts/1', { status: 'success' });
    expect(seen).toEqual(['case:AAAA']);
  });

  test('A VERB MISS CONTINUES THE SCAN, it does not end it', () => {
    /* LOW-2. `_sniff` used to `return` when a matcher matched the path but
       rejected the verb, which quietly made the FIRST path-match authoritative
       for every verb. Inert today — no two matchers share a path, so the scan
       finds nothing either way — and that is exactly why it was safe to change
       now rather than on the day two matchers do share one and the first
       silently eats the second's traffic.

       Observable proof that the loop keeps going: a verb-rejected match must
       not stop a LATER matcher from being reached in the same call. The two
       app-settings matchers are the closest thing the table has to overlapping
       paths — `POST /api/app-settings` is rejected by the PUT-only per-key
       matcher's sibling ordering — so this asserts the general property
       instead: every matcher is still reachable for its own verb after a
       neighbour has rejected one. */
    const w = mkWindow();
    const seen = [];
    ['setting:*', 'appt:*', 'case:*'].forEach(a => w.YC.on(a, '*', (f, m) => seen.push(m.addr)));
    // PATCH on the PUT-only per-key settings matcher: rejected, scan continues,
    // nothing else matches → silence, no throw.
    w.YC._sniff('PATCH', '/api/app-settings/fe-x', { setting: { key: 'fe-x', value: 'v' } });
    expect(seen).toEqual([]);
    // The very next call on the same window still reaches every other matcher.
    w.YC._sniff('PUT',   '/api/app-settings/fe-x', { setting: { key: 'fe-x', value: 'v' } });
    w.YC._sniff('PATCH', '/api/appts/55',          { status: 'success' });
    w.YC._sniff('POST',  '/api/cases/AAAA/contacts', { status: 'success' });
    expect(seen).toEqual(['setting:fe-x', 'appt:55', 'case:AAAA']);
  });
});

// ─────────────────────────────────────────────────────────────
// The auto-emit circuit breaker (Slice 3c)
//
// WHY IT EXISTS, since the code it defends against is not in this repo:
//
// A form's per-form `code` hook lives in the DATABASE. Those hooks run inside
// YCForm.refresh(), which runs inside a bus-triggered form push — so a hook that
// WRITES is a handler that emits, one indirection away from §3.6, and no amount
// of reading public/ can prove none does. An idempotent hook-write terminates by
// itself (the second identical PATCH diffs empty and `emit` drops it); a
// value-varying one — a timestamp, a counter, a re-derive that never settles —
// would not.
//
// The breaker caps that and any future loop of any shape. It is deliberately on
// the SNIFF path only: YC.emit call sites are hand-placed and auditable.
// ─────────────────────────────────────────────────────────────

describe('auto-emit circuit breaker', () => {
  /** Sniff a matched PATCH n times against one case, collecting emits + warns. */
  function hammer(w, n, addr = 'AAAA') {
    for (let i = 0; i < n; i++) {
      // A CHANGING value each time — the pathological shape. An unchanging one
      // would be dropped by emit's empty-changes guard and never reach here.
      w.YC._sniff('PATCH', `/api/cases/${addr}`,
                  { data: { changes: { case_status: 'v' + i } } });
    }
  }

  function watch(w) {
    const seen = [];
    const warns = [];
    w.YC.on('case:*', '*', (f, m) => seen.push(m.addr));
    w.console.warn = (...a) => warns.push(a.join(' '));
    return { seen, warns };
  }

  test('EIGHT get through, the ninth is dropped, and it warns once', () => {
    const w = mkWindow();
    const { seen, warns } = watch(w);
    hammer(w, 9);
    expect(seen.length).toBe(8);
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/case:AAAA/);
    expect(warns[0]).toMatch(/rate limit/i);
  });

  test('it keeps dropping past the threshold, and does NOT keep warning', () => {
    // One warn per address per window. A loop firing hundreds of times a second
    // must not turn the console into the second problem.
    const w = mkWindow();
    const { seen, warns } = watch(w);
    hammer(w, 40);
    expect(seen.length).toBe(8);
    expect(warns.length).toBe(1);
  });

  test('IT IS PER-ADDRESS — a different case in the same window is untouched', () => {
    // The whole reason it is keyed on the address: a bulk action announcing
    // fifty different cases is legitimate traffic and must not be capped.
    const w = mkWindow();
    const { seen } = watch(w);
    hammer(w, 12, 'AAAA');          // trips
    hammer(w, 3,  'BBBB');          // well under
    expect(seen.filter(a => a === 'case:AAAA').length).toBe(8);
    expect(seen.filter(a => a === 'case:BBBB').length).toBe(3);
  });

  test('THE WINDOW EXPIRES — a tripped address recovers, and warns again', () => {
    // Real time is not available here (the window is 4s), so the clock is moved
    // instead. THE STUB MUST GO ON THE JSDOM WINDOW: yc-sync is evaluated inside
    // `w`, so its `Date.now` resolves against `w.Date`, not Node's. Stubbing
    // Node's global does nothing and the test passes vacuously in the wrong
    // direction — it was written that way first and this comment is the scar.
    const w = mkWindow();
    const { seen, warns } = watch(w);
    const realNow = w.Date.now;
    let t = realNow();
    w.Date.now = () => t;
    try {
      hammer(w, 9);
      expect(seen.length).toBe(8);
      expect(warns.length).toBe(1);

      t += 5000;                    // past BREAKER_WINDOW_MS
      hammer(w, 9);
      expect(seen.length).toBe(16); // eight more got through
      expect(warns.length).toBe(2); // and the second trip warns again
    } finally {
      w.Date.now = realNow;
    }
  });

  test('EXPLICIT YC.emit IS EXEMPT — hand-placed call sites are auditable', () => {
    // checklistView.saveBody is the one explicit emitter in the system. Capping
    // it would mean a user who edits one note nine times in four seconds stops
    // syncing, which is a real thing a fast typist with autosave can do.
    const w = mkWindow();
    const { seen, warns } = watch(w);
    for (let i = 0; i < 30; i++) {
      w.YC.emit('case:AAAA', { case_notes: 'draft ' + i }, 'checklistView:saveBody');
    }
    expect(seen.length).toBe(30);
    expect(warns).toEqual([]);
  });

  test('an emit the breaker DROPPED does not reach the log either', () => {
    // _log is the traceability answer; a dropped message never happened, so it
    // must not appear there and imply that it did.
    const w = mkWindow();
    watch(w);
    hammer(w, 20);
    expect(w.YC._log.filter(m => m.addr === 'case:AAAA').length).toBe(8);
  });

  test('EMPTY-CHANGES CALLS DO NOT SPEND THE BUDGET', () => {
    // A matcher that keeps announcing nothing must not exhaust the allowance a
    // real message would need. The empty check runs before the breaker sees the
    // address.
    const w = mkWindow();
    const { seen, warns } = watch(w);
    for (let i = 0; i < 20; i++) {
      w.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: {} } });
    }
    expect(seen).toEqual([]);
    hammer(w, 8);                   // the full allowance is still there
    expect(seen.length).toBe(8);
    expect(warns).toEqual([]);
  });

  test('the breaker does not leak across windows', async () => {
    // Per-frame state. Two browser tabs each get their own budget, which is
    // correct: the loop this defends against is per-frame.
    const a = mkWindow();
    const b = mkWindow();
    a.console.warn = () => {};
    b.console.warn = () => {};
    const seenB = [];
    b.YC.on('case:*', '*', (f, m) => seenB.push(m.addr));
    for (let i = 0; i < 20; i++) {
      a.YC._sniff('PATCH', '/api/cases/AAAA', { data: { changes: { case_status: 'v' + i } } });
    }
    await settle();                 // BroadcastChannel delivery is async
    // b heard a's first eight over the wire — the cap applied at the SENDER…
    expect(seenB.filter(x => x === 'case:AAAA').length).toBe(8);
    // …and b's OWN budget is untouched.
    for (let i = 0; i < 8; i++) {
      b.YC._sniff('PATCH', '/api/cases/BBBB', { data: { changes: { case_status: 'x' + i } } });
    }
    expect(seenB.filter(x => x === 'case:BBBB').length).toBe(8);
  });
});
