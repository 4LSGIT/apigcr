// tests/configReadOnly.test.js
//
/**
 * Settings arc §3b — the Config read-only handshake, sub-page side. The four
 * vocabulary sub-pages (public/caseconfig/types.html, pipelines.html,
 * fields.html, calendarTypes.html) run for REAL in a jsdom frame: their own
 * markup and whole inline script, under a parent window that plays the
 * Config shell's part of the protocol (apiSend, setTopbarButtons, the
 * configCanEdit getter) and an in-memory backend that answers the GETs with
 * fixtures and records every call. fields.html gets the real
 * public/js/yc-custom-fields.js (its show_when builder needs it). SweetAlert2
 * (a CDN library, not the module under test) is a stub that renders a
 * dialog's html into the page, runs didOpen, then auto-CONFIRMS — a user who
 * clicks OK on everything — unless the dialog has no confirm button.
 *
 * Locks, per page:
 *   · read-only at init from P.configCanEdit (anything but === true), and
 *     editable at init when it is true — no onAccess needed;
 *   · onAccess({ canEdit }) re-applies it both ways;
 *   · read-only: every write control (an inventory per page, by its handler)
 *     is hidden, every form control the page draws is disabled, viewing and
 *     navigation still work, the detail dialogs open to LOOK (no confirm,
 *     inputs disabled);
 *   · THE SWEEP: dispatch a click / input / change on EVERY rendered control
 *     — hidden and disabled ones included, and every button inside every
 *     dialog that opens — and no POST / PUT / PATCH / DELETE reaches apiSend.
 *     The same sweep with canEdit true does reach the writes (it proves the
 *     sweep exercises the write paths at all).
 *
 * Mutation-checked (see the W5 worker report).
 *
 * Run:  npx jest tests/configReadOnly.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGES = {
  types: read('public/caseconfig/types.html'),
  pipelines: read('public/caseconfig/pipelines.html'),
  fields: read('public/caseconfig/fields.html'),
  calendarTypes: read('public/caseconfig/calendarTypes.html'),
};
const YCCF_SRC = read('public/js/yc-custom-fields.js');

// setImmediate turns, not setTimeout(0): every flow here is promise-driven
// against an immediate backend, and the 1 ms timer clamp × the sweeps' many
// turns would cost seconds per test.
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const isWrite = (c) => !/^(GET|HEAD)$/i.test(c.method || 'GET');

// ── SweetAlert2 stand-in (runs in the frame's realm) ───────────────────────
const SWAL_STUB = `
window.__swal = []; window.__toasts = []; window.__validation = [];
window.Swal = (function () {
  var stack = [];
  var n = 0;
  async function fire(a, b, c) {
    var opts = typeof a === 'string' ? { title: a, html: b, icon: c } : (a || {});
    var rec = { opts: opts };
    window.__swal.push(rec);
    var box = document.createElement('div');
    box.className = 'swal-stub';
    box.innerHTML = opts.html || '';
    document.body.appendChild(box);
    stack.push(box);
    try {
      if (opts.didOpen) opts.didOpen(box);
      rec.controls = Array.prototype.map.call(box.querySelectorAll('input, select, textarea'), function (el) { return el.disabled; });
      if (window.__swalHook) await window.__swalHook(box, opts);
      if (opts.showConfirmButton === false) return { isConfirmed: false, isDenied: false, isDismissed: true };
      var value = opts.input === 'checkbox' ? 1 : (opts.input ? 'Auto ' + (++n) : true);
      if (opts.preConfirm) {
        var v = await opts.preConfirm();
        if (v === false) return { isConfirmed: false, isDenied: false, isDismissed: true };
        value = v;
      }
      return { isConfirmed: true, isDenied: false, value: value };
    } finally {
      box.remove();
      stack.splice(stack.indexOf(box), 1);
    }
  }
  return {
    fire: fire,
    mixin: function () { return { fire: function (o) { window.__toasts.push(o); return Promise.resolve({}); } }; },
    getHtmlContainer: function () { return stack[stack.length - 1] || null; },
    showValidationMessage: function (m) { window.__validation.push(m); },
    close: function () {},
  };
})();
`;

/** The page as shipped, with the CDN / theme tags dropped and the two
 *  scripts the page needs supplied inline (the stub; the real renderer). */
