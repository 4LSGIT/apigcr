// routes/api.assistant.js — staff conversation and recording-only action receipts.

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { makeLimiter } = require('../lib/rateLimiter');
const svc = require('../services/assistantService');
const chats = require('../services/assistantChatService');
const ledger = require('../services/assistantActionLedger');

const planLimited = makeLimiter(60 * 60 * 1000, 30);
const executeLimited = makeLimiter(60 * 60 * 1000, 60);
// Chat-history reads/writes: generous for real use (each question saves two
// messages; applying a card saves one more), a ceiling against a runaway
// client. Per-process like every makeLimiter (× instance count).
const chatLimited = makeLimiter(60 * 60 * 1000, 600);

function chatRate(req, res, next) {
  if (chatLimited(`u${req.auth.userId}`)) {
    return res.status(429).json({ status: 'error', message: 'Too many chat-history requests this hour. Try again later.' });
  }
  return next();
}

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
      modelMode: req.body && req.body.model_mode,
      temporaryAttachments: req.body && req.body.temporary_attachments,
      documentIds: req.body && req.body.document_ids,
      workspaceContext: req.body && req.body.workspace_context,
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
      // R1: a sealed continuation (the user's "Keep going" click) and the chat
      // it is bound to. Evidence is never read from the body.
      continuation: req.body && req.body.continuation,
      chatId: req.body && req.body.chat_id,
      userId: req.auth.userId,
      auth: req.auth,
      temporaryAttachments: req.body && req.body.temporary_attachments,
    });
    // Older browser builds still use chat markers and cannot claim receipts.
    if (out.action_draft && req.body && req.body.action_ledger_version === 1) {
      await ledger.issue(req.db, req.auth.userId, out.action_draft);
    }
    res.json({ status: 'success', outcome: 'answer', ...out });
  } catch (err) { fail(res, 'execute', err); }
});

router.get('/api/assistant/chats', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    res.json({ status: 'success', chats: await chats.list(req.db, req.auth.userId) });
  } catch (err) { fail(res, 'list chats', err); }
});

router.post('/api/assistant/chats', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    const chat = await chats.create(req.db, {
      userId: req.auth.userId,
      question: req.body && req.body.question,
      modelMode: req.body && req.body.model_mode,
      payload: req.body && req.body.payload,
    });
    res.status(201).json({ status: 'success', chat });
  } catch (err) { fail(res, 'create chat', err); }
});

router.get('/api/assistant/chats/:id(\\d+)', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    res.json({ status: 'success', chat: await chats.get(req.db, req.params.id, req.auth.userId) });
  } catch (err) { fail(res, 'get chat', err); }
});

router.post('/api/assistant/chats/:id(\\d+)/messages', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    await chats.addMessage(req.db, req.params.id, req.auth.userId, req.body || {});
    res.status(201).json({ status: 'success' });
  } catch (err) { fail(res, 'add chat message', err); }
});

router.patch('/api/assistant/chats/:id(\\d+)', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    const chat = await chats.setModelMode(req.db, req.params.id, req.auth.userId, req.body && req.body.model_mode);
    res.json({ status: 'success', chat });
  } catch (err) { fail(res, 'set chat model mode', err); }
});

router.delete('/api/assistant/chats/:id(\\d+)', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try {
    await chats.remove(req.db, req.params.id, req.auth.userId);
    res.json({ status: 'success' });
  } catch (err) { fail(res, 'delete chat', err); }
});

// These endpoints only record/reconcile user actions; they never call a
// business writer. Authentication and user scope come from the staff JWT.
router.post('/api/assistant/actions/reconcile', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try { res.json({ status: 'success', actions: await ledger.read(req.db, req.auth.userId, req.body && req.body.draft_ids) }); }
  catch (err) { fail(res, 'reconcile actions', err); }
});
router.post('/api/assistant/actions/:draftId/claim', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try { res.json({ status: 'success', ...await ledger.claim(req.db, req.auth.userId, req.params.draftId) }); }
  catch (err) { fail(res, 'claim action', err); }
});
router.post('/api/assistant/actions/:draftId/result', jwtOrApiKey, staffOnly, chatRate, async (req, res) => {
  try { res.json({ status: 'success', ...await ledger.record(req.db, req.auth.userId, req.params.draftId,
    req.body && req.body.claim_token, req.body && req.body.result) }); }
  catch (err) { fail(res, 'record action', err); }
});
module.exports = router;
