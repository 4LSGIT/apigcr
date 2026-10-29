// tests/uiConfigS6c5.test.js
//
/**
 * ui-custom S6c-5 — pages in lib/uiConfigShape.js: the `{ type:'page' }` item
 * kind (firm items and a user's own buttons) and the layout's `pages` map
 * (S6c_DESIGN.md §4.2, §5 S6c-5; Fred's ruling Q4).
 *
 *   - An item of kind page carries nothing but its type: present / size /
 *     any other key is refused, at both tiers; the normalized action is
 *     exactly { type:'page' }.
 *   - layout.pages { <pageId>: { tiles?, icons? } }: the keys are the SCOPE's
 *     own page ids (firm: for the firm document, user: for a user's), ≤ 50;
 *     tiles take the grid grammar (item | break, ≤100, an item once), icons
 *     the icon-row grammar (item only, ≤12), refs per scope; a list left out
 *     stays out; an empty page is valid. Errors name pages.<id>.<part>[i].
 *   - What stood before still normalizes to itself: every S6c document shape
 *     (no pages) is byte-identical through the new validator.
 *   - The real uiConfigService stores a firm layout with pages (scripted
 *     connection; the engine run is tests/uiConfigS6c.mysql.test.js).
 *
 * Mutation-checked (see local/ui-custom/S6c5_worker_report.md).
 *
 * Run:  npx jest tests/uiConfigS6c5.test.js
 */

'use strict';

const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');

const errs = (r) => r.errors.join(' | ');
const F = (doc) => shape.validate('firm', 'layout', doc);
const U = (doc) => shape.validate('user', 'layout', doc);
const RO = (items) => shape.validate('firm', 'registry_overrides', { items });
const MINE = (items) => shape.validate('user', 'items', { items });
const page = (id, action) => ({ id, label: 'Ops', icon: 'layer-group', action });

describe('the page item kind', () => {
  test('{ type:"page" } is accepted at both tiers and normalizes to exactly itself', () => {
    expect(RO([page('firm:ops', { type: 'page' })]).value.items[0]).toEqual(page('firm:ops', { type: 'page' }));
    expect(MINE([page('user:ops', { type: 'page' })]).value.items[0]).toEqual(page('user:ops', { type: 'page' }));
    expect(shape.ACTION_SHAPES.page).toEqual({ keys: ['type'], present: [] });
    expect(shape.USER_ACTION_SHAPES.page).toEqual({ keys: ['type'], present: [] });
  });

  test('a page carries nothing else: present, size or any other key is refused', () => {
    for (const [v, bad] of [[RO, 'firm:ops'], [MINE, 'user:ops']]) {
      expect(errs(v([page(bad, { type: 'page', present: 'modal' })]))).toMatch(/items\[0\]: a page has no present or size/);
      expect(errs(v([page(bad, { type: 'page', size: 'large' })]))).toMatch(/items\[0\]: a page has no present or size/);
      expect(errs(v([page(bad, { type: 'page', items: [] })]))).toBe('items[0].action: unknown field "items"');
      expect(errs(v([page(bad, { type: 'page', key: 'x' })]))).toBe('items[0].action: unknown field "key"');
    }
    // the other kinds are untouched
    expect(RO([page('firm:x', { type: 'url', href: 'https://x.example/', present: 'window' })]).ok).toBe(true);
    expect(MINE([page('user:x', { type: 'drawer', items: ['cases'] })]).ok).toBe(true);
  });
});

