/**
 * Email Credentials API — SMTP sender accounts for the Connections system.
 * routes/api.emailCredentials.js
 *
 * GET    /api/email-credentials       — list, any auth (smtp_pass scrubbed)
 * GET    /api/email-credentials/:id   — admin only (full row incl. smtp_pass)
 * POST   /api/email-credentials       — admin only
 * PUT    /api/email-credentials/:id   — admin only
 * DELETE /api/email-credentials/:id   — admin only
 *
 * Slice 3 deliverable. Currently smtp_pass is plaintext in the DB (matches
 * existing send-site read patterns); a future cleanup slice may encrypt it
 * with a one-time migration. NOT addressed here.
 *
 * The list endpoint is the dropdown source for hooks/sequences/workflows when
 * configuring an email sender. Admin CRUD endpoints feed the Connections UI.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');

const TOOL = 'connections';

// Columns that are safe to expose in the list endpoint (any auth user).
// smtp_pass is intentionally omitted — admin GET single returns it.
const LIST_COLUMNS = [
  'id', 'email', 'smtp_host', 'smtp_port', 'smtp_user',
  'smtp_secure', 'provider', 'from_name',
];

// Full column set for admin GET single.
const ALL_COLUMNS = [
  'id', 'email', 'smtp_host', 'smtp_port', 'smtp_user',
  'smtp_pass', 'smtp_secure', 'provider', 'from_name',
];

// Required on POST.
const REQUIRED_FIELDS = [
  'email', 'smtp_host', 'smtp_port', 'smtp_user',
  'smtp_pass', 'provider', 'from_name',
];

// Allowed on PUT.
const UPDATABLE_FIELDS = [
  'email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
  'smtp_secure', 'provider', 'from_name',
];

const VALID_PROVIDERS = ['smtp', 'pabbly'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(db, row) {
  return auditAdminAction(db, row).catch(err =>
    console.error('[email-creds] audit log failed:', err.message)
  );
}

function coerceField(field, value) {
  if (field === 'smtp_port')   return Number(value);
  if (field === 'smtp_secure') return value ? 1 : 0;
  return value;
}

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials   — list (any auth user)
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT ${LIST_COLUMNS.join(', ')} FROM email_credentials ORDER BY email ASC`
    );
    res.json({ status: 'success', email_credentials: rows });
  } catch (err) {
    console.error('[email-creds] list error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials/:id   — admin (full row incl. smtp_pass)
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT ${ALL_COLUMNS.join(', ')} FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { email_credential_id: row.id, email: row.email },
    });

    res.json({ status: 'success', email_credential: row });
  } catch (err) {
    console.error('[email-creds] get error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/email-credentials   — admin
// ─────────────────────────────────────────────────────────────

router.post('/api/email-credentials', superuserOnlyFor(TOOL), async (req, res) => {
  const meta = reqMeta(req);
  try {
    const body = req.body || {};

    for (const f of REQUIRED_FIELDS) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        return res.status(400).json({ status: 'error', message: `${f} is required` });
      }
    }
    if (!VALID_PROVIDERS.includes(body.provider)) {
      return res.status(400).json({
        status: 'error',
        message: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    const data = {
      email:       body.email,
      smtp_host:   body.smtp_host,
      smtp_port:   Number(body.smtp_port),
      smtp_user:   body.smtp_user,
      smtp_pass:   body.smtp_pass,                                // plaintext (existing convention)
      smtp_secure: body.smtp_secure !== undefined ? (body.smtp_secure ? 1 : 0) : 1,
      provider:    body.provider,
      from_name:   body.from_name,
    };

    const [result] = await req.db.query(`INSERT INTO email_credentials SET ?`, [data]);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { email_credential_id: result.insertId, email: data.email },
    });

    res.json({ status: 'success', id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        status: 'error',
        message: 'A sender with this email already exists',
      });
    }
    console.error('[email-creds] create error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: null, email: req.body?.email ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/email-credentials/:id   — admin
// ─────────────────────────────────────────────────────────────

router.put('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const body = req.body || {};

    const data = {};
    const fieldsChanged = [];
    for (const f of UPDATABLE_FIELDS) {
      if (body[f] !== undefined) {
        data[f] = coerceField(f, body[f]);
        fieldsChanged.push(f);
      }
    }

    if (data.provider !== undefined && !VALID_PROVIDERS.includes(data.provider)) {
      return res.status(400).json({
        status: 'error',
        message: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ status: 'error', message: 'No fields to update' });
    }

    const [[existing]] = await req.db.query(
      `SELECT id, email FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    await req.db.query(`UPDATE email_credentials SET ? WHERE id = ?`, [data, id]);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: Number(id),
        email: data.email ?? existing.email,
        fields_changed: fieldsChanged,
      },
    });

    res.json({ status: 'success' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        status: 'error',
        message: 'A sender with this email already exists',
      });
    }
    console.error('[email-creds] update error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: Number(id), email: req.body?.email ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/email-credentials/:id   — admin (hard delete)
// ─────────────────────────────────────────────────────────────

router.delete('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[existing]] = await req.db.query(
      `SELECT id, email FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    await req.db.query(`DELETE FROM email_credentials WHERE id = ?`, [id]);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { email_credential_id: Number(id), email: existing.email },
    });

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[email-creds] delete error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: Number(id), email: null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;