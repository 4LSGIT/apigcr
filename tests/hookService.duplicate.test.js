/**
 * Tests for hookService.duplicateHook.
 *
 * WHAT DUPLICATE GUARANTEES:
 *   - deep copy: hook row + ALL target rows, in one db.withTransaction
 *   - the copy ALWAYS gets a FRESH random 8-char slug (slug is UNIQUE and is
 *     the live inbound endpoint /hooks/:slug — never shared, never "-copy")
 *   - the copy is ALWAYS created active=0 (literal in the SQL)
 *   - auth_type + auth_config copy VERBATIM (secrets included — inert on a
 *     virgin slug until traffic is pointed at it)
 *   - capture_mode resets to 'off' (literal in the SQL — live state is never
 *     copied) but captured_sample/captured_at ARE copied (they power the Test
 *     tab against the clone)
 *   - version is NOT in the insert column list (resets via column default)
 *   - name becomes "<source> (copy)", truncated to 255
 *   - targets copy verbatim: credential_id (FK reference), per-target
 *     conditions, per-target transform, active flag
 *   - absent source → null, and no transaction is opened
 *
 * The db is a scripted FAKE (the service takes `db` as a parameter). Nothing
 * is jest-mocked. Mirrors tests/ingestRuleService.duplicate.test.js.
 *
 * Run: npx jest tests/hookService.duplicate.test.js
 */

const hookService = require('../services/hookService');

function makeFakeDb(srcHook, srcTargets) {
  const state = {
    hookInsert: null,
    targetInserts: [],
    txOpened: 0,
    newHookId: 700,
  };

  function builtNewHook() {
    if (!state.hookInsert) return null;
    const p = state.hookInsert.params;
    // column order in the service INSERT (active=0 / capture_mode='off' literal):
    // slug, name, description, auth_type, auth_config,
    // filter_mode, filter_config, transform_mode, transform_config,
    // last_modified_by, captured_sample, captured_at
    return {
      id: state.newHookId,
      slug: p[0], name: p[1], description: p[2],
      auth_type: p[3], auth_config: p[4],
      filter_mode: p[5], filter_config: p[6],
      transform_mode: p[7], transform_config: p[8],
      active: 0, version: 1, last_modified_by: p[9],
      capture_mode: 'off', captured_sample: p[10], captured_at: p[11],
      modified_by_name: null,
    };
  }
  function builtNewTargets() {
    return state.targetInserts.map((ins, i) => {
      const p = ins.params;
      return {
        id: 7001 + i, hook_id: p[0], target_type: p[1], name: p[2],
        position: p[3], method: p[4], url: p[5], headers: p[6],
        credential_id: p[7], body_mode: p[8], body_template: p[9],
        config: p[10], conditions: p[11], transform_mode: p[12],
        transform_config: p[13], active: p[14],
      };
    });
  }

  const db = {
    state,
    query: async (sql, params) => {
      if (sql.includes('FROM hooks h') && sql.includes('WHERE h.id = ?')) {
        const id = params[0];
        if (id === srcHook?.id) return [[{ ...srcHook }]];
        if (id === state.newHookId) return [[builtNewHook()]];
        return [[]];
      }
      if (sql.includes('FROM hook_targets ht') && sql.includes('WHERE ht.hook_id = ?')) {
        const id = params[0];
        if (id === srcHook?.id) return [srcTargets.map(t => ({ ...t }))];
        if (id === state.newHookId) return [builtNewTargets()];
        return [[]];
      }
      throw new Error(`fake db: unexpected query: ${sql}`);
    },
    withTransaction: async (fn) => {
      state.txOpened++;
      const conn = {
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO hooks')) {
            state.hookInsert = { sql, params };
            return [{ insertId: state.newHookId }];
          }
          if (sql.includes('INSERT INTO hook_targets')) {
            state.targetInserts.push({ sql, params });
            return [{ insertId: 7001 + state.targetInserts.length - 1 }];
          }
          throw new Error(`fake conn: unexpected query: ${sql}`);
        },
      };
      return fn(conn);
    },
  };
  return db;
}

const SRC_HOOK = {
  id: 12,
  slug: 'calendly-new-lead',
  name: 'Calendly New Lead',
  description: 'inbound booking events',
  auth_type: 'hmac',
  auth_config: { secret: 'shh-hmac', header: 'X-Sig', algorithm: 'sha256' },
  filter_mode: 'conditions',
  filter_config: { operator: 'and', conditions: [{ path: 'event', op: 'equals', value: 'invitee.created' }] },
  transform_mode: 'mapper',
  transform_config: [{ from: 'payload.email', to: 'email' }],
  active: 1,
  version: 7,
  last_modified_by: 1,
  capture_mode: 'capturing',
  captured_sample: { event: 'invitee.created', payload: { email: 'x@y.com' } },
  captured_at: '2026-07-10 09:00:00',
  modified_by_name: 'stuart',
  // joined extras from getHookById's target query never appear on the hook row
};

