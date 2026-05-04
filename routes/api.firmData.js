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
      [users]
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
      )
    ]);

    const currentUser = meRows[0] ? stripUser(meRows[0]) : null;

    res.json({
      status: 'success',
      currentUser,
      phoneLines: lines,
      emailFrom: emails,
      users
    });
  } catch (err) {
    console.error('GET /api/firm-data error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load firm data' });
  }
});

module.exports = router;