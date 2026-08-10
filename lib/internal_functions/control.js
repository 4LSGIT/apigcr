// lib/internal_functions/control.js

// ─────────────────────────────────────────────────────────────
// HELPER: evaluate a single condition against a variable map
//
// SEMANTICS ARE LOAD-BEARING — do not "fix" the loose equality. wf15 s1 /
// wf16 s1 gate on `needs_fetch == true` with a literal boolean operand, and
// `true == "true"` is FALSE in JS: any coercion here silently inverts live
// branches. The branches[] extension below reuses this function unchanged so
// single-mode, conditions[]-mode, and branch-mode all compare identically.
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

/** Evaluate one branch clause: single {variable,operator,value} OR
 *  {conditions:[…], match:'all'|'any'}. Shared by evaluate_condition's
 *  branch mode. */
function evaluateClause(variables, clause) {
  if (Array.isArray(clause.conditions)) {
    const match = clause.match || 'all';
    const results = clause.conditions.map(c => evaluateSingle(variables, c));
    return match === 'any' ? results.some(Boolean) : results.every(Boolean);
  }
  const { variable, operator } = clause;
  if (!variable || !operator) {
    throw new Error('evaluate_condition: each branch requires variable+operator or conditions[]');
  }
  return evaluateSingle(variables, clause);
}

const fns = {};

