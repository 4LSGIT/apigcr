// services/pipelineAdminService.js
//
/**
 * pipelineAdminService.js — Admin service layer for the Case Pipeline Engine
 * (Slice C2: template + stage CRUD backing the Case Config manager UI).
 *
 * Backs routes/api.pipelineAdmin.js. services/pipelineService.js (the Slice B
 * read/advance engine) is deliberately untouched — this file is the ONLY
 * writer of pipeline_templates / pipeline_stages. case_stage_log is never
 * written here (advanceStage remains its only writer); it is only COUNTED,
 * because log references are what make keys immutable and rows undeletable.
 *
 * Server-enforced rules (each throws an Error carrying `.status`):
 *   - internal_label ≤ 50 chars → 400. cases.case_status is varchar(50) and
 *     the session lacks STRICT_TRANS_TABLES, so an over-length label would be
 *     truncated SILENTLY the first time advanceStage copies it into
 *     case_status. Rejecting at the admin boundary prevents that. (The column
 *     itself is varchar(100); the 50 cap is the case_status contract, not the
 *     column width.)
 *   - stage_key IMMUTABLE once any case_stage_log row references the stage —
 *     by stage_id OR by (template_id, stage_key) → 409. Keys are the
 *     permanent contract; automation and history reference keys, not labels.
 *     Labels remain freely editable — that is the point of the design.
 *   - deleteStage: hard delete only when zero log rows reference the stage
 *     (same predicate as immutability) → else 409 directing to active=0.
 *     Soft-deactivate via updateStage is always allowed.
 *   - deleteTemplate: hard delete only when zero log rows reference the
 *     template (by template_id OR by stage_id of any of its stages) → else
 *     409, deactivate instead. Stages cascade-delete in app code under the
 *     same guard (schema has no FK constraints — repo convention).
 *   - create/updateTemplate: a second ACTIVE template with an identical
 *     (case_type, case_subtype, role) triple → 409 unless {force:true}.
 *     resolveTemplate picks arbitrarily among duplicates (lowest id), so the
 *     guard keeps resolution deterministic; force is the escape hatch for a
 *     deliberate stage-and-swap.
 *   - Setting is_default=1 transactionally clears is_default on the other
 *     templates of the same case_type (single-default invariant —
 *     resolveTemplate branch 3 assumes at most one).
 *   - pipeline_stages.config: accepts an object or null. Objects are
 *     JSON.stringify'd before binding to the `?` placeholder (mysql2
 *     landmine: raw objects expand to `key`=val pairs). Blank/empty → NULL.
 *
 * Conventions (match services/pipelineService.js / formTemplateService.js):
 *   - Every function takes the mysql2 pool (req.db) as its first argument.
 *   - Business-rule failures throw Error with `.status` (400/404/409); the
 *     route maps `err.status || 500`.
 *   - withTransaction (lib/withTransaction) wherever an operation is
 *     multi-statement. All callbacks here are DB-side only, so the helper's
 *     single transient retry is safe.
 *   - Session sql_mode lacks STRICT_TRANS_TABLES: over-length strings clip
 *     silently and invalid enum values write '' silently. Every length and
 *     enum is therefore validated in JS with an explicit 400 rather than
 *     trusting the DB to complain.
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS / HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Column widths (ref/2026-08-02_pipeline_engine_slice_a.sql). Validated here
// with 400s because the session's lax sql_mode would otherwise clip silently.
const MAX_NAME         = 100;  // pipeline_templates.name varchar(100)
const MAX_TYPE         = 40;   // case_type / case_subtype varchar(40)
const MAX_INTERNAL     = 50;   // HARD CAP — cases.case_status contract, NOT the varchar(100) column
const MAX_CLIENT_LABEL = 100;  // pipeline_stages.client_label varchar(100)
const MAX_DEFAULT_REC  = 128;  // pipeline_stages.default_rec varchar(128)

const ROLES       = new Set(['intake', 'case']);
const CASE_STAGES = new Set(['Open', 'Pending', 'Filed', 'Concluded', 'Closed']);

// Same shape as form_key (formTemplateService FORM_KEY_RE). Every seeded key
// matches. Keys are permanent machine identifiers — keep them boring.
const STAGE_KEY_RE = /^[a-z0-9_]{1,50}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (msg) => httpError(400, msg);
const notFound   = (msg) => httpError(404, msg);
const conflict   = (msg) => httpError(409, msg);

/** Length/blank validation. Values are stored VERBATIM (no trimming — repo
 *  convention); `required` uses a trimmed check so whitespace-only fails. */
function vStr(label, v, max, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw badRequest(`${label} is required`);
    return v == null ? null : '';
  }
  if (typeof v !== 'string') throw badRequest(`${label} must be a string`);
  if (required && v.trim() === '') throw badRequest(`${label} is required`);
  if (v.length > max) {
    throw badRequest(`${label} must be at most ${max} characters (got ${v.length})`);
  }
  return v;
}

