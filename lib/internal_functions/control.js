// lib/internal_functions/control.js

// ─────────────────────────────────────────────────────────────
// HELPER: evaluate a single condition against a variable map
// ─────────────────────────────────────────────────────────────
function evaluateSingle(variables, { variable, operator, value }) {
  const actual = variables[variable];

  switch (operator) {
    case '==':           return actual == value;
    case '!=':           return actual != value;
    case '>':            return Number(actual) > Number(value);
    case '<':            return Number(actual) < Number(value);
    case '>=':           return Number(actual) >= Number(value);
    case '<=':           return Number(actual) <= Number(value);
    case 'contains':     return String(actual ?? '').includes(String(value));
    case 'not_contains': return !String(actual ?? '').includes(String(value));
    case 'is_empty':     return actual == null || actual === '';
    case 'is_not_empty': return actual != null && actual !== '';
    default:
      throw new Error(`evaluate_condition: unknown operator "${operator}"`);
  }
}

const fns = {};

// ─────────────────────────────────────────────────────────────
// CONTROL FLOW
// ─────────────────────────────────────────────────────────────

/**
 * set_next
 * Jump to a specific step number, or use 'cancel'/'fail' to terminate.
 *
 * params:
 *   value  {number|'cancel'|'fail'|null}  — target step; null ends the workflow normally
 *
 * example config:
 *   { "function_name": "set_next", "params": { "value": 5 } }
 */

fns.set_next = async (params) => {
    const next = params.value;
    console.log(`[SET_NEXT] next_step = ${next}`);
    return { success: true, next_step: next };
  };

fns.set_next.__meta = {
  category: 'control',
  workflowOnly: true,
  controlFlow: true,
  description: 'Jump to a specific step number, or terminate with cancel/fail.',
  params: [
    { name: 'value', type: 'string', required: true, placeholderAllowed: true,
      description: 'Step number, "cancel", "fail", or null/empty to end normally.',
      example: 5 },
  ],
  example: { value: 5 }
};

/**
 * evaluate_condition
 * Branch to a different step based on a variable comparison.
 *
 * Simple params:
 *   variable  {string}      — variable name to test
 *   operator  {string}      — ==, !=, >, <, >=, <=, contains, not_contains, is_empty, is_not_empty
 *   value     {any}         — value to compare against (ignored for is_empty / is_not_empty)
 *   then      {number}      — next_step if condition is true
 *   else      {number|null} — next_step if false (null = continue sequentially)
 *
 * Extended params (array form, works today):
 *   conditions  [{variable, operator, value}, ...]
 *   match       "all" | "any"  (default "all")
 *   then / else same as above
 *
 * NOTE: The engine must inject _variables into params before calling this function.
 * In executeStep (workflow_engine.js), add before executeJob:
 *   if (jobData.type === 'internal_function') {
 *     jobData.params = { ...jobData.params, _variables: context.variables };
 *   }
 *
 * example config:
 *   {
 *     "function_name": "evaluate_condition",
 *     "params": {
 *       "variable": "appt_status", "operator": "==", "value": "confirmed",
 *       "then": 5, "else": 8
 *     }
 *   }
 */

fns.evaluate_condition = async (params) => {
    const { then: thenStep, else: elseStep = null } = params;
    const variables = params._variables || {};

    let result;

    if (Array.isArray(params.conditions)) {
      const match = params.match || 'all';
      const results = params.conditions.map(c => evaluateSingle(variables, c));
      result = match === 'any' ? results.some(Boolean) : results.every(Boolean);
    } else {
      const { variable, operator, value } = params;
      if (!variable || !operator) throw new Error('evaluate_condition requires variable and operator');
      result = evaluateSingle(variables, { variable, operator, value });
    }

    const next_step = result ? thenStep : elseStep;
    console.log(`[EVALUATE_CONDITION] result=${result} → next_step=${next_step}`);
    return { success: true, next_step };
  };

fns.evaluate_condition.__meta = {
  category: 'control',
  workflowOnly: true,
  controlFlow: true,
  description: 'Branch to a different step based on a variable comparison.',
  params: [
    { name: 'variable', type: 'string', required: false, placeholderAllowed: true,
      modeGroup: 'single',
      description: 'Variable name to test (single-condition mode).' },
    { name: 'operator', type: 'enum', required: false,
      modeGroup: 'single',
      enum: ['==','!=','>','<','>=','<=','contains','not_contains','is_empty','is_not_empty'],
      description: 'Comparison operator. Required if `variable` is set.' },
    { name: 'value', type: 'string', required: false, placeholderAllowed: true,
      modeGroup: 'single',
      description: 'Value to compare against. Ignored for is_empty / is_not_empty.' },
    { name: 'conditions', type: 'array', required: false,
      modeGroup: 'multi',
      description: 'Array of {variable, operator, value} for multi-condition mode.',
      example: [{ variable: 'stage', operator: '==', value: 'intake' }] },
    { name: 'match', type: 'enum', required: false, enum: ['all', 'any'], default: 'all',
      modeGroup: 'multi',
      description: 'How to combine multiple conditions.' },
    { name: 'then', type: 'integer', required: true,
      description: 'Step number to jump to when condition is true.' },
    { name: 'else', type: 'integer', required: false,
      description: 'Step to jump to when false. Omit/null = continue sequentially (and end the workflow if this is the last step — see cookbook §5.16).' },
  ],
  exclusiveOneOf: [['variable', 'conditions']],
  example: { variable: 'appt_status', operator: '==', value: 'confirmed', then: 5, else: 8 }
};

module.exports = fns;
