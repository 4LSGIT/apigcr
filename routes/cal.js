// routes/cal.js
// Thin route wrapper around services/calendarService.js.
// All logic lives in the service — this file is just HTTP plumbing.
//
// Routes:
//   GET  /isWorkday?date=YYYY-MM-DDTHH:mm:ss
//   POST /nextBusinessDay
//   POST /prevBusinessDay

const express         = require('express');
const router          = express.Router();
const jwtOrApiKey     = require('../lib/auth.jwtOrApiKey');
const calendar        = require('../services/calendarService');
const trap            = require('../lib/legacyTrap');

// ─────────────────────────────────────────────────────────────
// GET /isWorkday?date=YYYY-MM-DDTHH:mm:ss
// Unchanged behaviour from original cal.js — existing callers unaffected.
// ─────────────────────────────────────────────────────────────
router.get('/isWorkday', trap('isWorkday'), async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      error: 'Missing date parameter. Use format YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD HH:mm:ss'
    });
  }

  try {
    const result = await calendar.isWorkday(date);
    return res.json({ ...result, version: '6' });
  } catch (err) {
    if (err.message.startsWith('Invalid datetime')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[GET /isWorkday]', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /nextBusinessDay
// Find the next available business day at a target time.
//
// Body:
//   fromDate         {string}  ISO datetime to search from (default: now)
//   timeOfDay        {string}  "HH:MM" target time (default "09:00")
//   randomizeMinutes {number}  ± jitter in minutes (default 0)
//   maxDaysAhead     {number}  give up after N days (default 30)
//
// Returns: { scheduledAt: ISO string, ...isWorkday result for that day }
// ─────────────────────────────────────────────────────────────
router.post('/nextBusinessDay', jwtOrApiKey, async (req, res) => {
  const {
    fromDate,
    timeOfDay        = '09:00',
    randomizeMinutes = 0,
    maxDaysAhead     = 30,
  } = req.body;

  if (randomizeMinutes < 0) {
    return res.status(400).json({ error: 'randomizeMinutes must be >= 0' });
  }

  try {
    const scheduledAt = await calendar.nextBusinessDay(
      fromDate ? new Date(fromDate) : new Date(),
      { timeOfDay, randomizeMinutes, maxDaysAhead }
    );

    return res.json({
      scheduledAt: scheduledAt.toISOString(),
      input: { fromDate: fromDate || new Date().toISOString(), timeOfDay, randomizeMinutes }
    });
  } catch (err) {
    if (err.message.startsWith('No business day found')) {
      return res.status(422).json({ error: err.message });
    }
    console.error('[POST /nextBusinessDay]', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /prevBusinessDay
// Find the best business-day slot before an appointment.
// Walks a priority-ordered attempts array, returns first valid slot.
//
// Body:
//   anchorDate  {string}   ISO datetime of the appointment
//   attempts    {object[]} ordered fallback rules — see calendarService.prevBusinessDay
//   defaults    {object}   { minHoursBefore, maxDaysBack }
//
// Returns: { scheduledAt, attemptIndex } or { scheduledAt: null, reason: "all_blocked" }
// ─────────────────────────────────────────────────────────────
router.post('/prevBusinessDay', jwtOrApiKey, async (req, res) => {
  const { anchorDate, attempts, defaults } = req.body;

  if (!anchorDate) {
    return res.status(400).json({ error: 'anchorDate is required' });
  }

  if (!Array.isArray(attempts) || !attempts.length) {
    return res.status(400).json({ error: 'attempts must be a non-empty array' });
  }

  try {
    const result = await calendar.prevBusinessDay(
      new Date(anchorDate),
      attempts,
      defaults || {}
    );

    if (!result) {
      return res.json({
        scheduledAt: null,
        reason: 'all_blocked',
        message: 'All reminder attempt slots were blocked by holidays or fell in the past'
      });
    }

    const anchor        = new Date(anchorDate);
    const scheduled     = result.scheduledAt;
    const actualHoursBefore = (anchor - scheduled) / (1000 * 60 * 60);
    const requestedHoursBack = attempts[result.attemptIndex].hoursBack;

    return res.json({
      scheduledAt:      scheduled.toISOString(),
      attemptIndex:     result.attemptIndex,
      attemptUsed:      attempts[result.attemptIndex],
      actualHoursBefore: Math.round(actualHoursBefore * 10) / 10,
      walkedBack:        Math.abs(actualHoursBefore - requestedHoursBack) > 0.5
    });
  } catch (err) {
    console.error('[POST /prevBusinessDay]', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

module.exports = router;