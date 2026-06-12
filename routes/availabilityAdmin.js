// routes/api.availabilityAdmin.js
//
/**
 * Availability Admin CRUD — Scheduler Slice 8
 *
 * Staff management API for the three availability-engine input tables that
 * were previously SQL-only. Backs public/availabilityManager.html. Plain
 * jwtOrApiKey like booking-views / pages / redirects — NOT admin-gated.
 *
 *   user_availability   (weekly working hours, per provider)
 *     GET    /api/user-availability            ?user=<id> filters; all rows incl. inactive
 *     POST   /api/user-availability
 *     PATCH  /api/user-availability/:id        (merged-row validation)
 *     DELETE /api/user-availability/:id        SOFT (active=0)
 *
 *   availability_blocks (personal time off, per provider)
 *     GET    /api/availability-blocks          ?user=<id>; upcoming by default, ?all=1 for history
 *     POST   /api/availability-blocks
 *     PATCH  /api/availability-blocks/:id
 *     DELETE /api/availability-blocks/:id      SOFT
 *
 *   firm_blocks (firm-wide closures)
 *     GET    /api/firm-blocks                  upcoming by default, ?all=1 for history
 *     POST   /api/firm-blocks                  source FORCED 'manual', generated_for NULL
 *     PATCH  /api/firm-blocks/:id              manual rows: full edit. Generated rows
 *                                              (source != 'manual'): ONLY `active` —
 *                                              start/end/label would be silently clobbered
 *                                              by the next Hebcal regeneration
 *                                              (firmBlocksService upserts those columns on
 *                                              every run; `active` is never touched, so a
 *                                              deactivation survives regeneration).
 *     DELETE /api/firm-blocks/:id              SOFT, any row
 *
 * Soft delete throughout (mirrors booking-views): the availability engine
 * reads active=1 only, so deactivation takes effect immediately while the
 * row survives for re-activation (PATCH {active:1}).
 *
 * All datetimes are firm-local naive wall time — the same convention as
 * every availability-engine source (see availabilityService's timezone
 * model). "Upcoming" comparisons therefore use a firm-local now-string
 * computed via Luxon, NOT SQL NOW() (whose meaning depends on the session
 * timezone). Datetime/date/time columns are returned as DATE_FORMAT/
 * TIME_FORMAT strings so the mysql2 timezone:"Z" Date wrapping never
 * enters the picture.
 *
 * firm_blocks' PK is `block_id` (not `id`); the API still exposes /:id and
 * maps internally.
 *
 * Auto-mounts via the routes/ scan in server.js.
 */

const express = require('express');
const router  = express.Router();
const { DateTime } = require('luxon');

const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { FIRM_TZ } = require('../services/timezoneService');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function firmNowStr() {
  return DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-LL-dd HH:mm:ss');
}

function parseId(raw) {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function bool01(v) {
  return (v === true || v === 1 || v === '1') ? 1 : 0;
}

/** 'HH:MM' | 'HH:MM:SS' → 'HH:MM:SS' or null. */
function normTime(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3] || 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}

/** 'YYYY-MM-DD' → same or null (real calendar date). */
function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return DateTime.fromISO(s, { zone: FIRM_TZ }).isValid ? s : null;
}

/**
 * 'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM[:SS]' (datetime-local) →
 * 'YYYY-MM-DD HH:MM:SS' firm-local naive, or null.
 */
function normDateTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const dt = DateTime.fromISO(s, { zone: FIRM_TZ });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd HH:mm:ss') : null;
}

/** Is `user` a does_appts=1 provider? */
async function isProvider(db, user) {
  const id = parseInt(user, 10);
  if (!Number.isInteger(id) || id <= 0) return false;
  const [[row]] = await db.query(
    'SELECT user FROM users WHERE user = ? AND does_appts = 1 LIMIT 1', [id]
  );
  return !!row;
}

function err400(res, message) {
  return res.status(400).json({ status: 'error', message });
}

// ─────────────────────────────────────────────────────────────
// user_availability — weekly working hours
// ─────────────────────────────────────────────────────────────

const UA_FIELDS = ['user', 'weekday', 'start_time', 'end_time', 'valid_from', 'valid_to', 'active'];

/**
 * Validate + normalize a FULL user_availability object (create, or existing
 * row merged with a patch). Returns { values } or { error }.
 */
