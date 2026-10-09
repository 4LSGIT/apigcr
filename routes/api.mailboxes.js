// routes/api.mailboxes.js
//
/**
 * Mailboxes API — mailbox-system arc, slice S0
 * routes/api.mailboxes.js
 *
 *   GET    /api/mailboxes                      SU → every mailbox (full projection);
 *                                              others → mailboxes they hold any grant
 *                                              on (public projection). Every row
 *                                              carries the caller's `access` flags.
 *   POST   /api/mailboxes                      SU only (superuserOnlyFor + step-up)
 *   PATCH  /api/mailboxes/:id                  SU, or can_manage (display_name + color only)
 *   GET    /api/mailboxes/:id/grants           SU or can_manage
 *   POST   /api/mailboxes/:id/grants           SU or can_manage   {user, can_read, can_send, can_manage}
 *   PATCH  /api/mailboxes/:id/grants/:grantId  SU or can_manage   ownership-scoped
 *   DELETE /api/mailboxes/:id/grants/:grantId  SU or can_manage   ownership-scoped
 *   GET    /api/mailboxes/:id/messages/:mid/parts/:part
 *                                              SU or can_read — streams one stored
 *                                              message's attachment from IMAP (S1, D1)
 *   GET    /api/mailboxes/:id/folders          SU only — the server's folder list
 *                                              with STATUS counts + provider_id_kind,
 *                                              checked against ingest_folders (S1-G)
 *   GET    /api/mailboxes/:id/messages/:mid/emit-preview
 *                                              SU only — what the worker WOULD emit
 *                                              for a stored message (emit identity +
 *                                              derived text); the Gmail parity gate's
 *                                              pre-emission text check (S1-G)
 *
 * Auto-mounted (server.js readdirSync); req.db injected. UI:
 * public/mailboxAdmin.html (Admin → Mailboxes). Spec:
 * ref/MAILBOX_SYSTEM_DESIGN.md §3, §4.4, §5 (S0), D6.
 *
 * ENFORCEMENT SEAT (D6): grant checks live HERE, on interactive routes — never
 * inside emailService / phoneService — so workflow/automation sends bypass
 * grants. Later slices (S2 inbox, S3 send, S-PH phone) keep that discipline:
 * the route resolves access via mailboxService.getAccess, the service it then
 * calls stays grant-blind.
 *
 * HUMANS ONLY. Every route requires a staff JWT (an x-api-key caller has no
 * user identity to resolve grants against → 403).
 *
 * SU STEP-UP. POST runs the house superuserOnlyFor chain (JWT-SU, elevation,
 * rate limit, rejection audit) and then the service's DB-side SU check. The
 * mixed SU-or-manager routes cannot use that chain (it 403s managers), so an
 * SU acting through the bypass must present the same elevation token on
 * WRITES (requireElevation below — same 401 `elevation_required` shape, so
 * the shell's apiSend prompts and retries). A non-SU manager acts through
 * their grant; there is nothing for them to elevate to.
 *
 * NO ESCALATION BEYOND THE BOX. A non-SU manager passes only where they hold
 * can_manage on THAT :id; grant rows are ownership-scoped to :id (404
 * otherwise — routes/api.contactRoles.js precedent); and mailboxService
 * limits their PATCH to display_name + color (connection/plumbing fields are SU-only,
 * see the service header for why).
 *
 * SECRETS. imap_secret is accepted on POST/PATCH mailbox bodies only. It is
 * encrypted in the service, never selected back, never echoed, never in an
 * audit row (only "set"/"clear"), and redacted from jwt_api_audit_log by
 * lib/auth.jwtOrApiKey. Error logging here prints code + message only — never
 * the error object (mysql2 attaches the formatted SQL to it).
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const {
  superuserOnlyFor, auditAdminAction, verifyElevationToken, stepupEnabled,
} = require('../lib/auth.superuser');
const { pipeline } = require('stream');
const svc = require('../services/mailboxService');
const imapTransport = require('../services/mailbox/imapTransport');
const { loadConnectionRow, previewEmission, folderConfig } = require('../services/mailbox/mailboxIngestService');

const TOOL = 'mailboxes';


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function reqMeta(req) {
  return {
    tool: TOOL,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(req, status, details) {
  auditAdminAction(req.db, { ...reqMeta(req), status, details })
    .catch(err => console.error('[mailboxes] audit log failed:', err.message));
}

function sendError(res, label, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) {
    // code + message only: the mysql2 error object carries the formatted SQL.
    console.error(`[mailboxes] ${label} error:`, err && err.code ? err.code : '', err && err.message);
  }
  res.status(status).json({ status: 'error', message: (err && err.message) || 'Mailbox request failed' });
}

/** Staff JWT only — grants resolve against a user id. */
function requireJwt(req, res, next) {
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    return res.status(403).json({ status: 'error', message: 'Mailbox routes require a signed-in user' });
  }
  next();
}