function pageHtml(name) {
  return PAGES[name]
    .replace('<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>', `<script>${SWAL_STUB}</script>`)
    .replace('<script src="/js/yc-custom-fields.js"></script>', `<script>${YCCF_SRC}</script>`)
    .replace(/<script src=[^>]*><\/script>/g, '')
    .replace(/<link [^>]*>/g, '');
}

// ── Fixtures + the in-memory backend ───────────────────────────────────────
const CASE_TYPES = { Bankruptcy: ['Chapter 7', 'Chapter 13'], Civil: [] };
const STAGE = (id, n, extra = {}) => ({ id, stage_number: n, stage_key: `stage_${id}`, internal_label: `Stage ${id}`, client_label: `Client ${id}`,
  case_stage: 'Open', lane: 'main', client_visible: 1, is_terminal: 0, active: 1, log_count: 0, req_count: 0, default_rec: 'Call them', config: null, ...extra });
const TEMPLATE = { id: 1, name: 'Chapter 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', is_default: 1, active: 1,
  description: 'BK', stage_count: 2, log_count: 0 };
const REQ = { id: 101, sort_order: 1, requirement_key: 'retainer', internal_label: 'Retainer', client_label: 'Sign the retainer', group_label: '',
  owner: 'client', kind: 'task', hint: 'Last 60 days', effort: '~5 min', detector: 'manual', detector_config: null, client_visible: 1, required: 1, active: 1, override_count: 0 };
const DEFS = [
  { id: 1, field_key: 'cf_color', label: 'Color', field_type: 'select', indexed: 1, sort_order: 0, active: 1,
    options: [{ value: 'red', label: 'Red', active: true }, { value: 'blue', label: 'Blue', active: true }],
    validation: { required: true }, show_when: { field: 'case_type', op: 'eq', value: 'Bankruptcy' }, default_value: 'red' },
  { id: 2, field_key: 'cf_note', label: 'Note', field_type: 'text', indexed: 0, sort_order: 1, active: 1,
    options: null, validation: { max_len: 10 }, show_when: null, default_value: 'hi' },
];
const CAL_TYPES = [
  { type_key: 'consult', label: 'Consult', kind: 'meeting', singleton: 0, blocks_default: 'attendee', client_attends: 1, default_length: 30,
    approaching_offsets: [1], ingest_aliases: ['consultation'], case_types: ['Bankruptcy'], active: 1, sort_order: 10,
    options: [{ id: 5, length: 30, label: null, surfaces: ['new_client', 'follow_up'], sort_order: 10, active: 1 }],
    refs: { total: 0, events: 0, appts: 0, booking_views: 0, ai_match_types: 0 } },
  { type_key: 'hearing_341', label: '341 Meeting', kind: 'hearing', singleton: 1, blocks_default: 'firm', client_attends: 1, default_length: null,
    approaching_offsets: null, ingest_aliases: [], case_types: null, active: 1, sort_order: 20, options: [],
    refs: { total: 3, events: 3, appts: 0, booking_views: 0, ai_match_types: 0 } },
];

