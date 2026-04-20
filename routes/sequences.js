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
const { enrollContact, enrollContactByTemplateId, cancelSequences } = require('../lib/sequenceEngine');
const toJson = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

// Normalize the optional `type` column. As of Slice B, sequence_templates.type
// is nullable — templates without a type are "ID-only" and can be enrolled only
// via template_id (no cascade matching). Treat null, empty string, and
// whitespace-only strings all equivalently as NULL.
const normalizeType = v => (v == null || !String(v).trim()) ? null : String(v).trim();

// ─────────────────────────────────────────────────────────────
// Template CRUD
// ─────────────────────────────────────────────────────────────

// GET /sequences/templates
router.get('/sequences/templates', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { type, active } = req.query;

  try {
    let query  = `SELECT t.*,
                    (SELECT COUNT(*) FROM sequence_steps WHERE template_id = t.id) AS step_count
                  FROM sequence_templates t WHERE 1=1`;
    const params = [];

    if (type)   { query += ` AND t.type = ?`;   params.push(type); }
    if (active !== undefined) { query += ` AND t.active = ?`; params.push(active === 'true' ? 1 : 0); }

    query += ` ORDER BY t.type, t.name`;

    const [rows] = await db.query(query, params);
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

    const [steps] = await db.query(
      `SELECT * FROM sequence_steps WHERE template_id = ? ORDER BY step_number ASC`, [id]
    );

    // Parse JSON columns for readability
    steps.forEach(s => {
      ['timing','action_config','condition','fire_guard','error_policy'].forEach(col => {
        if (typeof s[col] === 'string') try { s[col] = JSON.parse(s[col]); } catch {}
      });
    });

    if (typeof template.condition === 'string') {
      try { template.condition = JSON.parse(template.condition); } catch {}
    }

    res.json({ success: true, template, steps });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch template', message: err.message });
  }
});

