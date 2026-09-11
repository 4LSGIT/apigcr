// routes/api.tools.js
//
/**
 * Tools — SU-authored DB-stored tool pages (Slice 1: backend)
 * routes/api.tools.js
 *
 * Tools are internal HTML utilities stored in the `tools` table and served on
 * the app origin. They run as iframe children of the shell and use the
 * parent's apiSend (same runtime contract as public/customView.html). This is
 * DELIBERATE same-origin authored code — the security boundary is that only
 * superusers (with step-up elevation) can write the table, not that the
 * output is sandboxed. Nothing here touches the `pages` table or the
 * landing-host system, and /tool/* + /api/tools/* must stay OFF the
 * routes/pageLanding.js allowlist so they dead-end on the landing host
 * (locked in tests/apiTools.routes.test.js).
 *
 * SU management API — every route guarded superuserOnlyFor('tools')
 * (JWT-only + SU + X-SU-Elevation step-up + per-tool rate limit; API keys
 * are rejected by the SU check with 403):
 *   GET    /api/tools                     — lean list (no html) + version_count
 *   GET    /api/tools/:id                 — full row
 *   POST   /api/tools                     — create { tool_key, title?, html, status? }
 *   PATCH  /api/tools/:id                 — partial update of tool_key/title/html/status
 *   DELETE /api/tools/:id                 — delete (tool_versions cascade via FK)
 *   GET    /api/tools/:id/versions        — list (id, saved_by, saved_at, html_length)
 *   GET    /api/tools/:id/versions/:vid   — one full version
 *   POST   /api/tools/:id/restore/:vid    — copy that version's html back into the tool
 *
 * VERSIONING CONVENTION (single source of truth, do not vary):
 *   On any save (POST create or PATCH) where html is provided AND differs
 *   from the stored html, a tool_versions row is appended containing the NEW
 *   html — so tool_versions is the complete save history (v1 = the html the
 *   tool was created with; the newest row always equals tools.html), and
 *   restore is literally "copy row N back". A title/status-only PATCH
 *   appends nothing. Restore goes through the same rule: it appends a row
 *   with the restored html, EXCEPT when the restored html already equals the
 *   current html (a no-op restore appends nothing — no duplicate rows).
 *   The append runs after the tools write succeeds; no transaction, matching
 *   house style for sequential writes (see api.pages create-hook). A crash
 *   between the two statements loses one history row, never the tool itself.
 *
 * Actor attribution: updated_by / saved_by are VARCHAR(100) — same shape and
 * convention as system_alerts.acked_by in routes/admin.systemAlerts.js:
 * req.auth username, falling back to `user:<id>`. (The INT userId convention
 * in api.hooks/api.pages is for INT columns under jwtOrApiKey — not this.)
 *
 * Audit: create/update/delete/restore each write an admin_audit_log row with
 * tool='tools' via auditAdminAction (superuserOnlyFor only audits
 * REJECTIONS, so successful actions must be audited per-action — same
 * pattern as admin.systemAlerts.js). Reads are not audited, ditto.
 *
 * PUBLIC serve endpoint (no auth):
 *   GET /tool/:key — lowercase + validate the key, look up by tool_key,
 *   require status='live', else 404 plain text (no firm-site redirect — this
 *   is an internal utility URL, not marketing surface, so the deadPage
 *   treatment in pageLanding.js would be wrong here). Serves
 *   200 text/html; charset=utf-8, Cache-Control: no-cache,
 *   X-Robots-Tag: noindex, nofollow. Two-segment path, so the
 *   single-segment GET /:page static catch-all in server.js never
 *   intercepts it (same reasoning as /p/:slug).
 *
 * Error shape: { status:'error', message } — house standard (api.pages).
 * Auto-mounts via the routes/ scan in server.js.
 */

const express = require('express');
const router = express.Router();
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');

const guard = superuserOnlyFor('tools');

const TOOL_KEY_RE = /^[a-z0-9-]{1,80}$/;
const STATUSES = new Set(['draft', 'live']);

const LEAN_COLS = 't.id, t.tool_key, t.title, t.status, t.updated_by, t.updated_at';
const FULL_COLS = 'id, tool_key, title, status, html, updated_by, created_at, updated_at';

function errBody(msg) {
  return { status: 'error', message: msg };
}

/** VARCHAR(100) actor — same convention as system_alerts.acked_by. */
function actorOf(req) {
  return (
    req.auth?.username ||
    (req.auth?.userId != null ? `user:${req.auth.userId}` : null)
  );
}

const ipOf = (req) =>
  req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;

