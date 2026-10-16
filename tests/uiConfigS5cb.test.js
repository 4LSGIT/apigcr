// tests/uiConfigS5cb.test.js
//
/**
 * ui-custom S5c-b — a user's own tool / view button may open as a TAB; the
 * validator side (lib/uiConfigShape.js) and its client twin (ycLauncher's
 * cleanUserItem / cleanFirmItem in public/index.html).
 *
 *   - present:'tab' is accepted for a USER tool / view, normalized without a
 *     size; a size with it is refused (size is the dialog's preset);
 *   - refused for a link (a link always opens a new window) and for a drawer
 *     (it has no present);
 *   - refused for a FIRM item with the firm's message unchanged (firm items
 *     stay modal-only in v1);
 *   - the client keeps exactly what the server accepts, over one fixture set
 *     (parity), and its present lists are the server's.
 *
 * Mutation-checked (see the S5c-b worker report).
 *
 * Run:  npx jest tests/uiConfigS5cb.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const shape = require('../lib/uiConfigShape');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];

const I = (config) => shape.validate('user', 'items', config);
const RO = (config) => shape.validate('firm', 'registry_overrides', config);
const errs = (r) => r.errors.join(' | ');
const BTN = (over = {}) => ({ id: 'user:b', label: 'B', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' }, ...over });
const FIRM = (over = {}) => ({ id: 'firm:f', label: 'F', icon: 'star', action: { type: 'tool', key: 'clio-code', present: 'modal' }, ...over });

function client() {
  const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL, document: { getElementById: () => null } });
  ctx.window = ctx;
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  return ctx.window.ycLauncher;
}

describe('user items: present "tab"', () => {
  test('a tool and a view may open as a tab; normalized as written (no size added)', () => {
    const tool = BTN({ id: 'user:t', action: { type: 'tool', key: 'call-review', present: 'tab' } });
    const view = BTN({ id: 'user:v', action: { type: 'view', key: 'lead_followups', present: 'tab' } });
    const r = I({ items: [tool, view] });
    expect([r.ok, r.errors]).toEqual([true, []]);
    expect(r.value.items).toEqual([tool, view]);
  });

  test('a tab has no size: either size is refused with a message', () => {
    for (const size of ['compact', 'large']) {
      const r = I({ items: [BTN({ action: { type: 'tool', key: 'call-review', present: 'tab', size } })] });
      expect([size, r.ok, errs(r)]).toEqual([size, false, 'items[0]: a tab has no size (size is the dialog\'s preset)']);
    }
    // a bad size still names the size rule first (one message, not two)
    expect(errs(I({ items: [BTN({ action: { type: 'view', key: 'lead_followups', present: 'tab', size: 'huge' } })] })))
      .toBe('items[0]: size must be "compact" or "large"');
  });

  test('a link never opens as a tab (it always opens a new window); a drawer has no present', () => {
    const link = I({ items: [BTN({ action: { type: 'url', href: 'https://x.example/', present: 'tab' } })] });
    expect(errs(link)).toBe('items[0]: present "tab" is for tools and saved views: a link always opens in a new window, never inside YisraCase');
    const drawer = I({ items: [BTN({ action: { type: 'drawer', items: [], present: 'tab' } })] });
    expect(errs(drawer)).toMatch(/a drawer has no present or size/);
  });

  test('other presents stay refused for a tool / view (window, junk), naming both allowed values', () => {
    for (const present of ['window', 'Tab', '', undefined]) {
      const r = I({ items: [BTN({ action: { type: 'tool', key: 'x', present } })] });
      expect([String(present), r.ok, errs(r)]).toEqual([String(present), false, 'items[0]: a tool item\'s present must be "modal" or "tab"']);
    }
  });

  test('modal buttons are unchanged (size optional, absent stays absent)', () => {
    const a = BTN({ action: { type: 'tool', key: 'x', present: 'modal' } });
    const b = BTN({ id: 'user:c', action: { type: 'view', key: 'lead_followups', present: 'modal', size: 'compact' } });
    expect(I({ items: [a, b] }).value.items).toEqual([a, b]);
  });
});

describe('firm items stay modal-only (v1)', () => {
  test('a firm tool / view with present "tab" is refused with the firm\'s unchanged message', () => {
    for (const a of [{ type: 'tool', key: 'clio-code', present: 'tab' }, { type: 'view', key: 'lead_followups', present: 'tab' }]) {
      expect([a.type, errs(RO({ items: [FIRM({ action: a })] }))]).toEqual([a.type, 'items[0]: present "tab" is not available yet']);
    }
    // with a size too: still ONLY the firm's refusal (byte-identical to before S5c-b — the size rule is for user tabs)
    expect(RO({ items: [FIRM({ action: { type: 'view', key: 'lead_followups', present: 'tab', size: 'compact' } })] }).errors)
      .toEqual(['items[0]: present "tab" is not available yet']);
    expect(shape.ACTION_SHAPES.tool.present).toEqual(['modal']);
    expect(shape.ACTION_SHAPES.view.present).toEqual(['modal']);
  });
  test('the user shapes add "tab" to tool / view only (links stay window-only)', () => {
    expect(shape.USER_ACTION_SHAPES.tool.present).toEqual(['modal', 'tab']);
    expect(shape.USER_ACTION_SHAPES.view.present).toEqual(['modal', 'tab']);
    expect(shape.USER_ACTION_SHAPES.url.present).toEqual(['window']);
    expect(Object.keys(shape.USER_ACTION_SHAPES)).toEqual(['url', 'tool', 'view', 'drawer']);
  });
});

describe('the client keeps exactly what the server accepts (parity)', () => {
  const CL = client();
  const USER_FIX = [
    BTN({ action: { type: 'tool', key: 'call-review', present: 'tab' } }),
    BTN({ action: { type: 'view', key: 'lead_followups', present: 'tab' } }),
    BTN({ action: { type: 'tool', key: 'call-review', present: 'tab', size: 'compact' } }),
    BTN({ action: { type: 'view', key: 'lead_followups', present: 'tab', size: 'large' } }),
    BTN({ action: { type: 'view', key: 'lead_followups', present: 'tab', size: 'huge' } }),
    BTN({ action: { type: 'url', href: 'https://x.example/', present: 'tab' } }),
    BTN({ action: { type: 'url', href: '/manuals.html', present: 'tab' } }),
    BTN({ action: { type: 'tool', key: 'Bad Key', present: 'tab' } }),
    BTN({ action: { type: 'view', key: 'ab', present: 'tab' } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'Tab' } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'window' } }),
    BTN({ action: { type: 'drawer', items: [], present: 'tab' } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'tab', extra: 1 } }),
    BTN({ action: { type: 'tool', key: 'x', present: 'modal', size: 'compact' } }),
  ];
  test.each(USER_FIX.map((f, i) => [i, f]))('user fixture %i', (_, f) => {
    const server = I({ items: [f] });
    const c = CL.cleanUserItem(f);
    expect(c === null ? null : JSON.parse(JSON.stringify(c))).toEqual(server.ok ? server.value.items[0] : null);
  });
  const FIRM_FIX = [
    FIRM({ action: { type: 'tool', key: 'clio-code', present: 'tab' } }),
    FIRM({ action: { type: 'view', key: 'lead_followups', present: 'tab' } }),
    FIRM({ action: { type: 'tool', key: 'clio-code', present: 'modal' } }),
  ];
  test.each(FIRM_FIX.map((f, i) => [i, f]))('firm fixture %i', (_, f) => {
    const server = RO({ items: [f] });
    const c = CL.cleanFirmItem(f);
    expect(c === null ? null : JSON.parse(JSON.stringify(c))).toEqual(server.ok ? server.value.items[0] : null);
  });
  test('the client\'s present lists are the server\'s (FIRM_ACTIONS = ACTION_SHAPES, USER_ACTIONS = USER_ACTION_SHAPES)', () => {
    const src = RENDERER_SRC;
    const block = (name) => src.slice(src.indexOf('var ' + name + ' = {'), src.indexOf('};', src.indexOf('var ' + name + ' = {')));
    const firm = block('FIRM_ACTIONS'), user = block('USER_ACTIONS');
    for (const k of ['tool', 'view']) {
      expect(firm).toMatch(new RegExp(`${k}: \\{[^}]*present: ${JSON.stringify(shape.ACTION_SHAPES[k].present).replace(/"/g, "'").replace(/[[\]]/g, '\\$&')}`));
      expect(user).toMatch(new RegExp(`${k}: \\{[^}]*present: ${JSON.stringify(shape.USER_ACTION_SHAPES[k].present).replace(/"/g, "'").replace(/,/g, ', ').replace(/[[\]]/g, '\\$&')}`));
    }
    expect(user).toMatch(/url: {2}FIRM_ACTIONS\.url/);
  });
});
