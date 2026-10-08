// services/ctaService.js
//
/**
 * CTA (Call To Action) service — substrate (CTA arc, slice S1).
 *
 * Spec (canonical): ref/CTA_DESIGN.md. Schema: ref/migrations/2026-10-07_cta.sql.
 *
 * A CTA is a tokenized link (or set of option buttons) that executes a
 * PRE-AUTHORIZED action plan when the recipient agrees. Each option carries
 * a plan of internal-function calls with params frozen at mint. This module
 * owns everything below the HTTP surface:
 *
 *   mintCta(db, input)          validation (layered eligibility, params,
 *                               result_template refs, password rules) + insert
 *   respond(db, {...})          the click path: state checks → SU check (su
 *                               mints) → password (BEFORE the claim) → claim
 *                               or guarded increment → plan run
 *   patchCta(db, id, patch)     expiry / max_uses / status transitions
 *   sweepExpired(db)            timeout_option claims + stale-running warnings
 *                               (the cta_expiry_sweep internal function)
 *   publicDescriptor(row)       the agent/JSON descriptor (no name/plans/templates)
 *
 * S2 adds the surfaces (routes/ctaActions.js, routes/api.cta.js) on top of
 * this, plus the SU reads listCtas / listExecutions / adminRow; S3 adds
 * create_cta. Nothing here builds URLs — the public origin is a surface
 * concern (firmConfig.publicUrl), composed in lib/ctaLinks.js.
 *
 * ── INVARIANTS (each one is locked by tests/ctaService.test.js) ────────────
 *
 *  1. The claim SQL is the single arbiter. CLAIM_ONCE_SQL / INCREMENT_SQL /
 *     TIMEOUT_CLAIM_SQL below are §6 verbatim; the JS state checks before them
 *     are only for a friendly early answer. The respond claim's
 *     `expires_at > NOW()` and the timeout claim's `expires_at <= NOW()` are
 *     mutually exclusive on the one DB clock (pool timezone Z, server UTC).
 *  2. Password is verified BEFORE the claim/increment — a wrong password must
 *     never burn a single-use link or a repeatable use.
 *  3. The cta_executions row is inserted 'running' in the SAME transaction as
 *     the claim, before step 1 — a crash mid-plan is visible (the sweep warns
 *     on running rows older than 15 min) and a claimed link always has a row.
 *  4. Plans run as user 0, sequentially; a throw, success === false, an
 *     ineligible function, or the RUNTIME GUARD (a step result carrying
 *     delayed_until / next_step / nextStep) stops the plan → 'failed'.
 *  5. Public surfaces never see plan internals: respond() returns raw
 *     plan_result only when the CTA was minted with return_plan_result=1.
 *     result_template is the curated public output.
 *  6. Timeout executions always log by=0 — never attributed_user_id.
 *  7. CLICKER INPUTS (§12, slice S1i). An option may declare `inputs`; a plan
 *     param whose WHOLE top-level value is "[[input:name]]" is a binding, and
 *     only into a param its function opens via __meta.ctaInputParams. Values
 *     are validated twice server-side — each input (type → normalize → maxlen
 *     → pattern, the pattern on V8's LINEAR-TIME engine only — see
 *     LINEAR_RE), then __validateFunctionParams on the substituted step — at
 *     mint (defaults or samples) and at click. At click the pipeline runs
 *     AFTER the password check (no unauthenticated caller reaches a pattern)
 *     and BEFORE the claim (a bad value never burns a use). A non-html input
 *     bound into a param marked html:true is HTML-escaped + nl2br at
 *     substitution; only a declared type:'html' input passes raw, and only
 *     behind the raw_html_input acknowledgment.
 *  8. Policy (§12): inputs default protection to 'password'; risk codes
 *     (CTA_RISKS) fail the mint closed unless listed in accept_risks; a
 *     repeatable link with a kind:'recipient' binding MUST set max_uses (hard
 *     rule, not acknowledgeable — PATCH can't remove the cap either, and
 *     linkRefusal refuses a link that lost it some other way); timeout_option
 *     needs a default on every input of that option (the sweep has no clicker).
 *
 * Standing rule (R3): cta_links / cta_executions never enter
 * QUERY_DB_ALLOWED_TABLES or WRITE_POLICY.
 */

'use strict';

const bcrypt = require('bcrypt');
const ms = require('ms');
const { generateToken } = require('../lib/token');

// lazy require (circular dep safety): lib/internal_functions/cta.js requires
// this module, and the registry's index.js requires every category file at
// load — a module-scope require here would hand back a half-built registry.
function registry() {
  return require('../lib/internal_functions');
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry functions a CTA plan may never call, on top of the predicate in
 * isCtaEligible(). Additions are exposure decisions: tests/ctaService.test.js
 * snapshots the eligible set.
 *
 *   wait_until_time           the one flagless function that returns
 *                             delayed_until (§4.2) — its flaglessness is
 *                             deliberate (controlFlow would route it through
 *                             controlTarget normalization and the runaway-loop
 *                             guard), so it is denied by name here instead.
 *   cta_expiry_sweep          internal plumbing (S2 ruling, 2026-10-07): a
 *   decision_timeout_cleanup  public link must never drive the job that runs
 *                             OTHER links' timeout plans, nor close a
 *                             workflow's pending decision out from under it.
 *   set_test_var              dev-only (S2 ruling): no business on a public link.
 */
const CTA_FN_DENYLIST = Object.freeze([
  'wait_until_time',
  'cta_expiry_sweep',
  'decision_timeout_cleanup',
  'set_test_var',
  // S3: create_cta needs a live workflow execution (_execution_id) that a
  // public link can never supply — and links minting links is bearer-token
  // recursion with no owner in the loop.
  'create_cta',
]);

/** Chromium-backed functions: eligible, but a public repeatable link fans out load. */
const CHROMIUM_FNS = new Set(['render_submission_pdf', 'document_generate_from_template']);

const VALUE_RE = /^[a-zA-Z0-9_\-]{1,64}$/;     // option values ride in URL path segments
const RESERVED_VALUES = new Set(['respond']);   // POST /c/:token/respond
const PLACEHOLDER_RE = /{{([^}]+)}}/;           // workflow_engine.resolvePlaceholders' own pattern
const RESULT_TOKEN_RE = /\[\[([^\]]*)\]\]/g;    // decisions' [[...]] convention
const RESULT_REF_RE = /^(\d+)\.output((?:\.[A-Za-z0-9_\-]+)*)$/;

const MAX_OPTIONS = 10;
const MAX_PLAN_STEPS = 20;
const MAX_NAME = 120;
const MAX_PROMPT = 2000;            // mirrors request_decision.question
const MAX_CONTEXT_HTML = 200000;    // mirrors request_decision.context_html
const MAX_LABEL = 100;
const MAX_CONFIRM_TEXT = 500;
const MAX_RESULT_TEMPLATE = 5000;
const MAX_EXPIRY_MS = ms('365d');

const BCRYPT_ROUNDS = 12;
const MIN_SUPPLIED_PASSWORD = 12;   // NB2: SU-supplied secrets ≥12 chars
const MAX_PASSWORD_BYTES = 72;      // bcrypt ignores everything past 72 bytes

const STEP_OUTPUT_MAX = 2000;       // plan_result truncation, per step
const STALE_RUNNING_MINUTES = 15;
const STALE_FINALIZE_ERROR =
  `finalized as failed by an SU re-enable: still running over ${STALE_RUNNING_MINUTES} min — the instance likely died ` +
  'mid-plan; side effects of any steps that ran are unknown';
const PW_WARN_AT = 20;              // warning (records only)
const PW_ERROR_AT = 100;            // error (emails IT)
const DEFAULT_SWEEP_LIMIT = 50;

const SETTING_TIMEOUT = {
  once: 'cta_default_timeout_once',
  repeatable: 'cta_default_timeout_repeatable',
};
const FALLBACK_TIMEOUT = { once: '3d', repeatable: '30d' };

const VIA_VALUES = new Set(['link', 'app', 'api']); // 'timeout' is the sweep's alone

const MINT_KEYS = new Set([
  'name', 'prompt', 'context_html', 'options', 'mode', 'max_uses',
  'expires_at', 'timeout', 'timeout_option', 'protection', 'password',
  'return_plan_result', 'attributed_user_id', 'link_type', 'link_id',
  'mint_source', 'source_execution_id', 'minted_by', 'dry_run',
  'accept_risks',
]);
const OPTION_KEYS = new Set(['value', 'label', 'plan', 'confirm_text', 'result_template', 'inputs']);
const STEP_KEYS = new Set(['fn', 'params']);
const PATCH_KEYS = new Set(['expires_at', 'max_uses', 'status']);

// ─── §6 claim SQL — VERBATIM. tests/ctaService.test.js locks the text. ──────
const CLAIM_ONCE_SQL =
`UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW()`;

const INCREMENT_SQL =
`UPDATE cta_links SET uses_count = uses_count + 1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW()
   AND (max_uses IS NULL OR uses_count < max_uses)`;

const TIMEOUT_CLAIM_SQL =
`UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND mode='once' AND uses_count=0
   AND timeout_option IS NOT NULL AND expires_at <= NOW()`;

// ─── §12 clicker inputs ─────────────────────────────────────────────────────
const INPUT_TYPES = Object.freeze(['text', 'phone', 'email', 'number', 'enum', 'date', 'html']);
const INPUT_KEYS = new Set(['name', 'label', 'type', 'required', 'default', 'maxlen', 'pattern', 'choices']);
const INPUT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;   // the result_var rule (decisions.js VAR_RE)
// Names that would hit Object.prototype machinery wherever a plain object is
// keyed by input name (a qs-parsed body, an author's spread). Every map here
// is null-prototype anyway; this is the belt to that braces.
const RESERVED_INPUT_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_INPUTS = 10;              // per option
const MAX_INPUT_LABEL = 100;
const MAX_INPUT_LEN = 1000;         // maxlen server cap (§12)
const MAX_RAW_INPUT = 4 * MAX_INPUT_LEN;   // pre-normalization guard; maxlen is checked on the NORMALIZED value
const MAX_PATTERN = 100;
const MAX_CHOICES = 20;
const BINDING_RE = /^\[\[input:([^\]]*)\]\]$/;   // a WHOLE param value — Ruling 5, no splicing
const BINDING_MARK = '[[input:';
const INPUT_REF_RE = /^input:([a-zA-Z_][a-zA-Z0-9_]{0,63})$/;   // result_template [[input:x]]
// One address, nothing a mailer could read as a second recipient or a header
// break — same character class as routes/api.cta.js (send) EMAIL_RE.
const INPUT_EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const MAX_NUMBER_DIGITS = 15;       // significant digits a double round-trips exactly
const EMAIL_INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0 controls except \t and \n (CR is normalized away first), plus DEL.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const OPENED_KINDS = new Set(['recipient', 'content']);
// A kind:'recipient' binding takes only a type whose pipeline guarantees ONE
// recipient. A text input into send_email.to would carry "a@x, b@y, …" — one
// use, many recipients — and quietly defeat the max_uses hard rule.
const RECIPIENT_TYPES = new Set(['phone', 'email']);

/** Normalized-width floors: a smaller maxlen could never accept a value. */
const MIN_MAXLEN = Object.freeze({ phone: 12, date: 10 });
const MIN_MAXLEN_WHY = Object.freeze({ phone: '+1 and 10 digits', date: 'YYYY-MM-DD' });

/** Mint-time stand-ins when an input has no default (validator pass only — never stored). */
const INPUT_SAMPLES = Object.freeze({
  text: 'sample text', phone: '+12485550100', email: 'sample@example.com',
  number: '1', date: '2000-01-01', html: '<p>sample</p>',
});

/**
 * Acknowledge-to-proceed risk codes (§12 Policy). A mint that triggers one
 * fails closed (400 risk_acceptance_required) unless accept_risks lists it;
 * accepted codes land in the receipt and the admin_audit_log row. The pane
 * renders these descriptions as its checkbox text.
 */
const CTA_RISKS = Object.freeze({
  open_recipient_repeatable:
    'A clicker-supplied recipient on a repeatable link: whoever holds the link can send from the firm\'s ' +
    'identity to any address or number they choose, once per use, until max_uses or expiry.',
  raw_html_input:
    'A type:"html" input passes the clicker\'s markup into the plan unescaped — they can author HTML that is ' +
    'sent or stored under the firm\'s identity.',
});

