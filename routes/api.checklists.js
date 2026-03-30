/**
 * Checklist Routes
 * 
 * GET    /checklists                          list (filter by link_type + link)
 * GET    /checklists/:id                      single checklist + items
 * POST   /checklists                          create
 * PATCH  /checklists/:id                      update title/tag
 * DELETE /checklists/:id                      delete (cascades items)
 * POST   /checklists/:id/items                add item
 * PATCH  /checkitems/:id                      update item (name, status)
 * DELETE /checkitems/:id                      delete item
 * POST   /checklists/upsert-items             find-or-create 'Docs Needed' + upsert items
 *
 * Public (no auth):
 * GET    /api/public/docs/:caseId             rate-limited, returns name + incomplete docs items
 */

const express      = require('express');
const router       = express.Router();
const rateLimit    = require('express-rate-limit');
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');

// ─── Helpers ────────────────────────────────────────────────────

async function computeAndSaveStatus(db, checklistId) {
  const [items] = await db.query(
    'SELECT status FROM checkitems WHERE checklist_id = ?',
    [checklistId]
  );
  const status = items.length > 0 && items.every(i => i.status === 'complete')
    ? 'complete' : 'incomplete';
  await db.query(
    'UPDATE checklists SET status = ?, updated_date = NOW() WHERE id = ?',
    [status, checklistId]
  );
  return status;
}

async function getChecklistWithItems(db, checklistId) {
  const [[checklist]] = await db.query(
    'SELECT * FROM checklists WHERE id = ?', [checklistId]
  );
  if (!checklist) return null;
  const [items] = await db.query(
    'SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC',
    [checklistId]
  );
  return { ...checklist, items };
}

// ─── Authenticated routes ────────────────────────────────────────

// GET /checklists?link_type=case&link=uT7EU36v
router.get('/checklists', jwtOrApiKey, async (req, res) => {
  try {
    const { link_type, link } = req.query;
    const where = [];
    const params = [];
    if (link_type) { where.push('link_type = ?'); params.push(link_type); }
    if (link)      { where.push('link = ?');      params.push(link); }
    const sql = `SELECT * FROM checklists${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_date ASC`;
    const [rows] = await req.db.query(sql, params);
    res.json({ checklists: rows });
  } catch (err) {
    console.error('GET /checklists error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch checklists' });
  }
});

// GET /checklists/:id  — single checklist + items
router.get('/checklists/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await getChecklistWithItems(req.db, req.params.id);
    if (!result) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch checklist' });
  }
});

// POST /checklists
router.post('/checklists', jwtOrApiKey, async (req, res) => {
  const { title, link, link_type, tag, items } = req.body;
  if (!title?.trim()) return res.status(400).json({ status: 'error', message: 'title is required' });

  try {
    const [result] = await req.db.query(
      'INSERT INTO checklists (title, created_by, link, link_type, tag) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), req.auth.userId, link || null, link_type || null, tag || null]
    );
    const checklistId = result.insertId;

    if (Array.isArray(items) && items.length) {
      const values = items.map((item, i) => [
        checklistId, item.name, item.status || 'incomplete', item.position ?? i + 1, item.tag || null
      ]);
      await req.db.query(
        'INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES ?',
        [values]
      );
    }

    const checklist = await getChecklistWithItems(req.db, checklistId);
    res.status(201).json(checklist);
  } catch (err) {
    console.error('POST /checklists error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create checklist' });
  }
});

// PATCH /checklists/:id
router.patch('/checklists/:id', jwtOrApiKey, async (req, res) => {
  const { title, tag, link, link_type } = req.body;
  const fields = [], params = [];
  if (title     !== undefined) { fields.push('title = ?');     params.push(title); }
  if (tag       !== undefined) { fields.push('tag = ?');       params.push(tag); }
  if (link      !== undefined) { fields.push('link = ?');      params.push(link); }
  if (link_type !== undefined) { fields.push('link_type = ?'); params.push(link_type); }
  if (!fields.length) return res.status(400).json({ status: 'error', message: 'Nothing to update' });

  try {
    params.push(req.params.id);
    await req.db.query(`UPDATE checklists SET ${fields.join(', ')} WHERE id = ?`, params);
    const checklist = await getChecklistWithItems(req.db, req.params.id);
    if (!checklist) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json(checklist);
  } catch (err) {
    console.error('PATCH /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to update checklist' });
  }
});

// DELETE /checklists/:id
router.delete('/checklists/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [result] = await req.db.query('DELETE FROM checklists WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json({ status: 'success', message: 'Checklist deleted' });
  } catch (err) {
    console.error('DELETE /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to delete checklist' });
  }
});

// POST /checklists/:id/items
router.post('/checklists/:id/items', jwtOrApiKey, async (req, res) => {
  const { name, status = 'incomplete', position, tag } = req.body;
  if (!name?.trim()) return res.status(400).json({ status: 'error', message: 'name is required' });

  try {
    let pos = position;
    if (!pos) {
      const [[{ maxPos }]] = await req.db.query(
        'SELECT COALESCE(MAX(position), 0) AS maxPos FROM checkitems WHERE checklist_id = ?',
        [req.params.id]
      );
      pos = maxPos + 1;
    }
    await req.db.query(
      'INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, name.trim(), status, pos, tag || null]
    );
    await computeAndSaveStatus(req.db, req.params.id);
    const checklist = await getChecklistWithItems(req.db, req.params.id);
    res.status(201).json(checklist);
  } catch (err) {
    console.error('POST /checklists/:id/items error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to add item' });
  }
});