function makeBackend() {
  const calls = [];
  const GET = {
    '/api/app-settings': () => ({ status: 'success', settings: [{ key: 'fe-case_types', value: JSON.stringify(CASE_TYPES) }] }),
    '/api/pipeline-admin/usage': () => ({ cases: 0, templates: 0 }),
    '/api/pipeline-admin/templates': () => ({ templates: [clone(TEMPLATE)] }),
    '/api/pipeline-admin/templates/1/stages': () => ({ template: clone(TEMPLATE), stages: [STAGE(11, 1, { req_count: 1 }), STAGE(12, 2, { lane: 'offramp' })] }),
    '/api/pipeline-admin/detectors': () => ({ detectors: [{ key: 'manual', label: 'Manual', config_hint: '' }] }),
    '/api/pipeline-admin/stages/11/requirements': () => ({ requirements: [clone(REQ), { ...clone(REQ), id: 102, sort_order: 2, requirement_key: 'paystubs', internal_label: 'Paystubs' }] }),
    '/api/field-defs': () => ({ defs: clone(DEFS) }),
    '/api/field-defs/usage': () => ({ usage: { cf_color: 0, cf_note: 0 } }),
    '/api/calendar-types-admin': () => ({ types: clone(CAL_TYPES) }),
    '/api/calendar-types-admin/case-types': () => ({ case_types: [{ case_type: 'Bankruptcy', cases: 3 }, { case_type: 'Civil', cases: 1 }] }),
    '/api/calendar-types-admin/unmapped': () => ({ events: [{ id: 7, label: 'Mediation', date: '2026-01-02' }], appts: [], no_label: { events: 0, appts: 0 } }),
    '/api/calendar-types-admin/consult': () => ({ type: clone(CAL_TYPES[0]) }),
  };
  async function api(endpoint, method = 'GET', payload = null) {
    calls.push({ endpoint, method, payload: payload == null ? null : clone(payload) });
    const p = String(endpoint).split('?')[0];
    if (/^(GET|HEAD)$/i.test(method)) {
      if (GET[p]) return GET[p]();
      return {};
    }
    // A write: the server takes it. (The page's own handling of the answer is
    // not under test here — only whether the write reached apiSend.) The
    // reorders answer what the page renders from, as the real routes do.
    if (/\/stages\/reorder$/.test(p)) return GET['/api/pipeline-admin/templates/1/stages']();
    if (/\/requirements\/reorder$/.test(p)) return GET['/api/pipeline-admin/stages/11/requirements']();
    return { status: 'success', template: clone(TEMPLATE), total: 0, events: 0, appts: 0, field_key: 'cf_x' };
  }
  return { api, calls, writes: () => calls.filter(isWrite) };
}

// ── The frame ──────────────────────────────────────────────────────────────
async function bootPage(name, { canEdit = false } = {}) {
  const vc = new VirtualConsole();   // quiet: the pages log their (expected) refusals
  const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: vc }).window;
  const backend = makeBackend();
  const state = { canEdit };
  const topbar = [];
  top.apiSend = backend.api;
  top.setTopbarButtons = (b) => topbar.push(b);
  Object.defineProperty(top, 'configCanEdit', { get: () => state.canEdit, configurable: true });
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  await flush(5);
  const w = f.contentWindow;
  w.confirm = () => true;
  const doc = w.document;
  doc.open(); doc.write(pageHtml(name)); doc.close();
  await flush();
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);
  const $$ = (sel) => [...d.querySelectorAll(sel)].filter((el) => !el.closest('.swal-stub'));
  return { top, w, d, $, $$, backend, state, topbar };
}

/** Rendered and not hidden by any ancestor (computed display, [hidden]). */
function shown(w, el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden || w.getComputedStyle(e).display === 'none') return false;
  }
  return true;
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (w, el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));

/** Drive one control the way a person would, disabled or hidden or not. */
function act(w, el) {
  const tag = el.tagName;
  if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    el.checked = !el.checked; fire(w, el, 'input'); fire(w, el, 'change');
  } else if (tag === 'SELECT') {
    const other = [...el.options].find((o) => !o.selected);
    if (other) { other.selected = true; if (!el.multiple) el.value = other.value; }
    fire(w, el, 'input'); fire(w, el, 'change');
  } else if (tag === 'TEXTAREA') {
    el.value = '';                                  // blank = valid for every JSON / list box here
    fire(w, el, 'input'); fire(w, el, 'change');
  } else if (tag === 'INPUT') {
    // 'abc' passes every key regex the pages check client-side, so a confirmed
    // dialog really sends its write.
    el.value = el.type === 'number' ? '7' : el.type === 'date' ? '2026-01-02' : 'abc';
    fire(w, el, 'input'); fire(w, el, 'change');
  } else {
    click(w, el);
  }
}

