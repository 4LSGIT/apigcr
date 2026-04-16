/**
 * Hook Mapper — Declarative Mapping Engine
 * services/hookMapper.js
 *
 * Executes mapping rules to transform input into output.
 * Supports three source modes per rule:
 *   - from:     single dot-path with optional transforms
 *   - template: string with {{path|transform|transform}} tokens
 *   - value:    static literal
 *
 * Output supports dot-notation for nested objects and numeric keys for arrays.
 *
 * Usage:
 *   const { executeMapper } = require('./hookMapper');
 *   const output = executeMapper(rules, input);
 */

const { applyChain, applyTransform } = require('./hookTransforms');

// ─────────────────────────────────────────────────────────────
// PATH RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a dot-notation path against an object.
 * Supports numeric indices for arrays: "items.0.name"
 *
 * @param {object} obj   - the source object
 * @param {string} path  - dot-notation path, e.g. "body.payload.name"
 * @returns {*} resolved value, or undefined if path doesn't exist
 */
function resolvePath(obj, path) {
  if (!obj || !path) return undefined;
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    // Support array index access
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[parseInt(key, 10)];
    } else {
      current = current[key];
    }
  }
  return current;
}

/**
 * Set a value at a dot-notation path, creating intermediate
 * objects/arrays as needed.
 *
 * "contact.name"   → { contact: { name: value } }
 * "phones.0"       → { phones: [value] }
 *
 * @param {object} obj   - the target object (mutated)
 * @param {string} path  - dot-notation path
 * @param {*}      value - value to set
 */
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    const nextIsIndex = /^\d+$/.test(nextKey);

    if (Array.isArray(current)) {
      const idx = parseInt(key, 10);
      if (current[idx] == null) {
        current[idx] = nextIsIndex ? [] : {};
      }
      current = current[idx];
    } else {
      if (current[key] == null) {
        current[key] = nextIsIndex ? [] : {};
      }
      current = current[key];
    }
  }

  const lastKey = keys[keys.length - 1];
  if (Array.isArray(current)) {
    current[parseInt(lastKey, 10)] = value;
  } else {
    current[lastKey] = value;
  }
}


// ─────────────────────────────────────────────────────────────
// TEMPLATE RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a template string with {{path}} and {{path|transform|transform}} tokens.
 *
 * If the template contains exactly ONE token and no surrounding text,
 * returns the raw resolved value (preserving type). Otherwise returns a string.
 *
 * @param {string} template - e.g. "{{body.name|capitalize}} ({{body.email|lowercase}})"
 * @param {object} input    - the source object
 * @returns {*}
 */
function resolveTemplate(template, input) {
  // Check if the entire template is a single token (preserve type)
  const singleTokenMatch = template.match(/^\{\{([^}]+)\}\}$/);
  if (singleTokenMatch) {
    return resolveToken(singleTokenMatch[1], input);
  }

  // Multiple tokens or mixed text — result is always a string
  return template.replace(/\{\{([^}]+)\}\}/g, (_, tokenContent) => {
    const resolved = resolveToken(tokenContent, input);
    return resolved == null ? '' : String(resolved);
  });
}

/**
 * Resolve a single token: "path" or "path|transform|transform"
 *
 * @param {string} tokenContent - e.g. "body.name|capitalize|trim"
 * @param {object} input
 * @returns {*}
 */
function resolveToken(tokenContent, input) {
  const parts = tokenContent.split('|');
  const path = parts[0].trim();
  const transformDescriptors = parts.slice(1).map((t) => t.trim());

  let value = resolvePath(input, path);

  // Apply inline transforms
  if (transformDescriptors.length) {
    value = applyChain(value, transformDescriptors);
  }

  return value;
}


// ─────────────────────────────────────────────────────────────
// RULE EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * Execute a single mapping rule against input.
 *
 * @param {object} rule  - { from?, template?, value?, to, transforms? }
 * @param {object} input - the source object
 * @returns {{ key: string, value: * }}
 */
function executeRule(rule, input) {
  let value;

  if (rule.template !== undefined) {
    // Template mode — resolve {{path|transforms}} tokens
    value = resolveTemplate(rule.template, input);
  } else if (rule.from !== undefined) {
    // Path mode — resolve single path, apply rule-level transforms
    value = resolvePath(input, rule.from);
    if (Array.isArray(rule.transforms) && rule.transforms.length) {
      value = applyChain(value, rule.transforms);
    }
  } else if (rule.value !== undefined) {
    // Static value mode
    value = rule.value;
  } else {
    throw new Error(`Mapping rule for "${rule.to}" has no source (from, template, or value)`);
  }

  return { key: rule.to, value };
}


// ─────────────────────────────────────────────────────────────
// MAPPER ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Execute a full set of mapping rules against input.
 *
 * @param {object[]} rules - array of mapping rule objects
 * @param {object}   input - the unified event input
 * @returns {{ output: object, errors: string[] }}
 */
function executeMapper(rules, input) {
  if (!Array.isArray(rules) || !rules.length) {
    return { output: {}, errors: [] };
  }

  const output = {};
  const errors = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    if (!rule.to) {
      errors.push(`Rule ${i}: missing "to" field`);
      continue;
    }

    try {
      const { key, value } = executeRule(rule, input);
      setNestedValue(output, key, value);
    } catch (err) {
      errors.push(`Rule ${i} (→ ${rule.to}): ${err.message}`);
    }
  }

  return { output, errors };
}

/**
 * Resolve a body template against the transform output.
 * Same template syntax as mapper templates: {{path|transforms}}
 *
 * If the template is a JSON string, attempts to parse, resolve each
 * string value, and re-stringify. Otherwise resolves as plain text.
 *
 * @param {string} template     - the body template string
 * @param {object} transformOutput - the data to resolve against
 * @returns {string}
 */
function resolveBodyTemplate(template, transformOutput) {
  if (!template || typeof template !== 'string') return JSON.stringify(transformOutput);

  // Try to handle as JSON template
  try {
    const parsed = JSON.parse(template);
    const resolved = resolveObjectTemplates(parsed, transformOutput);
    return JSON.stringify(resolved);
  } catch {
    // Not JSON — resolve as plain text template
    return resolveTemplate(template, transformOutput);
  }
}

/**
 * Recursively resolve {{}} tokens in all string values of an object/array.
 * @param {*} val
 * @param {object} data
 * @returns {*}
 */
function resolveObjectTemplates(val, data) {
  if (typeof val === 'string') {
    return resolveTemplate(val, data);
  }
  if (Array.isArray(val)) {
    return val.map((item) => resolveObjectTemplates(item, data));
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = resolveObjectTemplates(v, data);
    }
    return out;
  }
  return val;
}


module.exports = {
  resolvePath,
  setNestedValue,
  resolveTemplate,
  executeMapper,
  resolveBodyTemplate,
};