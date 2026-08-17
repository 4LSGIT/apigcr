// services/taskService.js
//
/**
 * Task Service
 * services/taskService.js
 *
 * All task business logic lives here. Routes and internal functions
 * are thin wrappers that call these methods.
 *
 * Statuses:
 *   Pending   — active, no due date or due in the future
 *   Due Today — active, due today
 *   Overdue   — active, past due
 *   Completed — done
 *   Deleted   — soft-deleted (was Canceled in older schema)
 *
 *   Open statuses are computed from task_due in FIRM TIME (computeStatus) at
 *   every write that can change them: createTask, updateTask (when task_due
 *   changes on an open task), reopenTask. The daily digest's 13:00-UTC sweep
 *   (lib/internal_functions/tasks.js) remains as the day-rollover pass — a
 *   task nobody touches still flips Pending → Due Today → Overdue each
 *   morning. Terminal statuses (Completed/Deleted) are never recomputed.
 *
 * Link strategy:
 *   Writes: always set task_link + task_link_type + task_link_id (all three)
 *   Reads:  prefer task_link_type/task_link_id, fall back to task_link for old rows.
 *
 * Action tokens:
 *   Every task gets a random url-safe token (tasks.task_action_token) at
 *   creation. It powers the public action links served by routes/taskActions.js
 *   (GET /t/:token confirm page, POST .../complete, POST .../cancel,
 *   GET .../status.svg live badge). Token authorizes the assignee's
 *   complete/cancel action — acceptable threat model for internal staff tasks.
 *
 * Two exits, and the note:
 *   completeTask = acted. deleteTask = dismissed (soft, reversible via
 *   reopenTask). Cancel is NOT a new status — it is deleteTask, so the
 *   acted-vs-dismissed signal reads straight off task_status.
 *
 *   Both take an optional `logExtra` object which is merged into the log row's
 *   `data` (→ log_data JSON). Conventional keys:
 *     via  — 'app' | 'email_link'    (which surface performed the action)
 *     note — optional free text from the actor. Callers CLAMP it (500 chars)
 *            before it gets here; the service never validates it. It is NOT a
 *            column. completeTask additionally renders it in the completion
 *            email to the assigner (task_notification = 1).
 *
 *   createTask RETURNS the token and its URL:
 *     { task_id, action_token, action_url }
 *   so a caller can embed the one-click link in an email it sends itself.
 *
 * Tasks as notifications:
 *   createTask({ source, send_assignment_email }) turns a task into a
 *   general-purpose, one-click-dismissable notice:
 *     - `source` (tasks.task_source, VARCHAR(50), free-text, immutable)
 *       NULL      = human-created work
 *       non-NULL  = machine-pushed notice; records which system pushed it
 *                   ('court_review', 'esign_stall', …). Never validated —
 *                   new sources must be zero-migration.
 *     - `send_assignment_email: false` suppresses the canned assignment
 *       email so the caller can send its own containing action_url.
 *       It does NOT suppress the due-date reminder — omit `due` for that.
 *
 * HTML escaping:
 *   Every user/machine-supplied value interpolated into the email builders
 *   below goes through htmlEscape(). MIME subject headers do NOT (escaping a
 *   mail header would put a literal &amp; in the recipient's inbox) — only
 *   the HTML <title> inside emailWrap() is escaped.
 */

const crypto       = require('crypto');
const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('./timezoneService');
const logService   = require('./logService');
const { blankDatesToNull } = require('../lib/blankDateToNull');

// ─── lazy-load to avoid circular deps ───────────────────────────────────────
function emailSvc() { return require('./emailService'); }
function smsSvc()   { return require('./phoneService'); }
function settings() { return require('./settingsService'); }

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Read per call so live edits of the app_url setting apply without redeploy.
const APP_URL = () => require('../lib/firmConfig').cfg('app_url') || 'https://app.4lsg.com';
// Client/recipient-facing action links (/t/:token) live on the PUBLIC landing
// host as of 2026-08-17 — see ref/ORIGIN_SEPARATION_ROLLOUT.md. APP_URL stays
// for STAFF-shell deep links (?contact= / ?case=), which only resolve on the
// app origin. Keeping both named makes the choice explicit at each call site.
const PUBLIC_URL = () => require('../lib/firmConfig').publicUrl();

/**
 * HTML-escape a value for interpolation into the email builders below.
 *
 * Deliberately duplicated from routes/taskActions.js rather than imported —
 * both modules stay self-contained (existing convention). Keep them in sync.
 *
 * ORDER MATTERS for multiline text: escape FIRST, then newline→<br>:
 *   htmlEscape(task.desc).replace(/\n/g, '<br>')
 * Doing it the other way round would escape the <br> tags you just inserted.
 */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a task description for HTML surfaces: escape, bold leading
 * "Label:" line prefixes, then newline→<br>.
 *
 * ORDER MATTERS: escape FIRST, per line, then run the bold regex on the
 * escaped text — the pattern only matches [A-Za-z ]+: so it can never touch
 * escaped entities, and the <strong> tags it inserts are the only HTML in
 * the output. Bolding applies to ANY line starting "Some Label:" (machine-
 * composed lead/court descs and hand-typed ones alike) — deliberate.
 *
 * Duplicated in routes/taskActions.js (self-contained convention, same as
 * htmlEscape). Keep them in sync.
 */
function renderDescHtml(desc) {
  return String(desc == null ? '' : desc)
    .split('\n')
    .map(line => htmlEscape(line).replace(/^([A-Za-z][A-Za-z ]{0,30}:)/, '<strong>$1</strong>'))
    .join('<br>');
}

/** Random url-safe action token (22 chars), stored in tasks.task_action_token. */
function newActionToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** Public one-click action URL for a shaped task, or null if no token. */
function taskActionUrl(task) {
  return task?.action_token ? `${PUBLIC_URL()}/t/${task.action_token}` : null;
}

/**
 * Given a DATE value, return the status it should have right now, in FIRM
 * TIME. Callers: createTask (initial status), updateTask (recompute when
 * task_due changes on an open task), reopenTask.
 *
 * "Today" is the firm's calendar day, not the server's — Cloud Run runs UTC,
 * so `new Date().setHours(0,0,0,0)` here would flip a Detroit-evening due
 * date a day early. ISO date strings compare correctly lexicographically.
 *
 * Accepts a JS Date (mysql2 DATE under the pool's timezone:"Z" config comes
 * back as UTC midnight, so toISOString().slice(0,10) is the stored calendar
 * date) or a 'YYYY-MM-DD[...]' string. Anything unparseable → 'Pending'
 * (fail-safe, matches the old NaN behaviour).
 */
