/**
 * tests/ingestRuleService.transformFailure.test.js
 *
 * T6/F-3 — a matched rule whose TRANSFORM fails must emit a synthetic
 * failed action outcome, on BOTH emailIngestRuleService and
 * phoneIngestRuleService (their transform paths are line-identical).
 *
 * WHY THIS MATTERS: before F-3, a transform failure recorded only
 * metadata._parse_warnings — no action outcome was written, `status` stayed
 * green, action_failure_count stayed 0, and lib/alerting.js (which watches
 * only action_outcomes) never fired. That is the same silent-failure class
 * as phone execution #4529, with NO detector at all.
 *
 * WHAT THE SYNTHETIC OUTCOME GUARANTEES (both services, symmetric):
 *   - shape: { rule_id, rule_action_id:null, action_type:'transform',
 *              status:'failed', error }
 *   - the rule still counts as MATCHED (matchedRuleIds records it)
 *   - the rule's real actions do NOT dispatch (actions skipped — the
 *     synthetic entry is the ONLY outcome, even though the rule has an
 *     active action)
 *   - parseWarnings STILL carries the human-readable diagnostic (the
 *     outcome entry does not replace it)
 *   - a rule whose transform SUCCEEDS produces no synthetic entry
 *     (regression guard, exercised with a zero-action passthrough rule so
 *     no dispatcher runs)
 *
 * COUNTABILITY: the generated column expression
 *   COALESCE(JSON_LENGTH(JSON_SEARCH(
 *     JSON_EXTRACT(metadata,'$.action_outcomes[*].status'),'all','failed')),0)
 * matches any array entry whose status string is 'failed' — the synthetic
 * entry qualifies exactly like a real failed action. Verified against live
 * MySQL 8.4 with the synthetic shape as a JSON literal (T6 verification
 * step 4; SELECT over the literal returned 1). This test proves the JS
 * side: the entry is written with status:'failed' into the same array the
 * column reads.
 *
 * The db is a scripted FAKE (the services take `db` as a parameter; nothing
 * is jest-mocked). Mirrors the fake-db style of
 * tests/ingestRuleService.duplicate.test.js. The transform failure path
 * never reaches _dispatchAction, so lib/actionDispatchers is never invoked;
 * the fake db only has to answer listActiveRules' two SELECTs and swallow
 * the fire-and-forget _bumpMetrics UPDATE.
 *
 * Run: npx jest tests/ingestRuleService.transformFailure.test.js
 */

const emailSvc = require('../services/emailIngestRuleService');
const phoneSvc = require('../services/phoneIngestRuleService');

const ALWAYS_MATCH = { operator: 'and', conditions: [] };  // documented always-match
const THROWING_CODE = { code: 'throw new Error("boom from test")' };

/**
 * Fake db for one evaluateRules call.
 *   - answers `FROM <prefix>_rules WHERE active = 1`        → rules
 *   - answers `FROM <prefix>_rule_actions`                  → actions
 *   - swallows the fire-and-forget _bumpMetrics UPDATE (recorded)
 *   - anything else → empty result (and recorded, so a test can assert the
 *     dispatcher never touched the db)
 */
function makeFakeDb(tablePrefix, rules, actions) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes(`FROM ${tablePrefix}_rules`))        return [rules.map(r => ({ ...r }))];
      if (sql.includes(`FROM ${tablePrefix}_rule_actions`)) return [actions.map(a => ({ ...a }))];
      if (sql.includes(`UPDATE ${tablePrefix}_rules`))      return [{}];
      return [[]];
    },
  };
}

function failingRule(id) {
  return {
    id,
    name: `t6-f3 failing transform ${id}`,
    match_mode: 'conditions',
    match_config: ALWAYS_MATCH,
    transform_mode: 'code',
    transform_config: THROWING_CODE,
  };
}

function passthroughRule(id) {
  return {
    id,
    name: `t6-f3 clean passthrough ${id}`,
    match_mode: 'conditions',
    match_config: ALWAYS_MATCH,
    transform_mode: 'passthrough',
    transform_config: null,
  };
}

