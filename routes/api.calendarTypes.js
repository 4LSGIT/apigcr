// routes/api.calendarTypes.js
//
/**
 * routes/api.calendarTypes.js — read surface for the calendar item-type
 * registry (Unified Events U2). See services/calendarTypeService.js.
 *
 * GET /api/calendar-types   — registry rows for pickers.
 *                             ?kind=hearing,deadline   one or more kinds (CSV, repeatable)
 *                             ?active=1                active only ('0' = inactive only;
 *                                                      absent = all)
 *                             ?case_type=Bankruptcy    rows whose case_types is NULL
 *                                                      (all) or contains it (ci)
 *
 * Response: { status:'success', data:[ { type_key, label, kind, singleton,
 *             blocks_default, client_attends, default_length, ingest_aliases,
 *             case_types, active, sort_order } … ] }  — sorted by sort_order,
 *             type_key (the registry's own order).
 *
 * No write routes here — admin CRUD is U2b, which also calls
 * calendarTypeService.invalidate() after every write.
 *
 * Auto-mounted from routes/ (server.js readdir loop). /api/calendar-types is
 * a new path; nothing else in routes/ declares it (grep verified).
 *
 * AUTH: jwtOrApiKey, matching every sibling calendar surface
 * (api.events, api.appts, api.caseEvents). The picker in eventform.html calls
 * this through the shell's apiSend.
 */

'use strict';

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const calendarTypeService = require('../services/calendarTypeService');

/** ?kind=a,b or ?kind=a&kind=b → ['a','b'] */
function csvParam(v) {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

router.get('/api/calendar-types', jwtOrApiKey, async (req, res) => {
  try {
    const data = await calendarTypeService.listTypes(req.db, {
      kind:      csvParam(req.query.kind),
      active:    req.query.active === undefined ? undefined : String(req.query.active),
      case_type: req.query.case_type == null ? undefined : String(req.query.case_type),
    });
    res.json({ status: 'success', data });
  } catch (err) {
    console.error('GET /api/calendar-types error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch calendar types' });
  }
});

module.exports = router;