// ─────────────────────────────────────────────────────────────
// CONTROL FLOW
//
// ENGINE COUPLING: workflow_engine.js isControlStep() is a HARDCODED
// whitelist — the controlFlow:true meta flag is UI-facing only. Any new
// control function added here must ALSO be added to that whitelist or its
// next_step output is silently ignored.
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
    // type:'string' but the live corpus (and this spec's own `example: 5`)
    // stores a bare step NUMBER — legal since _validateType's string case
    // accepts finite numbers.
    //
    // nullishSkipsBlock is what makes required:true compatible with the
    // documented `{"value": null}` idiom (= end the workflow normally; live on
    // wf28 s6). The flag switches the required-check to key-presence, so an
    // explicit null passes while an OMITTED value still 400s — omission is not
    // the same thing: with no `value` the function returns next_step:undefined,
    // which the engine's `next_step !== undefined` guard turns into a silent
    // fall-through to the following step rather than a stop.
    { name: 'value', type: 'string', required: true, placeholderAllowed: true,
      nullishSkipsBlock: true,
      description: 'Step number, "cancel", "fail", or null to end normally.',
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
 *   else      {number|null} — next_step if false (null = stop; omit = also stop — see NOTE)
 *
 * Extended params (array form, works today):
 *   conditions  [{variable, operator, value}, ...]
 *   match       "all" | "any"  (default "all")
 *   then / else same as above
 *
 * Multi-branch params (ordered if / else-if / … / else — first match wins):
 *   branches  [ { variable, operator, value, then }        — single clause
 *             | { conditions:[…], match, then } , ... ]    — multi clause
 *   else      {number|null} — next_step when no branch matches
 *
 *   Each branch's clause uses the SAME evaluateSingle semantics as the other
 *   two modes (loose ==, boolean operands legal). A matched branch MUST carry
 *   `then` — a matched branch without one throws. Exactly one of
 *   variable / conditions / branches may be set.
 *
 * NOTE on else/null: for control steps the engine treats next_step null (and
 * undefined, which executeStep initializes to null) as END WORKFLOW — there is
 * no sequential fall-through from a control step. The historical meta text
 * claiming "null = continue sequentially" described intent, not behavior; live
 * configs (wf5 s8, wf17 s3, …) already rely on null-as-stop.
 *
 * example config (branch mode):
 *   {
 *     "function_name": "evaluate_condition",
 *     "params": {
 *       "branches": [
 *         { "variable": "match_key", "operator": "==", "value": "341_scheduled",        "then": 5 },
 *         { "variable": "match_key", "operator": "==", "value": "show_cause_scheduled", "then": 9 },
 *         { "conditions": [ { "variable": "verb", "operator": "==", "value": "cancelled" } ],
 *           "match": "all", "then": 12 }
 *       ],
 *       "else": 20
 *     }
 *   }
 */

fns.evaluate_condition = async (params) => {
    const { then: thenStep, else: elseStep = null } = params;
    const variables = params._variables || {};

    // ── Multi-branch mode (additive; absent on every pre-existing step) ──
    if (Array.isArray(params.branches)) {
      for (let i = 0; i < params.branches.length; i++) {
        const br = params.branches[i];
        if (br == null || typeof br !== 'object') {
          throw new Error(`evaluate_condition: branches[${i}] must be an object`);
        }
        if (evaluateClause(variables, br)) {
          if (br.then === undefined) {
            throw new Error(`evaluate_condition: branches[${i}] matched but has no "then"`);
          }
          console.log(`[EVALUATE_CONDITION] branch[${i}] matched → next_step=${br.then}`);
          return { success: true, next_step: br.then };
        }
      }
      console.log(`[EVALUATE_CONDITION] no branch matched → next_step=${elseStep}`);
      return { success: true, next_step: elseStep };
    }

    // ── Legacy modes — byte-for-byte the original logic ──────────────────
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
  description: 'Branch to a different step based on a variable comparison. Supports single-condition, multi-condition (all/any), and ordered multi-branch (first match wins) modes.',
  params: [
    { name: 'variable', type: 'string', required: false, placeholderAllowed: true,
      modeGroup: 'single',
      description: 'Variable name to test (single-condition mode).' },
    { name: 'operator', type: 'enum', required: false,
      modeGroup: 'single',
      enum: ['==','!=','>','<','>=','<=','contains','not_contains','is_empty','is_not_empty'],
      description: 'Comparison operator. Required if `variable` is set.' },
    // The comparison OPERAND. Its JSDoc type is `{any}` and evaluateSingle
    // applies it with LOOSE equality, so the stored JSON type is load-bearing:
    // wf15 s1 / wf16 s1 gate on `needs_fetch == true` with a literal boolean,
    // and `true == "true"` is FALSE in JS — coercing the operand to a string
    // would silently invert those branches. Hence booleanAllowed here (and
    // finite numbers, which the string case now accepts globally: `value: 1`
    // on wf15 s5 / wf16 s4 / wf17 s3).
    { name: 'value', type: 'string', required: false, placeholderAllowed: true,
      booleanAllowed: true,
      modeGroup: 'single',
      description: 'Value to compare against (string, number, or boolean — compared loosely). Ignored for is_empty / is_not_empty.' },
    { name: 'conditions', type: 'array', required: false,
      modeGroup: 'multi',
      description: 'Array of {variable, operator, value} for multi-condition mode.',
      example: [{ variable: 'stage', operator: '==', value: 'intake' }] },
    { name: 'match', type: 'enum', required: false, enum: ['all', 'any'], default: 'all',
      modeGroup: 'multi',
      description: 'How to combine multiple conditions.' },
    { name: 'branches', type: 'array', required: false,
      modeGroup: 'branches',
      description: 'Ordered branches, first match wins. Each: {variable,operator,value,then} or {conditions:[…],match,then}. Combine with top-level `else` for the no-match target.',
      example: [{ variable: 'match_key', operator: '==', value: '341_scheduled', then: 5 }] },
    // `then` moved from a bare required:true to membership in requiredWith
    // [['then','branches']]: the validator skips the per-param required check
    // for group members, and the group demands at least one of then/branches —
    // so all 31 pre-existing steps (which carry `then`) save exactly as
    // before, while branch-mode steps may omit the top-level then. Runtime
    // still throws when a matched branch lacks its own then.
    { name: 'then', type: 'integer', required: true,
      description: 'Step number to jump to when condition is true (single / multi-condition modes). Omit in branch mode — each branch carries its own then.' },
    { name: 'else', type: 'integer', required: false,
      description: 'Step to jump to when false / no branch matches. Omit or null = end the workflow (control steps never fall through sequentially).' },
  ],
  exclusiveOneOf: [['variable', 'conditions', 'branches']],
  requiredWith: [['then', 'branches']],
  example: { variable: 'appt_status', operator: '==', value: 'confirmed', then: 5, else: 8 }
};

/**
 * foreach
 * Iterate a list: one loop-body pass per item, driven by the workflow's own
 * step graph. Place foreach at the TOP of the loop; the body is the steps
 * that follow it; the LAST body step jumps back to the foreach step with
 * set_next. On each visit foreach either exposes the next item and falls
 * into the body, or (list exhausted) clears its state and jumps to end_step.
 *
 *   N   foreach { list: "{{matches}}", item_var: "match", end_step: M+1 }
 *   N+1 …body… (reads {{match}}, {{match.fields.date}}, …)
 *   M   set_next { value: N }
 *   M+1 …after the loop…
 *
 * params:
 *   list       {array}   — the list. Usually a single {{placeholder}} whose
 *                          resolution is an array (the engine's single-token
 *                          fast path preserves arrays). A JSON-array string is
 *                          also accepted and parsed.
 *   item_var   {string}  — variable name that receives the current item.
 *   index_var  {string?} — variable name that receives the 0-based index.
 *   end_step   {number|'cancel'|'fail'|null} — where to go when the list is
 *                          exhausted (or empty). Same contract as
 *                          set_next.value: null = end the workflow normally.
 *   state_var  {string?} — variable holding loop state. Default
 *                          '__foreach_' + item_var. Override only when two
 *                          concurrent loops share an item_var (don't).
 *   max_items  {number?} — per-loop item cap. Default 100, hard ceiling 500.
 *
 * TERMINATION & PERSISTENCE (why this cannot runaway):
 *   The engine has NO global loop protection — MAX_STEPS_PER_INVOCATION=20
 *   schedules a self-continue rather than failing, so an unbounded loop
 *   reschedules forever. foreach therefore (a) bounds the list at max_items
 *   (≤500) up front, and (b) keeps its cursor {i,n} in a WORKFLOW VARIABLE,
 *   persisted by the engine's mergeVariables after every step — a loop whose
 *   body spans self-continue invocations resumes at the right index. The
 *   cursor is monotonic: every visit either advances i or exits, so the loop
 *   terminates in ≤ n+1 visits. If the source list's LENGTH changes
 *   mid-loop, foreach throws (the list must be loop-stable).
 *
 * ENGINE COUPLING: registered in workflow_engine.js isControlStep(); reads
 * the engine-injected _variables and _step_number params (the body entry
 * point is the foreach step's own number + 1).
 */

const FOREACH_DEFAULT_MAX = 100;
const FOREACH_HARD_MAX    = 500;

fns.foreach = async (params) => {
    const variables = params._variables || {};
    const stepNumber = Number(params._step_number);
    if (!Number.isInteger(stepNumber) || stepNumber <= 0) {
      throw new Error('foreach: engine did not inject _step_number (workflow_engine.js executeStep)');
    }

    const itemVar = params.item_var;
    if (!itemVar || typeof itemVar !== 'string') {
      throw new Error('foreach: item_var is required');
    }
    const indexVar = (params.index_var && String(params.index_var)) || null;
    const stateVar = (params.state_var && String(params.state_var)) || `__foreach_${itemVar}`;

    // end_step: same value contract as set_next.value. undefined is a config
    // error (nullishSkipsBlock makes explicit-null the deliberate form).
    if (!('end_step' in params)) throw new Error('foreach: end_step is required (use null to end the workflow after the loop)');
    const endStep = params.end_step;

    // Resolve the list. Placeholders resolving to arrays arrive as arrays
    // (single-token fast path); a JSON-array string is parsed defensively.
    let list = params.list;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { /* fall through to the array check */ }
    }
    if (!Array.isArray(list)) {
      throw new Error(`foreach: list must resolve to an array (got ${list === null ? 'null' : typeof params.list})`);
    }

    let max = Number(params.max_items);
    if (!Number.isInteger(max) || max <= 0) max = FOREACH_DEFAULT_MAX;
    if (max > FOREACH_HARD_MAX) max = FOREACH_HARD_MAX;
    if (list.length > max) {
      throw new Error(`foreach: list has ${list.length} items, exceeding max_items=${max}`);
    }

    // Load / init the persisted cursor.
    let st = variables[stateVar];
    if (!st || typeof st !== 'object' || !Number.isInteger(st.i)) {
      st = { i: 0, n: list.length };
    }
    if (st.n !== list.length) {
      throw new Error(`foreach: list length changed mid-loop (${st.n} → ${list.length}) — the list must be loop-stable`);
    }

    if (st.i >= list.length) {
      // Exhausted (or empty on the first visit): clear state, exit the loop.
      console.log(`[FOREACH s${stepNumber}] done (${list.length} items) → next_step=${endStep}`);
      return {
        success: true,
        next_step: endStep,
        set_vars: { [stateVar]: null },
        output: { done: true, count: list.length },
      };
    }

    const item = list[st.i];
    const setVars = {
      [itemVar]: item,
      [stateVar]: { i: st.i + 1, n: list.length },
    };
    if (indexVar) setVars[indexVar] = st.i;

    console.log(`[FOREACH s${stepNumber}] item ${st.i + 1}/${list.length} → ${itemVar}; body @ step ${stepNumber + 1}`);
    return {
      success: true,
      next_step: stepNumber + 1,   // control steps never fall through — jump into the body explicitly
      set_vars: setVars,
      output: { done: false, index: st.i, count: list.length },
    };
  };