function vInternalLabel(v, { required = false } = {}) {
  // The one hard business cap: this string becomes cases.case_status
  // (varchar(50)) verbatim on advance. See file header.
  return vStr('internal_label', v, MAX_INTERNAL, { required });
}

function vBool(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v ? 1 : 0;
}

/**
 * Normalize a stage `config` value for the JSON column.
 *   undefined / null / '' / whitespace-only string → null
 *   plain object                                   → JSON.stringify(obj)
 *   JSON string                                    → parsed, must be a plain
 *                                                    object, re-stringified
 *   anything else (array, number, bool, bad JSON)  → 400
 * Always returns null or a STRING — never a raw object — so the caller can
 * bind it to a `?` placeholder safely (mysql2 object-expansion landmine).
 */
function normalizeConfig(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    let parsed;
    try { parsed = JSON.parse(v); }
    catch (e) { throw badRequest(`config is not valid JSON — ${e.message}`); }
    v = parsed;
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw badRequest('config must be a JSON object (or blank for none)');
  }
  return JSON.stringify(v);
}

/** Predicate SQL for "does history reference this stage": by row id OR by the
 *  (template_id, stage_key) identity. Used identically for the per-stage
 *  log_count in listStages, the stage_key immutability check, and the
 *  deleteStage guard — one definition of "referenced". */
const STAGE_LOG_REF_WHERE =
  `(l.stage_id = ? OR (l.template_id = ? AND l.stage_key = ?))`;

async function countStageLogRefs(conn, stage) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM case_stage_log l WHERE ${STAGE_LOG_REF_WHERE}`,
    [stage.id, stage.template_id, stage.stage_key]
  );
  return Number(row.n);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List ALL templates (active and inactive — this is the admin view) with a
 * per-template stage count and case_stage_log usage count.
 *
 * @param {object} db mysql2 pool
 * @returns {object[]} pipeline_templates rows + { stage_count, log_count }
 */
async function listTemplates(db) {
  const [rows] = await db.query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM pipeline_stages s  WHERE s.template_id = t.id) AS stage_count,
            (SELECT COUNT(*) FROM case_stage_log  l  WHERE l.template_id = t.id) AS log_count
       FROM pipeline_templates t
      ORDER BY t.id ASC`
  );
  return rows;
}

/** Shared field validation for create/update. `next` is the fully-merged row
 *  candidate. Throws 400 on any problem. */
function validateTemplateFields(next) {
  vStr('name', next.name, MAX_NAME, { required: true });
  vStr('case_type', next.case_type, MAX_TYPE);
  vStr('case_subtype', next.case_subtype, MAX_TYPE);
  if (!ROLES.has(next.role)) {
    throw badRequest(`role "${next.role}" must be one of: intake, case`);
  }
}

/** Duplicate-active guard (see header). Runs INSIDE the transaction so the
 *  check and the write are atomic. excludeId skips self on update. */
async function assertNoActiveDupe(conn, next, force, excludeId = 0) {
  if (!next.active || force) return;
  const [rows] = await conn.query(
    `SELECT id, name FROM pipeline_templates
      WHERE active = 1 AND role = ? AND case_type = ? AND case_subtype = ?
        AND id != ?
      ORDER BY id ASC`,
    [next.role, next.case_type, next.case_subtype, excludeId]
  );
  if (rows.length) {
    throw conflict(
      `An active ${next.role} template already exists for ` +
      `("${next.case_type}", "${next.case_subtype}"): "${rows[0].name}" (id ${rows[0].id}). ` +
      `resolveTemplate would pick among duplicates arbitrarily — deactivate it first, ` +
      `or pass force:true to override.`
    );
  }
}

/** Single-default invariant: at most one is_default=1 per case_type. Runs
 *  whenever the row will end up default (covers both "newly set" and
 *  "default row moved to another case_type"). */
async function clearOtherDefaults(conn, caseType, excludeId = 0) {
  await conn.query(
    `UPDATE pipeline_templates SET is_default = 0
      WHERE case_type = ? AND is_default = 1 AND id != ?`,
    [caseType, excludeId]
  );
}

/**
 * Create a template.
 *
 * @param {object} db mysql2 pool
 * @param {object} body { name, case_type?, case_subtype?, role?, is_default?,
 *                        description?, active?, force? }
 * @returns fresh pipeline_templates row
 * @throws 400 validation; 409 duplicate-active (unless force)
 */
