// tests/uiConfigS31.test.js
//
/**
 * ui-custom S3.1 — the ui_config document grammar (lib/uiConfigShape.js), the
 * client's re-validation of firm items (ycLauncher.cleanFirmItem in
 * public/index.html) held to the same rules, the PUT/GET gates on
 * routes/api.uiConfig.js where they stop BEFORE the database, and
 * /api/firm-data's `ui` delivery (fail-soft, user layer for JWT callers only).
 *
 * The write path on a real engine (upsert, versions, cascade, the auth matrix
 * end to end): tests/uiConfig.mysql.test.js (gated on YC_TEST_MYSQL_URL).
 *
 * Mutation-checked (see the S3.1 worker report for the list and results).
 *
 * Run:  npx jest tests/uiConfigS31.test.js
 */

'use strict';

process.env.JWT_SECRET = 'ui-config-s31-test-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s31_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const shape = require('../lib/uiConfigShape');
const { TOOL_KEY_RE } = require('../routes/api.tools');
const { UNDENIABLE } = require('../services/entitlementService');
const vm = require('vm');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
// The page's own ycLauncher block in a bare vm (as tests/helpers/shellHtml.js
// loadLauncher does) — plus URL, which every browser has and a bare vm lacks
// (the client's https:// check parses with it).
const CL = (() => {
  const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8'), ctx);
  vm.runInContext(rawShellHtml().match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1], ctx);
  return ctx.window.ycLauncher;
})();

const item = (over = {}) => ({ id: 'firm:payroll', label: 'Payroll', icon: 'money-check',
  action: { type: 'url', href: 'https://payroll.example.com/x?y=1', present: 'window' }, ...over });
const ro = (doc) => shape.validate('firm', 'registry_overrides', doc);
const errs = (r) => r.errors.join(' | ');

