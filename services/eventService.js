// services/eventService.js
//
/**
 * Event Service
 * services/eventService.js
 *
 * All event business logic. Routes are thin wrappers that call these
 * functions. Internal functions, sequences, and workflows can also call
 * them directly.
 *
 * An "event" is a first-class dated case/contact obligation — a confirmation
 * hearing, a docs deadline, an internal milestone. It is DISTINCT from:
 *   - appts  = a meeting WITH a person (attendee, platform, attendance lifecycle)
 *   - tasks  = a single user's to-do (assignee, due date, digest)
 * An event is a fact on a timeline. It goes on Google Calendar, links to a
 * case OR a contact OR nothing (internal), and may optionally spawn ONE
 * reminder task.
 *
 * This service mirrors apptService's conventions:
 *   - Core writes happen synchronously; calendar work and reminder spawning
 *     are POST-COMMIT, NON-BLOCKING (fire-and-forget, never throw out).
 *   - GCal failures alert IT (throttled) and are swallowed — a calendar
 *     failure must never block or roll back an event write.
 *   - On a "reschedule" (date/time change) the calendar event is
 *     delete-then-recreated, matching the proven appt reschedule pattern and
 *     avoiding all-day<->timed PATCH edge cases.
 *
 * Invariants (enforced on every write):
 *   - event_all_day = 1  <=>  event_time IS NULL
 *   - event_length applies to timed events only (ignored for all-day)
 *
 * Usage:
 *   const eventService = require('../services/eventService');
 *   const { event_id, event } = await eventService.createEvent(db, { ... });
 */

const gcal         = require('./gcalService');
const taskService  = require('./taskService');
const logService   = require('./logService');
const emailService = require('./emailService');
const { FIRM_TZ }  = require('./timezoneService');
const { DateTime } = require('luxon');

// ─────────────────────────────────────────────────────────────
// GOOGLE CALENDAR INTEGRATION
//
// Mirrors apptService: gcalService returns the event resource synchronously
// and THIS service owns the event_gcal write. All calendar work is
// fire-and-forget (post-commit) — a calendar failure emails IT (throttled)
// but never blocks or rolls back an event write.
// ─────────────────────────────────────────────────────────────

// In-memory throttle so a burst of calendar failures can't bury IT in email.
// 1 hour per failure-kind. Process-local — acceptable for a low-volume alert.
const GCAL_ALERT_THROTTLE_MS = 60 * 60 * 1000;
const _lastGcalAlertAt = new Map();

/**
 * Email IT about a calendar failure, throttled per `kind`. Never throws.
 * Mirrors apptService.alertGcalFailure.
 */
function alertGcalFailure(db, kind, detail) {
  const now = Date.now();
  if ((now - (_lastGcalAlertAt.get(kind) || 0)) < GCAL_ALERT_THROTTLE_MS) return;
  _lastGcalAlertAt.set(kind, now);

  const to   = process.env.IT_EMAIL;
  const from = process.env.AUTO_EMAIL;
  if (!to || !from) {
    console.warn('[EVENT SERVICE] IT_EMAIL or AUTO_EMAIL not set; gcal alert skipped');
    return;
  }

  emailService.sendEmail(db, {
    from,
    to,
    subject: `[YisraCase] Google Calendar sync failed (event): ${kind}`,
    text:
      `A Google Calendar operation failed in eventService.\n\n` +
      `Operation:    ${kind}\n` +
      `Environment:  ${process.env.ENVIRONMENT || 'unknown'}\n` +
      `Time:         ${new Date().toISOString()}\n` +
      `Detail:       ${detail}\n\n` +
      `The event record itself is unaffected — only the calendar event did ` +
      `not sync. Check the connection (Connections → Google) and the ` +
      `credential's allowed_urls if this repeats.\n\n` +
      `Throttled to once per hour per operation type.`,
  }).catch(e => console.error('[EVENT SERVICE] gcal alert email failed:', e.message));
}

/**
 * Delete a calendar event by ID. Fire-and-forget — never throws. Treats
 * Google's 410 (already gone) as success. Mirrors apptService.
 */