/** A stable identity for a control across re-renders. */
function keyOf(el) {
  const a = ['id', 'onclick', 'onchange', 'oninput', 'type', 'placeholder', 'title']
    .map((k) => `${k}=${el.getAttribute(k) || ''}`);
  for (const at of el.attributes) if (at.name.startsWith('data-')) a.push(`${at.name}=${at.value}`);
  return `${el.tagName}|${a.join('|')}`;
}

const SWEEP_SEL = 'button, a, [onclick], [onchange], [oninput], input, select, textarea, .drag-handle';

/** Let an action run to its end: every dialog it opened closed, then quiet. */
async function settle(w) {
  await flush();
  for (let i = 0; i < 200 && w.document.querySelector('.swal-stub'); i++) await flush(5);
  await flush();
}

/**
 * THE SWEEP. Every control the page draws (after `prepare` has opened every
 * view there is), driven one by one. A control the last action took away (a
 * local-only edit — say a hidden "remove option" — re-rendered without it)
 * is found again after the page's own Refresh + `prepare`. Inside every
 * dialog that opens, every control is driven too (re-queried by position: a
 * dialog may re-render after each of its own writes). `skip` = navigation-
 * only controls that would collapse the views (only GETs; the viewing tests
 * drive them).
 */
async function sweep(t, { prepare = async () => {}, skip = () => false, reset: pageReset = null } = {}) {
  const { w } = t;
  const CTRL = 'button, input, select, textarea';
  w.__swalHook = async (box) => {
    const n = box.querySelectorAll(CTRL).length;
    for (let i = 0; i < n; i++) {
      const el = box.querySelectorAll(CTRL)[i];
      if (!el) break;
      act(w, el);
      await flush(5);
    }
  };
  const reset = async () => {
    if (pageReset) await pageReset();
    else if (typeof w.onRefresh === 'function') { w.onRefresh(); await flush(); }
    await prepare();
  };
  await prepare();
  const keys = [];
  const seen = {};
  for (const el of t.$$(SWEEP_SEL)) {
    const k = keyOf(el);
    seen[k] = (seen[k] || 0) + 1;
    if (!skip(el)) keys.push([k, seen[k] - 1]);
  }
  const missed = [];
  for (const [k, nth] of keys) {
    let el = t.$$(SWEEP_SEL).filter((e) => keyOf(e) === k)[nth];
    if (!el) { await reset(); el = t.$$(SWEEP_SEL).filter((e) => keyOf(e) === k)[nth]; }
    if (!el) { missed.push(k); continue; }
    act(w, el);
    await settle(w);
  }
  w.__swalHook = null;
  return { driven: keys.length - missed.length, missed };
}

const writesOf = (t) => t.backend.writes().map((c) => `${c.method.toUpperCase()} ${c.endpoint.split('?')[0]}`);

// ═══════════════════════════════════════════════════════════════════════════
// Per-page inventories: the controls that WRITE (by their handler), the form
// controls that must be disabled, the ones that must keep working. An entry
// is a CSS selector, or startsWith(attr, prefix) — jsdom's selector engine
// mis-reads ^= / $= values that contain parentheses.
// ═══════════════════════════════════════════════════════════════════════════
const startsWith = (attr, prefix, not) => (t) => t.$$(`[${attr}]`)
  .filter((el) => el.getAttribute(attr).startsWith(prefix) && !(not && el.getAttribute(attr).includes(not)));
const pick = (t, s) => (typeof s === 'function' ? s(t) : t.$$(s));

