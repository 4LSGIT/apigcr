// routes/api.appSettings.js
//
/**
 * App Settings API (user-facing settings editor)
 * ----------------------------------------------
 * GET /api/app-settings        — rows where is_editable = 1 AND is_secret = 0,
 *                                including display metadata (category, label,
 *                                description, type, sort_order)
 * PUT /api/app-settings/:key   — update value of an existing editable row,
 *                                validated against the row's declared `type`
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

module.exports = router;

module.exports.validateByType = validateByType; // exported for tests