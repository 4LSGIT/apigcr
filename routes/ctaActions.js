// routes/ctaActions.js
//
/**
 * CTA (Call To Action) links — public, no auth. CTA arc S2.
 * Spec: ref/CTA_DESIGN.md §5.1/§5.2/§6. Substrate: services/ctaService.js
 * (every rule about WHO may run WHAT lives there; this file is the surface).
 *
 *   GET  /c/:token          landing page: prompt + one button per option
 *                           (+ the password field when protected)
 *   GET  /c/:token/:value   pre-selected confirm page for one option — what
 *                           the emailed buttons link to (+ password field)
 *   POST /c/:token/respond  run the chosen option's plan (form or JSON body
 *                           {value, password?})
 *
 * Same family as routes/decisionActions.js (/d/) and routes/taskActions.js
 * (/t/), and the same rules:
 *
 *   - GET NEVER MUTATES. SafeLinks / Gmail prefetch every GET in an email; the
 *     only mutation is the form POST, which scanners don't submit. Options
 *     with confirm_text render on the landing page as links to their confirm
 *     page instead of direct submit buttons.
 *   - Cache-Control: no-store, X-Robots-Tag noindex on every response (the
 *     bearer token is in the path). routes/pageLanding.js serves /c/ on the
 *     landing host only (C_ROUTE_RE / C_VALUE_RE / C_POST_RE).
 *   - Limiters are WIRED (unlike /d/ before the 2026-10-07 R6 patch, where the
 *     POST bucket was declared and never called for seven weeks):
 *       reads   30/min/IP   GET /c/:token, GET /c/:token/:value
 *       respond 10/min/IP   POST /c/:token/respond
 *       passwords 5 per 15 min per token+IP (§6) — see pwAttempts below
 *     tests/ctaActions.routes.test.js locks each one and was mutation-checked
 *     against removing the guard.
 *
 * PASSWORDS (§6, §8): CTA passwords are mint-set secrets, never YisraCase
 * account passwords. Read from the BODY only (form field or JSON) — never the
 * query string, never logged, never echoed back into a page.
 *
 * CONTENT NEGOTIATION (§5.2): JSON only on an EXPLICIT Accept:
 * application/json that the client prefers over HTML — a browser's
 * "text/html,…,*\/*" and a bare "*\/*" both get HTML.
 *   GET  → ctaService.publicDescriptor (no name, plans, result_template)
 *   POST → { ok, status, execution_id, result? } — result only after a
 *          successful plan whose option has a result_template; plan_result
 *          only for return_plan_result=1 mints (ctaService.respond decides);
 *          a failed plan gets a generic message, never internals.
 *   responded_via: 'link' for the HTML form, 'api' for the JSON surface.
 *
 * PUBLIC STATE: a su-minted link whose minter is no longer an active SU (B1
 * kill switch) reads as 'disabled' everywhere public — the GET pre-checks it
 * so the page never offers buttons the POST would refuse, and the public
 * never learns WHY a link is off. Same for the §12 link-level refusal
 * (respond code refused — ctaService.linkRefusal), on the GETs and the POST.
 *
 * CLICKER INPUTS (§12, slice S1i): an option that declares inputs renders on
 * the landing page as a link to its confirm page (like a confirm_text
 * option); the confirm page renders its fields above the confirm button —
 * labels and hints ESCAPED, enum as a <select>, the SU's own hint (decl.hint)
 * and the required/maxlen line in .sub-label under the control. Form fields
 * are named in_<name> (flat keys, parser-agnostic); the JSON surface sends
 * `inputs: {name: value}`. A rejected submission re-renders the confirm page
 * with per-field errors and the ENTERED values echoed back escaped (the
 * password never is). Client attributes (required, maxlength, input types)
 * are UX only — ctaService is the gate. The JSON
 * descriptor carries each option's declarations (ctaService.publicDescriptor).
 */

'use strict';

const express = require('express');
const router = express.Router();
const ctaService = require('../services/ctaService');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');

const readLimited = makeLimiter(60 * 1000, 30);   // GET /c/:token and /:value
const postLimited = makeLimiter(60 * 1000, 10);   // POST /c/:token/respond

