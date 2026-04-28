// /lib/internal_functions.js
const ms = require('ms');
const smsService   = require('../services/smsService');
const emailService = require('../services/emailService');
const { parseUserDateTime } = require('../services/timezoneService');
// NOTE: sequenceEngine is NOT required here — circular dependency with job_executor.
// Instead, require it lazily inside cancel_sequences and enroll_sequence.

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
    const result = await smsService.sendSms(db, from, to, message);

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
   *   from     {string}  — must match a row in email_credentials
   *   to       {string}  — recipient address
   *   subject  {string}
   *   text     {string}  — plain text body
   *   html     {string}  — optional HTML body
   *
   * example config:
   *   {
   *     "function_name": "send_email",
   *     "params": {
   *       "from": "info@4lsg.com",
   *       "to": "{{contactEmail}}",
   *       "subject": "Your appointment is confirmed",
   *       "text": "Hi {{firstName}}, we look forward to seeing you on {{apptDate}}."
   *     }
   *   }
   */
  send_email: async (params, db) => {
    const { from, to, subject, text, html } = params;
    if (!from)    throw new Error('send_email requires from');
    if (!to)      throw new Error('send_email requires to');
    if (!subject) throw new Error('send_email requires subject');
    if (!text && !html) throw new Error('send_email requires at least one of: text, html');
    

    console.log(`[SEND_EMAIL] from=${from} to=${to} subject="${subject}"`);
    const result = await emailService.sendEmail(db, { from, to, subject, text, html });

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
    const {
      title,
      description = '',
      contact_id,
      assigned_to,
      assigned_by = null,
      link_type   = 'contact',
      link_id     = null,
      due_date    = null
    } = params;

    if (!title)       throw new Error('create_task requires title');
    if (!contact_id)  throw new Error('create_task requires contact_id');
    if (!assigned_to) throw new Error('create_task requires assigned_to');

    const taskFrom   = assigned_by || assigned_to;
    const taskLinkId = link_id || contact_id;

    console.log(`[CREATE_TASK] "${title}" for contact ${contact_id}, assigned to user ${assigned_to}`);

    const [result] = await db.query(
      `INSERT INTO tasks
         (task_title, task_desc, task_to, task_from, task_status, task_date,
          task_due, task_link, task_link_type, task_link_id, task_last_update)
       VALUES (?, ?, ?, ?, 'Pending', NOW(), ?, ?, ?, ?, NOW())`,
      [
        title,
        description,
        assigned_to,
        taskFrom,
        due_date || null,
        contact_id,       // task_link — legacy, TODO: REMOVE when frontend stops using it
        link_type,        // task_link_type — new
        String(taskLinkId) // task_link_id — new
      ]
    );

    return {
      success: true,
      output: { task_id: result.insertId }
    };
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
   *   appt_workflow_execution_id — managed by apptService, not general updates
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
      'appt_ref_id', 'appt_note', 'appt_platform', 'appt_with'
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
   *   (a) By template type (cascade match): pass `template_type` (and
   *       optionally `appt_type` / `appt_with` filter hints). The engine
   *       picks the most-specific active template matching type + filters.
   *
   *   (b) By template ID (direct): pass `template_id` for a specific
   *       template. Ignores cascade filters. The template must be active.
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
   *                                     (appt_id, appt_time, case_id, etc.)
   *   appt_type      {string|null}    — optional cascade filter (type-mode only)
   *   appt_with      {number|null}    — optional cascade filter (type-mode only)
   *
   * example config (by type):
   *   {
   *     "function_name": "enroll_sequence",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "template_type": "no_show",
   *       "trigger_data": { "appt_id": "{{apptId}}", "enrolled_by": "workflow" }
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
      appt_type = null,
      appt_with = null,
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
      result = await sequenceEngine.enrollContact(db, contact_id, template_type, trigger_data, { appt_type, appt_with });
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
   * params:
   *   type         {string}         — log_type enum: 'email','sms','call','other','form',
   *                                   'status','note','court email','docs','appt','update'
   *   link_type    {string|null}    — 'contact','case','appt','bill' (optional)
   *   link_id      {string|number}  — the ID for the link (optional)
   *   by           {number}         — user ID (0 for system/automation)
   *   data         {string|object}  — log_data content (JSON string or object)
   *   from         {string|null}    — log_from (optional)
   *   to           {string|null}    — log_to (optional)
   *   subject      {string|null}    — log_subject (optional)
   *   message      {string|null}    — log_message, legacy but still written (optional)
   *   direction    {string|null}    — 'incoming' or 'outgoing' (optional)
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
    const {
      type,
      link_type  = null,
      link_id    = null,
      by         = 0,
      data       = '',
      from       = null,
      to         = null,
      subject    = null,
      message    = null,
      direction  = null
    } = params;
 
    if (!type) throw new Error('create_log requires type');
 
    // Stringify data if it's an object
    const logData = typeof data === 'object' ? JSON.stringify(data) : data;
    // Use link_id as legacy log_link too
    const logLink = link_id != null ? String(link_id) : '';
 
    console.log(`[CREATE_LOG] type=${type} link=${link_type}:${link_id} by=${by}`);
 
    const [result] = await db.query(
      `INSERT INTO log
         (log_type, log_date, log_link, log_link_type, log_link_id,
          log_by, log_data, log_from, log_to, log_subject, log_message, log_direction)
       VALUES (?, CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'), ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?)`,
      [
        type,
        logLink,      // log_link — legacy, TODO: REMOVE when frontend stops using it
        link_type,    // log_link_type — new
        link_id != null ? String(link_id) : null,  // log_link_id — new
        by,
        logData,
        from,
        to,
        subject,
        message || '',
        direction
      ]
    );
 
    return {
      success: true,
      output: { log_id: result.insertId }
    };
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
    const smsSvc        = require('../services/smsService');
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
           t.task_id, t.task_status, t.task_title, t.task_due,
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

  // ─────────────────────────────────────────────────────────────
  // DEV / TESTING
  // ─────────────────────────────────────────────────────────────

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
  ],
  requiredWith: [['text', 'html']],
  example: { from: 'info@4lsg.com', to: '{{contactEmail}}', subject: 'Confirmed', text: 'Hi!' }
};

// --- TASKS ---

internalFunctions.create_task.__meta = {
  category: 'tasks',
  description: 'Insert a task row linked to a contact, case, appointment, or bill.',
  params: [
    { name: 'title', type: 'string', required: true, placeholderAllowed: true,
      example: 'Follow up call' },
    { name: 'description', type: 'string', required: false, placeholderAllowed: true,
      multiline: true },
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'FK to contacts table.',
      example: '{{contactId}}' },
    { name: 'assigned_to', type: 'integer', required: true,
      description: 'User ID to assign to.', example: 2 },
    { name: 'assigned_by', type: 'integer', required: false,
      description: 'User ID who created it. Defaults to assigned_to.' },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill'], default: 'contact' },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'ID for the link. Defaults to contact_id.' },
    { name: 'due_date', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'ISO date or datetime.' },
  ],
  example: { title: 'Follow up call', contact_id: '{{contactId}}', assigned_to: 2 }
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
      enum: ['email','sms','call','other','form','status','note','court email','docs','appt','update'] },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill'] },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true },
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

module.exports = internalFunctions;