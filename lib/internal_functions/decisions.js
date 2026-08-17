// lib/internal_functions/decisions.js
//
// Human-in-the-loop decision step (HITL).
//
// request_decision pauses a workflow, sends the recipient an email and/or SMS
// carrying links to the public decision pages (routes/decisionActions.js,
// GET /d/:token), optionally creates a paired task for staff recipients, and
// resumes when the recipient responds — or at the timeout, whichever wins.
//
// ── How the pause/resume works (no new engine machinery) ────────────────────
//
// The function returns the same { delayed_until, next_step } shape as
// schedule_resume, so the engine parks the execution as 'delayed' and
// schedules a workflow_resume job at expires_at. The TIMEOUT DEFAULT is
// pre-written: the function returns set_vars { [result_var]: timeout_value },
// which the engine merges BEFORE pausing. Two futures:
//
//   • Nobody responds → the workflow_resume job fires at expires_at and the
//     workflow continues at next_step with result_var = timeout_value. A
//     separate one_time cleanup job (decision_timeout_cleanup, scheduled at
//     the same instant) marks the row timed_out, dismisses the paired task,
//     and writes the outcome log. No engine changes needed for the timeout
//     path — it IS the ordinary delayed-resume path.
//
//   • Recipient responds first → routes/decisionActions.js atomically claims
//     the row (status pending→responded, expires_at > NOW()), OVERWRITES
//     result_var with the chosen value, deletes the pending timeout resume
//     job, flips the execution delayed→active at resume_step, and advances.
//
//   Race safety: the claim requires NOW() < expires_at while the timeout job
//   only fires at NOW() >= expires_at — mutually exclusive on the same DB
//   clock. And because the response handler merges the variable BEFORE
//   flipping the execution, even a microsecond-boundary race resolves with
//   the workflow branching on the RESPONSE value, which is correct whenever
//   the claim succeeded.
//
// The step after a request_decision is typically evaluate_condition branching
// on result_var.
//
// WORKFLOW-ONLY. The sequence engine ignores delayed_until returns (it
// advances after any successful step), so a request_decision inside a
// sequence would send the message and sail on without gating. Sequences that
// need a decision gate use a start_workflow step to spawn a workflow that
// carries the gate. __meta.workflowOnly keeps it out of the sequence picker.
//
// ── [[...]] template tokens (NOT {{...}}) ───────────────────────────────────
//
// The engine resolves every {{...}} in step config BEFORE the function runs,
// so decision URLs — which don't exist until this function mints the token —
// use square-bracket tokens resolved here, after the engine pass:
//
//   [[decision_url]]          landing page URL (/d/<token>)
//   [[respond_url:VALUE]]     pre-selected confirm page for one option
//                             (/d/<token>/VALUE). Unknown VALUE throws.
//   [[question]]              the question (HTML-escaped in email_html)
//   [[options_html]]          styled button block, one per option (email only)
//   [[options_text]]          "Label: url" lines (SMS/plain text)
//   [[expires_at]]            deadline formatted in firm time
//
// Normal {{variables}} still work everywhere — they resolve first via the
// engine pipeline, so an author can write "Approve refund for {{contactName}}".
//
// SCANNER SAFETY: every emailed link is a GET that never mutates (Outlook
// SafeLinks / Gmail prefetch every GET). The mutation lives behind a form
// POST on the /d pages — same pattern as routes/taskActions.js.

const crypto = require('crypto');
const ms     = require('ms');

const fns = {};

// Read per call so live edits of the app_url setting apply without redeploy.
// Recipient-facing decision links (/d/:token) live on the PUBLIC landing host
// as of 2026-08-17 — see ref/ORIGIN_SEPARATION_ROLLOUT.md. This file mints no
// staff-shell links, so it needs no app_url form.
const PUBLIC_URL = () => require('../firmConfig').publicUrl();

