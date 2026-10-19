'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction } = require('../lib/auth.superuser');
const svc = require('../services/entityCommsService');
const archiveView = require('../services/commsArchiveView');

function requireJwt(req, res, next) {
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    return res.status(403).json({ status: 'error', message: 'Communications require a signed-in user' });
  }
  next();
}

function sendError(res, label, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) console.error(`[entityComms] ${label}:`, err && err.code ? err.code : '', err && err.message);
  res.status(status).json({ status: 'error', message: status < 500 ? err.message : 'Communications request failed' });
}

function auditSummaryViews(req, out) {
  const ids = archiveView.summaryMediaIds({ messages: out.items });
  if (!ids.length) return;
  auditAdminAction(req.db, {
    tool: 'comms_archive', userId: req.auth.userId, username: req.auth.username ?? null,
    route: req.originalUrl, method: req.method, status: 'success',
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    details: { action: 'view_summary', media_ids: ids.slice(0, 200) },
  }).catch(err => console.error('[entityComms] summary audit failed:', err.message));
}

async function get(req, res, type) {
  try {
    const out = await svc.list(req.db, req.auth, type, req.params.id, req.query || {});
    auditSummaryViews(req, out);
    res.json({ status: 'success', ...out });
  } catch (err) {
    sendError(res, `GET ${type} communications`, err);
  }
}

router.get('/api/contacts/:id/communications', jwtOrApiKey, requireJwt,
  (req, res) => get(req, res, 'contact'));
router.get('/api/cases/:id/communications', jwtOrApiKey, requireJwt,
  (req, res) => get(req, res, 'case'));

router.auditSummaryViews = auditSummaryViews;
module.exports = router;