const PAGE_SPECS = {
  types: {
    writeSel: ['[onclick^="addType"]', '[onclick^="renameType"]', '[onclick^="moveType"]', '[onclick^="deleteType"]',
      '[onclick^="addSub"]', '[onclick^="renameSub"]', '[onclick^="moveSub"]', '[onclick^="deleteSub"]'],
    inputSel: [],
    // 2 types → rename/up/down/delete each; 2 subs → rename/up/down/delete each; + Subtype × 2; New Type
    minWrite: 2 * 4 + 2 * 4 + 2 + 1,
    expectWrites: ['PUT /api/app-settings/fe-case_types'],
    prepare: async () => {},
    skip: () => false,
  },
  pipelines: {
    writeSel: ['[onclick^="newTemplate"]', '[onclick^="editTemplate"]', '[onclick^="deleteTemplate"]', '[onclick="stageDialog(null)"]',
      '[onclick^="nudgeStage"]', '[onclick^="deleteStage"]', '.drag-handle', '[onclick="reqDialog(11, null)"]',
      '[onclick^="nudgeReq"]', '[onclick^="deleteReq"]'],
    inputSel: ['[onchange^="toggleStageActive"]', '[onchange^="toggleReqActive"]'],
    viewSel: ['.tpl-item', '[onclick^="toggleReqs"]', startsWith('onclick', 'stageDialog(1'), startsWith('onclick', 'reqDialog(11, 1')],
    minWrite: 1 + 3 + 2 * 4 + 1 + 2 * 3,
    expectWrites: ['PUT /api/pipeline-admin/stages/11', 'POST /api/pipeline-admin/templates/1/stages/reorder',
      'DELETE /api/pipeline-admin/stages/11', 'PUT /api/pipeline-admin/requirements/101', 'DELETE /api/pipeline-admin/requirements/101',
      'POST /api/pipeline-admin/stages/11/requirements/reorder', 'PUT /api/pipeline-admin/templates/1', 'DELETE /api/pipeline-admin/templates/1'],
    prepare: async (t) => {
      if (!t.$('#stage-tbody')) { click(t.w, t.$('.tpl-item')); await flush(); }
      if (!t.$('table.reqs')) {
        if (t.$('tr.req-sub')) { click(t.w, t.$('[onclick="toggleReqs(11)"]')); await flush(); }   // open on another state: close first
        click(t.w, t.$('[onclick="toggleReqs(11)"]')); await flush();
      }
    },
    skip: (el) => el.matches('.tpl-item, [onclick^="toggleReqs"]'),
  },
  fields: {
    writeSel: ['[onclick^="onNew"]', '#addCard', '[data-cf-drag]', '[data-cf-up]', '[data-cf-down]', '[data-cf-act]', '[data-cf-save]',
      '[data-cf-oretire]', '[data-cf-oup]', '[data-cf-odown]', '[data-cf-odel]', '[data-cf-oadd]'],
    inputSel: ['[data-cf-label]:not([data-cf-label="n"])', '#cfList [data-cf-type]', '[data-cf-ov]', '[data-cf-ol]', '#cfList [data-cf-v]',
      '#cfList [data-cf-dv]', '#cfList [data-cf-sw]'],
    viewSel: ['[data-cf-toggle]', '[data-cf-entity="contact"]'],
    minWrite: 2 + 2 * 5 + 2 * 4 + 1,
    expectWrites: ['PATCH /api/field-defs/1', 'PATCH /api/field-defs/2', 'POST /api/field-defs/1/deactivate', 'POST /api/field-defs'],
    prepare: async (t) => {
      for (const b of t.$$('[data-cf-toggle]')) {
        if (b.textContent !== 'Hide') { click(t.w, b); await flush(5); }
      }
    },
    // the Add card keeps its draft across a Refresh; an entity round trip
    // starts it over (the page's own reset)
    reset: async (t) => {
      click(t.w, t.$('[data-cf-entity="contact"]')); await flush();
      click(t.w, t.$('[data-cf-entity="case"]')); await flush();
    },
    skip: (el) => el.matches('[data-cf-toggle], [data-cf-entity]'),
  },
  calendarTypes: {
    writeSel: ['[onclick="openEditor(null)"]'],
    inputSel: ['[onchange^="toggleActive"]'],
    viewSel: ['#f-kind', '#f-inactive', 'tr[onclick^="openEditor"]', '.opt-link', '#unmapped-line a'],
    minWrite: 1,
    expectWrites: ['PUT /api/calendar-types-admin/consult', 'PUT /api/calendar-types-admin/options/5', 'DELETE /api/calendar-types-admin/options/5',
      'POST /api/calendar-types-admin/consult/options', 'POST /api/calendar-types-admin', 'POST /api/calendar-types-admin/abc/adopt-unmapped'],
    prepare: async () => {},
    skip: (el) => el.matches('#f-kind, #f-inactive'),      // the filters: navigation (the viewing test drives them)
  },
};

