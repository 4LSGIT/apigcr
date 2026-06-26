// lib/internal_functions.js
const ms = require('ms');
const phoneService   = require('../services/phoneService');
const emailService   = require('../services/emailService');
const contactService = require('../services/contactService');
const { parseUserDateTime }       = require('../services/timezoneService');
const { getSetting }              = require('../services/settingsService');
const { buildHeadersForCredential } = require('./credentialInjection');
// NOTE: sequenceEngine is NOT required here — circular dependency with job_executor.
// Instead, require it lazily inside cancel_sequences and enroll_sequence.

// NOTE: phoneIngestService is lazy-required INSIDE phone_log, matching this
// file's circular-dep-safety convention for logService / sequenceEngine /
// apptService. phoneIngestService owns the phone-event pipeline (extracted
// from the old inline phone_log body) plus the firm-number cache. Do NOT add
// a module-scope require for it.
//
// The firm-number cache (formerly _firmNumberCache / _getFirmNumbers /
// _phoneLogNorm10 / _resetFirmNumberCache here) moved to
// services/phoneIngestService.js with the pipeline. The public
// internalFunctions.__resetFirmNumberCache handle is preserved at the bottom
// of this file, re-pointed at phoneIngestService.resetFirmNumberCache.

// ─────────────────────────────────────────────────────────────
// Timing helpers (used by schedule_resume / wait_for)
// ─────────────────────────────────────────────────────────────

/**
 * Apply symmetric ±N minute jitter to an ISO timestamp string. Mirrors
 * lib/sequenceEngine.applyRandomJitter and the calendar service. We keep
 * the workflow side as a separate function (rather than importing from
 * sequenceEngine) to avoid a new circular-dependency surface.
 *
 * @param {string} iso  — ISO datetime string
 * @param {number?} randomizeMinutes
 * @returns {string} ISO datetime string (possibly the same as input)
 */
function applyJitterIso(iso, randomizeMinutes) {
  const n = Number(randomizeMinutes) || 0;
  if (n <= 0) return iso;
  const jitter = Math.floor(Math.random() * (n * 2 + 1)) - n;
  return new Date(new Date(iso).getTime() + jitter * 60 * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────
// query_db security config
// ─────────────────────────────────────────────────────────────

const QUERY_DB_ALLOWED_TABLES = new Set([
  'contacts', 'cases', 'appts', 'tasks', 'log',
  'users', 'phone_lines', 'scheduled_jobs',
  'workflows', 'workflow_executions', 'workflow_execution_steps',
  'sequence_templates', 'sequence_steps', 'sequence_enrollments', 'sequence_step_log',
  'case_relate',
  'judges', 'trustees',
  'checkitems', 'checklists',
  'job_results',
  // NOTE: cases.case_judge and cases.case_trustee are varchar columns on cases —
  // join directly: ON cases.case_judge = judges.judge_name
  //                ON cases.case_trustee = trustees.trustee_full_name
]);

const QUERY_DB_BLOCKED_COLUMNS = {
  users: ['password', 'password_hash'],
};

const QUERY_DB_WHERE_OPS  = new Set(['=','!=','<>','>','<','>=','<=','LIKE','NOT LIKE','IN','NOT IN','IS NULL','IS NOT NULL']);
const QUERY_DB_JOIN_TYPES = new Set(['inner','left','right','left outer','right outer']);
const QUERY_DB_ORDER_DIRS = new Set(['asc','desc']);

function _qdbValidateId(id, label) {
  if (!id || typeof id !== 'string') throw new Error(`query_db: ${label} must be a non-empty string`);
  if (!/^[\w.]+$/.test(id)) throw new Error(`query_db: invalid ${label} "${id}"`);
  return id;
}
function _qdbEscId(id) {
  return id.split('.').map(p => `\`${p}\``).join('.');
}
function _qdbValidateTable(name, label) {
  if (!QUERY_DB_ALLOWED_TABLES.has(name.trim())) throw new Error(`query_db: table "${name}" is not allowed (${label})`);
  return name.trim();
}

// ─────────────────────────────────────────────────────────────
// HELPER: evaluate a single condition against a variable map
// ─────────────────────────────────────────────────────────────
function evaluateSingle(variables, { variable, operator, value }) {
  const actual = variables[variable];

  switch (operator) {
    case '==':           return actual == value;
    case '!=':           return actual != value;
    case '>':            return Number(actual) > Number(value);
    case '<':            return Number(actual) < Number(value);
    case '>=':           return Number(actual) >= Number(value);
    case '<=':           return Number(actual) <= Number(value);
    case 'contains':     return String(actual ?? '').includes(String(value));
    case 'not_contains': return !String(actual ?? '').includes(String(value));
    case 'is_empty':     return actual == null || actual === '';
    case 'is_not_empty': return actual != null && actual !== '';
    default:
      throw new Error(`evaluate_condition: unknown operator "${operator}"`);
  }
}

// Direction normalization (Slice 4-C) was lifted to services/logService.js
// in Phase 2 so REST callers via /api/log get the same normalization that
// workflow/sequence create_log calls have always had. The semantics are
// unchanged: caller's input retains its raw value (e.g. "Outbound") for
// evaluate_condition branches; only the DB write conforms to the enum.

const internalFunctions = {

  // ─────────────────────────────────────────────────────────────
  // CONTROL FLOW
  // ─────────────────────────────────────────────────────────────

  /**
   * set_next
   * Jump to a specific step number, or use 'cancel'/'fail' to terminate.
   *
   * params:
   *   value  {number|'cancel'|'fail'|null}  — target step; null ends the workflow normally
   *
   * example config:
   *   { "function_name": "set_next", "params": { "value": 5 } }
   */
  set_next: async (params) => {
    const next = params.value;
    console.log(`[SET_NEXT] next_step = ${next}`);
    return { success: true, next_step: next };
  },

  /**
   * evaluate_condition
   * Branch to a different step based on a variable comparison.
   *
   * Simple params:
   *   variable  {string}      — variable name to test
   *   operator  {string}      — ==, !=, >, <, >=, <=, contains, not_contains, is_empty, is_not_empty
   *   value     {any}         — value to compare against (ignored for is_empty / is_not_empty)
   *   then      {number}      — next_step if condition is true
   *   else      {number|null} — next_step if false (null = continue sequentially)
   *
   * Extended params (array form, works today):
   *   conditions  [{variable, operator, value}, ...]
   *   match       "all" | "any"  (default "all")
   *   then / else same as above
   *
   * NOTE: The engine must inject _variables into params before calling this function.
   * In executeStep (workflow_engine.js), add before executeJob:
   *   if (jobData.type === 'internal_function') {
   *     jobData.params = { ...jobData.params, _variables: context.variables };
   *   }
   *
   * example config:
   *   {
   *     "function_name": "evaluate_condition",
   *     "params": {
   *       "variable": "appt_status", "operator": "==", "value": "confirmed",
   *       "then": 5, "else": 8
   *     }
   *   }
   */
  evaluate_condition: async (params) => {
    const { then: thenStep, else: elseStep = null } = params;
    const variables = params._variables || {};

    let result;

    if (Array.isArray(params.conditions)) {
      const match = params.match || 'all';
      const results = params.conditions.map(c => evaluateSingle(variables, c));
      result = match === 'any' ? results.some(Boolean) : results.every(Boolean);
    } else {
      const { variable, operator, value } = params;
      if (!variable || !operator) throw new Error('evaluate_condition requires variable and operator');
      result = evaluateSingle(variables, { variable, operator, value });
    }

    const next_step = result ? thenStep : elseStep;
    console.log(`[EVALUATE_CONDITION] result=${result} → next_step=${next_step}`);
    return { success: true, next_step };
  },

  // ─────────────────────────────────────────────────────────────
  // VARIABLE MANIPULATION
  // ─────────────────────────────────────────────────────────────

  /**
   * noop
   * Does nothing. Useful as a config-driven step that only uses
   * set_vars in the step config to set variables.
   *
   * example config:
   *   { "function_name": "noop", "params": {}, "set_vars": { "stage": "intake" } }
   */
  noop: async () => {
    console.log('[NOOP] Step executed');
    return { success: true };
  },

  /**
   * set_var
   * Explicitly set one variable to a value.
   *
   * params:
   *   name   {string}  — variable name
   *   value  {any}     — value to assign
   *
   * example config:
   *   { "function_name": "set_var", "params": { "name": "stage", "value": "intake" } }
   */
  set_var: async (params) => {
    const { name, value } = params;
    if (!name) throw new Error('set_var requires a name');
    console.log(`[SET_VAR] ${name} = ${JSON.stringify(value)}`);
    return {
      success: true,
      set_vars: { [name]: value }
    };
  },

  /**
   * format_string
   * Build a string from a template and store it as a variable.
   * The engine resolves {{placeholders}} before this runs, so
   * `template` arrives already interpolated — this just stores it.
   *
   * params:
   *   template    {string}  — e.g. "Hello {{firstName}} {{lastName}}"
   *   output_var  {string}  — variable name to store the result in
   *
   * example config:
   *   {
   *     "function_name": "format_string",
   *     "params": { "template": "{{firstName}} {{lastName}}", "output_var": "fullName" }
   *   }
   */
  format_string: async (params) => {
    const { template, output_var } = params;
    if (!output_var) throw new Error('format_string requires output_var');
    const result = template ?? '';
    console.log(`[FORMAT_STRING] ${output_var} = "${result}"`);
    return {
      success: true,
      set_vars: { [output_var]: result }
    };
  },

  // ─────────────────────────────────────────────────────────────
  // TIME / SCHEDULING
  // ─────────────────────────────────────────────────────────────

  /**
   * schedule_resume
   * Pause execution and resume at a future point in time.
   *
   * params:
   *   resumeAt           {string|number|null}
   *                      ISO datetime, duration string ("2h","10m","1d"),
   *                      milliseconds-from-now, or null (skip-block).
   *                      String forms accepted:
   *                        "2026-05-01T14:30:00Z"        explicit UTC
   *                        "2026-05-01T14:30:00-04:00"   explicit offset
   *                        "2026-05-01T14:30:00"         naive → FIRM_TZ
   *                        "2026-05-01 14:30:00"         SQL-ish → FIRM_TZ
   *                        "2026-05-01"                  date → FIRM_TZ midnight
   *                        "2h" / "10m" / "30s" / "1d"   relative duration
   *   nextStep           {number}  — step number to resume at
   *   skipToStep         {number?} — step to jump to when resumeAt is null
   *                                   (defaults to nextStep)
   *   randomizeMinutes   {number?} — symmetric ±N minute jitter applied to
   *                                   the computed resume time
   *
   * Past times are passed through to scheduled_jobs as-is — the next
   * /process-jobs tick will fire them. We do not throw on past times.
   *
   * example config:
   *   { "function_name": "schedule_resume",
   *     "params": { "resumeAt": "{{resume_24h}}", "nextStep": 4,
   *                 "skipToStep": 6, "randomizeMinutes": 15 } }
   */
  schedule_resume: async (params) => {
    // Skip-block path — used when pre-computed timestamps are in the past
    // and set to null by createAppt. Workflow continues to skipToStep
    // (or nextStep if no skipToStep given).
    if (params.resumeAt == null || params.resumeAt === '' || params.resumeAt === 'null') {
      const skipTo = params.skipToStep ?? params.nextStep;
      console.log(`[SCHEDULE_RESUME] resumeAt is null/empty — skipping block, jumping to step ${skipTo}`);
      return { success: true, next_step: skipTo };
    }

    let resumeAt;
    if (typeof params.resumeAt === 'string') {
      // Date-shape strings (start with YYYY-MM-DD) go through the
      // timezone-aware parser. Other strings ("2h", "10m", etc.) go
      // through ms() for relative-duration parsing.
      if (/^\d{4}-\d{2}-\d{2}/.test(params.resumeAt)) {
        const parsed = parseUserDateTime(params.resumeAt);
        if (!parsed) {
          // Should not be reachable — top guard already caught null/""/"null".
          // This handles the edge case of "  " (whitespace-only) which
          // parseUserDateTime returns null for.
          const skipTo = params.skipToStep ?? params.nextStep;
          console.log(`[SCHEDULE_RESUME] resumeAt parsed as empty — skipping block, jumping to step ${skipTo}`);
          return { success: true, next_step: skipTo };
        }
        resumeAt = parsed.toISOString();
      } else {
        const msDelay = ms(params.resumeAt);
        if (msDelay === undefined) {
          throw new Error(
            `Invalid resumeAt: "${params.resumeAt}". Use a duration ` +
            `("10m","2h","1d","30s"), an ISO datetime ` +
            `("2026-05-01T14:30:00Z" or "2026-05-01T14:30:00-04:00"), ` +
            `a naive datetime in firm time ("2026-05-01T14:30:00"), ` +
            `or a date ("2026-05-01")`
          );
        }
        resumeAt = new Date(Date.now() + msDelay).toISOString();
      }
    } else if (typeof params.resumeAt === 'number') {
      resumeAt = new Date(Date.now() + params.resumeAt).toISOString();
    } else {
      throw new Error('resumeAt must be ISO/duration string, number (ms), or null');
    }

    const nextStep = params.nextStep;
    if (nextStep == null) throw new Error('nextStep is required');

    // Apply optional symmetric ±N jitter
    resumeAt = applyJitterIso(resumeAt, params.randomizeMinutes);

    console.log(`[SCHEDULE_RESUME] Resume at ${resumeAt}, step ${nextStep}` +
                (params.randomizeMinutes ? ` (±${params.randomizeMinutes}min)` : ''));
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  },

  /**
   * wait_for
   * Pause for a duration OR until a specific time, then continue.
   *
   * params:
   *   duration           {string|number?} — relative ("2h","30m") or ms number
   *   at                 {string?}        — absolute ISO datetime; same
   *                                          parsing as schedule_resume.resumeAt
   *                                          (FIRM_TZ for naive forms)
   *   nextStep           {number}         — step to resume at
   *   skipToStep         {number?}        — used when `at` resolves to null
   *                                          (parity with schedule_resume)
   *   randomizeMinutes   {number?}        — symmetric ±N minute jitter
   *
   * Exactly one of `duration` or `at` is required.
   *
   * example configs:
   *   { "function_name": "wait_for", "params": { "duration": "48h", "nextStep": 5 } }
   *   { "function_name": "wait_for",
   *     "params": { "at": "2026-05-01T14:30:00", "nextStep": 5,
   *                 "randomizeMinutes": 10 } }
   */
  wait_for: async (params) => {
    const { duration, at, nextStep } = params;
    if (nextStep == null) throw new Error('wait_for requires nextStep');

    // Skip-block path — when `at` is explicitly present in params with a
    // nullish/empty value. Parity with schedule_resume's null-skip semantics.
    // Triggered by precompute-and-gate patterns like apptService.createAppt
    // ("the time we wanted to wait until is already past, so don't wait").
    //
    // We check `'at' in params` to distinguish "explicitly null" (skip) from
    // "at key missing" (use duration instead) — those are different inputs
    // and need different behavior.
    if ('at' in params && (at === null || at === '' || at === 'null')) {
      const skipTo = params.skipToStep ?? nextStep;
      console.log(`[WAIT_FOR] at is null/empty — skipping block, jumping to step ${skipTo}`);
      return { success: true, next_step: skipTo };
    }

    const hasDuration = duration !== undefined && duration !== null && duration !== '';
    const hasAt       = at       !== undefined && at       !== null && at       !== '';
    if (hasDuration && hasAt) {
      throw new Error('wait_for accepts exactly one of `duration` or `at`, not both');
    }
    if (!hasDuration && !hasAt) {
      throw new Error('wait_for requires either `duration` or `at`');
    }

    let resumeAt;
    if (hasAt) {
      // Absolute mode. Whitespace-only or otherwise unparseable `at` falls
      // through to the skip path below — exact null/""/"null" was already
      // handled by the top guard.
      if (typeof at !== 'string') {
        throw new Error('wait_for.at must be a string');
      }
      const parsed = parseUserDateTime(at);
      if (!parsed) {
        const skipTo = params.skipToStep ?? nextStep;
        console.log(`[WAIT_FOR] at parsed as empty — skipping block, jumping to step ${skipTo}`);
        return { success: true, next_step: skipTo };
      }
      resumeAt = parsed.toISOString();
    } else {
      // Relative mode — preserves existing behavior.
      if (typeof duration === 'number') {
        resumeAt = new Date(Date.now() + duration).toISOString();
      } else {
        const msDelay = ms(String(duration));
        if (msDelay === undefined) throw new Error(`Invalid duration: "${duration}"`);
        resumeAt = new Date(Date.now() + msDelay).toISOString();
      }
    }

    resumeAt = applyJitterIso(resumeAt, params.randomizeMinutes);

    const label = hasAt ? `at ${at}` : `duration ${duration}`;
    console.log(`[WAIT_FOR] Waiting (${label}) → resume step ${nextStep} at ${resumeAt}` +
                (params.randomizeMinutes ? ` (±${params.randomizeMinutes}min)` : ''));
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  },

  /**
   * wait_until_time
   * Resume at the next occurrence of a specific time of day.
   * Useful for "send this at 9am the next business day" patterns.
   *
   * params:
   *   time      {string}  — "HH:MM" in 24h format, e.g. "09:00"
   *   timezone  {string}  — IANA timezone, e.g. "America/Detroit" (default: UTC)
   *   nextStep  {number}  — step to resume at
   *
   * example config:
   *   {
   *     "function_name": "wait_until_time",
   *     "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 }
   *   }
   */
  wait_until_time: async (params) => {
    const { time, timezone = process.env.FIRM_TIMEZONE || 'America/Detroit', nextStep } = params;
    if (!time)            throw new Error('wait_until_time requires time (HH:MM)');
    if (nextStep == null) throw new Error('wait_until_time requires nextStep');

    const [hours, minutes] = time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time format: "${time}". Use HH:MM`);

    const now = new Date();
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    tzDate.setHours(hours, minutes, 0, 0);

    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    if (tzDate <= nowInTz) {
      tzDate.setDate(tzDate.getDate() + 1);
    }

    const utcEquivalent = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = now - utcEquivalent;
    const resumeAt = new Date(tzDate.getTime() + offsetMs).toISOString();

    console.log(`[WAIT_UNTIL_TIME] Resume at ${time} ${timezone} → ${resumeAt}, step ${nextStep}`);
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  },

  // ─────────────────────────────────────────────────────────────
  // COMMUNICATION
  // ─────────────────────────────────────────────────────────────

  /**
   * send_sms
   * Send an SMS from an internal phone line.
   * Returns the provider result as output — use set_vars in step config
   * to capture anything you need (e.g. {{this.messageId}}).
   *
   * params:
   *   from     {string}  — 10-digit number matching phone_lines.phone_number
   *   to       {string}  — recipient number (any common format)
   *   message  {string}  — message body ({{variables}} resolved before call)
   *
   * example config:
   *   {
   *     "function_name": "send_sms",
   *     "params": {
   *       "from": "2485559999",
   *       "to": "{{contactPhone}}",
   *       "message": "Hi {{firstName}}, your appointment is confirmed for {{apptDate}}."
   *     }
   *   }
   */
  send_sms: async (params, db) => {
    const { from, to, message } = params;
    if (!from)    throw new Error('send_sms requires from');
    if (!to)      throw new Error('send_sms requires to');
    if (!message) throw new Error('send_sms requires message');

    console.log(`[SEND_SMS] from=${from} to=${to}`);
    const result = await phoneService.sendSms(db, from, to, message);

    return {
      success: true,
      output: result
    };
  },

  /**
   * send_email
   * Send an email via the configured provider (smtp or pabbly).
   * Returns the provider result as output — use set_vars in step config
   * to capture anything you need (e.g. {{this.messageId}}).
   *
   * params:
   *   from              {string}  — must match a row in email_credentials
   *   to                {string}  — recipient address
   *   subject           {string}
   *   text              {string}  — plain text body
   *   html              {string}  — optional HTML body
   *   attachment_urls   {array}   — optional. Array of {url, name} objects,
   *                                 array of URL strings, or a single
   *                                 {url, name} object. Names are inferred
   *                                 from the URL when omitted. Works on both
   *                                 SMTP (via nodemailer's remote-fetch path)
   *                                 and Pabbly providers. Placeholders inside
   *                                 URL strings are resolved before send.
   *   attachment_names  {array}   — optional. Parallel array of display names.
   *                                 Usually unnecessary — names are inferred
   *                                 from the URL or the {name} field.
   *
   * example config:
   *   {
   *     "function_name": "send_email",
   *     "params": {
   *       "from": "info@4lsg.com",
   *       "to": "{{contactEmail}}",
   *       "subject": "Your appointment is confirmed",
   *       "text": "Hi {{firstName}}, we look forward to seeing you on {{apptDate}}.",
   *       "attachment_urls": [
   *         { "url": "https://storage.googleapis.com/.../intake.pdf", "name": "Intake Packet.pdf" }
   *       ]
   *     }
   *   }
   */
  send_email: async (params, db) => {
    const { from, to, subject, text, html, attachment_urls, attachment_names } = params;
    if (!from)    throw new Error('send_email requires from');
    if (!to)      throw new Error('send_email requires to');
    if (!subject) throw new Error('send_email requires subject');
    if (!text && !html) throw new Error('send_email requires at least one of: text, html');

    console.log(`[SEND_EMAIL] from=${from} to=${to} subject="${subject}"${attachment_urls ? ' (with attachments)' : ''}`);
    const result = await emailService.sendEmail(db, {
      from, to, subject, text, html,
      ...(attachment_urls  && { attachment_urls }),
      ...(attachment_names && { attachment_names }),
    });

    return {
      success: true,
      output: result
    };
  },

/**
   * send_mms
   * Send an MMS from a phone line that's flagged mms_capable in phone_lines.
   * URL-attachment only (single attachment per RingCentral API limits).
   *
   * MMS today is RingCentral-only — Quo and OpenPhone don't support MMS sends.
   * The capability is read from phone_lines.mms_capable (a TINYINT(1) flag),
   * not inferred from provider, so future provider additions can opt in via
   * a row update without code changes here. If the flag is false, phoneService
   * throws a clear error — no silent fallback to SMS.
   *
   * MEDIA TYPES:
   *   RingCentral's published spec lists images (JPEG, PNG, GIF, BMP, TIFF)
   *   and standard audio/video formats as supported. **PDFs are NOT on the
   *   published list but work in practice for this account today** — they're
   *   tested-good but not contractually guaranteed; an RC API change could
   *   break PDF support without notice. Prefer the spec-supported types when
   *   reliability matters; for documents you need delivered guaranteed, use
   *   send_email (attachment_urls handles PDFs cleanly).
   *
   * CONTENT-TYPE GOTCHA:
   *   The RingCentral adapter strips Content-Type parameters before forwarding
   *   to RC because RC's parser doesn't normalize them. A source URL that
   *   returns `application/pdf; qs=0.001` (some W3C-hosted files do this as a
   *   content-negotiation hint) gets rejected as MSG-348 "Unsupported
   *   attachment media type" if the parameter isn't stripped. Hosting
   *   attachments on GCS, your own server, or any provider that returns a
   *   clean Content-Type avoids the issue.
   *
   * params:
   *   from            {string}  — 10-digit phone_lines.phone_number;
   *                                must be active AND mms_capable=1
   *   to              {string}  — recipient number (any common format)
   *   text            {string}  — optional message body (≤1000 chars per RC limits)
   *   attachment_url  {string}  — required. Publicly fetchable URL.
   *                                The adapter fetches at send time and
   *                                caps it at 1.5MB.
   *
   * example config:
   *   {
   *     "function_name": "send_mms",
   *     "params": {
   *       "from": "2485559999",
   *       "to": "{{contactPhone}}",
   *       "text": "Hi {{firstName}}, see attached.",
   *       "attachment_url": "https://storage.googleapis.com/uploads.4lsg.com/screenshot.png"
   *     }
   *   }
   */
  send_mms: async (params, db) => {
    const { from, to, text, attachment_url } = params;
    if (!from)           throw new Error('send_mms requires from');
    if (!to)             throw new Error('send_mms requires to');
    if (!attachment_url) throw new Error('send_mms requires attachment_url');

    console.log(`[SEND_MMS] from=${from} to=${to}`);
    const result = await phoneService.sendMms(db, from, to, text || '', attachment_url);

    return {
      success: true,
      output: result
    };
  },

  // ─────────────────────────────────────────────────────────────
  // TASKS
  // ─────────────────────────────────────────────────────────────
  /**
   * create_task
   * Insert a task row linked to a contact, case, appointment, or bill.
   * Returns { task_id } as output — use set_vars in step config to capture it.
   *
   * params:
   *   title        {string}         — task title (required)
   *   description  {string}         — optional
   *   contact_id   {number|string}  — FK to contacts table (required)
   *   assigned_to  {number}         — user ID to assign to (required)
   *   assigned_by  {number}         — user ID who created it (defaults to assigned_to)
   *   link_type    {string}         — 'contact' | 'case' | 'appt' | 'bill' (default: 'contact')
   *   link_id      {string|number}  — the ID for the link (default: contact_id)
   *   due_date     {string}         — ISO date or datetime (optional)
   *
   * example config:
   *   {
   *     "function_name": "create_task",
   *     "params": {
   *       "title": "Follow up call",
   *       "contact_id": "{{contactId}}",
   *       "assigned_to": 2,
   *       "due_date": "{{followUpDate}}"
   *     },
   *     "set_vars": { "newTaskId": "{{this.output.task_id}}" }
   *   }
   */
  create_task: async (params, db) => {
    const taskService = require('../services/taskService');
    const {
      title,
      description = '',
      assigned_to,
      assigned_by = null,   // null -> service self-assigns to assigned_to; pass 0 for the automations user
      due_date    = null,
      start_date  = null,
      notify      = false,  // notify assigner on completion
      contact_id  = null,   // optional convenience: link to a contact
      link_type   = null,   // optional; 'contact'|'case'|'appt'|'bill'|'event'
      link_id     = null
    } = params;

    if (!title)       throw new Error('create_task requires title');
    if (!assigned_to) throw new Error('create_task requires assigned_to');

    // Link is OPTIONAL — tasks may be standalone. Back-compat: a bare
    // contact_id implies a contact link.
    let lt  = link_type;
    let lid = (link_id != null) ? link_id : contact_id;
    if (lt == null && lid != null && contact_id != null) lt = 'contact';

    // Delegate to the service so we get assignment notification, due-date
    // reminder, event log, and action token (the raw INSERT skipped all that).
    const { task_id } = await taskService.createTask(db, {
      from:  assigned_by,
      to:    assigned_to,
      title,
      desc:  description,
      start: start_date,
      due:   due_date,
      notify,
      link_type: lt || null,
      link_id:   (lid != null) ? lid : null
    });

    console.log(`[CREATE_TASK] "${title}" -> user ${assigned_to}` + (lt ? ` (${lt} ${lid})` : ' (standalone)'));
    return { success: true, output: { task_id } };
  },

  // ─────────────────────────────────────────────────────────────
  // CONTACTS
  // ─────────────────────────────────────────────────────────────

  /**
   * lookup_contact
   * Fetch a contact row and return it as output.
   * Use set_vars in the step config to map fields into workflow variables.
   *
   * params:
   *   contact_id  {number|string}  — can be a {{variable}}
   *
   * example config:
   *   {
   *     "function_name": "lookup_contact",
   *     "params": { "contact_id": "{{contactId}}" },
   *     "set_vars": {
   *       "contact_first_name": "{{this.contact_fname}}",
   *       "contact_phone":      "{{this.contact_phone}}",
   *       "contact_email":      "{{this.contact_email}}"
   *     }
   *   }
   */
  lookup_contact: async (params, db) => {
    const { contact_id } = params;
    if (!contact_id) throw new Error('lookup_contact requires contact_id');

    console.log(`[LOOKUP_CONTACT] id=${contact_id}`);

    const [[row]] = await db.query(
      `SELECT contact_id, contact_fname, contact_lname, contact_name, contact_pname, contact_phone, contact_phone2, contact_email, contact_email2, contact_type, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_tags, contact_notes, contact_clio_id, contact_created FROM contacts WHERE contact_id = ?`,
      [contact_id]
    );

    if (!row) throw new Error(`Contact ${contact_id} not found`);

    return {
      success: true,
      output: row   // entire row available as {{this.column_name}}
    };
  },

  /**
   * find_contact
   * Find contacts by phone and/or email value. Pure read; returns ALL
   * matches without picking a winner — caller decides on ambiguity.
   *
   * Wraps contactService.resolveContactsByValue. See that function for
   * normalization, source precedence (child_active > child_ended >
   * legacy_primary > legacy_secondary), and fail-soft input behavior.
   *
   * At least one of phone / email is required.
   *
   * params:
   *   phone                    {string?}   — phone value (any format).
   *                                          Normalized to 10 digits.
   *   email                    {string?}   — email value.
   *                                          Trimmed + lowercased.
   *   include_ended            {boolean?}  — default true.
   *   include_legacy_secondary {boolean?}  — default true.
   *
   * Output namespace (under {{this.*}}):
   *   matches       array of MatchEntry
   *   count         matches.length
   *   first         matches[0] or null   (most common single-match case)
   *   is_ambiguous  matches.length > 1   (use to branch on divergence)
   *   summary       {phone_normalized, email_normalized, total_matches}
   *
   * example config:
   *   {
   *     "function_name": "find_contact",
   *     "params": { "phone": "{{trigger.from_phone}}" },
   *     "set_vars": {
   *       "resolvedContactId": "{{this.first.contact_id}}",
   *       "isAmbiguous":       "{{this.is_ambiguous}}"
   *     }
   *   }
   */
  find_contact: async (params, db) => {
    const {
      phone = null,
      email = null,
      include_ended,
      include_legacy_secondary,
    } = params || {};

    if ((phone == null || phone === '') && (email == null || email === '')) {
      throw new Error('find_contact requires phone or email');
    }

    const result = await contactService.resolveContactsByValue(
      db,
      { phone, email },
      { include_ended, include_legacy_secondary }
    );

    const matches = result.matches;
    const count   = matches.length;
    const first   = count > 0 ? matches[0] : null;

    console.log(
      `[FIND_CONTACT] phone=${result.summary.phone_normalized || 'null'} ` +
      `email=${result.summary.email_normalized || 'null'} → matches=${count}`
    );

    return {
      success: true,
      output: {
        matches,
        count,
        first,
        is_ambiguous: count > 1,
        summary: result.summary,
      },
    };
  },

  // ─────────────────────────────────────────────────────────────
// update_contact
// ─────────────────────────────────────────────────────────────
 
  /**
   * update_contact
   * Update one or more fields on a contact row.
   *
   * Allowed columns are whitelisted. Blocked:
   *   contact_id       — PK, immutable
   *   contact_ssn      — sensitive, never writable via automation
   *   contact_name     — trigger-computed from fname/mname/lname
   *   contact_lfm_name — trigger-computed
   *   contact_rname    — trigger-computed
   *   contact_created  — set once at insert
   *   contact_updated  — auto-managed below
   *
   * The DB trigger `contact_name_update` auto-recomputes derived name
   * fields when fname/mname/lname change.
   * The DB trigger `after_contact_update` auto-logs all changes to the
   * log table — no need to log from here.
   *
   * params:
   *   contact_id  {number|string}  — target contact
   *   fields      {object}         — column: value pairs
   *
   * example config:
   *   {
   *     "function_name": "update_contact",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "fields": { "contact_tags": "intake-complete", "contact_type": "Client" }
   *     }
   *   }
   */
  update_contact: async (params, db) => {
    const { contact_id, fields } = params;
    if (!contact_id) throw new Error('update_contact requires contact_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_contact requires a non-empty fields object');
    }
 
    // Whitelist — only these columns may be set via this function
    const ALLOWED = new Set([
      'contact_type', 'contact_fname', 'contact_mname', 'contact_lname',
      'contact_pname', 'contact_phone', 'contact_email',
      'contact_address', 'contact_city', 'contact_state', 'contact_zip',
      'contact_dob', 'contact_marital_status', 'contact_ssn',
      'contact_tags', 'contact_notes', 'contact_clio_id',
      'contact_phone2', 'contact_email2'
    ]);
 
    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_contact: blocked columns: ${blocked.join(', ')}`);
    }
 
    console.log(`[UPDATE_CONTACT] id=${contact_id} fields=${JSON.stringify(fields)}`);
 
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => fields[k]), contact_id];
 
    const [result] = await db.query(
      `UPDATE contacts SET ${setClauses}, contact_updated = NOW() WHERE contact_id = ?`,
      values
    );
 
    if (result.affectedRows === 0) {
      throw new Error(`Contact ${contact_id} not found`);
    }
 
    return {
      success: true,
      output: { contact_id, updated_fields: keys }
    };
  },

  /**
   * update_case
   * Update one or more whitelisted fields on a case row.
   *
   * params:
   *   case_id  {number}  — required
   *   fields   {object}  — { column_name: value, ... }
   *
   * example config:
   *   {
   *     "function_name": "update_case",
   *     "params": {
   *       "case_id": "{{cases.case_id}}",
   *       "fields": {
   *         "case_stage":  "closed",
   *         "case_status": "Stale Lead"
   *       }
   *     }
   *   }
   */
  update_case: async (params, db) => {
    const { case_id, fields } = params;
    if (!case_id) throw new Error('update_case requires case_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_case requires a non-empty fields object');
    }

    // Whitelist — only these columns may be set via this function.
    // Mirror of update_contact's whitelist pattern. Expand as needed.
    const ALLOWED = new Set([
      'case_number', 'case_number_full', 'case_type', 'case_stage', 'case_status', 'case_rec',
      'case_open_date', 'case_file_date', 'case_close_date',
      'case_garnish', 'case_issues_bk_vehicle', 'case_issues_bk_other', 'case_pre_petition', 'case_post_petition', 'case_1st_course', 'case_2nd_course',
      'matrix', 'matrix_date_original', 'matrix_date_proposed', 'schedules', 'schedules_due_original', 'schedules_due_proposed',
      'filing_fee', 'final_installment', 'show_cause', 'filing_fee_extended_deadline',
      'docs', 'docs_due', 'docs_missing',
      'case_intake_form', 'case_detailed_form', 'case_detailed_link', 'case_ISSN_form', 'case_form', 'case_341_form',
      'case_source', 'case_source_ref', 'case_dropbox', 'case_primary_reason',
      'case_judge', 'case_trustee', 'case_chapter',
      'case_341_current', 'case_341_initial', 'case_objection', 'case_180', 'case_preference', 'case_show_cause',
      'clio_matter', '341_appt_id', '341_status', '341_docs', '341_amend', '341_notes',
      'case_clio_id', 'case_notes', 'case_alerts',
    ]);

    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_case: blocked columns: ${blocked.join(', ')}`);
    }

    console.log(`[UPDATE_CASE] id=${case_id} fields=${JSON.stringify(fields)}`);

    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => fields[k]), case_id];

    const [result] = await db.query(
      `UPDATE cases SET ${setClauses} WHERE case_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      throw new Error(`Case ${case_id} not found`);
    }

    return {
      success: true,
      output: { case_id, updated_fields: keys }
    };
  },

  // ─────────────────────────────────────────────────────────────
  // APPOINTMENTS
  // ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
  // APPOINTMENTS — CREATE
  // ─────────────────────────────────────────────────────────────

  /**
   * create_appointment
   * Create a new appointment with full side-effects (log, 341 update,
   * sequence cancel, GCal, reminder workflow).
   * Delegates entirely to apptService.createAppt().
   *
   * params:
   *   contact_id      {number|string}  — required
   *   case_id         {string}         — optional (but usually provided)
   *   appt_date       {string}         — required, datetime string (firm local time)
   *   appt_type       {string}         — required, e.g. '341 Meeting'
   *   appt_length     {number}         — required, minutes
   *   appt_platform   {string}         — required, 'Telephone'|'Zoom'|'In-person'
   *   appt_with       {number}         — user ID, defaults to 1
   *   note            {string}         — optional
   *   confirm_sms     {boolean}        — optional
   *   confirm_email   {boolean}        — optional
   *   confirm_message {string}         — required if sms/email true
   *   acting_user_id  {number}         — user ID for log entry, defaults to 0
   *
   * returns: { appt_id, appt_date_utc, workflow_execution_id }
   *
   * example config:
   *   {
   *     "function_name": "create_appointment",
   *     "params": {
   *       "contact_id":    "{{primary_contact_id}}",
   *       "case_id":       "{{link_id}}",
   *       "appt_date":     "{{new_control_datetime}}",
   *       "appt_type":     "341 Meeting",
   *       "appt_length":   15,
   *       "appt_platform": "Telephone",
   *       "appt_with":     "{{attorney_user_id}}"
   *     },
   *     "set_vars": { "new_appt_id": "{{this.output.appt_id}}" }
   *   }
   */
  create_appointment: async (params, db) => {
    const apptService = require('../services/apptService');  // deferred require (circular dep safety)

    const {
      contact_id,
      case_id         = '',
      appt_date,
      appt_type,
      appt_length,
      appt_platform,
      appt_with       = 1,
      note            = '',
      confirm_sms     = false,
      confirm_email   = false,
      confirm_message = '',
      acting_user_id  = 0,
      source          = 'internal',   // optional caller override; defaults internal
    } = params;

    if (!contact_id) throw new Error('create_appointment requires contact_id');
    if (!appt_date)  throw new Error('create_appointment requires appt_date');
    if (!appt_type)  throw new Error('create_appointment requires appt_type');
    if (!appt_length) throw new Error('create_appointment requires appt_length');
    if (!appt_platform) throw new Error('create_appointment requires appt_platform');

    console.log(`[CREATE_APPOINTMENT] type=${appt_type} contact=${contact_id} case=${case_id} date=${appt_date}`);

    const result = await apptService.createAppt(db, {
      contact_id:      parseInt(contact_id, 10),
      case_id,
      appt_length:     parseInt(appt_length, 10),
      appt_type,
      appt_platform,
      appt_date,
      appt_with:       parseInt(appt_with, 10),
      note,
      confirm_sms:     !!confirm_sms,
      confirm_email:   !!confirm_email,
      confirm_message,
      actingUserId:    parseInt(acting_user_id, 10),
      source,
    });

    return {
      success: true,
      output: {
        appt_id:               result.appt_id,
        appt_date_utc:         result.appt_date_utc,
        workflow_execution_id: result.workflow_execution_id || null,
      }
    };
  },
  /**
   * lookup_appointment
   * Fetch an appointment row and return it as output.
   * Use set_vars in the step config to map fields into workflow variables.
   *
   * params:
   *   appointment_id  {number|string}
   *
   * example config:
   *   {
   *     "function_name": "lookup_appointment",
   *     "params": { "appointment_id": "{{apptId}}" },
   *     "set_vars": {
   *       "appt_status": "{{this.status}}",
   *       "appt_date":   "{{this.appointment_date}}"
   *     }
   *   }
   */
  lookup_appointment: async (params, db) => {
    const { appointment_id } = params;
    if (!appointment_id) throw new Error('lookup_appointment requires appointment_id');

    console.log(`[LOOKUP_APPOINTMENT] id=${appointment_id}`);

    const [[row]] = await db.query(
      `SELECT * FROM appts WHERE appt_id = ?`,
      [appointment_id]
    );

    if (!row) throw new Error(`Appointment ${appointment_id} not found`);

    return {
      success: true,
      output: row   // entire row available as {{this.column_name}}
    };
  },

  // ─────────────────────────────────────────────────────────────
