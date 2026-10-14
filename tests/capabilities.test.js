// tests/capabilities.test.js
//
/**
 * Capability registry + can() + requireAuth({can}) — access-control arc A1
 * (lib/capabilities.js, ref/ACCESS_CONTROL_DESIGN.md §2.2, §2.3, §3).
 *
 * WHAT IS LOCKED
 *   - The REGISTRY: capability names + root flags, and the ROLE_CAPS map, as
 *     exact snapshots. Every entry is a reviewed access decision (root-grade
 *     vs it-reachable; which role holds what) — any change fails here until
 *     the snapshot is deliberately updated, like the opened-param set in
 *     tests/ctaInputs.test.js.
 *   - can(): su role passes everything (the legacy SU string alone: nothing,
 *     since A2b); it passes firm-grade
 *     only; named roles pass exactly their ROLE_CAPS; staff/automation hold
 *     nothing; api_key = machine trust (Q3); portal / readonly / missing auth
 *     = false; an unknown capability THROWS.
 *   - requireAuth({audience:'staff', can}): 200-path / 403 / mount-time
 *     throws (unknown cap, roles+can), audit-row parity with the role gate,
 *     and the allowApiKey path (api_key trusted; JWT fallthrough gated).
 *
 * HARNESS: the REAL capabilities module and the REAL requireAuth /
 * jwtOrApiKey over a regex-scripted db stub (same shape as
 * tests/portalAuth.test.js). Nothing is mocked.
 *
 * Run: npx jest tests/capabilities.test.js
 */
'use strict';

process.env.JWT_SECRET = 'capabilities-a1-test-secret';
process.env.INTERNAL_API_KEY = 'yci_capabilities_a1_internal';

const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

const { CAPABILITIES, ROLE_CAPS, can } = require('../lib/capabilities');
const requireAuth = require('../lib/auth.requireAuth');

const SECRET = process.env.JWT_SECRET;
const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

function stubDb(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: norm, params: params || [] });
      for (const h of handlers) if (h.re.test(norm)) return [h.rows];
      throw new Error('stubDb: unscripted query: ' + norm);
    },
  };
}

function stubRes() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.emit('finish'); return this; },
    set() { return this; },
  });
}

function runMw(mw, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = out => { if (!settled) { settled = true; resolve(out); } };
    const origJson = res.json;
    res.json = function (b) {
      const r = origJson.call(this, b);
      done({ via: 'res', status: this.statusCode, body: b });
      return r;
    };
    try {
      mw(req, res, err => (err ? reject(err) : done({ via: 'next' })));
    } catch (e) { reject(e); }
  });
}

function baseReq(overrides = {}) {
  return Object.assign({
    headers: {},
    body: {},
    query: {},
    originalUrl: '/api/app-settings',
    method: 'PUT',
    ip: '1.2.3.4',
    socket: { remoteAddress: '127.0.0.1' },
    db: stubDb([
      { re: /jwt_api_audit_log/, rows: { affectedRows: 1 } },
      { re: /FROM api_keys WHERE key_hash/, rows: [] },   // every external key unknown
    ]),
  }, overrides);
}

const tok = (claims = {}) => jwt.sign(Object.assign(
  { sub: 5, username: 'sb', user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1 },
  claims), SECRET, { expiresIn: '1h' });

const jwtAuth = (roles, extra = {}) => Object.assign(
  { type: 'jwt', userId: 5, user_auth: 'authorized', roles }, extra);

// ─────────────────────────────────────────────────────────────────────────────
// Registry snapshot — the deliberate-choice gate
// ─────────────────────────────────────────────────────────────────────────────

