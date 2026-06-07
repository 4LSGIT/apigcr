// routes/api.appSettings.js
//
/**
 * App Settings API (user-facing settings editor)
 * ----------------------------------------------
 * GET /api/app-settings        — rows where is_editable = 1 AND is_secret = 0
 * PUT /api/app-settings/:key   — update value of an existing editable row
 *
 * Consumed by public/settings.html (the Settings tab iframe).
 *
 * Gates:
 *   - is_secret = 1 rows are NEVER returned or writable through this route,
 *     regardless of is_editable. (Belt-and-suspenders: a fat-fingered
 *     is_editable=1 on a secret still can't leak it.)
 *   - PUT only updates rows that already exist with is_editable = 1.
 *     There is no insert path — new keys are created via the DB console.
 *   - Keys are never renamed or deleted through this route.
 *
 * WHITESPACE INVARIANT:
 *   Values are stored VERBATIM. Never trim, collapse, or normalize whitespace.
 *   Some settings carry load-bearing leading/trailing spaces (e.g. Dropbox
 *   folder-name padding used for manual sort ordering).
 *
 * TODO: audit-log writes (old value -> new value, acting user) via the
 *       upcoming jwtOrApiKey middleware logging once it lands.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// app_settings.value is TEXT (64KB). Leave headroom for multi-byte chars.
const MAX_VALUE_LEN = 60000;

// ─────────────────────────────────────────
// GET /api/app-settings
// ─────────────────────────────────────────
router.get('/api/app-settings', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT \`key\`, \`value\`, updated_at
       FROM app_settings
       WHERE is_editable = 1 AND is_secret = 0
       ORDER BY \`key\` ASC`
    );
    res.json({ status: 'success', settings: rows });
  } catch (err) {
    console.error('GET /api/app-settings error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load settings' });
  }
});

// ─────────────────────────────────────────
// PUT /api/app-settings/:key
// Body: { value: string }  — stored verbatim
// ─────────────────────────────────────────
router.put('/api/app-settings/:key', jwtOrApiKey, async (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};

  // Structured values (case_types map, event_types array) must be
  // JSON.stringify'd client-side. Refusing non-strings here prevents
  // accidental "[object Object]" writes.
  if (typeof value !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'value must be a string (JSON-stringify structured values client-side)'
    });
  }
  if (value.length > MAX_VALUE_LEN) {
    return res.status(400).json({
      status: 'error',
      message: `value exceeds maximum length of ${MAX_VALUE_LEN} characters`
    });
  }

  try {
    const [rows] = await req.db.query(
      'SELECT is_editable, is_secret FROM app_settings WHERE `key` = ?',
      [key]
    );
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Setting not found' });
    }
    if (Number(rows[0].is_editable) !== 1 || Number(rows[0].is_secret) === 1) {
      return res.status(403).json({ status: 'error', message: 'This setting is not editable' });
    }

    // TODO: audit-log this write (key, old value, new value, req.auth.userId)
    //       via the upcoming jwtOrApiKey middleware logging.

    // Stored VERBATIM — see whitespace invariant in the header comment.
    await req.db.query(
      'UPDATE app_settings SET `value` = ? WHERE `key` = ?',
      [value, key]
    );

    const [[updated]] = await req.db.query(
      'SELECT `key`, `value`, updated_at FROM app_settings WHERE `key` = ?',
      [key]
    );
    res.json({ status: 'success', setting: updated });
  } catch (err) {
    console.error(`PUT /api/app-settings/${key} error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to update setting' });
  }
});

module.exports = router;