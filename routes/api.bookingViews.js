// routes/api.bookingViews.js
//
/**
 * Booking Views CRUD — Scheduler Slice 6b
 *
 * Staff management API for the booking_views table that backs the public
 * booking widget (routes/booking.js). Plain jwtOrApiKey like the pages /
 * redirects routes — NOT admin-gated.
 *
 *   GET    /api/booking-views            — list all views (incl. inactive)
 *   GET    /api/booking-views/providers  — users with does_appts=1 (reference data)
 *   GET    /api/booking-views/:id        — single view
 *   POST   /api/booking-views            — create
 *   PATCH  /api/booking-views/:id        — partial update (merged-row validation)
 *   DELETE /api/booking-views/:id        — SOFT delete (active=0)
 *
 * Soft delete is deliberate (diverges from pages/redirects hard-DELETE):
 * views are embedded as iframes on third-party sites, so "delete" should
 * stop serving (booking.js loadView only reads active=1) without destroying
 * the config. Re-activation is a PATCH {active:1}.
 *
 * Validation mirrors booking.js loadView's sanity checks so a saved view
 * can never trip the misconfigured-view alert path:
 *   - slug ^[a-zA-Z0-9_-]{1,100}$, unique
 *   - provider_mode ∈ enum; provider_ids non-empty int array;
 *     fixed_one → exactly one id; ids must exist in users (does_appts=1)
 *   - appt_length int 1–127 (appts.appt_length is tinyint even though
 *     booking_views.appt_length is smallint — booking.js enforces 1–127)
 *   - granularity_min ≥ 5; horizon_days 1–365; buffer/min_notice ≥ 0
 *
 * mysql2 JSON gotcha: provider_ids is a json column — must JSON.stringify
 * before binding to a `?` placeholder on write; arrives parsed (array) on
 * read. Both directions handled here.
 *
 * Auto-mounts via the routes/ scan in server.js.
 */

const express = require('express');
const router  = express.Router();

const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;

const PROVIDER_MODES = ['fixed_one', 'client_choice', 'any_auto'];
const PLATFORMS      = ['telephone', 'Zoom', 'in-person'];
const IDENTITY_MODES = ['public', 'prefill'];

// Columns the API accepts on create/update (everything except id/timestamps).
const FIELDS = [
  'slug', 'active', 'provider_mode', 'provider_ids', 'page_windows',
  'appt_type', 'appt_length', 'platform',
  'buffer_min', 'min_notice_min', 'horizon_days', 'granularity_min',
  'identity_mode', 'source_tag', 'collect_note',
  'confirm_template', 'confirm_sms', 'confirm_email', 'hook_id',
  'title', 'subtitle', 'accent_color', 'logo_url', 'logo_link_url', 'thankyou_html',
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** provider_ids from DB (parsed array) or request (array) → clean int array or null. */
function cleanProviderIds(v) {
  let arr = v;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const ids = arr.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length || ids.length !== arr.length) return null;
  return [...new Set(ids)];
}

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function bool01(v) {
  return (v === true || v === 1 || v === '1') ? 1 : 0;
}

function trimOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Validate + normalize a FULL view object (create, or existing-row-merged-
 * with-patch). Returns { values } (normalized, DB-ready except provider_ids
 * still an array) or { error: 'message' }.
 */
