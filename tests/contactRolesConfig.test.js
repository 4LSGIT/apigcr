/**
 * @jest-environment node
 *
 * tests/contactRolesConfig.test.js — settings arc CFG-2: the Contact Roles
 * editor, moved from settings.html into YisraCase Config
 * (public/caseconfig/contactRoles.html).
 *
 * BOOTS the real page in jsdom, two frames deep as in the app: a fake Config
 * shell (top) speaking the sub-page protocol + the §3b read-only handshake
 * (apiSend, setTopbarButtons, the configCanEdit getter, onAccess), and the
 * page written into its iframe. Nothing in the page is stubbed. The backend
 * behind apiSend is the REAL services/contactRoleService (list / create /
 * update and its attrs_schema validator — so every error the page shows is
 * the server's own words) over an in-memory contact_role_types table that
 * stores attrs_schema the way MySQL's JSON column does: object keys
 * re-ordered on write (length, then bytes) and handed back parsed, as mysql2
 * returns a JSON column. Schemas are compared key-order-insensitively.
 *
 * WHAT IS LOCKED
 *   - Options and number identity: numbers stay numbers, numeric-looking
 *     strings and comma-carrying strings display as JSON and come back as
 *     strings, CSV parsing, the raw JSON-array escape hatch, bad JSON refused
 *     client-side with no write; an untouched load → save of every type
 *     sends back exactly what is stored.
 *   - Per-type saves: one PUT per Save click, to that type only, with the
 *     route's body shape; Save enabled only on a dirty card.
 *   - Create: the POST body, the reload, other cards' unsaved edits kept.
 *   - Validation errors from the route shown verbatim in the type's status
 *     line; the card stays dirty and saveable.
 *   - Read-only (§3b): configCanEdit false / null / missing → no write
 *     control rendered enabled, and dispatching input / click on every
 *     rendered control (the disabled ones included) reaches no write;
 *     viewing (Show fields) still works; onAccess flips it both ways.
 *   - Lifecycle: topbar request, Refresh / onShow dirty guards.
 *
 * Mutation-checked — see the settings-arc W6 worker report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const roleSvc = require('../services/contactRoleService');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public/caseconfig/contactRoles.html'), 'utf8');
// External scripts / sheets (CDN, themeSync) are not loaded in jsdom; drop them.
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const clone = (x) => JSON.parse(JSON.stringify(x));

const DOMS = [];
afterEach(() => {
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});

/** Key-order-insensitive canonical form (MySQL JSON re-orders object keys). */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
  return v;
}
/** What MySQL's JSON column stores: keys sorted by length, then by bytes. */
function mysqlJson(v) {
  if (Array.isArray(v)) return v.map(mysqlJson);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0))
      .reduce((o, k) => { o[k] = mysqlJson(v[k]); return o; }, {});
  }
  return v;
}

// The LIVE seeded schemas (tests/contactRoles.roleForms.test.js), plus types
// that exercise the ambiguous-display rule.
const TRUSTEE_SCHEMA = [
  { key: 'chapter',   type: 'multi_select', label: 'Chapters',      options: [7, 11, 12, 13], required: true },
  { key: 'zoom_link', type: 'url',          label: '341 Zoom link', required: false, placeholder: 'https://…zoom.us/j/…' },
];
const JUDGE_SCHEMA = [
  { key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true, placeholder: 'lsg' },
];
const COURT_SCHEMA = [   // numeric-looking STRINGS — must stay strings
  { key: 'room', type: 'select', label: 'Room', options: ['7', '11'] },
];
const VENUE_SCHEMA = [   // a comma inside an option, beside a number
  { key: 'venue', type: 'multi_select', label: 'Venue', options: ['Detroit, MI', 'Flint', 3] },
];
const SEED = [
  { role_code: 'trustee', label: 'Trustee', attrs_schema: TRUSTEE_SCHEMA, sort_order: 10, active: 1 },
  { role_code: 'judge',   label: 'Judge',   attrs_schema: JUDGE_SCHEMA,   sort_order: 20, active: 1 },
  { role_code: 'court',   label: 'Court',   attrs_schema: COURT_SCHEMA,   sort_order: 30, active: 1 },
  { role_code: 'venue',   label: 'Venue',   attrs_schema: VENUE_SCHEMA,   sort_order: 40, active: 0 },
  { role_code: 'mediator', label: 'Mediator', attrs_schema: null,         sort_order: 50, active: 1 },
];

