// routes/portal.callback.js
//
// Client Portal Slice 3.5 — callback requests. Auto-mounted (routes/
// readdir). Thin: all logic in services/portalCallbackService.js; envelope
// { status:'success', ... } / { status:'error', message } (portal.auth.js
// style).
//
//   GET  /api/portal/callback         — pending request + offer grid + phone
//   POST /api/portal/callback         — create (5/min/IP)
//   POST /api/portal/callback/cancel  — cancel the open request (5/min/IP)
//
// Contact-level scope (Phase A decision): no :caseId, no req.portalCaseId —
// portal_access_log rows attribute to the contact via requireAuth as usual.
// The service's open-request lookup is scoped to the authed contact, so a
// foreign request can never be reached; cancel with nothing open returns
// the uniform 404 body (oracle posture, S2/S3 precedent).
//
// Respond-first sequencing (S3 precedent): create's GCal event and cancel's
// assignee notification fire AFTER the 200, detached, self-caught in the
// service. The reminder-job insert is inside createRequest (awaited) — it
// is core to the feature, not a side effect.

'use strict';

const express = require('express');
const router = express.Router();

const requireAuth = require('../lib/auth.requireAuth');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');
const svc = require('../services/portalCallbackService');

const NOT_FOUND    = { status: 'error', message: 'Not found' };
const RATE_LIMITED = { status: 'error', message: 'Too many requests. Please try again later.' };

const createLimited = makeLimiter(60 * 1000, 5);  // 5 / min / IP
const cancelLimited = makeLimiter(60 * 1000, 5);  // 5 / min / IP

// ── GET /api/portal/callback ────────────────────────────────────────────────

router.get(
  '/api/portal/callback',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    try {
      const state = await svc.getState(req.db, req.auth.contactId);
      res.json({ status: 'success', ...state });
    } catch (err) {
      console.error('[portal] callback state error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

// ── POST /api/portal/callback ───────────────────────────────────────────────
// Body: { date:'YYYY-MM-DD', window:'14-16', phone, message }

router.post(
  '/api/portal/callback',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    if (createLimited(getClientIp(req))) {
      return res.status(429).json(RATE_LIMITED);
    }
    try {
      const ctx = await svc.createRequest(req.db, req.auth.contactId, req.body || {});
      res.json({
        status: 'success',
        message: 'Callback request received.',
        pending: ctx.pending,
      });
      svc.fireCreateSideEffects(req.db, ctx);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      if (err.status === 409) {
        return res.status(409).json({
          status: 'error',
          code: 'pending_exists',
          message: err.message,
          pending: err.pending || null,
        });
      }
      console.error('[portal] callback create error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

// ── POST /api/portal/callback/cancel ────────────────────────────────────────

router.post(
  '/api/portal/callback/cancel',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    if (cancelLimited(getClientIp(req))) {
      return res.status(429).json(RATE_LIMITED);
    }
    try {
      const ctx = await svc.cancelRequest(req.db, req.auth.contactId);
      if (!ctx) return res.status(404).json(NOT_FOUND);

      res.json({ status: 'success', message: 'Your callback request was canceled.' });
      svc.fireCancelSideEffects(req.db, ctx);
    } catch (err) {
      console.error('[portal] callback cancel error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

module.exports = router;