/** True iff the request carries a live elevation token for its user (or step-up is off). */
function isElevated(req) {
  return !stepupEnabled() || verifyElevationToken(req.headers['x-su-elevation'], req.auth.userId);
}

/** Same response + audit shape as lib/auth.superuser's elevation check. */
function rejectNoElevation(req, res) {
  audit(req, 'rejected_no_elevation', null);
  return res.status(401).json({
    error: 'Elevation required — confirm your password to use superuser tools.',
    code: 'elevation_required',
  });
}

/**
 * Resolve the caller's access to mailbox :id. Sends the 4xx itself and
 * returns null on any miss.
 *   need:  'manage' — every :id route in S0 is a management route.
 *   write: true → an SU acting through the bypass must be elevated.
 * Callers with no grant at all get 404 (no existence oracle); grant holders
 * lacking can_manage get 403.
 */
async function resolveAccess(req, res, { write }) {
  let id;
  let access;
  try {
    id = Number(req.params.id);
    if (!/^\d+$/.test(String(req.params.id)) || id <= 0) {
      res.status(400).json({ status: 'error', message: 'mailbox id must be a positive integer' });
      return null;
    }
    access = await svc.getAccess(req.db, req.auth.userId, 'mailbox', id);
  } catch (err) {
    sendError(res, 'access', err);
    return null;
  }
  if (access.su) {
    if (write && !isElevated(req)) { rejectNoElevation(req, res); return null; }
    if (!(await svc.mailboxExists(req.db, id))) {
      res.status(404).json({ status: 'error', message: 'Mailbox not found' });
      return null;
    }
    return { id, access, via: 'su' };
  }
  if (!access.can_read && !access.can_send && !access.can_manage) {
    res.status(404).json({ status: 'error', message: 'Mailbox not found' });
    return null;
  }
  if (!access.can_manage) {
    res.status(403).json({ status: 'error', message: 'Manage permission required on this mailbox' });
    return null;
  }
  return { id, access, via: 'manage' };
}

/** Body channel_type defaults to 'mailbox'; the service gates anything else. */
function bodyChannelType(body) {
  return body && body.channel_type !== undefined ? body.channel_type : 'mailbox';
}

/** Audit-safe field diff. imap_secret is reported as set/clear, never a value. */
function mailboxDiff(before, after, changed, secretChange) {
  const diff = {};
  for (const f of changed) {
    if (f === 'imap_secret') { diff.imap_secret = secretChange; continue; }
    const a = before ? before[f] : undefined;
    const b = after ? after[f] : undefined;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    diff[f] = { from: a ?? null, to: b ?? null };
  }
  if (changed.includes('address') && before && after && before.domain !== after.domain) {
    diff.domain = { from: before.domain ?? null, to: after.domain ?? null };
  }
  return diff;
}

function grantFlags(g) {
  return g ? { can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage } : null;
}