/** Clicker-facing input errors — generic by contract: never plan internals, never the pattern. */
const INPUT_MSG = Object.freeze({
  required: 'This field is required.',
  type: 'Enter a text value.',
  chars: 'This contains characters that are not allowed.',
  phone: 'Enter a valid phone number.',
  email: 'Enter a single valid email address.',
  number: 'Enter a number.',
  enum: 'Choose one of the listed options.',
  date: 'Enter a date as YYYY-MM-DD.',
  pattern: 'This is not in the expected format.',
  unknown: 'Unknown field.',
  rejected: "This value can't be used for this action.",
  unavailable: "This field can't be checked right now — please try again later.",
});
const tooLongMsg = (n) => `Use at most ${n} characters.`;

// cta_executions INSERTs. The inputs column is named ONLY when an option
// declared inputs, so the click path of an input-less link (every link minted
// before §12 — WF27's live not-spam button included) never depends on the
// 2026-10-08 migration having run.
const EXEC_INSERT_SQL =
`INSERT INTO cta_executions
   (cta_id, option_value, status, responded_via, responder_user_id, responder_ip)
 VALUES (?, ?, 'running', ?, ?, ?)`;
const EXEC_INSERT_INPUTS_SQL =
`INSERT INTO cta_executions
   (cta_id, option_value, status, responded_via, responder_user_id, responder_ip, inputs)
 VALUES (?, ?, 'running', ?, ?, ?, ?)`;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

class CtaError extends Error {
  /** status: HTTP-ish (400 bad input, 404 missing, 409 state conflict). */
  constructor(status, message, code) {
    super(message);
    this.name = 'CtaError';
    this.status = status;
    this.code = code || (status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid');
  }
}
const bad = (msg) => new CtaError(400, `cta: ${msg}`);

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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function rejectUnknownKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw bad(`${label}: unknown field "${k}"`);
  }
}

function posInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** First path inside `v` holding a {{...}} string, or null. Keys are not resolved by the engine, so only values are checked. */
function findPlaceholder(v, path) {
  if (typeof v === 'string') return PLACEHOLDER_RE.test(v) ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = findPlaceholder(v[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = findPlaceholder(x, `${path}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

function parseJsonCol(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return dflt; }
  }
  return v;
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Serialize a step output for plan_result, truncated to ~2k chars. */
function truncateOutput(value) {
  if (value === undefined) return null;
  let s;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  if (s === undefined) return null;
  if (s.length <= STEP_OUTPUT_MAX) return value;
  return `${s.slice(0, STEP_OUTPUT_MAX)}…[truncated ${s.length - STEP_OUTPUT_MAX} chars]`;
}

function truncateText(s, n = STEP_OUTPUT_MAX) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function alertSafe(opts, db) {
  try {
    const { alert } = require('../lib/alerting'); // deferred require (circular-dep safety convention)
    return Promise.resolve(alert(db, opts)).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility (§4 — layered; B2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Layer 1 (predicate) + layer 2 (denylist). Layer 3 is the runtime guard in
 * runPlan(), layer 4 is per-step param validation at mint, layer 5 is the
 * eligible-set snapshot in tests/ctaService.test.js.
 *
 * Predicate: the UI-picker rule (typeof function && __meta && not __-prefixed;
 * lib/internal_functions/db.js comment above __WRITE_POLICY), plus
 * `__meta.controlFlow !== true` — control functions (set_next,
 * evaluate_condition, foreach, request_decision, wait_for, schedule_resume)
 * are engine-coupled by definition; excluding them is what makes
 * wait_until_time "the one accepted function returning delayed_until" (§4.2).
 * `workflowOnly` and `uiHidden` are NOT filters (§4.6 — start_workflow
 * carries workflowOnly only to stay out of the sequence picker).
 *
 * Own-property lookup: plan JSON is untrusted shape, and a name like
 * "constructor" must never resolve through the prototype chain.
 */
function isCtaEligible(name, reg = registry()) {
  if (typeof name !== 'string' || name === '' || name.startsWith('__')) return false;
  if (!hasOwn(reg, name)) return false;
  const fn = reg[name];
  if (typeof fn !== 'function' || !fn.__meta) return false;
  if (fn.__meta.controlFlow === true) return false;
  if (CTA_FN_DENYLIST.includes(name)) return false;
  return true;
}

/** Sorted list of every CTA-eligible registry function. */
function eligibleFunctionNames(reg = registry()) {
  return Object.keys(reg).filter((k) => isCtaEligible(k, reg)).sort();
}

function _ineligibleReason(name, reg) {
  if (typeof name !== 'string' || !name) return 'fn is required';
  if (name.startsWith('__') || !hasOwn(reg, name) || typeof reg[name] !== 'function') {
    return `unknown function "${name}"`;
  }
  if (!reg[name].__meta) return `function "${name}" has no metadata`;
  if (reg[name].__meta.controlFlow === true) return `"${name}" is a workflow control function`;
  if (CTA_FN_DENYLIST.includes(name)) return `"${name}" is denied for CTA plans`;
  return `"${name}" is not CTA-eligible`;
}

// ─────────────────────────────────────────────────────────────────────────────
// result_template (§4 — B5b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint-time check: every [[...]] token must be [[N.output(.path)*]] with
 * 1 ≤ N ≤ plan length. Unknown steps throw, mirroring request_decision's
 * [[respond_url:X]] rule — a template pointing at nothing must fail loudly
 * at mint, not render blank to a recipient.
 */
function validateResultTemplate(tpl, planLength, label, inputNames = null) {
  let m;
  RESULT_TOKEN_RE.lastIndex = 0;
  while ((m = RESULT_TOKEN_RE.exec(tpl)) !== null) {
    // §12: [[input:x]] echoes the clicker's (normalized) value — escaped like
    // every other template output. Must name an input of THIS option.
    const inp = INPUT_REF_RE.exec(m[1]);
    if (inp) {
      if (!inputNames || !inputNames.has(inp[1])) {
        throw bad(`${label}.result_template references [[input:${inp[1]}]] — no such input is declared on this option`);
      }
      continue;
    }
    const ref = RESULT_REF_RE.exec(m[1]);
    if (!ref) {
      throw bad(`${label}.result_template: unsupported token [[${m[1]}]] — use [[N.output]], [[N.output.path]] or [[input:name]]`);
    }
    const n = Number(ref[1]);
    if (n < 1 || n > planLength) {
      throw bad(`${label}.result_template references unknown step ${n} in [[${m[1]}]] (plan has ${planLength} step${planLength === 1 ? '' : 's'})`);
    }
  }
}

/**
 * Render a result_template against the FULL (untruncated) step outputs of a
 * successful plan. Returns { text, html }: the template is TEXT, not HTML —
 * `html` escapes the whole rendered string (literal + values) and turns
 * newlines into <br>; `text` is for the JSON surface. Missing paths render
 * ''; objects render as JSON; Dates as ISO. Own-property walk only.
 * `inputs` (§12) is the execution's normalized input map for [[input:x]].
 */
function renderResultTemplate(tpl, outputs, inputs = null) {
  const text = String(tpl).replace(RESULT_TOKEN_RE, (_, inner) => {
    const inp = INPUT_REF_RE.exec(inner);
    if (inp) {
      // an omitted optional input renders '' (same as a missing output path)
      return inputs && hasOwn(inputs, inp[1]) && inputs[inp[1]] != null ? String(inputs[inp[1]]) : '';
    }
    const ref = RESULT_REF_RE.exec(inner);
    if (!ref) return '';
    let v = outputs[Number(ref[1]) - 1];
    const path = ref[2] ? ref[2].slice(1).split('.') : [];
    for (const seg of path) {
      if (v == null || typeof v !== 'object' || !hasOwn(v, seg)) { v = undefined; break; }
      v = v[seg];
    }
    if (v == null) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return ''; }
    }
    return String(v);
  });
  return { text, html: htmlEscape(text).replace(/\r?\n/g, '<br>') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clicker inputs (§12) — opened params, declarations, the value pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The opened-param spec for fn.param, or null. Opt-in per function via
 * __meta.ctaInputParams = { <param>: { kind: 'recipient'|'content', html?: true } }
 * (Ruling 6c). Only an ELIGIBLE function's REAL meta param can be opened;
 * own-property lookups throughout (plan JSON is untrusted shape). The full
 * opened set is snapshotted in tests/ctaInputs.test.js — every opened param
 * is a reviewed exposure decision, like the eligible-function set.
 */
function openedParamSpec(fnName, param, reg = registry()) {
  if (typeof param !== 'string' || !isCtaEligible(fnName, reg)) return null;
  const meta = reg[fnName].__meta;
  const cip = meta.ctaInputParams;
  if (!isPlainObject(cip) || !hasOwn(cip, param)) return null;
  const s = cip[param];
  if (!isPlainObject(s) || !OPENED_KINDS.has(s.kind)) return null;
  if (!Array.isArray(meta.params) || !meta.params.some((p) => p && p.name === param)) return null;
  // N6 (S1i review): a recipient may pin the input type it takes — the
  // transport only understands one (send_sms.to a phone, send_email.to an
  // email). Anything else in `type` is a malformed opening: treat as closed.
  if (s.type !== undefined && !(s.kind === 'recipient' && RECIPIENT_TYPES.has(s.type))) return null;
  const out = { kind: s.kind, html: s.html === true };
  if (s.type !== undefined) out.type = s.type;
  return out;
}

/** { fn: { param: {kind, html?} } } over every eligible function — the snapshot surface. */
function openedInputParams(reg = registry()) {
  const out = {};
  for (const fn of eligibleFunctionNames(reg)) {
    const cip = reg[fn].__meta.ctaInputParams;
    if (!isPlainObject(cip)) continue;
    const params = {};
    for (const p of Object.keys(cip).sort()) {
      const s = openedParamSpec(fn, p, reg);
      if (!s) continue;
      const e = { kind: s.kind };
      if (s.html) e.html = true;
      if (s.type) e.type = s.type;
      params[p] = e;
    }
    if (Object.keys(params).length) out[fn] = params;
  }
  return out;
}

/**
 * Why binding input `decl` into fn.param can't run, as { code, spec }:
 * code null = fine; 'binding_closed' = undeclared input or a param no longer
 * opened; 'recipient_type' = a recipient fed by a type that can't guarantee
 * ONE recipient of the kind the transport takes. Shared by the click path
 * (prepareRun) and the link-level refusal (linkRefusal) — the mint checks the
 * same rules with its own, more specific 400s.
 */
function bindingProblem(fn, param, decl, reg) {
  const spec = openedParamSpec(fn, param, reg);
  if (!decl || !spec) return { code: 'binding_closed', spec: null };
  if (spec.kind === 'recipient' && !RECIPIENT_TYPES.has(decl.type)) return { code: 'recipient_type', spec };
  if (spec.type && decl.type !== spec.type) return { code: 'recipient_type', spec };
  return { code: null, spec };
}

/**
 * Every [[input:x]] binding in options that DECLARE inputs, as
 * { option, step, param, name, decl }. Input-less options are skipped: a
 * marker there is never substituted (prepareRun returns their plan untouched),
 * so it is just text.
 */
function listBindings(options) {
  const out = [];
  for (const o of Array.isArray(options) ? options : []) {
    const decls = o && Array.isArray(o.inputs) ? o.inputs : [];
    if (!decls.length) continue;
    const byName = new Map(decls.map((d) => [d.name, d]));
    for (const step of Array.isArray(o.plan) ? o.plan : []) {
      if (!step || !isPlainObject(step.params)) continue;
      for (const [k, v] of Object.entries(step.params)) {
        const m = typeof v === 'string' ? BINDING_RE.exec(v) : null;
        if (m) out.push({ option: o, step, param: k, name: m[1], decl: byName.get(m[1]) });
      }
    }
  }
  return out;
}

/** True when any input-declaring option binds a recipient — a closed binding counts (conservative). */
function hasRecipientBinding(options, reg = registry()) {
  return listBindings(options).some((b) => {
    const spec = openedParamSpec(b.step.fn, b.param, reg);
    return !spec || spec.kind === 'recipient';
  });
}

/**
 * LINK-LEVEL refusal (S1i review B1 + N2): a state the mint would have refused
 * that exists anyway — a param closed or retyped since mint, or max_uses
 * removed from a repeatable open-recipient link behind the hard rule's back
 * (PATCH now refuses that; a SQL edit could still do it). Pure. Returns null
 * or { reason, detail }. Called by BOTH respond() and the GET pre-check
 * (routes/ctaActions.js publicState, via linkBlocked) so a page never offers
 * what the POST would refuse. The public sees 'disabled', never why.
 */
function linkRefusal(row, reg = registry()) {
  let recipient = false;
  for (const b of listBindings(row && row.options)) {
    const p = bindingProblem(b.step.fn, b.param, b.decl, reg);
    if (p.code) return { reason: p.code, detail: `option "${b.option.value}": ${b.step.fn}.${b.param} ← [[input:${b.name}]]` };
    if (p.spec.kind === 'recipient') recipient = true;
  }
  if (row && row.mode === 'repeatable' && row.max_uses == null && recipient) {
    return { reason: 'unbounded_recipient', detail: 'a repeatable link with a clicker-supplied recipient has no max_uses (§12 hard rule)' };
  }
  return null;
}

/** linkRefusal + one deduplicated warning alert per link and reason. */
async function linkBlocked(db, row, reg = registry()) {
  const r = linkRefusal(row, reg);
  if (r) {
    await alertSafe({
      source: 'cta', kind: 'link_refused', group_key: `cta:${row.id}`, severity: 'warning',
      title: `CTA #${row.id} "${String(row.name).slice(0, 120)}" refused: ${r.reason}`,
      message: `${r.detail}. Every click is refused and the public pages show "unavailable" — nothing is claimed. ` +
        'Cancel the link or re-mint it (for unbounded_recipient, PATCH a max_uses).',
      ref_table: 'cta_links', ref_id: row.id, dedup_key: `cta:${row.id}:refused:${r.reason}`,
    }, db);
  }
  return r;
}

