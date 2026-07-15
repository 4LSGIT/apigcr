// lib/internal_functions/index.js
//
// Assembles the internal-function registry from the category modules in this
// directory. Adding a new category file requires no edit here — files are
// auto-scanned. Files starting with "_" and non-.js files are skipped.
// See README.md for the module convention.
const fs = require('fs');
const path = require('path');
const ms = require('ms');
const { parseUserDateTime } = require('../../services/timezoneService');

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
// This helper covers shape, types, enums, exclusiveOneOf, and requiredWith.
// Specialized parse-checks (parseUserDateTime, ms()) live in
// validateInternalFunctionParams further down (relocated here from
// routes/workflows.js in scheduled-jobs Slice 5).
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

function _isNullishParam(v) {
  return v === undefined || v === null || v === '';
}

function _isProvided(params, name) {
  if (!(name in params)) return false;
  return !_isNullishParam(params[name]);
}

// `nullishSkipsBlock` marks a param where explicit-null is a MEANINGFUL VALUE
// with its own runtime semantics — not an absent param. Presence checks on such
// params therefore use key-presence rather than value-presence, so the
// precompute-and-gate pattern (apptService.createAppt et al.) saves cleanly.
//
// Current carriers:
//   wait_for.at / schedule_resume.resumeAt — null = "skip this block, jump to
//     skipToStep" (the flag's original, narrower meaning — hence the name).
//   set_next.value — null = "end the workflow normally" (control.js). Its own
//     description has always documented null as a legal value, but the param is
//     required:true, so {value:null} — the documented idiom, live on wf28 s6 —
//     hit "value is required" and 400'd at save. required stays ON: omitting
//     `value` entirely is NOT the same thing (the engine's
//     `next_step !== undefined` guard makes a valueless set_next a silent
//     fall-through to the next step), so the step must still declare an intent.
function _isPresentForGroup(params, spec, name) {
  if (spec && spec.nullishSkipsBlock) return name in params;
  return _isProvided(params, name);
}

