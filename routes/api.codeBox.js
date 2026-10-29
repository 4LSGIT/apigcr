// routes/api.codeBox.js
/**
 * POST /api/code-box/runs — the Code dialog's audit row (public/js/ycCodeBox.js).
 *
 * The dialog runs a staff member's pasted JavaScript in the shell, as them —
 * no more than the browser console already lets them do. Every request the
 * snippet makes is already in jwt_api_audit_log; what is NOT is the snippet
 * itself, nor anything it does that never reaches this server (reading the
 * session token and sending it elsewhere). So the dialog posts the code here
 * BEFORE it runs it, and runs nothing unless this answers success: one
 * admin_audit_log row per run (tool 'code_box', details.code).
 *
 * Gate: any staff JWT (requireAuth staff; no API keys — only the browser
 * dialog calls this). Allowed in read-only View-as (markViewAsControl): the
 * row records a run, it changes no data, and the snippet's own writes are
 * still refused by every other route. Under View-as the row names the REAL
 * actor as the user and the View-as target in details (target_user_id /
 * target_username), the way the view_as rows do (routes/api.impersonation.js).
 *
 * Awaited, not fire-and-forget: a run the audit could not record does not
 * happen (the dialog fails closed on any non-success answer).
 *
 * POST /api/code-box/runs/:id/finish records browser-reported success/error
 * and elapsed milliseconds on that same row (no console output or result).
 * A row left at 'run' has no received outcome; it does not prove a failure.
 *
 * What a row proves: the dialog recorded this code before running it. Not
 * the reverse — anyone may POST here without running anything, and code run
 * in the real browser console leaves no row at all.
 */

const express = require('express');
const router = express.Router();
const requireAuth = require('../lib/auth.requireAuth');
const { markViewAsControl } = require('../lib/auth.impersonation');
const { auditAdminAction } = require('../lib/auth.superuser');
const { getClientIp } = require('../lib/rateLimiter');

const TOOL = 'code_box';      // admin_audit_log tag
const CODE_MAX = 65536;       // characters; public/js/ycCodeBox.js CODE_MAX

router.post('/api/code-box/runs', markViewAsControl, requireAuth({ audience: 'staff' }), async (req, res) => {
  const code = req.body && req.body.code;
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ status: 'error', message: 'code must be a non-empty string' });
  }
  if (code.length > CODE_MAX) {
    return res.status(400).json({ status: 'error', message: `code is longer than ${CODE_MAX} characters` });
  }
  const actor = req.auth.impersonator || null;   // View-as: the real person at the keyboard
  try {
    const [result] = await auditAdminAction(req.db, {
      tool: TOOL,
      userId: actor ? actor.userId : req.auth.userId,
      username: actor ? actor.username : req.auth.username,
      route: req.originalUrl,
      method: req.method,
      status: 'run',
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      details: {
        code,
        ...(actor ? { target_user_id: req.auth.userId, target_username: req.auth.username } : {}),
      },
    });
    return res.json({ status: 'success', run_id: result.insertId });
  } catch (err) {
    console.error('[api.codeBox] audit write failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'The run could not be recorded' });
  }
});

// A browser-reported outcome, not proof of execution. Only the same real
// actor AND effective user may finish an initial row, and only once. Keep
// the code and original receipt timestamp; never store console/result data.
router.post('/api/code-box/runs/:id/finish', markViewAsControl, requireAuth({ audience: 'staff' }), async (req, res) => {
  const id = Number(req.params.id);
  const { status, duration_ms: duration } = req.body || {};
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)
      || !['success', 'error'].includes(status)
      || !Number.isInteger(duration) || duration < 0 || duration > 2147483647) {
    return res.status(400).json({ status: 'error', message: 'Invalid run outcome' });
  }
  const actor = req.auth.impersonator || req.auth;
  try {
    const [result] = await req.db.query(`
      UPDATE admin_audit_log SET status = ?, duration_ms = ?
      WHERE id = ? AND tool = ? AND status = 'run' AND user_id = ?
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(details, '$.target_user_id')), user_id) = ?
    `, [status, duration, id, TOOL, actor.userId, req.auth.userId]);
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', message: 'Pending run not found' });
    }
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('[api.codeBox] outcome write failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'The outcome could not be recorded' });
  }
});

module.exports = router;
module.exports.CODE_MAX = CODE_MAX;
