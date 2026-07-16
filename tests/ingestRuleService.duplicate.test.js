/**
 * Tests for duplicateRule on emailIngestRuleService + phoneIngestRuleService.
 *
 * WHAT DUPLICATE GUARANTEES (both services, symmetric):
 *   - deep copy: rule row + ALL its action rows, in one db.withTransaction
 *   - the copy is ALWAYS created active=0 (a half-configured clone must never
 *     fire on live traffic — the UI edits then activates)
 *   - name becomes "<source> (copy)", truncated to 255
 *   - pipeline-owned columns (match_count, last_matched_at) are NOT in the
 *     insert column list — they start fresh via column defaults
 *   - transform passthrough forces transform_config NULL
 *   - absent source → null, and no transaction is opened
 *   - NO validator round-trip (source rows already passed validation; the
 *     copy is byte-identical config)
 *
 * The db is a scripted FAKE (the services take `db` as a parameter; nothing
 * is jest-mocked). Mirrors the fake-db style of
 * tests/phoneingestservice.dedup.test.js.
 *
 * Run: npx jest tests/ingestRuleService.duplicate.test.js
 */

const emailSvc = require('../services/emailIngestRuleService');
const phoneSvc = require('../services/phoneIngestRuleService');

/**
 * Fake db for one duplicateRule call.
 *   - getById(srcId): SELECT rules WHERE id → [srcRule]; SELECT actions → srcActions
 *   - withTransaction(fn): runs fn with a conn that records INSERTs and
 *     hands out insertIds starting at 900 (rule) / 9001+ (actions)
 *   - getById(newId): rebuilt row from the captured rule INSERT + captured
 *     action INSERTs, so the returned shape reflects what was actually written
 */
function makeFakeDb(tablePrefix, srcRule, srcActions) {
  const rulesTable   = `${tablePrefix}_rules`;
  const actionsTable = `${tablePrefix}_rule_actions`;
  const state = {
    ruleInsert: null,          // { sql, params }
    actionInserts: [],         // [{ sql, params }]
    txOpened: 0,
    newRuleId: 900,
  };

  function builtNewRule() {
    if (!state.ruleInsert) return null;
    const p = state.ruleInsert.params;
    // column order in the service INSERT:
    // name, description, position, match_mode, match_config,
    // transform_mode, transform_config, last_modified_by  (active is literal 0)
    return {
      id: state.newRuleId,
      name: p[0], description: p[1], active: 0, position: p[2],
      match_mode: p[3], match_config: p[4],
      transform_mode: p[5], transform_config: p[6],
      match_count: 0, last_matched_at: null,
      last_modified_by: p[7], created_at: 'now', updated_at: 'now',
    };
  }
  function builtNewActions() {
    return state.actionInserts.map((ins, i) => ({
      id: 9001 + i,
      rule_id: ins.params[0], position: ins.params[1], active: ins.params[2],
      action_type: ins.params[3], config: ins.params[4],
    }));
  }

  const db = {
    state,
    query: async (sql, params) => {
      if (sql.includes(`FROM ${rulesTable} WHERE id = ?`)) {
        const id = params[0];
        if (id === srcRule?.id) return [[{ ...srcRule }]];
        if (id === state.newRuleId) return [[builtNewRule()]];
        return [[]];
      }
      if (sql.includes(`FROM ${actionsTable}`)) {
        const id = params[0];
        if (id === srcRule?.id) return [srcActions.map(a => ({ ...a }))];
        if (id === state.newRuleId) return [builtNewActions()];
        return [[]];
      }
      throw new Error(`fake db: unexpected query: ${sql}`);
    },
    withTransaction: async (fn) => {
      state.txOpened++;
      const conn = {
        query: async (sql, params) => {
          if (sql.includes(`INSERT INTO ${rulesTable}`)) {
            state.ruleInsert = { sql, params };
            return [{ insertId: state.newRuleId }];
          }
          if (sql.includes(`INSERT INTO ${actionsTable}`)) {
            state.actionInserts.push({ sql, params });
            return [{ insertId: 9001 + state.actionInserts.length - 1 }];
          }
          throw new Error(`fake conn: unexpected query: ${sql}`);
        },
      };
      return fn(conn);
    },
  };
  return db;
}

