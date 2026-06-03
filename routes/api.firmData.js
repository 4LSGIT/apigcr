// routes/api.firmData.js
//
/**
 * Firm Data API
 * routes/api.firmdata.js
 *
 * GET /api/firm-data   unified endpoint returning all firm-wide lookup data
 *
 * Returns:
 *   currentUser  — full row (stripped of sensitive fields) for the JWT user
 *   phoneLines   — active phone lines
 *   emailFrom    — email sender addresses
 *   users        — active staff users (user_type = true)
 *   settings     — frontend settings map: every app_settings row keyed 'fe-*'
 *                  (prefix stripped, value JSON-parsed, raw-string fallback)
 *
 * This replaces the need for separate calls to:
 *   GET /api/phone-lines
 *   GET /api/email-from
 *   GET /api/users/me
 *   GET /api/users (filtered)
 * Those individual routes still work — switch consumers at your own pace.
 *
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// Fields to strip from the current user response
const USER_STRIP = ['password', 'password_hash', 'reset_token', 'reset_expires'];

function stripUser(row) {
  if (!row) return row;
  const clean = { ...row };
  for (const f of USER_STRIP) delete clean[f];
  return clean;
}

router.get('/api/firm-data', jwtOrApiKey, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const [
      [meRows],
      [lines],
      [emails],
      [users],
      [settingsRows]
    ] = await Promise.all([
      req.db.query('SELECT * FROM users WHERE user = ?', [userId]),
      req.db.query(
        `SELECT id, phone_number, display_name, provider, mms_capable
         FROM phone_lines
         WHERE active = 1
         ORDER BY display_name DESC`
      ),
      req.db.query(
        `SELECT id, email, from_name, provider
         FROM email_credentials
         ORDER BY id`
      ),
      req.db.query(
        `SELECT user, user_name, user_fname, user_lname, user_initials,
         user_type, does_appts
         FROM users
         ORDER BY user_name ASC`
      ),
      // Frontend-destined settings: any app_settings row whose key starts with
      // 'fe-'. New client settings need NO backend change — just add a row.
      // ('fe-%' uses a hyphen on purpose: in LIKE, '_' is a single-char
      //  wildcard, so 'fe_%' would also match 'feature…'. The hyphen has no
      //  wildcard meaning and matches the literal prefix.)
      req.db.query(
        "SELECT `key`, `value` FROM app_settings WHERE `key` LIKE 'fe-%'"
      )
    ]);

    const currentUser = meRows[0] ? stripUser(meRows[0]) : null;

    // Build the settings map: strip the 'fe-' prefix and JSON-parse each value
    // (so a row can ship an array/object/number/bool). If a value isn't valid
    // JSON it's passed through as the raw string, so plain scalars work without
    // needing to be quoted. Client reads these via window.firmData.settings.
    const settings = {};
    for (const row of settingsRows) {
      const k = row.key.slice(3); // drop 'fe-'
      let v = row.value;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { /* keep raw string */ }
      }
      settings[k] = v;
    }

    res.json({
      status: 'success',
      currentUser,
      phoneLines: lines,
      emailFrom: emails,
      users,
      settings
    });
  } catch (err) {
    console.error('GET /api/firm-data error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load firm data' });
  }
});

module.exports = router;