async function deleteEventCalendarEvent(db, eventId, calendarId, contextLabel) {
  if (!eventId) return;
  try {
    await gcal.deleteEvent(db, {
      eventId,
      ...(calendarId && calendarId !== 'none' && { calendarId }),
    });
  } catch (err) {
    if (/→\s410:/.test(err.message)) {
      console.warn(`[EVENT SERVICE] GCal delete (${contextLabel}) — event ${eventId} already gone`);
      return;
    }
    console.error(`[EVENT SERVICE] GCal delete (${contextLabel}) failed:`, err.message);
    alertGcalFailure(db, 'delete', `${contextLabel} event=${eventId}: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Format a DATE value (Date or string) as 'YYYY-MM-DD'.
 * mysql2 reads a DATE column as a Date labeled UTC; slicing the ISO form
 * preserves the calendar date exactly as stored.
 */
function _dateOnly(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Format a TIME value (string 'HH:MM:SS' or Date) as 'HH:MM:SS'.
 */
function _timeOnly(t) {
  if (t == null || t === '') return null;
  const s = String(t);
  // mysql2 returns TIME as a string 'HH:MM:SS'. Accept 'HH:MM' too.
  const m = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  return m[1].length === 5 ? `${m[1]}:00` : m[1];
}

/**
 * Apply the all_day/time consistency invariant to a normalized field set.
 * Rules:
 *   - all_day explicitly 1  → time forced null, all_day = 1
 *   - all_day explicitly 0  → all_day = 0 (time kept as given; may be null)
 *   - all_day not given:
 *       time present        → all_day = 0
 *       time absent          → all_day = 1
 * Returns { event_all_day, event_time }.
 */
function _normalizeAllDay({ event_all_day, event_time }) {
  let allDay;
  let time = (event_time === '' ? null : event_time);

  const allDayGiven = event_all_day !== undefined && event_all_day !== null;

  if (allDayGiven) {
    allDay = (event_all_day === 1 || event_all_day === '1' || event_all_day === true) ? 1 : 0;
  } else {
    allDay = (time == null) ? 1 : 0;
  }

  if (allDay === 1) time = null;
  return { event_all_day: allDay, event_time: time };
}

/**
 * Compose the calendar start/end objects for an event row.
 * Exported for testing.
 *
 *   all-day:  start = { date: 'YYYY-MM-DD' }
 *             end   = { date: 'YYYY-MM-DD' + 1 day }   // GCal end.date is EXCLUSIVE
 *   timed:    start = 'YYYY-MM-DDTHH:MM:SS'            // gcalService applies FIRM_TZ
 *             end   = start + (event_length || 60) minutes, same naive-local form
 *
 * @param {object} event - an events row (post-normalization, or DB row)
 * @returns {{ start: any, end: any }}
 */
function _gcalTimes(event) {
  const dateStr = _dateOnly(event.event_date);
  const isAllDay =
    event.event_all_day === 1 || event.event_all_day === '1' || event.event_all_day === true ||
    (event.event_all_day == null && (event.event_time == null || event.event_time === ''));

  if (isAllDay) {
    const startDt = DateTime.fromISO(dateStr, { zone: FIRM_TZ });
    const endDt   = startDt.plus({ days: 1 });
    return {
      start: { date: startDt.toFormat('yyyy-MM-dd') },
      end:   { date: endDt.toFormat('yyyy-MM-dd') },
    };
  }

  const timeStr = _timeOnly(event.event_time) || '00:00:00';
  const local   = `${dateStr}T${timeStr}`;
  const lenMin  = Number(event.event_length) > 0 ? Number(event.event_length) : 60;
  const startDt = DateTime.fromISO(local, { zone: FIRM_TZ });
  const endStr  = startDt.isValid
    ? startDt.plus({ minutes: lenMin }).toFormat("yyyy-MM-dd'T'HH:mm:ss")
    : local;

  return { start: local, end: endStr };
}

/**
 * Build the calendar event resource (summary/description/location) for an event.
 * Kept in one place so the event text is easy to tune.
 */
function _buildEventResource(event) {
  const summary = event.event_title || 'Event';

  const descLines = [];
  if (event.event_type)  descLines.push(`Type: ${event.event_type}`);
  if (event.event_note)  descLines.push(event.event_note);
  if (event.event_link)  descLines.push(event.event_link);

  return {
    summary,
    ...(descLines.length && { description: descLines.join('\n') }),
    ...(event.event_location && { location: event.event_location }),
  };
}

/**
 * Decide whether an event should sync to the calendar at all.
 * v1: every event goes on the calendar UNLESS event_calendar_id is the
 * literal 'none', or skip_gcal is explicitly set.
 */
function _shouldSyncGcal(event, { skip_gcal = false } = {}) {
  if (skip_gcal) return false;
  if (event.event_calendar_id === 'none') return false;
  return true;
}

/**
 * Create the calendar event for an event row and write event_gcal back.
 * Fire-and-forget — never throws.
 */
async function syncEventToCalendar(db, event, { skip_gcal = false } = {}) {
  if (!_shouldSyncGcal(event, { skip_gcal })) return;
  try {
    const { start, end } = _gcalTimes(event);
    const resource = _buildEventResource(event);

    const created = await gcal.createEvent(db, {
      ...resource,
      start,
      end,
      // event_calendar_id 'none' is handled by _shouldSyncGcal above; any other
      // truthy value is a real override. NULL/empty → undefined → service default.
      ...(event.event_calendar_id && { calendarId: event.event_calendar_id }),
    });

    await db.query(
      'UPDATE events SET event_gcal = ? WHERE event_id = ?',
      [created.id, event.event_id]
    );
  } catch (err) {
    console.error(`[EVENT SERVICE] GCal create (event ${event.event_id}) failed:`, err.message);
    alertGcalFailure(db, 'create', `event_id=${event.event_id}: ${err.message}`);
  }
}

/**
 * Insert a log entry tied to an event row.
 *
 * Mirrors apptService.insertApptLog: delegates to logService.createLogEntry
 * for proper JSON.stringify of log_data and correct population of
 * log_link_type / log_link_id.
 *
 * Link mapping:
 *   event_link_type 'case'    → log link_type 'case',    link_id = event_link_id
 *   event_link_type 'contact' → log link_type 'contact', link_id = event_link_id
 *   unlinked (both NULL)      → log_link_type/id NULL (allowed)
 *
 * @param {object} db
 * @param {object} event       - an events row (must include id/type/date/link cols)
 * @param {number} actingUserId
 * @param {string} action      - 'created' | 'updated' | 'completed' | 'canceled'
 * @param {object} [extra]     - additional key/value pairs merged into log_data
 */
async function insertEventLog(db, event, actingUserId, action, extra = {}) {
  const data = {
    action,
    event_id:    event.event_id,
    event_title: event.event_title || '',
    ...(event.event_type ? { event_type: event.event_type } : {}),
    ...(event.event_date ? { event_date: _dateOnly(event.event_date) } : {}),
    ...extra,
  };

  let linkType = null;
  let linkId   = null;
  if (event.event_link_type && event.event_link_id != null && event.event_link_id !== '') {
    linkType = event.event_link_type;   // 'case' | 'contact'
    linkId   = event.event_link_id;
  }

  await logService.createLogEntry(db, {
    type:      'event',
    link_type: linkType,
    link_id:   linkId,
    by:        actingUserId || 0,
    data,   // createLogEntry handles JSON.stringify internally
  });
}


// ─────────────────────────────────────────────────────────────
// REMINDER TASKS
//
// A reminder is a normal task with task_link_type='event' and
// task_link_id=String(event_id). Created via taskService.createTask (which
// also schedules the 8 AM due-date reminder job when `due` is set). On
// complete/cancel we find active reminder tasks for the event and delete
// each via taskService.deleteTask — chosen over a bare status flip because
// deleteTask ALSO calls cancelDueReminder, which kills the scheduled job.
// ─────────────────────────────────────────────────────────────

/**
 * Spawn a single reminder task for an event. Non-blocking semantics are the
 * caller's responsibility (this awaits, but callers wrap it). Returns the new
 * task_id or null.
 *
 * @param {object} db
 * @param {object} event   - the event row (for default title)
 * @param {object} reminder - { to, date, title? }
 * @param {number} actingUserId
 */
async function spawnReminderTask(db, event, reminder, actingUserId = 0) {
  if (!reminder || !reminder.to) {
    console.warn(`[EVENT SERVICE] spawnReminderTask: missing reminder.to for event ${event.event_id}`);
    return null;
  }
  const title = (reminder.title && String(reminder.title).trim())
    || `Reminder: ${event.event_title}`;

  const result = await taskService.createTask(db, {
    from:      actingUserId || reminder.to,
    to:        reminder.to,
    title,
    desc:      '',
    due:       reminder.date || null,
    link_type: 'event',
    link_id:   String(event.event_id),
  });
  return result.task_id;
}

/**
 * Find active (not Completed/Deleted) reminder tasks for an event.
 */
async function _activeReminderTaskIds(db, eventId) {
  const [rows] = await db.query(
    `SELECT task_id FROM tasks
      WHERE task_link_type = 'event' AND task_link_id = ?
        AND task_status NOT IN ('Completed', 'Deleted')`,
    [String(eventId)]
  );
  return rows.map(r => r.task_id);
}

/**
 * Cancel (soft-delete) all active reminder tasks for an event. Each
 * deleteTask call also cancels that task's scheduled due-reminder job.
 * Non-blocking — failures are logged, never thrown.
 */
async function cancelReminderTasks(db, eventId, actingUserId = 0) {
  try {
    const ids = await _activeReminderTaskIds(db, eventId);
    for (const id of ids) {
      await taskService.deleteTask(db, id, actingUserId)
        .catch(err => console.error(`[EVENT SERVICE] Cancel reminder task ${id} failed:`, err.message));
    }
  } catch (err) {
    console.error(`[EVENT SERVICE] cancelReminderTasks (event ${eventId}) failed:`, err.message);
  }
}


// ─────────────────────────────────────────────────────────────
// getEvent
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single event with its resolved link label.
 *
 * @param {object} db
 * @param {number} eventId
 * @returns {Promise<object|null>} the event row plus link_label / link_id /
 *          link_type fields, or null if not found.
 */
async function getEvent(db, eventId) {
  const [[row]] = await db.query(
    `SELECT
       e.*,
       co.contact_name,
       ca.case_id AS joined_case_id,
       COALESCE(ca.case_number_full, ca.case_number) AS case_number_display
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     WHERE e.event_id = ?`,
    [eventId]
  );
  if (!row) return null;

  let link_label = null;
  if (row.event_link_type === 'contact') {
    link_label = row.contact_name || (row.event_link_id != null ? `Contact #${row.event_link_id}` : null);
  } else if (row.event_link_type === 'case') {
    link_label = row.case_number_display || row.event_link_id || null;
  }

  return {
    ...row,
    link_type:  row.event_link_type,
    link_id:    row.event_link_id,
    link_label,
  };
}


// ─────────────────────────────────────────────────────────────
// listEvents
// ─────────────────────────────────────────────────────────────

/**
 * List events with filters.
 *
 * @param {object} db
 * @param {object} opts
 *   link_type {string?}  'case' | 'contact'
 *   link_id   {string?}
 *   status    {string?}  default 'Scheduled'; 'all' => no status filter
 *   type      {string?}  event_type
 *   from      {string?}  event_date >= (YYYY-MM-DD)
 *   to        {string?}  event_date <= (YYYY-MM-DD)
 *   q         {string?}  LIKE on event_title
 *   sort      {string?}  'asc' (soonest first, default) | 'desc' (latest first)
 *   limit     {number?}  default 100
 *   offset    {number?}  default 0
 * @returns {Promise<{ data: object[], total: number }>}
 */
async function listEvents(db, {
  link_type = null,
  link_id   = null,
  status    = 'Scheduled',
  type      = null,
  from      = null,
  to        = null,
  q         = '',
  sort      = 'asc',
  limit     = 100,
  offset    = 0,
} = {}) {
  const where  = [];
  const params = [];

  if (link_type && link_id != null && link_id !== '') {
    where.push('e.event_link_type = ? AND e.event_link_id = ?');
    params.push(link_type, String(link_id));
  } else if (link_type) {
    where.push('e.event_link_type = ?');
    params.push(link_type);
  }

  if (status && status !== 'all' && status !== 'All') {
    where.push('e.event_status = ?');
    params.push(status);
  }

  if (type) { where.push('e.event_type = ?'); params.push(type); }
  if (from) { where.push('e.event_date >= ?'); params.push(String(from).slice(0, 10)); }
  if (to)   { where.push('e.event_date <= ?'); params.push(String(to).slice(0, 10)); }
  if (q)    { where.push('e.event_title LIKE ?'); params.push(`%${q}%`); }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Whitelisted sort (no interpolation of user input). 'asc' = soonest first
  // (default, preserves prior behavior); 'desc' = latest first.
  const orderSQL = String(sort).toLowerCase() === 'desc'
    ? 'ORDER BY e.event_date DESC, e.event_time IS NULL ASC, e.event_time DESC'
    : 'ORDER BY e.event_date ASC, e.event_time IS NULL DESC, e.event_time ASC';

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM events e ${whereSQL}`,
    params
  );

  const [rows] = await db.query(
    `SELECT
       e.*,
       co.contact_name,
       COALESCE(ca.case_number_full, ca.case_number) AS case_number_display
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     ${whereSQL}
     ${orderSQL}
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );

  const data = rows.map(r => {
    let link_label = null;
    if (r.event_link_type === 'contact') {
      link_label = r.contact_name || (r.event_link_id != null ? `Contact #${r.event_link_id}` : null);
    } else if (r.event_link_type === 'case') {
      link_label = r.case_number_display || r.event_link_id || null;
    }
    return { ...r, link_type: r.event_link_type, link_id: r.event_link_id, link_label };
  });

  return { data, total };
}


