// lib/internal_functions/index.js
//
// Assembles the internal-function registry from the category modules in this
// directory. Adding a new category file requires no edit here — files are
// auto-scanned. Files starting with "_" and non-.js files are skipped.
// See README.md for the module convention.
const fs = require('fs');
const path = require('path');

const internalFunctions = {};
for (const f of fs.readdirSync(__dirname).sort()) {
  if (f === 'index.js' || f.startsWith('_') || !f.endsWith('.js')) continue;
  const mod = require(path.join(__dirname, f));
  for (const [name, fn] of Object.entries(mod)) {
    if (internalFunctions[name]) {
      throw new Error(`internal_functions: duplicate function "${name}" in ${f}`);
    }
    internalFunctions[name] = fn;
  }
}

// ─────────────────────────────────────────────────────────────
// Validator helper — driven off the metadata above.
//
// Returns null on success or { error: '...' } on failure. Used by
// routes/workflows.js (and, in a future slice, routes/sequences.js) for
// save-time validation of internal_function step configs.
//
// Specialized parse-checks (parseUserDateTime, ms()) live in
// routes/workflows.js to avoid re-importing those modules here. This helper
// covers shape, types, enums, exclusiveOneOf, and requiredWith.
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

function _isNullishParam(v) {
  return v === undefined || v === null || v === '';
}

function _isProvided(params, name) {
  if (!(name in params)) return false;
  return !_isNullishParam(params[name]);
}

// `nullishSkipsBlock` params (wait_for.at, schedule_resume.resumeAt) treat
// explicit-null as a valid value with runtime semantics ("skip this block,
// jump to skipToStep"). For presence checks involving such params, we use
// key-presence rather than value-presence so the precompute-and-gate pattern
// (apptService.createAppt et al.) saves cleanly.
function _isPresentForGroup(params, spec, name) {
  if (spec && spec.nullishSkipsBlock) return name in params;
  return _isProvided(params, name);
}

function _validateType(spec, v) {
  switch (spec.type) {
    case 'string':
    case 'placeholder_string':
      if (typeof v !== 'string') return 'must be a string';
      return null;
    case 'number': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '') n = Number(n);
      if (typeof n !== 'number' || !Number.isFinite(n)) return 'must be a number';
      if (spec.min !== undefined && n < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `must be <= ${spec.max}`;
      return null;
    }
    case 'integer': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '') n = Number(n);
      if (typeof n !== 'number' || !Number.isInteger(n)) return 'must be an integer';
      if (spec.min !== undefined && n < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `must be <= ${spec.max}`;
      return null;
    }
    case 'boolean':
      if (typeof v !== 'boolean') return 'must be a boolean';
      return null;
    case 'enum':
      if (!Array.isArray(spec.enum) || !spec.enum.includes(v)) {
        return `must be one of: ${(spec.enum || []).join(', ')}`;
      }
      return null;
    case 'iso_datetime':
      // Shape only — specialized parsing happens in routes/workflows.js
      // (parseUserDateTime + ms() dispatch). resumeAt accepts numbers (ms).
      if (typeof v !== 'string' && typeof v !== 'number') {
        return 'must be a string or number';
      }
      return null;
    case 'duration':
      // Shape only — specialized ms() check happens in routes/workflows.js.
      if (typeof v !== 'string' && typeof v !== 'number') {
        return 'must be a duration string or number';
      }
      return null;
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v) || v === null) {
        return 'must be a JSON object';
      }
      return null;
    case 'array':
      if (!Array.isArray(v)) return 'must be a JSON array';
      return null;
    default:
      return null;
  }
}

function validateParamsAgainstMeta(meta, params) {
  if (!meta || !Array.isArray(meta.params)) return null;
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { error: 'params must be a JSON object' };
  }

  const exGroups = meta.exclusiveOneOf || [];
  const rwGroups = meta.requiredWith   || [];

  // Resolve specs by name once for the group-presence checks
  const specByName = new Map(meta.params.map(p => [p.name, p]));

  // exclusiveOneOf — exactly one must be set (key-present for nullishSkipsBlock params)
  for (const group of exGroups) {
    const present = group.filter(name => _isPresentForGroup(params, specByName.get(name), name));
    if (present.length === 0) {
      return { error: `must include exactly one of: ${group.join(', ')}` };
    }
    if (present.length > 1) {
      return { error: `must include only one of: ${group.join(', ')} (got: ${present.join(', ')})` };
    }
  }

  // requiredWith — at least one must be set
  for (const group of rwGroups) {
    const present = group.filter(name => _isPresentForGroup(params, specByName.get(name), name));
    if (present.length === 0) {
      return { error: `must include at least one of: ${group.join(', ')}` };
    }
  }

  // Per-param type and required checks
  const inAnyGroup = new Set([
    ...exGroups.flat(),
    ...rwGroups.flat(),
  ]);

  for (const spec of meta.params) {
    const provided = _isProvided(params, spec.name);
    const keyPresent = spec.name in params;

    if (spec.required && !provided && !inAnyGroup.has(spec.name)) {
      // Honor nullishSkipsBlock for required-but-can-skip params (resumeAt)
      if (spec.nullishSkipsBlock && keyPresent) {
        // present-but-null is valid for skip-block; skip type check below
        continue;
      }
      return { error: `${spec.name} is required` };
    }
    if (!provided) {
      // For nullishSkipsBlock params that are part of a group and key-present-but-null,
      // we've already counted them present in the group check. Skip type validation.
      continue;
    }

    const v = params[spec.name];

    // Placeholder bypass for string-typed fields that allow it
    if (spec.placeholderAllowed && typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
      continue;
    }

    const typeErr = _validateType(spec, v);
    if (typeErr) return { error: `${spec.name}: ${typeErr}` };
  }

  return null;
}

// Expose validator and a helper to fetch meta on the registry.
internalFunctions.__validateParamsAgainstMeta = validateParamsAgainstMeta;
internalFunctions.__getMeta = (name) => {
  const fn = internalFunctions[name];
  return fn && fn.__meta ? fn.__meta : null;
};
internalFunctions.__getAllMeta = () => {
  const out = {};
  for (const [name, fn] of Object.entries(internalFunctions)) {
    if (typeof fn === 'function' && fn.__meta) out[name] = fn.__meta;
  }
  return out;
};

// Preserved public handle for the firm-number cache reset (the cache itself
// moved to services/phoneIngestService.js with the phone_log pipeline). Any
// external caller of internalFunctions.__resetFirmNumberCache keeps working.
internalFunctions.__resetFirmNumberCache = require('../../services/phoneIngestService').resetFirmNumberCache;

module.exports = internalFunctions;
