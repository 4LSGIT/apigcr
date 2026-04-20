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

const { getSetting, getSettings } = require('./settingsService');
const smsService   = require('./smsService');
const emailService = require('./emailService');
const pabbly       = require('./pabblyService');
const taskService  = require('./taskService');
const logService   = require('./logService');
const { localToUTC, FIRM_TZ } = require('./timezoneService');
const { DateTime } = require('luxon');
const { advanceWorkflow } = require('../lib/workflow_engine');
const calendar = require('./calendarService');

// Lazy-require to avoid circular dependency (sequenceEngine → job_executor → internal_functions)
function getSequenceEngine() {
  return require('../lib/sequenceEngine');
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
 * Cancel the reminder workflow for an appointment.
 * Called by every status-change function.
 */
async function cancelApptWorkflow(db, apptId) {
  const [[appt]] = await db.query(
    'SELECT appt_workflow_execution_id FROM appts WHERE appt_id = ?',
    [apptId]
  );
  if (!appt?.appt_workflow_execution_id) return;

  const execId = appt.appt_workflow_execution_id;

  await db.query(
    `UPDATE workflow_executions
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = ? AND status IN ('active', 'delayed', 'processing')`,
    [execId]
  );

  await db.query(
    `UPDATE scheduled_jobs
     SET status = 'failed', updated_at = NOW()
     WHERE workflow_execution_id = ? AND status = 'pending'`,
    [execId]
  );

  console.log(`[APPT SERVICE] Cancelled reminder workflow execution ${execId} for appt ${apptId}`);
}

/**
 * Determine the case_tab for a given appointment type.
 */
function determineCaseTab(apptType) {
  if (!apptType) return '';
  if (apptType === '341 Meeting') return '341';
  if (apptType === 'Initial Strategy Session') return 'ISSN';
  return '';
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


// ─────────────────────────────────────────────────────────────
// createAppt
// ─────────────────────────────────────────────────────────────

/**
 * Create a new appointment.
 *
 * Immediate side effects:
 *   - INSERT into appts (with appt_date_utc computed from local appt_date)
 *   - Log entry
 *   - If 341 Meeting: UPDATE cases.case_341_current
 *   - Cancel active no_show sequences for this contact
 *   - Send confirmation SMS if provided
 *   - GCal create via Pabbly (fire-and-forget)
 *   - Start reminder workflow → store execution_id on appt row (TODO: Phase 3)
 *
 * @param {object} db
 * @param {object} opts
 * @returns {{ appt_id, appt, appt_date_utc, workflow_execution_id }}
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

  // Compute real UTC from local firm time
  const apptDateUTC = localToUTC(new Date(appt_date));

  // ────────────────────────────────────────────────────────────
  // Atomic core writes (transaction): INSERT appt + log + 341 pointer
  // If any of these fail, we don't want the appt to exist.
  // Everything after this runs on the pool and is fire-and-forget.
  // ────────────────────────────────────────────────────────────
  const conn = await db.getConnection();
  let apptId;
  try {
    await conn.beginTransaction();

    // 1) INSERT appointment — includes both local and UTC times
    const [result] = await conn.query(
      `INSERT INTO appts
         (appt_client_id, appt_case_id, appt_type, appt_length,
          appt_platform, appt_date, appt_date_utc, appt_status, appt_with,
          appt_note, appt_create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, NOW())`,
      [contact_id, case_id, appt_type, appt_length,
       appt_platform, appt_date, apptDateUTC, appt_with, note]
    );
    apptId = result.insertId;

    // 2) Log entry
    const logExtras = { Status: 'Created' };
    if (note) logExtras.Note = note;
    await insertApptLog(conn, apptId, actingUserId, logExtras);

    // 3) If 341 Meeting, update case pointer — MUST succeed or we roll back
    if (appt_type === '341 Meeting' && case_id) {
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

  // 4) Cancel active no_show sequences for this contact
  try {
    const seq = getSequenceEngine();
    await seq.cancelSequences(db, contact_id, 'no_show', 'new_appointment_booked');
  } catch (err) {
    console.error('[APPT SERVICE] Cancel no_show sequences failed:', err.message);
  }

  // 5) Confirmation SMS / email (fully non-blocking — consistent with cancelAppt)
  if ((confirm_sms || confirm_email) && confirm_message && confirm_message.trim()) {
    (async () => {
      try {
        const settings = await getSettings(db, ['sms_default_from', 'email_default_from']);
        const [[contact]] = await db.query(
          'SELECT contact_phone, contact_email FROM contacts WHERE contact_id = ?',
          [contact_id]
        );

        if (confirm_sms && contact?.contact_phone && settings.sms_default_from) {
          smsService.sendSms(db, settings.sms_default_from, contact.contact_phone, confirm_message)
            .catch(err => console.error('[APPT SERVICE] Confirm SMS failed:', err.message));
        }

        if (confirm_email && contact?.contact_email && settings.email_default_from) {
          emailService.sendEmail(db, {
            from:    settings.email_default_from,
            to:      contact.contact_email,
            subject: 'Appointment Confirmation',
            text:    confirm_message
          }).catch(err => console.error('[APPT SERVICE] Confirm email failed:', err.message));
        }
      } catch (err) {
        console.error('[APPT SERVICE] Confirm SMS/email settings lookup failed:', err.message);
      }
    })();
  }

  // 6) GCal create via Pabbly (fire-and-forget)
  const [[contactForGcal]] = await db.query(
    'SELECT contact_name, contact_email FROM contacts WHERE contact_id = ?',
    [contact_id]
  );
  pabbly.send(db, 'gcal_create', {
    appt_id: apptId, appt_date, appt_length, appt_type,
    appt_platform,
    contact_name:  contactForGcal?.contact_name || '',
    contact_email: contactForGcal?.contact_email || '',
    case_id
  });

  // 7) Start reminder workflow
  let workflowExecutionId = null;
  try {
    const wfId = await getSetting(db, 'appt_reminder_workflow_id');
    if (wfId) {
      // Build display strings in firm timezone from the local appt_date
      // (appt_date is firm-local stored as fake UTC by mysql2)
      const apptLocal = DateTime.fromISO(
        new Date(appt_date).toISOString().slice(0, 19),
        { zone: FIRM_TZ }
      );
 
      // Pre-compute resume timestamps from real UTC
      // Any timestamp already in the past → null (schedule_resume will skip)
      const now = Date.now();
      const utcMs = apptDateUTC.getTime();
 
      // 341: day before at 6 PM firm time
      let resume_day_before = null;
      if (appt_type === '341 Meeting') {
        const dayBefore = apptLocal.minus({ days: 1 }).set({ hour: 18, minute: 0, second: 0 });
        const dayBeforeUTC = dayBefore.toUTC().toJSDate();
        resume_day_before = dayBeforeUTC.getTime() > now ? dayBeforeUTC.toISOString() : null;
      }
 
      // Non-341: 24h before using prevBusinessDay for business-day awareness
      let resume_24h = null;
      if (appt_type !== '341 Meeting') {
        try {
          const prevBiz = await calendar.prevBusinessDay(apptDateUTC, [
            { hoursBack: 24, timeOfDay: '10:00', minHoursBefore: 4 }
          ], { minHoursBefore: 4 });
          if (prevBiz?.scheduledAt && prevBiz.scheduledAt.getTime() > now) {
            resume_24h = prevBiz.scheduledAt.toISOString();
          }
        } catch (err) {
          console.error('[APPT SERVICE] prevBusinessDay failed:', err.message);
        }
      }
 
      // Simple offsets from real UTC
      const resume_2h  = (utcMs - 2 * 3600000)  > now ? new Date(utcMs - 2 * 3600000).toISOString()  : null;
      const resume_10m = (utcMs - 10 * 60000)    > now ? new Date(utcMs - 10 * 60000).toISOString()   : null;
      const resume_3m  = (utcMs - 3 * 60000)     > now ? new Date(utcMs - 3 * 60000).toISOString()    : null;
 
// Start the workflow
      const initData = {
        appt_id:           apptId,
        appt_type,
        appt_platform,
        case_id:           case_id || '',
        case_tab:          determineCaseTab(appt_type),
        appt_with,
        // Slice 4.3 Part B — surface contact_id in init_data so workflow
        // steps can reference {{contact_id}} directly, AND so the template
        // default mechanism (workflows.default_contact_id_from = 'contact_id')
        // works for any future non-appt caller that routes through
        // POST /workflows/:id/start. This path (apptService direct INSERT)
        // populates the column explicitly in the INSERT below, so it doesn't
        // depend on the default mechanism — both paths now produce the same
        // wiring.
        contact_id,
        sms_staff_from:    await getSetting(db, 'sms_staff_from') || '2486213656',
        sms_client_from:   await getSetting(db, 'sms_default_from') || '2485592400',
        // Display strings (pre-formatted, frozen at creation time)
        appt_time_display: apptLocal.toFormat('h:mm a'),       // "2:30 PM"
        appt_day_name:     apptLocal.toFormat('cccc'),          // "Wednesday"
        appt_date_display: apptLocal.toFormat('LLL. d'),        // "Mar. 19"
        // Resume timestamps (real UTC, null if already past)
        resume_day_before,
        resume_24h,
        resume_2h,
        resume_10m,
        resume_3m,
      };
 
      // Create execution row. Populates the new contact_id column directly
      // — this path bypasses POST /workflows/:id/start (and therefore the
      // shared resolveExecutionContactId helper), but the caller always
      // knows contact_id at this point, so using it directly is simpler
      // and doesn't require re-reading the workflows row.
      const [execResult] = await db.query(
        `INSERT INTO workflow_executions
           (workflow_id, contact_id, status, init_data, variables, current_step_number)
         VALUES (?, ?, 'active', ?, ?, 1)`,
        [parseInt(wfId), contact_id, JSON.stringify(initData), JSON.stringify(initData)]
      );
      workflowExecutionId = execResult.insertId;
 
      // Store execution ID on the appointment
      await db.query(
        'UPDATE appts SET appt_workflow_execution_id = ? WHERE appt_id = ?',
        [workflowExecutionId, apptId]
      );
 
      // Advance in background (non-blocking)
      advanceWorkflow(workflowExecutionId, db)
        .then(r => console.log(`[APPT SERVICE] Reminder workflow ${workflowExecutionId} started: ${r.status}`))
        .catch(err => console.error(`[APPT SERVICE] Reminder workflow failed:`, err.message));
 
      console.log(`[APPT SERVICE] Started reminder workflow ${workflowExecutionId} for appt ${apptId} (${appt_type})`);
    } else {
      console.log('[APPT SERVICE] appt_reminder_workflow_id not set in app_settings — skipping workflow');
    }
  } catch (err) {
    // Workflow failure should never block appointment creation
    console.error('[APPT SERVICE] Failed to start reminder workflow:', err.message);
  }


  // 8) Re-fetch the created appointment
  const [[appt]] = await db.query('SELECT * FROM appts WHERE appt_id = ?', [apptId]);

  return {
    appt_id: apptId,
    appt,
    appt_date_utc: apptDateUTC,
    workflow_execution_id: workflowExecutionId
  };
}


// ─────────────────────────────────────────────────────────────
// markAttended
// ─────────────────────────────────────────────────────────────

/**
 * Mark an appointment as Attended.
 *
 * Side effects:
 *   - Cancel reminder workflow
 *   - Cancel active no_show sequences for this contact
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

  // Cancel reminder workflow (non-blocking)
  cancelApptWorkflow(db, appt_id)
    .catch(err => console.error('[APPT SERVICE] Cancel workflow failed:', err.message));

  // Cancel no_show sequences (non-blocking)
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
 *   - Cancel reminder workflow
 *   - If enroll=true and first no-show for contact: enroll in no_show sequence
 *   - Log entry
 */
async function markNoShow(db, { appt_id, note = '', enroll = false, actingUserId = 0 }) {
  if (!appt_id) throw new Error('markNoShow requires appt_id');

  const [[appt]] = await db.query(
    'SELECT appt_id, appt_client_id, appt_case_id, appt_date, appt_type, appt_with, appt_status FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');
  if (appt.appt_status === 'No Show') {
    throw new Error('Appointment is already marked No Show');
  }

  // Capture prior status before we flip it — used for the log's From field
  const priorStatus = appt.appt_status;

  // Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'No Show',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // Cancel reminder workflow (non-blocking)
  cancelApptWorkflow(db, appt_id)
    .catch(err => console.error('[APPT SERVICE] Cancel workflow failed:', err.message));

  // Sequence enrollment
  let enrolled = false;
  if (enroll) {
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
          enrolled_by: 'no_show_handler'
        }, {
          appt_type: appt.appt_type,
          appt_with: appt.appt_with
        });
        enrolled = true;
      } catch (err) {
        console.error('[APPT SERVICE] Sequence enroll failed:', err.message);
      }
    }
  }

  // Log
  const logExtras = { Status: 'No Show', Enrolled: String(enrolled) };
  if (priorStatus !== 'Scheduled') logExtras.From = priorStatus;
  if (note) logExtras.Note = note;
  await insertApptLog(db, appt_id, actingUserId, logExtras);

  return { appt_id, enrolled };
}