// ─────────────────────────────────────────────────────────────
// createEvent
// ─────────────────────────────────────────────────────────────

/**
 * Create a new event.
 *
 * Core write (synchronous):
 *   - INSERT into events
 *   - Log entry (log_type='event', action 'created')
 *
 * Post-commit (non-blocking):
 *   - GCal create → write event_gcal back
 *   - If opts.reminder present → spawn ONE reminder task
 *
 * @param {object} db
 * @param {object} opts
 * @returns {{ event_id, event }}
 */
async function createEvent(db, {
  event_type        = null,
  event_link_type   = null,
  event_link_id     = null,
  event_title,
  event_date,
  event_time        = null,
  event_all_day,
  event_length      = null,
  event_location    = null,
  event_link        = null,
  event_note        = null,
  event_calendar_id = null,
  acting_user_id,
  reminder          = null,
  skip_gcal         = false,
} = {}) {
  if (!event_title || !String(event_title).trim()) throw new Error('createEvent requires event_title');
  if (!event_date) throw new Error('createEvent requires event_date');

  // Normalize all-day/time consistency
  const { event_all_day: allDay, event_time: time } =
    _normalizeAllDay({ event_all_day, event_time });

  // event_length applies to timed events only
  const lengthVal = allDay === 1 ? null : (event_length != null ? Number(event_length) : null);

  const createdBy = (acting_user_id != null && acting_user_id !== '' && Number(acting_user_id) !== 0)
    ? Number(acting_user_id)
    : null;

  const [result] = await db.query(
    `INSERT INTO events
       (event_type, event_link_type, event_link_id, event_title, event_date,
        event_time, event_all_day, event_length, event_location, event_link,
        event_note, event_status, event_calendar_id, event_create_date, event_created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, NOW(), ?)`,
    [
      event_type,
      event_link_type,
      event_link_id != null && event_link_id !== '' ? String(event_link_id) : null,
      String(event_title).trim(),
      _dateOnly(event_date),
      time,
      allDay,
      lengthVal,
      event_location,
      event_link,
      event_note,
      event_calendar_id,
      createdBy,
    ]
  );
  const eventId = result.insertId;

  // Build a lightweight row for logging / gcal (avoids an extra round-trip
  // before the post-commit work).
  const eventRow = {
    event_id:          eventId,
    event_type,
    event_link_type,
    event_link_id:     event_link_id != null && event_link_id !== '' ? String(event_link_id) : null,
    event_title:       String(event_title).trim(),
    event_date:        _dateOnly(event_date),
    event_time:        time,
    event_all_day:     allDay,
    event_length:      lengthVal,
    event_location,
    event_link,
    event_note,
    event_calendar_id,
  };

  // Log entry
  const logExtras = {};
  if (event_note) logExtras.note = event_note;
  await insertEventLog(db, eventRow, createdBy, 'created', logExtras);

  // ---- Post-commit non-blocking side effects ----

  // a) GCal create
  syncEventToCalendar(db, eventRow, { skip_gcal })
    .catch(err => console.error('[EVENT SERVICE] syncEventToCalendar wrapper failed:', err.message));

  // b) Reminder task
  if (reminder) {
    spawnReminderTask(db, eventRow, reminder, createdBy || 0)
      .then(taskId => {
        if (taskId) console.log(`[EVENT SERVICE] Event ${eventId} reminder task #${taskId} created`);
      })
      .catch(err => console.error('[EVENT SERVICE] spawnReminderTask failed:', err.message));
  }

  const event = await getEvent(db, eventId);
  return { event_id: eventId, event };
}


