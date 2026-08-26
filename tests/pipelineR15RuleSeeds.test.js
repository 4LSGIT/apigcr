// tests/pipelineR15RuleSeeds.test.js
//
// R1.5 — the two seeded trigger rules that took over the pipeline advances
// formerly hardcoded in esignSendService and api.checklists.
//
// WHAT THIS FILE IS FOR
// ---------------------
// The advances R1.5 deleted from code did not vanish — they MOVED into
// ref/2026-08-26_pipeline_r15_rules.sql as trigger_rule_actions.config JSON.
// That JSON is data, so nothing in the normal build ever type-checks it, and
// the failure mode when it is wrong is the worst kind: the Aug 2026 rule-12
// postmortem established that a malformed csvList guard makes a rule report
// status 'matched', action 'success', reason 'guard' — indistinguishable in
// the executions view from a legitimately-guarded miss, while silently
// skipping 100% of the time.
//
// So the mappings are copied here as LITERALS and run through the same
// save-time validator services/triggerService._validateActions calls. Two
// things get caught:
//   1. a mapping that would be rejected (or silently unmatchable) at dispatch;
//   2. DRIFT — someone edits the SQL file, or edits a live rule and updates
//      the SQL, without updating the other. The literals below and the SQL
//      file must be read together; that is the point.
//
// KEEP IN SYNC WITH: ref/2026-08-26_pipeline_r15_rules.sql
//
// Run:
//   npx jest tests/pipelineR15RuleSeeds.test.js

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const internalFunctions = require('../lib/internal_functions');
const { EVENT_TYPES } = require('../services/triggerService');

const validateParamsMapping = internalFunctions.__validateParamsMapping;

// ─────────────────────────────────────────────────────────────────────────────
// THE SEEDS — copied verbatim from ref/2026-08-26_pipeline_r15_rules.sql.
//
// In the SQL these are JSON string literals inside the config column, with
// single quotes doubled for MySQL ('' → '). Un-doubled here, which is what
// the dispatcher actually sees after MySQL parses the row.
// ─────────────────────────────────────────────────────────────────────────────

/** Rule A — "Contract sent → contract_sent stage", event esign.sent. */
const RULE_A = {
  event: 'esign.sent',
  name: 'Contract sent → contract_sent stage',
  match_config: {
    operator: 'and',
    conditions: [
      { op: 'equals', path: 'data.kind', value: 'contract' },
      { op: 'exists', path: 'case_id' },
    ],
  },
  function_name: 'advance_stage',
  params_mapping: {
    case_id:        'case_id',
    stage:          "'contract_sent'",
    only_from_role: "'intake,none'",
    note:           "'Contract sent for signature'",
  },
};

/** Rule B — "Doc request sent → docs stage", event checklist.items_upserted. */
const RULE_B = {
  event: 'checklist.items_upserted',
  name: 'Doc request sent → docs stage',
  match_config: {
    operator: 'and',
    conditions: [
      { op: 'equals', path: 'data.tag', value: 'docs_needed' },
      { op: 'exists', path: 'case_id' },
    ],
  },
  function_name: 'advance_stage',
  params_mapping: {
    case_id:   'case_id',
    stage:     "'docs'",
    only_from: "'retained'",
    note:      "'Doc request sent'",
  },
};

const RULES = [RULE_A, RULE_B];

// ─────────────────────────────────────────────────────────────────────────────
// 1. The mappings would SAVE — the check _validateActions runs
// ─────────────────────────────────────────────────────────────────────────────

