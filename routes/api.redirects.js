/**
 * Redirects — short-link redirector for YisraCase.
 * routes/api.redirects.js
 *
 * PUBLIC (no auth):
 *   GET /r/:slug
 *     Look up slug (case-insensitive via utf8mb4_general_ci collation),
 *     302-redirect to target_url. Increments hit_count fire-and-forget
 *     AFTER responding (respond-first pattern). Dead links (not found,
 *     inactive, expired) render a branded "link unavailable" HTML page (404),
 *     generated fresh from env so it never needs the authed shell.
 *
 * JWT-gated CRUD (jwtOrApiKey):
 *   GET    /api/redirects            — list all
 *   GET    /api/redirects/:id        — get one
 *   POST   /api/redirects            — create { slug, target_url, label?, active?, expires_at? }
 *   PUT    /api/redirects/:id        — update (partial)
 *   DELETE /api/redirects/:id        — delete
 *
 * Error response shape: { status:'error', message:<msg> } — matches the house
 * route shape (checklists/cases/email_router). The shell's apiSend reads
 * data.message into err.message, so the UI surfaces it directly.
 *
 * Open-redirect note: this IS an open redirector by design. The security
 * boundary is the create/update endpoint (JWT-gated) + the target_url scheme
 * check (https?:// only — blocks javascript:/data: XSS vectors). The public
 * GET only resolves slugs that already exist in the table.
 *
 * Auto-mounts via the routes/ scan in server.js. No entry-point edit needed.
 * server.js's `GET /:page` static catch-all is single-segment, so it does not
 * intercept the two-segment `/r/:slug`.
 */

const express     = require('express');
const router      = express.Router();
const rateLimit   = require('express-rate-limit');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const SELECT_COLS = `id, slug, target_url, label, active, hit_count,
                     expires_at, created_by, created_at, updated_at`;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// House error shape: { status:'error', message }. apiSend reads data.message.
function errBody(msg) {
  return { status: 'error', message: msg };
}

// Accept only http(s) targets. Blocks javascript:, data:, etc.
function isValidTarget(url) {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Normalize incoming expires_at into a MySQL DATETIME string or null.
// null/'' -> null. Unparseable -> throws (caller -> 400).
function normExpiry(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error('Invalid expires_at');
  return d.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS' UTC
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Branded dead-link page, generated fresh from env each request.
// Falls back to literals so it never renders broken if an env var is unset.
function deadLinkPage() {
  const logo    = process.env.FIRM_LOGO  || 'https://iili.io/Jy2nXHv.md.png';
    const formatPhone = p => {
      const digits = String(p).replace(/\D/g, '');
      return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : p;
    };
  const phone = process.env.FIRM_PHONE ? formatPhone(process.env.FIRM_PHONE) : '(248) 559-2400';
  const email   = process.env.FIRM_EMAIL || 'info@4lsg.com';
  const telHref = phone.replace(/[^0-9+]/g, '');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Link Unavailable</title>',
    '  <style>',
    '    * { box-sizing: border-box; margin: 0; padding: 0; }',
    '    body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }',
    '    .container { max-width: 520px; margin: 60px auto 0; text-align: center; }',
    '    .logo { display: block; margin: 0 auto 28px; max-width: 220px; }',
    '    .card { background: #fff; border-radius: 6px; border: 1px solid #ddd; padding: 36px 24px; }',
    '    h1 { font-size: 22px; color: #07ADEF; margin-bottom: 12px; }',
    '    p { font-size: 15px; color: #555; line-height: 1.6; }',
    '    .footer-note { font-size: 13px; color: #999; margin-top: 22px; }',
    '    a { color: #07ADEF; text-decoration: none; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="container">',
    '    <img class="logo" src="' + esc(logo) + '" alt="Legal Solutions Group">',
    '    <div class="card">',
    '      <h1>This link is no longer available</h1>',
    '      <p>The link you followed may have expired or been removed.</p>',
    '      <p class="footer-note">',
    '        Questions? Call our office at <a href="tel:' + esc(telHref) + '">' + esc(phone) + '</a>',
    '        or email <a href="mailto:' + esc(email) + '">' + esc(email) + '</a>.',
    '      </p>',
    '    </div>',
    '  </div>',
    '</body>',
    '</html>',
  ].join('\n');
}

function sendDeadLink(res) {
  return res.status(404).type('html').send(deadLinkPage());
}

// ─────────────────────────────────────────────────────────────
// JWT-gated CRUD
// ─────────────────────────────────────────────────────────────

// LIST
router.get('/api/redirects', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT ${SELECT_COLS} FROM redirects ORDER BY created_at DESC, id DESC`
    );
    res.json({ status: 'success', redirects: rows });
  } catch (err) {
    console.error('GET /api/redirects error:', err);
    res.status(500).json(errBody('Failed to list redirects'));
  }
});

// GET ONE
router.get('/api/redirects/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [[row]] = await req.db.query(
      `SELECT ${SELECT_COLS} FROM redirects WHERE id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json(errBody('Redirect not found'));
    res.json({ status: 'success', redirect: row });
  } catch (err) {
    console.error('GET /api/redirects/:id error:', err);
    res.status(500).json(errBody('Failed to fetch redirect'));
  }
});

