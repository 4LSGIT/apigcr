// services/formTemplateService.js
//
/**
 * formTemplateService.js — Service layer for the YisraForm template system.
 *
 * Backs routes/api.formTemplates.js. Owns:
 *   - CRUD over form_templates (single row per form_key; published `definition`
 *     JSON + working `draft_definition` JSON coexist on the row).
 *   - Publish flow (copy draft → published, bump schema_version on field-set
 *     change, append a form_template_versions row) — contract §6.
 *   - Structural validation of a definition — contract §7.
 *   - getPublishedByKey — what public/forms/render.html consumes.
 *   - Version history reads + restore-to-draft (Slice 4): listVersions /
 *     getVersion / restoreVersion over form_template_versions.
 *
 * Governing contract: ref/FORM_TEMPLATE_SCHEMA_V1.md.
 *
 * Conventions (match services/formService.js + routes/api.forms.js):
 *   - Every function takes the mysql2 pool (req.db) as its first argument.
 *   - Business-rule / validation failures throw an Error carrying `.status`
 *     (400 or 404); the route maps `err.status || 500` to the HTTP code.
 *   - mysql2 returns native JSON columns as PARSED objects. Incoming definition
 *     objects are JSON.stringify()-ed before binding to `?` (key-expansion
 *     hazard). The publish path copies JSON column-to-column in SQL and so
 *     never round-trips a parsed object back through a placeholder.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const FORM_KEY_RE   = /^[a-z0-9_]{1,50}$/;          // contract §2
const FIELD_NAME_RE = /^[a-zA-Z0-9_]{1,50}$/;       // contract §4.3
const HOOKS_RE      = /^[a-zA-Z0-9_-]{1,50}$/;      // contract §3 / §7 (path-traversal guard)
const LINK_TYPES    = new Set(['case', 'contact', 'appt']);
const SHOWWHEN_OPS  = new Set(['eq', 'neq', 'in', 'notEmpty', 'includes']); // includes: 2.5A, checkgroup targets only

// $load prefill grammar (contract §5, Slice 2.5A):
//   $load ( '.' key | '[' field '=' value ']' )+   — literal filter values only.
const LOAD_PREFILL_RE = /^\$load(\.[A-Za-z0-9_]+|\[[A-Za-z0-9_]+=[^\]]+\])+$/;

// optionsFrom firmData source grammar (contract §4.3, Slice 2.5B B1):
//   firmData.<key>(.<key>)*  — dot path off the relayed window.firmData.
const FIRMDATA_SOURCE_RE = /^firmData(\.[A-Za-z0-9_]+)+$/;

// derive verb set (contract §3, Slice 2.5B B2). Fixed registry — no
// expressions, no eval; the renderer interprets these two verbs only.
const DERIVE_OPS = new Set(['addDays', 'dateFromDatetime']);

// The full type vocabulary (contract §4.3). Slice 1's renderer draws a subset,
// but validation accepts every declared type so drafts using repeaters/showWhen
// (Slice 2 render targets) still create/publish cleanly.
const KNOWN_TYPES = new Set([
  'text', 'textarea', 'number', 'date', 'datetime',
  'select', 'radio', 'checkbox', 'checkgroup', 'tags', 'hidden',
]);

const OPTIONS_TYPES = new Set(['select', 'radio', 'checkgroup']); // options iff these


// ─────────────────────────────────────────────────────────────────────────────
// ERROR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (msg) => httpError(400, msg);
const notFound   = (msg) => httpError(404, msg);


// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL VALIDATION — contract §7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a definition object. Throws a 400 Error naming the offending path on
 * the first failure. Returns silently on success.
 *
 * Name scoping (contract §7, Slice 2.5A A4):
 *   - TOP-LEVEL names (standard-section fields + repeater KEYS — they share the
 *     submission data namespace) are unique form-wide.
 *   - Repeater FIELD names are unique within their own repeater and distinct
 *     from every top-level name — but two repeaters may share a row-field name
 *     (collect()/populate() scope repeater lookups to one .yc-repeater-item;
 *     only form-wide [name=…] queries — conditionals, validate() — need the
 *     top-level guarantee).
 *
 * @param {object} def  parsed definition JSON
 */
function validateDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw badRequest('definition must be an object');
  }
  if (!Array.isArray(def.sections) || def.sections.length === 0) {
    throw badRequest('definition.sections must be a non-empty array');
  }

  const topLevel      = new Set();  // standard-section field names + repeater keys (shared data namespace)
  const topLevelTypes = {};         // top-level field name -> type (for includes-op target checks)
  const repFieldRefs  = [];         // { name, path } — cross-checked vs topLevel in a second pass
  const condRefs      = [];         // { path, field, op, key } collected for the second pass
  let hasSaveColumn   = false;      // any field with a SAVE-direction apiColumn (string, or {save}) — 2.5B B3

  // One normalized condition { field, op, value }. `key` names the carrying
  // property ("showWhen" / "requiredWhen") for error messages.
  const noteCondition = (cond, path, key) => {
    if (typeof cond !== 'object' || cond == null || Array.isArray(cond)) {
      throw badRequest(`${path}.${key} conditions must be objects`);
    }
    if (!SHOWWHEN_OPS.has(cond.op)) {
      throw badRequest(`${path}.${key}.op "${cond.op}" is not one of eq, neq, in, notEmpty, includes`);
    }
    if (typeof cond.field !== 'string' || !cond.field) {
      throw badRequest(`${path}.${key}.field is required`);
    }
    condRefs.push({ path, field: cond.field, op: cond.op, key });
  };

  // A condition slot: a single condition object, or an array = AND (2.5A).
  const noteConditionSlot = (sw, path, key) => {
    if (sw == null) return;
    if (Array.isArray(sw)) {
      if (sw.length === 0) throw badRequest(`${path}.${key} must not be an empty array`);
      sw.forEach((c, i) => noteCondition(c, `${path}`, `${key}[${i}]`));
      return;
    }
    noteCondition(sw, path, key);
  };
  const noteShowWhen = (sw, path) => noteConditionSlot(sw, path, 'showWhen');

  const validateField = (field, path, { topLevelField, repScope }) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw badRequest(`${path} must be an object`);
    }
    if (typeof field.name !== 'string' || !FIELD_NAME_RE.test(field.name)) {
      throw badRequest(`${path}.name "${field.name}" is invalid (must match ^[a-zA-Z0-9_]{1,50}$)`);
    }
    if (!KNOWN_TYPES.has(field.type)) {
      throw badRequest(`${path}.type "${field.type}" is not a known field type`);
    }

    if (topLevelField) {
      if (topLevel.has(field.name)) {
        throw badRequest(`duplicate field name "${field.name}" (${path}); top-level names must be unique form-wide`);
      }
      topLevel.add(field.name);
      topLevelTypes[field.name] = field.type;
    } else {
      if (repScope.has(field.name)) {
        throw badRequest(`duplicate field name "${field.name}" (${path}); names must be unique within a repeater`);
      }
      repScope.add(field.name);
      repFieldRefs.push({ name: field.name, path });   // vs topLevel: second pass (order-independent)
    }

    // options present iff type is select/radio/checkgroup
    const wantsOptions = OPTIONS_TYPES.has(field.type);
    const hasOptions   = field.options !== undefined && field.options !== null;
    if (wantsOptions) {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        throw badRequest(`${path}.options must be a non-empty array for type "${field.type}"`);
      }
    } else if (hasOptions) {
      throw badRequest(`${path}.options is not allowed for type "${field.type}"`);
    }

    // checkgroup columns (2.5A A5): integer 1–3, checkgroup only.
    if (field.columns !== undefined && field.columns !== null) {
      if (field.type !== 'checkgroup') {
        throw badRequest(`${path}.columns is only allowed on type "checkgroup"`);
      }
      if (!Number.isInteger(field.columns) || field.columns < 1 || field.columns > 3) {
        throw badRequest(`${path}.columns must be an integer between 1 and 3`);
      }
    }

    // pattern, if present, must compile
    if (field.pattern !== undefined && field.pattern !== null && field.pattern !== '') {
      if (typeof field.pattern !== 'string') {
        throw badRequest(`${path}.pattern must be a string`);
      }
      try { new RegExp(field.pattern); }
      catch (e) { throw badRequest(`${path}.pattern is not a valid regular expression: ${e.message}`); }
    }

    // $load prefill (2.5A A1): grammar-checked here; non-$load prefill stays a
    // free-form resolver expression (unchanged).
    if (typeof field.prefill === 'string' && field.prefill.startsWith('$load')) {
      if (!LOAD_PREFILL_RE.test(field.prefill)) {
        throw badRequest(`${path}.prefill "${field.prefill}" is not a valid $load expression `
          + `(grammar: $load ( '.' key | '[' field '=' value ']' )+ — literal filter values only)`);
      }
    }

    // requiredMessage, if present, must be a string (rendered as the error text).
    if (field.requiredMessage !== undefined && field.requiredMessage !== null
        && typeof field.requiredMessage !== 'string') {
      throw badRequest(`${path}.requiredMessage must be a string`);
    }

    // apiColumn (2.5B B3): a plain non-empty string (both directions,
    // unchanged), or { load?, save? } — each a non-empty string, at least one
    // present. One column per direction; multi-column writes and value
    // transforms stay hooks.
    if (field.apiColumn !== undefined && field.apiColumn !== null) {
      const ac = field.apiColumn;
      if (typeof ac === 'string') {
        if (!ac) throw badRequest(`${path}.apiColumn must not be an empty string`);
        hasSaveColumn = true;
      } else if (typeof ac === 'object' && !Array.isArray(ac)) {
        const hasLoad = ac.load !== undefined && ac.load !== null;
        const hasSave = ac.save !== undefined && ac.save !== null;
        if (!hasLoad && !hasSave) {
          throw badRequest(`${path}.apiColumn object must have at least one of "load", "save"`);
        }
        if (hasLoad && (typeof ac.load !== 'string' || !ac.load)) {
          throw badRequest(`${path}.apiColumn.load must be a non-empty string`);
        }
        if (hasSave && (typeof ac.save !== 'string' || !ac.save)) {
          throw badRequest(`${path}.apiColumn.save must be a non-empty string`);
        }
        if (hasSave) hasSaveColumn = true;
      } else {
        throw badRequest(`${path}.apiColumn must be a string or a { load, save } object`);
      }
    }

    // optionsFrom (2.5B B1): dynamic select options. select only; source is a
    // whitelisted prefix (firmData.* dot path, or a $load expression sharing
    // the §5.1 grammar); "value" names the item key holding the option value;
    // optional "label" / "groupBy" name item keys; optional "groupLabels"
    // maps raw groupBy values to display text. Static `options` remain
    // REQUIRED (rule above) — they are the guaranteed fallback when the
    // source is unreachable at render time.
    if (field.optionsFrom !== undefined && field.optionsFrom !== null) {
      const of = field.optionsFrom;
      if (field.type !== 'select') {
        throw badRequest(`${path}.optionsFrom is only allowed on type "select"`);
      }
      if (typeof of !== 'object' || Array.isArray(of)) {
        throw badRequest(`${path}.optionsFrom must be an object`);
      }
      if (typeof of.source !== 'string'
          || !(FIRMDATA_SOURCE_RE.test(of.source) || LOAD_PREFILL_RE.test(of.source))) {
        throw badRequest(`${path}.optionsFrom.source "${of.source}" must be a firmData.* dot path or a $load expression`);
      }
      if (typeof of.value !== 'string' || !of.value) {
        throw badRequest(`${path}.optionsFrom.value is required (the item key holding the option value)`);
      }
      if (of.label !== undefined && of.label !== null && (typeof of.label !== 'string' || !of.label)) {
        throw badRequest(`${path}.optionsFrom.label must be a non-empty string when present`);
      }
      if (of.groupBy !== undefined && of.groupBy !== null && (typeof of.groupBy !== 'string' || !of.groupBy)) {
        throw badRequest(`${path}.optionsFrom.groupBy must be a non-empty string when present`);
      }
      if (of.groupLabels !== undefined && of.groupLabels !== null) {
        if (typeof of.groupLabels !== 'object' || Array.isArray(of.groupLabels)) {
          throw badRequest(`${path}.optionsFrom.groupLabels must be an object mapping group values to labels`);
        }
        for (const k of Object.keys(of.groupLabels)) {
          if (typeof of.groupLabels[k] !== 'string') {
            throw badRequest(`${path}.optionsFrom.groupLabels["${k}"] must be a string`);
          }
        }
      }
    }

    noteShowWhen(field.showWhen, path);
    // requiredWhen (2.5A A2): same normalized-condition shape; array = AND.
    noteConditionSlot(field.requiredWhen, path, 'requiredWhen');
  };

  def.sections.forEach((section, i) => {
    const sPath = `sections[${i}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw badRequest(`${sPath} must be an object`);
    }

    const isRepeater = Object.prototype.hasOwnProperty.call(section, 'repeater');
    const hasRows    = Object.prototype.hasOwnProperty.call(section, 'rows');

    // XOR: a section is standard (rows) or a repeater (repeater + fields), never both/neither.
    if (isRepeater && hasRows) {
      throw badRequest(`${sPath} has both "repeater" and "rows"; a section must be one or the other`);
    }
    if (!isRepeater && !hasRows) {
      throw badRequest(`${sPath} must have "rows" (standard) or "repeater" + "fields"`);
    }

    if (isRepeater) {
      if (typeof section.repeater !== 'string' || !FIELD_NAME_RE.test(section.repeater)) {
        throw badRequest(`${sPath}.repeater "${section.repeater}" is invalid (must match ^[a-zA-Z0-9_]{1,50}$)`);
      }
      // Repeater keys live in the top-level data namespace (collect() writes
      // data[repeater] beside data[fieldName]) — enforce uniqueness there too.
      if (topLevel.has(section.repeater)) {
        throw badRequest(`${sPath}.repeater "${section.repeater}" collides with a top-level field or repeater name`);
      }
      topLevel.add(section.repeater);
      if (!Array.isArray(section.fields) || section.fields.length === 0) {
        throw badRequest(`${sPath} (repeater) requires a non-empty "fields" array`);
      }
      const repScope = new Set();
      section.fields.forEach((f, k) => {
        validateField(f, `${sPath}.fields[${k}]`, { topLevelField: false, repScope });
      });
    } else {
      if (!Array.isArray(section.rows)) {
        throw badRequest(`${sPath}.rows must be an array`);
      }
      section.rows.forEach((row, j) => {
        const rPath = `${sPath}.rows[${j}]`;
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Array.isArray(row.fields)) {
          throw badRequest(`${rPath} must be an object with a "fields" array`);
        }
        noteShowWhen(row.showWhen, rPath);
        row.fields.forEach((f, k) => {
          validateField(f, `${rPath}.fields[${k}]`, { topLevelField: true });
        });
      });
    }

    noteShowWhen(section.showWhen, sPath);
  });

  // Second pass A: repeater field names must be distinct from every top-level
  // name (incl. repeater keys) — deferred so section order doesn't matter.
  for (const ref of repFieldRefs) {
    if (topLevel.has(ref.name)) {
      throw badRequest(`repeater field name "${ref.name}" (${ref.path}) collides with a top-level field or repeater name`);
    }
  }

  // Second pass B: every condition's field must reference an existing TOP-LEVEL
  // field; the includes op additionally requires a checkgroup target.
  for (const ref of condRefs) {
    if (!topLevel.has(ref.field) || !(ref.field in topLevelTypes)) {
      throw badRequest(`${ref.path}.${ref.key}.field "${ref.field}" does not reference an existing top-level field`);
    }
    if (ref.op === 'includes' && topLevelTypes[ref.field] !== 'checkgroup') {
      throw badRequest(`${ref.path}.${ref.key}: op "includes" requires the target field "${ref.field}" to be a checkgroup`);
    }
  }

  // onSubmit.patch requires at least one field with a SAVE-direction apiColumn
  // (a plain string, or an object carrying "save" — 2.5B B3): a load-only
  // column contributes nothing to the PATCH whitelist.
  if (def.onSubmit && def.onSubmit.patch && !hasSaveColumn) {
    throw badRequest('onSubmit.patch is set but no field declares a save-direction apiColumn');
  }

  // derive (2.5B B2): top-level array of { target, from, op, n? } rules.
  // Fixed verb set; target/from reference existing TOP-LEVEL fields; one rule
  // per target (deterministic — last-write-wins is a footgun, reject it).
  if (def.derive !== undefined && def.derive !== null) {
    if (!Array.isArray(def.derive) || def.derive.length === 0) {
      throw badRequest('derive must be a non-empty array of rules');
    }
    const deriveTargets = new Set();
    def.derive.forEach((r, i) => {
      const dPath = `derive[${i}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        throw badRequest(`${dPath} must be an object`);
      }
      if (!DERIVE_OPS.has(r.op)) {
        throw badRequest(`${dPath}.op "${r.op}" is not one of addDays, dateFromDatetime`);
      }
      if (typeof r.target !== 'string' || !(r.target in topLevelTypes)) {
        throw badRequest(`${dPath}.target "${r.target}" does not reference an existing top-level field`);
      }
      if (typeof r.from !== 'string' || !(r.from in topLevelTypes)) {
        throw badRequest(`${dPath}.from "${r.from}" does not reference an existing top-level field`);
      }
      if (r.target === r.from) {
        throw badRequest(`${dPath}: target and from must be different fields`);
      }
      if (deriveTargets.has(r.target)) {
        throw badRequest(`${dPath}: duplicate derive target "${r.target}"`);
      }
      deriveTargets.add(r.target);
      // n: required integer for addDays (an offset of 0 is legal but must be
      // explicit); optional integer for dateFromDatetime (absent = pure
      // date-part extraction).
      if (r.op === 'addDays') {
        if (!Number.isInteger(r.n)) throw badRequest(`${dPath}.n must be an integer (days offset) for addDays`);
      } else if (r.n !== undefined && r.n !== null && !Number.isInteger(r.n)) {
        throw badRequest(`${dPath}.n must be an integer when present`);
      }
    });
  }

  // css (2.5B B4): free-form string, injected via textContent only.
  // INTERNAL-ONLY pending the portal security review (contract §9).
  if (def.css !== undefined && def.css !== null && typeof def.css !== 'string') {
    throw badRequest('css must be a string');
  }

  // hooks, if set, must be a safe file-name token.
  if (def.hooks !== undefined && def.hooks !== null) {
    if (typeof def.hooks !== 'string' || !HOOKS_RE.test(def.hooks)) {
      throw badRequest('hooks must match ^[a-zA-Z0-9_-]{1,50}$');
    }
  }
}


