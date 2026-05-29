// routes/api.log.js
//
/**
 * Log API
 * routes/api.log.js
 *
 * GET  /api/log       list with filters
 * GET  /api/log/:id   single entry
 * POST /api/log       create manual entry (note, call log, etc.)
 *
 * Phase 3 Slice 1: POST accepts optional `extra` (JSON object) for IT-facing
 * fields kept separate from the user-facing log_data blob.
 *
 * Slice 1 (log reader semantic unification):
 *   GET /api/log accepts an optional `case_relate_filter` query param
 *   that only takes effect when `link_type=case`. Whitelisted values:
 *   'default' (Primary/Secondary/Other; the typical case view),
 *   'all'     (include Bystander),
 *   'none'    (case-scope only; no related-contact merge).
 *   Anything else → 400.
 */

const express    = require('express');
const router     = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const logService = require('../services/logService');

// Slice 1: whitelist for the new case_relate_filter query param.
const VALID_RELATE_FILTERS = new Set(['default', 'all', 'none']);

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
    const toDate   = to_date   ? to_date : null; // service uses < DATE_ADD logic below

    // Slice 1: validate case_relate_filter against whitelist.
    const caseRelateFilter = req.query.case_relate_filter || 'default';
    if (!VALID_RELATE_FILTERS.has(caseRelateFilter)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid case_relate_filter: "${caseRelateFilter}". ` +
                 `Must be one of: default, all, none.`
      });
    }

    const result = await logService.listLog(req.db, {
      link_type: req.query.link_type,
      link_id:   req.query.link_id,
      type:      typeParam,
      types:     typesParam,
      q:         q || null,
      direction: req.query.direction,
      from_date: fromDate,
      to_date:   toDate,
      by: req.query.by || null,
      case_relate_filter: caseRelateFilter,
      limit:     req.query.limit  || 50,
      offset:    req.query.offset || 0
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log entries' });
  }
});

// ─── ORPHAN EARLIEST ───
//
// GET /api/log/orphan-earliest?type=phone|email&value=...
//
// Returns the earliest log_date for an orphan phone/email value (a log row
// with log_link_type IN ('phone','email') and the normalized value in
// log_link_id). Backs OrphanAdoptDialog's "start date on contact" default.
//
// MUST be declared BEFORE GET /api/log/:id, or Express would match
// "orphan-earliest" as the :id param.
//
// Response: { earliest_log_date: 'YYYY-MM-DD' | null }
router.get('/api/log/orphan-earliest', jwtOrApiKey, async (req, res) => {
  const { type, value } = req.query;

  if (type !== 'phone' && type !== 'email') {
    return res.status(400).json({
      status: 'error',
      message: "Invalid type. Must be 'phone' or 'email'.",
    });
  }
  if (value == null || value === '') {
    return res.status(400).json({ status: 'error', message: 'value is required' });
  }

  try {
    const result = await logService.getOrphanEarliestDate(req.db, type, value);
    res.json(result);
  } catch (err) {
    console.error('GET /api/log/orphan-earliest error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch earliest log date' });
  }
});

// ─── CASE DOCKET PREVIEW ───
//
// GET /api/log/case-docket-preview?case_number=...&case_number_full=...
//
// Impact preview for the docket-adopt flow (Phase 4.1). Counts case-typed log
// rows whose log_link equals ANY of the submitted docket strings. These are
// exactly the rows that will reattribute to a case once that case carries
// these values in case_number / case_number_full, because listLog's JOIN
// matches log_link against either column. The preview query and that JOIN both
// key off log_link compared to the same strings, so "N rows" promised here
// equals the rows actually reattributed by the adopt.
//
// SHAPE-AGNOSTIC: no docket-format parsing. Both params are opaque strings;
// trim, drop empties, match by equality. At least one must be non-empty.
//
// MUST be declared BEFORE GET /api/log/:id, or Express matches
// "case-docket-preview" as the :id param.
//
// Response: { count: <int>, earliest_log_date: 'YYYY-MM-DD'|null,
//             latest_log_date: 'YYYY-MM-DD'|null }
router.get('/api/log/case-docket-preview', jwtOrApiKey, async (req, res) => {
  // Trim; treat '', 'null', 'undefined' (URLSearchParams stringifies those)
  // as absent.
  const norm = (v) => {
    if (v == null) return '';
    const s = String(v).trim();
    return (s === '' || s === 'null' || s === 'undefined') ? '' : s;
  };
  const caseNumber     = norm(req.query.case_number);
  const caseNumberFull = norm(req.query.case_number_full);

  const submitted = [...new Set([caseNumber, caseNumberFull].filter(Boolean))];

  if (!submitted.length) {
    return res.json({ count: 0, earliest_log_date: null, latest_log_date: null });
  }

  try {
    const placeholders = submitted.map(() => '?').join(', ');
    // Format dates in SQL (codebase convention; avoids JS Date/UTC TZ shift).
    const [rows] = await req.db.query(
      `SELECT COUNT(*)                                       AS count,
              DATE_FORMAT(MIN(log_date), '%Y-%m-%d')          AS earliest,
              DATE_FORMAT(MAX(log_date), '%Y-%m-%d')          AS latest
         FROM log
        WHERE log_link_type = 'case'
          AND log_link IN (${placeholders})`,
      submitted
    );

    const r = rows[0] || {};
    res.json({
      count: Number(r.count) || 0,
      earliest_log_date: r.earliest || null,
      latest_log_date:   r.latest   || null,
    });
  } catch (err) {
    console.error('GET /api/log/case-docket-preview error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to compute docket preview' });
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
  const { type, link_type, link_id, data, extra,
          from, to, subject, message, direction } = req.body;

  if (!type) return res.status(400).json({ status: 'error', message: 'type is required' });

  try {
    const result = await logService.createLogEntry(req.db, {
      type, link_type, link_id,
      by: req.auth?.userId || 0,
      data, extra, from, to, subject, message, direction
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/log error:', err);
    if (err.code === 'INVALID_LOG_LINK_ID') {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    res.status(500).json({ status: 'error', message: 'Failed to create log entry' });
  }
});

module.exports = router;