const SRC_TARGETS = [
  { id: 31, hook_id: 12, target_type: 'http', name: 'Notify CRM', position: 0,
    method: 'POST', url: 'https://crm.example.com/in', headers: { 'X-K': 'v' },
    credential_id: 5, body_mode: 'template', body_template: '{"email":"{{email}}"}',
    config: null, conditions: { operator: 'and', conditions: [] },
    transform_mode: 'passthrough', transform_config: null, active: 1,
    cred_name: 'CRM key', cred_type: 'api_key' },      // joined extras — must NOT leak
  { id: 32, hook_id: 12, target_type: 'workflow', name: 'Start intake', position: 1,
    method: 'POST', url: null, headers: null,
    credential_id: null, body_mode: 'transform_output', body_template: null,
    config: { workflow_id: 9 }, conditions: null,
    transform_mode: 'mapper', transform_config: [{ from: 'email', to: 'contact_email' }], active: 0,
    cred_name: null, cred_type: null },
];

describe('hookService.duplicateHook', () => {

  test('deep-copies hook + targets: fresh slug, inactive, capture off, one tx', async () => {
    const db = makeFakeDb(SRC_HOOK, SRC_TARGETS);
    const out = await hookService.duplicateHook(db, 12, 99);

    expect(db.state.txOpened).toBe(1);

    const hi = db.state.hookInsert;
    // literals: active=0 and capture_mode='off' are hard-coded in the SQL
    expect(hi.sql).toMatch(/, 0, \?, 'off',/);
    // version resets via column default — never in the column list
    expect(hi.sql).not.toMatch(/\bversion\b/);
    // fresh random slug: 8 chars, not the source's, not "-copy"
    expect(hi.params[0]).toHaveLength(8);
    expect(hi.params[0]).not.toBe('calendly-new-lead');
    expect(hi.params[0]).not.toMatch(/copy/);
    expect(hi.params[1]).toBe('Calendly New Lead (copy)');
    expect(hi.params[2]).toBe('inbound booking events');
    // auth verbatim (stringified), secret included
    expect(hi.params[3]).toBe('hmac');
    expect(JSON.parse(hi.params[4])).toEqual(SRC_HOOK.auth_config);
    expect(JSON.parse(hi.params[6])).toEqual(SRC_HOOK.filter_config);
    expect(JSON.parse(hi.params[8])).toEqual(SRC_HOOK.transform_config);
    expect(hi.params[9]).toBe(99);                                  // duplicating user
    expect(JSON.parse(hi.params[10])).toEqual(SRC_HOOK.captured_sample); // sample copied
    expect(hi.params[11]).toBe('2026-07-10 09:00:00');

    // targets: both rows, joined extras (cred_name/cred_type) never in params
    expect(db.state.targetInserts).toHaveLength(2);
    const [t0, t1] = db.state.targetInserts;
    expect(t0.params).toEqual([
      700, 'http', 'Notify CRM', 0, 'POST', 'https://crm.example.com/in',
      JSON.stringify({ 'X-K': 'v' }), 5, 'template', '{"email":"{{email}}"}',
      null, JSON.stringify({ operator: 'and', conditions: [] }), 'passthrough', null, 1,
    ]);
    expect(t1.params).toEqual([
      700, 'workflow', 'Start intake', 1, 'POST', null, null,
      null, 'transform_output', null, JSON.stringify({ workflow_id: 9 }),
      null, 'mapper', JSON.stringify([{ from: 'email', to: 'contact_email' }]), 0,
    ]);
    for (const ins of db.state.targetInserts) {
      expect(ins.params).not.toContain('CRM key');
      expect(ins.params).not.toContain('api_key');
    }

    // returned shape
    expect(out.id).toBe(700);
    expect(out.active).toBe(0);
    expect(out.capture_mode).toBe('off');
    expect(out.targets).toHaveLength(2);
    expect(out.targets[0].hook_id).toBe(700);
  });

  test('two duplicates of the same source get different slugs', async () => {
    const db1 = makeFakeDb(SRC_HOOK, []);
    const db2 = makeFakeDb(SRC_HOOK, []);
    await hookService.duplicateHook(db1, 12, 1);
    await hookService.duplicateHook(db2, 12, 1);
    expect(db1.state.hookInsert.params[0]).not.toBe(db2.state.hookInsert.params[0]);
  });

  test('absent source → null, no transaction opened', async () => {
    const db = makeFakeDb(SRC_HOOK, SRC_TARGETS);
    const out = await hookService.duplicateHook(db, 999, 1);
    expect(out).toBeNull();
    expect(db.state.txOpened).toBe(0);
    expect(db.state.hookInsert).toBeNull();
  });

  test('name truncates to 255 with the suffix; zero targets copies cleanly', async () => {
    const db = makeFakeDb({ ...SRC_HOOK, name: 'x'.repeat(255) }, []);
    const out = await hookService.duplicateHook(db, 12, null);
    expect(db.state.hookInsert.params[1]).toHaveLength(255);
    expect(db.state.targetInserts).toHaveLength(0);
    expect(out.targets).toEqual([]);
  });
});