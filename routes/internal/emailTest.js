/**
 * Internal Email Test Route — Slice 1 diagnostic only.
 *
 *   GET  /internal/email-test/credentials
 *        List email_credentials rows (smtp_pass omitted).
 *
 *   POST /internal/email-test/send
 *        Body: {
 *          from_id,         // email_credentials.id
 *          to,              // string or string[]
 *          subject,
 *          text?,
 *          html?,
 *          attachments?,    // smtp-style inline (nodemailer format)
 *          attachmentUrls?  // string | object | array — passed as attachment_urls
 *        }
 *        Maps from_id → email, then calls emailService.sendEmail.
 *        Returns { ok, result } / { ok: false, error }.
 *
 * JWT-guarded. Routes auto-mount via the routes/internal/ scan.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../../lib/auth.jwtOrApiKey');
const emailService = require('../../services/emailService');

router.get('/internal/email-test/credentials', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, email, provider, from_name, credential_id
         FROM email_credentials
         ORDER BY id`
    );
    res.json({ ok: true, credentials: rows });
  } catch (err) {
    console.error('[email-test] GET credentials failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/internal/email-test/send', jwtOrApiKey, async (req, res) => {
  const {
    from_id, to, subject, text, html,
    attachments, attachmentUrls,
  } = req.body || {};

  if (!from_id || !to || !subject) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: from_id, to, subject',
    });
  }

  try {
    const [[row]] = await req.db.query(
      'SELECT email FROM email_credentials WHERE id = ? LIMIT 1',
      [from_id]
    );
    if (!row) {
      return res.status(404).json({
        ok: false,
        error: `No email_credentials row with id=${from_id}`,
      });
    }

    const result = await emailService.sendEmail(req.db, {
      from:            row.email,
      to,
      subject,
      text,
      html,
      attachments,
      attachment_urls: attachmentUrls,   // public API is snake_case
    });

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[email-test] POST send failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;