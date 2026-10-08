// routes/api.cta.js
//
/**
 * CTA (Call To Action) — SU management API. CTA arc S2.
 * Spec: ref/CTA_DESIGN.md §5.3. Substrate: services/ctaService.js.
 * Public surface: routes/ctaActions.js (/c/…).
 *
 * Every route is guarded superuserOnlyFor('cta') — JWT-only + SU +
 * X-SU-Elevation step-up + per-tool rate limit; API keys are 403 at the SU
 * check. Mount path /api/cta is NOT on the pageLanding allowlist, so the
 * whole API dead-ends on the landing host.
 *
 *   POST  /api/cta                  mint. Body = the ctaService mint input
 *                                   (name, prompt, context_html, options,
 *                                   mode, max_uses, expires_at | timeout,
 *                                   timeout_option, protection, password,
 *                                   return_plan_result, attributed_user_id,
 *                                   link_type, link_id, dry_run,
 *                                   accept_risks) plus the API-only
 *                                   `email_template` (below). Options may
 *                                   declare clicker `inputs` (§12).
 *                                   201 { …receipt, cta_url, urls,
 *                                   options_html, email_html }. `password`
 *                                   is in the receipt ONLY when auto-
 *                                   generated — the one time it is shown.
 *     dry_run: true                 full validation (per-step params,
 *                                   result_template refs, the template's
 *                                   [[respond_url:X]]), URLs carrying the
 *                                   literal "<token>", the rendered email —
 *                                   200, nothing inserted, nothing audited.
 *     accept_risks                  §12 acknowledge-to-proceed codes. A mint
 *                                   (dry_run too) that triggers one not
 *                                   listed is 400 code risk_acceptance_required
 *                                   with `risks: [{code, description}]` — the
 *                                   pane's checkbox source. Accepted codes come
 *                                   back as receipt.risks_accepted and land in
 *                                   the audit row.
 *     email_template                optional HTML using [[cta_url]],
 *                                   [[respond_url:VALUE]], [[options_html]],
 *                                   [[expires_at]] (lib/ctaLinks.js). Resolved
 *                                   into email_html; an unknown
 *                                   [[respond_url:X]] is a 400 BEFORE any row
 *                                   is written. Never stored.
 *   GET   /api/cta                  list, newest first, with exec counts
 *                                   (?status=active|used|disabled|cancelled,
 *                                   ?limit ≤200, ?offset)
 *   GET   /api/cta/:id/executions   every run with its FULL plan_result — the
 *                                   only surface that carries it (B5) — plus
 *                                   `links` (the detail's copy buttons; see
 *                                   the handler)
 *   PATCH /api/cta/:id              { expires_at?, max_uses?, status? } —
 *                                   ctaService.patchCta (extend, disable ↔
 *                                   enable, re-enable after a failed or dead
 *                                   run, cancel = permanent)
 *   POST  /api/cta/:id/send         { channel: 'email'|'sms', to, from?,
 *                                   subject?, email_template?, sms_text?,
 *                                   dry_run? } —
 *                                   send an ACTIVE link (send slice,
 *                                   2026-10-08; see the handler's header)
 *
 * SERVER-OWNED FIELDS: minted_by is the calling SU and mint_source is 'su',
 * always. A body that tries to set minted_by / mint_source /
 * source_execution_id is a 400 — accepting mint_source:'workflow' here would
 * mint a row that skips the B1 click-time SU check forever.
 *
 * AUDIT: mint, every changing PATCH (disable/enable/re-enable/cancel/
 * extend) and every real send write admin_audit_log (tool 'cta') —
 * superuserOnlyFor audits only REJECTIONS on its own. Details carry ids,
 * settings and a field diff; never the token, the password or
 * password_hash. Reads are not audited (house convention, api.tools).
 *
 * Never password_hash on any response (ctaService.adminRow).
 * Error shape: { status:'error', message, code? } — house standard.
 * Auto-mounts via the routes/ scan in server.js.
 */

'use strict';