// PATCH /checkitems/:id
router.patch('/checkitems/:id', jwtOrApiKey, async (req, res) => {
  const { name, status, position, tag } = req.body;
  const fields = [], params = [];
  if (name     !== undefined) { fields.push('name = ?');     params.push(name); }
  if (status   !== undefined) { fields.push('status = ?');   params.push(status); }
  if (position !== undefined) { fields.push('position = ?'); params.push(position); }
  if (tag      !== undefined) { fields.push('tag = ?');      params.push(tag); }
  if (!fields.length) return res.status(400).json({ status: 'error', message: 'Nothing to update' });

  try {
    params.push(req.params.id);
    await req.db.query(`UPDATE checkitems SET ${fields.join(', ')} WHERE id = ?`, params);

    // Recompute parent status
    const [[item]] = await req.db.query(
      'SELECT checklist_id FROM checkitems WHERE id = ?', [req.params.id]
    );
    if (item) await computeAndSaveStatus(req.db, item.checklist_id);

    const [[updated]] = await req.db.query('SELECT * FROM checkitems WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('PATCH /checkitems/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to update item' });
  }
});

// DELETE /checkitems/:id
router.delete('/checkitems/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [[item]] = await req.db.query(
      'SELECT checklist_id FROM checkitems WHERE id = ?', [req.params.id]
    );
    if (!item) return res.status(404).json({ status: 'error', message: 'Item not found' });

    await req.db.query('DELETE FROM checkitems WHERE id = ?', [req.params.id]);
    await computeAndSaveStatus(req.db, item.checklist_id);
    res.json({ status: 'success', message: 'Item deleted' });
  } catch (err) {
    console.error('DELETE /checkitems/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to delete item' });
  }
});

// POST /checklists/upsert-items
// Replaces the Pabbly/Trello "Docs Needed" upsert logic.
// Finds or creates a 'Docs Needed' checklist for the case,
// then for each item: removes any existing item matching the first 22 chars, inserts fresh.
router.post('/checklists/upsert-items', jwtOrApiKey, async (req, res) => {
  const { case_id, items } = req.body;
  if (!case_id) return res.status(400).json({ status: 'error', message: 'case_id is required' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ status: 'error', message: 'items must be a non-empty array' });

  try {
    // Find or create the 'Docs Needed' checklist for this case
    let [[checklist]] = await req.db.query(
      `SELECT id FROM checklists WHERE link_type = 'case' AND link = ? AND title = 'Docs Needed' LIMIT 1`,
      [case_id]
    );

    if (!checklist) {
      const [result] = await req.db.query(
        `INSERT INTO checklists (title, created_by, link, link_type) VALUES ('Docs Needed', ?, ?, 'case')`,
        [req.auth.userId || 0, case_id]
      );
      checklist = { id: result.insertId };
    }

    const checklistId = checklist.id;

    // Load existing items
    const [existing] = await req.db.query(
      'SELECT id, name FROM checkitems WHERE checklist_id = ?',
      [checklistId]
    );

    // For each incoming item: delete any matching existing item (first 22 chars), then insert
    for (let i = 0; i < items.length; i++) {
      const item = items[i].trim();
      const prefix = item.substring(0, 22);
      const match = existing.find(e => e.name.substring(0, 22) === prefix);
      if (match) {
        await req.db.query('DELETE FROM checkitems WHERE id = ?', [match.id]);
      }
      await req.db.query(
        'INSERT INTO checkitems (checklist_id, name, status, position) VALUES (?, ?, ?, ?)',
        [checklistId, item, 'incomplete', i + 1]
      );
    }

    await computeAndSaveStatus(req.db, checklistId);
    const result = await getChecklistWithItems(req.db, checklistId);
    res.json({ status: 'success', checklist: result });
  } catch (err) {
    console.error('POST /checklists/upsert-items error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to upsert items' });
  }
});

// ─── Public route ────────────────────────────────────────────────

const docsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});

// GET /api/public/docs/:caseId
router.get('/api/public/docs/:caseId', docsRateLimit, async (req, res) => {
  try {
    const { caseId } = req.params;

    // Get primary client name
    const [[primary]] = await req.db.query(
      `SELECT co.contact_fname
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
       WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
       LIMIT 1`,
      [caseId]
    );
    if (!primary) return res.status(404).json({ status: 'error', message: 'Case not found' });

    // Get incomplete items from Docs Needed checklist
    const [items] = await req.db.query(
      `SELECT ci.name
       FROM checkitems ci
       JOIN checklists cl ON ci.checklist_id = cl.id
       WHERE cl.link_type = 'case'
         AND cl.link = ?
         AND cl.title = 'Docs Needed'
         AND ci.status = 'incomplete'
       ORDER BY ci.position ASC, ci.id ASC`,
      [caseId]
    );

    res.json({
      name: primary.contact_fname,
      items: items.map(i => i.name)
    });
  } catch (err) {
    console.error('GET /api/public/docs/:caseId error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch docs list' });
  }
});

module.exports = router;