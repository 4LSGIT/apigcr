// lib/internal_functions/appointments.js

const { assertNoteLengths } = require('../noteLimits');

const fns = {};

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

fns.create_appointment = async (params, db) => {
    const apptService = require('../../services/apptService');  // deferred require (circular dep safety)

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
  };

fns.create_appointment.__meta = {
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
    // placeholderAllowed is REQUIRED here despite the integer type — the
    // validator's placeholder bypass runs BEFORE the type check, so the flag
    // works on any type (same reasoning as update_log.log_id). This function's
    // own JSDoc example passes "{{attorney_user_id}}", and wf7 s3 does exactly
    // that in production; omitting the flag 400'd that step at save while the
    // executor (which resolves placeholders first, then parseInt's) ran it fine.
    { name: 'appt_with', type: 'integer', required: false, default: 1,
      placeholderAllowed: true,
      description: 'User ID. Defaults to 1. Accepts a {{placeholder}}.' },
    { name: 'note', type: 'string', required: false, multiline: true },
    { name: 'confirm_sms', type: 'boolean', required: false, default: false },
    { name: 'confirm_email', type: 'boolean', required: false, default: false },
    { name: 'confirm_message', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Required if confirm_sms or confirm_email is true.' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      placeholderAllowed: true,
      description: 'User ID for log entry. Defaults to 0 (system). Accepts a {{placeholder}} — the runtime parseInt()s whatever it resolves to.' },
    { name: 'source', type: 'enum', required: false, default: 'internal',
      enum: ['client', 'staff', 'court', 'internal', 'system'],
      description: 'Origin of the action. Persisted to the appt log (log_extra.source) for audit. Only "client" triggers the office staff SMS alert (office_alerts_to) — set it when a workflow books on a client\'s behalf. Use "system" for unattended automation. Defaults to "internal".' },
  ],
  example: { contact_id: '{{primary_contact_id}}', case_id: '{{link_id}}',
             appt_date: '{{new_control_datetime}}', appt_type: '341 Meeting',
             appt_length: 15, appt_platform: 'Telephone' }
};

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

fns.lookup_appointment = async (params, db) => {
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
  };

fns.lookup_appointment.__meta = {
  category: 'appointments',
  description: 'Fetch an appointment row and return it as output.',
  params: [
    { name: 'appointment_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{apptId}}' },
  ],
  example: { appointment_id: '{{apptId}}' }
};

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

