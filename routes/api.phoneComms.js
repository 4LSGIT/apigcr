// routes/api.phoneComms.js
//
/**
 * Phone comms API — mailbox-system arc, slice S-PH (the comms hub's Phone
 * tab). Spec: ref/MAILBOX_SYSTEM_DESIGN.md §4.4 "Phone tab", D6.
 *
 *   GET    /api/phone-lines/readable                 lines the caller can READ (SU: all;
 *                                                    attorney: all, send/manage from grants;
 *                                                    others: can_read grants) — the pane's rail
 *   GET    /api/phone-lines/all/conversations        every READABLE line at once ("All numbers"):
 *                                                    one row per OUTSIDE number, newest first,
 *                                                    line_ids + last.line_id ?kind=&q=&cursor=&limit=
 *   GET    /api/phone-lines/all/conversations/:party one number across the readable lines,
 *                                                    merged; items carry line_id ?cursor=&limit=
 *   GET    /api/phone-lines/all/calls                every readable line's call log, merged;
 *                                                    rows carry line_id ?q=&cursor=&limit=
 *   GET    /api/phone-lines/first-seen?number=       firm-local day of the earliest text/call with
 *                                                    the number on any line the caller can READ
 *                                                    (the Add-to-contact start-date default)
 *   GET    /api/phone-lines/sendable                 lines the caller can SEND from (SU: all;
 *                                                    others: can_send grants — no role bypass)
 *                                                    — the staff From pickers' filter
 *   GET    /api/phone-lines/:id/grants               SU or can_manage
 *   POST   /api/phone-lines/:id/grants               SU or can_manage   {user, can_read, can_send, can_manage}
 *   PATCH  /api/phone-lines/:id/grants/:grantId      SU or can_manage   ownership-scoped
 *   DELETE /api/phone-lines/:id/grants/:grantId      SU or can_manage   ownership-scoped
 *   GET    /api/phone-lines/:id/conversations        can_read — conversations (texts AND calls) per
 *                                                    number, newest activity first
 *                                                    ?kind=sms (texts only) &q=&cursor=&limit=≤100
 *   GET    /api/phone-lines/:id/conversations/:party can_read — one conversation (its texts AND
 *                                                    calls, each item `kind` sms|call), newest
 *                                                    page returned oldest-first ?cursor=&limit=
 *   GET    /api/phone-lines/:id/calls                can_read — the call log ?q=&cursor=&limit=
 *
 *   SEARCH (?q=, slice PS): the four LIST reads above narrow to the numbers
 *   q matches — digits in the number, a contact's name, a case's docket
 *   number / caption (its clients' numbers) — unioned; rows gain matched_by
 *   (+ matched_cases), the page a `search` block. Same paging, same scope
 *   (phoneCommsService "Search" has the rules). Threads take no q.
 *
 *   ARCHIVE (comms archive S4, ref/COMMS_ARCHIVE_DESIGN.md §9): both
 *   conversation-THREAD routes (…/:id/conversations/:party and
 *   …/all/conversations/:party) run services/commsArchiveView.decorate on the
 *   page — call items gain `archive` / `voicemail`, text items `attachments`,
 *   the page `archive_admin` — only what the viewer may read (§7). Bytes and
 *   transcripts are fetched through routes/api.commsArchive.js.
 *   POST   /api/phone-lines/:id/sms                  can_send (SU: + step-up) {to, message}
 *
 * Auto-mounted (server.js readdirSync); req.db injected. Pane:
 * public/comms.html (Phone tab); grants editor: public/connections.html
 * (Phone Lines → Access). The SU admin CRUD stays in routes/api.phoneLines.js
 * (/api/phone-lines/admin/*) and GET /api/phone-lines (routes/api.sending.js)
 * stays the minimal active-lines picker — neither changed here. No path here
 * overlaps theirs (mount order between route files is readdir order).
 *
 * ENFORCEMENT SEAT (D6): grant checks live HERE (and, for staff-JWT callers,
 * in routes/internal/{sms,mms}.js through phoneCommsService.staffSendGate) —
 * never inside phoneService, so workflow / automation sends are untouched.
 * Access resolves through mailboxService (getAccess / listReadable /
 * listSendable) — the one chokepoint for both channels.
 *
 * HUMANS ONLY: every route needs a staff JWT (an x-api-key caller has no user
 * to resolve grants against → 403).
 *
 * The grants block mirrors routes/api.mailboxes.js one-for-one: no access at
 * all → 404 (no existence oracle), a grant without can_manage → 403, an SU
 * acting through the bypass needs step-up elevation on WRITES, rows are
 * ownership-scoped to :id, every success is audited (admin_audit_log, tool
 * 'phone_lines', actions grant_create / grant_update / grant_delete). The
 * channel is PINNED to 'phone_line': a body naming another channel_type is a
 * 400 (line and mailbox ids overlap — a route never writes another channel's
 * grant).
 *
 * SEND mirrors POST /api/mail/send: can_send via getAccess (the attorney READ
 * bypass does NOT send); an SU needs step-up before anything is dispatched;
 * 30 sends / 10 min per user (lib/rateLimiter, per instance); audited as tool
 * 'phone_send' (sent / send_failed / rejected_no_elevation — line, length,
 * never the number or the text). Text only; the line must be active. Nothing
 * is written to phone_event_log — the provider's webhook echo is the record.
 * An optional Idempotency-Key (scope phone_lines.sms_send, lib/requestIdempotency
 * — the Ask Casey send card sends its draft_id) makes a repeat replay the first
 * result instead of texting twice; a failure after dispatch KEEPS the claim
 * (releaseOnRefusalOnly), so an ambiguous send is never re-sent under that key.
 * No key = the old behaviour, untouched.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction, verifyElevationToken, stepupEnabled } = require('../lib/auth.superuser');
const { makeLimiter } = require('../lib/rateLimiter');
const mbx = require('../services/mailboxService');
const phone = require('../services/phoneCommsService');
const archiveView = require('../services/commsArchiveView');
const { idempotentRequest, sendIdempotencyError, releaseOnRefusalOnly } = require('../lib/requestIdempotency');
const optout = require('../services/optoutService');

const TOOL = 'phone_lines';
const SEND_TOOL = 'phone_send';
const CHANNEL = 'phone_line';

// Per-USER send rate — the POST /api/mail/send numbers (a runaway client loop,
// not a policy). Per Cloud Run instance like every lib/rateLimiter consumer.
const SEND_RATE_WINDOW_MS = 10 * 60 * 1000;
const SEND_RATE_MAX = 30;
let sendLimited = makeLimiter(SEND_RATE_WINDOW_MS, SEND_RATE_MAX);


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

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

function audit(req, status, details, tool = TOOL, errorMessage = null) {
  auditAdminAction(req.db, { ...reqMeta(req, tool), status, details, errorMessage })
    .catch(err => console.error('[phoneComms] audit log failed:', err.message));
}

/**
 * Comms archive S3 (design §7 P9): AI summaries ride the thread as bubble text,
 * so the view is audited here — ONE admin_audit_log row per fetch that handed
 * out any, tool 'comms_archive', details {action:'view_summary', media_ids},
 * never content. Fire-and-forget like this route's other audit rows.
 */
