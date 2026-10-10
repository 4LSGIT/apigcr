// routes/api.mail.js
//
/**
 * Mail (comms hub, Email tab) API — mailbox-system arc, slice S2
 * routes/api.mail.js
 *
 *   GET    /api/mail/mailboxes                readable mailboxes + INBOX unread/total (view switcher)
 *   GET    /api/mail/messages                 the mixed-inbox list — keyset-paginated, NO bodies
 *            ?view=&mailbox_ids=1,2&unread_only=1&has_case=1|no_case=1&client_only=1
 *             &has_files=1&all_folders=1&from_domain=example.com&q=…
 *             &cursor=<next_cursor>&limit=≤100
 *   GET    /api/mail/messages/:id             one message with bodies (threadless mail)
 *   GET    /api/mail/threads/:threadKey       the thread, merged across readable mailboxes (bodies)
 *   POST   /api/mail/messages/:id/read        mark read   (idempotent)
 *   DELETE /api/mail/messages/:id/read        mark unread (idempotent)
 *   POST   /api/mail/read                     bulk mark read: {ids:[…≤500]} |
 *                                             {all:true, mailbox_ids?, filters?} = everything the
 *                                             list shows for that scope (every page)
 *   GET    /api/mail/views                    the caller's saved views
 *   GET    /api/mail/views/counts             {counts: {<view id>: unread}} — each view's INBOX
 *                                             unread under its own mailboxes + filters
 *   POST   /api/mail/views                    {name, mailbox_ids?, filters?, is_default?, sort_order?}
 *   PATCH  /api/mail/views/:id                caller-owned only (404 otherwise)
 *   DELETE /api/mail/views/:id                caller-owned only (404 otherwise)
 *   POST   /api/mail/messages/:id/case-link   {case_id} — about-link the message's log row
 *                                             to a case; a store-only message gets its
 *                                             log row created first
 *   GET    /api/mail/messages/:id/related     contacts behind the conversation's outside
 *                                             addresses + their client cases (open the file),
 *                                             + the outside addresses no contact holds
 *   GET    /api/mail/first-seen?address=      firm-local day of the earliest readable mail
 *                                             with that address (add-to-client start date)
 *   GET    /api/mail/image-senders            the caller's "always show images from" senders
 *   POST   /api/mail/image-senders            {address} — trust one (idempotent)
 *   DELETE /api/mail/image-senders/:address   stop trusting one (encodeURIComponent it)
 *
 * Auto-mounted (server.js readdirSync); req.db injected. UI: public/comms.html.
 * Service: services/mailbox/mailReadService.js. Spec: ref/MAILBOX_SYSTEM_DESIGN.md
 * §4.3, §4.4, D6.
 *
 * ENFORCEMENT SEAT (D6): grant resolution runs in mailReadService through
 * mailboxService (listReadable / getAccess) on these interactive routes only.
 * HUMANS ONLY: every route needs a staff JWT — grants and read state resolve
 * against a person (S0 rule); an x-api-key caller gets 403.
 *
 * ERRORS follow routes/api.mailboxes.js: the service throws status-bearing
 * errors; 5xx log code + message only (mysql2 attaches the SQL to the error
 * object, and these statements carry mail addresses).
 *
 * Attachments are NOT served here: the client fetches them through the S1 part
 * route (GET /api/mailboxes/:id/messages/:mid/parts/:part) with apiSend's blob
 * responseType — the same grant check, the same inline allowlist + nosniff.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/mailbox/mailReadService');

function sendError(res, label, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) {
    console.error(`[mail] ${label} error:`, err && err.code ? err.code : '', err && err.message);
  }
  res.status(status).json({ status: 'error', message: (status >= 500 ? null : err && err.message) || 'Mail request failed' });
}

/** Staff JWT only — grants and read state resolve against a user id. */
function requireJwt(req, res, next) {
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    return res.status(403).json({ status: 'error', message: 'Mail routes require a signed-in user' });
  }
  next();
}

const guard = [jwtOrApiKey, requireJwt];

// ─── GET /api/mail/mailboxes ───
router.get('/api/mail/mailboxes', ...guard, async (req, res) => {
  try {
    const out = await svc.summary(req.db, req.auth.userId);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'GET /api/mail/mailboxes', err); }
});

