// services/extFormService.js
//
/**
 * extFormService.js — Service layer for the EXTERNAL form surface (X2).
 *
 * Governing contract: ref/EXTERNAL_FORMS_DESIGN.md (§2 auth, §4 refusal
 * invariant, §5 routes, §6 badLink). Backs routes/api.ext.forms.js and,
 * later, the portal-mode credential addition (Tier B widens the visibility
 * scope on the SAME functions — never a second path).
 *
 * THE INVERSION RULE (§2, load-bearing): externally the server resolves
 * EVERYTHING from the credential. The client supplies field values and
 * nothing else — no client-named load URLs, no client-supplied
 * link_type/link_id, no resolver access, no firmData. Every function here is
 * written under that rule; any change that lets a client-supplied string
 * reach a query outside resolveCase() is a defect (§9.3).
 *
 * THE REFUSAL INVARIANT (§4, non-negotiable): templates whose PUBLISHED
 * definition carries `code`, `css`, `hooks`, or any `type:"embed"` field are
 * REFUSED — never stripped — per request (scanExternalRefusals, shared with
 * the X1 flip gate; belt and suspenders because publish can change the
 * definition after the flip). Refusal is indistinguishable from a missing
 * template (getServableTemplate → null → the route's one generic 404).
 *
 * Conventions: functions take the mysql2 pool first; failures throw Errors
 * carrying `.status`; mysql2 JSON columns arrive parsed (guarded anyway).
 */

'use strict';

const { scanExternalRefusals } = require('./formTemplateService');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (msg) => httpError(400, msg);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// case_id shape (routes/api.intake.js:76 — crypto.randomBytes(6) b64url,
// 8 chars; column varchar(20)). Anything outside this never touches the DB.
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

// Per-string storage sanity cap when a field declares no maxLength.
const MAX_STRING = 20000;
const MAX_REPEATER_ITEMS = 100;

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE GATE — §5.2/§5.3 steps 1–2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the one servable template for an external request, or null.
 * null means THE generic 404 — deliberately not distinguishing (§5.4
 * no-oracle): unknown form_key, unpublished, wrong visibility, and
 * refused-keys all collapse to the same null.
 *
 * v1 scope: visibility='public' only. The portal-mode slice widens this by
 * passing { scopes: ['public','portal'] } once a valid portal JWT is on the
 * request — same function, wider set, never a second query path.
 *
 * Returns { form_key, title, link_type, schema_version, definition } with
 * definition PARSED and UNPROJECTED (the submit path needs onSubmit.workflow
 * and external.badLink; only the GET payload is projected).
 */
async function getServableTemplate(db, formKey, opts) {
  const scopes = (opts && opts.scopes) || ['public'];
  if (typeof formKey !== 'string' || !formKey) return null;

  const [[row]] = await db.query(
    `SELECT form_key, title, link_type, schema_version, visibility, definition
       FROM form_templates
      WHERE form_key = ? AND definition IS NOT NULL
      LIMIT 1`,
    [formKey]
  );
  if (!row) return null;
  if (!scopes.includes(row.visibility)) return null;

  const def = typeof row.definition === 'string'
    ? JSON.parse(row.definition)
    : row.definition;

  // §4 per-request refusal scan — refuse, never strip.
  if (scanExternalRefusals(def).length) return null;

  return {
    form_key: row.form_key,
    title: row.title,
    link_type: row.link_type,
    schema_version: row.schema_version,
    definition: def,
  };
}