// update_appointment
// ─────────────────────────────────────────────────────────────
 
  /**
   * update_appointment
   * Update one or more fields on an appointment row.
   *
   * Allowed columns are whitelisted. Blocked:
   *   appt_id          — PK, immutable
   *   appt_end         — GENERATED ALWAYS AS (appt_date + interval appt_length minute)
   *   appt_create_date — set once at insert
   *
   * params:
   *   appointment_id  {number|string}  — target appt_id
   *   fields          {object}         — column: value pairs
   *
   * example config:
   *   {
   *     "function_name": "update_appointment",
   *     "params": {
   *       "appointment_id": "{{apptId}}",
   *       "fields": { "appt_note": "Client confirmed via phone" }
   *     }
   *   }
   */
  update_appointment: async (params, db) => {
    const { appointment_id, fields } = params;
    if (!appointment_id) throw new Error('update_appointment requires appointment_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_appointment requires a non-empty fields object');
    }
 
    // Whitelist — only these columns may be set via this function
    const ALLOWED = new Set([
      'appt_client_id', 'appt_case_id', 'appt_type', 'appt_length',
      'appt_form', 'appt_status', 'appt_date', 'appt_gcal',
      'appt_ref_id', 'appt_note', 'appt_platform', 'appt_with',
      'appt_gcal_user'
    ]);
 
    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_appointment: blocked columns: ${blocked.join(', ')}`);
    }
 
    console.log(`[UPDATE_APPOINTMENT] id=${appointment_id} fields=${JSON.stringify(fields)}`);
 
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => fields[k]), appointment_id];
 
    const [result] = await db.query(
      `UPDATE appts SET ${setClauses} WHERE appt_id = ?`,
      values
    );
 
    if (result.affectedRows === 0) {
      throw new Error(`Appointment ${appointment_id} not found`);
    }
 
    return {
      success: true,
      output: { appointment_id, updated_fields: keys }
    };
  },



  // ─────────────────────────────────────────────────────────────
  // APPOINTMENTS QUERY
  // ─────────────────────────────────────────────────────────────

  /**
   * get_appointments
   * Query the appts table with optional filters and return results
   * in a format suitable for email, SMS, or variable storage.
   *
   * params:
   *   status       {string}   — appt_status filter e.g. 'Scheduled', 'No Show'
   *                             omit for all statuses
   *   date         {string}   — 'today', 'tomorrow', or ISO date string 'YYYY-MM-DD'
   *                             omit for no date filter
   *   from         {string}   — ISO datetime, lower bound on appt_date
   *   to           {string}   — ISO datetime, upper bound on appt_date
   *   contact_id   {number}   — filter by contact
   *   case_id      {string}   — filter by case
   *   appt_type    {string}   — filter by appointment type
   *   limit        {number}   — max rows (default 200)
   *   format       {string}   — 'raw'       → array of objects (default)
   *                             'html_rows' → <tr> rows for email table
   *                             'count'     → just the count number
   *   output_var   {string}   — store formatted result in this workflow variable
   *   count_var    {string}   — store row count in this workflow variable
   *   date_var     {string}   — store formatted date string in this workflow variable
   *                             e.g. "Wednesday, March 18, 2026"
   *   base_url     {string}   — base URL for links in html_rows (default 'https://app.4lsg.com')
   *
   * Returns:
   *   { success, output: { rows, count, html, date_formatted }, set_vars }
   *
   * example config (daily report workflow):
   *   {
   *     "function_name": "get_appointments",
   *     "params": {
   *       "status": "Scheduled",
   *       "date": "today",
   *       "format": "html_rows",
   *       "output_var": "apptRows",
   *       "count_var": "apptCount",
   *       "date_var": "todayFormatted"
   *     },
   *     "set_vars": {
   *       "apptRows":       "{{this.output.html}}",
   *       "apptCount":      "{{this.output.count}}",
   *       "todayFormatted": "{{this.output.date_formatted}}"
   *     }
   *   }
   */
  get_appointments: async (params, db) => {
    const {
      status,
      date,
      from,
      to,
      contact_id,
      case_id,
      appt_type,
      limit     = 200,
      format    = 'raw',
      base_url = process.env.APP_URL || 'https://app.4lsg.com',
    } = params;

    // ── Build WHERE conditions ──
    const conditions = [];
    const queryParams = [];

    if (status) {
      conditions.push('appts.appt_status = ?');
      queryParams.push(status);
    }

    if (date) {
      if (date === 'today') {
        conditions.push('DATE(appts.appt_date) = CURDATE()');
      } else if (date === 'tomorrow') {
        conditions.push('DATE(appts.appt_date) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)');
      } else {
        // ISO date string — validate it looks like a date
        const d = new Date(date);
        if (isNaN(d.getTime())) throw new Error(`get_appointments: invalid date "${date}"`);
        conditions.push('DATE(appts.appt_date) = ?');
        queryParams.push(date.slice(0, 10));
      }
    }

    if (from)       { conditions.push('appts.appt_date >= ?');        queryParams.push(from); }
    if (to)         { conditions.push('appts.appt_date <= ?');         queryParams.push(to); }
    if (contact_id) { conditions.push('appts.appt_client_id = ?');    queryParams.push(contact_id); }
    if (case_id)    { conditions.push('appts.appt_case_id = ?');       queryParams.push(case_id); }
    if (appt_type)  { conditions.push('appts.appt_type = ?');          queryParams.push(appt_type); }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // ── Execute query (same JOIN structure as GET /api/appts) ──
    const [rows] = await db.query(
      `SELECT
         appts.appt_id,
         appts.appt_client_id,
         appts.appt_case_id,
         appts.appt_type,
         appts.appt_status,
         appts.appt_date,
         appts.appt_end,
         appts.appt_platform,
         appts.appt_length,
         appts.appt_with,
         appts.appt_note,
         DATE_FORMAT(appts.appt_date, '%W %e, %Y at %l:%i %p') AS appt_date_fmt,
         DATE_FORMAT(appts.appt_date, '%b. %e, %Y')            AS format_date,
         DATE_FORMAT(appts.appt_date, '%h:%i %p')              AS appt_time,
         contacts.contact_name,
         contacts.contact_id,
         COALESCE(cases.case_number_full, cases.case_number, appts.appt_case_id) AS case_number,
         users.user_name
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases    ON appts.appt_case_id   = cases.case_id
       LEFT JOIN users    ON users.user            = appts.appt_with
       ${whereSql}
       ORDER BY appts.appt_date ASC
       LIMIT ?`,
      [...queryParams, parseInt(limit)]
    );

    const count = rows.length;

    // ── Formatted date string for email header ──
    // Uses the target date or today
    let targetDate;
    if (date === 'tomorrow') {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (date && date !== 'today') {
      targetDate = new Date(date);
    } else {
      targetDate = new Date();
    }

    const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const date_formatted = `${WEEKDAYS[targetDate.getDay()]}, ${MONTHS[targetDate.getMonth()]} ${targetDate.getDate()}, ${targetDate.getFullYear()}`;

    console.log(`[GET_APPOINTMENTS] Found ${count} appointment(s) for ${date_formatted}`);

    // ── Format output ──
    let html = '';

    if (format === 'html_rows' || format === 'html_table') {
      if (count === 0) {
        html = `<tr><td colspan="5" style="text-align:center; padding:12px; color:#888;">No appointments scheduled</td></tr>`;
      } else {
        html = rows.map(appt => {
          const clientCell = appt.contact_id
            ? `<a href="${base_url}/?contact=${appt.contact_id}" style="color:#1a73e8;">${appt.contact_name || appt.contact_id}</a>`
            : String(appt.appt_client_id || '—');

          const caseCell = appt.appt_case_id
            ? `<a href="${base_url}/?case=${appt.appt_case_id}" style="color:#1a73e8;">${appt.case_number || appt.appt_case_id}</a>`
            : 'no case';

          return `<tr>
            <td style="padding:6px; border:1px solid #ddd;">${appt.appt_id}</td>
            <td style="padding:6px; border:1px solid #ddd;">${appt.appt_type || '—'}</td>
            <td style="padding:6px; border:1px solid #ddd;">${appt.appt_date_fmt}</td>
            <td style="padding:6px; border:1px solid #ddd;">${clientCell}</td>
            <td style="padding:6px; border:1px solid #ddd;">${caseCell}</td>
          </tr>`;
        }).join('\n');
      }
    }

    const output = {
      rows,
      count,
      html,
      date_formatted,
      has_appointments: count > 0,
    };

    // ── Build set_vars from named output vars ──
    // Note: set_vars in step config using {{this.output.*}} is preferred,
    // but we also support direct output_var / count_var / date_var params
    // for convenience in simple workflows.
    const set_vars = {};
    if (params.output_var) set_vars[params.output_var] = format === 'html_rows' ? html : rows;
    if (params.count_var)  set_vars[params.count_var]  = count;
    if (params.date_var)   set_vars[params.date_var]   = date_formatted;

    return { success: true, output, set_vars };
  },


  // ─────────────────────────────────────────────────────────────
  // GOOGLE CALENDAR (native — services/gcalService.js)
  // ─────────────────────────────────────────────────────────────
  //
  // Thin wrappers over gcalService. gcalService is lazy-required inside each
  // function, matching this file's convention for service-backed functions
  // (apptService et al.) — cheap circular-dep insurance even though gcal has
  // no cycle today.
  //
  // Auth/calendar binding: omit credential_id / calendar_id to use the
  // app_settings binding (gcal_credential_id / gcal_calendar_id) or the
  // service defaults. The bound credential must be an oauth2 connection with
  // the calendar scope AND have https://www.googleapis.com/* in allowed_urls,
  // or every call fails with an out-of-scope error.

  /**
   * gcal_create_event
   * Create a Google Calendar event. Returns the created event as output —
   * capture {{this.output.id}} (the event ID, store it in appts.appt_gcal)
   * via set_vars.
   *
   * params:
   *   summary       {string}   — event title
   *   start         {string}   — ISO datetime (firm-local if naive), or "YYYY-MM-DD" for all-day
   *   end           {string}   — ISO datetime, or "YYYY-MM-DD"
   *   description   {string?}
   *   location      {string?}
   *   attendees     {array?}   — email strings or {email,...} objects
   *   send_updates  {string?}  — 'all' | 'externalOnly' | 'none' (default 'none')
   *   credential_id {number?}  — override the bound credential
   *   calendar_id   {string?}  — override the bound calendar
   *
   * example config:
   *   {
   *     "function_name": "gcal_create_event",
   *     "params": {
   *       "summary":  "341 Meeting — {{contact_name}}",
   *       "start":    "{{appt_date}}",
   *       "end":      "{{appt_end}}",
   *       "location": "Telephone",
   *       "attendees": ["{{contact_email}}"]
   *     },
   *     "set_vars": { "gcal_event_id": "{{this.output.id}}" }
   *   }
   */
  gcal_create_event: async (params, db) => {
    const gcal = require('../services/gcalService');  // deferred require (convention)
    const { summary, start, end, description, location, attendees,
            send_updates, credential_id, calendar_id } = params;
    if (!start) throw new Error('gcal_create_event requires start');
    if (!end)   throw new Error('gcal_create_event requires end');

    console.log(`[GCAL_CREATE_EVENT] "${summary || '(no title)'}" ${start} → ${end}`);
    const event = await gcal.createEvent(db, {
      summary, start, end, description, location, attendees,
      ...(send_updates  && { sendUpdates: send_updates }),
      ...(credential_id != null && { credentialId: credential_id }),
      ...(calendar_id   && { calendarId: calendar_id }),
    });

    return { success: true, output: event };
  },

  /**
   * gcal_get_event
   * Fetch a single calendar event by ID.
   *
   * params:
   *   event_id      {string}   — required (appts.appt_gcal)
   *   credential_id {number?}  — override
   *   calendar_id   {string?}  — override
   *
   * example config:
   *   {
   *     "function_name": "gcal_get_event",
   *     "params": { "event_id": "{{gcal_event_id}}" },
   *     "set_vars": { "event_status": "{{this.output.status}}" }
   *   }
   */
  gcal_get_event: async (params, db) => {
    const gcal = require('../services/gcalService');
    const { event_id, credential_id, calendar_id } = params;
    if (!event_id) throw new Error('gcal_get_event requires event_id');

    console.log(`[GCAL_GET_EVENT] ${event_id}`);
    const event = await gcal.getEvent(db, {
      eventId: event_id,
      ...(credential_id != null && { credentialId: credential_id }),
      ...(calendar_id   && { calendarId: calendar_id }),
    });

    return { success: true, output: event };
  },

  /**
   * gcal_update_event
   * Partial-update (PATCH) a calendar event. Only supplied fields change.
   *
   * params:
   *   event_id      {string}   — required
   *   summary       {string?}
   *   start         {string?}  — ISO datetime, or "YYYY-MM-DD"
   *   end           {string?}  — ISO datetime, or "YYYY-MM-DD"
   *   description   {string?}
   *   location      {string?}
   *   attendees     {array?}
   *   send_updates  {string?}  — 'all' | 'externalOnly' | 'none'
   *   credential_id {number?}  — override
   *   calendar_id   {string?}  — override
   *
   * example config:
   *   {
   *     "function_name": "gcal_update_event",
   *     "params": { "event_id": "{{gcal_event_id}}", "start": "{{new_date}}", "end": "{{new_end}}" }
   *   }
   */
  gcal_update_event: async (params, db) => {
    const gcal = require('../services/gcalService');
    const { event_id, summary, start, end, description, location, attendees,
            send_updates, credential_id, calendar_id } = params;
    if (!event_id) throw new Error('gcal_update_event requires event_id');

    console.log(`[GCAL_UPDATE_EVENT] ${event_id}`);
    const event = await gcal.updateEvent(db, {
      eventId: event_id,
      summary, start, end, description, location, attendees,
      ...(send_updates  && { sendUpdates: send_updates }),
      ...(credential_id != null && { credentialId: credential_id }),
      ...(calendar_id   && { calendarId: calendar_id }),
    });

    return { success: true, output: event };
  },

  /**
   * gcal_delete_event
   * Delete a calendar event by ID.
   *
   * params:
   *   event_id      {string}   — required
   *   send_updates  {string?}  — 'all' | 'externalOnly' | 'none'
   *   credential_id {number?}  — override
   *   calendar_id   {string?}  — override
   *
   * example config:
   *   {
   *     "function_name": "gcal_delete_event",
   *     "params": { "event_id": "{{gcal_event_id}}" }
   *   }
   */
  gcal_delete_event: async (params, db) => {
    const gcal = require('../services/gcalService');
    const { event_id, send_updates, credential_id, calendar_id } = params;
    if (!event_id) throw new Error('gcal_delete_event requires event_id');

    console.log(`[GCAL_DELETE_EVENT] ${event_id}`);
    const result = await gcal.deleteEvent(db, {
      eventId: event_id,
      ...(send_updates  && { sendUpdates: send_updates }),
      ...(credential_id != null && { credentialId: credential_id }),
      ...(calendar_id   && { calendarId: calendar_id }),
    });

    return { success: true, output: result };
  },

  // ─────────────────────────────────────────────────────────────
  // DROPBOX (native — services/dropboxService.js)
  // ─────────────────────────────────────────────────────────────
  //
  // Thin wrappers over dropboxService (Connections-based; credential 8 /
  // app_settings 'dropbox_credential_id'). dropboxService is lazy-required
  // inside each function, matching this file's convention for
  // service-backed functions — cheap circular-dep insurance.
  //
  // SPACES IN PATHS/NAMES ARE SIGNIFICANT (the firm's manual-sort
  // convention uses leading spaces, e.g. "/  Law Office/   Cases/...").
  // These wrappers pass path/filename params through untouched.
  //
  // Location addressing: where noted, steps accept `path` OR `shared_link`
  // (the per-case folder handle stored in cases.case_dropbox — it keeps
  // resolving after staff move/rename the folder).

  /**
   * dropbox_create_folder
   * Create a Dropbox folder (idempotent), optionally subfolders and a
   * public shared link. Returns { path, existed, subfolders_created,
   * shared_link } — capture {{this.output.shared_link}} to store in
   * cases.case_dropbox (the native replacement for the Pabbly
   * create_dropbox_folder flow).
   *
   * params:
   *   path          {string}   — full folder path; leading spaces preserved
   *   subfolders    {array?}   — subfolder names (nested "a/b" allowed)
   *   share_link    {boolean?} — create/reuse a public shared link (default false)
   *   credential_id {number?}  — override the bound credential
   *
   * example config:
   *   {
   *     "function_name": "dropbox_create_folder",
   *     "params": {
   *       "path": "/  Law Office/   Cases/  Potential Cases/  Potential - Bankruptcy/ {{contact_name}} - {{caseId}}",
   *       "subfolders": ["Client Uploads"],
   *       "share_link": true
   *     },
   *     "set_vars": { "case_dropbox": "{{this.output.shared_link}}" }
   *   }
   */
  dropbox_create_folder: async (params, db) => {
    const dropbox = require('../services/dropboxService');  // deferred require (convention)
    const { path, subfolders, share_link, credential_id } = params;
    if (!path) throw new Error('dropbox_create_folder requires path');

    console.log(`[DROPBOX_CREATE_FOLDER] "${path}" share_link=${share_link === true}`);
    const result = await dropbox.createFolderWithOptions(db, {
      path,
      subfolders: Array.isArray(subfolders) ? subfolders : [],
      shareLink: share_link === true,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  },

  /**
   * dropbox_get_shared_link
   * Get (or create) a public shared link for a path.
   *
   * params:
   *   path          {string}   — required
   *   credential_id {number?}
   *
   * example config:
   *   {
   *     "function_name": "dropbox_get_shared_link",
   *     "params": { "path": "{{folder_path}}" },
   *     "set_vars": { "shared_link": "{{this.output.shared_link}}" }
   *   }
   */
  dropbox_get_shared_link: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { path, credential_id } = params;
    if (!path) throw new Error('dropbox_get_shared_link requires path');

    console.log(`[DROPBOX_GET_SHARED_LINK] "${path}"`);
    const url = await dropbox.getOrCreateSharedLink(db, {
      path,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: { shared_link: url } };
  },

  /**
   * dropbox_list_folder
   * List a folder's entries (by path or by the case's shared link).
   * Output: { entries, count, truncated } — entries are Dropbox metadata
   * objects (.tag 'file'|'folder', name, path_display, ...). Useful for
   * "did the client upload anything" branches via {{this.output.count}}.
   *
   * params:
   *   path          {string?}  — folder path ('/' or '' = root); OR
   *   shared_link   {string?}  — case folder handle (cases.case_dropbox)
   *   subfolder     {string?}  — list this subfolder under the resolved
   *                              folder (e.g. "Client Uploads"); shared_link only
   *   recursive     {boolean?} — default false
   *   max_entries   {number?}  — default 2000
   *   credential_id {number?}
   *
   * example config:
   *   {
   *     "function_name": "dropbox_list_folder",
   *     "params": { "shared_link": "{{case_dropbox}}", "subfolder": "Client Uploads" },
   *     "set_vars": { "upload_count": "{{this.output.count}}" }
   *   }
   */
  dropbox_list_folder: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { path, shared_link, subfolder, recursive, max_entries, credential_id } = params;
    if (!path && path !== '' && !shared_link) {
      throw new Error('dropbox_list_folder requires path or shared_link');
    }

    const common = {
      recursive: recursive === true,
      ...(max_entries != null && { maxEntries: max_entries }),
      ...(credential_id != null && { credentialId: credential_id }),
    };

    let result;
    if (shared_link && subfolder) {
      // Resolve the link, then descend into the subfolder.
      const credentialId = await dropbox._resolveCredential(db, { credentialId: credential_id });
      const base = await dropbox.resolveLocation(db, credentialId, {
        sharedLink: shared_link, expectFolder: true,
      });
      const listPath = dropbox.joinPath(base, subfolder);
      console.log(`[DROPBOX_LIST_FOLDER] "${listPath}"`);
      result = await dropbox.listFolder(db, { path: listPath, ...common });
    } else {
      console.log(`[DROPBOX_LIST_FOLDER] ${shared_link ? `link=${shared_link}` : `"${path}"`}`);
      result = await dropbox.listFolder(db, { path, sharedLink: shared_link, ...common });
    }

    return { success: true, output: result };
  },

  /**
   * dropbox_move
   * Move a file/folder. Source by from_path OR from_shared_link (the
   * case-folder handle — survives prior moves/renames).
   *
   * params:
   *   from_path        {string?} — OR
   *   from_shared_link {string?}
   *   to_path          {string}  — required; full destination path
   *   autorename       {boolean?} — default false
   *   credential_id    {number?}
   *
   * example config:
   *   {
   *     "function_name": "dropbox_move",
   *     "params": {
   *       "from_shared_link": "{{case_dropbox}}",
   *       "to_path": "/  Law Office/   Cases/ Active/ {{contact_name}} - {{caseId}}"
   *     }
   *   }
   */
  dropbox_move: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { from_path, from_shared_link, to_path, autorename, credential_id } = params;
    if (!to_path) throw new Error('dropbox_move requires to_path');
    if (!from_path && !from_shared_link) throw new Error('dropbox_move requires from_path or from_shared_link');

    console.log(`[DROPBOX_MOVE] → "${to_path}"`);
    const result = await dropbox.movePath(db, {
      fromPath: from_path,
      fromSharedLink: from_shared_link,
      toPath: to_path,
      autorename: autorename === true,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  },

  /**
   * dropbox_rename
   * Rename a file/folder in place (same parent). new_name may carry
   * leading spaces — preserved.
   *
   * params:
   *   path          {string?} — OR
   *   shared_link   {string?}
   *   new_name      {string}  — required; no "/" allowed
   *   credential_id {number?}
   *
   * example config:
   *   {
   *     "function_name": "dropbox_rename",
   *     "params": { "shared_link": "{{case_dropbox}}", "new_name": " {{contact_name}} - {{case_number}}" }
   *   }
   */
  dropbox_rename: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { path, shared_link, new_name, credential_id } = params;
    if (!new_name) throw new Error('dropbox_rename requires new_name');
    if (!path && !shared_link) throw new Error('dropbox_rename requires path or shared_link');

    console.log(`[DROPBOX_RENAME] → "${new_name}"`);
    const result = await dropbox.renamePath(db, {
      path,
      sharedLink: shared_link,
      newName: new_name,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  },

  /**
   * dropbox_delete
   * Delete a file/folder by path or shared link. Refuses root.
   *
   * params:
   *   path          {string?} — OR
   *   shared_link   {string?}
   *   credential_id {number?}
   *
   * example config:
   *   { "function_name": "dropbox_delete", "params": { "path": "{{file_path}}" } }
   */
  dropbox_delete: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { path, shared_link, credential_id } = params;
    if (!path && !shared_link) throw new Error('dropbox_delete requires path or shared_link');

    console.log(`[DROPBOX_DELETE] ${path ? `"${path}"` : `link=${shared_link}`}`);
    const result = await dropbox.deletePath(db, {
      path,
      sharedLink: shared_link,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  },

  /**
   * dropbox_save_url
   * Pull a file FROM A URL into Dropbox (transfer runs on Dropbox's side —
   * Cloud Run friendly, bytes never transit our instance). Destination is
   * either a full `path` (including filename) or the case folder via
   * `shared_link` + `filename` (+ optional `subfolder`).
   *
   * Waits for completion by default (~25s); if still running, returns
   * { status: 'in_progress', async_job_id } instead of failing.
   *
   * params:
   *   url           {string}   — required; source URL
   *   path          {string?}  — full destination path incl. filename; OR
   *   shared_link   {string?}  — + filename below
   *   filename      {string?}  — required with shared_link; leading spaces preserved
   *   subfolder     {string?}  — e.g. "Client Uploads"
   *   wait          {boolean?} — default true
   *   credential_id {number?}
   *
   * example config:
   *   {
   *     "function_name": "dropbox_save_url",
   *     "params": {
   *       "url": "{{attachment_url}}",
   *       "shared_link": "{{case_dropbox}}",
   *       "subfolder": "Client Uploads",
   *       "filename": " {{contact_name}} - {{caseId}} - statement.pdf"
   *     },
   *     "set_vars": { "saved_status": "{{this.output.status}}" }
   *   }
   */
  dropbox_save_url: async (params, db) => {
    const dropbox = require('../services/dropboxService');
    const { url, path, shared_link, filename, subfolder, wait, credential_id } = params;
    if (!url) throw new Error('dropbox_save_url requires url');
    if (!path && !shared_link) throw new Error('dropbox_save_url requires path or shared_link');

    console.log(`[DROPBOX_SAVE_URL] ${url} → ${path ? `"${path}"` : `link+${filename}`}`);
    const result = await dropbox.saveUrl(db, {
      url,
      path,
      sharedLink: shared_link,
      filename,
      subfolder,
      ...(wait !== undefined && { wait: wait === true }),
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  },

  /**
   * dropbox_ensure_case_folder
   * Ensure a case has a Dropbox folder + shared link in cases.case_dropbox.
   * Thin wrapper over caseService.ensureCaseDropboxFolder — STAGE-AWARE:
   * a case with a docket number gets the Active-tree convention + the four
   * staff subfolders; otherwise the Potential-tree convention (+ Client
   * Uploads). Names come from the Primary contact. Idempotent: if
   * case_dropbox is already set it returns the existing link untouched
   * (force: true to recreate and overwrite the saved link).
   *
   * Templates: app_settings 'dropbox_case_folder_templates' (per-stage,
   * per-case_type) with hardcoded fallback — see caseService.
   *
   * Output: { existed, stage, path, shared_link, folder_existed,
   *           subfolders_created }
   *
   * params:
   *   case_id {string}   — required
   *   force   {boolean?} — default false; create even if a link exists
   *
   * example config (Voluntary Petition workflow — guarantees a filed case
   * has a folder before any move/upload steps):
   *   {
   *     "function_name": "dropbox_ensure_case_folder",
   *     "params": { "case_id": "{{cases.case_id}}" },
   *     "set_vars": { "case_dropbox": "{{this.output.shared_link}}" }
   *   }
   */
  dropbox_ensure_case_folder: async (params, db) => {
    const caseService = require('../services/caseService');  // deferred require (convention)
    const { case_id, force } = params;
    if (!case_id) throw new Error('dropbox_ensure_case_folder requires case_id');

    console.log(`[DROPBOX_ENSURE_CASE_FOLDER] case ${case_id}${force === true ? ' (force)' : ''}`);
    const result = await caseService.ensureCaseDropboxFolder(db, case_id, {
      force: force === true,
    });

    return { success: true, output: result };
  },

  // ─────────────────────────────────────────────────────────────
  // EVENTS (services/eventService.js)
  //
  // First-class dated case/contact obligations (hearings, deadlines,
  // internal milestones). Distinct from appts (meetings) and tasks (to-dos).
  // These let automation drive events natively (341 → docs-deadline,
  // court-email → hearing) without a Pabbly bridge.
  // ─────────────────────────────────────────────────────────────

  /**
   * create_event
   * Create an event with full side-effects (log, GCal create, optional
   * reminder task). Delegates to eventService.createEvent.
   *
   * params:
   *   event_title       {string}   – required
   *   event_date        {string}   – required, 'YYYY-MM-DD' (firm-local)
   *   event_type        {string?}
   *   event_link_type   {string?}  – 'case' | 'contact' | 'case_number' (omit for internal)
   *   event_link_id     {string?}  – case_id, contact_id, or the docket string
   *                                  verbatim for 'case_number' (opaque — no
   *                                  shape validation; resolved query-side)
   *   event_time        {string?}  – 'HH:MM[:SS]'; omit/null for all-day
   *   event_all_day     {boolean?} – authoritative all-day flag
   *   event_length      {number?}  – minutes; timed events only
   *   event_location    {string?}
   *   event_link        {string?}  – zoom / dial-in / docket url
   *   event_note        {string?}
   *   event_calendar_id {string?}  – per-event calendar override; 'none' skips gcal
   *   event_with        {number?}  – users.user (does_appts=1). Scopes which
   *                                  provider's booking availability a timed
   *                                  event blocks: omit/null = blocks ALL
   *                                  providers (firm-wide); an id = blocks
   *                                  only that provider; 0 = blocks NOBODY.
   *   acting_user_id    {number?}  – users.user; omit/0 = automation
   *   reminder          {object?}  – { to:<userId>, date:'YYYY-MM-DD', title? }
   *
   * example config:
   *   {
   *     "function_name": "create_event",
   *     "params": {
   *       "event_type": "Confirmation Hearing",
   *       "event_link_type": "case",
   *       "event_link_id": "{{caseId}}",
   *       "event_title": "Confirmation Hearing – {{case_number}}",
   *       "event_date": "{{hearing_date}}",
   *       "event_time": "10:00:00"
   *     },
   *     "set_vars": { "new_event_id": "{{this.output.event_id}}" }
   *   }
   */
  create_event: async (params, db) => {
    const eventService = require('../services/eventService');  // deferred require (circular dep safety)

    const {
      event_title,
      event_date,
      event_type        = null,
      event_link_type   = null,
      event_link_id     = null,
      event_time        = null,
      event_all_day,
      event_length      = null,
      event_location    = null,
      event_link        = null,
      event_note        = null,
      event_calendar_id = null,
      event_with        = null,
      acting_user_id,
      reminder          = null,
    } = params;

    if (!event_title) throw new Error('create_event requires event_title');
    if (!event_date)  throw new Error('create_event requires event_date');

    console.log(`[CREATE_EVENT] "${event_title}" ${event_link_type || 'internal'}:${event_link_id || '-'} date=${event_date}`);

    const result = await eventService.createEvent(db, {
      event_title,
      event_date,
      event_type,
      event_link_type,
      event_link_id,
      event_time,
      event_all_day,
      event_length:  event_length != null ? parseInt(event_length, 10) : null,
      event_location,
      event_link,
      event_note,
      event_calendar_id,
      event_with:    event_with != null && event_with !== '' ? parseInt(event_with, 10) : null,
      acting_user_id: acting_user_id != null ? parseInt(acting_user_id, 10) : null,
      reminder,
    });

    return {
      success: true,
      output: { event_id: result.event_id, event: result.event }
    };
  },

  /**
   * update_event
   * Update one or more fields on an event (whitelisted columns only), and/or
   * swap its reminder task. Re-syncs the calendar event if a gcal-affecting
   * field changed. Delegates to eventService.updateEvent.
   *
   * params:
   *   event_id  {number|string}  — target
   *   fields    {object?}        — column → value pairs. Allowed: event_type,
   *             event_link_type, event_link_id, event_title, event_date,
   *             event_time, event_all_day, event_length, event_location,
   *             event_link, event_note, event_status, event_calendar_id,
   *             event_with (null = blocks all providers' availability;
   *             a does_appts user id = blocks only that provider; 0 = nobody).
   *   reminder  {object|null?}   — OMIT to leave reminders alone. Object
   *             { to:<userId>, date:'YYYY-MM-DD', title? } cancels existing
   *             active reminder task(s) and spawns a new one. null cancels
   *             existing reminder task(s) and spawns none.
   *   acting_user_id {number?}
   *
   * At least one of `fields` or `reminder` must be provided.
   *
   * example config (reschedule hearing + its reminder in one call):
   *   {
   *     "function_name": "update_event",
   *     "params": {
   *       "event_id": "{{eventId}}",
   *       "fields": { "event_date": "{{new_date}}" },
   *       "reminder": { "to": 3, "date": "{{new_reminder_date}}" }
   *     }
   *   }
   */
  update_event: async (params, db) => {
    const eventService = require('../services/eventService');
    const { event_id, fields, acting_user_id = 0 } = params;
    const hasReminder = Object.prototype.hasOwnProperty.call(params, 'reminder');
    if (!event_id) throw new Error('update_event requires event_id');

    const hasFields = fields && typeof fields === 'object' && Object.keys(fields).length > 0;
    if (!hasFields && !hasReminder) {
      throw new Error('update_event requires a non-empty fields object or a reminder');
    }

    console.log(`[UPDATE_EVENT] id=${event_id} fields=${JSON.stringify(fields || {})} reminder=${hasReminder ? 'set' : 'none'}`);

    const result = await eventService.updateEvent(
      db, event_id, fields || {}, parseInt(acting_user_id, 10) || 0,
      hasReminder ? { reminder: params.reminder } : {}
    );

    return { success: true, output: { event: result.event } };
  },

  /**
   * complete_event
   * Mark an event Completed. Cancels any reminder task(s). The calendar entry
   * is left in place (it's a real past obligation).
   *
   * params:
   *   event_id        {number|string}
   *   acting_user_id  {number?}
   *
   * example config:
   *   { "function_name": "complete_event", "params": { "event_id": "{{eventId}}" } }
   */
  complete_event: async (params, db) => {
    const eventService = require('../services/eventService');
    const { event_id, acting_user_id = 0 } = params;
    if (!event_id) throw new Error('complete_event requires event_id');

    console.log(`[COMPLETE_EVENT] id=${event_id}`);

    const result = await eventService.completeEvent(
      db, event_id, parseInt(acting_user_id, 10) || 0
    );

    return { success: true, output: { event: result.event } };
  },

  /**
   * lookup_event
   * Fetch an event row (with resolved link label) and return it as output.
   * Use set_vars to map fields into workflow variables.
   *
   * params:
   *   event_id  {number|string}
   *
   * example config:
   *   {
   *     "function_name": "lookup_event",
   *     "params": { "event_id": "{{eventId}}" },
   *     "set_vars": {
   *       "event_status": "{{this.event_status}}",
   *       "event_date":   "{{this.event_date}}"
   *     }
   *   }
   */
  lookup_event: async (params, db) => {
    const eventService = require('../services/eventService');
    const { event_id } = params;
    if (!event_id) throw new Error('lookup_event requires event_id');

    console.log(`[LOOKUP_EVENT] id=${event_id}`);

    const event = await eventService.getEvent(db, parseInt(event_id, 10));
    if (!event) throw new Error(`Event ${event_id} not found`);

    return {
      success: true,
      output: event   // entire row + link_label available as {{this.column_name}}
    };
  },

  /**
   * get_events
   * Query the events table with optional filters and return results in a
   * format suitable for email, SMS, or variable storage. Mirrors
   * get_appointments' output shape.
   *
   * params:
   *   link_type   {string?}  – 'case' | 'contact' | 'case_number'
   *   link_id     {string?}
   *   status      {string?}  – event_status filter; omit (or 'all') for all.
   *                            Defaults to 'Scheduled'.
   *   type        {string?}  – event_type
   *   from        {string?}  – event_date >= (YYYY-MM-DD)
   *   to          {string?}  – event_date <= (YYYY-MM-DD)
   *   date        {string?}  – 'today' | 'tomorrow' | 'YYYY-MM-DD' (exact day)
   *   limit       {number?}  – default 200
   *   format      {string?}  – 'raw' (default) | 'html_rows' | 'count'
   *   output_var  {string?}  – store formatted result in this workflow variable
   *   count_var   {string?}  – store row count in this workflow variable
   *   base_url    {string?}  – base URL for links in html_rows
   *
   * Returns:
   *   { success, output: { rows, count, html, has_events }, set_vars }
   *
   * example config:
   *   {
   *     "function_name": "get_events",
   *     "params": { "status": "Scheduled", "date": "tomorrow", "format": "html_rows",
   *                 "output_var": "eventRows", "count_var": "eventCount" },
   *     "set_vars": { "eventRows": "{{this.output.html}}", "eventCount": "{{this.output.count}}" }
   *   }
   */
  get_events: async (params, db) => {
    const {
      link_type,
      link_id,
      status   = 'Scheduled',
      type,
      from,
      to,
      date,
      limit    = 200,
      format   = 'raw',
      base_url = process.env.APP_URL || 'https://app.4lsg.com',
    } = params;

    const conditions = [];
    const queryParams = [];

    if (link_type && link_id != null && link_id !== '') {
      conditions.push('events.event_link_type = ? AND events.event_link_id = ?');
      queryParams.push(link_type, String(link_id));
    } else if (link_type) {
      conditions.push('events.event_link_type = ?');
      queryParams.push(link_type);
    }

    if (status && status !== 'all' && status !== 'All') {
      conditions.push('events.event_status = ?');
      queryParams.push(status);
    }

    if (type) { conditions.push('events.event_type = ?'); queryParams.push(type); }

    if (date) {
      if (date === 'today') {
        conditions.push('events.event_date = CURDATE()');
      } else if (date === 'tomorrow') {
        conditions.push('events.event_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)');
      } else {
        const d = new Date(date);
        if (isNaN(d.getTime())) throw new Error(`get_events: invalid date "${date}"`);
        conditions.push('events.event_date = ?');
        queryParams.push(String(date).slice(0, 10));
      }
    }

    if (from) { conditions.push('events.event_date >= ?'); queryParams.push(String(from).slice(0, 10)); }
    if (to)   { conditions.push('events.event_date <= ?'); queryParams.push(String(to).slice(0, 10)); }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await db.query(
      `SELECT
         events.event_id,
         events.event_type,
         events.event_link_type,
         events.event_link_id,
         events.event_title,
         events.event_date,
         events.event_time,
         events.event_all_day,
         events.event_length,
         events.event_location,
         events.event_link,
         events.event_status,
         DATE_FORMAT(events.event_date, '%W %e, %Y')  AS event_date_fmt,
         DATE_FORMAT(events.event_date, '%b. %e, %Y') AS format_date,
         TIME_FORMAT(events.event_time, '%h:%i %p')   AS event_time_fmt,
         contacts.contact_name,
         contacts.contact_id,
         COALESCE(cases.case_number_full, cases.case_number, events.event_link_id) AS case_number
       FROM events
       LEFT JOIN contacts ON (events.event_link_type = 'contact' AND events.event_link_id = contacts.contact_id)
       LEFT JOIN cases    ON (events.event_link_type = 'case'    AND events.event_link_id = cases.case_id)
       ${whereSql}
       ORDER BY events.event_date ASC, events.event_time IS NULL DESC, events.event_time ASC
       LIMIT ?`,
      [...queryParams, parseInt(limit, 10)]
    );

    const count = rows.length;

    console.log(`[GET_EVENTS] Found ${count} event(s)`);

    let html = '';
    if (format === 'html_rows' || format === 'html_table') {
      if (count === 0) {
        html = `<tr><td colspan="5" style="text-align:center; padding:12px; color:#888;">No events</td></tr>`;
      } else {
        html = rows.map(ev => {
          const whenCell = ev.event_all_day
            ? ev.event_date_fmt
            : `${ev.event_date_fmt}${ev.event_time_fmt ? ' at ' + ev.event_time_fmt : ''}`;

          let linkCell = 'internal';
          if (ev.event_link_type === 'contact' && ev.contact_id) {
            linkCell = `<a href="${base_url}/?contact=${ev.contact_id}" style="color:#1a73e8;">${ev.contact_name || ev.event_link_id}</a>`;
          } else if (ev.event_link_type === 'case' && ev.event_link_id) {
            linkCell = `<a href="${base_url}/?case=${ev.event_link_id}" style="color:#1a73e8;">${ev.case_number || ev.event_link_id}</a>`;
          } else if (ev.event_link_type === 'case_number' && ev.event_link_id) {
            // Docket-linked: plain text docket (this lightweight query does no
            // case resolution; the COALESCE case_number alias already falls
            // back to the docket for these rows).
            linkCell = ev.event_link_id;
          }

          return `<tr>
            <td style="padding:6px; border:1px solid #ddd;">${ev.event_id}</td>
            <td style="padding:6px; border:1px solid #ddd;">${ev.event_type || '—'}</td>
            <td style="padding:6px; border:1px solid #ddd;">${ev.event_title || '—'}</td>
            <td style="padding:6px; border:1px solid #ddd;">${whenCell}</td>
            <td style="padding:6px; border:1px solid #ddd;">${linkCell}</td>
          </tr>`;
        }).join('\n');
      }
    }

    const output = {
      rows,
      count,
      html,
      has_events: count > 0,
    };

    const set_vars = {};
    if (params.output_var) set_vars[params.output_var] = (format === 'html_rows' || format === 'html_table') ? html : rows;
    if (params.count_var)  set_vars[params.count_var]  = count;

    return { success: true, output, set_vars };
  },


  // ─────────────────────────────────────────────────────────────
  // GENERAL QUERY
  // ─────────────────────────────────────────────────────────────

  /**
   * query_db
   * Build and execute a safe parameterized SELECT from a JSON descriptor.
   * No raw SQL accepted — query is built from validated, whitelisted
   * identifiers with fully parameterized WHERE values.
   *
   * params:
   *   select       {string[]}  columns e.g. ["contacts.contact_name","appts.appt_date"]
   *                            use "*" for all columns from the FROM table
   *   from         {string}    primary table name
   *   join         {object[]}  optional JOIN clauses (see shape below)
   *   where        {object[]}  optional WHERE conditions (see shape below)
   *   where_mode   "and"|"or"  default "and"
   *   order_by     {object[]}  optional [{ column, dir: "asc"|"desc" }]
   *   limit        {number}    default 100, max 1000
   *   format       "raw"|"html_rows"|"count"|"first"   default "raw"
   *   output_var   {string}    store result in this workflow variable
   *   count_var    {string}    store row count in this variable
   *   base_url     {string}    base URL for links in html_rows
   *   html_columns {object[]}  column display config for html_rows
   *
   * JOIN shape:
   *   { type: "left", table: "judges", alias: "j",
   *     on: { left: "cj.judge_id", right: "j.judge_id" } }
   *
   * WHERE shape:
   *   { column: "appts.appt_status", op: "=",       value: "Scheduled" }
   *   { column: "appts.appt_date",   op: ">=",      value: "{{fromDate}}" }
   *   { column: "appts.appt_id",     op: "IN",      value: [1, 2, 3] }
   *   { column: "contacts.contact_dob", op: "IS NULL" }
   *
   * HTML_COLUMNS shape:
   *   [
   *     { column: "appts.appt_id",         label: "ID" },
   *     { column: "contacts.contact_name", label: "Client",
   *       link_base: "/?contact=", link_id: "contacts.contact_id" }
   *   ]
   *
   * Security:
   *   - Only tables in QUERY_DB_ALLOWED_TABLES may be queried
   *   - users.password and users.password_hash stripped from all results
   *   - All identifiers validated as word characters only
   *   - All values fully parameterized — no injection possible
   *
   * Example — fetch judge and trustee for a case:
   *   {
   *     "function_name": "query_db",
   *     "params": {
   *       "select": ["j.judge_name", "j.judge_court", "t.trustee_name"],
   *       "from": "cases",
   *       "join": [
   *         { "type": "left", "table": "case_judge",  "alias": "cj",
   *           "on": { "left": "cases.case_id", "right": "cj.case_id" } },
   *         { "type": "left", "table": "judges",      "alias": "j",
   *           "on": { "left": "cj.judge_id",  "right": "j.judge_id" } },
   *         { "type": "left", "table": "case_trustee","alias": "ct",
   *           "on": { "left": "cases.case_id", "right": "ct.case_id" } },
   *         { "type": "left", "table": "trustees",    "alias": "t",
   *           "on": { "left": "ct.trustee_id","right": "t.trustee_id" } }
   *       ],
   *       "where": [{ "column": "cases.case_id", "op": "=", "value": "{{caseId}}" }],
   *       "format": "first",
   *       "output_var": "caseDetails"
   *     }
   *   }
   */
  query_db: async (params, db) => {
    const {
      select, from, join = [], where = [],
      where_mode = 'and', order_by = [],
      limit = 100, format = 'raw',
      output_var, count_var,
      base_url = process.env.APP_URL || 'https://app.4lsg.com',
      html_columns,
    } = params;

    if (!from) throw new Error('query_db: "from" is required');
    if (!select || !Array.isArray(select) || !select.length)
      throw new Error('query_db: "select" must be a non-empty array');

    const fromTable = _qdbValidateTable(_qdbValidateId(from, 'from'), 'from');

    // Build alias → real table map (needed to validate SELECT/WHERE references)
    const aliasMap = new Map();
    aliasMap.set(fromTable, fromTable);

    // ── Validate JOINs first so aliases are registered ──
    const joinClauses = [];
    for (const j of join) {
      const joinType  = (j.type || 'left').toLowerCase();
      if (!QUERY_DB_JOIN_TYPES.has(joinType)) throw new Error(`query_db: invalid join type "${j.type}"`);
      const joinTable = _qdbValidateTable(_qdbValidateId(j.table, 'join.table'), 'join.table');
      const alias     = j.alias ? _qdbValidateId(j.alias, 'join.alias') : null;
      if (alias) aliasMap.set(alias, joinTable);
      aliasMap.set(joinTable, joinTable);
      if (!j.on?.left || !j.on?.right) throw new Error('query_db: each join requires on.left and on.right');
      _qdbValidateId(j.on.left, 'join.on.left');
      _qdbValidateId(j.on.right, 'join.on.right');
      const aliasSql = alias ? ` \`${alias}\`` : '';
      joinClauses.push(
        `${joinType.toUpperCase()} JOIN \`${joinTable}\`${aliasSql} ON ${_qdbEscId(j.on.left)} = ${_qdbEscId(j.on.right)}`
      );
    }

    // ── SELECT ──
    const selectParts = [];
    for (const col of select) {
      if (col === '*') { selectParts.push(`\`${fromTable}\`.*`); continue; }
      _qdbValidateId(col, 'select column');
      const tableRef = col.split('.')[0];
      if (!aliasMap.has(tableRef)) throw new Error(`query_db: select references unknown table/alias "${tableRef}"`);
      selectParts.push(_qdbEscId(col));
    }

    // ── WHERE ──
    const whereParams = [];
    const whereParts  = [];
    for (const clause of where) {
      if (!clause.column || !clause.op) throw new Error('query_db: each where clause needs column and op');
      _qdbValidateId(clause.column, 'where.column');
      const tableRef = clause.column.split('.')[0];
      if (!aliasMap.has(tableRef)) throw new Error(`query_db: where references unknown table/alias "${tableRef}"`);
      const op = clause.op.toUpperCase();
      if (!QUERY_DB_WHERE_OPS.has(op)) throw new Error(`query_db: invalid operator "${clause.op}"`);
      if (op === 'IS NULL' || op === 'IS NOT NULL') {
        whereParts.push(`${_qdbEscId(clause.column)} ${op}`);
      } else if (op === 'IN' || op === 'NOT IN') {
        if (!Array.isArray(clause.value) || !clause.value.length)
          throw new Error('query_db: IN/NOT IN requires a non-empty array value');
        whereParts.push(`${_qdbEscId(clause.column)} ${op} (${clause.value.map(() => '?').join(', ')})`);
        whereParams.push(...clause.value);
      } else {
        whereParts.push(`${_qdbEscId(clause.column)} ${op} ?`);
        whereParams.push(clause.value ?? null);
      }
    }

    // ── ORDER BY ──
    const orderParts = [];
    for (const o of order_by) {
      if (!o.column) throw new Error('query_db: order_by entry needs column');
      _qdbValidateId(o.column, 'order_by.column');
      const dir = (o.dir || 'asc').toLowerCase();
      if (!QUERY_DB_ORDER_DIRS.has(dir)) throw new Error(`query_db: invalid order direction "${o.dir}"`);
      orderParts.push(`${_qdbEscId(o.column)} ${dir.toUpperCase()}`);
    }

    const limitInt = Math.min(Math.max(1, parseInt(limit) || 100), 1000);

    // ── Assemble SQL ──
    const sql = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM \`${fromTable}\``,
      ...joinClauses,
      whereParts.length ? `WHERE ${whereParts.join(` ${where_mode.toUpperCase()} `)}` : '',
      orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '',
      `LIMIT ${limitInt}`,
    ].filter(Boolean).join(' ');

    console.log(`[QUERY_DB] SQL: ${sql}`);

    let rows;
    try {
      [rows] = await db.query(sql, whereParams);
    } catch (err) {
      throw new Error(`query_db execution failed: ${err.message}
SQL: ${sql}`);
    }

    // ── Strip blocked columns ──
    rows = rows.map(row => {
      const clean = { ...row };
      for (const [, realTable] of aliasMap.entries()) {
        (QUERY_DB_BLOCKED_COLUMNS[realTable] || []).forEach(col => delete clean[col]);
      }
      return clean;
    });

    const count = rows.length;

    // ── Format ──
    let output;
    if (format === 'count') {
      output = count;
    } else if (format === 'first') {
      output = rows[0] || null;
    } else if (format === 'html_rows') {
      if (count === 0) {
        output = `<tr><td colspan="${select.length}" style="text-align:center;padding:12px;color:#888;">No results</td></tr>`;
      } else if (html_columns && Array.isArray(html_columns)) {
        output = rows.map(row => {
          const cells = html_columns.map(hc => {
            const rawVal = row[hc.column] ?? row[hc.column.split('.').pop()] ?? '';
            let cell;
            if (hc.link_base && hc.link_id) {
              const linkId = row[hc.link_id] ?? row[hc.link_id.split('.').pop()] ?? '';
              cell = `<a href="${base_url}${hc.link_base}${linkId}" style="color:#1a73e8;">${rawVal}</a>`;
            } else {
              cell = String(rawVal);
            }
            return `<td style="padding:6px;border:1px solid #ddd;">${cell}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
      } else {
        output = rows.map(row =>
          `<tr>${Object.values(row).map(v =>
            `<td style="padding:6px;border:1px solid #ddd;">${v ?? ''}</td>`
          ).join('')}</tr>`
        ).join('');
      }
    } else {
      output = rows;
    }

    const set_vars = {};
    if (output_var) set_vars[output_var] = output;
    if (count_var)  set_vars[count_var]  = count;

    return { success: true, output, count, set_vars };
  },


  // ─────────────────────────────────────────────────────────────
// SEQUENCES (Phase 0.6)
// ─────────────────────────────────────────────────────────────
 
  /**
   * cancel_sequences
   * Cancel all active sequence enrollments of a given type for a contact.
   * Wraps sequenceEngine.cancelSequences().
   *
   * params:
   *   contact_id     {number|string}  — required
   *   template_type  {string|null}    — e.g. 'no_show'. Omit or null to cancel ALL types.
   *   reason         {string}         — logged in cancel_reason (default: 'internal_function')
   *
   * example config:
   *   {
   *     "function_name": "cancel_sequences",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "template_type": "no_show",
   *       "reason": "new_appointment_booked"
   *     }
   *   }
   */
cancel_sequences: async (params, db) => {
    const sequenceEngine = require('./sequenceEngine');  // ← lazy require
    const { contact_id, template_type = null, reason = 'internal_function' } = params;
    if (!contact_id) throw new Error('cancel_sequences requires contact_id');
 
    console.log(`[CANCEL_SEQUENCES] contact=${contact_id} type=${template_type || 'all'} reason=${reason}`);
 
    const result = await sequenceEngine.cancelSequences(db, contact_id, template_type, reason);
 
    return {
      success: true,
      output: result  // { cancelled: number }
    };
  },
 
/**
   * enroll_sequence
   * Enroll a contact in a sequence template. Two modes:
   *
   *   (a) By template type (cascade match): pass `template_type`. The
   *       engine loads the type's priority_fields from
   *       sequence_template_types and scores each active template against
   *       trigger_data; the most-specific qualifying template wins. Any
   *       cascade keys (e.g. appt_type, appt_with, case_type) must be
   *       present in trigger_data — there is no separate filters arg.
   *
   *   (b) By template ID (direct): pass `template_id` for a specific
   *       template. Bypasses cascade matching. The template must be active.
   *
   *   Exactly one of `template_type` or `template_id` must be provided.
   *
   * Wraps sequenceEngine.enrollContact() (by type) or
   *       sequenceEngine.enrollContactByTemplateId() (by id).
   *
   * params:
   *   contact_id     {number|string}  — required
   *   template_type  {string}         — required if template_id is omitted
   *   template_id    {number|string}  — required if template_type is omitted
   *   trigger_data   {object}         — optional context passed to the sequence
   *                                     (appt_id, appt_time, case_id, and any
   *                                     cascade keys declared in the type's
   *                                     priority_fields)
   *
   * example config (by type):
   *   {
   *     "function_name": "enroll_sequence",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "template_type": "no_show",
   *       "trigger_data": {
   *         "appt_id":   "{{apptId}}",
   *         "appt_type": "{{apptType}}",
   *         "appt_with": "{{apptWith}}",
   *         "enrolled_by": "workflow"
   *       }
   *     }
   *   }
   *
   * example config (by id):
   *   {
   *     "function_name": "enroll_sequence",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "template_id": 42,
   *       "trigger_data": { "source": "manual_test" }
   *     }
   *   }
   */
  enroll_sequence: async (params, db) => {
    const sequenceEngine = require('./sequenceEngine');  // ← lazy require
    const {
      contact_id,
      template_type,
      template_id,
      trigger_data = {},
    } = params;

    if (!contact_id) throw new Error('enroll_sequence requires contact_id');

    const hasType = template_type !== undefined && template_type !== null && template_type !== '';
    const hasId   = template_id   !== undefined && template_id   !== null && template_id   !== '';

    if (hasType && hasId) {
      throw new Error('enroll_sequence: provide exactly one of template_type or template_id, not both');
    }
    if (!hasType && !hasId) {
      throw new Error('enroll_sequence requires template_type or template_id');
    }

    let result;
    if (hasId) {
      const idInt = parseInt(template_id, 10);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        throw new Error('enroll_sequence: template_id must be a positive integer');
      }
      console.log(`[ENROLL_SEQUENCE] contact=${contact_id} template_id=${idInt}`);
      result = await sequenceEngine.enrollContactByTemplateId(db, contact_id, idInt, trigger_data);
    } else {
      console.log(`[ENROLL_SEQUENCE] contact=${contact_id} type=${template_type}`);
      result = await sequenceEngine.enrollContact(db, contact_id, template_type, trigger_data);
    }

    return {
      success: true,
      output: result,  // { enrollmentId, templateName, totalSteps, firstJobScheduledAt }
    };
  },
 
 
// ─────────────────────────────────────────────────────────────
// LOG (Phase 0.7)
// ─────────────────────────────────────────────────────────────
 
  /**
   * create_log
   * Insert a log entry. Used by workflows/sequences to record events.
   *
   * Phase 2: thin shim over services/logService.createLogEntry. The
   * heavy lifting — phone/email link_id normalization (Track A.1
   * Phase A), direction normalization (Slice 4-C), and log_data
   * enrichment from typed display params (Phase 2) — all lives in
   * logService now so REST callers via /api/log get the same shape.
   *
   * params:
   *   type         {string}         — log_type enum: 'email','sms','call','other','form',
   *                                   'status','note','court email','docs','appt','update'
   *   link_type    {string|null}    — 'contact','case','appt','bill','phone','email' (optional)
   *   link_id      {string|number}  — the ID for the link (optional)
   *   by           {number}         — user ID (0 for system/automation)
   *   data         {string|object}  — log_data content (JSON string or object)
   *   from         {string|null}    — log_from + folded into log_data.from
   *   to           {string|null}    — log_to + folded into log_data.to
   *   subject      {string|null}    — log_subject + folded into log_data.subject
   *   message      {string|null}    — log_message + folded into log_data.message
   *   direction    {string|null}    — 'incoming' or 'outgoing' (normalized
   *                                   from 'Inbound'/'Outbound') — column only
   *
   * example config:
   *   {
   *     "function_name": "create_log",
   *     "params": {
   *       "type": "note",
   *       "link_type": "contact",
   *       "link_id": "{{contactId}}",
   *       "by": 0,
   *       "data": "{\"source\": \"workflow\", \"note\": \"Auto follow-up sent\"}"
   *     },
   *     "set_vars": { "logId": "{{this.output.log_id}}" }
   *   }
   */
  create_log: async (params, db) => {
    const logService = require('../services/logService');
    const result = await logService.createLogEntry(db, params);
    return { success: true, output: result };
  },

  /**
   * phone_log
   * Phone-event log write with forensic catch-all + Layer-2 suppression.
   * Drop-in replacement for create_log in the 5 phone workflows
   * (wf17 s1, wf18 s1, wf19 s4, wf20 s4, wf21 s1). Accepts the SAME params
   * create_log accepts and returns the SAME shape ({ success, output:{log_id} })
   * so downstream steps (find_contact / cancel_sequences) read
   * {{this.output.log_id}} unchanged.
   *
   * Pipeline (per event):
   *   1. firmToFirm enrichment — stamp params.extra.firmToFirm = (other party
   *      is also a firm number). Persists into log_extra automatically since
   *      extra is the column logService stores. Queryable later; usable as a
   *      suppression match field (extra.firmToFirm).
   *   2. Write phone_event_log catch-all — ALWAYS, idempotent
   *      (INSERT ... ON DUPLICATE KEY UPDATE). Forensic; never gates logging.
   *   3. evaluateSuppressions(db, params). If suppressed: mark the catch-all
   *      row, SKIP createLogEntry, return output.log_id = null.
   *   4. Else createLogEntry, backfill catch-all.log_id, return result.
   *
   * Suppression governs the LOG WRITE only — it does NOT halt the workflow
   * (design call 1A). Downstream steps run regardless; output.suppressed is
   * surfaced for observability/branching if ever wanted.
   *
   * Firm-to-firm is NOT a hardcoded skip here — it is exposed as the
   * extra.firmToFirm match field so the operator can choose to suppress it
   * (or not) via a normal suppression rule, visible in the UI with metrics.
   */
  phone_log: async (params, db) => {
    // Thin skin. The pipeline (firmToFirm enrich → phone_event_log catch-all →
    // Layer-2 suppression → createLogEntry, with the suppressed/backfill
    // branches) lives in services/phoneIngestService.ingestPhoneEvent. Layer 3
    // (rules + executions) will be wired inside that service by a later worker.
    // Lazy-required for the same circular-dep safety as logService.
    const phoneIngestService = require('../services/phoneIngestService');
    const output = await phoneIngestService.ingestPhoneEvent(db, params || {});
    return { success: true, output };
  },



  // ─────────────────────────────────────────────────────────────
  // TASK DIGEST
  // ─────────────────────────────────────────────────────────────

  /**
   * run_task_digest — send the daily task digest on demand.
   *
   * params:
   *   user  {number|string}  (optional) — send only to this user ID
   *   force {boolean}        (optional) — skip Shabbos/Yom Tov gate
   *                                       and ignore task_remind_freq day filter
   *
   * When called with no params it behaves identically to the scheduled
   * task_daily_digest job (same Shabbos gate, same remind-freq filter).
   */
  run_task_digest: async ({ user: targetUser, force = false } = {}, db) => {
    const { DateTime }  = require('luxon');
    const calendarSvc   = require('../services/calendarService');
    const taskService   = require('../services/taskService');
    const emailSvc      = require('../services/emailService');
    const smsSvc        = require('../services/phoneService');
    const FIRM_TZ       = process.env.FIRM_TIMEZONE || 'America/Detroit';

    // ── 0. Refresh statuses (always runs) ──────────────────────
    const [overdueMoved] = await db.query(
      `UPDATE tasks
       SET task_status = 'Overdue', task_last_update = NOW()
       WHERE task_status IN ('Pending', 'Due Today')
         AND task_due IS NOT NULL
         AND task_due < CURDATE()`
    );
    const [dueTodayMoved] = await db.query(
      `UPDATE tasks
       SET task_status = 'Due Today', task_last_update = NOW()
       WHERE task_status = 'Pending'
         AND task_due = CURDATE()`
    );
    console.log(
      `[TASK DIGEST] Status refresh: ${overdueMoved.affectedRows} → Overdue, ` +
      `${dueTodayMoved.affectedRows} → Due Today`
    );

    // ── 1. Shabbos / Yom Tov gate (skipped when force=true) ────
    const nowFirm = DateTime.now().setZone(FIRM_TZ);
    if (!force) {
      const { workday, isShabbos, holidayName } = await calendarSvc.isWorkday(nowFirm.toISO());
      if (!workday) {
        const reason = isShabbos ? 'Shabbos' : `Yom Tov (${holidayName})`;
        console.log(`[TASK DIGEST] Skipping notifications — ${reason}`);
        return { skipped_reason: reason, overdue_moved: overdueMoved.affectedRows, due_today_moved: dueTodayMoved.affectedRows };
      }
    }

    const todayName = nowFirm.toFormat('cccc');   // "Monday"
    const todayFmt  = nowFirm.toFormat('MMMM d, yyyy');

    // ── 2. Fetch target user(s) ─────────────────────────────────
    let users;
    if (targetUser) {
      const [rows] = await db.query(
        `SELECT user, user_fname, user_name, email, phone, allow_sms, task_remind_freq
         FROM users WHERE user = ?`,
        [targetUser]
      );
      users = rows;
    } else {
      const [rows] = await db.query(
        `SELECT user, user_fname, user_name, email, phone, allow_sms, task_remind_freq
         FROM users
         WHERE task_remind_freq IS NOT NULL AND task_remind_freq != ''
           AND email IS NOT NULL AND email != ''`
      );
      users = rows;
    }

    const fromEmail = await taskService.getFromEmail(db);
    const smsFrom   = await taskService.getSmsFrom(db);

    let sent = 0, skipped = 0;

    for (const user of users) {
      // Remind-freq day filter — skipped when force=true or targeting a specific user
      if (!force && !targetUser) {
        const days = (user.task_remind_freq || '').split(',').map(d => d.trim());
        if (!days.includes(todayName)) { skipped++; continue; }
      }

      const [tasks] = await db.query(
        `SELECT
           t.task_id, t.task_status, t.task_title, t.task_due, t.task_action_token,
           co.contact_name, co.contact_id,
           ca.case_number_full, ca.case_number, ca.case_id
         FROM tasks t
         LEFT JOIN contacts co ON (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
         LEFT JOIN cases    ca ON (t.task_link_type = 'case'    AND t.task_link_id = ca.case_id)
         WHERE t.task_to = ?
           AND t.task_status IN ('Pending', 'Due Today', 'Overdue')
         ORDER BY
           FIELD(t.task_status, 'Overdue', 'Due Today', 'Pending'),
           t.task_due ASC`,
        [user.user]
      );

      if (!tasks.length) { skipped++; continue; }

      const overdue  = tasks.filter(t => t.task_status === 'Overdue');
      const dueToday = tasks.filter(t => t.task_status === 'Due Today');
      const pending  = tasks.filter(t => t.task_status === 'Pending');

      try {
        const html = taskService.buildDigestEmail(user, overdue, dueToday, pending, todayName);
        await emailSvc.sendEmail(db, {
          from:    fromEmail,
          to:      user.email,
          subject: `Your Task Summary — ${todayFmt}`,
          html
        });
      } catch (emailErr) {
        console.error(`[TASK DIGEST] Email failed for user ${user.user}:`, emailErr.message);
      }

      if (user.allow_sms && user.phone && smsFrom) {
        try {
          const parts = [];
          if (overdue.length)  parts.push(`${overdue.length} overdue`);
          if (dueToday.length) parts.push(`${dueToday.length} due today`);
          if (pending.length)  parts.push(`${pending.length} pending`);
          await smsSvc.sendSms(db, smsFrom, user.phone,
            `Hi ${user.user_fname}! Task summary for ${todayName}: ${parts.join(', ')}. Log in to YisraCase for more info.`
          );
        } catch (smsErr) {
          console.error(`[TASK DIGEST] SMS failed for user ${user.user}:`, smsErr.message);
        }
      }

      sent++;
    }

    console.log(`[TASK DIGEST] Done. Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped, overdue_moved: overdueMoved.affectedRows, due_today_moved: dueTodayMoved.affectedRows };
  },

  /**
   * run_event_digest — send the upcoming-events digest on demand.
   *
   * Thin wrapper over eventService.sendEventDigest, which owns ALL
   * orchestration (window math, grouping, recipient resolution, dispatch).
   * Used by the recurring "Event Daily Digest" scheduled job AND callable on
   * demand (apiTester / workflows / sequences).
   *
   * params (all optional):
   *   force {boolean}  — skip the Shabbos/Yom Tov send-gate
   *   from  {string}   — window start 'YYYY-MM-DD' (override; default tomorrow)
   *   to    {string}   — window end   'YYYY-MM-DD' (override; default next workday)
   *
   * example config:
   *   { "function_name": "run_event_digest", "params": {} }
   */
  run_event_digest: async (params = {}, db) => {
    const eventService = require('../services/eventService'); // deferred require (circular dep safety)
    return eventService.sendEventDigest(db, params || {});
  },

  /**
   * run_error_sweep — scan automation failure tables and email a grouped
   * alert digest. Driven by the "Error Alert Sweep" recurring job; callable
   * on demand (apiTester) with dry_run for a no-write preview.
   */
  run_error_sweep: async (params = {}, db) => {
    const { runErrorSweep } = require('./alerting'); // deferred require (circular dep safety)
    return runErrorSweep(db, params || {});
  },

  // ─────────────────────────────────────────────────────────────
  // DEV / TESTING
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // CONNECTIONS / OAUTH
  // ─────────────────────────────────────────────────────────────

  /**
   * refresh_expiring_oauth_credentials
   * Scan oauth2 credentials and proactively refresh anything whose tokens
   * are near expiry. Designed to run as a daily recurring scheduled job.
   *
   * Selection criteria (OR'd together, status='connected' required):
   *   - refresh_token_expires_at IS NOT NULL AND < NOW() + 48h
   *     (catch refresh tokens about to die so we get a fresh refresh token
   *      via rotation before the existing one expires)
   *   - access_token_expires_at < NOW() + 1h
   *     (catch stale access tokens for credentials that haven't been used
   *      lately by any webhook — lazy refresh on use never fired)
   *
   * Credentials with status pending/failed/refresh_failed/revoked are
   * skipped (refreshing a failed cred would re-fail; refreshing a revoked
   * cred would error).
   *
   * The 2-strike alert and oauth_status='refresh_failed' transition is
   * handled INSIDE oauthService.refreshTokens. This function just iterates
   * and reports counts.
   *
   * params: none
   *
   * example config:
   *   { "function_name": "refresh_expiring_oauth_credentials", "params": {} }
   */
  refresh_expiring_oauth_credentials: async (params, db) => {
    // Lazy require — heavy module specific to this one function. Matches
    // the run_task_digest pattern (require its services inline).
    const oauthService = require('../services/oauthService');

    const [rows] = await db.query(
      `SELECT id, name
         FROM credentials
        WHERE type = 'oauth2'
          AND oauth_status = 'connected'
          AND (
            (refresh_token_expires_at IS NOT NULL
             AND refresh_token_expires_at < NOW() + INTERVAL 48 HOUR)
            OR access_token_expires_at < NOW() + INTERVAL 1 HOUR
          )`
    );

    const results = {
      attempted: rows.length,
      succeeded: 0,
      failed:    0,
      errors:    [],
    };

    console.log(`[REFRESH_EXPIRING_OAUTH] ${rows.length} credentials due for refresh`);

    for (const row of rows) {
      try {
        await oauthService.refreshTokens(db, row.id);
        results.succeeded++;
        console.log(`[REFRESH_EXPIRING_OAUTH] cred ${row.id} (${row.name}) refreshed`);
      } catch (err) {
        results.failed++;
        results.errors.push({ id: row.id, name: row.name, error: err.message });
        // refreshTokens already updates failure_count + alerts at threshold.
        // We just log here so the daily-job output is searchable.
        console.error(
          `[REFRESH_EXPIRING_OAUTH] cred ${row.id} (${row.name}) failed: ${err.message}`
        );
      }
    }

    console.log(
      `[REFRESH_EXPIRING_OAUTH] done — ${results.succeeded}/${results.attempted} refreshed, ${results.failed} failed`
    );

    return { success: true, output: results };
  },

  /**
   * rc_renew_subscriptions
   * Daily idempotent renewal pass over RingCentral webhook subscriptions
   * tracked in app_settings.rc_subscriptions.
   *
   * Storage shape (one JSON-encoded array under key 'rc_subscriptions'):
   *   [{
   *     subscription_id, hook_slug, credential_id,
   *     event_filters: [...],
   *     expires_at: <ISO>,         // mirrors RC's expirationTime
   *     verification_token: <UUID>,
   *     created_at: <ISO>
   *   }, ...]
   *
   * Per-entry behavior:
   *   - expires_at > now + 48h → skip ('not_due')
   *   - else PUT subscription/<id> with body '{}' (RC extends w/ default duration)
   *       · 200 → update expires_at to response.expirationTime ('renewed')
   *       · 404 → remove from array, queue IT alert ('removed_404')
   *       · any other status / network error → log+leave untouched ('error')
   *
   * Idempotent: RC's PUT on a still-active subscription extends it. Multiple
   * runs in a row, or a partial failure mid-loop, leave the system in a
   * consistent state — the next daily pass re-tries any 'error' entries.
   *
   * The app_settings row is only written back when something actually
   * changed (renewed OR removed) — avoids unnecessary writes on no-op runs.
   *
   * params: none
   *
   * example config:
   *   { "function_name": "rc_renew_subscriptions", "params": {} }
   */
  rc_renew_subscriptions: async (params, db) => {
    const SUBSCRIPTION_BASE = 'https://platform.ringcentral.com/restapi/v1.0/subscription';
    const RENEW_LEAD_MS     = 48 * 60 * 60 * 1000; // 48h
    const REQUEST_TIMEOUT_MS = 30_000;

    // ── Load and parse the subscriptions blob ────────────────────────
    const raw = await getSetting(db, 'rc_subscriptions');
    if (!raw) {
      console.log('[RC_RENEW] no app_settings.rc_subscriptions row — nothing to do');
      return { success: true, output: { skipped: 'no subscriptions configured' } };
    }

    let subscriptions;
    try {
      subscriptions = JSON.parse(raw);
    } catch (err) {
      console.error(`[RC_RENEW] app_settings.rc_subscriptions is not valid JSON: ${err.message}`);
      return { success: true, output: { skipped: 'malformed rc_subscriptions JSON', error: err.message } };
    }
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      console.log('[RC_RENEW] rc_subscriptions array is empty — nothing to do');
      return { success: true, output: { skipped: 'no subscriptions configured' } };
    }

    console.log(`[RC_RENEW] starting pass over ${subscriptions.length} subscription(s)`);

    const now      = Date.now();
    const results  = [];
    const toRemove = new Set();   // indices into `subscriptions`
    const alerts   = [];          // payloads for IT email after the loop
    let modified   = false;

    // ── Per-entry processing ─────────────────────────────────────────
    for (let i = 0; i < subscriptions.length; i++) {
      const entry = subscriptions[i];
      const tag   = `sub=${entry.subscription_id} slug=${entry.hook_slug}`;

      const expMs = new Date(entry.expires_at).getTime();
      if (!Number.isFinite(expMs)) {
        // Malformed expires_at — treat as immediately due so we either renew it
        // or clear it via the 404 path. Surface it loudly.
        console.warn(`[RC_RENEW] ${tag} has invalid expires_at "${entry.expires_at}" — attempting renewal anyway`);
      } else if (expMs > now + RENEW_LEAD_MS) {
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'not_due',
          expires_at:      entry.expires_at,
        });
        continue;
      }

      const url = `${SUBSCRIPTION_BASE}/${encodeURIComponent(entry.subscription_id)}`;

      // Build auth headers. oauth2 requires the async builder.
      let headers;
      try {
        headers = await buildHeadersForCredential(db, entry.credential_id, url);
      } catch (err) {
        console.error(`[RC_RENEW] ${tag} buildHeadersForCredential threw: ${err.message}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           `header build failed: ${err.message}`,
        });
        continue;
      }
      if (!headers.Authorization) {
        const msg =
          `credential ${entry.credential_id} not connected, or URL ${url} ` +
          `out of allowed_urls scope`;
        console.error(`[RC_RENEW] ${tag} ${msg}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           msg,
        });
        continue;
      }

      // PUT with explicit timeout.
      const controller = new AbortController();
      const tHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method:  'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body:    '{}',
          signal:  controller.signal,
        });
      } catch (err) {
        // Network error or timeout. Don't mutate the entry; next daily pass retries.
        console.error(`[RC_RENEW] ${tag} PUT threw: ${err.message}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           `network: ${err.message}`,
        });
        continue;
      } finally {
        clearTimeout(tHandle);
      }

      if (res.status === 200) {
        let body;
        try {
          body = await res.json();
        } catch (err) {
          console.error(`[RC_RENEW] ${tag} 200 but JSON parse failed: ${err.message}`);
          results.push({
            subscription_id: entry.subscription_id,
            hook_slug:       entry.hook_slug,
            action:          'error',
            error:           `200 with malformed JSON: ${err.message}`,
          });
          continue;
        }
        const newExpiry = body.expirationTime;
        if (!newExpiry) {
          console.error(`[RC_RENEW] ${tag} 200 missing expirationTime in body`);
          results.push({
            subscription_id: entry.subscription_id,
            hook_slug:       entry.hook_slug,
            action:          'error',
            error:           '200 response missing expirationTime',
          });
          continue;
        }
        entry.expires_at = newExpiry; // mutates the array element
        modified = true;
        console.log(`[RC_RENEW] ${tag} renewed → new expires_at=${newExpiry}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'renewed',
          new_expires_at:  newExpiry,
        });
      } else if (res.status === 404) {
        // Subscription is gone on RC's side. Remove + alert.
        toRemove.add(i);
        modified = true;
        alerts.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          event_filters:   entry.event_filters,
          credential_id:   entry.credential_id,
        });
        console.warn(`[RC_RENEW] ${tag} 404 — removing from app_settings, queueing IT alert`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'removed_404',
        });
      } else {
        const text = await res.text().catch(() => '');
        console.error(
          `[RC_RENEW] ${tag} PUT failed: ${res.status} ${text.slice(0, 500)}`
        );
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          status:          res.status,
          error:           text.slice(0, 500),
        });
      }
    }

    // ── Persist back to app_settings, only if something changed ──────
    if (modified) {
      const next = subscriptions.filter((_, idx) => !toRemove.has(idx));
      try {
        await db.query(
          'REPLACE INTO app_settings (`key`, `value`) VALUES (?, ?)',
          ['rc_subscriptions', JSON.stringify(next)]
        );
        console.log(
          `[RC_RENEW] wrote back ${next.length} subscription(s) ` +
          `(removed ${toRemove.size}, renewed ${results.filter(r => r.action === 'renewed').length})`
        );
      } catch (err) {
        // Write-back failure is serious — we already mutated nothing on RC
        // (renewal PUTs are idempotent) so the next run will recompute, but
        // surface it loudly.
        console.error(`[RC_RENEW] failed to write back app_settings.rc_subscriptions: ${err.message}`);
        results.push({ action: 'error', error: `app_settings write failed: ${err.message}` });
      }
    }

    // ── IT alerts for removed-404 entries ────────────────────────────
    // Resolved AFTER the renewal loop so a slow / failing email send can't
    // block subsequent RC PUTs in this pass. Email failures are swallowed —
    // the console.error is the durable record, and the next daily pass will
    // not re-alert (the entry is already gone from app_settings).
    if (alerts.length) {
      const fromAddr =
        (await getSetting(db, 'email_automations')) ||
        process.env.AUTO_EMAIL ||
        'automations@4lsg.com';
      const toAddr = (await getSetting(db, 'email_it')) || process.env.IT_EMAIL || 'it@4lsg.com';

      for (const a of alerts) {
        const subject = `RC Subscription removed: ${a.hook_slug}`;
        const body =
          `RingCentral returned 404 for subscription ${a.subscription_id}.\n` +
          `It has been removed from app_settings.rc_subscriptions to stop the daily renewal loop.\n\n` +
          `  subscription_id: ${a.subscription_id}\n` +
          `  hook_slug:       ${a.hook_slug}\n` +
          `  credential_id:   ${a.credential_id}\n` +
          `  event_filters:   ${JSON.stringify(a.event_filters)}\n` +
          `  timestamp:       ${new Date().toISOString()}\n` +
          `  environment:     ${process.env.ENVIRONMENT || 'unknown'}\n\n` +
          `Operator: re-bootstrap this subscription via apiTester per the Slice 6 doc ` +
          `(POST RC create-subscription, then INSERT/UPDATE app_settings.rc_subscriptions).`;

        try {
          await emailService.sendEmail(db, {
            from:    fromAddr,
            to:      toAddr,
            subject,
            text:    body,
          });
          console.log(`[RC_RENEW] IT alert sent for sub=${a.subscription_id} (${a.hook_slug})`);
        } catch (err) {
          console.error(
            `[RC_RENEW] IT alert email failed for sub=${a.subscription_id} (${a.hook_slug}): ${err.message}`
          );
        }
      }
    }

    console.log(
      `[RC_RENEW] done — ${subscriptions.length} considered, ` +
      `${results.filter(r => r.action === 'renewed').length} renewed, ` +
      `${results.filter(r => r.action === 'removed_404').length} removed, ` +
      `${results.filter(r => r.action === 'not_due').length} not_due, ` +
      `${results.filter(r => r.action === 'error').length} error`
    );

    return {
      success: true,
      output: {
        count: subscriptions.length,
        results,
      },
    };
  },

  /**
   * set_test_var — dev/testing only. Remove or restrict in production.
   */
  set_test_var: async () => {
    console.log('[SET_TEST_VAR] Setting testKey = "hello"');
    return {
      success: true,
      set_vars: { testKey: 'hello' }
    };
  },

  // ─────────────────────────────────────────────────────────────
  // COURT EMAIL — AI EXTRACTION (Slice 5)
  // ─────────────────────────────────────────────────────────────
  //
  // Wires the live email-ingest path to the LLM court-email extractor in a
  // forced-dry-run posture. Registered for use by an email_ingest_rule_actions
  // row (action_type='internal_function'); NOT meant for the workflow/sequence
  // step editor, so it intentionally carries NO __meta (it reads raw envelope
  // dot-paths supplied via the rule's params_mapping, which only exist in the
  // ingest pipeline).
  //
  // INVOCATION CONVENTION (verified against lib/actionDispatchers.deliverInternalFunction):
  //   called as fn(params, db). `params` is resolveParamsMapping(action.config
  //   .params_mapping, transformedInput) where transformedInput is the canonical
  //   email envelope (rule transform_mode='passthrough'). So each param is a
  //   dot-path read off the envelope:
  //     message_id      ← headers.message_id        (gmail id; carries -test- on replays)
  //     exim_message_id ← envelope.exim_message_id  (fallback id source)
  //     subject         ← subject
  //     from_email      ← from.email
  //     body            ← text   (court NEFs put the body in text; html is a fallback)
  //     body_html       ← html
  //
  // DRY-RUN: read app_settings 'court_ingest_live'. Absent/'0' → dryRun=true;
  //   '1' → dryRun=false. THIS SLICE NEVER FLIPS IT (default-dry). Additionally,
  //   executeCourtActions FORCES dry-run whenever message_id matches /-test-/,
  //   so GAS -test- replays are always dry regardless of the flag.
  //
  // SAFETY: every failure path is caught and logged (court_ai_log via
  //   logExtractFailure) and returns a soft result — one bad court email must
  //   never break the ingest pipeline. The forensic email_log row is already
  //   durable by the time Layer 3 runs, so nothing is lost.
  court_extract: async (params, db) => {
    const courtExecutor = require('../services/courtExecutor');  // lazy require (convention)
    const aiService     = require('../services/aiService');      // lazy require (convention)
    // getSetting is imported at module scope.

    // Canonical message_id — replicate emailIngestService._resolveMessageId so
    // the id we stamp matches the email_log row exactly (incl. the -test- marker).
    const rawId =
      (params.message_id && String(params.message_id).trim()) ||
      (params.exim_message_id && String(params.exim_message_id).trim()) ||
      null;
    const messageId = rawId
      ? (rawId.replace(/^<+/, '').replace(/>+$/, '').trim() || null)
      : null;

    const subject   = params.subject != null ? String(params.subject) : '';
    const fromEmail = params.from_email != null ? String(params.from_email) : '';
    const body =
      (params.body != null && params.body !== '')
        ? String(params.body)
        : (params.body_html != null ? String(params.body_html) : '');

    // Effective dry-run flag (fail-safe to dry if the setting read throws).
    let dryRun = true;
    try {
      const liveFlag = await getSetting(db, 'court_ingest_live');
      dryRun = String(liveFlag ?? '').trim() !== '1';
    } catch (e) {
      dryRun = true;
    }

    console.log(`[COURT_EXTRACT] message_id=${messageId || '(none)'} dryRun=${dryRun}`);

    try {
      const extract = await aiService.call(db, {
        promptKey:   'court_extract',
        vars:        { message_id: messageId, subject, from_email: fromEmail },
        // SECURITY (prompt v3): subject + sender are attacker-influenceable, so
        // they ride INSIDE <untrusted_user_input> (prepended to the body) rather
        // than the trusted system block. Keep this identical to the courtPreview
        // run handler and the backtest call site.
        userInput:   `SUBJECT: ${subject}\nFROM: ${fromEmail}\n\n${body}`,
        model:       'claude-sonnet-4-6',
        outputType:  'json',
        consumerRef: `court_ingest:${messageId || 'unknown'}`,
      });

      if (!extract.ok || !extract.json) {
        await courtExecutor.logExtractFailure(db, {
          messageId,
          dryRun,
          error:     extract.error || 'no_json',
          aiCallId:  extract.callId ?? null,
        });
        return {
          success: true,
          output: {
            dry_run:     dryRun,
            skipped:     'extract_failed',
            error:       extract.error || 'no_json',
            ai_call_id:  extract.callId ?? null,
          },
        };
      }

      const payload = extract.json;
      payload.message_id = messageId;        // trust OUR canonical id, not the model echo
      payload.ai_call_id = extract.callId;

      const result = await courtExecutor.executeCourtActions(db, {
        payload,
        subject,
        body,
        dryRun,
      });

      return {
        success: true,
        output: {
          dry_run:         dryRun,
          outcome:         result.outcome,
          court_ai_log_id: result.court_ai_log_id,
          ai_call_id:      extract.callId,
          applied:         Array.isArray(result.applied) ? result.applied.length : 0,
          skipped:         Array.isArray(result.skipped) ? result.skipped.length : 0,
          review_reason:   result.review_reason || null,
        },
      };
    } catch (err) {
      // One bad court email must not break ingest — audit the failure, soft-return.
      try {
        await courtExecutor.logExtractFailure(db, {
          messageId,
          dryRun,
          error: `court_extract_threw:${err.message}`,
        });
      } catch (logErr) {
        console.error('[COURT_EXTRACT] logExtractFailure failed:', logErr.message);
      }
      console.error('[COURT_EXTRACT] error:', err.message);
      return { success: true, output: { dry_run: dryRun, skipped: 'error', error: err.message } };
    }
  },

  // ─────────────────────────────────────────────────────────────
  // court_review_retry — daily auto-retry sweep over the court review queue.
  //
  // Re-runs OPEN queued rows with review_reason='case_not_found' whose docket
  // NOW resolves (a case was created/adopted since the row was queued). Reuses
  // the stored payload — NO AI call (case_not_found rows always carry a
  // payload). Honors app_settings.court_ingest_live exactly like ingest:
  // dryRun=!(live); this sweep NEVER flips the flag.
  //
  // Deliberately scoped to case_not_found ONLY. citation_miss / model_flagged
  // queue because a HUMAN judgment is needed — auto-retrying replays identical
  // inputs to the same verdict (pointless). extract_failed has no payload;
  // retrying it would spend an AI call per row per day with no new information
  // (a transient-API retry, if ever wanted, is a separate once-with-backoff
  // design, not this sweep).
  //
  // Idempotent across runs via the queue's openness rule: a LIVE re-run that
  // lands executed/none closes the row, so it won't be picked up again; a DRY
  // re-run leaves it queued (re-attempted next run, harmlessly).
  //
  // params: { limit = 100, dry_run = false }   (dry_run here = PLAN ONLY: scan +
  //   resolve, do not execute. Distinct from court_ingest_live.)
  court_review_retry: async ({ limit = 100, dry_run = false } = {}, db) => {
    const { resolveCase } = require('../lib/courtResolve'); // lazy require (convention)
    const courtRerun      = require('../services/courtRerun');

    let cap = parseInt(limit, 10);
    if (!Number.isFinite(cap) || cap <= 0) cap = 100;
    if (cap > 500) cap = 500;

    const live = await courtRerun.isLive(db);

    // Open case_not_found queued rows (latest queued row per message_id), newest
    // first. Mirrors routes/courtReview.js OPEN_QUEUE_WHERE.
    const [rows] = await db.query(
      `SELECT cal.id, cal.message_id, cal.case_number, cal.classification, cal.raw_response
         FROM court_ai_log cal
        WHERE cal.outcome = 'queued'
          AND cal.review_reason = 'case_not_found'
          AND NOT EXISTS (
            SELECT 1 FROM court_ai_log c2
             WHERE c2.message_id = cal.message_id AND c2.id > cal.id
               AND c2.dry_run = 0 AND c2.outcome IN ('executed','none'))
          AND NOT EXISTS (
            SELECT 1 FROM court_ai_log c3
             WHERE c3.message_id = cal.message_id AND c3.id > cal.id
               AND c3.outcome = 'queued')
        ORDER BY cal.id DESC
        LIMIT ?`,
      [cap]
    );

    let resolved = 0, executed = 0, stillQueued = 0, stillMissing = 0, errors = 0;
    const details = [];

    for (const row of rows) {
      let r;
      try {
        r = await resolveCase(db, row.case_number);
      } catch (e) {
        errors++;
        details.push({ id: row.id, case_number: row.case_number, action: 'resolve_error', error: e.message });
        continue;
      }
      if (!r || !r.found) {
        stillMissing++;
        continue; // case still doesn't exist — leave queued
      }
      resolved++;

      if (dry_run) {
        details.push({ id: row.id, case_number: row.case_number, case_id: r.case_id, action: 'would_rerun' });
        continue;
      }

      try {
        const rr = await courtRerun.rerunCalRow(db, row, { allowExtract: false });
        const outcome = rr.result && rr.result.outcome;
        // executed AND live (dry_run=0) means the queued row is now closed.
        if (outcome === 'executed' && rr.dry_run === false) executed++;
        else stillQueued++;
        details.push({
          id: row.id, case_number: row.case_number, case_id: r.case_id,
          action: 'reran', outcome: outcome || null, dry_run: rr.dry_run,
          new_court_ai_log_id: rr.new_court_ai_log_id || null,
        });
      } catch (e) {
        errors++;
        details.push({ id: row.id, case_number: row.case_number, action: 'rerun_error', error: e.message });
      }
    }

    console.log(
      `[COURT_REVIEW_RETRY] live=${live} dry_run=${dry_run} scanned=${rows.length} ` +
      `resolved=${resolved} executed=${executed} still_queued=${stillQueued} ` +
      `still_missing=${stillMissing} errors=${errors}`
    );

    return {
      success: true,
      output: {
        live, plan_only: !!dry_run,
        scanned: rows.length, resolved, executed,
        still_queued: stillQueued, still_missing: stillMissing, errors,
        details,
      },
    };
  },

};