// One active action on the failing rule — its NON-dispatch is part of the
// contract under test. action_type 'http' is arbitrary; it must never run.
function actionRow(id, ruleId) {
  return { id, rule_id: ruleId, action_type: 'http', config: { url: 'https://example.invalid' }, position: 1 };
}

const CASES = [
  {
    label: 'emailIngestRuleService',
    svc: emailSvc,
    prefix: 'email_ingest',
    input: { from: { email: 'x@example.com' }, subject: 't6', text: 'hello' },
  },
  {
    label: 'phoneIngestRuleService',
    svc: phoneSvc,
    prefix: 'phone_ingest',
    input: { type: 'sms', direction: 'in', from: '2485551234', message: 'hello' },
  },
];

describe.each(CASES)('$label — transform failure emits synthetic outcome (T6/F-3)', ({ svc, prefix, input }) => {
  test('thrown code transform → one synthetic failed outcome, actions skipped, warning kept', async () => {
    const rule = failingRule(7);
    const db = makeFakeDb(prefix, [rule], [actionRow(71, 7)]);

    const res = await svc.evaluateRules(db, input);

    // Rule matched.
    expect(res.matchedRuleIds).toEqual([7]);

    // Exactly ONE outcome — the synthetic one. The rule's real action was
    // skipped (no second entry) and the dispatcher never ran.
    expect(res.actionOutcomes).toHaveLength(1);
    expect(res.actionOutcomes[0]).toEqual({
      rule_id:        7,
      rule_action_id: null,
      action_type:    'transform',
      status:         'failed',
      error:          'code transform threw: boom from test',
    });

    // The generated column counts entries with status === 'failed' — the
    // synthetic entry is countable (JS-side mirror of the SQL expression).
    const countable = res.actionOutcomes.filter(o => o && o.status === 'failed');
    expect(countable).toHaveLength(1);

    // parseWarnings still carries the human-readable diagnostic.
    expect(res.parseWarnings).toHaveLength(1);
    expect(res.parseWarnings[0]).toContain('transform failed');
    expect(res.parseWarnings[0]).toContain('boom from test');
    expect(res.parseWarnings[0]).toContain('actions skipped');

    // The fake db saw ONLY the two listActiveRules SELECTs (plus, possibly,
    // the fire-and-forget metrics UPDATE) — no dispatcher activity.
    const nonBump = db.queries.filter(q => !q.sql.includes(`UPDATE ${prefix}_rules`));
    expect(nonBump).toHaveLength(2);
    expect(nonBump[0].sql).toContain(`FROM ${prefix}_rules`);
    expect(nonBump[1].sql).toContain(`FROM ${prefix}_rule_actions`);
  });

  test('successful transform emits NO synthetic entry (regression guard)', async () => {
    // Zero-action passthrough rule: matches, transform succeeds, nothing
    // dispatches — actionOutcomes must be empty, parseWarnings empty.
    const rule = passthroughRule(8);
    const db = makeFakeDb(prefix, [rule], []);

    const res = await svc.evaluateRules(db, input);

    expect(res.matchedRuleIds).toEqual([8]);
    expect(res.actionOutcomes).toEqual([]);
    expect(res.parseWarnings).toEqual([]);
  });

  test('mixed rules: failing transform + clean rule → one synthetic entry only', async () => {
    // Two matched rules; only the broken one contributes an outcome. Proves
    // the synthetic entry is per-failing-rule, not per-evaluation.
    const db = makeFakeDb(prefix, [failingRule(7), passthroughRule(8)], [actionRow(71, 7)]);

    const res = await svc.evaluateRules(db, input);

    expect(res.matchedRuleIds).toEqual([7, 8]);
    expect(res.actionOutcomes).toHaveLength(1);
    expect(res.actionOutcomes[0].action_type).toBe('transform');
    expect(res.actionOutcomes[0].rule_id).toBe(7);
    expect(res.parseWarnings).toHaveLength(1);
  });
});
