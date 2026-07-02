// lib/internal_functions/calendar.js

const fns = {};

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

fns.gcal_create_event = async (params, db) => {
    const gcal = require('../../services/gcalService');  // deferred require (convention)
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
  };

fns.gcal_create_event.__meta = {
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

fns.gcal_get_event = async (params, db) => {
    const gcal = require('../../services/gcalService');
    const { event_id, credential_id, calendar_id } = params;
    if (!event_id) throw new Error('gcal_get_event requires event_id');

    console.log(`[GCAL_GET_EVENT] ${event_id}`);
    const event = await gcal.getEvent(db, {
      eventId: event_id,
      ...(credential_id != null && { credentialId: credential_id }),
      ...(calendar_id   && { calendarId: calendar_id }),
    });

    return { success: true, output: event };
  };

fns.gcal_get_event.__meta = {
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

fns.gcal_update_event = async (params, db) => {
    const gcal = require('../../services/gcalService');
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
  };

fns.gcal_update_event.__meta = {
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

fns.gcal_delete_event = async (params, db) => {
    const gcal = require('../../services/gcalService');
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
  };

fns.gcal_delete_event.__meta = {
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

module.exports = fns;