// ─────────────────────────────────────────────────────────────
// METADATA REGISTRY — Slice: form-driven param editor
//
// Each function in `internalFunctions` may carry a `__meta` block describing
// its param shape. Surfaced to the UI via GET /workflows/functions so the
// workflow + sequence editors can render real form fields instead of a raw
// JSON textarea. Save-time validation in routes/workflows.js drives off
// these blocks too.
//
// Schema fields:
//   category            string   — grouping label (control / timing / ...)
//   description         string   — one-line summary shown above the form
//   workflowOnly        boolean  — advisory; matches SEQUENCE_EXCLUDED in routes
//   controlFlow         boolean  — advisory; matches isControlStep in engine
//   params              array of param specs (see below)
//   exclusiveOneOf      array of [name,...] groups — exactly one must be set
//   requiredWith        array of [name,...] groups — at least one must be set
//   example             object   — copy/paste starting payload
//
// Param spec fields:
//   name                string   — params[name] in the runtime call
//   type                string   — see TYPE_VALIDATORS below
//   required            boolean  — save-time required check
//   placeholderAllowed  boolean  — strings containing {{var}} skip type checks
//   widget              string   — UI rendering hint ('phone_line','email_from')
//   multiline           boolean  — UI hint: render as textarea, not <input>
//   description         string   — helper text below the field
//   example             any      — example value
//   default             any      — runtime default; informs UI placeholder
//   enum                array    — for type:'enum'
//   min, max            number   — bounds for type:'number'/'integer'
// ─────────────────────────────────────────────────────────────