function listOpened(fnName, reg) {
  const cip = reg[fnName] && reg[fnName].__meta && reg[fnName].__meta.ctaInputParams;
  const names = isPlainObject(cip) ? Object.keys(cip).filter((p) => openedParamSpec(fnName, p, reg)) : [];
  return names.length ? names.join(', ') : 'none';
}

// ── Clicker patterns run on V8's LINEAR-TIME regexp engine (S1i review R1) ──
//
// The backtracking engine cannot be made safe by linting: the S1i lint passed
// (a?a?)+b, which took 35 s against 22 characters (measured 2026-10-08), and
// alternation overlap like (a|a)+ is undecidable for a lint in general. The
// experimental engine guarantees linear time and REFUSES to compile what it
// can't run that way — lookahead, backreferences, and bounded repeats above
// 16 — so every rejection happens at mint, as a 400, never at click.
//
// Enabled once per process. Prod also passes --enable-experimental-regexp-engine
// on the Dockerfile CMD; this call covers local runs, nodemon and jest, and is
// harmless when the flag is already set. There is NO backtracking fallback: if
// the engine is ever unavailable (a Node upgrade that drops the flag),
// patterns are refused at mint and a pattern-bearing input fails closed at
// click — tests/ctaInputs.test.js asserts the engine is present so CI catches
// that upgrade first. Ruling 4 holds: no new dependency.
const LINEAR_RE = (() => {
  try {
    require('v8').setFlagsFromString('--enable-experimental-regexp-engine');
    new RegExp('a', 'l'); // eslint-disable-line no-new
    return true;
  } catch (_) {
    return false;
  }
})();
console.log(`[CTA] linear regexp engine: ${LINEAR_RE ? 'available' : 'UNAVAILABLE — clicker-input patterns are refused'}`);

/** True when clicker-input patterns can run (the linear engine is available). */
function linearRegexAvailable() {
  return LINEAR_RE;
}

const BIG_REPEAT_RE = /\{(\d+)(?:,(\d*))?\}/g;
const MAX_LINEAR_REPEAT = 16;   // V8's linear engine refuses bounded repeats above this
const PATTERN_LIMITS =
  `repeat counts above ${MAX_LINEAR_REPEAT} aren't supported — use + or * with maxlen (maxlen already caps the length), ` +
  'or write the repeat as consecutive pieces (\\d{9}\\d{8}, not \\d{17}); lookahead and backreferences aren\'t supported';

const patternCache = new Map();
/**
 * The anchored, full-match, LINEAR-TIME RegExp for a stored pattern, or null
 * when the linear engine is unavailable (the caller fails closed).
 */
function compiledPattern(p) {
  if (!LINEAR_RE) return null;
  let re = patternCache.get(p);
  if (!re) {
    // Compiled alone FIRST (at mint): an unbalanced ')' can't break out of the
    // ^(?: … )$ wrapper, because it never got this far.
    re = new RegExp(`^(?:${p})$`, 'l');
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(p, re);
  }
  return re;
}

function lintPattern(p, il) {
  if (typeof p !== 'string' || p === '' || p.length > MAX_PATTERN) {
    throw bad(`${il}.pattern must be a 1–${MAX_PATTERN} character string`);
  }
  try {
    new RegExp(p); // eslint-disable-line no-new
  } catch (err) {
    throw bad(`${il}.pattern is not a valid regular expression: ${err.message}`);
  }
  if (!LINEAR_RE) {
    throw bad(`${il}.pattern: patterns are unavailable on this server (the linear-time regexp engine is missing) — omit pattern`);
  }
  try {
    new RegExp(`^(?:${p})$`, 'l'); // eslint-disable-line no-new
  } catch (_) {
    let big = null;
    let m;
    BIG_REPEAT_RE.lastIndex = 0;
    while ((m = BIG_REPEAT_RE.exec(p)) !== null) {
      const max = m[2] === undefined ? Number(m[1]) : (m[2] === '' ? Infinity : Number(m[2]));
      if (Number.isFinite(max) && max > MAX_LINEAR_REPEAT) { big = m[0]; break; }
    }
    throw bad(`${il}.pattern must run in linear time${big ? ` (${big} is too large)` : ''}: ${PATTERN_LIMITS}`);
  }
}

function isRealDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * The per-value pipeline (§12 "type → normalize → maxlen → pattern"): one
 * NON-BLANK raw value against one declaration. Returns { value } (normalized,
 * always a string) or { error } (a clicker-facing, generic message).
 *
 *   text/html  CRLF → LF, trimmed, C0 controls (but \t \n) rejected
 *   phone      phoneService.normalizeE164 — the canonical helper — then a
 *              strict E.164 shape check: that helper passes any '+…' string
 *              through untouched, so '+44 20 7946 0958' or '+<x>' would
 *              otherwise reach the transport as-is
 *   email      no control/format characters (\p{Cc}\p{Cf}), then
 *              contactEmailService.normalizeEmail (trim + lowercase) and ONE
 *              address — no list separators, no whitespace
 *   number     plain decimal (no exponent/hex/Infinity), ≤ 15 significant
 *              digits and |n| < 1e15 so String(n) is exact and exponent-free
 *   enum       exactly one of the declared choices
 *   date       YYYY-MM-DD that is a real calendar date
 */
function validateInputValue(decl, raw) {
  let s;
  if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'number' && decl.type === 'number' && Number.isFinite(raw)) s = String(raw);
  else return { error: INPUT_MSG.type };
  if (s.length > MAX_RAW_INPUT) return { error: tooLongMsg(decl.maxlen) };
  s = s.replace(/\r\n?/g, '\n').trim();

  let v;
  switch (decl.type) {
    case 'text':
    case 'html':
      if (CONTROL_RE.test(s)) return { error: INPUT_MSG.chars };
      v = s;
      break;
    case 'phone': {
      const { normalizeE164 } = require('./phoneService');
      const n = normalizeE164(s);
      if (!n || !E164_RE.test(n)) return { error: INPUT_MSG.phone };
      v = n;
      break;
    }
    case 'email': {
      // Every control and format character — NUL, BEL, zero-width spaces and
      // joiners, the BOM, bidi overrides (U+202E). \s in the address regex
      // misses all of these; a send to one fails and still burns the use.
      if (EMAIL_INVISIBLE_RE.test(s)) return { error: INPUT_MSG.email };
      const { normalizeEmail } = require('./contactEmailService');
      const n = normalizeEmail(s);
      if (!INPUT_EMAIL_RE.test(n)) return { error: INPUT_MSG.email };
      v = n;
      break;
    }
    case 'number': {
      if (!NUMBER_RE.test(s)) return { error: INPUT_MSG.number };
      // > 15 significant digits can't round-trip through a double: refuse
      // rather than silently change the value the clicker typed.
      if (s.replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '').length > MAX_NUMBER_DIGITS) {
        return { error: INPUT_MSG.number };
      }
      const n = Number(s);
      if (!Number.isFinite(n) || Math.abs(n) >= 1e15) return { error: INPUT_MSG.number };
      v = String(n);
      if (/e/i.test(v)) return { error: INPUT_MSG.number };   // 0.0000001 → "1e-7": not a plain decimal
      break;
    }
    case 'enum':
      if (!Array.isArray(decl.choices) || !decl.choices.includes(s)) return { error: INPUT_MSG.enum };
      v = s;
      break;
    case 'date':
      if (!isRealDate(s)) return { error: INPUT_MSG.date };
      v = s;
      break;
    default:
      return { error: INPUT_MSG.type };
  }
  if (v.length > decl.maxlen) return { error: tooLongMsg(decl.maxlen) };
  if (decl.pattern) {
    const re = compiledPattern(decl.pattern);
    if (!re) return { error: INPUT_MSG.unavailable };   // no linear engine: fail closed, never backtrack
    if (!re.test(v)) return { error: INPUT_MSG.pattern };
  }
  return { value: v };
}

/**
 * Validate an option's `inputs` declarations at mint. Returns the normalized
 * array (stored in the option): { name, label, type, required, maxlen,
 * choices?, pattern?, default? } — a stored default has passed the full value
 * pipeline, so the timeout path and the HTML pre-fill can use it as-is.
 */
function validateInputDecls(raw, ol) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_INPUTS) {
    throw bad(`${ol}.inputs must be an array of at most ${MAX_INPUTS} input declarations`);
  }
  const seen = new Set();
  return raw.map((d, j) => {
    const il = `${ol}.inputs[${j}]`;
    if (!isPlainObject(d)) throw bad(`${il} must be an object {name, label, type, required, maxlen, …}`);
    rejectUnknownKeys(d, INPUT_KEYS, il);

    const name = typeof d.name === 'string' ? d.name : '';
    if (!INPUT_NAME_RE.test(name)) throw bad(`${il}.name must match ${INPUT_NAME_RE}`);
    if (RESERVED_INPUT_NAMES.has(name)) throw bad(`${il}.name "${name}" is reserved`);
    if (seen.has(name)) throw bad(`${ol}.inputs: duplicate input name "${name}"`);
    seen.add(name);

    const label = typeof d.label === 'string' ? d.label.trim() : '';
    if (!label || label.length > MAX_INPUT_LABEL) throw bad(`${il}.label must be 1–${MAX_INPUT_LABEL} chars`);

    if (!INPUT_TYPES.includes(d.type)) throw bad(`${il}.type must be one of ${INPUT_TYPES.join(', ')}`);
    if (typeof d.required !== 'boolean') throw bad(`${il}.required must be true or false`);
    if (!Number.isInteger(d.maxlen) || d.maxlen < 1 || d.maxlen > MAX_INPUT_LEN) {
      throw bad(`${il}.maxlen is required: an integer 1–${MAX_INPUT_LEN}`);
    }
    // maxlen is checked on the NORMALIZED value; below these floors every
    // value would be rejected — a dead input, so a mint error instead.
    const floor = MIN_MAXLEN[d.type];
    if (floor && d.maxlen < floor) {
      throw bad(`${il}.maxlen ${d.maxlen} is below ${floor} — every ${d.type} value normalizes to at least that (${MIN_MAXLEN_WHY[d.type]})`);
    }

    const decl = { name, label, type: d.type, required: d.required, maxlen: d.maxlen };

    if (d.type === 'enum') {
      const ch = d.choices;
      if (!Array.isArray(ch) || ch.length < 1 || ch.length > MAX_CHOICES) {
        throw bad(`${il}.choices: an enum needs 1–${MAX_CHOICES} choices`);
      }
      const uniq = new Set();
      for (const c of ch) {
        if (typeof c !== 'string' || !VALUE_RE.test(c)) throw bad(`${il}.choices: each choice must match ${VALUE_RE}`);
        if (uniq.has(c)) throw bad(`${il}.choices: duplicate choice "${c}"`);
        if (c.length > d.maxlen) throw bad(`${il}.choices: "${c}" is longer than maxlen ${d.maxlen}`);
        uniq.add(c);
      }
      decl.choices = ch.slice();
    } else if (d.choices !== undefined) {
      throw bad(`${il}.choices applies to type enum only`);
    }

    if (d.pattern != null) {
      lintPattern(d.pattern, il);
      decl.pattern = d.pattern;
    }

    if (d.default != null && d.default !== '') {
      if (typeof d.default === 'string' && PLACEHOLDER_RE.test(d.default)) {
        throw bad(`${il}.default: unresolved {{...}} placeholder — defaults are frozen literals at mint`);
      }
      const r = validateInputValue(decl, d.default);
      if (r.error) throw bad(`${il}.default: ${r.error}`);
      decl.default = r.value;
    }
    return decl;
  });
}

