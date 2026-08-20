// routes/api.issueReports.js
//
/**
 * Issue Reports API — the "Report an Issue" button in the shell.
 * routes/api.issueReports.js
 *
 *   POST  /api/issue-reports          any authed staff — file a report
 *   GET   /api/issue-reports          admin — list (default: unresolved)
 *   PATCH /api/issue-reports/:id      admin — resolve / reopen
 *
 * WHAT THIS IS FOR, AND HOW IT DIFFERS FROM FEATURE REQUESTS
 *   routes/api.featureRequests.js is a deliberate, public, votable board: you
 *   sit down and write a title and a description for something you want built.
 *   This is the opposite end of the spectrum — one button, one textarea, sent
 *   from wherever you already are, WITH the technical state attached
 *   automatically. It exists for "this just broke and I don't know how to
 *   describe it", which is exactly the report that never gets filed on a board.
 *   The two do not share a table on purpose: half-formed panic notes must not
 *   land on a board every member of staff can read and vote on.
 *
 * THE EMAIL IS AWAITED, NOT DETACHED
 *   featureRequests fires its notification from a floating async IIFE after
 *   res.json(). That pattern is unreliable on Cloud Run: with request-based
 *   billing the instance's CPU is throttled once the response flushes, so
 *   post-response work can stall indefinitely or never run. Here the send is
 *   awaited and its outcome is returned to the caller, so the dialog can
 *   honestly say "sent" vs "saved, but the email didn't go out". Costs ~1s on
 *   a button press a user is already watching — the right trade.
 *
 * TRUST
 *   `context` is client-supplied. It is size-capped before insert and every
 *   value is HTML-escaped on the way into the email. Nothing in it is ever
 *   interpreted, only displayed.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const { cfg }      = require('../lib/firmConfig');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');
const emailService = require('../services/emailService');

// ── constants ─────────────────────────────────────────────────────────────────

const ADMIN_AUTH = ['authorized - SU', 'authorized - admin'];

// Read per call (not module-load consts) so live edits of the email_automations
// / email_it settings apply without a redeploy — same convention as
// api.featureRequests.js.
const FROM_ADDR   = () => cfg('email_automations') || 'automations@4lsg.com';
const ADMIN_EMAIL = () => cfg('email_it') || 'IT@4lsg.com';
const APP_URL     = () => (cfg('app_url') || 'https://app.4lsg.com').replace(/\/+$/, '');

const VALID_KINDS = ['problem', 'idea', 'question'];

const KIND_META = {
  problem:  { emoji: '🐛', label: 'Problem',  color: '#dc2626', bg: '#fef2f2' },
  idea:     { emoji: '💡', label: 'Idea',     color: '#b45309', bg: '#fffbeb' },
  question: { emoji: '❓', label: 'Question', color: '#0369a1', bg: '#f0f9ff' },
};

// Caps. sql_mode has no STRICT_TRANS_TABLES (see ref/SCHEMA_CONVENTIONS.md),
// so an over-length write would TRUNCATE SILENTLY rather than error. Every
// bound value is clamped here, at the door, because the database will not do
// it for us.
const NOTE_MAX     = 4000;
const URL_MAX      = 1000;
const CONTEXT_MAX  = 24 * 1024;   // serialized JSON bytes
const ERRORS_MAX   = 30;          // ring-buffer entries kept

// 10 reports / 10 min. Keyed on user id where we have one: the whole office
// shares one NAT egress IP, so an IP-keyed limit would let one stuck user lock
// everyone else out of the button.
const limited = makeLimiter(10 * 60 * 1000, 10);

// ── helpers ───────────────────────────────────────────────────────────────────

function isAdmin(req) {
  return ADMIN_AUTH.includes(req.auth?.user_auth);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  next();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clamp(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** Dotted lookup that never throws on a missing branch. */
function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Serialize `context` and enforce CONTEXT_MAX. Oversized payloads are not
 * rejected — a too-chatty diagnostic must never lose the human's note. The
 * error ring buffer is trimmed first (it is both the biggest and the most
 * compressible part); if that still isn't enough the whole thing is replaced
 * with a marker so the row stays valid JSON.
 */