describe('layout.pages', () => {
  const TILES = [{ item: 'moreAutomations' }, { break: true }, { item: 'adminUsers' }, { item: 'firm:clio-code' }];
  const ICONS = [{ item: 'casey' }, { item: 'all' }];

  test('a well-formed map round-trips; a list left out stays out; an empty page is fine', () => {
    const doc = { pages: { 'firm:ops': { tiles: TILES, icons: ICONS }, 'firm:empty': {}, 'firm:tiles': { tiles: [] } } };
    const r = F(doc);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ placed: {}, removed: {}, pages: doc.pages });
    expect(shape.canonical(F(r.value).value)).toBe(shape.canonical(r.value));
    const u = U({ pages: { 'user:desk': { tiles: [{ item: 'user:leads' }, { item: 'cases' }], icons: [{ item: 'user:leads' }] } } });
    expect(u.ok).toBe(true);
    expect(u.value.pages['user:desk'].tiles).toEqual([{ item: 'user:leads' }, { item: 'cases' }]);
    // absent stays absent
    expect(F({ placed: { home: [] } }).value).toEqual({ placed: { home: [] }, removed: {} });
    expect(F({ placed: { home: [] } }).value).not.toHaveProperty('pages');
  });

  test('keys: a tier names only its own pages — firm: for the firm, user: for a user; anything else is refused by name', () => {
    expect(errs(F({ pages: { 'user:ops': {} } }))).toBe('pages.user:ops: not a firm page id (firm:…)');
    expect(errs(U({ pages: { 'firm:ops': {} } }))).toBe('pages.firm:ops: not one of your page ids (user:…)');
    expect(errs(F({ pages: { moreFeatures: {} } }))).toBe('pages.moreFeatures: not a firm page id (firm:…)');
    expect(errs(U({ pages: { 'user:Bad Id': {} } }))).toBe('pages.user:Bad Id: not one of your page ids (user:…)');
    expect(errs(F({ pages: { 'firm:ops': 1 } }))).toBe('pages.firm:ops must be an object { tiles?, icons? }');
    expect(errs(F({ pages: { 'firm:ops': { nope: 1 } } }))).toBe('pages.firm:ops: unknown field "nope"');
  });

  test('tiles take the grid grammar, icons the icon-row grammar; refs per scope; errors name the page and the part', () => {
    const r = F({ pages: { 'firm:ops': {
      tiles: [{ item: 'a' }, { label: 'x' }, { item: 'a' }, { break: 1 }, { item: 'user:y' }, { nope: 1 }],
      icons: [{ break: true }, { item: 'b' }, { item: 'b' }],
    } } });
    expect(r.ok).toBe(false);
    const e = errs(r);
    expect(e).toMatch(/pages\.firm:ops\.tiles\[1\]: a label is for the sidebar only/);
    expect(e).toMatch(/pages\.firm:ops\.tiles\[2\]: a is already placed at pages\.firm:ops\.tiles\[0\]/);
    expect(e).toMatch(/pages\.firm:ops\.tiles\[3\]: break must be true/);
    expect(e).toMatch(/pages\.firm:ops\.tiles\[4\]: not an item id/);
    expect(e).toMatch(/pages\.firm:ops\.tiles\[5\]: unknown field "nope" \(an entry is \{ item \} or \{ break: true \}\)/);
    expect(e).toMatch(/pages\.firm:ops\.icons\[0\]: a break is for a grid \(Home, a page's tiles\) only/);
    expect(e).toMatch(/pages\.firm:ops\.icons\[2\]: b is already placed at pages\.firm:ops\.icons\[1\]/);
    // a user's page may name their own buttons; a firm's may not
    expect(U({ pages: { 'user:d': { tiles: [{ item: 'user:y' }], icons: [{ item: 'user:y' }] } } }).ok).toBe(true);
    expect(errs(F({ pages: { 'firm:d': { icons: [{ item: 'user:y' }] } } }))).toBe('pages.firm:d.icons[0]: not an item id');
  });

  test('caps: at most 50 pages, 100 tiles, 12 icons — refused at the length check before an entry is read', () => {
    const many = (n, k) => Object.fromEntries(Array.from({ length: n }, (_, i) => [k + i, {}]));
    expect(F({ pages: many(50, 'firm:p') }).ok).toBe(true);
    expect(errs(F({ pages: many(51, 'firm:p') }))).toBe('pages: at most 50 pages');
    expect(errs(U({ pages: many(51, 'user:p') }))).toBe('pages: at most 50 pages');
    expect(shape.CAPS.pages).toBe(50);
    const junk = (n) => Array.from({ length: n }, () => ({ nope: 1 }));
    expect(errs(F({ pages: { 'firm:p': { tiles: junk(101) } } }))).toBe('pages.firm:p.tiles: at most 100 entries');
    expect(errs(F({ pages: { 'firm:p': { icons: junk(13) } } }))).toBe('pages.firm:p.icons: at most 12 entries');
    expect(errs(F({ pages: { 'firm:p': { tiles: 'x', icons: null } } }))).toBe('pages.firm:p.tiles must be an array | pages.firm:p.icons must be an array');
    expect(F({ pages: { 'firm:p': { tiles: Array.from({ length: 100 }, (_, i) => ({ item: 'i' + i })), icons: Array.from({ length: 12 }, (_, i) => ({ item: 'i' + i })) } } }).ok).toBe(true);
  });

  test('PAGE_PARTS maps each list to the surface whose grammar it borrows', () => {
    expect(shape.PAGE_PARTS).toEqual({ tiles: 'more', icons: 'moreIcons' });
  });

  test('what stood before: every S6c document shape (no pages) normalizes exactly as it did', () => {
    const docs = [
      [F, {}], [F, { placed: {}, removed: {} }],
      [F, { placed: { home: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }], homeIcons: [{ item: 'casey' }] }, removed: { sidebar: ['adminDbConsole'] } }],
      [F, { placed: { home: [{ item: 'cases' }], sidebar: [{ label: 'Mine' }, { item: 'tasks' }], homeIcons: [{ item: 'all' }] } }],
      [U, { placed: { home: [{ item: 'user:y' }, { break: true }], sidebar: [{ item: 'firm:x' }], homeIcons: [{ item: 'all' }, { item: 'myTasks' }] }, removed: { home: ['bills'], sidebar: ['log'], homeIcons: ['casey'] } }],
      [U, {}], [U, { removed: { home: [] } }],
    ];
    for (const [v, d] of docs) {
      const r = v(d);
      expect([d, r.ok]).toEqual([d, true]);
      expect(r.value).toEqual({ placed: d.placed || {}, removed: d.removed || {} });
      expect(r.value).not.toHaveProperty('pages');
      expect(shape.canonical(v(r.value).value)).toBe(shape.canonical(r.value));
    }
    // and the old refusals stand
    expect(U({ placed: { more: [] } }).ok).toBe(false);
    expect(F({ removed: { homeIcons: ['all'] } }).ok).toBe(false);
    expect(F({ removed: ['x'] }).ok).toBe(false);
  });
});

