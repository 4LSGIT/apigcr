// routes/_courtexec.js  —  TEMPORARY. Commit-and-delete-later test harness.
//
// Auto-mounts via the server.js readdirSync loop. INERT unless
// COURTEXEC_ENABLED=1. Every endpoint also requires header
//   X-Courtexec-Key: <COURTEXEC_KEY env value>
// so it can't be poked by randoms even if the flag is left on.
//
// Slice 5 (ingest internal_function) will call executeCourtActions() /
// revertCourtActions() directly — services/courtExecutor.js is the real entry
// point; this route is only a way to drive payloads through them during
// testing. Delete after the court action layer is wired into ingest.
//
//   POST /courtexec   body { payload, subject, body, dryRun }
//     → executeCourtActions(req.db, { payload, subject, body, dryRun })
//
//   POST /courtexec   body { op:'revert', messageId | changeLogIds, dryRun, actingUserId }
//     → revertCourtActions(req.db, { messageId, changeLogIds, dryRun, actingUserId })
//
// NOTE: execute dryRun defaults true inside the service; a message_id containing
// '-test-' FORCES dry-run. revert dryRun ALSO defaults true (preview).
//
// op-less (or op !== 'revert') bodies take the execute path, unchanged.

const express = require('express');
const router = express.Router();

const { executeCourtActions, revertCourtActions } = require('../services/courtExecutor');

const ENABLED = process.env.COURTEXEC_ENABLED === '1';
const KEY = process.env.COURTEXEC_KEY || '';

function gate(req, res, next) {
  if (!KEY || req.get('X-Courtexec-Key') !== KEY) {
    return res.status(401).json({ error: 'bad courtexec key' });
  }
  next();
}

if (ENABLED) {
  router.post('/courtexec', gate, async (req, res) => {
    try {
      const body = req.body || {};

      // ── REVERT PATH ──────────────────────────────────────────────────
      if (body.op === 'revert') {
        const { messageId, changeLogIds, dryRun, actingUserId } = body;
        const hasIds = Array.isArray(changeLogIds) && changeLogIds.length > 0;
        if (!messageId && !hasIds) {
          return res.status(400).json({
            status: 'error',
            message: 'revert requires messageId or non-empty changeLogIds[]',
          });
        }
        const result = await revertCourtActions(req.db, {
          messageId,
          changeLogIds,
          dryRun,                 // undefined → service default (true)
          actingUserId: actingUserId != null ? actingUserId : 0,
        });
        return res.json({ status: 'ok', result });
      }

      // ── EXECUTE PATH (existing) ──────────────────────────────────────
      const { payload, subject, body: emailBody, dryRun } = body;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ status: 'error', message: 'payload (object) is required' });
      }
      const result = await executeCourtActions(req.db, { payload, subject, body: emailBody, dryRun });
      return res.json({ status: 'ok', result });
    } catch (err) {
      console.error('[courtexec] error:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  });

  console.warn('[courtexec] ⚠ court-executor test route ENABLED. Remove routes/_courtexec.js before normal operation.');
}

module.exports = router;