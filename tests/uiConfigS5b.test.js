// tests/uiConfigS5b.test.js
//
/**
 * ui-custom S5b — drawers, the validator (lib/uiConfigShape.js).
 *
 * A drawer is one more kind of a user's own button (the S5a `items`
 * document): { id, label, icon, action: { type: 'drawer', items: [ref…] } }.
 *   - user items only: a firm item can't be one (the firm grammar is
 *     unchanged, message included);
 *   - no present, no size; no other field;
 *   - items: required, an array, ≤ 30 (refused at the cap, before an entry is
 *     read), no duplicates, each a registry / firm / user id;
 *   - one level deep: a ref naming a drawer of the same document is refused
 *     (itself included; a drawer with an error elsewhere still counts);
 *   - other refs are soft: an unknown id, a user id the document doesn't hold
 *     — kept, the shell drops them at draw time;
 *   - a deleted drawer's id is retired like any button's (the REAL
 *     uiConfigService.write on an in-memory connection).
 * Adversarial bodies stay linear (timed).
 *
 * Mutation-checked (see the S5b worker report).
 *
 * Run:  npx jest tests/uiConfigS5b.test.js
 */

'use strict';

const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');

const I = (d) => shape.validate('user', 'items', d);
const errs = (r) => r.errors.join(' | ');
const VIEW = { id: 'user:leads', label: 'Leads', icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } };
const LINK = { id: 'user:court', label: 'Court', icon: 'gavel', action: { type: 'url', href: 'https://ecf.example.gov/', present: 'window' } };
const D = (items, over = {}) => ({ id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items }, ...over });

