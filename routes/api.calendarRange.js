// routes/api.calendarRange.js
//
/**
 * routes/api.calendarRange.js — the firm-wide unified calendar window
 * (Unified Events U9). Logic lives in services/caseEventService.listRange;
 * this file is the HTTP mapper.
 *
 * GET /api/calendar-range
 *
 *   from, to            REQUIRED, 'YYYY-MM-DD' firm-local, inclusive.
 *                       to - from must be ≤ 92 days (400 beyond).
 *   kind                CSV or repeated — hearing|meeting|deadline|conference|other
 *   type_key            CSV or repeated — registry keys
 *   state               CSV or repeated — live|resolved|cancelled|superseded
 *                       (default 'live')
 *   with_user_id        CSV or repeated — provider ids. Firm-wide events
 *                       (event_with NULL) match ANY provider filter.
 *   include_superseded  1/true — ADDS superseded rows to whatever `state` asks
 *                       for. It is a checkbox beside the state select in the
 *                       UI, not a value inside it, and the API says the same.
 *   include_attendees   1/true — attendees[] + client_expected (§3.6)
 *   include_labels      1/true — display{case_label, contact_name}
 *   limit               default 500, hard cap 1000
 *   offset              default 0
 *
 * Response: { status:'success', items[], count, limit, offset, has_more }
 *
 * ── WHY A SEPARATE FILE FROM api.caseEvents.js ─────────────────────────────
 *
 * That file mounts two static paths and parses exactly two option shapes
 * (a boolean flag and a date). This surface needs CSV-array parsing, a window
 * validator, an integer-list parser and limit/offset — roughly as much option
 * handling again, none of it shared with the per-case read. Auto-mounted from
 * routes/ (server.js readdir loop); /api/calendar-range collides with nothing
 * (/api/calendar-types and /api/calendar-types-admin are distinct prefixes,
 * /api/calendarFeed is its own path).
 *
 * ── VALIDATION IS THE SERVICE'S, NOT THIS FILE'S ───────────────────────────
 *
 * Unknown kinds/states 400 from listRange, which owns the vocabulary lists.
 * This file's parsing is purely SHAPE (split a CSV, coerce a number); the
 * moment it started deciding which kinds are legal there would be two lists to
 * keep in step. Service throws carry `.status`; anything else is a 500.
 *
 * AUTH: jwtOrApiKey, matching api.caseEvents.js and every sibling read.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/caseEventService');

function fail(res, err) {
  const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
  if (status >= 500) {
    console.error('[api.calendarRange] listRange error:', err);
    return res.status(500).json({ status: 'error', message: 'Calendar range request failed' });
  }
  res.status(status).json({ status: 'error', message: err.message });
}

/** '1'/'true' → true. Anything else (absent, '0', '') → false. */
const flag = (v) => v === '1' || v === 'true';

/**
 * A CSV-or-repeated query param → string[]. Express hands a repeated param
 * back as an array, so both spellings are supported without the caller having
 * to know which this endpoint prefers.
 */
function list(v) {
  return [].concat(v == null ? [] : v)
    .join(',')
    .split(',')
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/** An integer query param, or undefined when absent/unparseable. */
function int(v) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

router.get('/api/calendar-range', jwtOrApiKey, async (req, res) => {
  try {
    const { items, has_more } = await svc.listRange(req.db, {
      from: req.query.from,
      to:   req.query.to,
      kind:         list(req.query.kind),
      type_key:     list(req.query.type_key),
      state:        list(req.query.state),
      with_user_id: list(req.query.with_user_id),
      includeSuperseded: flag(req.query.include_superseded),
      includeAttendees:  flag(req.query.include_attendees),
      includeLabels:     flag(req.query.include_labels),
      limit:  int(req.query.limit),
      offset: int(req.query.offset),
    });
    res.json({
      status: 'success',
      items,
      count: items.length,
      // Echoed as RESOLVED, not as sent: the service applies the default and
      // the cap, and a client that asked for 5000 needs to know it got 1000.
      limit:  int(req.query.limit) == null ? svc._RANGE_LIMIT_DEFAULT
                                           : Math.min(int(req.query.limit), svc._RANGE_LIMIT_MAX),
      offset: int(req.query.offset) || 0,
      has_more,
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
