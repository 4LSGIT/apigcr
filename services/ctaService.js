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
]);
const OPTION_KEYS = new Set(['value', 'label', 'plan', 'confirm_text', 'result_template']);
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
function validateResultTemplate(tpl, planLength, label) {
  let m;
  RESULT_TOKEN_RE.lastIndex = 0;
  while ((m = RESULT_TOKEN_RE.exec(tpl)) !== null) {
    const ref = RESULT_REF_RE.exec(m[1]);
    if (!ref) {
      throw bad(`${label}.result_template: unsupported token [[${m[1]}]] — use [[N.output]] or [[N.output.path]]`);
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
 */
function renderResultTemplate(tpl, outputs) {
  const text = String(tpl).replace(RESULT_TOKEN_RE, (_, inner) => {
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
// Mint validation
// ─────────────────────────────────────────────────────────────────────────────

function validatePlan(plan, label, reg) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_PLAN_STEPS) {
    throw bad(`${label}.plan must be an array of 1–${MAX_PLAN_STEPS} {fn, params} steps`);
  }
  return plan.map((step, i) => {
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

    const err = reg.__validateFunctionParams(step.fn, params);
    if (err) throw bad(`${sl} (${step.fn}): ${err.error}`);

    // Round-trip: the stored plan is exactly what JSON can carry.
    return { fn: step.fn, params: JSON.parse(JSON.stringify(params)) };
  });
}

function validateOptions(raw, reg) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPTIONS) {
    throw bad(`options must be an array of 1–${MAX_OPTIONS} options`);
  }
  const seen = new Set();
  return raw.map((o, i) => {
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

    const plan = validatePlan(o.plan, ol, reg);
    const out = { value, label, plan };

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
      validateResultTemplate(t, plan.length, ol);
      out.result_template = t;
    }
    return out;
  });
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

  const options = validateOptions(input.options, reg);
  const values = new Set(options.map((o) => o.value));

  let timeoutOption = null;
  if (input.timeout_option != null && input.timeout_option !== '') {
    if (mode !== 'once') throw bad('timeout_option applies to mode=once only');
    if (typeof input.timeout_option !== 'string' || !values.has(input.timeout_option)) {
      throw bad(`timeout_option "${input.timeout_option}" is not one of the option values`);
    }
    timeoutOption = input.timeout_option;
  }

  const expiresAt = await resolveExpiry(db, input, mode, now);

  // ── Protection (§2.11, NB2) ───────────────────────────────────────────
  const hasTemplate = options.some((o) => o.result_template);
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
    options: r.options.map((o) => ({ value: o.value, label: o.label })),
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

/** §5.2 agent descriptor — deliberately EXCLUDES name, plans, result_template. */
function publicDescriptor(row, now = new Date()) {
  const exp = toDate(row.expires_at);
  let usesRemaining = null;
  if (row.mode === 'once') usesRemaining = Number(row.uses_count) > 0 ? 0 : 1;
  else if (row.max_uses != null) usesRemaining = Math.max(0, Number(row.max_uses) - Number(row.uses_count));
  return {
    prompt: row.prompt,
    options: (row.options || []).map((o) => ({ value: o.value, label: o.label })),
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
    `SELECT id, cta_id, option_value, status, plan_result, responded_via,
            responder_user_id, responder_ip, executed_at
       FROM cta_executions
      WHERE cta_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [ctaId, lim]
  );
  return {
    cta: adminRow(row, now),
    executions: rows.map((e) => ({ ...e, plan_result: parseJsonCol(e.plan_result, null) })),
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
async function claimAndOpen(db, claimSql, row, { optionValue, via, responderUserId, ip }) {
  return db.withTransaction(async (conn) => {
    const [upd] = await conn.query(claimSql, [row.id]);
    if (!upd || !upd.affectedRows) return null;
    const [ins] = await conn.query(
      `INSERT INTO cta_executions
         (cta_id, option_value, status, responded_via, responder_user_id, responder_ip)
       VALUES (?, ?, 'running', ?, ?, ?)`,
      [row.id, optionValue, via, responderUserId ?? null, ip ?? null]
    );
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
 */
async function executeOpened(db, row, option, { executionId, via, responderUserId }) {
  let run;
  try {
    run = await runPlan(db, option.plan || []);
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
    const rendered = renderResultTemplate(option.result_template, run.outputs);
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
 *                          password_required | bad_password | conflict
 *   { ok: true, status: 'success'|'failed', execution_id,
 *     result?, result_html?, plan_result? }
 * plan_result is included only for return_plan_result=1 CTAs (B5); result /
 * result_html only after a successful plan whose option has a template.
 */
async function respond(db, { token, row: givenRow, value, password, via = 'link', responderUserId = null, ip = null } = {}) {
  if (!VIA_VALUES.has(via)) throw new CtaError(400, `cta: invalid via "${via}"`);
  const row = givenRow || await getCtaByToken(db, token);
  if (!row) return { ok: false, code: 'not_found' };

  const state = deriveState(row);
  if (state !== 'active') return { ok: false, code: state };

  const option = row.options.find((o) => o && o.value === value);
  if (!option) return { ok: false, code: 'unknown_option' };

  if (!(await minterAllowed(db, row))) return { ok: false, code: 'minter_inactive' };

  // Password BEFORE the claim / increment (§6).
  if (row.protection === 'password') {
    if (typeof password !== 'string' || password === '') return { ok: false, code: 'password_required' };
    const okPw = !!row.password_hash && await bcrypt.compare(password, row.password_hash);
    if (!okPw) {
      await recordFailedPassword(db, row);
      return { ok: false, code: 'bad_password' };
    }
  }

  const claimSql = row.mode === 'repeatable' ? INCREMENT_SQL : CLAIM_ONCE_SQL;
  const executionId = await claimAndOpen(db, claimSql, row, {
    optionValue: option.value, via, responderUserId, ip,
  });
  if (!executionId) {
    const fresh = await getCtaById(db, row.id);
    const s = deriveState(fresh);
    // Lost to a concurrent claim/increment between the read and the UPDATE.
    return { ok: false, code: s === 'active' ? 'conflict' : s };
  }

  const run = await executeOpened(db, row, option, { executionId, via, responderUserId });
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
      const executionId = await claimAndOpen(db, TIMEOUT_CLAIM_SQL, row, {
        optionValue: row.timeout_option, via: 'timeout', responderUserId: null, ip: null,
      });
      if (!executionId) { summary.lost++; continue; }   // a click, a PATCH, or another sweep got there first
      summary.claimed++;

      if (!option || !(await minterAllowed(db, row))) {
        const error = !option
          ? `timeout_option "${row.timeout_option}" matches no option`
          : 'minting superuser is no longer active — timeout plan not run';
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

      const run = await executeOpened(db, row, option, { executionId, via: 'timeout', responderUserId: null });
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
