// lib/internal_functions/portalCallback.js
//
// Portal Slice 3.5 — the callback-window reminder. Scheduled by
// services/portalCallbackService.createRequest as a one_time scheduled_jobs
// row firing AT WINDOW START (the built-in task_due_reminder fires at 8 AM
// of the due DATE — wrong instrument for a clock-time reminder).
//
// Cancellation model: NONE needed. Client cancel soft-deletes the task
// (status 'Deleted'); this function checks task status at fire time and
// skips Completed/Deleted — the job-executor's own task_due_reminder
// precedent. The stale pending job simply no-ops.
//
// Services are lazy-required inside the function (calendar.js convention —
// this directory is required at boot by index.js's auto-scan, and top-level
// service requires here would drag the whole service graph into boot).

'use strict';

const fns = {};

/**
 * portal_callback_reminder
 * Notify the task's CURRENT assignee (resolved at fire time, not frozen at
 * schedule time) that a client's callback window has opened: SMS when the
 * assignee allows it, email fallback. Sender + recipient resolve from
 * settings/DB — never hardcoded.
 *
 * params:
 *   task_id      {number}  — the portal_callback task
 *   contact_id   {number}  — the requesting contact (deep-link target)
 *   phone        {string}  — the number the client asked to be called at
 *   window_label {string}  — e.g. "2:00–4:00 PM" (server-derived, not client text)
 *   date         {string?} — 'YYYY-MM-DD' (carried for the pending display;
 *                            unused here)
 */
fns.portal_callback_reminder = async (params, db) => {
  const taskService = require('../../services/taskService');

  const { task_id, contact_id, phone, window_label } = params || {};
  if (!task_id)    throw new Error('portal_callback_reminder: missing task_id');
  if (!contact_id) throw new Error('portal_callback_reminder: missing contact_id');

  const task = await taskService.getTask(db, task_id);
  if (!task) {
    console.log(`[CALLBACK REMINDER] Task #${task_id} not found — skipping`);
    return { success: true, skipped: true, reason: 'task not found' };
  }
  if (['Completed', 'Deleted'].includes(task.status)) {
    console.log(`[CALLBACK REMINDER] Task #${task_id} already ${task.status} — skipping`);
    return { success: true, skipped: true, reason: `task already ${task.status}` };
  }

  // Fresh contact name (display only; the number to dial is the client's
  // request-time choice carried in params).
  const [[contact]] = await db.query(
    'SELECT contact_name FROM contacts WHERE contact_id = ?',
    [contact_id]
  );
  const name = String(contact?.contact_name || '').trim() || `Contact ${contact_id}`;

  const d = String(phone || '').replace(/\D/g, '');
  const prettyPhone = d.length === 10
    ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    : String(phone || '');

  const appUrl = require('../firmConfig').cfg('app_url') || 'https://app.4lsg.com';
  const link = `${appUrl}/?contact=${contact_id}`;
  const line =
    `Callback now: ${name}` +
    (prettyPhone ? ` ${prettyPhone}` : '') +
    (window_label ? ` (${window_label} window)` : '') +
    ` — ${link}`;

  const [[assignee]] = await db.query(
    'SELECT email, phone, allow_sms FROM users WHERE user = ?',
    [task.to.id]
  );
  if (!assignee) {
    console.warn(`[CALLBACK REMINDER] Assignee user ${task.to.id} not found — skipping`);
    return { success: true, skipped: true, reason: 'assignee not found' };
  }

  if (assignee.allow_sms && assignee.phone) {
    const smsFrom = await taskService.getSmsFrom(db);
    if (smsFrom) {
      const phoneService = require('../../services/phoneService');
      await phoneService.sendSms(db, smsFrom, assignee.phone, line);
      return { success: true, output: { notified: 'sms', task_id } };
    }
  }

  if (assignee.email) {
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const emailService = require('../../services/emailService');
    const from = await taskService.getFromEmail(db);
    await emailService.sendEmail(db, {
      from,
      to: assignee.email,
      subject: `⏰ Callback now: ${name}`,
      html:
        `<p><strong>${esc(name)}</strong> asked for a callback` +
        (window_label ? ` in the <strong>${esc(window_label)}</strong> window` : '') +
        (prettyPhone ? ` at <strong>${esc(prettyPhone)}</strong>` : '') +
        `.</p><p><a href="${esc(link)}">Open contact</a></p>`,
    });
    return { success: true, output: { notified: 'email', task_id } };
  }

  console.warn(`[CALLBACK REMINDER] Assignee user ${task.to.id} has no reachable channel`);
  return { success: true, skipped: true, reason: 'assignee unreachable' };
};

fns.portal_callback_reminder.__meta = {
  category: 'system',
  uiHidden: true,   // machine-scheduled by the portal callback service — not a picker action
  description:
    'Portal callback-window reminder: at window start, SMS (email fallback) the ' +
    'callback task\'s current assignee with the client name, requested phone, ' +
    'window, and a contact deep-link. Skips silently if the task is Completed ' +
    'or Deleted (client cancel needs no job cancellation).',
  params: [
    { name: 'task_id',      type: 'integer', required: true,
      description: 'The portal_callback task id.' },
    { name: 'contact_id',   type: 'integer', required: true,
      description: 'The requesting contact (deep-link target).' },
    { name: 'phone',        type: 'string',  required: false,
      description: 'The number the client asked to be called at (10 digits).' },
    { name: 'window_label', type: 'string',  required: false,
      description: 'Display label of the window, e.g. "2:00–4:00 PM".' },
    { name: 'date',         type: 'string',  required: false,
      description: 'Callback day, YYYY-MM-DD (carried for the pending display).' },
  ],
  example: {
    task_id: 123, contact_id: 456, phone: '2485551212',
    window_label: '2:00–4:00 PM', date: '2026-08-13',
  },
};

module.exports = fns;