function auditSummaryViews(req, out) {
  const ids = archiveView.summaryMediaIds(out);
  if (ids.length) audit(req, 'success', { action: 'view_summary', media_ids: ids.slice(0, 200) }, 'comms_archive');
}

function sendError(res, label, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) {
    // code + message only: the mysql2 error object carries the formatted SQL.
    console.error(`[phoneComms] ${label} error:`, err && err.code ? err.code : '', err && err.message);
  }
  const expose = status < 500 || !!(err && err.expose === true);
  res.status(status).json({ status: 'error', message: (expose ? err && err.message : null) || 'Phone request failed' });
}

/** Staff JWT only — grants resolve against a user id. */
function requireJwt(req, res, next) {
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    return res.status(403).json({ status: 'error', message: 'Phone routes require a signed-in user' });
  }
  next();
}

/** True iff the request carries a live elevation token for its user (or step-up is off). */
function isElevated(req) {
  return !stepupEnabled() || verifyElevationToken(req.headers['x-su-elevation'], req.auth.userId);
}

/** Same response + audit shape as lib/auth.superuser's elevation check. */
function rejectNoElevation(req, res, tool = TOOL, details = null) {
  audit(req, 'rejected_no_elevation', details, tool);
  return res.status(401).json({
    error: 'Elevation required — confirm your password to use superuser tools.',
    code: 'elevation_required',
  });
}

