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
 * THE REFUSAL INVARIANT IS RETIRED (2026-08-16 reversal, Fred-ratified —
 * ref/EXTERNAL_CODE_CSS_DECISION.md): templates carrying `code` / `css` /
 * `hooks` / embed fields now SERVE externally. The controls moved upstream:
 * authoring code/css/hooks is form_dev-gated at the write, exposure moments
 * carry the no-third-party-resources warning in the builder, and origin
 * separation is chartered as the structural fix. The one generic 404 (§5.4
 * no-oracle) still covers missing/unpublished/wrong-visibility templates.
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

// case_id shape. Anything outside this never touches the DB.
//
// ENTROPY — load-bearing, corrected 2026-08-12 (X2.1, §9 co-review F1). The
// bearer credential is **40 bits**, not the 48 an earlier comment here
// claimed: lib/caseId.js mints 8 chars of Crockford Base32 (32 symbols) via
// generateCaseId(), called by routes/api.intake.js:611 and
// api.intake.petition.js:428. The ~1k legacy mixed-case base64url ids are
// ~42 bits AS THE DB SEES THEM — cases.case_id is utf8mb4_general_ci, so the
// collation folds case. caseId.js's "40 bits is ample" reasons about
// COLLISION (a birthday bound); this route depends on the different property
// of resistance to ONLINE GUESSING, derived here:
//   P(hit/guess) ≈ 1075 / 2^40 ≈ 9.8e-10 → ~1.0e9 expected guesses.
// Per-IP that is unreachable (30 GET/15min ⇒ ~350k IP-days). The vector that
// made it reachable was wildcard CORS letting any web page read this response
// from a visitor's browser: ~1M hijacked browsers ⇒ a hit inside a day, with
// every per-IP bucket intact. api.ext.forms.js now strips the CORS grant, so
// cross-origin JS cannot read these responses at all. Do NOT re-add a
// permissive ACAO to /api/ext/* without redoing this arithmetic.
// The varchar(20) cap admits the legacy ids; the pattern must never narrow to
// the new alphabet (caseId.js is explicit that legacy ids are never migrated).
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

// Per-string storage sanity cap when a field declares no maxLength.
const MAX_STRING = 20000;
const MAX_REPEATER_ITEMS = 100;
// Longest input ever handed to a staff-authored `pattern` regex (X2.1, F6).
const REGEX_INPUT_CAP = 512;
// Whole-payload byte cap, enforced on the PARSED body (X2.1, F5) — the
// Content-Length header it replaced is absent under chunked encoding.
const MAX_VALUES_BYTES = 64 * 1024;

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

  // 2026-08-16 reversal (ref/EXTERNAL_CODE_CSS_DECISION.md): the §4
  // per-request refusal scan is GONE. Templates carrying code/css/hooks/embed
  // now serve externally — authoring of code/css/hooks is form_dev-gated at
  // the write (formTemplateService), and the exposure moments (visibility
  // flip, publish) carry the no-third-party-resources warning in the builder.
  // scanExternalRefusals lives on as the ADVISORY scanner behind those
  // notices; nothing on the serving path calls it.

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

/**
 * D1 — is server-side draft persistence opted in for this definition?
 *
 * `external.serverDrafts: true` and nothing looser: absent, false, or any
 * non-boolean is OFF, so every template that predates D1 (intake included)
 * keeps localStorage-only drafts with no definition edit. validateDefinition
 * already rejects non-boolean values at the write; this reads STRICTLY true
 * anyway, because a definition row can predate any validator.
 */