describe('seeded params_mapping passes save-time validation', () => {
  test.each(RULES.map((r) => [r.name, r]))('%s', (_name, rule) => {
    expect(validateParamsMapping(rule.function_name, rule.params_mapping)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The guards resolve to what the deleted CODE passed
//
// The migration's whole claim is "today's guards, verbatim". These assertions
// are that claim, mechanised — they replay the dispatcher's literal rule
// (lib/actionDispatchers.resolveParamsMapping: one outer quote pair stripped)
// and then the function's own parser, and compare against the arrays the
// deleted code handed advanceStage.
// ─────────────────────────────────────────────────────────────────────────────

/** resolveParamsMapping's literal rule, verbatim. */
function resolveLiteral(source) {
  if (typeof source !== 'string' || source.length < 2) return null;
  if (!(source.startsWith("'") && source.endsWith("'"))) return null;
  return source.slice(1, -1);
}

/** _csvGuard's parse, verbatim (lib/internal_functions/pipeline.js). */
function parseCsvGuard(resolved) {
  return String(resolved)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => (s.toLowerCase() === 'none' ? null : s));
}

describe('the guards mean exactly what the deleted code meant', () => {
  test("rule A: only_from_role 'intake,none' === the old ['intake', null]", () => {
    // esignSendService.sendFromTemplate passed:
    //   advanceStage(db, caseId, 'contract_sent', { onlyFromRole: ['intake', null], … })
    const resolved = resolveLiteral(RULE_A.params_mapping.only_from_role);
    expect(resolved).toBe('intake,none');
    expect(parseCsvGuard(resolved)).toEqual(['intake', null]);
  });

  test("rule B: only_from 'retained' === the old ['retained']", () => {
    // api.checklists.js upsert-items passed:
    //   advanceStage(req.db, caseId, 'docs', { onlyFrom: ['retained'], … })
    const resolved = resolveLiteral(RULE_B.params_mapping.only_from);
    expect(resolved).toBe('retained');
    expect(parseCsvGuard(resolved)).toEqual(['retained']);
  });

  test('the stage keys and notes are the ones the code used', () => {
    expect(resolveLiteral(RULE_A.params_mapping.stage)).toBe('contract_sent');
    expect(resolveLiteral(RULE_A.params_mapping.note)).toBe('Contract sent for signature');
    expect(resolveLiteral(RULE_B.params_mapping.stage)).toBe('docs');
    expect(resolveLiteral(RULE_B.params_mapping.note)).toBe('Doc request sent');
  });

  test('case_id is a BARE PATH, not a literal — it must resolve off the envelope', () => {
    // The single most likely authoring slip: quoting it. "'case_id'" would
    // send the literal string "case_id" to advance_stage as the case id, and
    // every dispatch would fail on an unknown case.
    for (const rule of RULES) {
      expect(resolveLiteral(rule.params_mapping.case_id)).toBeNull();
      expect(rule.params_mapping.case_id).toBe('case_id');
    }
  });

  test('NEITHER rule adopts forward_only in this slice', () => {
    // Deliberate: swapping a from-state whitelist for a direction check is a
    // behaviour change and belongs in its own slice with its own gates.
    for (const rule of RULES) {
      expect(rule.params_mapping).not.toHaveProperty('forward_only');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The rules point at events that actually exist
//
// A rule on an unregistered event type is inert forever and nothing says so.
// ─────────────────────────────────────────────────────────────────────────────

describe('the seeded rules bind to registered events and readable paths', () => {
  test.each(RULES.map((r) => [r.name, r]))('%s — event is in EVENT_TYPES', (_name, rule) => {
    expect(EVENT_TYPES[rule.event]).toBeDefined();
  });

  test.each(RULES.map((r) => [r.name, r]))(
    '%s — every match_config path is a published field', (_name, rule) => {
      const published = new Set(EVENT_TYPES[rule.event].fields.map((f) => f.path));
      for (const cond of rule.match_config.conditions) {
        expect(published.has(cond.path)).toBe(true);
      }
    }
  );

  test('advance_stage is a real internal function with the params these use', () => {
    const meta = internalFunctions.__getMeta('advance_stage');
    expect(meta).not.toBeNull();
    const names = new Set(meta.params.map((p) => p.name));
    for (const rule of RULES) {
      for (const param of Object.keys(rule.params_mapping)) {
        expect(names.has(param)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The validator can actually fail here
//
// Without this, every assertion above would still pass if
// __validateParamsMapping were accidentally reduced to `return null`.
// ─────────────────────────────────────────────────────────────────────────────

describe('the seed check is not vacuous', () => {
  test('the rule-12 multi-literal form IS rejected for these same params', () => {
    expect(validateParamsMapping('advance_stage', {
      ...RULE_A.params_mapping, only_from_role: "'intake','none'",
    })).not.toBeNull();

    expect(validateParamsMapping('advance_stage', {
      ...RULE_B.params_mapping, only_from: "'retained','filed'",
    })).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Drift guard — the SQL file still contains these exact strings
//
// The literals above are a COPY. This is the assertion that the copy is still
// faithful: if someone edits the SQL and not this file (or the reverse), the
// mismatch surfaces here rather than in production six weeks later.
// ─────────────────────────────────────────────────────────────────────────────

describe('ref/2026-08-26_pipeline_r15_rules.sql matches the literals above', () => {
  const sql = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ref', '2026-08-26_pipeline_r15_rules.sql'), 'utf8'
  );

  test.each(RULES.map((r) => [r.name, r]))('%s — rule name and event appear', (name, rule) => {
    expect(sql).toContain(`'${name}'`);
    expect(sql).toContain(`'${rule.event}'`);
  });

  test.each(RULES.map((r) => [r.name, r]))(
    '%s — the params_mapping JSON appears verbatim (MySQL-escaped)', (_name, rule) => {
      // The SQL doubles single quotes inside its string literal.
      const json = JSON.stringify({
        function_name: rule.function_name,
        params_mapping: rule.params_mapping,
      }).replace(/'/g, "''");
      expect(sql).toContain(json);
    }
  );

  test.each(RULES.map((r) => [r.name, r]))(
    '%s — the match_config JSON appears verbatim', (_name, rule) => {
      expect(sql).toContain(JSON.stringify(rule.match_config));
    }
  );
});
