// routes/api.appSettings.js
//
/**
 * App Settings API (user-facing settings editor)
 * ----------------------------------------------
 * GET  /api/app-settings       — rows where is_editable = 1 AND is_secret = 0,
 *                                including display metadata (category, label,
 *                                description, type, sort_order)
 * PUT  /api/app-settings/:key  — update value of an existing editable row,
 *                                validated against the row's declared `type`
 * POST /api/app-settings       — create a NEW editable, non-secret setting.
 *                                Any signed-in user (JWT). API-key auth is
 *                                rejected — automation must never mint keys
 *                                (same philosophy as set_setting's
 *                                key-must-exist gate). Forces is_editable=1,
 *                                is_secret=0 — secrets are still created
 *                                ONLY via the DB console.
 *
 * Consumed by public/settings.html (the Settings tab iframe).
 *
 * Gates:
 *   - is_secret = 1 rows are NEVER returned or writable through this route,
 *     regardless of is_editable. (Belt-and-suspenders: a fat-fingered
 *     is_editable=1 on a secret still can't leak it.)
 *   - PUT only updates rows that already exist with is_editable = 1.
 *   - POST is the ONLY insert path and can only mint editable non-secret
 *     rows. Any JWT user may create; API-key auth (including the internal
 *     key) is rejected so automation can never mint keys — creation is a
 *     named human action, attributed by jwt_api_audit_log. A row created
 *     here is immediately usable by the get_setting / get_settings /
 *     set_setting internal functions (key exists, non-secret).
 *   - Keys are never renamed or deleted through this route.
 *
 * TYPE VALIDATION (see type vocabulary in the Slice A migration SQL):
 *   Validation is PERMISSIVE and NEVER MUTATES. Checks run against a trimmed
 *   COPY of the value; the stored value is always the exact string received.
 *   A blank value ('' or whitespace-only for non-whitespace-bearing types)
 *   always passes — blank means "unset" and must never be un-blankable.
 *   Rows with type NULL / 'string' / 'template' are stored with no checks.
 *
 * WHITESPACE INVARIANT:
 *   Values are stored VERBATIM. Never trim, collapse, or normalize whitespace.
 *   Some settings carry load-bearing leading/trailing spaces (e.g. Dropbox
 *   folder-name padding used for manual sort ordering).
 *
 * CACHE COHERENCE:
 *   Successful writes call firmConfig.invalidate() so lib/firmConfig.js
 *   consumers on THIS instance see the new value on their next read. Other
 *   Cloud Run instances converge within firmConfig's TTL (60s).
 *
 * TODO: audit-log writes (old value -> new value, acting user) via the
 *       upcoming jwtOrApiKey middleware logging once it lands.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const firmConfig  = require('../lib/firmConfig');

// app_settings.value is TEXT (64KB). Leave headroom for multi-byte chars.
const MAX_VALUE_LEN = 60000;

// ─────────────────────────────────────────
// Type validators. Each returns true, or a human-readable reason string.
// Input is the RAW value; validators trim their own working copy where the
// type is whitespace-insensitive. string/template deliberately absent.
// ─────────────────────────────────────────
const TYPE_VALIDATORS = {
  number(v) {
    return /^-?\d+(\.\d+)?$/.test(v.trim()) || 'must be a number';
  },
  bool(v) {
    return /^[01]$/.test(v.trim()) || 'must be 1 or 0';
  },
  email(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || 'must be a valid email address';
  },
  csv(v) {
    // loose: non-empty comma-separated entries (emails, domains, ...)
    return v.split(',').every((p) => p.trim().length > 0)
      || 'must be a comma-separated list with no empty entries';
  },
  phone(v) {
    const s = v.trim();
    return (/^[+()\d\s.\-]+$/.test(s) && (s.match(/\d/g) || []).length >= 7)
      || 'must be a phone number (digits, spaces, ()+.- allowed)';
  },
  url(v) {
    try {
      const u = new URL(v.trim());
      return (u.protocol === 'http:' || u.protocol === 'https:') || 'must be an http(s) URL';
    } catch {
      return 'must be a valid URL (include https://)';
    }
  },
  json(v) {
    try { JSON.parse(v); return true; }
    catch (e) { return 'must be valid JSON — ' + e.message; }
  },
  json_array(v) {
    try { return Array.isArray(JSON.parse(v)) || 'must be a JSON array'; }
    catch (e) { return 'must be valid JSON — ' + e.message; }
  },
  date(v) {
    // min_client_build semantics (lib/appBuild.js parseMinBuild): off-words,
    // epoch seconds/ms, or anything Date.parse understands.
    const s = v.trim();
    if (/^(0|off|false|no|none|null)$/i.test(s)) return true;
    if (/^\d{10}$/.test(s) || /^\d{13,}$/.test(s)) return true;
    return Number.isFinite(Date.parse(s))
      || 'must be a date (2026-07-12), datetime, epoch ms, or blank/off';
  },
};

/**
 * @param {string|null} type - app_settings.type
 * @param {string} value - raw value from the client
 * @returns {true|string} true, or the rejection reason
 */
function validateByType(type, value) {
  if (value.trim() === '') return true; // blank = unset, always allowed
  const fn = type && TYPE_VALIDATORS[type];
  return fn ? fn(value) : true; // NULL / string / template / unknown → verbatim
}

