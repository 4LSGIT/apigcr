// routes/sequences.js
//
// Sequence template management + enrollment operations.
//
// Template CRUD:
//   GET    /sequences/templates                         list all templates
//   GET    /sequences/templates/:id                     get template + steps
//   POST   /sequences/templates                         create template
//   PUT    /sequences/templates/:id                     update template
//   DELETE /sequences/templates/:id                     delete template + steps
//   POST   /sequences/templates/:id/duplicate           duplicate template + steps (created inactive)
//   POST   /sequences/templates/:id/steps               add step
//   PUT    /sequences/templates/:id/steps/:stepNumber   replace step
//   PATCH  /sequences/templates/:id/steps/:stepNumber   partial update step
//   DELETE /sequences/templates/:id/steps/:stepNumber   delete + renumber
//   PATCH  /sequences/templates/:id/steps/reorder       move a step / apply full order
//
// Enrollments:
//   POST   /sequences/enroll                           enroll a contact
//   POST   /sequences/cancel                           cancel sequences for a contact
//   GET    /sequences/enrollments                      list enrollments (filterable by contact/type/status)
//   GET    /sequences/enrollments/:id                  single enrollment + step log (?history=true for scheduled-jobs-derived history)
//   GET    /sequences/templates/:id/enrollments        list enrollments scoped to a template (paginated)
//   POST   /sequences/enrollments/:id/cancel           cancel one enrollment

const express         = require('express');
const router          = express.Router();
const jwtOrApiKey     = require('../lib/auth.jwtOrApiKey');
const { enrollContact, enrollContactByTemplateId, previewEnrollmentSteps, cancelSequences, validateTemplateFilters, scheduleStepJob } = require('../lib/sequenceEngine');
const { diffSequenceSteps, validateSequenceDraftShape, canonical, parseMaybeJson } = require('../lib/versionDiff');
const toJson = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

// Normalize the optional `type` column. As of Slice B, sequence_templates.type
// is nullable — templates without a type are "ID-only" and can be enrolled only
// via template_id (no cascade matching). Treat null, empty string, and
// whitespace-only strings all equivalently as NULL.
const normalizeType = v => (v == null || !String(v).trim()) ? null : String(v).trim();

