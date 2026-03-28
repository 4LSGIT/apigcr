// lib/job_executor.js
const axios = require("axios");
const vm = require("vm");
const internalFunctions = require("./internal_functions");
const taskService = require('../services/taskService');

/**
 * Execute one job (webhook, internal_function, custom_code,
 *                   task_due_reminder, task_daily_digest)
 * Used by both standalone scheduler and workflow steps
 */
async function executeJob(job, db) {
  let jobData;
  try {
    jobData = typeof job.data === "string" ? JSON.parse(job.data) : job.data;
  } catch (err) {
    throw new Error(`Invalid job.data JSON: ${err.message}`);
  }

  const { type } = jobData;

  if (type === "webhook") {
    const { url, method = "GET", headers = {}, body } = jobData;
    if (!url) throw new Error('Webhook job missing "url"');

    const response = await axios({
      url,
      method,
      headers,
      data: body,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return response.data;
  }

  if (type === "internal_function") {
    const { function_name, params = {} } = jobData;
    const fn = internalFunctions[function_name];
    if (!fn) throw new Error(`Unknown internal function: ${function_name}`);
    return await fn(params, db);
  }

  if (type === "custom_code") {
    const { code, input = {} } = jobData;
    if (!code) throw new Error('Custom code job missing "code"');

    const sandbox = {
      input,
      console: {
        log: (...args) => console.log(`[CUSTOM CODE ${job.id}]`, ...args),
      },
    };

    const script = new vm.Script(code);
    return script.runInNewContext(sandbox, { timeout: 5000 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // task_due_reminder
  //
  // Fires at 8 AM on the task's due date.
  // Sends email (and SMS if allow_sms) to the task assignee.
  // Silently skips if the task is already Completed or Deleted.
  // ─────────────────────────────────────────────────────────────────────────

  if (type === 'task_due_reminder') {
    const { task_id } = jobData;
    if (!task_id) throw new Error('task_due_reminder: missing task_id');

    const task = await taskService.getTask(db, task_id);

    if (!task) {
      console.log(`[TASK REMINDER] Task #${task_id} not found — skipping`);
      return { skipped: true, reason: 'task not found' };
    }

    if (['Completed', 'Deleted'].includes(task.status)) {
      console.log(`[TASK REMINDER] Task #${task_id} already ${task.status} — skipping`);
      return { skipped: true, reason: `task already ${task.status}` };
    }

    const [[toUser]] = await db.query(
      'SELECT email, phone, allow_sms FROM users WHERE user = ?',
      [task.to.id]
    );

    if (!toUser?.email) {
      console.log(`[TASK REMINDER] No email for user ${task.to.id} — skipping`);
      return { skipped: true, reason: 'no email for assignee' };
    }

    const from = await taskService.getFromEmail(db);
    const html = taskService.buildDueReminderEmail(task);

    await require('../services/emailService').sendEmail(db, {
      from,
      to:      toUser.email,
      subject: `⏰ Task Due Today: ${task.title}`,
      html
    });

    // SMS if allow_sms
    if (toUser.allow_sms && toUser.phone) {
      try {
        const smsFrom = await taskService.getSmsFrom(db);
        if (smsFrom) {
          await require('../services/smsService').sendSms(db, smsFrom, toUser.phone,
            `Task due today: "${task.title}". Log in to YisraCase to complete it.`
          );
        }
      } catch (smsErr) {
        console.error(`[TASK REMINDER] SMS failed for task #${task_id}:`, smsErr.message);
      }
    }

    console.log(`[TASK REMINDER] Sent due reminder for task #${task_id} to ${toUser.email}`);
    return { task_id, sent_to: toUser.email, sms: !!(toUser.allow_sms && toUser.phone) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // task_daily_digest
  //
  // Runs once per day (seeded as a recurring scheduled_job).
  // 1) Refreshes task statuses: Pending → Overdue / Due Today based on task_due
  // 2) For each user whose task_remind_freq includes today's day name:
  //      - Queries their active tasks (Overdue / Due Today / Pending)
  //      - Sends a digest email (and short SMS summary if allow_sms)
  //      - Skips users with no active tasks
  // ─────────────────────────────────────────────────────────────────────────

  if (type === 'task_daily_digest') {
    const { DateTime } = require('luxon');
    const FIRM_TZ      = process.env.FIRM_TIMEZONE || 'America/Detroit';

    // ── 1. Refresh statuses ───────────────────────────────────────────────
    const [overdueMoved] = await db.query(
      `UPDATE tasks
       SET task_status = 'Overdue', task_last_update = NOW()
       WHERE task_status IN ('Pending', 'Due Today')
         AND task_due IS NOT NULL
         AND task_due < CURDATE()`
    );

    const [dueTodayMoved] = await db.query(
      `UPDATE tasks
       SET task_status = 'Due Today', task_last_update = NOW()
       WHERE task_status = 'Pending'
         AND task_due = CURDATE()`
    );

    console.log(
      `[TASK DIGEST] Status refresh: ${overdueMoved.affectedRows} → Overdue, ` +
      `${dueTodayMoved.affectedRows} → Due Today`
    );

    // ── 2. Today's day name in firm timezone ──────────────────────────────
    const todayName = DateTime.now().setZone(FIRM_TZ).toFormat('cccc'); // "Monday"
    const todayFmt  = DateTime.now().setZone(FIRM_TZ).toFormat('MMMM d, yyyy');

    // ── 3. Get all users with a task_remind_freq set ──────────────────────
    const [users] = await db.query(
      `SELECT user, user_fname, user_name, email, phone, allow_sms, task_remind_freq
       FROM users
       WHERE task_remind_freq IS NOT NULL AND task_remind_freq != ''
         AND email IS NOT NULL AND email != ''`
    );

    const emailSvc = require('../services/emailService');
    const smsSvc   = require('../services/smsService');
    const fromEmail = await taskService.getFromEmail(db);
    const smsFrom   = await taskService.getSmsFrom(db);

    let sent = 0, skipped = 0;

    for (const user of users) {
      // Check if today is in this user's reminder schedule
      const days = (user.task_remind_freq || '').split(',').map(d => d.trim());
      if (!days.includes(todayName)) {
        skipped++;
        continue;
      }

      // Fetch their active tasks with linked entity info
      const [tasks] = await db.query(
        `SELECT
           t.task_id, t.task_status, t.task_title, t.task_due,
           co.contact_name,
           ca.case_number_full, ca.case_number
         FROM tasks t
         LEFT JOIN contacts co ON (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
         LEFT JOIN cases    ca ON (t.task_link_type = 'case'    AND t.task_link_id = ca.case_id)
         WHERE t.task_to = ?
           AND t.task_status IN ('Pending', 'Due Today', 'Overdue')
         ORDER BY
           FIELD(t.task_status, 'Overdue', 'Due Today', 'Pending'),
           t.task_due ASC`,
        [user.user]
      );

      if (!tasks.length) {
        skipped++;
        continue; // no email if nothing to show
      }

      const overdue  = tasks.filter(t => t.task_status === 'Overdue');
      const dueToday = tasks.filter(t => t.task_status === 'Due Today');
      const pending  = tasks.filter(t => t.task_status === 'Pending');

      // Email
      try {
        const html = taskService.buildDigestEmail(user, overdue, dueToday, pending, todayName);
        await emailSvc.sendEmail(db, {
          from:    fromEmail,
          to:      user.email,
          subject: `Your Task Summary — ${todayFmt}`,
          html
        });
      } catch (emailErr) {
        console.error(`[TASK DIGEST] Email failed for user ${user.user}:`, emailErr.message);
      }

      // SMS — short summary only
      if (user.allow_sms && user.phone && smsFrom) {
        try {
          const parts = [];
          if (overdue.length)  parts.push(`${overdue.length} overdue`);
          if (dueToday.length) parts.push(`${dueToday.length} due today`);
          if (pending.length)  parts.push(`${pending.length} pending`);
          await smsSvc.sendSms(db, smsFrom, user.phone,
            `Task summary for ${todayName}: ${parts.join(', ')}. Log in to YisraCase.`
          );
        } catch (smsErr) {
          console.error(`[TASK DIGEST] SMS failed for user ${user.user}:`, smsErr.message);
        }
      }

      sent++;
    }

    console.log(`[TASK DIGEST] Done. Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped, overdue_moved: overdueMoved.affectedRows, due_today_moved: dueTodayMoved.affectedRows };
  }

  throw new Error(`Unsupported job type: ${type}`);
}

module.exports = { executeJob };