/** The value a binding receives: escape-on-substitute (§12) for a non-html input into an html:true param. */
function substituteValue(value, decl, spec) {
  if (spec && spec.html && decl.type !== 'html') {
    return htmlEscape(value).replace(/\n/g, '<br>');
  }
  return value;
}

/** First path inside `v` carrying the [[input: marker, or null (deep, values only). */
function findInputMark(v, path) {
  if (typeof v === 'string') return v.includes(BINDING_MARK) ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = findInputMark(v[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = findInputMark(x, `${path}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Check a submission against an option's declarations. `submitted` is
 * null/undefined (defaults only — the timeout path) or a plain object of
 * name → raw value. Blank (missing, null, whitespace) → the default when
 * declared, else 'required' for a required input, else omitted.
 * Returns { values, errors, formError } — null-prototype maps.
 */
function resolveInputs(decls, submitted) {
  const values = Object.create(null);
  const errors = Object.create(null);
  const sub = submitted == null ? {} : submitted;
  if (!isPlainObject(sub)) {
    return { values, errors, formError: 'inputs must be an object of input name to value' };
  }
  const declared = new Set(decls.map((d) => d.name));
  for (const k of Object.keys(sub)) {
    if (!declared.has(k)) errors[k] = INPUT_MSG.unknown;
  }
  for (const d of decls) {
    const raw = hasOwn(sub, d.name) ? sub[d.name] : undefined;
    const blank = raw == null || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      if (hasOwn(d, 'default')) values[d.name] = d.default;
      else if (d.required) errors[d.name] = INPUT_MSG.required;
      continue;
    }
    const r = validateInputValue(d, raw);
    if (r.error) errors[d.name] = r.error;
    else values[d.name] = r.value;
  }
  return { values, errors, formError: null };
}

/**
 * The click-time half of §12, for one option. Pure — no DB. Validates the
 * submission, substitutes every binding (type-aware escape), then re-runs
 * __validateFunctionParams on each bound step before step 1 can run.
 *
 *   { ok: true, plan, values }    values is null for an input-less option,
 *                                 whose plan is returned UNTOUCHED (no
 *                                 re-validation — byte-identical to S1)
 *   { ok: false, code: 'invalid_inputs', errors, formError }
 *   { ok: false, code: 'binding_closed', error }  a binding can no longer run
 *                                 (bindingProblem: param closed or retyped
 *                                 since mint): refused before any claim, like
 *                                 the run-time eligibility re-check but without
 *                                 burning a use. respond() checks linkRefusal
 *                                 first, so there this is defense in depth; the
 *                                 sweep relies on it
 */
function prepareRun(option, submitted, reg = registry()) {
  const decls = Array.isArray(option.inputs) ? option.inputs : [];
  if (!decls.length) {
    if (submitted != null) {
      if (!isPlainObject(submitted)) {
        return { ok: false, code: 'invalid_inputs', errors: Object.create(null), formError: 'inputs must be an object of input name to value' };
      }
      const keys = Object.keys(submitted);
      if (keys.length) {
        const errors = Object.create(null);
        for (const k of keys) errors[k] = INPUT_MSG.unknown;
        return { ok: false, code: 'invalid_inputs', errors, formError: null };
      }
    }
    return { ok: true, plan: option.plan || [], values: null };
  }

  const { values, errors, formError } = resolveInputs(decls, submitted);
  if (formError || Object.keys(errors).length) return { ok: false, code: 'invalid_inputs', errors, formError };

  const byName = new Map(decls.map((d) => [d.name, d]));
  const plan = [];
  for (const step of option.plan || []) {
    const fn = step && step.fn;
    const params = JSON.parse(JSON.stringify((step && step.params) || {}));
    const bound = [];
    for (const [k, v] of Object.entries(params)) {
      const m = typeof v === 'string' ? BINDING_RE.exec(v) : null;
      if (!m) continue;
      const decl = byName.get(m[1]);
      const problem = bindingProblem(fn, k, decl, reg);
      if (problem.code) return { ok: false, code: 'binding_closed', error: `${fn}.${k} ← [[input:${m[1]}]] (${problem.code})` };
      const { spec } = problem;
      bound.push(decl.name);
      if (!(decl.name in values)) delete params[k];   // omitted optional input: the param is absent
      else params[k] = substituteValue(values[decl.name], decl, spec);
    }
    if (bound.length) {
      const err = reg.__validateFunctionParams(fn, params);
      if (err) {
        // Mint validated defaults/samples AND the blank-optional variant, so
        // this is defense in depth — log it, answer generically.
        console.warn(`[CTA] click-time re-validation rejected ${fn}: ${err.error}`);
        const errs = Object.create(null);
        for (const n of bound) errs[n] = INPUT_MSG.rejected;
        return { ok: false, code: 'invalid_inputs', errors: errs, formError: null };
      }
    }
    plan.push({ fn, params });
  }
  return { ok: true, plan, values };
}

/** §5.2 descriptor entries for an option's declarations (never the pattern). */
function publicInputs(decls) {
  return decls.map((d) => {
    const o = { name: d.name, label: d.label, type: d.type, required: d.required };
    if (d.choices) o.choices = d.choices.slice();
    o.maxlen = d.maxlen;
    if (hasOwn(d, 'default')) o.default = d.default;
    return o;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mint validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one option's plan. `decls` are the option's validated input
 * declarations (§12). Returns { plan, bindings } — bindings is
 * [{ step, param, name, kind, html }] for the policy gates in validateMint.
 */
function validatePlan(plan, label, reg, decls = []) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_PLAN_STEPS) {
    throw bad(`${label}.plan must be an array of 1–${MAX_PLAN_STEPS} {fn, params} steps`);
  }
  const byName = new Map(decls.map((d) => [d.name, d]));
  const bindings = [];
  const out = plan.map((step, i) => {
    const sl = `${label}.plan[${i}]`;
    if (!isPlainObject(step)) throw bad(`${sl} must be an object {fn, params}`);
    rejectUnknownKeys(step, STEP_KEYS, sl);
    if (!isCtaEligible(step.fn, reg)) throw bad(`${sl}.fn: ${_ineligibleReason(step.fn, reg)}`);

    const params = step.params === undefined || step.params === null ? {} : step.params;
    if (!isPlainObject(params)) throw bad(`${sl}.params must be a JSON object`);

    // _-prefixed keys are the engine-injection namespace (_variables,
    // _step_number, _execution_id). A CTA has no execution; a literal one
    // would let a plan impersonate one (e.g. defeat a self-cancel guard).
    for (const k of Object.keys(params)) {
      if (k.startsWith('_')) throw bad(`${sl}.params.${k}: _-prefixed keys are reserved for the workflow engine`);
    }
    // Frozen literals only. The resolver renders an unknown {{x}} as '' —
    // e.g. start_workflow re-running WF27 with empty input, unattended.
    const ph = findPlaceholder(params, `${sl}.params`);
    if (ph) throw bad(`${ph}: unresolved {{...}} placeholder — CTA params are frozen literals at mint`);

    // §12 bindings: "[[input:name]]" as a WHOLE top-level value, into an
    // opened param, naming a declared input. Anything else carrying the
    // marker is a splice or a nested binding — Ruling 5, rejected.
    const stepBindings = [];
    for (const [k, v] of Object.entries(params)) {
      const m = typeof v === 'string' ? BINDING_RE.exec(v) : null;
      if (!m) continue;
      const decl = byName.get(m[1]);
      if (!decl) throw bad(`${sl}.params.${k}: [[input:${m[1]}]] — no input "${m[1]}" is declared on this option`);
      const spec = openedParamSpec(step.fn, k, reg);
      if (!spec) {
        throw bad(`${sl}.params.${k}: ${step.fn}.${k} is not open to clicker inputs (${step.fn} opens: ${listOpened(step.fn, reg)})`);
      }
      if (spec.kind === 'recipient' && !RECIPIENT_TYPES.has(decl.type)) {
        throw bad(`${sl}.params.${k}: ${step.fn}.${k} is a recipient — bind a phone or email input (input "${decl.name}" is ${decl.type}, which could carry a list of recipients)`);
      }
      if (spec.type && decl.type !== spec.type) {
        throw bad(`${sl}.params.${k}: ${step.fn}.${k} takes a ${spec.type} input (input "${decl.name}" is ${decl.type}) — the send would fail on every click`);
      }
      stepBindings.push({ step: i + 1, param: k, name: decl.name, kind: spec.kind, html: spec.html, decl, spec });
    }
    // Only where inputs are declared (S1i review N1): an input-less option's
    // marker is never substituted, so it is just text — and WF27 step 47
    // freezes the raw website form body into init_data, where a spam message
    // carrying a literal "[[input:" must not fail the mint.
    const bound = new Set(stepBindings.map((b) => b.param));
    for (const [k, v] of decls.length ? Object.entries(params) : []) {
      if (bound.has(k)) continue;
      const stray = findInputMark(v, `${sl}.params.${k}`);
      if (stray) {
        throw bad(`${stray}: [[input:…]] must be a param's whole top-level value — no splicing inside strings, no nesting (§12 Ruling 5)`);
      }
    }

    if (!stepBindings.length) {
      const err = reg.__validateFunctionParams(step.fn, params);
      if (err) throw bad(`${sl} (${step.fn}): ${err.error}`);
    } else {
      // Validator pass 1 (§12 "Mint"): every binding filled with its default,
      // else a type-appropriate sample — substituted exactly as a click would.
      const filled = JSON.parse(JSON.stringify(params));
      for (const b of stepBindings) {
        const sample = hasOwn(b.decl, 'default') ? b.decl.default
          : (b.decl.type === 'enum' ? b.decl.choices[0] : INPUT_SAMPLES[b.decl.type]);
        filled[b.param] = substituteValue(sample, b.decl, b.spec);
      }
      let err = reg.__validateFunctionParams(step.fn, filled);
      if (err) throw bad(`${sl} (${step.fn}) with default/sample inputs: ${err.error}`);
      // …and the blank-optional variant: an optional input with no default
      // leaves its param ABSENT at click — a function that requires that
      // param would fail every blank submission, so it fails the mint instead.
      const omittable = stepBindings.filter((b) => !b.decl.required && !hasOwn(b.decl, 'default'));
      if (omittable.length) {
        for (const b of omittable) delete filled[b.param];
        err = reg.__validateFunctionParams(step.fn, filled);
        if (err) {
          throw bad(`${sl} (${step.fn}) with optional input${omittable.length === 1 ? '' : 's'} ` +
            `${omittable.map((b) => `"${b.name}"`).join(', ')} left blank: ${err.error} — make the input required or give it a default`);
        }
      }
    }
    for (const b of stepBindings) {
      bindings.push({ step: b.step, param: b.param, name: b.name, kind: b.kind, html: b.html });
    }

    // Round-trip: the stored plan is exactly what JSON can carry.
    return { fn: step.fn, params: JSON.parse(JSON.stringify(params)) };
  });

  const used = new Set(bindings.map((b) => b.name));
  const unused = decls.find((d) => !used.has(d.name));
  if (unused) throw bad(`${label}.inputs: "${unused.name}" is declared but never bound to a plan param`);
  return { plan: out, bindings };
}