async function validateUA(db, v) {
  const out = {};

  if (!(await isProvider(db, v.user))) {
    return { error: 'user must be an appointment provider (users.does_appts = 1).' };
  }
  out.user = Number(v.user);

  const wd = Number(v.weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
    return { error: 'weekday must be an integer 0–6 (0 = Sunday).' };
  }
  out.weekday = wd;

  out.start_time = normTime(v.start_time);
  if (!out.start_time) return { error: 'start_time must be HH:MM[:SS].' };
  out.end_time = normTime(v.end_time);
  if (!out.end_time) return { error: 'end_time must be HH:MM[:SS].' };
  if (out.end_time <= out.start_time) {
    return { error: 'end_time must be after start_time.' };
  }

  if (v.valid_from != null && v.valid_from !== '') {
    out.valid_from = normDate(v.valid_from);
    if (!out.valid_from) return { error: 'valid_from must be YYYY-MM-DD.' };
  } else out.valid_from = null;

  if (v.valid_to != null && v.valid_to !== '') {
    out.valid_to = normDate(v.valid_to);
    if (!out.valid_to) return { error: 'valid_to must be YYYY-MM-DD.' };
  } else out.valid_to = null;

  if (out.valid_from && out.valid_to && out.valid_to < out.valid_from) {
    return { error: 'valid_to must be on or after valid_from.' };
  }

  out.active = bool01(v.active === undefined ? 1 : v.active);
  return { values: out };
}

