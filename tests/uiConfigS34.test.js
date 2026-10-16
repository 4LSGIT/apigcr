// tests/uiConfigS34.test.js
//
/**
 * ui-custom S3.4 — role scoping ("Who sees what"), the server side:
 *   - registry_overrides' `visible_to: { itemId: [role…] }` (lib/uiConfigShape.js):
 *     roles are lib/capabilities ROLE_MEMBERS minus su (the constant reused,
 *     never copied); su is implicit and REFUSED in a list; [] (only su) is
 *     valid and distinct from an absent key (everyone); {} normalizes to
 *     absent; undeniables refused; registry and firm ids allowed, other ids
 *     refused; duplicates dropped and lists stored in ROLE_MEMBERS order;
 *     caps refused at the length check; a document saved before S3.4
 *     normalizes to itself;
 *   - the REAL uiConfigService.write / restoreVersion on a scripted
 *     transaction connection: visible_to is stored normalized under the base
 *     check; a role-order-only difference is the canonical no-op; a version
 *     saved before S3.4 (no visible_to) still restores;
 *   - services/entitlementService.normalizeDeny accepts a firm item id
 *     (firm:<slug>, uiConfigShape's FIRM_ID_RE reused) and still refuses a
 *     malformed one, with registry ids unchanged; both require orders load.
 *   (The real engine for per-user firm denies: tests/entitlements.mysql.test.js, gated.)
 *
 * Mutation-checked (see the S3.4 worker report).
 *
 * Run:  npx jest tests/uiConfigS34.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');
const ent = require('../services/entitlementService');
const { ROLE_MEMBERS } = require('../lib/capabilities');

const ROOT = path.join(__dirname, '..');
const RO = (config) => shape.validate('firm', 'registry_overrides', config);
const errs = (r) => r.errors.join(' | ');
const ITEM = (id, label = 'Item') => ({ id, label, icon: 'link', action: { type: 'tool', key: 'appt-form', present: 'modal' } });

// ─────────────────────────────────────────────────────────────────────────
describe('visible_to: the vocabulary', () => {
  test('roles are lib/capabilities ROLE_MEMBERS minus su — the constant reused, not copied', () => {
    expect(shape.VISIBLE_ROLES).toEqual(ROLE_MEMBERS.filter((r) => r !== 'su'));
    const src = fs.readFileSync(path.join(ROOT, 'lib/uiConfigShape.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/capabilities'\)/);
    expect(src).not.toMatch(/'form_dev'|'attorney'|"form_dev"/);          // no copied role list
  });

  test('every role is accepted, alone and together', () => {
    for (const r of shape.VISIBLE_ROLES) expect(RO({ visible_to: { moreAutomations: [r] } }).value.visible_to).toEqual({ moreAutomations: [r] });
    expect(RO({ visible_to: { moreAutomations: shape.VISIBLE_ROLES.slice() } }).ok).toBe(true);
  });

  test('a role outside ROLE_MEMBERS (or not a string) is refused, naming the slot', () => {
    for (const bad of ['boss', 'Admin', 'admin ', '', 3, null, { r: 'admin' }]) {
      const r = RO({ visible_to: { moreAutomations: ['admin', bad] } });
      expect([bad, r.ok]).toEqual([bad, false]);
      expect(errs(r)).toMatch(/visible_to\.moreAutomations\[1\]: not a role \(it, admin, staff, attorney, automation, form_dev\)/);
    }
  });

  test('su is implicit: refused in a list, alone or with others, with the reason', () => {
    for (const list of [['su'], ['admin', 'su']]) {
      const r = RO({ visible_to: { moreAutomations: list } });
      expect(r.ok).toBe(false);
      expect(errs(r)).toMatch(/su always sees every item — leave it out/);
    }
  });

  test('duplicates are dropped and the list is stored in ROLE_MEMBERS order (a set: tick order never matters)', () => {
    expect(RO({ visible_to: { moreAutomations: ['attorney', 'admin', 'attorney', 'it'] } }).value.visible_to)
      .toEqual({ moreAutomations: ['it', 'admin', 'attorney'] });
  });
});

describe('visible_to: absent, [] and {}', () => {
  test('[] is valid and means only su — kept as []', () => {
    const r = RO({ visible_to: { moreAutomations: [] } });
    expect(r.ok).toBe(true);
    expect(r.value.visible_to).toEqual({ moreAutomations: [] });
  });

  test('absent stays absent; {} normalizes to absent (both mean everyone)', () => {
    expect(RO({ hidden: ['bills'] }).value).toEqual({ hidden: ['bills'], locked: [], renames: {}, items: [] });
    expect(Object.prototype.hasOwnProperty.call(RO({ visible_to: {} }).value, 'visible_to')).toBe(false);
  });

  test('a document saved before S3.4 normalizes to itself', () => {
    const old = { hidden: ['bills'], locked: ['cases'], renames: { cases: { label: 'Matters' } }, items: [ITEM('firm:a')], retired: ['firm:b'] };
    const r = RO(old);
    expect(r.ok).toBe(true);
    expect(shape.canonical(r.value)).toBe(shape.canonical(old));
  });
});

describe('visible_to: ids', () => {
  test('registry ids and firm ids are allowed (soft refs — never checked against the registry)', () => {
    expect(RO({ visible_to: { moreAutomations: ['admin'], 'firm:payroll': [], notInRegistry: ['staff'] } }).ok).toBe(true);
  });

  test('Settings and Help & Support are refused: they stay visible to everyone', () => {
    for (const id of ['moreSettings', 'helpSupport']) {
      const r = RO({ visible_to: { [id]: ['admin'] } });
      expect(r.ok).toBe(false);
      expect(errs(r)).toMatch(new RegExp(`visible_to\\.${id}: ${id} is always visible to everyone`));
    }
  });

  test('a key that is not an item id is refused', () => {
    for (const bad of ['firm:Payroll', 'firm:', 'bad_id', '1abc', 'firm:' + 'a'.repeat(41)]) {
      expect([bad, RO({ visible_to: { [bad]: [] } }).ok]).toEqual([bad, false]);
    }
  });

  test('shapes: visible_to must be an object of arrays', () => {
    expect(errs(RO({ visible_to: [] }))).toMatch(/visible_to must be an object/);
    expect(errs(RO({ visible_to: 'admin' }))).toMatch(/visible_to must be an object/);
    expect(errs(RO({ visible_to: { moreAutomations: 'admin' } }))).toMatch(/visible_to\.moreAutomations must be an array of roles/);
    expect(errs(RO({ visible_to: { moreAutomations: null } }))).toMatch(/must be an array/);
  });

  test('visible_to does not loosen the strict top level (an unknown key is still an error)', () => {
    expect(errs(RO({ visible_to: {}, visibleTo: {} }))).toMatch(/unknown field "visibleTo"/);
  });
});

describe('visible_to: caps (refused at the length check)', () => {
  test(`more than ${shape.CAPS.visible_to} entries → one cap error, fast`, () => {
    const big = {};
    for (let i = 0; i < 60000; i++) big['x' + i] = ['bogus'];
    const t = Date.now();
    const r = RO({ visible_to: big });
    expect(Date.now() - t).toBeLessThan(300);
    expect(r.errors).toEqual([`visible_to: at most ${shape.CAPS.visible_to} entries`]);
    const ok = {};
    for (let i = 0; i < shape.CAPS.visible_to; i++) ok['x' + i] = ['admin'];
    expect(RO({ visible_to: ok }).ok).toBe(true);
  });

  test(`a role list longer than ${shape.CAPS.visible_roles} → refused before its entries are read`, () => {
    const r = RO({ visible_to: { moreAutomations: new Array(60000).fill('nope') } });
    expect(r.errors).toEqual([`visible_to.moreAutomations: at most ${shape.CAPS.visible_roles} entries`]);
    expect(RO({ visible_to: { moreAutomations: new Array(shape.CAPS.visible_roles).fill('admin') } }).value.visible_to)
      .toEqual({ moreAutomations: ['admin'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The REAL uiConfigService.write / restoreVersion on a scripted transaction
// connection (the S4a test's idiom).
describe('write(): visible_to rides the firm write path (always-run)', () => {
  const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
  function txDb(stored, { version, head = 7 } = {}) {
    const stmts = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        stmts.push({ s, params });
        if (/^SELECT id, config FROM ui_config .* FOR UPDATE$/.test(s)) return [stored ? [{ id: 4, config: JSON.stringify(stored) }] : []];
        if (/^SELECT MAX\(id\) AS id FROM ui_config_versions/.test(s)) return [[{ id: head }]];
        if (/^INSERT INTO ui_config /.test(s)) return [{ insertId: 4 }];
        if (/^INSERT INTO ui_config_versions /.test(s)) return [{ insertId: head + 1 }];
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
  const put = (config, base) => ({ scope: 'firm', config_key: 'registry_overrides', config, ...(base !== undefined ? { base } : {}) });
  const doc = (extra) => ({ hidden: [], locked: [], renames: {}, items: [], ...extra });

  test('stored normalized, with the base check holding; a stale base writes nothing', async () => {
    const db = txDb(doc({ items: [ITEM('firm:pay')] }));
    const r = await svc.write(db, put(doc({ items: [ITEM('firm:pay')], visible_to: { moreAutomations: ['attorney', 'admin'], 'firm:pay': [] } }), 7), admin);
    expect(r.config.visible_to).toEqual({ moreAutomations: ['admin', 'attorney'], 'firm:pay': [] });
    expect(db.storedDoc().visible_to).toEqual({ moreAutomations: ['admin', 'attorney'], 'firm:pay': [] });
    expect(db.writes().some((x) => /ui_config_versions/.test(x.s))).toBe(true);
    const stale = txDb(doc({ items: [ITEM('firm:pay')] }));
    await expect(svc.write(stale, put(doc({ visible_to: { moreAutomations: ['admin'] } }), 6), admin)).rejects.toMatchObject({ status: 409 });
    expect(stale.writes()).toEqual([]);
  });

  test('a role-order-only difference is the canonical no-op: nothing written, no version', async () => {
    const db = txDb(doc({ visible_to: { moreAutomations: ['admin', 'attorney'] } }));
    const r = await svc.write(db, put(doc({ visible_to: { moreAutomations: ['attorney', 'admin'] } }), 7), admin);
    expect([r.changed, r.versioned]).toEqual([false, false]);
    expect(db.writes()).toEqual([]);
  });

  test('a bad visible_to is a 400 naming it; nothing written', async () => {
    const db = txDb(doc());
    await expect(svc.write(db, put(doc({ visible_to: { moreAutomations: ['su'] } })), admin))
      .rejects.toMatchObject({ status: 400 });
    expect(db.writes()).toEqual([]);
  });

  test('restore of a version saved before S3.4 (no visible_to) still validates — and drops the current restrictions', async () => {
    const v1 = doc({ hidden: ['bills'] });
    const db = txDb(doc({ visible_to: { moreAutomations: ['admin'] } }), {
      version: { id: 3, config_key: 'registry_overrides', row_config_key: 'registry_overrides', config: JSON.stringify(v1), saved_by: 1, saved_by_name: 'x', saved_at: null },
    });
    const r = await svc.restoreVersion(db, 3, admin);
    expect(r.config).toEqual(v1);
    expect(db.storedDoc()).toEqual(v1);
  });

  test('restore of a version with visible_to brings it back', async () => {
    const v2 = doc({ visible_to: { moreAutomations: ['staff'] } });
    const db = txDb(doc(), {
      version: { id: 5, config_key: 'registry_overrides', row_config_key: 'registry_overrides', config: JSON.stringify(v2), saved_by: 1, saved_by_name: 'x', saved_at: null },
    });
    expect((await svc.restoreVersion(db, 5, admin)).config.visible_to).toEqual({ moreAutomations: ['staff'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('entitlementService.normalizeDeny: firm item ids (D3)', () => {
  const bad = (b, re) => {
    let err = null;
    try { ent.normalizeDeny(b); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.status).toBe(400);
    if (re) expect(err.message).toMatch(re);
  };

  test('a firm id is accepted (per user, and at the other scopes the API keeps)', () => {
    expect(ent.normalizeDeny({ scope: 'user', scope_ref: 5, item_key: 'firm:payroll' })).toEqual({ scope: 'user', scope_ref: '5', item_key: 'firm:payroll' });
    expect(ent.normalizeDeny({ scope: 'user', scope_ref: '22', item_key: 'firm:' + 'a'.repeat(40) }).item_key).toBe('firm:' + 'a'.repeat(40));
    expect(ent.normalizeDeny({ scope: 'firm', item_key: 'firm:get-clio-code' }).scope_ref).toBe('');
  });

  test('a malformed firm id is refused', () => {
    for (const k of ['firm:Payroll', 'firm:', 'firm:pay roll', 'firm:pay_roll', 'Firm:payroll', 'firm:' + 'a'.repeat(41), 'firm:payroll ', 'xfirm:payroll']) {
      bad({ scope: 'user', scope_ref: 5, item_key: k }, /unknown item_key/);
    }
  });

  test('registry ids work as before; an unknown registry-shaped id is still refused; undeniables still refused', () => {
    expect(ent.normalizeDeny({ scope: 'user', scope_ref: 5, item_key: 'bills' }).item_key).toBe('bills');
    bad({ scope: 'user', scope_ref: 5, item_key: 'moreReport' }, /unknown item_key "moreReport"/);
    bad({ scope: 'user', scope_ref: 5, item_key: 'helpSupport' }, /cannot be denied/);
  });

  test('the pattern is uiConfigShape\'s FIRM_ID_RE, read lazily (no copy, no load-time require cycle)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/entitlementService.js'), 'utf8');
    expect(src).toMatch(/require\('\.\.\/lib\/uiConfigShape'\)\.FIRM_ID_RE/);
    expect(src).not.toMatch(/firm:\[a-z0-9-\]/);                           // no copied regex
    // either module may load first
    jest.isolateModules(() => {
      const e = require('../services/entitlementService');
      expect(e.normalizeDeny({ scope: 'user', scope_ref: 1, item_key: 'firm:x' }).item_key).toBe('firm:x');
      expect(typeof require('../lib/uiConfigShape').validate).toBe('function');
      expect(require('../lib/uiConfigShape').validate('firm', 'registry_overrides', { hidden: ['moreSettings'] }).ok).toBe(false);
    });
    jest.isolateModules(() => {
      const s = require('../lib/uiConfigShape');
      expect(s.validate('firm', 'registry_overrides', { hidden: ['helpSupport'] }).ok).toBe(false);   // UNDENIABLE arrived
      expect(require('../services/entitlementService').normalizeDeny({ scope: 'user', scope_ref: 1, item_key: 'firm:y' }).item_key).toBe('firm:y');
    });
  });
});
