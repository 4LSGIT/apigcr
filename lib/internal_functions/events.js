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
 * Coerce a workflow/sequence param to a boolean. Placeholder resolution turns
 * everything into strings ("{{dedupe}}" → "false"), so a bare truthiness test
 * would read the STRING "false" as true. Anything unrecognized falls back to
 * the supplied default — a typo must not silently disarm a safety guard.
 */
function _bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (v === true  || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v).trim().toLowerCase();
  if (s === 'true'  || s === 'yes') return true;
  if (s === 'false' || s === 'no')  return false;
  return dflt;
}

/**
 * create_event
 * Create an event with full side-effects (log, GCal create, optional
 * reminder task). Delegates to eventService.createEvent.
 *
 * DEDUPE DEFAULTS TRUE HERE (Slice 4 Phase B). eventService.createEvent
 * defaults it to FALSE so a human clicking "add event" twice gets two events —
 * that is their call to make. Automation gets no such benefit of the doubt:
 * every duplicate event in the Phase A audit (25 of them) arrived through THIS
 * function, from a workflow, because nothing between the court's email and the
 * INSERT ever asked "do we already have this?". Three real triggers, none of
 * them a bug in the workflow itself:
 *   - the MIEB clerk re-dockets a 341 notice minutes later with a corrected
 *     Zoom link → two valid NEFs, one obligation, wf24 fires twice;
 *   - a GAS forwardTestTrigger() replay re-POSTs old court mail with a mangled
 *     message_id (deliberately, to bypass ingest dedupe) → wf24 fires again;
 *   - two pipelines (wf24 + the court executor) both act on the SAME email.
 * On a hit the function is a no-op and returns the EXISTING event with
 * deduped:true — no INSERT, no log row, no GCal event, no reminder task.
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
 *   dedupe            {boolean?} – DEFAULT TRUE. Set false ONLY if you are
 *                                  intentionally creating a same-slot duplicate.
 *
 * output: { event_id, event, deduped }
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
      dedupe,
    } = params;

    if (!event_title) throw new Error('create_event requires event_title');
    if (!event_date)  throw new Error('create_event requires event_date');

    const dedupeOn = _bool(dedupe, true);   // automation default: ON

    console.log(`[CREATE_EVENT] "${event_title}" ${event_link_type || 'internal'}:${event_link_id || '-'} date=${event_date} dedupe=${dedupeOn}`);

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
      dedupe: dedupeOn,
    });

    if (result.deduped) {
      console.log(`[CREATE_EVENT] DEDUPED — reused existing event ${result.event_id}; nothing written`);
    }

    return {
      success: true,
      output: {
        event_id: result.event_id,
        event:    result.event,
        deduped:  !!result.deduped,
      }
    };
  };

fns.create_event.__meta = {
  category: 'events',
  description: 'Create a first-class dated obligation (hearing, deadline, milestone) with log + GCal create + optional reminder task. Deduplicates by default. Delegates to eventService.createEvent.',
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
      placeholderAllowed: true,
      description: 'users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}} — the runtime parseInt()s whatever it resolves to.' },
    { name: 'reminder', type: 'object', required: false,
      description: 'Optional single reminder task: { to:<userId>, date:"YYYY-MM-DD", title? }. A reminder whose date is already past is refused (warned + skipped) rather than created Overdue.',
      example: { to: 3, date: '{{reminder_date}}' } },
    { name: 'dedupe', type: 'boolean', required: false, default: true,
      description: 'DEFAULT TRUE. Skips the create entirely when a Scheduled event for the same case already sits in the same slot — matched by exact natural key, OR same normalized event_type at the same date+time, OR a loosely-matching title at the same date+time. Sees ACROSS pipelines (an event wf24 created as "confirmation_hearing" and one the court executor would create as "Confirmation Hearing" are the same event). On a hit NOTHING is written — no event row, no log entry, no calendar event, no reminder task — and the EXISTING event is returned in output.event with output.deduped=true. Set false ONLY if you are intentionally creating a same-slot duplicate.' },
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
 *             event_title, event_date, event_time, event_all_day,
 *             event_length, event_location, event_link, event_note,
 *             event_status, event_calendar_id, event_with (null = blocks all
 *             providers' availability; a does_appts user id = blocks only that
 *             provider; 0 = nobody).
 *             NOT allowed: event_link_type / event_link_id. An event's entity
 *             is decided at CREATION — see the "IDENTITY IS CREATION-TIME"
 *             note above UPDATE_ALLOWED in eventService. To move an event,
 *             cancel it and create it on the right entity.
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
            description: 'Column → value pairs. Allowed: event_type, type_key, event_title, event_date, event_time, event_all_day, event_length, event_location, event_link, event_note, event_status, event_resolution, event_calendar_id, event_with. event_resolution (U6a): validated against the event\'s kind and its post-update status — a Scheduled event cannot carry one; setting event_status to Completed/Canceled without one writes the default (deadline → met, else held; cancel → cancelled). NOT allowed: event_link_type / event_link_id — an event\'s entity is set at CREATION and is not updatable (a relink would invalidate the duplicate guard\'s natural key). To move an event to a different case/contact, cancel it and create it on the right entity. event_with: null = blocks all providers\' availability; a does_appts user id = blocks only that provider; 0 = blocks nobody. At least one of fields or reminder is required.',
      example: { event_date: '{{new_date}}' } },
    { name: 'reminder', type: 'object', required: false,
      description: 'Omit to leave reminders alone. Object { to:<userId>, date:"YYYY-MM-DD", title? } cancels existing active reminder task(s) and spawns a new one (a past-dated reminder is refused, not created Overdue). null cancels existing reminder task(s) and spawns none.',
      example: { to: 3, date: '{{new_reminder_date}}' } },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      placeholderAllowed: true,
      description: 'users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}}.' },
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
    const { event_id, acting_user_id = 0, resolution } = params;
    if (!event_id) throw new Error('complete_event requires event_id');

    console.log(`[COMPLETE_EVENT] id=${event_id}${resolution ? ` resolution=${resolution}` : ''}`);

    // U6a: `resolution` is optional; omitted/blank → the service writes the
    // §3.7 default (deadline → met, else held). Validated by the service
    // against the row's kind — an invalid value throws (err.status=400,
    // though only the message reaches a workflow step).
    const opts = {};
    if (resolution != null && String(resolution).trim() !== '') opts.resolution = String(resolution).trim();

    const result = await eventService.completeEvent(
      db, event_id, parseInt(acting_user_id, 10) || 0, opts
    );

    return { success: true, output: { event: result.event } };
  };

fns.complete_event.__meta = {
  category: 'events',
  description: 'Mark an event Completed and cancel any reminder task(s). Leaves the calendar entry in place. Writes event_resolution (deadline → met, else held) unless `resolution` says otherwise.',
  params: [
    { name: 'event_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{eventId}}' },
    { name: 'resolution', type: 'string', required: false, placeholderAllowed: true,
      description: "Outcome to record (v0.5 §3.7). Hearings/conferences/other: 'held'. Deadlines: 'met' | 'missed' | 'moot'. Omit for the default. Invalid for the event's kind → the step fails." },
    { name: 'acting_user_id', type: 'integer', required: false, default: 0,
      placeholderAllowed: true,
      description: 'users.user for the log entry. 0/omit = automation. Accepts a {{placeholder}}.' },
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
      base_url = require('../firmConfig').cfg('app_url') || 'https://app.4lsg.com',
      include_superseded = false,
    } = params;

    const conditions = [];
    const queryParams = [];

    // U6a — hide superseded rows that would LOOK live (a rescheduled
    // predecessor carries event_status='Rescheduled' since U6c, so the status
    // filter already hides it and this is belt-and-braces; it still catches a
    // hand-edited row whose pointer is set but whose status was left
    // 'Scheduled'. Same predicate
    // as eventService.listEvents, for the same reason: terminal superseded
    // rows (the 31 E0a Canceled tombstones) stay visible under status:'all'
    // so nothing a workflow saw yesterday disappears with the flag off.
    if (!(include_superseded === true || include_superseded === 'true' || include_superseded === 1 || include_superseded === '1')) {
      conditions.push(`NOT (events.superseded_by_event_id IS NOT NULL AND events.event_status = 'Scheduled')`);
    }

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
      description: 'event_status filter (Scheduled | Completed | Canceled | Rescheduled). Omit or "all" for all statuses. Defaults to "Scheduled". "Rescheduled" (U6c) is a tombstone — a row superseded by a successor event; it is hidden from every other status filter and only returned when asked for by name or under "all".' },
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
    { name: 'include_superseded', type: 'boolean', required: false, default: false,
      description: 'Include rows superseded by a reschedule (superseded_by_event_id set) even when they still read Scheduled. Default hides them.' },
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

/**
 * sweep_calendar_missed — nightly: past-dated Scheduled deadlines → Completed
 * with event_resolution='missed' (Unified Events U6a, v0.5 §3.7).
 *
 * House pattern of emit_stage_aged: validated params, per-run cap, wall-clock
 * bound, structured return, dry_run. Each row goes through
 * eventService.completeEvent({ resolution:'missed', source:'sweep' }) — so it
 * emits calendar.resolved with data.resolution='missed', writes a
 * 'completed' log row, and soft-deletes any reminder task. No GCal action
 * (a deadline's all-day banner is the historical record, as for any
 * completion). Idempotent by construction: a marked row leaves the
 * population.
 *
 * `since` IS REQUIRED AND HAS NO DEFAULT (Fred, v0.5 §8.2). 0 Completed
 * events exist live — staff have never marked a deadline met — so every
 * past-dated Scheduled deadline is UNKNOWN, not missed (30 rows at
 * 2026-09-01). The sweep must not rewrite that history: it only sees rows
 * dated on/after `since`, and Fred sets `since` in the scheduled job's
 * params (proposed 2026-09-01, the day the resolution writers shipped).
 *
 * "Today" is FIRM-LOCAL (luxon, FIRM_TZ), computed here and bound as a
 * parameter — NOT CURDATE(), because the pool session runs in UTC and a
 * deadline dated today is not missed until the firm's day is over. A row is
 * in the population only when event_date < today.
 *
 * params:
 *   since      {string}   REQUIRED 'YYYY-MM-DD' — floor on event_date (inclusive)
 *   max_rows   {number?}  per-run cap (default 200)
 *   dry_run    {boolean?} list would-mark rows; no writes, no emits
 *   max_runtime_ms {number?} wall-clock bound (default 20000)
 *
 * returns { scanned, marked, skipped, dry_run, since, today, wall_clock_ms,
 *           errors[], would_mark[] (dry run only) }
 */
