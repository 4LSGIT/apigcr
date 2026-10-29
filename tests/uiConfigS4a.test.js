// tests/uiConfigS4a.test.js
//
/**
 * ui-custom S4a — the server side of the user layer and of durable retired
 * firm ids (lib/uiConfigShape.js + services/uiConfigService.js):
 *   - the user `layout` document: { placed: { home?, sidebar? },
 *     removed: { home?, sidebar? } } (removals PER SURFACE — fix round SF1; the
 *     flat array form is refused, never coerced) —
 *     an entry is exactly one of { item } / { break: true } (a grid) /
 *     { label } (sidebar only, plain text 1–40); an item once per surface;
 *     every array capped (refused at the length check, before its entries are
 *     looked at); unknown keys are errors; ids are soft refs (any id shape,
 *     never checked against the registry); a surface left out stays out;
 *   - `layout` is a key of BOTH scopes since ui-custom S6c (the firm's default
 *     layout); a user's covers home / sidebar / homeIcons only;
 *   - registry_overrides' server-managed `retired` list: firm ids only, absent
 *     when empty (documents saved before S4a normalize to themselves), an item
 *     whose id is retired is refused;
 *   - the REAL uiConfigService.write on a scripted transaction connection
 *     (always-run; the real engine is tests/uiConfigS4a.mysql.test.js, gated):
 *     a deleted item's id is retired in the stored document; a client's own
 *     `retired` is dropped (it can neither shrink nor grow the list); a new
 *     item reusing a retired id is a 400 with nothing written; the canonical
 *     no-op still holds with a retired list; a restore brings the very item
 *     back and its id leaves the list.
 *
 * Mutation-checked (see the S4a worker report).
 *
 * Run:  npx jest tests/uiConfigS4a.test.js
 */

'use strict';

const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');

const L = (config) => shape.validate('user', 'layout', config);
const errs = (r) => r.errors.join(' | ');