// --- CONTROL FLOW ---

internalFunctions.set_next.__meta = {
  category: 'control',
  workflowOnly: true,
  controlFlow: true,
  description: 'Jump to a specific step number, or terminate with cancel/fail.',
  params: [
    { name: 'value', type: 'string', required: true, placeholderAllowed: true,
      description: 'Step number, "cancel", "fail", or null/empty to end normally.',
      example: 5 },
  ],
  example: { value: 5 }
};

internalFunctions.evaluate_condition.__meta = {
  category: 'control',
  workflowOnly: true,
  controlFlow: true,
  description: 'Branch to a different step based on a variable comparison.',
  params: [
    { name: 'variable', type: 'string', required: false, placeholderAllowed: true,
      modeGroup: 'single',
      description: 'Variable name to test (single-condition mode).' },
    { name: 'operator', type: 'enum', required: false,
      modeGroup: 'single',
      enum: ['==','!=','>','<','>=','<=','contains','not_contains','is_empty','is_not_empty'],
      description: 'Comparison operator. Required if `variable` is set.' },
    { name: 'value', type: 'string', required: false, placeholderAllowed: true,
      modeGroup: 'single',
      description: 'Value to compare against. Ignored for is_empty / is_not_empty.' },
    { name: 'conditions', type: 'array', required: false,
      modeGroup: 'multi',
      description: 'Array of {variable, operator, value} for multi-condition mode.',
      example: [{ variable: 'stage', operator: '==', value: 'intake' }] },
    { name: 'match', type: 'enum', required: false, enum: ['all', 'any'], default: 'all',
      modeGroup: 'multi',
      description: 'How to combine multiple conditions.' },
    { name: 'then', type: 'integer', required: true,
      description: 'Step number to jump to when condition is true.' },
    { name: 'else', type: 'integer', required: false,
      description: 'Step to jump to when false. Omit/null = continue sequentially (and end the workflow if this is the last step — see cookbook §5.16).' },
  ],
  exclusiveOneOf: [['variable', 'conditions']],
  example: { variable: 'appt_status', operator: '==', value: 'confirmed', then: 5, else: 8 }
};

