// lib/templating.js

/*
 * Resolves all {{placeholders}} in an object (or string).
 * Supports nested access and env helpers.
 *
 * @param {any} template - string, object, or array to resolve
 * @param {object} context - { variables, this: currentStepOutput, env }
 * @returns {any} resolved value (same shape as input)
 */
function resolvePlaceholders(template, context) {
  if (typeof template === 'string') {
    return template.replace(/{{([^}]+)}}/g, (_, key) => {
      return resolveSingle(key.trim(), context) ?? '';
    });
  }

  if (Array.isArray(template)) {
    return template.map(item => resolvePlaceholders(item, context));
  }

  if (template && typeof template === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(template)) {
      result[k] = resolvePlaceholders(v, context);
    }
    return result;
  }

  return template; // primitive
}

/**
 * Resolve a single placeholder key (e.g. "contactPhone", "contactData.first_name", "env.now")
 */
function resolveSingle(key, context) {
  const { variables = {}, this: thisOutput = {}, env = {} } = context;

  // 1. variables (highest priority, includes init_data)
  if (key in variables) {
    return variables[key];
  }
  if (key.includes('.')) {
    const nested = getNested(variables, key);
    if (nested !== undefined) return nested;
  }

  // 2. current step output ("this")
  if (key.startsWith('this.')) {
    const thisKey = key.slice(5);
    return getNested(thisOutput, thisKey);
  }
  if (key === 'this') {
    return thisOutput;
  }

  // 3. env helpers
  if (key.startsWith('env.')) {
    const envKey = key.slice(4);
    switch (envKey) {
      case 'now':
        return new Date().toISOString();
      case 'executionId':
        return env.executionId;
      case 'stepNumber':
        return env.stepNumber;
      default:
        return null;
    }
  }

  // Not found
  return null;
}

/**
 * Safe nested object access: "a.b.c" → obj.a?.b?.c
 * Returns undefined on any missing part
 */
function getNested(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;

  let current = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

module.exports = { resolvePlaceholders };