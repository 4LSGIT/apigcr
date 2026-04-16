/**
 * Users, Judges, Trustees API
 * routes/api.users.js
 *
 * GET /api/users/me       current user (full row, sensitive fields stripped)
 * GET /api/users          list all users (stripped of sensitive fields)
 * GET /api/users/:id      single user (stripped)
 * GET /api/judges         list all judges
 * GET /api/trustees       list all trustees
 *
 * These are read-only reference endpoints for populating dropdowns
 * (assigned_to, appt_with, case_judge, case_trustee, etc.)
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
              user_initials, user_auth, user_type, email, phone, allow_sms
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