// ─────────────────────────────────────────────────────────────────────────
describe('the user layout document', () => {
  test('a full document normalizes: labels trimmed, removed de-duplicated, entry shapes kept', () => {
    const r = L({
      placed: {
        home: [{ item: 'cases' }, { break: true }, { item: 'firm:payroll' }, { item: 'moreAutomations' }],
        sidebar: [{ label: '  Mine  ' }, { item: 'cases' }, { item: 'helpSupport' }],
      },
      removed: { home: ['bills', 'bills', 'firm:x'], sidebar: ['bills'] },
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      placed: {
        home: [{ item: 'cases' }, { break: true }, { item: 'firm:payroll' }, { item: 'moreAutomations' }],
        sidebar: [{ label: 'Mine' }, { item: 'cases' }, { item: 'helpSupport' }],
      },
      removed: { home: ['bills', 'firm:x'], sidebar: ['bills'] },
    });
  });

  test('empty and partial documents: a surface left out stays out; [] is kept', () => {
    expect(L({}).value).toEqual({ placed: {}, removed: {} });
    expect(L({ placed: { sidebar: [] } }).value).toEqual({ placed: { sidebar: [] }, removed: {} });
    expect(L({ removed: { sidebar: ['cases'] } }).value).toEqual({ placed: {}, removed: { sidebar: ['cases'] } });
    expect(L({ removed: { home: [] } }).value).toEqual({ placed: {}, removed: { home: [] } });
  });

  test('ids are soft refs: any id SHAPE is accepted, the registry is never consulted', () => {
    expect(L({ placed: { home: [{ item: 'noSuchThing' }, { item: 'firm:gone' }] }, removed: { home: ['alsoGone'] } }).ok).toBe(true);
    for (const bad of ['', 'has space', '9lives', 'firm:UPPER', 'firm:', 7, null, {}]) {
      expect([bad, L({ placed: { home: [{ item: bad }] } }).ok]).toEqual([bad, false]);
      expect([bad, L({ removed: { sidebar: [bad] } }).ok]).toEqual([bad, false]);
    }
  });

  test('an entry is exactly one shape; a break is for a grid, a label the sidebar only', () => {
    const r = L({
      placed: {
        home: [{ label: 'x' }, { break: 1 }, { break: false }, { item: 'a', break: true }, {}, { foo: 1 }, 'cases', null],
        sidebar: [{ break: true }, { label: '' }, { label: 'x'.repeat(41) }, { label: 'a\u0007b' }, { label: 5 }],
      },
    });
    expect(r.ok).toBe(false);
    const e = errs(r);
    expect(e).toMatch(/placed\.home\[0\]: a label is for the sidebar only/);
    expect(e).toMatch(/placed\.home\[1\]: break must be true/);
    expect(e).toMatch(/placed\.home\[2\]: break must be true/);
    expect(e).toMatch(/placed\.home\[3\] must be exactly one of/);
    expect(e).toMatch(/placed\.home\[4\] must be exactly one of/);
    expect(e).toMatch(/placed\.home\[5\]: unknown field "foo"/);
    expect(e).toMatch(/placed\.home\[6\] must be an object/);
    expect(e).toMatch(/placed\.home\[7\] must be an object/);
    expect(e).toMatch(/placed\.sidebar\[0\]: a break is for a grid \(Home, a page's tiles\) only/);
    expect(e).toMatch(/placed\.sidebar\[1\]: label must be 1-40/);
    expect(e).toMatch(/placed\.sidebar\[2\]: label must be 1-40/);
    expect(e).toMatch(/placed\.sidebar\[3\]: label must be plain text/);
    expect(e).toMatch(/placed\.sidebar\[4\]: label must be a string/);
    // 40 code points is fine (an emoji is ONE)
    expect(L({ placed: { sidebar: [{ label: '😀'.repeat(40) }] } }).ok).toBe(true);
  });

  test('an item at most once per surface (the same item on both surfaces is fine)', () => {
    const r = L({ placed: { home: [{ item: 'cases' }, { break: true }, { item: 'cases' }] } });
    expect(errs(r)).toMatch(/placed\.home\[2\]: cases is already placed at placed\.home\[0\]/);
    expect(L({ placed: { home: [{ item: 'cases' }], sidebar: [{ item: 'cases' }] } }).ok).toBe(true);
    expect(L({ placed: { home: [{ break: true }, { break: true }], sidebar: [{ label: 'A' }, { label: 'A' }] } }).ok).toBe(true);
  });

  test('unknown keys are errors at every level; wrong types are errors', () => {
    expect(errs(L({ placed: {}, removed: {}, extra: 1 }))).toMatch(/layout: unknown field "extra"/);
    expect(errs(L({ removed: { drawer: [] } }))).toMatch(/removed: unknown field "drawer"/);
    expect(errs(L({ removed: { home: 'cases' } }))).toMatch(/removed\.home must be an array/);
    expect(errs(L({ placed: { drawer: [] } }))).toMatch(/placed: unknown field "drawer"/);
    expect(errs(L({ placed: [] }))).toMatch(/placed must be an object/);
    expect(errs(L({ placed: { home: {} } }))).toMatch(/placed\.home must be an array/);
    expect(errs(L({ removed: 'cases' }))).toMatch(/removed must be an object/);
  });

  test('caps: refused at the length check, before the entries are looked at', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ item: 'x' + i }));
    expect(errs(L({ placed: { home: many } }))).toBe('placed.home: at most 100 entries');
    expect(L({ placed: { home: many.slice(0, 100) } }).ok).toBe(true);
    const removed = Array.from({ length: 101 }, (_, i) => 'x' + i);
    expect(errs(L({ removed: { sidebar: removed } }))).toBe('removed.sidebar: at most 100 entries');
    expect(L({ removed: { home: removed.slice(0, 100), sidebar: removed.slice(0, 100) } }).ok).toBe(true);
    // a 60k junk list costs one length check
    const t0 = Date.now();
    const r = L({ placed: { sidebar: Array.from({ length: 60000 }, () => ({ nope: 1 })) } });
    expect(r.errors).toEqual(['placed.sidebar: at most 100 entries']);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test('removals are per surface: the flat array form is REFUSED, never coerced (fix round SF1)', () => {
    for (const flat of [['bills'], []]) {
      const r = L({ removed: flat });
      expect(r.ok).toBe(false);
      expect(errs(r)).toBe('removed must be an object { home?, sidebar?, homeIcons? } — removals are per surface');
    }
    // each surface keeps its own list, untouched by the other's
    expect(L({ removed: { sidebar: ['bills'] } }).value.removed).toEqual({ sidebar: ['bills'] });
    expect(L({ removed: { home: ['log'], sidebar: ['bills'] } }).value.removed).toEqual({ home: ['log'], sidebar: ['bills'] });
  });

  test('layout is a key of both scopes (S6c): the PUT envelope takes it for user and firm; a user may not arrange More', () => {
    expect(shape.validateWrite({ scope: 'user', config_key: 'layout', config: { placed: { home: [] } } }).ok).toBe(true);
    expect(shape.validateWrite({ scope: 'firm', config_key: 'layout', config: {} }).ok).toBe(true);
    expect(errs(shape.validateWrite({ scope: 'user', config_key: 'layout', config: { placed: { more: [] } } }))).toMatch(/placed: unknown field "more"/);
    expect(shape.CONFIG_KEYS.user).toEqual(['shortcuts', 'layout', 'prefs', 'items']);   // prefs: S5d's theme; items: S5a's user buttons
  });
});

