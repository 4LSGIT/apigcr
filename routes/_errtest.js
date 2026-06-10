// routes/_errtest.js  —  TEMPORARY. Delete after verifying Slice 3b alerting.
//
// Auto-mounts via the server.js readdirSync loop. INERT unless
// ERRTEST_ENABLED=1. Every endpoint also requires header
//   X-Errtest-Key: <ERRTEST_KEY env value>
// so it can't be poked by randoms even if the flag is left on.
//
// Maps 1:1 to the Slice 3b test plan:
//   /errtest/self-500  → route self-handles 500 (the case slice 3 missed)
//   /errtest/next-500  → next(err)        → stack-enriched single alert
//   /errtest/throw-500 → sync throw       → same path as next(err)
//   /errtest/reject    → async rejection  → unhandled_rejection guard; HANGS
//   /errtest/503       → any 5xx alerts (not just 500)
//   /errtest/400       → 4xx → NO alert
//   /errtest/uncaught  → uncaught_exception guard; KILLS the instance

const express = require('express');
const router = express.Router();

const ENABLED = process.env.ERRTEST_ENABLED === '1';
const KEY = process.env.ERRTEST_KEY || '';

function gate(req, res, next) {
  if (!KEY || req.get('X-Errtest-Key') !== KEY) {
    return res.status(401).json({ error: 'bad errtest key' });
  }
  next();
}

if (ENABLED) {
  // 1. SELF-HANDLED 500 — catches and responds itself; never next(err).
  //    Slice 3 could not see this. Observer emits an alert whose message is
  //    the response body (no stack available).
  router.get('/errtest/self-500', gate, async (req, res) => {
    try {
      throw new Error('errtest self-handled 500');
    } catch (err) {
      console.error('[errtest] self-500:', err.message);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // 2. next(err) — errorMiddleware stashes the stack on res.locals._errStack;
  //    observer emits ONE alert containing the stack.
  router.get('/errtest/next-500', gate, (req, res, next) => {
    next(new Error('errtest next(err) 500'));
  });

  // 2b. SYNC THROW in handler — Express 4 catches synchronous throws and
  //     routes them to error middleware (identical path to next(err)).
  router.get('/errtest/throw-500', gate, (req, res) => {
    throw new Error('errtest sync throw 500');
  });

  // 3. ASYNC REJECTION, no try/catch — Express 4 does NOT route this to
  //    middleware; it surfaces as an unhandledRejection. The request HANGS
  //    (no response ever sent) — EXPECTED. Use curl --max-time.
  router.get('/errtest/reject', gate, async (req, res) => {
    throw new Error('errtest async unhandled rejection');
  });

  // 4. Clean 4xx — must NOT alert.
  router.get('/errtest/400', gate, (req, res) => {
    res.status(400).json({ status: 'error', message: 'errtest 400 (no alert expected)' });
  });

  // 5. Non-500 5xx — observer keys on >=500, so this alerts with title
  //    "503 on GET /errtest/503".
  router.get('/errtest/503', gate, (req, res) => {
    res.status(503).json({ status: 'error', message: 'errtest 503' });
  });

  // 6. UNCAUGHT EXCEPTION — DANGER: kills the instance (process.exit(1) ~2s
  //    after the alert flush). Requires ?confirm=1 on top of the key. Throws
  //    on a timer so it escapes the request handler entirely.
  router.get('/errtest/uncaught', gate, (req, res) => {
    if (req.query.confirm !== '1') {
      return res.status(400).json({ error: 'add ?confirm=1 — this KILLS the instance' });
    }
    res.json({ status: 'scheduled', note: 'uncaught throw in ~0.5s, exit in ~2.5s' });
    setTimeout(() => { throw new Error('errtest uncaught exception'); }, 500);
  });

  console.warn('[errtest] ⚠ error-test routes ENABLED. Remove routes/_errtest.js before normal operation.');
}

module.exports = router;