// ─────────────────────────────────────────────────────────────────────────────
// Password-attempt limiter (§6: 5 attempts / 15 min / token+IP)
//
// Reserve-then-refund: a slot is TAKEN before ctaService.respond() runs the
// bcrypt compare (so a burst of parallel guesses is capped at 5 in flight —
// a check-then-record counter would let all of them through) and REFUNDED
// unless the outcome was bad_password. Net effect: wrong guesses are capped
// at 5 per window per token+IP; a correct password never spends budget, so a
// repeatable password link (a live lookup an agent polls) keeps working.
// Per-instance memory like every limiter here — the real ceiling is
// 5 × instances (accepted in §6). failed_attempts + the 20/100 alerts in the
// service are the cross-instance record.
// ─────────────────────────────────────────────────────────────────────────────
const PW_WINDOW_MS = 15 * 60 * 1000;
const PW_MAX = 5;

function makeAttemptLimiter(windowMs, max) {
  const buckets = new Map(); // key -> { windowStart, count }
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, b] of buckets) if (b.windowStart < cutoff) buckets.delete(k);
  }, 5 * 60 * 1000).unref();
  return {
    /** true = a slot was reserved; false = over the limit (do not attempt). */
    take(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now - b.windowStart >= windowMs) {
        b = { windowStart: now, count: 0 };
        buckets.set(key, b);
      }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    },
    /** Give a reserved slot back (the attempt was not a wrong password). */
    refund(key) {
      const b = buckets.get(key);
      if (b && b.count > 0) b.count -= 1;
    },
  };
}
const pwAttempts = makeAttemptLimiter(PW_WINDOW_MS, PW_MAX);

const INDIGO = '#312e81';
const GREEN  = '#065f46';
const RED    = '#991b1b';
const GREY   = '#6b7280';

const TOKEN_PATTERN = ':token([A-Za-z0-9_\\-]{10,40})';
const VALUE_PATTERN = ':value([A-Za-z0-9_\\-]{1,64})';

const GENERIC_FAILURE = 'The action could not be completed. Our team has been notified.';

// §12 input fields. These pages load no app stylesheet (landing host), so the
// house label/hint classes are defined here: .input-label (the password
// label's look), .sub-label hints, .cta-field-error per-field errors.
const FIELD_PREFIX = 'in_';
const FIELD_CSS = `
.input-label{display:block;margin:0 0 6px;font-size:13px;font-weight:600;color:#374151}
.sub-label{margin:4px 0 0;font-size:12px;color:#6b7280}
.cta-field{margin:0 0 16px}
.cta-input{display:block;width:100%;max-width:420px;box-sizing:border-box;padding:10px 12px;font-size:15px;
  font-family:inherit;border:1px solid #c7d2fe;border-radius:6px;background:#fff;color:#111827}
textarea.cta-input{min-height:96px;resize:vertical}
.cta-field-error{margin:4px 0 0;font-size:13px;font-weight:600;color:#991b1b}
.cta-field.has-error .cta-input{border-color:#991b1b}`;
const TEXTAREA_OVER = 120;   // a text input longer than this renders as a <textarea>

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deliberately duplicated (self-contained convention — see taskActions.js). */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtFirmTime(dt) {
  const { DateTime } = require('luxon');
  const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';
  const d = dt instanceof Date
    ? DateTime.fromJSDate(dt, { zone: 'utc' })
    : DateTime.fromISO(String(dt), { zone: 'utc' });
  return d.isValid ? d.setZone(FIRM_TZ).toFormat("MMM d, yyyy 'at' h:mm a ZZZZ") : '';
}

/** JSON only on an explicit, preferred Accept: application/json (§5.2). */
function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  return /\bapplication\/json\b/i.test(accept) && req.accepts(['html', 'json']) === 'json';
}

/** Every /c/ response, before anything else (429s and errors included). */
function baseHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.vary('Accept');
}

/**
 * deriveState + the B1 kill switch + the §12 link-level refusal
 * (ctaService.linkRefusal — a binding closed or retyped since mint, or a
 * repeatable open-recipient link without max_uses), as the public sees it:
 * 'disabled', never why. respond() runs the same checks, so the page never
 * offers a button the POST would refuse. A refusal raises one deduplicated
 * IT warning (system_alerts) — observability only; no link state changes.
 */
async function publicState(db, row) {
  const s = ctaService.deriveState(row);
  if (s !== 'active') return s;
  if (!(await ctaService.minterAllowed(db, row))) return 'disabled';
  if (await ctaService.linkBlocked(db, row)) return 'disabled';
  return 'active';
}

