// routes/api.caseEvents.js
//
/**
 * routes/api.caseEvents.js — HTTP surface for the unified calendar read layer
 * (Unified Events E1). See services/caseEventService.js.
 *
 * GET /api/cases/:id/events   — one case's unified timeline (appts + events),
 *                               starts_at ascending.
 *                               ?include_superseded=1  include superseded events
 *                                                      and Rescheduled appt
 *                                                      tombstones, flagged
 *                               ?from=YYYY-MM-DD       inclusive lower bound
 *                               ?to=YYYY-MM-DD         inclusive upper bound
 *
 * GET /api/case-events/audit  — every event that resolves to no case.
 *                               Diagnostics; no UI in E1.
 *
 * Auto-mounted from routes/ (server.js readdir loop). Both paths are new:
 * routes/api.cases.js owns /api/cases/:id and its /contacts /tasks /log /merge
 * children, routes/api.pipeline.js owns /api/cases/:id/pipeline*, and neither
 * declares /events — verified against the tree, no shadowing either way.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * jwtOrApiKey on both, matching every sibling case route AND the pipeline
 * admin routes. The audit endpoint reads as "admin-level" but there is no
 * higher tier to put it behind: routes/api.pipelineAdmin.js — the most
 * admin-shaped surface in the repo — is plain jwtOrApiKey too, and the
 * superuser middleware (lib/auth.superuser.js) guards only account escalation
 * and the DB console. Using jwtOrApiKey here is matching the codebase, not
 * lowering a bar. The audit returns event metadata for rows that belong to no
 * case, which is strictly less than GET /api/events already exposes.
 *
 * Envelope + error mapping match routes/api.pipeline.js: { status:'success', … }
 * / { status:'error', message }; service throws carry `.status` (404 unknown
 * case), anything else is a 500.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/caseEventService');

// Map a thrown service error to an HTTP response.
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.caseEvents] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}

/** '1'/'true' → true. Anything else (absent, '0', '') → false. */
const flag = (v) => v === '1' || v === 'true';

/** Keep only a plausible 'YYYY-MM-DD'; anything else is treated as absent. */
function dateParam(v) {
  const s = v == null ? '' : String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/events — the unified timeline
//
// 404 vs EMPTY is a real distinction and is preserved deliberately, the same
// way requirementService.getCaseRequirements does it: an unknown case is a 404,
// an existing case with an empty calendar is a 200 with []. Collapsing them
// would make a typo'd case id look like a case with nothing scheduled — which
// is exactly the answer a caller would then act on. The service derives the
// existence fact from the batch's own `cases` query, so the distinction costs
// no extra round trip.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/cases/:id/events', jwtOrApiKey, async (req, res) => {
  try {
    const events = await svc.listForCase(req.db, req.params.id, {
      includeSuperseded: flag(req.query.include_superseded),
      from: dateParam(req.query.from),
      to:   dateParam(req.query.to),
    });
    res.json({ status: 'success', events });
  } catch (err) {
    fail(res, 'listForCase', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/case-events/audit — orphan census
//
// Static path, no :id, so it cannot collide with the route above.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/case-events/audit', jwtOrApiKey, async (req, res) => {
  try {
    const orphans = await svc.auditOrphans(req.db);
    res.json({ status: 'success', count: orphans.length, orphans });
  } catch (err) {
    fail(res, 'auditOrphans', err);
  }
});


module.exports = router;