// --- VARIABLE MANIPULATION ---

internalFunctions.noop.__meta = {
  category: 'variables',
  description: 'Does nothing. Useful as a config-driven step that only sets variables via set_vars.',
  params: [],
  example: {}
};

internalFunctions.set_var.__meta = {
  category: 'variables',
  description: 'Explicitly set one variable to a value.',
  params: [
    { name: 'name', type: 'string', required: true,
      description: 'Variable name.', example: 'stage' },
    { name: 'value', type: 'string', required: false, placeholderAllowed: true,
      description: 'Value to assign.', example: 'intake' },
  ],
  example: { name: 'stage', value: 'intake' }
};

internalFunctions.format_string.__meta = {
  category: 'variables',
  workflowOnly: true,
  description: 'Build a string from a template (placeholders resolved before this runs) and store it as a variable.',
  params: [
    { name: 'template', type: 'string', required: true, placeholderAllowed: true,
      multiline: true,
      description: 'Template string. {{placeholders}} are resolved by the engine before this runs.',
      example: 'Hello {{firstName}} {{lastName}}' },
    { name: 'output_var', type: 'string', required: true,
      description: 'Variable name to store the result in.', example: 'fullName' },
  ],
  example: { template: 'Hello {{firstName}}', output_var: 'greeting' }
};