function serverDraftsEnabled(def) {
  return !!(def && def.external && def.external.serverDrafts === true);
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
  // X6 (§R): card layout is presentation and must survive the projection or
  // the mode silently does not exist externally — which is where it matters
  // most (phone intake conversion is the whole point). Validator-bounded to
  // the single value 'card'. This exact omission shipped as a defect in §Q
  // (content fields rendered empty externally); test-locked this time too.
  'layout',
  // 2026-08-16 reversal (ref/EXTERNAL_CODE_CSS_DECISION.md): authored
  // executable content ships externally. Authoring these is form_dev-gated
  // at the write; the builder warns at the exposure moments. The renderer
  // already executes all three in ext boots — projection was the last gate.
  'code', 'css', 'hooks',
];
const SECTION_KEYS  = ['title', 'subtitle', 'showWhen'];
const REPEATER_KEYS = ['repeater', 'title', 'subtitle', 'addLabel', 'showWhen'];
const FIELD_KEYS = [
  'name', 'label', 'type', 'width', 'sublabel', 'placeholder', 'rows',
  'readonly', 'lockedMsg', 'mask', 'required', 'requiredWhen',
  'requiredMessage', 'minLength', 'maxLength', 'pattern', 'patternMessage',
  'email', 'options', 'allowOther', 'columns', 'showWhen', 'prefillMode',
  'urlParam', 'min', 'max', 'step',
  // §Q content (display-only, EXTERNAL-SAFE): the block's whole payload IS
  // display content, so it must survive the projection or an external form
  // renders an empty box. All six are SU-authored and validator-bounded
  // (https ≤2000 src/href, ≤2000 text, string alt, positive-int maxWidth,
  // left|center|right align) and reach the DOM via textContent/setAttribute.
  // embed offered no precedent here — embed is refused externally outright.
  // embed ships externally too since the 2026-08-16 reversal — its `height`
  // rides here; `src` was already admitted for content. The renderer's
  // https-only re-check on embed src still applies.
  'src', 'text', 'alt', 'maxWidth', 'align', 'href', 'height',
];

// Types that carry no value: excluded from the submit registry below, so a
// crafted POST naming one is rejected as "not a field of this form" rather
// than stashing junk in form_submissions.data. (The renderer never registers
// them, so a legitimate client never sends one.)
const DISPLAY_ONLY_TYPES = new Set(['content', 'embed']);

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// Option items are the one nested spot the top-level allowlist doesn't reach:
// validateDefinition never constrains option-object shape, so any extra key a
// staff author leaves on one would ride to the public wire verbatim (X2.1,
// §9 co-review N6). Strings pass through; objects are reduced to the two keys
// the renderer reads.
function projectOptions(options) {
  if (!Array.isArray(options)) return options;
  return options.map((o) => {
    if (!o || typeof o !== 'object') return o;
    const out = {};
    if (o.value !== undefined) out.value = o.value;
    if (o.label !== undefined) out.label = o.label;
    return out;
  });
}

function projectField(f) {
  const out = pick(f, FIELD_KEYS);
  if (out.options !== undefined) out.options = projectOptions(out.options);
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

  // contact_id is selected for INTERNAL use only — it binds the workflow
  // execution to the real Primary contact (X2.1, §9 co-review F7) and is
  // stripped from `load` below. §5.2.3's "hard three-field projection"
  // governs THE WIRE; contact_id is not PII and never reaches it. The ban on
  // `contacts.*` is unchanged: every column is still named explicitly, so
  // contact_ssn stays unreachable.
  const [[primary]] = await db.query(
    `SELECT co.contact_id, co.contact_name, co.contact_phone, co.contact_email
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
      LIMIT 1`,
    [caseId]
  );
  return {
    valid: true,
    // load = exactly the three wire fields, or null.
    load: primary
      ? {
          contact_name:  primary.contact_name,
          contact_phone: primary.contact_phone,
          contact_email: primary.contact_email,
        }
      : null,
    // Sidecar, never serialized to the client (the route reads it and drops it).
    contactId: primary && Number.isInteger(Number(primary.contact_id))
      ? Number(primary.contact_id) : null,
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
    // ReDoS containment (X2.1, §9 co-review F6): patterns are staff-authored
    // and may backtrack catastrophically (nested quantifiers are easy to
    // write by accident in phone/email validation). The input length is
    // attacker-controlled up to maxLength — or MAX_STRING (20000) when the
    // field declares none, which is enough to stall this single-threaded
    // instance for EVERY user, staff included. Anything longer than
    // REGEX_INPUT_CAP fails the pattern without being run through it: no
    // legitimate form field carries a 512+ char patterned value, and failing
    // closed is the safe direction. (The try/catch below covers UNPARSEABLE
    // patterns — a different failure; publish already rejects those.)
    if (str.length > REGEX_INPUT_CAP) {
      throw badRequest(`${path} ${field.patternMessage || 'does not match the required format'}`);
    }
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
/**
 * The value registry for a published definition — every container, one pool:
 *   { fields: { name → field }, repeaters: { key → { name → field } } }
 *
 * Sections mode walks def.sections; tabs mode (2.6) walks stickyTop, each
 * tab's sections, then stickyBottom. DISPLAY_ONLY_TYPES carry no value and
 * are excluded, so a crafted payload naming one is rejected as "not a field
 * of this form" rather than stashing junk in form_submissions.data.
 *
 * EXTRACTED (D1) so submit re-validation and draft shape-checking read the
 * SAME definition of "is this a declared field". Two copies of this walk
 * would drift the first time a container type is added, and the drift would
 * show up as a form that can be drafted but not submitted (or worse).
 */
function buildValueRegistry(def) {
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
          for (const f of (row && row.fields) || []) {
            if (f && DISPLAY_ONLY_TYPES.has(f.type)) continue;   // §Q: no value
            fields[f.name] = f;
          }
        }
      }
    }
  }
  return { fields, repeaters };
}