// CREATE
router.post('/api/redirects', jwtOrApiKey, async (req, res) => {
  const body = req.body || {};
  const slug = body.slug;
  const target_url = body.target_url;
  const label = body.label == null ? null : String(body.label);
  const active = body.active === undefined ? 1 : (body.active ? 1 : 0);

  if (!slug || !SLUG_RE.test(slug)) {
    return res.status(400).json(errBody('slug is required and must match ^[a-zA-Z0-9_-]{1,64}$'));
  }
  if (!isValidTarget(target_url)) {
    return res.status(400).json(errBody('target_url is required and must be a valid http(s) URL'));
  }

  let expires_at;
  try {
    expires_at = normExpiry(body.expires_at);
  } catch {
    return res.status(400).json(errBody('Invalid expires_at'));
  }

  // req.auth.userId is undefined under api_key auth; store null in that case.
  const createdBy = req.auth && req.auth.userId != null ? req.auth.userId : null;

  try {
    const [r] = await req.db.query(
      `INSERT INTO redirects (slug, target_url, label, active, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(slug).trim(), String(target_url).trim(), label || null, active, expires_at, createdBy]
    );
    const [[row]] = await req.db.query(
      `SELECT ${SELECT_COLS} FROM redirects WHERE id = ?`,
      [r.insertId]
    );
    res.json({ status: 'success', redirect: row });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody(
        'Slug "' + slug + '" is already in use (slugs are case-insensitive).'
      ));
    }
    console.error('POST /api/redirects error:', err);
    res.status(500).json(errBody('Failed to create redirect'));
  }
});

// UPDATE (partial)
router.put('/api/redirects/:id', jwtOrApiKey, async (req, res) => {
  const id   = req.params.id;
  const body = req.body || {};
  const fields = [];
  const vals   = [];

  if (body.slug !== undefined) {
    if (!SLUG_RE.test(body.slug)) {
      return res.status(400).json(errBody('slug must match ^[a-zA-Z0-9_-]{1,64}$'));
    }
    fields.push('slug = ?');
    vals.push(String(body.slug).trim());
  }
  if (body.target_url !== undefined) {
    if (!isValidTarget(body.target_url)) {
      return res.status(400).json(errBody('target_url must be a valid http(s) URL'));
    }
    fields.push('target_url = ?');
    vals.push(String(body.target_url).trim());
  }
  if (body.label !== undefined) {
    fields.push('label = ?');
    vals.push(body.label ? String(body.label) : null);
  }
  if (body.active !== undefined) {
    fields.push('active = ?');
    vals.push(body.active ? 1 : 0);
  }
  if (body.expires_at !== undefined) {
    let e;
    try {
      e = normExpiry(body.expires_at);
    } catch {
      return res.status(400).json(errBody('Invalid expires_at'));
    }
    fields.push('expires_at = ?');
    vals.push(e);
  }

  if (!fields.length) {
    return res.status(400).json(errBody('No updatable fields provided'));
  }

  vals.push(id);

  try {
    const [r] = await req.db.query(
      `UPDATE redirects SET ${fields.join(', ')} WHERE id = ?`,
      vals
    );
    if (!r.affectedRows) {
      return res.status(404).json(errBody('Redirect not found'));
    }
    const [[row]] = await req.db.query(
      `SELECT ${SELECT_COLS} FROM redirects WHERE id = ?`,
      [id]
    );
    res.json({ status: 'success', redirect: row });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody(
        'That slug is already in use (slugs are case-insensitive).'
      ));
    }
    console.error('PUT /api/redirects/:id error:', err);
    res.status(500).json(errBody('Failed to update redirect'));
  }
});

// DELETE
router.delete('/api/redirects/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [r] = await req.db.query(`DELETE FROM redirects WHERE id = ?`, [req.params.id]);
    if (!r.affectedRows) {
      return res.status(404).json(errBody('Redirect not found'));
    }
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/redirects/:id error:', err);
    res.status(500).json(errBody('Failed to delete redirect'));
  }
});

// ─────────────────────────────────────────────────────────────
// PUBLIC receiver — GET /r/:slug
// ─────────────────────────────────────────────────────────────

const redirectRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Show the same branded page to a human who trips the limit.
  handler: (req, res) => sendDeadLink(res),
});

router.get('/r/:slug', redirectRateLimit, async (req, res) => {
  const { slug } = req.params;

  // Cheap shape guard — avoids a pointless query on obviously bad input.
  if (!SLUG_RE.test(slug)) return sendDeadLink(res);

  try {
    // Case-insensitive match via column collation (utf8mb4_general_ci).
    const [[row]] = await req.db.query(
      `SELECT id, target_url, active, expires_at
         FROM redirects
        WHERE slug = ?
        LIMIT 1`,
      [slug]
    );

    if (!row) return sendDeadLink(res);
    if (!row.active) return sendDeadLink(res);
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return sendDeadLink(res);
    }

    // Respond first (302), then bump the counter fire-and-forget.
    res.redirect(302, row.target_url);

    req.db.query(
      `UPDATE redirects SET hit_count = hit_count + 1 WHERE id = ?`,
      [row.id]
    ).catch(err => console.error('[redirects] hit_count bump failed:', err.message));
  } catch (err) {
    console.error('GET /r/:slug error:', err);
    return sendDeadLink(res);
  }
});

module.exports = router;