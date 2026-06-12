// services/apptService.js
//
/**
 * Appointment Service
 * services/apptService.js
 *
 * All appointment business logic. Routes are thin wrappers that call
 * these functions. Internal functions, sequences, and workflows can
 * also call them directly.
 *
 * Usage:
 *   const apptService = require('../services/apptService');
 *   const result = await apptService.createAppt(db, { ... });
 */

const { getSettings } = require('./settingsService');
const smsService   = require('./phoneService');
const emailService = require('./emailService');
const gcal         = require('./gcalService');
const taskService  = require('./taskService');
const logService   = require('./logService');
const { localToUTC, FIRM_TZ } = require('./timezoneService');
const { DateTime } = require('luxon');
const { alert } = require('../lib/alerting');
const crypto = require('crypto');

// Lazy-require to avoid circular dependency (sequenceEngine → job_executor → internal_functions)
function getSequenceEngine() {
  return require('../lib/sequenceEngine');
}

// ─────────────────────────────────────────────────────────────
// GOOGLE CALENDAR INTEGRATION (native — replaces the Pabbly bridge)
//
// Previously appointment calendar sync went through Pabbly:
//   pabbly.send(db, 'gcal_create' | 'gcal_delete', {...})
// The Zap created/deleted the event and wrote appt_gcal back to the DB
// out-of-band. Going native inverts that: gcalService returns the event
// synchronously and THIS service owns the appt_gcal write. (appt_end is a
// STORED GENERATED column — MySQL computes it from appt_date + appt_length;
// it is never written by app code.)
//
// All calendar work stays fire-and-forget (post-response) — a calendar
// failure must never block or roll back an appointment write, matching the
// prior behavior. On failure we record an alert via lib/alerting; it rides
// the hourly digest with the DB-backed 6h per-group cooldown.
// ─────────────────────────────────────────────────────────────

/**
 * Record a calendar sync failure via lib/alerting. Never throws (alert()
 * swallows internally); fire-and-forget. Replaces the old in-memory 1h
 * email throttle — alert_state's DB-backed 6h per-group cooldown is
 * multi-instance safe, which the per-process Map never was. Behavior
 * change: notification rides the hourly digest instead of an instant
 * IT_EMAIL send.
 */
function alertGcalFailure(db, kind, detail) {
  alert(db, {
    source: 'app',
    kind: `gcal_${kind}_failed`,        // gcal_create_failed | gcal_delete_failed | gcal_create_user_failed | gcal_delete_user_failed
    group_key: `gcal_sync:${kind}`,
    severity: 'error',
    title: `Google Calendar sync failed: ${kind}`,
    message:
      `A Google Calendar operation failed in apptService.\n` +
      `Operation: ${kind}\n` +
      `Detail: ${detail}\n\n` +
      `The appointment record itself is unaffected — only the calendar event ` +
      `did not sync. Check the connection (Connections → Google) and the ` +
      `credential's allowed_urls if this repeats.`,
    context: { operation: kind, detail: String(detail).slice(0, 500) },
  });
}

/**
 * Compute the naive firm-local end-datetime string for an appointment, as
 * 'YYYY-MM-DDTHH:MM:SS' (RFC3339-shaped, no offset — gcalService attaches
 * timeZone: FIRM_TZ). Used ONLY to set the calendar event's end time —
 * the appts.appt_end column is STORED GENERATED and must never be written.
 * appt_date is stored naive-local; we add the length in FIRM_TZ so DST
 * boundaries are handled, then emit the naive local form.
 */