function computeStatus(dueDate) {
  if (!dueDate) return 'Pending';
  const due = (dueDate instanceof Date
    ? dueDate.toISOString()
    : String(dueDate).trim()
  ).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 'Pending';
  const today = DateTime.now().setZone(FIRM_TZ).toISODate();
  if (due < today)   return 'Overdue';
  if (due === today) return 'Due Today';
  return 'Pending';
}

/**
 * Format a date for display in emails.
 * @param {string|Date} d
 * @returns {string} e.g. "Thursday, April 10"
 */
function fmtDate(d) {
  if (!d) return '—';
  try {
    const iso = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    return DateTime.fromISO(iso).toFormat('cccc, MMMM d');
  } catch { return String(d).slice(0, 10); }
}
function fmtDateShort(d) {
  if (!d) return '—';
  try {
    const iso = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    return DateTime.fromISO(iso).toFormat('MMM d');
  } catch { return '—'; }
}

/**
 * Format a stored DATETIME (tasks.task_date etc.) as a firm-timezone calendar
 * date. Do NOT use fmtDate() for these: it slices the UTC ISO string, so
 * anything written after 8 PM Detroit reports the following day.
 *
 * The pool is configured with timezone:"Z" (startup/db.js), so mysql2 hands
 * back a Date at the correct absolute instant; we only need to re-render it
 * in FIRM_TZ.
 *
 * Year is included — an assignment date can be months old, unlike a due date.
 *
 * @param {string|Date} d
 * @returns {string} e.g. "April 10, 2026"
 */
