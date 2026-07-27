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
const SHOWWHEN_OPS  = new Set(['eq', 'neq', 'in', 'notEmpty']);

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
 * @param {object} def  parsed definition JSON
 */
function validateDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw badRequest('definition must be an object');
  }
  if (!Array.isArray(def.sections) || def.sections.length === 0) {
    throw badRequest('definition.sections must be a non-empty array');
  }

  const seen        = new Set();  // all field names, form-wide (incl. repeater fields)
  const topLevel    = new Set();  // names of fields in STANDARD sections (valid showWhen targets)
  const showWhenRefs = [];        // { path, field } collected for a second pass
  let hasApiColumn  = false;

  const noteShowWhen = (sw, path) => {
    if (sw == null) return;
    if (typeof sw !== 'object' || Array.isArray(sw)) {
      throw badRequest(`${path}.showWhen must be an object`);
    }
    if (!SHOWWHEN_OPS.has(sw.op)) {
      throw badRequest(`${path}.showWhen.op "${sw.op}" is not one of eq, neq, in, notEmpty`);
    }
    if (typeof sw.field !== 'string' || !sw.field) {
      throw badRequest(`${path}.showWhen.field is required`);
    }
    showWhenRefs.push({ path, field: sw.field });
  };

  const validateField = (field, path, { topLevelField }) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw badRequest(`${path} must be an object`);
    }
    if (typeof field.name !== 'string' || !FIELD_NAME_RE.test(field.name)) {
      throw badRequest(`${path}.name "${field.name}" is invalid (must match ^[a-zA-Z0-9_]{1,50}$)`);
    }
    if (!KNOWN_TYPES.has(field.type)) {
      throw badRequest(`${path}.type "${field.type}" is not a known field type`);
    }
    if (seen.has(field.name)) {
      throw badRequest(`duplicate field name "${field.name}" (${path}); names must be unique form-wide`);
    }
    seen.add(field.name);
    if (topLevelField) topLevel.add(field.name);

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

    // pattern, if present, must compile
    if (field.pattern !== undefined && field.pattern !== null && field.pattern !== '') {
      if (typeof field.pattern !== 'string') {
        throw badRequest(`${path}.pattern must be a string`);
      }
      try { new RegExp(field.pattern); }
      catch (e) { throw badRequest(`${path}.pattern is not a valid regular expression: ${e.message}`); }
    }

    if (typeof field.apiColumn === 'string' && field.apiColumn) hasApiColumn = true;

    noteShowWhen(field.showWhen, path);
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
      if (!Array.isArray(section.fields) || section.fields.length === 0) {
        throw badRequest(`${sPath} (repeater) requires a non-empty "fields" array`);
      }
      section.fields.forEach((f, k) => {
        validateField(f, `${sPath}.fields[${k}]`, { topLevelField: false });
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

  // Second pass: showWhen.field must reference an existing TOP-LEVEL field name.
  for (const ref of showWhenRefs) {
    if (!topLevel.has(ref.field)) {
      throw badRequest(`${ref.path}.showWhen.field "${ref.field}" does not reference an existing top-level field`);
    }
  }

  // onSubmit.patch requires at least one field declaring apiColumn.
  if (def.onSubmit && def.onSubmit.patch && !hasApiColumn) {
    throw badRequest('onSubmit.patch is set but no field declares an apiColumn');
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
  // exported for tests / reuse:
  validateDefinition,
  fieldSignature,
};