/** badLink mode for a definition (§6). Default: reject. */
function badLinkMode(def) {
  return def && def.external && def.external.badLink === 'degrade'
    ? 'degrade' : 'reject';
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFINITION PROJECTION — what the public GET payload carries
// ─────────────────────────────────────────────────────────────────────────────
//
// ALLOWLIST projection: the external payload carries only what the external
// renderer consumes. This is not the §4 refusal machinery (refused templates
// never reach here) — it is information-disclosure hygiene: internal API
// paths (endpoints), workflow ids (onSubmit), DB column names (apiColumn),
// resolver expressions, firmData paths (optionsFrom), and staff commentary
// (`note`) stay off the public wire. Allowlist, not denylist, so any future
// server-side key stays private by default. `prefill` survives ONLY in its
// `$load.*` form (resolved client-side against the served `load` object);
// resolver expressions are server vocabulary and could not run externally
// anyway (contract §5: /resolve is authed).

const TOP_KEYS = [
  'dataMode', 'autosave', 'autosaveMs', 'toggle', 'warningText', 'saveLabel',
  'derive',
];
const SECTION_KEYS  = ['title', 'subtitle', 'showWhen'];
const REPEATER_KEYS = ['repeater', 'title', 'subtitle', 'addLabel', 'showWhen'];
const FIELD_KEYS = [
  'name', 'label', 'type', 'width', 'sublabel', 'placeholder', 'rows',
  'readonly', 'lockedMsg', 'mask', 'required', 'requiredWhen',
  'requiredMessage', 'minLength', 'maxLength', 'pattern', 'patternMessage',
  'email', 'options', 'allowOther', 'columns', 'showWhen', 'prefillMode',
  'urlParam', 'min', 'max', 'step',
];

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function projectField(f) {
  const out = pick(f, FIELD_KEYS);
  if (typeof f.prefill === 'string' && f.prefill.indexOf('$load') === 0) {
    out.prefill = f.prefill;               // $load only — resolver exprs stay private
  }
  return out;
}

function projectSection(section) {
  if (section && has(section, 'repeater')) {
    const out = pick(section, REPEATER_KEYS);
    out.fields = (section.fields || []).map(projectField);
    return out;
  }
  const out = pick(section || {}, SECTION_KEYS);
  out.rows = ((section && section.rows) || []).map((row) => {
    const r = row && row.showWhen !== undefined ? { showWhen: row.showWhen } : {};
    r.fields = ((row && row.fields) || []).map(projectField);
    return r;
  });
  return out;
}

/** Project a (refusal-clean) published definition for the external payload. */
function projectDefinition(def) {
  const out = pick(def, TOP_KEYS);
  if (Array.isArray(def.tabs)) {
    out.tabs = def.tabs.map((t) => ({
      label: t.label,
      sections: (t.sections || []).map(projectSection),
    }));
    if (Array.isArray(def.stickyTop) && def.stickyTop.length) {
      out.stickyTop = def.stickyTop.map(projectSection);
    }
    if (Array.isArray(def.stickyBottom) && def.stickyBottom.length) {
      out.stickyBottom = def.stickyBottom.map(projectSection);
    }
  } else {
    out.sections = (def.sections || []).map(projectSection);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE RESOLUTION + PREFILL PROJECTION — §5.2 step 3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a client-supplied case_id. Returns:
 *   { valid: false }                    — absent/malformed/unknown case_id
 *   { valid: true, load: {...}|null }   — case exists; load is the HARD
 *     3-field projection of the Primary contact (contact_name,
 *     contact_phone, contact_email — §5.2.3), or null when the case has no
 *     Primary. NEVER a wider read: contact_ssn is NOT NULL on contacts; any
 *     `contacts.*` in this path is a defect.
 *
 * The regex gate runs before any query — a non-conforming string never
 * reaches the DB. Primary resolution mirrors routes/api.checklists.js
 * (contacts JOIN case_relate ON case_relate_client_id, type='Primary').
 */
async function resolveCase(db, caseId) {
  if (typeof caseId !== 'string' || !CASE_ID_RE.test(caseId)) {
    return { valid: false };
  }
  const [[caseRow]] = await db.query(
    'SELECT case_id FROM cases WHERE case_id = ? LIMIT 1',
    [caseId]
  );
  if (!caseRow) return { valid: false };

  const [[primary]] = await db.query(
    `SELECT co.contact_name, co.contact_phone, co.contact_email
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
      LIMIT 1`,
    [caseId]
  );
  return {
    valid: true,
    load: primary
      ? {
          contact_name:  primary.contact_name,
          contact_phone: primary.contact_phone,
          contact_email: primary.contact_email,
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE RE-VALIDATION — §5.3.2 (client validation counts for nothing)
// ─────────────────────────────────────────────────────────────────────────────

// Condition evaluation against a submitted values object — mirrors the
// client's _evaluateConditionals semantics for requiredWhen (eq/neq/in/
// notEmpty/includes; arrays = AND). String-loose like the runtime.
function evalCond(cond, values) {
  if (Array.isArray(cond)) return cond.every((c) => evalCond(c, values));
  if (!cond || typeof cond !== 'object') return false;
  const raw = has(values, cond.field) ? values[cond.field] : '';
  const val = raw == null ? '' : String(raw);
  switch (cond.op) {
    case 'eq':       return val === String(cond.value != null ? cond.value : '');
    case 'neq':      return val !== String(cond.value != null ? cond.value : '');
    case 'in': {
      const list = Array.isArray(cond.value) ? cond.value : [cond.value];
      return list.map((v) => String(v != null ? v : '')).includes(val);
    }
    case 'notEmpty': return val.trim() !== '';
    case 'includes': {
      const sel = val.split(',').map((s) => s.trim());
      const want = Array.isArray(cond.value) ? cond.value : [cond.value];
      return want.some((w) => sel.includes(String(w != null ? w : '')));
    }
    default: return false;
  }
}

const isEmpty = (v) => v == null || String(v).trim() === '';

function optionValues(field) {
  return (field.options || []).map((o) =>
    o && typeof o === 'object' ? String(o.value != null ? o.value : '') : String(o)
  );
}

// One scalar value against one field declaration. Throws 400 naming the path.
// Shape-trick resistance (§9.7): only string/number/boolean scalars pass —
// arrays and objects where strings are expected are rejected outright.
function checkScalar(field, value, path) {
  if (value == null || value === '') return;                    // emptiness is required's job
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') {
    throw badRequest(`${path} must be a scalar value`);
  }
  const str = String(value);
  const cap = Number.isInteger(field.maxLength) && field.maxLength > 0
    ? field.maxLength : MAX_STRING;
  if (str.length > cap) throw badRequest(`${path} exceeds maximum length ${cap}`);

  switch (field.type) {
    case 'number': {
      if (!Number.isFinite(Number(str))) throw badRequest(`${path} must be a number`);
      const n = Number(str);
      if (field.min != null && n < Number(field.min)) throw badRequest(`${path} is below minimum ${field.min}`);
      if (field.max != null && n > Number(field.max)) throw badRequest(`${path} is above maximum ${field.max}`);
      break;
    }
    case 'select':
    case 'radio': {
      if (field.allowOther) break;                               // free text permitted (capped above)
      if (!optionValues(field).includes(str)) {
        throw badRequest(`${path} value is not one of the allowed options`);
      }
      break;
    }
    case 'checkgroup': {
      if (field.allowOther) break;                               // Other free-text may contain commas
      const opts = optionValues(field);
      for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!opts.includes(part)) {
          throw badRequest(`${path} contains a value that is not one of the allowed options`);
        }
      }
      break;
    }
    default: break;                                              // text-ish: string cap above suffices
  }

  if (isEmpty(value)) return;
  if (typeof field.pattern === 'string' && field.pattern) {
    let re = null;
    try { re = new RegExp(field.pattern); } catch (_) { /* staff-authored; unparseable = skip */ }
    if (re && !re.test(str)) {
      throw badRequest(`${path} ${field.patternMessage || 'does not match the required format'}`);
    }
  }
  if (field.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
    throw badRequest(`${path} must be a valid email address`);
  }
  if (Number.isInteger(field.minLength) && field.minLength > 0 && str.length < field.minLength) {
    throw badRequest(`${path} must be at least ${field.minLength} characters`);
  }
}

/**
 * Re-validate submitted values against the PUBLISHED definition (§5.3.2).
 * Throws 400 naming the offending path; returns silently on success.
 *
 * Strictness: unknown keys are REJECTED (the legit renderer never sends
 * them; prototype-name keys — "__proto__", "constructor" — arrive as own
 * JSON properties, miss the registry, and die on the same check). Repeater
 * values are arrays (capped) of flat objects over that repeater's field
 * names. required/requiredWhen mirror the client: required is enforced
 * unconditionally (the contract's rule that hideable fields use
 * requiredWhen), requiredWhen evaluates its condition against the submitted
 * values. Detail in messages is deliberate — the definition is public, so
 * naming the failing field gives an attacker nothing and a debugging
 * integrator everything (the §5.4 no-oracle rule governs the template
 * refusal branches, not field validation).
 */
function validateValues(def, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest('values must be an object');
  }

  // Registry from the published definition — all containers, one pool.
  const fields = Object.create(null);      // top-level name → field
  const repeaters = Object.create(null);   // repeater key → { name → field }
  const lists = Array.isArray(def.tabs)
    ? [].concat(
        Array.isArray(def.stickyTop) ? [def.stickyTop] : [],
        def.tabs.map((t) => t.sections || []),
        Array.isArray(def.stickyBottom) ? [def.stickyBottom] : []
      )
    : [def.sections || []];
  for (const sections of lists) {
    for (const section of sections) {
      if (section && has(section, 'repeater')) {
        const reg = Object.create(null);
        for (const f of section.fields || []) reg[f.name] = f;
        repeaters[section.repeater] = reg;
      } else if (section) {
        for (const row of section.rows || []) {
          for (const f of (row && row.fields) || []) fields[f.name] = f;
        }
      }
    }
  }

  // Unknown keys rejected.
  for (const k of Object.keys(values)) {
    if (!(k in fields) && !(k in repeaters)) {
      throw badRequest(`values.${k} is not a field of this form`);
    }
  }

  // Top-level fields.
  for (const name of Object.keys(fields)) {
    const f = fields[name];
    const v = has(values, name) ? values[name] : undefined;

    const needed =
      f.required === true ||
      (f.requiredWhen != null && evalCond(f.requiredWhen, values));
    if (needed && isEmpty(v)) {
      throw badRequest(`values.${name} ${f.requiredMessage || 'is required'}`);
    }
    checkScalar(f, v, `values.${name}`);
  }

  // Repeaters.
  for (const key of Object.keys(repeaters)) {
    if (!has(values, key)) continue;
    const arr = values[key];
    if (arr == null) continue;
    if (!Array.isArray(arr)) throw badRequest(`values.${key} must be an array`);
    if (arr.length > MAX_REPEATER_ITEMS) {
      throw badRequest(`values.${key} exceeds ${MAX_REPEATER_ITEMS} items`);
    }
    const reg = repeaters[key];
    arr.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw badRequest(`values.${key}[${i}] must be an object`);
      }
      for (const k of Object.keys(item)) {
        if (!(k in reg)) throw badRequest(`values.${key}[${i}].${k} is not a field of this repeater`);
        checkScalar(reg[k], item[k], `values.${key}[${i}].${k}`);
      }
    });
  }
}

module.exports = {
  getServableTemplate,
  badLinkMode,
  projectDefinition,
  resolveCase,
  validateValues,
  // exported for tests:
  evalCond,
};