const VALUE_RE = /^[a-zA-Z0-9_\-]{1,64}$/;   // option values ride in URL path segments
const VAR_RE   = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** Deliberately duplicated (self-contained convention — see taskService). */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lenient truthiness with a caller-supplied default. Workflow configs and
 * resolved {{placeholders}} deliver booleans as strings; absent/empty means
 * "use the default" (send_email defaults TRUE, so plain falsy checks would
 * flip it whenever the param is simply omitted).
 */
function boolish(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return /^(true|1|yes)$/i.test(String(v));
}

/** Format an ISO instant in firm time for human display. */
function fmtFirmTime(iso) {
  const { DateTime } = require('luxon');
  const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(FIRM_TZ)
    .toFormat("MMM d, yyyy 'at' h:mm a ZZZZ");
}

/** Styled per-option button block for the default/templated email. */
function optionButtonsHtml(options, base) {
  return options.map(o =>
    `<a href="${base}/${o.value}"
        style="display:inline-block;background:#312e81;color:#ffffff;text-decoration:none;
               border-radius:6px;padding:12px 24px;font-size:15px;font-weight:700;
               margin:0 10px 10px 0">${htmlEscape(o.label)}</a>`
  ).join('');
}

/**
 * Resolve [[...]] decision tokens in an author-supplied template.
 * `html: true` escapes [[question]] and enables [[options_html]].
 * Unknown [[respond_url:X]] values THROW — that's a config bug referencing an
 * option that doesn't exist, and it must fail loudly, not send a dead link.
 */
function resolveDecisionTokens(tpl, { question, options, token, expiresFmt, html }) {
  const base = `${PUBLIC_URL()}/d/${token}`;
  const byValue = new Set(options.map(o => o.value));
  let out = String(tpl);
  out = out.replace(/\[\[respond_url:([a-zA-Z0-9_\-]{1,64})\]\]/g, (_, v) => {
    if (!byValue.has(v)) {
      throw new Error(`request_decision: template references unknown option value "${v}" in [[respond_url:${v}]]`);
    }
    return `${base}/${v}`;
  });
  out = out.replace(/\[\[decision_url\]\]/g, base);
  out = out.replace(/\[\[question\]\]/g, html ? htmlEscape(question) : question);
  out = out.replace(/\[\[expires_at\]\]/g, expiresFmt);
  out = out.replace(/\[\[options_html\]\]/g, html ? optionButtonsHtml(options, base) : '');
  out = out.replace(/\[\[options_text\]\]/g,
    options.map(o => `${o.label}: ${base}/${o.value}`).join('\n'));
  return out;
}

