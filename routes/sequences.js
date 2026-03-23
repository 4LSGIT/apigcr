// routes/sequences.js
//
// Sequence template management + enrollment operations.
//
// Template CRUD:
//   GET    /sequences/templates              list all templates
//   GET    /sequences/templates/:id          get template + steps
//   POST   /sequences/templates              create template
//   PUT    /sequences/templates/:id          update template
//   DELETE /sequences/templates/:id          delete template + steps
//   POST   /sequences/templates/:id/steps    add step
//   PUT    /sequences/templates/:id/steps/:stepNumber   replace step
//   PATCH  /sequences/templates/:id/steps/:stepNumber   partial update step
//   DELETE /sequences/templates/:id/steps/:stepNumber   delete + renumber
//
// Enrollments:
//   POST   /sequences/enroll                 enroll a contact
//   POST   /sequences/cancel                 cancel sequences for a contact
//   GET    /sequences/enrollments            list enrollments (filterable)
//   GET    /sequences/enrollments/:id        single enrollment + step log
//   POST   /sequences/enrollments/:id/cancel cancel one enrollment

const express         = require('express');
const router          = express.Router();
const jwtOrApiKey     = require('../lib/auth.jwtOrApiKey');
const { enrollContact, cancelSequences } = require('../lib/sequenceEngine');

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
router.post('/sequences/templates', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, type, appt_type_filter, condition, description, active = true } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!type?.trim()) return res.status(400).json({ error: 'type is required' });

  try {
    const [result] = await db.query(
      `INSERT INTO sequence_templates (name, type, appt_type_filter, \`condition\`, description, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), type.trim(), appt_type_filter || null,
       condition ? JSON.stringify(condition) : null,
       description || null, active ? 1 : 0]
    );
    res.status(201).json({ success: true, templateId: result.insertId, name: name.trim(), type });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template', message: err.message });
  }
});

// PUT /sequences/templates/:id
router.put('/sequences/templates/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { name, type, appt_type_filter, condition, description, active } = req.body;

  const updates = [];
  const params  = [];

  if (name        !== undefined) { updates.push('name = ?');              params.push(name?.trim()); }
  if (type        !== undefined) { updates.push('type = ?');              params.push(type?.trim()); }
  if (appt_type_filter !== undefined) { updates.push('appt_type_filter = ?'); params.push(appt_type_filter); }
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
router.post('/sequences/enroll', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { contact_id, template_type, trigger_data = {} } = req.body;

  if (!contact_id)    return res.status(400).json({ error: 'contact_id is required' });
  if (!template_type) return res.status(400).json({ error: 'template_type is required' });

  try {
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
router.get('/sequences/enrollments/:id', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const includeLog = req.query.log !== 'false'; // default true

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

    res.json({ success: true, enrollment, log });
  } catch (err) {
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
      `DELETE FROM scheduled_jobs WHERE sequence_enrollment_id=? AND status IN ('pending','running')`,
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