describe('write(): a firm layout with pages is stored and versioned like any firm layout', () => {
  const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
  function txDb(stored, head = 7) {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push({ s, params });
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) return [stored ? [{ id: 5, config: JSON.stringify(stored) }] : []];
        if (/^SELECT MAX\(id\) AS id FROM ui_config_versions/.test(s)) return [[{ id: stored ? head : null }]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 5 }];
        if (/^INSERT INTO ui_config_versions /.test(s)) return [{ insertId: 8 }];
        throw new Error('unscripted statement: ' + s);
      },
    };
    return { stmts, writes: () => stmts.filter((x) => /^(INSERT|UPDATE|DELETE)\b/.test(x.s)), getConnection: async () => conn, query: async () => { throw new Error('no'); } };
  }
  const DOC = { placed: { home: [{ item: 'moreReports' }] }, removed: {}, pages: { 'firm:ops': { tiles: [{ item: 'moreAutomations' }, { break: true }, { item: 'adminUsers' }], icons: [{ item: 'casey' }] } } };

  test('stored with its pages, one version; a user key in the firm map is a 400 that writes nothing; a user layout with pages is their own row', async () => {
    const db = txDb(null);
    const r = await svc.write(db, { scope: 'firm', config_key: 'layout', config: DOC }, admin);
    expect([r.changed, r.versioned, r.version_id]).toEqual([true, true, 8]);
    expect(r.config).toEqual(DOC);
    expect(JSON.parse(db.writes()[0].params[3])).toEqual(DOC);
    const bad = txDb(null);
    const e = await svc.write(bad, { scope: 'firm', config_key: 'layout', config: { pages: { 'user:x': {} } } }, admin).catch((x) => x);
    expect([e.status, e.errors]).toEqual([400, ['pages.user:x: not a firm page id (firm:…)']]);
    expect(bad.writes()).toEqual([]);
    const u = txDb(null);
    const mine = { pages: { 'user:desk': { tiles: [{ item: 'cases' }, { item: 'user:leads' }] } } };
    const ur = await svc.write(u, { scope: 'user', config_key: 'layout', config: mine }, { type: 'jwt', userId: 9, roles: ['staff'] });
    expect([ur.changed, ur.versioned, ur.config]).toEqual([true, false, { placed: {}, removed: {}, pages: mine.pages }]);
    expect(u.writes()[0].params.slice(0, 3)).toEqual(['user', 9, 'layout']);
  });
});
