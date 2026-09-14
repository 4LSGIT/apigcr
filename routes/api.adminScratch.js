// routes/api.adminScratch.js
//
/**
 * Scratch Browser — staff-facing READ + prune surface over `rw_scratch`.
 *
 * Why this exists alongside routes/api.scratch.js: that file is the MACHINE
 * surface (PUT/DELETE on X-Readonly-Api-Key, for AI sessions holding a ycro_
 * key), and it deliberately has no read endpoint because those callers read
 * through POST /api/readonly/sql. A browser pane has a staff JWT and no
 * readonly key, so it can use neither. Hence a separate router on the SU
 * guard chain rather than a second auth path bolted onto the machine routes —
 * the two audiences stay separate, and neither one's auth can be reached
 * through the other's URL.
 *
 * Do NOT "converge" these two files. Different auth, different audience,
 * different audit table.
 *
 *   GET    /api/admin/scratch              lean list (no values) + totals
 *   GET    /api/admin/scratch/:ns/:k       one row, full value
 *   DELETE /api/admin/scratch/:ns/:k       delete one, audited
 *
 * Auth: superuserOnlyFor('scratch') — JWT-only + SU + X-SU-Elevation step-up
 * + 60/min. API keys are refused 403 by the SU check. Scratch carries arc
 * state and worker findings across sessions, which is exactly the shape of
 * thing that should not be readable from an API key.
 *
 * Audit: deletes write an admin_audit_log row (tool='scratch') carrying the
 * key and its byte length, so a prune is reconstructable after the value is
 * gone. Reads are not audited — same posture as the rest of the SU tools.
 * (The machine routes audit to readonly_query_log instead, per key.)
 *
 * Error shape: { status:'error', message } — house standard.
 * Auto-mounts via the routes/ scan in server.js.
 */

const express = require('express');
const router = express.Router();
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');

const guard = superuserOnlyFor('scratch');

// Same shape the machine routes enforce on write, so nothing addressable
// there is unreachable here.
const NS_K_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

const errBody = (message) => ({ status: 'error', message });

const ipOf = (req) =>
  req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;

/** VARCHAR actor — same convention as tools.updated_by / system_alerts.acked_by. */
function actorOf(req) {
  return req.auth?.username || (req.auth?.userId != null ? `user:${req.auth.userId}` : null);
}

// ─── LIST (lean — never returns values) ─────────────────────────────
router.get('/api/admin/scratch', guard, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT ns,
              k,
              LENGTH(v) AS len,
              meta,
              created_at,
              updated_at,
              TIMESTAMPDIFF(DAY, updated_at, NOW()) AS age_days
         FROM rw_scratch
        ORDER BY ns, k`
    );
    const bytes = rows.reduce((n, r) => n + (Number(r.len) || 0), 0);
    res.json({
      status: 'success',
      totals: { keys: rows.length, bytes, namespaces: new Set(rows.map(r => r.ns)).size },
      keys: rows,
    });
  } catch (err) {
    console.error('GET /api/admin/scratch error:', err);
    res.status(500).json(errBody('Failed to list scratch keys'));
  }
});

// ─── GET ONE (full value) ───────────────────────────────────────────
router.get('/api/admin/scratch/:ns/:k', guard, async (req, res) => {
  const { ns, k } = req.params;
  if (!NS_K_RE.test(ns) || !NS_K_RE.test(k)) {
    return res.status(400).json(errBody('Invalid namespace or key'));
  }
  try {
    const [[row]] = await req.db.query(
      `SELECT ns, k, v, meta, created_at, updated_at, LENGTH(v) AS len
         FROM rw_scratch
        WHERE ns = ? AND k = ?`,
      [ns, k]
    );
    if (!row) return res.status(404).json(errBody('Key not found'));
    res.json({ status: 'success', entry: row });
  } catch (err) {
    console.error('GET /api/admin/scratch/:ns/:k error:', err);
    res.status(500).json(errBody('Failed to fetch scratch key'));
  }
});

// ─── DELETE ONE (audited) ───────────────────────────────────────────
router.delete('/api/admin/scratch/:ns/:k', guard, async (req, res) => {
  const { ns, k } = req.params;
  if (!NS_K_RE.test(ns) || !NS_K_RE.test(k)) {
    return res.status(400).json(errBody('Invalid namespace or key'));
  }
  try {
    // Read the length BEFORE deleting: the audit row is the only trace left
    // once the value is gone, and "how big was it" is the question you ask
    // when you wonder whether a prune lost something.
    const [[before]] = await req.db.query(
      `SELECT LENGTH(v) AS len FROM rw_scratch WHERE ns = ? AND k = ?`,
      [ns, k]
    );
    if (!before) return res.status(404).json(errBody('Key not found'));

    const [r] = await req.db.query(`DELETE FROM rw_scratch WHERE ns = ? AND k = ?`, [ns, k]);

    await auditAdminAction(req.db, {
      tool: 'scratch',
      userId: req.auth?.userId ?? null,
      username: actorOf(req),
      route: req.originalUrl,
      method: 'DELETE',
      status: 'success',
      ip: ipOf(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      details: { ns, k, bytes: Number(before.len) || 0 },
    }).catch(err => console.error('[adminScratch] audit failed:', err.message));

    res.json({ status: 'success', deleted: r.affectedRows });
  } catch (err) {
    console.error('DELETE /api/admin/scratch/:ns/:k error:', err);
    res.status(500).json(errBody('Failed to delete scratch key'));
  }
});

module.exports = router;