/** Default decision email — matches the task email visual family. */
function defaultDecisionEmailHtml({ question, options, token, expiresFmt }) {
  const base = `${PUBLIC_URL()}/d/${token}`;
  const qHtml = htmlEscape(question).replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:94%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:#312e81;padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">YisraCase — Decision Needed</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          <p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#111827;line-height:1.5">${qHtml}</p>
          <div style="margin:0 0 8px">${optionButtonsHtml(options, base)}</div>
          <p style="margin:14px 0 0;font-size:13px;color:#6b7280">
            Clicking a button opens a confirmation page — nothing is recorded until you confirm there.
            You can also <a href="${base}" style="color:#4f46e5">review all options</a> first.
          </p>
          <p style="margin:10px 0 0;font-size:13px;color:#9ca3af">
            This request expires ${htmlEscape(expiresFmt)}. If no response is received by then,
            the default action will be taken automatically.
          </p>
        </td>
      </tr>
      <tr>
        <td style="background:#f8f7ff;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">Sent automatically by a YisraCase workflow.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Outcome log row — 'note' log linked to the execution's contact when it has
 * one. Duplicated in routes/decisionActions.js (self-contained convention,
 * same as htmlEscape in taskService/taskActions). Keep them in sync.
 */
async function logDecisionOutcome(db, row, { outcome, value = null, label = null, via = null }) {
  const logService = require('../../services/logService');
  const q = String(row.question || '').replace(/\s+/g, ' ').slice(0, 200);
  let message;
  if (outcome === 'responded') {
    message = `Decision "${q}" — responded "${label || value}" (${value})${via ? ` via ${via}` : ''}`;
  } else {
    message = `Decision "${q}" — no response by deadline; defaulted to "${row.timeout_value}"`;
  }
  const entry = {
    type: 'note',
    by: outcome === 'responded' ? (row.recipient_user_id || 0) : 0,
    subject: 'Workflow decision',
    message,
    data: {
      decision_request_id: row.id,
      workflow_execution_id: row.workflow_execution_id,
      outcome,
      ...(value != null && { value }),
    },
  };
  const [[exec]] = await db.query(
    `SELECT contact_id FROM workflow_executions WHERE id = ?`,
    [row.workflow_execution_id]
  );
  if (exec?.contact_id) {
    entry.link_type = 'contact';
    entry.link_id   = exec.contact_id;
  }
  await logService.createLogEntry(db, entry);
}

// ─────────────────────────────────────────────────────────────
// request_decision
// ─────────────────────────────────────────────────────────────

/**
 * request_decision
 * Pause the workflow and ask a human to pick one of several options.
 *
 * The chosen value (or timeout_value if nobody responds in time) lands in the
 * workflow variable named by result_var; the workflow resumes at nextStep
 * (default: the following step), where an evaluate_condition typically
 * branches on it.
 *
 * example config:
 *   { "function_name": "request_decision",
 *     "params": {
 *       "question": "Approve $500 refund for {{contactName}}?",
 *       "options": [ { "label": "Approve", "value": "approve" },
 *                    { "label": "Deny",    "value": "deny" } ],
 *       "result_var": "refund_decision",
 *       "timeout": "3d",
 *       "timeout_value": "no_response",
 *       "recipient_kind": "user",
 *       "recipient_id": 1
 *     } }
 *   ... next step:
 *   { "function_name": "evaluate_condition",
 *     "params": { "variable": "refund_decision", "operator": "equals",
 *                 "value": "approve", "then": 5, "else": 8 } }
 */
fns.request_decision = async (params, db) => {
  const executionId = Number(params._execution_id);
  const stepNumber  = Number(params._step_number);
  if (!Number.isInteger(executionId) || executionId <= 0) {
    throw new Error('request_decision can only run inside a workflow execution');
  }

  // ── Validate config ────────────────────────────────────────
  const question = String(params.question ?? '').trim();
  if (!question) throw new Error('request_decision requires question');
  if (question.length > 2000) throw new Error('request_decision: question exceeds 2000 chars');

  const rawOptions = params.options;
  if (!Array.isArray(rawOptions) || rawOptions.length < 1 || rawOptions.length > 10) {
    throw new Error('request_decision: options must be an array of 1–10 {label, value} objects');
  }
  const seen = new Set();
  const options = rawOptions.map((o, i) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      throw new Error(`request_decision: options[${i}] must be an object with label and value`);
    }
    const label = String(o.label ?? '').trim();
    const value = String(o.value ?? '').trim();
    if (!label || label.length > 100) {
      throw new Error(`request_decision: options[${i}].label must be 1–100 chars`);
    }
    if (!VALUE_RE.test(value)) {
      throw new Error(`request_decision: options[${i}].value must match ${VALUE_RE} (url-safe, it rides in the link path)`);
    }
    if (seen.has(value)) throw new Error(`request_decision: duplicate option value "${value}"`);
    seen.add(value);
    return { label, value };
  });

  const resultVar = String(params.result_var ?? '').trim();
  if (!VAR_RE.test(resultVar)) {
    throw new Error(`request_decision: result_var must match ${VAR_RE}`);
  }

  const timeoutMs = typeof params.timeout === 'number'
    ? params.timeout
    : ms(String(params.timeout ?? ''));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`request_decision: invalid timeout "${params.timeout}" (use "2h", "3d", "30m", or ms)`);
  }
  if (timeoutMs > ms('365d')) throw new Error('request_decision: timeout exceeds 365d');

  const timeoutValue = String(params.timeout_value ?? '').trim();
  if (!timeoutValue) throw new Error('request_decision requires timeout_value');
  if (timeoutValue.length > 255) throw new Error('request_decision: timeout_value exceeds 255 chars');

  let nextStep;
  if (params.nextStep != null && params.nextStep !== '') {
    nextStep = Number(params.nextStep);
    if (!Number.isInteger(nextStep) || nextStep <= 0) {
      throw new Error('request_decision: nextStep must be a positive integer');
    }
  } else {
    if (!Number.isInteger(stepNumber) || stepNumber <= 0) {
      throw new Error('request_decision: cannot default nextStep — step number unavailable; set nextStep explicitly');
    }
    nextStep = stepNumber + 1;
  }

  const expiresAtIso = new Date(Date.now() + timeoutMs).toISOString();
  const expiresFmt   = fmtFirmTime(expiresAtIso);

  // ── Resolve recipient ──────────────────────────────────────
  const kind = params.recipient_kind;
  if (!['user', 'contact', 'raw'].includes(kind)) {
    throw new Error("request_decision: recipient_kind must be 'user', 'contact', or 'raw'");
  }

  let recipientUserId = null, recipientContactId = null;
  let email = null, phone = null;

  if (kind === 'user') {
    const uid = Number(params.recipient_id);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('request_decision: recipient_id (user id) required for recipient_kind=user');
    const [[u]] = await db.query(`SELECT user, user_name, email, phone FROM users WHERE user = ?`, [uid]);
    if (!u) throw new Error(`request_decision: user ${uid} not found`);
    recipientUserId = u.user;
    email = (u.email || '').trim() || null;
    phone = (u.phone || '').trim() || null;
  } else if (kind === 'contact') {
    const cid = Number(params.recipient_id);
    if (!Number.isInteger(cid) || cid <= 0) throw new Error('request_decision: recipient_id (contact id) required for recipient_kind=contact');
    const [[c]] = await db.query(`SELECT contact_id, contact_name, contact_email, contact_phone FROM contacts WHERE contact_id = ?`, [cid]);
    if (!c) throw new Error(`request_decision: contact ${cid} not found`);
    recipientContactId = c.contact_id;
    email = (c.contact_email || '').trim() || null;
    phone = (c.contact_phone || '').trim() || null;
  } else {
    email = String(params.recipient_email ?? '').trim() || null;
    phone = String(params.recipient_phone ?? '').trim() || null;
    if (!email && !phone) throw new Error('request_decision: recipient_kind=raw requires recipient_email and/or recipient_phone');
  }

  const wantEmail = boolish(params.send_email, true);
  const wantSms   = boolish(params.send_sms, false);
  const wantTask  = boolish(params.create_task, true) && kind === 'user';

  const emailTo = wantEmail ? email : null;
  const smsTo   = wantSms   ? phone : null;
  if (!emailTo && !smsTo && !wantTask) {
    throw new Error('request_decision: no delivery surface — recipient has no usable email/phone for the requested channels and no paired task will be created');
  }

  // ── Insert the request row ─────────────────────────────────
  const token = crypto.randomBytes(16).toString('base64url'); // 22 chars, mirrors tasks
  const [ins] = await db.query(
    `INSERT INTO decision_requests
       (token, workflow_execution_id, step_number, resume_step, recipient_kind,
        recipient_user_id, recipient_contact_id, recipient_email, recipient_phone,
        question, options, result_var, timeout_value, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      token, executionId, Number.isInteger(stepNumber) ? stepNumber : 0, nextStep, kind,
      recipientUserId, recipientContactId, emailTo, smsTo,
      question, JSON.stringify(options), resultVar, timeoutValue, expiresAtIso,
    ]
  );
  const decisionId = ins.insertId;
  const decisionUrl = `${PUBLIC_URL()}/d/${token}`;

  // ── Paired task (staff recipients) — best-effort ───────────
  let pairedTaskId = null;
  if (wantTask) {
    try {
      const taskService = require('../../services/taskService');
      const rawTitle = String(params.task_title ?? '').trim() || `Decision: ${question}`;
      const title = rawTitle.length > 100 ? rawTitle.slice(0, 87) + '…(truncated)' : rawTitle;
      const descBase = `${question}\n\nRespond: ${decisionUrl}\nExpires: ${expiresFmt}`;
      const desc = descBase.length > 1000 ? descBase.slice(0, 987) + '…(truncated)' : descBase;
      const created = await taskService.createTask(db, {
        from: 0,                    // automations user
        to: recipientUserId,
        title,
        desc,
        source: 'decision_request',
        send_assignment_email: false,   // the decision email/SMS IS the notification
      });
      pairedTaskId = created.task_id;
      await db.query(`UPDATE decision_requests SET paired_task_id = ? WHERE id = ?`, [pairedTaskId, decisionId]);
    } catch (err) {
      console.error(`[REQUEST_DECISION] Paired task creation failed for decision ${decisionId}:`, err.message);
    }
  }

  // ── Send messages ──────────────────────────────────────────
  const tokenCtx  = { question, options, token, expiresFmt };
  const delivered = [];
  const failures  = [];

  if (emailTo) {
    try {
      const emailService = require('../../services/emailService');
      const from = String(params.email_from ?? '').trim()
        || await require('../../services/taskService').getFromEmail(db);
      const subject = params.email_subject
        ? resolveDecisionTokens(params.email_subject, { ...tokenCtx, html: false })
        : `Decision needed: ${question.replace(/\s+/g, ' ').slice(0, 80)}`;
      const html = params.email_html
        ? resolveDecisionTokens(params.email_html, { ...tokenCtx, html: true })
        : defaultDecisionEmailHtml(tokenCtx);
      await emailService.sendEmail(db, { from, to: emailTo, subject, html });
      delivered.push('email');
    } catch (err) {
      failures.push(`email: ${err.message}`);
    }
  } else if (wantEmail) {
    failures.push('email: recipient has no email address');
  }

  if (smsTo) {
    try {
      const phoneService = require('../../services/phoneService');
      const smsFrom = String(params.sms_from ?? '').trim()
        || await require('../../services/taskService').getSmsFrom(db);
      if (!smsFrom) throw new Error('no sms_from configured (sms_staff_from / sms_default_from settings empty)');
      const text = params.sms_text
        ? resolveDecisionTokens(params.sms_text, { ...tokenCtx, html: false })
        : `${question.replace(/\s+/g, ' ').slice(0, 240)}\nRespond: ${decisionUrl}`;
      await phoneService.sendSms(db, smsFrom, smsTo, text);
      delivered.push('sms');
    } catch (err) {
      failures.push(`sms: ${err.message}`);
    }
  } else if (wantSms) {
    failures.push('sms: recipient has no phone number');
  }

  // Undeliverable AND no paired task → the recipient can never see this.
  // Close the row and fail the step so error_policy decides what happens.
  if (delivered.length === 0 && !pairedTaskId) {
    await db.query(
      `UPDATE decision_requests SET status = 'cancelled', updated_at = NOW() WHERE id = ? AND status = 'pending'`,
      [decisionId]
    );
    throw new Error(`request_decision: all delivery channels failed — ${failures.join('; ')}`);
  }

  // ── Timeout cleanup job (row status + paired task + log) ───
  // The workflow's own timeout resume is the engine's ordinary delayed-resume
  // job (scheduled by the engine from delayed_until below). This SEPARATE
  // one_time job only tidies the decision row at expiry; if the recipient
  // responds first it no-ops (the guarded UPDATE inside finds status
  // != 'pending'), so it is never cancelled — just left to fizzle.
  await db.query(
    `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data)
     VALUES ('one_time', ?, 'pending', ?, ?)`,
    [
      expiresAtIso,
      `Decision #${decisionId} timeout cleanup`,
      JSON.stringify({
        type: 'internal_function',
        function_name: 'decision_timeout_cleanup',
        params: { decision_request_id: decisionId },
      }),
    ]
  );

  console.log(
    `[REQUEST_DECISION] #${decisionId} exec=${executionId} step=${stepNumber} ` +
    `recipient=${kind}${recipientUserId ? ` user ${recipientUserId}` : ''}${recipientContactId ? ` contact ${recipientContactId}` : ''} ` +
    `delivered=[${delivered.join(',')}]${pairedTaskId ? ` task=${pairedTaskId}` : ''} ` +
    `expires=${expiresAtIso} → resume step ${nextStep}` +
    (failures.length ? ` | failures: ${failures.join('; ')}` : '')
  );

  // Pre-write the timeout default; pause until expires_at. A response
  // overwrites the variable and resumes early.
  return {
    success: true,
    delayed_until: expiresAtIso,
    next_step: nextStep,
    set_vars: { [resultVar]: timeoutValue },
    output: {
      decision_request_id: decisionId,
      token,
      decision_url: decisionUrl,
      expires_at: expiresAtIso,
      delivered,
      failures,
      paired_task_id: pairedTaskId,
    },
  };
};