/**
 * Field-set signature: sorted list of (name, type) across all fields including
 * repeater fields. Used by publish to decide whether schema_version bumps.
 * A rename shows up as remove+add and therefore changes the signature. (§6)
 */
function fieldSignature(def) {
  const parts = [];
  for (const section of (def && def.sections) || []) {
    if (section && Object.prototype.hasOwnProperty.call(section, 'repeater')) {
      for (const f of section.fields || []) parts.push(`${f.name}\u0000${f.type}`);
    } else if (section) {
      for (const row of section.rows || []) {
        for (const f of (row && row.fields) || []) parts.push(`${f.name}\u0000${f.type}`);
      }
    }
  }
  return parts.sort().join('|');
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function submissionCount(db, formKey) {
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS c FROM form_submissions WHERE form_key = ?',
    [formKey]
  );
  return Number(row.c);
}

/**
 * Normalize a JSON column read. On MySQL 8 native `json`, mysql2 already returns
 * a parsed object (this is a no-op). Kept as a guard so the service is correct
 * regardless of how the driver/engine surfaces the column (e.g. a MariaDB
 * `longtext`-backed JSON returns a string). null/undefined pass through.
 */
function parseJsonCol(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function fetchRow(db, id) {
  const [[row]] = await db.query(
    `SELECT id, form_key, title, link_type, schema_version,
            definition, draft_definition, published_at, updated_by,
            created_at, updated_at
     FROM form_templates WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!row) return null;
  row.definition = row.definition == null ? null : parseJsonCol(row.definition);
  row.draft_definition = parseJsonCol(row.draft_definition);
  return row;
}


// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all templates (summary columns only — no definition bodies).
 * @returns {Array<object>}
 */
async function listTemplates(db) {
  const [rows] = await db.query(
    `SELECT id, form_key, title, link_type, schema_version, published_at, updated_at
     FROM form_templates
     ORDER BY updated_at DESC`
  );
  return rows;
}


// ─────────────────────────────────────────────────────────────────────────────
// GET (full row)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full row including both definitions. Throws 404 if not found.
 * definition / draft_definition are returned as parsed objects (mysql2).
 */
async function getTemplate(db, id) {
  const row = await fetchRow(db, id);
  if (!row) throw notFound(`Template ${id} not found`);
  return row;
}


// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a template. Validates form_key/link_type/title and structurally
 * validates draft_definition (§7). schema_version starts at 1, definition NULL
 * (never published).
 *
 * @param {object} body  { form_key, title, link_type, draft_definition }
 * @param {number|null} userId
 * @returns {object} the created full row
 */
async function createTemplate(db, body, userId) {
  const { form_key, title, link_type, draft_definition } = body || {};

  if (typeof form_key !== 'string' || !FORM_KEY_RE.test(form_key)) {
    throw badRequest('form_key is required and must match ^[a-z0-9_]{1,50}$');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw badRequest('title is required');
  }
  if (!LINK_TYPES.has(link_type)) {
    throw badRequest(`link_type must be one of: ${[...LINK_TYPES].join(', ')}`);
  }
  validateDefinition(draft_definition);

  // Unique form_key (also guarded by the DB unique index; check first for a clean 400).
  const [[existing]] = await db.query(
    'SELECT id FROM form_templates WHERE form_key = ? LIMIT 1',
    [form_key]
  );
  if (existing) throw badRequest(`form_key "${form_key}" already exists`);

  const [result] = await db.query(
    `INSERT INTO form_templates
       (form_key, title, link_type, schema_version, definition, draft_definition, updated_by)
     VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    [form_key, title.trim(), link_type, JSON.stringify(draft_definition), userId]
  );

  return fetchRow(db, result.insertId);
}


// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update title and/or draft_definition (and optionally form_key). A form_key
 * change is rejected unless the template has never been published (definition
 * IS NULL AND published_at IS NULL) and has no submissions (contract §2,
 * tightened: a published template's key is permanent). draft_definition is
 * structurally validated (§7).
 *
 * @param {object} body  { title?, draft_definition?, form_key? }
 * @returns {object} the updated full row
 */
async function updateTemplate(db, id, body, userId) {
  const row = await fetchRow(db, id);
  if (!row) throw notFound(`Template ${id} not found`);

  const sets = [];
  const vals = [];
  const b = body || {};

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) throw badRequest('title must be a non-empty string');
    sets.push('title = ?');
    vals.push(b.title.trim());
  }

  if (b.draft_definition !== undefined) {
    validateDefinition(b.draft_definition);
    sets.push('draft_definition = ?');
    vals.push(JSON.stringify(b.draft_definition));
  }

  if (b.form_key !== undefined && b.form_key !== row.form_key) {
    if (typeof b.form_key !== 'string' || !FORM_KEY_RE.test(b.form_key)) {
      throw badRequest('form_key must match ^[a-z0-9_]{1,50}$');
    }
    // form_key may change ONLY while the template has never been published AND
    // has no submissions. Renaming a published template would silently 404 every
    // render URL (and any Slice-4 external link) that references the old key.
    if (row.definition != null || row.published_at != null) {
      throw badRequest('form_key is immutable once the template has been published');
    }
    if (await submissionCount(db, row.form_key) > 0) {
      throw badRequest(`form_key is immutable: submissions already exist for "${row.form_key}"`);
    }
    const [[clash]] = await db.query(
      'SELECT id FROM form_templates WHERE form_key = ? AND id <> ? LIMIT 1',
      [b.form_key, id]
    );
    if (clash) throw badRequest(`form_key "${b.form_key}" already exists`);
    sets.push('form_key = ?');
    vals.push(b.form_key);
  }

  if (sets.length === 0) {
    throw badRequest('no updatable fields provided (title, draft_definition, form_key)');
  }

  sets.push('updated_by = ?');
  vals.push(userId);
  vals.push(id);

  await db.query(`UPDATE form_templates SET ${sets.join(', ')} WHERE id = ?`, vals);
  return fetchRow(db, id);
}


// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH — contract §6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish: structurally validate the draft, copy draft → published, bump
 * schema_version iff the field-set signature changed, append a version row.
 *
 * JSON is copied column-to-column in SQL (definition = draft_definition) so no
 * parsed object is re-bound to a placeholder.
 *
 * @returns {{ schema_version: number, bumped: boolean }}
 */
async function publishTemplate(db, id, userId) {
  const row = await fetchRow(db, id);
  if (!row) throw notFound(`Template ${id} not found`);

  const draft = row.draft_definition; // parsed object (mysql2)
  validateDefinition(draft);

  // First publish (no published definition yet) is v1 — never a bump.
  const bumped = row.definition != null &&
                 fieldSignature(draft) !== fieldSignature(row.definition);
  const newVersion = bumped ? row.schema_version + 1 : row.schema_version;

  await db.query(
    `UPDATE form_templates
        SET definition = draft_definition,
            schema_version = ?,
            published_at = NOW(),
            updated_by = ?
      WHERE id = ?`,
    [newVersion, userId, id]
  );

  // draft_definition is untouched by the update above, so it still holds the
  // just-published content — copy it into the append-only version row.
  await db.query(
    `INSERT INTO form_template_versions (template_id, schema_version, definition, published_by)
     SELECT id, ?, draft_definition, ? FROM form_templates WHERE id = ?`,
    [newVersion, userId, id]
  );

  return { schema_version: newVersion, bumped };
}


// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a template — only if it was NEVER published AND has no submissions.
 * @returns {{ deleted: boolean }}
 */
async function deleteTemplate(db, id) {
  const row = await fetchRow(db, id);
  if (!row) throw notFound(`Template ${id} not found`);

  if (row.definition != null || row.published_at != null) {
    throw badRequest('cannot delete a template that has been published');
  }
  if (await submissionCount(db, row.form_key) > 0) {
    throw badRequest(`cannot delete: submissions exist for "${row.form_key}"`);
  }

  // No version rows exist for a never-published template; clear defensively anyway.
  await db.query('DELETE FROM form_template_versions WHERE template_id = ?', [id]);
  await db.query('DELETE FROM form_templates WHERE id = ?', [id]);

  return { deleted: true };
}


// ─────────────────────────────────────────────────────────────────────────────
// GET PUBLISHED BY KEY — what render.html consumes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Published projection for a form_key. Returns null when the key is unknown or
 * unpublished (route → 404). definition is a parsed object.
 * @returns {{ title, link_type, schema_version, definition }|null}
 */
async function getPublishedByKey(db, formKey) {
  const [[row]] = await db.query(
    `SELECT title, link_type, schema_version, definition
     FROM form_templates
     WHERE form_key = ? AND definition IS NOT NULL
     LIMIT 1`,
    [formKey]
  );
  if (!row) return null;
  row.definition = parseJsonCol(row.definition);
  return row;
}