fns.sweep_calendar_missed = async (params = {}, db) => {
  const eventService = require('../../services/eventService'); // deferred require (circular dep safety)
  const { DateTime } = require('luxon');
  const { FIRM_TZ }  = require('../../services/timezoneService');

  const since = params.since == null ? '' : String(params.since).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !DateTime.fromISO(since).isValid) {
    throw new Error("sweep_calendar_missed: `since` (YYYY-MM-DD) is required — there is no default on purpose (v0.5 §8.2)");
  }
  const maxRows      = Number(params.max_rows) > 0 ? Math.floor(Number(params.max_rows)) : 200;
  const maxRuntimeMs = Number(params.max_runtime_ms) > 0 ? Math.floor(Number(params.max_runtime_ms)) : 20 * 1000;
  const dryRun       = !!params.dry_run && params.dry_run !== 'false';
  const startedAt    = Date.now();
  const today        = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');

  const [rows] = await db.query(
    `SELECT e.event_id, DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_date,
            e.type_key, e.event_title, e.event_link_type, e.event_link_id
       FROM events e
      WHERE e.kind = 'deadline'
        AND e.event_status = 'Scheduled'
        AND e.superseded_by_event_id IS NULL
        AND e.event_date < ?
        AND e.event_date >= ?
      ORDER BY e.event_date ASC, e.event_id ASC
      LIMIT ?`,
    [today, since, maxRows]
  );

  let marked = 0, timedOut = false;
  const errors = [];
  const wouldMark = [];

  for (const r of rows) {
    if (dryRun) {
      wouldMark.push({ event_id: r.event_id, event_date: r.event_date, type_key: r.type_key,
                       link: r.event_link_type ? `${r.event_link_type}:${r.event_link_id}` : null });
      continue;
    }
    if (Date.now() - startedAt >= maxRuntimeMs) { timedOut = true; break; }
    try {
      await eventService.completeEvent(db, r.event_id, 0, { resolution: 'missed', source: 'sweep' });
      marked++;
    } catch (err) {
      errors.push({ event_id: r.event_id, error: err.message });
      console.error(`[SWEEP CALENDAR MISSED] event ${r.event_id} failed:`, err.message);
    }
  }

  const skipped = dryRun ? 0 : rows.length - marked;
  console.log(
    `[SWEEP CALENDAR MISSED] since=${since} today=${today} scanned=${rows.length} ` +
    `marked=${marked} skipped=${skipped} timed_out=${timedOut}${dryRun ? ' (dry run)' : ''}`
  );

  const output = {
    scanned: rows.length, marked, skipped, dry_run: dryRun, since, today,
    capped: rows.length >= maxRows, timed_out: timedOut,
    wall_clock_ms: Date.now() - startedAt, errors,
  };
  if (dryRun) output.would_mark = wouldMark;
  return { success: true, output };
};

