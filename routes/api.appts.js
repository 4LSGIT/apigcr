/**
 * Appointments API
 * routes/api.appts.js
 *
 * GET  /api/appts              list with filters
 * GET  /api/appts/:id          single appointment
 * POST /api/appts              create
 * POST /api/appts/:id/attended mark attended
 * POST /api/appts/:id/no-show  mark no show
 * POST /api/appts/cancel       cancel
 * POST /api/appts/reschedule   reschedule (now or later)
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const apptService  = require('../services/apptService');

// ─── LIST ───
router.get('/api/appts', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    contact_id, case_id, status, type, exclude_type, from, to,
    limit = 50, offset = 0
  } = req.query;

  const conditions = [];
  const params = [];

  if (contact_id) { conditions.push('appts.appt_client_id = ?'); params.push(contact_id); }
  if (case_id)    { conditions.push('appts.appt_case_id = ?');   params.push(case_id); }
  if (status)     { conditions.push('appts.appt_status = ?');    params.push(status); }
  if (from)       { conditions.push('appts.appt_date >= ?');     params.push(`${from} 00:00:00`); }
  if (to)         { conditions.push('appts.appt_date < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to);} 
  if (type)         { conditions.push('appts.appt_type = ?');  params.push(type); }
  if (exclude_type) { conditions.push('appts.appt_type != ?'); params.push(exclude_type); }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows] = await db.query(
      `SELECT
         appts.appt_id        AS id,
         appts.appt_client_id,
         appts.appt_case_id,
         appts.appt_type,
         appts.appt_length,
         appts.appt_platform,
         appts.appt_status    AS status,
         appts.appt_date,
         appts.appt_end,
         appts.appt_with,
         appts.appt_note,
         appts.appt_gcal,
         DATE_FORMAT(appts.appt_date, '%b. %e, %Y') AS format_date,
         DATE_FORMAT(appts.appt_date, '%h:%i %p')   AS time,
         contacts.contact_name,
         contacts.contact_id,
         users.user_name,
         cases.case_number,
         DATE_FORMAT(appts.appt_date, '%Y-%m-%dT%H:%i') AS appt_datetime_local
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN users    ON users.user = appts.appt_with
       LEFT JOIN cases    ON appts.appt_case_id = cases.case_id
       ${whereSql}
       ORDER BY appts.appt_date DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ counter }]] = await db.query(
      `SELECT COUNT(*) AS counter
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases    ON appts.appt_case_id = cases.case_id
       ${whereSql}`,
      params
    );

    res.json({ appts: rows, counter: counter || 0 });

  } catch (err) {
    console.error('GET /api/appts error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch appointments' });
  }
});

// ─── GET ONE ───
router.get('/api/appts/:id', jwtOrApiKey, async (req, res) => {
  const apptId = parseInt(req.params.id);
  if (!apptId) return res.status(400).json({ status: 'error', message: 'Invalid appointment ID' });

  try {
    const [[appt]] = await req.db.query(
      `SELECT
         appts.*,
         contacts.contact_name,
         contacts.contact_fname,
         contacts.contact_lname,
         contacts.contact_phone,
         contacts.contact_email,
         cases.case_id,
         cases.case_type,
         cases.case_status,
         cases.case_stage,
         DATE_FORMAT(appts.appt_date, '%Y-%m-%dT%H:%i') AS appt_date_local,
         DATE_FORMAT(appts.appt_end,  '%Y-%m-%dT%H:%i') AS appt_end_local
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases    ON appts.appt_case_id   = cases.case_id
       WHERE appts.appt_id = ?`,
      [apptId]
    );

    if (!appt) return res.status(404).json({ status: 'error', message: 'Appointment not found' });
    res.json({ data: appt });

  } catch (err) {
    console.error('GET /api/appts/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch appointment' });
  }
});

// ─── CREATE ───
router.post('/api/appts', jwtOrApiKey, async (req, res) => {
  try {
    const result = await apptService.createAppt(req.db, {
      ...req.body,
      actingUserId: req.auth?.userId || 0
    });
    res.json({
      status: 'success',
      title:  'Appointment Created!',
      message: `Appointment #${result.appt_id} created`,
      data:   result
    });
  } catch (err) {
    console.error('POST /api/appts error:', err);
    res.status(400).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── ATTENDED ───
router.post('/api/appts/:id/attended', jwtOrApiKey, async (req, res) => {
  const apptId = parseInt(req.params.id);
  if (!apptId) return res.status(400).json({ status: 'error', title: 'Error', message: 'Invalid appointment ID' });

  try {
    await apptService.markAttended(req.db, {
      appt_id:      apptId,
      note:         (req.body.note || '').trim(),
      actingUserId: req.auth?.userId || 0
    });
    res.json({ status: 'success', title: 'Success!', message: 'Appointment marked Attended!' });
  } catch (err) {
    console.error('POST /attended error:', err);
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── NO SHOW ───
router.post('/api/appts/:id/no-show', jwtOrApiKey, async (req, res) => {
  const apptId = parseInt(req.params.id);
  if (!apptId) return res.status(400).json({ status: 'error', title: 'Error', message: 'Invalid appointment ID' });

  try {
    const result = await apptService.markNoShow(req.db, {
      appt_id:      apptId,
      note:         (req.body.note || '').trim(),
      enroll:       req.body.enroll === true,
      actingUserId: req.auth?.userId || 0
    });

    const message = req.body.enroll && !result.enrolled
      ? 'Marked No Show — sequence not triggered (contact has prior no-shows)'
      : `Marked No Show${result.enrolled ? ' and enrolled in sequence' : ''}`;

    res.json({ status: 'success', title: 'Success!', message });
  } catch (err) {
    console.error('POST /no-show error:', err);
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── CANCEL ───
router.post('/api/appts/cancel', jwtOrApiKey, async (req, res) => {
  const {
    appt: apptId,
    note          = '',
    sms           = false,
    email         = false,
    confirm_message = '',
    cancel_gcal   = true,
    create_task   = false
  } = req.body;

  if (!apptId) return res.status(400).json({ status: 'error', title: 'Error', message: 'Missing appointment ID' });
  if ((sms || email) && !confirm_message.trim()) {
    return res.status(400).json({ status: 'error', title: 'Error', message: 'Confirmation message required when sending SMS or email' });
  }

  try {
    const result = await apptService.cancelAppt(req.db, {
      appt_id:         apptId,
      note,
      sms,
      email,
      confirm_message,
      cancel_gcal,
      create_task,
      actingUserId: req.auth?.userId || 0
    });

    // Non-blocking side effects (SMS, email, GCal) already fired inside service.
    // Response is immediate.
    res.json({
      status:  'success',
      title:   'Appointment Canceled',
      message: result.taskId ? `Canceled — follow-up task #${result.taskId} created` : 'Canceled'
    });

  } catch (err) {
    console.error('POST /api/appts/cancel error:', err);
    if (!res.headersSent) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ status: 'error', title: 'Error', message: err.message });
    }
  }
});

// ─── RESCHEDULE ───
router.post('/api/appts/reschedule', jwtOrApiKey, async (req, res) => {
  const {
    appt: apptId,
    newDate,
    note            = '',
    sms             = false,
    email           = false,
    msg             = '',
    rescheduleLater = false,
    createTask      = false
  } = req.body;

  if (!apptId) return res.status(400).json({ status: 'error', title: 'Error', message: 'Missing appointment ID' });

  try {
    if (!rescheduleLater) {
      // RESCHEDULE NOW
      if (!newDate) return res.status(400).json({ status: 'error', title: 'Error', message: 'Missing new date' });

      const result = await apptService.rescheduleAppt(req.db, {
        appt_id:         apptId,
        newDate,
        note,
        sms,
        email,
        confirm_message: msg,
        actingUserId:    req.auth?.userId || 0
      });

      res.json({
        status:  'success',
        title:   'Success!',
        message: `Rescheduled — new appointment #${result.new_appt_id}`
      });

    } else {
      // RESCHEDULE LATER
      const result = await apptService.rescheduleLater(req.db, {
        appt_id:      apptId,
        note,
        create_task:  createTask,
        actingUserId: req.auth?.userId || 0
      });

      const message = result.taskId
        ? `Marked Rescheduled — task #${result.taskId} created to follow up`
        : 'Marked Rescheduled — no follow-up task created';

      res.json({ status: 'success', title: 'Success!', message });
    }
  } catch (err) {
    console.error('POST /api/appts/reschedule error:', err);
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

module.exports = router;