fns.request_decision.__meta = {
  category: 'control',
  workflowOnly: true,   // sequence engine can't pause on step results — use start_workflow to wrap a gate
  controlFlow: true,
  description:
    'Human-in-the-loop gate: pause the workflow, email/SMS a person clickable options, and resume ' +
    'when they respond (or at the timeout with timeout_value). The chosen value lands in the variable ' +
    'named by result_var — branch on it with evaluate_condition at the next step. Staff recipients also ' +
    'get a paired task that auto-closes with the decision. Message templates support [[decision_url]], ' +
    '[[respond_url:VALUE]], [[question]], [[options_html]], [[options_text]], [[expires_at]] (square ' +
    'brackets — resolved after the normal {{variable}} pass).',
  params: [
    { name: 'question', type: 'string', required: true, placeholderAllowed: true, multiline: true,
      description: 'The question shown on the decision page, in the default email, and in the outcome log. Max 2000 chars.',
      example: 'Approve $500 refund for {{contactName}}?' },
    { name: 'options', type: 'array', required: true,
      description: 'JSON array of 1–10 {"label","value"} objects. label ≤100 chars; value url-safe [a-zA-Z0-9_-]{1,64}, unique. The chosen value is written to result_var.',
      example: [{ label: 'Approve', value: 'approve' }, { label: 'Deny', value: 'deny' }] },
    { name: 'result_var', type: 'string', required: true,
      description: 'Workflow variable that receives the chosen value (or timeout_value).',
      example: 'refund_decision' },
    { name: 'timeout', type: 'duration', required: true, placeholderAllowed: true,
      description: 'How long to wait — "2h", "3d", "30m", or milliseconds. Max 365d.',
      example: '3d' },
    { name: 'timeout_value', type: 'string', required: true, placeholderAllowed: true,
      description: 'Written to result_var when nobody responds in time. Need not be one of the option values — branch on it like any other.',
      example: 'no_response' },
    { name: 'nextStep', type: 'integer', required: false,
      description: 'Step the workflow resumes at after response OR timeout. Default: the step after this one. Typically an evaluate_condition on result_var.',
      example: 4 },
    { name: 'recipient_kind', type: 'enum', required: true, enum: ['user', 'contact', 'raw'],
      description: "'user' = staff (users table, gets a paired task), 'contact' = client, 'raw' = explicit email/phone." },
    { name: 'recipient_id', type: 'integer', required: false, placeholderAllowed: true,
      description: 'User id or contact id (required for kind user/contact). Accepts a {{placeholder}}.',
      example: 1 },
    { name: 'recipient_email', type: 'string', required: false, placeholderAllowed: true,
      description: 'Email address for recipient_kind=raw.' },
    { name: 'recipient_phone', type: 'string', required: false, placeholderAllowed: true,
      description: 'Phone for recipient_kind=raw.' },
    { name: 'send_email', type: 'boolean', required: false, default: true,
      description: 'Send the decision email. Omitting email_html sends a styled default with one button per option.' },
    { name: 'send_sms', type: 'boolean', required: false, default: false,
      description: 'Send an SMS carrying the decision link.' },
    { name: 'email_from', type: 'string', required: false, widget: 'email_from',
      description: 'Sender address (email_credentials row). Default: the email_automations setting.' },
    { name: 'email_subject', type: 'string', required: false, placeholderAllowed: true,
      description: 'Default: "Decision needed: <question>". [[...]] tokens work here too.' },
    { name: 'email_html', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'Custom HTML body. Use [[options_html]] or per-option [[respond_url:VALUE]] links. Omit for the styled default email.' },
    { name: 'sms_from', type: 'string', required: false, widget: 'phone_line',
      description: 'Sending line (phone_lines.phone_number). Default: sms_staff_from / sms_default_from setting.' },
    { name: 'sms_text', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'Custom SMS body — include [[decision_url]]. Default: question + link.' },
    { name: 'create_task', type: 'boolean', required: false, default: true,
      description: 'Staff recipients only: create a paired task (source=decision_request, no assignment email) that auto-completes on response and is dismissed on timeout/cancel.' },
    { name: 'task_title', type: 'string', required: false, placeholderAllowed: true,
      description: 'Paired task title. Default: "Decision: <question>".' },
  ],
  example: {
    question: 'Approve $500 refund for {{contactName}}?',
    options: [{ label: 'Approve', value: 'approve' }, { label: 'Deny', value: 'deny' }],
    result_var: 'refund_decision',
    timeout: '3d',
    timeout_value: 'no_response',
    recipient_kind: 'user',
    recipient_id: 1,
  },
};