// ─────────────────────────────────────────────────────────────
// cancelAppt
// ─────────────────────────────────────────────────────────────

/**
 * Cancel an appointment.
 *
 * Side effects:
 *   - Cancel reminder workflow
 *   - Cancel no_show sequences for contact
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

  // 2) Cancel reminder workflow
  cancelApptWorkflow(db, appt_id)
    .catch(err => console.error('[APPT SERVICE] Cancel workflow failed:', err.message));

  // 3) Cancel no_show sequences
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

  // 7) SMS confirmation — outer .catch guards against unhandled rejection
  //    if getSetting itself throws (e.g., DB error on app_settings).
  if (sms && appt.contact_phone) {
    getSetting(db, 'sms_default_from')
      .then(fromNumber => {
        if (fromNumber) {
          smsService.sendSms(db, fromNumber, appt.contact_phone, confirm_message)
            .catch(err => console.error('[APPT SERVICE] Cancel SMS failed:', err.message));
        }
      })
      .catch(err => console.error('[APPT SERVICE] Cancel SMS settings lookup failed:', err.message));
  }

  // 8) Email confirmation
  if (email && appt.client_email) {
    getSetting(db, 'email_default_from')
      .then(fromEmail => {
        if (fromEmail) {
          emailService.sendEmail(db, {
            from:    fromEmail,
            to:      appt.client_email,
            subject: 'Appointment Cancellation Confirmation',
            text:    confirm_message
          }).catch(err => console.error('[APPT SERVICE] Cancel email failed:', err.message));
        }
      })
      .catch(err => console.error('[APPT SERVICE] Cancel email settings lookup failed:', err.message));
  }

  // 9) GCal delete
  console.log(cancel_gcal);
  console.log(appt.appt_gcal);
  if (cancel_gcal && appt.appt_gcal) {
    console.log("sending gcal_delete");
    pabbly.send(db, 'gcal_delete', { appt_gcal: appt.appt_gcal, appt_id });
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
 *   - Cancel old appt's reminder workflow
 *   - Create new appt (calls createAppt, which starts a new workflow)
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

  // 1) Fetch old appointment
  const [[oldAppt]] = await db.query('SELECT * FROM appts WHERE appt_id = ?', [appt_id]);
  if (!oldAppt) throw new Error('Original appointment not found');

  // 2) Mark old as Rescheduled
  await db.query(
    `UPDATE appts
     SET appt_status = 'Rescheduled',
         appt_note   = CONCAT(COALESCE(appt_note,''), ' ', ?)
     WHERE appt_id = ?`,
    [note, appt_id]
  );

  // 3) Cancel old reminder workflow
  await cancelApptWorkflow(db, appt_id);

  // 3b) GCal delete for old appt (non-blocking)
  if (oldAppt.appt_gcal) {
    pabbly.send(db, 'gcal_delete', { appt_gcal: oldAppt.appt_gcal, appt_id })
      .catch(err => console.error('[APPT SERVICE] GCal delete (reschedule) failed:', err.message));
  }

  // 4) Create new appointment (handles workflow, GCal, sequences, etc.)
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
 *   - Cancel reminder workflow
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
    'SELECT appt_id, appt_client_id, appt_gcal FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');

  // 1) Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'Rescheduled',
         appt_note   = CONCAT(COALESCE(appt_note,''), ' ', ?)
     WHERE appt_id = ?`,
    [note, appt_id]
  );

  // 2) Cancel reminder workflow
  await cancelApptWorkflow(db, appt_id);

  // 2b) GCal delete (non-blocking)
  if (appt.appt_gcal) {
    pabbly.send(db, 'gcal_delete', { appt_gcal: appt.appt_gcal, appt_id })
      .catch(err => console.error('[APPT SERVICE] GCal delete (rescheduleLater) failed:', err.message));
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
  cancelApptWorkflow,
  insertApptLog,
  determineCaseTab,
  fetchApptWithContact
};