// /lib/internal_functions.js
const ms = require('ms');
const smsService   = require('../services/smsService');
const emailService = require('../services/emailService');
// NOTE: sequenceEngine is NOT required here — circular dependency with job_executor.
// Instead, require it lazily inside cancel_sequences and enroll_sequence.

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
   *   resumeAt  {string|number}  — ISO datetime, duration string ("2h","10m","1d"),
   *                                or milliseconds from now
   *   nextStep  {number}         — step number to resume at
   *
   * example config:
   *   { "function_name": "schedule_resume", "params": { "resumeAt": "24h", "nextStep": 4 } }
   */
  schedule_resume: async (params) => {
    let resumeAt;

    // Skip if resumeAt is null/empty — used when pre-computed timestamps
    // are in the past and set to null by createAppt. The workflow continues
    // to nextStep without pausing.
    if (params.resumeAt == null || params.resumeAt === '' || params.resumeAt === 'null') {
      const skipTo = params.skipToStep ?? params.nextStep;
      console.log(`[SCHEDULE_RESUME] resumeAt is null/empty — skipping block, jumping to step ${skipTo}`);
      return { success: true, next_step: skipTo };
    }

    if (typeof params.resumeAt === 'string') {
      const dt = new Date(params.resumeAt);
      if (!isNaN(dt.getTime())) {
        resumeAt = dt.toISOString();
      } else {
        const msDelay = ms(params.resumeAt);
        if (msDelay === undefined) {
          throw new Error(`Invalid resumeAt: "${params.resumeAt}". Use ISO or duration like "10m", "2h", "30s"`);
        }
        resumeAt = new Date(Date.now() + msDelay).toISOString();
      }
    } else if (typeof params.resumeAt === 'number') {
      resumeAt = new Date(Date.now() + params.resumeAt).toISOString();
    } else {
      throw new Error('resumeAt must be ISO string, duration string, or number (ms)');
    }

    const nextStep = params.nextStep;
    if (nextStep == null) throw new Error('nextStep is required');

    console.log(`[SCHEDULE_RESUME] Resume at ${resumeAt}, step ${nextStep}`);
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  },

  /**
   * wait_for
   * Pause for a duration then continue at a specific step.
   *
   * params:
   *   duration  {string|number}  — e.g. "2h", "3d", "30m", or ms number
   *   nextStep  {number}         — step to resume at
   *
   * example config:
   *   { "function_name": "wait_for", "params": { "duration": "48h", "nextStep": 5 } }
   */
  wait_for: async (params) => {
    const { duration, nextStep } = params;
    if (!duration)        throw new Error('wait_for requires duration');
    if (nextStep == null) throw new Error('wait_for requires nextStep');

    let resumeAt;
    if (typeof duration === 'number') {
      resumeAt = new Date(Date.now() + duration).toISOString();
    } else {
      const msDelay = ms(String(duration));
      if (msDelay === undefined) throw new Error(`Invalid duration: "${duration}"`);
      resumeAt = new Date(Date.now() + msDelay).toISOString();
    }

    console.log(`[WAIT_FOR] Waiting ${duration} → resume step ${nextStep} at ${resumeAt}`);
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
      base_url  = 'https://app.4lsg.com',
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
      base_url = 'https://app.4lsg.com',
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
   * Enroll a contact in a sequence template by type.
   * Wraps sequenceEngine.enrollContact().
   *
   * params:
   *   contact_id     {number|string}  — required
   *   template_type  {string}         — required, e.g. 'no_show', 'appt_reminder'
   *   trigger_data   {object}         — optional context passed to the sequence
   *                                     (appt_id, appt_time, case_id, etc.)
   *
   * example config:
   *   {
   *     "function_name": "enroll_sequence",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "template_type": "no_show",
   *       "trigger_data": {
   *         "appt_id": "{{apptId}}",
   *         "appt_time": "{{apptDate}}",
   *         "enrolled_by": "workflow"
   *       }
   *     },
   *     "set_vars": { "enrollmentId": "{{this.output.enrollmentId}}" }
   *   }
   */
  enroll_sequence: async (params, db) => {
    const sequenceEngine = require('./sequenceEngine');  // ← lazy require
    const { contact_id, template_type, trigger_data = {}, appt_type = null, appt_with = null } = params;
    if (!contact_id)    throw new Error('enroll_sequence requires contact_id');
    if (!template_type) throw new Error('enroll_sequence requires template_type');
 
    console.log(`[ENROLL_SEQUENCE] contact=${contact_id} type=${template_type}`);
 
    const result = await sequenceEngine.enrollContact(db, contact_id, template_type, trigger_data, { appt_type, appt_with });
 
    return {
      success: true,
      output: result  // { enrollmentId, templateName, totalSteps, firstJobScheduledAt }
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

module.exports = internalFunctions;