function computeApptEndLocal(apptDateLocal, lengthMinutes) {
  const len = Number(lengthMinutes) || 0;
  // apptDateLocal may be a Date (read by mysql2 as fake-UTC) or a string.
  const base = apptDateLocal instanceof Date
    ? DateTime.fromISO(apptDateLocal.toISOString().slice(0, 19), { zone: FIRM_TZ })
    : DateTime.fromISO(String(apptDateLocal).replace(' ', 'T').slice(0, 19), { zone: FIRM_TZ });
  if (!base.isValid) return null;
  return base.plus({ minutes: len }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Build the calendar event summary/description/location for an appointment.
 * Kept in one place so the event text is easy to tune. Title format:
 *   "<appt_type> — <contact_name>"   (falls back gracefully if either is blank)
 */
function buildApptEventResource({ appt_type, contact_name, appt_platform, case_id, note }) {
  const titleParts = [appt_type, contact_name].filter(Boolean);
  const summary = titleParts.join(' — ') || 'Appointment';

  const descLines = [];
  if (case_id) descLines.push(`Case: ${case_id}`);
  if (note)    descLines.push(note);

  return {
    summary,
    ...(descLines.length && { description: descLines.join('\n') }),
    ...(appt_platform && { location: appt_platform }),
  };
}

/**
 * Resolve a provider's secondary calendar ID from users.user_gcal_id.
 * Returns the trimmed calendar ID string, or null when the user has none
 * (or apptWith is invalid). Trimming matters: the column has been observed
 * to carry trailing newlines from copy-paste, which would 404 every API
 * call after encodeURIComponent.
 */
async function resolveProviderCalendarId(db, apptWith) {
  const n = Number(apptWith);
  if (!Number.isInteger(n) || n <= 0) return null;
  const [[row]] = await db.query(
    'SELECT user_gcal_id FROM users WHERE user = ?',
    [n]
  );
  const id = row && row.user_gcal_id ? String(row.user_gcal_id).trim() : '';
  return id || null;
}

/**
 * Create the calendar event(s) for a freshly-created appointment and write
 * the event ID(s) back to the appt row. Fire-and-forget — never throws.
 * Used post-commit in createAppt.
 *
 * Slice 5: double-write. Two independent targets, same oauth2 credential:
 *   1. FIRM calendar (existing binding via gcalService._resolveTarget) —
 *      behavior unchanged, attendee attached, event id → appt_gcal.
 *   2. PROVIDER calendar (users.user_gcal_id for appt_with) — written BARE,
 *      no attendees, so Google can never notify a client from it. Client
 *      confirmations are template/SMS/email driven, never Google invites.
 *      Event id → appt_gcal_user.
 * The provider write is skipped when user_gcal_id is NULL/blank or equals
 * the firm calendar id (duplicate guard). Each write has its own catch +
 * alert kind; one failing never blocks the other. sendUpdates is never
 * passed → gcalService default 'none' on both.
 */
async function syncApptToCalendar(db, { appt_id, appt_date, appt_length, appt_type,
                                        appt_platform, case_id, note, contact_name,
                                        contact_email, appt_with }) {
  // Shared event content (pure functions — but keep the guard anyway so a
  // malformed date can't kill both writes silently without an alert).
  let resource, startLocal, endLocal;
  try {
    endLocal = computeApptEndLocal(appt_date, appt_length);
    resource = buildApptEventResource({ appt_type, contact_name, appt_platform, case_id, note });
    startLocal = typeof appt_date === 'string'
      ? appt_date.replace(' ', 'T').slice(0, 19)
      : appt_date.toISOString().slice(0, 19);       // naive local → FIRM_TZ in service
  } catch (err) {
    console.error(`[APPT SERVICE] GCal create (appt ${appt_id}) — event build failed:`, err.message);
    alertGcalFailure(db, 'create', `appt_id=${appt_id}: event build failed: ${err.message}`);
    return;
  }

  // ── 1) Firm calendar (unchanged behavior, attendee attached) ──
  try {
    const event = await gcal.createEvent(db, {
      ...resource,
      start: startLocal,
      end: endLocal,
      ...(contact_email && { attendees: [contact_email] }),
    });

    // Write back ONLY the event ID. appt_end is a STORED GENERATED column
    // (appt_date + appt_length) — MySQL computes it; writing it throws 3105.
    await db.query(
      'UPDATE appts SET appt_gcal = ? WHERE appt_id = ?',
      [event.id, appt_id]
    );
  } catch (err) {
    console.error(`[APPT SERVICE] GCal create (appt ${appt_id}) failed:`, err.message);
    alertGcalFailure(db, 'create', `appt_id=${appt_id}: ${err.message}`);
  }

  // ── 2) Provider calendar (bare — NO attendees, internal-only) ──
  try {
    const providerCalId = await resolveProviderCalendarId(db, appt_with);
    if (!providerCalId) return;                       // user has no calendar — clean skip

    // Duplicate guard: if the provider's calendar IS the firm calendar,
    // skip — the firm write above already covered it.
    const { calendarId: firmCalId } = await gcal._resolveTarget(db, {});
    if (providerCalId === String(firmCalId).trim()) return;

    const event = await gcal.createEvent(db, {
      ...resource,
      start: startLocal,
      end: endLocal,
      calendarId: providerCalId,
      // deliberately NO attendees / sendUpdates / reminders
    });

    await db.query(
      'UPDATE appts SET appt_gcal_user = ? WHERE appt_id = ?',
      [event.id, appt_id]
    );
  } catch (err) {
    console.error(`[APPT SERVICE] GCal provider create (appt ${appt_id}, with=${appt_with}) failed:`, err.message);
    alertGcalFailure(db, 'create_user', `appt_id=${appt_id} appt_with=${appt_with}: ${err.message}`);
  }
}

/**
 * Delete a firm-calendar event by ID. Fire-and-forget — never throws.
 * Treats Google's 404/410 (already gone) as success.
 */
async function deleteApptCalendarEvent(db, eventId, contextLabel) {
  if (!eventId) return;
  try {
    await gcal.deleteEvent(db, { eventId });
  } catch (err) {
    if (/→\s(404|410):/.test(err.message)) {
      // Already deleted on Google's side — nothing to do.
      console.warn(`[APPT SERVICE] GCal delete (${contextLabel}) — event ${eventId} already gone`);
      return;
    }
    console.error(`[APPT SERVICE] GCal delete (${contextLabel}) failed:`, err.message);
    alertGcalFailure(db, 'delete', `${contextLabel} event=${eventId}: ${err.message}`);
  }
}

/**
 * Delete a provider-calendar event (appts.appt_gcal_user) by ID.
 * Fire-and-forget — never throws. The provider's calendar is re-resolved
 * from users.user_gcal_id at delete time; if the binding was removed since
 * the event was created, the delete can't locate the calendar and alerts
 * (kind gcal_delete_user_failed) so the orphan can be cleaned up manually.
 * Treats Google's 404/410 (already gone) as success.
 */
async function deleteApptProviderCalendarEvent(db, eventId, apptWith, contextLabel) {
  if (!eventId) return;
  try {
    const providerCalId = await resolveProviderCalendarId(db, apptWith);
    if (!providerCalId) {
      throw new Error(`no user_gcal_id for user ${apptWith} — cannot locate provider event`);
    }
    await gcal.deleteEvent(db, { eventId, calendarId: providerCalId });
  } catch (err) {
    if (/→\s(404|410):/.test(err.message)) {
      console.warn(`[APPT SERVICE] GCal provider delete (${contextLabel}) — event ${eventId} already gone`);
      return;
    }
    console.error(`[APPT SERVICE] GCal provider delete (${contextLabel}) failed:`, err.message);
    alertGcalFailure(db, 'delete_user', `${contextLabel} event=${eventId} appt_with=${apptWith}: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Format a DATETIME value (Date or string) as 'YYYY-MM-DD HH:MM:SS'.
 * Matches the format MySQL produces when CONCAT-ing a DATETIME column.
 */
function formatApptDate(dt) {
  if (!dt) return '';
  if (dt instanceof Date) {
    // mysql2 returns DATETIME as Date interpreted as UTC; toISOString preserves
    // the YYYY-MM-DDTHH:MM:SS portion exactly as stored.
    return dt.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(dt);
}

/**
 * Insert a log entry tied to an appointment row.
 *
 * Delegates to logService.createLogEntry for proper JSON.stringify of log_data
 * (avoids escape bugs when notes contain backslashes, newlines, or quotes) and
 * for correct population of log_link_type / log_link_id columns.
 *
 * @param {object} db            - pool or connection (both have .query)
 * @param {number} apptId
 * @param {number} actingUserId
 * @param {object} [extraFields] - additional key/value pairs to merge into log_data.
 *                                 All values are coerced to strings for backward
 *                                 compatibility with existing log_data consumers.
 *                                 Keys with null/undefined values are dropped.
 */
async function insertApptLog(db, apptId, actingUserId, extraFields = {}) {
  // Fetch the appt row — we need type/date/link info for the log payload.
  const [[appt]] = await db.query(
    'SELECT appt_client_id, appt_case_id, appt_type, appt_date FROM appts WHERE appt_id = ?',
    [apptId]
  );
  if (!appt) {
    // Appt was deleted between action and log — nothing sensible to write.
    console.warn(`[APPT SERVICE] insertApptLog: appt ${apptId} not found, skipping log`);
    return;
  }

  // Build base fields (all stringified for backward compat with existing consumers)
  const data = {
    'Appt ID':   String(apptId),
    'Appt Type': appt.appt_type || '',
    'Appt Time': formatApptDate(appt.appt_date),
  };

  // Merge extras, dropping null/undefined and coercing everything else to string
  for (const [key, value] of Object.entries(extraFields)) {
    if (value === null || value === undefined) continue;
    data[key] = String(value);
  }

  // Determine link columns
  const hasCase = appt.appt_case_id && appt.appt_case_id !== '';
  const linkType = hasCase ? 'case' : 'contact';
  const linkId   = hasCase ? appt.appt_case_id : (appt.appt_client_id ?? '');

  await logService.createLogEntry(db, {
    type:      'appt',
    link_type: linkType,
    link_id:   linkId,
    by:        actingUserId,
    data,  // createLogEntry handles JSON.stringify internally
  });
}

/**
 * Cancel all reminder automation tied to an appointment — currently just
 * sequence enrollments scoped to this appt_id (pre_appt, iss_intake, or
 * any future appt-scoped type). Kept as a thin wrapper around
 * cancelByApptId so additional appt-scoped teardown (tasks, scheduled
 * jobs, etc.) can be added here later without re-touching every caller.
 *
 * Non-blocking — automation teardown should never block the status-change
 * that triggered it. Caller passes a reason string that lands in
 * sequence_enrollments.cancel_reason for audit.
 */
async function cancelApptAutomation(db, apptId, reason = 'manual') {
  try {
    const seq = getSequenceEngine();
    seq.cancelByApptId(db, apptId, reason)
      .catch(err => console.error('[APPT SERVICE] Cancel sequences failed:', err.message));
  } catch (err) {
    console.error('[APPT SERVICE] Sequence engine error in cancelApptAutomation:', err.message);
  }
}

/**
 * Fetch an appointment with contact info.
 */
async function fetchApptWithContact(db, apptId) {
  const [[appt]] = await db.query(
    `SELECT appts.*,
            contacts.contact_phone,
            contacts.contact_email AS client_email,
            contacts.contact_name,
            contacts.contact_id
     FROM appts
     LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
     WHERE appts.appt_id = ?`,
    [apptId]
  );
  return appt || null;
}

/**
 * Send appointment confirmation SMS and/or email. Fire-and-forget — never
 * throws; each channel failure is logged and swallowed so a messaging problem
 * never affects the appointment write. Senders come from app_settings
 * (sms_default_from / email_default_from); recipient phone/email are looked up
 * from the contact.
 *
 * Shared by createAppt and cancelAppt so the two paths can't drift. The
 * "message required when a channel is requested" check lives in the calling
 * mutation, which throws BEFORE any state change — so by the time we get here
 * the message is already present (the guard below is just defensive).
 *
 * @param {object}  db
 * @param {object}  opts
 * @param {number}  opts.contactId
 * @param {boolean} opts.sms
 * @param {boolean} opts.email
 * @param {string}  opts.message
 * @param {string}  [opts.subject]  email subject (ignored for SMS)
 */
async function sendApptConfirmation(db, { contactId, sms, email, message, subject }) {
  if (!sms && !email) return;
  if (!message || !message.trim()) return;   // defensive — caller already validated
  try {
    const settings = await getSettings(db, ['sms_default_from', 'email_default_from']);
    const [[contact]] = await db.query(
      'SELECT contact_phone, contact_email FROM contacts WHERE contact_id = ?',
      [contactId]
    );

    if (sms && contact?.contact_phone && settings.sms_default_from) {
      smsService.sendSms(db, settings.sms_default_from, contact.contact_phone, message)
        .catch(err => console.error('[APPT SERVICE] Confirmation SMS failed:', err.message));
    }

    if (email && contact?.contact_email && settings.email_default_from) {
      emailService.sendEmail(db, {
        from:    settings.email_default_from,
        to:      contact.contact_email,
        subject: subject || 'Appointment Confirmation',
        text:    message,
      }).catch(err => console.error('[APPT SERVICE] Confirmation email failed:', err.message));
    }
  } catch (err) {
    console.error('[APPT SERVICE] Confirmation settings/contact lookup failed:', err.message);
  }
}

/**
 * Enroll the appropriate appt-reminder sequences for a new appointment.
 *
 * Enrolls the appt in the pre_appt sequence. The cascade matches the right
 * template by appt_type × appt_with (341 → T19, ISS → ISS template, else the
 * generic fallback). No per-type pre-computation: templates own all timing
 * (341 day-before via before_appt; ISS welcome via open_delay, nags via
 * before_appt). trigger_data carries only IDs + appt_time.
 *
 * Non-blocking — any failure is logged and swallowed.
 */
async function enrollApptReminderSequences(db, {
  appt_id,
  contact_id,
  case_id,
  appt_type,
  appt_with,
  appt_date,
  appt_date_utc,
}) {
  // ── Build trigger_data (frozen at enrollment) ──
  // Generic for every appt type. No per-type pre-computation: the templates
  // own all timing now (341 via before_appt; ISS welcome via open_delay, nags
  // via before_appt). The cascade picks the right pre_appt template by
  // appt_type × appt_with.
  const triggerData = {
    appt_id,
    appt_time:   appt_date_utc.toISOString(),
    appt_type,
    appt_with:   Number(appt_with),
    case_id:     case_id || null,
    enrolled_by: 'createAppt',
  };

  const seq = getSequenceEngine();

  try {
    await seq.enrollContact(db, contact_id, 'pre_appt', triggerData);
    console.log(`[APPT SERVICE] Enrolled appt ${appt_id} in pre_appt sequence`);
  } catch (err) {
    console.error(`[APPT SERVICE] pre_appt enrollment failed for appt ${appt_id}:`, err.message);
  }
}


// ─────────────────────────────────────────────────────────────
// createAppt
// ─────────────────────────────────────────────────────────────

/**
 * Create a new appointment.
 *
 * Immediate side effects (transaction):
 *   - INSERT into appts (with appt_date_utc computed from local appt_date)
 *   - Log entry
 *   - If 341 Meeting: supersede prior 341 (mark Rescheduled) + UPDATE cases.case_341_current
 *
 * Post-commit (non-blocking):
 *   - 341 supersession: cancel old appt's automation + GCal-delete + log
 *   - Cancel active no_show sequences for this contact
 *   - Send confirmation SMS / email if provided
 *   - GCal create (native gcalService — no longer Pabbly)
 *   - Enroll in pre_appt + (if ISS) iss_intake sequences
 *
 * @param {object} db
 * @param {object} opts
 * @returns {{ appt_id, appt, appt_date_utc }}
 */
async function createAppt(db, {
  contact_id,
  case_id         = '',
  appt_length,
  appt_type,
  appt_platform,
  appt_date,
  appt_with       = 1,
  note            = '',
  appt_source     = null,
  confirm_sms     = false,
  confirm_email   = false,
  confirm_message = '',
  actingUserId    = 0
}) {
  // Validation
  if (!contact_id) throw new Error('Missing contact_id');
  if (!appt_date)  throw new Error('Missing appt_date');
  if (!appt_length || isNaN(appt_length) || appt_length <= 0) throw new Error('Invalid appt_length');
  if (!appt_type)     throw new Error('Missing appt_type');
  if (!appt_platform) throw new Error('Missing appt_platform');
  if ((confirm_sms || confirm_email) && (!confirm_message || !confirm_message.trim())) {
    throw new Error('Confirmation message required when sending SMS or email');
  }

  // Compute real UTC from local firm time
  const apptDateUTC = localToUTC(new Date(appt_date));

  // ────────────────────────────────────────────────────────────
  // Atomic core writes (transaction): INSERT appt + log + 341 supersession + pointer.
  // If any of these fail, we don't want the appt to exist.
  // Post-commit side effects (sequences, GCal, etc.) are fire-and-forget.
  // ────────────────────────────────────────────────────────────
  const conn = await db.getConnection();
  let apptId;
  let supersededAppt = null; // { appt_id, appt_gcal, appt_gcal_user, appt_with } for any prior 341 we're replacing
  try {
    await conn.beginTransaction();

    // 1) INSERT appointment — includes both local and UTC times.
    //    appt_manage_token: minted on EVERY insert (char(32) UNIQUE hex).
    //    Unused until the slice-9 client manage page; resolver-visible as a
    //    plain column so templates can later embed /m/{{appts.appt_manage_token}}.
    const manageToken = crypto.randomBytes(16).toString('hex');
    const [result] = await conn.query(
      `INSERT INTO appts
         (appt_client_id, appt_case_id, appt_type, appt_length,
          appt_platform, appt_date, appt_date_utc, appt_status, appt_with,
          appt_note, appt_source, appt_manage_token, appt_create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?, NOW())`,
      [contact_id, case_id, appt_type, appt_length,
       appt_platform, appt_date, apptDateUTC, appt_with, note,
       appt_source, manageToken]
    );
    apptId = result.insertId;

    // 2) Log entry
    const logExtras = { Status: 'Created' };
    if (note) logExtras.Note = note;
    await insertApptLog(conn, apptId, actingUserId, logExtras);

    // 3) 341 Meeting: supersede prior 341 for this case + update case pointer
    if (appt_type === '341 Meeting' && case_id) {
      // 3a) Find the prior 341 (if any) and mark Rescheduled — but only if
      //     it's still 'Scheduled'. rescheduleAppt may have already handled
      //     teardown if it's the caller; in that case the prior is already
      //     Rescheduled and we skip the inner UPDATE + post-commit work.
      const [[prior]] = await conn.query(
        `SELECT a.appt_id, a.appt_gcal, a.appt_gcal_user, a.appt_with, a.appt_status
         FROM cases c
         JOIN appts a ON a.appt_id = c.\`341_appt_id\`
         WHERE c.case_id = ? AND c.\`341_appt_id\` != 0 AND c.\`341_appt_id\` != ?
         LIMIT 1`,
        [case_id, apptId]
      );
      if (prior && prior.appt_status === 'Scheduled') {
        await conn.query(
          `UPDATE appts SET appt_status = 'Rescheduled' WHERE appt_id = ?`,
          [prior.appt_id]
        );
        supersededAppt = {
          appt_id:        prior.appt_id,
          appt_gcal:      prior.appt_gcal,
          appt_gcal_user: prior.appt_gcal_user,
          appt_with:      prior.appt_with,
        };
      }

      // 3b) Point the case at the new 341
      await conn.query(
        'UPDATE cases SET case_341_current = ?, `341_appt_id` = ? WHERE case_id = ?',
        [appt_date, apptId, case_id]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(rbErr =>
      console.error('[APPT SERVICE] Rollback failed:', rbErr.message)
    );
    console.error('[APPT SERVICE] createAppt core writes failed:', err.message);
    throw err;
  } finally {
    conn.release();
  }

  // 3c) Post-commit 341 supersession side effects (non-blocking)
  if (supersededAppt) {
    cancelApptAutomation(db, supersededAppt.appt_id, '341_superseded')
      .catch(err => console.error('[APPT SERVICE] cancelApptAutomation (341 supersession) failed:', err.message));

    if (supersededAppt.appt_gcal) {
      deleteApptCalendarEvent(db, supersededAppt.appt_gcal, '341_superseded');
    }
    if (supersededAppt.appt_gcal_user) {
      deleteApptProviderCalendarEvent(db, supersededAppt.appt_gcal_user, supersededAppt.appt_with, '341_superseded');
    }

    insertApptLog(db, supersededAppt.appt_id, actingUserId, {
      Status:     'Rescheduled',
      'New Appt': apptId,
      Reason:     '341_superseded',
    }).catch(err => console.error('[APPT SERVICE] Supersession log failed:', err.message));
  }

  // 4) Cancel active no_show sequences for this contact (contact-level)
  try {
    const seq = getSequenceEngine();
    await seq.cancelSequences(db, contact_id, 'no_show', 'new_appointment_booked');
  } catch (err) {
    console.error('[APPT SERVICE] Cancel no_show sequences failed:', err.message);
  }

  // 5) Confirmation SMS / email (fire-and-forget via shared helper)
  if (confirm_sms || confirm_email) {
    sendApptConfirmation(db, {
      contactId: contact_id,
      sms:       confirm_sms,
      email:     confirm_email,
      message:   confirm_message,
      subject:   'Appointment Confirmation',
    }).catch(err => console.error('[APPT SERVICE] Confirmation wrapper failed:', err.message));
  }

  // 6) GCal create (native) — fire-and-forget. Fetches contact, creates the
  //    event, writes appt_gcal + appt_end back. Never blocks the response.
  (async () => {
    const [[contactForGcal]] = await db.query(
      'SELECT contact_name, contact_email FROM contacts WHERE contact_id = ?',
      [contact_id]
    );
    await syncApptToCalendar(db, {
      appt_id: apptId, appt_date, appt_length, appt_type, appt_platform,
      case_id, note, appt_with,
      contact_name:  contactForGcal?.contact_name || '',
      contact_email: contactForGcal?.contact_email || '',
    });
  })().catch(err => console.error('[APPT SERVICE] GCal create wrapper failed:', err.message));

  // 7) Reminder automation — enroll in pre_appt + (if ISS) iss_intake sequences
  try {
    await enrollApptReminderSequences(db, {
      appt_id:       apptId,
      contact_id,
      case_id,
      appt_type,
      appt_with,
      appt_date,
      appt_date_utc: apptDateUTC,
    });
  } catch (err) {
    console.error('[APPT SERVICE] Reminder automation failed:', err.message);
  }

  // 8) Re-fetch the created appointment
  const [[appt]] = await db.query('SELECT * FROM appts WHERE appt_id = ?', [apptId]);

  return {
    appt_id: apptId,
    appt,
    appt_date_utc: apptDateUTC,
  };
}


// ─────────────────────────────────────────────────────────────
// markAttended
// ─────────────────────────────────────────────────────────────

/**
 * Mark an appointment as Attended.
 *
 * Side effects:
 *   - Cancel appt-scoped automation (workflow + pre_appt/iss_intake)
 *   - Cancel contact-level no_show sequences
 *   - Log entry
 */
async function markAttended(db, { appt_id, note = '', actingUserId = 0 }) {
  if (!appt_id) throw new Error('markAttended requires appt_id');

  const [[appt]] = await db.query(
    'SELECT appt_id, appt_client_id, appt_status FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');
  if (appt.appt_status === 'Attended') {
    throw new Error('Appointment is already marked Attended');
  }

  // Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'Attended',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // Log (include From when this is a correction from a non-Scheduled state)
  const logExtras = { Status: 'Attended' };
  if (appt.appt_status !== 'Scheduled') logExtras.From = appt.appt_status;
  if (note) logExtras.Note = note;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  // Cancel appt-scoped automation (workflow + pre_appt/iss_intake sequences)
  cancelApptAutomation(db, appt_id, 'appointment_attended')
    .catch(err => console.error('[APPT SERVICE] cancelApptAutomation failed:', err.message));

  // Cancel contact-level no_show sequences (separate scope from cancelByApptId)
  try {
    const seq = getSequenceEngine();
    seq.cancelSequences(db, appt.appt_client_id, 'no_show', 'appointment_attended')
      .catch(err => console.error('[APPT SERVICE] Cancel no_show sequences failed:', err.message));
  } catch (err) {
    console.error('[APPT SERVICE] Sequence engine error:', err.message);
  }

  return { appt_id };
}


// ─────────────────────────────────────────────────────────────
// markNoShow
// ─────────────────────────────────────────────────────────────

/**
 * Mark an appointment as No Show.
 *
 * Side effects:
 *   - Cancel appt-scoped automation (workflow + pre_appt/iss_intake)
 *   - If enroll=true and first no-show for contact: enroll in no_show sequence
 *   - Log entry
 */
async function markNoShow(db, { appt_id, note = '', enroll = false, actingUserId = 0 }) {
  if (!appt_id) throw new Error('markNoShow requires appt_id');

  // SELECT extended: pull contact_phone for pre-check, JOIN cases for case_type.
  // Without case_type in trigger_data, future case_type-filtered no_show
  // templates would never qualify (sequenceEngine disqualifies specific filters
  // when the trigger field is undefined).
  const [[appt]] = await db.query(
    `SELECT a.appt_id, a.appt_client_id, a.appt_case_id, a.appt_date,
            a.appt_type, a.appt_with, a.appt_status,
            c.contact_phone,
            cs.case_type,
            cs.case_subtype
     FROM appts a
     LEFT JOIN contacts c ON c.contact_id = a.appt_client_id
     LEFT JOIN cases    cs ON cs.case_id  = a.appt_case_id
     WHERE a.appt_id = ?`,
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');
  if (appt.appt_status === 'No Show') {
    throw new Error('Appointment is already marked No Show');
  }

  const priorStatus = appt.appt_status;

  await db.query(
    `UPDATE appts
     SET appt_status = 'No Show',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // Cancel appt-scoped automation (workflow + pre_appt/iss_intake sequences).
  // The new no_show enrollment below is a separate, contact-level concern.
  cancelApptAutomation(db, appt_id, 'appointment_no_show')
    .catch(err => console.error('[APPT SERVICE] cancelApptAutomation failed:', err.message));

  // Sequence enrollment
  let enrolled = false;
  let skipReason = null;
  if (enroll) {
    // Pre-check: contact must have a phone number. The no_show sequences are
    // SMS-only; without a phone, the sequence would either silent-fail every
    // step or close the case after zero outreach. Fail loud at enrollment.
    if (!appt.contact_phone || !String(appt.contact_phone).trim()) {
      skipReason = 'no_phone';
    } else {
      const [[{ activeEnrollments }]] = await db.query(
        `SELECT COUNT(*) AS activeEnrollments
        FROM sequence_enrollments se
        JOIN sequence_templates st ON se.template_id = st.id
        WHERE se.contact_id = ?
        AND se.status = 'active'
        AND st.type = 'no_show'`,
        [appt.appt_client_id]
      );
      if (activeEnrollments === 0) {
        try {
          const seq = getSequenceEngine();
          await seq.enrollContact(db, appt.appt_client_id, 'no_show', {
            appt_id:     appt_id,
            appt_time:   appt.appt_date,
            case_id:     appt.appt_case_id,
            appt_type:   appt.appt_type,
            appt_with:   appt.appt_with,
            case_type:    appt.case_type,
            case_subtype: appt.case_subtype,
            enrolled_by: 'no_show_handler'
          });
          enrolled = true;
        } catch (err) {
          console.error('[APPT SERVICE] Sequence enroll failed:', err.message);
        }
      } else {
        skipReason = 'active_enrollment';
      }
    }
  }

  // Log
  const logExtras = { Status: 'No Show', Enrolled: String(enrolled) };
  if (priorStatus !== 'Scheduled') logExtras.From = priorStatus;
  if (note) logExtras.Note = note;
  if (skipReason) logExtras.SkipReason = skipReason;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  return { appt_id, enrolled, skipReason };
}


// ─────────────────────────────────────────────────────────────
// cancelAppt
// ─────────────────────────────────────────────────────────────

/**
 * Cancel an appointment.
 *
 * Side effects:
 *   - Cancel appt-scoped automation (workflow + pre_appt/iss_intake)
 *   - Cancel contact-level no_show sequences
 *   - Optional: follow-up task, SMS/email confirmation, GCal delete
 */
async function cancelAppt(db, {
  appt_id,
  note            = '',
  sms             = false,
  email           = false,
  confirm_message = '',
  cancel_gcal     = true,
  create_task     = false,
  actingUserId    = 0
}) {
  if (!appt_id) throw new Error('cancelAppt requires appt_id');
  if ((sms || email) && !confirm_message.trim()) {
    throw new Error('Confirmation message required when sending SMS or email');
  }

  const appt = await fetchApptWithContact(db, appt_id);
  if (!appt) throw new Error('Appointment not found');
  if (appt.appt_status === 'Canceled') {
    throw new Error('Appointment is already Canceled');
  }

  // Capture prior status for the log's From field
  const priorStatus = appt.appt_status;

  // 1) Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'Canceled',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // 2) Cancel appt-scoped automation (workflow + pre_appt/iss_intake)
  cancelApptAutomation(db, appt_id, 'appointment_cancelled')
    .catch(err => console.error('[APPT SERVICE] cancelApptAutomation failed:', err.message));

  // 3) Cancel contact-level no_show sequences
  try {
    const seq = getSequenceEngine();
    seq.cancelSequences(db, appt.appt_client_id, 'no_show', 'appointment_cancelled')
      .catch(err => console.error('[APPT SERVICE] Cancel no_show sequences failed:', err.message));
  } catch (err) {
    console.error('[APPT SERVICE] Sequence engine error:', err.message);
  }

  // 4) Optional: follow-up task
  let taskId = null;
  if (create_task) {
    try {
      const result = await taskService.createTask(db, {
        from:      actingUserId,
        to:        actingUserId,
        title:     'Appointment Cancellation Follow-up',
        link_type: 'contact',
        link_id:   appt.appt_client_id
      });
      taskId = result.task_id;
    } catch (err) {
      console.error('[APPT SERVICE] Create task failed:', err.message);
    }
  }

  // 5) Log entry
  const logExtras = { Status: 'Canceled' };
  if (priorStatus !== 'Scheduled') logExtras.From = priorStatus;
  if (taskId) logExtras.Task = taskId;
  if (note)   logExtras.Note = note;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  // 6) Return result (before non-blocking side effects)
  const result = { appt_id, taskId };

  // ---- Non-blocking side effects below ----

  // 7) Confirmation SMS / email (fire-and-forget via shared helper)
  if (sms || email) {
    sendApptConfirmation(db, {
      contactId: appt.appt_client_id,
      sms,
      email,
      message:   confirm_message,
      subject:   'Appointment Cancellation Confirmation',
    }).catch(err => console.error('[APPT SERVICE] Confirmation wrapper failed:', err.message));
  }

  // 8) GCal delete
  if (cancel_gcal && appt.appt_gcal) {
    deleteApptCalendarEvent(db, appt.appt_gcal, 'cancel');
  }
  if (cancel_gcal && appt.appt_gcal_user) {
    deleteApptProviderCalendarEvent(db, appt.appt_gcal_user, appt.appt_with, 'cancel');
  }

  // TODO: Cancel sequence enrollment — not yet designed.
  // When a 'cancel' sequence template exists, wire it here:
  //   if (enroll_sequence) { seq.enrollContact(db, appt.appt_client_id, 'cancel', { ... }) }

  return result;
}


// ─────────────────────────────────────────────────────────────
// rescheduleAppt
// ─────────────────────────────────────────────────────────────

/**
 * Reschedule an appointment (now — with a new date).
 *
 * Side effects:
 *   - Mark old appt as 'Rescheduled'
 *   - Cancel old appt's automation (workflow + pre_appt/iss_intake)
 *   - Create new appt (calls createAppt, which enrolls fresh sequences)
 *   - Log on old appt
 */
async function rescheduleAppt(db, {
  appt_id,
  newDate,
  note            = '',
  sms             = false,
  email           = false,
  confirm_message = '',
  actingUserId    = 0
}) {
  if (!appt_id) throw new Error('rescheduleAppt requires appt_id');
  if (!newDate)  throw new Error('rescheduleAppt requires newDate');
  if ((sms || email) && (!confirm_message || !confirm_message.trim())) {
    throw new Error('Confirmation message required when sending SMS or email');
  }

  // 1) Fetch old appointment
  const [[oldAppt]] = await db.query('SELECT * FROM appts WHERE appt_id = ?', [appt_id]);
  if (!oldAppt) throw new Error('Original appointment not found');

  // 2) Mark old as Rescheduled
  await db.query(
    `UPDATE appts
     SET appt_status = 'Rescheduled',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // 3) Cancel old appt's automation (workflow + pre_appt/iss_intake sequences).
  //    Non-blocking — createAppt below proceeds regardless.
  cancelApptAutomation(db, appt_id, 'appointment_rescheduled')
    .catch(err => console.error('[APPT SERVICE] cancelApptAutomation (reschedule) failed:', err.message));

  // 3b) GCal delete for old appt (non-blocking)
  if (oldAppt.appt_gcal) {
    deleteApptCalendarEvent(db, oldAppt.appt_gcal, 'reschedule');
  }
  if (oldAppt.appt_gcal_user) {
    deleteApptProviderCalendarEvent(db, oldAppt.appt_gcal_user, oldAppt.appt_with, 'reschedule');
  }

  // 4) Create new appointment (handles enrollments, GCal, etc.)
  const newAppt = await createAppt(db, {
    contact_id:      oldAppt.appt_client_id,
    case_id:         oldAppt.appt_case_id,
    appt_length:     oldAppt.appt_length,
    appt_type:       oldAppt.appt_type,
    appt_platform:   oldAppt.appt_platform,
    appt_date:       newDate,
    appt_with:       oldAppt.appt_with,
    note,
    confirm_sms:     sms,
    confirm_email:   email,
    confirm_message: (sms || email) ? confirm_message : '',
    actingUserId
  });

  // 5) Log on old appointment
  const logExtras = {
    Status:     'Rescheduled',
    'New Appt': newAppt.appt_id,
    'New Time': newDate,
  };
  if (note) logExtras.Note = note;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  return { old_appt_id: appt_id, new_appt_id: newAppt.appt_id };
}


// ─────────────────────────────────────────────────────────────
// rescheduleLater
// ─────────────────────────────────────────────────────────────

/**
 * Mark as Rescheduled without creating a new appointment.
 * Optionally creates a follow-up task.
 *
 * Side effects:
 *   - Cancel appt-scoped automation (workflow + pre_appt/iss_intake)
 *   - Optional follow-up task
 *   - Log entry
 *
 * TODO: May also enroll in a reschedule follow-up workflow or sequence
 *       once that template is designed.
 */
async function rescheduleLater(db, {
  appt_id,
  note         = '',
  create_task  = false,
  actingUserId = 0
}) {
  if (!appt_id) throw new Error('rescheduleLater requires appt_id');

  const [[appt]] = await db.query(
    'SELECT appt_id, appt_client_id, appt_gcal, appt_gcal_user, appt_with FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');

  // 1) Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'Rescheduled',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // 2) Cancel appt-scoped automation
  cancelApptAutomation(db, appt_id, 'appointment_rescheduled_later')
    .catch(err => console.error('[APPT SERVICE] cancelApptAutomation (rescheduleLater) failed:', err.message));

  // 2b) GCal delete (non-blocking)
  if (appt.appt_gcal) {
    deleteApptCalendarEvent(db, appt.appt_gcal, 'rescheduleLater');
  }
  if (appt.appt_gcal_user) {
    deleteApptProviderCalendarEvent(db, appt.appt_gcal_user, appt.appt_with, 'rescheduleLater');
  }

  // 3) Optional task
  let taskId = null;
  if (create_task) {
    try {
      const result = await taskService.createTask(db, {
        from:      actingUserId,
        to:        actingUserId,      // TODO: use default_task_assignee from app_settings
        title:     'Appointment Reschedule Follow-up',
        desc:      'This appointment was marked rescheduled without scheduling another appointment.',
        link_type: 'contact',
        link_id:   appt.appt_client_id
      });
      taskId = result.task_id;
    } catch (err) {
      console.error('[APPT SERVICE] Create task failed:', err.message);
    }
  }

  // 4) Log
  const logExtras = { Status: 'Rescheduled' };
  if (taskId) logExtras.Task = taskId;
  if (note)   logExtras.Note = note;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  return { appt_id, taskId };
}


module.exports = {
  createAppt,
  markAttended,
  markNoShow,
  cancelAppt,
  rescheduleAppt,
  rescheduleLater,
  cancelApptAutomation,
  insertApptLog,
  fetchApptWithContact
};