// --- TIMING ---

internalFunctions.schedule_resume.__meta = {
  category: 'timing',
  workflowOnly: true,
  controlFlow: true,
  description: 'Pause execution and resume at a future point in time.',
  params: [
    { name: 'resumeAt', type: 'iso_datetime', required: true, placeholderAllowed: true,
      nullishSkipsBlock: true,
      description: 'ISO datetime, duration string ("2h"), milliseconds-from-now, or null (skip-block path — jumps to skipToStep).',
      example: '{{resume_24h}}' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step number to resume at.', example: 4 },
    { name: 'skipToStep', type: 'integer', required: false,
      description: 'Step to jump to when resumeAt is null/empty. Defaults to nextStep.',
      example: 6 },
    { name: 'randomizeMinutes', type: 'integer', required: false, min: 0, max: 1440,
      description: '±N minute jitter applied to resume time. Max 1440 (24h).',
      example: 15 },
  ],
  example: { resumeAt: '2h', nextStep: 4 }
};

internalFunctions.wait_for.__meta = {
  category: 'timing',
  workflowOnly: true,
  description: 'Pause for a duration OR until a specific time, then continue.',
  params: [
    { name: 'duration', type: 'duration', required: false, placeholderAllowed: true,
      modeGroup: 'relative',
      description: 'Relative wait — "30s", "5m", "2h", "1d", or millisecond number.',
      example: '2h' },
    { name: 'at', type: 'iso_datetime', required: false, placeholderAllowed: true,
      nullishSkipsBlock: true, modeGroup: 'absolute',
      description: 'Absolute datetime; naive forms use FIRM_TZ. Explicit null/empty triggers skip-block path (jump to skipToStep).',
      example: '2026-05-01T14:30:00' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step to resume at.', example: 5 },
    { name: 'skipToStep', type: 'integer', required: false,
      description: 'Step to jump to when `at` resolves to null. Defaults to nextStep.',
      example: 7 },
    { name: 'randomizeMinutes', type: 'integer', required: false, min: 0, max: 1440,
      description: '±N minute jitter. Max 1440 (24h).', example: 10 },
  ],
  exclusiveOneOf: [['duration', 'at']],
  example: { duration: '2h', nextStep: 5 }
};

internalFunctions.wait_until_time.__meta = {
  category: 'timing',
  workflowOnly: true,
  description: 'Resume at the next occurrence of a specific time of day.',
  params: [
    { name: 'time', type: 'string', required: true,
      description: '"HH:MM" 24h format.', example: '09:00' },
    { name: 'timezone', type: 'string', required: false,
      description: 'IANA timezone. Defaults to FIRM_TIMEZONE (America/Detroit).',
      example: 'America/Detroit' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step to resume at.', example: 6 },
  ],
  example: { time: '09:00', timezone: 'America/Detroit', nextStep: 6 }
};

// --- COMMUNICATION ---

internalFunctions.send_sms.__meta = {
  category: 'communication',
  description: 'Send an SMS from an internal phone line.',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'phone_line',
      description: '10-digit number matching phone_lines.phone_number.',
      example: '2485559999' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient number (any common format).',
      example: '{{contactPhone}}' },
    { name: 'message', type: 'string', required: true, placeholderAllowed: true,
      multiline: true,
      description: 'Message body. {{variables}} resolved before send.',
      example: 'Hi {{firstName}}, your appointment is confirmed.' },
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', message: 'Hi {{firstName}}!' }
};

internalFunctions.send_email.__meta = {
  category: 'communication',
  description: 'Send an email via the configured provider (smtp or pabbly).',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'email_from',
      description: 'Must match a row in email_credentials.',
      example: 'info@4lsg.com' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient address.',
      example: '{{contactEmail}}' },
    { name: 'subject', type: 'string', required: true, placeholderAllowed: true },
    { name: 'text', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Plain text body. Provide at least one of text or html.' },
    { name: 'html', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'HTML body. Provide at least one of text or html.' },
    { name: 'attachment_urls', type: 'array', required: false,
      description:
        'Optional. JSON array of attachments. Two shapes accepted:\n' +
        '  ["https://.../file.pdf"]                                  — URL strings, name auto-derived\n' +
        '  [{"url":"https://...","name":"Fee Agreement.pdf"}]        — explicit display name\n' +
        'Placeholders work inside URL strings (e.g. {{contacts.contact_doc_url}}).\n' +
        'Files are fetched at send time — they must be publicly reachable.' },
  ],
  requiredWith: [['text', 'html']],
  example: { from: 'info@4lsg.com', to: '{{contactEmail}}', subject: 'Confirmed', text: 'Hi!' }
};

internalFunctions.send_mms.__meta = {
  category: 'communication',
  description: 'Send an MMS from an mms_capable phone line. URL-attachment only. Spec-supported types: images (JPEG/PNG/GIF/BMP/TIFF) and standard audio/video. PDFs work in practice but are best-effort (not in RC\'s published spec).',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'phone_line_mms',
      description:
        'Must be an active phone line with mms_capable=1 in phone_lines. ' +
        'Today that means RingCentral lines; Quo/OpenPhone lines won\'t appear ' +
        'in the dropdown and will fail at runtime if entered manually.' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient phone (any common format).' },
    { name: 'text', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Optional message body (≤1000 chars per RingCentral limits).' },
    { name: 'attachment_url', type: 'string', required: true, placeholderAllowed: true,
      description:
        'Publicly fetchable URL. RingCentral fetches the file at send time and caps it at 1.5MB. ' +
        'Spec-supported per RingCentral: images (JPEG, PNG, GIF, BMP, TIFF) and standard audio/video. ' +
        'PDFs are not on the published list but work in practice for this account — best-effort, ' +
        'no contractual guarantee. For guaranteed document delivery, prefer send_email.' },
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', text: 'See attached', attachment_url: 'https://storage.googleapis.com/uploads.4lsg.com/screenshot.png' }
};

// --- TASKS ---

internalFunctions.create_task.__meta = {
  category: 'tasks',
  description: 'Create a task (via taskService: assignment notification + due reminder + log). The link is OPTIONAL — tasks can be standalone.',
  params: [
    { name: 'title', type: 'string', required: true, placeholderAllowed: true,
      example: 'Follow up call' },
    { name: 'description', type: 'string', required: false, placeholderAllowed: true,
      multiline: true },
    { name: 'assigned_to', type: 'integer', required: true,
      description: 'User ID to assign to.', example: 22 },
    { name: 'assigned_by', type: 'integer', required: false,
      description: 'User ID who created it. Default: self-assign to assigned_to. Pass 0 for the automations user.' },
    { name: 'due_date', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'ISO date or datetime.' },
    { name: 'start_date', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'ISO date or datetime.' },
    { name: 'notify', type: 'boolean', required: false, default: false,
      description: 'Notify the assigner when the task is completed.' },
    { name: 'contact_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Optional: link the task to a contact.', example: '{{contactId}}' },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','event'],
      description: 'Optional link type; omit for a standalone task.' },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'ID for the link. Defaults to contact_id when set.' },
  ],
  example: { title: 'Follow up call', assigned_to: 22, due_date: '{{followUpDate}}' }
};

internalFunctions.run_task_digest.__meta = {
  category: 'tasks',
  description: 'Send the daily task digest on demand.',
  params: [
    { name: 'user', type: 'string', required: false, placeholderAllowed: true,
      description: 'User ID to target (omit for all users with task_remind_freq).' },
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Skip Shabbos/Yom Tov gate and ignore task_remind_freq day filter.' },
  ],
  example: {}
};

internalFunctions.run_event_digest.__meta = {
  category: 'events',
  description: 'Send the upcoming-events digest on demand (default window: tomorrow through the next workday).',
  params: [
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Skip the Shabbos/Yom Tov send-gate.' },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true,
      description: 'Window start (YYYY-MM-DD). Overrides the default (tomorrow); used verbatim with "to".' },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true,
      description: 'Window end (YYYY-MM-DD). Overrides the default (next workday); used verbatim with "from".' },
  ],
  example: {}
};

internalFunctions.run_error_sweep.__meta = {
  category: 'system',
  description: 'Scan automation failure tables and email a grouped alert digest.',
  params: [
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'Scan and build the digest without sending, writing, or advancing watermarks.' },
  ],
  example: {}
};

internalFunctions.court_review_retry.__meta = {
  category: 'system',
  description: 'Re-run court review-queue rows (case_not_found) whose docket now resolves. No AI call; honors court_ingest_live.',
  params: [
    { name: 'limit', type: 'number', required: false, default: 100,
      description: 'Max open case_not_found rows to scan per run (capped at 500).' },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'Plan only — scan + resolve but do not execute. Distinct from court_ingest_live.' },
  ],
  example: {}
};

// --- CONTACTS ---

internalFunctions.lookup_contact.__meta = {
  category: 'contacts',
  description: 'Fetch a contact row and return it as output. Use set_vars to map fields into variables.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
  ],
  example: { contact_id: '{{contactId}}' }
};

internalFunctions.find_contact.__meta = {
  category: 'contacts',
  description: 'Find contacts by phone and/or email value. Returns ALL matches; caller decides on ambiguity.',
  params: [
    { name: 'phone', type: 'string', required: false, placeholderAllowed: true,
      description: 'Phone value (any format). Normalized to 10 digits before search.',
      example: '{{trigger.from_phone}}' },
    { name: 'email', type: 'string', required: false, placeholderAllowed: true,
      description: 'Email value (any case/spacing). Trimmed + lowercased before search.',
      example: '{{trigger.from_email}}' },
    { name: 'include_ended', type: 'boolean', required: false, default: true,
      description: 'Include ended child-table rows (orphan-log auto-re-adopt). Default true.' },
    { name: 'include_legacy_secondary', type: 'boolean', required: false, default: true,
      description: 'Also check contact_phone2 / contact_email2. Default true.' },
  ],
  requiredWith: [['phone', 'email']],
  example: { phone: '{{trigger.from_phone}}' }
};

internalFunctions.update_contact.__meta = {
  category: 'contacts',
  description: 'Update one or more fields on a contact row. Whitelisted columns only.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Allowed: contact_type, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone, contact_email, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_ssn, contact_tags, contact_notes, contact_clio_id, contact_phone2, contact_email2.',
      example: { contact_tags: 'intake-complete', contact_type: 'Client' } },
  ],
  example: { contact_id: '{{contactId}}', fields: { contact_type: 'Client' } }
};

