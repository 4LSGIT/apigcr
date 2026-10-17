// tests/uiConfigS5a.test.js
//
/**
 * ui-custom S5a — users' own buttons ("My buttons"), the server side
 * (lib/uiConfigShape.js + services/uiConfigService.js + routes/api.uiConfig.js):
 *   - the user `items` document: { items: [ { id 'user:<slug>', label, icon,
 *     action } ] } — the firm item grammar (one function, cleanItems): url /
 *     tool / view, tool and view with the optional size, links
 *     https:// or a root-relative path that is not a shell-only page; cap 50;
 *     present:'tab' refused for a link (a tool / view tab is S5c-b's,
 *     tests/uiConfigS5cb.test.js); non-https links, shell-only
 *     pages, firm / bad ids and duplicates refused; unknown keys are errors;
 *   - its server-managed `retired` list: user ids only, absent when empty, a
 *     button reusing a retired id refused;
 *   - user: refs: a user's layout (placed and removed) and shortcuts may name
 *     one; the FIRM document never does (hidden / locked / renames /
 *     visible_to refuse it) — and the firm grammar is otherwise unchanged
 *     (literal messages here; the S5a worker report records a 32,000-case
 *     differential of the base commit's validator against this one);
 *   - the REAL uiConfigService.write on a scripted transaction connection: a
 *     deleted button's id is retired in the CALLER's row; a client's retired
 *     is dropped; a reuse is a 400 with nothing written; never versioned
 *     (the real engine: tests/uiConfigS5a.mysql.test.js, gated);
 *   - GET /api/ui-config/pickers: any staff user (200), keys and titles only,
 *     never html; an API key or no token is still 401;
 *   - the client's re-validation (ycLauncher.cleanUserItem) keeps exactly what
 *     the server accepts, over one fixture set.
 *
 * Mutation-checked (see the S5a worker report).
 *
 * Run:  npx jest tests/uiConfigS5a.test.js
 */

'use strict';

process.env.JWT_SECRET = 'ui-config-s5a-test-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s5a_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');
const uiRouter = require('../routes/api.uiConfig');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const CL = (() => {
  const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8'), ctx);
  vm.runInContext(rawShellHtml().match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1], ctx);
  return ctx.window.ycLauncher;
})();

const BTN = (over = {}) => ({ id: 'user:leads', label: 'My leads', icon: 'star',
  action: { type: 'view', key: 'lead_followups', present: 'modal' }, ...over });