/**
 * SU-only gate for the S1-G diagnostic reads (DB-sourced SU, like every other
 * bypass here). Reads need no elevation (S0 rule). Sends the 4xx itself and
 * returns null on a miss: no grant at all → 404 (no existence oracle), a
 * grant of any kind → 403.
 */
async function resolveSuOnly(req, res) {
  if (!/^\d+$/.test(String(req.params.id)) || Number(req.params.id) <= 0) {
    res.status(400).json({ status: 'error', message: 'mailbox id must be a positive integer' });
    return null;
  }
  const id = Number(req.params.id);
  const access = await svc.getAccess(req.db, req.auth.userId, 'mailbox', id);
  if (!access.su) {
    if (!access.can_read && !access.can_send && !access.can_manage) {
      res.status(404).json({ status: 'error', message: 'Mailbox not found' });
    } else {
      res.status(403).json({ status: 'error', message: 'Superuser access required' });
    }
    return null;
  }
  return id;
}


// ─────────────────────────────────────────────────────────────
// Mailboxes
// ─────────────────────────────────────────────────────────────

// ─── GET /api/mailboxes ───
router.get('/api/mailboxes', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const result = await svc.listMailboxesFor(req.db, req.auth.userId);
    res.json({ status: 'success', viewer: { su: result.su }, mailboxes: result.mailboxes });
  } catch (err) {
    sendError(res, 'GET /api/mailboxes', err);
  }
});

// ─── POST /api/mailboxes ───  SU only
router.post('/api/mailboxes', ...superuserOnlyFor(TOOL), async (req, res) => {
  try {
    // superuserOnlyFor trusted the JWT claim; the bypass everywhere else in
    // this subsystem is DB-sourced — both must agree.
    if (!(await svc.isSuperuser(req.db, req.auth.userId))) {
      audit(req, 'rejected_not_su', { reason: 'db user_auth is not SU' });
      return res.status(403).json({ status: 'error', message: 'Superuser access required' });
    }
    const result = await svc.createMailbox(req.db, req.body);
    audit(req, 'success', {
      action: 'mailbox_create',
      mailbox_id: result.id,
      address: result.mailbox.address,
      imap_secret: result.secret_change,
    });
    res.status(201).json({ status: 'success', id: result.id, mailbox: result.mailbox });
  } catch (err) {
    sendError(res, 'POST /api/mailboxes', err);
  }
});

// ─── PATCH /api/mailboxes/:id ───  SU (all fields) or can_manage (display_name, color)
router.patch('/api/mailboxes/:id', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveAccess(req, res, { write: true });
    if (!ctx) return;
    const result = await svc.updateMailbox(req.db, ctx.id, req.body, { su: ctx.via === 'su' });
    audit(req, 'success', {
      action: 'mailbox_update',
      via: ctx.via,
      mailbox_id: ctx.id,
      address: result.mailbox.address,
      diff: mailboxDiff(result.before, result.mailbox, result.changed, result.secret_change),
    });
    res.json({ status: 'success', mailbox: { ...result.mailbox, access: ctx.access } });
  } catch (err) {
    sendError(res, 'PATCH /api/mailboxes/:id', err);
  }
});


// ─────────────────────────────────────────────────────────────
// Grants (mailbox channel only in S0)
// ─────────────────────────────────────────────────────────────

// ─── GET /api/mailboxes/:id/grants ───
router.get('/api/mailboxes/:id/grants', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveAccess(req, res, { write: false });
    if (!ctx) return;
    const grants = await svc.listGrants(req.db, { channelType: 'mailbox', channelId: ctx.id });
    res.json({ status: 'success', mailbox_id: ctx.id, grants });
  } catch (err) {
    sendError(res, 'GET /api/mailboxes/:id/grants', err);
  }
});