// --- APPOINTMENTS ---

internalFunctions.create_appointment.__meta = {
  category: 'appointments',
  description: 'Create a new appointment with full side-effects (log, 341 update, sequence cancel, GCal, reminder workflow). Delegates to apptService.createAppt.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{primary_contact_id}}' },
    { name: 'case_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Optional but usually provided.', example: '{{link_id}}' },
    { name: 'appt_date', type: 'iso_datetime', required: true, placeholderAllowed: true,
      description: 'Datetime in firm local time.',
      example: '{{new_control_datetime}}' },
    { name: 'appt_type', type: 'string', required: true,
      description: 'e.g. "341 Meeting", "Strategy Session".',
      example: '341 Meeting' },
    { name: 'appt_length', type: 'integer', required: true,
      description: 'Length in minutes.', example: 15 },
    { name: 'appt_platform', type: 'enum', required: true,
      enum: ['Telephone', 'Zoom', 'In-person'] },
    { name: 'appt_with', type: 'integer', required: false, default: 1,
      description: 'User ID. Defaults to 1.' },
    { name: 'note', type: 'string', required: false, multiline: true },
    { name: 'confirm_sms', type: 'boolean', required: false, default: false },
    { name: 'confirm_email', type: 'boolean', required: false, default: false },
    { name: 'confirm_message', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Required if confirm_sms or confirm_email is true.' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      description: 'User ID for log entry. Defaults to 0 (system).' },
    { name: 'source', type: 'enum', required: false, default: 'internal',
      enum: ['client', 'staff', 'court', 'internal', 'system'],
      description: 'Origin of the action. Persisted to the appt log (log_extra.source) for audit. Only "client" triggers the office staff SMS alert (office_alerts_to) — set it when a workflow books on a client\'s behalf. Use "system" for unattended automation. Defaults to "internal".' },
  ],
  example: { contact_id: '{{primary_contact_id}}', case_id: '{{link_id}}',
             appt_date: '{{new_control_datetime}}', appt_type: '341 Meeting',
             appt_length: 15, appt_platform: 'Telephone' }
};

internalFunctions.lookup_appointment.__meta = {
  category: 'appointments',
  description: 'Fetch an appointment row and return it as output.',
  params: [
    { name: 'appointment_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{apptId}}' },
  ],
  example: { appointment_id: '{{apptId}}' }
};

internalFunctions.update_appointment.__meta = {
  category: 'appointments',
  description: 'Update one or more fields on an appointment row. Whitelisted columns only.',
  params: [
    { name: 'appointment_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{apptId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Allowed: appt_client_id, appt_case_id, appt_type, appt_length, appt_form, appt_status, appt_date, appt_gcal, appt_ref_id, appt_note, appt_platform, appt_with.',
      example: { appt_note: 'Client confirmed via phone' } },
  ],
  example: { appointment_id: '{{apptId}}', fields: { appt_status: 'Confirmed' } }
};

internalFunctions.get_appointments.__meta = {
  category: 'appointments',
  description: 'Query the appts table with optional filters and return results in a format suitable for email, SMS, or variable storage.',
  params: [
    { name: 'status', type: 'string', required: false,
      description: 'appt_status filter, e.g. "Scheduled", "No Show". Omit for all.' },
    { name: 'date', type: 'string', required: false, placeholderAllowed: true,
      description: '"today", "tomorrow", or ISO date "YYYY-MM-DD".' },
    { name: 'from', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'Lower bound on appt_date.' },
    { name: 'to', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'Upper bound on appt_date.' },
    { name: 'contact_id', type: 'string', required: false, placeholderAllowed: true },
    { name: 'case_id', type: 'string', required: false, placeholderAllowed: true },
    { name: 'appt_type', type: 'string', required: false },
    { name: 'limit', type: 'integer', required: false, default: 200, min: 1, max: 1000 },
    { name: 'format', type: 'enum', required: false,
      enum: ['raw', 'html_rows', 'count'], default: 'raw' },
    { name: 'output_var', type: 'string', required: false },
    { name: 'count_var', type: 'string', required: false },
    { name: 'date_var', type: 'string', required: false,
      description: 'Variable name to store formatted date string ("Wednesday, March 18, 2026").' },
    { name: 'base_url', type: 'string', required: false,
      description: 'Base URL for links in html_rows output.' },
  ],
  example: { status: 'Scheduled', date: 'today', format: 'html_rows', output_var: 'apptRows' }
};

// --- GOOGLE CALENDAR ---

internalFunctions.gcal_create_event.__meta = {
  category: 'calendar',
  description: 'Create a Google Calendar event via the bound oauth2 connection. Returns the created event (capture this.output.id into appts.appt_gcal).',
  params: [
    { name: 'summary', type: 'string', required: false, placeholderAllowed: true,
      description: 'Event title.' },
    { name: 'start', type: 'string', required: true, placeholderAllowed: true,
      description: 'ISO datetime (firm-local if naive) or "YYYY-MM-DD" for all-day.' },
    { name: 'end', type: 'string', required: true, placeholderAllowed: true,
      description: 'ISO datetime or "YYYY-MM-DD".' },
    { name: 'description', type: 'string', required: false, placeholderAllowed: true, multiline: true },
    { name: 'location', type: 'string', required: false, placeholderAllowed: true },
    { name: 'attendees', type: 'array', required: false,
      description: 'Array of email strings or {email,...} objects.' },
    { name: 'send_updates', type: 'enum', required: false,
      enum: ['all', 'externalOnly', 'none'], default: 'none',
      description: 'Whether Google emails attendees about the new event.' },
    { name: 'credential_id', type: 'integer', required: false,
      description: 'Override the bound credential (app_settings gcal_credential_id).' },
    { name: 'calendar_id', type: 'string', required: false,
      description: 'Override the bound calendar (app_settings gcal_calendar_id, default "primary").' },
  ],
  example: { summary: '341 Meeting — {{contact_name}}', start: '{{appt_date}}', end: '{{appt_end}}' }
};

internalFunctions.gcal_get_event.__meta = {
  category: 'calendar',
  description: 'Fetch a single Google Calendar event by ID.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'Calendar event ID (appts.appt_gcal).' },
    { name: 'credential_id', type: 'integer', required: false },
    { name: 'calendar_id', type: 'string', required: false },
  ],
  example: { event_id: '{{gcal_event_id}}' }
};

internalFunctions.gcal_update_event.__meta = {
  category: 'calendar',
  description: 'Partial-update (PATCH) a Google Calendar event. Only supplied fields change.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'Calendar event ID.' },
    { name: 'summary', type: 'string', required: false, placeholderAllowed: true },
    { name: 'start', type: 'string', required: false, placeholderAllowed: true,
      description: 'ISO datetime or "YYYY-MM-DD".' },
    { name: 'end', type: 'string', required: false, placeholderAllowed: true,
      description: 'ISO datetime or "YYYY-MM-DD".' },
    { name: 'description', type: 'string', required: false, placeholderAllowed: true, multiline: true },
    { name: 'location', type: 'string', required: false, placeholderAllowed: true },
    { name: 'attendees', type: 'array', required: false },
    { name: 'send_updates', type: 'enum', required: false,
      enum: ['all', 'externalOnly', 'none'] },
    { name: 'credential_id', type: 'integer', required: false },
    { name: 'calendar_id', type: 'string', required: false },
  ],
  requiredWith: [['summary', 'start', 'end', 'description', 'location', 'attendees']],
  example: { event_id: '{{gcal_event_id}}', start: '{{new_date}}', end: '{{new_end}}' }
};

internalFunctions.gcal_delete_event.__meta = {
  category: 'calendar',
  description: 'Delete a Google Calendar event by ID.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'Calendar event ID.' },
    { name: 'send_updates', type: 'enum', required: false,
      enum: ['all', 'externalOnly', 'none'] },
    { name: 'credential_id', type: 'integer', required: false },
    { name: 'calendar_id', type: 'string', required: false },
  ],
  example: { event_id: '{{gcal_event_id}}' }
};

// --- DROPBOX ---

internalFunctions.dropbox_create_folder.__meta = {
  category: 'dropbox',
  description: 'Create a Dropbox folder (idempotent), optionally subfolders and a public shared link. Capture this.output.shared_link into cases.case_dropbox. Leading spaces in path segments are significant (firm sort convention) and preserved.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full folder path. Leading/embedded spaces preserved.',
      example: '/  Law Office/   Cases/  Potential Cases/  Potential - Bankruptcy/ {{contact_name}} - {{caseId}}' },
    { name: 'subfolders', type: 'array', required: false,
      description: 'Subfolder names to create under path (nested "a/b" allowed).' },
    { name: 'share_link', type: 'boolean', required: false, default: false,
      description: 'Create/reuse a public shared link for the folder.' },
    { name: 'credential_id', type: 'integer', required: false,
      description: 'Override the bound credential (app_settings dropbox_credential_id, default 8).' },
  ],
  example: { path: '/ {{contact_name}} - {{caseId}}', subfolders: ['Client Uploads'], share_link: true }
};

internalFunctions.dropbox_get_shared_link.__meta = {
  category: 'dropbox',
  description: 'Get (or create) a public Dropbox shared link for a path. Output: { shared_link }.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  example: { path: '{{folder_path}}' }
};

internalFunctions.dropbox_list_folder.__meta = {
  category: 'dropbox',
  description: 'List a Dropbox folder by path or by the case shared link (cases.case_dropbox). Output: { entries, count, truncated } — branch on this.output.count for "did the client upload anything" checks.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder path ("/" lists root).' },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link (survives staff moves/renames).' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the shared-link folder, e.g. "Client Uploads".' },
    { name: 'recursive', type: 'boolean', required: false, default: false },
    { name: 'max_entries', type: 'integer', required: false, default: 2000, min: 1 },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { shared_link: '{{case_dropbox}}', subfolder: 'Client Uploads' }
};

internalFunctions.dropbox_move.__meta = {
  category: 'dropbox',
  description: 'Move a Dropbox file/folder. Source by from_path or from_shared_link (case-folder handle). to_path is the full destination path; spaces preserved.',
  params: [
    { name: 'from_path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'from_shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link (cases.case_dropbox).' },
    { name: 'to_path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full destination path. Leading spaces preserved.' },
    { name: 'autorename', type: 'boolean', required: false, default: false },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['from_path', 'from_shared_link']],
  example: { from_shared_link: '{{case_dropbox}}', to_path: '/  Law Office/   Cases/ Active/ {{contact_name}} - {{caseId}}' }
};

internalFunctions.dropbox_rename.__meta = {
  category: 'dropbox',
  description: 'Rename a Dropbox file/folder in place (same parent). new_name may carry leading spaces (preserved); "/" not allowed.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true },
    { name: 'new_name', type: 'string', required: true, placeholderAllowed: true,
      description: 'New name only (no "/"). Leading spaces preserved.' },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { shared_link: '{{case_dropbox}}', new_name: ' {{contact_name}} - {{case_number}}' }
};

internalFunctions.dropbox_delete.__meta = {
  category: 'dropbox',
  description: 'Delete a Dropbox file/folder by path or shared link. Refuses root.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { path: '{{file_path}}' }
};

internalFunctions.dropbox_save_url.__meta = {
  category: 'dropbox',
  description: 'Pull a file from a URL into Dropbox (transfer runs on Dropbox\'s side — no bytes through Cloud Run). Destination: full path (incl. filename) OR shared_link + filename (+ subfolder). Waits ~25s by default; output.status is "complete" or "in_progress" (with async_job_id).',
  params: [
    { name: 'url', type: 'string', required: true, placeholderAllowed: true,
      description: 'Source URL to pull from.' },
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Full destination path including filename.' },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link; requires filename.' },
    { name: 'filename', type: 'string', required: false, placeholderAllowed: true,
      description: 'Destination filename (with shared_link). Leading spaces preserved.' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the shared-link folder, e.g. "Client Uploads".' },
    { name: 'wait', type: 'boolean', required: false, default: true,
      description: 'Poll until complete (~25s) before returning.' },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { url: '{{attachment_url}}', shared_link: '{{case_dropbox}}', subfolder: 'Client Uploads', filename: ' {{contact_name}} - statement.pdf' }
};

internalFunctions.dropbox_ensure_case_folder.__meta = {
  category: 'dropbox',
  description: 'Ensure a case has a Dropbox folder + shared link saved in cases.case_dropbox. Stage-aware: docket number present → Active-tree convention + staff subfolders; otherwise Potential-tree (+ Client Uploads). Idempotent — returns the existing link if already set. Templates from app_settings dropbox_case_folder_templates.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case to ensure a folder for.' },
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Create even if case_dropbox is already set (overwrites the saved link).' },
  ],
  example: { case_id: '{{cases.case_id}}' }
};

// --- EVENTS ---

internalFunctions.create_event.__meta = {
  category: 'events',
  description: 'Create a first-class dated obligation (hearing, deadline, milestone) with log + GCal create + optional reminder task. Delegates to eventService.createEvent.',
  params: [
    { name: 'event_title', type: 'string', required: true, placeholderAllowed: true,
      example: 'Confirmation Hearing – {{case_number}}' },
    { name: 'event_date', type: 'string', required: true, placeholderAllowed: true,
      description: 'Obligation date "YYYY-MM-DD" (firm-local).', example: '{{hearing_date}}' },
    { name: 'event_type', type: 'string', required: false,
      description: 'Opaque category, e.g. "Confirmation Hearing", "Docs Deadline".' },
    { name: 'event_link_type', type: 'enum', required: false,
      enum: ['case', 'contact', 'case_number'],
      description: 'Omit for an internal/unlinked event. "case_number" links by docket string (e.g. when no internal case exists yet); resolution to a case is query-side and self-healing.' },
    { name: 'event_link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'case_id, contact_id, or the docket string verbatim for case_number (opaque — never shape-validated).', example: '{{caseId}}' },
    { name: 'event_time', type: 'string', required: false, placeholderAllowed: true,
      description: '"HH:MM[:SS]" firm-local. Omit/null for an all-day event.' },
    { name: 'event_all_day', type: 'boolean', required: false,
      description: 'Authoritative all-day flag. If omitted, inferred from event_time.' },
    { name: 'event_length', type: 'integer', required: false,
      description: 'Minutes; timed events only (ignored for all-day).' },
    { name: 'event_location', type: 'string', required: false, placeholderAllowed: true },
    { name: 'event_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Zoom / dial-in / docket URL.' },
    { name: 'event_note', type: 'string', required: false, multiline: true, placeholderAllowed: true },
    { name: 'event_calendar_id', type: 'string', required: false,
      description: 'Per-event calendar override. Literal "none" skips GCal entirely.' },
    { name: 'event_with', type: 'integer', required: false, placeholderAllowed: true,
      description: 'users.user (does_appts=1). Scopes which provider\'s booking availability a timed event blocks: omit/null = blocks ALL providers (firm-wide); an id = blocks only that provider; 0 = blocks NOBODY.' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      description: 'users.user for the log entry. 0/omit = automation.' },
    { name: 'reminder', type: 'object', required: false,
      description: 'Optional single reminder task: { to:<userId>, date:"YYYY-MM-DD", title? }.',
      example: { to: 3, date: '{{reminder_date}}' } },
  ],
  example: { event_type: 'Confirmation Hearing', event_link_type: 'case',
             event_link_id: '{{caseId}}', event_title: 'Confirmation Hearing – {{case_number}}',
             event_date: '{{hearing_date}}', event_time: '10:00:00' }
};

internalFunctions.update_event.__meta = {
  category: 'events',
  description: 'Update fields on an event (whitelisted columns) and/or swap its reminder task. Re-syncs the calendar event if a gcal-affecting field changed. Delegates to eventService.updateEvent.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
    { name: 'fields', type: 'object', required: false,
            description: 'Column → value pairs. Allowed: event_type, event_link_type, event_link_id, event_title, event_date, event_time, event_all_day, event_length, event_location, event_link, event_note, event_status, event_calendar_id, event_with. event_link_type accepts case, contact, or case_number (docket in event_link_id). event_with: null = blocks all providers\' availability; a does_appts user id = blocks only that provider; 0 = blocks nobody. At least one of fields or reminder is required.',
      example: { event_date: '{{new_date}}' } },
    { name: 'reminder', type: 'object', required: false,
      description: 'Omit to leave reminders alone. Object { to:<userId>, date:"YYYY-MM-DD", title? } cancels existing active reminder task(s) and spawns a new one. null cancels existing reminder task(s) and spawns none.',
      example: { to: 3, date: '{{new_reminder_date}}' } },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0 },
  ],
  example: { event_id: '{{eventId}}', fields: { event_date: '{{new_date}}' },
             reminder: { to: 3, date: '{{new_reminder_date}}' } }
};

internalFunctions.complete_event.__meta = {
  category: 'events',
  description: 'Mark an event Completed and cancel any reminder task(s). Leaves the calendar entry in place.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0 },
  ],
  example: { event_id: '{{eventId}}' }
};

internalFunctions.lookup_event.__meta = {
  category: 'events',
  description: 'Fetch an event row (with resolved link label) and return it as output.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
  ],
  example: { event_id: '{{eventId}}' }
};

internalFunctions.get_events.__meta = {
  category: 'events',
  description: 'Query the events table with optional filters and return results suitable for email, SMS, or variable storage.',
  params: [
    { name: 'link_type', type: 'enum', required: false, enum: ['case', 'contact', 'case_number'],
      description: 'case_number filters by docket string equality in link_id.' },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true },
    { name: 'status', type: 'string', required: false,
      description: 'event_status filter. Omit or "all" for all statuses. Defaults to "Scheduled".' },
    { name: 'type', type: 'string', required: false, description: 'event_type filter.' },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true,
      description: 'Lower bound on event_date (YYYY-MM-DD).' },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true,
      description: 'Upper bound on event_date (YYYY-MM-DD).' },
    { name: 'date', type: 'string', required: false, placeholderAllowed: true,
      description: '"today", "tomorrow", or "YYYY-MM-DD" for an exact day.' },
    { name: 'limit', type: 'integer', required: false, default: 200, min: 1, max: 1000 },
    { name: 'format', type: 'enum', required: false,
      enum: ['raw', 'html_rows', 'count'], default: 'raw' },
    { name: 'output_var', type: 'string', required: false },
    { name: 'count_var', type: 'string', required: false },
    { name: 'base_url', type: 'string', required: false,
      description: 'Base URL for links in html_rows output.' },
  ],
  example: { status: 'Scheduled', date: 'tomorrow', format: 'html_rows', output_var: 'eventRows' }
};

// --- GENERAL QUERY ---

internalFunctions.query_db.__meta = {
  category: 'general',
  description: 'Build and execute a safe parameterized SELECT from a JSON descriptor. Whitelisted tables only.',
  params: [
    { name: 'select', type: 'array', required: true,
      description: 'Columns. ["*"] for all from `from`. e.g. ["contacts.contact_name","appts.appt_date"].',
      example: ['contacts.contact_name', 'appts.appt_date'] },
    { name: 'from', type: 'string', required: true,
      description: 'Primary table (whitelisted).', example: 'cases' },
    { name: 'join', type: 'array', required: false,
      description: 'JOIN clauses. Each: { type, table, alias?, on:{left,right} }.' },
    { name: 'where', type: 'array', required: false,
      description: 'WHERE clauses. Each: { column, op, value? }. {{placeholders}} OK in value.' },
    { name: 'where_mode', type: 'enum', required: false,
      enum: ['and','or'], default: 'and' },
    { name: 'order_by', type: 'array', required: false,
      description: 'ORDER BY entries. Each: { column, dir: "asc"|"desc" }.' },
    { name: 'limit', type: 'integer', required: false, default: 100, min: 1, max: 1000 },
    { name: 'format', type: 'enum', required: false,
      enum: ['raw','html_rows','count','first'], default: 'raw' },
    { name: 'output_var', type: 'string', required: false },
    { name: 'count_var', type: 'string', required: false },
    { name: 'base_url', type: 'string', required: false },
    { name: 'html_columns', type: 'array', required: false,
      description: 'Per-column display config for html_rows. Each: { column, label, link_base?, link_id? }.' },
  ],
  example: { select: ['cases.case_id'], from: 'cases', limit: 10 }
};

// --- SEQUENCES ---

internalFunctions.cancel_sequences.__meta = {
  category: 'sequences',
  description: 'Cancel all active sequence enrollments of a given type for a contact.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'template_type', type: 'string', required: false,
      description: 'Sequence type, e.g. "no_show". Omit/null to cancel ALL types.',
      example: 'no_show' },
    { name: 'reason', type: 'string', required: false, default: 'internal_function',
      description: 'Logged in cancel_reason.', example: 'new_appointment_booked' },
  ],
  example: { contact_id: '{{contactId}}', template_type: 'no_show' }
};

internalFunctions.enroll_sequence.__meta = {
  category: 'sequences',
  description: 'Enroll a contact in a sequence template. By type (cascade match) or by id (direct).',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'template_type', type: 'string', required: false,
      modeGroup: 'by_type',
      description: 'Sequence type for cascade match.', example: 'no_show' },
    { name: 'appt_type', type: 'string', required: false,
      modeGroup: 'by_type',
      description: 'Cascade filter (type-mode only).' },
    { name: 'appt_with', type: 'integer', required: false,
      modeGroup: 'by_type',
      description: 'Cascade filter (type-mode only).' },
    { name: 'template_id', type: 'integer', required: false,
      modeGroup: 'by_id',
      description: 'Specific template ID for direct enrollment.', example: 42 },
    { name: 'trigger_data', type: 'object', required: false,
      description: 'Optional context passed to the sequence (appt_id, case_id, etc.).',
      example: { appt_id: '{{apptId}}' } },
  ],
  exclusiveOneOf: [['template_type', 'template_id']],
  example: { contact_id: '{{contactId}}', template_type: 'no_show' }
};

// --- LOG ---

internalFunctions.create_log.__meta = {
  category: 'log',
  description: 'Insert a log entry. Used by workflows/sequences to record events.',
  params: [
    { name: 'type', type: 'enum', required: true,
      enum: ['email','sms','call','other','form','status','note','court email','docs','appt','update','task'] },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','phone','email'],
      description:
        "For 'phone'/'email', link_id is the value itself (logService " +
        "normalizes phone to 10 digits and email to lowercased+trimmed). " +
        "Use these when the log isn't attached to a specific entity ID — " +
        "inbound comms, automation traces, pre-contact pipeline activity." },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description:
        'Entity ID for contact/case/appt/bill, OR the phone (any format, ' +
        'normalized to 10 digits) / email (lowercased+trimmed) VALUE when ' +
        'link_type is phone/email.' },
    { name: 'by', type: 'integer', required: false, default: 0,
      description: 'User ID (0 for system/automation).' },
    { name: 'data', type: 'string', required: false, multiline: true,
      description: 'log_data content. JSON string or plain text. Objects are stringified at runtime.' },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true },
    { name: 'message', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'log_message — legacy but still written.' },
    { name: 'direction', type: 'enum', required: false, enum: ['incoming', 'outgoing'] },
  ],
  example: { type: 'note', link_type: 'contact', link_id: '{{contactId}}', by: 0,
             data: 'Auto follow-up sent' }
};