/**
 * Validate the options array. Returns { options, bindingsByValue } —
 * bindingsByValue (option value → validatePlan bindings) feeds the §12
 * policy gates in validateMint and is never stored.
 */
function validateOptions(raw, reg) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPTIONS) {
    throw bad(`options must be an array of 1–${MAX_OPTIONS} options`);
  }
  const seen = new Set();
  const bindingsByValue = new Map();
  const options = raw.map((o, i) => {
    const ol = `options[${i}]`;
    if (!isPlainObject(o)) throw bad(`${ol} must be an object`);
    rejectUnknownKeys(o, OPTION_KEYS, ol);

    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!VALUE_RE.test(value)) throw bad(`${ol}.value must match ${VALUE_RE} (url-safe, it rides in the link path)`);
    if (RESERVED_VALUES.has(value)) throw bad(`${ol}.value "${value}" is reserved`);
    if (seen.has(value)) throw bad(`duplicate option value "${value}"`);
    seen.add(value);

    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label || label.length > MAX_LABEL) throw bad(`${ol}.label must be 1–${MAX_LABEL} chars`);

    const decls = validateInputDecls(o.inputs, ol);
    const { plan, bindings } = validatePlan(o.plan, ol, reg, decls);
    const out = { value, label, plan };
    bindingsByValue.set(value, bindings);

    if (o.confirm_text != null) {
      if (typeof o.confirm_text !== 'string') throw bad(`${ol}.confirm_text must be a string`);
      const t = o.confirm_text.trim();
      if (t.length > MAX_CONFIRM_TEXT) throw bad(`${ol}.confirm_text exceeds ${MAX_CONFIRM_TEXT} chars`);
      if (t) out.confirm_text = t;
    }
    if (o.result_template != null) {
      if (typeof o.result_template !== 'string') throw bad(`${ol}.result_template must be a string`);
      const t = o.result_template;
      if (t.trim() === '') throw bad(`${ol}.result_template is blank — omit it instead`);
      if (t.length > MAX_RESULT_TEMPLATE) throw bad(`${ol}.result_template exceeds ${MAX_RESULT_TEMPLATE} chars`);
      validateResultTemplate(t, plan.length, ol, new Set(decls.map((d) => d.name)));
      out.result_template = t;
    }
    if (decls.length) out.inputs = decls;
    return out;
  });
  return { options, bindingsByValue };
}

async function resolveExpiry(db, input, mode, now) {
  const hasAt = input.expires_at != null && input.expires_at !== '';
  const hasTimeout = input.timeout != null && input.timeout !== '';
  if (hasAt && hasTimeout) throw bad('give expires_at OR timeout, not both');

  let expiresAt;
  if (hasAt) {
    expiresAt = parseExpiresAt(input.expires_at);
  } else {
    let durMs;
    if (hasTimeout) {
      durMs = typeof input.timeout === 'number' ? input.timeout : ms(String(input.timeout));
      if (!Number.isFinite(durMs) || durMs <= 0) {
        throw bad(`invalid timeout "${input.timeout}" (use "2h", "3d", "30m", or ms)`);
      }
    } else {
      const { getSetting } = require('./settingsService');
      const raw = await getSetting(db, SETTING_TIMEOUT[mode]);
      durMs = raw == null ? undefined : ms(String(raw).trim());
      if (!Number.isFinite(durMs) || durMs <= 0 || durMs > MAX_EXPIRY_MS) {
        if (raw != null) {
          console.warn(`[CTA] setting ${SETTING_TIMEOUT[mode]}="${raw}" is not a usable duration — using ${FALLBACK_TIMEOUT[mode]}`);
        }
        durMs = ms(FALLBACK_TIMEOUT[mode]);
      }
    }
    expiresAt = new Date(now.getTime() + durMs);
  }
  checkExpiryWindow(expiresAt, now);
  return expiresAt;
}

/** Naive datetimes are FIRM_TZ (parseUserDateTime); stored UTC. */
function parseExpiresAt(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw bad('expires_at is not a valid datetime');
    return v;
  }
  if (typeof v !== 'string') throw bad('expires_at must be a datetime string');
  const { parseUserDateTime } = require('./timezoneService');
  let d;
  try { d = parseUserDateTime(v); } catch (err) { throw bad(`expires_at: ${err.message}`); }
  if (!d) throw bad('expires_at is blank');
  return d;
}

function checkExpiryWindow(expiresAt, now) {
  if (expiresAt.getTime() <= now.getTime()) throw bad('expiry must be in the future');
  if (expiresAt.getTime() - now.getTime() > MAX_EXPIRY_MS) throw bad('expiry exceeds 365d');
}

/**
 * Validate a mint request and return the row to insert. Pure validation
 * apart from the settings read (default expiry) and the attributed-user
 * existence check — no writes. Throws CtaError(400).
 */
async function validateMint(db, input, { now = new Date() } = {}) {
  if (!isPlainObject(input)) throw bad('mint body must be a JSON object');
  rejectUnknownKeys(input, MINT_KEYS, 'mint');
  const reg = registry();
  const notes = [];
  const warnings = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_NAME) throw bad(`name must be 1–${MAX_NAME} chars`);

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT) throw bad(`prompt must be 1–${MAX_PROMPT} chars`);

  let contextHtml = null;
  if (input.context_html != null) {
    if (typeof input.context_html !== 'string') throw bad('context_html must be a string');
    contextHtml = input.context_html.trim() === '' ? null : input.context_html;
    if (contextHtml && contextHtml.length > MAX_CONTEXT_HTML) throw bad(`context_html exceeds ${MAX_CONTEXT_HTML} chars`);
  }

  const mode = input.mode == null ? 'once' : input.mode;
  if (mode !== 'once' && mode !== 'repeatable') throw bad("mode must be 'once' or 'repeatable'");

  let maxUses = null;
  if (input.max_uses != null) {
    if (mode !== 'repeatable') throw bad('max_uses applies to mode=repeatable only');
    maxUses = posInt(input.max_uses);
    if (maxUses == null) throw bad('max_uses must be a positive integer (or null for "until expiry")');
  }

  const { options, bindingsByValue } = validateOptions(input.options, reg);
  const values = new Set(options.map((o) => o.value));

  let timeoutOption = null;
  if (input.timeout_option != null && input.timeout_option !== '') {
    if (mode !== 'once') throw bad('timeout_option applies to mode=once only');
    if (typeof input.timeout_option !== 'string' || !values.has(input.timeout_option)) {
      throw bad(`timeout_option "${input.timeout_option}" is not one of the option values`);
    }
    timeoutOption = input.timeout_option;
    // §12: the sweep has no clicker — it substitutes defaults, so every input
    // of the timeout option needs one.
    const tOpt = options.find((o) => o.value === timeoutOption);
    const missing = (tOpt.inputs || []).find((d) => !hasOwn(d, 'default'));
    if (missing) {
      throw bad(`timeout_option "${timeoutOption}": input "${missing.name}" needs a default — the expiry sweep has no clicker to supply it`);
    }
  }

  // ── §12 policy: the hard rule (not acknowledgeable) ───────────────────
  const allBindings = [...bindingsByValue.values()].flat();
  const recipientBound = allBindings.some((b) => b.kind === 'recipient');
  if (mode === 'repeatable' && recipientBound && maxUses == null) {
    throw bad('a repeatable link with a clicker-supplied recipient must set max_uses (any value, your choice) — ' +
      'an open-recipient link is a relay from the firm\'s identity, never unbounded by omission');
  }

  const expiresAt = await resolveExpiry(db, input, mode, now);

  // ── Protection (§2.11, NB2; §12) ──────────────────────────────────────
  const hasTemplate = options.some((o) => o.result_template);
  const hasInputs = options.some((o) => o.inputs && o.inputs.length);
  const passwordGiven = input.password != null && input.password !== '';
  let protection;
  let protectionSource;
  if (input.protection != null) {
    if (input.protection !== 'none' && input.protection !== 'password') {
      throw bad("protection must be 'none' or 'password'");
    }
    protection = input.protection;
    protectionSource = 'explicit';
  } else if (passwordGiven) {
    protection = 'password';
    protectionSource = 'password_supplied';
  } else if (hasInputs) {
    // §12: same B5b pattern — the default is password, an explicit 'none' IS
    // the SU's acceptance, and the receipt names the default that applied.
    protection = 'password';
    protectionSource = 'default_inputs';
    notes.push("protection defaulted to 'password' because an option declares clicker inputs" +
      (hasTemplate ? ' (and an option carries result_template)' : '') + "; pass protection:'none' to override");
  } else if (hasTemplate) {
    protection = 'password';
    protectionSource = 'default_result_template';
    notes.push("protection defaulted to 'password' because an option carries result_template; pass protection:'none' to override");
  } else {
    protection = 'none';
    protectionSource = 'default';
  }
  if (protection === 'none' && passwordGiven) throw bad("password given but protection is 'none'");

  let passwordPlain = null;
  let passwordGenerated = false;
  if (protection === 'password') {
    if (passwordGiven) {
      if (typeof input.password !== 'string') throw bad('password must be a string');
      if (input.password.length < MIN_SUPPLIED_PASSWORD) {
        throw bad(`password must be at least ${MIN_SUPPLIED_PASSWORD} characters (omit it to auto-generate one)`);
      }
      if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
        throw bad(`password must be at most ${MAX_PASSWORD_BYTES} bytes`);
      }
      passwordPlain = input.password;
    } else {
      passwordGenerated = true;   // minted at insert time — never in a dry run
    }
  }

  let returnPlanResult = 0;
  if (input.return_plan_result != null) {
    const v = input.return_plan_result;
    if (v === true || v === 1) returnPlanResult = 1;
    else if (v === false || v === 0) returnPlanResult = 0;
    else throw bad('return_plan_result must be a boolean');
  }

  let attributedUserId = null;
  if (input.attributed_user_id != null && input.attributed_user_id !== '') {
    attributedUserId = posInt(input.attributed_user_id);
    if (attributedUserId == null) throw bad('attributed_user_id must be a positive integer');
    const [[u]] = await db.query('SELECT `user` FROM users WHERE `user` = ?', [attributedUserId]);
    if (!u) throw bad(`attributed_user_id ${attributedUserId} not found`);
  }

  let linkType = null;
  let linkId = null;
  const ltGiven = input.link_type != null && input.link_type !== '';
  const liGiven = input.link_id != null && input.link_id !== '';
  if (ltGiven || liGiven) {
    if (!ltGiven || !liGiven) throw bad('link_type and link_id go together');
    const { _normalizeAbout } = require('./logService');
    try {
      linkId = _normalizeAbout(input.link_type, input.link_id); // ABOUT_TYPES value set + phone/email normalization
    } catch (err) {
      throw bad(`link: ${err.message}`);
    }
    if (linkId.length > 255) throw bad('link_id exceeds 255 chars');
    linkType = input.link_type;
  }

  const mintSource = input.mint_source == null ? 'su' : input.mint_source;
  if (mintSource !== 'su' && mintSource !== 'workflow') throw bad("mint_source must be 'su' or 'workflow'");
  let mintedBy;
  let sourceExecutionId = null;
  if (mintSource === 'su') {
    mintedBy = posInt(input.minted_by);
    if (mintedBy == null) throw bad('minted_by (the minting SU user id) is required');
    if (input.source_execution_id != null) throw bad('source_execution_id is for mint_source=workflow');
  } else {
    mintedBy = input.minted_by == null ? 0 : Number(input.minted_by);
    if (mintedBy !== 0) throw bad('workflow mints have minted_by 0');
    sourceExecutionId = posInt(input.source_execution_id);
    if (sourceExecutionId == null) throw bad('source_execution_id is required for mint_source=workflow');
  }

  if (mode === 'repeatable') {
    const heavy = [...new Set(options.flatMap((o) => o.plan.map((s) => s.fn)).filter((fn) => CHROMIUM_FNS.has(fn)))];
    if (heavy.length) {
      warnings.push(`repeatable link runs Chromium-backed ${heavy.join(', ')} on every use — public fan-out is server load; consider max_uses`);
    }
  }

  // ── §12 acknowledge-to-proceed risks — last, so every structural error
  // above is reported first. dry_run fails the same way (it IS the mint
  // minus the insert): that 400's `risks` is how the pane learns which
  // checkboxes to show.
  const accepted = new Set();
  if (input.accept_risks != null) {
    if (!Array.isArray(input.accept_risks) || input.accept_risks.some((c) => typeof c !== 'string')) {
      throw bad('accept_risks must be an array of risk codes');
    }
    for (const c of input.accept_risks) {
      if (!hasOwn(CTA_RISKS, c)) throw bad(`accept_risks: unknown risk code "${c}" (known: ${Object.keys(CTA_RISKS).join(', ')})`);
      accepted.add(c);
    }
  }
  const triggered = [];
  if (mode === 'repeatable' && recipientBound) triggered.push('open_recipient_repeatable');
  if (options.some((o) => (o.inputs || []).some((d) => d.type === 'html'))) triggered.push('raw_html_input');
  const missingRisks = triggered.filter((c) => !accepted.has(c));
  if (missingRisks.length) {
    const err = new CtaError(400,
      `cta: this link needs explicit risk acceptance — add ${missingRisks.map((c) => `"${c}"`).join(', ')} to accept_risks. ` +
      missingRisks.map((c) => `${c}: ${CTA_RISKS[c]}`).join(' '),
      'risk_acceptance_required');
    err.risks = missingRisks.map((code) => ({ code, description: CTA_RISKS[code] }));
    throw err;
  }
  for (const c of accepted) {
    if (!triggered.includes(c)) notes.push(`accept_risks "${c}" does not apply to this link — not recorded`);
  }

  return {
    row: {
      name, prompt, context_html: contextHtml, options, mode, max_uses: maxUses,
      expires_at: expiresAt, timeout_option: timeoutOption, protection,
      return_plan_result: returnPlanResult, attributed_user_id: attributedUserId,
      mint_source: mintSource, source_execution_id: sourceExecutionId,
      minted_by: mintedBy, link_type: linkType, link_id: linkId,
    },
    protectionSource,
    passwordPlain,
    passwordGenerated,
    risksAccepted: triggered,
    notes,
    warnings,
  };
}

