// routes/api.log.js
//
/**
 * Log API
 * routes/api.log.js
 *
 * GET  /api/log            list with filters
 * GET  /api/log/:id        single entry
 * POST /api/log            create manual entry (note, call log, etc.)
 * PUT  /api/log/:id/about  set or clear the about-link (About-link S2)
 *
 * Communication date (log-comm-date): POST accepts an optional `date` — when
 * the logged call/text/email actually happened, so an entry made days later
 * still sorts and filters by that day. Parsed by parseUserDateTime (naive
 * values are FIRM time; an explicit Z/offset is honoured), never handed to
 * createLogEntry as a string: its own parser reads a naive SQL-style value as
 * UTC. Future dates are refused. The real entry time survives in
 * log_extra.logged_at — `log` has no created-at column. GET accepts
 * `sort=asc|desc` (log_date, newest first by default).
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
const { parseUserDateTime } = require('../services/timezoneService');

// Slice 1: whitelist for the new case_relate_filter query param.
const VALID_RELATE_FILTERS = new Set(['default', 'all', 'none']);
const VALID_SORTS = new Set(['asc', 'desc']);

// A communication date this far past the server clock is refused, not
// clamped: it is a typo, and a future row would sit atop every log for good.
// The slack absorbs browser/server clock skew on a "now" the form sent.
const FUTURE_SLACK_MS = 2 * 60 * 1000;

// `extra` as an object to merge into, whatever shape the caller sent;
// createLogEntry coerces the result exactly as it would the original.
function extraObject(extra) {
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) return { ...extra };
  if (typeof extra === 'string' && extra !== '') {
    try {
      const parsed = JSON.parse(extra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON — dropped, as createLogEntry would */ }
  }
  return {};
}

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

    const sort = req.query.sort || 'desc';
    if (!VALID_SORTS.has(sort)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid sort: "${sort}". Must be one of: asc, desc.`
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
      sort,
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
  const { type, link_type, link_id, about_type, about_id, data, extra,
          from, to, subject, message, direction, date } = req.body;

  if (!type) return res.status(400).json({ status: 'error', message: 'type is required' });

  let when = null;
  let extraOut = extra;
  if (date != null && date !== '') {
    try {
      when = parseUserDateTime(String(date));
    } catch (err) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    if (!when) return res.status(400).json({ status: 'error', message: 'date is empty' });
    if (when.getTime() > Date.now() + FUTURE_SLACK_MS) {
      return res.status(400).json({ status: 'error', message: 'date cannot be in the future' });
    }
    extraOut = { ...extraObject(extra), logged_at: new Date().toISOString() };
  }

  try {
    const result = await logService.createLogEntry(req.db, {
      type, link_type, link_id, about_type, about_id,
      by: req.auth?.userId || 0,
      data, extra: extraOut, from, to, subject, message, direction,
      date: when
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/log error:', err);
    if (err.code === 'INVALID_LOG_LINK_ID'
        || err.code === 'INVALID_LOG_ABOUT_TYPE'
        || err.code === 'INVALID_LOG_ABOUT_ID') {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    res.status(500).json({ status: 'error', message: 'Failed to create log entry' });
  }
});

// ─── ABOUT-LINK (About-link S2) ───
// Set or clear the SECONDARY "what it's about" attribution on a log row.
// Never touches the primary identity link or the log content.
// Body: { about_type, about_id }. about_type null/''/'none' clears the
// about-link (about_id ignored) — unlike the primary link, unlink is
// deliberately supported here.
router.put('/api/log/:id/about', jwtOrApiKey, async (req, res) => {
  const { about_type, about_id } = req.body || {};

  try {
    const result = await logService.setLogAbout(req.db, {
      log_id: req.params.id,
      about_type,
      about_id
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    if (err.code === 'LOG_NOT_FOUND') {
      return res.status(404).json({ status: 'error', message: err.message });
    }
    if (err.code === 'LOG_ID_REQUIRED'
        || err.code === 'INVALID_LOG_ABOUT_TYPE'
        || err.code === 'INVALID_LOG_ABOUT_ID') {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    console.error('PUT /api/log/:id/about error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to set log about-link' });
  }
});

module.exports = router;