describe('capability registry', () => {
  test('capability names + root flags are exactly the reviewed snapshot', () => {
    const shape = Object.fromEntries(
      Object.entries(CAPABILITIES).map(([k, v]) => [k, v.root]));
    expect(shape).toEqual({
      'firm.settings': false,
      'users.manage': true,
      'automations.manage': false,
      'archives.purge': false,
      'comms.read_all': false,
      'templates.code': false,
      'tools.author': true,
    });
  });

  test('every capability carries a boolean root flag and a non-empty desc', () => {
    for (const [name, def] of Object.entries(CAPABILITIES)) {
      expect(typeof def.root).toBe('boolean');
      expect(typeof def.desc).toBe('string');
      expect(def.desc.trim()).not.toBe('');
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  test('ROLE_CAPS is exactly the reviewed snapshot (su and it absent)', () => {
    expect(ROLE_CAPS).toEqual({
      admin: ['firm.settings', 'automations.manage', 'archives.purge'],
      attorney: ['comms.read_all'],
      form_dev: ['templates.code'],
      staff: [],
      automation: [],
    });
  });

  test('ROLE_CAPS cites only registered capabilities', () => {
    for (const caps of Object.values(ROLE_CAPS)) {
      for (const c of caps) expect(Object.keys(CAPABILITIES)).toContain(c);
    }
  });

  test('registry is frozen — no runtime grant can sneak in', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(CAPABILITIES['tools.author'])).toBe(true);
    expect(Object.isFrozen(ROLE_CAPS)).toBe(true);
    expect(Object.isFrozen(ROLE_CAPS.admin)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// can() matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('can()', () => {
  const ALL = Object.keys(CAPABILITIES);
  const ROOT = ALL.filter(c => CAPABILITIES[c].root);
  const FIRM = ALL.filter(c => !CAPABILITIES[c].root);

  test('root and firm-grade sets are both non-empty (matrix is meaningful)', () => {
    expect(ROOT).toEqual(['users.manage', 'tools.author']);
    expect(FIRM.length).toBeGreaterThan(0);
  });

  test('su role passes every capability, root-grade included', () => {
    for (const c of ALL) expect(can(jwtAuth(['su']), c)).toBe(true);
  });

  test('legacy SU string alone (no su role) passes NOTHING since A2b', () => {
    const legacy = { type: 'jwt', userId: 6, user_auth: 'authorized - SU', roles: [] };
    for (const c of ALL) expect(can(legacy, c)).toBe(false);
    const noClaim = { type: 'jwt', userId: 6, user_auth: 'authorized - SU' };
    expect(can(noClaim, 'firm.settings')).toBe(false);
    // the string adds nothing to the roles it rides with
    const withAttorney = { type: 'jwt', userId: 6, user_auth: 'authorized - SU', roles: ['attorney'] };
    expect(ALL.filter(c => can(withAttorney, c))).toEqual(['comms.read_all']);
  });

  test('the legacy SU string is no credential on a portal-shaped auth either', () => {
    expect(can({ type: 'portal', user_auth: 'authorized - SU' }, 'firm.settings')).toBe(false);
  });

  test('it passes every firm-grade capability', () => {
    for (const c of FIRM) expect(can(jwtAuth(['it']), c)).toBe(true);
  });

  test('it NEVER passes a root-grade capability', () => {
    for (const c of ROOT) expect(can(jwtAuth(['it']), c)).toBe(false);
    // ...even stacked with every enumerated role
    const stacked = jwtAuth(['it', ...Object.keys(ROLE_CAPS)]);
    for (const c of ROOT) expect(can(stacked, c)).toBe(false);
  });

  test('admin: exactly firm.settings, automations.manage, archives.purge', () => {
    const a = jwtAuth(['admin']);
    expect(ALL.filter(c => can(a, c)))
      .toEqual(['firm.settings', 'automations.manage', 'archives.purge']);
  });

  test('attorney: exactly comms.read_all', () => {
    expect(ALL.filter(c => can(jwtAuth(['attorney']), c))).toEqual(['comms.read_all']);
  });

  test('form_dev: exactly templates.code', () => {
    expect(ALL.filter(c => can(jwtAuth(['form_dev']), c))).toEqual(['templates.code']);
  });

  test('multi-role holder gets the union', () => {
    const live6 = jwtAuth(['admin', 'form_dev']);   // user 6 minus it
    expect(can(live6, 'templates.code')).toBe(true);
    expect(can(live6, 'firm.settings')).toBe(true);
    expect(can(live6, 'comms.read_all')).toBe(false);
    const ss = jwtAuth(['staff', 'attorney']);      // user 1
    expect(ALL.filter(c => can(ss, c))).toEqual(['comms.read_all']);
  });

  test('staff, automation, no roles, unknown role: denied everything', () => {
    for (const roles of [['staff'], ['automation'], [], ['bogus'], ['constructor'], ['__proto__']]) {
      for (const c of ALL) expect(can(jwtAuth(roles), c)).toBe(false);
    }
    // missing roles claim on a non-SU token
    for (const c of ALL) expect(can({ type: 'jwt', user_auth: 'authorized' }, c)).toBe(false);
  });

  test('api_key = machine trust (Q3) — every capability, root included', () => {
    for (const c of ALL) {
      expect(can({ type: 'api_key', key_label: 'internal' }, c)).toBe(true);
      expect(can({ type: 'api_key', key_id: 3, key_label: 'zap' }, c)).toBe(true);
    }
  });

  test('portal, readonly_apikey, missing/empty auth: false', () => {
    for (const c of ALL) {
      expect(can({ type: 'portal', contactId: 7 }, c)).toBe(false);
      expect(can({ type: 'readonly_apikey', keyId: 1 }, c)).toBe(false);
      expect(can(undefined, c)).toBe(false);
      expect(can(null, c)).toBe(false);
      expect(can({}, c)).toBe(false);
    }
  });

  test('portal / readonly auth carrying an su/it roles array still false', () => {
    expect(can({ type: 'portal', roles: ['su'] }, 'firm.settings')).toBe(false);
    expect(can({ type: 'readonly_apikey', roles: ['it'] }, 'firm.settings')).toBe(false);
  });

  test('unknown capability throws — for every caller kind, before any allow', () => {
    const callers = [jwtAuth(['su']), { type: 'api_key' }, jwtAuth(['it']), undefined];
    for (const a of callers) {
      expect(() => can(a, 'firm.setting')).toThrow(/unknown capability "firm.setting"/);
      expect(() => can(a, undefined)).toThrow(/unknown capability/);
      expect(() => can(a, 'toString')).toThrow(/unknown capability/);
      expect(() => can(a, '__proto__')).toThrow(/unknown capability/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth({audience:'staff', can})
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAuth({audience:"staff", can})', () => {
  const auditRows = req => req.db.calls.filter(c => /jwt_api_audit_log/.test(c.sql));

  test('factory: unknown capability throws at mount', () => {
    expect(() => requireAuth({ audience: 'staff', can: 'firm.setting' }))
      .toThrow(/requireAuth: unknown capability "firm.setting"/);
    expect(() => requireAuth({ audience: 'staff', can: '' })).toThrow(/unknown capability/);
    expect(() => requireAuth({ audience: 'staff', can: 'hasOwnProperty' })).toThrow(/unknown capability/);
  });

  test('factory: roles and can together throw at mount', () => {
    expect(() => requireAuth({ audience: 'staff', roles: ['admin'], can: 'firm.settings' }))
      .toThrow(/roles OR can/);
    expect(() => requireAuth({ audience: 'staff', roles: [], can: 'firm.settings' }))
      .toThrow(/roles OR can/);
  });

  test('factory: a known capability mounts', () => {
    expect(typeof requireAuth({ audience: 'staff', can: 'firm.settings' })).toBe('function');
    expect(typeof requireAuth({ audience: 'staff', can: 'tools.author', allowApiKey: true })).toBe('function');
  });

  test('holder passes (next); req.auth is the jwtOrApiKey shape + roles', async () => {
    const mw = requireAuth({ audience: 'staff', can: 'firm.settings' });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['admin', 'staff'] }) } });
    const out = await runMw(mw, req, stubRes());
    expect(out.via).toBe('next');
    expect(req.auth).toEqual({
      type: 'jwt', userId: 5, username: 'sb', user_type: 'staff',
      user_auth: 'authorized', roles: ['admin', 'staff'],
    });
    await flush();
    expect(auditRows(req)).toHaveLength(1);
    expect(auditRows(req)[0].params[9]).toBe('authorized');
  });

  test('non-holder → 403 Forbidden, one unauthorized audit row, no req.auth', async () => {
    const mw = requireAuth({ audience: 'staff', can: 'firm.settings' });
    const req = baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['staff', 'attorney'] }) } });
    const out = await runMw(mw, req, stubRes());
    expect(out).toMatchObject({ via: 'res', status: 403, body: { error: 'Forbidden' } });
    expect(req.auth).toBeUndefined();
    await flush();
    const rows = auditRows(req);
    expect(rows).toHaveLength(1);
    // (route, method, headers, query, body, ip, ua, auth_type, username, status)
    expect(rows[0].params[7]).toBe('jwt');
    expect(rows[0].params[8]).toBe('sb');
    expect(rows[0].params[9]).toBe('unauthorized');
  });

  test('it: firm-grade passes, root-grade 403', async () => {
    const itTok = tok({ roles: ['it'] });
    const firm = await runMw(requireAuth({ audience: 'staff', can: 'firm.settings' }),
      baseReq({ headers: { authorization: 'Bearer ' + itTok } }), stubRes());
    expect(firm.via).toBe('next');
    const root = await runMw(requireAuth({ audience: 'staff', can: 'tools.author' }),
      baseReq({ headers: { authorization: 'Bearer ' + itTok } }), stubRes());
    expect(root).toMatchObject({ via: 'res', status: 403 });
  });

  test('su role passes a root-grade gate; the legacy SU string alone is 403 (A2b)', async () => {
    const mw = requireAuth({ audience: 'staff', can: 'tools.author' });
    const su = await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['su'] }) } }), stubRes());
    expect(su.via).toBe('next');
    const legacy = jwt.sign(
      { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized - SU', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const leg = await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + legacy } }), stubRes());
    expect(leg).toMatchObject({ via: 'res', status: 403 });
  });

  test('legacy non-SU token (no roles claim) fails a can gate CLOSED', async () => {
    const legacy = jwt.sign(
      { sub: 5, username: 'sb', user_type: 'staff', user_auth: 'authorized', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const out = await runMw(requireAuth({ audience: 'staff', can: 'templates.code' }),
      baseReq({ headers: { authorization: 'Bearer ' + legacy } }), stubRes());
    expect(out).toMatchObject({ via: 'res', status: 403 });
  });

  test('authn failures stay 401 ahead of the can gate', async () => {
    const mw = requireAuth({ audience: 'staff', can: 'firm.settings' });
    const portal = jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' });
    expect(await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + portal } }), stubRes()))
      .toMatchObject({ via: 'res', status: 401 });
    expect(await runMw(mw, baseReq({}), stubRes())).toMatchObject({ via: 'res', status: 401 });
    const disabled = tok({ user_auth: 'disabled', roles: ['su'] });
    expect(await runMw(mw, baseReq({ headers: { authorization: 'Bearer ' + disabled } }), stubRes()))
      .toMatchObject({ via: 'res', status: 401 });
  });

  test('no can and no roles: unchanged pass-through for any staff JWT', async () => {
    const out = await runMw(requireAuth({ audience: 'staff' }),
      baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['staff'] }) } }), stubRes());
    expect(out.via).toBe('next');
  });

  test('roles gate unchanged: it still bypasses a literal-role gate', async () => {
    const out = await runMw(requireAuth({ audience: 'staff', roles: ['admin'] }),
      baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['it'] }) } }), stubRes());
    expect(out.via).toBe('next');
    const deny = await runMw(requireAuth({ audience: 'staff', roles: ['admin'] }),
      baseReq({ headers: { authorization: 'Bearer ' + tok({ roles: ['form_dev'] }) } }), stubRes());
    expect(deny).toMatchObject({ via: 'res', status: 403 });
  });

  describe('allowApiKey', () => {
    test('internal api key passes even a root-grade can gate (machine trust, Q3)', async () => {
      const mw = requireAuth({ audience: 'staff', can: 'tools.author', allowApiKey: true });
      const req = baseReq({ headers: { 'x-api-key': process.env.INTERNAL_API_KEY } });
      const out = await runMw(mw, req, stubRes());
      expect(out.via).toBe('next');
      expect(req.auth.type).toBe('api_key');
    });

    test('unrecognized key + Bearer: JWT fallthrough applies the can gate', async () => {
      const mw = requireAuth({ audience: 'staff', can: 'firm.settings', allowApiKey: true });

      const denyReq = baseReq({ headers: {
        'x-api-key': 'yck_not_a_real_key', authorization: 'Bearer ' + tok({ roles: ['staff'] }) } });
      const deny = await runMw(mw, denyReq, stubRes());
      expect(deny).toMatchObject({ via: 'res', status: 403, body: { error: 'Forbidden' } });

      const okReq = baseReq({ headers: {
        'x-api-key': 'yck_not_a_real_key', authorization: 'Bearer ' + tok({ roles: ['admin'] }) } });
      const ok = await runMw(mw, okReq, stubRes());
      expect(ok.via).toBe('next');
      expect(okReq.auth.roles).toEqual(['admin']);
    });

    test('JWT fallthrough: it denied a root-grade gate', async () => {
      const mw = requireAuth({ audience: 'staff', can: 'users.manage', allowApiKey: true });
      const req = baseReq({ headers: {
        'x-api-key': 'yck_not_a_real_key', authorization: 'Bearer ' + tok({ roles: ['it'] }) } });
      expect(await runMw(mw, req, stubRes())).toMatchObject({ via: 'res', status: 403 });
    });
  });
});