// ─────────────────────────────────────────────────────────────────────────────
// VERSION HISTORY (Slice 4) — reads over form_template_versions + restore
// ─────────────────────────────────────────────────────────────────────────────

// Cheap existence check (no definition bodies). 404 if the template is unknown.
async function assertTemplateExists(db, id) {
  const [[row]] = await db.query(
    'SELECT id FROM form_templates WHERE id = ? LIMIT 1', [id]
  );
  if (!row) throw notFound(`Template ${id} not found`);
}

/**
 * List the publish history of a template, newest first. Each entry carries a
 * computed `schema_changed` boolean: whether that publish's field-set
 * signature (fieldSignature, §6) differs from the CHRONOLOGICALLY previous
 * version row. The first-ever publish is `schema_changed: true` (it
 * established the schema). Rows where the signature did not change are the
 * "no schema change" republishes the builder labels.
 *
 * Definitions are read internally for the signature computation but are NOT
 * included in the payload — fetch one via getVersion.
 *
 * @returns {Array<{ id, schema_version, published_by, user_name, published_at, schema_changed }>}
 */
async function listVersions(db, id) {
  await assertTemplateExists(db, id);
  const [rows] = await db.query(
    `SELECT v.id, v.schema_version, v.definition, v.published_by, v.published_at,
            u.user_name AS user_name
     FROM form_template_versions v
     LEFT JOIN users u ON u.user = v.published_by
     WHERE v.template_id = ?
     ORDER BY v.id ASC`,
    [id]
  );
  let prevSig = null;
  const out = rows.map((r) => {
    const sig = fieldSignature(parseJsonCol(r.definition));
    const schema_changed = prevSig === null ? true : sig !== prevSig;
    prevSig = sig;
    return {
      id: r.id,
      schema_version: r.schema_version,
      published_by: r.published_by,
      user_name: r.user_name,
      published_at: r.published_at,
      schema_changed,
    };
  });
  return out.reverse();   // newest first for the history view
}