function _validateType(spec, v) {
  switch (spec.type) {
    case 'string':
    case 'placeholder_string':
      if (typeof v === 'string') return null;

      // strictString: a string is the ONLY acceptable form — skip every
      // widening below. Carried by the eight params whose RUNTIME hard-rejects
      // a non-string, so a number fails HERE at save time (400) with a precise
      // message rather than deferring to a runtime throw on first execution:
      //   parse_pdf.pages          — services/pdfService.js (parsePageRangeSyntax)
      //   query_db.from            — db.js  _qdbValidateId
      //   update_db.table          — db.js  _wdbValidateTable
      //   insert_db.table          — db.js  _wdbValidateTable
      //   update_db.set_column     — db.js
      //   update_db.where_column   — db.js
      //   set_setting.key          — system.js
      //   get_setting.key          — system.js
      //   query_ai.prompt          — ai.js
      // (placeholderAllowed still wins where set — the {{token}} bypass runs in
      // validateParamsAgainstMeta BEFORE _validateType, so a placeholder on one
      // of these never reaches this line.)
      if (spec.strictString) return 'must be a string';

      // FINITE NUMBERS pass a string param — globally, for every non-strict
      // spec.
      //
      // The `number`/`integer` cases below already coerce the other direction
      // (a numeric STRING passes a numeric param), and the string case
      // rejecting a number made that asymmetry an edit-lock: `set_next.value`
      // is typed string but its own example is `5`, and 8 live steps store a
      // bare step number there (wf1/2/15/16 s*), as does evaluate_condition's
      // comparison operand (`value: 1`) and run_task_digest's `user: 6`.
      // Booleans, objects, and arrays are still rejected here unless a per-spec
      // flag below opts them in.
      if (typeof v === 'number' && Number.isFinite(v)) return null;

      // OPT-IN WIDENINGS — per-spec, never global.
      //
      // objectAllowed: a plain object literal passes. For params whose runtime
      //   dual-accepts object-or-string (create_log.data / phone_log.data →
      //   logService.createLogEntry stringifies an object; 7 live steps pass
      //   nested {to,from,status,direction,…} blobs).
      // booleanAllowed: a boolean passes. For comparison OPERANDS, whose JSDoc
      //   type is genuinely `{any}` (evaluate_condition.value — wf15 s1 / wf16
      //   s1 compare against literal `true`, and coercing that to the string
      //   "true" would silently INVERT the branch: `true == true` is true but
      //   `true == "true"` is false).
      if (spec.objectAllowed && v !== null && typeof v === 'object' && !Array.isArray(v)) return null;
      if (spec.booleanAllowed && typeof v === 'boolean') return null;

      return 'must be a string';
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
      // Shape only — specialized parsing happens in phase 2 of
      // validateInternalFunctionParams below (parseUserDateTime + ms()
      // dispatch). resumeAt accepts numbers (ms).
      if (typeof v !== 'string' && typeof v !== 'number') {
        return 'must be a string or number';
      }
      return null;
    case 'duration':
      // Shape only — specialized ms() check happens in phase 2 of
      // validateInternalFunctionParams below.
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


// ─────────────────────────────────────────────────────────────
// Full param validator — phase 1 (meta shape, via
// validateParamsAgainstMeta above) + phase 2 (specialized parse-checks for
// iso_datetime / duration string forms via parseUserDateTime + ms()).
//
// Relocated from routes/workflows.js (scheduled-jobs Slice 5) so the
// workflow routes and the scheduled-jobs routes validate internal_function
// params identically. Helper names keep their historical _wf prefix from
// the workflows.js era so the move is auditable against git history.
//
// Functions without __meta are passed through (engine validates at run
// time — legacy permissive behavior).
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

function _wfHasPlaceholder(s) {
  return typeof s === 'string' && PLACEHOLDER_RE.test(s);
}

// iso_datetime fields accept three string shapes at runtime: date-leading
// strings (parseUserDateTime), duration strings (ms()), and plain numbers
// (ms-from-now). Validate accordingly when not a placeholder.
function _wfValidateIsoDatetimeString(label, v) {
  if (typeof v === 'number') return null;
  if (typeof v !== 'string') return { error: `${label} must be a string or number` };
  if (_wfHasPlaceholder(v)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    try {
      const parsed = parseUserDateTime(v);
      if (!parsed) return { error: `${label} is empty after trim: "${v}"` };
    } catch (err) {
      return { error: `${label}: ${err.message}` };
    }
    return null;
  }
  if (ms(v) === undefined) {
    return { error: `${label}: "${v}" is not a valid duration or datetime (use "30s","10m","2h","1d", or an ISO datetime like "2026-05-01T14:30:00")` };
  }
  return null;
}

function _wfValidateDurationString(label, v) {
  if (typeof v === 'number') return null;
  if (typeof v !== 'string') return { error: `${label} must be a duration string or number` };
  if (_wfHasPlaceholder(v)) return null;
  if (ms(v) === undefined) {
    return { error: `${label}: "${v}" is not a valid duration (use "30s","10m","2h","1d", or a millisecond number)` };
  }
  return null;
}

function validateInternalFunctionParams(functionName, params) {
  if (!functionName) return null;
  if (params == null) return null; // function-level required-field check happens elsewhere/runtime

  const fn = internalFunctions[functionName];
  const meta = (fn && fn.__meta) ? fn.__meta : null;
  if (!meta) {
    // No metadata — preserve legacy permissive behavior (engine validates at run time)
    if (typeof params !== 'object' || Array.isArray(params)) {
      return { status: 400, error: 'params must be a JSON object' };
    }
    return null;
  }

  // Phase 1 — generic shape/type/group validation
  const metaErr = validateParamsAgainstMeta(meta, params);
  if (metaErr) return { status: 400, error: metaErr.error };

  // Phase 2 — specialized parse-checks for iso_datetime / duration string forms
  if (typeof params !== 'object' || params === null) return null; // already validated above
  if (!Array.isArray(meta.params)) return null; // meta without params array — nothing to phase-2 check
  for (const spec of meta.params) {
    if (!(spec.name in params)) continue;
    const v = params[spec.name];
    if (v === null || v === '' || v === 'null') continue; // nullishSkipsBlock handled by phase 1

    if (spec.type === 'iso_datetime') {
      const err = _wfValidateIsoDatetimeString(`${functionName} params.${spec.name}`, v);
      if (err) return { status: 400, error: err.error };
    } else if (spec.type === 'duration') {
      const err = _wfValidateDurationString(`${functionName} params.${spec.name}`, v);
      if (err) return { status: 400, error: err.error };
    }
  }

  return null;
}

// Expose validator and a helper to fetch meta on the registry.
internalFunctions.__validateParamsAgainstMeta = validateParamsAgainstMeta;
internalFunctions.__validateFunctionParams = validateInternalFunctionParams;
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