async function audit(req, action, details, status = 'ok', errorMessage = null) {
  try {
    await auditAdminAction(req.db, {
      tool: 'tools',
      userId: req.auth?.userId,
      username: req.auth?.username,
      route: req.originalUrl,
      method: req.method,
      status,
      errorMessage,
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
      details: { action, ...details },
    });
  } catch (e) {
    console.error('tools audit failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Validation (mirrors services/pageService.validatePayload style)
// ─────────────────────────────────────────────────────────────

/**
 * Validate + normalize a create/update payload. `partial = true` for PATCH
 * semantics (only validate present keys). Throws Error with .status = 400.
 * tool_key is LOWERCASED before validation, so mixed-case input normalizes
 * rather than rejects.
 */
function validatePayload(body, { partial = false } = {}) {
  const out = {};
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
  const has = (k) => body[k] !== undefined;

  if (!partial || has('tool_key')) {
    const key = String(body.tool_key || '').trim().toLowerCase();
    if (!TOOL_KEY_RE.test(key)) bad('tool_key is required and must match ^[a-z0-9-]{1,80}$');
    out.tool_key = key;
  }

  if (!partial || has('html')) {
    if (typeof body.html !== 'string' || body.html.trim() === '') {
      bad('html is required and must be a non-empty string');
    }
    out.html = body.html;
  }

  if (has('title')) {
    const t = body.title == null ? '' : String(body.title).trim();
    if (t.length > 200) bad('title too long (max 200)');
    out.title = t;
  }

  if (has('status')) {
    const status = String(body.status || '').trim();
    if (!STATUSES.has(status)) bad("status must be 'draft' or 'live'");
    out.status = status;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

async function getTool(db, id) {
  const [[row]] = await db.query(`SELECT ${FULL_COLS} FROM tools WHERE id = ?`, [id]);
  return row || null;
}

/** Append one save-history row (the NEW html — see convention above). */
async function appendVersion(db, toolId, html, actor) {
  await db.query(
    `INSERT INTO tool_versions (tool_id, html, saved_by) VALUES (?, ?, ?)`,
    [toolId, html, actor]
  );
}

// ─────────────────────────────────────────────────────────────
// SU management API
// ─────────────────────────────────────────────────────────────

// LIST (lean — no html) + version count
router.get('/api/tools', guard, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT ${LEAN_COLS},
              (SELECT COUNT(*) FROM tool_versions v WHERE v.tool_id = t.id) AS version_count
         FROM tools t
        ORDER BY t.updated_at DESC, t.id DESC`
    );
    res.json({ status: 'success', tools: rows });
  } catch (err) {
    console.error('GET /api/tools error:', err);
    res.status(500).json(errBody('Failed to list tools'));
  }
});

// GET ONE (full, including html)
router.get('/api/tools/:id', guard, async (req, res) => {
  try {
    const tool = await getTool(req.db, req.params.id);
    if (!tool) return res.status(404).json(errBody('Tool not found'));
    res.json({ status: 'success', tool });
  } catch (err) {
    console.error('GET /api/tools/:id error:', err);
    res.status(500).json(errBody('Failed to fetch tool'));
  }
});

// CREATE — appends version row v1 (the created html)
router.post('/api/tools', guard, async (req, res) => {
  try {
    const data = validatePayload(req.body || {}, { partial: false });
    if (data.title === undefined) data.title = '';
    if (data.status === undefined) data.status = 'draft';
    const actor = actorOf(req);
    data.updated_by = actor;

    const [r] = await req.db.query(`INSERT INTO tools SET ?`, [data]);
    await appendVersion(req.db, r.insertId, data.html, actor);

    const tool = await getTool(req.db, r.insertId);
    await audit(req, 'create', { tool_id: r.insertId, tool_key: data.tool_key, status: data.status });
    res.json({ status: 'success', tool });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('A tool with this tool_key already exists'));
    }
    if (err.status === 400) return res.status(400).json(errBody(err.message));
    console.error('POST /api/tools error:', err);
    res.status(500).json(errBody('Failed to create tool'));
  }
});

// UPDATE (partial) — appends a version row only when html is provided and differs
router.patch('/api/tools/:id', guard, async (req, res) => {
  try {
    const existing = await getTool(req.db, req.params.id);
    if (!existing) return res.status(404).json(errBody('Tool not found'));

    const data = validatePayload(req.body || {}, { partial: true });
    if (!Object.keys(data).length) {
      return res.status(400).json(errBody('No updatable fields provided'));
    }
    const actor = actorOf(req);
    data.updated_by = actor;

    const htmlChanged = data.html !== undefined && data.html !== existing.html;

    await req.db.query(`UPDATE tools SET ? WHERE id = ?`, [data, existing.id]);
    if (htmlChanged) await appendVersion(req.db, existing.id, data.html, actor);

    const tool = await getTool(req.db, existing.id);
    await audit(req, 'update', {
      tool_id: existing.id,
      fields: Object.keys(data).filter((k) => k !== 'updated_by'),
      html_changed: htmlChanged,
    });
    res.json({ status: 'success', tool });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('A tool with this tool_key already exists'));
    }
    if (err.status === 400) return res.status(400).json(errBody(err.message));
    console.error('PATCH /api/tools/:id error:', err);
    res.status(500).json(errBody('Failed to update tool'));
  }
});

// DELETE — tool_versions rows cascade via fk_tool_versions_tool
router.delete('/api/tools/:id', guard, async (req, res) => {
  try {
    const existing = await getTool(req.db, req.params.id);
    if (!existing) return res.status(404).json(errBody('Tool not found'));

    await req.db.query(`DELETE FROM tools WHERE id = ?`, [existing.id]);
    await audit(req, 'delete', { tool_id: existing.id, tool_key: existing.tool_key });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/tools/:id error:', err);
    res.status(500).json(errBody('Failed to delete tool'));
  }
});

// VERSIONS — list (no full html; length only), newest first
router.get('/api/tools/:id/versions', guard, async (req, res) => {
  try {
    const tool = await getTool(req.db, req.params.id);
    if (!tool) return res.status(404).json(errBody('Tool not found'));

    const [rows] = await req.db.query(
      `SELECT id, saved_by, saved_at, CHAR_LENGTH(html) AS html_length
         FROM tool_versions
        WHERE tool_id = ?
        ORDER BY id DESC`,
      [tool.id]
    );
    res.json({ status: 'success', versions: rows });
  } catch (err) {
    console.error('GET /api/tools/:id/versions error:', err);
    res.status(500).json(errBody('Failed to list versions'));
  }
});

// VERSIONS — one full version (scoped to the tool: a vid belonging to a
// different tool is a 404, not a leak)
router.get('/api/tools/:id/versions/:vid', guard, async (req, res) => {
  try {
    const [[row]] = await req.db.query(
      `SELECT id, tool_id, html, saved_by, saved_at
         FROM tool_versions
        WHERE id = ? AND tool_id = ?`,
      [req.params.vid, req.params.id]
    );
    if (!row) return res.status(404).json(errBody('Version not found'));
    res.json({ status: 'success', version: row });
  } catch (err) {
    console.error('GET /api/tools/:id/versions/:vid error:', err);
    res.status(500).json(errBody('Failed to fetch version'));
  }
});

// RESTORE — copy a version's html back into the tool. Appends a new version
// row (the restored html) per the convention above, except a no-op restore
// (version html === current html) which changes nothing and appends nothing.
router.post('/api/tools/:id/restore/:vid', guard, async (req, res) => {
  try {
    const existing = await getTool(req.db, req.params.id);
    if (!existing) return res.status(404).json(errBody('Tool not found'));

    const [[ver]] = await req.db.query(
      `SELECT id, tool_id, html FROM tool_versions WHERE id = ? AND tool_id = ?`,
      [req.params.vid, existing.id]
    );
    if (!ver) return res.status(404).json(errBody('Version not found'));

    const actor = actorOf(req);
    const changed = ver.html !== existing.html;
    if (changed) {
      await req.db.query(
        `UPDATE tools SET ? WHERE id = ?`,
        [{ html: ver.html, updated_by: actor }, existing.id]
      );
      await appendVersion(req.db, existing.id, ver.html, actor);
    }

    const tool = await getTool(req.db, existing.id);
    await audit(req, 'restore', { tool_id: existing.id, version_id: ver.id, changed });
    res.json({ status: 'success', tool });
  } catch (err) {
    console.error('POST /api/tools/:id/restore/:vid error:', err);
    res.status(500).json(errBody('Failed to restore version'));
  }
});

// ─────────────────────────────────────────────────────────────
// Public serve endpoint — GET /tool/:key (no auth)
// ─────────────────────────────────────────────────────────────

router.get('/tool/:key', async (req, res) => {
  try {
    const key = String(req.params.key || '').trim().toLowerCase();
    if (!TOOL_KEY_RE.test(key)) {
      return res.status(404).type('text').send('Not found');
    }
    const [[tool]] = await req.db.query(
      `SELECT html, status FROM tools WHERE tool_key = ? LIMIT 1`,
      [key]
    );
    if (!tool || tool.status !== 'live') {
      return res.status(404).type('text').send('Not found');
    }
    return res.status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-cache')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send(tool.html);
  } catch (err) {
    console.error('GET /tool/:key error:', err);
    return res.status(500).type('text').send('Server error');
  }
});

module.exports = router;
