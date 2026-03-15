// /lib/internal_functions.js
const ms = require('ms');
const smsService   = require('../services/smsService');
const emailService = require('../services/emailService');

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
    const { time, timezone = 'UTC', nextStep } = params;
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
   * Insert a task row linked to a contact.
   * Returns { task_id } as output — use set_vars in step config to capture it.
   *
   * params:
   *   title        {string}         — task title
   *   description  {string}         — optional
   *   contact_id   {number|string}  — FK to contacts table
   *   assigned_to  {number}         — user ID to assign to
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
   *     "set_vars": { "newTaskId": "{{this.task_id}}" }
   *   }
   */
  create_task: async (params, db) => {
    const { title, description = '', contact_id, assigned_to, due_date = null } = params;
    if (!title)       throw new Error('create_task requires title');
    if (!contact_id)  throw new Error('create_task requires contact_id');
    if (!assigned_to) throw new Error('create_task requires assigned_to');

    console.log(`[CREATE_TASK] "${title}" for contact ${contact_id}`);

    // STANDIN — replace with your actual tasks table columns
    const [result] = await db.query(
      `INSERT INTO tasks (title, description, contact_id, assigned_to, due_date, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [title, description, contact_id, assigned_to, due_date]
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

  /**
   * update_contact
   * Update one or more fields on a contact row.
   * Returns the contact_id as output for reference.
   *
   * params:
   *   contact_id  {number|string}  — target contact
   *   fields      {object}         — key/value pairs to update
   *                                  e.g. { "status": "active", "stage": "intake" }
   *
   * example config:
   *   {
   *     "function_name": "update_contact",
   *     "params": {
   *       "contact_id": "{{contactId}}",
   *       "fields": { "status": "active", "stage": "retained" }
   *     }
   *   }
   */
  update_contact: async (params, db) => {
    const { contact_id, fields } = params;
    if (!contact_id) throw new Error('update_contact requires contact_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_contact requires a non-empty fields object');
    }

    console.log(`[UPDATE_CONTACT] id=${contact_id} fields=${JSON.stringify(fields)}`);

    // STANDIN — uncomment and adjust column names when ready:
    // const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    // const values = [...Object.values(fields), contact_id];
    // await db.query(`UPDATE contacts SET ${setClauses}, updated_at = NOW() WHERE id = ?`, values);

    return {
      success: true,
      output: { contact_id }
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
      `SELECT * FROM appointments WHERE id = ?`,
      [appointment_id]
    );

    if (!row) throw new Error(`Appointment ${appointment_id} not found`);

    return {
      success: true,
      output: row   // entire row available as {{this.column_name}}
    };
  },

  /**
   * update_appointment
   * Update one or more fields on an appointment row.
   * Returns the appointment_id as output for reference.
   *
   * params:
   *   appointment_id  {number|string}
   *   fields          {object}  — key/value pairs to update
   *
   * example config:
   *   {
   *     "function_name": "update_appointment",
   *     "params": {
   *       "appointment_id": "{{apptId}}",
   *       "fields": { "status": "confirmed" }
   *     }
   *   }
   */
  update_appointment: async (params, db) => {
    const { appointment_id, fields } = params;
    if (!appointment_id) throw new Error('update_appointment requires appointment_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_appointment requires a non-empty fields object');
    }

    console.log(`[UPDATE_APPOINTMENT] id=${appointment_id} fields=${JSON.stringify(fields)}`);

    // STANDIN — uncomment and adjust column names when ready:
    // const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    // const values = [...Object.values(fields), appointment_id];
    // await db.query(`UPDATE appointments SET ${setClauses}, updated_at = NOW() WHERE id = ?`, values);

    return {
      success: true,
      output: { appointment_id }
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