// routes/api.checklists.js
//
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
 * POST   /api/public/get-upload-link          rate-limited, Dropbox temp upload link
 * POST   /api/public/upload-complete          rate-limited, notifies staff + logs
 *
 * The three public routes above are UNAUTHENTICATED (case_id is the only
 * capability). Treat every value off req.body/req.params as hostile: bind it
 * into SQL, and escapeHtml() it before it reaches an email body.
 */

const express      = require('express');
const router       = express.Router();
const rateLimit    = require('express-rate-limit');
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const emailService = require('../services/emailService');
const logService   = require('../services/logService');
const uploadTarget = require('../services/uploadTargetService');
const { getSetting } = require('../services/settingsService');
const { cfg } = require('../lib/firmConfig');
const { NOTIFY_TO_KEY } = require('../services/portalDocsService');

// ─── Helpers ────────────────────────────────────────────────────

/**
 * HTML-escape a value for interpolation into notification email bodies.
 *
 * Deliberately file-local rather than imported — matches the existing repo
 * convention (services/taskService.js, services/eventService.js and
 * services/esignSendService.js each carry their own copy). Keep in sync.
 *
 * Covers text nodes AND double-quoted attribute values (both quote forms are
 * escaped), which is what the upload notification needs: case_dropbox lands
 * inside an href.
 *
 * MIME subject headers must NOT be escaped — escaping a mail header puts a
 * literal &amp; in the recipient's inbox. Only HTML bodies go through this.
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Caps on client-supplied input reaching the public upload-complete route.
// This route is UNAUTHENTICATED — everything in req.body is hostile until
// proven otherwise, and unbounded strings would land in a staff inbox and
// the log table verbatim.
const MAX_UPLOAD_FILES    = 50;
const MAX_UPLOAD_FILENAME = 255;
const MAX_UPLOAD_COMMENT  = 2000;

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
 
    // Sanitize: public callers must not steer the Dropbox path. Strip path
    // separators and leading dots; '..' without a separator is just a filename.
    const safeFilename =
      String(filename).replace(/[\/\\]/g, '_').replace(/^\.+/, '').slice(0, 200)
      || 'upload.dat';
 
    // Upload-target ladder (services/uploadTargetService.js): the case's
    // Dropbox folder → auto-created folder → unsorted client-uploads folder.
    // A client always has a way to upload; the old "No Dropbox folder linked
    // to this case" dead end is gone. Total failure (Dropbox unreachable)
    // throws into the catch-all 500 below.
    let link;
    try {
      ({ link } = await uploadTarget.issueClientUploadLink(req.db, {
        caseId: case_id,
        filename: safeFilename,
      }));
    } catch (err) {
      if (err.code === 'CASE_NOT_FOUND') {
        return res.status(404).json({ status: 'error', message: 'Case not found' });
      }
      throw err;
    }

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
 
    // Normalise client input ONCE, before it reaches the email or the log.
    // Non-string array entries are coerced (a client can POST anything).
    // Caps applied silently — the true file count is kept for the headline.
    const fileCount   = files.length;
    const safeFiles   = files
      .slice(0, MAX_UPLOAD_FILES)
      .map(f => String(f ?? '').slice(0, MAX_UPLOAD_FILENAME));
    const omittedCount = fileCount - safeFiles.length;
    const safeComment = comment == null ? '' : String(comment).slice(0, MAX_UPLOAD_COMMENT);
 
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
 
    // Where did the batch land? Re-derived server-side — nothing trustworthy
    // travels from link issuance through the client (see uploadTargetService,
    // complete-time inspection). Null (case vanished) already handled above;
    // an inspection ERROR degrades to the legacy wording below.
    let dest = null;
    try {
      dest = await uploadTarget.inspectUploadDestination(req.db, case_id);
    } catch (e) {
      console.warn('Upload destination inspection failed:', e.message);
    }

    // Build file list for email. EVERY interpolated value is escaped: the
    // filenames and comment are attacker-controlled (public route), and the
    // DB-derived values are escaped as defence in depth — case_dropbox in
    // particular sits inside an href, where an unescaped quote breaks out of
    // the attribute.
    const fileListHtml = safeFiles.map(f => `<li>${escapeHtml(f)}</li>`).join('\n');
    const omittedHtml = omittedCount > 0
      ? `\n        <li><em>… and ${omittedCount} more file${omittedCount > 1 ? 's' : ''} not listed</em></li>`
      : '';
    const commentBlock = safeComment
      ? `<p><strong>Client comment:</strong> ${escapeHtml(safeComment)}</p>`
      : '';

    // Placement-aware Dropbox paragraph. Unsorted placement gets a loud note
    // + a staff task (below); dest === null (inspection error) degrades to
    // the legacy case_dropbox wording.
    let dropboxHtml;
    if (dest && dest.placement === 'unsorted') {
      const where = dest.link
        ? `<a href="${escapeHtml(dest.link)}">unsorted client uploads folder</a>`
        : `unsorted client uploads folder (<code>${escapeHtml(dest.path)}</code>)`;
      dropboxHtml =
        `<p><strong>Note:</strong> this case has no working Dropbox folder — the files were ` +
        `placed in the ${where}. Please move them into the case's folder.</p>`;
    } else {
      const dropboxLink = (dest && dest.sharedLink) || caseRow.case_dropbox || '';
      dropboxHtml = dropboxLink
        ? `<p><a href="${escapeHtml(dropboxLink)}">Open Dropbox Folder</a> — review, rename, and move files from the "Client Uploads" subfolder.</p>`
        : '<p><em>No Dropbox link on file for this case.</em></p>';
    }
 
    // Subject is a MIME header, not HTML — deliberately NOT escaped
    // (matches services/taskService.js convention).
    const subject = `New Documents Uploaded — ${clientName} (${caseRow.case_display})`;
    const html = `
      <p><strong>${escapeHtml(clientName)}</strong> uploaded <strong>${fileCount}</strong> document${fileCount > 1 ? 's' : ''} to case <strong>${escapeHtml(caseRow.case_display)}</strong>.</p>
 
      <p><strong>Files:</strong></p>
      <ul>
        ${fileListHtml}${omittedHtml}
      </ul>
 
      ${commentBlock}
 
      ${dropboxHtml}
    `.trim();
 
    // Recipient from app_settings — the SAME key the portal flow reads
    // (services/portalDocsService.js NOTIFY_TO_KEY), so editing the setting
    // retargets BOTH upload surfaces. Sender = the firm-wide automations
    // address (cfg('email_automations'), AUTO_EMAIL env fallback — the
    // taskService / featureRequests / auth.password convention).
    // Blank/missing recipient ⇒ email skipped with a warning (the case-log
    // entry below still writes) — deliberate staff off-switch semantics.
    let notifyTo = '';
    try {
      notifyTo = String((await getSetting(req.db, NOTIFY_TO_KEY)) ?? '').trim();
    } catch (e) {
      console.error('Upload notification settings read failed — email skipped:', e.message);
    }
    if (notifyTo) {
      emailService.sendEmail(req.db, {
        from: cfg('email_automations') || 'automations@4lsg.com',
        to:   notifyTo,
        subject,
        html
      }).catch(err => console.error('Upload notification email failed:', err.message));
    } else {
      console.warn(
        `Upload notification email skipped — ${NOTIFY_TO_KEY} unset or blank ` +
        `(blank = notifications off)`
      );
    }

    // Unsorted placement is easy to lose in an inbox — raise a staff task
    // (best-effort, self-caught in the service) so the files get moved.
    if (dest && dest.placement === 'unsorted') {
      uploadTarget.raiseUnsortedUploadTask(req.db, {
        caseId:     case_id,
        clientName,
        fileCount,
        path:       dest.path,
        link:       dest.link,
      });
    }
 
    // Log the upload event on the case
    logService.createLogEntry(req.db, {
      type:      'docs',
      link_type: 'case',
      link_id:   case_id,
      by:        0,  // system / client action
      data:      JSON.stringify({
        action:     'client_upload',
        files:      safeFiles,
        file_count: fileCount,
        comment:    safeComment || null
      }),
      subject:   `Client uploaded ${fileCount} document${fileCount > 1 ? 's' : ''}`,
      direction: 'incoming'
    }).catch(err => console.error('Upload log entry failed:', err.message));
 
  } catch (err) {
    console.error('POST /api/public/upload-complete error:', err);
    // Response already sent — just log
  }
});
module.exports = router;