async function validateView(db, v) {
  const out = {};

  // slug
  const slug = String(v.slug || '').trim();
  if (!SLUG_RE.test(slug)) {
    return { error: 'Slug must be 1–100 chars: letters, numbers, _ and - only.' };
  }
  out.slug = slug;

  // active
  out.active = bool01(v.active === undefined ? 1 : v.active);

  // provider_mode + provider_ids
  if (!PROVIDER_MODES.includes(v.provider_mode)) {
    return { error: `provider_mode must be one of: ${PROVIDER_MODES.join(', ')}` };
  }
  out.provider_mode = v.provider_mode;

  const pids = cleanProviderIds(v.provider_ids);
  if (!pids) {
    return { error: 'provider_ids must be a non-empty array of positive integers.' };
  }
  if (out.provider_mode === 'fixed_one' && pids.length !== 1) {
    return { error: 'fixed_one mode requires exactly one provider.' };
  }
  // Providers must exist and do appointments — keeps the public widget from
  // ever computing slots for a non-provider.
  const [urows] = await db.query(
    'SELECT user FROM users WHERE user IN (?) AND does_appts = 1',
    [pids]
  );
  const found = new Set(urows.map(r => Number(r.user)));
  const missing = pids.filter(id => !found.has(id));
  if (missing.length) {
    return { error: `Unknown or non-appointment provider id(s): ${missing.join(', ')}` };
  }
  out.provider_ids = pids;

  // page_windows — optional per-view weekly time restriction (Slice A).
  // null/''/[]/undefined → unrestricted (stored NULL). Otherwise an array of
  // { weekday:0–6, start?:'HH:mm', end?:'HH:mm' } (both times or neither;
  // start < end). Max 28 entries. Extra keys are stripped, not rejected.
  const PW_ERR = 'page_windows must be null or an array of {weekday:0-6, start?:"HH:mm", end?:"HH:mm"} (both times or neither; start < end).';
  let pw = v.page_windows;
  if (pw === undefined || pw === null || pw === '') {
    out.page_windows = null;
  } else {
    if (typeof pw === 'string') {
      try { pw = JSON.parse(pw); } catch { return { error: PW_ERR }; }
    }
    if (!Array.isArray(pw)) {
      return { error: PW_ERR };
    } else if (pw.length === 0) {
      out.page_windows = null;
    } else if (pw.length > 28) {
      return { error: 'page_windows may not exceed 28 entries.' };
    } else {
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      const norm = [];
      for (const entry of pw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return { error: PW_ERR };
        }
        const wd = Number(entry.weekday);
        if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
          return { error: 'page_windows entry weekday must be an integer 0–6.' };
        }
        const hasStart = entry.start !== undefined && entry.start !== null && entry.start !== '';
        const hasEnd   = entry.end   !== undefined && entry.end   !== null && entry.end   !== '';
        if (hasStart !== hasEnd) {
          return { error: 'Each page_windows entry needs both start and end, or neither.' };
        }
        if (!hasStart) {
          norm.push({ weekday: wd }); // all-day
        } else {
          const s = String(entry.start);
          const e = String(entry.end);
          if (!HHMM.test(s) || !HHMM.test(e)) {
            return { error: 'page_windows start/end must be "HH:mm" (00:00–23:59).' };
          }
          if (!(s < e)) {
            return { error: 'page_windows entry start must be earlier than end.' };
          }
          norm.push({ weekday: wd, start: s, end: e });
        }
      }
      out.page_windows = norm;
    }
  }

  // appt_type / title — NOT NULL columns
  const apptType = trimOrNull(v.appt_type, 60);
  if (!apptType) return { error: 'appt_type is required.' };
  out.appt_type = apptType;

  const title = trimOrNull(v.title, 200);
  if (!title) return { error: 'title is required.' };
  out.title = title;

  // numeric knobs
  out.appt_length = intIn(v.appt_length, 1, 127);
  if (out.appt_length === null) return { error: 'appt_length must be an integer 1–127.' };

  out.granularity_min = intIn(v.granularity_min === undefined ? 15 : v.granularity_min, 5, 1440);
  if (out.granularity_min === null) return { error: 'granularity_min must be an integer ≥ 5.' };

  out.horizon_days = intIn(v.horizon_days === undefined ? 30 : v.horizon_days, 1, 365);
  if (out.horizon_days === null) return { error: 'horizon_days must be an integer 1–365.' };

  out.buffer_min = intIn(v.buffer_min === undefined ? 0 : v.buffer_min, 0, 1440);
  if (out.buffer_min === null) return { error: 'buffer_min must be an integer 0–1440.' };

  out.min_notice_min = intIn(v.min_notice_min === undefined ? 120 : v.min_notice_min, 0, 525600);
  if (out.min_notice_min === null) return { error: 'min_notice_min must be a non-negative integer.' };

  // enums
  const platform = v.platform === undefined ? 'telephone' : v.platform;
  if (!PLATFORMS.includes(platform)) {
    return { error: `platform must be one of: ${PLATFORMS.join(', ')}` };
  }
  out.platform = platform;

  const identityMode = v.identity_mode === undefined ? 'public' : v.identity_mode;
  if (!IDENTITY_MODES.includes(identityMode)) {
    return { error: `identity_mode must be one of: ${IDENTITY_MODES.join(', ')}` };
  }
  out.identity_mode = identityMode;

  // flags
  out.collect_note  = bool01(v.collect_note);
  out.confirm_sms   = bool01(v.confirm_sms);
  out.confirm_email = bool01(v.confirm_email);

  // hook_id — null or an existing hook (active not required at save time;
  // booking.js checks active at fire time and warns).
  if (v.hook_id == null || v.hook_id === '') {
    out.hook_id = null;
  } else {
    const hid = intIn(v.hook_id, 1, 2147483647);
    if (hid === null) return { error: 'hook_id must be a positive integer or null.' };
    const [[hook]] = await db.query('SELECT id FROM hooks WHERE id = ? LIMIT 1', [hid]);
    if (!hook) return { error: `hook_id ${hid} does not exist.` };
    out.hook_id = hid;
  }

  // optional text
  out.source_tag       = trimOrNull(v.source_tag, 60);
  out.subtitle         = trimOrNull(v.subtitle, 500);
  out.accent_color     = trimOrNull(v.accent_color, 20);
  out.logo_url         = trimOrNull(v.logo_url, 500);
  out.logo_link_url    = trimOrNull(v.logo_link_url, 500);
  out.confirm_template = (v.confirm_template == null || String(v.confirm_template).trim() === '')
    ? null : String(v.confirm_template);
  out.thankyou_html    = (v.thankyou_html == null || String(v.thankyou_html).trim() === '')
    ? null : String(v.thankyou_html);

  if (out.logo_url && !/^https?:\/\//i.test(out.logo_url)) {
    return { error: 'logo_url must be an http(s) URL.' };
  }
  if (out.logo_link_url && !/^https?:\/\//i.test(out.logo_link_url)) {
    return { error: 'logo_link_url must be an http(s) URL.' };
  }

  return { values: out };
}