// ─────────────────────────────────────────────────────────────
// updateEvent
// ─────────────────────────────────────────────────────────────

const UPDATE_ALLOWED = new Set([
  'event_type', 'event_link_type', 'event_link_id', 'event_title',
  'event_date', 'event_time', 'event_all_day', 'event_length',
  'event_location', 'event_link', 'event_note', 'event_status',
  'event_calendar_id',
]);

// Fields whose change requires a calendar re-sync (delete + recreate).
const GCAL_AFFECTING = new Set([
  'event_title', 'event_date', 'event_time', 'event_all_day',
  'event_length', 'event_location', 'event_link', 'event_calendar_id',
]);

/**
 * Update one or more fields on an event, and/or swap its reminder task.
 *
 * Whitelisted columns only (others rejected with "blocked fields: ..."). The
 * all_day/time consistency rule is re-applied. If any gcal-affecting field
 * changed (and the event should have a calendar entry) the calendar event is
 * delete-then-recreated, mirroring the appt reschedule pattern.
 *
 * Reminder handling (option 2 — explicit, no delta-inference):
 *   - opts.reminder OMITTED (undefined)       → reminders untouched.
 *   - opts.reminder = { to, date, title? }    → cancel existing active reminder
 *                                               task(s) for this event, spawn
 *                                               the new one.
 *   - opts.reminder = null                    → cancel existing active reminder
 *                                               task(s), spawn none (remove).
 * A reminder-only update (no `fields`) is allowed.
 *
 * @param {object} db
 * @param {number} eventId
 * @param {object} fields
 * @param {number} actingUserId
 * @param {object} [opts]
 * @param {object|null} [opts.reminder] - see above. `undefined` = leave reminders alone.
 * @returns {{ event }}
 */