function lineIdOf(req, res) {
  if (!/^\d+$/.test(String(req.params.id)) || Number(req.params.id) <= 0) {
    res.status(400).json({ status: 'error', message: 'phone line id must be a positive integer' });
    return null;
  }
  return Number(req.params.id);
}

/**
 * Resolve the caller's MANAGE access to line :id (routes/api.mailboxes.js
 * resolveAccess, line-shaped). Sends the 4xx itself and returns null on any
 * miss. write: true → an SU acting through the bypass must be elevated.
 */
async function resolveManage(req, res, { write }) {
  const id = lineIdOf(req, res);
  if (id == null) return null;
  let access;
  try {
    access = await mbx.getAccess(req.db, req.auth.userId, CHANNEL, id);
  } catch (err) {
    sendError(res, 'access', err);
    return null;
  }
  if (access.su) {
    if (write && !isElevated(req)) { rejectNoElevation(req, res); return null; }
    if (!(await mbx.channelExists(req.db, CHANNEL, id))) {
      res.status(404).json({ status: 'error', message: 'Phone line not found' });
      return null;
    }
    return { id, access, via: 'su' };
  }
  if (!access.can_read && !access.can_send && !access.can_manage) {
    res.status(404).json({ status: 'error', message: 'Phone line not found' });
    return null;
  }
  // The attorney READ bypass answers for any id — a missing line is a 404,
  // not a 403 (a small tightening over the mailbox route).
  if (!(await mbx.channelExists(req.db, CHANNEL, id))) {
    res.status(404).json({ status: 'error', message: 'Phone line not found' });
    return null;
  }
  if (!access.can_manage) {
    res.status(403).json({ status: 'error', message: 'Manage permission required on this phone line' });
    return null;
  }
  return { id, access, via: 'manage' };
}

/** The channel this route writes is pinned: a body may only repeat it. */
function pinnedChannel(body) {
  if (body && body.channel_type !== undefined && body.channel_type !== CHANNEL) {
    throw mbx.httpError(400, `channel_type must be '${CHANNEL}' here — mailbox grants live under /api/mailboxes/:id/grants`);
  }
  return CHANNEL;
}

function grantFlags(g) {
  return g ? { can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage } : null;
}


// ─────────────────────────────────────────────────────────────
// Line lists
// ─────────────────────────────────────────────────────────────

// ─── GET /api/phone-lines/readable ───
router.get('/api/phone-lines/readable', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const uid = req.auth.userId;
    const [su, lines] = await Promise.all([mbx.isSuperuser(req.db, uid), mbx.listReadable(req.db, uid, CHANNEL)]);
    res.json({ status: 'success', viewer: { su }, lines });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/readable', err);
  }
});

// ─── GET /api/phone-lines/first-seen?number= ───
// No path collision: nothing here or in api.phoneLines.js / api.sending.js
// mounts GET /api/phone-lines/:id (one segment).
router.get('/api/phone-lines/first-seen', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await phone.firstSeen(req.db, req.auth.userId, (req.query || {}).number)) });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/first-seen', err);
  }
});

// ─── All numbers (GET /api/phone-lines/all/…) ───
// REGISTERED BEFORE every /api/phone-lines/:id/… route below: Express takes
// the first match, and as :id "all" would 400 in lineIdOf. Scope = the
// caller's readable lines (resolved inside the service, not resolveRead).
router.get('/api/phone-lines/all/conversations', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    res.json({ status: 'success', all: true, ...(await phone.listAllConversations(req.db, req.auth.userId, req.query || {})) });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/all/conversations', err);
  }
});

router.get('/api/phone-lines/all/conversations/:party', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const out = await phone.listAllMessages(req.db, req.auth.userId, req.params.party, req.query || {});
    await archiveView.decorate(req.db, req.auth, out);
    auditSummaryViews(req, out);
    res.json({ status: 'success', all: true, ...out });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/all/conversations/:party', err);
  }
});

