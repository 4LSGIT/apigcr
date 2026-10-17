// routes/admin.users.js
//
/**
 * User Management — superuser-only CRUD for the `users` table.
 * Auto-mounts (routes/). UI: public/users.html (index.html → Admin tab).
 *
 *   GET   /api/admin/users                    — list all users (secrets stripped,
 *                                               has_password / has_hash / reset_pending flags)
 *   POST  /api/admin/users                    — create user (optional initial password)
 *   PATCH /api/admin/users/:id                — edit whitelisted fields (incl. user_auth, roles)
 *   POST  /api/admin/users/:id/set-password   — set/reset a user's password
 *   POST  /api/admin/users/:id/disable        — user_auth='disabled', wipe passwords + reset token
 *   POST  /api/admin/users/:id/enable         — user_auth='authorized' (password must be re-set)
 *
 * All endpoints: superuserOnlyFor('users') — JWT-only, `su` role (lib/auth.superuser),
 * rate-limited, rejections audited. All mutations write an admin_audit_log row
 * (tool='users'); password values are never logged.
 *
 * NO DELETE ENDPOINT — user rows are referenced by tasks, campaigns, logs,
 * assets, appts, etc. "Removing" a user means disabling them.
 *
 * DUAL-WRITE NOTE:
 *   Both `password` (plaintext) and `password_hash` (bcrypt) are written on
 *   create-with-password and set-password. Legacy routes (dropbox.js, db64.js,
 *   dbQuery.js, unplacehold.js) still authenticate against plaintext `password`.
 *   Lines marked with:
 *       // TODO: REMOVE when dropping plaintext password column
 *   should be deleted once all legacy routes use password_hash exclusively.
 *
 * ACCESS (ref/ACCESS_CONTROL_DESIGN.md §2.2, §2.4–2.5):
 *   user_auth is login status only:
 *     'authorized' — may log in
 *     'disabled'   — cannot log in (login requires user_auth LIKE 'authorized%')
 *   Authorization is users.roles (SET; ROLE_MEMBERS below). Accepted as an
 *   array or csv, validated against the SET, written as csv in SET order.
 *   `su` (root) changes only from an SU caller — today every caller is one
 *   (superuserOnlyFor), so that check is the backstop for the day
 *   users.manage is delegated. Nobody removes their own `su`.
 *   Role changes reach the user's JWT at their next login (24h ceiling);
 *   DB-read checks (mailbox/archive SU bypass) see them immediately.
 *
 * KNOWN LIMITATIONS:
 *   - Disabling a user does NOT invalidate a JWT they already hold; tokens are
 *     good for up to 24h (user_auth is baked into the token at login).
 *     Bumping JWT_VERSION would force it, at the cost of logging everyone out.
 *   - `users.user` is TINYINT → hard cap of 127 ids ever issued.
 *   - User 0 (automations) is protected: no PATCH / set-password / disable.
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const router  = express.Router();
const { superuserOnlyFor, auditAdminAction, isSuperuser } = require('../lib/auth.superuser');

const TOOL = 'users';
const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LEN = 4; // matches auth.password.js / auth.login.js conventions

const ALLOWED_AUTH = ['authorized', 'disabled'];

// users.roles SET members (lib/capabilities); writes are normalized to this order.
const { ROLE_MEMBERS } = require('../lib/capabilities');
const DEFAULT_ROLES = 'staff';

// Fields an SU may edit via PATCH. task_remind_freq / freebusy_calendar_ids
// deliberately excluded (own tools / DB console).
const PATCH_WHITELIST = [
  'username', 'user_fname', 'user_lname', 'user_name', 'user_real_name',
  'user_initials', 'user_auth', 'user_type', 'email', 'phone',
  'default_phone', 'default_email', 'allow_sms', 'does_appts',
  'ringcentral', 'user_gcal_id', 'roles',
];

// ── helpers ──────────────────────────────────────────────────────────────────

function reqMeta(req) {
  return {
    tool: TOOL,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(req, status, details) {
  auditAdminAction(req.db, { ...reqMeta(req), status, details })
    .catch(err => console.error('[admin.users] audit log failed:', err.message));
}

/** Normalize a phone to 10 digits or null. Returns undefined on invalid. */
function normPhone(v) {
  if (v == null || String(v).trim() === '') return null;
  const digits = String(v).replace(/\D/g, '');
  return digits.length === 10 ? digits : undefined;
}

/** users.roles csv (as mysql2 returns a SET) → array. */
function rolesOf(csv) {
  return String(csv || '').split(',').map(r => r.trim()).filter(Boolean);
}