async function updateEvent(db, eventId, fields, actingUserId = 0, { reminder } = {}) {
  const hasFields        = !!(fields && Object.keys(fields).length);
  const reminderProvided = reminder !== undefined;

  if (!hasFields && !reminderProvided) {
    throw new Error('updateEvent requires at least one field or a reminder');
  }

  if (hasFields) {
    const blocked = Object.keys(fields).filter(k => !UPDATE_ALLOWED.has(k));
    if (blocked.length) throw new Error(`updateEvent: blocked fields: ${blocked.join(', ')}`);
  }

  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);

  let changedKeys = [];

  if (hasFields) {
    // Work on a merged copy so we can re-apply the all_day/time invariant even
    // when only one of the pair was supplied.
    const merged = { ...fields };

    // Re-apply the all_day/time invariant when EITHER half of the pair was
    // supplied. Precedence (matches _normalizeAllDay):
    //   - user sent event_all_day  → it wins (all_day=1 forces time null).
    //   - user sent only event_time → all_day is INFERRED from the time
    //     (non-null time → timed; null time → all-day). The existing all_day
    //     flag must NOT be fed in here, or it would override the user's intent
    //     (e.g. PATCH {event_time:"14:30"} on an all-day event would snap back
    //     to all-day and drop the time).
    if ('event_all_day' in fields || 'event_time' in fields) {
      const allDayArg = 'event_all_day' in fields ? fields.event_all_day : undefined;
      const timeArg   = 'event_time'    in fields ? fields.event_time     : existing.event_time;

      const { event_all_day: allDay, event_time: time } = _normalizeAllDay({
        event_all_day: allDayArg,   // undefined when not user-supplied → infer from time
        event_time:    timeArg,
      });
      merged.event_all_day = allDay;
      merged.event_time     = time;
      // If we became all-day, null the length too.
      if (allDay === 1) merged.event_length = null;
    }

    // Normalize event_date if present
    if ('event_date' in merged && merged.event_date) {
      merged.event_date = _dateOnly(merged.event_date);
    }
    // Stringify link id if present
    if ('event_link_id' in merged) {
      merged.event_link_id =
        merged.event_link_id != null && merged.event_link_id !== '' ? String(merged.event_link_id) : null;
    }

    const keys = Object.keys(merged);
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => merged[k]), eventId];

    const [res] = await db.query(
      `UPDATE events SET ${setClauses} WHERE event_id = ?`,
      values
    );
    if (res.affectedRows === 0) throw new Error(`Event ${eventId} not found`);
    changedKeys = keys;
  }

  // Re-log (covers field change and/or reminder change)
  const logExtra = {};
  if (changedKeys.length) logExtra.changed = changedKeys;
  if (reminderProvided) {
    logExtra.reminder = (reminder && typeof reminder === 'object') ? 'rescheduled' : 'cleared';
  }
  await insertEventLog(db, existing, actingUserId, 'updated', logExtra);

  // ---- GCal sync (non-blocking) — only when a gcal-affecting field changed ----
  const gcalChanged = changedKeys.some(k => GCAL_AFFECTING.has(k));
  if (gcalChanged) {
    (async () => {
      const fresh = await getEvent(db, eventId);
      if (!fresh) return;
      // Determine whether this event should have a calendar entry now.
      if (!_shouldSyncGcal(fresh)) {
        // Calendar opt-out (event_calendar_id 'none'): tear down any prior event.
        if (existing.event_gcal) {
          await deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'update_optout');
          await db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId]);
        }
        return;
      }
      // Delete-then-recreate (mirrors appt reschedule).
      if (existing.event_gcal) {
        await deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'update');
        await db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId]);
      }
      await syncEventToCalendar(db, { ...fresh });
    })().catch(err => console.error('[EVENT SERVICE] update gcal sync failed:', err.message));
  }

  // ---- Reminder swap (option 2) ----
  // Awaited (so callers/tests see the new task immediately) but wrapped so a
  // task-system failure never propagates out of an otherwise-successful event
  // update. cancelReminderTasks never throws; spawnReminderTask might.
  if (reminderProvided) {
    try {
      await cancelReminderTasks(db, eventId, actingUserId);
      if (reminder && typeof reminder === 'object') {
        // Re-fetch so the default reminder title reflects any title change in
        // this same update.
        const fresh = await getEvent(db, eventId) || existing;
        const taskId = await spawnReminderTask(db, fresh, reminder, actingUserId);
        if (taskId) console.log(`[EVENT SERVICE] Event ${eventId} reminder task #${taskId} created (update)`);
      }
    } catch (err) {
      console.error('[EVENT SERVICE] updateEvent reminder swap failed:', err.message);
    }
  }

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// completeEvent
// ─────────────────────────────────────────────────────────────