internalFunctions.phone_log.__meta = {
  category: 'log',
  description:
    'Phone-event log write with forensic catch-all (phone_event_log) + Layer-2 ' +
    'suppression (phone_log_suppressions). Drop-in for create_log in the phone ' +
    'workflows. Same params + same return shape ({success, output:{log_id}}). ' +
    'Stamps extra.firmToFirm (other party is a firm number). Suppression skips ' +
    'the user-facing log only; it does not halt the workflow.',
  params: [
    { name: 'type', type: 'enum', required: true,
      enum: ['email','sms','call','other','form','status','note','court email','docs','appt','update','task'] },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','phone','email'] },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Canonical other-party phone (any format, normalized to 10 digits) when link_type=phone.' },
    { name: 'by', type: 'integer', required: false, default: 0 },
    { name: 'data', type: 'string', required: false, multiline: true },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true },
    { name: 'to', type: 'string', required: false, placeholderAllowed: true },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true },
    { name: 'message', type: 'string', required: false, placeholderAllowed: true, multiline: true },
    { name: 'direction', type: 'enum', required: false, enum: ['incoming', 'outgoing'] },
  ],
  example: { type: 'sms', link_type: 'phone', link_id: '{{their_number}}', by: 0,
             direction: 'incoming', from: '{{from}}', to: '{{to}}', message: '{{body}}' },
};

// --- CONNECTIONS / OAUTH ---

internalFunctions.refresh_expiring_oauth_credentials.__meta = {
  category: 'connections',
  description:
    'Refresh oauth2 credentials with tokens expiring soon. Refresh-token cutoff: 48h. ' +
    'Access-token cutoff: 1h (catches stale connections that webhooks haven\'t exercised). ' +
    'Skips non-connected credentials. The 2-strike alert + status flip is handled inside ' +
    'oauthService.refreshTokens — this function just iterates and reports counts.',
  params: [],
  example: {}
};

internalFunctions.rc_renew_subscriptions.__meta = {
  category: 'connections',
  description:
    'Daily idempotent renewal pass over RC webhook subscriptions tracked in ' +
    'app_settings.rc_subscriptions. Per-entry: skip if >48h to expiry, else ' +
    'PUT subscription/<id> with empty body. 404 → remove + alert IT. Other ' +
    'errors are logged and left for the next daily pass. The app_settings ' +
    'row is only rewritten if something changed. Inert until Slice 6 seeds ' +
    'app_settings.rc_subscriptions — empty/missing array short-circuits with ' +
    'skipped=true. Returns { count, results: [...] } on success.',
  params: [],
  example: {}
};

// --- DEV / TESTING ---

internalFunctions.set_test_var.__meta = {
  category: 'dev',
  description: 'Dev/testing only. Sets testKey = "hello".',
  params: [],
  example: {}
};

// ─────────────────────────────────────────────────────────────
// Validator helper — driven off the metadata above.
//
// Returns null on success or { error: '...' } on failure. Used by
// routes/workflows.js (and, in a future slice, routes/sequences.js) for
// save-time validation of internal_function step configs.
//
// Specialized parse-checks (parseUserDateTime, ms()) live in
// routes/workflows.js to avoid re-importing those modules here. This helper
// covers shape, types, enums, exclusiveOneOf, and requiredWith.
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

function _isNullishParam(v) {
  return v === undefined || v === null || v === '';
}

function _isProvided(params, name) {
  if (!(name in params)) return false;
  return !_isNullishParam(params[name]);
}

// `nullishSkipsBlock` params (wait_for.at, schedule_resume.resumeAt) treat
// explicit-null as a valid value with runtime semantics ("skip this block,
// jump to skipToStep"). For presence checks involving such params, we use
// key-presence rather than value-presence so the precompute-and-gate pattern
// (apptService.createAppt et al.) saves cleanly.
function _isPresentForGroup(params, spec, name) {
  if (spec && spec.nullishSkipsBlock) return name in params;
  return _isProvided(params, name);
}

function _validateType(spec, v) {
  switch (spec.type) {
    case 'string':
    case 'placeholder_string':
      if (typeof v !== 'string') return 'must be a string';
      return null;
    case 'number': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '') n = Number(n);
      if (typeof n !== 'number' || !Number.isFinite(n)) return 'must be a number';
      if (spec.min !== undefined && n < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `must be <= ${spec.max}`;
      return null;
    }
    case 'integer': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '') n = Number(n);
      if (typeof n !== 'number' || !Number.isInteger(n)) return 'must be an integer';
      if (spec.min !== undefined && n < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `must be <= ${spec.max}`;
      return null;
    }
    case 'boolean':
      if (typeof v !== 'boolean') return 'must be a boolean';
      return null;
    case 'enum':
      if (!Array.isArray(spec.enum) || !spec.enum.includes(v)) {
        return `must be one of: ${(spec.enum || []).join(', ')}`;
      }
      return null;
    case 'iso_datetime':
      // Shape only — specialized parsing happens in routes/workflows.js
      // (parseUserDateTime + ms() dispatch). resumeAt accepts numbers (ms).
      if (typeof v !== 'string' && typeof v !== 'number') {
        return 'must be a string or number';
      }
      return null;
    case 'duration':
      // Shape only — specialized ms() check happens in routes/workflows.js.
      if (typeof v !== 'string' && typeof v !== 'number') {
        return 'must be a duration string or number';
      }
      return null;
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v) || v === null) {
        return 'must be a JSON object';
      }
      return null;
    case 'array':
      if (!Array.isArray(v)) return 'must be a JSON array';
      return null;
    default:
      return null;
  }
}

function validateParamsAgainstMeta(meta, params) {
  if (!meta || !Array.isArray(meta.params)) return null;
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { error: 'params must be a JSON object' };
  }

  const exGroups = meta.exclusiveOneOf || [];
  const rwGroups = meta.requiredWith   || [];

  // Resolve specs by name once for the group-presence checks
  const specByName = new Map(meta.params.map(p => [p.name, p]));

  // exclusiveOneOf — exactly one must be set (key-present for nullishSkipsBlock params)
  for (const group of exGroups) {
    const present = group.filter(name => _isPresentForGroup(params, specByName.get(name), name));
    if (present.length === 0) {
      return { error: `must include exactly one of: ${group.join(', ')}` };
    }
    if (present.length > 1) {
      return { error: `must include only one of: ${group.join(', ')} (got: ${present.join(', ')})` };
    }
  }

  // requiredWith — at least one must be set
  for (const group of rwGroups) {
    const present = group.filter(name => _isPresentForGroup(params, specByName.get(name), name));
    if (present.length === 0) {
      return { error: `must include at least one of: ${group.join(', ')}` };
    }
  }

  // Per-param type and required checks
  const inAnyGroup = new Set([
    ...exGroups.flat(),
    ...rwGroups.flat(),
  ]);

  for (const spec of meta.params) {
    const provided = _isProvided(params, spec.name);
    const keyPresent = spec.name in params;

    if (spec.required && !provided && !inAnyGroup.has(spec.name)) {
      // Honor nullishSkipsBlock for required-but-can-skip params (resumeAt)
      if (spec.nullishSkipsBlock && keyPresent) {
        // present-but-null is valid for skip-block; skip type check below
        continue;
      }
      return { error: `${spec.name} is required` };
    }
    if (!provided) {
      // For nullishSkipsBlock params that are part of a group and key-present-but-null,
      // we've already counted them present in the group check. Skip type validation.
      continue;
    }

    const v = params[spec.name];

    // Placeholder bypass for string-typed fields that allow it
    if (spec.placeholderAllowed && typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
      continue;
    }

    const typeErr = _validateType(spec, v);
    if (typeErr) return { error: `${spec.name}: ${typeErr}` };
  }

  return null;
}

// Expose validator and a helper to fetch meta on the registry.
internalFunctions.__validateParamsAgainstMeta = validateParamsAgainstMeta;
internalFunctions.__getMeta = (name) => {
  const fn = internalFunctions[name];
  return fn && fn.__meta ? fn.__meta : null;
};
internalFunctions.__getAllMeta = () => {
  const out = {};
  for (const [name, fn] of Object.entries(internalFunctions)) {
    if (typeof fn === 'function' && fn.__meta) out[name] = fn.__meta;
  }
  return out;
};

// Preserved public handle for the firm-number cache reset (the cache itself
// moved to services/phoneIngestService.js with the phone_log pipeline). Any
// external caller of internalFunctions.__resetFirmNumberCache keeps working.
internalFunctions.__resetFirmNumberCache = require('../services/phoneIngestService').resetFirmNumberCache;

// --- GOOGLE CONTACTS SYNC ---

internalFunctions.gcontacts_sync_pending = async ({ limit = 1000 } = {}, db) => {
  const gcontacts = require('../services/gContactsService'); // lazy require (convention)
  const result = await gcontacts.syncPending(db, { limit });
  console.log(
    `[GCONTACTS_SYNC] pushed=${result.pushed} created=${result.created} ` +
    `updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`
  );
  return result;
};
internalFunctions.gcontacts_sync_pending.__meta = {
  category: 'connections',
  description:
    'Nightly drift sweep: pushes YisraCase contacts whose row changed since last sync ' +
    '(contact_updated > contact_google_synced_at) or were never synced, to Google Contacts. ' +
    'Names authoritative; phones/emails union-merged (no deletes); firm-internal domains skipped. ' +
    'Bounded by limit (default 1000, capped 2000). Returns { pushed, created, updated, skipped, errors }.',
  params: [
    { name: 'limit', type: 'number', required: false, default: 1000,
      description: 'Max changed contacts to push per run (capped at 2000).' },
  ],
  example: {}
};

// --- COURT ACTIVITY SUMMARY ---
//
// Coverage-review digest over court_ai_log. Queries a rolling window, renders a
// 3-section HTML email (Actioned / Needs Review / Ignored–No Action) and sends
// it via emailService. The Ignored section lists EVERY no-action subject in
// full so a human can spot a court-email type we SHOULD be actioning but aren't.
// No AI call; read-only over court_ai_log (+ a correlated email_log subject
// lookup). Driven by the "Court Activity Weekly Summary" recurring job
// (params {days:7}); also callable on demand (apiTester / scheduled-job "run
// now") with any window.

// actions_json (a JSON column) → plain English, SIMPLE. mysql2 returns JSON
// columns already parsed; the readonly HTTP API returns them parsed too. Guard
// the string case defensively.
function summarizeCourtActions(actions) {
  let arr = actions;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
  if (!Array.isArray(arr) || arr.length === 0) return '(no actions)';
  const parts = arr.map((a) => {
    const f = (a && a.fields) || {};
    switch (a && a.type) {
      case 'create_appointment':
        return 'scheduled ' + (f.appt_type || 'appointment');
      case 'create_event':
        return 'added event: ' + (f.event_type || f.event_title || 'event');
      case 'update_event':
        return 'updated event';
      case 'update_case_fields': {
        const keys = Object.keys(f).map((k) => k.replace(/^case_/, ''));
        return 'updated case (' + keys.join(', ') + ')';
      }
      default:
        return (a && a.type) ? String(a.type) : 'unknown action';
    }
  });
  return parts.join('; ');
}

// Build the 3-section coverage digest. Pure: takes the window rows (newest-first)
// + opts {days, firmTz}; returns { html, counts }. Inline styles only (email
// clients). Partitions internally so the test and the runtime call share one
// renderer.
function buildCourtSummaryHtml(rows, opts = {}) {
  const { DateTime } = require('luxon');
  const firmTz = opts.firmTz || process.env.FIRM_TIMEZONE || 'America/Detroit';
  const days   = Number(opts.days) || 7;

  const list = Array.isArray(rows) ? rows : [];
  const actioned    = list.filter((r) => r.outcome === 'executed');
  const needsReview = list.filter((r) => r.outcome === 'queued');
  const ignoredAll  = list.filter((r) => r.outcome === 'none' || r.outcome === 'error'); // newest-first across both
  const noneCount   = list.filter((r) => r.outcome === 'none').length;
  const errorCount  = list.filter((r) => r.outcome === 'error').length;

  const processed = list.length;
  const anyDry = list.some((r) => Number(r.dry_run) === 1);
  const allDry = processed > 0 && list.every((r) => Number(r.dry_run) === 1);

  const counts = {
    processed,
    actioned: actioned.length,
    queued: needsReview.length,
    ignored: noneCount,
    errors: errorCount,
    anyDry, allDry,
  };

  const end   = DateTime.now().setZone(firmTz);
  const start = end.minus({ days });
  const windowLabel = `${start.toFormat('LLL d')} – ${end.toFormat('LLL d, yyyy')}`;
  const stamp = end.toFormat('yyyy-LL-dd HH:mm ZZZZ');

  // ---- escapers / formatters ----
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDate = (d) => {
    try { return DateTime.fromJSDate(new Date(d)).setZone(firmTz).toFormat('LLL d'); }
    catch { return esc(d); }
  };
  const caseLabel = (r) => {
    const num = String(r.case_number || '').trim();
    const nm  = String(r.case_name || '').trim();
    if (num && nm) return esc(num) + ' — ' + esc(nm);
    return esc(num || nm || '—');
  };
  const trimReason = (s) => {
    s = String(s || '');
    return esc(s.length > 120 ? s.slice(0, 119) + '…' : s);
  };
  // Per-row DR tag only matters in MIXED mode; in all-dry mode the banner says it.
  const drTag = (r) => (!allDry && Number(r.dry_run) === 1)
    ? '<span style="display:inline-block;background:#fde68a;color:#92400e;font-size:11px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">DR</span>'
    : '';

  const td = (html, extra = '') =>
    `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;${extra}">${html}</td>`;
  const sectionH = (title, accent, sub) =>
    `<h3 style="font-size:15px;margin:20px 0 2px;color:#111827;border-left:4px solid ${accent};padding-left:8px;">` +
    `${title}${sub != null ? ` <span style="font-weight:400;color:#9ca3af;font-size:13px;">(${sub})</span>` : ''}</h3>`;
  const table = (headers, bodyRows, accent) => {
    if (!bodyRows.length) return '<p style="color:#9ca3af;font-size:13px;margin:4px 0 8px;">None.</p>';
    const ths = headers.map((h) =>
      `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid ${accent};font-size:11px;` +
      `letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">${h}</th>`).join('');
    return `<table cellpadding="0" cellspacing="0" border="0" width="100%" ` +
      `style="border-collapse:collapse;font-size:13px;margin:4px 0 8px;table-layout:fixed;">` +
      `<thead><tr>${ths}</tr></thead><tbody>${bodyRows.join('')}</tbody></table>`;
  };

  // ---- §A ACTIONED ----
  const rowsA = actioned.map((r) => {
    const proposed = Number(r.dry_run) === 1
      ? ' <span style="color:#92400e;font-size:12px;">(proposed)</span>' : '';
    return '<tr>' +
      td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
      td(drTag(r) + esc(r.subject || '(no subject)'), 'font-weight:600;') +
      td(caseLabel(r), 'color:#374151;') +
      td(esc(summarizeCourtActions(r.actions_json)) + proposed) +
      '</tr>';
  });
  const secA = sectionH('Actioned', '#16a34a', actioned.length) +
    table(['Date', 'Subject', 'Case', 'Actions'], rowsA, '#16a34a');

  // ---- §B NEEDS REVIEW ----
  const rowsB = needsReview.map((r) =>
    '<tr>' +
    td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
    td(drTag(r) + esc(r.subject || '(no subject)'), 'font-weight:600;') +
    td(caseLabel(r), 'color:#374151;') +
    td(trimReason(r.review_reason || '—'), 'color:#b91c1c;') +
    '</tr>');
  const secB = sectionH('Needs Review', '#dc2626', needsReview.length) +
    '<p style="font-size:12px;color:#6b7280;margin:2px 0 4px;">A human must act on these.</p>' +
    table(['Date', 'Subject', 'Case', 'Reason'], rowsB, '#dc2626');

  // ---- §C IGNORED / NO ACTION (coverage review — full subjects, no actions col) ----
  const rowsC = ignoredAll.map((r) => {
    const thought = r.outcome === 'error' ? 'extract error' : (r.classification || '(unclassified)');
    return '<tr>' +
      td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
      td(drTag(r) + esc(r.subject || '(no subject)')) +
      td(esc(thought), 'color:#6b7280;font-style:italic;width:200px;') +
      '</tr>';
  });
  const secC = sectionH('Ignored / No Action', '#9ca3af', ignoredAll.length) +
    '<p style="font-size:12px;color:#6b7280;margin:2px 0 4px;">Read every subject — catch a type we should be actioning but aren\'t.</p>' +
    table(['Date', 'Subject', 'Model thought'], rowsC, '#9ca3af');

  // ---- banner ----
  let banner = '';
  if (allDry) {
    banner = '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;' +
      'margin:12px 0;color:#92400e;font-size:14px;"><strong>DRY RUN</strong> — these are ' +
      '<strong>proposed</strong> actions; nothing was written to live records.</div>';
  } else if (anyDry) {
    banner = '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;' +
      'margin:12px 0;color:#92400e;font-size:14px;">Some rows are dry-run (proposed); see the ' +
      '<strong>DR</strong> tag per row.</div>';
  }

  const tally = `<div style="font-size:14px;margin:10px 0 6px;color:#374151;">` +
    `<strong>${processed}</strong> processed — <strong>${actioned.length}</strong> actioned, ` +
    `<strong>${needsReview.length}</strong> queued for review, <strong>${noneCount}</strong> ignored, ` +
    `<strong>${errorCount}</strong> errors</div>`;

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;' +
    'max-width:760px;margin:0 auto;padding:4px;">' +
    `<h2 style="margin:0 0 2px;font-size:20px;color:#0f172a;">Court Email Activity</h2>` +
    `<div style="font-size:14px;color:#6b7280;margin:0 0 6px;">${windowLabel}</div>` +
    banner +
    tally +
    secA +
    secB +
    secC +
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:8px;">` +
    `Generated from court_ai_log · window ${days}d · ${stamp}</p>` +
    '</div>';

  return { html, counts };
}

// Subject is NOT on court_ai_log. We hydrate it from email_log via a CORRELATED
// SUBQUERY (LIMIT 1, newest el.id), NOT a LEFT JOIN: email_log holds duplicate
// message_id rows, so a JOIN fans out / inflates the partition the first time a
// court message_id is logged twice. This mirrors EMAIL_SUBJECT_SUBQ in
// routes/courtReview.js. COLLATE coerces court_ai_log.message_id (utf8mb4_unicode_ci)
// to email_log's utf8mb4_general_ci. The NOT EXISTS clause collapses to the
// LATEST court_ai_log row per message_id (a reran/dismissed message has several;
// show only its final state).
const COURT_SUMMARY_SQL = `
  SELECT cal.id, cal.created_at, cal.message_id, cal.classification, cal.outcome,
         cal.review_reason, cal.case_number, cal.case_name, cal.dry_run, cal.actions_json,
         (SELECT el.subject FROM email_log el
            WHERE el.message_id = cal.message_id COLLATE utf8mb4_general_ci
            ORDER BY el.id DESC LIMIT 1) AS subject
    FROM court_ai_log cal
   WHERE cal.created_at >= (NOW() - INTERVAL ? DAY)
     AND NOT EXISTS (
       SELECT 1 FROM court_ai_log c2
        WHERE c2.message_id = cal.message_id AND c2.id > cal.id)
   ORDER BY cal.created_at DESC`;

internalFunctions.court_activity_summary = async (
  { days = 7, to = null, from = null, skip_if_empty = false } = {},
  db
) => {
  const { DateTime } = require('luxon'); // lazy require (file convention)
  const firmTz = process.env.FIRM_TIMEZONE || 'America/Detroit';

  // Window clamp: default 7, floor 1, cap 90.
  let win = parseInt(days, 10);
  if (!Number.isFinite(win) || win < 1) win = 7;
  if (win > 90) win = 90;

  const [rows] = await db.query(COURT_SUMMARY_SQL, [win]);

  const { html, counts } = buildCourtSummaryHtml(rows, { days: win, firmTz });
  const { processed, actioned, queued, ignored, errors } = counts;

  // skip_if_empty: a "0 processed" email is normally reassuring (confirms
  // liveness), so default false. When true and the window is empty, send nothing.
  if (skip_if_empty && processed === 0) {
    console.log(`[COURT_SUMMARY] window=${win}d processed=0 — skip_if_empty set, nothing sent`);
    return {
      success: true,
      output: { processed: 0, actioned: 0, queued: 0, ignored: 0, errors: 0, sent: false, to: null },
    };
  }

  // from: identical fallback chain to the other automation funcs (rc_renew).
  const fromAddr = from
    || (await getSetting(db, 'email_automations'))
    || process.env.AUTO_EMAIL
    || 'automations@4lsg.com';

  // to: explicit param wins (the job row controls recipients without code). Else
  // the firm review list: Stuart + Rena + IT. IT resolves via setting for parity
  // with rc_renew; Stuart/Rena have no setting keys so they are literal.
  const itAddr = (await getSetting(db, 'email_it')) || process.env.IT_EMAIL || 'it@4lsg.com';
  const toRaw = to || `stuart@4lsg.com, Rena@4lsg.com, ${itAddr}`;
  const recipients = String(toRaw).split(',').map((s) => s.trim()).filter(Boolean);

  // Subject window label — mirror the body's label (same tz + win + "now").
  const end = DateTime.now().setZone(firmTz);
  const start = end.minus({ days: win });
  const windowLabel = `${start.toFormat('LLL d')} – ${end.toFormat('LLL d, yyyy')}`;
  const subject = `Court Email Activity — ${windowLabel}`;

  // Send per-recipient (mirrors run_task_digest): one address per call, each in
  // its own try/catch so one bad address can't sink the rest. html-only is fine —
  // emailService.normalizeBodies derives the text part.
  let sentCount = 0;
  for (const addr of recipients) {
    try {
      await emailService.sendEmail(db, { from: fromAddr, to: addr, subject, html });
      sentCount++;
    } catch (e) {
      console.error(`[COURT_SUMMARY] send failed for ${addr}: ${e.message}`);
    }
  }
  const sent = sentCount > 0;

  console.log(
    `[COURT_SUMMARY] window=${win}d processed=${processed} actioned=${actioned} ` +
    `queued=${queued} ignored=${ignored} errors=${errors} sent=${sent} (${sentCount}/${recipients.length})`
  );

  return {
    success: true,
    output: { processed, actioned, queued, ignored, errors, sent, to: recipients.join(', ') },
  };
};

internalFunctions.court_activity_summary.__meta = {
  category: 'system',
  description:
    'Coverage-review digest of court_ai_log over a rolling window. Emails a 3-section ' +
    'HTML summary (Actioned / Needs Review / Ignored–No Action); the Ignored section lists ' +
    'every no-action subject in full so a human can catch a type we should be actioning but ' +
    'aren\'t. No AI call; read-only over court_ai_log. Sends per-recipient via emailService.',
  params: [
    { name: 'days', type: 'number', required: false, default: 7,
      description: 'Window size in days (created_at >= NOW() - INTERVAL N DAY). Floored at 1, capped at 90. 7 = weekly; 1 = daily.' },
    { name: 'to', type: 'string', required: false,
      description: 'Comma-separated recipient override. Default: stuart@4lsg.com, Rena@4lsg.com, <email_it>. One send per address.' },
    { name: 'from', type: 'string', required: false,
      description: 'Sender override (must exist in email_credentials). Default: setting email_automations → AUTO_EMAIL → automations@4lsg.com.' },
    { name: 'skip_if_empty', type: 'boolean', required: false, default: false,
      description: 'If true and the window has 0 rows, send nothing (returns sent:false). Default false — a "0 processed" email confirms liveness.' },
  ],
  example: { days: 7 }
};

// Test handles (filtered from the registry by the __ prefix, like __getMeta /
// __getAllMeta). scripts/courtSummaryTest.js requires these.
internalFunctions.__summarizeCourtActions = summarizeCourtActions;
internalFunctions.__buildCourtSummaryHtml = buildCourtSummaryHtml;

module.exports = internalFunctions;