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
 *                                   link_type, link_id, dry_run) plus the
 *                                   API-only `email_template` (below).
 *                                   201 { …receipt, cta_url, urls,
 *                                   options_html, email_html }. `password`
 *                                   is in the receipt ONLY when auto-
 *                                   generated — the one time it is shown.
 *     dry_run: true                 full validation (per-step params,
 *                                   result_template refs, the template's
 *                                   [[respond_url:X]]), URLs carrying the
 *                                   literal "<token>", the rendered email —
 *                                   200, nothing inserted, nothing audited.
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
 *                                   only surface that carries it (B5)
 *   PATCH /api/cta/:id              { expires_at?, max_uses?, status? } —
 *                                   ctaService.patchCta (extend, disable ↔
 *                                   enable, re-enable after a failed or dead
 *                                   run, cancel = permanent)
 *
 * SERVER-OWNED FIELDS: minted_by is the calling SU and mint_source is 'su',
 * always. A body that tries to set minted_by / mint_source /
 * source_execution_id is a 400 — accepting mint_source:'workflow' here would
 * mint a row that skips the B1 click-time SU check forever.
 *
 * AUDIT: mint and every changing PATCH (disable/enable/re-enable/cancel/
 * extend) write admin_audit_log (tool 'cta') — superuserOnlyFor audits only
 * REJECTIONS on its own. Details carry ids, settings and a field diff;
 * never the token, the password or password_hash. Reads are not audited
 * (house convention, api.tools).
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

async function audit(req, details) {
  try {
    await auditAdminAction(req.db, {
      tool: TOOL,
      userId: req.auth?.userId,
      username: req.auth?.username,
      route: req.originalUrl,
      method: req.method,
      status: 'ok',
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
    return res.status(err.status).json(errBody(err.message, err.code));
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
      options: input.options.map((o) => ({ value: String(o.value).trim(), steps: o.plan.map((s) => s.fn) })),
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

router.get('/api/cta/:id/executions', guard, async (req, res) => {
  try {
    const out = await ctaService.listExecutions(req.db, req.params.id, { limit: req.query.limit });
    res.json({ cta: withUrl(out.cta), executions: out.executions });
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

module.exports = router;
