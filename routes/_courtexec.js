// routes/_courtexec.js  —  TEMPORARY. Commit-and-delete-later test harness.
//
// Auto-mounts via the server.js readdirSync loop. INERT unless
// COURTEXEC_ENABLED=1. Every endpoint also requires header
//   X-Courtexec-Key: <COURTEXEC_KEY env value>
// so it can't be poked by randoms even if the flag is left on.
//
// Slice 5 (ingest internal_function) will call executeCourtActions() directly —
// services/courtExecutor.js is the real entry point; this route is only a way
// to drive payloads through it during testing. Delete after the court action
// layer is wired into ingest.
//
//   POST /courtexec   body { payload, subject, body, dryRun }
//     → executeCourtActions(req.db, { payload, subject, body, dryRun })
//
// NOTE: dryRun defaults true inside the service. A message_id containing
// '-test-' FORCES dry-run regardless of the dryRun flag.

const express = require('express');
const router = express.Router();

const { executeCourtActions } = require('../services/courtExecutor');

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
      const { payload, subject, body, dryRun } = req.body || {};
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ status: 'error', message: 'payload (object) is required' });
      }
      const result = await executeCourtActions(req.db, { payload, subject, body, dryRun });
      return res.json({ status: 'ok', result });
    } catch (err) {
      console.error('[courtexec] error:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  });

  console.warn('[courtexec] ⚠ court-executor test route ENABLED. Remove routes/_courtexec.js before normal operation.');
}

module.exports = router;