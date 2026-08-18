// tests/paramsMappingCsvList.test.js
//
// Save-time half of the Aug 2026 trigger rule 12 postmortem.
//
// The runtime half (advance_stage throwing on a quote-bearing guard) lives in
// tests/pipelineInternalFn.guard.test.js. This file covers the check that fires
// BEFORE a rule is ever dispatched: internalFunctions.__validateParamsMapping,
// wired into services/triggerService._validateActions.
//
// The distinction that made the bug survive a fix attempt: saving a rule writes
// JSON to trigger_rule_actions.config and never calls the internal function, so
// a runtime-only guard stays silent until a live event fires. _validateActions
// already carried a comment calling that shape a booby trap; this closes it for
// csvList params.
//
// Run:
//   npx jest tests/paramsMappingCsvList.test.js

'use strict';

const internalFunctions = require('../lib/internal_functions');
const validate = internalFunctions.__validateParamsMapping;

// The exact value that shipped to production on trigger rule 12.
const SHIPPED_BUG = "'lead','none'";
const CORRECT     = "'lead,none'";

describe('__validateParamsMapping — rejects the multi-literal form', () => {
  test('the production value is rejected', () => {
    const r = validate('advance_stage', { only_from: SHIPPED_BUG });
    expect(r).not.toBeNull();
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/only_from/);
  });

  test('error names the correct form AND shows what the bad one resolves to', () => {
    const { error } = validate('advance_stage', { only_from: SHIPPED_BUG });
    expect(error).toContain("'lead,none'");   // what to write instead
    expect(error).toContain("lead','none");   // what theirs actually becomes
  });

  test('only_from_role is covered by the same flag', () => {
    const r = validate('advance_stage', { only_from_role: "'intake','none'" });
    expect(r).not.toBeNull();
    expect(r.error).toMatch(/only_from_role/);
  });

  test('a literal that splits to nothing is rejected, matching the runtime guard', () => {
    const r = validate('advance_stage', { only_from: "',,,'" });
    expect(r).not.toBeNull();
    expect(r.error).toMatch(/must contain at least one entry/);
  });
});

describe('__validateParamsMapping — accepts everything legitimate', () => {
  test('the correct single-literal form', () => {
    expect(validate('advance_stage', { only_from: CORRECT })).toBeNull();
  });

  test('a longer list', () => {
    expect(
      validate('advance_stage', { only_from: "'lead,consult_booked,none'" })
    ).toBeNull();
  });

  test('a full realistic mapping', () => {
    expect(validate('advance_stage', {
      case_id:   'case_id',
      stage:     "'intake_complete'",
      note:      "'Auto: intake form submitted'",
      only_from: "'lead,consult_booked,none'",
    })).toBeNull();
  });

  test('blank literal degrades to unguarded, exactly as the runtime does', () => {
    expect(validate('advance_stage', { only_from: "''" })).toBeNull();
    expect(validate('advance_stage', { only_from: "'   '" })).toBeNull();
  });

  test('a dot-path mapping is unknowable at save time and passes through', () => {
    // The resolved value is not available until dispatch — the runtime guard
    // owns this case. Rejecting here would break legitimate dynamic guards.
    expect(validate('advance_stage', { only_from: 'some.field' })).toBeNull();
    expect(validate('advance_stage', { only_from: '$' })).toBeNull();
  });
});

describe('__validateParamsMapping — scope is narrow by design', () => {
  test('a non-csvList param may legitimately contain an apostrophe', () => {
    // This is WHY quote rejection is declared per-param rather than applied to
    // every literal: prose params take apostrophes, stage_keys never do.
    expect(validate('advance_stage', {
      note: "'Client's intake received'",
    })).toBeNull();
  });

  test('functions without meta pass through (legacy permissive behavior)', () => {
    expect(validate('no_such_function_exists', { only_from: SHIPPED_BUG })).toBeNull();
  });

  test('null / absent mapping is not an error', () => {
    expect(validate('advance_stage', null)).toBeNull();
    expect(validate('advance_stage', undefined)).toBeNull();
    expect(validate('advance_stage', {})).toBeNull();
  });

  test('a non-object mapping is rejected', () => {
    expect(validate('advance_stage', ['lead'])).not.toBeNull();
    expect(validate('advance_stage', 'lead')).not.toBeNull();
  });

  test('no function name → no opinion', () => {
    expect(validate('', { only_from: SHIPPED_BUG })).toBeNull();
    expect(validate(null, { only_from: SHIPPED_BUG })).toBeNull();
  });
});

describe('csvList also guards the DIRECT-value surface (workflow steps, scheduled jobs)', () => {
  const validateParams = internalFunctions.__validateFunctionParams;

  test('bare CSV — the workflow-step convention — is accepted', () => {
    expect(validateParams('advance_stage', {
      case_id: '{{case_id}}', stage: 'intake_complete', only_from: 'lead,consult_booked',
    })).toBeNull();
  });

  test('quotes typed into a workflow step are rejected there too', () => {
    const r = validateParams('advance_stage', {
      case_id: '{{case_id}}', stage: 'intake_complete', only_from: "'lead','none'",
    });
    expect(r).not.toBeNull();
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/only_from/);
  });

  test('a placeholder value is unknowable and passes through', () => {
    expect(validateParams('advance_stage', {
      case_id: '{{case_id}}', stage: 'intake_complete', only_from: '{{allowed_stages}}',
    })).toBeNull();
  });
});

describe('the validator return shape serves both caller conventions', () => {
  // triggerService throws a 400; the ingest validators accumulate
  // {field, message} pairs and need the param NAME to build a field path.
  test('a failure carries status, error, and param', () => {
    const r = validate('advance_stage', { only_from: SHIPPED_BUG });
    expect(r.status).toBe(400);
    expect(typeof r.error).toBe('string');
    expect(r.param).toBe('only_from');
  });

  test('param identifies which guard failed when both are present', () => {
    const r = validate('advance_stage', {
      only_from: "'lead,none'",          // fine
      only_from_role: "'intake','none'", // broken
    });
    expect(r.param).toBe('only_from_role');
  });
});