// POST /sequences/templates
//
// Slice B: `type` is optional. Null / empty / whitespace-only all become NULL
// in the DB — these "ID-only" templates cannot be cascade-matched and are
// reachable only via template_id on POST /sequences/enroll.
router.post('/sequences/templates', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, type, appt_type_filter, appt_with_filter, condition, description, active = true } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const typeVal = normalizeType(type);

  try {
    const [result] = await db.query(
      `INSERT INTO sequence_templates (name, type, appt_type_filter, appt_with_filter, \`condition\`, description, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), typeVal, appt_type_filter || null,
       appt_with_filter != null ? parseInt(appt_with_filter) : null,
       condition ? JSON.stringify(condition) : null,
       description || null, active ? 1 : 0]
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
router.put('/sequences/templates/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { name, type, appt_type_filter, appt_with_filter, condition, description, active } = req.body;

  const updates = [];
  const params  = [];

  if (name        !== undefined) { updates.push('name = ?');              params.push(name?.trim()); }
  if (type        !== undefined) { updates.push('type = ?');              params.push(normalizeType(type)); }
  if (appt_type_filter !== undefined) { updates.push('appt_type_filter = ?'); params.push(appt_type_filter); }
  if (appt_with_filter !== undefined) { updates.push('appt_with_filter = ?'); params.push(appt_with_filter != null ? parseInt(appt_with_filter) : null); }
  if (condition   !== undefined) { updates.push('\`condition\` = ?');         params.push(condition ? JSON.stringify(condition) : null); }
  if (description !== undefined) { updates.push('description = ?');       params.push(description); }
  if (active      !== undefined) { updates.push('active = ?');            params.push(active ? 1 : 0); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(id);
  try {
    await db.query(`UPDATE sequence_templates SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Fetch original template row
    const [tplRows] = await connection.query(
      `SELECT name, type, appt_type_filter, appt_with_filter, \`condition\`, description
       FROM sequence_templates WHERE id = ?`,
      [originalId]
    );
    if (tplRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: 'Template not found' });
    }

    const original = tplRows[0];
    const newName  = customName?.trim() || `Copy of ${original.name}`;

    // Insert new template — active=0 (starts inactive, intentional).
    // JSON column `condition` is passed through as-is from SELECT; mysql2
    // handles the round-trip without double-encoding.
    // `type` is copied verbatim — if original is NULL (ID-only), the duplicate
    // is NULL (ID-only) too.
    const [newTplResult] = await connection.query(
      `INSERT INTO sequence_templates
        (name, type, appt_type_filter, appt_with_filter, \`condition\`, description, active)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        newName,
        original.type,
        original.appt_type_filter,
        original.appt_with_filter,
        toJson(original.condition),
        original.description
      ]
    );
    const newTemplateId = newTplResult.insertId;

    // Fetch + duplicate all steps. JSON columns pass through raw — same
    // pattern as POST /workflows/:id/duplicate.
    const [steps] = await connection.query(
      `SELECT step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy
       FROM sequence_steps
       WHERE template_id = ?
       ORDER BY step_number ASC`,
      [originalId]
    );

    if (steps.length > 0) {
      const stepValues = steps.map(s => [
        newTemplateId,
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
          (template_id, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
         VALUES ?`,
        [stepValues]
      );
    }

    await connection.commit();
    connection.release();

    console.log(`[DUPLICATE SEQUENCE] Template ${originalId} → ${newTemplateId} (${steps.length} steps)`);

    res.status(201).json({
      success: true,
      templateId: newTemplateId,
      name: newName
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [[t]] = await connection.query(`SELECT id FROM sequence_templates WHERE id = ?`, [templateId]);
    if (!t) { await connection.commit(); return res.status(404).json({ error: 'Template not found' }); }

    let targetStep = step_number;
    if (!targetStep) {
      const [[maxRow]] = await connection.query(
        `SELECT MAX(step_number) as max FROM sequence_steps WHERE template_id = ?`, [templateId]
      );
      targetStep = (maxRow.max || 0) + 1;
    } else {
      // Two-pass shift up
      await connection.query(
        `UPDATE sequence_steps SET step_number = step_number + 10000 WHERE template_id = ? AND step_number >= ?`,
        [templateId, targetStep]
      );
      await connection.query(
        `UPDATE sequence_steps SET step_number = step_number - 10000 + 1 WHERE template_id = ? AND step_number >= ?`,
        [templateId, targetStep + 10000]
      );
    }

    const [result] = await connection.query(
      `INSERT INTO sequence_steps (template_id, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [templateId, targetStep, action_type,
       JSON.stringify(action_config), JSON.stringify(timing),
       condition   ? JSON.stringify(condition)   : null,
       fire_guard  ? JSON.stringify(fire_guard)  : null,
       error_policy? JSON.stringify(error_policy): null]
    );

    await connection.commit();
    connection.release();
    res.status(201).json({ success: true, stepId: result.insertId, stepNumber: targetStep });
  } catch (err) {
    if (connection) { await connection.rollback(); connection.release(); }
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

  try {
    const [[step]] = await db.query(
      `SELECT id FROM sequence_steps WHERE template_id = ? AND step_number = ?`, [templateId, stepNum]
    );
    if (!step) return res.status(404).json({ error: 'Step not found' });

    await db.query(
      `UPDATE sequence_steps SET action_type=?, action_config=?, timing=?, \`condition\`=?, fire_guard=?, error_policy=?, updated_at=NOW()
       WHERE template_id=? AND step_number=?`,
      [action_type, JSON.stringify(action_config), JSON.stringify(timing),
       condition    ? JSON.stringify(condition)   : null,
       fire_guard   ? JSON.stringify(fire_guard)  : null,
       error_policy ? JSON.stringify(error_policy): null,
       templateId, stepNum]
    );
    res.json({ success: true, templateId, stepNumber: stepNum });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update step', message: err.message });
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

  params.push(templateId, stepNum);
  try {
    await db.query(
      `UPDATE sequence_steps SET ${updates.join(', ')}, updated_at=NOW() WHERE template_id=? AND step_number=?`,
      params
    );
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [[step]] = await connection.query(
      `SELECT id FROM sequence_steps WHERE template_id = ? AND step_number = ?`, [templateId, stepNum]
    );
    if (!step) { await connection.commit(); return res.status(404).json({ error: 'Step not found' }); }

    await connection.query(
      `DELETE FROM sequence_steps WHERE template_id = ? AND step_number = ?`, [templateId, stepNum]
    );
    await connection.query(
      `UPDATE sequence_steps SET step_number = step_number - 1
       WHERE template_id = ? AND step_number > ? ORDER BY step_number ASC`,
      [templateId, stepNum]
    );

    await connection.commit();
    connection.release();
    res.json({ success: true, message: `Step ${stepNum} deleted and renumbered` });
  } catch (err) {
    if (connection) { await connection.rollback(); connection.release(); }
    res.status(500).json({ error: 'Failed to delete step', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Enrollment operations
// ─────────────────────────────────────────────────────────────

// POST /sequences/enroll
//
// Two modes — pass exactly one of:
//   template_type  (+ optional appt_type, appt_with) — cascade match
//   template_id    — target a specific template directly (no cascade filters)
//
// Slice B: if `template_type` is present in the body but null / empty string /
// whitespace-only, we reject with 400 rather than falling through to a zero-
// match cascade query. Keeps behavior explicit and prevents an accidental
// "cascade-match against NULL-type templates" surface if client code sends a
// blanked-out value.
router.post('/sequences/enroll', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    contact_id,
    template_type,
    template_id,
    trigger_data = {},
    appt_type = null,
    appt_with = null,
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
      // By-ID mode — cascade filters are not allowed
      if (appt_type !== null || appt_with !== null) {
        return res.status(400).json({
          error: 'appt_type and appt_with are only valid with template_type (cascade mode); omit them when using template_id',
        });
      }
      const idInt = parseInt(template_id, 10);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        return res.status(400).json({ error: 'template_id must be a positive integer' });
      }
      const result = await enrollContactByTemplateId(db, contact_id, idInt, trigger_data);
      return res.status(201).json({ success: true, ...result });
    }

    // By-type (cascade) mode — original behavior, unchanged
    const result = await enrollContact(db, contact_id, template_type, trigger_data, { appt_type, appt_with });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to enroll contact', message: err.message });
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

    // ── NEW: derived step history from scheduled_jobs LEFT JOIN sequence_step_log ──
    // One row per scheduled_jobs entry for this enrollment, scheduled_time ASC.
    // Log fields are NULL for rows that never executed (pending, or cancelled-before-fire).
    // step_number is read from sj.data JSON — scheduled_jobs has no dedicated column.
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

      history = histRows.map(r => {
        // Defensively parse JSON columns (mysql2 may return object or string).
        ['job_data','action_config_resolved','output_data'].forEach(col => {
          if (typeof r[col] === 'string') {
            try { r[col] = JSON.parse(r[col]); } catch {}
          }
        });
        return r;
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
      `UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW()
       WHERE sequence_enrollment_id = ? AND status IN ('pending', 'running')`,
      [id]
    );

    res.json({ success: true, enrollmentId: id, message: 'Enrollment cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel enrollment', message: err.message });
  }
});

// PATCH /sequences/templates/:id/steps/reorder — swap two steps
router.patch('/sequences/templates/:id/steps/reorder', jwtOrApiKey, async (req, res) => {
  const db         = req.db;
  const templateId = parseInt(req.params.id);
  const { fromStep, toStep } = req.body;

  if (!fromStep || !toStep) return res.status(400).json({ error: 'fromStep and toStep are required' });

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Two-pass swap via temp number
    const temp = 99999;
    await connection.query(
      `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND step_number = ?`,
      [temp, templateId, fromStep]
    );
    await connection.query(
      `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND step_number = ?`,
      [fromStep, templateId, toStep]
    );
    await connection.query(
      `UPDATE sequence_steps SET step_number = ? WHERE template_id = ? AND step_number = ?`,
      [toStep, templateId, temp]
    );

    await connection.commit();
    connection.release();
    res.json({ success: true });
  } catch (err) {
    if (connection) { await connection.rollback(); connection.release(); }
    res.status(500).json({ error: 'Failed to reorder steps', message: err.message });
  }
});


module.exports = router;