/** Normalize a DB row for JSON responses (provider_ids → array). */
function rowOut(row) {
  if (!row) return row;
  const r = { ...row };
  if (typeof r.provider_ids === 'string') {
    try { r.provider_ids = JSON.parse(r.provider_ids); } catch { r.provider_ids = []; }
  }
  if (typeof r.page_windows === 'string') {
    try { r.page_windows = JSON.parse(r.page_windows); } catch { r.page_windows = null; }
  }
  return r;
}

// ─────────────────────────────────────────────────────────────
// Reference data — providers (declared before /:id)
// ─────────────────────────────────────────────────────────────

router.get('/api/booking-views/providers', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT user, user_real_name, user_name
         FROM users
        WHERE does_appts = 1
        ORDER BY user_real_name, user_name, user`
    );
    const providers = rows.map(r => ({
      id:   Number(r.user),
      name: r.user_real_name || r.user_name || `Provider ${r.user}`,
    }));
    res.json({ status: 'success', providers });
  } catch (err) {
    console.error('GET /api/booking-views/providers error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

router.get('/api/booking-views', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      'SELECT * FROM booking_views ORDER BY active DESC, slug'
    );
    res.json({ status: 'success', views: rows.map(rowOut) });
  } catch (err) {
    console.error('GET /api/booking-views error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/booking-views/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid id' });
    }
    const [[row]] = await req.db.query(
      'SELECT * FROM booking_views WHERE id = ? LIMIT 1', [id]
    );
    if (!row) return res.status(404).json({ status: 'error', message: 'View not found' });
    res.json({ status: 'success', view: rowOut(row) });
  } catch (err) {
    console.error('GET /api/booking-views/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/booking-views', jwtOrApiKey, async (req, res) => {
  try {
    const result = await validateView(req.db, req.body || {});
    if (result.error) {
      return res.status(400).json({ status: 'error', message: result.error });
    }
    const v = result.values;
    const cols = FIELDS;
    const vals = cols.map(c => {
      if (c === 'provider_ids') return JSON.stringify(v.provider_ids); // NOT NULL
      if (c === 'page_windows') return v.page_windows == null ? null : JSON.stringify(v.page_windows);
      return v[c];
    });
    const [ins] = await req.db.query(
      `INSERT INTO booking_views (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      vals
    );
    res.json({ status: 'success', id: ins.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', message: 'A booking view with this slug already exists.' });
    }
    console.error('POST /api/booking-views error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/api/booking-views/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid id' });
    }
    const [[existing]] = await req.db.query(
      'SELECT * FROM booking_views WHERE id = ? LIMIT 1', [id]
    );
    if (!existing) return res.status(404).json({ status: 'error', message: 'View not found' });

    // Merge patch onto the existing row, then validate the whole thing —
    // catches cross-field breakage (e.g. PATCHing provider_mode to fixed_one
    // while the stored provider_ids has three entries).
    const merged = { ...rowOut(existing) };
    const body = req.body || {};
    let touched = 0;
    for (const f of FIELDS) {
      if (body[f] !== undefined) { merged[f] = body[f]; touched++; }
    }
    if (!touched) {
      return res.status(400).json({ status: 'error', message: 'No updatable fields in request.' });
    }

    const result = await validateView(req.db, merged);
    if (result.error) {
      return res.status(400).json({ status: 'error', message: result.error });
    }
    const v = result.values;
    const sets = FIELDS.map(c => `${c} = ?`).join(', ');
    const vals = FIELDS.map(c => {
      if (c === 'provider_ids') return JSON.stringify(v.provider_ids); // NOT NULL
      if (c === 'page_windows') return v.page_windows == null ? null : JSON.stringify(v.page_windows);
      return v[c];
    });
    await req.db.query(
      `UPDATE booking_views SET ${sets} WHERE id = ?`,
      [...vals, id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', message: 'A booking view with this slug already exists.' });
    }
    console.error('PATCH /api/booking-views/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Soft delete — deactivate. The public widget 404s immediately (loadView
// filters active=1); the row and its config survive for re-activation.
router.delete('/api/booking-views/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid id' });
    }
    const [upd] = await req.db.query(
      'UPDATE booking_views SET active = 0 WHERE id = ?', [id]
    );
    if (upd.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: 'View not found' });
    }
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/booking-views/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;