/**
 * Mint a CTA. input.dry_run === true → full validation, no insert, no token,
 * no password. Returns the mint receipt; `password` is present ONLY when it
 * was auto-generated — this is the one time it is ever shown.
 */
async function mintCta(db, input, { now = new Date() } = {}) {
  const v = await validateMint(db, input, { now });
  const dryRun = input.dry_run === true;
  const r = v.row;
  const receipt = {
    dry_run: dryRun,
    name: r.name,
    mode: r.mode,
    expires_at: r.expires_at.toISOString(),
    max_uses: r.max_uses,
    timeout_option: r.timeout_option,
    protection: r.protection,
    protection_source: v.protectionSource,
    options: r.options.map((o) => (o.inputs
      ? { value: o.value, label: o.label, inputs: o.inputs.map((d) => d.name) }
      : { value: o.value, label: o.label })),
    risks_accepted: v.risksAccepted.slice(),
    notes: v.notes.slice(),
    warnings: v.warnings,
  };
  if (dryRun) {
    if (v.passwordGenerated) receipt.notes.push('a 22-character password will be generated at mint and shown once');
    return receipt;
  }

  let passwordHash = null;
  let passwordOut;
  if (r.protection === 'password') {
    const plain = v.passwordGenerated ? generateToken() : v.passwordPlain;
    passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
    if (v.passwordGenerated) passwordOut = plain;
  }

  const token = generateToken();
  const [ins] = await db.query(
    `INSERT INTO cta_links
       (token, name, prompt, context_html, options, mode, max_uses, expires_at,
        timeout_option, protection, password_hash, return_plan_result,
        attributed_user_id, status, mint_source, source_execution_id,
        minted_by, link_type, link_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      token, r.name, r.prompt, r.context_html, JSON.stringify(r.options), r.mode,
      r.max_uses, r.expires_at, r.timeout_option, r.protection, passwordHash,
      r.return_plan_result, r.attributed_user_id, r.mint_source,
      r.source_execution_id, r.minted_by, r.link_type, r.link_id,
    ]
  );
  receipt.id = ins.insertId;
  receipt.token = token;
  if (passwordOut !== undefined) receipt.password = passwordOut;
  console.log(
    `[CTA] minted #${ins.insertId} "${r.name}" mode=${r.mode} protection=${r.protection}` +
    ` source=${r.mint_source} by=${r.minted_by} expires=${receipt.expires_at}`
  );
  return receipt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads + derived state
// ─────────────────────────────────────────────────────────────────────────────

function hydrate(row) {
  if (!row) return null;
  row.options = parseJsonCol(row.options, []);
  if (!Array.isArray(row.options)) row.options = [];
  return row;
}

async function getCtaByToken(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const [[row]] = await db.query('SELECT * FROM cta_links WHERE token = ? LIMIT 1', [token]);
  return hydrate(row);
}

async function getCtaById(db, id) {
  const [[row]] = await db.query('SELECT * FROM cta_links WHERE id = ? LIMIT 1', [id]);
  return hydrate(row);
}

/**
 * The state a recipient sees. Stored: active | used | disabled | cancelled.
 * Derived: expired (expires_at ≤ now), exhausted (repeatable at max_uses).
 * Advisory only — the claim SQL decides.
 */
function deriveState(row, now = new Date()) {
  if (!row) return 'not_found';
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'disabled') return 'disabled';
  if (row.status === 'used') return 'used';
  const exp = toDate(row.expires_at);
  if (!exp || exp.getTime() <= now.getTime()) return 'expired';
  if (row.mode === 'repeatable' && row.max_uses != null && Number(row.uses_count) >= Number(row.max_uses)) {
    return 'exhausted';
  }
  return 'active';
}

/**
 * §5.2 agent descriptor — deliberately EXCLUDES name, plans, result_template.
 * §12: an option that declares inputs carries `inputs` (name, label, type,
 * required, choices, maxlen, default — never the pattern, never bindings) so
 * an agent can fill them; an input-less option's entry is unchanged.
 */