/**
 * One version row including its definition (parsed). 404 when the version id
 * does not exist OR does not belong to the given template.
 */
async function getVersion(db, id, versionId) {
  await assertTemplateExists(db, id);
  const [[row]] = await db.query(
    `SELECT v.id, v.template_id, v.schema_version, v.definition, v.published_by,
            v.published_at, u.user_name AS user_name
     FROM form_template_versions v
     LEFT JOIN users u ON u.user = v.published_by
     WHERE v.id = ? AND v.template_id = ?
     LIMIT 1`,
    [versionId, id]
  );
  if (!row) throw notFound(`Version ${versionId} not found for template ${id}`);
  row.definition = parseJsonCol(row.definition);
  return row;
}

/**
 * Restore: copy a historical version's definition into draft_definition. The
 * PUBLISHED definition is untouched — the normal save/publish flow applies
 * from the restored draft. JSON is copied column-to-column in SQL (same
 * convention as publish) so no parsed object is re-bound to a placeholder.
 *
 * No structural re-validation here: the definition passed §7 when it was
 * published, and the draft column tolerates anything — PUT/publish remain the
 * validation gates.
 *
 * @returns {{ template: object, restored: { version_id, schema_version } }}
 */
async function restoreVersion(db, id, versionId, userId) {
  await assertTemplateExists(db, id);
  const [[v]] = await db.query(
    `SELECT id, schema_version FROM form_template_versions
     WHERE id = ? AND template_id = ? LIMIT 1`,
    [versionId, id]
  );
  if (!v) throw notFound(`Version ${versionId} not found for template ${id}`);

  await db.query(
    `UPDATE form_templates ft
       JOIN form_template_versions v ON v.id = ? AND v.template_id = ft.id
        SET ft.draft_definition = v.definition,
            ft.updated_by = ?
      WHERE ft.id = ?`,
    [versionId, userId, id]
  );

  const template = await fetchRow(db, id);
  return { template, restored: { version_id: v.id, schema_version: v.schema_version } };
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  publishTemplate,
  deleteTemplate,
  getPublishedByKey,
  listVersions,
  getVersion,
  restoreVersion,
  // exported for tests / reuse:
  validateDefinition,
  fieldSignature,
};