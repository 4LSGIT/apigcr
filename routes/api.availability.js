// routes/api.availability.js
//
/**
 * Availability API — Scheduler Slice 4
 *
 * GET /api/availability   open slot starts per provider over a date range
 *
 * Thin internal face over services/availabilityService.getSlots(). The
 * response shape { success: true, slots: { [providerId]: ['YYYY-MM-DD HH:mm',
 * …] } } mirrors the engine verbatim and is REUSED by slices 6 (public
 * booking) and 7 (calendar UI) — keep it boring and stable.
 *
 * Query params:
 *   providers    csv of users.user ids (required)
 *   length       appt length in minutes, 1–127 (required; appts.appt_length
 *                is tinyint)
 *   from, to     YYYY-MM-DD firm-local civil dates, inclusive (required;
 *                from ≤ to, range capped at 60 days)
 *   buffer       minutes padding around busy appts (default 0)
 *   granularity  slot grid minutes (default 15)
 *   min_notice   minutes of lead time from now (default 0)
 *
 * All times are firm-local wall time — see availabilityService's timezone
 * model. Internal callers default buffer/min_notice to 0 deliberately (staff
 * may book tighter than clients); booking-view-driven values arrive in
 * slice 6.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { getSlots } = require('../services/availabilityService');

const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 60; // inclusive-day cap — protects against accidental huge scans

/** Parse an optional non-negative integer query param with a default. */
function optNonNegInt(raw, dflt) {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  return (Number.isInteger(n) && n >= 0) ? n : NaN;
}

router.get('/api/availability', jwtOrApiKey, async (req, res) => {
  try {
    const q = req.query;

    // ── providers: csv → non-empty integer array ──
    const pids = String(q.providers || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s !== '')
      .map(Number);
    if (pids.length === 0 || pids.some(p => !Number.isInteger(p))) {
      return res.status(400).json({ status: 'error', message: 'providers must be a comma-separated list of integer user ids' });
    }

    // ── length: 1–127 (appts.appt_length is tinyint) ──
    const lengthMin = Number(q.length);
    if (!Number.isInteger(lengthMin) || lengthMin < 1 || lengthMin > 127) {
      return res.status(400).json({ status: 'error', message: 'length must be an integer between 1 and 127 minutes' });
    }

    // ── from / to: YYYY-MM-DD, from ≤ to, ≤ 60 days ──
    const from = String(q.from || '');
    const to   = String(q.to || '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ status: 'error', message: 'from and to must be YYYY-MM-DD dates' });
    }
    if (to < from) {
      return res.status(400).json({ status: 'error', message: 'to must be on or after from' });
    }
    // Civil-date diff via UTC parse — both strings are plain dates, so this
    // is an exact day count with no timezone wobble.
    const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({ status: 'error', message: `date range may not exceed ${MAX_RANGE_DAYS} days` });
    }

    // ── optional knobs ──
    const buffer      = optNonNegInt(q.buffer, 0);
    const granularity = optNonNegInt(q.granularity, 15);
    const minNotice   = optNonNegInt(q.min_notice, 0);
    if (Number.isNaN(buffer) || Number.isNaN(minNotice)) {
      return res.status(400).json({ status: 'error', message: 'buffer and min_notice must be non-negative integers (minutes)' });
    }
    if (Number.isNaN(granularity) || granularity < 1 || granularity > 1440) {
      return res.status(400).json({ status: 'error', message: 'granularity must be an integer between 1 and 1440 minutes' });
    }

    // ── engine call — response mirrors getSlots' shape verbatim ──
    const slots = await getSlots(req.db, {
      providerIds:    pids,
      appt_length:    lengthMin,
      buffer_min:     buffer,
      from, to,
      granularity,
      min_notice_min: minNotice,
    });

    res.json({ success: true, slots });
  } catch (err) {
    console.error('GET /api/availability error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to compute availability' });
  }
});

module.exports = router;