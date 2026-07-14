// lib/internal_functions/tasks.js

const fns = {};

// ─────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────
/**
 * create_task
 * Insert a task row, optionally linked to a contact, case, appointment, bill,
 * or event.
 *
 * Returns { task_id, action_token, action_url } as output — use set_vars in
 * the step config to capture any of them.
 *
 * params:
 *   title                  {string}         — task title, ≤100 chars (required, THROWS if longer)
 *   description            {string}         — optional, ≤1000 chars (THROWS if longer)
 *   contact_id             {number|string}  — convenience: implies a contact link
 *   assigned_to            {number}         — user ID to assign to (required)
 *   assigned_by            {number}         — user ID who created it (defaults to assigned_to)
 *   link_type              {string}         — 'contact'|'case'|'appt'|'bill'|'event'
 *   link_id                {string|number}  — the ID for the link (default: contact_id)
 *   due_date               {string}         — ISO date or datetime (optional)
 *   start_date             {string}         — ISO date or datetime (optional)
 *   notify                 {boolean}        — notify the ASSIGNER on completion
 *   source                 {string}         — machine-notice marker, ≤50 chars (e.g. 'court_review')
 *   send_assignment_email  {boolean}        — default true; false suppresses the canned email
 *
 * example config — a normal work task:
 *   {
 *     "function_name": "create_task",
 *     "params": {
 *       "title": "Follow up call",
 *       "contact_id": "{{contactId}}",
 *       "assigned_to": 2,
 *       "due_date": "{{followUpDate}}"
 *     },
 *     "set_vars": { "newTaskId": "{{this.output.task_id}}" }
 *   }
 *
 * ── TASKS AS NOTIFICATIONS ───────────────────────────────────────────────────
 * A task with `source` set and `send_assignment_email: false` is a
 * machine-pushed notice: it lands in the assignee's task list AND in an email
 * you compose yourself, carrying a one-click "dismiss" (= complete) button.
 *
 *   step 1  create_task
 *             { title: "Court notice needs review",
 *               description: "{{trigger.subject}}",
 *               assigned_to: 22,
 *               source: "court_review",
 *               send_assignment_email: false }
 *           set_vars: { "taskUrl": "{{this.output.action_url}}" }
 *
 *   step 2  send_email
 *             { to: "rena@4lsg.com",
 *               subject: "Court notice — review needed",
 *               body: "...<a href='{{taskUrl}}'>Not relevant? Dismiss</a>..." }
 *
 * Without send_assignment_email:false, step 1 and step 2 BOTH email the
 * assignee — that double-email is the whole reason the flag exists.
 *
 * ⚠ send_assignment_email does NOT suppress the due-date reminder email. If you
 *   set a due_date, the assignee still gets the canned 8 AM reminder on that
 *   date. Omit due_date if you want your email to be the only one.
 */

fns.create_task = async (params, db) => {
    const taskService = require('../../services/taskService');
    const {
      title,
      description = '',
      assigned_to,
      assigned_by = null,   // null -> service self-assigns to assigned_to; pass 0 for the automations user
      due_date    = null,
      start_date  = null,
      notify      = false,  // notify assigner on completion
      contact_id  = null,   // optional convenience: link to a contact
      link_type   = null,   // optional; 'contact'|'case'|'appt'|'bill'|'event'
      link_id     = null,
      source      = null,   // machine-notice marker ('court_review', …); null = human work
      send_assignment_email = true   // false -> caller sends its own email w/ action_url
    } = params;

    if (!title)       throw new Error('create_task requires title');
    if (!assigned_to) throw new Error('create_task requires assigned_to');

    // Link is OPTIONAL — tasks may be standalone. Back-compat: a bare
    // contact_id implies a contact link.
    let lt  = link_type;
    let lid = (link_id != null) ? link_id : contact_id;
    if (lt == null && lid != null && contact_id != null) lt = 'contact';

    // Delegate to the service so we get assignment notification, due-date
    // reminder, event log, and action token (the raw INSERT skipped all that).
    const { task_id, action_token, action_url } = await taskService.createTask(db, {
      from:  assigned_by,
      to:    assigned_to,
      title,
      desc:  description,
      start: start_date,
      due:   due_date,
      notify,
      link_type: lt || null,
      link_id:   (lid != null) ? lid : null,
      source,
      send_assignment_email
    });

    console.log(
      `[CREATE_TASK] "${title}" -> user ${assigned_to}` +
      (lt ? ` (${lt} ${lid})` : ' (standalone)') +
      (source ? ` [source=${source}]` : '') +
      (send_assignment_email ? '' : ' [assignment email suppressed]')
    );
    return { success: true, output: { task_id, action_token, action_url } };
  };