/** Login status class: anything starting 'authorized' is 'authorized'. */
function authStatus(v) {
  return String(v || '').startsWith('authorized') ? 'authorized' : String(v || '');
}

/**
 * Parse + validate a roles value (array of names, or csv string).
 * Returns { csv } normalized to SET order, or { error }.
 */
function parseRoles(v) {
  let list;
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string') list = v.split(',');
  else return { error: 'roles must be an array or a comma-separated string' };
  const names = [];
  for (const r of list) {
    if (typeof r !== 'string') return { error: 'roles must contain role names' };
    const t = r.trim();
    if (t) names.push(t);
  }
  const bad = names.filter(r => !ROLE_MEMBERS.includes(r));
  if (bad.length) {
    return { error: `unknown role(s): ${bad.join(', ')} (allowed: ${ROLE_MEMBERS.join(', ')})` };
  }
  return { csv: ROLE_MEMBERS.filter(r => names.includes(r)).join(',') };
}

/**
 * The su rules for a roles write (design §2.2: granting root is root-grade;
 * no self-service lock-out). Pure — callers pass the caller's req.auth, the
 * target id (null on create), and the before/after csvs.
 * Returns null when allowed, else { status, message }.
 */
function roleChangeRefusal(auth, targetId, oldCsv, newCsv) {
  const hadSu = rolesOf(oldCsv).includes('su');
  const getsSu = rolesOf(newCsv).includes('su');
  if (hadSu !== getsSu && !isSuperuser(auth)) {
    return { status: 403, message: 'Only a superuser can grant or revoke the su role' };
  }
  if (targetId != null && targetId === auth?.userId && hadSu && !getsSu) {
    return { status: 400, message: 'You cannot remove your own su role' };
  }
  return null;
}

/**
 * Validate + normalize incoming user fields.
 * `fields` = raw body subset. `partial` = PATCH mode (only validate present keys).
 * Returns { ok, errors[], clean{} }.
 */
function validateFields(fields, { partial = false } = {}) {
  const errors = [];
  const clean = {};

  const has = k => Object.prototype.hasOwnProperty.call(fields, k);
  const str = k => (fields[k] == null ? '' : String(fields[k]).trim());

  // Required-on-create text fields with max lengths (column limits)
  const reqText = [
    ['username',      50],
    ['user_fname',    20],
    ['user_lname',    50],
    ['user_initials',  3],
  ];
  for (const [k, max] of reqText) {
    if (!partial || has(k)) {
      const v = str(k);
      if (!v) errors.push(`${k} is required`);
      else if (v.length > max) errors.push(`${k} exceeds ${max} characters`);
      else clean[k] = v;
    }
  }

  // Optional text fields with max lengths
  const optText = [
    ['user_name',       20],
    ['user_real_name',  64],
    ['email',           50],
    ['default_email',  255],
    ['user_gcal_id',   255],
  ];
  for (const [k, max] of optText) {
    if (!partial || has(k)) {
      const v = str(k);
      if (v.length > max) errors.push(`${k} exceeds ${max} characters`);
      else clean[k] = v || null;
    }
  }

  // Phones — char(10)
  for (const k of ['phone', 'default_phone']) {
    if (!partial || has(k)) {
      const p = normPhone(fields[k]);
      if (p === undefined) errors.push(`${k} must be 10 digits`);
      else clean[k] = p;
    }
  }

  // user_auth
  if (!partial || has('user_auth')) {
    const v = str('user_auth') || (partial ? '' : 'authorized');
    if (!ALLOWED_AUTH.includes(v)) {
      errors.push(`user_auth must be one of: ${ALLOWED_AUTH.join(', ')}`);
    } else clean.user_auth = v;
  }

  // roles — SET members; create defaults to staff
  if (!partial || has('roles')) {
    const r = has('roles') ? parseRoles(fields.roles) : { csv: DEFAULT_ROLES };
    if (r.error) errors.push(r.error);
    else clean.roles = r.csv;
  }

  // user_type — tinyint(1), default 1
  if (!partial || has('user_type')) {
    const n = has('user_type') ? Number(fields.user_type) : 1;
    if (!Number.isInteger(n) || n < 0 || n > 9) errors.push('user_type must be a small integer');
    else clean.user_type = n;
  }

  // Boolean-ish tinyints
  for (const k of ['allow_sms', 'does_appts', 'ringcentral']) {
    if (!partial || has(k)) {
      clean[k] = fields[k] ? 1 : 0;
    }
  }

  // Create-mode fallbacks (user_name / user_real_name from fname+lname)
  if (!partial && !errors.length) {
    if (!clean.user_name) {
      clean.user_name = `${clean.user_fname} ${clean.user_lname}`.slice(0, 20).trim();
    }
    if (!clean.user_real_name) {
      clean.user_real_name = `${clean.user_fname} ${clean.user_lname}`.slice(0, 64).trim();
    }
  }

  return { ok: errors.length === 0, errors, clean };
}

