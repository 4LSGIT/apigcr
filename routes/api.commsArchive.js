// routes/api.commsArchive.js
//
/**
 * Comms archive admin API — ref/COMMS_ARCHIVE_DESIGN.md §8 (restrict / purge),
 * §7 P9 (audit), §0 R9 (who). S1b: driven from the console (apiSend); the UI
 * comes with S4.
 *
 *   POST /api/comms-archive/media/:id/restrict    {reason}            → restricted = 1
 *   POST /api/comms-archive/media/:id/unrestrict  {reason}            → restricted = 0
 *   POST /api/comms-archive/media/:id/purge       {reason, confirm}   → irreversible (§8);
 *                                                                       confirm must equal :id
 *
 * WHO: a staff JWT whose user passes services/commsArchiveAdmin.isArchiveAdmin
 * (SU, or listed in app_settings comms_archive_admins). An API key is refused
 * even if it maps to a listed user — these are named-human acts.
 *
 * AUDIT (P9): every attempt that reaches this router, rejects included,
 * writes an admin_audit_log row — tool 'comms_archive', details { action,
 * media_id, reason? } (the table has no action column; route / method / user
 * via reqMeta; never any content). A request with no valid credential is
 * 401'd by jwtOrApiKey before it gets here (that middleware logs its own
 * attempt in jwt_api_audit_log). A PURGE writes an 'attempt' row BEFORE the
 * destructive step and its outcome after; if the attempt row cannot be
 * written the purge is refused (503) — nothing is purged unaudited.
 *
 * RATE: purges are limited per user (PURGE_PER_HOUR, the lib/rateLimiter
 * pattern, per instance) — over the limit is a 429, audited.
 *
 * comms_media is not a sync-bus entity (no ycSync matcher): nothing renders it
 * live until S4.
 *
 * Auto-mounted (server.js readdirSync); req.db injected.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction } = require('../lib/auth.superuser');
const { makeLimiter } = require('../lib/rateLimiter');
const admin = require('../services/commsArchiveAdmin');

const TOOL = 'comms_archive';
const MAX_REASON = 500;
const HOUR_MS = 60 * 60 * 1000;
const PURGE_PER_HOUR = 20;
let purgeLimited = makeLimiter(HOUR_MS, PURGE_PER_HOUR);

function reqMeta(req, tool) {
  return {
    tool,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

async function audit(req, status, details, errorMessage = null) {
  try {
    await auditAdminAction(req.db, { ...reqMeta(req, TOOL), status, details, errorMessage });
  } catch (err) {
    console.error('[commsArchive] audit log failed:', err.message);
  }
}

function handler(action) {
  return async (req, res) => {
    const idRaw = String(req.params.id || '');
    const id = /^\d{1,19}$/.test(idRaw) ? Number(idRaw) : null;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const details = { action, media_id: id ?? idRaw.slice(0, 32) };

    if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
      await audit(req, 'rejected_not_jwt', details);
      return res.status(403).json({ status: 'error', message: 'Archive admin actions require a signed-in user' });
    }
    let ok = false;
    try { ok = await admin.isArchiveAdmin(req.db, req.auth); } catch (err) {
      console.error('[commsArchive] isArchiveAdmin error:', err.code || '', err.message);
      await audit(req, 'error', details, 'admin check failed');
      return res.status(500).json({ status: 'error', message: 'Archive request failed' });
    }
    if (!ok) {
      await audit(req, 'rejected_not_admin', details);
      return res.status(403).json({ status: 'error', message: 'Archive admins only' });
    }
    if (id == null) {
      await audit(req, 'rejected_bad_request', details, 'bad id');
      return res.status(400).json({ status: 'error', message: 'Bad archive item id' });
    }
    if (!reason || reason.length > MAX_REASON) {
      await audit(req, 'rejected_bad_request', details, 'reason required (1–500 chars)');
      return res.status(400).json({ status: 'error', message: `A reason is required (1–${MAX_REASON} characters)` });
    }
    details.reason = reason;
    if (action === 'purge' && String(req.body?.confirm ?? '') !== String(id)) {
      await audit(req, 'rejected_bad_request', details, 'confirm must equal the id');
      return res.status(400).json({ status: 'error', message: 'Purge is irreversible: send confirm equal to the item id' });
    }
    if (action === 'purge') {
      if (purgeLimited(`u${req.auth.userId}`)) {
        await audit(req, 'rejected_rate_limited', details);
        return res.status(429).json({ status: 'error', message: `At most ${PURGE_PER_HOUR} purges per hour` });
      }
      // The attempt is on record BEFORE anything is destroyed, or nothing is.
      try {
        await auditAdminAction(req.db, { ...reqMeta(req, TOOL), status: 'attempt', details });
      } catch (err) {
        console.error('[commsArchive] purge attempt audit failed — refusing:', err.message);
        return res.status(503).json({ status: 'error', message: 'Audit unavailable — purge refused; retry' });
      }
    }

    try {
      const media = action === 'purge'
        ? await admin.purge(req.db, id, { userId: Number(req.auth.userId), reason })
        : await admin.setRestricted(req.db, id, action === 'restrict');
      await audit(req, 'success', { ...details, ...(media.parts ? { parts: media.parts } : {}) });
      return res.json({ status: 'success', media: { id: media.id, state: media.state, restricted: media.restricted } });
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      if (status >= 500) console.error(`[commsArchive] ${action} error:`, err.message, err.cause ? err.cause.message : '');
      await audit(req, status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'failed', details,
        (err.cause ? `${err.message} (${err.cause.message})` : err.message || '').slice(0, 1000));
      return res.status(status).json({ status: 'error', message: err.expose ? err.message : 'Archive request failed' });
    }
  };
}

router.post('/api/comms-archive/media/:id/restrict', jwtOrApiKey, handler('restrict'));
router.post('/api/comms-archive/media/:id/unrestrict', jwtOrApiKey, handler('unrestrict'));
router.post('/api/comms-archive/media/:id/purge', jwtOrApiKey, handler('purge'));

/** Test hook: a fresh purge limiter (optionally with another per-hour max). */
router._resetPurgeLimit = (max = PURGE_PER_HOUR) => { purgeLimited = makeLimiter(HOUR_MS, max); };

module.exports = router;
