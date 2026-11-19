// routes/portal.docs.js
//
// Client Portal Slice 3 — per-case document checklist + uploads.
// Auto-mounted (routes/ readdir). Thin: all logic in
// services/portalDocsService.js; envelope { status:'success', ... } /
// { status:'error', message } (portal.auth.js style).
//
//   GET  /api/portal/cases/:caseId/docs                — checklist + statuses
//   POST /api/portal/cases/:caseId/docs/upload-link    — Dropbox temp link
//   POST /api/portal/cases/:caseId/docs/upload-landed  — one file landed (docs intake S3)
//   POST /api/portal/cases/:caseId/docs/upload-complete — notify + case log
//
// The public docReq surface (routes/api.checklists.js /api/public/*) stays
// live and untouched — links are in the wild; retirement is a later,
// deliberate decision.
//
// Oracle posture (manage.js / S2 philosophy): out-of-scope and nonexistent
// case ids return the SAME 404 { status:'error', message:'Not found' }.
// A foreign/unknown itemId on upload-link gets the same body — item ids
// are not probeable either.
//
// req.portalCaseId: set from the service's canonical case_id once scope is
// confirmed — including on validation 400s (the service stamps
// err.portalCaseId), so portal_access_log attributes rejected uploads too.
//
// Rate limiting (S3 judgment, flagged for ratification):
//   - GET docs: no per-route limiter — S2 precedent (authed reads are
//     unlimited; every request already writes a portal_access_log row).
//   - The two upload mutations touch Dropbox + email/log side effects, so
//     they carry modest per-IP limiters mirroring the public routes'
//     numbers: upload-link 30/min (each file needs a link; big batches are
//     legitimate), upload-complete 10/min. lib/rateLimiter.js semantics
//     (fixed window, per-instance, XFF-LAST keying — do not change).
//   - upload-landed (S3): 60/min — one call per landed file, so a 50-file
//     run is legitimate.

'use strict';

const express = require('express');
const router = express.Router();

const requireAuth = require('../lib/auth.requireAuth');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');
const portalDocs = require('../services/portalDocsService');

const NOT_FOUND    = { status: 'error', message: 'Not found' };
const RATE_LIMITED = { status: 'error', message: 'Too many requests. Please try again later.' };

const uploadLinkLimited     = makeLimiter(60 * 1000, 30);  // 30 / min / IP
const uploadCompleteLimited = makeLimiter(60 * 1000, 10);  // 10 / min / IP
const uploadLandedLimited   = makeLimiter(60 * 1000, 60);  // 60 / min / IP

/** Shared error → response mapping for the two POST routes. */
function respondError(res, req, err, label) {
  if (err && err.portalCaseId) req.portalCaseId = err.portalCaseId;
  if (err && err.status === 404) return res.status(404).json(NOT_FOUND);
  if (err && err.status === 400) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
  console.error(`[portal] ${label} error:`, err.message);
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

// ── GET /api/portal/cases/:caseId/docs ──────────────────────────────────────

router.get(
  '/api/portal/cases/:caseId/docs',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    try {
      const docs = await portalDocs.listDocs(
        req.db, req.auth.contactId, req.params.caseId
      );
      if (!docs) return res.status(404).json(NOT_FOUND);

      req.portalCaseId = docs.case_id;
      res.json({
        status: 'success',
        case_id: docs.case_id,
        has_upload: docs.has_upload,
        items: docs.items,
      });
    } catch (err) {
      console.error('[portal] docs list error:', err.message);
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
);

// ── POST /api/portal/cases/:caseId/docs/upload-link ─────────────────────────
// Body: { item_id?, filename, size, content_type? }

router.post(
  '/api/portal/cases/:caseId/docs/upload-link',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    if (uploadLinkLimited(getClientIp(req))) {
      return res.status(429).json(RATE_LIMITED);
    }
    try {
      const { item_id, filename, size, content_type } = req.body || {};
      const result = await portalDocs.createUploadLink(
        req.db, req.auth.contactId, req.params.caseId,
        { itemId: item_id, filename, size, contentType: content_type }
      );
      if (!result) return res.status(404).json(NOT_FOUND);

      req.portalCaseId = result.case_id;
      res.json({ status: 'success', link: result.link });
    } catch (err) {
      respondError(res, req, err, 'upload-link');
    }
  }
);

// ── POST /api/portal/cases/:caseId/docs/upload-landed ───────────────────────
// Body: { batch, file: { name, item_id? }, comment? }
//
// Docs intake S3: the page reports each file the moment its Dropbox PUT
// succeeds (fetch keepalive), appending it to the run's batch row. Answers
// AFTER the write (one upsert — a write lost behind an early 200 would defeat
// the slice). A refused append (batch already closed) is still a success to the
// page; it has nothing to do about it.

router.post(
  '/api/portal/cases/:caseId/docs/upload-landed',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    if (uploadLandedLimited(getClientIp(req))) {
      return res.status(429).json(RATE_LIMITED);
    }
    try {
      const { batch, file, comment } = req.body || {};
      const result = await portalDocs.recordLanded(
        req.db, req.auth.contactId, req.params.caseId, { batch, file, comment }
      );
      if (!result) return res.status(404).json(NOT_FOUND);

      req.portalCaseId = result.case_id;
      res.json({ status: 'success' });
    } catch (err) {
      respondError(res, req, err, 'upload-landed');
    }
  }
);

// ── POST /api/portal/cases/:caseId/docs/upload-complete ─────────────────────
// Body: { files: [{ name, item_id? }], comment?, batch? }
//
// Respond-first sequencing (public-route parity): validation + resolution
// happen before the 200; the email + case-log side effects fire AFTER it,
// detached, each self-caught inside the service.

router.post(
  '/api/portal/cases/:caseId/docs/upload-complete',
  requireAuth({ audience: 'contact' }),
  async (req, res) => {
    if (uploadCompleteLimited(getClientIp(req))) {
      return res.status(429).json(RATE_LIMITED);
    }
    try {
      const { files, comment, batch } = req.body || {};
      const ctx = await portalDocs.completeUpload(
        req.db, req.auth.contactId, req.params.caseId, { files, comment, batch }
      );
      if (!ctx) return res.status(404).json(NOT_FOUND);

      req.portalCaseId = ctx.case_id;
      res.json({ status: 'success', message: 'Notification received. Thank you!' });

      portalDocs.sendUploadNotifications(req.db, ctx)
        .catch(err => console.error('[portal] upload-complete side effects error:', err.message));
    } catch (err) {
      respondError(res, req, err, 'upload-complete');
    }
  }
);

module.exports = router;