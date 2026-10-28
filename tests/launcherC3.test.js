// tests/launcherC3.test.js
//
/**
 * launcher-nits C3 — scripts/launcherC3MoreAdminPages.js, its pure core:
 * the plan (More and Admin become the firm pages firm:more / firm:admin; every
 * stored id moreFeatures / admin re-pointed), the validation, and the
 * VERIFICATION that stands between a wrong plan and a production write —
 * every user's Home, sidebar, small buttons, pages and shortcuts, computed
 * with the client's own code, before vs after.
 *
 * Synthetic rows shaped like the live ones (the live copy is dry-run on a
 * local MySQL, never committed: people's own buttons are in it). The real
 * engine: tests/launcherC3.mysql.test.js (gated on YC_TEST_MYSQL_URL).
 *
 * Run:  npx jest tests/launcherC3.test.js
 */

'use strict';

const C3 = require('../scripts/launcherC3MoreAdminPages');
const shape = require('../lib/uiConfigShape');

const J = (x) => JSON.parse(JSON.stringify(x));
const core = C3.loadCore();
const MORE = core.LAY.more.filter((e) => e.item).map((e) => e.item);

// the firm: More rearranged (a break dropped, Ask Casey off), Admin as shipped, Admin for it + admin
const FIRM_RO = { items: [{ id: 'firm:get-clio-code', icon: 'c', label: 'Get Clio Code', action: { key: 'clio-code', size: 'compact', type: 'tool', present: 'modal' } }],
  hidden: [], locked: [], renames: {}, retired: ['firm:clio-code-v2'], visible_to: { admin: ['it', 'admin'] } };
const FIRM_LAY = { placed: { more: [...MORE.filter((k) => k !== 'moreAssistant').map((item) => ({ item })), { item: 'firm:get-clio-code' }] }, removed: { more: ['moreAssistant'] } };
const row = (id, scope, uid, key, config) => ({ id, scope, user_id: uid, role: '', config_key: key, config: J(config), updated_at: '2026-10-28T00:00:00.000Z' });
function rows() {
  return [
    row(1, 'firm', 0, 'registry_overrides', FIRM_RO),
    row(2, 'firm', 0, 'layout', FIRM_LAY),
    // a user with Home + sidebar placed, More Features on both
    row(3, 'user', 1, 'layout', { placed: { home: [{ item: 'cases' }, { item: 'moreFeatures' }, { item: 'comms' }], sidebar: [{ label: 'Records' }, { item: 'cases' }, { label: 'Settings' }, { item: 'moreFeatures' }, { item: 'helpSupport' }] }, removed: { home: ['bills'] } }),
    // Fred: his own page holds Admin and More, a shortcut to Admin, a list holding More
    row(4, 'user', 6, 'layout', { placed: { home: [{ item: 'cases' }, { item: 'moreFeatures' }, { item: 'user:page' }] }, removed: {}, pages: { 'user:page': { tiles: [{ item: 'cases' }, { item: 'admin' }, { item: 'moreFeatures' }], icons: [{ item: 'moreFeatures' }] } } }),
    row(5, 'user', 6, 'shortcuts', { bindings: [{ id: 'admin', combo: { alt: false, key: 'x', ctrl: true, meta: true, shift: false } }, { id: 'all', combo: { alt: false, key: 'a', ctrl: true, meta: true, shift: false } }] }),
    row(6, 'user', 6, 'items', { items: [{ id: 'user:page', label: 'My page', icon: 'star', action: { type: 'page' } }, { id: 'user:box', label: 'Box', icon: 'box', action: { type: 'drawer', items: ['moreFeatures', 'tasks'] } }] }),
  ];
}
const USERS = [
  { uid: 1, roles: ['admin', 'staff', 'attorney'], denied: [] },
  { uid: 2, roles: ['staff'], denied: [] },            // no rows: the firm's layout only
  { uid: 6, roles: ['it', 'admin', 'form_dev', 'su'], denied: [] },
];
const doc = (writes, scope, uid, key) => (writes.find((w) => w.scope === scope && w.uid === uid && w.key === key) || {}).after;