// ─────────────────────────────────────────────────────────────────────────
const ITEM = (id, label = 'Item') => ({ id, label, icon: 'c', action: { type: 'url', href: 'https://example.com/', present: 'window' } });
const RO = (extra) => shape.validate('firm', 'registry_overrides', extra);

describe('registry_overrides: the retired list (grammar)', () => {
  test('absent when empty — a document saved before S4a normalizes to itself', () => {
    expect(RO({}).value).toEqual({ hidden: [], locked: [], renames: {}, items: [] });
    expect(RO({ retired: [] }).value).toEqual({ hidden: [], locked: [], renames: {}, items: [] });
    expect(RO({ retired: ['firm:a', 'firm:a', 'firm:b'] }).value.retired).toEqual(['firm:a', 'firm:b']);
  });

  test('firm ids only; an array; capped', () => {
    expect(errs(RO({ retired: ['cases'] }))).toMatch(/retired\[0\]: not a firm item id/);
    expect(errs(RO({ retired: 'firm:a' }))).toMatch(/retired must be an array/);
    const big = Array.from({ length: 1001 }, (_, i) => 'firm:x' + i);
    expect(errs(RO({ retired: big }))).toBe('retired: at most 1000 entries');
  });

  test('an item whose id is retired is refused', () => {
    const r = RO({ items: [ITEM('firm:a'), ITEM('firm:b')], retired: ['firm:b'] });
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/items\[1\]: firm:b belonged to a deleted item and is retired/);
    expect(RO({ items: [ITEM('firm:a')], retired: ['firm:b'] }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The REAL uiConfigService.write / restoreVersion on a scripted transaction
// connection that answers the FOR UPDATE read and records every statement
// with its params.
describe('write(): retired ids are server-managed (always-run)', () => {
  const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
  function txDb(stored, { version } = {}) {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push({ s, params });
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) return [stored ? [{ id: 4, config: JSON.stringify(stored) }] : []];
        if (/^SELECT MAX\(id\) AS id FROM ui_config_versions/.test(s)) return [[{ id: 7 }]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 4 }];
        if (/^INSERT INTO ui_config_versions /.test(s)) return [{ insertId: 8 }];
        throw new Error('unscripted statement: ' + s);
      },
    };
    return {
      stmts,
      writes: () => stmts.filter((x) => /^(INSERT|UPDATE|DELETE)\b/.test(x.s)),
      storedDoc: () => {
        const w = stmts.find((x) => /^INSERT INTO ui_config /.test(x.s));
        return w ? JSON.parse(w.params[3]) : null;
      },
      getConnection: async () => conn,
      query: async (sql) => {
        if (version && /FROM ui_config_versions v JOIN ui_config c/.test(String(sql))) return [[version]];
        throw new Error('pool query not expected');
      },
    };
  }
  const put = (config) => ({ scope: 'firm', config_key: 'registry_overrides', config });
  const doc = (items, extra) => ({ hidden: [], locked: [], renames: {}, items, ...extra });

  test('deleting an item retires its id in the stored document (and the response)', async () => {
    const db = txDb(doc([ITEM('firm:a'), ITEM('firm:b')]));
    const r = await svc.write(db, put(doc([ITEM('firm:a')])), admin);
    expect(r.config.retired).toEqual(['firm:b']);
    expect(db.storedDoc().retired).toEqual(['firm:b']);
  });

  test('the list only grows: stored ids stay, newly deleted ones are appended in stored order', async () => {
    const db = txDb(doc([ITEM('firm:c'), ITEM('firm:d'), ITEM('firm:e')], { retired: ['firm:a', 'firm:b'] }));
    const r = await svc.write(db, put(doc([ITEM('firm:d')])), admin);
    expect(r.config.retired).toEqual(['firm:a', 'firm:b', 'firm:c', 'firm:e']);
  });

  test('a client\'s own retired is dropped: it can neither shrink nor grow the list', async () => {
    const stored = doc([ITEM('firm:a')], { retired: ['firm:old'] });
    const shrink = txDb(stored);
    const r1 = await svc.write(shrink, put(doc([ITEM('firm:a'), ITEM('firm:b')], { retired: [] })), admin);
    expect(r1.config.retired).toEqual(['firm:old']);
    const grow = txDb(stored);
    const r2 = await svc.write(grow, put(doc([ITEM('firm:a')], { retired: ['firm:old', 'firm:zzz'] })), admin);
    expect(r2.config.retired).toEqual(['firm:old']);
    // …and a junk retired from a client is not even a 400 (it is never read)
    const junk = txDb(stored);
    expect((await svc.write(junk, put(doc([ITEM('firm:a')], { retired: 'nonsense' })), admin)).config.retired).toEqual(['firm:old']);
  });

  test('a new item reusing a retired id → 400 naming it, nothing written', async () => {
    const db = txDb(doc([], { retired: ['firm:payroll'] }));
    await expect(svc.write(db, put(doc([ITEM('firm:payroll', 'Payroll')])), admin))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/firm:payroll belonged to a deleted item and is retired/) });
    expect(db.writes()).toEqual([]);
    expect(db.stmts.some((x) => /FOR UPDATE$/.test(x.s))).toBe(true);   // decided under the row lock
  });

  test('dropping and re-sending the same id in ONE save is an edit: the id never left, so it is not retired', async () => {
    const db = txDb(doc([ITEM('firm:a', 'Old')]));
    const r = await svc.write(db, put(doc([ITEM('firm:a', 'New')])), admin);
    expect(r.config.retired).toBeUndefined();
  });

  test('unchanged document with a retired list → no write (the canonical no-op still holds)', async () => {
    const stored = doc([ITEM('firm:a')], { retired: ['firm:b'] });
    const db = txDb(stored);
    const r = await svc.write(db, put(doc([ITEM('firm:a')])), admin);
    expect([r.changed, r.versioned]).toEqual([false, false]);
    expect(db.writes()).toEqual([]);
  });

  test('a first-ever firm row: no retired list', async () => {
    const db = txDb(null);
    const r = await svc.write(db, put(doc([ITEM('firm:a')])), admin);
    expect(r.config).toEqual(doc([ITEM('firm:a')]));
  });

  test('user writes are untouched by any of this (a user layout stored as sent, normalized)', async () => {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push({ s, params });
        if (/FOR UPDATE$/.test(s)) return [[]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 9 }];
        throw new Error('unscripted statement: ' + s);
      },
    };
    const db = { getConnection: async () => conn, query: async () => { throw new Error('no'); } };
    const staff = { type: 'jwt', userId: 5, roles: ['staff'] };
    const r = await svc.write(db, { scope: 'user', config_key: 'layout', config: { placed: { sidebar: [{ label: ' Mine ' }] }, removed: { sidebar: ['bills'] } } }, staff);
    expect(r.config).toEqual({ placed: { sidebar: [{ label: 'Mine' }] }, removed: { sidebar: ['bills'] } });
    const ins = stmts.find((x) => /^INSERT INTO ui_config /.test(x.s));
    expect(ins.params.slice(0, 2)).toEqual(['user', 5]);
    expect(stmts.some((x) => /ui_config_versions/.test(x.s))).toBe(false);
  });

  test('restore brings the very item back: its id leaves the list', async () => {
    const v1 = doc([ITEM('firm:a'), ITEM('firm:b')]);
    const db = txDb(doc([ITEM('firm:a')], { retired: ['firm:b', 'firm:z'] }), {
      version: { id: 3, config_key: 'registry_overrides', row_config_key: 'registry_overrides', config: JSON.stringify(v1), saved_by: 1, saved_by_name: 'x', saved_at: null },
    });
    const r = await svc.restoreVersion(db, 3, admin);
    expect(r.config.items.map((i) => i.id)).toEqual(['firm:a', 'firm:b']);
    expect(r.config.retired).toEqual(['firm:z']);
    expect(r.restored_from).toBe(3);
  });

  test('restore of a version that predates a later deletion retires what it drops, like any save', async () => {
    const v1 = doc([ITEM('firm:a')], { retired: ['firm:stale'] });   // the version's own list is NOT used
    const db = txDb(doc([ITEM('firm:a'), ITEM('firm:c')], { retired: ['firm:b'] }), {
      version: { id: 2, config_key: 'registry_overrides', row_config_key: 'registry_overrides', config: JSON.stringify(v1), saved_by: 1, saved_by_name: 'x', saved_at: null },
    });
    const r = await svc.restoreVersion(db, 2, admin);
    expect(r.config.retired).toEqual(['firm:b', 'firm:c']);
  });
});