/**
 * Mark an event Completed.
 *   - status → 'Completed'
 *   - cancel reminder task(s) (non-blocking)
 *   - do NOT delete the gcal event (it's a real past calendar entry)
 *   - log action 'completed'
 */
async function completeEvent(db, eventId, actingUserId = 0) {
  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);
  if (existing.event_status === 'Completed') throw new Error('Event is already Completed');

  await db.query(
    `UPDATE events SET event_status = 'Completed' WHERE event_id = ?`,
    [eventId]
  );

  await insertEventLog(db, existing, actingUserId, 'completed',
    existing.event_status !== 'Scheduled' ? { from: existing.event_status } : {});

  cancelReminderTasks(db, eventId, actingUserId)
    .catch(err => console.error('[EVENT SERVICE] completeEvent cancelReminderTasks failed:', err.message));

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// cancelEvent
// ─────────────────────────────────────────────────────────────

/**
 * Mark an event Canceled.
 *   - status → 'Canceled'
 *   - if delete_gcal and event_gcal: delete the calendar event (non-blocking)
 *   - cancel reminder task(s) (non-blocking)
 *   - log action 'canceled'
 */
async function cancelEvent(db, eventId, actingUserId = 0, { delete_gcal = true } = {}) {
  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);
  if (existing.event_status === 'Canceled') throw new Error('Event is already Canceled');

  await db.query(
    `UPDATE events SET event_status = 'Canceled' WHERE event_id = ?`,
    [eventId]
  );

  await insertEventLog(db, existing, actingUserId, 'canceled',
    existing.event_status !== 'Scheduled' ? { from: existing.event_status } : {});

  if (delete_gcal && existing.event_gcal) {
    deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'cancel');
    db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId])
      .catch(err => console.error('[EVENT SERVICE] cancelEvent clear gcal id failed:', err.message));
  }

  cancelReminderTasks(db, eventId, actingUserId)
    .catch(err => console.error('[EVENT SERVICE] cancelEvent cancelReminderTasks failed:', err.message));

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// DIGEST SUPPORT (for the 'event_daily_digest' scheduled job)
//
// Pure read/format helpers — no writes, no GCal, no side effects.
// getEventsForDigest mirrors the getEvent/listEvents join shape;
// buildEventDigestEmail mirrors taskService.buildDigestEmail's
// inline-styled email aesthetic (teal accent to distinguish it from
// the indigo task digest). The job block in lib/job_executor.js owns
// the date-window math, grouping, recipients, and dispatch.
// ─────────────────────────────────────────────────────────────

/**
 * Fetch Scheduled events whose event_date falls within [from..to]
 * (inclusive, firm-local 'YYYY-MM-DD'), with resolved entity labels.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.from  'YYYY-MM-DD'
 * @param {string} opts.to    'YYYY-MM-DD'
 * @returns {Promise<object[]>} raw rows (job block groups/formats)
 */
async function getEventsForDigest(db, { from, to } = {}) {
  if (!from || !to) {
    throw new Error('getEventsForDigest requires { from, to } as YYYY-MM-DD');
  }
  const fromStr = String(from).slice(0, 10);
  const toStr   = String(to).slice(0, 10);

  // Joins mirror getEvent() verbatim:
  //   - case join: varchar event_link_id = varchar cases.case_id (both
  //     utf8mb4_general_ci) → collation-safe.
  //   - contact join: varchar event_link_id = int contacts.contact_id →
  //     implicit numeric cast (same as getEvent, proven in production).
  const [rows] = await db.query(
    `SELECT
       e.event_id, e.event_type, e.event_title, e.event_date, e.event_time,
       e.event_all_day, e.event_location, e.event_link,
       e.event_link_type, e.event_link_id,
       co.contact_name,
       ca.case_number_full, ca.case_number, ca.case_id
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     WHERE e.event_status = 'Scheduled'
       AND e.event_date BETWEEN ? AND ?
     ORDER BY e.event_date ASC, e.event_all_day DESC, e.event_time ASC`,
    [fromStr, toStr]
  );
  return rows;
}

/**
 * Build the upcoming-events digest email HTML.
 *
 * @param {string} recipientFName  first name for the greeting ('' = generic)
 * @param {object[]} eventsByDate  [{ dateName, events: [row, ...] }, ...]
 *                                 (pre-grouped & date-ascending by the job)
 * @param {object} [opts]
 * @param {string} [opts.windowLabel]  e.g. "Fri" / "Fri–Sun"
 * @returns {string} full HTML document
 */