router.get('/api/phone-lines/all/calls', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    res.json({ status: 'success', all: true, ...(await phone.listAllCalls(req.db, req.auth.userId, req.query || {})) });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/all/calls', err);
  }
});

// ─── GET /api/phone-lines/sendable ───
router.get('/api/phone-lines/sendable', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const lines = await mbx.listSendable(req.db, req.auth.userId, CHANNEL);
    res.json({ status: 'success', lines });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/sendable', err);
  }
});


// ─────────────────────────────────────────────────────────────
// Grants (mirror of routes/api.mailboxes.js)
// ─────────────────────────────────────────────────────────────

// ─── GET /api/phone-lines/:id/grants ───
router.get('/api/phone-lines/:id/grants', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveManage(req, res, { write: false });
    if (!ctx) return;
    const grants = await mbx.listGrants(req.db, { channelType: CHANNEL, channelId: ctx.id });
    res.json({ status: 'success', line_id: ctx.id, grants });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/:id/grants', err);
  }
});

// ─── POST /api/phone-lines/:id/grants ───
router.post('/api/phone-lines/:id/grants', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveManage(req, res, { write: true });
    if (!ctx) return;
    const body = req.body || {};
    const { grant } = await mbx.createGrant(req.db, {
      channelType: pinnedChannel(body),
      channelId: ctx.id,
      body,
      grantedBy: req.auth.userId,
    });
    audit(req, 'success', {
      action: 'grant_create',
      via: ctx.via,
      line_id: ctx.id,
      grant_id: grant.id,
      user: grant.user,
      flags: grantFlags(grant),
    });
    res.status(201).json({ status: 'success', grant });
  } catch (err) {
    sendError(res, 'POST /api/phone-lines/:id/grants', err);
  }
});

// ─── PATCH /api/phone-lines/:id/grants/:grantId ───
router.patch('/api/phone-lines/:id/grants/:grantId', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveManage(req, res, { write: true });
    if (!ctx) return;
    const body = req.body || {};
    const { grant, before } = await mbx.updateGrant(req.db, {
      channelType: pinnedChannel(body),
      channelId: ctx.id,
      grantId: req.params.grantId,
      body,
    });
    audit(req, 'success', {
      action: 'grant_update',
      via: ctx.via,
      line_id: ctx.id,
      grant_id: grant.id,
      user: grant.user,
      from: grantFlags(before),
      to: grantFlags(grant),
    });
    res.json({ status: 'success', grant });
  } catch (err) {
    sendError(res, 'PATCH /api/phone-lines/:id/grants/:grantId', err);
  }
});

// ─── DELETE /api/phone-lines/:id/grants/:grantId ───
router.delete('/api/phone-lines/:id/grants/:grantId', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveManage(req, res, { write: true });
    if (!ctx) return;
    const { before } = await mbx.deleteGrant(req.db, {
      channelType: pinnedChannel(req.body),
      channelId: ctx.id,
      grantId: req.params.grantId,
    });
    audit(req, 'success', {
      action: 'grant_delete',
      via: ctx.via,
      line_id: ctx.id,
      grant_id: before.id,
      user: before.user,
      flags: grantFlags(before),
    });
    res.json({ status: 'success', removed: 1, grant_id: before.id });
  } catch (err) {
    sendError(res, 'DELETE /api/phone-lines/:id/grants/:grantId', err);
  }
});


// ─────────────────────────────────────────────────────────────
// Reads — phone_event_log per line (can_read)
// ─────────────────────────────────────────────────────────────

// ─── GET /api/phone-lines/:id/conversations ───
router.get('/api/phone-lines/:id/conversations', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    if (lineIdOf(req, res) == null) return;
    const { line } = await phone.resolveRead(req.db, req.auth.userId, req.params.id);
    const out = await phone.listConversations(req.db, line, req.query || {});
    res.json({ status: 'success', line_id: line.id, ...out });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/:id/conversations', err);
  }
});

// ─── GET /api/phone-lines/:id/conversations/:party ───
router.get('/api/phone-lines/:id/conversations/:party', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    if (lineIdOf(req, res) == null) return;
    const { line } = await phone.resolveRead(req.db, req.auth.userId, req.params.id);
    const out = await phone.listMessages(req.db, line, req.params.party, req.query || {});
    await archiveView.decorate(req.db, req.auth, out, { lineId: line.id });
    auditSummaryViews(req, out);
    res.json({ status: 'success', line_id: line.id, ...out });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/:id/conversations/:party', err);
  }
});