// ─── POST /api/mailboxes/:id/grants ───
router.post('/api/mailboxes/:id/grants', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveAccess(req, res, { write: true });
    if (!ctx) return;
    const body = req.body || {};
    const { grant } = await svc.createGrant(req.db, {
      channelType: bodyChannelType(body),
      channelId: ctx.id,
      body,
      grantedBy: req.auth.userId,
    });
    audit(req, 'success', {
      action: 'grant_create',
      via: ctx.via,
      mailbox_id: ctx.id,
      grant_id: grant.id,
      user: grant.user,
      flags: grantFlags(grant),
    });
    res.status(201).json({ status: 'success', grant });
  } catch (err) {
    sendError(res, 'POST /api/mailboxes/:id/grants', err);
  }
});

// ─── PATCH /api/mailboxes/:id/grants/:grantId ───
router.patch('/api/mailboxes/:id/grants/:grantId', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveAccess(req, res, { write: true });
    if (!ctx) return;
    const body = req.body || {};
    const { grant, before } = await svc.updateGrant(req.db, {
      channelType: bodyChannelType(body),
      channelId: ctx.id,
      grantId: req.params.grantId,
      body,
    });
    audit(req, 'success', {
      action: 'grant_update',
      via: ctx.via,
      mailbox_id: ctx.id,
      grant_id: grant.id,
      user: grant.user,
      from: grantFlags(before),
      to: grantFlags(grant),
    });
    res.json({ status: 'success', grant });
  } catch (err) {
    sendError(res, 'PATCH /api/mailboxes/:id/grants/:grantId', err);
  }
});

// ─── DELETE /api/mailboxes/:id/grants/:grantId ───
router.delete('/api/mailboxes/:id/grants/:grantId', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const ctx = await resolveAccess(req, res, { write: true });
    if (!ctx) return;
    const { before } = await svc.deleteGrant(req.db, {
      channelType: bodyChannelType(req.body),
      channelId: ctx.id,
      grantId: req.params.grantId,
    });
    audit(req, 'success', {
      action: 'grant_delete',
      via: ctx.via,
      mailbox_id: ctx.id,
      grant_id: before.id,
      user: before.user,
      flags: grantFlags(before),
    });
    res.json({ status: 'success', removed: 1, grant_id: before.id });
  } catch (err) {
    sendError(res, 'DELETE /api/mailboxes/:id/grants/:grantId', err);
  }
});


// ─────────────────────────────────────────────────────────────
// Message parts (S1) — attachments stream on demand from IMAP (D1)
// ─────────────────────────────────────────────────────────────

// INLINE-SAFE TYPES ONLY — the routes/api.documents.js RAW_INLINE_MIME
// allowlist and reasoning, keyed on MIME type because a mail part has no
// trustworthy extension. The type is whatever the SENDER declared in the
// message structure, so anything absent here (svg, html, xml — script hosts
// on THIS origin, where the staff JWT lives) is served as octet-stream +
// attachment, with nosniff so the browser cannot second-guess it.
const PART_INLINE_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

// IMAP body part ids: "1", "2.1", "1.2.3"… (bounded so a path segment can't
// smuggle anything else in).
const PART_ID_RE = /^\d{1,4}(?:\.\d{1,4}){0,15}$/;

