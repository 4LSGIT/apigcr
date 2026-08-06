// routes/portal.cases.js
//
// Client Portal Slice 2 — read-only case status endpoints. Auto-mounted
// (routes/ readdir). Thin: all logic in services/portalCaseService.js;
// envelope { status:'success', ... } / { status:'error', message }
// (portal.auth.js style).
//
//   GET /api/portal/cases          — the contact's case list
//   GET /api/portal/cases/:caseId  — one case + client timeline
//
// Oracle posture: out-of-scope and nonexistent case ids return the SAME
// 404 { status:'error', message:'Not found' } (manage.js philosophy —
// existence is not probeable through the portal).
//
// req.portalCaseId: requireAuth's finish hook reads it for per-case
// portal_access_log attribution — set ONLY after the scope check confirms
// the case is the caller's (the service returning non-null IS that
// confirmation), and set from the service's canonical case_id (the scope
// match is collation-case-insensitive; the log gets the DB's casing).
//
// Rate limiting: no per-route limiter on these authed reads — S1 limits
// the unauthenticated surface (request-pin / verify-pin) and every request
// here already writes a portal_access_log row for monitoring. (Manager
// judgment, pre-flagged in the slice spec.)

'use strict';

const express = require('express');
const router = express.Router();

const requireAuth = require('../lib/auth.requireAuth');
const portalCases = require('../services/portalCaseService');

const NOT_FOUND = { status: 'error', message: 'Not found' };

// ── GET /api/portal/cases ───────────────────────────────────────────────────

router.get(
  '/api/portal/cases',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    try {
      const cases = await portalCases.listCases(req.db, req.auth.contactId);
      res.json({ status: 'success', cases });
    } catch (err) {
      console.error('[portal] cases list error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

// ── GET /api/portal/cases/:caseId ───────────────────────────────────────────

router.get(
  '/api/portal/cases/:caseId',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    try {
      const view = await portalCases.getCaseView(
        req.db,
        req.auth.contactId,
        req.params.caseId
      );
      if (!view) return res.status(404).json(NOT_FOUND);

      // Scope confirmed — attribute the access-log row to this case.
      req.portalCaseId = view.case_id;
      res.json({ status: 'success', case: view });
    } catch (err) {
      console.error('[portal] case view error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

module.exports = router;