describe('a drawer: one more kind of user button', () => {
  test('accepted with registry, firm and user refs, in their order; normalized to { type, items }; an empty drawer is valid', () => {
    const r = I({ items: [VIEW, D(['cases', 'firm:payroll', 'user:leads', 'moreDocuments'])] });
    expect(r.ok).toBe(true);
    expect(r.value.items[1]).toEqual({ id: 'user:box', label: 'My box', icon: 'box-open', action: { type: 'drawer', items: ['cases', 'firm:payroll', 'user:leads', 'moreDocuments'] } });
    expect(I({ items: [D([])] }).value.items[0].action).toEqual({ type: 'drawer', items: [] });
    expect(shape.CAPS.drawer).toBe(30);
    expect(Object.keys(shape.USER_ACTION_SHAPES)).toEqual(['url', 'tool', 'view', 'page', 'drawer']);   // page: S6c-5
    expect(Object.keys(shape.ACTION_SHAPES)).toEqual(['url', 'tool', 'view', 'page']);   // page: S6c-5 (firm pages)
  });

  test('refused for a firm item: the firm grammar and its message are unchanged', () => {
    const ro = (d) => shape.validate('firm', 'registry_overrides', d);
    expect(ro({ items: [D(['cases'], { id: 'firm:box' })] }).errors).toEqual(['items[0]: action.type must be one of url, tool, view, page']);   // page at both tiers: S6c-5
    // a user document names the new kind in its message
    expect(errs(I({ items: [{ ...VIEW, action: { type: 'iframe', present: 'modal' } }] }))).toBe('items[0]: action.type must be one of url, tool, view, page, drawer');
  });

  test('no present, no size, no other field', () => {
    expect(I({ items: [D(['cases'], { action: { type: 'drawer', items: ['cases'], present: 'modal' } })] }).errors)
      .toEqual(['items[0]: a drawer has no present or size (it opens its own list)']);
    expect(I({ items: [D(['cases'], { action: { type: 'drawer', items: ['cases'], size: 'compact' } })] }).errors)
      .toEqual(['items[0]: a drawer has no present or size (it opens its own list)']);
    expect(I({ items: [D(['cases'], { action: { type: 'drawer', items: ['cases'], href: 'https://x.example/' } })] }).errors)
      .toEqual(['items[0].action: unknown field "href"']);
    expect(I({ items: [D(['cases'], { action: { type: 'drawer', items: ['cases'], onclick: 'x()' } })] }).errors)
      .toEqual(['items[0].action: unknown field "onclick"']);
  });

  test('items: required, an array of item ids', () => {
    expect(I({ items: [D(undefined)] }).errors).toEqual(['items[0]: a drawer\'s items must be an array of item ids']);
    expect(I({ items: [D('cases')] }).errors).toEqual(['items[0]: a drawer\'s items must be an array of item ids']);
    expect(I({ items: [D({ 0: 'cases' })] }).errors).toEqual(['items[0]: a drawer\'s items must be an array of item ids']);
    expect(I({ items: [D(['cases', 5, '', 'user:Bad', 'firm:', 'a b', null])] }).errors).toEqual([
      'items[0].action.items[1]: not an item id', 'items[0].action.items[2]: not an item id', 'items[0].action.items[3]: not an item id',
      'items[0].action.items[4]: not an item id', 'items[0].action.items[5]: not an item id', 'items[0].action.items[6]: not an item id',
    ]);
  });

  test('cap: 30 refs; 31 is ONE cap error, refused before an entry is read', () => {
    const refs = (n) => Array.from({ length: n }, (_, i) => 'item' + i);
    expect(I({ items: [D(refs(30))] }).ok).toBe(true);
    expect(I({ items: [D(refs(31))] }).errors).toEqual(['items[0]: a drawer holds at most 30 items']);
    expect(I({ items: [D(refs(30).concat('not an id'))] }).errors).toEqual(['items[0]: a drawer holds at most 30 items']);
  });

  test('no duplicates', () => {
    expect(I({ items: [D(['cases', 'tasks', 'cases'])] }).errors).toEqual(['items[0].action.items[2]: cases is already in this drawer']);
  });

  test('depth 1: a ref to another drawer of the document is refused — itself included; a broken drawer still counts', () => {
    const other = D(['tasks'], { id: 'user:other', label: 'Other' });
    expect(I({ items: [other, D(['cases', 'user:other'])] }).errors)
      .toEqual(['items[1].action.items[1]: user:other is a drawer — a drawer can\'t hold a drawer']);
    expect(I({ items: [D(['user:box'])] }).errors).toEqual(['items[0].action.items[0]: user:box is a drawer — a drawer can\'t hold a drawer']);
    // the other drawer has a bad label, and is still a drawer
    const broken = { ...other, label: '' };
    expect(I({ items: [broken, D(['user:other'])] }).errors).toEqual([
      'items[0]: label must be 1-40 characters', 'items[1].action.items[0]: user:other is a drawer — a drawer can\'t hold a drawer']);
    // review N3: one broken in another way — no items array at all — still counts
    const noItems = { ...other, action: { type: 'drawer' } };
    expect(I({ items: [noItems, D(['user:other'])] }).errors).toEqual([
      'items[0]: a drawer\'s items must be an array of item ids', 'items[1].action.items[0]: user:other is a drawer — a drawer can\'t hold a drawer']);
    // a button that is not a drawer is fine, before or after the drawer
    expect(I({ items: [D(['user:leads', 'user:court']), VIEW, LINK] }).ok).toBe(true);
  });

  test('other refs are soft: an id the registry, the firm or this document doesn\'t hold is kept', () => {
    const r = I({ items: [D(['notARealItem', 'firm:gone', 'user:gone', 'user:old'])], retired: ['user:old'] });
    expect(r.ok).toBe(true);
    expect(r.value.items[0].action.items).toEqual(['notARealItem', 'firm:gone', 'user:gone', 'user:old']);
  });

  test('a user layout and user shortcuts may name a drawer (it is a user: id)', () => {
    expect(shape.validate('user', 'layout', { placed: { home: [{ item: 'user:box' }], sidebar: [{ item: 'user:box' }] } }).ok).toBe(true);
    expect(shape.validate('user', 'shortcuts', { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'b' }, id: 'user:box' }] }).ok).toBe(true);
  });

  test('a deleted drawer\'s id is retired (the REAL uiConfigService.write): a new button can\'t take it', async () => {
    const rows = new Map();
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, p = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) { const k = p.slice(0, 3).join('|'); return [rows.has(k) ? [{ id: 1, config: rows.get(k) }] : []]; }
        if (/^INSERT INTO ui_config /.test(s)) { rows.set(p.slice(0, 3).join('|'), p[3]); return [{ insertId: 1 }]; }
        throw new Error('unscripted ' + s);
      },
    };
    const db = { getConnection: async () => conn, query: async () => { throw new Error('no pool'); } };
    const actor = { type: 'jwt', userId: 9, roles: ['staff'] };
    const put = (config) => svc.write(db, { scope: 'user', config_key: 'items', config }, actor);
    await put({ items: [VIEW, D(['cases', 'user:leads'])] });
    const r = await put({ items: [VIEW] });
    expect(r.config).toEqual({ items: [VIEW], retired: ['user:box'] });
    await expect(put({ items: [VIEW, D([])] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('adversarial bodies stay linear', () => {
  const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  test('50 drawers of 30 long refs, and a 31-ref drawer of 200 KB ids, each well under a second', () => {
    const long = (c, n) => c.repeat(n);
    const drawers = Array.from({ length: 50 }, (_, i) => D(Array.from({ length: 30 }, (_, k) => 'a' + long('B', 60) + k + i).map((x) => x.slice(0, 64)), { id: 'user:d' + i }));
    expect(time(() => I({ items: drawers }))).toBeLessThan(1000);
    const big = 'user:' + long('a', 200000) + '!';     // one string, shared (invalid refs are never de-duplicated)
    const bad = Array.from({ length: 50 }, (_, i) => D(Array.from({ length: 30 }, () => big), { id: 'user:x' + i }));
    expect(time(() => I({ items: bad }))).toBeLessThan(1000);
    const huge = [D(Array.from({ length: 31 }, () => long('a', 200000)))];
    expect(time(() => I({ items: huge }))).toBeLessThan(200);
  });
});