// ── contact_role_types in memory, dispatched on SQL text ───────────────────
function makeDb(seed = SEED) {
  const rows = seed.map((r) => ({ ...r, attrs_schema: r.attrs_schema == null ? null : JSON.stringify(mysqlJson(r.attrs_schema)) }));
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT role_code, label, attrs_schema, sort_order, active FROM contact_role_types/.test(s)) {
      const all = /WHERE active = 1/.test(s) ? rows.filter((r) => r.active) : rows.slice();
      all.sort((a, b) => (a.sort_order - b.sort_order) || (a.role_code < b.role_code ? -1 : 1));
      // mysql2 hands a JSON column back parsed.
      return [all.map((r) => ({ ...r, attrs_schema: r.attrs_schema == null ? null : JSON.parse(r.attrs_schema) }))];
    }
    if (/^INSERT INTO contact_role_types \(role_code, label, attrs_schema, sort_order, active\) VALUES/.test(s)) {
      const [code, label, schema, sort, active] = params;
      if (rows.some((r) => r.role_code === code)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      rows.push({ role_code: code, label, attrs_schema: schema == null ? null : JSON.stringify(mysqlJson(JSON.parse(schema))), sort_order: sort, active });
      return [{ affectedRows: 1 }];
    }
    let m;
    if ((m = s.match(/^UPDATE contact_role_types SET (.+) WHERE role_code = \?$/))) {
      const cols = m[1].split(', ').map((c) => c.replace(' = ?', ''));
      const code = params[params.length - 1];
      const r = rows.find((x) => x.role_code === code);
      if (!r) return [{ affectedRows: 0 }];
      cols.forEach((c, i) => {
        r[c] = c === 'attrs_schema' && params[i] != null ? JSON.stringify(mysqlJson(JSON.parse(params[i]))) : params[i];
      });
      return [{ affectedRows: 1 }];
    }
    throw new Error('makeDb: unscripted query — ' + s);
  };
  const stored = (code) => {
    const r = rows.find((x) => x.role_code === code);
    return r && { ...r, attrs_schema: r.attrs_schema == null ? null : JSON.parse(r.attrs_schema) };
  };
  return { query, rows, stored };
}

function apiError(status, message) {
  const e = new Error(message);
  e.name = 'ApiError'; e.status = status; e.body = { status: 'error', message };
  return e;
}
/** routes/api.contactRoles.js's mapErrorStatus, for a realistic status. */
const statusOf = (msg) => (/not found/.test(msg) ? 404 : /already exists/.test(msg) ? 409 : 400);

