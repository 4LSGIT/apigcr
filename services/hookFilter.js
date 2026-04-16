/**
 * Hook Filter — Recursive Condition Evaluator
 * services/hookFilter.js
 *
 * Evaluates AND/OR condition groups against an input object.
 * Used for both hook-level filters and per-target conditions.
 *
 * Condition structure:
 *   { operator: "and"|"or", conditions: [...] }   ← group
 *   { path: "body.event", op: "equals", value: "..." }  ← leaf
 *
 * Groups can nest arbitrarily.
 *
 * Usage:
 *   const { evaluateConditions } = require('./hookFilter');
 *   const passed = evaluateConditions(conditionsConfig, inputData);
 */

const { resolvePath } = require('./hookMapper');

// ─────────────────────────────────────────────────────────────
// LEAF OPERATORS
// ─────────────────────────────────────────────────────────────

const operators = {
  equals: (actual, expected) => String(actual) === String(expected),
  not_equals: (actual, expected) => String(actual) !== String(expected),

  contains: (actual, expected) => String(actual ?? '').includes(String(expected)),
  not_contains: (actual, expected) => !String(actual ?? '').includes(String(expected)),

  starts_with: (actual, expected) => String(actual ?? '').startsWith(String(expected)),
  ends_with: (actual, expected) => String(actual ?? '').endsWith(String(expected)),

  gt: (actual, expected) => Number(actual) > Number(expected),
  gte: (actual, expected) => Number(actual) >= Number(expected),
  lt: (actual, expected) => Number(actual) < Number(expected),
  lte: (actual, expected) => Number(actual) <= Number(expected),

  exists: (actual) => actual != null && actual !== '',
  not_exists: (actual) => actual == null || actual === '',

  in: (actual, expected) => {
    const arr = Array.isArray(expected) ? expected : [expected];
    return arr.some((v) => String(actual) === String(v));
  },
  not_in: (actual, expected) => {
    const arr = Array.isArray(expected) ? expected : [expected];
    return !arr.some((v) => String(actual) === String(v));
  },

  matches: (actual, expected) => {
    try {
      return new RegExp(expected).test(String(actual ?? ''));
    } catch {
      return false;
    }
  },
};


// ─────────────────────────────────────────────────────────────
// EVALUATOR
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a leaf condition.
 *
 * @param {object} condition - { path, op, value? }
 * @param {object} input     - the data to evaluate against
 * @returns {boolean}
 */
function evaluateLeaf(condition, input) {
  const { path, op, value } = condition;

  if (!path || !op) {
    throw new Error(`Invalid condition: missing path or op`);
  }

  const fn = operators[op];
  if (!fn) {
    throw new Error(`Unknown filter operator: "${op}"`);
  }

  const actual = resolvePath(input, path);
  return fn(actual, value);
}

/**
 * Evaluate a condition group or leaf recursively.
 *
 * @param {object} node  - either a group { operator, conditions } or a leaf { path, op, value }
 * @param {object} input - the data to evaluate against
 * @returns {boolean}
 */
function evaluateNode(node, input) {
  // It's a group if it has 'operator' and 'conditions'
  if (node.operator && Array.isArray(node.conditions)) {
    const op = node.operator.toLowerCase();

    if (op === 'and') {
      return node.conditions.every((child) => evaluateNode(child, input));
    }
    if (op === 'or') {
      return node.conditions.some((child) => evaluateNode(child, input));
    }

    throw new Error(`Unknown group operator: "${node.operator}"`);
  }

  // It's a leaf condition
  return evaluateLeaf(node, input);
}

/**
 * Evaluate a full conditions config against input data.
 * Returns true if conditions is null/undefined (no filter = pass all).
 *
 * @param {object|null} conditions - the conditions config from hook or target
 * @param {object}      input      - the data to evaluate against
 * @returns {boolean}
 */
function evaluateConditions(conditions, input) {
  if (!conditions) return true;
  return evaluateNode(conditions, input);
}

/**
 * List all available operator names (for UI).
 * @returns {string[]}
 */
function listOperators() {
  return Object.keys(operators).sort();
}


module.exports = {
  evaluateConditions,
  listOperators,
  // Exported for testing
  evaluateLeaf,
  evaluateNode,
};