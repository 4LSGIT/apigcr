// routes/portal.home.js
//
// Client Portal Slice 5 — the home-page aggregate. Auto-mounted
// (routes/ readdir). Thin: composition of existing services; envelope
// { status:'success', ... } / { status:'error', message } (portal.cases.js
// style).
//
//   GET /api/portal/home → { status:'success', name, cases, cards }
//
//     name   — portalAuthService.getMe (the contact's first name)
//     cases  — portalCaseService.listCases (the same list /api/portal/cases
//              serves — title/docket/current_stage_label per case)
//     cards  — portalCardEngine.renderCards pinned to the authed contact
//              with placement 'home' and caseId NULL: the home surface is
//              CASE-LESS by contract (S5). No req.portalCaseId is ever set
//              here — the access-log row for this route carries no case,
//              correctly.
//
// Shape rationale (manager judgment, flagged): one aggregate endpoint =
// one round-trip for home.html and exactly one portal_access_log row per
// home view, instead of three. The pieces stay independently reachable
// (/me, /cases) for pages that need them alone.
//
// Rate limiting: none per-route — authed read, every request logs
// (portal.cases.js precedent).

'use strict';

const express = require('express');
const router = express.Router();

const requireAuth = require('../lib/auth.requireAuth');
const portalAuth  = require('../services/portalAuthService');
const portalCases = require('../services/portalCaseService');
const cardEngine  = require('../lib/portalCardEngine');

/** The aggregate payload for one authed contact. */
async function getHome(db, contactId) {
  // renderCards fails closed internally ([] on any engine-level error); the
  // other two throw upward to the route's 500 like their own routes do.
  const [me, cases, cards] = await Promise.all([
    portalAuth.getMe(db, contactId),
    portalCases.listCases(db, contactId),
    cardEngine.renderCards(db, { caseId: null, contactId, placement: 'home' }),
  ]);
  return { name: me.name, cases, cards };
}

// ── GET /api/portal/home ────────────────────────────────────────────────────

router.get(
  '/api/portal/home',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    try {
      const home = await getHome(req.db, req.auth.contactId);
      res.json({ status: 'success', ...home });
    } catch (err) {
      console.error('[portal] home error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

module.exports = router;
// exported for tests (repo pattern: api.portalCardsAdmin)
module.exports._getHome = getHome;