/** Reject bad :id params. Returns integer id or null (response already sent). */
function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ status: 'error', message: 'invalid user id' });
    return null;
  }
  if (id === 0) {
    // Automations account — managed via DB console only.
    res.status(403).json({ status: 'error', message: 'user 0 (automations) cannot be managed here' });
    return null;
  }
  return id;
}

async function usernameTaken(db, username, excludeId = null) {
  const [rows] = await db.query(
    'SELECT user FROM users WHERE username = ?' + (excludeId != null ? ' AND user != ?' : '') + ' LIMIT 1',
    excludeId != null ? [username, excludeId] : [username]
  );
  return rows.length > 0;
}

// ── GET list ─────────────────────────────────────────────────────────────────

router.get('/api/admin/users', ...superuserOnlyFor(TOOL), async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT user, username, user_name, user_real_name, user_fname, user_lname,
              user_initials, user_auth, roles, user_type, email, phone,
              default_phone, default_email, allow_sms, does_appts, ringcentral,
              user_gcal_id,
              (password IS NOT NULL)      AS has_password,
              (password_hash IS NOT NULL) AS has_hash,
              (reset_token IS NOT NULL AND reset_expires > NOW()) AS reset_pending
       FROM users
       ORDER BY user ASC`
    );
    // mysql2 returns the boolean expressions as strings/numbers — coerce.
    const users = rows.map(r => ({
      ...r,
      has_password:  !!Number(r.has_password),
      has_hash:      !!Number(r.has_hash),
      reset_pending: !!Number(r.reset_pending),
    }));
    res.json({ status: 'success', users });
  } catch (err) {
    console.error('GET /api/admin/users error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch users' });
  }
});

// ── POST create ──────────────────────────────────────────────────────────────

router.post('/api/admin/users', ...superuserOnlyFor(TOOL), async (req, res) => {
  const body = req.body || {};
  const { ok, errors, clean } = validateFields(body, { partial: false });
  if (!ok) return res.status(400).json({ status: 'error', message: errors.join('; ') });

  const refusal = roleChangeRefusal(req.auth, null, '', clean.roles);
  if (refusal) return res.status(refusal.status).json({ status: 'error', message: refusal.message });

  const password = body.password == null ? '' : String(body.password);
  if (password && password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ status: 'error', message: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }

  try {
    if (await usernameTaken(req.db, clean.username)) {
      return res.status(409).json({ status: 'error', message: `Username "${clean.username}" already exists` });
    }

    const hash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;

    // Every NOT NULL column supplied explicitly — the session sql_mode is
    // relaxed but we don't lean on implicit defaults here. One exception, on
    // purpose (ui-custom S5e-3): the retired custom-tab column is no longer
    // named, so this INSERT works before and after
    // scripts/uiCustomS5e3DropCustomTab.js drops it. Until then the relaxed
    // mode fills it with its implicit default, the JSON null scalar — what
    // this INSERT wrote explicitly before (measured on 8.4.11).
    const [r] = await req.db.query(
      `INSERT INTO users
         (username, user_type, user_real_name, user_name, user_fname, user_lname,
          user_initials, user_auth, roles, email, phone, default_phone, default_email,
          allow_sms, ringcentral, does_appts, user_gcal_id,
          password_hash,
          password)          -- TODO: REMOVE when dropping plaintext password column
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?,
          ?)                 -- TODO: REMOVE when dropping plaintext password column
      `,
      [
        clean.username, clean.user_type, clean.user_real_name, clean.user_name,
        clean.user_fname, clean.user_lname, clean.user_initials, clean.user_auth,
        clean.roles, clean.email, clean.phone, clean.default_phone, clean.default_email,
        clean.allow_sms, clean.ringcentral, clean.does_appts, clean.user_gcal_id,
        hash,
        password || null, // TODO: REMOVE when dropping plaintext password column
      ]
    );

    audit(req, 'user_created', {
      new_user_id: r.insertId,
      username: clean.username,
      user_auth: clean.user_auth,
      roles: clean.roles,
      with_password: !!password,
    });
    res.json({ status: 'success', user: r.insertId, username: clean.username });
  } catch (err) {
    console.error('POST /api/admin/users error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create user' });
  }
});

// ── PATCH edit ───────────────────────────────────────────────────────────────

router.patch('/api/admin/users/:id', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;

  const body = req.body || {};
  const fields = {};
  for (const k of PATCH_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({ status: 'error', message: 'No editable fields provided' });
  }

  const { ok, errors, clean } = validateFields(fields, { partial: true });
  if (!ok) return res.status(400).json({ status: 'error', message: errors.join('; ') });

  try {
    const [[existing]] = await req.db.query(
      'SELECT user, username, user_auth, roles FROM users WHERE user = ?', [id]
    );
    if (!existing) return res.status(404).json({ status: 'error', message: 'User not found' });

    // Guardrail: you can't change your own access level. Compared as login
    // status, so a row still holding the legacy 'authorized - SU' string
    // (until the A2b collapse runs) saves as 'authorized' rather than 400ing.
    if (id === req.auth.userId &&
        clean.user_auth !== undefined &&
        authStatus(clean.user_auth) !== authStatus(existing.user_auth)) {
      return res.status(400).json({ status: 'error', message: 'You cannot change your own access level' });
    }

    if (clean.roles !== undefined) {
      const refusal = roleChangeRefusal(req.auth, id, existing.roles, clean.roles);
      if (refusal) return res.status(refusal.status).json({ status: 'error', message: refusal.message });
    }

    if (clean.username !== undefined && clean.username !== existing.username) {
      if (await usernameTaken(req.db, clean.username, id)) {
        return res.status(409).json({ status: 'error', message: `Username "${clean.username}" already exists` });
      }
    }

    const keys = Object.keys(clean);
    const sets = keys.map(k => `\`${k}\` = ?`).join(', ');
    const vals = keys.map(k => clean[k]);
    await req.db.query(`UPDATE users SET ${sets} WHERE user = ?`, [...vals, id]);

    audit(req, 'user_updated', { target_user_id: id, changed: clean });
    res.json({ status: 'success', user: id, updated: keys });
  } catch (err) {
    console.error(`PATCH /api/admin/users/${id} error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to update user' });
  }
});

// ── POST set-password ────────────────────────────────────────────────────────

router.post('/api/admin/users/:id/set-password', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;

  const password = req.body?.password == null ? '' : String(req.body.password);
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ status: 'error', message: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [r] = await req.db.query(
      `UPDATE users
       SET password_hash = ?,
           password = ?,       -- TODO: REMOVE when dropping plaintext password column
           reset_token = NULL,
           reset_expires = NULL
       WHERE user = ?`,
      [hash, password, id]     // TODO: REMOVE password param when dropping plaintext column
    );
    if (!r.affectedRows) return res.status(404).json({ status: 'error', message: 'User not found' });

    audit(req, 'password_set', { target_user_id: id }); // never log the value
    res.json({ status: 'success', user: id, message: 'Password set' });
  } catch (err) {
    console.error(`POST /api/admin/users/${id}/set-password error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to set password' });
  }
});

