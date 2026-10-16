// tests/uiConfigS6c.test.js
//
/**
 * ui-custom S6c-2 — the firm's default `layout` and the user layout's icon
 * row, in lib/uiConfigShape.js + services/uiConfigService.js
 * (S6c_DESIGN.md §4.2, §5 S6c-2; Fred's rulings 1, 3, 4).
 *
 *   - `layout` is a key of BOTH scopes: the firm's covers every launcher
 *     surface (home, sidebar, homeIcons, more, moreIcons, admin, adminIcons);
 *     a user's stays home / sidebar / homeIcons. The same grammar at both
 *     tiers: a break on a grid, a label on the sidebar, an icon row takes
 *     { item } only and at most 12 (refused at the length check); a firm
 *     document names registry / firm ids, a user's may name its own buttons.
 *   - `pages` is RESERVED (S6c-5): refused, never stored.
 *   - `all` is guaranteed in Home's icon row: removed.homeIcons may not name it.
 *   - Documents saved before S6c normalize to themselves (a differential over
 *     the old user grammar), and the flat removed form stays refused.
 *   - The REAL uiConfigService.write on a scripted transaction connection:
 *     a firm layout is versioned like registry_overrides (a version row, the
 *     response's version_id), a stale base is a 409 that writes nothing, the
 *     same document again (MySQL key order) is a no-op, no `retired` book-
 *     keeping for this key; the real engine is tests/uiConfigS6c.mysql.test.js
 *     (gated).
 *
 * Mutation-checked (see local/ui-custom/S6c12_worker_report.md).
 *
 * Run:  npx jest tests/uiConfigS6c.test.js
 */

'use strict';

const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');

const errs = (r) => r.errors.join(' | ');
const F = (doc) => shape.validate('firm', 'layout', doc);
const U = (doc) => shape.validate('user', 'layout', doc);
const ALL7 = ['home', 'sidebar', 'homeIcons', 'more', 'moreIcons', 'admin', 'adminIcons'];