// ─── GET /api/mail/messages ───
router.get('/api/mail/messages', ...guard, async (req, res) => {
  try {
    const out = await svc.listMessages(req.db, req.auth.userId, req.query || {});
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'GET /api/mail/messages', err); }
});

// ─── GET /api/mail/messages/:id ───
router.get('/api/mail/messages/:id', ...guard, async (req, res) => {
  try {
    const out = await svc.getMessage(req.db, req.auth.userId, req.params.id);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'GET /api/mail/messages/:id', err); }
});

// ─── GET /api/mail/threads/:threadKey ───  (encodeURIComponent the key)
router.get('/api/mail/threads/:threadKey', ...guard, async (req, res) => {
  try {
    const out = await svc.getThread(req.db, req.auth.userId, req.params.threadKey);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'GET /api/mail/threads/:threadKey', err); }
});

// ─── POST / DELETE /api/mail/messages/:id/read ───
router.post('/api/mail/messages/:id/read', ...guard, async (req, res) => {
  try {
    const out = await svc.setRead(req.db, req.auth.userId, req.params.id, true);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'POST /api/mail/messages/:id/read', err); }
});

router.delete('/api/mail/messages/:id/read', ...guard, async (req, res) => {
  try {
    const out = await svc.setRead(req.db, req.auth.userId, req.params.id, false);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'DELETE /api/mail/messages/:id/read', err); }
});

// ─── POST /api/mail/read ───  bulk
router.post('/api/mail/read', ...guard, async (req, res) => {
  try {
    const out = await svc.markRead(req.db, req.auth.userId, req.body);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'POST /api/mail/read', err); }
});

// ─── Views ───
router.get('/api/mail/views', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', views: await svc.listViews(req.db, req.auth.userId) });
  } catch (err) { sendError(res, 'GET /api/mail/views', err); }
});

router.get('/api/mail/views/counts', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.viewCounts(req.db, req.auth.userId)) });
  } catch (err) { sendError(res, 'GET /api/mail/views/counts', err); }
});

router.post('/api/mail/views', ...guard, async (req, res) => {
  try {
    res.status(201).json({ status: 'success', view: await svc.createView(req.db, req.auth.userId, req.body) });
  } catch (err) { sendError(res, 'POST /api/mail/views', err); }
});

router.patch('/api/mail/views/:id', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', view: await svc.updateView(req.db, req.auth.userId, req.params.id, req.body) });
  } catch (err) { sendError(res, 'PATCH /api/mail/views/:id', err); }
});

router.delete('/api/mail/views/:id', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.deleteView(req.db, req.auth.userId, req.params.id)) });
  } catch (err) { sendError(res, 'DELETE /api/mail/views/:id', err); }
});

// ─── POST /api/mail/messages/:id/case-link ───
router.post('/api/mail/messages/:id/case-link', ...guard, async (req, res) => {
  try {
    const out = await svc.caseLink(req.db, req.auth.userId, req.params.id, req.body);
    res.json({ status: 'success', ...out });
  } catch (err) { sendError(res, 'POST /api/mail/messages/:id/case-link', err); }
});

// ─── GET /api/mail/messages/:id/related ───
router.get('/api/mail/messages/:id/related', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.related(req.db, req.auth.userId, req.params.id)) });
  } catch (err) { sendError(res, 'GET /api/mail/messages/:id/related', err); }
});

// ─── GET /api/mail/first-seen?address= ───
router.get('/api/mail/first-seen', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.firstSeen(req.db, req.auth.userId, (req.query || {}).address)) });
  } catch (err) { sendError(res, 'GET /api/mail/first-seen', err); }
});

// ─── /api/mail/image-senders ───  (per user; never another user's list)
router.get('/api/mail/image-senders', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.listImageSenders(req.db, req.auth.userId)) });
  } catch (err) { sendError(res, 'GET /api/mail/image-senders', err); }
});

router.post('/api/mail/image-senders', ...guard, async (req, res) => {
  try {
    res.status(201).json({ status: 'success', ...(await svc.trustImageSender(req.db, req.auth.userId, req.body)) });
  } catch (err) { sendError(res, 'POST /api/mail/image-senders', err); }
});

router.delete('/api/mail/image-senders/:address', ...guard, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.untrustImageSender(req.db, req.auth.userId, req.params.address)) });
  } catch (err) { sendError(res, 'DELETE /api/mail/image-senders/:address', err); }
});

module.exports = router;