const VIEW = BTN();
const TOOL = BTN({ id: 'user:intake', label: 'Intake', icon: 'clipboard-check', action: { type: 'tool', key: 'qa-intake-tool', present: 'modal', size: 'compact' } });
const LINK = BTN({ id: 'user:court', label: 'Court site', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/', present: 'window' } });
const APP_LINK = BTN({ id: 'user:manual', label: 'Manual', icon: 'book', action: { type: 'url', href: '/manuals.html#x', present: 'window' } });
const I = (doc) => shape.validate('user', 'items', doc);
const errs = (r) => r.errors.join(' | ');

// ─────────────────────────────────────────────────────────────────────────
describe('the user items document', () => {
  test('every kind is accepted and normalized; the document is { items } (no retired when empty)', () => {
    const r = I({ items: [VIEW, TOOL, LINK, APP_LINK, BTN({ id: 'user:big', action: { type: 'view', key: 'lead_followups', present: 'modal', size: 'large' } })] });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ items: [VIEW, TOOL, LINK, APP_LINK, BTN({ id: 'user:big', action: { type: 'view', key: 'lead_followups', present: 'modal', size: 'large' } })] });
    expect(I({}).value).toEqual({ items: [] });
    expect(I({ items: [BTN({ label: '  Trimmed  ' })] }).value.items[0].label).toBe('Trimmed');
  });

  // S5c-b: a tool / view button may now open as a tab (tests/uiConfigS5cb.test.js);
  // a link never does — it always opens a new window.
  test('present "tab" is refused for a link, saying a link always opens a new window', () => {
    const r = I({ items: [BTN({ action: { type: 'url', href: 'https://x.example/', present: 'tab' } })] });
    expect([r.ok, errs(r)]).toEqual([false, 'items[0]: present "tab" is for tools and saved views: a link always opens in a new window, never inside YisraCase']);
    for (const a of [{ type: 'view', key: 'lead_followups', present: 'tab' }, { type: 'tool', key: 'x', present: 'tab' }]) {
      expect([a.type, I({ items: [BTN({ action: a })] }).ok]).toEqual([a.type, true]);
    }
  });

  test('a link is https:// or a root-relative path — never http:, javascript:, data: or //host; window only', () => {
    for (const href of ['http://x.example/', 'javascript:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example', 'https://u:p@x.example/', 'ftp://x', 'x.example']) {
      expect([href, I({ items: [BTN({ action: { type: 'url', href, present: 'window' } })] }).ok]).toEqual([href, false]);
    }
    expect(errs(I({ items: [BTN({ action: { type: 'url', href: 'https://x.example/', present: 'modal' } })] }))).toMatch(/a url item's present must be "window"/);
    expect(errs(I({ items: [BTN({ action: { type: 'tool', key: 'x', present: 'window' } })] }))).toMatch(/a tool item's present must be "modal"/);
  });

  test('a link may not open a shell-only page (/tool/…, /customView…), however it is spelled', () => {
    for (const href of ['/tool/clio-code', '/TOOL/x', '/%74ool/x', '/a/../tool/x', '/customView.html?key=lead_followups', '/customview']) {
      expect([href, errs(I({ items: [BTN({ action: { type: 'url', href, present: 'window' } })] }))])
        .toEqual([href, expect.stringMatching(/shell-only page/)]);
    }
  });

  test('ids: user:<a-z0-9-> 1–40; a firm id, a bare id, upper case or 41 characters is refused; duplicates refused', () => {
    for (const id of ['firm:leads', 'leads', 'user:Leads', 'user:' + 'x'.repeat(41), 'user:', 'user:a b', 7, undefined]) {
      expect([id, errs(I({ items: [BTN({ id })] }))]).toEqual([id, expect.stringMatching(/id must match \/\^user:/)]);
    }
    expect(I({ items: [BTN({ id: 'user:' + 'x'.repeat(40) })] }).ok).toBe(true);
    expect(errs(I({ items: [BTN(), BTN()] }))).toMatch(/items\[1\]: duplicate id user:leads/);
  });

  test('cap: 50 buttons; 51 is ONE cap error (refused before the entries are read)', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => BTN({ id: 'user:b' + i }));
    expect(I({ items: many(50) }).ok).toBe(true);
    expect(I({ items: many(51) }).errors).toEqual(['items: at most 50 entries']);
    expect(shape.CAPS.items).toBe(50);
  });

  test('strict: unknown fields on the document, a button or its action are errors; no onclick / html field', () => {
    expect(errs(I({ items: [], extra: 1 }))).toMatch(/items: unknown field "extra"/);
    expect(errs(I({ items: [BTN({ onclick: 'x()' })] }))).toMatch(/items\[0\]: unknown field "onclick"/);
    expect(errs(I({ items: [BTN({ action: { ...VIEW.action, html: '<b>' } })] }))).toMatch(/unknown field "html"/);
    expect(errs(I({ items: [BTN({ action: { type: 'action', fetch: '/x', present: 'modal' } })] }))).toMatch(/action\.type must be one of url, tool, view/);
    expect(errs(I({ items: 'x' }))).toBe('items must be an array');
  });

  test('retired: user ids only, absent when empty, kept when present; a button reusing one is refused', () => {
    expect(I({ items: [], retired: ['user:old'] }).value).toEqual({ items: [], retired: ['user:old'] });
    expect(I({ items: [], retired: [] }).value).toEqual({ items: [] });
    expect(errs(I({ items: [], retired: ['firm:x'] }))).toBe('retired[0]: not a user item id');
    expect(errs(I({ items: [BTN({ id: 'user:old' })], retired: ['user:old'] })))
      .toMatch(/user:old belonged to a deleted item and is retired — a new item needs a new id/);
  });

  test('items is a USER key: not a firm key; base refused (user rows are not versioned)', () => {
    expect(shape.CONFIG_KEYS.user).toContain('items');
    expect(errs(shape.validateWrite({ scope: 'firm', config_key: 'items', config: { items: [] } }))).toMatch(/config_key for scope firm/);
    expect(errs(shape.validateWrite({ scope: 'user', config_key: 'items', config: { items: [] }, base: 1 }))).toMatch(/firm" only/);
    expect(shape.validateWrite({ scope: 'user', config_key: 'items', config: { items: [VIEW] } }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('labels: the length bound is checked before the string is spread (review N4)', () => {
  test('a too-long label is refused without iterating it; valid labels are unchanged (40 code points, astral ones too)', () => {
    const astral = '😀'.repeat(40);                       // 40 code points, 80 UTF-16 units
    expect(I({ items: [BTN({ label: astral })] }).value.items[0].label).toBe(astral);
    expect(errs(I({ items: [BTN({ label: astral + '😀' })] }))).toMatch(/label must be 1-40 characters/);
    expect(errs(I({ items: [BTN({ label: 'x'.repeat(41) })] }))).toMatch(/label must be 1-40 characters/);
    const orig = String.prototype[Symbol.iterator];
    let spread = 0;
    String.prototype[Symbol.iterator] = function () { spread++; return orig.call(this); };   // eslint-disable-line no-extend-native
    try {
      const r = I({ items: [BTN({ label: 'y'.repeat(5000000) })] });
      expect(errs(r)).toMatch(/items\[0\]: label must be 1-40 characters/);
    } finally { String.prototype[Symbol.iterator] = orig; }   // eslint-disable-line no-extend-native
    expect(spread).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('user: refs — a user\'s layout and shortcuts may name a button; the firm document never does', () => {
  test('layout: placed (both surfaces) and removed accept user: ids', () => {
    const r = shape.validate('user', 'layout', { placed: { home: [{ item: 'user:leads' }, { break: true }], sidebar: [{ item: 'user:court' }] }, removed: { home: ['user:x'] } });
    expect(r.ok).toBe(true);
    expect(r.value.placed.home[0]).toEqual({ item: 'user:leads' });
    expect(errs(shape.validate('user', 'layout', { placed: { home: [{ item: 'user:Bad' }] } }))).toMatch(/placed\.home\[0\]: not an item id/);
  });

  test('shortcuts: a binding to a user: id is accepted', () => {
    const b = { combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' };
    expect(shape.validate('user', 'shortcuts', { bindings: [b] }).value).toEqual({ bindings: [b] });
    expect(errs(shape.validate('user', 'shortcuts', { bindings: [{ ...b, id: 'user:' }] }))).toMatch(/id must be an item id/);
  });

  test('the firm document refuses user: ids in hidden, locked, renames and visible_to — and as a firm item id', () => {
    const ro = (d) => errs(shape.validate('firm', 'registry_overrides', d));
    expect(ro({ hidden: ['user:leads'] })).toBe('hidden[0]: not an item id');
    expect(ro({ locked: ['user:leads'] })).toBe('locked[0]: not an item id');
    expect(ro({ renames: { 'user:leads': { label: 'X' } } })).toBe('renames.user:leads: not an item id');
    expect(ro({ visible_to: { 'user:leads': ['admin'] } })).toBe('visible_to.user:leads: not an item id');
    expect(ro({ items: [BTN()] })).toMatch(/items\[0\]: id must match \/\^firm:/);
    expect(ro({ retired: ['user:leads'] })).toBe('retired[0]: not a firm item id');
  });

  test('the firm grammar\'s own messages are unchanged (byte-identical: the S5a worker report has the differential)', () => {
    const F = { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://x.example/', present: 'window' } };
    const ro = (d) => shape.validate('firm', 'registry_overrides', d);
    expect(ro({ items: [{ ...F, action: { type: 'tool', key: 'x', present: 'tab' } }] }).errors).toEqual(['items[0]: present "tab" is not available yet']);
    expect(ro({ items: [{ ...F, id: 'user:x' }] }).errors).toEqual(['items[0]: id must match /^firm:[a-z0-9-]{1,40}$/']);
    expect(ro({ items: [F, F] }).errors).toEqual(['items[1]: duplicate id firm:payroll']);
    expect(ro({ items: Array.from({ length: 51 }, (_, i) => ({ ...F, id: 'firm:f' + i })) }).errors).toEqual(['items: at most 50 entries']);
    expect(ro({ items: [{ ...F, action: { type: 'action', present: 'modal' } }] }).errors)
      .toEqual(['items[0]: action.type must be one of url, tool, view, page (there is no action kind: a firm action is a tool item)']);   // page: S6c-5
    expect(ro({ retired: ['firm:payroll'], items: [F] }).errors)
      .toEqual(['items[0]: firm:payroll belonged to a deleted item and is retired — a new item needs a new id']);
    expect(ro({ items: [F], retired: ['firm:old'] }).value).toEqual({ hidden: [], locked: [], renames: {}, items: [F], retired: ['firm:old'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('write(): a user\'s retired button ids are server-managed (always-run, scripted connection)', () => {
  const staff = { type: 'jwt', userId: 5, roles: ['staff'] };
  function txDb(stored) {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push({ s, params });
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) return [stored ? [{ id: 9, config: JSON.stringify(stored) }] : []];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 9 }];
        throw new Error('unscripted statement: ' + s);
      },
    };
    return {
      stmts,
      writes: () => stmts.filter((x) => /^(INSERT|UPDATE|DELETE)\b/.test(x.s)),
      storedDoc: () => { const w = stmts.find((x) => /^INSERT INTO ui_config /.test(x.s)); return w ? JSON.parse(w.params[3]) : null; },
      getConnection: async () => conn,
      query: async () => { throw new Error('pool query not expected'); },
    };
  }
  const put = (config) => ({ scope: 'user', config_key: 'items', config });

  test('deleting a button retires its id — in the caller\'s own row, never versioned', async () => {
    const db = txDb({ items: [VIEW, LINK] });
    const r = await svc.write(db, put({ items: [LINK] }), staff);
    expect(r.config).toEqual({ items: [LINK], retired: ['user:leads'] });
    expect(db.storedDoc()).toEqual({ items: [LINK], retired: ['user:leads'] });
    const sel = db.stmts.find((x) => /FOR UPDATE$/.test(x.s));
    expect(sel.params).toEqual(['user', 5, 'items']);
    const ins = db.stmts.find((x) => /^INSERT INTO ui_config /.test(x.s));
    expect(ins.params.slice(0, 3)).toEqual(['user', 5, 'items']);
    expect(db.stmts.some((x) => /ui_config_versions/.test(x.s))).toBe(false);
    expect([r.changed, r.versioned]).toEqual([true, false]);
  });

  test('the list only grows; a client\'s own retired is dropped (it can neither shrink nor grow it)', async () => {
    const stored = { items: [VIEW, LINK, TOOL], retired: ['user:a'] };
    const r = await svc.write(txDb(stored), put({ items: [LINK], retired: [] }), staff);
    expect(r.config.retired).toEqual(['user:a', 'user:leads', 'user:intake']);
    const g = await svc.write(txDb({ items: [VIEW], retired: ['user:a'] }), put({ items: [VIEW], retired: ['user:a', 'user:zzz'] }), staff);
    expect([g.changed, g.config.retired]).toEqual([false, ['user:a']]);
  });

  test('a client\'s retired never reaches a row that has none yet (nor makes a 400: it is never read)', async () => {
    const first = await svc.write(txDb(null), put({ items: [VIEW], retired: ['user:zzz'] }), staff);
    expect(first.config).toEqual({ items: [VIEW] });
    const noList = txDb({ items: [VIEW] });
    expect((await svc.write(noList, put({ items: [VIEW, LINK], retired: ['user:zzz'] }), staff)).config).toEqual({ items: [VIEW, LINK] });
    expect(noList.storedDoc()).toEqual({ items: [VIEW, LINK] });
    expect((await svc.write(txDb({ items: [VIEW] }), put({ items: [LINK, VIEW], retired: 'nonsense' }), staff)).config).toEqual({ items: [LINK, VIEW] });
  });

  test('a new button reusing a retired id → 400 naming it, nothing written', async () => {
    const db = txDb({ items: [], retired: ['user:leads'] });
    await expect(svc.write(db, put({ items: [VIEW] }), staff))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/user:leads belonged to a deleted item and is retired/) });
    expect(db.writes()).toEqual([]);
  });

  test('a first-ever row: { items } with no retired; an edit of the same id is not a deletion', async () => {
    expect((await svc.write(txDb(null), put({ items: [VIEW] }), staff)).config).toEqual({ items: [VIEW] });
    const r = await svc.write(txDb({ items: [VIEW] }), put({ items: [{ ...VIEW, label: 'Renamed' }] }), staff);
    expect(r.config.retired).toBeUndefined();
  });

  test('the firm document\'s retired list is untouched by this (still firm ids, still derived)', async () => {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push(s);
        if (/FOR UPDATE$/.test(s)) return [[{ id: 4, config: JSON.stringify({ hidden: [], locked: [], renames: {}, items: [{ id: 'firm:a', label: 'A', icon: 'c', action: LINK.action }] }) }]];
        if (/^SELECT MAX\(id\)/.test(s)) return [[{ id: 7 }]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 4 }];
        if (/^INSERT INTO ui_config_versions /.test(s)) return [{ insertId: 8 }];
        throw new Error('unscripted ' + s);
      },
    };
    const db = { getConnection: async () => conn, query: async () => { throw new Error('no'); } };
    const r = await svc.write(db, { scope: 'firm', config_key: 'registry_overrides', config: { hidden: [], locked: [], renames: {}, items: [] } }, { type: 'jwt', userId: 1, roles: ['admin'] });
    expect(r.config.retired).toEqual(['firm:a']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('GET /api/ui-config/pickers — any staff user', () => {
  let server;
  let db;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(uiRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());
  const makeDb = () => ({
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM api_keys/.test(s)) return [[]];
      if (/FROM tools/.test(s)) return [[{ tool_key: 'clio-code', title: 'Get Clio Code', html: '<script>secret()</script>', status: 'live' }, { tool_key: 'Bad Key', title: 'x' }]];
      if (/FROM report_definitions/.test(s)) return [[{ report_key: 'lead_followups', title: 'Leads', sql_text: 'SELECT secret' }]];
      throw new Error('unscripted ' + s);
    },
  });
  const tok = (roles) => ({ authorization: 'Bearer ' + jwt.sign({ sub: 9, username: 'u9', user_type: 1, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' }) });
  const get = async (headers) => {
    db = makeDb();
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ui-config/pickers`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  };

  test('staff, attorney, form_dev, automation, no roles at all: 200 — keys and titles only, never html or sql', async () => {
    for (const roles of [['staff'], ['attorney'], ['form_dev'], ['automation'], [], ['admin']]) {
      const r = await get(tok(roles));
      expect([roles, r.status]).toEqual([roles, 200]);
      expect(r.body).toEqual({ status: 'success', tools: [{ key: 'clio-code', title: 'Get Clio Code' }], views: [{ key: 'lead_followups', title: 'Leads' }] });
      expect(r.text).not.toMatch(/script|secret|html|sql/i);
      for (const row of [...r.body.tools, ...r.body.views]) expect(Object.keys(row).sort()).toEqual(['key', 'title']);
    }
  });

  test('an API key or no token: still 401 (a user needs a user)', async () => {
    expect((await get({ 'x-api-key': process.env.INTERNAL_API_KEY })).status).toBe(401);
    expect((await get({})).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the client (ycLauncher.cleanUserItem) keeps exactly what the server accepts', () => {
  const FIX = [
    VIEW, TOOL, LINK, APP_LINK,
    BTN({ action: { type: 'url', href: '/tool/x', present: 'window' } }),
    BTN({ action: { type: 'url', href: '/%74ool/x', present: 'window' } }),
    BTN({ action: { type: 'url', href: '/customView.html?key=a', present: 'window' } }),
    BTN({ action: { type: 'url', href: '//evil', present: 'window' } }),
    BTN({ action: { type: 'url', href: 'http://x.example/', present: 'window' } }),
    BTN({ action: { type: 'url', href: 'https://u:p@x.example/', present: 'window' } }),
    BTN({ action: { type: 'url', href: 'https://x.example/', present: 'tab' } }),
    BTN({ action: { type: 'view', key: 'lead_followups', present: 'tab' } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'window' } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'modal', size: 'huge' } }),
    BTN({ action: { type: 'url', href: 'https://x.example/', present: 'window', size: 'compact' } }),
    BTN({ id: 'firm:leads' }), BTN({ id: 'user:Leads' }), BTN({ id: 'leads' }),
    BTN({ label: '' }), BTN({ label: ' Spaced ' }), BTN({ label: 'x'.repeat(41) }), BTN({ icon: 'Bad Icon' }),
    BTN({ onclick: 'x()' }), null, 'x', [],
  ];
  test.each(FIX.map((f, i) => [i, f]))('fixture %i', (_, f) => {
    const server = I({ items: [f] });
    const client = CL.cleanUserItem(f);
    expect(client === null ? null : JSON.parse(JSON.stringify(client))).toEqual(server.ok ? server.value.items[0] : null);
  });
  test('the client\'s USER_ID_RE is the server\'s; a firm item is not a user item and vice versa', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(src.match(/var USER_ID_RE = (\/.*?\/[a-z]*);/)[1]).toBe(String(shape.USER_ID_RE));
    expect(CL.cleanFirmItem(VIEW)).toBe(null);
    expect(CL.cleanUserItem({ ...VIEW, id: 'firm:x' })).toBe(null);
  });
});