// ── POST disable / enable ────────────────────────────────────────────────────

router.post('/api/admin/users/:id/disable', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  if (id === req.auth.userId) {
    return res.status(400).json({ status: 'error', message: 'You cannot disable your own account' });
  }

  try {
    // Wipe both password columns: kills future JWT logins AND the legacy
    // plaintext-auth routes (dropbox/db64/dbQuery/unplacehold) for this user.
    // NOTE: a JWT the user already holds remains valid up to 24h.
    const [r] = await req.db.query(
      `UPDATE users
       SET user_auth = 'disabled',
           password_hash = NULL,
           password = NULL,     -- TODO: REMOVE when dropping plaintext password column
           reset_token = NULL,
           reset_expires = NULL
       WHERE user = ?`,
      [id]
    );
    if (!r.affectedRows) return res.status(404).json({ status: 'error', message: 'User not found' });

    audit(req, 'user_disabled', { target_user_id: id });
    res.json({ status: 'success', user: id, message: 'User disabled (existing sessions may persist up to 24h)' });
  } catch (err) {
    console.error(`POST /api/admin/users/${id}/disable error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to disable user' });
  }
});

router.post('/api/admin/users/:id/enable', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;

  try {
    const [r] = await req.db.query(
      "UPDATE users SET user_auth = 'authorized' WHERE user = ?", [id]
    );
    if (!r.affectedRows) return res.status(404).json({ status: 'error', message: 'User not found' });

    audit(req, 'user_enabled', { target_user_id: id });
    res.json({ status: 'success', user: id, message: 'User enabled — set a password before they can log in' });
  } catch (err) {
    console.error(`POST /api/admin/users/${id}/enable error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to enable user' });
  }
});

module.exports = router;
module.exports.parseRoles = parseRoles; // exported for tests
module.exports.roleChangeRefusal = roleChangeRefusal;
module.exports.ROLE_MEMBERS = ROLE_MEMBERS;