describe('launcher-nits C3 — the plan', () => {
  test('the firm: two page items, Admin\'s audience copied, the pages hold what the hubs show, Home and the sidebar point at them', () => {
    const w = C3.plan(core, rows());
    expect(w.map((x) => [x.scope, x.uid, x.key])).toEqual([['firm', 0, 'registry_overrides'], ['firm', 0, 'layout'], ['user', 1, 'layout'], ['user', 6, 'layout'], ['user', 6, 'shortcuts'], ['user', 6, 'items']]);
    const ro = doc(w, 'firm', 0, 'registry_overrides');
    expect(ro.items.slice(1)).toEqual([
      { id: 'firm:more', label: 'More Features', icon: core.REG.moreFeatures.icon, action: { type: 'page' } },
      { id: 'firm:admin', label: 'Admin', icon: core.REG.admin.icon, action: { type: 'page' } },
    ]);
    expect(ro.visible_to).toEqual({ admin: ['it', 'admin'], 'firm:admin': ['it', 'admin'] });
    expect(ro.retired).toBeUndefined();                                     // the service's
    const lay = doc(w, 'firm', 0, 'layout');
    expect(lay.pages['firm:more'].tiles.map((e) => e.item || '|')).toEqual([...MORE.filter((k) => k !== 'moreAssistant'), 'firm:get-clio-code']);
    expect(lay.pages['firm:more'].icons).toEqual(core.LAY.moreIcons.map((e) => ({ item: e.item })));
    expect(lay.pages['firm:admin'].tiles).toEqual(core.LAY.admin.map((e) => (e.item ? { item: e.item } : { break: true })));
    expect(lay.placed.sidebar.map((e) => e.item || '#' + e.label)).toContain('firm:admin');
    expect(lay.placed.sidebar.map((e) => e.item)).not.toContain('admin');
    expect(lay.placed.home.map((e) => e.item)).toContain('firm:more');
    expect(lay.removed).toEqual({ more: ['moreAssistant'], sidebar: ['moreFeatures', 'admin'], home: ['moreFeatures'] });
    expect(lay.placed.more).toEqual(FIRM_LAY.placed.more);                 // the hub's lists stay until C4
    expect(C3.validationProblems(w)).toEqual([]);
  });

  test('every stored id re-pointed: placed, removed, own pages, shortcuts, list contents', () => {
    const w = C3.plan(core, rows());
    expect(doc(w, 'user', 1, 'layout').placed.sidebar.map((e) => e.item || '#' + e.label)).toEqual(['#Records', 'cases', '#Settings', 'firm:more', 'helpSupport']);
    const f = doc(w, 'user', 6, 'layout');
    expect(f.placed.home.map((e) => e.item)).toEqual(['cases', 'firm:more', 'user:page']);
    expect(f.pages['user:page']).toEqual({ tiles: [{ item: 'cases' }, { item: 'firm:admin' }, { item: 'firm:more' }], icons: [{ item: 'firm:more' }] });
    expect(doc(w, 'user', 6, 'shortcuts').bindings.map((b) => b.id)).toEqual(['firm:admin', 'all']);
    expect(doc(w, 'user', 6, 'items').items[1].action.items).toEqual(['firm:more', 'tasks']);
    // no stored reference to an old id in anyone's own documents, nor in the firm's placed lists or pages
    // (the firm's removed lists name them on purpose; visible_to keeps the old key, and 'admin' is also a role)
    const ref = /"(?:item|id)":"(?:moreFeatures|admin)"|\["?(?:moreFeatures|admin)"?[,\]]/;
    for (const x of w.filter((x) => x.scope === 'user')) expect([x.uid, x.key, ref.test(JSON.stringify(x.after))]).toEqual([x.uid, x.key, false]);
    const lay = doc(w, 'firm', 0, 'layout');
    for (const sf of ['home', 'sidebar']) expect(JSON.stringify(lay.placed[sf])).not.toMatch(/"item":"(?:moreFeatures|admin)"/);
    expect(JSON.stringify(lay.pages)).not.toMatch(/"item":"(?:moreFeatures|admin)"/);
  });

  test('idempotent: the plan applied plans nothing; a page the firm already has is kept as it is', () => {
    const after = C3.applyPlan(rows(), C3.plan(core, rows()));
    expect(C3.plan(core, after)).toEqual([]);
    const pre = rows();
    pre[1].config.pages = { 'firm:more': { tiles: [{ item: 'moreManuals' }] } };
    expect(doc(C3.plan(core, pre), 'firm', 0, 'layout').pages['firm:more']).toEqual({ tiles: [{ item: 'moreManuals' }] });
  });

  test('More\'s firm row: with no placed.more, the firm\'s own items close the More page (as the shell draws them)', () => {
    const pre = rows();
    pre[1].config = { placed: {}, removed: {} };
    const tiles = doc(C3.plan(core, pre), 'firm', 0, 'layout').pages['firm:more'].tiles;
    expect(tiles.slice(-2)).toEqual([{ break: true }, { item: 'firm:get-clio-code' }]);
  });
});