/** RFC 6266 / 5987 Content-Disposition — same construction as routes/api.documents.js. */
function contentDisposition(disposition, filename) {
  const name  = String(filename == null ? '' : filename) || 'attachment';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; ` +
         `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseJsonCol(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

// ─── GET /api/mailboxes/:id/messages/:mid/parts/:part ───  SU or can_read
//
// The ENFORCEMENT SEAT for reading stored mail's bytes (D6): grant check here,
// on the interactive route. The connection is request-scoped and closes when
// the stream ends or the client goes away.
//
// Like /api/documents/:id/raw this is fetched with apiSend's
// `responseType:'blob'` — the browser sends no Authorization header on a
// plain <a href> / <iframe src> navigation, so a direct link would 401.
//
// 404 when the server no longer has the message (deleted in webmail /
// Outlook — the accepted D1 caveat: the GCS archival slice removes it).
// 409 when the folder's UIDVALIDITY moved or the UID now holds a different
// message: the stored UID is stale until the next ingest re-keys it, and
// serving "whatever is at that UID now" could hand over another client's
// document.
router.get('/api/mailboxes/:id/messages/:mid/parts/:part', jwtOrApiKey, requireJwt, async (req, res) => {
  const { id: idRaw, mid: midRaw, part } = req.params;
  if (!/^\d+$/.test(String(idRaw)) || Number(idRaw) <= 0 ||
      !/^\d+$/.test(String(midRaw)) || Number(midRaw) <= 0) {
    return res.status(400).json({ status: 'error', message: 'mailbox id and message id must be positive integers' });
  }
  if (!PART_ID_RE.test(String(part))) {
    return res.status(400).json({ status: 'error', message: 'part must be an IMAP body part id like 2 or 1.2' });
  }
  const id = Number(idRaw);
  const mid = Number(midRaw);

  try {
    const access = await svc.getAccess(req.db, req.auth.userId, 'mailbox', id);
    if (!access.can_read) {
      // No grant at all → no existence oracle; a grant without read → 403.
      if (!access.can_send && !access.can_manage) {
        return res.status(404).json({ status: 'error', message: 'Mailbox not found' });
      }
      return res.status(403).json({ status: 'error', message: 'Read permission required on this mailbox' });
    }

    const [[msg]] = await req.db.query(
      `SELECT id, folder, uid, message_id, attachments
         FROM mail_messages WHERE id = ? AND mailbox_id = ? LIMIT 1`,
      [mid, id]
    );
    if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

    const atts = parseJsonCol(msg.attachments);
    const att = Array.isArray(atts) ? atts.find(a => a && String(a.part) === String(part)) : null;
    if (!att) return res.status(404).json({ status: 'error', message: 'Attachment not found on this message' });

    const row = await loadConnectionRow(req.db, id);
    if (!row) return res.status(404).json({ status: 'error', message: 'Mailbox not found' });
    const cursor = (parseJsonCol(row.ingest_state) || {})[msg.folder];
    if (msg.uid == null || !cursor || cursor.uidvalidity == null) {
      return res.status(409).json({ status: 'error', message: 'This mailbox is re-syncing — try again after the next ingest run (about 5 minutes).' });
    }

    let got;
    try {
      got = await imapTransport.fetchPart(row, msg.folder, msg.uid, part, {
        uidValidity: cursor.uidvalidity,
        messageId: msg.message_id,
      });
    } catch (err) {
      if (err && (err.code === 'UIDVALIDITY_MISMATCH' || err.code === 'MESSAGE_MISMATCH')) {
        return res.status(409).json({ status: 'error', message: 'This mailbox is re-syncing — try again after the next ingest run (about 5 minutes).' });
      }
      // Sanitized by imapTransport — no credential can be in it.
      console.warn(`[mailboxes] part fetch mailbox ${id} message ${mid}:`, err && err.message);
      return res.status(502).json({
        status: 'error',
        message: 'Could not reach the mail server for this attachment',
        code: (err && err.code) || null,
      });
    }
    if (!got) {
      return res.status(404).json({
        status: 'error',
        message: 'This message is no longer on the mail server (deleted in webmail or a mail client), so its attachment is gone too.',
      });
    }

    const mime = String(att.mime || '').toLowerCase();
    const inline = PART_INLINE_MIME.has(mime);
    res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
    res.setHeader('Content-Disposition',
      contentDisposition(inline ? 'inline' : 'attachment', att.filename || `attachment-${part}`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // PRIVATE: client mail behind a login — never a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200);
    pipeline(got.stream, res, (err) => {
      if (err) console.warn(`[mailboxes] part stream mailbox ${id} message ${mid} ended early:`, err.code || err.message);
      got.close();
    });
  } catch (err) {
    sendError(res, 'GET /api/mailboxes/:id/messages/:mid/parts/:part', err);
  }
});


// ─────────────────────────────────────────────────────────────
// S1-G diagnostics — SU only, read-only
// ─────────────────────────────────────────────────────────────

// ─── GET /api/mailboxes/:id/folders ───  SU only
//
// Connects with the stored secret (request-scoped, like the part fetch), runs
// LIST + STATUS and logs out — nothing is opened or written. Answers the two
// questions the Gmail pilot checklist asks before creating or emitting:
//   - which folder names does this server use (Gmail's Sent is localized),
//     and how big are they (the backfill decision);
//   - will ingest capture provider ids (provider_id_kind 'gmail') — the
//     precondition for an emit_id_kind 'provider' override.
// `configured` checks the mailbox's ingest_folders against the server: a
// folder that does not exist, or one that is \All (Gmail All Mail — every
// labelled message again, never poll it).
router.get('/api/mailboxes/:id/folders', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const id = await resolveSuOnly(req, res);
    if (!id) return;
    const row = await loadConnectionRow(req.db, id);
    if (!row) return res.status(404).json({ status: 'error', message: 'Mailbox not found' });
    let out;
    try {
      out = await imapTransport.listFolders(row);
    } catch (err) {
      // Sanitized by imapTransport — no credential can be in it.
      console.warn(`[mailboxes] folder list mailbox ${id}:`, err && err.message);
      return res.status(502).json({
        status: 'error',
        message: 'Could not list folders on the mail server',
        code: (err && err.code) || null,
        detail: String((err && err.message) || '').slice(0, 300),
      });
    }
    const byPath = new Map(out.folders.map(f => [String(f.path).toLowerCase(), f]));
    const configured = folderConfig(row.ingest_folders).map(([name, cfg]) => {
      const f = byPath.get(String(name).toLowerCase()) || null;
      return {
        folder: name,
        emit_to_rules: cfg.emit_to_rules,
        backfill: cfg.backfill,
        exists: !!f,
        special_use: f ? f.special_use : null,
        messages: f ? f.messages : null,
        all_mail: !!(f && f.special_use === '\\All'),
      };
    });
    res.json({
      status: 'success',
      mailbox_id: id,
      provider_id_kind: out.provider_id_kind,
      emit_override: { emit_source_name: row.emit_source_name || null, emit_id_kind: row.emit_id_kind || null },
      configured,
      folders: out.folders,
    });
  } catch (err) {
    sendError(res, 'GET /api/mailboxes/:id/folders', err);
  }
});

// ─── GET /api/mailboxes/:id/messages/:mid/emit-preview ───  SU only
//
// What the ingest worker would emit for one stored message, from the stored
// row with the worker's own helpers (previewEmission) — no IMAP, no pipeline,
// no writes. The Gmail parity gate compares this `text` with the Apps Script
// copy's BEFORE the mailbox emits (ref/MAILBOX_GMAIL_PARITY.md).
router.get('/api/mailboxes/:id/messages/:mid/emit-preview', jwtOrApiKey, requireJwt, async (req, res) => {
  try {
    const id = await resolveSuOnly(req, res);
    if (!id) return;
    if (!/^\d+$/.test(String(req.params.mid)) || Number(req.params.mid) <= 0) {
      return res.status(400).json({ status: 'error', message: 'message id must be a positive integer' });
    }
    const preview = await previewEmission(req.db, id, Number(req.params.mid));
    if (!preview) return res.status(404).json({ status: 'error', message: 'Message not found' });
    res.json({ status: 'success', preview });
  } catch (err) {
    sendError(res, 'GET /api/mailboxes/:id/messages/:mid/emit-preview', err);
  }
});

module.exports = router;