const SRC_RULE = {
  id: 42,
  name: 'Court FW: Fee Waiver Order',
  description: 'forward to SB',
  active: 1,
  position: 105,
  match_mode: 'conditions',
  match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'Filing Fee Waived' }] },
  transform_mode: 'passthrough',
  transform_config: null,
  match_count: 31,
  last_matched_at: '2026-07-15 12:00:00',
  last_modified_by: 1,
};

const SRC_ACTIONS = [
  { id: 7, rule_id: 42, position: 0, active: 1, action_type: 'internal_function',
    config: { function_name: 'forward_as_email', params_mapping: { event: '$', to: "'sb@4lsg.com'" } } },
  { id: 8, rule_id: 42, position: 1, active: 0, action_type: 'workflow',
    config: { workflow_id: 23 } },
];

// ── run the same assertions against both services ──
describe.each([
  ['emailIngestRuleService', emailSvc, 'email_ingest'],
  ['phoneIngestRuleService', phoneSvc, 'phone_ingest'],
])('%s.duplicateRule', (_label, svc, prefix) => {

  test('deep-copies rule + actions, inactive, "(copy)" name, one transaction', async () => {
    const db = makeFakeDb(prefix, SRC_RULE, SRC_ACTIONS);
    const out = await svc.duplicateRule(db, 42, 99);

    expect(db.state.txOpened).toBe(1);

    // rule insert: literal active=0 in SQL, name suffixed, scalars copied
    const ri = db.state.ruleInsert;
    expect(ri.sql).toMatch(/VALUES \(\?, \?, 0, \?/);          // hard-coded inactive
    expect(ri.sql).not.toMatch(/match_count|last_matched_at/); // pipeline-owned, never copied
    expect(ri.params[0]).toBe('Court FW: Fee Waiver Order (copy)');
    expect(ri.params[1]).toBe('forward to SB');
    expect(ri.params[2]).toBe(105);                            // position
    expect(ri.params[3]).toBe('conditions');
    expect(JSON.parse(ri.params[4])).toEqual(SRC_RULE.match_config);
    expect(ri.params[5]).toBe('passthrough');
    expect(ri.params[6]).toBeNull();                           // passthrough → NULL
    expect(ri.params[7]).toBe(99);                             // duplicating user, not source's

    // action inserts: both rows, config stringified, active + position preserved
    expect(db.state.actionInserts).toHaveLength(2);
    const [a0, a1] = db.state.actionInserts;
    expect(a0.params).toEqual([900, 0, 1, 'internal_function', JSON.stringify(SRC_ACTIONS[0].config)]);
    expect(a1.params).toEqual([900, 1, 0, 'workflow', JSON.stringify(SRC_ACTIONS[1].config)]);

    // returned shape: the fresh row with its copied actions
    expect(out.id).toBe(900);
    expect(out.active).toBe(0);
    expect(out.name).toBe('Court FW: Fee Waiver Order (copy)');
    expect(out.actions).toHaveLength(2);
    expect(out.actions[0].rule_id).toBe(900);
  });

  test('absent source → null, no transaction opened', async () => {
    const db = makeFakeDb(prefix, SRC_RULE, SRC_ACTIONS);
    const out = await svc.duplicateRule(db, 12345, 99);
    expect(out).toBeNull();
    expect(db.state.txOpened).toBe(0);
    expect(db.state.ruleInsert).toBeNull();
  });

  test('name truncates to 255 with the suffix', async () => {
    const longName = 'x'.repeat(255);
    const db = makeFakeDb(prefix, { ...SRC_RULE, name: longName }, []);
    await svc.duplicateRule(db, 42, null);
    const written = db.state.ruleInsert.params[0];
    expect(written.length).toBe(255);
    expect(written.startsWith('xxx')).toBe(true);
  });

  test('rule with zero actions copies cleanly', async () => {
    const db = makeFakeDb(prefix, SRC_RULE, []);
    const out = await svc.duplicateRule(db, 42, 1);
    expect(db.state.actionInserts).toHaveLength(0);
    expect(out.actions).toEqual([]);
  });

  test('non-passthrough transform_config is copied (stringified)', async () => {
    const src = { ...SRC_RULE, transform_mode: 'mapper', transform_config: [{ from: 'subject', to: 'title' }] };
    const db = makeFakeDb(prefix, src, []);
    await svc.duplicateRule(db, 42, 1);
    const ri = db.state.ruleInsert;
    expect(ri.params[5]).toBe('mapper');
    expect(JSON.parse(ri.params[6])).toEqual([{ from: 'subject', to: 'title' }]);
  });
});