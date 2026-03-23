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
const { localToUTC }              = require('./timezoneService');
const smsService   = require('./smsService');
const emailService = require('./emailService');
const pabbly       = require('./pabblyService');
const taskService  = require('./taskService');

// Lazy-require to avoid circular dependency (sequenceEngine → job_executor → internal_functions)
function getSequenceEngine() {
  return require('../lib/sequenceEngine');
}


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Insert a log entry tied to an appointment row.
 * Builds log_data as JSON in SQL from the appt row itself.
 */
async function insertApptLog(db, apptId, actingUserId, extraJson) {
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     SELECT
       'appt',
       CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
       CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != ''
            THEN appt_case_id
            ELSE appt_client_id
       END,
       ?,
       CONCAT(
         '{',
           '"Appt ID":"', appt_id, '",',
           '"Appt Type":"', REPLACE(IFNULL(appt_type,''), '"', '\\\\"'), '",',
           '"Appt Time":"', appt_date, '",',
           ?
         '}'
       )
     FROM appts
     WHERE appt_id = ?`,
    [actingUserId, extraJson, apptId]
  );
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

  // 1) INSERT appointment — includes both local and UTC times
  const [result] = await db.query(
    `INSERT INTO appts
       (appt_client_id, appt_case_id, appt_type, appt_length,
        appt_platform, appt_date, appt_date_utc, appt_status, appt_with,
        appt_note, appt_create_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, NOW())`,
    [contact_id, case_id, appt_type, appt_length,
     appt_platform, appt_date, apptDateUTC, appt_with, note]
  );
  const apptId = result.insertId;

  // 2) Log entry
  await insertApptLog(db, apptId, actingUserId,
    `"Status":"Created"${note ? `,"Note":"${note.replace(/"/g, '\\"')}"` : ''}`
  );

  // 3) If 341 Meeting, update case
  if (appt_type === '341 Meeting' && case_id) {
    await db.query(
      'UPDATE cases SET case_341_current = ? WHERE case_id = ?',
      [appt_date, case_id]
    ).catch(err => console.error('[APPT SERVICE] 341 case update failed:', err.message));
  }

  // 4) Cancel active no_show sequences for this contact
  try {
    const seq = getSequenceEngine();
    await seq.cancelSequences(db, contact_id, 'no_show', 'new_appointment_booked');
  } catch (err) {
    console.error('[APPT SERVICE] Cancel no_show sequences failed:', err.message);
  }

  // 5) Confirmation SMS (immediate, if provided)
  if (confirm_message && confirm_message.trim()) {
    const settings = await getSettings(db, ['sms_default_from', 'email_default_from']);

    const [[contact]] = await db.query(
      'SELECT contact_phone, contact_email FROM contacts WHERE contact_id = ?',
      [contact_id]
    );

    if (contact?.contact_phone && settings.sms_default_from) {
      smsService.sendSms(db, settings.sms_default_from, contact.contact_phone, confirm_message)
        .catch(err => console.error('[APPT SERVICE] Confirm SMS failed:', err.message));
    }
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
  //    TODO: Wire in Phase 3 once the reminder workflow template exists.
  //
  //    IMPORTANT — Past-timestamp safety:
  //    When computing resume timestamps from apptDateUTC, any timestamp
  //    that falls in the past should be set to null. Workflow steps should
  //    check for null and skip the corresponding reminder block.
  //
  //    Example of what the Phase 3 code will look like:
  //
  //    const now = Date.now();
  //    const resume_3m  = apptDateUTC - 3*60*1000  > now ? new Date(apptDateUTC - 3*60*1000)  : null;
  //    const resume_10m = apptDateUTC - 10*60*1000 > now ? new Date(apptDateUTC - 10*60*1000) : null;
  //    const resume_2h  = apptDateUTC - 2*3600000  > now ? new Date(apptDateUTC - 2*3600000)  : null;
  //    // resume_24h uses prevBusinessDay — also null if in the past
  //
  let workflowExecutionId = null;
  console.log(`[APPT SERVICE] TODO: Start reminder workflow for appt ${apptId}`);

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
    'SELECT appt_id, appt_client_id FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');

  // Update status
  await db.query(
    `UPDATE appts
     SET appt_status = 'Attended',
         appt_note   = CONCAT(IFNULL(appt_note,''), ?)
     WHERE appt_id = ?`,
    [note ? ` ${note}` : '', appt_id]
  );

  // Log
  await insertApptLog(db, appt_id, actingUserId,
    `"Status":"Attended"${note ? `,"Note":"${note.replace(/"/g, '\\"')}"` : ''}`
  );

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
    'SELECT appt_id, appt_client_id, appt_case_id, appt_date, appt_type, appt_with FROM appts WHERE appt_id = ?',
    [appt_id]
  );
  if (!appt) throw new Error('Appointment not found');

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
    const [[{ priorCount }]] = await db.query(
      `SELECT COUNT(*) AS priorCount FROM appts
       WHERE appt_client_id = ? AND appt_status = 'No Show' AND appt_id != ?`,
      [appt.appt_client_id, appt_id]
    );

    if (priorCount === 0) {
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
  await insertApptLog(db, appt_id, actingUserId,
    `"Status":"No Show","Enrolled":"${enrolled}"`
  );

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
  cancel_gcal     = false,
  create_task     = false,
  actingUserId    = 0
}) {
  if (!appt_id) throw new Error('cancelAppt requires appt_id');
  if ((sms || email) && !confirm_message.trim()) {
    throw new Error('Confirmation message required when sending SMS or email');
  }

  const appt = await fetchApptWithContact(db, appt_id);
  if (!appt) throw new Error('Appointment not found');

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
  await insertApptLog(db, appt_id, actingUserId,
    `"Status":"Canceled"` +
    (taskId ? `,"Task":"${taskId}"` : '') +
    (note   ? `,"Note":"${note.replace(/"/g, '\\"')}"` : '')
  );

  // 6) Return result (before non-blocking side effects)
  const result = { appt_id, taskId };

  // ---- Non-blocking side effects below ----

  // 7) SMS confirmation
  if (sms && appt.contact_phone) {
    getSetting(db, 'sms_default_from').then(fromNumber => {
      if (fromNumber) {
        smsService.sendSms(db, fromNumber, appt.contact_phone, confirm_message)
          .catch(err => console.error('[APPT SERVICE] Cancel SMS failed:', err.message));
      }
    });
  }

  // 8) Email confirmation
  if (email && appt.client_email) {
    getSetting(db, 'email_default_from').then(fromEmail => {
      if (fromEmail) {
        emailService.sendEmail(db, {
          from:    fromEmail,
          to:      appt.client_email,
          subject: 'Appointment Cancellation Confirmation',
          text:    confirm_message
        }).catch(err => console.error('[APPT SERVICE] Cancel email failed:', err.message));
      }
    });
  }

  // 9) GCal delete
  if (cancel_gcal && appt.appt_gcal) {
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
    confirm_message: (sms || email) ? confirm_message : '',
    actingUserId
  });

  // 5) Log on old appointment
  await insertApptLog(db, appt_id, actingUserId,
    `"Status":"Rescheduled","New Appt":"${newAppt.appt_id}","New Time":"${newDate}"` +
    (note ? `,"Note":"${note.replace(/"/g, '\\"')}"` : '')
  );

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
    'SELECT appt_id, appt_client_id FROM appts WHERE appt_id = ?',
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
  await insertApptLog(db, appt_id, actingUserId,
    `"Status":"Rescheduled"` +
    (taskId ? `,"Task":"${taskId}"` : '') +
    (note   ? `,"Note":"${note.replace(/"/g, '\\"')}"` : '')
  );

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