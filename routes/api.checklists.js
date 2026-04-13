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
const dropbox      = require('../services/dropboxService');
const emailService = require('../services/emailService');
const logService   = require('../services/logService');

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

// GET /checklists?link_type=case&link=uT7EU36v&include=items
router.get('/checklists', jwtOrApiKey, async (req, res) => {
  try {
    const { link_type, link, include } = req.query;
    const where = [];
    const params = [];
    if (link_type) { where.push('link_type = ?'); params.push(link_type); }
    if (link)      { where.push('link = ?');      params.push(link); }
    const sql = `SELECT * FROM checklists${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_date ASC`;
    const [rows] = await req.db.query(sql, params);

    // Optionally bulk-load items (single query, no N+1)
    if (include === 'items' && rows.length) {
      const ids = rows.map(r => r.id);
      const [allItems] = await req.db.query(
        `SELECT * FROM checkitems WHERE checklist_id IN (?) ORDER BY position ASC, id ASC`,
        [ids]
      );
      const grouped = {};
      for (const item of allItems) {
        (grouped[item.checklist_id] ||= []).push(item);
      }
      for (const cl of rows) {
        cl.items = grouped[cl.id] || [];
      }
    }

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

// ─── Public upload routes ────────────────────────────────────────
 
const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,   // higher than docs GET — each file needs a link
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});
 
const notifyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});
 
/**
 * POST /api/public/get-upload-link
 * Body: { case_id, filename }
 *
 * Returns a Dropbox temporary upload link so the client browser
 * can upload directly — file bytes never touch our server.
 */
router.post('/api/public/get-upload-link', uploadRateLimit, async (req, res) => {
  try {
    const { case_id, filename } = req.body;
 
    if (!case_id || !filename) {
      return res.status(400).json({ status: 'error', message: 'case_id and filename are required' });
    }
 
    // Look up the case's Dropbox shared link
    const [[caseRow]] = await req.db.query(
      'SELECT case_dropbox FROM cases WHERE case_id = ?',
      [case_id]
    );
 
    if (!caseRow) {
      return res.status(404).json({ status: 'error', message: 'Case not found' });
    }
 
    const sharedLink = caseRow.case_dropbox;
    if (!sharedLink) {
      return res.status(400).json({ status: 'error', message: 'No Dropbox folder linked to this case' });
    }
 
    // Resolve the shared link to get the actual Dropbox path
    const meta = await dropbox.getSharedLinkMetadata(sharedLink);
    if (meta['.tag'] !== 'folder') {
      return res.status(400).json({ status: 'error', message: 'Shared link is not a folder' });
    }

    const folderPath = meta.path_lower;
    const link = await dropbox.getTemporaryUploadLink(folderPath, filename);
 
    res.json({ link });
  } catch (err) {
    console.error('POST /api/public/get-upload-link error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create upload link' });
  }
});
 
 
/**
 * POST /api/public/upload-complete
 * Body: { case_id, files: string[], comment?: string }
 *
 * Called after client finishes uploading. Logs the event
 * and emails the team with the file list + Dropbox link.
 */
router.post('/api/public/upload-complete', notifyRateLimit, async (req, res) => {
  try {
    const { case_id, files, comment } = req.body;
 
    if (!case_id || !files || !Array.isArray(files) || !files.length) {
      return res.status(400).json({ status: 'error', message: 'case_id and files array are required' });
    }
 
    // Respond first, then handle side effects
    res.json({ status: 'success', message: 'Notification received. Thank you!' });
 
    // ── Side effects (non-blocking) ──────────────────────
 
    // Fetch case info for the email
    const [[caseRow]] = await req.db.query(
      `SELECT c.case_id, c.case_dropbox,
              COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_display
       FROM cases c
       WHERE c.case_id = ?`,
      [case_id]
    );
    if (!caseRow) return; // case vanished — nothing to notify about
 
    // Get primary client name
    const [[primary]] = await req.db.query(
      `SELECT co.contact_fname, co.contact_lname, co.contact_name
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
       WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
       LIMIT 1`,
      [case_id]
    );
    const clientName = primary?.contact_name || 'Unknown client';
 
    // Build file list for email
    const fileListHtml = files.map(f => `<li>${f}</li>`).join('\n');
    const dropboxLink = caseRow.case_dropbox || '';
    const commentBlock = comment
      ? `<p><strong>Client comment:</strong> ${comment}</p>`
      : '';
 
    const subject = `New Documents Uploaded — ${clientName} (${caseRow.case_display})`;
    const html = `
      <p><strong>${clientName}</strong> uploaded <strong>${files.length}</strong> document${files.length > 1 ? 's' : ''} to case <strong>${caseRow.case_display}</strong>.</p>
 
      <p><strong>Files:</strong></p>
      <ul>
        ${fileListHtml}
      </ul>
 
      ${commentBlock}
 
      ${dropboxLink
        ? `<p><a href="${dropboxLink}">Open Dropbox Folder</a> — review, rename, and move files from the "Client Uploads" subfolder.</p>`
        : '<p><em>No Dropbox link on file for this case.</em></p>'}
    `.trim();
 
    // Send notification email
    emailService.sendEmail(req.db, {
      from: 'automations@4lsg.com',
      to:   'rena@4lsg.com',
      subject,
      html
    }).catch(err => console.error('Upload notification email failed:', err.message));
 
    // Log the upload event on the case
    logService.createLogEntry(req.db, {
      type:      'docs',
      link_type: 'case',
      link_id:   case_id,
      by:        0,  // system / client action
      data:      JSON.stringify({ action: 'client_upload', files, comment: comment || null }),
      subject:   `Client uploaded ${files.length} document${files.length > 1 ? 's' : ''}`,
      direction: 'incoming'
    }).catch(err => console.error('Upload log entry failed:', err.message));
 
  } catch (err) {
    console.error('POST /api/public/upload-complete error:', err);
    // Response already sent — just log
  }
});
module.exports = router;