router.get('/api/user-availability', jwtOrApiKey, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.user !== undefined) {
      const uid = parseId(req.query.user);
      if (!uid) return err400(res, 'Invalid user');
      where = 'WHERE user = ?';
      params.push(uid);
    }
    const [rows] = await req.db.query(
      `SELECT id, user, weekday,
              TIME_FORMAT(start_time, '%H:%i') AS start_time,
              TIME_FORMAT(end_time,   '%H:%i') AS end_time,
              DATE_FORMAT(valid_from, '%Y-%m-%d') AS valid_from,
              DATE_FORMAT(valid_to,   '%Y-%m-%d') AS valid_to,
              active
         FROM user_availability
         ${where}
        ORDER BY user, weekday, start_time, id`,
      params
    );
    res.json({ status: 'success', rows });
  } catch (err) {
    console.error('GET /api/user-availability error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/user-availability', jwtOrApiKey, async (req, res) => {
  try {
    const result = await validateUA(req.db, req.body || {});
    if (result.error) return err400(res, result.error);
    const v = result.values;
    const [ins] = await req.db.query(
      `INSERT INTO user_availability (${UA_FIELDS.join(', ')})
       VALUES (${UA_FIELDS.map(() => '?').join(', ')})`,
      UA_FIELDS.map(c => v[c])
    );
    res.json({ status: 'success', id: ins.insertId });
  } catch (err) {
    console.error('POST /api/user-availability error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/api/user-availability/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [[existing]] = await req.db.query(
      `SELECT id, user, weekday,
              TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
              TIME_FORMAT(end_time,   '%H:%i:%s') AS end_time,
              DATE_FORMAT(valid_from, '%Y-%m-%d') AS valid_from,
              DATE_FORMAT(valid_to,   '%Y-%m-%d') AS valid_to,
              active
         FROM user_availability WHERE id = ? LIMIT 1`, [id]
    );
    if (!existing) return res.status(404).json({ status: 'error', message: 'Row not found' });

    // Merge patch onto the existing row, then validate the whole thing —
    // catches cross-field breakage (e.g. PATCHing start_time past the
    // stored end_time).
    const merged = { ...existing };
    const body = req.body || {};
    let touched = 0;
    for (const f of UA_FIELDS) {
      if (body[f] !== undefined) { merged[f] = body[f]; touched++; }
    }
    if (!touched) return err400(res, 'No updatable fields in request.');

    const result = await validateUA(req.db, merged);
    if (result.error) return err400(res, result.error);
    const v = result.values;
    await req.db.query(
      `UPDATE user_availability SET ${UA_FIELDS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...UA_FIELDS.map(c => v[c]), id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    console.error('PATCH /api/user-availability/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/user-availability/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [upd] = await req.db.query(
      'UPDATE user_availability SET active = 0 WHERE id = ?', [id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'Row not found' });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/user-availability/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// availability_blocks — personal time off
// ─────────────────────────────────────────────────────────────

const AB_FIELDS = ['user', 'block_start', 'block_end', 'reason', 'active'];

async function validateAB(db, v) {
  const out = {};

  if (!(await isProvider(db, v.user))) {
    return { error: 'user must be an appointment provider (users.does_appts = 1).' };
  }
  out.user = Number(v.user);

  out.block_start = normDateTime(v.block_start);
  if (!out.block_start) return { error: 'block_start must be a datetime (YYYY-MM-DD HH:MM).' };
  out.block_end = normDateTime(v.block_end);
  if (!out.block_end) return { error: 'block_end must be a datetime (YYYY-MM-DD HH:MM).' };
  if (out.block_end <= out.block_start) {
    return { error: 'block_end must be after block_start.' };
  }

  if (v.reason == null) out.reason = null;
  else {
    const r = String(v.reason).trim();
    out.reason = r ? r.slice(0, 120) : null;
  }

  out.active = bool01(v.active === undefined ? 1 : v.active);
  return { values: out };
}

router.get('/api/availability-blocks', jwtOrApiKey, async (req, res) => {
  try {
    const params = [];
    const conds = [];
    if (req.query.user !== undefined) {
      const uid = parseId(req.query.user);
      if (!uid) return err400(res, 'Invalid user');
      conds.push('user = ?');
      params.push(uid);
    }
    if (req.query.all !== '1') {
      conds.push('block_end >= ?');
      params.push(firmNowStr());
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows] = await req.db.query(
      `SELECT id, user,
              DATE_FORMAT(block_start, '%Y-%m-%d %H:%i') AS block_start,
              DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i') AS block_end,
              reason, active
         FROM availability_blocks
         ${where}
        ORDER BY block_start, id`,
      params
    );
    res.json({ status: 'success', rows });
  } catch (err) {
    console.error('GET /api/availability-blocks error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/availability-blocks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await validateAB(req.db, req.body || {});
    if (result.error) return err400(res, result.error);
    const v = result.values;
    const [ins] = await req.db.query(
      `INSERT INTO availability_blocks (${AB_FIELDS.join(', ')})
       VALUES (${AB_FIELDS.map(() => '?').join(', ')})`,
      AB_FIELDS.map(c => v[c])
    );
    res.json({ status: 'success', id: ins.insertId });
  } catch (err) {
    console.error('POST /api/availability-blocks error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/api/availability-blocks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [[existing]] = await req.db.query(
      `SELECT id, user,
              DATE_FORMAT(block_start, '%Y-%m-%d %H:%i:%s') AS block_start,
              DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i:%s') AS block_end,
              reason, active
         FROM availability_blocks WHERE id = ? LIMIT 1`, [id]
    );
    if (!existing) return res.status(404).json({ status: 'error', message: 'Block not found' });

    const merged = { ...existing };
    const body = req.body || {};
    let touched = 0;
    for (const f of AB_FIELDS) {
      if (body[f] !== undefined) { merged[f] = body[f]; touched++; }
    }
    if (!touched) return err400(res, 'No updatable fields in request.');

    const result = await validateAB(req.db, merged);
    if (result.error) return err400(res, result.error);
    const v = result.values;
    await req.db.query(
      `UPDATE availability_blocks SET ${AB_FIELDS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...AB_FIELDS.map(c => v[c]), id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    console.error('PATCH /api/availability-blocks/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/availability-blocks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [upd] = await req.db.query(
      'UPDATE availability_blocks SET active = 0 WHERE id = ?', [id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'Block not found' });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/availability-blocks/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// firm_blocks — firm-wide closures
// ─────────────────────────────────────────────────────────────

/** Validate manual-row content fields. Returns { values } or { error }. */
function validateFBContent(v) {
  const out = {};
  out.block_start = normDateTime(v.block_start);
  if (!out.block_start) return { error: 'block_start must be a datetime (YYYY-MM-DD HH:MM).' };
  out.block_end = normDateTime(v.block_end);
  if (!out.block_end) return { error: 'block_end must be a datetime (YYYY-MM-DD HH:MM).' };
  if (out.block_end <= out.block_start) {
    return { error: 'block_end must be after block_start.' };
  }
  if (v.label == null) out.label = null;
  else {
    const l = String(v.label).trim();
    out.label = l ? l.slice(0, 120) : null;
  }
  return { values: out };
}

router.get('/api/firm-blocks', jwtOrApiKey, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.all !== '1') {
      where = 'WHERE block_end >= ?';
      params.push(firmNowStr());
    }
    const [rows] = await req.db.query(
      `SELECT block_id AS id,
              DATE_FORMAT(block_start, '%Y-%m-%d %H:%i') AS block_start,
              DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i') AS block_end,
              label, source,
              DATE_FORMAT(generated_for, '%Y-%m-%d') AS generated_for,
              active
         FROM firm_blocks
         ${where}
        ORDER BY block_start, block_id`,
      params
    );
    res.json({ status: 'success', rows });
  } catch (err) {
    console.error('GET /api/firm-blocks error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST: always a manual closure. source is FORCED 'manual' and generated_for
// NULL — manual rows must stay structurally unreachable by the Hebcal
// generator's upsert (its dedupe key is (source, generated_for)).
router.post('/api/firm-blocks', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const result = validateFBContent(body);
    if (result.error) return err400(res, result.error);
    const v = result.values;
    const active = bool01(body.active === undefined ? 1 : body.active);
    const [ins] = await req.db.query(
      `INSERT INTO firm_blocks (block_start, block_end, label, source, generated_for, active)
       VALUES (?, ?, ?, 'manual', NULL, ?)`,
      [v.block_start, v.block_end, v.label, active]
    );
    res.json({ status: 'success', id: ins.insertId });
  } catch (err) {
    console.error('POST /api/firm-blocks error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH: manual rows get full content edit + active. Generated rows
// (source != 'manual') accept ONLY `active` — their block_start/block_end/
// label are overwritten by every Hebcal regeneration run, so an edit would
// be silently clobbered; reject it loudly instead.
router.patch('/api/firm-blocks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [[existing]] = await req.db.query(
      `SELECT block_id,
              DATE_FORMAT(block_start, '%Y-%m-%d %H:%i:%s') AS block_start,
              DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i:%s') AS block_end,
              label, source, active
         FROM firm_blocks WHERE block_id = ? LIMIT 1`, [id]
    );
    if (!existing) return res.status(404).json({ status: 'error', message: 'Block not found' });

    const body = req.body || {};
    const contentKeys = ['block_start', 'block_end', 'label'].filter(k => body[k] !== undefined);
    const hasActive = body.active !== undefined;

    if (!contentKeys.length && !hasActive) {
      return err400(res, 'No updatable fields in request.');
    }

    if (existing.source !== 'manual' && contentKeys.length) {
      return err400(res,
        `This ${existing.source} block is regenerated monthly from Hebcal — its times and label ` +
        `are not editable (an edit would be overwritten on the next run). ` +
        `Only activate/deactivate is allowed; add a separate manual closure if you need different times.`);
    }

    const sets = [];
    const vals = [];

    if (contentKeys.length) {
      // Merge + validate the full content set so cross-field rules hold.
      const merged = {
        block_start: body.block_start !== undefined ? body.block_start : existing.block_start,
        block_end:   body.block_end   !== undefined ? body.block_end   : existing.block_end,
        label:       body.label       !== undefined ? body.label       : existing.label,
      };
      const result = validateFBContent(merged);
      if (result.error) return err400(res, result.error);
      sets.push('block_start = ?', 'block_end = ?', 'label = ?');
      vals.push(result.values.block_start, result.values.block_end, result.values.label);
    }
    if (hasActive) {
      sets.push('active = ?');
      vals.push(bool01(body.active));
    }

    await req.db.query(
      `UPDATE firm_blocks SET ${sets.join(', ')} WHERE block_id = ?`,
      [...vals, id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    console.error('PATCH /api/firm-blocks/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Soft delete — any row (generated included: `active` is the one column the
// Hebcal upsert never touches, so a deactivation survives regeneration).
router.delete('/api/firm-blocks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return err400(res, 'Invalid id');
    const [upd] = await req.db.query(
      'UPDATE firm_blocks SET active = 0 WHERE block_id = ?', [id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'Block not found' });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/firm-blocks/:id error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;