const writeControls = (t, spec) => spec.writeSel.flatMap((s) => pick(t, s));
const formControls = (t, spec) => spec.inputSel.flatMap((s) => pick(t, s));

// ═══════════════════════════════════════════════════════════════════════════
describe.each(Object.keys(PAGE_SPECS))('%s.html — the read-only handshake', (name) => {
  const spec = PAGE_SPECS[name];

  test('read-only at init for every answer but true (no onAccess): write controls hidden, form controls disabled', async () => {
    for (const canEdit of [false, null, undefined, 'true', 1]) {
      const t = await bootPage(name, { canEdit });
      await spec.prepare(t);
      expect([canEdit, t.d.body.classList.contains('cc-ro')]).toEqual([canEdit, true]);
      const wc = writeControls(t, spec);
      expect(wc.length).toBeGreaterThanOrEqual(spec.minWrite);
      expect(wc.filter((el) => shown(t.w, el)).map(keyOf)).toEqual([]);
      const fc = formControls(t, spec);
      if (spec.inputSel.length) expect(fc.length).toBeGreaterThan(0);
      expect(fc.filter((el) => !el.disabled).map(keyOf)).toEqual([]);
      for (const s of spec.viewSel || []) expect([String(s), pick(t, s).some((el) => shown(t.w, el))]).toEqual([String(s), true]);
      t.top.close();
    }
  });

  test('editable at init when P.configCanEdit === true (no onAccess): write controls shown, form controls enabled', async () => {
    const t = await bootPage(name, { canEdit: true });
    await spec.prepare(t);
    expect(t.d.body.classList.contains('cc-ro')).toBe(false);
    const wc = writeControls(t, spec);
    expect(wc.length).toBeGreaterThanOrEqual(spec.minWrite);
    expect(wc.filter((el) => !shown(t.w, el)).map(keyOf)).toEqual([]);
    expect(formControls(t, spec).filter((el) => el.disabled).map(keyOf)).toEqual([]);
    t.top.close();
  });

  test('onAccess re-applies it both ways (true → editable, then false / missing / "true" → read-only)', async () => {
    const t = await bootPage(name, { canEdit: null });
    await spec.prepare(t);
    expect(typeof t.w.onAccess).toBe('function');
    t.w.onAccess({ canEdit: true });
    await flush();
    await spec.prepare(t);
    expect(t.d.body.classList.contains('cc-ro')).toBe(false);
    expect(writeControls(t, spec).filter((el) => !shown(t.w, el)).map(keyOf)).toEqual([]);
    expect(formControls(t, spec).filter((el) => el.disabled).map(keyOf)).toEqual([]);
    for (const access of [{ canEdit: false }, undefined, { canEdit: 'true' }, {}]) {
      t.w.onAccess({ canEdit: true });
      await flush(5);
      t.w.onAccess(access);
      await flush();
      await spec.prepare(t);
      expect([access, t.d.body.classList.contains('cc-ro')]).toEqual([access, true]);
      expect(writeControls(t, spec).filter((el) => shown(t.w, el)).map(keyOf)).toEqual([]);
      expect(formControls(t, spec).filter((el) => !el.disabled).map(keyOf)).toEqual([]);
    }
    t.top.close();
  });

  test('THE SWEEP, read-only: every rendered control driven (hidden and disabled ones too, and inside every dialog) — no write reaches apiSend', async () => {
    const t = await bootPage(name, { canEdit: false });
    const r = await sweep(t, { prepare: () => spec.prepare(t), skip: spec.skip, reset: spec.reset && (() => spec.reset(t)) });
    expect(r.missed).toEqual([]);
    expect(r.driven).toBeGreaterThanOrEqual(spec.minWrite);
    expect(writesOf(t)).toEqual([]);
    expect(t.backend.calls.length).toBeGreaterThan(0);          // it did talk to the server: GETs only
    t.top.close();
  });

  test('THE SWEEP, editable: the same drive reaches the writes (so the read-only sweep exercises them)', async () => {
    const t = await bootPage(name, { canEdit: true });
    const r = await sweep(t, { prepare: () => spec.prepare(t), skip: spec.skip, reset: spec.reset && (() => spec.reset(t)) });
    expect(r.missed).toEqual([]);
    const got = new Set(writesOf(t));
    for (const want of spec.expectWrites) expect([want, got.has(want)]).toEqual([want, true]);
    t.top.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('viewing still works read-only', () => {
  test('types.html: the list renders — every type and subtype', async () => {
    const t = await bootPage('types');
    expect(t.$$('.type-name').map((e) => e.firstChild.textContent.trim())).toEqual(['Bankruptcy', 'Civil']);
    expect(t.$$('.sub-name').map((e) => e.textContent)).toEqual(['Chapter 7', 'Chapter 13']);
    t.top.close();
  });

  test('pipelines.html: select a template, open a stage\'s requirements, and VIEW a stage and a requirement (no confirm, inputs disabled)', async () => {
    const t = await bootPage('pipelines');
    await PAGE_SPECS.pipelines.prepare(t);
    expect(t.$$('#stage-tbody tr[data-stage-id]')).toHaveLength(2);
    expect(t.$$('table.reqs tbody tr')).toHaveLength(2);
    const view = t.$('[onclick="stageDialog(11)"]');
    expect([view.title, shown(t.w, view)]).toEqual(['View', true]);
    click(t.w, view);
    await flush();
    let rec = t.w.__swal[t.w.__swal.length - 1];
    expect(rec.opts.title).toBe('View stage "stage_11"');
    expect([rec.opts.showConfirmButton, rec.opts.cancelButtonText]).toEqual([false, 'Close']);
    expect(rec.controls.length).toBeGreaterThan(5);
    expect(rec.controls.every(Boolean)).toBe(true);
    click(t.w, t.$('[onclick="reqDialog(11, 101)"]'));
    await flush();
    rec = t.w.__swal[t.w.__swal.length - 1];
    expect(rec.opts.title).toBe('View requirement "retainer"');
    expect(rec.opts.showConfirmButton).toBe(false);
    expect(rec.controls.every(Boolean)).toBe(true);
    expect(writesOf(t)).toEqual([]);
    t.top.close();
  });

  test('pipelines.html editable: the same dialogs are editors (confirm shown, inputs enabled)', async () => {
    const t = await bootPage('pipelines', { canEdit: true });
    await PAGE_SPECS.pipelines.prepare(t);
    expect(t.$('[onclick="stageDialog(11)"]').title).toBe('Edit');
    t.w.__swalHook = async () => {};
    let rec;
    t.w.Swal.fire = ((orig) => async (o) => { rec = o; return { isConfirmed: false }; })(t.w.Swal.fire);
    click(t.w, t.$('[onclick="stageDialog(11)"]'));
    await flush();
    expect([rec.title, rec.showConfirmButton, rec.confirmButtonText]).toEqual(['Edit stage "stage_11"', undefined, 'Save']);
    t.top.close();
  });

  test('fields.html: a card opens to VIEW (its button reads View), its controls disabled; the entity tabs still switch', async () => {
    const t = await bootPage('fields');
    const tog = t.$$('[data-cf-toggle]');
    expect(tog.map((b) => b.textContent)).toEqual(['View', 'View']);
    click(t.w, tog[0]);
    await flush(5);
    expect(t.$('[data-cf-toggle="0"]').textContent).toBe('Hide');
    expect(t.$$('[data-cf-ov]').map((e) => [e.value, e.disabled])).toEqual([['red', true], ['blue', true]]);
    expect(t.$('[data-cf-sw="0:field"]').value).toBe('case_type');
    const before = t.backend.calls.length;
    click(t.w, t.$('[data-cf-entity="contact"]'));
    await flush();
    expect(t.backend.calls.slice(before).map((c) => [c.endpoint, c.method, c.payload])).toEqual([
      ['/api/field-defs', 'GET', { entity: 'contact' }], ['/api/field-defs/usage', 'GET', { entity: 'contact' }]]);
    expect(writesOf(t)).toEqual([]);
    t.top.close();
  });

  test('fields.html editable: the card button reads Edit', async () => {
    const t = await bootPage('fields', { canEdit: true });
    expect(t.$$('[data-cf-toggle]').map((b) => b.textContent)).toEqual(['Edit', 'Edit']);
    t.top.close();
  });

  test('calendarTypes.html: filters work; a row opens its details to VIEW; the picker options and the unmapped list open with their writes hidden', async () => {
    const t = await bootPage('calendarTypes');
    expect(t.$$('tbody tr[onclick^="openEditor"]')).toHaveLength(2);
    const kind = t.$('#f-kind');
    kind.value = 'hearing'; fire(t.w, kind, 'change');
    expect(t.$$('tbody tr[onclick^="openEditor"]')).toHaveLength(1);
    kind.value = ''; fire(t.w, kind, 'change');
    // the row → the editor, to look
    let html = null;
    t.w.__swalHook = async (box) => { html = box; };
    click(t.w, t.$('tr[onclick="openEditor(\'consult\')"]'));
    await flush();
    let rec = t.w.__swal[t.w.__swal.length - 1];
    expect(rec.opts.title).toBe('View Consult');
    expect([rec.opts.showConfirmButton, rec.opts.showDenyButton, rec.opts.cancelButtonText]).toEqual([false, false, 'Close']);
    expect(rec.controls.length).toBeGreaterThan(8);
    expect(rec.controls.every(Boolean)).toBe(true);
    // picker options: rows shown, every save / delete / add hidden
    let optShown = null;
    t.w.__swalHook = async (box) => {
      optShown = [...box.querySelectorAll('button[data-act]')].map((b) => [b.dataset.act, shown(t.w, b)]);
    };
    click(t.w, t.$('.opt-link'));
    await flush();
    rec = t.w.__swal[t.w.__swal.length - 1];
    expect(rec.opts.title).toBe('Picker options — Consult');
    expect(rec.controls.every(Boolean)).toBe(true);
    expect(optShown).toEqual([['save', false], ['del', false], ['add', false]]);
    // the unmapped list: shown; Mint hidden
    let mint = null;
    t.w.__swalHook = async (box) => { mint = [...box.querySelectorAll('[data-mint]')].map((b) => shown(t.w, b)); };
    click(t.w, t.$('#unmapped-line a'));
    await flush();
    expect(t.w.__swal[t.w.__swal.length - 1].opts.title).toBe('Unmapped types');
    expect(mint).toEqual([false]);
    expect(html).not.toBeNull();
    expect(writesOf(t)).toEqual([]);
    t.top.close();
  });

  test('calendarTypes.html editable: the row opens the editor (Save + Delete), its inputs enabled except the locked key', async () => {
    const t = await bootPage('calendarTypes', { canEdit: true });
    t.w.__swalHook = async () => {};
    click(t.w, t.$('tr[onclick="openEditor(\'consult\')"]'));
    await flush();
    const rec = t.w.__swal[t.w.__swal.length - 1];
    expect([rec.opts.title, rec.opts.showConfirmButton, rec.opts.showDenyButton]).toEqual(['Edit Consult', undefined, true]);
    expect(rec.controls.filter(Boolean)).toHaveLength(2);   // ed-key (permanent) + ed-kind (picker options exist)
    t.top.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the source idiom (one per page)', () => {
  test.each(Object.keys(PAGES))('%s.html: body starts read-only; api() is the one write gate; init reads P.configCanEdit; onAccess is exposed', (name) => {
    const src = PAGES[name];
    expect(src).toMatch(/<body class="cc-ro">/);
    expect(src).toMatch(/body\.cc-ro \.cc-w \{ display: none; \}/);
    expect(src.match(/const api = /g)).toHaveLength(1);
    expect(src.match(/P\.apiSend\(/g)).toHaveLength(1);                  // nothing bypasses api()
    expect(src).toMatch(/ccApplyAccess\(P\.configCanEdit\);/);
    expect(src).toMatch(/window\.onAccess = onAccess;/);
  });
});