fns.update_appointment = async (params, db) => {
    const { appointment_id, fields } = params;
    if (!appointment_id) throw new Error('update_appointment requires appointment_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_appointment requires a non-empty fields object');
    }
 
    // Whitelist — only these columns may be set via this function. Mirrors
    // routes/api.appts.js PATCH; tests/apptTypeKey.patch.test.js asserts the
    // two sets are equal — change both or neither.
    const ALLOWED = new Set([
      'appt_client_id', 'appt_case_id', 'appt_type', 'appt_length',
      'appt_form', 'appt_status', 'appt_date', 'appt_gcal',
      'appt_ref_id', 'appt_note', 'appt_platform', 'appt_with',
      'appt_gcal_user', 'type_key'
    ]);
 
    const rawKeys = Object.keys(fields);
    const blocked = rawKeys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_appointment: blocked columns: ${blocked.join(', ')}`);
    }

    // Notes length — appt_note is TEXT and truncates silently under this
    // session's non-strict sql_mode. Checked here as well as in
    // routes/api.appts.js because this function writes appts DIRECTLY; there
    // is no shared service update path to hang a single check off.
    // See lib/noteLimits.js.
    assertNoteLengths(fields);

    // U2 — type_key: resolved from appt_type when only the label is patched;
    // validated against the registry when given (unknown → throws; internal
    // functions surface errors by message — workflow_execution_steps.error_message
    // — so the 400 on err.status is informational here). Same helper as the
    // PATCH route, so the two paths cannot diverge.
    const calendarTypeService = require('../../services/calendarTypeService');   // deferred require (circular dep safety)
    const resolved = await calendarTypeService.applyApptTypePatch(db, fields, {
      errorPrefix: 'update_appointment',
    });
    const keys = Object.keys(resolved);
 
    console.log(`[UPDATE_APPOINTMENT] id=${appointment_id} fields=${JSON.stringify(resolved)}`);
 
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => resolved[k]), appointment_id];
 
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
  };

fns.update_appointment.__meta = {
  category: 'appointments',
  description: 'Update one or more fields on an appointment row. Whitelisted columns only.',
  params: [
    { name: 'appointment_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{apptId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Allowed: appt_client_id, appt_case_id, appt_type, appt_length, appt_form, appt_status, appt_date, appt_gcal, appt_ref_id, appt_note, appt_platform, appt_with, appt_gcal_user, type_key. Patching appt_type alone re-resolves type_key from the registry; a given type_key must exist in calendar_item_types.',
      example: { appt_note: 'Client confirmed via phone' } },
  ],
  example: { appointment_id: '{{apptId}}', fields: { appt_status: 'Confirmed' } }
};

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

fns.get_appointments = async (params, db) => {
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
      base_url = require('../firmConfig').cfg('app_url') || 'https://app.4lsg.com',
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
  };

fns.get_appointments.__meta = {
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

// ─────────────────────────────────────────────────────────────
// cancel_case_appointments
// ─────────────────────────────────────────────────────────────

/**
 * cancel_case_appointments
 * Cancel every future Scheduled appointment on a case. Built for the
 * terminal-stage cascade (case dismissed / closed → nothing left to meet
 * about): trigger rules on case.court_processed / case.updated run it as a
 * second action after advance_stage.
 *
 * ── ALWAYS SILENT — BY CONSTRUCTION ──────────────────────────────────────
 * There are deliberately NO sms/email/confirm params. Each cancel goes
 * through apptService.cancelAppt with sms:false, email:false — the same
 * silent-cancel posture courtExecutor's revert path uses. Rationale: this
 * fires from automation on a terminal classification; a wrong auto-cancel
 * that ALSO texts the client is a client-facing incident, a silent one is
 * recoverable from the appt log. If a notified variant is ever wanted, add
 * it as a separate explicit function — do not bolt notify flags onto this
 * one.
 *
 * cancelAppt still runs its full side-effect chain per appt: status →
 * 'Canceled', appt-scoped automation cancel, contact no_show sequence
 * cancel, GCal delete, appt log row.
 *
 * "Future" = appt_date >= firm-local now (appts.appt_date is stored naive
 * firm-local — see apptService's tz contract). Override with `from` to
 * widen/narrow the window (the tLfSP42H backfill passes a past date to
 * sweep an already-elapsed stale 341).
 *
 * Per-appt errors are ISOLATED: an already-Canceled race (cancelAppt throws
 * on it) or a single bad row must not abort the sweep. Failures are
 * collected and reported in output; the function only throws on bad input.
 *
 * params:
 *   case_id        {string}  — required
 *   from           {string}  — optional 'YYYY-MM-DD[ HH:mm[:ss]]' firm-local
 *                              lower bound on appt_date. Default: now.
 *   appt_type      {string}  — optional CSV of appt_type values to limit the
 *                              sweep (e.g. '341 Meeting'). Omit = all types.
 *   note           {string}  — optional note appended to each appt + log.
 *   acting_user_id {number}  — user ID for log entries, defaults 0 (system).
 *   source         {string}  — appt log source, defaults 'system'.
 *
 * returns output:
 *   { case_id, canceled_count, failed_count,
 *     canceled: [{appt_id, appt_type, appt_date}],
 *     failed:   [{appt_id, error}] }
 *
 * example config (trigger rule action, position 1 after advance_stage):
 *   {
 *     "function_name": "cancel_case_appointments",
 *     "params_mapping": {
 *       "case_id": "case_id",
 *       "note":    "'Auto-canceled: case dismissed (court)'"
 *     }
 *   }
 */
fns.cancel_case_appointments = async (params, db) => {
  const apptService = require('../../services/apptService');   // deferred require (circular dep safety)
  const { nowLocal } = require('../../services/timezoneService');

  const {
    case_id,
    from           = '',
    appt_type      = '',
    note           = '',
    acting_user_id = 0,
    source         = 'system',
  } = params;

  if (!case_id) throw new Error('cancel_case_appointments requires case_id');

  // appts.appt_date is naive firm-local; the cutoff must be too. A blanked
  // {{placeholder}} degrades to the default (now), same convention as
  // advance_stage's guards.
  const fromLocal = String(from).trim() !== ''
    ? String(from).trim()
    : nowLocal().toFormat('yyyy-LL-dd HH:mm:ss');

  const typeFilter = String(appt_type)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  let sql = `SELECT appt_id, appt_type, appt_date
               FROM appts
              WHERE appt_case_id = ?
                AND appt_status  = 'Scheduled'
                AND appt_date   >= ?`;
  const bind = [String(case_id), fromLocal];
  if (typeFilter.length) {
    sql += ` AND appt_type IN (${typeFilter.map(() => '?').join(', ')})`;
    bind.push(...typeFilter);
  }
  sql += ` ORDER BY appt_date ASC`;

  const [rows] = await db.query(sql, bind);

  const canceled = [];
  const failed = [];
  for (const row of rows) {
    try {
      await apptService.cancelAppt(db, {
        appt_id:      row.appt_id,
        note,
        sms:          false,
        email:        false,
        cancel_gcal:  true,
        create_task:  false,
        actingUserId: parseInt(acting_user_id, 10) || 0,
        source,
      });
      canceled.push({ appt_id: row.appt_id, appt_type: row.appt_type, appt_date: row.appt_date });
    } catch (err) {
      // Already-Canceled race or per-row failure — record, keep sweeping.
      console.error(`[CANCEL_CASE_APPTS] case=${case_id} appt=${row.appt_id} failed:`, err.message);
      failed.push({ appt_id: row.appt_id, error: err.message });
    }
  }

  console.log(
    `[CANCEL_CASE_APPTS] case=${case_id} from=${fromLocal}` +
    (typeFilter.length ? ` types=${typeFilter.join('|')}` : '') +
    ` matched=${rows.length} canceled=${canceled.length} failed=${failed.length}`
  );

  return {
    success: true,
    output: {
      case_id:        String(case_id),
      canceled_count: canceled.length,
      failed_count:   failed.length,
      canceled,
      failed,
    },
  };
};

fns.cancel_case_appointments.__meta = {
  category: 'appointments',
  description: 'Cancel every future Scheduled appointment on a case (terminal-stage cascade: dismissed/closed). ALWAYS silent — no client SMS/email, by construction. Each cancel runs apptService.cancelAppt\'s full side-effect chain (automation cancel, no_show sequence cancel, GCal delete, log row). Per-appt failures are isolated and reported in output, never thrown. "Future" = appt_date >= firm-local now unless `from` overrides it.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{case_id}}' },
    { name: 'from', type: 'string', required: false, placeholderAllowed: true,
      description: 'Firm-local lower bound on appt_date, "YYYY-MM-DD[ HH:mm[:ss]]". Default: now. Pass a past date to sweep stale already-elapsed Scheduled rows (backfill use).' },
    { name: 'appt_type', type: 'string', required: false,
      description: 'CSV of appt_type values to limit the sweep, e.g. "341 Meeting". Omit for all types.' },
    { name: 'note', type: 'string', required: false, multiline: true,
      description: 'Appended to each canceled appt\'s note and log row.' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      placeholderAllowed: true,
      description: 'User ID for log entries. Defaults to 0 (system).' },
    { name: 'source', type: 'enum', required: false, default: 'system',
      enum: ['client', 'staff', 'court', 'internal', 'system'],
      description: 'Appt log source. Defaults to "system".' },
  ],
  example: { case_id: '{{case_id}}', note: 'Auto-canceled: case dismissed (court)' }
};

module.exports = fns;