describe('the firm layout key and the surfaces', () => {
  test('CONFIG_KEYS: layout is a firm key too; the surface lists per scope', () => {
    expect(shape.CONFIG_KEYS.firm).toEqual(['registry_overrides', 'layout']);
    expect(shape.CONFIG_KEYS.user).toEqual(['shortcuts', 'layout', 'prefs', 'items']);
    expect(shape.FIRM_LAYOUT_SURFACES).toEqual(ALL7);
    expect(shape.LAYOUT_SURFACES).toEqual(['home', 'sidebar', 'homeIcons']);
    expect(shape.ICON_SURFACES).toEqual(['homeIcons', 'moreIcons', 'adminIcons']);
    expect(shape.BREAK_SURFACES).toEqual(['home', 'more', 'admin']);
    expect(shape.CAPS.icons).toBe(12);
    expect(shape.validate('firm', 'layout', {}).value).toEqual({ placed: {}, removed: {} });
  });

  test('firm: every surface; user: home / sidebar / homeIcons only (More, Admin and their rows are firm-only)', () => {
    const placedAll = Object.fromEntries(ALL7.map((sf) => [sf, []]));
    expect(F({ placed: placedAll, removed: placedAll }).value).toEqual({ placed: placedAll, removed: placedAll });
    const r = U({ placed: { more: [], moreIcons: [], admin: [], adminIcons: [], home: [] }, removed: { more: [] } });
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/placed: unknown field "more"/);
    expect(errs(r)).toMatch(/placed: unknown field "moreIcons"/);
    expect(errs(r)).toMatch(/placed: unknown field "admin"/);
    expect(errs(r)).toMatch(/placed: unknown field "adminIcons"/);
    expect(errs(r)).toMatch(/removed: unknown field "more"/);
    expect(U({ placed: { homeIcons: [{ item: 'all' }] }, removed: { homeIcons: ['myTasks'] } }).value)
      .toEqual({ placed: { homeIcons: [{ item: 'all' }] }, removed: { homeIcons: ['myTasks'] } });
  });

  test('a break is for a grid (home, more, admin), a label for the sidebar, an icon row takes items only', () => {
    expect(F({ placed: { more: [{ item: 'moreManuals' }, { break: true }, { item: 'firm:x' }], admin: [{ break: true }] } }).ok).toBe(true);
    const r = F({ placed: {
      more: [{ label: 'x' }],
      moreIcons: [{ break: true }, { label: 'x' }, { item: 'casey', break: true }],
      sidebar: [{ break: true }],
      homeIcons: [{ nope: 1 }],
    } });
    expect(r.ok).toBe(false);
    const e = errs(r);
    expect(e).toMatch(/placed\.more\[0\]: a label is for the sidebar only/);
    expect(e).toMatch(/placed\.moreIcons\[0\]: a break is for a grid \(home, more, admin\) only/);
    expect(e).toMatch(/placed\.moreIcons\[1\]: a label is for the sidebar only/);
    expect(e).toMatch(/placed\.moreIcons\[2\] must be exactly one of \{ item \}$|placed\.moreIcons\[2\] must be exactly one of \{ item \} \|/);
    expect(e).toMatch(/placed\.sidebar\[0\]: a break is for a grid \(home, more, admin\) only/);
    expect(e).toMatch(/placed\.homeIcons\[0\]: unknown field "nope" \(an entry is \{ item \}\)/);
  });

  test('an icon row holds at most 12, refused at the length check before an entry is read; a grid 100', () => {
    const junk = Array.from({ length: 13 }, () => ({ nope: 1 }));
    const r = F({ placed: { adminIcons: junk } });
    expect(r.errors).toEqual(['placed.adminIcons: at most 12 entries']);
    expect(F({ placed: { adminIcons: Array.from({ length: 12 }, (_, i) => ({ item: 'i' + i })) } }).ok).toBe(true);
    expect(errs(U({ placed: { homeIcons: junk } }))).toBe('placed.homeIcons: at most 12 entries');
    expect(errs(F({ placed: { more: Array.from({ length: 101 }, (_, i) => ({ item: 'x' + i })) } }))).toBe('placed.more: at most 100 entries');
    // an item once per surface
    expect(errs(F({ placed: { moreIcons: [{ item: 'casey' }, { item: 'casey' }] } }))).toMatch(/placed\.moreIcons\[1\]: casey is already placed at placed\.moreIcons\[0\]/);
  });

  test('refs by scope: a firm document names registry and firm ids, never a user\'s button; a user\'s may', () => {
    expect(F({ placed: { home: [{ item: 'cases' }, { item: 'firm:clio-code' }] }, removed: { more: ['moreViews', 'firm:x'] } }).ok).toBe(true);
    const r = F({ placed: { home: [{ item: 'user:mine' }] }, removed: { sidebar: ['user:mine'] } });
    expect(errs(r)).toMatch(/placed\.home\[0\]: not an item id/);
    expect(errs(r)).toMatch(/removed\.sidebar\[0\]: not an item id/);
    expect(U({ placed: { home: [{ item: 'user:mine' }], homeIcons: [{ item: 'user:mine' }] }, removed: { sidebar: ['user:mine'] } }).ok).toBe(true);
    expect(errs(U({ placed: { home: [{ item: 'bad id' }] } }))).toMatch(/placed\.home\[0\]: not an item id/);
  });

  test('pages is reserved: refused with its own message, both scopes, whatever it holds', () => {
    for (const v of [{}, { 'firm:ops': { tiles: [], icons: [] } }, null, 1]) {
      for (const scope of ['firm', 'user']) {
        const r = shape.validate(scope, 'layout', { pages: v });
        expect(r.ok).toBe(false);
        expect(r.errors).toEqual(['pages is not available yet (firm and user pages come later)']);
      }
    }
    // the rest of a document carrying it is still read (one refusal names everything wrong)
    expect(errs(F({ pages: {}, placed: { more: 'x' } }))).toBe('pages is not available yet (firm and user pages come later) | placed.more must be an array');
    expect(errs(F({ foo: 1 }))).toBe('layout: unknown field "foo"');
  });

  test('all is guaranteed in Home\'s icon row: removed.homeIcons may not name it (either scope); placing it anywhere is fine', () => {
    for (const scope of ['firm', 'user']) {
      const r = shape.validate(scope, 'layout', { removed: { homeIcons: ['myTasks', 'all'] } });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual(["removed.homeIcons: all is always in this row (it can't be removed)"]);
      expect(shape.validate(scope, 'layout', { removed: { homeIcons: ['myTasks'], sidebar: ['all'] } }).ok).toBe(true);   // the sidebar's All is removable
      expect(shape.validate(scope, 'layout', { placed: { homeIcons: [{ item: 'myTasks' }, { item: 'all' }] } }).ok).toBe(true);
    }
    expect(shape.GUARANTEED).toEqual({ homeIcons: ['all'] });
  });

  test('removals: per surface, the flat form refused with the scope\'s surfaces named; absent stays absent; de-duplicated', () => {
    expect(errs(F({ removed: ['moreViews'] }))).toBe('removed must be an object { home?, sidebar?, homeIcons?, more?, moreIcons?, admin?, adminIcons? } — removals are per surface');
    expect(errs(U({ removed: [] }))).toBe('removed must be an object { home?, sidebar?, homeIcons? } — removals are per surface');
    expect(F({ removed: { more: ['a', 'a', 'firm:b'] } }).value).toEqual({ placed: {}, removed: { more: ['a', 'firm:b'] } });
    expect(F({ placed: { adminIcons: [] } }).value).toEqual({ placed: { adminIcons: [] }, removed: {} });   // [] is kept: it means "this order"
    expect(errs(F({ removed: { more: Array.from({ length: 101 }, (_, i) => 'x' + i) } }))).toBe('removed.more: at most 100 entries');
  });

  test('differential: documents of the pre-S6c user grammar normalize exactly as before', () => {
    const docs = [
      {}, { placed: {} }, { placed: { home: [] } }, { placed: { home: [{ item: 'cases' }, { break: true }], sidebar: [{ label: 'Mine' }, { item: 'tasks' }] } },
      { removed: { home: ['bills'], sidebar: ['log', 'bills'] } },
      { placed: { sidebar: [{ item: 'firm:x' }, { item: 'user:y' }] }, removed: { home: ['user:y'] } },
    ];
    for (const d of docs) {
      const r = U(d);
      expect([d, r.ok]).toEqual([d, true]);
      expect(r.value).toEqual({ placed: d.placed || {}, removed: d.removed || {} });
      expect(shape.canonical(U(r.value).value)).toBe(shape.canonical(r.value));   // normalizes to itself
    }
    for (const d of [{ placed: { home: [{ label: 'x' }] } }, { removed: ['bills'] }, { placed: { home: [{ item: 'cases' }, { item: 'cases' }] } }]) {
      expect(U(d).ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('write(): the firm layout is versioned like registry_overrides (scripted connection)', () => {
  const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
  const staff = { type: 'jwt', userId: 9, roles: ['staff'] };
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
  const MORE = { placed: { more: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }], moreIcons: [{ item: 'casey' }] }, removed: { admin: ['adminDbConsole'] } };

  test('a first firm layout: the row and ONE version; the response carries version_id and the normalized document', async () => {
    const db = txDb(null);
    const r = await svc.write(db, { scope: 'firm', config_key: 'layout', config: MORE }, admin);
    expect([r.scope, r.config_key, r.changed, r.versioned, r.version_id]).toEqual(['firm', 'layout', true, true, 8]);
    expect(r.config).toEqual(MORE);
    const w = db.writes();
    expect(w.map((x) => x.s.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO ui_config', 'INSERT INTO ui_config_versions']);
    expect(w[0].params.slice(0, 4)).toEqual(['firm', 0, 'layout', JSON.stringify(MORE)]);   // the firm row: user_id 0
    expect(w[1].params).toEqual([5, 'layout', JSON.stringify(MORE), 1]);
    expect(JSON.parse(w[0].params[3])).not.toHaveProperty('retired');                        // no retired bookkeeping for this key
  });

  test('base: the newest version id passes, a stale one is a 409 that writes nothing; absent means no check', async () => {
    const stored = { placed: { more: [] }, removed: {} };
    const ok = txDb(stored, 7);
    const r = await svc.write(ok, { scope: 'firm', config_key: 'layout', config: MORE, base: 7 }, admin);
    expect([r.changed, r.versioned, r.version_id]).toEqual([true, true, 8]);
    const stale = txDb(stored, 7);
    await expect(svc.write(stale, { scope: 'firm', config_key: 'layout', config: MORE, base: 6 }, admin)).rejects.toMatchObject({ status: 409, message: svc.CONFLICT_MSG });
    expect(stale.writes()).toEqual([]);
    const none = txDb(stored, 7);
    expect((await svc.write(none, { scope: 'firm', config_key: 'layout', config: MORE }, admin)).changed).toBe(true);
  });

  test('the same document again — keys in MySQL\'s order — is a no-op carrying the current version id', async () => {
    const asMysql = { removed: { admin: ['adminDbConsole'] }, placed: { moreIcons: [{ item: 'casey' }], more: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }] } };
    const db = txDb(asMysql, 7);
    const r = await svc.write(db, { scope: 'firm', config_key: 'layout', config: MORE, base: 7 }, admin);
    expect([r.changed, r.versioned, r.version_id]).toEqual([false, false, 7]);
    expect(db.writes()).toEqual([]);
  });

  test('refusals: staff (no firm.settings) 403; a reserved pages key, a user id in a firm list, a removal of all → 400 with errors; nothing written', async () => {
    const db = txDb(null);
    await expect(svc.write(db, { scope: 'firm', config_key: 'layout', config: MORE }, staff)).rejects.toMatchObject({ status: 403 });
    for (const bad of [{ pages: {} }, { placed: { home: [{ item: 'user:x' }] } }, { removed: { homeIcons: ['all'] } }, { placed: { adminIcons: [{ break: true }] } }]) {
      const e = await svc.write(db, { scope: 'firm', config_key: 'layout', config: bad }, admin).catch((x) => x);
      expect([bad, e.status, Array.isArray(e.errors) && e.errors.length > 0]).toEqual([bad, 400, true]);
    }
    expect(db.writes()).toEqual([]);
    // a user's layout with homeIcons: their own row, never versioned
    const u = txDb(null);
    const r = await svc.write(u, { scope: 'user', config_key: 'layout', config: { placed: { homeIcons: [{ item: 'all' }, { item: 'user:x' }] } } }, staff);
    expect([r.changed, r.versioned, r.config]).toEqual([true, false, { placed: { homeIcons: [{ item: 'all' }, { item: 'user:x' }] }, removed: {} }]);
    expect(u.writes().map((x) => x.s.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO ui_config']);
    expect(u.writes()[0].params.slice(0, 3)).toEqual(['user', 9, 'layout']);
  });
});