function packContext(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const ctx = { ...raw };

  if (Array.isArray(ctx.errors)) ctx.errors = ctx.errors.slice(-ERRORS_MAX);

  let json;
  try { json = JSON.stringify(ctx); }
  catch (_) { return JSON.stringify({ _error: 'context was not serializable' }); }

  if (json.length <= CONTEXT_MAX) return json;

  if (Array.isArray(ctx.errors) && ctx.errors.length) {
    ctx.errors = ctx.errors.slice(-5);
    ctx._truncated = 'error buffer trimmed to fit';
    try {
      json = JSON.stringify(ctx);
      if (json.length <= CONTEXT_MAX) return json;
    } catch (_) { /* fall through */ }
  }
  return JSON.stringify({ _truncated: `context exceeded ${CONTEXT_MAX} bytes and was dropped` });
}

// ── email rendering ───────────────────────────────────────────────────────────

function renderErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return '';
  const rows = errors.map((e) => {
    const when  = esc(String(e?.t || '').replace('T', ' ').slice(0, 19));
    const type  = esc(e?.type || 'error');
    const frame = e?.frame ? ` <span style="color:#9ca3af">(${esc(e.frame)})</span>` : '';
    const rep   = e?.n > 1 ? ` <strong style="color:#b91c1c">×${Number(e.n)}</strong>` : '';
    return `<div style="margin:0 0 8px;padding:8px 10px;background:#fff;border-left:3px solid #dc2626;border-radius:3px">
              <div style="font-size:11px;color:#6b7280;margin-bottom:3px">${when} · ${type}${frame}${rep}</div>
              <div style="font-family:monospace;font-size:11px;color:#374151;white-space:pre-wrap;word-break:break-word">${esc(e?.detail)}</div>
            </div>`;
  }).join('');
  return `<h3 style="margin:22px 0 8px;font-size:14px;color:#b91c1c">
            Client errors captured before the report (${errors.length})
          </h3>
          <div style="padding:10px;background:#f9fafb;border-radius:4px">${rows}</div>`;
}

