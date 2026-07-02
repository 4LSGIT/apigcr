// lib/internal_functions/events.js

const fns = {};

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

fns.create_event = async (params, db) => {
    const eventService = require('../../services/eventService');  // deferred require (circular dep safety)

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
  };

fns.create_event.__meta = {
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

fns.update_event = async (params, db) => {
    const eventService = require('../../services/eventService');
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
  };

fns.update_event.__meta = {
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

fns.complete_event = async (params, db) => {
    const eventService = require('../../services/eventService');
    const { event_id, acting_user_id = 0 } = params;
    if (!event_id) throw new Error('complete_event requires event_id');

    console.log(`[COMPLETE_EVENT] id=${event_id}`);

    const result = await eventService.completeEvent(
      db, event_id, parseInt(acting_user_id, 10) || 0
    );

    return { success: true, output: { event: result.event } };
  };

fns.complete_event.__meta = {
  category: 'events',
  description: 'Mark an event Completed and cancel any reminder task(s). Leaves the calendar entry in place.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0 },
  ],
  example: { event_id: '{{eventId}}' }
};

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

fns.lookup_event = async (params, db) => {
    const eventService = require('../../services/eventService');
    const { event_id } = params;
    if (!event_id) throw new Error('lookup_event requires event_id');

    console.log(`[LOOKUP_EVENT] id=${event_id}`);

    const event = await eventService.getEvent(db, parseInt(event_id, 10));
    if (!event) throw new Error(`Event ${event_id} not found`);

    return {
      success: true,
      output: event   // entire row + link_label available as {{this.column_name}}
    };
  };

fns.lookup_event.__meta = {
  category: 'events',
  description: 'Fetch an event row (with resolved link label) and return it as output.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
  ],
  example: { event_id: '{{eventId}}' }
};

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

fns.get_events = async (params, db) => {
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
  };

fns.get_events.__meta = {
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

fns.run_event_digest = async (params = {}, db) => {
    const eventService = require('../../services/eventService'); // deferred require (circular dep safety)
    return eventService.sendEventDigest(db, params || {});
  };

fns.run_event_digest.__meta = {
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

module.exports = fns;
