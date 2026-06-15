// routes/api.users.js
//
/**
 * Users, Judges, Trustees API
 * routes/api.users.js
 *
 * GET   /api/users/me                          current user (full row, sensitive fields stripped)
 * GET   /api/users                             list all users (stripped of sensitive fields)
 * GET   /api/users/:id                         single user (stripped)
 * PATCH /api/users/:id/freebusy-calendars      set provider freebusy_calendar_ids (scheduler phase 2)
 * GET   /api/judges                            list all judges
 * GET   /api/trustees                          list all trustees
 *
 * The GETs are read-only reference endpoints for populating dropdowns
 * (assigned_to, appt_with, case_judge, case_trustee, etc.). The freebusy
 * PATCH is the lone writer here — it backs the scheduler settings UI.
 *
 * NOTE: /api/users/me MUST be registered before /api/users/:id
 * so Express doesn't treat "me" as an :id param.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// Fields to strip from user responses
const USER_STRIP = ['password', 'password_hash', 'reset_token', 'reset_expires'];

function stripUser(row) {
  if (!row) return row;
  const clean = { ...row };
  for (const f of USER_STRIP) delete clean[f];
  return clean;
}

// ─── CURRENT USER (must be before /:id) ───

router.get('/api/users/me', jwtOrApiKey, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const [[user]] = await req.db.query(
      'SELECT * FROM users WHERE user = ?',
      [userId]
    );
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', user: stripUser(user) });
  } catch (err) {
    console.error('GET /api/users/me error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user' });
  }
});

// ─── USERS ───

router.get('/api/users', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT user, username, user_name, user_fname, user_lname,
              user_initials, user_auth, user_type, email, phone, allow_sms,
              does_appts, freebusy_calendar_ids
       FROM users
       ORDER BY user_name ASC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch users' });
  }
});

router.get('/api/users/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [[user]] = await req.db.query(
      'SELECT * FROM users WHERE user = ?',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ data: stripUser(user) });
  } catch (err) {
    console.error('GET /api/users/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user' });
  }
});

// ─── FREEBUSY CALENDARS (scheduler phase 2) ───
//
// PATCH /api/users/:id/freebusy-calendars
// Body: { calendar_ids: string[] }  — Google calendar id strings whose TIMED
// events block this provider's booking availability (read live via freeBusy).
// Stored as a native json array. Empty array / [] clears it (feature off for
// that user). mysql2 json hazard: JSON.stringify on write.
router.patch('/api/users/:id/freebusy-calendars', jwtOrApiKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid user id' });
  }
  let { calendar_ids } = req.body || {};
  if (!Array.isArray(calendar_ids)) {
    return res.status(400).json({ status: 'error', message: 'calendar_ids must be an array of strings' });
  }
  // Normalize: trim, drop blanks, dedupe, coerce to strings.
  const clean = [...new Set(
    calendar_ids.map(x => String(x == null ? '' : x).trim()).filter(Boolean)
  )];

  try {
    const [r] = await req.db.query(
      'UPDATE users SET freebusy_calendar_ids = ? WHERE user = ?',
      [JSON.stringify(clean), id]   // json column — stringify on write
    );
    if (!r.affectedRows) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success', user: id, freebusy_calendar_ids: clean });
  } catch (err) {
    console.error(`PATCH /api/users/${id}/freebusy-calendars error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to update freebusy calendars' });
  }
});

// ─── JUDGES ───

router.get('/api/judges', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      'SELECT judge_id, judge_3, judge_name FROM judges ORDER BY judge_name ASC'
    );
    res.json({ judges: rows });
  } catch (err) {
    console.error('GET /api/judges error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch judges' });
  }
});

// ─── TRUSTEES ───

router.get('/api/trustees', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT trustee_id, trustee_full_name, trustee_lname,
              trustee_case_type, trustee_email, trustee_phone
       FROM trustees
       ORDER BY trustee_full_name ASC`
    );
    res.json({ trustees: rows });
  } catch (err) {
    console.error('GET /api/trustees error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch trustees' });
  }
});

module.exports = router;