// ─────────────────────────────────────────────────────────────────────────
describe('scope / config_key / role / body envelope', () => {
  test('system scope is refused; unknown scopes are refused', () => {
    expect(errs(shape.validate('system', 'registry_overrides', {}))).toMatch(/reserved/);
    for (const s of ['', 'role', 'FIRM', undefined, null, 1]) expect(shape.validate(s, 'registry_overrides', {}).ok).toBe(false);
  });

  test('config_key is whitelisted per scope', () => {
    expect(shape.validate('firm', 'registry_overrides', {}).ok).toBe(true);
    expect(shape.validate('user', 'shortcuts', {}).ok).toBe(true);
    expect(errs(shape.validate('firm', 'shortcuts', {}))).toMatch(/config_key/);
    expect(errs(shape.validate('user', 'registry_overrides', {}))).toMatch(/config_key/);
    // ui-custom S4a: the user layer's layout key; S6c: the firm's default layout too
    expect(shape.validate('user', 'layout', {}).ok).toBe(true);
    expect(shape.validate('firm', 'layout', {}).ok).toBe(true);
    // ui-custom S5d: the user's theme (prefs) is a user key only
    expect(shape.validate('user', 'prefs', {}).ok).toBe(true);
    expect(errs(shape.validate('firm', 'prefs', {}))).toMatch(/config_key/);
    for (const k of ['drawers', 'custom_tabs', '']) {
      expect(shape.validate('firm', k, {}).ok).toBe(false);
      expect(shape.validate('user', k, {}).ok).toBe(false);
    }
  });

  test('config must be a plain object', () => {
    for (const c of [null, [], 'x', 3, undefined]) expect(errs(ro(c))).toMatch(/config must be an object/);
  });

  test('validateWrite: role must be "" when present; user_id rejected; unknown body keys rejected', () => {
    const base = { scope: 'firm', config_key: 'registry_overrides', config: {} };
    expect(shape.validateWrite(base).ok).toBe(true);
    expect(shape.validateWrite({ ...base, role: '' }).ok).toBe(true);
    for (const role of ['admin', ' ', null, 0]) expect(errs(shape.validateWrite({ ...base, role }))).toMatch(/role is reserved/);
    expect(errs(shape.validateWrite({ ...base, scope: 'user', config_key: 'shortcuts', user_id: 6 }))).toMatch(/user_id is not accepted/);
    expect(errs(shape.validateWrite({ ...base, extra: 1 }))).toMatch(/unknown field "extra"/);
    expect(shape.validateWrite(null).ok).toBe(false);
    expect(shape.validateWrite([]).ok).toBe(false);
    expect(shape.validateWrite({ ...base, scope: 'system' }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('registry_overrides', () => {
  test('normalizes to exactly hidden / locked / renames / items, trimming and de-duplicating', () => {
    const r = ro({
      hidden: ['moreCampaigns', 'bills', 'moreCampaigns'],
      locked: ['cases', 'cases'],
      renames: { bills: { label: '  Billing Desk  ' } },
      items: [item({ label: ' Payroll ' })],
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      hidden: ['moreCampaigns', 'bills'],
      locked: ['cases'],
      renames: { bills: { label: 'Billing Desk' } },
      items: [item()],
    });
    expect(ro({}).value).toEqual({ hidden: [], locked: [], renames: {}, items: [] });
  });

  test('unknown fields anywhere are errors, never dropped', () => {
    expect(errs(ro({ hiden: [] }))).toMatch(/unknown field "hiden"/);
    expect(errs(ro({ layout: {} }))).toMatch(/unknown field "layout"/);
    expect(errs(ro({ renames: { bills: { label: 'B', icon: 'x' } } }))).toMatch(/unknown field "icon"/);
    expect(errs(ro({ items: [item({ color: 'red' })] }))).toMatch(/unknown field "color"/);
    expect(errs(ro({ items: [item({ action: { type: 'url', href: '/x', present: 'window', target: '_top' } })] }))).toMatch(/unknown field "target"/);
  });

  test('no code on a DB item: onclick / fn / script / html are refused', () => {
    for (const k of ['onclick', 'fn', 'script', 'html']) {
      expect(errs(ro({ items: [item({ [k]: 'alert(1)' })] }))).toMatch(new RegExp(`unknown field "${k}"`));
      expect(ro({ items: [item({ action: { type: 'url', href: '/x', present: 'window', [k]: 'alert(1)' } })] }).ok).toBe(false);
    }
  });

  test('hidden refuses the undeniable set (one definition: entitlementService.UNDENIABLE)', () => {
    expect([...UNDENIABLE].sort()).toEqual(['all', 'helpSupport', 'moreSettings']);   // all: ui-custom S6c
    for (const id of UNDENIABLE) expect(errs(ro({ hidden: [id] }))).toMatch(/cannot be hidden/);
    expect(ro({ locked: ['moreSettings'] }).ok).toBe(true);           // locking is not hiding
  });

  test('ids: registry-shaped or firm-shaped; junk refused', () => {
    expect(ro({ hidden: ['firm:payroll', 'adminDbConsole'] }).ok).toBe(true);
    for (const bad of ['', '1cases', 'cases!', 'firm:', 'firm:UPPER', 'firm:a_b', 'x'.repeat(65), 7, null]) {
      expect([bad, ro({ hidden: [bad] }).ok]).toEqual([bad, false]);
      expect([bad, ro({ locked: [bad] }).ok]).toEqual([bad, false]);
    }
    expect(ro({ renames: { 'not an id': { label: 'x' } } }).ok).toBe(false);
  });

  test('renames refuse custom (its user titles it) and firm items (edit their label) — never stored as silent data', () => {
    expect(errs(ro({ renames: { custom: { label: 'Mine' } } }))).toMatch(/custom tab is titled by its user/);
    expect(errs(ro({ renames: { 'firm:payroll': { label: 'Pay' } } }))).toMatch(/firm item is renamed by editing its own label/);
    expect(ro({ renames: { cases: { label: 'Matters' } } }).ok).toBe(true);
  });

  test('labels: plain text, trimmed, 1–40 characters', () => {
    expect(ro({ renames: { bills: { label: 'x'.repeat(40) } } }).ok).toBe(true);
    expect(ro({ renames: { bills: { label: '😀'.repeat(40) } } }).ok).toBe(true);   // code points, not UTF-16 units
    for (const label of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0000b', 'a b', 5, null, undefined]) {
      expect([label, ro({ renames: { bills: { label } } }).ok]).toEqual([label, false]);
      expect([label, ro({ items: [item({ label })] }).ok]).toEqual([label, false]);
    }
    expect(ro({ renames: { bills: 'Billing' } }).ok).toBe(false);
  });

  test('firm item id, icon, duplicates', () => {
    for (const id of ['payroll', 'firm:', 'firm:Pay', 'firm:pay roll', 'firm:pay_roll', 'firm:' + 'a'.repeat(41), 'firmx:pay']) {
      expect([id, errs(ro({ items: [item({ id })] }))]).toEqual([id, expect.stringMatching(/id must match/)]);
    }
    expect(ro({ items: [item({ id: 'firm:' + 'a'.repeat(40) })] }).ok).toBe(true);
    for (const icon of ['', 'Money', 'fa-solid fa-x', 'a b', '"x', 'x'.repeat(41)]) expect(ro({ items: [item({ icon })] }).ok).toBe(false);
    expect(errs(ro({ items: [item(), item({ label: 'Two' })] }))).toMatch(/duplicate id firm:payroll/);
  });

  test('oversized input is refused at the cap check, fast, with one error — never iterated', () => {
    const big = Array.from({ length: 60000 }, (_, i) => `item${i}`);
    let t = process.hrtime.bigint();
    const r = ro({ hidden: big });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    expect(r.errors).toEqual(['hidden: at most 100 entries']);
    expect(ms).toBeLessThan(100);
    t = process.hrtime.bigint();
    const r2 = ro({ locked: big, renames: Object.fromEntries(big.map((k) => [k, { label: '' }])),   // each one invalid
      items: big.map((k) => ({ id: 'firm:' + k.toLowerCase() })) });
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(400);
    expect(r2.errors).toEqual(['locked: at most 100 entries', 'renames: at most 100 entries', 'items: at most 50 entries']);
    const r3 = shape.validate('user', 'shortcuts', { bindings: big.map(() => ({ nope: 1 })) });
    expect(r3.errors).toEqual(['bindings: at most 50 entries']);
  });

  test('the error list is capped (first ERRORS_MAX + a count); unknown fields are reported 5 per object', () => {
    const r = ro({ hidden: Array.from({ length: 100 }, (_, i) => `bad id ${i}`) });
    expect(r.errors).toHaveLength(shape.ERRORS_MAX + 1);
    expect(r.errors[shape.ERRORS_MAX]).toBe('…and 80 more errors');
    const u = ro(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`x${i}`, 1])));
    expect(u.errors).toHaveLength(6);
    expect(u.errors[5]).toBe('registry_overrides: more unknown fields');
  });

  test('caps: items 50, hidden / locked / renames 100', () => {
    const n = (k) => Array.from({ length: k }, (_, i) => item({ id: `firm:i${i}` }));
    expect(ro({ items: n(50) }).ok).toBe(true);
    expect(errs(ro({ items: n(51) }))).toMatch(/at most 50/);
    const ids = (k) => Array.from({ length: k }, (_, i) => `item${i}`);
    expect(ro({ hidden: ids(100), locked: ids(100) }).ok).toBe(true);
    expect(errs(ro({ hidden: ids(101) }))).toMatch(/hidden: at most 100/);
    expect(errs(ro({ locked: ids(101) }))).toMatch(/locked: at most 100/);
    const ren = (k) => Object.fromEntries(ids(k).map((i) => [i, { label: 'L' }]));
    expect(ro({ renames: ren(100) }).ok).toBe(true);
    expect(errs(ro({ renames: ren(101) }))).toMatch(/renames: at most 100/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('firm item actions', () => {
  const act = (action) => ro({ items: [item({ action })] });

  test('url: https://… or a root-relative path, present window only', () => {
    for (const href of ['https://example.com', 'https://example.com/a?b=c#d', '/reports.html?x=1', '/', '/manuals/01-intro']) {
      expect([href, act({ type: 'url', href, present: 'window' }).ok]).toEqual([href, true]);
    }
    expect(act({ type: 'url', href: '/x', present: 'modal' }).ok).toBe(false);
  });

  test('url: a root-relative href may not open a shell-only page (/tool/…, /customView…) — after normalisation', () => {
    for (const href of ['/tool/appt-form', '/tool', '/tool/', '/TOOL/appt-form', '/Tool/x?y=1', '/customView.html?key=lead_followups',
      '/customView.html', '/customview', '/CUSTOMVIEW.HTML#x', '/customView', '/customView/', '/%74ool/x', '/%54OOL/x', '/%2574ool/x',
      '/%252574ool/x', '/a/../tool/x', '/%2e%2e/tool/x', '/./tool/x', '/x/..//tool/x', '/tool//x', '/%2ftool/x', '/customView%2Ehtml',
      '/%63ustom%56iew.html?key=x', '/%']) {
      expect([href, errs(act({ type: 'url', href, present: 'window' }))]).toEqual([href, expect.stringMatching(/shell-only|whitespace/)]);
    }
    for (const href of ['/tools', '/toolbox/x', '/x/tool/y', '/customViewer.html', '/customviews', '/reports.html', '/']) {
      expect([href, act({ type: 'url', href, present: 'window' }).ok]).toEqual([href, true]);
    }
    expect(shape.shellOnlyPath('/tool/x')).toBe(true);
  });

  test('url: every other scheme / shape is refused — incl. //host and javascript:', () => {
    for (const href of ['//evil.example', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'ftp://x', 'vbscript:x', 'example.com',
      'https://', 'https://user:pw@example.com', 'https://ex ample.com', '/a b', '/a\tb', '/a\nb', '', 'x'.repeat(2001),
      'https:/\\evil.example', null, 5]) {
      expect([href, act({ type: 'url', href, present: 'window' }).ok]).toEqual([href, false]);
    }
  });

  test('tool and view: key grammar (TOOL_KEY_RE reused, VIEW_KEY_RE = report_key), modal only', () => {
    expect(act({ type: 'tool', key: 'appt-form', present: 'modal' }).ok).toBe(true);
    expect(act({ type: 'view', key: 'lead_followups', present: 'modal' }).ok).toBe(true);
    for (const t of ['tool', 'view']) {
      expect(errs(act({ type: t, key: t === 'tool' ? 'appt-form' : 'lead_followups', present: 'window' })))
        .toMatch(/present must be "modal"/);
    }
    for (const key of ['', 'Appt', 'a/b', '../x', 'a b', 'x'.repeat(81), 5]) expect(act({ type: 'tool', key, present: 'modal' }).ok).toBe(false);
    for (const key of ['ab', '1abc', 'abc-d', 'ABC', 'x'.repeat(61)]) expect(act({ type: 'view', key, present: 'modal' }).ok).toBe(false);
    expect(act({ type: 'tool', key: 'appt-form', present: 'modal', href: '/x' }).ok).toBe(false);
  });

  test('present "tab" is refused for every kind (S5)', () => {
    expect(errs(act({ type: 'tool', key: 'appt-form', present: 'tab' }))).toMatch(/present "tab" is not available/);
    expect(errs(act({ type: 'url', href: '/x', present: 'tab' }))).toMatch(/present "tab"/);
    expect(act({ type: 'url', href: '/x' }).ok).toBe(false);            // present is required
  });

  test('every other type is refused — action (dropped: a tool item), iframe, fn, tab, panel', () => {
    expect(errs(act({ type: 'action', fetch: '/clio-code', present: 'modal' }))).toMatch(/no action kind: a firm action is a tool item/);
    for (const type of ['iframe', 'fn', 'tab', 'panel', 'URL', '', undefined]) {
      expect([type, act({ type, href: '/x', key: 'x', present: 'modal' }).ok]).toEqual([type, false]);
    }
    expect(act('https://x').ok).toBe(false);
    expect(act(null).ok).toBe(false);
  });

  test('the borrowed grammars are the real ones: TOOL_KEY_RE from api.tools, VIEW_KEY_RE = reportService REPORT_KEY_RE', () => {
    expect(TOOL_KEY_RE).toBeInstanceOf(RegExp);
    expect(TOOL_KEY_RE.test('appt-form')).toBe(true);
    const rs = fs.readFileSync(path.join(ROOT, 'services/reportService.js'), 'utf8').match(/const REPORT_KEY_RE = (\/.*\/);/)[1];
    expect(String(shape.VIEW_KEY_RE)).toBe(rs);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('shortcuts (user scope; S4c adds the combo rules: tests/launcherS4c.test.js)', () => {
  const sc = (doc) => shape.validate('user', 'shortcuts', doc);
  const b = (over = {}, combo = {}) => ({ combo: { ctrl: true, meta: false, alt: false, shift: false, key: 'b', ...combo }, id: 'bills', ...over });

  test('normalizes; letters stored lower-case; named keys kept', () => {
    const r = sc({ bindings: [b({}, { key: 'B' }), b({ id: 'firm:payroll' }, { key: 'F2' }), b({}, { key: '/' })] });
    expect(r.ok).toBe(true);
    expect(r.value.bindings.map((x) => x.combo.key)).toEqual(['b', 'F2', '/']);
    expect(sc({}).value).toEqual({ bindings: [] });
  });

  test('strict booleans, all four required; bad keys; bad ids; unknown fields', () => {
    expect(sc({ bindings: [b({}, { ctrl: 1 })] }).ok).toBe(false);
    expect(sc({ bindings: [b({}, { shift: 'false' })] }).ok).toBe(false);
    const noAlt = b(); delete noAlt.combo.alt;
    expect(sc({ bindings: [noAlt] }).ok).toBe(false);
    for (const key of ['', ' ', 'ab', 'enter', 'F13', '\n', null]) expect([key, sc({ bindings: [b({}, { key })] }).ok]).toEqual([key, false]);
    expect(sc({ bindings: [b({ id: 'not an id' })] }).ok).toBe(false);
    expect(errs(sc({ bindings: [b({ fn: 'x' })] }))).toMatch(/unknown field "fn"/);
    expect(errs(sc({ bindings: [b({}, { code: 'KeyB' })] }))).toMatch(/unknown field "code"/);
    expect(errs(sc({ keys: [] }))).toMatch(/unknown field "keys"/);
  });

  test('duplicate combos refused (case-folded); cap 50', () => {
    expect(errs(sc({ bindings: [b(), b({ id: 'cases' }, { key: 'B' })] }))).toMatch(/same combo as bindings\[0\]/);
    expect(sc({ bindings: [b(), b({ id: 'cases' }, { shift: true })] }).ok).toBe(true);
    // ctrl+alt: '!'…'R' include K, and Ctrl-K alone is the palette's (S4c rule)
    const many = (n) => Array.from({ length: n }, (_, i) => b({}, { key: String.fromCharCode(33 + i), alt: true }));
    expect(sc({ bindings: many(50) }).ok).toBe(true);
    expect(errs(sc({ bindings: many(51) }))).toMatch(/at most 50/);
  });
});

describe('canonical() — the "unchanged" test is key-order-insensitive', () => {
  test('same document, keys reordered at every level → equal; a change → different', () => {
    const a = { hidden: ['x'], renames: { b: { label: 'B' } }, items: [{ id: 'firm:a', label: 'A', icon: 'i', action: { type: 'url', href: '/', present: 'window' } }], locked: [] };
    const b = { locked: [], items: [{ action: { present: 'window', href: '/', type: 'url' }, icon: 'i', label: 'A', id: 'firm:a' }], renames: { b: { label: 'B' } }, hidden: ['x'] };
    expect(shape.canonical(a)).toBe(shape.canonical(b));
    expect(shape.canonical(a)).not.toBe(shape.canonical({ ...a, hidden: ['y'] }));
    expect(shape.canonical({ x: [1, 2] })).not.toBe(shape.canonical({ x: [2, 1] }));   // arrays keep order
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The client (ycLauncher.cleanFirmItem) keeps exactly what the server accepts.
describe('client re-validation == server validation (one fixture set)', () => {
  const FIXTURES = [
    item(),
    item({ action: { type: 'url', href: '/tool/appt-form', present: 'window' } }),
    item({ action: { type: 'url', href: '/reports.html', present: 'window' } }),
    item({ action: { type: 'url', href: '/%74ool/x', present: 'window' } }),
    item({ action: { type: 'url', href: '/a/../TOOL/x', present: 'window' } }),
    item({ action: { type: 'url', href: '/x/..//customView.html?key=a', present: 'window' } }),
    item({ action: { type: 'url', href: '/%2574ool/x', present: 'window' } }),
    item({ action: { type: 'url', href: '/customViewer.html', present: 'window' } }),
    item({ action: { type: 'tool', key: 'appt-form', present: 'modal' } }),
    item({ action: { type: 'view', key: 'lead_followups', present: 'modal' } }),
    item({ action: { type: 'tool', key: 'appt-form', present: 'window' } }),
    item({ action: { type: 'view', key: 'lead_followups', present: 'window' } }),
    item({ action: { type: 'tool', key: 'appt-form', present: 'tab' } }),
    item({ action: { type: 'url', href: '//evil.example', present: 'window' } }),
    item({ action: { type: 'url', href: '/\\evil.example', present: 'window' } }),
    item({ action: { type: 'url', href: 'javascript:alert(1)', present: 'window' } }),
    item({ action: { type: 'url', href: 'http://x.example', present: 'window' } }),
    item({ action: { type: 'url', href: 'https://u:p@x.example', present: 'window' } }),
    item({ action: { type: 'url', href: 'data:text/html,x', present: 'window' } }),
    item({ action: { type: 'action', fetch: '/clio-code', present: 'modal' } }),
    item({ action: { type: 'iframe', href: '/x', present: 'modal' } }),
    item({ action: { type: 'url', href: '/x', present: 'window', onclick: 'x()' } }),
    item({ onclick: 'x()' }),
    item({ id: 'payroll' }),
    item({ id: 'firm:Pay' }),
    item({ icon: 'fa-x y' }),
    item({ label: '' }),
    item({ label: ' Spaced ' }),
    item({ label: 'x'.repeat(41) }),
    item({ label: 'a b' }),
    item({ action: { type: 'view', key: 'ab', present: 'modal' } }),
    item({ action: { type: 'tool', key: 'A', present: 'modal' } }),
    null, 'string', [],
  ];

  test.each(FIXTURES.map((f, i) => [i, f]))('fixture %i', (_, f) => {
    const server = ro({ items: [f] });
    const client = CL.cleanFirmItem(f);
    expect(client === null ? null : JSON.parse(JSON.stringify(client))).toEqual(server.ok ? server.value.items[0] : null);
  });

  test('the client regexes are the server ones', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const grab = (name) => src.match(new RegExp(`var ${name} = (/.*?/[a-z]*);`))[1];
    expect(grab('TOOL_KEY_RE')).toBe(String(TOOL_KEY_RE));
    expect(grab('VIEW_KEY_RE')).toBe(String(shape.VIEW_KEY_RE));
    expect(grab('FIRM_ID_RE')).toBe(String(shape.FIRM_ID_RE));
    expect(grab('ICON_RE')).toBe(String(shape.ICON_RE));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Routes: the gates that stop before the database, and /api/firm-data `ui`.
function makeDb({ uiRows = [], uiThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM api_keys WHERE key_hash/.test(s)) return [[]];
      if (/FROM ui_config/.test(s)) {
        if (uiThrows) throw new Error("Table 'ui_config' doesn't exist");
        return [uiRows.filter((r) => r.scope === 'firm' || r.user_id === params[0])];
      }
      if (/FROM entitlement_denies/.test(s)) return [[]];
      if (/^SELECT \* FROM users WHERE user = \?/.test(s)) return [[{ user: params[0], user_name: 'U', roles: 'staff' }]];
      if (/FROM phone_lines|FROM email_credentials|FROM users|FROM app_settings/.test(s)) return [[]];
      if (/contact_roles|FROM contacts/.test(s)) return [[]];
      throw new Error('unscripted query: ' + s);
    },
    getConnection: async () => { throw new Error('the write path must not be reached'); },
  };
}

// HTTP round trips on a loaded machine (a full gated run beside Chromium
// surveys) can pass jest's 5 s default; 20 s still catches a real hang.
jest.setTimeout(20000);

// One server per router for the whole file, the stub db swapped per call.
// Building an app and listening anew on every call (several per test) hit
// jest's 5 s default under a loaded full run (2026-10-15) and could NO-GO
// another arc's landing. Calls in this file are sequential, so one current
// db is safe.
const callServers = new Map();
let callDb = null;
function callServer(router) {
  if (!callServers.has(router)) callServers.set(router, new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = callDb; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  }));
  return callServers.get(router);
}
afterAll(async () => {
  for (const p of callServers.values()) {
    const server = await p;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function call(router, method, url, { headers = {}, body, db }) {
  const server = await callServer(router);
  callDb = db;
  const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
  return { status: r.status, body: json };
}

const tok = (roles, sub = 9) => ({ authorization: 'Bearer ' + jwt.sign(
  { sub, username: 'u' + sub, user_type: 1, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' }) });
const uiRouter = require('../routes/api.uiConfig');
const firmData = require('../routes/api.firmData');
const FIRM_PUT = { scope: 'firm', config_key: 'registry_overrides', config: {} };

describe('routes/api.uiConfig.js — gates (no database reached)', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('firm PUT without firm.settings → 403 (staff, attorney, form_dev); the write path is never reached', async () => {
    for (const roles of [['staff'], ['attorney'], ['form_dev'], []]) {
      const db = makeDb();
      const r = await call(uiRouter, 'PUT', '/api/ui-config', { headers: tok(roles), body: FIRM_PUT, db });
      expect([roles, r.status]).toEqual([roles, 403]);
      expect(db.calls.filter((c) => !/jwt_api_audit_log/.test(c.sql))).toEqual([]);
    }
  });

  test('defence in depth: the service refuses a VALIDATED firm write without firm.settings, before any DB work', async () => {
    const svc = require('../services/uiConfigService');
    const body = { scope: 'firm', config_key: 'registry_overrides', config: { hidden: ['bills'] } };
    for (const auth of [{ type: 'jwt', userId: 9, roles: ['staff'] }, { type: 'jwt', userId: 9, roles: ['attorney', 'form_dev'] },
      { type: 'api_key', key_label: 'internal' }, null]) {
      const db = makeDb();
      await expect(svc.write(db, body, auth)).rejects.toMatchObject({ status: 403 });
      expect(db.calls).toEqual([]);
    }
    // with the capability it goes on to the write path (the stub DB refuses it there)
    for (const roles of [['admin'], ['it'], ['su']]) {
      await expect(svc.write(makeDb(), body, { type: 'jwt', userId: 9, roles })).rejects.toThrow(/write path must not be reached/);
    }
    // a plain staff caller's own user row is not affected by the check
    await expect(svc.write(makeDb(), { scope: 'user', config_key: 'shortcuts', config: {} }, { type: 'jwt', userId: 9, roles: ['staff'] }))
      .rejects.toThrow(/write path must not be reached/);
  });

  test('API keys are refused on GET and PUT (no user, no layer); no token → 401', async () => {
    const key = { 'x-api-key': process.env.INTERNAL_API_KEY };
    for (const [m, body] of [['GET', undefined], ['PUT', FIRM_PUT], ['PUT', { ...FIRM_PUT, scope: 'user', config_key: 'shortcuts' }]]) {
      const db = makeDb();
      const r = await call(uiRouter, m, '/api/ui-config', { headers: key, body, db });
      expect([m, r.status]).toEqual([m, 401]);
      expect(db.calls.some((c) => /ui_config/.test(c.sql))).toBe(false);
    }
  });

  test('body errors are 400 with the error list, after auth: system, role, user_id, bad key', async () => {
    for (const body of [{ ...FIRM_PUT, scope: 'system' }, { ...FIRM_PUT, role: 'admin' },
      { scope: 'user', config_key: 'shortcuts', config: {}, user_id: 3 }, { ...FIRM_PUT, config_key: 'prefs' }, { scope: 'nope' }]) {
      const r = await call(uiRouter, 'PUT', '/api/ui-config', { headers: tok(['su']), body, db: makeDb() });
      expect([body, r.status, Array.isArray(r.body.errors)]).toEqual([body, 400, true]);
    }
  });

  test('GET for a staff user: firm + only this user\'s rows', async () => {
    const db = makeDb({ uiRows: [
      { scope: 'firm', user_id: 0, config_key: 'registry_overrides', config: { hidden: ['bills'] } },
      { scope: 'user', user_id: 9, config_key: 'shortcuts', config: '{"bindings":[]}' },
      { scope: 'user', user_id: 4, config_key: 'shortcuts', config: { bindings: [{ id: 'x' }] } },
    ] });
    const r = await call(uiRouter, 'GET', '/api/ui-config', { headers: tok(['staff']), db });
    expect(r.status).toBe(200);
    // can_edit_firm: S3.2 (tests/uiConfigS32.test.js covers it across roles)
    expect(r.body).toEqual({ status: 'success', firm: { registry_overrides: { hidden: ['bills'] } }, user: { shortcuts: { bindings: [] } }, can_edit_firm: false });
    expect(db.calls.find((c) => /FROM ui_config/.test(c.sql)).params).toEqual([9]);
  });
});

describe('/api/firm-data `ui`', () => {
  afterEach(() => jest.restoreAllMocks());
  const ROWS = [
    { scope: 'firm', user_id: 0, config_key: 'registry_overrides', config: { hidden: ['bills'] } },
    { scope: 'user', user_id: 9, config_key: 'shortcuts', config: { bindings: [] } },
  ];

  test('JWT caller: firm + their user layer, built by uiConfigService.readFor; denied untouched', async () => {
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: tok(['staff']), db: makeDb({ uiRows: ROWS }) });
    expect(r.status).toBe(200);
    expect(r.body.ui).toEqual({ firm: { registry_overrides: { hidden: ['bills'] } }, user: { shortcuts: { bindings: [] } } });
    expect(r.body.denied).toEqual([]);
  });

  test('x-api-key caller: firm layer only (the user query matches no user)', async () => {
    const db = makeDb({ uiRows: ROWS });
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: { 'x-api-key': process.env.INTERNAL_API_KEY }, db });
    expect(r.status).toBe(200);
    expect(r.body.ui).toEqual({ firm: { registry_overrides: { hidden: ['bills'] } }, user: {} });
    expect(db.calls.find((c) => /FROM ui_config/.test(c.sql)).params).toEqual([null]);
  });

  test('fail-soft: a broken read → { firm: {}, user: {} } + a console error; the shell still boots', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: tok(['staff']), db: makeDb({ uiThrows: true }) });
    expect(r.status).toBe(200);
    expect(r.body.ui).toEqual({ firm: {}, user: {} });
    expect(r.body.currentUser).toBeTruthy();
    expect(spy.mock.calls.some((c) => /ui config load failed/.test(c.join(' ')))).toBe(true);
  });
});