function renderFacts(facts) {
  const rows = facts
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<tr>
        <td style="padding:4px 14px 4px 0;font-weight:600;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td>
        <td style="padding:4px 0;color:#111827;word-break:break-word">${esc(v)}</td>
      </tr>`).join('');
  return `<table style="border-collapse:collapse;font-size:13px;margin:4px 0 0">${rows}</table>`;
}

function buildEmail({ id, kind, note, userLabel, userEmail, pageUrl, context }) {
  const meta = KIND_META[kind] || KIND_META.problem;
  const ctx  = context || {};

  const activeView = [dig(ctx, 'active_tab.label'), dig(ctx, 'active_frame.sub_tab')]
    .filter(Boolean).join(' › ');

  const openFiles = Array.isArray(ctx.open_files) && ctx.open_files.length
    ? ctx.open_files.map((f) => f?.title).filter(Boolean).join(', ')
    : null;

  const viewport = dig(ctx, 'browser.viewport');
  const screen   = dig(ctx, 'browser.screen');

  const facts = [
    ['From',         userLabel + (userEmail ? ` <${userEmail}>` : '')],
    ['Type',         meta.label],
    ['Active view',  activeView],
    ['Open files',   openFiles],
    ['Frame URL',    dig(ctx, 'active_frame.url')],
    ['Page URL',     pageUrl],
    ['App build',    ctx.build],
    ['Browser',      dig(ctx, 'browser.ua')],
    ['Screen',       viewport && screen ? `${viewport} viewport / ${screen} screen` : (viewport || screen)],
    ['Theme',        dig(ctx, 'session.theme')],
    ['Client time',  dig(ctx, 'browser.local_time')],
  ];

  let ctxJson = '';
  try { ctxJson = JSON.stringify(ctx, null, 2); } catch (_) { ctxJson = '(unserializable)'; }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#111827">
      <h2 style="margin:0 0 4px;font-size:19px;color:${meta.color}">
        ${meta.emoji} ${esc(meta.label)} from ${esc(userLabel)}
      </h2>
      <p style="margin:0 0 16px;font-size:12px;color:#9ca3af">Report #${Number(id)} · YisraCase</p>

      <div style="margin:0 0 18px;padding:14px 16px;background:${meta.bg};border-left:4px solid ${meta.color};border-radius:4px;font-size:15px;line-height:1.55;white-space:pre-wrap">${esc(note)}</div>

      <h3 style="margin:0 0 4px;font-size:14px;color:#374151">Where they were</h3>
      ${renderFacts(facts)}

      ${renderErrors(ctx.errors)}

      <h3 style="margin:22px 0 6px;font-size:14px;color:#374151">Full context</h3>
      <pre style="margin:0;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;font-size:11px;color:#4b5563;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(ctxJson)}</pre>

      <p style="margin:18px 0 0;font-size:12px;color:#9ca3af">
        Sent by the Report an Issue button in the YisraCase shell (${esc(APP_URL())}).
        The reporter saw none of the technical detail above — only their own message.
      </p>
    </div>`;

  const text = [
    `${meta.label} from ${userLabel}${userEmail ? ` <${userEmail}>` : ''}`,
    `Report #${id}`,
    '',
    note,
    '',
    '--- where they were ---',
    ...facts.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`),
    '',
    '--- full context ---',
    ctxJson,
  ].join('\n');

  const subject = `[YisraCase] ${meta.emoji} ${meta.label} from ${userLabel}: ${clamp(note.replace(/\s+/g, ' '), 70)}`;

  return { subject, html, text };
}

// ── POST /api/issue-reports ───────────────────────────────────────────────────

router.post('/api/issue-reports', jwtOrApiKey, async (req, res) => {
  try {
    const db  = req.db;
    const uid = req.auth?.userId != null ? Number(req.auth.userId) : null;

    const rlKey = Number.isInteger(uid) ? `u:${uid}` : `ip:${getClientIp(req)}`;
    if (limited(rlKey)) {
      return res.status(429).json({ error: 'Too many reports in a short window — give it a few minutes.' });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!note) return res.status(400).json({ error: 'note is required' });

    const kind = VALID_KINDS.includes(req.body?.kind) ? req.body.kind : 'problem';
    const noteClamped = clamp(note, NOTE_MAX);
    const pageUrl     = clamp(req.body?.page_url, URL_MAX);
    const contextJson = packContext(req.body?.context);

    // Attribution. The users row is the authority for the display name; fall
    // back to the JWT username, then to a stable "#id" so a report is never
    // anonymous. Denormalized into the row — see the migration's note.
    let userName  = req.auth?.username || null;
    let userEmail = null;
    if (Number.isInteger(uid)) {
      try {
        const [[u]] = await db.query(
          'SELECT user_name, email FROM users WHERE user = ? LIMIT 1', [uid]
        );
        if (u?.user_name) userName = u.user_name;
        if (u?.email)     userEmail = u.email;
      } catch (e) {
        console.error('[issue-reports] user lookup failed:', e.message);
      }
    }
    const userLabel = clamp(userName || (Number.isInteger(uid) ? `#${uid}` : 'Unknown user'), 64);

    const [ins] = await db.query(
      `INSERT INTO issue_reports (user_id, user_name, kind, note, page_url, context)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number.isInteger(uid) ? uid : null, userLabel, kind, noteClamped, pageUrl, contextJson]
    );
    const id = ins.insertId;

    // ── notify (awaited — see the header note on Cloud Run CPU throttling) ──
    let emailed = false;
    let emailErr = null;
    try {
      const to = ADMIN_EMAIL();
      if (!to) throw new Error('no email_it setting configured');

      let parsedCtx = null;
      try { parsedCtx = contextJson ? JSON.parse(contextJson) : null; } catch (_) { }

      const { subject, html, text } = buildEmail({
        id, kind, note: noteClamped, userLabel, userEmail,
        pageUrl, context: parsedCtx,
      });

      await emailService.sendEmail(db, { from: FROM_ADDR(), to, subject, html, text });
      emailed = true;
      await db.query('UPDATE issue_reports SET emailed_at = NOW() WHERE id = ?', [id])
        .catch((e) => console.error('[issue-reports] emailed_at stamp failed:', e.message));
    } catch (e) {
      emailErr = e.message || String(e);
      console.error('[issue-reports] email failed:', emailErr);
      // Best effort — the row is already durable, this is only for triage.
      await db.query(
        'UPDATE issue_reports SET email_error = ? WHERE id = ?', [clamp(emailErr, 255), id]
      ).catch(() => { });
    }

    // 201 either way: the report IS filed. `emailed` lets the dialog tell the
    // truth rather than promise a notification that never left.
    res.status(201).json({ id, emailed, ...(emailed ? {} : { email_error: emailErr }) });

  } catch (err) {
    console.error('POST /api/issue-reports error:', err);
    res.status(500).json({ error: 'Failed to file report' });
  }
});

// ── GET /api/issue-reports (admin) ────────────────────────────────────────────
//
// Response shape deliberately mirrors GET /admin/system-alerts
// ({ rows, total, limit, offset, counts }) so public/issueReports.html reads
// like public/systemAlerts.html — one idiom for the two triage tools.

router.get('/api/issue-reports', jwtOrApiKey, requireAdmin, async (req, res) => {
  try {
    const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const kind   = VALID_KINDS.includes(req.query.kind) ? req.query.kind : null;
    const q      = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where  = [];
    const params = [];
    if (status === 'open')     where.push('resolved_at IS NULL');
    if (status === 'resolved') where.push('resolved_at IS NOT NULL');
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (q) {
      where.push('(note LIKE ? OR user_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `context` is deliberately NOT selected here. It is the bulk of the row
    // (up to 24KB) and nothing in a list view renders it — 50 rows would be a
    // 1.2MB response for data the page throws away. The detail expansion
    // fetches the single row instead.
    const [rows] = await req.db.query(
      `SELECT id, user_id, user_name, kind, note, page_url,
              emailed_at, email_error, resolved_at, resolved_by, created_at
         FROM issue_reports
         ${whereSql}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await req.db.query(
      `SELECT COUNT(*) AS total FROM issue_reports ${whereSql}`, params
    );

    // Counts are filter-independent — they describe the whole table, so the
    // cards keep meaning something while you are filtered down to one row.
    // never_emailed is the one that earns its place: it is the ONLY surface
    // that shows a report whose notification silently failed to leave.
    const [[counts]] = await req.db.query(
      `SELECT
         SUM(resolved_at IS NULL)                          AS open_total,
         SUM(resolved_at IS NULL AND kind = 'problem')     AS open_problem,
         SUM(resolved_at IS NULL AND kind = 'idea')        AS open_idea,
         SUM(resolved_at IS NULL AND kind = 'question')    AS open_question,
         SUM(resolved_at >= NOW() - INTERVAL 7 DAY)        AS resolved_7d,
         SUM(emailed_at IS NULL)                           AS never_emailed
       FROM issue_reports`
    );

    res.json({
      rows, total, limit, offset,
      counts: Object.fromEntries(
        Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])
      ),
    });
  } catch (err) {
    console.error('GET /api/issue-reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ── POST /api/issue-reports/resolve (admin) — bulk resolve / reopen ───────────
//
// Mounted BEFORE the /:id getter below only for readability; the two cannot
// collide anyway (different verbs).

router.post('/api/issue-reports/resolve', jwtOrApiKey, requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids || !ids.length || ids.length > 500) {
      return res.status(400).json({ error: 'body.ids must be a non-empty array of ints (max 500)' });
    }
    const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (clean.length !== ids.length) return res.status(400).json({ error: 'body.ids must all be positive ints' });

    if (typeof req.body?.resolved !== 'boolean') {
      return res.status(400).json({ error: 'body.resolved (boolean) is required' });
    }

    const who = clamp(req.auth?.username || `#${req.auth?.userId}`, 64);
    const [r] = req.body.resolved
      ? await req.db.query(
          `UPDATE issue_reports SET resolved_at = NOW(), resolved_by = ?
            WHERE id IN (?) AND resolved_at IS NULL`, [who, clean])
      : await req.db.query(
          `UPDATE issue_reports SET resolved_at = NULL, resolved_by = NULL
            WHERE id IN (?)`, [clean]);

    res.json({ updated: r.affectedRows });
  } catch (err) {
    console.error('POST /api/issue-reports/resolve error:', err);
    res.status(500).json({ error: 'Failed to update reports' });
  }
});

// ── GET /api/issue-reports/:id (admin) — full row incl. context ───────────────

router.get('/api/issue-reports/:id', jwtOrApiKey, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    const [[row]] = await req.db.query(
      'SELECT * FROM issue_reports WHERE id = ? LIMIT 1', [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ row });
  } catch (err) {
    console.error('GET /api/issue-reports/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

module.exports = router;