function descriptor(row, state) {
  return { ...ctaService.publicDescriptor(row), status: state };
}

/** respond() codes → what the public sees (never WHY a link is off). */
function publicCode(code) {
  return code === 'minter_inactive' || code === 'refused' ? 'disabled' : code;
}

const STATE_CODES = new Set(['used', 'disabled', 'cancelled', 'expired', 'exhausted']);

const JSON_MESSAGES = {
  not_found: 'This link is invalid or no longer exists.',
  used: 'This link has already been used.',
  disabled: 'This link is currently unavailable.',
  cancelled: 'This link has been withdrawn.',
  expired: 'This link has expired.',
  exhausted: 'This link has reached its maximum number of uses.',
  unknown_option: 'That option is not part of this link.',
  password_required: 'A password is required.',
  bad_password: 'That password is not correct.',
  conflict: 'Someone else used this link at the same moment. Please try again.',
  rate_limited: 'Too many requests.',
  too_many_passwords: 'Too many password attempts. Try again in 15 minutes.',
  invalid_inputs: 'Some inputs are not valid — see errors.',
  error: 'Something went wrong. Please try again in a moment.',
};

function jsonError(res, status, code) {
  return res.status(status).json({ ok: false, code, message: JSON_MESSAGES[code] || JSON_MESSAGES.error });
}

/** Page shell — the decisions/task action-page family (indigo header card). */
function pageWrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${htmlEscape(title)}</title>
<style>${FIELD_CSS}</style>
</head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:94%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${INDIGO};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">YisraCase — Action</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="background:#f8f7ff;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">
            YisraCase action link.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** cta_links.prompt is ESCAPED text — context_html is the only raw-HTML slot. */
function promptBlock(row, color = INDIGO) {
  const html = htmlEscape(row.prompt).replace(/\r?\n/g, '<br>');
  return `
    <div style="margin:0 0 18px;padding:14px 16px;background:#f5f3ff;border-left:3px solid ${color};
                border-radius:4px;font-size:15px;color:#111827;line-height:1.6;font-weight:600">
      ${html}
    </div>`;
}

/** cta_links.context_html, rendered RAW — trusted SU/workflow-authored HTML,
 *  the decision_requests.context_html contract. Shown on the actionable pages
 *  only; terminal pages (a used/withdrawn link) stop displaying it. */
function contextBlock(row) {
  const ctx = row && row.context_html;
  if (ctx == null || String(ctx).trim() === '') return '';
  return `
    <div style="margin:0 0 18px;padding:14px 16px;background:#fafafa;border:1px solid #e5e7eb;
                border-radius:4px;font-size:14px;color:#111827;line-height:1.5">
      ${ctx}
    </div>`;
}

function errorBanner(msg) {
  if (!msg) return '';
  return `
    <div role="alert" style="margin:0 0 18px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;
                border-radius:4px;font-size:14px;color:${RED};font-weight:600">
      ${htmlEscape(msg)}
    </div>`;
}

/** The password field — never pre-filled, never echoed. */
function passwordField(row) {
  if (row.protection !== 'password') return '';
  return `
        <label style="display:block;margin:0 0 6px;font-size:13px;font-weight:600;color:#374151"
               for="cta-password">Password</label>
        <input id="cta-password" type="password" name="password" required autocomplete="off"
               style="display:block;width:100%;max-width:320px;box-sizing:border-box;padding:10px 12px;
                      margin:0 0 16px;font-size:15px;border:1px solid #c7d2fe;border-radius:6px">`;
}

function expiryNote(row) {
  const when = fmtFirmTime(row.expires_at);
  const timeout = row.mode === 'once' && row.timeout_option
    ? ' If there is no response by then, a default action runs automatically.'
    : '';
  return `This link expires ${htmlEscape(when)}.${timeout}`;
}

