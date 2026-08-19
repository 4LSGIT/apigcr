/**
 * tests/ingestService.evaluatorFailure.test.js
 *
 * T7/F-8 — when Layer-3's evaluateRules ITSELF throws (rule-loader / DB
 * failure), the ingest services must record a countable failed outcome, not
 * just a _parse_warnings string.
 *
 * THE BUG THIS LOCKS SHUT: the step-6b/3b catch produced
 *   { matchedRuleIds: [], actionOutcomes: [], parseWarnings: [msg] }
 * and _buildMetadata gated the action_outcomes write on
 * matchedRuleIds.length — so the outcome array was dropped, metadata carried
 * only _parse_warnings, action_failure_count stayed 0, lib/alerting.js (which
 * reads only action_outcomes) never fired, and Activity's failures union
 * never saw it. A TOTAL Layer-3 outage was quieter than one failed action
 * inside it. T6/F-3 closed the same class for transform failures; this is the
 * last one.
 *
 * WHAT IS ASSERTED (both services, symmetric):
 *   - the synthetic entry survives _buildMetadata with no matched rule
 *   - matched_rules is NOT fabricated (it would corrupt the has_match filter)
 *   - the entry is countable by the generated column's JS-equivalent
 *     (status === 'failed' in the action_outcomes array)
 *   - _parse_warnings is still written alongside it
 *   - REGRESSION GUARD: a matched rule with no actions still writes
 *     action_outcomes: [] — 38 live email rows carry that exact shape, and
 *     gating the write on actionOutcomes.length would have silently changed
 *     it
 *
 * _buildMetadata is pure (no db, no I/O), so this tests it directly. The
 * catch block's literal is asserted separately against the source text —
 * cheap, and it fails loudly if someone edits the shape in one service and
 * not the other.
 *
 * Run: npx jest tests/ingestService.evaluatorFailure.test.js
 */

const fs   = require('fs');
const path = require('path');

const emailSvc = require('../services/emailIngestService');
const phoneSvc = require('../services/phoneIngestService');

// The exact object the step-6b/3b catch synthesizes.
const EVALUATOR_OUTCOME = {
  rule_id:        null,
  rule_action_id: null,
  action_type:    'rule_evaluation',
  status:         'failed',
  error:          'evaluateRules threw: Table \'x\' doesn\'t exist',
};

// What the catch hands to _buildMetadata when the evaluator threw.
function thrownAutomation() {
  return {
    matchedRuleIds: [],
    actionOutcomes: [{ ...EVALUATOR_OUTCOME }],
    parseWarnings:  ['evaluateRules threw: Table \'x\' doesn\'t exist'],
  };
}

// JS mirror of the generated column:
//   COALESCE(JSON_LENGTH(JSON_SEARCH(
//     JSON_EXTRACT(metadata,'$.action_outcomes[*].status'),'all','failed')),0)
function actionFailureCount(metadata) {
  const arr = metadata && metadata.action_outcomes;
  if (!Array.isArray(arr)) return 0;
  return arr.filter(o => o && o.status === 'failed').length;
}

const CASES = [
  { label: 'emailIngestService', svc: emailSvc, file: 'services/emailIngestService.js' },
  { label: 'phoneIngestService', svc: phoneSvc, file: 'services/phoneIngestService.js' },
];

describe.each(CASES)('$label — evaluator failure is countable (T7/F-8)', ({ svc, file }) => {
  test('_buildMetadata keeps the synthetic outcome when NO rule matched', () => {
    const m = svc._buildMetadata(null, thrownAutomation());

    expect(m).not.toBeNull();
    expect(m.action_outcomes).toEqual([EVALUATOR_OUTCOME]);

    // The whole point: the generated column now sees it.
    expect(actionFailureCount(m)).toBe(1);

    // No rule matched — do not fabricate one (has_match keys off this).
    expect(m.matched_rules).toBeUndefined();

    // The human-readable diagnostic is retained, not replaced.
    expect(m._parse_warnings).toHaveLength(1);
    expect(m._parse_warnings[0]).toContain('evaluateRules threw');
  });

  test('suppression context does not swallow the outcome', () => {
    // Phone's suppressed path and email's INVALID_LOG_LINK_ID path both call
    // _buildMetadata with a populated suppression block. The evaluator
    // outcome must survive alongside suppressed_by.
    const m = svc._buildMetadata({ suppressed: true, matchedRuleIds: [4] }, thrownAutomation());

    expect(m.suppressed_by).toEqual([4]);
    expect(actionFailureCount(m)).toBe(1);
    expect(m.matched_rules).toBeUndefined();
  });

  test('REGRESSION: matched rule with zero actions still writes an empty array', () => {
    // 38 live email rows have exactly this shape. Gating the action_outcomes
    // write on actionOutcomes.length would have dropped the key.
    const m = svc._buildMetadata(null, {
      matchedRuleIds: [9],
      actionOutcomes: [],
      parseWarnings:  [],
    });

    expect(m.matched_rules).toEqual([9]);
    expect(m.action_outcomes).toEqual([]);
    expect(actionFailureCount(m)).toBe(0);
  });

  test('REGRESSION: a normal matched run is unchanged', () => {
    const ok = { rule_id: 3, rule_action_id: 12, action_type: 'workflow', status: 'success' };
    const m = svc._buildMetadata(null, {
      matchedRuleIds: [3],
      actionOutcomes: [ok],
      parseWarnings:  [],
    });

    expect(m.matched_rules).toEqual([3]);
    expect(m.action_outcomes).toEqual([ok]);
    expect(actionFailureCount(m)).toBe(0);
    expect(m._parse_warnings).toBeUndefined();
  });

  test('nothing interesting still collapses to null', () => {
    expect(svc._buildMetadata(null, { matchedRuleIds: [], actionOutcomes: [], parseWarnings: [] }))
      .toBeNull();
    expect(svc._buildMetadata(null, null)).toBeNull();
  });

  test('the catch block synthesizes the agreed shape (source assertion)', () => {
    // Guards against the two services drifting apart — the failure mode that
    // made this class survive T6/F-3 in the first place.
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const catchBlock = src.slice(src.indexOf('evaluateRules threw:'));

    expect(catchBlock).toContain("action_type:    'rule_evaluation'");
    expect(catchBlock).toContain("status:         'failed'");
    expect(catchBlock).toContain('rule_id:        null');
    expect(catchBlock).toContain('rule_action_id: null');
  });
});

describe('lib/alerting renders null ids without printing "null" (T7/F-8)', () => {
  // _describeOutcome is module-private; assert via the source so the three
  // shapes stay readable in the alert body a human actually receives.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'alerting.js'), 'utf8');

  test('_describeOutcome exists and both scanners use it', () => {
    expect(src).toContain('function _describeOutcome(');
    expect(src.match(/failed\.map\(_describeOutcome\)/g) || []).toHaveLength(2);
  });

  test('the old inline template is gone from both scanners', () => {
    // Must match the FULL old template. A bare
    // "rule ${f.rule_id} action ${f.rule_action_id}" prefix still legitimately
    // appears inside _describeOutcome itself — that is the replacement, not
    // the thing being removed.
    expect(src).not.toContain(
      '`rule ${f.rule_id} action ${f.rule_action_id} (${f.action_type}): ${f.error'
    );
  });
});