function fmtStampDate(d) {
  if (!d) return '—';
  try {
    const dt = d instanceof Date
      ? DateTime.fromJSDate(d, { zone: 'utc' })
      : DateTime.fromISO(String(d).trim().replace(' ', 'T'), { zone: 'utc' });
    if (!dt.isValid) return String(d).slice(0, 10);
    return dt.setZone(FIRM_TZ).toFormat('MMMM d, yyyy');
  } catch { return String(d).slice(0, 10); }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL HTML BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

const TASK_COLOR = '#312e81';   // indigo-900

/**
 * Humanized labels for tasks.task_source (machine-notice marker), with a
 * generic title-case fallback so new sources need zero code here. Duplicated
 * in public/tasks.html (SOURCE_LABELS) — same self-contained convention as
 * htmlEscape/renderDescHtml. Keep them in sync.
 */
const SOURCE_LABELS = {
  esign: 'E-sign', esign_followup: 'E-sign follow-up', esign_stall: 'E-sign stall',
  adobe_sign: 'Adobe Sign', client_upload: 'Client upload', ext_form: 'External form',
  form_pdf: 'Form PDF', court_review: 'Court review', claude_charter: 'Claude'
};
function sourceLabel(slug) {
  if (!slug) return '';
  return SOURCE_LABELS[slug] ||
    String(slug).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Shared outer wrapper.
 *
 * `subject` here is the HTML <title> ONLY — it is escaped. The MIME subject
 * header is built independently at each send site (notifyAssignment,
 * notifyCompletion, job_executor, run_task_digest) and must stay RAW.
 * `bodyHtml` is already-built HTML — never escaped.
 */
function emailWrap(headerLabel, subject, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:100%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">

      <!-- Header bar -->
      <tr>
        <td style="background:${TASK_COLOR};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">${htmlEscape(headerLabel)}</span>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          ${bodyHtml}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8f7ff;padding:14px 32px;border-top:1px solid #e0e0e0">
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

/** Inline metadata row used inside email bodies */
function metaRow(label, value) {
  return `<tr>
    <td style="padding:5px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top">${label}</td>
    <td style="padding:5px 0;font-size:13px;color:#111827;font-weight:500">${value}</td>
  </tr>`;
}

/**
 * One-click complete button + live status badge for single-task emails.
 * Falls back to the old "log in" line when the task has no action token
 * (pre-migration rows).
 *
 * The badge <img> is fetched at open time so the email reflects current
 * status (caveats: Apple MPP caches at delivery; Outlook blocks remote
 * images by default — it's decorative, the button/landing page is the
 * real mechanism).
 */
function buildActionBlock(task) {
  const url = taskActionUrl(task);
  if (!url) {
    return `<p style="margin:20px 0 0;font-size:13px;color:#9ca3af">
      Log in to YisraCase to view or complete this task.
    </p>`;
  }
  return `
    <table cellpadding="0" cellspacing="0" style="margin:22px 0 0">
      <tr>
        <td>
          <a href="${url}"
             style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;
                    border-radius:6px;padding:12px 24px;font-size:15px;font-weight:700">
            ✓ Mark Complete
          </a>
        </td>
        <td style="vertical-align:middle;padding-left:14px">
          <img src="${url}/status.svg" height="22" alt="Task status" style="vertical-align:middle">
        </td>
      </tr>
    </table>
    <p style="margin:10px 0 0;font-size:12px;color:#9ca3af">
      Or log in to YisraCase to view or complete this task.
    </p>`;
}

/**
 * Assignment / transfer notification email (to task_to).
 * @param {object} task  - from getTask()
 * @param {string} [verb] - "assigned" | "transferred to you"
 */
function buildAssignmentEmail(task, verb = 'assigned') {
  const linkLine = task.link
    ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">
         Linked to: <strong style="color:#4f46e5">${htmlEscape(task.link.title)}</strong>
       </p>`
    : '';

  const descBlock = task.desc
    ? `<div style="margin:16px 0;padding:14px 16px;background:#f5f3ff;border-left:3px solid ${TASK_COLOR};
                  border-radius:4px;font-size:14px;color:#374151;line-height:1.6">
         ${renderDescHtml(task.desc)}
       </div>`
    : '';

  const body = `
    <h2 style="margin:0 0 4px;font-size:22px;color:#111827">New Task ${verb.charAt(0).toUpperCase() + verb.slice(1)}</h2>
    <p style="margin:0 0 20px;font-size:15px;color:#374151">
      You have a new task waiting for you.
    </p>

    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${TASK_COLOR}">${htmlEscape(task.title)}</p>

    ${descBlock}
    ${linkLine}

    <table cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
      ${metaRow('Assigned by', htmlEscape(task.from.name || '—'))}
      ${task.start && String(task.start).slice(0, 10) > DateTime.now().setZone(FIRM_TZ).toISODate()
        ? metaRow('Starts', `${fmtDate(task.start)} — you'll be reminded then`)
        : ''}
      ${metaRow('Due date', task.due ? fmtDate(task.due) : 'No due date')}
      ${task.notify ? metaRow('Notification', 'Assigner will be notified on completion') : ''}
    </table>

    ${buildActionBlock(task)}
  `;

  // NOTE: the `subject` arg is the HTML <title> — emailWrap escapes it.
  // The MIME subject header is built separately in notifyAssignment (raw).
  return emailWrap('Task Assignment', `New Task ${verb}: ${task.title}`, body);
}

/**
 * Completion notification email (to task_from).
 *
 * @param {object} task
 * @param {string} completedByName
 * @param {string} [note]  optional free-text note the assignee left when
 *                         completing (from the /t/ page or the in-app dialog).
 *                         This email is exactly where "done, but heads-up: …"
 *                         matters, so it renders when present.
 */
function buildCompletionEmail(task, completedByName, note) {
  const linkLine = task.link
    ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">
         Linked to: <strong style="color:#4f46e5">${htmlEscape(task.link.title)}</strong>
       </p>`
    : '';

  // Same block pattern as buildAssignmentEmail's descBlock.
  // ORDER: htmlEscape FIRST, then newline→<br> (see htmlEscape's doc).
  const noteBlock = note
    ? `<div style="margin:16px 0;padding:14px 16px;background:#f5f3ff;border-left:3px solid ${TASK_COLOR};
                  border-radius:4px;font-size:14px;color:#374151;line-height:1.6">
         <div style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;
                     text-transform:uppercase;color:#6b7280">Note from ${htmlEscape(task.to.name || 'the assignee')}</div>
         ${htmlEscape(note).replace(/\n/g, '<br>')}
       </div>`
    : '';

  const body = `
    <h2 style="margin:0 0 4px;font-size:22px;color:#111827">Task Completed ✓</h2>
    <p style="margin:0 0 20px;font-size:15px;color:#374151">
      A task you created has been marked complete.
    </p>

    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#065f46">${htmlEscape(task.title)}</p>

    ${noteBlock}
    ${linkLine}

    <table cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
      ${metaRow('Completed by', htmlEscape(completedByName))}
      ${metaRow('Assigned to',  htmlEscape(task.to.name || '—'))}
      ${task.due ? metaRow('Was due', fmtDate(task.due)) : ''}
    </table>
  `;

  // NOTE: the `subject` arg is the HTML <title> — emailWrap escapes it.
  // The MIME subject header is built separately in notifyCompletion (raw).
  return emailWrap('Task Completed', `Task Completed: ${task.title}`, body);
}

/**
 * Due-date reminder email (to task_to, fires morning of due date).
 * @param {object} task
 */
/**
 * Start-date reminder — the "this is live now" nudge for a deferred task.
 *
 * A task with a future task_start is suppressed from the daily digest until
 * that date (see run_task_digest), so this email is the moment it re-enters
 * the assignee's world. Deliberately worded as an activation, not a deadline:
 * the due date may be days or months later, or absent entirely.
 */
function buildStartReminderEmail(task) {
  const linkLine = task.link
    ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">
         Linked to: <strong style="color:#4f46e5">${htmlEscape(task.link.title)}</strong>
       </p>`
    : '';

  const descBlock = task.desc
    ? `<div style="margin:14px 0;padding:14px 16px;background:#eef2ff;border-left:3px solid #4f46e5;
                  border-radius:4px;font-size:14px;color:#374151;line-height:1.6">
         ${renderDescHtml(task.desc)}
       </div>`
    : '';

  const body = `
    <h2 style="margin:0 0 4px;font-size:22px;color:#111827">\u{1F514} Task Starts Today</h2>
    <p style="margin:0 0 20px;font-size:15px;color:#374151">
      A task that was scheduled for later is now active.
    </p>

    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#4338ca">${htmlEscape(task.title)}</p>

    ${descBlock}
    ${linkLine}

    <table cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
      ${metaRow('Due date',    task.due ? fmtDate(task.due) : 'No due date')}
      ${metaRow('Assigned by', htmlEscape(task.from.name || '\u2014'))}
      ${task.created ? metaRow('Assigned on', fmtStampDate(task.created)) : ''}
    </table>

    ${buildActionBlock(task)}
  `;

  return emailWrap('Task Starts Today', `\u{1F514} Task Starts Today: ${task.title}`, body);
}


function buildDueReminderEmail(task) {
  const linkLine = task.link
    ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">
         Linked to: <strong style="color:#4f46e5">${htmlEscape(task.link.title)}</strong>
       </p>`
    : '';

  const descBlock = task.desc
    ? `<div style="margin:14px 0;padding:14px 16px;background:#fff7ed;border-left:3px solid #f97316;
                  border-radius:4px;font-size:14px;color:#374151;line-height:1.6">
         ${renderDescHtml(task.desc)}
       </div>`
    : '';

  const body = `
    <h2 style="margin:0 0 4px;font-size:22px;color:#111827">⏰ Task Due Today</h2>
    <p style="margin:0 0 20px;font-size:15px;color:#374151">
      A task assigned to you is due today.
    </p>

    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#b45309">${htmlEscape(task.title)}</p>

    ${descBlock}
    ${linkLine}

    <table cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
      ${metaRow('Due date',    fmtDate(task.due))}
      ${metaRow('Assigned by', htmlEscape(task.from.name || '—'))}
      ${task.created ? metaRow('Assigned on', fmtStampDate(task.created)) : ''}
    </table>

    ${buildActionBlock(task)}
  `;

  // NOTE: the `subject` arg is the HTML <title> — emailWrap escapes it.
  // The MIME subject header is built separately in job_executor (raw).
  return emailWrap('Due Today Reminder', `⏰ Task Due Today: ${task.title}`, body);
}

/**
 * Daily digest email — groups by Overdue / Due Today / Pending.
 * @param {object}   user
 * @param {object[]} overdue
 * @param {object[]} dueToday
 * @param {object[]} pending
 * @param {string}   dayName  e.g. "Monday"
 */
function buildDigestEmail(user, overdue, dueToday, pending, dayName) {
  const today = DateTime.now().setZone(FIRM_TZ).toFormat('MMMM d, yyyy');
  const total = overdue.length + dueToday.length + pending.length;

  function taskRow(t, color) {
    let linkHtml = '';
    const linkName = t.contact_name || t.case_number_full || t.case_number || '';
    if (linkName) {
      let href = APP_URL();
      if (t.contact_name) href += `?contact=${t.contact_id || ''}`;
      else if (t.case_number_full || t.case_number|| t.case_id) href += `?case=${t.case_id || ''}`;
      linkHtml = `<a href="${href}" style="color:#4f46e5;text-decoration:none">${htmlEscape(linkName)}</a>`;
    }
    // One-click complete link (requires the digest query to SELECT t.task_action_token)
    const doneHtml = t.task_action_token
      ? `<a href="${PUBLIC_URL()}/t/${t.task_action_token}" title="Mark complete"
            style="color:#059669;text-decoration:underline;font-weight:600;font-size:12px;white-space:nowrap">mark&nbsp;done</a>`
      : '';
    // Machine-pushed notices get the same de-emphasis the task list gives
    // them (robot marker + humanized source) so a block of e-sign receipts
    // reads as notices, not as work. Emoji, not an icon font — email clients.
    const srcChip = t.task_source
      ? ` <span style="font-size:11px;color:#6b7280;white-space:nowrap">\u{1F916} ${htmlEscape(sourceLabel(t.task_source))}</span>`
      : '';
    return `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:8px 4px 8px 0;font-size:13px;color:#111827;font-weight:500;
                 max-width:280px">${htmlEscape(t.task_title)}${srcChip}</td>
      <td style="padding:8px 6px;font-size:12px;color:#6b7280;white-space:nowrap">
        ${fmtDateShort(t.task_due)}
      </td>
      <td style="padding:8px 0 8px 4px;font-size:12px;color:#6b7280">${linkHtml}</td>
      <td style="padding:8px 0 8px 6px;text-align:center;white-space:nowrap">${doneHtml}</td>
    </tr>`;
  }

  function section(label, color, emoji, tasks) {
    if (!tasks.length) return '';
    return `<div style="margin-bottom:24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${color};
                letter-spacing:1.2px;text-transform:uppercase">${emoji} ${label} (${tasks.length})</p>
      <table width="100%" cellpadding="0" cellspacing="0"
             style="border-top:2px solid ${color}">
        <thead>
          <tr>
            <th style="padding:6px 4px 6px 0;font-size:11px;color:#9ca3af;font-weight:600;
                       text-align:left;border-bottom:1px solid #e5e7eb">Task</th>
            <th style="padding:6px 6px;font-size:11px;color:#9ca3af;font-weight:600;
                       text-align:left;border-bottom:1px solid #e5e7eb;white-space:nowrap">Due</th>
            <th style="padding:6px 0 6px 4px;font-size:11px;color:#9ca3af;font-weight:600;
                       text-align:left;border-bottom:1px solid #e5e7eb">Linked to</th>
            <th style="padding:6px 0 6px 6px;font-size:11px;color:#9ca3af;font-weight:600;
                       text-align:center;border-bottom:1px solid #e5e7eb;white-space:nowrap"></th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => taskRow(t, color)).join('')}
        </tbody>
      </table>
    </div>`;
  }

  const body = `
    <h2 style="margin:0 0 2px;font-size:22px;color:#111827">Good morning, ${htmlEscape(user.user_fname || user.user_name)}!</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#6b7280">Here's your task summary for ${dayName}, ${today}.</p>

    <table cellpadding="0" cellspacing="0" width="100%"
           style="margin-bottom:20px;background:#f5f3ff;border-radius:8px">
      <tr>
        <td style="padding:14px 18px;font-size:13px;color:#374151;text-align:center">
          <strong style="color:#dc2626;font-size:16px">${overdue.length}</strong> overdue
          <span style="color:#d1d5db;padding:0 10px">·</span>
          <strong style="color:#d97706;font-size:16px">${dueToday.length}</strong> due today
          <span style="color:#d1d5db;padding:0 10px">·</span>
          <strong style="color:#4f46e5;font-size:16px">${pending.length}</strong> pending
        </td>
      </tr>
    </table>

    ${section('Overdue',   '#dc2626', '🔴', overdue)}
    ${section('Due Today', '#d97706', '🟡', dueToday)}
    ${section('Pending',   '#4f46e5', '⚪', pending)}

    <p style="margin:20px 0 0;font-size:13px;color:#9ca3af">
      The mark done link completes a task (one confirmation click).
      Log in to YisraCase to manage your tasks reminder preferences.
    </p>
  `;

  return emailWrap(`Task Summary — ${dayName}`, `Your Task Summary — ${today}`, body);
}


// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a task event to the log table.
 * Links to the task's contact or case if available.
 */
async function logTaskEvent(db, taskId, actingUserId, action, extra = {}) {
  const task = await getTask(db, taskId);
  if (!task) return;

  await logService.createLogEntry(db, {
    type:      'task',
    link_type: task.link?.type || null,
    link_id:   task.link?.id   || null,
    by:        actingUserId || 0,
    data:      { action, task_id: taskId, task_title: task.title, ...extra }
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedule a one_time job to fire at 8 AM on the task's due date.
 * Stores the job ID back in tasks.task_due_job_id.
 * No-ops (returns null) if due date is today or past.
 */
async function scheduleDueReminder(db, taskId, dueDate) {
  if (!dueDate) return null;

  const dueDateStr  = String(dueDate).slice(0, 10);
  const reminderDt  = DateTime.fromISO(`${dueDateStr}T08:00:00`, { zone: FIRM_TZ });
  const reminderUTC = reminderDt.toUTC().toJSDate();

  if (reminderUTC <= new Date()) return null; // already past

  const [result] = await db.query(
    `INSERT INTO scheduled_jobs
       (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
     VALUES ('one_time', ?, 'pending', ?, ?, 2, 120)`,
    [
      reminderUTC,
      `Task due reminder — task #${taskId}`,
      JSON.stringify({ type: 'task_due_reminder', task_id: taskId })
    ]
  );

  const jobId = result.insertId;
  await db.query('UPDATE tasks SET task_due_job_id = ? WHERE task_id = ?', [jobId, taskId]);
  return jobId;
}

/**
 * Schedule the start-date notification: 8 AM firm time on task_start.
 *
 * Mirrors scheduleDueReminder exactly, including the "already past" no-op —
 * back-dating a start date must not fire a reminder for a day that's gone.
 * Returns null when there's nothing to schedule.
 */
async function scheduleStartReminder(db, taskId, startDate) {
  if (!startDate) return null;

  const startDateStr = String(startDate).slice(0, 10);
  const reminderDt   = DateTime.fromISO(`${startDateStr}T08:00:00`, { zone: FIRM_TZ });
  const reminderUTC  = reminderDt.toUTC().toJSDate();

  if (reminderUTC <= new Date()) return null; // already past

  const [result] = await db.query(
    `INSERT INTO scheduled_jobs
       (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
     VALUES ('one_time', ?, 'pending', ?, ?, 2, 120)`,
    [
      reminderUTC,
      `Task start reminder \u2014 task #${taskId}`,
      JSON.stringify({ type: 'task_start_reminder', task_id: taskId })
    ]
  );

  const jobId = result.insertId;
  await db.query('UPDATE tasks SET task_start_job_id = ? WHERE task_id = ?', [jobId, taskId]);
  return jobId;
}

/**
 * Cancel the pending start-reminder job for a task (audit-safe: marks cancelled).
 */
async function cancelStartReminder(db, taskId) {
  const [[task]] = await db.query(
    'SELECT task_start_job_id FROM tasks WHERE task_id = ?',
    [taskId]
  );
  if (!task?.task_start_job_id) return;

  await db.query(
    `UPDATE scheduled_jobs
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = ? AND status = 'pending'`,
    [task.task_start_job_id]
  );
  await db.query('UPDATE tasks SET task_start_job_id = NULL WHERE task_id = ?', [taskId]);
}

/**
 * Cancel the pending due-reminder job for a task (audit-safe: marks cancelled, not deleted).
 */
async function cancelDueReminder(db, taskId) {
  const [[task]] = await db.query(
    'SELECT task_due_job_id FROM tasks WHERE task_id = ?',
    [taskId]
  );
  if (!task?.task_due_job_id) return;

  await db.query(
    `UPDATE scheduled_jobs
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = ? AND status = 'pending'`,
    [task.task_due_job_id]
  );
  await db.query('UPDATE tasks SET task_due_job_id = NULL WHERE task_id = ?', [taskId]);
}


// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS  (fire-and-forget — never throw)
// ─────────────────────────────────────────────────────────────────────────────

async function getFromEmail(db) {
  try {
    const { getSetting } = settings();
    return await getSetting(db, 'email_automations') || 'automations@4lsg.com';
  } catch { return 'automations@4lsg.com'; }
}

async function getSmsFrom(db) {
  try {
    const { getSetting } = settings();
    return (
      await getSetting(db, 'sms_staff_from') ||
      await getSetting(db, 'sms_default_from') ||
      null
    );
  } catch { return null; }
}

/** Email (and optional SMS) to task_to when a task is assigned or transferred. */
async function notifyAssignment(db, task, verb = 'assigned') {
  try {
    const [[toUser]] = await db.query(
      'SELECT email, phone, allow_sms FROM users WHERE user = ?',
      [task.to.id]
    );
    if (!toUser?.email) return;

    const from = await getFromEmail(db);
    const html = buildAssignmentEmail(task, verb);

    await emailSvc().sendEmail(db, {
      from,
      to:      toUser.email,
      subject: `New Task Assigned: ${task.title}`,
      html
    });

    if (toUser.allow_sms && toUser.phone) {
      const smsFrom = await getSmsFrom(db);
      if (smsFrom) {
        const url  = taskActionUrl(task);
        const tail = url ? ` Mark complete: ${url}` : ' Log in to YisraCase.';
        await smsSvc().sendSms(db, smsFrom, toUser.phone,
          `New task assigned to you: "${task.title}".${task.due ? ` Due ${fmtDate(task.due)}.` : ''}${tail}`
        );
      }
    }
  } catch (err) {
    console.error('[TASK] notifyAssignment failed:', err.message);
  }
}

/**
 * Email to task_from when a task is completed (if task_notification = 1).
 * @param {string} [note] optional note left by the assignee — rendered in the email.
 */
async function notifyCompletion(db, task, completedByName, note) {
  try {
    const [[fromUser]] = await db.query(
      'SELECT email FROM users WHERE user = ?',
      [task.from.id]
    );
    if (!fromUser?.email) return;

    const from = await getFromEmail(db);
    const html = buildCompletionEmail(task, completedByName, note);

    await emailSvc().sendEmail(db, {
      from,
      to:      fromUser.email,
      subject: `Task Completed: ${task.title}`,
      html
    });
  } catch (err) {
    console.error('[TASK] notifyCompletion failed:', err.message);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List tasks with filters.
 * status='Incomplete' means Pending + Due Today + Overdue.
 *
 * source filter (additive, optional):
 *   absent / 'all' → no filter
 *   'human'        → task_source IS NULL      (human-created work)
 *   'machine'      → task_source IS NOT NULL  (machine-pushed notices)
 *   anything else  → exact match on task_source (e.g. 'esign')
 *
 * defer filter (additive, optional) — task_start is a "not actionable before"
 * date; NULL means active now:
 *   absent / 'all' → no filter
 *   'active'       → task_start IS NULL OR task_start <= today (firm tz)
 *   'scheduled'    → task_start > today  (deferred, not yet in play)
 */
async function listTasks(db, {
  query       = '',
  status      = 'Incomplete',
  assigned_to = null,
  assigned_by = null,
  link_type   = null,
  link_id     = null,
  source      = null,
  defer       = null,
  limit       = 100,
  offset      = 0
} = {}) {
  const where  = [];
  const params = [];

  // Firm-tz calendar date — the boundary for "has this task started yet".
  // Used by the defer filter AND the ordering clause below, so it is computed
  // once whether or not the caller passed a defer filter.
  const todayFirm = DateTime.now().setZone(FIRM_TZ).toISODate();

  if (status === 'Incomplete') {
    where.push(`t.task_status IN ('Pending', 'Due Today', 'Overdue')`);
  } else if (status && status !== 'All') {
    where.push('t.task_status = ?');
    params.push(status);
  }

  if (source && source !== 'all') {
    if      (source === 'human')   where.push('t.task_source IS NULL');
    else if (source === 'machine') where.push('t.task_source IS NOT NULL');
    else { where.push('t.task_source = ?'); params.push(source); }
  }

  if (defer === 'active') {
    where.push('(t.task_start IS NULL OR t.task_start <= ?)');
    params.push(todayFirm);
  } else if (defer === 'scheduled') {
    where.push('t.task_start > ?');
    params.push(todayFirm);
  }

  if (query) {
    where.push(`(
      t.task_title LIKE ? OR t.task_desc LIKE ?
      OR co.contact_name LIKE ?
      OR ca.case_number LIKE ? OR ca.case_number_full LIKE ?
    )`);
    const q = `%${query}%`;
    params.push(q, q, q, q, q);
  }

  if (assigned_to) { where.push('t.task_to = ?');   params.push(assigned_to); }
  if (assigned_by) { where.push('t.task_from = ?');  params.push(assigned_by); }

  if (link_type && link_id) {
    where.push(`(
      (t.task_link_type = ? AND t.task_link_id = ?)
      OR (t.task_link_type IS NULL AND t.task_link = ?)
    )`);
    params.push(link_type, String(link_id), String(link_id));
  }

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM tasks t
     LEFT JOIN contacts co ON (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (t.task_link_type = 'case'    AND t.task_link_id = ca.case_id)
     ${whereSQL}`,
    params
  );

  const [rows] = await db.query(
    `SELECT
       t.*,
       uf.user AS from_id, uf.user_name AS from_name,
       ut.user AS to_id,   ut.user_name AS to_name,
       co.contact_id, co.contact_name,
       ca.case_id, ca.case_number, ca.case_number_full
     FROM tasks t
     LEFT JOIN users    uf ON t.task_from = uf.user
     LEFT JOIN users    ut ON t.task_to   = ut.user
     LEFT JOIN contacts co ON (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (t.task_link_type = 'case'    AND t.task_link_id = ca.case_id)
     ${whereSQL}
     ORDER BY
       FIELD(t.task_status, 'Overdue','Due Today','Pending','Completed','Deleted'),
       -- Deferred work (task_start in the future) isn't in play yet, so it
       -- sinks below everything actionable within its status group.
       (t.task_start IS NOT NULL AND t.task_start > ?),
       t.task_due IS NULL,      -- MySQL sorts NULL first in ASC; push undated
       t.task_due ASC,          -- (mostly machine notices) BELOW dated work
       t.task_date DESC
     LIMIT ? OFFSET ?`,
    [...params, todayFirm, Number(limit), Number(offset)]
  );

  const data = rows.map(r => shapeRow(r));
  return { data, total };
}

function shapeRow(r) {
  let link = null;
  if      (r.task_link_type === 'contact' || (!r.task_link_type && r.contact_id))
    link = { type: 'contact', id: r.contact_id, title: r.contact_name };
  else if (r.task_link_type === 'case'    || (!r.task_link_type && r.case_id))
    link = { type: 'case', id: r.case_id, title: r.case_number_full || r.case_number || r.case_id };
  else if (r.task_link_type === 'appt')
    link = { type: 'appt', id: r.task_link_id, title: `Appt #${r.task_link_id}` };
  else if (r.task_link_type === 'bill')
    link = { type: 'bill', id: r.task_link_id, title: `Bill #${r.task_link_id}` };
  else if (r.task_link_type === 'event')
    link = { type: 'event', id: r.task_link_id, title: `Event #${r.task_link_id}` };

  return {
    id:      r.task_id,
    status:  r.task_status,
    title:   r.task_title,
    desc:    r.task_desc,
    due:     r.task_due,
    start:   r.task_start,
    created: r.task_date,
    notify:  !!r.task_notification,
    from:    { id: r.from_id, name: r.from_name },
    to:      { id: r.to_id,   name: r.to_name   },
    link,
    action_token: r.task_action_token || null,
    source:       r.task_source || null
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────────

async function getTask(db, taskId) {
  const [[r]] = await db.query(
    `SELECT
       t.*,
       uf.user AS from_id, uf.user_name AS from_name,
       ut.user AS to_id,   ut.user_name AS to_name,
       co.contact_id, co.contact_name,
       ca.case_id, ca.case_number, ca.case_number_full
     FROM tasks t
     LEFT JOIN users    uf ON t.task_from = uf.user
     LEFT JOIN users    ut ON t.task_to   = ut.user
     LEFT JOIN contacts co ON (
       (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
       OR (t.task_link_type IS NULL AND t.task_link = co.contact_id)
     )
     LEFT JOIN cases    ca ON (
       (t.task_link_type = 'case' AND t.task_link_id = ca.case_id)
       OR (t.task_link_type IS NULL AND t.task_link != '' AND (
         t.task_link = ca.case_number OR t.task_link = ca.case_number_full OR t.task_link = ca.case_id
       ))
     )
     WHERE t.task_id = ? LIMIT 1`,
    [taskId]
  );
  return r ? shapeRow(r) : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// HISTORY (E1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audit trail for one task, oldest first.
 *
 * Every logTaskEvent write carries log_data.task_id, so this is the only way
 * to see history for tasks with no contact/case link (44 of 116 rows live).
 * Query plan: idx_log_type narrows log_type='task' to ~100 rows (of ~64k),
 * then the JSON filter runs on that slice — verified via EXPLAIN (ref/const).
 * log_data is a TEXT column holding JSON; rows that fail to parse are
 * surfaced raw rather than dropped (audit trail must not silently thin out).
 *
 * @returns {Promise<Array<{id, date, by:{id,name}, action, note, data}>>}
 */
async function getTaskHistory(db, taskId) {
  const [rows] = await db.query(
    `SELECT l.log_id, l.log_date, l.log_by, u.user_name AS by_name, l.log_data
     FROM log l
     LEFT JOIN users u ON l.log_by = u.user
     WHERE l.log_type = 'task'
       AND JSON_UNQUOTE(JSON_EXTRACT(l.log_data, '$.task_id')) = ?
     ORDER BY l.log_date ASC, l.log_id ASC`,
    [String(taskId)]
  );

  return rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.log_data) || {}; } catch { data = { raw: r.log_data }; }
    const { action = null, note = null, task_id, task_title, ...rest } = data;
    return {
      id:     r.log_id,
      date:   r.log_date,
      by:     { id: r.log_by, name: r.by_name || (r.log_by === 0 ? 'Automation' : null) },
      action,
      note,
      data:   rest   // via, previous_status, changed[], transfer names, …
    };
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a task.
 *
 * @param {object}  db
 * @param {object}  opts
 * @param {number}  [opts.from]                  assigner user id; null → self-assign to `to`
 * @param {number}   opts.to                     assignee user id (required)
 * @param {string}   opts.title                  ≤100 chars (throws above)
 * @param {string}  [opts.desc='']               ≤1000 chars (throws above)
 * @param {string}  [opts.start=null]
 * @param {string}  [opts.due=null]              schedules an 8 AM reminder on that date
 * @param {boolean} [opts.notify=false]          notify the ASSIGNER on completion
 * @param {string}  [opts.link_type=null]        'contact'|'case'|'appt'|'bill'|'event'
 * @param {string}  [opts.link_id=null]
 * @param {string}  [opts.source=null]           tasks.task_source — free-text, ≤50 chars.
 *                                               NULL = human-created work. Non-NULL = a
 *                                               machine-pushed notice ('court_review', …).
 *                                               IMMUTABLE: not in updateTask's ALLOWED set.
 * @param {boolean} [opts.send_assignment_email=true]
 *                                               false → suppress the canned assignment email
 *                                               so the caller can send its own containing
 *                                               action_url. Does NOT suppress the due-date
 *                                               reminder — omit `due` for that.
 *
 * @returns {Promise<{task_id:number, action_token:string, action_url:string}>}
 *
 * Length guards THROW rather than truncate: session sql_mode lacks
 * STRICT_TRANS_TABLES, so an overlong write would land silently truncated.
 * (Enabling strict mode is not an option — /api/intake/case relies on implicit
 * defaults for ~41 NOT-NULL columns.)
 */
async function createTask(db, {
  from,
  to,
  title,
  desc      = '',
  start     = null,
  due       = null,
  notify    = false,
  link_type = null,
  link_id   = null,
  source                = null,
  send_assignment_email = true
}) {
  if (!title) throw new Error('createTask requires title');
  if (!to)    throw new Error('createTask requires to');

  // sql_mode is NOT strict → an overlong value truncates SILENTLY. Throw instead.
  if (String(title).length  > 100)  throw new Error('createTask: title exceeds 100 chars');
  if (String(desc).length   > 1000) throw new Error('createTask: desc exceeds 1000 chars');
  if (source && String(source).length > 50) throw new Error('createTask: source exceeds 50 chars');

  // null/undefined `from` → self-assign to the recipient; a legitimate 0
  // (the automations user) is preserved, NOT coerced to `to`.
  const taskFrom = (from == null) ? to : from;

  // Hoisted (was minted inline in the param array and discarded) so the caller
  // can be handed the token / URL back.
  const actionToken = newActionToken();

  // C2: status computed at write. A task created with a past due date lands
  // Overdue immediately instead of masquerading as Pending until the next
  // 13:00-UTC digest sweep. Undated tasks (all machine notices) still land
  // 'Pending' — computeStatus(null) === 'Pending' — so notice dedupe
  // (esignAlertService et al., all IN-set consumers) is unaffected.
  const initialStatus = computeStatus(due);

  const [result] = await db.query(
    `INSERT INTO tasks
       (task_from, task_to, task_title, task_desc, task_start, task_due,
        task_notification, task_source, task_status, task_date, task_last_update,
        task_link, task_link_type, task_link_id, task_action_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, ?, ?)`,
    [
      taskFrom, to, title, desc,
      start || null, due || null,
      notify ? 1 : 0,
      source || null,
      initialStatus,
      link_id != null ? String(link_id) : '',  // task_link — legacy
      link_type,
      link_id != null ? String(link_id) : null,
      actionToken
    ]
  );

  const taskId = result.insertId;

  // Log creation
  await logTaskEvent(db, taskId, taskFrom, 'created', { assigned_to: to });

  // Non-blocking: notify assignee + schedule due reminder
  setImmediate(async () => {
    try {
      const task = await getTask(db, taskId);
      if (!task) return;
      if (send_assignment_email) await notifyAssignment(db, task);
      // Intentionally NOT gated on send_assignment_email — the reminders are a
      // separate channel. A caller that wants neither email omits `due`/`start`.
      if (due) await scheduleDueReminder(db, taskId, due);
      // Start reminder: the "now it's live" nudge for a deferred task. Skipped
      // when start === due, so a same-day task doesn't fire twice.
      if (start && String(start).slice(0, 10) !== String(due || '').slice(0, 10)) {
        await scheduleStartReminder(db, taskId, start);
      }
    } catch (err) {
      console.error(`[TASK] Post-create side effects failed for task #${taskId}:`, err.message);
    }
  });

  return {
    task_id:      taskId,
    action_token: actionToken,
    action_url:   taskActionUrl({ action_token: actionToken })
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// UPDATE (generic field patch)
// ─────────────────────────────────────────────────────────────────────────────

async function updateTask(db, taskId, fields, actingUserId = 0) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateTask requires at least one field');
  }

  // Throwing allowlist. `task_source` and `task_action_token` are deliberately
  // ABSENT: source is IMMUTABLE after creation (it records which system pushed
  // the notice), and the token is minted once by createTask.
  const ALLOWED = new Set([
    'task_status', 'task_to', 'task_from', 'task_title', 'task_desc',
    'task_start', 'task_due', 'task_notification',
    'task_link', 'task_link_type', 'task_link_id'
  ]);

  const blocked = Object.keys(fields).filter(k => !ALLOWED.has(k));
  if (blocked.length) throw new Error(`updateTask: blocked fields: ${blocked.join(', ')}`);

  // Blank date -> NULL before binding: task_start / task_due are DATE columns
  // and non-strict sql_mode would turn '' into '0000-00-00'. task_id 1039
  // already had both. See lib/blankDateToNull.js.
  const safeFields = blankDatesToNull('tasks', fields);

  // C2: when the due date changes on an OPEN task, recompute the status so
  // the row doesn't sit mislabelled until the next 13:00-UTC digest sweep.
  // Guards, in order of importance:
  //   · terminal statuses are untouchable — editing a due date must NEVER
  //     resurrect a Completed/Deleted task (read current status first);
  //   · an explicitly-passed task_status always wins (no silent override).
  if ('task_due' in safeFields && !('task_status' in safeFields)) {
    const [[cur]] = await db.query(
      'SELECT task_status FROM tasks WHERE task_id = ?', [taskId]
    );
    if (!cur) throw new Error(`Task ${taskId} not found`);
    if (['Pending', 'Due Today', 'Overdue'].includes(cur.task_status)) {
      safeFields.task_status = computeStatus(safeFields.task_due);
    }
  }

  const keys      = Object.keys(safeFields);
  const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
  const values    = [...keys.map(k => safeFields[k]), taskId];

  const [res] = await db.query(
    `UPDATE tasks SET ${setClauses}, task_last_update = NOW() WHERE task_id = ?`,
    values
  );
  if (res.affectedRows === 0) throw new Error(`Task ${taskId} not found`);

  // If due date changed, cancel old reminder and schedule new one
  if ('task_due' in fields) {
    await cancelDueReminder(db, taskId);
    if (fields.task_due) {
      await scheduleDueReminder(db, taskId, fields.task_due).catch(() => {});
    }
  }

  // Same for the start date. Reads the effective due date (the patch's, or
  // the stored one) so the start===due suppression stays correct when only
  // one of the two moves.
  if ('task_start' in safeFields) {
    await cancelStartReminder(db, taskId);
    if (safeFields.task_start) {
      const [[row]] = await db.query('SELECT task_due FROM tasks WHERE task_id = ?', [taskId]);
      const effDue = String(row?.task_due ? new Date(row.task_due).toISOString() : '').slice(0, 10);
      if (String(safeFields.task_start).slice(0, 10) !== effDue) {
        await scheduleStartReminder(db, taskId, safeFields.task_start).catch(() => {});
      }
    }
  }

  await logTaskEvent(db, taskId, actingUserId, 'updated', { changed: keys });

  return getTask(db, taskId);
}


// ─────────────────────────────────────────────────────────────────────────────
// STATUS TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a task Completed.
 *
 * @param {object} db
 * @param {number} taskId
 * @param {number} [actingUserId=0]
 * @param {object} [logExtra={}]  merged into the 'completed' log row's data.
 *                                Conventional keys: `via` ('app'|'email_link'),
 *                                `note` (optional free text from the actor —
 *                                also rendered in the completion email).
 */
async function completeTask(db, taskId, actingUserId = 0, logExtra = {}) {
  const extra = logExtra || {};

  const task = await getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'Completed') throw new Error('Task is already completed');
  if (task.status === 'Deleted')   throw new Error('Cannot complete a deleted task');

  await db.query(
    `UPDATE tasks SET task_status = 'Completed', task_last_update = NOW() WHERE task_id = ?`,
    [taskId]
  );

  await logTaskEvent(db, taskId, actingUserId, 'completed', extra);
  await cancelDueReminder(db, taskId);
  await cancelStartReminder(db, taskId);

  // Notify assigner if task_notification = 1 and assigner ≠ completor
  if (task.notify) {
    const [[actor]] = await db.query('SELECT user_name FROM users WHERE user = ?', [actingUserId]);
    const byName = actor?.user_name || 'A team member';
    notifyCompletion(db, task, byName, extra.note).catch(() => {});
  }

  return getTask(db, taskId);
}

/**
 * Soft-delete a task (status → Deleted). Reversible via reopenTask.
 *
 * This is also the "cancel" verb the public /t/:token/cancel page calls:
 * completed = acted, deleted = dismissed. That pair is the acted-vs-dismissed
 * signal, so no new status value is introduced for cancellation.
 *
 * @param {object} db
 * @param {number} taskId
 * @param {number} [actingUserId=0]
 * @param {object} [logExtra={}]  merged into the 'deleted' log row's data
 *                                ALONGSIDE previous_status. Conventional keys:
 *                                `via` ('app'|'email_link'), `note`.
 *                                Callers passing nothing get the historical
 *                                payload — exactly { previous_status }.
 */
async function deleteTask(db, taskId, actingUserId = 0, logExtra = {}) {
  const extra = logExtra || {};

  const task = await getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'Deleted') throw new Error('Task is already deleted');

  await db.query(
    `UPDATE tasks SET task_status = 'Deleted', task_last_update = NOW() WHERE task_id = ?`,
    [taskId]
  );

  await logTaskEvent(db, taskId, actingUserId, 'deleted', { previous_status: task.status, ...extra });
  await cancelDueReminder(db, taskId);
  await cancelStartReminder(db, taskId);

  return getTask(db, taskId);
}

async function reopenTask(db, taskId, actingUserId = 0) {
  const task = await getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  if (!['Completed', 'Deleted'].includes(task.status)) {
    throw new Error(`Task is already active (${task.status})`);
  }

  const newStatus = computeStatus(task.due);

  await db.query(
    `UPDATE tasks SET task_status = ?, task_last_update = NOW() WHERE task_id = ?`,
    [newStatus, taskId]
  );

  await logTaskEvent(db, taskId, actingUserId, 'reopened', { previous_status: task.status, new_status: newStatus });

  // Re-schedule the due reminder. No date guard here: scheduleDueReminder
  // already no-ops when the 8 AM firm-time instant is past, and the guard
  // this replaced compared UTC calendar days (wrong from a Detroit evening).
  if (task.due) {
    await scheduleDueReminder(db, taskId, task.due).catch(() => {});
  }
  if (task.start && String(task.start).slice(0, 10) !== String(task.due || '').slice(0, 10)) {
    await scheduleStartReminder(db, taskId, task.start).catch(() => {});
  }

  return getTask(db, taskId);
}

/**
 * Reassign a task to a different user.
 * @param {object} db
 * @param {number} taskId
 * @param {number} newUserId
 * @param {number} actingUserId
 */
async function transferTask(db, taskId, newUserId, actingUserId = 0) {
  const task = await getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (['Completed', 'Deleted'].includes(task.status)) {
    throw new Error(`Cannot transfer a ${task.status} task`);
  }

  const [[newUser]] = await db.query(
    'SELECT user, user_name, email FROM users WHERE user = ?',
    [newUserId]
  );
  if (!newUser) throw new Error(`User ${newUserId} not found`);

  const prevTo   = task.to.id;
  const prevName = task.to.name;

  await db.query(
    'UPDATE tasks SET task_to = ?, task_last_update = NOW() WHERE task_id = ?',
    [newUserId, taskId]
  );

  await logTaskEvent(db, taskId, actingUserId, 'transferred', {
    from_user_id:   prevTo,
    from_user_name: prevName,
    to_user_id:     newUserId,
    to_user_name:   newUser.user_name
  });

  // Notify new assignee (non-blocking)
  setImmediate(async () => {
    try {
      const updated = await getTask(db, taskId);
      await notifyAssignment(db, updated, 'transferred to you');
    } catch (err) {
      console.error(`[TASK] Transfer notification failed for task #${taskId}:`, err.message);
    }
  });

  return getTask(db, taskId);
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listTasks,
  getTask,
  getTaskHistory,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  reopenTask,
  transferTask,
  scheduleDueReminder,
  cancelDueReminder,
  scheduleStartReminder,
  cancelStartReminder,
  logTaskEvent,
  // Email builders — exported so job_executor can use them
  buildDueReminderEmail,
  buildStartReminderEmail,
  buildDigestEmail,
  renderDescHtml,
  getFromEmail,
  getSmsFrom,
  fmtDate,
  fmtStampDate
};