// routes/portal.auth.js
//
// Client Portal Slice 1 — auth endpoints. Auto-mounted (routes/ readdir).
// Thin: all logic in services/portalAuthService.js; envelope
// { status:'success', ... } / { status:'error', message } (api.pipeline.js
// style). Limiters from lib/rateLimiter.js — REAL 429s (manage.js
// precedent: rate limiting is not part of the no-oracle surface).
//
// Oracle posture (see the service header for the full statement):
//   * request-pin returns ONE identical 200 for every resolution branch.
//     Even an internal error returns that same 200 (+ alert) — a
//     distinguishable 500 that only fires on some branches would partially
//     re-open the oracle. Malformed identifiers 400 (format is
//     client-known; no oracle concern).
//   * verify-pin returns ONE identical 401 for every failure mode.

'use strict';

const express = require('express');
const router = express.Router();

const { makeLimiter, getClientIp } = require('../lib/rateLimiter');
const requireAuth = require('../lib/auth.requireAuth');
const { isPortalLive } = requireAuth;
const portalAuth = require('../services/portalAuthService');
const { alert } = require('../lib/alerting');

const requestPinLimited = makeLimiter(15 * 60 * 1000, 5);   // 5 / 15min / IP
const verifyPinLimited = makeLimiter(15 * 60 * 1000, 10);   // 10 / 15min / IP

// Global kill switch (app_settings.portal_live, read via requireAuth's
// isPortalLive — one implementation). Session-protected routes already 401
// through requireAuth when the switch is off; the two login endpoints get
// this FRIENDLY 503 instead, so clients see a message rather than a login
// that mysteriously never works. Read errors fail OPEN (a DB hiccup must
// not present as "portal disabled"; the real error then surfaces through
// the endpoint's own handling). Not part of the no-oracle surface: the
// switch's state is global, not per-account (RATE_LIMITED precedent).
const PORTAL_DOWN = {
  status: 'error',
  message: 'The client portal is temporarily unavailable. Please try again later or call our office.',
};
async function portalDown(db) {
  try { return !(await isPortalLive(db)); } catch (_) { return false; }
}

const GENERIC_REQUEST_OK = {
  status: 'success',
  message: 'If we found a matching account, a code is on its way.',
};
const VERIFY_FAIL = { status: 'error', message: 'Invalid or expired code.' };
const RATE_LIMITED = { status: 'error', message: 'Too many requests. Please try again later.' };

// ── POST /api/portal/request-pin ────────────────────────────────────────────

router.post('/api/portal/request-pin', async (req, res) => {
  const ip = getClientIp(req);
  if (requestPinLimited(ip)) {
    return res.status(429).json(RATE_LIMITED);
  }
  if (await portalDown(req.db)) {
    return res.status(503).json(PORTAL_DOWN);
  }

  const { identifier } = req.body || {};
  const parsed = portalAuth.parseIdentifier(identifier);
  if (!parsed.kind) {
    return res.status(400).json({
      status: 'error',
      message: 'Enter a valid phone number or email address.',
    });
  }

  try {
    await portalAuth.requestPin(req.db, { identifier, ip });
  } catch (err) {
    // Same generic 200 even on internal error — see oracle posture above.
    console.error('[portal] request-pin error:', err.message);
    alert(req.db, {
      source: 'app', kind: 'portal_request_pin_error', severity: 'error',
      group_key: 'portal:request_pin_error',
      title: 'Portal request-pin internal error',
      message: err.stack || err.message,
    });
  }
  res.json(GENERIC_REQUEST_OK);
});

// ── POST /api/portal/verify-pin ─────────────────────────────────────────────

router.post('/api/portal/verify-pin', async (req, res) => {
  const ip = getClientIp(req);
  if (verifyPinLimited(ip)) {
    return res.status(429).json(RATE_LIMITED);
  }
  if (await portalDown(req.db)) {
    return res.status(503).json(PORTAL_DOWN);
  }

  const { identifier, pin, trust_device } = req.body || {};
  const parsed = portalAuth.parseIdentifier(identifier);
  if (!parsed.kind) {
    return res.status(400).json({
      status: 'error',
      message: 'Enter a valid phone number or email address.',
    });
  }

  // trust_device default TRUE when absent (checkbox default-checked).
  const trustDevice = trust_device === undefined ? true : !!trust_device;

  try {
    const result = await portalAuth.verifyPin(req.db, {
      identifier, pin, trustDevice, ip,
    });
    if (result.ok) {
      return res.json({ status: 'success', token: result.token });
    }
    return res.status(401).json(VERIFY_FAIL);
  } catch (err) {
    // One failure message for EVERY failure mode, internal errors included.
    console.error('[portal] verify-pin error:', err.message);
    alert(req.db, {
      source: 'app', kind: 'portal_verify_pin_error', severity: 'error',
      group_key: 'portal:verify_pin_error',
      title: 'Portal verify-pin internal error',
      message: err.stack || err.message,
    });
    return res.status(401).json(VERIFY_FAIL);
  }
});

// ── POST /api/portal/logout ─────────────────────────────────────────────────
// Stateless tokens — logout is client-side discard + the log row (the
// requireAuth finish hook writes it, tagged via req.portalLogEvent).
// All-device revoke is the staff-side portal_session_version bump, not this.

router.post('/api/portal/logout', requireAuth({ audience: 'contact' }), (req, res) => {
  req.portalLogEvent = 'logout';
  res.json({ status: 'success' });
});

// ── GET /api/portal/me ──────────────────────────────────────────────────────
// features:{} is the S2 data-driven-tab hook — empty object now, shape
// load-bearing (the frontend will iterate it to decide which tabs render).

router.get('/api/portal/me', requireAuth({ audience: 'contact' }), async (req, res) => {
  try {
    const me = await portalAuth.getMe(req.db, req.auth.contactId);
    res.json({ status: 'success', name: me.name, features: {} });
  } catch (err) {
    console.error('[portal] me error:', err.message);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

module.exports = router;