fns.foreach.__meta = {
  category: 'control',
  workflowOnly: true,
  controlFlow: true,
  description: 'Loop over a list: exposes one item per pass into item_var and falls into the body (the following steps); the last body step must set_next back to this step. When exhausted, jumps to end_step. Cursor persists in workflow variables, so loops safely span self-continue invocations. Hard-bounded at 500 items.',
  params: [
    { name: 'list', type: 'array', required: true, placeholderAllowed: true,
      description: 'The list to iterate — usually a single {{placeholder}} resolving to an array.',
      example: '{{matches}}' },
    { name: 'item_var', type: 'string', required: true,
      description: 'Variable name that receives the current item.', example: 'match' },
    { name: 'index_var', type: 'string', required: false,
      description: 'Optional variable name that receives the 0-based index.' },
    { name: 'end_step', type: 'string', required: true, placeholderAllowed: true,
      nullishSkipsBlock: true,
      description: 'Where to go when the list is exhausted: step number, "cancel", "fail", or null to end the workflow.', example: 12 },
    { name: 'state_var', type: 'string', required: false,
      description: 'Variable holding the loop cursor. Default: __foreach_<item_var>.' },
    { name: 'max_items', type: 'integer', required: false, min: 1, max: 500,
      description: 'Per-loop item cap (default 100, hard ceiling 500). Exceeding it fails the step.' },
  ],
  example: { list: '{{matches}}', item_var: 'match', end_step: 12 }
};

// NOTE: only fns is exported. index.js registers EVERY export as an internal
// function, so helper exports (evaluateSingle etc.) would pollute the registry
// and the step-editor pickers. Tests exercise the helpers through
// fns.evaluate_condition / fns.foreach directly.
module.exports = fns;