// ─────────────────────────────────────────────────────────────
// Slice 2.1 — test_input validation helper.
//
// sequence_templates.test_input is authorial documentation of the
// trigger_data shape this sequence expects at enrollment. Nullable; no
// runtime validation against it. At save time we only check shape: must be
// absent/null/undefined, or a plain JSON object (not an array, not a
// primitive).
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────
function validateTestInput(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    return {
      status: 400,
      error: 'test_input must be a JSON object or null (arrays and primitives are not accepted)',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Slice E Phase 2 — filters shape validation helper.
//
// Shape-only check (object | null | undefined). Semantic validation
// against the type's priority_fields is delegated to
// sequenceEngine.validateTemplateFilters which hits the DB.
// ─────────────────────────────────────────────────────────────
function validateFiltersShape(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    return {
      status: 400,
      error: 'filters must be a JSON object or null (arrays and primitives are not accepted)',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Timing validation — Timing-extensions slice
//
// Validates the `timing` JSON column on sequence_steps at save time. The
// engine (lib/sequenceEngine.calculateStepTime) is the runtime source of
// truth; this helper just rejects shapes that are guaranteed to fail
// before they hit the DB.
//
// Permissive by default — only `delay` (which got new "absolute" mode and
// `randomizeMinutes`) is fully validated. Other types preserve the existing
// open-config behavior so we don't accidentally reject a working config
// nobody documented.
//
// Returns null on success, or { status, error, message? } on failure.
// ─────────────────────────────────────────────────────────────

const { parseUserDateTime } = require('../services/timezoneService');

const ALLOWED_TIMING_TYPES = [
  'immediate', 'delay', 'next_business_day', 'business_days',
  'before_appt', 'before_appt_fixed', 'open_delay',
];

function _hasPlaceholder(s) {
  return typeof s === 'string' && /\{\{[^}]+\}\}/.test(s);
}

function _validateRandomizeMinutes(rm) {
  if (rm === undefined || rm === null) return null;
  const n = Number(rm);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { status: 400, error: 'randomizeMinutes must be a non-negative integer' };
  }
  if (n > 1440) {
    return { status: 400, error: 'randomizeMinutes cannot exceed 1440 (24 hours)' };
  }
  return null;
}

function validateTiming(timing) {
  if (timing == null) {
    return { status: 400, error: 'timing is required' };
  }
  if (typeof timing !== 'object' || Array.isArray(timing)) {
    return { status: 400, error: 'timing must be a JSON object' };
  }
  if (!ALLOWED_TIMING_TYPES.includes(timing.type)) {
    return {
      status: 400,
      error: `Invalid timing.type: "${timing.type}"`,
      message: `Must be one of: ${ALLOWED_TIMING_TYPES.join(', ')}`,
    };
  }

  if (timing.type === 'delay') {
    const hasAt           = timing.at !== undefined && timing.at !== null && timing.at !== '';
    const hasValueOrUnit  = timing.value !== undefined || timing.unit !== undefined;

    if (hasAt && hasValueOrUnit) {
      return {
        status: 400,
        error: 'delay timing accepts exactly one of `at` (absolute) or `value`+`unit` (relative), not both',
      };
    }
    if (!hasAt && !hasValueOrUnit) {
      return {
        status: 400,
        error: 'delay timing requires either `at` (absolute) or `value`+`unit` (relative)',
      };
    }

    if (hasAt) {
      if (typeof timing.at !== 'string') {
        return { status: 400, error: 'delay.at must be a string' };
      }
      // Defer parse-check for placeholder strings — we don't have
      // trigger_data at save time. Literal strings get parse-checked now
      // so authors find typos before the first enrollment fires.
      if (!_hasPlaceholder(timing.at)) {
        try {
          const parsed = parseUserDateTime(timing.at);
          if (!parsed) {
            return { status: 400, error: `delay.at is empty after trim: "${timing.at}"` };
          }
        } catch (err) {
          return { status: 400, error: `delay.at: ${err.message}` };
        }
      }
    } else {
      // Relative mode
      const v = Number(timing.value);
      if (!Number.isFinite(v) || v <= 0) {
        return { status: 400, error: 'delay.value must be a positive number' };
      }
      const allowedUnits = ['seconds', 'minutes', 'hours', 'days'];
      if (!allowedUnits.includes(timing.unit)) {
        return {
          status: 400,
          error: `delay.unit must be one of: ${allowedUnits.join(', ')}`,
        };
      }
    }

    const rmErr = _validateRandomizeMinutes(timing.randomizeMinutes);
    if (rmErr) return rmErr;
  }

  // Other timing types: validate randomizeMinutes range if present (cheap
  // sanity check shared with delay) but otherwise stay permissive.
  if (timing.type !== 'delay' && timing.randomizeMinutes !== undefined) {
    const rmErr = _validateRandomizeMinutes(timing.randomizeMinutes);
    if (rmErr) return rmErr;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Step config validation — Slice 3.3
//
// Single source of truth for action_type + action_config validity at save
// time. Called from POST, PUT, and PATCH step routes. Returns null on success,
// or { status, error, message? } on failure — caller handles res.status(...).
//
// Validation depth differs by action_type:
//   - sms / email / task / internal_function: no new field-level validation
//     beyond action_type enum membership (preserves existing permissive
//     behavior — those routes have been open-config since day one).
//   - webhook: URL, method, credential_id FK, headers/body shape, timeout_ms
//   - start_workflow: workflow_id FK, init_data shape, tie_to_contact type,
//     contact_id_override type
// ─────────────────────────────────────────────────────────────

const ALLOWED_ACTION_TYPES  = ['sms', 'email', 'task', 'internal_function', 'webhook', 'start_workflow'];
const ALLOWED_HTTP_METHODS  = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function validateStepConfig(db, action_type, action_config) {
  if (!ALLOWED_ACTION_TYPES.includes(action_type)) {
    return { status: 400, error: `Invalid action_type: ${action_type}`, message: `Must be one of: ${ALLOWED_ACTION_TYPES.join(', ')}` };
  }
  if (action_config == null || typeof action_config !== 'object' || Array.isArray(action_config)) {
    return { status: 400, error: 'action_config must be a JSON object' };
  }

  if (action_type === 'webhook') {
    const { url, method, credential_id, headers, body, timeout_ms } = action_config;
    if (!url || typeof url !== 'string' || !url.trim()) {
      return { status: 400, error: 'webhook action_config.url is required (non-empty string)' };
    }
    // Accept `{{...}}` placeholders — resolver runs at execution time. For
    // URLs with no placeholders, parse-check literally.
    if (!/\{\{.*?\}\}/.test(url)) {
      try { new URL(url); }
      catch { return { status: 400, error: `webhook action_config.url is not a valid URL: ${url}` }; }
    }
    if (method !== undefined) {
      const m = String(method).toUpperCase();
      if (!ALLOWED_HTTP_METHODS.includes(m)) {
        return { status: 400, error: `webhook action_config.method must be one of ${ALLOWED_HTTP_METHODS.join(', ')}` };
      }
    }
    if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
      const n = Number(credential_id);
      if (!Number.isInteger(n) || n <= 0) {
        return { status: 400, error: 'webhook action_config.credential_id must be a positive integer' };
      }
      const [[row]] = await db.query(`SELECT id FROM credentials WHERE id = ?`, [n]);
      if (!row) {
        return { status: 400, error: `webhook action_config.credential_id ${n} does not exist in credentials table` };
      }
    }
    if (headers !== undefined && headers !== null) {
      if (typeof headers !== 'object' || Array.isArray(headers)) {
        return { status: 400, error: 'webhook action_config.headers must be a JSON object' };
      }
    }
    if (body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, error: 'webhook action_config.body must be a JSON object or null' };
      }
    }
    if (timeout_ms !== undefined && timeout_ms !== null) {
      const n = Number(timeout_ms);
      if (!Number.isInteger(n) || n <= 0) {
        return { status: 400, error: 'webhook action_config.timeout_ms must be a positive integer' };
      }
      if (n > 120000) {
        return { status: 400, error: 'webhook action_config.timeout_ms cannot exceed 120000 (120s)' };
      }
    }
    return null;
  }

  if (action_type === 'start_workflow') {
    const { workflow_id, init_data, tie_to_contact, contact_id_override } = action_config;
    if (workflow_id == null || workflow_id === '') {
      return { status: 400, error: 'start_workflow action_config.workflow_id is required' };
    }
    const n = Number(workflow_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { status: 400, error: 'start_workflow action_config.workflow_id must be a positive integer' };
    }
    const [[wf]] = await db.query(`SELECT id FROM workflows WHERE id = ?`, [n]);
    if (!wf) {
      return { status: 400, error: `start_workflow action_config.workflow_id ${n} does not exist in workflows table` };
    }
    if (init_data !== undefined && init_data !== null) {
      if (typeof init_data !== 'object' || Array.isArray(init_data)) {
        return { status: 400, error: 'start_workflow action_config.init_data must be a JSON object' };
      }
    }
    if (tie_to_contact !== undefined && typeof tie_to_contact !== 'boolean') {
      return { status: 400, error: 'start_workflow action_config.tie_to_contact must be boolean' };
    }
    if (contact_id_override !== undefined && contact_id_override !== null) {
      // Must be a string (for a {{placeholder}} or a literal) or a number.
      // Runtime validation (positive integer after placeholder resolution) is
      // enforced by executeStartWorkflowAction.
      if (typeof contact_id_override !== 'string' && typeof contact_id_override !== 'number') {
        return { status: 400, error: 'start_workflow action_config.contact_id_override must be a string, number, or null' };
      }
    }
    return null;
  }

  // sms / email / task / internal_function — no additional field validation.
  return null;
}

// ─────────────────────────────────────────────────────────────
// Template CRUD
// ─────────────────────────────────────────────────────────────

// GET /sequences/templates

// ─────────────────────────────────────────────────────────────
// resolveEditTargetVersion — which version do the step-editing routes write?
//
// ensureDraft — which version do the step-editing routes write? (S4)
//
// Lazy copy-on-first-write, mirroring routes/workflows.js exactly: the first
// edit after a publish copies the published version's step rows into a NEW
// draft version, snapshots the template metadata (including the versioned
// template_condition), and points sequence_templates.draft_version at it.
// Published versions become immutable by construction.
//
// MUST run inside db.withTransaction on a CONNECTION — S4 wrapped the last
// bare-pool callers (PUT/PATCH step; review D1). Parent-row FOR UPDATE first
// is both the concurrency arbiter and the lock-ordering invariant shared with
// publish/discard (withTransaction has no deadlock retry — deliberate).
//
// Draft numbering: MAX(version)+1 — retired (discarded) drafts occupy
// numbers. Returns null when the template does not exist.
//
// The metadata stub's template_condition copies the CURRENT VERSION row's
// value (that is the truth the engine reads post-S4), falling back to the
// live legacy column for v0 templates that have no version rows yet.
// ─────────────────────────────────────────────────────────────
async function ensureDraft(connection, templateId) {
  const [[t]] = await connection.query(
    `SELECT current_version, draft_version FROM sequence_templates WHERE id = ? FOR UPDATE`,
    [templateId]
  );
  if (!t) return null;
  if (t.draft_version != null) return t.draft_version;

  const [[mx]] = await connection.query(
    `SELECT COALESCE(MAX(version), 0) AS mx FROM sequence_template_versions WHERE template_id = ?`,
    [templateId]
  );
  const draftVersion = Math.max(Number(mx.mx), Number(t.current_version)) + 1;

  await connection.query(
    `INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
     SELECT template_id, ?, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy
       FROM sequence_steps
      WHERE template_id = ? AND version = ?`,
    [draftVersion, templateId, t.current_version]
  );

  await connection.query(
    `INSERT INTO sequence_template_versions (template_id, version, name, type, template_condition, description, test_input)
     SELECT tt.id, ?, tt.name, tt.type, COALESCE(cv.template_condition, tt.\`condition\`), tt.description, tt.test_input
       FROM sequence_templates tt
       LEFT JOIN sequence_template_versions cv
              ON cv.template_id = tt.id AND cv.version = tt.current_version
      WHERE tt.id = ?`,
    [draftVersion, templateId]
  );

  await connection.query(
    `UPDATE sequence_templates SET draft_version = ?, updated_at = NOW() WHERE id = ?`,
    [draftVersion, templateId]
  );

  return draftVersion;
}

router.get('/sequences/templates', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { type, active } = req.query;

  try {
    let query  = `SELECT t.*,
                    (SELECT COUNT(*) FROM sequence_steps WHERE template_id = t.id AND version = COALESCE(t.draft_version, t.current_version)) AS step_count,
                    vv.template_condition AS _vcond, vv.version AS _vv
                  FROM sequence_templates t
                  LEFT JOIN sequence_template_versions vv
                         ON vv.template_id = t.id
                        AND vv.version = COALESCE(t.draft_version, t.current_version)
                  WHERE 1=1`;
    const params = [];

    if (type)   { query += ` AND t.type = ?`;   params.push(type); }
    if (active !== undefined) { query += ` AND t.active = ?`; params.push(active === 'true' ? 1 : 0); }

    query += ` ORDER BY t.type, t.name`;

    const [rows] = await db.query(query, params);

    // Versioned-condition overlay (S4.1): post-S4 nothing writes the legacy
    // t.`condition` column, so the list must serve the editing version's
    // template_condition or every loadSequences() clobbers the UI with the
    // frozen pre-versioning value (stale edit modal, hidden drafts). Explicit
    // post-processing — the overlay only applies when a version row exists
    // (_vv), so v0 templates keep their create-time live-column condition.
    for (const r of rows) {
      if (r._vv != null) r.condition = r._vcond;
      delete r._vcond;
      delete r._vv;
    }
    res.json({ success: true, templates: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list templates', message: err.message });
  }
});

// GET /sequences/templates/:id
router.get('/sequences/templates/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);

  try {
    const [[template]] = await db.query(
      `SELECT * FROM sequence_templates WHERE id = ?`, [id]
    );
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // Editor view (S4): the draft when one exists, else the published version.
    const editingVersion = template.draft_version ?? template.current_version;
    const [steps] = await db.query(
      `SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC`,
      [id, editingVersion]
    );

    // Versioned-condition overlay (S4): the editable condition lives on the
    // version row (template_condition), not the legacy live column. Fall back
    // to the live column only for v0 templates with no version rows yet.
    const [[condRow]] = await db.query(
      `SELECT template_condition FROM sequence_template_versions WHERE template_id = ? AND version = ?`,
      [id, editingVersion]
    );
    if (condRow) template.condition = condRow.template_condition;

    // (The pre-versioning reorder-safety warning and its active_enrollments
    // count were retired in S4/S6 — reorders land on the DRAFT and every
    // enrollment is pinned, so the premise inverted. The publish modal's
    // in-flight panel, fed by /draft-diff, is the live-enrollment surface.)

    // Parse JSON columns for readability
    steps.forEach(s => {
      ['timing','action_config','condition','fire_guard','error_policy'].forEach(col => {
        if (typeof s[col] === 'string') try { s[col] = JSON.parse(s[col]); } catch {}
      });
    });

    if (typeof template.condition === 'string') {
      try { template.condition = JSON.parse(template.condition); } catch {}
    }

    // Slice 2.1 — parse test_input JSON for response (same pattern as condition).
    if (typeof template.test_input === 'string') {
      try { template.test_input = JSON.parse(template.test_input); } catch {}
    }

    res.json({
      success: true, template, steps,
      // Versioning (S4): which version the steps (and condition) above came
      // from, and whether it is an unpublished draft.
      editing_version: editingVersion,
      has_draft: template.draft_version != null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch template', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Versioning endpoints (S4) — sequence draft lifecycle.
// Mirrors routes/workflows.js (see the comments there for the load-bearing
// reasoning: lock ordering, fail-closed migration, retire-in-place) with one
// deliberate asymmetry: the stranded query here excludes only
// current_version, NOT the draft — no enrollment can ever pin a draft
// (_enrollWithTemplate reads current_version only and throws below 1),
// whereas workflow draft test-runs can and do (?use_draft=1).
// Sequence-specific deltas: the migrate path is a pure enrollment REPOINT —
// queued jobs are never rewritten, because executeStep resolves the step by
// identity (template_id, pinned version, step_number) at fire time (S4.1) —
// and publish validation re-runs the editor's own validateTiming /
// validateStepConfig across the whole draft.
// ─────────────────────────────────────────────────────────────

// GET /sequences/templates/:id/versions
router.get('/sequences/templates/:id/versions', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const [[t]] = await db.query(
      `SELECT current_version, draft_version FROM sequence_templates WHERE id = ?`, [templateId]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const [versions] = await db.query(
      `SELECT v.version, v.name, v.type, v.description, v.published_at, v.published_by,
              v.retired_at, v.created_at,
              (SELECT COUNT(*) FROM sequence_steps s WHERE s.template_id = v.template_id AND s.version = v.version) AS step_count
         FROM sequence_template_versions v
        WHERE v.template_id = ?
        ORDER BY v.version DESC`,
      [templateId]
    );
    res.json({
      success: true,
      current_version: t.current_version,
      draft_version: t.draft_version,
      versions: versions.map(v => ({ ...v, is_current: v.version === t.current_version, is_draft: v.version === t.draft_version })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch versions', message: err.message });
  }
});

// GET /sequences/templates/:id/draft-diff
router.get('/sequences/templates/:id/draft-diff', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const [[t]] = await db.query(
      `SELECT current_version, draft_version FROM sequence_templates WHERE id = ?`, [templateId]
    );
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (t.draft_version == null) {
      return res.json({ success: true, has_draft: false, current_version: t.current_version });
    }

    const [currentSteps] = await db.query(
      `SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC`,
      [templateId, t.current_version]
    );
    const [draftSteps] = await db.query(
      `SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC`,
      [templateId, t.draft_version]
    );
    const [condRows] = await db.query(
      `SELECT version, template_condition FROM sequence_template_versions WHERE template_id = ? AND version IN (?, ?)`,
      [templateId, t.current_version, t.draft_version]
    );
    const condOf = (v) => condRows.find(r => r.version === v)?.template_condition ?? null;

    const diff = diffSequenceSteps(currentSteps, draftSteps, {
      currentCondition: condOf(t.current_version),
      draftCondition: condOf(t.draft_version),
    });
    const validation = await _validateSequenceDraft(db, draftSteps);

    const [inFlight] = await db.query(
      `SELECT id, status, current_step, contact_id, created_at
         FROM sequence_enrollments
        WHERE template_id = ? AND template_version = ? AND status = 'active'
        ORDER BY id DESC`,
      [templateId, t.current_version]
    );
    const [stranded] = await db.query(
      `SELECT template_version, COUNT(*) AS n
         FROM sequence_enrollments
        WHERE template_id = ? AND template_version <> ? AND status = 'active'
        GROUP BY template_version ORDER BY template_version DESC`,
      [templateId, t.current_version]
    );

    res.json({
      success: true,
      has_draft: true,
      current_version: t.current_version,
      draft_version: t.draft_version,
      classification: diff.classification,
      changes: diff.changes,
      structural_reasons: diff.structural_reasons,
      validation,
      in_flight: { count: inFlight.length, enrollments: inFlight },
      stranded_versions: stranded,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to diff draft', message: err.message });
  }
});

// Publish validation for sequences (plan-v2 ruling O5): shape checks + the
// editor's own per-step validators re-run across the WHOLE draft — a draft
// assembled step-by-step can hold rows that were valid when saved but not
// together (and bulk-copied drafts never passed the editors at all).
async function _validateSequenceDraft(db, draftSteps) {
  const { errors } = validateSequenceDraftShape(draftSteps);
  const warnings = [];
  const info = [];
  if (errors.length) return { errors, warnings, info };

  for (const s of draftSteps) {
    const timing = typeof s.timing === 'string' ? JSON.parse(s.timing) : s.timing;
    const cfg = typeof s.action_config === 'string' ? JSON.parse(s.action_config) : s.action_config;
    const tv = validateTiming(timing);
    if (tv) errors.push(`step ${s.step_number}: ${tv.message || tv.error}`);
    const cv = await validateStepConfig(db, s.action_type, cfg);
    if (cv) errors.push(`step ${s.step_number}: ${cv.message || cv.error}`);
  }
  return { errors, warnings, info };
}

// POST /sequences/templates/:id/publish — body { migrate_in_flight? }
router.post('/sequences/templates/:id/publish', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  const migrateInFlight = req.body?.migrate_in_flight === true;
  const publishedBy = (req.auth?.username || req.auth?.key_label || 'api').slice(0, 100);

  try {
    const outcome = await db.withTransaction(async (connection) => {
      const [[t]] = await connection.query(
        `SELECT current_version, draft_version FROM sequence_templates WHERE id = ? FOR UPDATE`,
        [templateId]
      );
      if (!t) return { respond: { status: 404, body: { error: 'Template not found' } } };
      if (t.draft_version == null) {
        return { respond: { status: 409, body: { error: 'No draft to publish', message: 'There are no unpublished changes.' } } };
      }
      const draftV = t.draft_version;
      const oldV = t.current_version;

      const [draftSteps] = await connection.query(
        `SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC`,
        [templateId, draftV]
      );
      const validation = await _validateSequenceDraft(connection, draftSteps);
      if (validation.errors.length) {
        return { respond: { status: 400, body: { error: 'Draft failed publish validation', validation } } };
      }

      let migratedEnrollments = null;
      // First publish: migrate_in_flight is vacuous, not refused — same
      // reasoning as routes/workflows.js (review II.6); no enrollment can be
      // pinned below v1 (the funnel refuses v0).
      if (migrateInFlight && oldV > 0) {
        const [currentSteps] = await connection.query(
          `SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC`,
          [templateId, oldV]
        );
        const [condRows] = await connection.query(
          `SELECT version, template_condition FROM sequence_template_versions WHERE template_id = ? AND version IN (?, ?)`,
          [templateId, oldV, draftV]
        );
        const condOf = (v) => condRows.find(r => r.version === v)?.template_condition ?? null;
        const diff = diffSequenceSteps(currentSteps, draftSteps, {
          currentCondition: condOf(oldV), draftCondition: condOf(draftV),
        });
        if (diff.classification === 'structural') {
          return { respond: { status: 409, body: {
            error: 'Structural changes cannot migrate in-flight enrollments',
            message: 'Enrollment step pointers and pending jobs survive only content-only publishes.',
            structural_reasons: diff.structural_reasons,
          } } };
        }
      }

      // Stamp the version row published + refresh the LIVE-field snapshot
      // (name/type/description/test_input). template_condition is NOT
      // refreshed — it is the versioned field being published as-is.
      await connection.query(
        `UPDATE sequence_template_versions v
           JOIN sequence_templates t2 ON t2.id = v.template_id
            SET v.published_at = NOW(), v.published_by = ?,
                v.name = t2.name, v.type = t2.type, v.description = t2.description, v.test_input = t2.test_input
          WHERE v.template_id = ? AND v.version = ?`,
        [publishedBy, templateId, draftV]
      );
      await connection.query(
        `UPDATE sequence_templates SET current_version = ?, draft_version = NULL, updated_at = NOW() WHERE id = ?`,
        [draftV, templateId]
      );

      if (migrateInFlight && oldV > 0) {
        // Repointing enrollments is the WHOLE migration. Queued jobs are NOT
        // rewritten — executeStep resolves the step by (template, pinned
        // version, step_number) at fire time, and a content-only publish
        // preserves numbering by construction, so every queued step (pending
        // OR already claimed 'running') lands on the new version's row
        // automatically. The previous JSON_SET stepId remap only covered
        // status='pending' and left claimed jobs holding dead stepIds — the
        // silent-wedge race that identity-based resolution closes.
        const [enrRows] = await connection.query(
          `SELECT id FROM sequence_enrollments
            WHERE template_id = ? AND template_version = ? AND status = 'active' FOR UPDATE`,
          [templateId, oldV]
        );
        const ids = enrRows.map(r => r.id);
        migratedEnrollments = ids.length;
        if (ids.length) {
          await connection.query(
            `UPDATE sequence_enrollments SET template_version = ?, updated_at = NOW() WHERE id IN (?)`,
            [draftV, ids]
          );
        }
      } else if (migrateInFlight) {
        migratedEnrollments = 0; // first publish — vacuously migrated nothing
      }

      return { published_version: draftV, previous_version: oldV, migrated_count: migratedEnrollments, validation };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    console.log(`[SEQ PUBLISH] Template ${templateId}: v${outcome.previous_version} → v${outcome.published_version}` +
      (outcome.migrated_count != null ? ` (migrated ${outcome.migrated_count} enrollments)` : ''));
    res.json({ success: true, ...outcome });
  } catch (err) {
    console.error('[SEQ PUBLISH] Failed:', err);
    res.status(500).json({ error: 'Failed to publish', message: err.message });
  }
});

// POST /sequences/templates/:id/discard-draft — retire in place (ruling O2)
router.post('/sequences/templates/:id/discard-draft', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const outcome = await db.withTransaction(async (connection) => {
      const [[t]] = await connection.query(
        `SELECT current_version, draft_version FROM sequence_templates WHERE id = ? FOR UPDATE`,
        [templateId]
      );
      if (!t) return { respond: { status: 404, body: { error: 'Template not found' } } };
      if (t.draft_version == null) return { respond: { status: 409, body: { error: 'No draft to discard' } } };
      await connection.query(
        `UPDATE sequence_template_versions SET retired_at = NOW() WHERE template_id = ? AND version = ?`,
        [templateId, t.draft_version]
      );
      await connection.query(
        `UPDATE sequence_templates SET draft_version = NULL, updated_at = NOW() WHERE id = ?`,
        [templateId]
      );
      return { retired_version: t.draft_version, current_version: t.current_version };
    });
    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    console.log(`[SEQ DISCARD DRAFT] Template ${templateId}: retired v${outcome.retired_version}`);
    res.json({ success: true, ...outcome });
  } catch (err) {
    console.error('[SEQ DISCARD DRAFT] Failed:', err);
    res.status(500).json({ error: 'Failed to discard draft', message: err.message });
  }
});

// POST /sequences/templates
//
// Slice B: `type` is optional. Null / empty / whitespace-only all become NULL
// in the DB — these "ID-only" templates cannot be cascade-matched and are
// reachable only via template_id on POST /sequences/enroll.
//
// Slice 2.1: `test_input` is authorial documentation of the trigger_data
// shape this sequence expects. Nullable. Plain JSON object only — arrays
// and primitives rejected with 400. Not validated at runtime.
//
// Slice E Phase 2: `filters` JSON replaces appt_type_filter / appt_with_filter.
// Keys must be a subset of the type's priority_fields (validated against
// sequence_template_types). Filters cannot be set on type-less templates.
router.post('/sequences/templates', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, type, filters, condition, description, active = true, test_input } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  // Slice 2.1 — test_input shape validation.
  {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  // Slice E Phase 2 — filters shape validation.
  {
    const v = validateFiltersShape(filters);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  const typeVal = normalizeType(type);

  // Slice E Phase 2 — semantic filter validation against priority_fields.
  // Skipped when type is NULL (ID-only templates) — but only if filters is
  // also empty; non-empty filters on a type-less template is an error
  // surfaced by validateTemplateFilters itself.
  {
    const v = await validateTemplateFilters(db, typeVal, filters);
    if (!v.valid) return res.status(400).json({ error: v.error });
  }

  try {
    // Versioning (S4, review D4a): new templates are born UNPUBLISHED —
    // current_version = 0. Cascade matching filters them out and the enroll
    // funnel refuses them loudly until the first publish. The `condition`
    // still lands on the live legacy column here; the first draft fork copies
    // it into the versioned template_condition (ensureDraft's COALESCE
    // fallback covers exactly this v0 state). Single statement — the D1
    // transaction concern applied to the create-plus-seed shape this route
    // had in the S2 window, not to this one.
    const [result] = await db.query(
      `INSERT INTO sequence_templates (name, type, filters, \`condition\`, description, active, test_input, current_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [name.trim(), typeVal,
       toJson(filters),
       condition ? JSON.stringify(condition) : null,
       description || null, active ? 1 : 0,
       toJson(test_input)]
    );

    res.status(201).json({ success: true, templateId: result.insertId, name: name.trim(), type: typeVal });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template', message: err.message });
  }
});

// PUT /sequences/templates/:id
//
// Slice B: passing `type: null` OR `type: ""` OR `type: "   "` explicitly sets
// the column to NULL (convert-to-ID-only). Omitting `type` from the body skips
// the column entirely (unchanged partial-update semantics).
//
// Slice 2.1: `test_input` is accepted as a partial-update field. Pass `null`
// to explicitly clear it. Omit from body to leave unchanged.
//
// Slice E Phase 2: `filters` is a partial-update field. Pass `null` to clear.
// Validated against the type currently being saved (or the existing row's
// type if `type` isn't in the body).
router.put('/sequences/templates/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { name, type, filters, condition, description, active, test_input } = req.body;

  // Slice 2.1 — test_input shape validation (only if present in body).
  if (test_input !== undefined) {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  // Slice E Phase 2 — filters shape validation (only if present in body).
  if (filters !== undefined) {
    const v = validateFiltersShape(filters);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  // Slice E Phase 2 — semantic filter validation. We need the resulting
  // type after this PUT to validate against the right priority_fields.
  // If `type` isn't in the body, look up the existing row.
  if (filters !== undefined) {
    let typeForValidation;
    if (type !== undefined) {
      typeForValidation = normalizeType(type);
    } else {
      const [[existing]] = await db.query(
        `SELECT type FROM sequence_templates WHERE id = ?`,
        [id]
      );
      if (!existing) return res.status(404).json({ error: 'Template not found' });
      typeForValidation = existing.type;
    }
    const v = await validateTemplateFilters(db, typeForValidation, filters);
    if (!v.valid) return res.status(400).json({ error: v.error });
  }

  // Versioned-field split (S4, plan-v2 ruling O3): `condition` is the ONE
  // versioned template field — it gates step execution per-run, so a
  // condition edit goes to the DRAFT and takes effect at publish, exactly
  // like a step edit. name/type/filters/active/description/test_input stay
  // live: they steer enroll-time matching and display, where "latest wins"
  // is the correct semantic and versioning them would only feign a gate the
  // publish flow doesn't actually control.
  const updates = [];
  const params  = [];

  if (name        !== undefined) { updates.push('name = ?');              params.push(name?.trim()); }
  if (type        !== undefined) { updates.push('type = ?');              params.push(normalizeType(type)); }
  if (filters     !== undefined) { updates.push('filters = ?');           params.push(toJson(filters)); }
  if (description !== undefined) { updates.push('description = ?');       params.push(description); }
  if (active      !== undefined) { updates.push('active = ?');            params.push(active ? 1 : 0); }
  if (test_input  !== undefined) { updates.push('test_input = ?');        params.push(toJson(test_input)); }

  if (!updates.length && condition === undefined) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const outcome = await db.withTransaction(async (connection) => {
      if (condition !== undefined) {
        // No-op guard (final review F4): the Edit modal sends `condition` on
        // EVERY save, so without this, renaming a template (or toggling
        // active, or fixing a description typo) forked a draft of
        // byte-identical steps — and the version strip then told the user to
        // publish a change that was already live. Fork only when the
        // condition actually changed... OR when a draft already exists: an
        // existing draft must still receive the write even when the value is
        // unchanged, or a later publish would ship the draft's OLD condition
        // instead of what the user last saved.
        const [[cur]] = await connection.query(
          `SELECT t.draft_version, COALESCE(v.template_condition, t.\`condition\`) AS eff
             FROM sequence_templates t
             LEFT JOIN sequence_template_versions v
                    ON v.template_id = t.id AND v.version = t.current_version
            WHERE t.id = ?`,
          [id]
        );
        if (!cur) return { respond: { status: 404, body: { error: 'Template not found' } } };
        const incoming = condition ? JSON.stringify(condition) : null;
        const unchanged = canonical(parseMaybeJson(cur.eff)) === canonical(parseMaybeJson(incoming));
        if (!unchanged || cur.draft_version != null) {
          // Draft fork (parent FOR UPDATE inside — lock ordering), then write
          // the versioned condition onto the draft row.
          const draftV = await ensureDraft(connection, id);
          if (draftV == null) return { respond: { status: 404, body: { error: 'Template not found' } } };
          await connection.query(
            `UPDATE sequence_template_versions SET template_condition = ? WHERE template_id = ? AND version = ?`,
            [incoming, id, draftV]
          );
        }
      }
      if (updates.length) {
        const [r] = await connection.query(
          `UPDATE sequence_templates SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
          [...params, id]
        );
        if (r.affectedRows === 0 && condition === undefined) {
          return { respond: { status: 404, body: { error: 'Template not found' } } };
        }
      }
      return {};
    });
    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    res.json({ success: true, templateId: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template', message: err.message });
  }
});

// DELETE /sequences/templates/:id
router.delete('/sequences/templates/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);

  try {
    const [[t]] = await db.query(`SELECT id FROM sequence_templates WHERE id = ?`, [id]);
    if (!t) return res.status(404).json({ error: 'Template not found' });

    // Steps cascade via FK. Enrollments are restricted — can't delete template with active enrollments.
    const [[active]] = await db.query(
      `SELECT COUNT(*) as n FROM sequence_enrollments WHERE template_id = ? AND status = 'active'`, [id]
    );
    if (active.n > 0) {
      return res.status(409).json({ error: `Cannot delete template with ${active.n} active enrollment(s)` });
    }

    await db.query(`DELETE FROM sequence_templates WHERE id = ?`, [id]);
    res.json({ success: true, message: `Template ${id} deleted` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template', message: err.message });
  }
});

// POST /sequences/templates/:id/duplicate
// Duplicate a sequence template + ALL its steps.
// The new template is created with active=0 by design — starts inactive so it
// doesn't compete in cascade matching until the author explicitly activates it.
// Body (optional): { "name"?: string }  → defaults to "Copy of <original name>"
router.post('/sequences/templates/:id/duplicate', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name: customName } = req.body || {};

  const originalId = parseInt(id, 10);
  if (isNaN(originalId) || originalId <= 0) {
    return res.status(400).json({ error: 'Invalid template ID' });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

      // Fetch original template row
      //
      // Slice 2.1: also SELECT test_input so the duplicate carries over the
      // authorial trigger_data shape doc.
      // Slice E Phase 2: SELECT filters JSON in place of the dropped
      // appt_type_filter / appt_with_filter columns.
      const [tplRows] = await connection.query(
        `SELECT t.name, t.type, t.filters, t.description, t.test_input,
                t.captured_input, t.captured_at, t.current_version, t.draft_version,
                COALESCE(cv.template_condition, t.\`condition\`) AS \`condition\`
         FROM sequence_templates t
         LEFT JOIN sequence_template_versions cv
                ON cv.template_id = t.id
               AND cv.version = COALESCE(NULLIF(t.current_version, 0), t.draft_version)
         WHERE t.id = ?`,
        [originalId]
      );
      if (tplRows.length === 0) {
        return { notFound: true };
      }

      const original = tplRows[0];
      const newName  = customName?.trim() || `Copy of ${original.name}`;

      // Insert new template — active=0 (starts inactive, intentional).
      // JSON columns (`filters`, `condition`, `test_input`) round-trip through
      // toJson — handles either string or parsed-object return from SELECT.
      // `type` is copied verbatim — if original is NULL (ID-only), the duplicate
      // is NULL (ID-only) too.
      // Capture slice: captured_input/captured_at copy over (hooks-clone
      // parity — the sample powers testing against the duplicate) but
      // capture_mode is NOT copied — live armed state never duplicates
      // (column default 'off' applies).
      // Versioning (S4): the duplicate lands UNPUBLISHED (current_version 0,
      // content as draft v1); source content is the source's PUBLISHED
      // version, falling back to its draft when never published — including
      // the versioned condition (the COALESCE join above).
      const sourceVersion = original.current_version || original.draft_version || 0;

      const [newTplResult] = await connection.query(
        `INSERT INTO sequence_templates
          (name, type, filters, \`condition\`, description, active, test_input,
           captured_input, captured_at, current_version, draft_version)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 1)`,
        [
          newName,
          original.type,
          toJson(original.filters),
          toJson(original.condition),
          original.description,
          toJson(original.test_input),
          toJson(original.captured_input),
          original.captured_at ?? null
        ]
      );
      const newTemplateId = newTplResult.insertId;

      // Fetch + duplicate all steps. JSON columns pass through raw — same
      // pattern as POST /workflows/:id/duplicate.
      const [steps] = await connection.query(
        `SELECT step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy
         FROM sequence_steps
         WHERE template_id = ? AND version = ?
         ORDER BY step_number ASC`,
        [originalId, sourceVersion]
      );

      if (steps.length > 0) {
        const stepValues = steps.map(s => [
          newTemplateId,
          1,
          s.step_number,
          s.action_type,
          toJson(s.action_config),
          toJson(s.timing),
          toJson(s.condition),
          toJson(s.fire_guard),
          toJson(s.error_policy)
        ]);

        await connection.query(
          `INSERT INTO sequence_steps
            (template_id, version, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
           VALUES ?`,
          [stepValues]
        );
      }

      // Draft metadata stub for the duplicate's v1 — published_at NULL until
      // the author publishes.
      await connection.query(
        `INSERT INTO sequence_template_versions
          (template_id, version, name, type, template_condition, description, test_input)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
        [newTemplateId, newName, original.type, toJson(original.condition), original.description, toJson(original.test_input)]
      );

      return { notFound: false, newTemplateId, newName, stepCount: steps.length };
    });

    if (outcome.notFound) {
      return res.status(404).json({ error: 'Template not found' });
    }

    console.log(`[DUPLICATE SEQUENCE] Template ${originalId} → ${outcome.newTemplateId} (${outcome.stepCount} steps)`);

    res.status(201).json({
      success: true,
      templateId: outcome.newTemplateId,
      name: outcome.newName
    });
  } catch (err) {
    console.error('[DUPLICATE SEQUENCE] Failed:', err);
    res.status(500).json({ error: 'Failed to duplicate template', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Step CRUD
// ─────────────────────────────────────────────────────────────

// POST /sequences/templates/:id/steps
router.post('/sequences/templates/:id/steps', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const { step_number, action_type, action_config, timing, condition, fire_guard, error_policy } = req.body;

  if (!action_type)  return res.status(400).json({ error: 'action_type is required' });
  if (!action_config) return res.status(400).json({ error: 'action_config is required' });
  if (!timing)        return res.status(400).json({ error: 'timing is required' });

  // Timing-extensions slice — timing.type enum + delay-mode validation
  {
    const v = validateTiming(timing);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Slice 3.3 — action_type enum + per-type config validation
  {
    const v = await validateStepConfig(db, action_type, action_config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

      // Existence check + edit-target version in one (S4: becomes ensureDraft).
      const editVersion = await ensureDraft(connection, templateId);
      if (editVersion == null) { return { notFound: true }; }

      let targetStep = step_number;
      if (!targetStep) {
        const [[maxRow]] = await connection.query(
          `SELECT MAX(step_number) as max FROM sequence_steps WHERE template_id = ? AND version = ?`, [templateId, editVersion]
        );
        targetStep = (maxRow.max || 0) + 1;
      } else {
        // Two-pass shift up
        await connection.query(
          `UPDATE sequence_steps SET step_number = step_number + 10000 WHERE template_id = ? AND version = ? AND step_number >= ?`,
          [templateId, editVersion, targetStep]
        );
        await connection.query(
          `UPDATE sequence_steps SET step_number = step_number - 10000 + 1 WHERE template_id = ? AND version = ? AND step_number >= ?`,
          [templateId, editVersion, targetStep + 10000]
        );
      }

      const [result] = await connection.query(
        `INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [templateId, editVersion, targetStep, action_type,
         JSON.stringify(action_config), JSON.stringify(timing),
         condition   ? JSON.stringify(condition)   : null,
         fire_guard  ? JSON.stringify(fire_guard)  : null,
         error_policy? JSON.stringify(error_policy): null]
      );
      return { notFound: false, stepId: result.insertId, stepNumber: targetStep };
    });

    if (outcome.notFound) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.status(201).json({ success: true, stepId: outcome.stepId, stepNumber: outcome.stepNumber });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add step', message: err.message });
  }
});

// PUT /sequences/templates/:id/steps/:stepNumber — full replace
router.put('/sequences/templates/:id/steps/:stepNumber', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const stepNum    = parseInt(req.params.stepNumber);
  const { action_type, action_config, timing, condition, fire_guard, error_policy } = req.body;

  if (!action_type || !action_config || !timing) {
    return res.status(400).json({ error: 'action_type, action_config, and timing are required' });
  }

  // Timing-extensions slice — timing.type enum + delay-mode validation
  {
    const v = validateTiming(timing);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Slice 3.3 — action_type enum + per-type config validation
  {
    const v = await validateStepConfig(db, action_type, action_config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    // Transaction (review D1, closed in S4): ensureDraft's FOR UPDATE only
    // serializes on a connection inside a transaction — on the bare pool it
    // was a no-op. Validators above stay OUTSIDE the tx body: withTransaction
    // retries the whole callback once on transient errors.
    const outcome = await db.withTransaction(async (connection) => {
      const editVersion = await ensureDraft(connection, templateId);
      if (editVersion == null) return { respond: { status: 404, body: { error: 'Template not found' } } };

      const [[step]] = await connection.query(
        `SELECT id FROM sequence_steps WHERE template_id = ? AND version = ? AND step_number = ?`,
        [templateId, editVersion, stepNum]
      );
      if (!step) return { respond: { status: 404, body: { error: 'Step not found' } } };

      await connection.query(
        `UPDATE sequence_steps SET action_type=?, action_config=?, timing=?, \`condition\`=?, fire_guard=?, error_policy=?, updated_at=NOW()
         WHERE template_id=? AND version=? AND step_number=?`,
        [action_type, JSON.stringify(action_config), JSON.stringify(timing),
         condition    ? JSON.stringify(condition)   : null,
         fire_guard   ? JSON.stringify(fire_guard)  : null,
         error_policy ? JSON.stringify(error_policy): null,
         templateId, editVersion, stepNum]
      );
      return {};
    });
    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    res.json({ success: true, templateId, stepNumber: stepNum });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update step', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE-ORDER FIX (2026-08-18): this reorder handler MUST be registered
// BEFORE the PATCH ':stepNumber' route below. Express matches layers in
// registration order, and ':stepNumber' happily captures the literal path
// segment 'reorder' — which is exactly what happened from the day this
// route shipped: it was registered at the bottom of the file, every
// PATCH .../steps/reorder landed in the :stepNumber handler, matched no
// updatable field, and 400ed with "Nothing to update". Sequence step
// reorder was therefore dead in production until this move.
// tests/sequences.routeOrder.test.js pins the ordering.
// (Same class of bug as the /d/:token/respond ordering fix.)
// ─────────────────────────────────────────────────────────────
// PATCH /sequences/templates/:id/steps/reorder — move a step, or apply a full order
//
// Two request shapes:
//   { fromStep, toStep }  MOVE the step at `fromStep` to position `toStep`;
//                         every step in between shifts one slot to close the
//                         gap. THIS USED TO BE A TWO-WAY SWAP. For adjacent
//                         steps a swap and a move are identical, which is all
//                         the editor ever sent — but a swap is wrong for any
//                         longer move ("move to #7"), because it teleports the
//                         displaced step across everything in between instead
//                         of shifting them. Now matches the semantics of
//                         PATCH /workflows/:id/steps/reorder.
//   { order: [3,1,2] }    Old step numbers in their new order: order[i] lands
//                         at position i+1. Numbers absent from the array keep
//                         their current position.
//
// Both paths park rows in a +10000 temp range first. uk_template_step is
// UNIQUE(template_id, step_number), so a shift whose first row lands on a
// still-occupied slot collides; same convention as the insert-at path above.
router.patch('/sequences/templates/:id/steps/reorder', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const { fromStep, toStep, order } = req.body;

  if (!Number.isInteger(templateId) || templateId <= 0) {
    return res.status(400).json({ error: 'Invalid template ID' });
  }

  const hasMove = fromStep !== undefined && toStep !== undefined;
  if (!hasMove && !Array.isArray(order)) {
    return res.status(400).json({ error: 'Must provide either {fromStep, toStep} or {order: array}' });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

      // Existence check + edit-target version in one (S4: becomes ensureDraft).
      const editVersion = await ensureDraft(connection, templateId);
      if (editVersion == null) return { respond: { status: 404, body: { error: 'Template not found' } } };

      // ── Case 1: move fromStep → toStep ────────────────────────
      if (hasMove) {
        const from = parseInt(fromStep, 10);
        const to   = parseInt(toStep, 10);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
          return { respond: { status: 400, body: { error: 'Invalid fromStep or toStep' } } };
        }
        if (from === to) return { moved: null };

        // Vacate `from` FIRST — until it is empty the shift below would land
        // its first row on a still-occupied slot and hit uk_template_step.
        const [parked] = await connection.query(
          `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND version = ? AND step_number = ?`,
          [from + 10000, templateId, editVersion, from]
        );
        if (parked.affectedRows === 0) {
          return { respond: { status: 404, body: { error: `No step at position ${from}` } } };
        }

        if (from < to) {
          // Moving down: pull the in-between steps up. ASC so the lowest
          // moves first, into the slot `from` just vacated.
          await connection.query(
            `UPDATE sequence_steps SET step_number = step_number - 1
             WHERE template_id = ? AND version = ? AND step_number > ? AND step_number <= ?
             ORDER BY step_number ASC`,
            [templateId, editVersion, from, to]
          );
        } else {
          // Moving up: push the in-between steps down. DESC, same reason.
          await connection.query(
            `UPDATE sequence_steps SET step_number = step_number + 1
             WHERE template_id = ? AND version = ? AND step_number >= ? AND step_number < ?
             ORDER BY step_number DESC`,
            [templateId, editVersion, to, from]
          );
        }

        await connection.query(
          `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND version = ? AND step_number = ?`,
          [to, templateId, editVersion, from + 10000]
        );

        return { moved: { from, to } };
      }

      // ── Case 2: full order array ──────────────────────────────
      if (!order.length) return { respond: { status: 400, body: { error: 'order array is empty' } } };
      if (order.some(n => !Number.isInteger(n) || n < 1)) {
        return { respond: { status: 400, body: { error: 'Invalid step numbers in order array' } } };
      }
      if (new Set(order).size !== order.length) {
        return { respond: { status: 400, body: { error: 'order array contains duplicates' } } };
      }

      for (const n of order) {
        await connection.query(
          `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND version = ? AND step_number = ?`,
          [n + 10000, templateId, editVersion, n]
        );
      }
      for (let i = 0; i < order.length; i++) {
        await connection.query(
          `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND version = ? AND step_number = ?`,
          [i + 1, templateId, editVersion, order[i] + 10000]
        );
      }

      return { moved: { order } };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    res.json({ success: true, moved: outcome.moved });
  } catch (err) {
    console.error('[SEQ REORDER STEPS] Failed:', err);
    res.status(500).json({ error: 'Failed to reorder steps', message: err.message });
  }
});


// PATCH /sequences/templates/:id/steps/:stepNumber — partial update
router.patch('/sequences/templates/:id/steps/:stepNumber', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const stepNum    = parseInt(req.params.stepNumber);
  const { action_type, action_config, timing, condition, fire_guard, error_policy } = req.body;

  const updates = [];
  const params  = [];

  if (action_type   !== undefined) { updates.push('action_type = ?');   params.push(action_type); }
  if (action_config !== undefined) { updates.push('action_config = ?'); params.push(JSON.stringify(action_config)); }
  if (timing        !== undefined) { updates.push('timing = ?');        params.push(JSON.stringify(timing)); }
  if (condition     !== undefined) { updates.push('\`condition\` = ?');     params.push(condition ? JSON.stringify(condition) : null); }
  if (fire_guard    !== undefined) { updates.push('fire_guard = ?');    params.push(fire_guard ? JSON.stringify(fire_guard) : null); }
  if (error_policy  !== undefined) { updates.push('error_policy = ?'); params.push(error_policy ? JSON.stringify(error_policy) : null); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  // Validation reads the version the edit WILL land on — the draft if one
  // exists, else the published version (a fresh draft is a copy of it, so the
  // rows are identical). Deliberately NOT ensureDraft here: a request that
  // fails validation must not fork a draft as a side effect. The fork happens
  // inside the transaction below (review D1).
  const [[tpl]] = await db.query(
    `SELECT current_version, draft_version FROM sequence_templates WHERE id = ?`, [templateId]
  );
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const patchVersion = tpl.draft_version ?? tpl.current_version;

  // Timing-extensions slice — if `timing` is being updated, validate it.
  if (timing !== undefined) {
    const v = validateTiming(timing);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Slice 3.3 — validate any action_type/action_config change. If only one of
  // the pair was supplied, load the other from the existing row so we always
  // validate the resulting (type, config) combination, not a partial view.
  if (action_type !== undefined || action_config !== undefined) {
    let typeToCheck   = action_type;
    let configToCheck = action_config;

    if (typeToCheck === undefined || configToCheck === undefined) {
      const [[existing]] = await db.query(
        `SELECT action_type, action_config FROM sequence_steps WHERE template_id = ? AND version = ? AND step_number = ?`,
        [templateId, patchVersion, stepNum]
      );
      if (!existing) return res.status(404).json({ error: 'Step not found' });
      if (typeToCheck === undefined) typeToCheck = existing.action_type;
      if (configToCheck === undefined) {
        configToCheck = typeof existing.action_config === 'string'
          ? JSON.parse(existing.action_config)
          : existing.action_config;
      }
    }

    const v = await validateStepConfig(db, typeToCheck, configToCheck);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {
      const editVersion = await ensureDraft(connection, templateId);
      if (editVersion == null) return { respond: { status: 404, body: { error: 'Template not found' } } };
      const [r] = await connection.query(
        `UPDATE sequence_steps SET ${updates.join(', ')}, updated_at=NOW() WHERE template_id=? AND version=? AND step_number=?`,
        [...params, templateId, editVersion, stepNum]
      );
      if (r.affectedRows === 0) return { respond: { status: 404, body: { error: 'Step not found' } } };
      return {};
    });
    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    res.json({ success: true, templateId, stepNumber: stepNum });
  } catch (err) {
    res.status(500).json({ error: 'Failed to patch step', message: err.message });
  }
});

// DELETE /sequences/templates/:id/steps/:stepNumber
router.delete('/sequences/templates/:id/steps/:stepNumber', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const stepNum    = parseInt(req.params.stepNumber);

  try {
    const outcome = await db.withTransaction(async (connection) => {

      // Edit-target version (S4: becomes ensureDraft).
      const editVersion = await ensureDraft(connection, templateId);
      if (editVersion == null) { return { notFound: true }; }

      const [[step]] = await connection.query(
        `SELECT id FROM sequence_steps WHERE template_id = ? AND version = ? AND step_number = ?`,
        [templateId, editVersion, stepNum]
      );
      if (!step) { return { notFound: true }; }

      await connection.query(
        `DELETE FROM sequence_steps WHERE template_id = ? AND version = ? AND step_number = ?`,
        [templateId, editVersion, stepNum]
      );
      await connection.query(
        `UPDATE sequence_steps SET step_number = step_number - 1
         WHERE template_id = ? AND version = ? AND step_number > ? ORDER BY step_number ASC`,
        [templateId, editVersion, stepNum]
      );
      return { notFound: false };
    });

    if (outcome.notFound) {
      return res.status(404).json({ error: 'Step not found' });
    }
    res.json({ success: true, message: `Step ${stepNum} deleted and renumbered` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete step', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Enrollment operations
// ─────────────────────────────────────────────────────────────

// POST /sequences/enroll
//
// Two modes — pass exactly one of:
//   template_type — cascade match against sequence_template_types config;
//                   any cascade fields (e.g. appt_type, appt_with, case_type)
//                   should be inside `trigger_data`, NOT top-level.
//   template_id   — target a specific template directly (no cascade)
//
// Slice B: if `template_type` is present in the body but null / empty string /
// whitespace-only, we reject with 400 rather than falling through to a zero-
// match cascade query. Keeps behavior explicit and prevents an accidental
// "cascade-match against NULL-type templates" surface if client code sends a
// blanked-out value.
//
// Slice E Phase 2: top-level appt_type / appt_with body fields are no longer
// accepted — the cascade reads them from trigger_data. This is a backward-
// incompatible change; any external caller still sending them must move
// those fields inside trigger_data.
router.post('/sequences/enroll', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    contact_id,
    template_type,
    template_id,
    trigger_data = {},
  } = req.body;

  if (!contact_id) {
    return res.status(400).json({ error: 'contact_id is required' });
  }

  // Note: hasType now treats whitespace-only as "not a valid type" — tighter
  // than the Slice A check which only rejected the empty string.
  const hasType = template_type !== undefined && template_type !== null && String(template_type).trim() !== '';
  const hasId   = template_id   !== undefined && template_id   !== null && template_id   !== '';

  // If the caller explicitly sent a template_type key but it's not a valid
  // non-empty string, reject with a dedicated error rather than letting it
  // fall through to the "one of X or Y is required" branch. This catches
  // client bugs like `template_type: someVar` where someVar is null/''/"   ".
  if ('template_type' in req.body && !hasType) {
    return res.status(400).json({
      error: 'template_type must be non-empty when provided',
    });
  }

  if (hasType && hasId) {
    return res.status(400).json({
      error: 'Provide exactly one of template_type or template_id, not both',
    });
  }
  if (!hasType && !hasId) {
    return res.status(400).json({
      error: 'One of template_type or template_id is required',
    });
  }

  try {
    if (hasId) {
      const idInt = parseInt(template_id, 10);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        return res.status(400).json({ error: 'template_id must be a positive integer' });
      }
      // 404 on nonexistent template rather than 500 (matches the pattern in
      // GET /sequences/templates/:id/enrollments). Cheap single-row lookup.
      const [[tpl]] = await db.query(
        `SELECT id FROM sequence_templates WHERE id = ?`,
        [idInt]
      );
      if (!tpl) return res.status(404).json({ error: 'Template not found' });
      const result = await enrollContactByTemplateId(db, contact_id, idInt, trigger_data);
      return res.status(201).json({ success: true, ...result });
    }

    // By-type (cascade) mode — cascade keys come from trigger_data.
    const result = await enrollContact(db, contact_id, template_type, trigger_data);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to enroll contact', message: err.message });
  }
});

// POST /sequences/preview — Slice 8A
//
// Zero-side-effect dry run of a would-be enrollment. Returns, per step, the
// computed fire time, skip verdicts, and the fully resolved action_config (the
// exact message text the contact would receive). Performs ONLY reads — no
// dispatch, no scheduled_jobs / enrollments / step_log writes.
//
// Body — exactly ONE of:
//   { template_id, contact_id, trigger_data? }   hypothetical enrollment
//   { enrollment_id }                             seed from an existing enrollment
//                                                 (its status is irrelevant)
//
// trigger_data (hypothetical only) must be a plain object; defaults to {}.
// 404 for a missing template / enrollment; 400 for a missing contact so a
// preview never silently resolves blank placeholders.
//
// Response: { success: true, preview: <engine return> }
router.post('/sequences/preview', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { template_id, contact_id, enrollment_id, trigger_data } = req.body || {};

  const present       = v => v !== undefined && v !== null && v !== '';
  const hasEnrollment = present(enrollment_id);
  const hasTemplate   = present(template_id);
  const hasContact    = present(contact_id);

  // ── Exactly one shape ──
  if (hasEnrollment && (hasTemplate || hasContact)) {
    return res.status(400).json({
      error: 'Provide either { template_id, contact_id } or { enrollment_id }, not both',
    });
  }
  if (!hasEnrollment && !hasTemplate && !hasContact) {
    return res.status(400).json({
      error: 'Provide either { template_id, contact_id } or { enrollment_id }',
    });
  }
  if (!hasEnrollment && !(hasTemplate && hasContact)) {
    return res.status(400).json({
      error: 'template_id and contact_id are both required for a hypothetical preview',
    });
  }

  // trigger_data — only meaningful for the hypothetical shape; validate its
  // shape whenever present (array/primitive → 400), default {}.
  let triggerData = {};
  if (trigger_data !== undefined && trigger_data !== null) {
    if (typeof trigger_data !== 'object' || Array.isArray(trigger_data)) {
      return res.status(400).json({ error: 'trigger_data must be a JSON object' });
    }
    triggerData = trigger_data;
  }

  try {
    if (hasEnrollment) {
      const enrollmentIdInt = parseInt(enrollment_id, 10);
      if (!Number.isInteger(enrollmentIdInt) || enrollmentIdInt <= 0) {
        return res.status(400).json({ error: 'enrollment_id must be a positive integer' });
      }
      const [[enr]] = await db.query(
        `SELECT id FROM sequence_enrollments WHERE id = ?`,
        [enrollmentIdInt]
      );
      if (!enr) return res.status(404).json({ error: 'Enrollment not found' });

      const preview = await previewEnrollmentSteps(db, { enrollment_id: enrollmentIdInt });
      return res.json({ success: true, preview });
    }

    // Hypothetical shape.
    const templateIdInt = parseInt(template_id, 10);
    const contactIdInt  = parseInt(contact_id, 10);
    if (!Number.isInteger(templateIdInt) || templateIdInt <= 0) {
      return res.status(400).json({ error: 'template_id must be a positive integer' });
    }
    if (!Number.isInteger(contactIdInt) || contactIdInt <= 0) {
      return res.status(400).json({ error: 'contact_id must be a positive integer' });
    }

    const [[tpl]] = await db.query(
      `SELECT id FROM sequence_templates WHERE id = ?`,
      [templateIdInt]
    );
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const [[contact]] = await db.query(
      `SELECT contact_id FROM contacts WHERE contact_id = ?`,
      [contactIdInt]
    );
    if (!contact) {
      return res.status(400).json({ error: `contact_id ${contactIdInt} does not exist` });
    }

    const preview = await previewEnrollmentSteps(db, {
      template_id:  templateIdInt,
      contact_id:   contactIdInt,
      trigger_data: triggerData,
    });
    res.json({ success: true, preview });
  } catch (err) {
    res.status(500).json({ error: 'Failed to preview sequence', message: err.message });
  }
});

// POST /sequences/cancel
router.post('/sequences/cancel', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { contact_id, template_type, reason = 'manual' } = req.body;

  if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

  try {
    const result = await cancelSequences(db, contact_id, template_type || null, reason);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel sequences', message: err.message });
  }
});

// GET /sequences/templates/:id/enrollments
//
// Template-scoped paginated enrollments list. Parallel to GET /workflows/:id/executions.
// Query: ?limit (default 50, max 200), ?offset (default 0), ?status
// Response: { success, enrollments, total }
// Row shape: id, template_id, contact_id, status, current_step, total_steps,
//            enrolled_at, completed_at, updated_at, cancel_reason, contact_name.
// trigger_data is intentionally excluded from list rows (can be large);
// drill-down via GET /sequences/enrollments/:id fetches it.
router.get('/sequences/templates/:id/enrollments', jwtOrApiKey, async (req, res) => {
  const db = req.db;

  const templateId = parseInt(req.params.id, 10);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return res.status(400).json({ error: 'Invalid template ID' });
  }

  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const statusFilter = req.query.status || null;

  // Validate status against the actual enum so typos 400 instead of silently
  // returning an empty list (MySQL would match nothing).
  if (statusFilter && !['active', 'completed', 'cancelled'].includes(statusFilter)) {
    return res.status(400).json({
      error: 'Invalid status. Must be one of: active, completed, cancelled',
    });
  }

  try {
    // Confirm the template exists so the client gets 404 vs an empty list when
    // they mistype an id. Cheap single-row lookup.
    const [[tpl]] = await db.query(
      `SELECT id FROM sequence_templates WHERE id = ?`, [templateId]
    );
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    let query = `
      SELECT
        e.id,
        e.template_id,
        e.contact_id,
        e.status,
        e.current_step,
        e.total_steps,
        e.enrolled_at,
        e.completed_at,
        e.updated_at,
        e.cancel_reason,
        TRIM(CONCAT(COALESCE(c.contact_fname,''), ' ', COALESCE(c.contact_lname,''))) AS contact_name
      FROM sequence_enrollments e
      LEFT JOIN contacts c ON c.contact_id = e.contact_id
      WHERE e.template_id = ?
    `;
    const params = [templateId];

    if (statusFilter) { query += ` AND e.status = ?`; params.push(statusFilter); }

    query += ` ORDER BY e.enrolled_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    const countQuery = `
      SELECT COUNT(*) AS total FROM sequence_enrollments e
      WHERE e.template_id = ?${statusFilter ? ' AND e.status = ?' : ''}
    `;
    const countParams = [templateId];
    if (statusFilter) countParams.push(statusFilter);
    const [[{ total }]] = await db.query(countQuery, countParams);

    res.json({ success: true, enrollments: rows, total });
  } catch (err) {
    console.error('[GET TEMPLATE ENROLLMENTS] Failed:', err);
    res.status(500).json({ error: 'Failed to list enrollments', message: err.message });
  }
});

// GET /sequences/step-log — GLOBAL recent step-log rows (Slice 7,
// cross-automation Activity tab).
//
// Joins enrollment → template so each row carries template_name /
// template_type + contact_id. INNER JOINs are safe: enrollment_id and
// template_id are FK-backed, a step-log row can't exist without both.
//
// No route-order hazard in this file — there is no '/sequences/:param'
// wildcard route, so '/sequences/step-log' can't be shadowed.
//
// Query params (mirrors GET /api/hooks/executions):
//   status — optional. Single value or comma-separated list from the
//            sequence_step_log enum: sent | skipped | failed.
//            (Failure status for the Activity view: failed.)
//   since  — optional ISO datetime; filters executed_at >= since.
//   limit  — default 50, capped at 200.
//
// Returns { success: true, step_log: [...] }, newest first.
router.get('/sequences/step-log', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const where = ['1=1'];
    const params = [];

    if (req.query.status) {
      const statuses = String(req.query.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length) {
        where.push(`l.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }

    if (req.query.since) {
      const d = new Date(req.query.since);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid since datetime' });
      }
      // Server + DB run in UTC; format as UTC 'YYYY-MM-DD HH:MM:SS' so a
      // 'Z'-suffixed ISO string never trips MySQL's datetime parsing.
      where.push('l.executed_at >= ?');
      params.push(d.toISOString().slice(0, 19).replace('T', ' '));
    }

    const [rows] = await db.query(
      `SELECT l.id, l.enrollment_id, l.step_id, l.step_number, l.status,
              l.skip_reason, l.error_message, l.duration_ms,
              l.scheduled_at, l.executed_at,
              e.contact_id, e.template_id,
              t.name AS template_name, t.type AS template_type
       FROM sequence_step_log l
       JOIN sequence_enrollments e ON e.id = l.enrollment_id
       JOIN sequence_templates t ON t.id = e.template_id
       WHERE ${where.join(' AND ')}
       ORDER BY l.executed_at DESC, l.id DESC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({ success: true, step_log: rows });
  } catch (err) {
    console.error('[GET STEP LOG] Failed:', err);
    res.status(500).json({ error: 'Failed to list step log', message: err.message });
  }
});

// GET /sequences/enrollments
router.get('/sequences/enrollments', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { contact_id, template_type, status, page = 1, limit = 20 } = req.query;

  const offset    = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const limitInt  = Math.min(100, Math.max(1, parseInt(limit)));

  try {
    // Build WHERE conditions separately so the count query is clean
    const whereClauses = ['1=1'];
    const whereParams  = [];

    if (contact_id)    { whereClauses.push('e.contact_id = ?');  whereParams.push(contact_id); }
    if (template_type) { whereClauses.push('t.type = ?');         whereParams.push(template_type); }
    if (status)        { whereClauses.push('e.status = ?');       whereParams.push(status); }

    const whereStr = whereClauses.join(' AND ');

    const query = `
      SELECT e.*, t.name AS template_name, t.type AS template_type,
             c.contact_fname, c.contact_lname
      FROM sequence_enrollments e
      JOIN sequence_templates t ON t.id = e.template_id
      JOIN contacts c ON c.contact_id = e.contact_id
      WHERE ${whereStr}
      ORDER BY e.enrolled_at DESC LIMIT ? OFFSET ?`;
    const params = [...whereParams, limitInt, offset];

    const countQuery = `
      SELECT COUNT(*) as total
      FROM sequence_enrollments e
      JOIN sequence_templates t ON t.id = e.template_id
      WHERE ${whereStr}`;

    const [rows]        = await db.query(query, params);
    const [[{ total }]] = await db.query(countQuery, whereParams);

    res.json({
      success: true,
      enrollments: rows,
      pagination: { page: parseInt(page), limit: limitInt, total, totalPages: Math.ceil(total / limitInt) }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list enrollments', message: err.message });
  }
});

// GET /sequences/enrollments/:id
//
// Returns the enrollment, plus:
//   - `log`     — legacy sequence_step_log array (unchanged behavior; default on, ?log=false to skip)
//   - `history` — NEW, opt-in via ?history=true. Scheduled-jobs-derived step timeline:
//                 one row per scheduled_jobs entry for this enrollment, LEFT JOINed with
//                 sequence_step_log. Rows that never executed have null log fields.
//                 step_number is read from sj.data JSON (no dedicated column on scheduled_jobs).
router.get('/sequences/enrollments/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const includeLog     = req.query.log !== 'false';       // legacy param, default true
  const includeHistory = req.query.history === 'true';    // new param, opt-in (mirrors workflow)

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid enrollment ID' });
  }

  try {
    const [[enrollment]] = await db.query(
      `SELECT e.*, t.name AS template_name, t.type AS template_type
       FROM sequence_enrollments e
       JOIN sequence_templates t ON t.id = e.template_id
       WHERE e.id = ?`, [id]
    );
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    if (typeof enrollment.trigger_data === 'string') {
      try { enrollment.trigger_data = JSON.parse(enrollment.trigger_data); } catch {}
    }

    let log = null;
    if (includeLog) {
      const [logRows] = await db.query(
        `SELECT l.*, s.action_type
         FROM sequence_step_log l
         JOIN sequence_steps s ON s.id = l.step_id
         WHERE l.enrollment_id = ? ORDER BY l.step_number ASC, l.executed_at ASC`, [id]
      );
      log = logRows.map(r => {
        ['action_config_resolved','output_data'].forEach(col => {
          if (typeof r[col] === 'string') try { r[col] = JSON.parse(r[col]); } catch {}
        });
        return r;
      });
    }

    // ── Derived step history: scheduled_jobs LEFT JOIN sequence_step_log,
    //    UNIONed with log rows that have no job row at all. ──
    //
    // Pass 1 (jobs-driven): one row per scheduled_jobs entry for this
    // enrollment. Log fields are NULL for rows that never executed (pending,
    // or cancelled-before-fire). step_number is read from sj.data JSON —
    // scheduled_jobs has no dedicated column.
    //
    // Pass 2 (orphan log rows): steps that were logged but never got a
    // scheduled_jobs row. In practice this is exactly the
    // 'skipped'/'unschedulable' set — scheduleFromStep logs the skip and
    // advances WITHOUT calling scheduleStepJob, so an appt booked inside a
    // step's lead time leaves no job behind. Every other skip reason
    // (condition_failed / fire_guard_failed / step_condition_failed) is
    // logged inside executeStep, which only runs because a job fired, so
    // those already appear via pass 1.
    //
    // Without pass 2 the drill-down silently starts at the first placeable
    // step — e.g. an enrollment whose steps 1-2 were out of runway renders
    // as "step 3, 4" with no explanation, which reads like data loss rather
    // than intended behavior.
    //
    // Ordering is step_number ASC (nulls last) rather than scheduled_time —
    // orphan rows have no scheduled_time to sort on, and step order is the
    // natural reading order for this table. The two coincide in practice:
    // scheduleFromStep walks steps in order against a non-decreasing floor.
    let history;
    if (includeHistory) {
      const [histRows] = await db.query(
        `SELECT
           sj.id                      AS job_id,
           sj.scheduled_time,
           sj.status                  AS job_status,
           sj.attempts,
           sj.max_attempts,
           sj.updated_at              AS job_updated_at,
           sj.data                    AS job_data,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(sj.data, '$.stepNumber')) AS UNSIGNED) AS step_number,
           l.id                       AS log_id,
           l.status                   AS log_status,
           l.skip_reason,
           l.error_message,
           l.duration_ms,
           l.executed_at,
           l.action_config_resolved,
           l.output_data,
           l.step_id                  AS log_step_id,
           s.action_type
         FROM scheduled_jobs sj
         LEFT JOIN sequence_step_log l
           ON l.enrollment_id = sj.sequence_enrollment_id
          AND l.step_number   = CAST(JSON_UNQUOTE(JSON_EXTRACT(sj.data, '$.stepNumber')) AS UNSIGNED)
         LEFT JOIN sequence_steps s ON s.id = l.step_id
         WHERE sj.type = 'sequence_step' AND sj.sequence_enrollment_id = ?
         ORDER BY sj.scheduled_time ASC, sj.id ASC`,
        [id]
      );

      // Pass 2 — log rows with no corresponding scheduled_jobs row.
      // NULL-safe compare (<=>) so a log row with a NULL step_number (the
      // 'enrollment_not_active' path) is treated as unmatched and surfaces
      // here rather than vanishing.
      const [orphanRows] = await db.query(
        `SELECT
           NULL                       AS job_id,
           NULL                       AS scheduled_time,
           NULL                       AS job_status,
           NULL                       AS attempts,
           NULL                       AS max_attempts,
           NULL                       AS job_updated_at,
           NULL                       AS job_data,
           l.step_number,
           l.id                       AS log_id,
           l.status                   AS log_status,
           l.skip_reason,
           l.error_message,
           l.duration_ms,
           l.executed_at,
           l.action_config_resolved,
           l.output_data,
           l.step_id                  AS log_step_id,
           s.action_type
         FROM sequence_step_log l
         LEFT JOIN sequence_steps s ON s.id = l.step_id
         WHERE l.enrollment_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_jobs sj
              WHERE sj.type = 'sequence_step'
                AND sj.sequence_enrollment_id = l.enrollment_id
                AND CAST(JSON_UNQUOTE(JSON_EXTRACT(sj.data, '$.stepNumber')) AS UNSIGNED)
                    <=> l.step_number
           )`,
        [id]
      );

      const stepOrd = v => (v == null ? Number.POSITIVE_INFINITY : Number(v));
      const timeOrd = v => (v ? new Date(v).getTime() : 0);

      history = [...histRows, ...orphanRows]
        .map(r => {
          // Defensively parse JSON columns (mysql2 may return object or string).
          ['job_data','action_config_resolved','output_data'].forEach(col => {
            if (typeof r[col] === 'string') {
              try { r[col] = JSON.parse(r[col]); } catch {}
            }
          });
          return r;
        })
        .sort((a, b) => {
          const d = stepOrd(a.step_number) - stepOrd(b.step_number);
          if (d) return d;
          const t = timeOrd(a.scheduled_time) - timeOrd(b.scheduled_time);
          if (t) return t;
          return Number(a.job_id || 0) - Number(b.job_id || 0);
        });
    }

    res.json({
      success: true,
      enrollment,
      log,
      ...(includeHistory && { history }),
    });
  } catch (err) {
    console.error('[GET ENROLLMENT] Failed:', err);
    res.status(500).json({ error: 'Failed to fetch enrollment', message: err.message });
  }
});

// POST /sequences/enrollments/:id/cancel
router.post('/sequences/enrollments/:id/cancel', jwtOrApiKey, async (req, res) => {
  const db     = req.db;
  const id     = parseInt(req.params.id);
  const reason = req.body.reason || 'manual';

  try {
    const [[e]] = await db.query(
      `SELECT id, status FROM sequence_enrollments WHERE id = ?`, [id]
    );
    if (!e) return res.status(404).json({ error: 'Enrollment not found' });
    if (e.status !== 'active') {
      return res.status(400).json({ error: `Enrollment is already ${e.status}` });
    }

    await db.query(
      `UPDATE sequence_enrollments SET status='cancelled', cancel_reason=?, updated_at=NOW() WHERE id=?`,
      [reason, id]
    );
    await db.query(
      `UPDATE scheduled_jobs SET status = 'cancelled', updated_at = NOW()
       WHERE sequence_enrollment_id = ? AND status IN ('pending', 'running')`,
      [id]
    );

    res.json({ success: true, enrollmentId: id, message: 'Enrollment cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel enrollment', message: err.message });
  }
});

// POST /sequences/enrollments/:id/fire-next
//
// Reschedules the enrollment's pending step job to NOW so the next
// /process-jobs tick picks it up.
//
// NOT a force-execute — the engine still evaluates the step's fire_guard
// and condition when it runs. This is purely a scheduling override. A step
// that would have skipped at its original time will still skip now.
//
// Race with /process-jobs:
//   Between our SELECT and UPDATE, the heartbeat can claim the job (it does
//   SELECT ... FOR UPDATE SKIP LOCKED, then UPDATE status='running'). We
//   rely on our UPDATE's `WHERE status='pending'` filter as the lock — if
//   affectedRows === 0, we lost the race; return 409. Do NOT retry.
//
// Use scheduled_jobs.sequence_enrollment_id (canonical column) — never filter
// via JSON_EXTRACT(data, '$.enrollmentId').
router.post('/sequences/enrollments/:id/fire-next', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid enrollment ID' });
  }

  try {
    // 1) Load enrollment
    const [[en]] = await db.query(
      `SELECT id, status FROM sequence_enrollments WHERE id = ?`,
      [id]
    );
    if (!en) return res.status(404).json({ error: 'Enrollment not found' });
    if (en.status !== 'active') {
      return res.status(409).json({
        error: `Enrollment is ${en.status}, not active`,
        enrollment_status: en.status,
      });
    }

    // 2) Find the pending scheduled_jobs row
    const [[job]] = await db.query(
      `SELECT id, scheduled_time, status, data
         FROM scheduled_jobs
        WHERE sequence_enrollment_id = ?
          AND status = 'pending'
        ORDER BY id DESC
        LIMIT 1`,
      [id]
    );
    if (!job) {
      return res.status(409).json({
        error: 'No pending step job for this enrollment',
        enrollment_status: en.status,
      });
    }

    // 3) Race-safe UPDATE. The WHERE status='pending' is the only thing
    //    standing between us and double-execution.
    const [upd] = await db.query(
      `UPDATE scheduled_jobs
          SET scheduled_time = NOW(), updated_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [job.id]
    );
    if (upd.affectedRows !== 1) {
      return res.status(409).json({ error: 'Job is already executing' });
    }

    // 4) Read back the new scheduled_time (NOW() at UPDATE moment) and
    //    pull stepNumber out of the data JSON for the response.
    const [[after]] = await db.query(
      `SELECT scheduled_time FROM scheduled_jobs WHERE id = ?`,
      [job.id]
    );
    let stepNumber = null;
    try {
      const d = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
      if (d && Number.isInteger(d.stepNumber)) stepNumber = d.stepNumber;
    } catch { /* leave null */ }

    return res.json({
      success:               true,
      enrollment_id:         id,
      job_id:                job.id,
      original_scheduled_at: new Date(job.scheduled_time).toISOString(),
      new_scheduled_at:      new Date(after.scheduled_time).toISOString(),
      step_number:           stepNumber,
      note: "Job will fire on the next /process-jobs tick (within ~5 min, "
          + "target ~1 min once cadence is tightened). The step's fire_guard "
          + "and condition still apply at execution.",
    });
  } catch (err) {
    console.error('[POST /sequences/enrollments/:id/fire-next] failed:', err);
    return res.status(500).json({ error: 'Failed to fire next step', message: err.message });
  }
});

// POST /sequences/enrollments/:id/recover
//
// Recover a stuck (wedged) enrollment by re-creating the missing
// scheduled_jobs row for whichever step should run next.
//
// "Stuck" = enrollment.status='active' AND no pending/running
// scheduled_jobs row. This state is normally created by the
// safeAdvanceToNextStep catch path in sequenceEngine.executeStep:
// the prior step's action ran fine, but the immediate next-step
// scheduling threw (Hebcal timeout chain → calculateStepTime → Invalid
// Date, transient DB blip, etc.). The action's success is durable in
// sequence_step_log; the missing next-step job is what this endpoint
// repairs.
//
// Target step selection:
//   - If sequence_step_log has any rows for this enrollment: target is
//     (most-recent log row's step_number) + 1. This is robust to the
//     edge where advanceToNextStep threw BEFORE updating
//     enrollment.current_step.
//   - If no log rows exist (enrollment-time wedge — _enrollWithTemplate
//     INSERTed the enrollment but scheduling the first step threw):
//     target is enrollment.current_step (which is 1 from the initial
//     INSERT).
//   - If no step exists at the target step_number in the template
//     (e.g., template was truncated after enrollment): mark the
//     enrollment 'completed', mirroring advanceToNextStep's terminal
//     branch.
//
// Idempotency: delegates the INSERT to sequenceEngine.scheduleStepJob,
// which short-circuits if a pending/running row already exists for the
// same (enrollmentId, step_number) idempotency_key. Two simultaneous
// clicks → only the first INSERT lands; the second is a no-op (and we
// surface a 409 below for clarity).
//
// Fire_guard / condition: NOT a force-execute. The step's guards still
// apply when /process-jobs picks the job up — same semantics as
// /fire-next.
router.post('/sequences/enrollments/:id/recover', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid enrollment ID' });
  }

  try {
    // 1) Load enrollment
    const [[en]] = await db.query(
      `SELECT id, template_id, template_version, status, current_step FROM sequence_enrollments WHERE id = ?`,
      [id]
    );
    if (!en) return res.status(404).json({ error: 'Enrollment not found' });
    if (en.status !== 'active') {
      return res.status(409).json({
        error: `Enrollment is ${en.status}, not active`,
        enrollment_status: en.status,
      });
    }

    // 2) Refuse if a pending/running job already exists — that's the
    //    /fire-next territory, not /recover. Caller's UI should already
    //    have hidden this button in that case; this is belt-and-braces.
    const [[existingJob]] = await db.query(
      `SELECT id, status FROM scheduled_jobs
        WHERE sequence_enrollment_id = ?
          AND status IN ('pending', 'running')
        ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (existingJob) {
      return res.status(409).json({
        error: `A ${existingJob.status} job already exists for this enrollment; nothing to recover`,
        job_id: existingJob.id,
        job_status: existingJob.status,
      });
    }

    // 3) Determine target step_number — see route comment for rationale.
    const [[lastLog]] = await db.query(
      `SELECT step_number FROM sequence_step_log
        WHERE enrollment_id = ?
        ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const targetStepNumber = lastLog && lastLog.step_number != null
      ? lastLog.step_number + 1
      : en.current_step;

    // 4) Load the step row. If absent, complete the enrollment (mirrors
    //    advanceToNextStep terminal branch).
    // PINNED-READ: recover must resume on the enrollment's pinned version —
    // recovering onto current_version could resurrect a renumbered step.
    const [[step]] = await db.query(
      `SELECT id, step_number, timing FROM sequence_steps
        WHERE template_id = ? AND version = ? AND step_number = ? LIMIT 1`,
      [en.template_id, en.template_version, targetStepNumber]
    );
    if (!step) {
      await db.query(
        `UPDATE sequence_enrollments
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = ?`,
        [id]
      );
      console.log(`[sequence] Recovery completed enrollment ${id} — no step ${targetStepNumber} in template`);
      return res.json({
        success:        true,
        enrollment_id:  id,
        status:         'completed',
        step_number:    targetStepNumber,
        note: 'Template has no step at the target number; marked enrollment completed.',
      });
    }

    // 5) Advance enrollment.current_step if it's behind targetStepNumber.
    //    This covers the edge where advanceToNextStep threw before its
    //    UPDATE current_step ran.
    if (en.current_step !== targetStepNumber) {
      await db.query(
        `UPDATE sequence_enrollments
            SET current_step = ?, updated_at = NOW()
          WHERE id = ?`,
        [targetStepNumber, id]
      );
    }

    // 6) Schedule. scheduleStepJob expects step.timing parsed already
    //    where it matters, but it only reads step.step_number and step.id
    //    for the INSERT — timing isn't touched here. Schedule for NOW so
    //    the next /process-jobs tick picks it up.
    const now = new Date();
    await scheduleStepJob(db, id, step, now);

    // 7) Read back the row we just (probably) inserted. If scheduleStepJob
    //    short-circuited because a pending row materialized between our
    //    check and the call (very unlikely but possible under concurrent
    //    recovery clicks), surface that.
    const [[after]] = await db.query(
      `SELECT id, scheduled_time, status FROM scheduled_jobs
        WHERE sequence_enrollment_id = ?
          AND idempotency_key = ?
          AND status IN ('pending', 'running')
        ORDER BY id DESC LIMIT 1`,
      [id, `seq-${id}-step-${step.step_number}`]
    );
    if (!after) {
      // Shouldn't happen — scheduleStepJob either inserts or finds a
      // pending/running existing row. Belt-and-braces 500.
      return res.status(500).json({
        error: 'Recovery insert did not produce a pending job; please check logs',
      });
    }

    return res.json({
      success:           true,
      enrollment_id:     id,
      job_id:            after.id,
      step_number:       step.step_number,
      new_scheduled_at:  new Date(after.scheduled_time).toISOString(),
      note: "Job will fire on the next /process-jobs tick (within ~5 min). "
          + "The step's fire_guard and condition still apply at execution.",
    });
  } catch (err) {
    console.error('[POST /sequences/enrollments/:id/recover] failed:', err);
    return res.status(500).json({ error: 'Failed to recover enrollment', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// Capture mode — one-shot capture of the next real trigger_data.
// Mirrors workflows + hooks: start arms, the next enrollment (any path
// through _enrollWithTemplate) records trigger_data and disarms via a
// guarded UPDATE; start/stop never clear the stored sample.
// ─────────────────────────────────────────────────────────────

router.post('/sequences/templates/:id/capture/start', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const [[row]] = await db.query(`SELECT id FROM sequence_templates WHERE id = ?`, [templateId]);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    await db.query(`UPDATE sequence_templates SET capture_mode = 'capturing' WHERE id = ?`, [templateId]);
    res.json({ status: 'success', capture_mode: 'capturing' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start capture', message: err.message });
  }
});

router.post('/sequences/templates/:id/capture/stop', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const [[row]] = await db.query(`SELECT id FROM sequence_templates WHERE id = ?`, [templateId]);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    await db.query(`UPDATE sequence_templates SET capture_mode = 'off' WHERE id = ?`, [templateId]);
    res.json({ status: 'success', capture_mode: 'off' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop capture', message: err.message });
  }
});

router.get('/sequences/templates/:id/captured', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId) || templateId <= 0) return res.status(400).json({ error: 'Invalid template ID' });
  try {
    const [[row]] = await db.query(
      `SELECT capture_mode, captured_input, captured_at FROM sequence_templates WHERE id = ?`,
      [templateId]
    );
    if (!row) return res.status(404).json({ error: 'Template not found' });
    let sample = row.captured_input;
    if (typeof sample === 'string') {
      try { sample = sample ? JSON.parse(sample) : null; } catch { /* leave as-is */ }
    }
    res.json({ status: 'success', capture_mode: row.capture_mode, captured_input: sample, captured_at: row.captured_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch captured input', message: err.message });
  }
});

module.exports = router;

// Test-only handle (tests/sequences.ensureDraft.test.js) — mirrors
// routes/workflows.js.
router._test = { ensureDraft };