function publicDescriptor(row, now = new Date()) {
  const exp = toDate(row.expires_at);
  let usesRemaining = null;
  if (row.mode === 'once') usesRemaining = Number(row.uses_count) > 0 ? 0 : 1;
  else if (row.max_uses != null) usesRemaining = Math.max(0, Number(row.max_uses) - Number(row.uses_count));
  return {
    prompt: row.prompt,
    options: (row.options || []).map((o) => (Array.isArray(o.inputs) && o.inputs.length
      ? { value: o.value, label: o.label, inputs: publicInputs(o.inputs) }
      : { value: o.value, label: o.label })),
    mode: row.mode,
    protection: row.protection,
    expires_at: exp ? exp.toISOString() : null,
    uses_remaining: usesRemaining,
    status: deriveState(row, now),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SU reads (routes/api.cta.js) — the ONLY surfaces that see plans and the
// full plan_result. Never password_hash, anywhere.
// ─────────────────────────────────────────────────────────────────────────────

const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const EXEC_LIST_DEFAULT = 100;
const EXEC_LIST_MAX = 500;
const STORED_STATUSES = ['active', 'used', 'disabled', 'cancelled'];

const LIST_COLS = [
  'id', 'token', 'name', 'mode', 'status', 'protection', 'options', 'max_uses', 'uses_count',
  'expires_at', 'timeout_option', 'failed_attempts', 'return_plan_result', 'attributed_user_id',
  'mint_source', 'source_execution_id', 'minted_by', 'link_type', 'link_id', 'created_at', 'updated_at',
].map((c) => `l.${c}`).join(', ');

/** SU-side view of a full link row: everything but password_hash, plus the derived state. */
function adminRow(row, now = new Date()) {
  if (!row) return null;
  const { password_hash: _omit, ...rest } = row;
  return { ...rest, state: deriveState(row, now) };
}

/**
 * List links, newest first, with execution counts. `status` filters the
 * STORED status (expired/exhausted are derived — read `state`). Options are
 * summarized ({value, label, steps:[fn…]}) — the plans' params stay out of
 * the list; the full row comes back from PATCH and the executions read.
 */
async function listCtas(db, { status = null, limit = LIST_DEFAULT, offset = 0 } = {}, { now = new Date() } = {}) {
  if (status != null && status !== '' && !STORED_STATUSES.includes(status)) {
    throw bad(`status filter must be one of ${STORED_STATUSES.join(', ')}`);
  }
  const lim = Math.min(posInt(limit) || LIST_DEFAULT, LIST_MAX);
  const offN = Number(offset);
  const off = Number.isInteger(offN) && offN >= 0 ? offN : 0;
  const filtered = status != null && status !== '';
  const [rows] = await db.query(
    `SELECT ${LIST_COLS},
            (SELECT COUNT(*) FROM cta_executions e WHERE e.cta_id = l.id) AS exec_count,
            (SELECT COUNT(*) FROM cta_executions e WHERE e.cta_id = l.id AND e.status = 'failed') AS failed_count,
            (SELECT MAX(e.executed_at) FROM cta_executions e WHERE e.cta_id = l.id) AS last_executed_at
       FROM cta_links l
       ${filtered ? 'WHERE l.status = ?' : ''}
      ORDER BY l.id DESC
      LIMIT ? OFFSET ?`,
    filtered ? [status, lim, off] : [lim, off]
  );
  return rows.map((r) => {
    const opts = parseJsonCol(r.options, []);
    return {
      ...r,
      options: (Array.isArray(opts) ? opts : []).map((o) => ({
        value: o && o.value,
        label: o && o.label,
        steps: Array.isArray(o && o.plan) ? o.plan.map((st) => st && st.fn) : [],
      })),
      exec_count: Number(r.exec_count || 0),
      failed_count: Number(r.failed_count || 0),
      state: deriveState(r, now),
    };
  });
}

/** Every execution of one link, newest first — the one surface with the full plan_result (B5). */
async function listExecutions(db, id, { limit = EXEC_LIST_DEFAULT } = {}, { now = new Date() } = {}) {
  const ctaId = posInt(id);
  if (ctaId == null) throw bad('invalid CTA id');
  const row = await getCtaById(db, ctaId);
  if (!row) throw new CtaError(404, `cta: CTA ${ctaId} not found`);
  const lim = Math.min(posInt(limit) || EXEC_LIST_DEFAULT, EXEC_LIST_MAX);
  const [rows] = await db.query(
    `SELECT id, cta_id, option_value, status, plan_result, inputs, responded_via,
            responder_user_id, responder_ip, executed_at
       FROM cta_executions
      WHERE cta_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [ctaId, lim]
  );
  return {
    cta: adminRow(row, now),
    // inputs (§12 Audit): the normalized values the plan ran with — SU-only,
    // same exposure posture as plan_result.
    executions: rows.map((e) => ({ ...e, plan_result: parseJsonCol(e.plan_result, null), inputs: parseJsonCol(e.inputs, null) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity checks
// ─────────────────────────────────────────────────────────────────────────────

/** B1: su mints refuse once minted_by is no longer an active SU. */
async function isActiveSuperuser(db, userId) {
  const { isSuperuser } = require('../lib/auth.superuser'); // single source of truth for "SU"
  const [[u]] = await db.query('SELECT user_auth FROM users WHERE `user` = ?', [userId]);
  return !!u && isSuperuser({ type: 'jwt', user_auth: u.user_auth });
}

async function minterAllowed(db, row) {
  if (row.mint_source !== 'su') return true;
  return isActiveSuperuser(db, row.minted_by);
}

async function recordFailedPassword(db, row) {
  await db.query('UPDATE cta_links SET failed_attempts = failed_attempts + 1 WHERE id = ?', [row.id]);
  const [[r]] = await db.query('SELECT failed_attempts FROM cta_links WHERE id = ?', [row.id]);
  const n = Number(r?.failed_attempts || 0);
  // Threshold alerts, once each per CTA (dedup_key). warning records only
  // (alert_email_min_severity='error') — by design; error emails IT. No
  // auto-disable: an attacker must not be able to kill a live link.
  if (n >= PW_WARN_AT) {
    await alertSafe({
      source: 'cta', kind: 'password_failures', group_key: `cta:${row.id}`, severity: 'warning',
      title: `CTA #${row.id} "${row.name}": ${PW_WARN_AT}+ wrong passwords`,
      message: `failed_attempts=${n}. Rate-limited per token+IP; the link stays live.`,
      ref_table: 'cta_links', ref_id: row.id, dedup_key: `cta:${row.id}:pw${PW_WARN_AT}`,
    }, db);
  }
  if (n >= PW_ERROR_AT) {
    await alertSafe({
      source: 'cta', kind: 'password_failures', group_key: `cta:${row.id}`, severity: 'error',
      title: `CTA #${row.id} "${row.name}": ${PW_ERROR_AT}+ wrong passwords`,
      message: `failed_attempts=${n}. Consider PATCH status=disabled or cancelled.`,
      ref_table: 'cta_links', ref_id: row.id, dedup_key: `cta:${row.id}:pw${PW_ERROR_AT}`,
    }, db);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim + plan runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `claimSql` and, only if it wins, insert the 'running' execution row —
 * one transaction (pure DB; withTransaction's single retry is safe). Returns
 * the execution id, or null when the claim lost.
 */
async function claimAndOpen(db, claimSql, row, { optionValue, via, responderUserId, ip, inputs = null }) {
  return db.withTransaction(async (conn) => {
    const [upd] = await conn.query(claimSql, [row.id]);
    if (!upd || !upd.affectedRows) return null;
    const base = [row.id, optionValue, via, responderUserId ?? null, ip ?? null];
    const [ins] = inputs == null
      ? await conn.query(EXEC_INSERT_SQL, base)
      : await conn.query(EXEC_INSERT_INPUTS_SQL, [...base, JSON.stringify(inputs)]);
    return ins.insertId;
  });
}

/** §4 runtime guard: a result coupled to engine timing/jumps. */
function guardTrip(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.delayed_until != null) return 'delayed_until';
  if (res.next_step !== undefined) return 'next_step';
  if (res.nextStep !== undefined) return 'nextStep';
  return null;
}

/**
 * Execute a claimed option's plan. The execution row already exists
 * ('running'). Never throws for plan failures — a failed plan is a recorded
 * outcome. Returns { status, steps, outputs, failedAt, error }.
 */
async function runPlan(db, plan) {
  const reg = registry();
  const steps = [];
  const outputs = [];
  for (let i = 0; i < plan.length; i++) {
    const { fn, params } = plan[i] || {};
    const t0 = Date.now();
    if (!isCtaEligible(fn, reg)) {
      // Click-time re-check: a function removed from the registry or added
      // to the denylist after mint must not run on an old link.
      const error = `function "${fn}" is not CTA-eligible at run time`;
      steps.push({ fn, ok: false, error, ms: 0 });
      return { status: 'failed', steps, outputs, failedAt: i + 1, error };
    }
    let res;
    try {
      // Fresh copy: a function that mutates its params must not mutate the
      // stored plan of a repeatable link mid-process.
      res = await reg[fn](JSON.parse(JSON.stringify(params || {})), db);
    } catch (err) {
      const error = truncateText(err && err.message ? err.message : String(err));
      steps.push({ fn, ok: false, error, ms: Date.now() - t0 });
      return { status: 'failed', steps, outputs, failedAt: i + 1, error };
    }
    const took = Date.now() - t0;
    const tripped = guardTrip(res);
    if (tripped) {
      const error = `runtime guard: "${fn}" returned ${tripped} — engine-coupled timing/flow is not supported in CTA plans`;
      steps.push({ fn, ok: false, error, ms: took });
      return { status: 'failed', steps, outputs, failedAt: i + 1, error };
    }
    if (res && res.success === false) {
      const error = truncateText(res.error || res.message || 'step returned success:false');
      steps.push({ fn, ok: false, error, output: truncateOutput(res.output), ms: took });
      return { status: 'failed', steps, outputs, failedAt: i + 1, error };
    }
    const output = res && typeof res === 'object' ? res.output : undefined;
    outputs.push(output);
    // set_vars is ignored — no variable context (chaining is v2, §9).
    steps.push({ fn, ok: true, output: truncateOutput(output), ms: took });
  }
  return { status: 'success', steps, outputs, failedAt: null, error: null };
}

/** One log row per execution (mirrors logDecisionOutcome). Best-effort. */
async function logOutcome(db, row, option, { executionId, status, via, responderUserId }) {
  try {
    const logService = require('./logService');
    const by = via === 'timeout' ? 0 : (responderUserId || row.attributed_user_id || 0);
    const entry = {
      type: 'note',
      by,
      subject: 'CTA',
      message:
        `CTA "${String(row.name).slice(0, 120)}" — ${via === 'timeout' ? 'no response by deadline; auto-ran' : 'chose'}` +
        ` "${option.label}" (${option.value}) via ${via} → ${status} (execution #${executionId})`,
      data: {
        cta_id: row.id,
        cta_execution_id: executionId,
        option_value: option.value,
        status,
        via,
      },
    };
    if (row.link_type && row.link_id) {
      entry.link_type = row.link_type;
      entry.link_id = row.link_id;
    }
    await logService.createLogEntry(db, entry);
  } catch (err) {
    console.warn(`[CTA] outcome log failed for execution ${executionId}:`, err.message);
  }
}

/**
 * Run the plan for an already-opened execution and finalize everything:
 * execution row, outcome log, IT alert on failure, rendered result.
 * `plan` is the prepareRun() output (bindings substituted); `inputValues` the
 * normalized input map for [[input:x]] in result_template (null: no inputs).
 */
async function executeOpened(db, row, option, { executionId, via, responderUserId, plan = null, inputValues = null }) {
  let run;
  try {
    run = await runPlan(db, plan || option.plan || []);
  } catch (err) {
    // runPlan does not throw for plan failures; this is infrastructure.
    run = { status: 'failed', steps: [], outputs: [], failedAt: null, error: truncateText(err.message) };
  }

  try {
    await db.query(
      `UPDATE cta_executions SET status = ?, plan_result = ? WHERE id = ? AND status = 'running'`,
      [run.status, JSON.stringify(run.steps), executionId]
    );
  } catch (err) {
    // The row stays 'running' — the sweep's stale warning surfaces it.
    console.error(`[CTA] could not finalize execution ${executionId}:`, err.message);
  }

  await logOutcome(db, row, option, { executionId, status: run.status, via, responderUserId });

  if (run.status === 'failed') {
    const step = run.failedAt ? run.steps[run.failedAt - 1] : null;
    await alertSafe({
      source: 'cta',
      kind: 'plan_failed',
      group_key: `cta:${row.id}`,
      severity: 'error',
      title: `CTA #${row.id} "${String(row.name).slice(0, 120)}" plan failed` +
        (step ? ` at step ${run.failedAt} (${step.fn})` : ''),
      message: run.error,
      context: { cta_id: row.id, execution_id: executionId, option_value: option.value, via },
      ref_table: 'cta_executions',
      ref_id: executionId,
    }, db);
  }

  console.log(`[CTA] #${row.id} option=${option.value} via=${via} → ${run.status} (execution ${executionId})`);

  const result = {
    status: run.status,
    execution_id: executionId,
    plan_result: run.steps,
  };
  if (run.status === 'success' && option.result_template) {
    const rendered = renderResultTemplate(option.result_template, run.outputs, inputValues);
    result.result = rendered.text;
    result.result_html = rendered.html;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// respond — the click path (link / app / api)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns either
 *   { ok: false, code }  — not_found | cancelled | disabled | used | expired |
 *                          exhausted | unknown_option | minter_inactive |
 *                          password_required | bad_password | conflict |
 *                          refused (+ reason: binding_closed | recipient_type |
 *                          unbounded_recipient — linkRefusal; public: disabled)
 *   { ok: false, code: 'invalid_inputs', errors, form_error? }  (§12) —
 *                          errors: { <input name>: generic message }; nothing
 *                          was claimed, counted or run
 *   { ok: true, status: 'success'|'failed', execution_id,
 *     result?, result_html?, plan_result? }
 * plan_result is included only for return_plan_result=1 CTAs (B5); result /
 * result_html only after a successful plan whose option has a template.
 * `inputs` (§12): the clicker's values — a plain object of name → value, or
 * undefined. Validated AFTER the password and BEFORE the claim.
 */
async function respond(db, { token, row: givenRow, value, password, inputs, via = 'link', responderUserId = null, ip = null } = {}) {
  if (!VIA_VALUES.has(via)) throw new CtaError(400, `cta: invalid via "${via}"`);
  const row = givenRow || await getCtaByToken(db, token);
  if (!row) return { ok: false, code: 'not_found' };

  const state = deriveState(row);
  if (state !== 'active') return { ok: false, code: state };

  const option = row.options.find((o) => o && o.value === value);
  if (!option) return { ok: false, code: 'unknown_option' };

  if (!(await minterAllowed(db, row))) return { ok: false, code: 'minter_inactive' };

  // Link-level refusal (S1i review B1/N2) — the same check the GET pages
  // make, so the POST never runs what the page didn't offer.
  const refusal = await linkBlocked(db, row);
  if (refusal) return { ok: false, code: 'refused', reason: refusal.reason };

  // Password BEFORE the claim / increment (§6).
  if (row.protection === 'password') {
    if (typeof password !== 'string' || password === '') return { ok: false, code: 'password_required' };
    const okPw = !!row.password_hash && await bcrypt.compare(password, row.password_hash);
    if (!okPw) {
      await recordFailedPassword(db, row);
      return { ok: false, code: 'bad_password' };
    }
  }

  // §12 inputs: AFTER the password (no caller without the secret reaches a
  // pattern or the validators) and BEFORE the claim (a bad value never burns
  // a single-use link or a repeatable use).
  const prep = prepareRun(option, inputs);
  if (!prep.ok) {
    // Unreachable while linkRefusal covers every binding problem — kept so
    // the click path can never run a binding the refusal check missed.
    if (prep.code === 'binding_closed') return { ok: false, code: 'refused', reason: 'binding_closed' };
    const out = { ok: false, code: 'invalid_inputs', errors: { ...prep.errors } };
    if (prep.formError) out.form_error = prep.formError;
    return out;
  }

  const claimSql = row.mode === 'repeatable' ? INCREMENT_SQL : CLAIM_ONCE_SQL;
  const executionId = await claimAndOpen(db, claimSql, row, {
    optionValue: option.value, via, responderUserId, ip, inputs: prep.values,
  });
  if (!executionId) {
    const fresh = await getCtaById(db, row.id);
    const s = deriveState(fresh);
    // Lost to a concurrent claim/increment between the read and the UPDATE.
    return { ok: false, code: s === 'active' ? 'conflict' : s };
  }

  const run = await executeOpened(db, row, option, {
    executionId, via, responderUserId, plan: prep.plan, inputValues: prep.values,
  });
  const out = { ok: true, status: run.status, execution_id: run.execution_id };
  if (run.result !== undefined) {
    out.result = run.result;
    out.result_html = run.result_html;
  }
  if (Number(row.return_plan_result) === 1) out.plan_result = run.plan_result;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry sweep (cta_expiry_sweep)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Over due rows: claim FIRST (TIMEOUT_CLAIM_SQL), run the timeout_option plan
 * only on affectedRows=1 (by=0, responded_via='timeout'). Overlapping sweeps
 * are benign by construction. Then warn on stale 'running' executions.
 *
 * Kill switch: an su-minted CTA whose minter is no longer an active SU is
 * still CLAIMED (so it can never fire later by surprise if the account is
 * re-enabled) but its plan does not run — the execution is recorded failed.
 * The same claim-then-record-failed path covers a timeout option whose input
 * DEFAULTS no longer pass the pipeline (§12) — e.g. a param closed since mint —
 * and any link linkRefusal() refuses (the public pages read "unavailable", so
 * the sweep must not fire it either).
 */
async function sweepExpired(db, { limit = DEFAULT_SWEEP_LIMIT } = {}) {
  const lim = Math.min(Math.max(posInt(limit) || DEFAULT_SWEEP_LIMIT, 1), 500);
  const summary = { due: 0, claimed: 0, success: 0, failed: 0, blocked: 0, lost: 0, errors: 0, stale_running: 0, executions: [] };

  const [due] = await db.query(
    `SELECT id FROM cta_links
      WHERE status = 'active' AND mode = 'once' AND uses_count = 0
        AND timeout_option IS NOT NULL AND expires_at <= NOW()
      ORDER BY expires_at
      LIMIT ?`,
    [lim]
  );
  summary.due = due.length;

  for (const { id } of due) {
    try {
      const row = await getCtaById(db, id);
      if (!row) { summary.lost++; continue; }
      const option = row.options.find((o) => o && o.value === row.timeout_option);
      // §12: no clicker — the defaults (mint guaranteed one per input) go
      // through the same pipeline a click does. Pure; prepared before the
      // claim so the execution row records the values it will run with.
      const prep = option ? prepareRun(option, null) : null;
      const executionId = await claimAndOpen(db, TIMEOUT_CLAIM_SQL, row, {
        optionValue: row.timeout_option, via: 'timeout', responderUserId: null, ip: null,
        inputs: prep && prep.ok ? prep.values : null,
      });
      if (!executionId) { summary.lost++; continue; }   // a click, a PATCH, or another sweep got there first
      summary.claimed++;

      let error = null;   // why the claimed timeout is recorded failed WITHOUT running its plan
      if (!option) error = `timeout_option "${row.timeout_option}" matches no option`;
      else if (!(await minterAllowed(db, row))) error = 'minting superuser is no longer active — timeout plan not run';
      else if (!prep.ok) {
        error = prep.code === 'binding_closed'
          ? `an input binding is no longer open (${prep.error}) — timeout plan not run`
          : `the timeout defaults failed input validation (${Object.keys(prep.errors || {}).join(', ') || prep.formError}) — timeout plan not run`;
      } else {
        // The link-level refusal (S1i re-review G1): a link the public pages
        // show as "unavailable" — e.g. a SIBLING option's binding closed or
        // retyped since mint — must not fire its timeout plan either.
        const refusal = linkRefusal(row);
        if (refusal) error = `link refused (${refusal.reason}: ${refusal.detail}) — timeout plan not run`;
      }
      if (error) {
        await db.query(
          `UPDATE cta_executions SET status = 'failed', plan_result = ? WHERE id = ? AND status = 'running'`,
          [JSON.stringify([{ fn: null, ok: false, error, ms: 0 }]), executionId]
        );
        await alertSafe({
          source: 'cta', kind: 'timeout_blocked', group_key: `cta:${row.id}`, severity: 'warning',
          title: `CTA #${row.id} "${String(row.name).slice(0, 120)}" timeout not run`,
          message: error, ref_table: 'cta_executions', ref_id: executionId,
        }, db);
        await logOutcome(db, row, option || { value: row.timeout_option, label: row.timeout_option },
          { executionId, status: 'failed', via: 'timeout', responderUserId: null });
        summary.blocked++;
        summary.executions.push({ cta_id: row.id, execution_id: executionId, status: 'failed', blocked: true });
        continue;
      }

      const run = await executeOpened(db, row, option, {
        executionId, via: 'timeout', responderUserId: null, plan: prep.plan, inputValues: prep.values,
      });
      summary[run.status === 'success' ? 'success' : 'failed']++;
      summary.executions.push({ cta_id: row.id, execution_id: executionId, status: run.status });
    } catch (err) {
      summary.errors++;
      console.error(`[CTA SWEEP] CTA ${id} failed:`, err.message);
    }
  }

  const [stale] = await db.query(
    `SELECT e.id, e.cta_id, e.option_value, e.executed_at
       FROM cta_executions e
      WHERE e.status = 'running'
        AND e.executed_at < NOW() - INTERVAL ${STALE_RUNNING_MINUTES} MINUTE`
  );
  summary.stale_running = stale.length;
  for (const e of stale) {
    await alertSafe({
      source: 'cta', kind: 'execution_stale', group_key: `cta:${e.cta_id}`, severity: 'warning',
      title: `CTA #${e.cta_id} execution ${e.id} still running after ${STALE_RUNNING_MINUTES} min`,
      message: `Option "${e.option_value}" started ${toDate(e.executed_at)?.toISOString() || e.executed_at} and never finalized — the instance likely died mid-plan. Check plan side effects before re-enabling.`,
      ref_table: 'cta_executions', ref_id: e.id, dedup_key: `cta_exec_stale:${e.id}`,
    }, db);
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH (§5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply an SU patch. Allowed fields: expires_at, max_uses, status.
 *
 *   active    → disabled | cancelled; extend expiry; max_uses (repeatable)
 *   disabled  → active (400 if still expired after this patch) | cancelled
 *   used      → active ONLY when the latest execution failed, OR is still
 *               'running' more than STALE_RUNNING_MINUTES after it started
 *               (S2 ruling: the instance died mid-plan — the sweep has been
 *               warning about it). The stale row is finalized 'failed'
 *               FIRST (guarded on status='running', so a plan that finishes
 *               in the meantime wins and is judged on its real outcome).
 *               Resets uses_count=0 and the next click re-runs the WHOLE
 *               plan (check plan_result / side effects first); → cancelled.
 *               Anything else is 409: the link is already claimed.
 *   cancelled → 409 always (R8: permanent).
 *
 * Every UPDATE is guarded on the status read here: losing a race to a
 * click/sweep claim is 409, never an overwrite. All 400s are decided before
 * any write. Returns { before, after, changed } — plus
 * finalized_execution_id when a stale run was closed — for the caller's
 * admin_audit_log row.
 */
async function patchCta(db, id, patch, { now = new Date() } = {}) {
  const ctaId = posInt(id);
  if (ctaId == null) throw bad('invalid CTA id');
  if (!isPlainObject(patch)) throw bad('patch body must be a JSON object');
  rejectUnknownKeys(patch, PATCH_KEYS, 'patch');
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('nothing to change — give expires_at, max_uses and/or status');

  const before = await getCtaById(db, ctaId);
  if (!before) throw new CtaError(404, `cta: CTA ${ctaId} not found`);
  if (before.status === 'cancelled') {
    throw new CtaError(409, 'cta: a cancelled CTA is permanent and cannot be changed', 'cancelled');
  }

  const sets = [];
  const params = [];
  let newExpires = toDate(before.expires_at);

  if (hasOwn(patch, 'expires_at')) {
    newExpires = parseExpiresAt(patch.expires_at);
    checkExpiryWindow(newExpires, now);
    sets.push('expires_at = ?');
    params.push(newExpires);
  }

  if (hasOwn(patch, 'max_uses')) {
    if (before.mode !== 'repeatable') throw bad('max_uses applies to mode=repeatable only');
    if (patch.max_uses === null) {
      // §12 hard rule, enforced here too (S1i review B1): the pane's "No cap"
      // checkbox must not undo what the mint refused.
      if (hasRecipientBinding(before.options)) {
        throw bad('max_uses cannot be removed: this link takes a clicker-supplied recipient (§12 hard rule — a repeatable open-recipient link always has a cap)');
      }
      sets.push('max_uses = NULL');
    } else {
      const n = posInt(patch.max_uses);
      if (n == null) throw bad('max_uses must be a positive integer or null');
      if (n < Number(before.uses_count)) {
        throw bad(`max_uses ${n} is below uses_count ${before.uses_count}`);
      }
      sets.push('max_uses = ?');
      params.push(n);
    }
  }

  let target = before.status;
  if (hasOwn(patch, 'status')) {
    target = patch.status;
    if (!['active', 'disabled', 'cancelled'].includes(target)) {
      throw bad("status must be 'active', 'disabled' or 'cancelled'");
    }
  }

  const expiredAfter = !newExpires || newExpires.getTime() <= now.getTime();
  let extraGuard = '';
  let staleExecutionId = null;   // a dead 'running' row to finalize before re-enabling

  if (before.status === 'used') {
    if (target === 'cancelled') {
      // permanent kill of a spent link — fine
    } else if (target === 'active') {
      const latest = await latestExecution(db, ctaId);
      const stale = isStaleRunning(latest, now);
      if (!latest || (latest.status !== 'failed' && !stale)) {
        throw new CtaError(409,
          `cta: re-enable from used requires the latest execution to have failed, or to be stuck running over ${STALE_RUNNING_MINUTES} min` +
          ` (it is ${latest ? latest.status : 'missing'})`,
          'not_reenableable');
      }
      if (expiredAfter) throw bad('the link is expired — extend expires_at in the same PATCH to re-enable it');
      if (stale) staleExecutionId = latest.id;
      sets.push('uses_count = 0');
      extraGuard = ' AND uses_count = ?';
    } else {
      throw new CtaError(409, 'cta: this single-use link was already claimed — re-enable (after a failed run) or cancel it', 'claimed');
    }
  } else if (before.status === 'disabled' && target === 'active') {
    if (expiredAfter) throw bad('the link is expired — extend expires_at in the same PATCH to re-enable it');
  }

  if (target !== before.status) {
    sets.push('status = ?');
    params.push(target);
  }
  if (!sets.length) {
    return { before, after: before, changed: false };
  }

  if (staleExecutionId != null) {
    // Finalize the dead run BEFORE the re-enable write. Guarded on 'running':
    // if the plan finished between the read above and here, its own finalize
    // won — re-read and let only a real failure through.
    const [fin] = await db.query(
      `UPDATE cta_executions SET status = 'failed', plan_result = ? WHERE id = ? AND status = 'running'`,
      [JSON.stringify([{ fn: null, ok: false, error: STALE_FINALIZE_ERROR, ms: 0 }]), staleExecutionId]
    );
    if (!fin || !fin.affectedRows) {
      const again = await latestExecution(db, ctaId);
      if (!again || again.id !== staleExecutionId || again.status !== 'failed') {
        throw new CtaError(409,
          `cta: execution ${staleExecutionId} finished while this PATCH was applied (now ${again ? again.status : 'missing'}) — re-read and retry`,
          'not_reenableable');
      }
      staleExecutionId = null;   // it failed on its own — nothing of ours to report
    }
  }

  const guardParams = [ctaId, before.status];
  if (extraGuard) guardParams.push(Number(before.uses_count));
  const [upd] = await db.query(
    `UPDATE cta_links SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND status = ?${extraGuard}`,
    [...params, ...guardParams]
  );
  if (!upd || !upd.affectedRows) {
    // A finalized stale row stays 'failed' — it was dead either way.
    throw new CtaError(409, 'cta: the link changed while this PATCH was applied (claimed or edited) — re-read and retry', 'conflict');
  }
  const after = await getCtaById(db, ctaId);
  const out = { before, after, changed: true };
  if (staleExecutionId != null) out.finalized_execution_id = staleExecutionId;
  return out;
}

/** The newest execution of a CTA (or undefined). */
async function latestExecution(db, ctaId) {
  const [[latest]] = await db.query(
    'SELECT id, status, executed_at FROM cta_executions WHERE cta_id = ? ORDER BY id DESC LIMIT 1',
    [ctaId]
  );
  return latest;
}

/** A 'running' row older than STALE_RUNNING_MINUTES — the sweep's "instance died mid-plan" test. */
function isStaleRunning(exec, now = new Date()) {
  if (!exec || exec.status !== 'running') return false;
  const at = toDate(exec.executed_at);
  return !!at && now.getTime() - at.getTime() > STALE_RUNNING_MINUTES * 60e3;
}

module.exports = {
  // surfaces
  mintCta,
  validateMint,
  respond,
  patchCta,
  sweepExpired,
  publicDescriptor,
  getCtaByToken,
  getCtaById,
  deriveState,
  minterAllowed,
  // SU reads (routes/api.cta.js)
  listCtas,
  listExecutions,
  adminRow,
  isStaleRunning,
  // eligibility
  isCtaEligible,
  eligibleFunctionNames,
  CTA_FN_DENYLIST,
  // result_template
  renderResultTemplate,
  validateResultTemplate,
  // §12 clicker inputs
  CTA_RISKS,
  INPUT_TYPES,
  openedParamSpec,
  openedInputParams,
  linkRefusal,
  linkBlocked,
  hasRecipientBinding,
  validateInputValue,
  prepareRun,
  linearRegexAvailable,
  publicInputs,
  // runner internals (exported for tests and S3)
  runPlan,
  guardTrip,
  CtaError,
  CLAIM_ONCE_SQL,
  INCREMENT_SQL,
  TIMEOUT_CLAIM_SQL,
  STEP_OUTPUT_MAX,
  STALE_RUNNING_MINUTES,
  PW_WARN_AT,
  PW_ERROR_AT,
};