/** The /api/contact-role-types routes over the REAL service. */
function makeBackend(db) {
  const calls = [];
  async function api(endpoint, method = 'GET', payload = null) {
    payload = payload == null ? null : clone(payload);   // over the wire it is JSON
    calls.push({ endpoint, method, payload });
    const [p, qs] = endpoint.split('?');
    try {
      if (method === 'GET' && p === '/api/contact-role-types') {
        const includeInactive = /include_inactive=true/.test(qs || '');
        return { status: 'success', ...(await roleSvc.listRoleTypes(db, { includeInactive })) };
      }
      if (method === 'POST' && p === '/api/contact-role-types') {
        return { status: 'success', ...(await roleSvc.createRoleType(db, payload)) };
      }
      const m = p.match(/^\/api\/contact-role-types\/([^/]+)$/);
      if (method === 'PUT' && m) {
        const code = decodeURIComponent(m[1]);
        const body = payload || {};
        if (body.role_code !== undefined && String(body.role_code).trim() !== code) {
          throw new Error('role_code is immutable — deactivate this type and create a new one instead');
        }
        return { status: 'success', ...(await roleSvc.updateRoleType(db, code, {
          label: body.label, sort_order: body.sort_order, active: body.active, attrs_schema: body.attrs_schema,
        })) };
      }
    } catch (e) {
      throw apiError(statusOf(e.message), e.message);
    }
    throw new Error(`unscripted ${method} ${endpoint}`);
  }
  return { api, calls };
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET');

/**
 * Boot: the fake shell (top) + the page in its iframe.
 * @param {object} o
 * @param {boolean|null|undefined} o.canEdit  what P.configCanEdit returns ('absent' = no getter at all)
 */
async function boot({ canEdit = true, seed = SEED } = {}) {
  const db = makeDb(seed);
  const backend = makeBackend(db);
  const vc = new VirtualConsole();
  const logs = [];
  ['warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(k + ': ' + a.join(' '))));
  vc.on('jsdomError', (e) => logs.push('jsdomError: ' + (e && e.message)));
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: vc });
  DOMS.push(dom);
  const top = dom.window;
  const topbar = [];
  const access = { canEdit };
  top.apiSend = backend.api;
  top.setTopbarButtons = (b) => topbar.push({ ...b });
  if (canEdit !== 'absent') Object.defineProperty(top, 'configCanEdit', { get: () => access.canEdit, configurable: true });
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  const w = f.contentWindow;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  w.document.open(); w.document.write(strip(PAGE)); w.document.close();
  w.Element.prototype.scrollIntoView = function () {};
  let confirmAnswer = true;
  const confirms = [];
  w.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };
  await flush();
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const setVal = (el, v) => { el.value = v; fire(el, 'input'); };
  const check = (el, on) => { el.checked = on; fire(el, 'input'); };
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const card = (code) => $$('.cr-type').find((c) => c.querySelector('.cr-code').textContent === code);
  const inCard = (code, sel) => card(code).querySelector(sel);
  const openFields = async (code) => { click(inCard(code, '[data-cr-toggle]')); await flush(); };
  return {
    db, backend, calls: backend.calls, top, w, $, $$, fire, setVal, check, click, card, inCard, openFields,
    topbar, errors, logs, confirms, access,
    setConfirm: (v) => { confirmAnswer = v; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
describe('boot', () => {
  test('lists every type (inactive included) from the role-type TABLE routes; New + Refresh requested', async () => {
    const t = await boot();
    expect(t.calls[0]).toEqual({ endpoint: '/api/contact-role-types?include_inactive=true', method: 'GET', payload: null });
    expect(t.$$('.cr-code').map((e) => e.textContent)).toEqual(['trustee', 'judge', 'court', 'venue', 'mediator']);
    expect(t.card('venue').classList.contains('cr-inactive')).toBe(true);
    expect(t.inCard('trustee', '.cr-count').textContent).toBe('2 fields');
    expect(t.$('#crHint').textContent).toBe('5 role types');
    expect(t.topbar[0]).toEqual({ new: true, refresh: true });
    expect(t.$('#addCard').hidden).toBe(false);
    expect(t.$$('[data-cr-save]').every((b) => b.disabled)).toBe(true);   // nothing dirty yet
    expect(t.errors).toEqual([]);
  });

  test('a failed load says so, with the server\'s words', async () => {
    const t = await boot();
    t.top.apiSend = async () => { throw apiError(500, 'Failed to fetch role types'); };
    t.w.onRefresh();
    await flush();
    expect(t.$('#crList').textContent).toMatch(/Failed to load role types: Failed to fetch role types/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('options and number identity', () => {
  const opt = (t, code, fi = 0) => t.inCard(code, `[data-cr-f="${t.$$('.cr-type').indexOf(t.card(code))}:${fi}:options"]`);
  const lastPut = (t) => writes(t.calls).filter((c) => c.method === 'PUT').pop();

  test('display: numbers as CSV; numeric-looking or comma-carrying STRINGS as JSON', async () => {
    const t = await boot();
    for (const code of ['trustee', 'court', 'venue']) await t.openFields(code);
    expect(opt(t, 'trustee').value).toBe('7, 11, 12, 13');
    expect(opt(t, 'court').value).toBe('["7","11"]');
    expect(opt(t, 'venue').value).toBe('["Detroit, MI","Flint",3]');
    // options box enabled only on select types
    expect(opt(t, 'trustee').disabled).toBe(false);
    expect(opt(t, 'trustee', 1).disabled).toBe(true);   // zoom_link is a url
  });

  // One deliberate difference, kept from the settings.html editor: an explicit
  // required:false is not sent back (absent means "not required" — every
  // consumer reads it by truthiness), so it is dropped before comparing.
  const noFalseRequired = (schema) => schema && schema.map((f) => {
    const o = { ...f };
    if (o.required === false) delete o.required;
    return o;
  });

  test('an untouched load → save of every type sends back what is stored (option types kept)', async () => {
    const t = await boot();
    for (const s of SEED) {
      const ti = t.$$('.cr-type').indexOf(t.card(s.role_code));
      // Dirty the card WITHOUT touching a field: the sort order, re-typed as itself.
      t.setVal(t.inCard(s.role_code, `[data-cr-sort="${ti}"]`), String(s.sort_order));
      click(t, t.inCard(s.role_code, `[data-cr-save="${ti}"]`));
      await flush();
      const put = lastPut(t);
      expect(put.endpoint).toBe(`/api/contact-role-types/${s.role_code}`);
      expect(canon(put.payload.attrs_schema)).toEqual(canon(noFalseRequired(s.attrs_schema)));
      // identity, not just equality-after-coercion: every option keeps its JS type
      (s.attrs_schema || []).forEach((f, fi) => {
        if (f.options) expect(put.payload.attrs_schema[fi].options.map((o) => typeof o)).toEqual(f.options.map((o) => typeof o));
      });
      // and the server holds what it held
      expect(canon(t.db.stored(s.role_code).attrs_schema)).toEqual(canon(noFalseRequired(s.attrs_schema)));
    }
    expect(t.errors).toEqual([]);
  });

  test('a second untouched save after the first round trip still keeps every type (re-adopted wire shape)', async () => {
    const t = await boot();
    await t.openFields('court');
    const ti = t.$$('.cr-type').indexOf(t.card('court'));
    for (let i = 0; i < 2; i++) {
      t.setVal(t.inCard('court', `[data-cr-label="${ti}"]`), `Court ${i}`);
      click(t, t.inCard('court', `[data-cr-save="${ti}"]`));
      await flush();
      expect(lastPut(t).payload.attrs_schema[0].options).toEqual(['7', '11']);
      expect(opt(t, 'court').value).toBe('["7","11"]');
    }
  });

  test.each([
    ['CSV: numeric-looking tokens become numbers, the rest stay strings', '7, 11, ch13', [7, 11, 'ch13']],
    ['CSV: decimals and negatives are numbers; empty tokens dropped', '-1, 2.5, , x', [-1, 2.5, 'x']],
    ['JSON escape hatch keeps numeric-looking strings', '["7", 11]', ['7', 11]],
    ['JSON escape hatch keeps a comma inside an option', '["a,b","c"]', ['a,b', 'c']],
  ])('%s', async (_n, typed, sent) => {
    const t = await boot();
    await t.openFields('trustee');
    t.setVal(opt(t, 'trustee'), typed);
    click(t, t.inCard('trustee', '[data-cr-save="0"]'));
    await flush();
    expect(lastPut(t).payload.attrs_schema[0].options).toEqual(sent);
    expect(lastPut(t).payload.attrs_schema[0].options.map((o) => typeof o)).toEqual(sent.map((o) => typeof o));
  });

  test('bad options JSON is refused on the page — no write, the reason in the type\'s status line', async () => {
    const t = await boot();
    await t.openFields('trustee');
    t.setVal(opt(t, 'trustee'), '[7, 11');
    click(t, t.inCard('trustee', '[data-cr-save="0"]'));
    await flush();
    expect(writes(t.calls)).toEqual([]);
    expect(t.$('#crStatus0').textContent).toMatch(/^options: /);
    expect(t.$('#crStatus0').className).toBe('status err');
  });

  test('JSON with trailing junk is refused the same way', async () => {
    const t = await boot();
    await t.openFields('trustee');
    t.setVal(opt(t, 'trustee'), '[1]x');
    click(t, t.inCard('trustee', '[data-cr-save="0"]'));
    await flush();
    expect(writes(t.calls)).toEqual([]);
    expect(t.$('#crStatus0').textContent).toMatch(/^options: /);
  });

  test('typed options survive a re-render (shown as typed, saved as typed)', async () => {
    const t = await boot();
    await t.openFields('trustee');
    t.setVal(opt(t, 'trustee'), '7, 13');
    click(t, t.inCard('trustee', '[data-cr-fadd="0"]'));   // re-renders the card
    await flush();
    expect(opt(t, 'trustee').value).toBe('7, 13');
  });
});

function click(t, el) { t.click(el); }

// ─────────────────────────────────────────────────────────────────────────
describe('per-type saves', () => {
  test('only the dirty card can save; its Save sends one PUT to that type with the route body', async () => {
    const t = await boot();
    const ji = t.$$('.cr-type').indexOf(t.card('judge'));
    const ti = t.$$('.cr-type').indexOf(t.card('trustee'));
    t.setVal(t.inCard('judge', `[data-cr-label="${ji}"]`), 'Bankruptcy Judge');
    t.check(t.inCard('trustee', `[data-cr-active="${ti}"]`), false);
    expect(t.inCard('judge', `[data-cr-save="${ji}"]`).disabled).toBe(false);
    expect(t.inCard('court', '[data-cr-save]').disabled).toBe(true);

    click(t, t.inCard('judge', `[data-cr-save="${ji}"]`));
    await flush();
    expect(writes(t.calls)).toEqual([{
      endpoint: '/api/contact-role-types/judge', method: 'PUT',
      payload: { label: 'Bankruptcy Judge', sort_order: 20, active: 1, attrs_schema: JUDGE_SCHEMA },
    }]);
    expect(t.db.stored('judge').label).toBe('Bankruptcy Judge');
    expect(t.db.stored('trustee').active).toBe(1);                       // not saved — its own Save is separate
    expect(t.inCard('judge', `[data-cr-save="${ji}"]`).disabled).toBe(true);
    expect(t.$(`#crStatus${ji}`).textContent).toBe('"judge" saved');
    expect(t.inCard('trustee', `[data-cr-save="${ti}"]`).disabled).toBe(false);   // still dirty
  });

  test('field edits: add / reorder / remove / required / type → the schema the route receives', async () => {
    const t = await boot();
    await t.openFields('judge');
    const ji = t.$$('.cr-type').indexOf(t.card('judge'));
    click(t, t.inCard('judge', `[data-cr-fadd="${ji}"]`));
    t.setVal(t.$(`[data-cr-f="${ji}:1:key"]`), 'courtroom');
    t.setVal(t.$(`[data-cr-f="${ji}:1:label"]`), 'Courtroom');
    const sel = t.$(`[data-cr-f="${ji}:1:type"]`);
    sel.value = 'select'; t.fire(sel, 'input');
    t.setVal(t.$(`[data-cr-f="${ji}:1:options"]`), '100, 1975');
    t.check(t.$(`[data-cr-f="${ji}:1:required"]`), true);
    click(t, t.$(`[data-cr-fup="${ji}:1"]`));        // courtroom first
    click(t, t.inCard('judge', `[data-cr-save="${ji}"]`));
    await flush();
    const put = writes(t.calls).pop();
    expect(put.payload.attrs_schema).toEqual([
      { key: 'courtroom', label: 'Courtroom', type: 'select', required: true, options: [100, 1975] },
      JUDGE_SCHEMA[0],
    ]);
    expect(t.db.stored('judge').attrs_schema[0].options).toEqual([100, 1975]);

    // removing every field sends null ("no structured attrs")
    click(t, t.$(`[data-cr-fdel="${ji}:1"]`));
    click(t, t.$(`[data-cr-fdel="${ji}:0"]`));
    click(t, t.inCard('judge', `[data-cr-save="${ji}"]`));
    await flush();
    expect(writes(t.calls).pop().payload.attrs_schema).toBeNull();
    expect(t.db.stored('judge').attrs_schema).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('create', () => {
  test('POSTs {role_code, label}, reloads, and keeps another card\'s unsaved edits', async () => {
    const t = await boot();
    const ji = t.$$('.cr-type').indexOf(t.card('judge'));
    t.setVal(t.inCard('judge', `[data-cr-label="${ji}"]`), 'Unsaved Judge');
    t.setVal(t.$('#crNewCode'), 'mediator2');
    t.setVal(t.$('#crNewLabel'), 'Mediator II');
    click(t, t.$('#crAdd'));
    await flush();
    expect(writes(t.calls)).toEqual([{ endpoint: '/api/contact-role-types', method: 'POST', payload: { role_code: 'mediator2', label: 'Mediator II' } }]);
    expect(t.calls.filter((c) => c.method === 'GET')).toHaveLength(2);   // boot + reload
    expect(t.$$('.cr-code').map((e) => e.textContent)).toContain('mediator2');
    expect(t.$('#crNewCode').value).toBe('');
    expect(t.$('#crAddStatus').textContent).toBe('"mediator2" created — add its fields above');
    // the judge edit survived the reload, still dirty
    expect(t.inCard('judge', '[data-cr-label]').value).toBe('Unsaved Judge');
    expect(t.inCard('judge', '[data-cr-save]').disabled).toBe(false);
  });

  test.each([
    ['a bad code', 'Bad Code', 'X', 'role_code must be 1–40 chars of a–z, 0–9, _'],
    ['a taken code', 'judge', 'Judge again', 'role type "judge" already exists'],
    ['no label', 'clerk', '', 'label is required'],
  ])('%s → the service\'s message, verbatim', async (_n, code, label, msg) => {
    const t = await boot();
    t.setVal(t.$('#crNewCode'), code);
    t.setVal(t.$('#crNewLabel'), label);
    click(t, t.$('#crAdd'));
    await flush();
    expect(t.$('#crAddStatus').textContent).toBe(msg);
    expect(t.$('#crAddStatus').className).toBe('status err');
    expect(t.$('#crNewCode').value).toBe(code);   // nothing cleared
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('route validation errors', () => {
  test('shown verbatim in that type\'s status line; the card stays dirty and saveable; nothing stored', async () => {
    const t = await boot();
    await t.openFields('judge');
    const ji = t.$$('.cr-type').indexOf(t.card('judge'));
    click(t, t.inCard('judge', `[data-cr-fadd="${ji}"]`));   // a blank field: no key, no label
    const sel = t.$(`[data-cr-f="${ji}:1:type"]`);
    sel.value = 'select'; t.fire(sel, 'input');            // and a select with no options
    click(t, t.inCard('judge', `[data-cr-save="${ji}"]`));
    await flush();
    const expected = (() => {
      try { roleSvc.validateAttrsSchema([JUDGE_SCHEMA[0], { key: '', label: '', type: 'select', options: [] }]); }
      catch (e) { return e.message; }
      return null;
    })();
    expect(expected).toMatch(/; /);   // several problems, joined
    expect(t.$(`#crStatus${ji}`).textContent).toBe(expected);
    expect(t.$(`#crStatus${ji}`).className).toBe('status err');
    expect(t.inCard('judge', `[data-cr-save="${ji}"]`).disabled).toBe(false);
    expect(canon(t.db.stored('judge').attrs_schema)).toEqual(canon(JUDGE_SCHEMA));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('read-only (§3b)', () => {
  /** Every way to write: input on every rendered input/select, click on every button, the add card, onNew. */
  async function pokeEverything(t) {
    for (const code of ['trustee', 'judge', 'mediator']) {
      const b = t.inCard(code, '[data-cr-toggle]');
      if (!t.card(code).querySelector('.cr-fields')) { click(t, b); await flush(); }
    }
    for (const el of t.$$('#crList input, #crList select')) {
      if (el.type === 'checkbox') { el.checked = !el.checked; t.fire(el, 'input'); }
      else if (el.tagName === 'SELECT') { el.value = 'select'; t.fire(el, 'input'); }
      else { el.value = el.value + 'x'; t.fire(el, 'input'); }
    }
    for (const b of t.$$('#crList button:not([data-cr-toggle])')) { click(t, b); await flush(); }
    t.$('#crNewCode').value = 'sneaky'; t.$('#crNewLabel').value = 'Sneaky';
    click(t, t.$('#crAdd'));
    click(t, t.$('#crNewBtn'));
    t.w.onNew();
    await flush();
  }

  test.each([[false], [null], ['absent']])('configCanEdit %p → read-only: no write control, no write reachable', async (canEdit) => {
    const t = await boot({ canEdit });
    expect(t.$('#addCard').hidden).toBe(true);
    expect(t.$('#crNewBtn').hidden).toBe(true);
    expect(t.$$('[data-cr-save], [data-cr-fadd], [data-cr-fdel], [data-cr-fup], [data-cr-fdown]')).toEqual([]);
    expect(t.$$('#crList input, #crList select').every((el) => el.disabled)).toBe(true);
    // viewing still works
    expect(t.inCard('trustee', '[data-cr-toggle]').textContent).toBe('Show fields');
    await t.openFields('trustee');
    expect(t.card('trustee').querySelectorAll('.cr-field')).toHaveLength(2);
    expect(t.card('trustee').querySelector('[data-cr-f="0:0:options"]').value).toBe('7, 11, 12, 13');
    expect(t.$$('#crList input, #crList select').every((el) => el.disabled)).toBe(true);

    await pokeEverything(t);
    expect(writes(t.calls)).toEqual([]);
    expect(t.w.eval('crDirty()')).toBe(false);
    expect(t.errors).toEqual([]);
  });

  test('onAccess({canEdit:true}) makes it editable; onAccess({canEdit:false}) takes it back', async () => {
    const t = await boot({ canEdit: null });
    expect(t.$$('[data-cr-save]')).toEqual([]);
    t.access.canEdit = true;
    t.w.onAccess({ canEdit: true });
    expect(t.$('#addCard').hidden).toBe(false);
    expect(t.$$('[data-cr-save]').length).toBe(SEED.length);
    t.setVal(t.inCard('judge', '[data-cr-label]'), 'J');
    click(t, t.inCard('judge', '[data-cr-save]'));
    await flush();
    expect(writes(t.calls).map((c) => `${c.method} ${c.endpoint}`)).toEqual(['PUT /api/contact-role-types/judge']);

    t.w.onAccess({ canEdit: false });
    expect(t.$('#addCard').hidden).toBe(true);
    expect(t.$$('[data-cr-save]')).toEqual([]);
    await pokeEverything(t);
    expect(writes(t.calls)).toHaveLength(1);
  });

  test('onAccess with anything but canEdit === true is read-only (fail closed)', async () => {
    const t = await boot({ canEdit: true });
    t.w.onAccess({ canEdit: 'yes' });
    expect(t.$$('[data-cr-save]')).toEqual([]);
    t.w.onAccess(undefined);
    expect(t.$('#addCard').hidden).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('lifecycle and dirty guards', () => {
  test('Refresh over unsaved edits asks; "no" keeps them and fetches nothing, "yes" reloads', async () => {
    const t = await boot();
    t.setVal(t.inCard('judge', '[data-cr-label]'), 'Edited');
    const gets = () => t.calls.filter((c) => c.method === 'GET').length;
    t.setConfirm(false);
    t.w.onRefresh();
    await flush();
    expect(t.confirms).toHaveLength(1);
    expect(gets()).toBe(1);
    expect(t.inCard('judge', '[data-cr-label]').value).toBe('Edited');
    t.setConfirm(true);
    t.w.onRefresh();
    await flush();
    expect(gets()).toBe(2);
    expect(t.inCard('judge', '[data-cr-label]').value).toBe('Judge');
  });

  test('onShow reloads a clean page, never a dirty one; open cards stay open', async () => {
    const t = await boot();
    await t.openFields('trustee');
    const gets = () => t.calls.filter((c) => c.method === 'GET').length;
    t.w.onShow();
    await flush();
    expect(gets()).toBe(2);
    expect(t.card('trustee').querySelector('.cr-fields')).not.toBeNull();
    t.setVal(t.inCard('judge', '[data-cr-label]'), 'Edited');
    t.w.onShow();
    await flush();
    expect(gets()).toBe(2);
    expect(t.topbar.every((b) => b.new === true && b.refresh === true)).toBe(true);
  });

  test('beforeunload asks only while something is unsaved', async () => {
    const t = await boot();
    const ev = () => { const e = new t.w.Event('beforeunload', { cancelable: true }); t.w.dispatchEvent(e); return e.defaultPrevented; };
    expect(ev()).toBe(false);
    t.setVal(t.inCard('judge', '[data-cr-label]'), 'Edited');
    expect(ev()).toBe(true);
  });
});