fns.create_task.__meta = {
  category: 'tasks',
  description: 'Create a task (via taskService: assignment notification + due reminder + log). The link is OPTIONAL — tasks can be standalone. Outputs task_id, action_token and action_url; set send_assignment_email:false and embed {{this.output.action_url}} in your own email to turn the task into a one-click-dismissable notification.',
  params: [
    { name: 'title', type: 'string', required: true, placeholderAllowed: true,
      description: 'Task title. Max 100 characters — the step FAILS if longer (it is not truncated).',
      example: 'Follow up call' },
    { name: 'description', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Max 1000 characters — the step FAILS if longer (it is not truncated).' },
    { name: 'assigned_to', type: 'integer', required: true,
      description: 'User ID to assign to.', example: 22 },
    { name: 'assigned_by', type: 'integer', required: false,
      description: 'User ID who created it. Default: self-assign to assigned_to. Pass 0 for the automations user.' },
    { name: 'due_date', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'ISO date or datetime.' },
    { name: 'start_date', type: 'iso_datetime', required: false, placeholderAllowed: true,
      description: 'ISO date or datetime.' },
    { name: 'notify', type: 'boolean', required: false, default: false,
      description: 'Notify the assigner when the task is completed.' },
    { name: 'contact_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Optional: link the task to a contact.', example: '{{contactId}}' },
    { name: 'link_type', type: 'enum', required: false,
      enum: ['contact','case','appt','bill','event'],
      description: 'Optional link type; omit for a standalone task.' },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'ID for the link. Defaults to contact_id when set.' },
    { name: 'source', type: 'string', required: false,
      example: 'court_review',
      description: 'Marks this task as a machine-pushed notice and records which system pushed it (e.g. court_review). Leave blank for normal work tasks.' },
    { name: 'send_assignment_email', type: 'boolean', required: false, default: true,
      description: 'Set false when you are sending your own email containing {{this.output.action_url}} — prevents a duplicate canned assignment email. NOTE: this does NOT suppress the due-date reminder email; omit due_date if you do not want that one either.' },
  ],
  example: { title: 'Follow up call', assigned_to: 22, due_date: '{{followUpDate}}' }
};

// ─────────────────────────────────────────────────────────────
// TASK DIGEST
// ─────────────────────────────────────────────────────────────

/**
 * run_task_digest — send the daily task digest on demand.
 *
 * params:
 *   user  {number|string}  (optional) — send only to this user ID
 *   force {boolean}        (optional) — skip Shabbos/Yom Tov gate
 *                                       and ignore task_remind_freq day filter
 *
 * When called with no params it behaves identically to the scheduled
 * task_daily_digest job (same Shabbos gate, same remind-freq filter).
 */

fns.run_task_digest = async ({ user: targetUser, force = false } = {}, db) => {
    const { DateTime }  = require('luxon');
    const calendarSvc   = require('../../services/calendarService');
    const taskService   = require('../../services/taskService');
    const emailSvc      = require('../../services/emailService');
    const smsSvc        = require('../../services/phoneService');
    const FIRM_TZ       = process.env.FIRM_TIMEZONE || 'America/Detroit';

    // ── 0. Refresh statuses (always runs) ──────────────────────
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

    // ── 1. Shabbos / Yom Tov gate (skipped when force=true) ────
    const nowFirm = DateTime.now().setZone(FIRM_TZ);
    if (!force) {
      const { workday, isShabbos, holidayName } = await calendarSvc.isWorkday(nowFirm.toISO());
      if (!workday) {
        const reason = isShabbos ? 'Shabbos' : `Yom Tov (${holidayName})`;
        console.log(`[TASK DIGEST] Skipping notifications — ${reason}`);
        return { skipped_reason: reason, overdue_moved: overdueMoved.affectedRows, due_today_moved: dueTodayMoved.affectedRows };
      }
    }

    const todayName = nowFirm.toFormat('cccc');   // "Monday"
    const todayFmt  = nowFirm.toFormat('MMMM d, yyyy');

    // ── 2. Fetch target user(s) ─────────────────────────────────
    let users;
    if (targetUser) {
      const [rows] = await db.query(
        `SELECT user, user_fname, user_name, email, phone, allow_sms, task_remind_freq
         FROM users WHERE user = ?`,
        [targetUser]
      );
      users = rows;
    } else {
      const [rows] = await db.query(
        `SELECT user, user_fname, user_name, email, phone, allow_sms, task_remind_freq
         FROM users
         WHERE task_remind_freq IS NOT NULL AND task_remind_freq != ''
           AND email IS NOT NULL AND email != ''`
      );
      users = rows;
    }

    const fromEmail = await taskService.getFromEmail(db);
    const smsFrom   = await taskService.getSmsFrom(db);

    let sent = 0, skipped = 0;

    for (const user of users) {
      // Remind-freq day filter — skipped when force=true or targeting a specific user
      if (!force && !targetUser) {
        const days = (user.task_remind_freq || '').split(',').map(d => d.trim());
        if (!days.includes(todayName)) { skipped++; continue; }
      }

      const [tasks] = await db.query(
        `SELECT
           t.task_id, t.task_status, t.task_title, t.task_due, t.task_action_token,
           co.contact_name, co.contact_id,
           ca.case_number_full, ca.case_number, ca.case_id
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

      if (!tasks.length) { skipped++; continue; }

      const overdue  = tasks.filter(t => t.task_status === 'Overdue');
      const dueToday = tasks.filter(t => t.task_status === 'Due Today');
      const pending  = tasks.filter(t => t.task_status === 'Pending');

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

      if (user.allow_sms && user.phone && smsFrom) {
        try {
          const parts = [];
          if (overdue.length)  parts.push(`${overdue.length} overdue`);
          if (dueToday.length) parts.push(`${dueToday.length} due today`);
          if (pending.length)  parts.push(`${pending.length} pending`);
          await smsSvc.sendSms(db, smsFrom, user.phone,
            `Hi ${user.user_fname}! Task summary for ${todayName}: ${parts.join(', ')}. Log in to YisraCase for more info.`
          );
        } catch (smsErr) {
          console.error(`[TASK DIGEST] SMS failed for user ${user.user}:`, smsErr.message);
        }
      }

      sent++;
    }

    console.log(`[TASK DIGEST] Done. Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped, overdue_moved: overdueMoved.affectedRows, due_today_moved: dueTodayMoved.affectedRows };
  };

fns.run_task_digest.__meta = {
  category: 'tasks',
  description: 'Send the daily task digest on demand.',
  params: [
    { name: 'user', type: 'string', required: false, placeholderAllowed: true,
      description: 'User ID to target (omit for all users with task_remind_freq).' },
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Skip Shabbos/Yom Tov gate and ignore task_remind_freq day filter.' },
  ],
  example: {}
};

module.exports = fns;