// ─────────────────────────────────────────────────────────────
// decision_timeout_cleanup — internal, scheduled by request_decision
// ─────────────────────────────────────────────────────────────

/**
 * Marks a decision request timed_out at its expiry, dismisses the paired
 * task, and writes the outcome log row. The WORKFLOW's timeout resume is a
 * separate, ordinary workflow_resume job — this only tidies the request.
 *
 * Idempotent / race-free: the guarded UPDATE (status='pending') no-ops when
 * the recipient responded or the execution's cancel cascade already closed
 * the row. Never cancelled on response — just left to fizzle here.
 */
fns.decision_timeout_cleanup = async (params, db) => {
  const id = Number(params.decision_request_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('decision_timeout_cleanup requires decision_request_id');
  }

  const [[row]] = await db.query(`SELECT * FROM decision_requests WHERE id = ?`, [id]);
  if (!row) return { success: true, output: { skipped: 'row not found' } };

  const [upd] = await db.query(
    `UPDATE decision_requests SET status = 'timed_out', updated_at = NOW() WHERE id = ? AND status = 'pending'`,
    [id]
  );
  if (upd.affectedRows === 0) {
    return { success: true, output: { skipped: `status was ${row.status}` } };
  }

  if (row.paired_task_id) {
    try {
      // Dismissed, not completed — the decision defaulted; nobody acted.
      await require('../../services/taskService').deleteTask(
        db, row.paired_task_id, 0, { via: 'decision_timeout' }
      );
    } catch (err) {
      // Already completed/deleted races are fine.
      console.warn(`[DECISION TIMEOUT] Could not dismiss task ${row.paired_task_id}:`, err.message);
    }
  }

  try {
    await logDecisionOutcome(db, row, { outcome: 'timed_out' });
  } catch (err) {
    console.warn(`[DECISION TIMEOUT] Outcome log failed for decision ${id}:`, err.message);
  }

  console.log(`[DECISION TIMEOUT] Decision ${id} marked timed_out (exec ${row.workflow_execution_id})`);
  return { success: true, output: { timed_out: true, decision_request_id: id } };
};

fns.decision_timeout_cleanup.__meta = {
  category: 'control',
  workflowOnly: true,
  uiHidden: true,   // internal plumbing — scheduled automatically by request_decision
  description: 'Internal: marks a decision request timed_out at expiry, dismisses its paired task, and logs the outcome. Scheduled automatically by request_decision — do not add to workflows.',
  params: [
    { name: 'decision_request_id', type: 'integer', required: true,
      description: 'decision_requests.id to close out.' },
  ],
  example: { decision_request_id: 42 },
};

module.exports = fns;