async function createTemplate(db, body = {}) {
  const next = {
    name:         body.name,
    case_type:    body.case_type    == null ? '' : body.case_type,
    case_subtype: body.case_subtype == null ? '' : body.case_subtype,
    role:         body.role         == null ? 'case' : body.role,
    is_default:   vBool(body.is_default, 0),
    description:  body.description  == null || body.description === '' ? null : String(body.description),
    active:       vBool(body.active, 1),
  };
  validateTemplateFields(next);
  const force = !!body.force;

  return withTransaction(db, async (conn) => {
    await assertNoActiveDupe(conn, next, force);
    if (next.is_default) await clearOtherDefaults(conn, next.case_type);
    const [ins] = await conn.query(
      `INSERT INTO pipeline_templates
         (name, case_type, case_subtype, role, is_default, description, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [next.name, next.case_type, next.case_subtype, next.role,
       next.is_default, next.description, next.active]
    );
    const [[row]] = await conn.query(
      `SELECT * FROM pipeline_templates WHERE id = ?`, [ins.insertId]
    );
    return row;
  });
}

/**
 * Update a template (partial body — only provided keys change).
 *
 * @param {object} db mysql2 pool
 * @param {number|string} id pipeline_templates.id
 * @param {object} body any of { name, case_type, case_subtype, role,
 *                       is_default, description, active, force }
 * @returns fresh pipeline_templates row
 * @throws 400 validation; 404 unknown id; 409 duplicate-active (unless force)
 */
async function updateTemplate(db, id, body = {}) {
  const force = !!body.force;

  return withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      `SELECT * FROM pipeline_templates WHERE id = ?`, [id]
    );
    if (!cur) throw notFound(`Template ${id} not found`);

    const next = {
      name:         'name'         in body ? body.name : cur.name,
      case_type:    'case_type'    in body ? (body.case_type    == null ? '' : body.case_type)    : cur.case_type,
      case_subtype: 'case_subtype' in body ? (body.case_subtype == null ? '' : body.case_subtype) : cur.case_subtype,
      role:         'role'         in body ? body.role : cur.role,
      is_default:   'is_default'   in body ? vBool(body.is_default, 0) : (cur.is_default ? 1 : 0),
      description:  'description'  in body
                      ? (body.description == null || body.description === '' ? null : String(body.description))
                      : cur.description,
      active:       'active'       in body ? vBool(body.active, 1) : (cur.active ? 1 : 0),
    };
    validateTemplateFields(next);

    await assertNoActiveDupe(conn, next, force, cur.id);
    if (next.is_default) await clearOtherDefaults(conn, next.case_type, cur.id);

    await conn.query(
      `UPDATE pipeline_templates
          SET name = ?, case_type = ?, case_subtype = ?, role = ?,
              is_default = ?, description = ?, active = ?
        WHERE id = ?`,
      [next.name, next.case_type, next.case_subtype, next.role,
       next.is_default, next.description, next.active, cur.id]
    );
    const [[row]] = await conn.query(
      `SELECT * FROM pipeline_templates WHERE id = ?`, [cur.id]
    );
    return row;
  });
}

/**
 * Hard-delete a template AND its stages — only when zero case_stage_log rows
 * reference it (by template_id, or by stage_id of any of its stages: log rows
 * from imports/backfills may carry a stage_id with a NULL template_id).
 *
 * @throws 404 unknown id; 409 when history references it (deactivate instead)
 */
async function deleteTemplate(db, id) {
  return withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      `SELECT id, name FROM pipeline_templates WHERE id = ?`, [id]
    );
    if (!cur) throw notFound(`Template ${id} not found`);

    const [[ref]] = await conn.query(
      `SELECT COUNT(*) AS n FROM case_stage_log l
        WHERE l.template_id = ?
           OR l.stage_id IN (SELECT s.id FROM pipeline_stages s WHERE s.template_id = ?)`,
      [cur.id, cur.id]
    );
    if (Number(ref.n) > 0) {
      throw conflict(
        `Template "${cur.name}" has ${ref.n} case history row(s) referencing it and ` +
        `cannot be deleted. Deactivate it instead (set active to 0).`
      );
    }

    await conn.query(`DELETE FROM pipeline_stages WHERE template_id = ?`, [cur.id]);
    await conn.query(`DELETE FROM pipeline_templates WHERE id = ?`, [cur.id]);
    return { deleted: true, id: cur.id };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List ALL stages of a template (active and inactive), ordered, each with
 * `log_count` — the number of history rows referencing the stage under the
 * shared reference predicate. log_count > 0 is exactly the condition that
 * locks stage_key and blocks hard delete, so the UI reads it directly.
 *
 * @returns {{ template: object, stages: object[] }}
 * @throws 404 unknown template
 */
async function listStages(db, templateId) {
  const [[template]] = await db.query(
    `SELECT * FROM pipeline_templates WHERE id = ?`, [templateId]
  );
  if (!template) throw notFound(`Template ${templateId} not found`);

  const [stages] = await db.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM case_stage_log l
              WHERE l.stage_id = s.id
                 OR (l.template_id = s.template_id AND l.stage_key = s.stage_key)
            ) AS log_count
       FROM pipeline_stages s
      WHERE s.template_id = ?
      ORDER BY s.stage_number ASC, s.id ASC`,
    [templateId]
  );
  return { template, stages };
}

/** Shared stage field validation on a merged candidate (create: everything
 *  required; update: only what changed). Throws 400. */
function validateStageFields(next, { checkKey }) {
  if (checkKey && !STAGE_KEY_RE.test(String(next.stage_key || ''))) {
    throw badRequest(
      `stage_key "${next.stage_key}" is invalid — lowercase letters, digits and ` +
      `underscores only, 1–50 chars (^[a-z0-9_]{1,50}$)`
    );
  }
  vInternalLabel(next.internal_label, { required: true });
  if (!CASE_STAGES.has(next.case_stage)) {
    throw badRequest(
      `case_stage "${next.case_stage}" must be one of: Open, Pending, Filed, Concluded, Closed ` +
      `(lax sql_mode would store an invalid enum value as '' silently)`
    );
  }
  if (next.client_label != null) vStr('client_label', next.client_label, MAX_CLIENT_LABEL);
  vStr('default_rec', next.default_rec == null ? '' : next.default_rec, MAX_DEFAULT_REC);
}

/**
 * Create a stage on a template. stage_number defaults to (current max + 1).
 * Duplicate stage_key within the template → 409 (mapped from the
 * uq_template_key UNIQUE constraint, which fires regardless of sql_mode).
 *
 * @throws 400 validation; 404 unknown template; 409 duplicate key
 */
async function createStage(db, templateId, body = {}) {
  const next = {
    stage_key:      body.stage_key,
    internal_label: body.internal_label,
    client_label:   body.client_label == null || body.client_label === '' ? null : body.client_label,
    case_stage:     body.case_stage,
    client_visible: vBool(body.client_visible, 1),
    is_terminal:    vBool(body.is_terminal, 0),
    default_rec:    body.default_rec == null ? '' : body.default_rec,
    active:         vBool(body.active, 1),
  };
  validateStageFields(next, { checkKey: true });
  const configJson = normalizeConfig(body.config);   // null or a STRING — never a raw object

  return withTransaction(db, async (conn) => {
    const [[tpl]] = await conn.query(
      `SELECT id FROM pipeline_templates WHERE id = ?`, [templateId]
    );
    if (!tpl) throw notFound(`Template ${templateId} not found`);

    let stageNumber = body.stage_number;
    if (stageNumber == null || !Number.isInteger(Number(stageNumber))) {
      const [[mx]] = await conn.query(
        `SELECT COALESCE(MAX(stage_number), 0) + 1 AS next_num
           FROM pipeline_stages WHERE template_id = ?`,
        [templateId]
      );
      stageNumber = Number(mx.next_num);
    } else {
      stageNumber = Number(stageNumber);
    }

    let ins;
    try {
      [ins] = await conn.query(
        `INSERT INTO pipeline_stages
           (template_id, stage_number, stage_key, internal_label, client_label,
            case_stage, client_visible, is_terminal, default_rec, config, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tpl.id, stageNumber, next.stage_key, next.internal_label, next.client_label,
         next.case_stage, next.client_visible, next.is_terminal, next.default_rec,
         configJson, next.active]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        throw conflict(`stage_key "${next.stage_key}" already exists in this template`);
      }
      throw err;
    }
    const [[row]] = await conn.query(
      `SELECT * FROM pipeline_stages WHERE id = ?`, [ins.insertId]
    );
    return row;
  });
}

/**
 * Update a stage (partial body). stage_key changes are refused with 409 once
 * ANY log row references the stage (by stage_id or by the old
 * (template_id, stage_key) pair) — keys are the permanent contract. Every
 * other field, including active (the soft-deactivate path) and both labels,
 * stays freely editable.
 *
 * @throws 400 validation; 404 unknown stage; 409 locked key / duplicate key
 */
async function updateStage(db, stageId, body = {}) {
  return withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      `SELECT * FROM pipeline_stages WHERE id = ?`, [stageId]
    );
    if (!cur) throw notFound(`Stage ${stageId} not found`);

    const keyChanging = 'stage_key' in body && body.stage_key !== cur.stage_key;
    if (keyChanging) {
      const n = await countStageLogRefs(conn, cur);
      if (n > 0) {
        throw conflict(
          `stage_key "${cur.stage_key}" is locked — ${n} case history row(s) reference it. ` +
          `Keys are permanent once used; edit the labels instead, or add a new stage.`
        );
      }
    }

    const next = {
      stage_key:      keyChanging ? body.stage_key : cur.stage_key,
      stage_number:   'stage_number'   in body && Number.isInteger(Number(body.stage_number))
                        ? Number(body.stage_number) : cur.stage_number,
      internal_label: 'internal_label' in body ? body.internal_label : cur.internal_label,
      client_label:   'client_label'   in body
                        ? (body.client_label == null || body.client_label === '' ? null : body.client_label)
                        : cur.client_label,
      case_stage:     'case_stage'     in body ? body.case_stage : cur.case_stage,
      client_visible: 'client_visible' in body ? vBool(body.client_visible, 1) : (cur.client_visible ? 1 : 0),
      is_terminal:    'is_terminal'    in body ? vBool(body.is_terminal, 0)    : (cur.is_terminal ? 1 : 0),
      default_rec:    'default_rec'    in body ? (body.default_rec == null ? '' : body.default_rec) : cur.default_rec,
      active:         'active'         in body ? vBool(body.active, 1) : (cur.active ? 1 : 0),
    };
    validateStageFields(next, { checkKey: keyChanging });

    // config: only touched when the key is present in the body. mysql2 hands
    // JSON columns back as parsed objects, so an untouched pass-through must
    // re-stringify (normalizeConfig handles both shapes).
    const configJson = 'config' in body
      ? normalizeConfig(body.config)
      : normalizeConfig(cur.config);

    try {
      await conn.query(
        `UPDATE pipeline_stages
            SET stage_number = ?, stage_key = ?, internal_label = ?, client_label = ?,
                case_stage = ?, client_visible = ?, is_terminal = ?, default_rec = ?,
                config = ?, active = ?
          WHERE id = ?`,
        [next.stage_number, next.stage_key, next.internal_label, next.client_label,
         next.case_stage, next.client_visible, next.is_terminal, next.default_rec,
         configJson, next.active, cur.id]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        throw conflict(`stage_key "${next.stage_key}" already exists in this template`);
      }
      throw err;
    }
    const [[row]] = await conn.query(
      `SELECT * FROM pipeline_stages WHERE id = ?`, [cur.id]
    );
    return row;
  });
}

/**
 * Hard-delete a stage — only when zero log rows reference it (same predicate
 * as the immutability check). Otherwise 409 pointing at soft-deactivate,
 * which is always allowed via updateStage {active: 0}.
 *
 * @throws 404 unknown stage; 409 when referenced
 */
async function deleteStage(db, stageId) {
  return withTransaction(db, async (conn) => {
    const [[cur]] = await conn.query(
      `SELECT * FROM pipeline_stages WHERE id = ?`, [stageId]
    );
    if (!cur) throw notFound(`Stage ${stageId} not found`);

    const n = await countStageLogRefs(conn, cur);
    if (n > 0) {
      throw conflict(
        `Stage "${cur.stage_key}" has ${n} case history row(s) referencing it and ` +
        `cannot be deleted. Deactivate it instead (set active to 0).`
      );
    }

    await conn.query(`DELETE FROM pipeline_stages WHERE id = ?`, [cur.id]);
    return { deleted: true, id: cur.id };
  });
}

/**
 * Rewrite stage_number for a template transactionally. orderedStageIds must
 * be EXACTLY the template's stage ids (every stage, active or not, exactly
 * once) — a partial or stale list would silently corrupt ordering, so it's a
 * 400 naming the mismatch. Numbers are rewritten 1..N in the given order.
 *
 * @returns fresh { template, stages } (listStages shape)
 * @throws 400 bad/mismatched id list; 404 unknown template
 */
async function reorderStages(db, templateId, orderedStageIds) {
  if (!Array.isArray(orderedStageIds) || orderedStageIds.length === 0) {
    throw badRequest('stage_ids must be a non-empty array of stage ids');
  }
  const ids = orderedStageIds.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw badRequest('stage_ids must all be positive integers');
  }
  if (new Set(ids).size !== ids.length) {
    throw badRequest('stage_ids contains duplicates');
  }

  await withTransaction(db, async (conn) => {
    const [[tpl]] = await conn.query(
      `SELECT id FROM pipeline_templates WHERE id = ?`, [templateId]
    );
    if (!tpl) throw notFound(`Template ${templateId} not found`);

    const [rows] = await conn.query(
      `SELECT id FROM pipeline_stages WHERE template_id = ?`, [templateId]
    );
    const existing = new Set(rows.map((r) => Number(r.id)));
    const given    = new Set(ids);
    const missing  = [...existing].filter((x) => !given.has(x));
    const extra    = [...given].filter((x) => !existing.has(x));
    if (missing.length || extra.length) {
      throw badRequest(
        `stage_ids must list every stage of template ${templateId} exactly once` +
        (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
        (extra.length   ? ` — not in template: ${extra.join(', ')}` : '')
      );
    }

    for (let i = 0; i < ids.length; i++) {
      await conn.query(
        `UPDATE pipeline_stages SET stage_number = ? WHERE id = ? AND template_id = ?`,
        [i + 1, ids[i], templateId]
      );
    }
  });

  return listStages(db, templateId);
}

// ─────────────────────────────────────────────────────────────────────────────
// USAGE COUNTS (Types/Subtypes editor warnings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count references to a case type (or type+subtype pair) so the
 * Types/Subtypes editor can warn on rename/delete.
 *
 *   - case_subtype omitted/blank → match on case_type only (a TYPE rename
 *     touches every subtype under it).
 *   - case_subtype given → match the exact pair.
 *
 * templates counts include INACTIVE templates deliberately — a rename must
 * update those too or they resurface pointing at a dead name. Matching is
 * case-insensitive via the tables' utf8mb4_general_ci collation (same
 * semantics resolveTemplate mirrors in JS).
 *
 * @returns {{ cases: number, templates: number }}
 * @throws 400 when case_type is blank
 */
async function usageCounts(db, case_type, case_subtype) {
  if (case_type == null || String(case_type).trim() === '') {
    throw badRequest('case_type is required');
  }
  const hasSub = case_subtype != null && String(case_subtype).trim() !== '';

  const caseSql = hasSub
    ? `SELECT COUNT(*) AS n FROM cases WHERE case_type = ? AND case_subtype = ?`
    : `SELECT COUNT(*) AS n FROM cases WHERE case_type = ?`;
  const tplSql = hasSub
    ? `SELECT COUNT(*) AS n FROM pipeline_templates WHERE case_type = ? AND case_subtype = ?`
    : `SELECT COUNT(*) AS n FROM pipeline_templates WHERE case_type = ?`;
  const params = hasSub ? [case_type, case_subtype] : [case_type];

  const [[c]] = await db.query(caseSql, params);
  const [[t]] = await db.query(tplSql, params);
  return { cases: Number(c.n), templates: Number(t.n) };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOARD (Slice C3 — Kanban board read model)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize for template matching — mirrors pipelineService.ciEq's
 *  trim+lowercase semantics (which itself mirrors utf8mb4_general_ci). */
function boardNorm(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * Board read model: every case that pipelineService.resolveTemplate would
 * resolve to `templateId`, bucketed into that template's stage columns by the
 * case's LATEST case_stage_log row (or `unstaged` when it has none, or when
 * its latest stage_key is not among this template's active stages — the
 * branched-from-intake shape; C1 matches by stage_key, not stage_id, and so
 * does the board).
 *
 * Membership mirrors resolveTemplate's branch order EXACTLY (that function is
 * read, not modified — this is the SQL restatement of its JS):
 *   branch 1 — pipeline_phase != 'case' → THE intake template (first active
 *              role='intake' by id). Board clause:
 *              COALESCE(pipeline_phase,'') <> 'case'.
 *   branch 2 — first active role='case' template exactly matching
 *              (case_type, case_subtype), CI + trimmed. Board clause:
 *              phase='case' AND both trimmed values equal (collation is
 *              utf8mb4_general_ci, so SQL `=` is the CI half; TRIM supplies
 *              the trim half of ciEq).
 *   branch 3 — first active is_default=1 role='case' template of the
 *              case_type. Board clause: phase='case', type matches, subtype
 *              NOT IN the subtypes that have their own exact active template
 *              for this type (those cases stopped at branch 2).
 *   branch 4 — fallback to the intake template: phase='case' with NO exact
 *              active template for its (type, subtype) AND no active default
 *              for its type. Part of the INTAKE board.
 *
 * T8 — the branch clauses key on cases.pipeline_phase (LIFECYCLE), not on
 * blank/non-blank case_subtype (MATTER). The old `TRIM(case_subtype) = ''`
 * / `<> ''` guards are GONE from every branch, not merely supplemented: a
 * post-retainer case with a blank subtype must reach branch 3/4 (it does
 * — 33 such rows live at T8), and a lead with a KNOWN chapter must stay on
 * the intake board (branch 1) rather than appearing on the chapter board
 * with no stage. Chapter boards are post-retainer only, by design.
 * First-match-wins ties (resolveTemplate uses .find over id ASC) are mirrored
 * too: a template shadowed by a lower-id duplicate — or an inactive one —
 * resolves for NO case, so its board is structurally empty.
 *
 * Set-based: one cases scan with the membership WHERE (+ Closed filter),
 * one groupwise-max scan of case_stage_log (tiny table) — no per-case
 * queries. Primary contact via the MIN-subquery precedent from
 * caseService.searchCases; case_display via the listCases COALESCE precedent
 * hardened with NULLIF (case_number/_full hold '' on a handful of live rows,
 * and plain COALESCE would display the empty string).
 *
 * @param {object} db mysql2 pool
 * @param {number|string} templateId pipeline_templates.id
 * @param {object} [opts]
 * @param {boolean} [opts.includeClosed=false] include case_stage='Closed'
 *        cases (excluded by default)
 * @returns {{ template: object,
 *             stages: object[],           // active, stage_number order, incl. client_visible
 *             columns: { unstaged: object[], [stage_key]: object[] } }}
 *   Card: { case_id, case_display, primary_contact_name, case_stage,
 *           case_status, case_type, case_subtype, case_open_date,
 *           current_stage_key, current_entered_at, current_note,
 *           days_in_stage }  (the current_* trio + days null when unstaged
 *           with no history; case_open_date null when unset — 167 live rows)
 * @throws 400 bad template_id; 404 unknown template
 */
async function getBoard(db, templateId, { includeClosed = false } = {}) {
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('template_id must be a positive integer');
  }

  const [[template]] = await db.query(
    `SELECT * FROM pipeline_templates WHERE id = ?`, [id]
  );
  if (!template) throw notFound(`Template ${id} not found`);

  // Active stages, stage_number order — getPipeline's stage projection plus
  // client_visible (board contract).
  const [stages] = await db.query(
    `SELECT id AS stage_id, stage_key, stage_number, internal_label,
            client_label, client_visible, case_stage, is_terminal, default_rec
       FROM pipeline_stages
      WHERE template_id = ? AND active = 1
      ORDER BY stage_number ASC, id ASC`,
    [id]
  );

  // Same load resolveTemplate performs — all active templates, id ASC.
  const [templates] = await db.query(
    `SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC`
  );

  const intake = templates.find(t => t.role === 'intake') || null;

  // Exact active (type, subtype) case-templates with a NON-BLANK subtype —
  // the only ones branch 2 can ever match (a case reaching branch 2 has a
  // non-blank subtype, which can't ci-equal ''). Trimmed originals for SQL
  // binding; the CI half of ciEq is the column collation.
  const exactTemplates = templates.filter(
    t => t.role === 'case' && boardNorm(t.case_subtype) !== ''
  );
  // Active default types (branch 3 / branch 4 context).
  const defaultTypes = templates
    .filter(t => t.role === 'case' && t.is_default)
    .map(t => String(t.case_type == null ? '' : t.case_type).trim());

  // Which resolution outcomes land on THIS template? (.find === T mirrors
  // first-match-wins; an inactive T is absent from `templates`, so nothing
  // matches and the board is empty by construction.)
  const isTheIntake = !!(intake && intake.id === template.id);
  const winsExact = template.role === 'case' &&
    (templates.find(t =>
      t.role === 'case' &&
      boardNorm(t.case_type) === boardNorm(template.case_type) &&
      boardNorm(t.case_subtype) === boardNorm(template.case_subtype) &&
      boardNorm(t.case_subtype) !== ''
    ) || {}).id === template.id;
  const winsDefault = template.role === 'case' && !!template.is_default &&
    (templates.find(t =>
      t.role === 'case' && t.is_default &&
      boardNorm(t.case_type) === boardNorm(template.case_type)
    ) || {}).id === template.id;

  const clauses = [];
  const params = [];

  if (isTheIntake) {
    // Branch 1: still in the funnel — ANY subtype, known chapter included.
    clauses.push(`COALESCE(c.pipeline_phase, '') <> 'case'`);
    // Branch 4: post-retainer case with no exact template and no type default.
    let b4 = `COALESCE(c.pipeline_phase, '') = 'case'`;
    if (exactTemplates.length) {
      b4 += ` AND (TRIM(c.case_type), TRIM(c.case_subtype)) NOT IN (` +
        exactTemplates.map(() => `(?, ?)`).join(', ') + `)`;
      for (const t of exactTemplates) {
        params.push(String(t.case_type == null ? '' : t.case_type).trim());
        params.push(String(t.case_subtype).trim());
      }
    }
    if (defaultTypes.length) {
      b4 += ` AND TRIM(c.case_type) NOT IN (` +
        defaultTypes.map(() => `?`).join(', ') + `)`;
      params.push(...defaultTypes);
    }
    clauses.push(`(${b4})`);
  }

  if (winsExact) {
    // Branch 2: post-retainer, exact (type, subtype).
    clauses.push(
      `(COALESCE(c.pipeline_phase, '') = 'case' ` +
      `AND TRIM(c.case_type) = ? AND TRIM(c.case_subtype) = ?)`
    );
    params.push(String(template.case_type == null ? '' : template.case_type).trim());
    params.push(String(template.case_subtype).trim());
  }

  if (winsDefault) {
    // Branch 3: same type, non-blank subtype, minus subtypes owned by an
    // exact active template of this type (their cases stopped at branch 2).
    const siblingSubtypes = exactTemplates
      .filter(t => boardNorm(t.case_type) === boardNorm(template.case_type))
      .map(t => String(t.case_subtype).trim());
    let b3 = `COALESCE(c.pipeline_phase, '') = 'case' AND TRIM(c.case_type) = ?`;
    const b3Params = [String(template.case_type == null ? '' : template.case_type).trim()];
    if (siblingSubtypes.length) {
      b3 += ` AND TRIM(c.case_subtype) NOT IN (` +
        siblingSubtypes.map(() => `?`).join(', ') + `)`;
      b3Params.push(...siblingSubtypes);
    }
    clauses.push(`(${b3})`);
    params.push(...b3Params);
  }

  // Empty columns scaffold — unstaged first, then stage_key order. (A stage
  // literally keyed 'unstaged' would share the meta bucket; the key regex
  // permits it but nothing seeds it — theoretical, accepted.)
  const columns = { unstaged: [] };
  for (const s of stages) columns[s.stage_key] = columns[s.stage_key] || [];

  if (!clauses.length) {
    // Shadowed or inactive template: resolveTemplate never picks it.
    return { template, stages, columns };
  }

  const closedFilter = includeClosed ? '' : ` AND c.case_stage <> 'Closed'`;

  // Cards: one cases scan. Primary contact = MIN-subquery precedent
  // (caseService.searchCases); display = listCases COALESCE precedent with
  // NULLIF hardening for ''-valued docket columns.
  const [cardRows] = await db.query(
    `SELECT c.case_id,
            COALESCE(NULLIF(c.case_number_full, ''), NULLIF(c.case_number, ''), c.case_id) AS case_display,
            c.case_stage, c.case_status,
            c.case_type, c.case_subtype, c.case_open_date,
            pc.contact_name AS primary_contact_name
       FROM cases c
       LEFT JOIN (
         SELECT case_relate_case_id, MIN(case_relate_client_id) AS primary_contact_id
           FROM case_relate
          WHERE case_relate_type = 'Primary'
          GROUP BY case_relate_case_id
       ) p ON p.case_relate_case_id = c.case_id
       LEFT JOIN contacts pc ON pc.contact_id = p.primary_contact_id
      WHERE (${clauses.join(' OR ')})${closedFilter}
      ORDER BY c.case_id ASC`,
    params
  );

  // Latest log row per case — groupwise max on (entered_at DESC, id DESC),
  // the exact ordering advanceStage/getPipeline use for "latest". One
  // set-based self-join over the (tiny) log; merged in JS.
  const [latestRows] = await db.query(
    `SELECT l.case_id, l.stage_key, l.entered_at, l.note,
            GREATEST(TIMESTAMPDIFF(DAY, l.entered_at, NOW()), 0) AS days_in_stage
       FROM case_stage_log l
       LEFT JOIN case_stage_log l2
         ON l2.case_id = l.case_id
        AND (l2.entered_at > l.entered_at
             OR (l2.entered_at = l.entered_at AND l2.id > l.id))
      WHERE l2.id IS NULL`
  );
  const latestByCase = new Map(latestRows.map(r => [r.case_id, r]));

  const stageKeys = new Set(stages.map(s => s.stage_key));

  for (const r of cardRows) {
    const latest = latestByCase.get(r.case_id) || null;
    const card = {
      case_id: r.case_id,
      case_display: r.case_display,
      primary_contact_name: r.primary_contact_name || null,
      case_stage: r.case_stage,
      case_status: r.case_status,
      case_type: r.case_type,
      case_subtype: r.case_subtype,
      case_open_date: r.case_open_date || null,
      current_stage_key: latest ? latest.stage_key : null,
      current_entered_at: latest ? latest.entered_at : null,
      current_note: latest ? (latest.note || null) : null,
      days_in_stage: latest ? Number(latest.days_in_stage) : null,
    };
    // Latest key not in THIS template's active stages (no history, or history
    // written under another template — branched-from-intake) → unstaged; the
    // card keeps its live case_status visible either way.
    const target = latest && stageKeys.has(latest.stage_key)
      ? latest.stage_key
      : 'unstaged';
    columns[target].push(card);
  }

  // Unstaged: alphabetical by contact (fallback display) — a browse list.
  // Staged: longest-in-stage first — the attention order.
  columns.unstaged.sort((a, b) =>
    String(a.primary_contact_name || a.case_display).localeCompare(
      String(b.primary_contact_name || b.case_display)) ||
    String(a.case_id).localeCompare(String(b.case_id))
  );
  for (const s of stages) {
    if (s.stage_key === 'unstaged') continue;
    columns[s.stage_key].sort((a, b) =>
      new Date(a.current_entered_at) - new Date(b.current_entered_at) ||
      String(a.case_id).localeCompare(String(b.case_id))
    );
  }

  return { template, stages, columns };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listStages,
  createStage,
  updateStage,
  deleteStage,
  reorderStages,
  usageCounts,
  getBoard,
};