/**
 * D1 — SHAPE check for a server-side DRAFT payload. Deliberately NOT
 * validateValues: a draft is partial by nature (required fields unfilled,
 * selects blank, a half-typed email), and running submit validation on one
 * would make the autosave fail on every keystroke until the form happened to
 * be submittable — which is the exact opposite of what a resumable 300-field
 * questionnaire needs. Submit still re-validates in full; nothing about this
 * relaxes that.
 *
 * Three rules only:
 *   1. `values` is a plain object,
 *   2. the whole payload fits MAX_VALUES_BYTES (the same 64KB storage bound
 *      submit enforces — a draft row lands in the same column),
 *   3. every key names a declared field or repeater of the PUBLISHED
 *      definition (shared registry above).
 *
 * Rule 3's message names the offending key. That branch fires only after
 * every template gate has already passed (§5.4 no-oracle governs those), so
 * it tells the caller nothing the form's own served definition doesn't.
 */
function checkDraftShape(def, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest('values must be an object');
  }
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_VALUES_BYTES) {
    throw badRequest('draft is too large');
  }
  const { fields, repeaters } = buildValueRegistry(def);
  for (const k of Object.keys(values)) {
    if (!(k in fields) && !(k in repeaters)) {
      throw badRequest(`values.${k} is not a field of this form`);
    }
  }
}

/**
 * D1 — the current server draft for (form, case), or null.
 *
 * Narrow on purpose: three columns, named explicitly. formService.getLatest
 * would also fetch the latest SUBMITTED row and join users for a display
 * name — neither belongs anywhere near this payload (§5.2.3's projection
 * discipline), and its draft half carries `id` / `submitted_by`, which the
 * external surface withholds for the same volume-oracle reason submit
 * returns no id. A SELECT that cannot name those columns cannot leak them.
 *
 * Drafts are case-linked only, so link_type is the literal 'case' — the same
 * server-resolved linkage submit writes.
 */
async function getServerDraft(db, formKey, caseId) {
  const [[row]] = await db.query(
    `SELECT data, updated_at, schema_version
       FROM form_submissions
      WHERE form_key = ? AND link_type = 'case' AND link_id = ? AND status = 'draft'
      LIMIT 1`,
    [formKey, caseId]
  );
  if (!row) return null;

  // mysql2 hands a json column back parsed or raw depending on driver config.
  let data = row.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return null; }   // corrupt row → no draft
  }
  if (!data || typeof data !== 'object') return null;

  return { data, updated_at: row.updated_at, schema_version: row.schema_version };
}

function validateValues(def, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest('values must be an object');
  }

  // Payload size (X2.1, §9 co-review F5): measured on the PARSED object, not
  // on Content-Length — chunked requests carry no such header, so the old
  // check passed unconditionally and the only real bound was the global
  // express.json 10mb. Note the per-field caps do NOT bound the whole: 100
  // repeater items x N fields x 20000 chars is a legitimately multi-megabyte
  // payload that every field-level rule accepts, and form_submissions.data
  // would store it.
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_VALUES_BYTES) {
    throw badRequest('submission is too large');
  }

  // Registry from the published definition — all containers, one pool.
  const { fields, repeaters } = buildValueRegistry(def);

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
  // D1 — server-side drafts on the external surface:
  serverDraftsEnabled,
  checkDraftShape,
  getServerDraft,
  // exported for tests:
  evalCond,
};