fns.sweep_calendar_missed.__meta = {
  category: 'events',
  description:
    "Nightly deadline sweep (Unified Events U6a). Every kind='deadline' event still Scheduled " +
    "whose date is before firm-local today AND on/after `since` is Completed with " +
    "event_resolution='missed' through eventService.completeEvent — so each emits " +
    "calendar.resolved (resolution 'missed'), logs, and clears its reminder task. " +
    "`since` is required and has no default: older past-dated deadlines are UNKNOWN, not " +
    "missed, and stay Scheduled until a human resolves them. Idempotent; superseded rows skipped.",
  params: [
    { name: 'since', type: 'string', required: true, placeholderAllowed: true,
      description: "Floor on event_date, inclusive (YYYY-MM-DD). Set by Fred in the scheduled job's params; proposed 2026-09-01." },
    { name: 'max_rows', type: 'integer', required: false, default: 200,
      description: 'Per-run cap on rows scanned (oldest first). The remainder is picked up next run.' },
    { name: 'max_runtime_ms', type: 'integer', required: false, default: 20000,
      description: 'Wall-clock bound; stops before the next row when exceeded.' },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'List would-mark rows (up to max_rows) without writing or emitting.' },
  ],
  example: { since: '2026-09-01', dry_run: true }
};

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED EVENTS U8 — `calendar.approaching` (v0.5 §3.2, amendment A6)
//
// A6 withdrew v0.4's dedicated reminder spawner. A reminder is now two things
// that already exist: this synthetic EVENT, and a TRIGGER RULE that decides
// what the reminder DOES (a task with a dedup key, a client SMS, a staff
// email). Nothing about "a task 7 days before a deadline" is code — the 7 is a
// registry row (`calendar_item_types.approaching_offsets`), the task is a rule.
// §8.0: code owns vocabulary, data owns policy.
//
// THE OFFSETS ARE THE ON SWITCH. `approaching_offsets` ships NULL on all 34
// rows, so with nothing configured this function loads one small table, finds
// no candidate type, and returns { scanned: 0 } without reading `events` or
// `appts` at all. Turning reminders on is an act in Case Config.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON column → array (tolerates mysql2-parsed values, strings, null). */
function _offsetArray(v) {
  if (v == null || v === '') return null;
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch (_) { return null; }
  }
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Normalize a stored offsets array to distinct integers 0..365, ASCENDING.
 *
 * Ascending is a cap-ordering decision, not a storage one: within an item the
 * SMALLEST offset is the most urgent rung ("1 day out" beats "7 days out"), so
 * if `max_emits` truncates a catch-up run it truncates the least urgent end.
 * The admin write layer stores them descending for display; neither order is
 * load-bearing, which is why this re-sorts rather than trusting the column.
 *
 * Junk is DROPPED, not thrown on: this runs unattended at 2am against data a
 * human edits, and one bad element must not silently disarm the whole type's
 * reminders — or, worse, take the nightly job down. The admin layer is where a
 * bad value gets rejected with a message somebody reads.
 */