function buildEventDigestEmail(recipientFName, eventsByDate, opts = {}) {
  const { windowLabel = '' } = opts;
  const APP_URL = process.env.APP_URL || 'https://app.4lsg.com';
  const HEADER  = '#0f766e'; // teal-700 — visually distinct from indigo task digest
  const groups  = Array.isArray(eventsByDate) ? eventsByDate : [];
  const total   = groups.reduce((n, g) => n + (g.events ? g.events.length : 0), 0);

  // NOTE: event fields are rendered unescaped, matching taskService's
  // buildDigestEmail behavior (staff-entered content). If we ever decide to
  // escape, do it in both builders together.

  function timeLabel(row) {
    const allDay = row.event_all_day === 1 || row.event_all_day === '1' || row.event_all_day === true;
    if (allDay) return 'All day';
    const t = _timeOnly(row.event_time);
    if (!t) return 'All day';
    const dt = DateTime.fromFormat(t, 'HH:mm:ss');
    return dt.isValid ? dt.toFormat('h:mm a') : t.slice(0, 5);
  }

  function entityLink(row) {
    if (row.event_link_type === 'contact') {
      const name = row.contact_name
        || (row.event_link_id != null ? `Contact #${row.event_link_id}` : '');
      if (!name) return '';
      return `<a href="${APP_URL}?contact=${row.event_link_id || ''}" `
           + `style="color:${HEADER};text-decoration:none">${name}</a>`;
    }
    if (row.event_link_type === 'case') {
      const name = row.case_number_full || row.case_number
        || (row.event_link_id != null ? `Case ${row.event_link_id}` : '');
      if (!name) return '';
      return `<a href="${APP_URL}?case=${row.case_id || row.event_link_id || ''}" `
           + `style="color:${HEADER};text-decoration:none">${name}</a>`;
    }
    return '';
  }

  function eventRow(row) {
    const time = timeLabel(row);
    const meta = [];
    if (row.event_type) meta.push(row.event_type);
    const ent = entityLink(row);
    if (ent) meta.push(ent);
    if (row.event_location) meta.push(row.event_location);

    const sep = '<span style="color:#d1d5db;padding:0 6px">·</span>';
    const metaLine = meta.length
      ? `<div style="margin-top:2px;font-size:12px;color:#6b7280">${meta.join(sep)}</div>`
      : '';
    const linkLine = row.event_link
      ? `<div style="margin-top:3px;font-size:12px">`
        + `<a href="${row.event_link}" style="color:${HEADER};text-decoration:none">Open link ↗</a></div>`
      : '';

    return `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:10px 10px 10px 0;font-size:12px;color:#111827;font-weight:600;
                 white-space:nowrap;vertical-align:top;width:80px">${time}</td>
      <td style="padding:10px 0;vertical-align:top">
        <div style="font-size:14px;color:#111827;font-weight:600">${row.event_title || 'Event'}</div>
        ${metaLine}
        ${linkLine}
      </td>
    </tr>`;
  }

  function dayBlock(group) {
    return `<div style="margin-bottom:22px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:${HEADER};
                letter-spacing:1px;text-transform:uppercase;
                border-bottom:2px solid ${HEADER};padding-bottom:6px">${group.dateName}</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tbody>
        ${(group.events || []).map(eventRow).join('')}
      </tbody></table>
    </div>`;
  }

  const greeting = recipientFName ? `Hi ${recipientFName},` : 'Hello,';
  const subject  = `Upcoming Events${windowLabel ? ` — ${windowLabel}` : ''}`;

  const body = `
    <h2 style="margin:0 0 2px;font-size:22px;color:#111827">Upcoming Events</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#6b7280">
      ${greeting} here ${total === 1 ? 'is' : 'are'} ${total}
      scheduled event${total === 1 ? '' : 's'}${windowLabel ? ` for ${windowLabel}` : ''}.
    </p>
    ${groups.map(dayBlock).join('')}
    <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">
      Log in to YisraCase to view or manage these events.
    </p>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f0fdfa;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfa;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:100%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${HEADER};padding:22px 32px 18px">
          <span style="color:#ccfbf1;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">${subject}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">${body}</td>
      </tr>
      <tr>
        <td style="background:#f0fdfa;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">
            This message was sent automatically by YisraCase.
            If you have questions, reach out to your supervisor.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Send the upcoming-events digest. Owns ALL orchestration (window math,
 * grouping, recipient resolution, dispatch) so the recurring scheduled job
 * (via internalFunctions.run_event_digest) and any on-demand caller share
 * one implementation — no copy-paste twin like task digest has today.
 *
 * Window: tomorrow → the next workday (inclusive), extended across any
 * Shabbos/Yom Tov closure so the last open day before a closure still warns.
 * Override with explicit { from, to } ('YYYY-MM-DD'); when overridden the
 * window is used verbatim (no workday extension).
 *
 * Send-gate: skipped entirely on Shabbos / Yom Tov unless force=true. (The
 * gate keys off TODAY, not the window.)
 *
 * Recipients: app_settings 'event_digest_recipients' (CSV of users.user
 * ids); falls back to the firm catch-all inbox (app_settings
 * 'email_default_to', then process.env.FIRM_EMAIL). Aborts (sends nothing)
 * if none resolve. One bad recipient never aborts the rest.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  skip the Shabbos/Yom Tov send-gate
 * @param {string}  [opts.from]         'YYYY-MM-DD' window start override
 * @param {string}  [opts.to]           'YYYY-MM-DD' window end override
 * @returns {Promise<object>} summary ({ sent, window, event_count } or
 *          { skipped_reason } or { sent:0, reason })
 */
async function sendEventDigest(db, { force = false, from = null, to = null } = {}) {
  // Lazy requires — cycle-safety + matches the run_task_digest convention.
  const calendarSvc = require('./calendarService');
  const phoneSvc    = require('./phoneService');

  const nowFirm = DateTime.now().setZone(FIRM_TZ);

  // ── 1. Shabbos / Yom Tov send-gate (unless forced) ───────────────────
  if (!force) {
    const { workday, isShabbos, holidayName } = await calendarSvc.isWorkday(nowFirm.toISO());
    if (!workday) {
      const reason = isShabbos ? 'Shabbos' : `Yom Tov (${holidayName})`;
      console.log(`[EVENT DIGEST] Skipping notifications — ${reason}`);
      return { skipped_reason: reason };
    }
  }

  // ── 2. Coverage window ───────────────────────────────────────────────
  let fromStr, toStr, windowLabel;
  if (from && to) {
    fromStr = String(from).slice(0, 10);
    toStr   = String(to).slice(0, 10);
    const a = DateTime.fromISO(fromStr, { zone: FIRM_TZ });
    const b = DateTime.fromISO(toStr,   { zone: FIRM_TZ });
    windowLabel = (fromStr === toStr) ? a.toFormat('cccc') : `${a.toFormat('ccc')}–${b.toFormat('ccc')}`;
  } else {
    // tomorrow → next workday (inclusive). Extend across closed days so the
    // last open day before a closure still warns. (startOf('day') firm-local
    // ISO keeps the same calendar weekday after UTC conversion, so
    // isWorkday's restricted-day detection stays correct.)
    const start = nowFirm.plus({ days: 1 }).startOf('day');
    let end = start, guard = 0;
    while (!(await calendarSvc.isWorkday(end.toISO())).workday && guard < 10) {
      end = end.plus({ days: 1 });
      guard++;
    }
    fromStr = start.toFormat('yyyy-MM-dd');
    toStr   = end.toFormat('yyyy-MM-dd');
    windowLabel = (fromStr === toStr) ? start.toFormat('cccc') : `${start.toFormat('ccc')}–${end.toFormat('ccc')}`;
  }

  // ── 3. Fetch Scheduled events in the window ──────────────────────────
  const rows = await getEventsForDigest(db, { from: fromStr, to: toStr });
  if (rows.length === 0) {
    console.log(`[EVENT DIGEST] No events in window ${fromStr}..${toStr} — nothing to send`);
    return { sent: 0, reason: 'no events in window', window: [fromStr, toStr] };
  }

  // ── 4. Group by event_date (rows already date-ascending) ─────────────
  const eventsByDate = [];
  const groupIndex   = new Map();
  for (const r of rows) {
    const key = _dateOnly(r.event_date);
    let grp = groupIndex.get(key);
    if (!grp) {
      grp = { dateName: DateTime.fromISO(key, { zone: FIRM_TZ }).toFormat('cccc, MMMM d'), events: [] };
      groupIndex.set(key, grp);
      eventsByDate.push(grp);
    }
    grp.events.push(r);
  }

  // ── 5. Resolve recipients ────────────────────────────────────────────
  let recipients = [];
  const [[recipRow]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = 'event_digest_recipients'"
  );
  const csv = ((recipRow && recipRow.value) || '').trim();
  if (csv) {
    const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [urows] = await db.query(
        `SELECT user_fname, email, phone, allow_sms FROM users WHERE user IN (${placeholders})`,
        ids
      );
      recipients = urows.map(u => ({
        fname: u.user_fname, email: u.email, phone: u.phone, allow_sms: u.allow_sms,
      }));
    }
  }
  if (!recipients.length) {
    // No targeted recipients — fall back to the firm catch-all inbox:
    // app_settings 'email_default_to', then process.env.FIRM_EMAIL.
    const [[toRow]] = await db.query(
      "SELECT value FROM app_settings WHERE `key` = 'email_default_to'"
    );
    const fallbackTo = ((toRow && toRow.value) || '').trim() || process.env.FIRM_EMAIL || null;
    if (fallbackTo) recipients = [{ fname: '', email: fallbackTo, phone: null, allow_sms: 0 }];
  }
  if (!recipients.length) {
    console.warn('[EVENT DIGEST] No recipients (event_digest_recipients / email_default_to / FIRM_EMAIL all unset) — aborting send');
    return { sent: 0, reason: 'no recipients', window: [fromStr, toStr], event_count: rows.length };
  }

  // ── 6. From-addresses ────────────────────────────────────────────────
  const fromEmail = await taskService.getFromEmail(db);
  const smsFrom   = await taskService.getSmsFrom(db);

  // ── 7. Dispatch (one bad recipient must not abort the rest) ──────────
  let sent = 0;
  for (const rcpt of recipients) {
    if (!rcpt.email) continue;
    try {
      const html = buildEventDigestEmail(rcpt.fname || '', eventsByDate, { windowLabel });
      await emailService.sendEmail(db, {
        from:    fromEmail,
        to:      rcpt.email,
        subject: `Upcoming Events — ${windowLabel}`,
        html,
      });
      sent++;
    } catch (emailErr) {
      console.error(`[EVENT DIGEST] Email failed for ${rcpt.email}:`, emailErr.message);
    }

    if (rcpt.allow_sms && rcpt.phone && smsFrom) {
      try {
        await phoneSvc.sendSms(db, smsFrom, rcpt.phone,
          `${rows.length} upcoming event(s) ${windowLabel}. Log in to YisraCase.`
        );
      } catch (smsErr) {
        console.error(`[EVENT DIGEST] SMS failed for ${rcpt.phone}:`, smsErr.message);
      }
    }
  }

  console.log(`[EVENT DIGEST] Done. Sent: ${sent}, window ${fromStr}..${toStr}, events: ${rows.length}`);
  return { sent, window: [fromStr, toStr], event_count: rows.length };
}


module.exports = {
  createEvent,
  updateEvent,
  completeEvent,
  cancelEvent,
  getEvent,
  listEvents,
  spawnReminderTask,
  cancelReminderTasks,
  // digest support
  getEventsForDigest,
  buildEventDigestEmail,
  sendEventDigest,
  // exported for testing / reuse
  _gcalTimes,
  _normalizeAllDay,
};