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
 * GET /api/calendar-types/options — (U2b) what a staff APPOINTMENT picker shows.
 *                             ?surface=new_client|follow_up   REQUIRED (else 400)
 *                             ?case_type=Bankruptcy           options whose TYPE is
 *                                                             unscoped or scoped to it
 *                             Active options of active types only.
 *
 * Response: { status:'success', data:[ { option_id, type_key, label, type_label,
 *             length, kind, surfaces, sort_order, active } … ] } — type order,
 *             then option order. `label` is the picker text (override or type
 *             label); callers send `type_label` back as appt_type so the label
 *             column always carries the registry's canonical string.
 *
 * No write routes here — admin CRUD is routes/api.calendarTypesAdmin.js
 * (U2b), which calls calendarTypeService.invalidate() after every write.
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

router.get('/api/calendar-types/options', jwtOrApiKey, async (req, res) => {
  try {
    const data = await calendarTypeService.listOptions(req.db, {
      surface:   req.query.surface   == null ? undefined : String(req.query.surface),
      case_type: req.query.case_type == null ? undefined : String(req.query.case_type),
    });
    res.json({ status: 'success', data });
  } catch (err) {
    if (typeof err.status === 'number' && err.status < 500) {
      return res.status(err.status).json({ status: 'error', message: err.message });
    }
    console.error('GET /api/calendar-types/options error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch calendar type options' });
  }
});

module.exports = router;
