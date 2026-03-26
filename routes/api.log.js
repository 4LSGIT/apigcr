/**
 * Log API
 * routes/api.log.js
 *
 * GET  /api/log       list with filters
 * GET  /api/log/:id   single entry
 * POST /api/log       create manual entry (note, call log, etc.)
 */

const express    = require('express');
const router     = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const logService = require('../services/logService');

// ─── LIST ───
router.get('/api/log', jwtOrApiKey, async (req, res) => {
  try {
    const { type, q, from_date, to_date } = req.query;
    // Map 'Communication' → types array; 'All' → no filter
    let typeParam  = null;
    let typesParam = null;
    if (type && type !== 'All') {
      if (type === 'Communication') {
        typesParam = ['sms', 'email', 'call'];
      } else {
        typeParam = type;
      }
    }
    // Apply same day-boundary fix as appts
    const fromDate = from_date ? `${from_date} 00:00:00` : null;
    const toDate   = to_date   ? to_date : null; // service uses < DATE_ADD logic belo
    const result = await logService.listLog(req.db, {
      link_type: req.query.link_type,
      link_id:   req.query.link_id,
      type:      typeParam,
      types:     typesParam,
      q:         q || null,
      direction: req.query.direction,
      from_date: fromDate,
      to_date:   toDate,
      limit:     req.query.limit  || 50,
      offset:    req.query.offset || 0
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log entries' });
  }
});

// ─── GET ONE ───
router.get('/api/log/:id', jwtOrApiKey, async (req, res) => {
  try {
    const entry = await logService.getLogEntry(req.db, req.params.id);
    if (!entry) return res.status(404).json({ status: 'error', message: 'Log entry not found' });
    res.json({ data: entry });
  } catch (err) {
    console.error('GET /api/log/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log entry' });
  }
});

// ─── CREATE ───
router.post('/api/log', jwtOrApiKey, async (req, res) => {
  const { type, link_type, link_id, data, from, to, subject, message, direction } = req.body;

  if (!type) return res.status(400).json({ status: 'error', message: 'type is required' });

  try {
    const result = await logService.createLogEntry(req.db, {
      type, link_type, link_id,
      by: req.auth?.userId || 0,
      data, from, to, subject, message, direction
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create log entry' });
  }
});

module.exports = router;