// ─── GET /api/phone-lines/:id/calls ───
router.get('/api/phone-lines/:id/calls', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    if (lineIdOf(req, res) == null) return;
    const { line } = await phone.resolveRead(req.db, req.auth.userId, req.params.id);
    const out = await phone.listCalls(req.db, line, req.query || {});
    res.json({ status: 'success', line_id: line.id, ...out });
  } catch (err) {
    sendError(res, 'GET /api/phone-lines/:id/calls', err);
  }
});


// ─────────────────────────────────────────────────────────────
// Send — can_send (no role bypass); SU needs step-up
// ─────────────────────────────────────────────────────────────

// ─── POST /api/phone-lines/:id/sms ───  {to, message}
router.post('/api/phone-lines/:id/sms', jwtOrApiKey, requireJwt, async (req, res) => {
  const id = lineIdOf(req, res);
  if (id == null) return;
  const uid = req.auth.userId;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const meta = { line_id: id, length: typeof body.message === 'string' ? body.message.trim().length : null };
  try {
    const access = await mbx.getAccess(req.db, uid, CHANNEL, id);
    if (!access.can_send) {
      // No access at all → no existence oracle; read-only (or an attorney) → 403.
      if (!access.can_read && !access.can_manage) {
        return res.status(404).json({ status: 'error', message: 'Phone line not found' });
      }
      return res.status(403).json({ status: 'error', message: 'Send permission required on this phone line' });
    }
    const line = await phone.loadLine(req.db, id);
    if (!line) return res.status(404).json({ status: 'error', message: 'Phone line not found' });
    // S0 rule (POST /api/mail/send): an SU acting through the bypass needs
    // step-up on a WRITE — checked before anything is dispatched, so
    // apiSend's prompt-and-retry can never send twice.
    if (access.su && !isElevated(req)) return rejectNoElevation(req, res, SEND_TOOL, meta);
    // Opt-out WARNS a staff sender (ruling 2026-10-27): 409 code 'opted_out'
    // until the body carries acknowledge_optout:true — checked before the
    // limiter and the idempotency claim, so the confirm-and-resend is one
    // send and reuses its key. Ask Casey's send card goes through the same
    // confirm (public/js/optoutAck.js; ruling 17).
    const gate = await optout.optoutGate(req.db, {
      channel: 'sms', dest: phone.normalizeTo(body.to).ten, acknowledged: body.acknowledge_optout,
    });
    if (gate.refusal) {
      audit(req, 'refused_opted_out', meta, SEND_TOOL);
      return res.status(gate.refusal.status).json(gate.refusal.body);
    }
    // Counted only once the caller may send (an SU's prompt-and-retry is one send).
    if (sendLimited(`u${uid}`)) {
      return res.status(429).json({ status: 'error', message: 'Too many texts from you in a few minutes — wait a little and try again.' });
    }
    const { value: out, replayed } = await idempotentRequest(req, 'phone_lines.sms_send',
      () => phone.sendSms(req.db, line, body), { releaseOnError: releaseOnRefusalOnly });
    // A replay sent nothing, so it is not audited as a send.
    if (!replayed) {
      audit(req, 'sent', {
        ...meta, via: access.su ? 'su' : 'grant', length: out.length,
        ...(gate.overridden.length ? optout.overrideAudit(gate.overridden) : {}),
      }, SEND_TOOL);
    }
    res.json({ status: 'success', line_id: id, to: out.to, result: out.result, ...(replayed ? { replayed: true } : {}) });
  } catch (err) {
    if (sendIdempotencyError(res, err)) return;
    if (err && err.status === 502) audit(req, 'send_failed', meta, SEND_TOOL, err.message);
    sendError(res, 'POST /api/phone-lines/:id/sms', err);
  }
});

// Test hook (the routes/api.mail.js precedent): a fresh send limiter.
router._resetSendRateLimit = () => { sendLimited = makeLimiter(SEND_RATE_WINDOW_MS, SEND_RATE_MAX); };
router.SEND_RATE_MAX = SEND_RATE_MAX;

module.exports = router;
