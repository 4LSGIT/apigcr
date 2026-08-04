// routes/api.mySignatures.js
//
/**
 * Self-service email signature editing (Settings → Email Signature).
 *
 *   GET /api/me/signatures       — sender rows the current user OWNS
 *   PUT /api/me/signatures/:id   — update signature on an owned row
 *
 * OWNERSHIP MODEL — why not "the row matching my default_email":
 * users can set their own default_email in Settings (it's just a picker
 * preselect), so anchoring edit rights to it would let anyone point their
 * default at stuart@4lsg.com and rewrite the lead attorney's signature.
 * Instead, email_credentials.owner_user is assigned by a superuser in
 * Connections → Email Senders. One user may own several rows (e.g. a
 * personal address plus a shared billing box); rows with NULL owner
 * (automated senders) are editable by nobody here — admin only.
 *
 * The :id in PUT is convenience, not authority: the row is fetched by id
 * AND owner_user = current user. Auth is jwtOrApiKey (any logged-in user);
 * scoping does the access control.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction } = require('../lib/auth.superuser');
const {
  validateSignatures, coerceSignature, summarizeForAudit,
} = require('../lib/signatureValidation');

const TOOL = 'my_signatures';

// ── GET /api/me/signatures ───────────────────────────────────────────────────
router.get('/api/me/signatures', jwtOrApiKey, async (req, res) => {
  try {
    const userId = req.auth.userId;
    // API-key auth carries no user identity — "my" signatures is undefined.
    if (!userId) {
      return res.status(403).json({ status: 'error', message: 'User session required' });
    }
    const [rows] = await req.db.query(
      `SELECT id, email, from_name, signature_html, signature_text
       FROM email_credentials
       WHERE owner_user = ?
       ORDER BY id`,
      [userId]
    );
    // default_email helps the UI phrase the empty state ("your sending
    // address X isn't assigned to you yet") without another round trip.
    const [[me]] = await req.db.query(
      'SELECT default_email FROM users WHERE user = ?',
      [userId]
    );
    res.json({
      status: 'success',
      signatures: rows,
      default_email: me ? me.default_email : null,
    });
  } catch (err) {
    console.error('GET /api/me/signatures error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load signatures' });
  }
});

// ── PUT /api/me/signatures/:id ───────────────────────────────────────────────
router.put('/api/me/signatures/:id', jwtOrApiKey, async (req, res) => {
  const started = Date.now();
  const userId = req.auth.userId;
  const id = Number(req.params.id);

  if (!userId) {
    return res.status(403).json({ status: 'error', message: 'User session required' });
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid id' });
  }

  const sigErr = validateSignatures(req.body);
  if (sigErr) {
    return res.status(400).json({ status: 'error', message: sigErr });
  }
  // Both fields are required keys on this endpoint (may be blank/null —
  // that CLEARS the signature). Requiring the keys keeps the semantics
  // "this is the full new state", not a partial patch.
  if (!('signature_html' in req.body) || !('signature_text' in req.body)) {
    return res.status(400).json({
      status: 'error',
      message: 'signature_html and signature_text are both required (empty string clears)',
    });
  }

  try {
    // Ownership check and current values in one read.
    const [[row]] = await req.db.query(
      `SELECT id, email, signature_html, signature_text
       FROM email_credentials
       WHERE id = ? AND owner_user = ?
       LIMIT 1`,
      [id, userId]
    );
    if (!row) {
      // 404 (not 403) on purpose: don't confirm that the id exists.
      return res.status(404).json({ status: 'error', message: 'Sender not found or not yours' });
    }

    const html = coerceSignature(req.body.signature_html);
    const text = coerceSignature(req.body.signature_text);

    await req.db.query(
      'UPDATE email_credentials SET signature_html = ?, signature_text = ? WHERE id = ?',
      [html, text, id]
    );

    await auditAdminAction(req.db, {
      tool: TOOL,
      userId,
      username: req.auth.username ?? null,
      route: `/api/me/signatures/${id}`,
      method: 'PUT',
      status: 200,
      durationMs: Date.now() - started,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      details: {
        credential_id: id,
        email: row.email,
        signature_html: { from: summarizeForAudit(row.signature_html), to: summarizeForAudit(html) },
        signature_text: { from: summarizeForAudit(row.signature_text), to: summarizeForAudit(text) },
      },
    });

    res.json({
      status: 'success',
      signature: { id, email: row.email, signature_html: html, signature_text: text },
    });
  } catch (err) {
    console.error('PUT /api/me/signatures/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to save signature' });
  }
});

module.exports = router;