function optionByValue(row, value) {
  return (row.options || []).find((o) => o && o.value === value) || null;
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** §12: does this option ask the clicker for anything? */
function hasInputs(opt) {
  return !!opt && Array.isArray(opt.inputs) && opt.inputs.length > 0;
}

/**
 * The clicker's inputs from the body: a JSON (or qs) `inputs` object when
 * present, else the form's flat in_<name> fields. Null-prototype map — a
 * field named in___proto__ is just an unknown key, never a prototype write.
 * undefined when the body carries neither. Shape is ctaService's to judge.
 */
function submittedInputs(body) {
  if (hasOwn(body, 'inputs')) return body.inputs;
  let out;
  for (const k of Object.keys(body)) {
    if (!k.startsWith(FIELD_PREFIX)) continue;
    if (!out) out = Object.create(null);
    out[k.slice(FIELD_PREFIX.length)] = body[k];
  }
  return out;
}

/** What to echo back into the re-rendered fields: string values only (escaped at render). */
function echoValues(inputs) {
  const out = Object.create(null);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return out;
  for (const k of Object.keys(inputs)) {
    const v = inputs[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

const LENGTH_HINT_TYPES = new Set(['text', 'html', 'email', 'number']);

const TYPE_HINT = {
  phone: 'Phone number',
  email: 'Email address',
  number: 'Number',
  date: 'Date (YYYY-MM-DD)',
};

/**
 * One declared input as a labelled control. Everything authored or entered
 * is escaped — labels, choices, defaults and echoed values alike.
 */
function inputField(d, values, errors) {
  const id = `cta-in-${d.name}`;
  const name = `${FIELD_PREFIX}${d.name}`;
  const err = errors && hasOwn(errors, d.name) ? errors[d.name] : null;
  let val = '';
  if (values && hasOwn(values, d.name)) val = values[d.name];
  else if (hasOwn(d, 'default')) val = String(d.default);
  const req = d.required ? ' required' : '';
  // The SU's own help text (decl.hint) sits right under the control, ahead of
  // the generated Required/type/length line; both describe the field.
  const help = hasOwn(d, 'hint') && d.hint ? d.hint : null;
  const describedBy = help ? `${id}-help ${id}-hint` : `${id}-hint`;
  const aria = ` aria-describedby="${htmlEscape(describedBy)}"${err ? ' aria-invalid="true"' : ''}`;
  const common = `id="${htmlEscape(id)}" name="${htmlEscape(name)}" class="cta-input"${req}${aria}`;

  let control;
  if (d.type === 'enum') {
    const blank = !d.required || !hasOwn(d, 'default') || val === ''
      ? `<option value=""${val === '' ? ' selected' : ''}>${d.required ? 'Choose…' : '(none)'}</option>`
      : '';
    const opts = (d.choices || []).map((c) =>
      `<option value="${htmlEscape(c)}"${c === val ? ' selected' : ''}>${htmlEscape(c)}</option>`).join('');
    control = `<select ${common}>${blank}${opts}</select>`;
  } else if (d.type === 'html' || (d.type === 'text' && d.maxlen > TEXTAREA_OVER)) {
    control = `<textarea ${common} maxlength="${d.maxlen}" rows="4">${htmlEscape(val)}</textarea>`;
  } else {
    const attrs = {
      text: `type="text" maxlength="${d.maxlen}"`,
      phone: 'type="tel" autocomplete="tel" inputmode="tel"',
      email: 'type="email" autocomplete="email"',
      number: 'type="text" inputmode="decimal"',
      date: 'type="date"',
    }[d.type] || 'type="text"';
    control = `<input ${attrs} ${common} value="${htmlEscape(val)}">`;
  }

  // A length hint only where the clicker controls the length — a phone or
  // date is checked on its normalized form, so "up to 16" would mislead.
  const hint = [d.required ? 'Required' : 'Optional', TYPE_HINT[d.type]]
    .concat(LENGTH_HINT_TYPES.has(d.type) ? [`up to ${d.maxlen} characters`] : [])
    .filter(Boolean).join(' · ');
  return `
        <div class="cta-field${err ? ' has-error' : ''}">
          <label class="input-label" for="${htmlEscape(id)}">${htmlEscape(d.label)}</label>
          ${control}${help ? `
          <div class="sub-label" id="${htmlEscape(id)}-help">${htmlEscape(help)}</div>` : ''}
          <div class="sub-label" id="${htmlEscape(id)}-hint">${htmlEscape(hint)}</div>${err ? `
          <div class="cta-field-error" role="alert">${htmlEscape(err)}</div>` : ''}
        </div>`;
}

function inputFields(opt, values, errors) {
  if (!hasInputs(opt)) return '';
  return opt.inputs.map((d) => inputField(d, values, errors)).join('');
}

function notFoundPage() {
  return pageWrap('Link Not Valid', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Link not valid</h2>
    <p style="margin:0;font-size:14px;color:#374151">
      This link is invalid or no longer exists.
    </p>`);
}

const TERMINAL = {
  used:      ['Already Used',        'Already used',        'This link has already been used.'],
  exhausted: ['Use Limit Reached',   'Use limit reached',   'This link has reached its maximum number of uses.'],
  disabled:  ['Link Unavailable',    'Link unavailable',    'This link is currently unavailable.'],
  cancelled: ['No Longer Available', 'No longer available', 'This link has been withdrawn and can no longer be used.'],
};

/** Terminal page for a non-active public state. Prompt shown; context_html is not. */
function terminalPage(row, state) {
  if (state === 'expired') {
    return pageWrap('Link Expired', `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Link expired</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">
      This link expired ${htmlEscape(fmtFirmTime(row.expires_at))} and can no longer be used.
    </p>
    ${promptBlock(row, GREY)}`);
  }
  const [title, heading, text] = TERMINAL[state] || TERMINAL.disabled;
  return pageWrap(title, `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">${heading}</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">${text}</p>
    ${promptBlock(row, GREY)}`);
}

function landingPage(row) {
  const base = `/c/${row.token}`;  // relative: follows the serving host
  const btnStyle = `background:${INDIGO};color:#ffffff;border:none;border-radius:6px;
                     padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;
                     margin:0 10px 10px 0;display:inline-block;text-decoration:none`;
  // Options with confirm_text — or declared inputs (§12), whose fields live
  // on the confirm page — go through their confirm page (a GET link); the
  // rest submit directly — the landing form IS a deliberate human click.
  const buttons = row.options.map((o) => (o.confirm_text || hasInputs(o)
    ? `
        <a href="${base}/${htmlEscape(o.value)}" style="${btnStyle}">${htmlEscape(o.label)}</a>`
    : `
        <button type="submit" name="value" value="${htmlEscape(o.value)}" style="${btnStyle}">
          ${htmlEscape(o.label)}
        </button>`)).join('');
  // With a password field, Enter would implicitly submit the FIRST submit
  // button — i.e. silently pick option 1. A disabled default button makes
  // implicit submission a no-op (HTML spec), so only a click chooses.
  const enterGuard = row.protection === 'password'
    ? `
        <button type="submit" disabled aria-hidden="true" tabindex="-1" style="display:none"></button>`
    : '';
  return pageWrap('Action requested', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Your response is requested</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        Review the request below and choose a response.
      </p>
      ${promptBlock(row)}
      ${contextBlock(row)}
      <form method="POST" action="${base}/respond" style="margin:20px 0 0">${enterGuard}
        ${passwordField(row)}
        ${buttons}
      </form>
      <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">${expiryNote(row)}</p>`);
}

/**
 * values/fieldErrors (§12): a re-render after a rejected POST echoes what was
 * ENTERED (escaped) with per-field errors; a fresh GET pre-fills defaults.
 */
function confirmPage(row, opt, { error = null, values = null, fieldErrors = null } = {}) {
  const base = `/c/${row.token}`;  // relative: follows the serving host
  const confirmText = opt.confirm_text
    ? `
      <div style="margin:0 0 18px;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;
                  border-radius:4px;font-size:14px;color:#78350f;line-height:1.5">
        ${htmlEscape(opt.confirm_text).replace(/\r?\n/g, '<br>')}
      </div>`
    : '';
  return pageWrap('Confirm your response', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Confirm your response</h2>
      ${errorBanner(error)}
      ${promptBlock(row)}
      ${contextBlock(row)}
      <p style="margin:0 0 18px;font-size:15px;color:#374151">
        You selected: <strong style="color:${INDIGO};font-size:16px">${htmlEscape(opt.label)}</strong>
      </p>
      ${confirmText}
      <form method="POST" action="${base}/respond" style="margin:0">
        <input type="hidden" name="value" value="${htmlEscape(opt.value)}">${inputFields(opt, values, fieldErrors)}
        ${passwordField(row)}
        <button type="submit"
                style="background:#059669;color:#ffffff;border:none;border-radius:6px;
                       padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer">
          ✓ Confirm: ${htmlEscape(opt.label)}
        </button>
        <a href="${base}"
           style="display:inline-block;margin-left:12px;color:${GREY};font-size:14px;
                  text-decoration:underline">Choose a different option</a>
      </form>
      <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">
        Nothing happens until you confirm. ${expiryNote(row)}
      </p>`);
}

function successPage(row, opt, out) {
  const again = row.mode === 'repeatable'
    ? `
      <p style="margin:14px 0 0;font-size:14px">
        <a href="/c/${row.token}" style="color:#4f46e5">Back to the options</a>
      </p>`
    : '';
  const result = out.result_html != null
    ? `
      <div style="margin:0 0 18px;padding:14px 16px;background:#ecfdf5;border:1px solid #a7f3d0;
                  border-radius:4px;font-size:15px;color:#064e3b;line-height:1.6">
        ${out.result_html}
      </div>`
    : '';
  return pageWrap('Done', `
      <h2 style="margin:0 0 8px;font-size:22px;color:${GREEN}">✓ Done</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">Your response has been received.</p>
      ${promptBlock(row, GREEN)}
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        You chose: <strong style="color:${GREEN}">${htmlEscape(opt.label)}</strong>
      </p>
      ${result}
      <p style="margin:0;font-size:12px;color:#9ca3af">Reference #${htmlEscape(out.execution_id)}</p>${again}`);
}

/** Generic by contract (B5): no step names, no error text, no plan internals. */
function failurePage(executionId) {
  return pageWrap('Not Completed', `
      <h2 style="margin:0 0 8px;font-size:22px;color:${RED}">We couldn't complete that</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        Your response was received, but the action could not be completed. Our team has been notified.
      </p>
      <p style="margin:0;font-size:12px;color:#9ca3af">Reference #${htmlEscape(executionId)}</p>`);
}

function messagePage(title, heading, text, row) {
  return pageWrap(title, `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">${heading}</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        ${text}
        ${row ? `<a href="/c/${row.token}" style="color:#4f46e5">Back to the options.</a>` : ''}
      </p>`);
}

function errorPage() {
  return pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">Please try the link again in a moment.</p>`);
}

function tooMany(res, json) {
  if (json) return jsonError(res, 429, 'rate_limited');
  return res.status(429).type('text/plain').send('Too many requests');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /c/:token — landing page (all options) | JSON descriptor
// ─────────────────────────────────────────────────────────────────────────────

router.get(`/c/${TOKEN_PATTERN}`, async (req, res) => {
  baseHeaders(res);
  const json = wantsJson(req);
  if (readLimited(getClientIp(req))) return tooMany(res, json);
  try {
    const row = await ctaService.getCtaByToken(req.db, req.params.token);
    if (!row) return json ? jsonError(res, 404, 'not_found') : res.status(200).send(notFoundPage());

    const state = await publicState(req.db, row);
    if (json) return res.json(descriptor(row, state));
    if (state !== 'active') return res.send(terminalPage(row, state));
    res.send(landingPage(row));
  } catch (err) {
    console.error('GET /c/:token error:', err.message);
    if (json) return jsonError(res, 500, 'error');
    res.status(500).send(errorPage());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /c/:token/:value — pre-selected confirm page (still zero mutation)
// ─────────────────────────────────────────────────────────────────────────────

router.get(`/c/${TOKEN_PATTERN}/${VALUE_PATTERN}`, async (req, res) => {
  baseHeaders(res);
  const json = wantsJson(req);
  if (readLimited(getClientIp(req))) return tooMany(res, json);
  try {
    const row = await ctaService.getCtaByToken(req.db, req.params.token);
    if (!row) return json ? jsonError(res, 404, 'not_found') : res.status(200).send(notFoundPage());

    const opt = optionByValue(row, req.params.value);
    // Unknown value (incl. the reserved "respond" — never an option) → the
    // landing page, which lists what IS available. Relative: follows the host.
    if (!opt) return res.redirect(302, `/c/${row.token}`);

    const state = await publicState(req.db, row);
    if (json) {
      const d = descriptor(row, state);
      // the descriptor's own entry for this option — {value, label} plus its
      // input declarations when it has any (§12)
      return res.json({ ...d, selected: d.options.find((o) => o.value === opt.value) });
    }
    if (state !== 'active') return res.send(terminalPage(row, state));
    res.send(confirmPage(row, opt));
  } catch (err) {
    console.error('GET /c/:token/:value error:', err.message);
    if (json) return jsonError(res, 500, 'error');
    res.status(500).send(errorPage());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /c/:token/respond — run the chosen option
// ─────────────────────────────────────────────────────────────────────────────

router.post(`/c/${TOKEN_PATTERN}/respond`, async (req, res) => {
  baseHeaders(res);
  const json = wantsJson(req);
  const ip = getClientIp(req);
  if (postLimited(ip)) return tooMany(res, json);

  const db = req.db;
  let pwKey = null;          // a reserved password-attempt slot…
  let spent = false;         // …kept only when the password was wrong
  try {
    const row = await ctaService.getCtaByToken(db, req.params.token);
    if (!row) return json ? jsonError(res, 404, 'not_found') : res.status(200).send(notFoundPage());

    // BODY ONLY (form field or JSON) — a ?password= query string is ignored by
    // construction, and nothing below logs or echoes either field.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const inputs = submittedInputs(body);

    if (row.protection === 'password' && password !== '') {
      const key = `${row.token}|${ip}`;
      if (!pwAttempts.take(key)) {
        if (json) return jsonError(res, 429, 'too_many_passwords');
        return res.status(429).send(messagePage('Too Many Attempts', 'Too many password attempts',
          'Too many incorrect passwords were entered for this link. Try again in 15 minutes.', null));
      }
      pwKey = key;
    }

    const out = await ctaService.respond(db, {
      row, value, password, inputs, via: json ? 'api' : 'link', ip,
    });

    if (out.ok) {
      if (json) {
        const body2 = { ok: true, status: out.status, execution_id: out.execution_id };
        if (out.result !== undefined) body2.result = out.result;
        if (out.plan_result !== undefined) body2.plan_result = out.plan_result;   // return_plan_result=1 only (respond decides)
        if (out.status !== 'success') body2.message = GENERIC_FAILURE;
        return res.json(body2);
      }
      if (out.status !== 'success') return res.send(failurePage(out.execution_id));
      return res.send(successPage(row, optionByValue(row, value), out));
    }

    const code = publicCode(out.code);
    if (code === 'bad_password') spent = true;

    if (code === 'invalid_inputs') {
      // Nothing was claimed or counted. Generic per-field messages only.
      if (json) {
        const b = { ok: false, code, message: JSON_MESSAGES.invalid_inputs, errors: out.errors || {} };
        if (out.form_error) b.form_error = out.form_error;
        return res.status(400).json(b);
      }
      return res.status(400).send(confirmPage(row, optionByValue(row, value), {
        error: out.form_error || 'Please correct the highlighted fields.',
        values: echoValues(inputs),
        fieldErrors: out.errors,
      }));
    }

    if (json) {
      const status = code === 'not_found' ? 404
        : code === 'unknown_option' ? 400
          : code === 'password_required' ? 401
            : code === 'bad_password' ? 403
              : 409;   // used / disabled / cancelled / expired / exhausted / conflict
      return jsonError(res, status, code);
    }

    if (code === 'not_found') return res.status(200).send(notFoundPage());
    if (STATE_CODES.has(code)) return res.send(terminalPage(row, code));
    if (code === 'unknown_option') {
      return res.send(messagePage('Invalid Option', 'Invalid option', "That option isn't part of this link.", row));
    }
    if (code === 'password_required' || code === 'bad_password') {
      const opt = optionByValue(row, value);   // respond() checked the option before the password
      return res.status(code === 'bad_password' ? 403 : 401).send(confirmPage(row, opt, {
        error: code === 'bad_password' ? 'That password is not correct.' : 'Enter the password to continue.',
        values: echoValues(inputs),   // keep what they typed; the password itself is never echoed
      }));
    }
    // conflict: lost a same-instant race while the link stayed active
    return res.status(409).send(messagePage('Please Try Again', 'Please try again',
      'Someone else used this link at the same moment.', row));
  } catch (err) {
    // err.message only — never req.body (it may carry the password).
    console.error('POST /c/:token/respond error:', err.message);
    if (json) return jsonError(res, 500, 'error');
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">
        Your response may not have been recorded. Please try again from the link.
      </p>`));
  } finally {
    if (pwKey && !spent) pwAttempts.refund(pwKey);
  }
});

module.exports = router;