const express = require('express');
const router = express.Router();
const ctaService = require('../services/ctaService');
const ctaLinks = require('../lib/ctaLinks');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');

const TOOL = 'cta';   // admin_audit_log tag + SU rate-limit bucket
const guard = superuserOnlyFor(TOOL);

const SERVER_OWNED = ['minted_by', 'mint_source', 'source_execution_id'];
const DIFF_KEYS = ['status', 'expires_at', 'max_uses', 'uses_count'];

function errBody(message, code) {
  return code ? { status: 'error', message, code } : { status: 'error', message };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ipOf = (req) =>
  req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;

async function audit(req, details, { status = 'ok', errorMessage = null } = {}) {
  try {
    await auditAdminAction(req.db, {
      tool: TOOL,
      userId: req.auth?.userId,
      username: req.auth?.username,
      route: req.originalUrl,
      method: req.method,
      status,
      errorMessage,
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
      details,
    });
  } catch (e) {
    console.error('cta audit failed:', e.message);
  }
}

function sendError(res, err, label) {
  if (err instanceof ctaService.CtaError) {
    const body = errBody(err.message, err.code);
    if (Array.isArray(err.risks)) body.risks = err.risks;   // §12 risk_acceptance_required
    return res.status(err.status).json(body);
  }
  console.error(`${label} error:`, err.message);
  return res.status(500).json(errBody('Internal error'));
}

/** SU view + the public URL. */
function withUrl(row) {
  return row ? { ...row, cta_url: ctaLinks.ctaUrl(row.token) } : row;
}

function cmpVal(v) {
  if (v instanceof Date) return v.toISOString();
  return v == null ? null : String(v);
}

/** { field: { from, to } } for the fields a PATCH can move. */
function diff(before, after) {
  const out = {};
  for (const k of DIFF_KEYS) {
    const a = cmpVal(before[k]);
    const b = cmpVal(after[k]);
    if (a !== b) out[k] = { from: a, to: b };
  }
  return out;
}

function patchAction(before, after) {
  if (before.status === after.status) return 'patch';
  if (after.status === 'disabled') return 'disable';
  if (after.status === 'cancelled') return 'cancel';
  if (after.status === 'active') return before.status === 'used' ? 'reenable' : 'enable';
  return 'patch';
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cta — mint (and dry_run)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/cta', guard, async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body)) return res.status(400).json(errBody('cta: mint body must be a JSON object'));
  for (const k of SERVER_OWNED) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      return res.status(400).json(errBody(`cta: ${k} is set by the server (the calling superuser) — remove it`));
    }
  }
  // dry_run must be a real boolean: mintCta treats anything but `true` as a
  // real mint, so a stringly "true" would silently INSERT.
  if (body.dry_run != null && typeof body.dry_run !== 'boolean') {
    return res.status(400).json(errBody('cta: dry_run must be a boolean'));
  }
  if (body.email_template != null && typeof body.email_template !== 'string') {
    return res.status(400).json(errBody('cta: email_template must be a string'));
  }

  const { email_template: emailTemplate = null, ...rest } = body;
  const input = { ...rest, minted_by: req.auth.userId, mint_source: 'su' };
  const dryRun = input.dry_run === true;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';

  const bundle = (token, r) => ctaLinks.linkBundle({
    token,
    options: r.options,
    expiresAt: r.expires_at,
    prompt,
    protection: r.protection,
    timeoutOption: r.timeout_option,
    emailTemplate,
  });

  try {
    // Full validation with no insert — the canonical, normalized options the
    // template is checked against. A real mint repeats it inside mintCta;
    // the extra settings read is the price of never writing a row whose
    // email template would have failed.
    const preview = await ctaService.mintCta(req.db, { ...input, dry_run: true });
    let previewLinks;
    try {
      previewLinks = bundle(ctaLinks.PLACEHOLDER_TOKEN, preview);
    } catch (e) {
      return res.status(400).json(errBody(`cta: email_template: ${e.message}`, 'invalid'));
    }
    if (dryRun) return res.status(200).json({ ...preview, ...previewLinks });

    const receipt = await ctaService.mintCta(req.db, { ...input, dry_run: false });
    const links = bundle(receipt.token, receipt);

    await audit(req, {
      action: 'mint',
      cta_id: receipt.id,
      name: receipt.name,
      mode: receipt.mode,
      protection: receipt.protection,
      protection_source: receipt.protection_source,
      password_generated: receipt.password !== undefined,
      expires_at: receipt.expires_at,
      max_uses: receipt.max_uses,
      timeout_option: receipt.timeout_option,
      return_plan_result: input.return_plan_result === true || input.return_plan_result === 1,
      attributed_user_id: input.attributed_user_id ?? null,
      link: input.link_type ? { type: input.link_type, id: String(input.link_id) } : null,
      // §12: input NAMES per option (the receipt's normalized list) — never
      // defaults or patterns — and the acknowledged risk codes.
      options: input.options.map((o, i) => {
        const a = { value: String(o.value).trim(), steps: o.plan.map((s) => s.fn) };
        const names = receipt.options[i] && receipt.options[i].inputs;
        if (names) a.inputs = names;
        return a;
      }),
      risks_accepted: receipt.risks_accepted,
      email_template: emailTemplate != null,
    });

    return res.status(201).json({ ...receipt, ...links });
  } catch (err) {
    return sendError(res, err, 'POST /api/cta');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cta — list
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/cta', guard, async (req, res) => {
  try {
    const rows = await ctaService.listCtas(req.db, {
      status: req.query.status ?? null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ctas: rows.map(withUrl) });
  } catch (err) {
    sendError(res, err, 'GET /api/cta');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cta/:id/executions — the full plan_result surface
// ─────────────────────────────────────────────────────────────────────────────
//
// `links` (2026-10-08 r3): the pane's detail view offers the receipt's Copy
// email / Copy buttons after the receipt is gone, so this read carries what
// the mint receipt did — { urls, options_html, email_html } composed from the
// row by ctaLinks.linkBundle. The DEFAULT email only: a mint-time custom
// template was never stored. Composed at read time, so it shows the current
// expiry (an extended link's email says so). ACTIVE links only, else null —
// the same line as /send: a dead link's email is not something to hand out.

/** The detail's copy bundle for an adminRow, or null when the link isn't active. */
function detailLinks(cta) {
  if (!cta || cta.state !== 'active') return null;
  const b = ctaLinks.linkBundle({
    token: cta.token,
    options: cta.options,
    expiresAt: cta.expires_at,
    prompt: cta.prompt,
    protection: cta.protection,
    timeoutOption: cta.timeout_option,
  });
  return { urls: b.urls, options_html: b.options_html, email_html: b.email_html };
}

router.get('/api/cta/:id/executions', guard, async (req, res) => {
  try {
    const out = await ctaService.listExecutions(req.db, req.params.id, { limit: req.query.limit });
    res.json({ cta: withUrl(out.cta), executions: out.executions, links: detailLinks(out.cta) });
  } catch (err) {
    sendError(res, err, 'GET /api/cta/:id/executions');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/cta/:id
// ─────────────────────────────────────────────────────────────────────────────

router.patch('/api/cta/:id', guard, async (req, res) => {
  try {
    const r = await ctaService.patchCta(req.db, req.params.id, req.body);
    if (r.changed) {
      const details = {
        action: patchAction(r.before, r.after),
        cta_id: r.after.id,
        name: r.after.name,
        changes: diff(r.before, r.after),
      };
      if (r.finalized_execution_id != null) details.finalized_execution_id = r.finalized_execution_id;
      await audit(req, details);
    }
    const out = { changed: r.changed, cta: withUrl(ctaService.adminRow(r.after)) };
    if (r.finalized_execution_id != null) out.finalized_execution_id = r.finalized_execution_id;
    res.json(out);
  } catch (err) {
    sendError(res, err, 'PATCH /api/cta/:id');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cta/:id/send — send an ACTIVE link by email or SMS
// ─────────────────────────────────────────────────────────────────────────────
//
// Send slice (2026-10-08, Fred's rulings). Server-side because the email only
// ever exists composed from the row (templates are never stored), the send is
// an audit event like mint/PATCH, and its log row belongs next to the link.
//
//   Active only: deriveState must be 'active' — used / disabled / cancelled /
//     expired / exhausted are a 409 (code not_active). Sending a dead link is
//     a footgun.
//   Email: subject defaults to "Action requested: <prompt>"; email_template
//     goes through the same [[...]] resolver as a mint (unknown
//     [[respond_url:X]] → 400 before anything is sent) and is never stored.
//   SMS: default = prompt + "Respond: <landing>" (request_decision's default
//     SMS). sms_text (r2, Fred 2026-10-08: "allow editing the sms, like we
//     allow the email") replaces it: same resolver + throw-on-unknown, never
//     stored, and it must still carry the link and fit 1000 chars once
//     resolved (ctaLinks.composeSend) — else 400 before anything is sent.
//     No subject / email_template on SMS; no sms_text on email.
//   from defaults: email → taskService.getFromEmail (email_automations);
//     sms → taskService.getSmsFrom (sms_staff_from / sms_default_from) — the
//     resolution request_decision uses.
//   Password: never included — only the bcrypt hash exists. The pane says
//     "send it separately".
//   Log (success, best-effort): only when the link has link_type/link_id.
//     email → an 'email' row (from/to/subject + the plain summary): emailService
//       records nothing itself, so this IS the record.
//     sms → a 'note' row ("link sent by SMS"), NOT an 'sms' row: the provider
//       webhook writes the authoritative sms row (communicate.html's
//       duplicate-row rule).
//   Audit: every real attempt — 'ok', or 'error' with the transport message
//     (a failed send to a typed address is still worth seeing). Never the
//     token, never a password.
//   dry_run: true → the composed message (subject/html/text, or text) and the
//     resolved from; `to` optional; nothing sent, logged or audited.
//   No limiter beyond the SU guard's (elevation + per-tool rate limit).

const SEND_KEYS = new Set(['channel', 'to', 'from', 'subject', 'email_template', 'sms_text', 'dry_run']);
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** 10-digit NANP or null (phoneService.normalizeE164's acceptance, pre-checked for a clean 400). */
function phone10(v) {
  const d = String(v).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return null;
}

router.post('/api/cta/:id/send', guard, async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body)) return res.status(400).json(errBody('cta: send body must be a JSON object'));
  for (const k of Object.keys(body)) {
    if (!SEND_KEYS.has(k)) return res.status(400).json(errBody(`cta: send: unknown field "${k}"`));
  }
  const channel = body.channel;
  if (channel !== 'email' && channel !== 'sms') {
    return res.status(400).json(errBody("cta: channel must be 'email' or 'sms'"));
  }
  if (body.dry_run != null && typeof body.dry_run !== 'boolean') {
    return res.status(400).json(errBody('cta: dry_run must be a boolean'));
  }
  const dryRun = body.dry_run === true;
  for (const k of ['to', 'from', 'subject', 'email_template', 'sms_text']) {
    if (body[k] != null && typeof body[k] !== 'string') return res.status(400).json(errBody(`cta: ${k} must be a string`));
  }
  if (channel === 'sms') {
    for (const k of ['subject', 'email_template']) {
      if (body[k] != null && body[k].trim() !== '') {
        return res.status(400).json(errBody(`cta: ${k} applies to channel 'email' only — for an SMS, edit sms_text`));
      }
    }
  } else if (body.sms_text != null && body.sms_text.trim() !== '') {
    return res.status(400).json(errBody("cta: sms_text applies to channel 'sms' only — for an email, use subject / email_template"));
  }
  const to = (body.to || '').trim();
  if (!to && !dryRun) return res.status(400).json(errBody('cta: to is required'));
  if (to && channel === 'email' && !EMAIL_RE.test(to)) {
    return res.status(400).json(errBody(`cta: to "${to}" is not an email address`));
  }
  if (to && channel === 'sms' && !phone10(to)) {
    return res.status(400).json(errBody(`cta: to "${to}" is not a 10-digit phone number`));
  }
  if (!/^[1-9]\d*$/.test(String(req.params.id))) return res.status(400).json(errBody('cta: invalid CTA id'));

  try {
    const row = await ctaService.getCtaById(req.db, Number(req.params.id));
    if (!row) return res.status(404).json(errBody(`cta: CTA ${req.params.id} not found`, 'not_found'));
    const state = ctaService.deriveState(row);
    if (state !== 'active') {
      return res.status(409).json(errBody(`cta: only an active link can be sent — CTA ${row.id} is ${state}`, 'not_active'));
    }

    let msg;
    try {
      msg = ctaLinks.composeSend({
        channel,
        token: row.token,
        prompt: row.prompt,
        options: row.options,
        expiresAt: row.expires_at,
        protection: row.protection,
        timeoutOption: row.timeout_option,
        subject: body.subject ?? null,
        emailTemplate: body.email_template ?? null,
        smsText: body.sms_text ?? null,
      });
    } catch (e) {
      const what = channel === 'sms' ? 'sms_text' : 'email_template/subject';
      return res.status(400).json(errBody(`cta: ${what}: ${e.message}`, 'invalid'));
    }

    const taskService = require('../services/taskService');
    const from = (body.from || '').trim()
      || (channel === 'email' ? await taskService.getFromEmail(req.db) : await taskService.getSmsFrom(req.db));
    if (!from) {
      return res.status(400).json(errBody('cta: no sending line — pass from, or set the sms_staff_from / sms_default_from setting'));
    }

    if (dryRun) {
      return res.status(200).json({ dry_run: true, channel, cta_id: row.id, from, to: to || null, ...msg });
    }

    const auditBase = {
      action: 'send', cta_id: row.id, name: row.name, channel, to, from,
      template: msg.template,
      ...(channel === 'email' ? { subject: msg.subject } : {}),
    };

    try {
      if (channel === 'email') {
        const emailService = require('../services/emailService');
        const mail = { from, to, subject: msg.subject, html: msg.html };
        if (msg.text) mail.text = msg.text;
        await emailService.sendEmail(req.db, mail);
      } else {
        const phoneService = require('../services/phoneService');
        await phoneService.sendSms(req.db, from, to, msg.text);
      }
    } catch (err) {
      await audit(req, auditBase, { status: 'error', errorMessage: String(err.message || err).slice(0, 500) });
      console.error(`POST /api/cta/:id/send ${channel} failed:`, err.message);
      return res.status(502).json(errBody(`cta: ${channel} send failed — ${err.message}`, 'send_failed'));
    }

    let logId = null;
    if (row.link_type && row.link_id) {
      try {
        const logService = require('../services/logService');
        const entry = channel === 'email'
          ? {
            type: 'email', link_type: row.link_type, link_id: row.link_id, by: req.auth.userId,
            direction: 'outgoing', from, to, subject: msg.subject,
            data: { from, to, subject: msg.subject, body: msg.summary, cta_id: row.id, template: msg.template },
          }
          : {
            type: 'note', link_type: row.link_type, link_id: row.link_id, by: req.auth.userId,
            subject: 'CTA',
            message: `CTA "${String(row.name).slice(0, 120)}" (#${row.id}) link sent by SMS to ${to} from ${from}`,
            data: { cta_id: row.id, channel: 'sms', to, from, template: msg.template },
          };
        const out = await logService.createLogEntry(req.db, entry);
        logId = out && out.log_id != null ? out.log_id : null;
      } catch (err) {
        console.warn(`[CTA] send log failed for CTA ${row.id}:`, err.message);
      }
    }

    await audit(req, { ...auditBase, log_id: logId });
    return res.status(200).json({
      sent: true, channel, cta_id: row.id, to, from,
      template: auditBase.template,
      ...(channel === 'email' ? { subject: msg.subject } : {}),
      log_id: logId,
    });
  } catch (err) {
    return sendError(res, err, 'POST /api/cta/:id/send');
  }
});

module.exports = router;