describe('launcher-nits C3 — the verification catches a wrong plan', () => {
  const ok = () => C3.verify(core, rows(), C3.applyPlan(rows(), C3.plan(core, rows())), USERS);
  test('the plan verifies for every user', () => { expect(ok()).toEqual([]); });

  const broken = (mutate) => {
    const w = C3.plan(core, rows());
    mutate(w);
    return C3.verify(core, rows(), C3.applyPlan(rows(), w), USERS);
  };
  test.each([
    ['the hub rows not removed from the sidebar (both would show)', (w) => { doc(w, 'firm', 0, 'layout').removed.sidebar = []; }, /user 2 sidebar/],
    ['Admin\'s audience not copied (everyone would see the Admin page)', (w) => { delete doc(w, 'firm', 0, 'registry_overrides').visible_to['firm:admin']; }, /user 2: firm:admin is theirs, admin was not/],
    ['a tile missing from the More page', (w) => { doc(w, 'firm', 0, 'layout').pages['firm:more'].tiles.splice(0, 1); }, /firm:more:tiles/],
    ['Admin\'s page out of order', (w) => { doc(w, 'firm', 0, 'layout').pages['firm:admin'].tiles.reverse(); }, /firm:admin:tiles/],
    ['a user\'s sidebar not re-pointed', (w) => { const d = doc(w, 'user', 1, 'layout'); d.placed.sidebar = d.placed.sidebar.map((e) => (e.item === 'firm:more' ? { item: 'moreFeatures' } : e)); }, /user 1 sidebar/],
    ['a shortcut not re-pointed', (w) => { doc(w, 'user', 6, 'shortcuts').bindings[0].id = 'admin'; }, /user 6 shortcuts/],
  ])('%s', (_, mutate, re) => {
    expect(broken(mutate).join('\n')).toMatch(re);
  });
});

describe('launcher-nits C3 — the digest', () => {
  test('any change to any row changes it; key order does not (MySQL re-orders JSON keys)', () => {
    const a = rows(), b = rows();
    expect(C3.digestOf(a)).toBe(C3.digestOf(b));
    const flip = (v) => (Array.isArray(v) ? v.map(flip) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, flip(v[k])])) : v);
    b[2].config = flip(b[2].config);
    expect(JSON.stringify(b[2].config)).not.toBe(JSON.stringify(a[2].config));   // really reordered
    expect(C3.digestOf(a)).toBe(C3.digestOf(b));
    b[4].config.bindings[1].id = 'tasks';
    expect(C3.digestOf(a)).not.toBe(C3.digestOf(b));
    expect(shape.canonical({ b: 1, a: 2 })).toBe(shape.canonical({ a: 2, b: 1 }));
  });
});
