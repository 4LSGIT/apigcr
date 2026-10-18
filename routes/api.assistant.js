// routes/api.assistant.js — staff-facing read-only conversational assistant.

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { makeLimiter } = require('../lib/rateLimiter');
const svc = require('../services/assistantService');

const planLimited = makeLimiter(60 * 60 * 1000, 30);
const executeLimited = makeLimiter(60 * 60 * 1000, 60);

function staffOnly(req, res, next) {
  if (req.auth && req.auth.type === 'jwt' && req.auth.userId != null) return next();
  return res.status(403).json({ status: 'error', message: 'The assistant requires a signed-in staff user.' });
}

function fail(res, tag, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) console.error(`[api.assistant] ${tag} error:`, err);
  const body = { status: 'error', message: status >= 500 ? 'The assistant request failed' : err.message };
  if (err && err.detail && status < 500) body.detail = err.detail;
  res.status(status).json(body);
}

router.post('/api/assistant/plan', jwtOrApiKey, staffOnly, async (req, res) => {
  if (planLimited(`u${req.auth.userId}`)) {
    return res.status(429).json({ status: 'error', message: 'You have asked the assistant a lot of questions this hour. Try again later.' });
  }
  try {
    const out = await svc.plan(req.db, {
      question: req.body && req.body.question,
      history: req.body && req.body.history,
      userId: req.auth.userId,
    });
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, 'plan', err); }
});

router.post('/api/assistant/execute', jwtOrApiKey, staffOnly, async (req, res) => {
  if (executeLimited(`u${req.auth.userId}`)) {
    return res.status(429).json({ status: 'error', message: 'You have run a lot of assistant searches this hour. Try again later.' });
  }
  try {
    const out = await svc.execute(req.db, {
      signedTicket: req.body && req.body.ticket,
      userId: req.auth.userId,
      auth: req.auth,
    });
    res.json({ status: 'success', outcome: 'answer', ...out });
  } catch (err) { fail(res, 'execute', err); }
});

module.exports = router;