// ─────────────────────────────────────────
// GET /api/app-settings
// ─────────────────────────────────────────
router.get('/api/app-settings', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT \`key\`, \`value\`, category, label, description, \`type\`, sort_order, updated_at
       FROM app_settings
       WHERE is_editable = 1 AND is_secret = 0
       ORDER BY category ASC, sort_order ASC, \`key\` ASC`
    );
    res.json({ status: 'success', settings: rows });
  } catch (err) {
    console.error('GET /api/app-settings error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load settings' });
  }
});

// ─────────────────────────────────────────
// PUT /api/app-settings/:key
// Body: { value: string }  — validated by row type, stored verbatim
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
      'SELECT is_editable, is_secret, `type` FROM app_settings WHERE `key` = ?',
      [key]
    );
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Setting not found' });
    }
    if (Number(rows[0].is_editable) !== 1 || Number(rows[0].is_secret) === 1) {
      return res.status(403).json({ status: 'error', message: 'This setting is not editable' });
    }

    const check = validateByType(rows[0].type, value);
    if (check !== true) {
      return res.status(400).json({ status: 'error', message: check });
    }

    // TODO: audit-log this write (key, old value, new value, req.auth.userId)
    //       via the upcoming jwtOrApiKey middleware logging.

    // Stored VERBATIM — see whitespace invariant in the header comment.
    await req.db.query(
      'UPDATE app_settings SET `value` = ? WHERE `key` = ?',
      [value, key]
    );

    // Same-instance firmConfig consumers pick up the change immediately;
    // other instances converge within the firmConfig TTL.
    firmConfig.invalidate();

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

// ─────────────────────────────────────────
// POST /api/app-settings
// Body: { key, value?, category?, label?, description?, type?, sort_order? }
// Creates a new editable, non-secret setting. Elevated JWT users only.
// ─────────────────────────────────────────

// Mirror of the `type` vocabulary the validators + settings.html understand.
// 'string' and 'template' are verbatim (no validation); the rest map to
// TYPE_VALIDATORS above. Kept as an explicit allow-list so a typo'd type on
// creation can't silently produce an unvalidated row.
const SETTING_TYPES = ['string', 'template', 'number', 'bool', 'email',
                       'csv', 'phone', 'url', 'json', 'json_array', 'date'];

// app_settings.key is varchar(100). No whitespace (keys travel through csv
// lists in get_settings and {{placeholders}}), no leading _/- for tidiness.
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,99}$/;

router.post('/api/app-settings', jwtOrApiKey, async (req, res) => {
  // Any signed-in HUMAN may create. API-key auth (including the internal
  // key) is deliberately rejected: automation must never mint settings keys
  // — that mirrors set_setting/get_setting's key-must-exist gate, which
  // exists so a typo'd params_mapping can't silently create a row.
  const auth = req.auth || {};
  if (auth.type !== 'jwt') {
    return res.status(403).json({ status: 'error', message: 'Settings can only be created by a signed-in user' });
  }

  const b = req.body || {};

  const key = b.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    return res.status(400).json({
      status: 'error',
      message: 'key must be 1-100 chars of letters, digits, _ or -, starting with a letter or digit'
    });
  }

  // value: optional, defaults to '' (blank = unset, same as everywhere else).
  const value = (b.value === undefined || b.value === null) ? '' : b.value;
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

  const type = (b.type == null || b.type === '') ? 'string' : b.type;
  if (!SETTING_TYPES.includes(type)) {
    return res.status(400).json({
      status: 'error',
      message: `type must be one of: ${SETTING_TYPES.join(', ')}`
    });
  }

  const check = validateByType(type, value);
  if (check !== true) {
    return res.status(400).json({ status: 'error', message: check });
  }

  // Optional display metadata — reject over-length rather than silently
  // truncating (column limits: category 50, label 100, description 500).
  const optStr = (name, v, max) => {
    if (v == null || v === '') return { val: null };
    if (typeof v !== 'string') return { err: `${name} must be a string` };
    if (v.length > max) return { err: `${name} exceeds ${max} characters` };
    return { val: v };
  };
  const category    = optStr('category',    b.category,    50);
  const label       = optStr('label',       b.label,       100);
  const description = optStr('description', b.description, 500);
  for (const f of [category, label, description]) {
    if (f.err) return res.status(400).json({ status: 'error', message: f.err });
  }

  let sortOrder = null;
  if (b.sort_order != null && b.sort_order !== '') {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ status: 'error', message: 'sort_order must be an integer' });
    }
    sortOrder = n;
  }

  try {
    // is_secret=0 and is_editable=1 are HARDCODED — this route can never
    // mint a secret, and a UI-created setting must remain UI-editable.
    try {
      await req.db.query(
        `INSERT INTO app_settings
           (\`key\`, \`value\`, is_secret, is_editable, category, label, description, \`type\`, sort_order)
         VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?)`,
        [key, value, category.val, label.val, description.val, type, sortOrder]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        // Covers secret + non-editable rows too, without existence-leaking
        // anything beyond "taken" — which the DB console owner already knows.
        return res.status(409).json({ status: 'error', message: `Setting "${key}" already exists` });
      }
      throw err;
    }

    // Same coherence rule as PUT: if the new key is in firmConfig's REGISTRY
    // (pre-creating a registry key with a value), this instance sees it now.
    firmConfig.invalidate();

    const [[row]] = await req.db.query(
      `SELECT \`key\`, \`value\`, category, label, description, \`type\`, sort_order, updated_at
       FROM app_settings WHERE \`key\` = ?`,
      [key]
    );
    res.status(201).json({ status: 'success', setting: row });
  } catch (err) {
    console.error('POST /api/app-settings error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create setting' });
  }
});

module.exports = router;

module.exports.validateByType = validateByType; // exported for tests