function _normalizeOffsets(raw) {
  const arr = _offsetArray(raw);
  if (!arr) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 365 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Whole days from `fromIso` to `toIso`, both 'YYYY-MM-DD'. Exact — no DST. */
function _wholeDaysBetween(fromIso, toIso) {
  const { DateTime } = require('luxon');
  const a = DateTime.fromISO(fromIso, { zone: 'utc' });
  const b = DateTime.fromISO(toIso,   { zone: 'utc' });
  return Math.round(b.diff(a, 'days').days);
}

/**
 * The `calendar.approaching` payload: the SOURCE SERVICE'S OWN envelope for
 * that row, plus the two paths this event adds.
 *
 * Reusing `_calendarEnvelope` rather than hand-rolling a payload is the whole
 * point of A5: a rule written against `data.type_key` / `data.kind` /
 * `data.state` matches identically whether the reminder is for an appt or an
 * event, and the U4 drift guard (extended in tests/unifiedEventsU8.approaching
 * .test.js) holds this shape to the field catalog automatically.
 *
 * `source` is 'system' and the actor is user 0, matching emit_stage_aged. The
 * sweep uses source:'sweep' because `calendar.resolved` has many writers and
 * needs disambiguating; `calendar.approaching` has exactly one, so `extra.via`
 * carries the provenance and `source` says the plain truth.
 *
 * The two helpers build a fresh object per call, so mutating `data` here is
 * safe — nothing else holds a reference.
 */
function _approachingEnvelope(item, offsetDays, daysUntil) {
  const apptService  = require('../../services/apptService');   // deferred (circular dep safety)
  const eventService = require('../../services/eventService');
  const opts = { source: 'system', actingUserId: 0, extra: { via: 'approaching_emitter' } };
  const env = item.source === 'appt'
    ? apptService._calendarEnvelope(item.row, opts)
    : eventService._calendarEnvelope(item.row, opts);
  env.data.offset_days = Number(offsetDays);
  env.data.days_until  = Number(daysUntil);
  return env;
}

/**
 * emit_calendar_approaching — nightly emitter for `calendar.approaching`.
 *
 * House pattern of emit_stage_aged: load a bounded population, claim
 * (item, rung, date) with INSERT IGNORE, emit only what THIS run claimed, stop
 * on a count cap or a wall-clock bound BEFORE claiming so the remainder stays
 * claimable, return structured counters.
 *
 * POPULATION — live items in [today, today + max(offsets)], firm-local:
 *   events  event_status='Scheduled' AND superseded_by_event_id IS NULL
 *   appts   appt_status='Scheduled'
 * "Today" is computed in FIRM_TZ (luxon) and bound as a parameter, NEVER
 * CURDATE() — the pool session runs in UTC, and the U6a rule applies for the
 * same reason it applied to the sweep: the firm's day, not the server's, is
 * what "3 days from now" is counted from.
 *
 * BOTH TABLES ARE QUERIED WITH THE FULL KEY SET, not split by kind. §3.3.2
 * routes a type's storage by kind (meeting → appts, else → events) at WRITE
 * time, but live data does not obey it perfectly: interim kind='meeting' 341
 * EVENT rows exist pending A3's retirement of event_type='341'. Filtering
 * appts to meeting-keys and events to the rest would make those rows silently
 * unremindable. A type that only ever lands in one table simply returns
 * nothing from the other, and both columns are indexed (idx_events_type_key,
 * idx_appts_type_key).
 *
 * `active` IS NOT FILTERED. §3.3: active gates PICKERS only — an inactive type
 * still resolves. An obligation already on the calendar is still an
 * obligation, so deactivating a type stops it being offered, not being
 * reminded about. Clear its offsets to stop the reminders.
 *
 * THE RUNG RULE — a rung fires once `today >= item_date - offset`, i.e. once
 * `days_until <= offset`. That is CATCH-UP semantics, deliberately: a job that
 * missed a night still emits the rung it slept through. Two consequences worth
 * knowing before authoring rules:
 *   - an item created INSIDE its own longest offset fires the already-passed
 *     rungs on the next run (a hearing booked 2 days out, offsets [7,1], emits
 *     offset_days 7 immediately, then 1 the night before);
 *   - a rule should filter `data.offset_days` EQUALS n, never `>=` — same
 *     advice as `data.threshold_days` on case.stage_aged.
 * Unlike stage_aged this needs no grace window: the population is FUTURE-dated
 * and bounded by max(offsets), so a backfill cannot produce more than
 * (items × offsets) emissions, and max_emits bounds that.
 *
 * Emissions are AWAITED (not fire-and-forget) so dispatch runs while the job
 * holds CPU instead of being orphaned into Cloud Run's throttled post-response
 * time. Each is its own ROOT event — the engine's per-root dispatch budget
 * applies per emission, and only max_emits bounds the run.
 *
 * params:
 *   max_emits      {number?}  per-run emission cap (default 200)
 *   max_runtime_ms {number?}  wall-clock bound (default 20000)
 *   dry_run        {boolean?} claim nothing, emit nothing; return would_emit
 *                             (ledger-aware: already-emitted rungs count as
 *                             duplicates, exactly as a real run would score
 *                             them, so a dry run on a live system does not
 *                             read as a pending stampede)
 *
 * returns { scanned, pairs_due, claimed, emitted, duplicates, skipped_capped,
 *           capped, timed_out, dry_run, today, horizon, max_offset,
 *           types_configured, wall_clock_ms, would_emit[] (dry run only) }
 */
fns.emit_calendar_approaching = async (params = {}, db) => {
  const domainEvents = require('../domainEvents');              // deferred require (circular dep safety)
  const { DateTime }  = require('luxon');
  const { FIRM_TZ }   = require('../../services/timezoneService');

  const maxEmits     = Number(params.max_emits)      > 0 ? Math.floor(Number(params.max_emits))      : 200;
  const maxRuntimeMs = Number(params.max_runtime_ms) > 0 ? Math.floor(Number(params.max_runtime_ms)) : 20 * 1000;
  const dryRun       = _bool(params.dry_run, false);
  const startedAt    = Date.now();
  const today        = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');

  // ── 1. the registry, once ────────────────────────────────────────────────
  // Its own query rather than calendarTypeService: that layer's REGISTRY_SQL
  // does not carry this column, and a nightly job wants the committed truth,
  // not a cache that may be up to 60s stale.
  const [typeRows] = await db.query(
    `SELECT type_key, approaching_offsets
       FROM calendar_item_types
      WHERE approaching_offsets IS NOT NULL`
  );
  const offsetsByKey = new Map();
  for (const r of typeRows || []) {
    const offs = _normalizeOffsets(r.approaching_offsets);
    if (offs.length) offsetsByKey.set(String(r.type_key), offs);
  }

  const base = {
    scanned: 0, pairs_due: 0, claimed: 0, emitted: 0, duplicates: 0,
    skipped_capped: 0, capped: false, timed_out: false, dry_run: dryRun,
    today, types_configured: offsetsByKey.size,
    wall_clock_ms: Date.now() - startedAt,
  };

  if (!offsetsByKey.size) {
    console.log(`[CALENDAR APPROACHING] no type carries approaching_offsets — nothing scanned`);
    return { success: true, output: { ...base, horizon: today, max_offset: null, wall_clock_ms: Date.now() - startedAt } };
  }

  const keys      = [...offsetsByKey.keys()];
  const maxOffset = Math.max(...[...offsetsByKey.values()].flat());
  const horizon   = DateTime.fromISO(today, { zone: 'utc' }).plus({ days: maxOffset }).toFormat('yyyy-MM-dd');

  // ── 2. population, one query per table ───────────────────────────────────
  // events.event_date is a DATE, so BETWEEN is both correct and sargable on
  // idx_events_date. The correlated subquery is eventService's
  // RESOLVED_CASE_SUBQUERY (module-private there); _calendarEnvelope needs
  // resolved_case_id to promote a docket-anchored row's case_id.
  const [eventRows] = await db.query(
    `SELECT e.event_id, e.event_type, e.kind, e.type_key,
            e.event_link_type, e.event_link_id,
            e.event_date, e.event_time, e.event_all_day, e.event_length,
            e.event_status, e.event_resolution, e.event_with,
            e.superseded_by_event_id,
            DATE_FORMAT(e.event_date, '%Y-%m-%d') AS item_date,
            (SELECT c.case_id FROM cases c
              WHERE e.event_link_type = 'case_number'
                AND (c.case_number = e.event_link_id OR c.case_number_full = e.event_link_id)
              LIMIT 1) AS resolved_case_id
       FROM events e
      WHERE e.event_status = 'Scheduled'
        AND e.superseded_by_event_id IS NULL
        AND e.type_key IN (?)
        AND e.event_date BETWEEN ? AND ?
      ORDER BY e.event_date ASC, e.event_id ASC`,
    [keys, today, horizon]
  );

  // appts.appt_date is a DATETIME, so DATE(appt_date) BETWEEN … would forfeit
  // KEY date (appt_date). Half-open datetime bounds are equivalent and
  // sargable. Columns are NAMED, not SELECT * — `appts` carries
  // appt_manage_token, a bearer credential for /m/<token>, and the cheapest
  // way to keep it out of an envelope is to never read it (the same reasoning
  // that made _calendarEnvelope a projection).
  const [apptRows] = await db.query(
    `SELECT a.appt_id, a.appt_client_id, a.appt_case_id,
            a.appt_link_type, a.appt_link_id,
            a.appt_type, a.type_key, a.appt_length, a.appt_date,
            a.appt_status, a.appt_with, a.rescheduled_from_appt_id,
            DATE_FORMAT(a.appt_date, '%Y-%m-%d') AS item_date
       FROM appts a
      WHERE a.appt_status = 'Scheduled'
        AND a.type_key IN (?)
        AND a.appt_date >= ? AND a.appt_date < ?
      ORDER BY a.appt_date ASC, a.appt_id ASC`,
    [keys, `${today} 00:00:00`,
     `${DateTime.fromISO(horizon, { zone: 'utc' }).plus({ days: 1 }).toFormat('yyyy-MM-dd')} 00:00:00`]
  );

  // Soonest first across both tables, so under the cap the most imminent
  // obligations win. 'appt' before 'event' on a tie is arbitrary but stable.
  const items = [
    ...(eventRows || []).map((r) => ({ source: 'event', id: Number(r.event_id), type_key: String(r.type_key),
                                       item_date: String(r.item_date), row: r })),
    ...(apptRows  || []).map((r) => ({ source: 'appt',  id: Number(r.appt_id),  type_key: String(r.type_key),
                                       item_date: String(r.item_date), row: r })),
  ].sort((a, b) =>
    (a.item_date < b.item_date ? -1 : a.item_date > b.item_date ? 1 : 0) ||
    (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
    (a.id - b.id));

  // A dry run reads the claim ledger for the same window, so its counters mean
  // the same thing a real run's do. Without this a dry run on a system that
  // has already emitted would list every past rung under `would_emit` and read
  // as a pending stampede — which is exactly when somebody runs it to check.
  const priorClaims = new Set();
  if (dryRun) {
    const [claimRows] = await db.query(
      `SELECT source, source_id, offset_days,
              DATE_FORMAT(item_date, '%Y-%m-%d') AS item_date
         FROM calendar_approaching_emitted
        WHERE item_date BETWEEN ? AND ?`,
      [today, horizon]
    );
    for (const c of claimRows || []) {
      priorClaims.add(`${c.source}\u0000${Number(c.source_id)}\u0000${Number(c.offset_days)}\u0000${c.item_date}`);
    }
  }

  // ── 3. claim, then emit ─────────────────────────────────────────────────
  let pairsDue = 0, claimed = 0, emitted = 0, duplicates = 0, skippedCapped = 0;
  let capped = false, timedOut = false, stopped = false;
  const wouldEmit = [];

  for (const item of items) {
    const offsets   = offsetsByKey.get(item.type_key) || [];
    const daysUntil = _wholeDaysBetween(today, item.item_date);

    for (const off of offsets) {
      if (daysUntil > off) continue;        // rung not reached yet
      pairsDue++;

      if (dryRun) {
        if (priorClaims.has(`${item.source}\u0000${item.id}\u0000${off}\u0000${item.item_date}`)) {
          duplicates++;                       // already emitted — a real run would skip it too
        } else {
          wouldEmit.push({
            source: item.source, source_id: item.id, type_key: item.type_key,
            item_date: item.item_date, offset_days: off, days_until: daysUntil,
          });
        }
        continue;
      }

      // Stop BEFORE claiming (emit_stage_aged's rule): an unclaimed rung is
      // still claimable on the next run, and the population is future-dated,
      // so nothing is lost by deferring it.
      if (!stopped && emitted >= maxEmits)                        { capped = true;   stopped = true; }
      if (!stopped && Date.now() - startedAt >= maxRuntimeMs)     { timedOut = true; stopped = true; }
      if (stopped) { skippedCapped++; continue; }

      // PLAIN INSERT IGNORE, never ON DUPLICATE KEY UPDATE: under mysql2's
      // CLIENT_FOUND_ROWS default an ODKU reports affectedRows=1 for a
      // no-change duplicate too, so every rung would look freshly claimed
      // forever. With INSERT IGNORE, affectedRows === 1 means exactly "this
      // row did not exist".
      const [res] = await db.query(
        `INSERT IGNORE INTO calendar_approaching_emitted
           (source, source_id, offset_days, item_date)
         VALUES (?, ?, ?, ?)`,
        [item.source, item.id, off, item.item_date]
      );
      if (res.affectedRows !== 1) { duplicates++; continue; }     // already emitted for this date
      claimed++;

      // emit() never throws; awaited so dispatch runs on-CPU (see header).
      await domainEvents.emit(db, 'calendar.approaching',
        _approachingEnvelope(item, off, daysUntil));
      emitted++;
    }
  }

  if (capped || timedOut) {
    try {
      const { alert } = require('../alerting');
      await alert(db, {
        source: 'app', kind: 'calendar_approaching_cap', severity: 'warning',
        group_key: 'calendar_approaching_cap',
        title: `emit_calendar_approaching stopped at its ${capped ? 'emission cap' : 'time bound'}`,
        message:
          `Hit ${capped ? `the per-run cap (${maxEmits} emissions)` : `the wall-clock bound (${maxRuntimeMs} ms)`}. ` +
          `${skippedCapped} reminder(s) stayed unclaimed and retry on the next run — nothing is lost, but a bound ` +
          `hit usually means offsets were just widened or a batch of items landed at once. Inspect before raising limits.`,
        context: { emitted, claimed, scanned: items.length, pairs_due: pairsDue,
                   types_configured: offsetsByKey.size, max_offset: maxOffset,
                   today, horizon, elapsed_ms: Date.now() - startedAt },
      }).catch(() => {});
    } catch (_) { /* alerting unavailable — counters still returned */ }
  }

  console.log(
    `[CALENDAR APPROACHING] today=${today} horizon=${horizon} types=${offsetsByKey.size} ` +
    `scanned=${items.length} due=${pairsDue} claimed=${claimed} emitted=${emitted} ` +
    `duplicates=${duplicates} skipped_capped=${skippedCapped} capped=${capped} timed_out=${timedOut}` +
    `${dryRun ? ' (dry run)' : ''}`
  );

  const output = {
    ...base,
    scanned: items.length, pairs_due: pairsDue, claimed, emitted, duplicates,
    skipped_capped: skippedCapped, capped, timed_out: timedOut,
    horizon, max_offset: maxOffset,
    wall_clock_ms: Date.now() - startedAt,
  };
  if (dryRun) output.would_emit = wouldEmit;
  return { success: true, output };
};

fns.emit_calendar_approaching.__meta = {
  category: 'events',
  description:
    "Nightly emitter for the calendar.approaching synthetic trigger event (Unified Events U8, " +
    "v0.5 §3.2/A6). For every live appt and event whose type carries approaching_offsets, claims " +
    "(source, source_id, offset_days, item_date) in calendar_approaching_emitted and emits " +
    "calendar.approaching once per rung whose day has arrived (days_until <= offset_days). The " +
    "reminder's OUTCOME — a task, an SMS, a staff email — is a trigger rule, not this function. " +
    "With no type configured it scans nothing. item_date is part of the claim key, so moving an " +
    "item's date re-arms every rung for the new date. Exactly-once per (item, rung, date); " +
    "'today' is firm-local, never CURDATE().",
  params: [
    { name: 'max_emits', type: 'integer', required: false, default: 200,
      description: 'Per-run emission cap. Stops before claiming, so the remainder retries on the next run; hitting it raises an alert.' },
    { name: 'max_runtime_ms', type: 'integer', required: false, default: 20000,
      description: 'Wall-clock bound; stops before the next claim when exceeded. Same retry semantics as the cap.' },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'List would_emit rungs (uncapped) without claiming or emitting. Reads the claim ledger, so rungs already emitted count as duplicates rather than appearing as pending — the counters mean the same thing they mean on a real run. The gate to run after setting offsets for the first time.' },
  ],
  example: { dry_run: true }
};

// Test seam for the U4/U8 catalog drift guard (repo `_`-prefix convention).
// Hung off the FUNCTION rather than exported on `fns`: lib/internal_functions/
// index.js turns every top-level key of this module into a callable internal
// function, so an exported helper would appear in the workflow step editor.
fns.emit_calendar_approaching._envelope   = _approachingEnvelope;
fns.emit_calendar_approaching._normalizeOffsets = _normalizeOffsets;

module.exports = fns;
