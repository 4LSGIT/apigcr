// routes/taskActions.js
//
/**
 * Task Action Links (public — no auth)
 * routes/taskActions.js
 *
 * One-click task completion from email/SMS links.
 *
 *   GET  /t/:token              — confirmation landing page (HTML)
 *   POST /t/:token/complete     — mark the task Completed, render result page
 *   GET  /t/:token/status.svg   — live status badge for embedding in emails
 *
 * Security model (deliberate, per Fred): the token authorizes the assignee's
 * complete action. Anyone holding the email holds the token — acceptable for
 * internal staff tasks. Completion via link is attributed to task_to and
 * logged with { via: 'email_link' } so the audit trail distinguishes it.
 *
 * Scanner safety: GET never mutates. Outlook SafeLinks / Gmail scanners
 * prefetch every GET in an email; the mutation lives behind a form POST on
 * the landing page, which scanners don't submit.
 *
 * Badge route returns 200 with a neutral badge for unknown tokens — keeps
 * scanner noise out of error logs and leaks nothing.
 */

const express     = require('express');
const router      = express.Router();
const taskService = require('../services/taskService');

const APP_URL    = process.env.APP_URL || 'https://app.4lsg.com';
const TASK_COLOR = '#312e81';

const STATUS_COLORS = {
  'Pending':   '#4f46e5',
  'Due Today': '#d97706',
  'Overdue':   '#dc2626',
  'Completed': '#059669',
  'Deleted':   '#6b7280'
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fetch a task by its action token. Returns shaped task (getTask) or null. */
async function getTaskByToken(db, token) {
  const [[row]] = await db.query(
    'SELECT task_id FROM tasks WHERE task_action_token = ? LIMIT 1',
    [token]
  );
  if (!row) return null;
  return taskService.getTask(db, row.task_id);
}

/**
 * Page shell — visually consistent with the task emails (indigo header,
 * white card, light footer).
 */
function pageWrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${htmlEscape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:94%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${TASK_COLOR};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">YisraCase Tasks</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="background:#f8f7ff;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">
            YisraCase task action page. <a href="${APP_URL}" style="color:#4f46e5">Log in</a> for full task management.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function metaRow(label, value) {
  return `<tr>
    <td style="padding:5px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top">${label}</td>
    <td style="padding:5px 0;font-size:13px;color:#111827;font-weight:500">${value}</td>
  </tr>`;
}

/** Shared task summary block (title, desc, meta) used on all page states. */
function taskSummaryHtml(task, titleColor = TASK_COLOR) {
  const descBlock = task.desc
    ? `<div style="margin:14px 0;padding:14px 16px;background:#f5f3ff;border-left:3px solid ${TASK_COLOR};
                  border-radius:4px;font-size:14px;color:#374151;line-height:1.6">
         ${htmlEscape(task.desc).replace(/\n/g, '<br>')}
       </div>`
    : '';

  const linkLine = task.link
    ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280">
         Linked to: <strong style="color:#4f46e5">${htmlEscape(task.link.title)}</strong>
       </p>`
    : '';

  return `
    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${titleColor}">${htmlEscape(task.title)}</p>
    ${descBlock}
    ${linkLine}
    <table cellpadding="0" cellspacing="0" style="margin:8px 0 16px">
      ${metaRow('Status',      `<span style="color:${STATUS_COLORS[task.status] || '#6b7280'}">${htmlEscape(task.status)}</span>`)}
      ${metaRow('Assigned to', htmlEscape(task.to.name || '—'))}
      ${metaRow('Assigned by', htmlEscape(task.from.name || '—'))}
      ${metaRow('Due date',    task.due ? taskService.fmtDate(task.due) : 'No due date')}
    </table>`;
}

function notFoundPage() {
  return pageWrap('Link Not Valid', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Link not valid</h2>
    <p style="margin:0;font-size:14px;color:#374151">
      This task link is invalid or no longer exists. Log in to YisraCase to view your tasks.
    </p>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /t/:token — confirmation landing page
// ─────────────────────────────────────────────────────────────────────────────

router.get('/t/:token([A-Za-z0-9_\\-]{10,40})', async (req, res) => {
  try {
    const task = await getTaskByToken(req.db, req.params.token);
    if (!task) return res.status(200).send(notFoundPage());

    let body;

    if (task.status === 'Completed') {
      body = `
        <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Already completed</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">This task has already been marked complete.</p>
        ${taskSummaryHtml(task, '#065f46')}`;
    } else if (task.status === 'Deleted') {
      body = `
        <h2 style="margin:0 0 8px;font-size:22px;color:#6b7280">Task deleted</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">This task has been deleted and can no longer be completed from this link.</p>
        ${taskSummaryHtml(task, '#6b7280')}`;
    } else {
      body = `
        <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Complete this task?</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">
          Review the task below and click the button to mark it complete.
        </p>
        ${taskSummaryHtml(task)}
        <form method="POST" action="${APP_URL}/t/${task.action_token}/complete" style="margin:20px 0 0">
          <button type="submit"
                  style="background:#059669;color:#ffffff;border:none;border-radius:6px;
                         padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer">
            ✓ Mark Complete
          </button>
        </form>`;
    }

    res.set('Cache-Control', 'no-store');
    res.send(pageWrap(`Task: ${task.title}`, body));
  } catch (err) {
    console.error('GET /t/:token error:', err);
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">Please try again, or log in to YisraCase to complete the task.</p>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /t/:token/complete — perform the completion
// ─────────────────────────────────────────────────────────────────────────────

router.post('/t/:token([A-Za-z0-9_\\-]{10,40})/complete', async (req, res) => {
  try {
    const task = await getTaskByToken(req.db, req.params.token);
    if (!task) return res.status(200).send(notFoundPage());

    if (task.status === 'Completed') {
      return res.send(pageWrap('Already Completed', `
        <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Already completed</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">This task was already marked complete.</p>
        ${taskSummaryHtml(task, '#065f46')}`));
    }

    if (task.status === 'Deleted') {
      return res.send(pageWrap('Task Deleted', `
        <h2 style="margin:0 0 8px;font-size:22px;color:#6b7280">Task deleted</h2>
        <p style="margin:0;font-size:14px;color:#374151">This task has been deleted and cannot be completed.</p>`));
    }

    // Attribute the action to the assignee; flag the channel in the log.
    const updated = await taskService.completeTask(
      req.db, task.id, task.to.id, { via: 'email_link' }
    );

    res.send(pageWrap('Task Completed', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Task completed</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">Nice work — the task has been marked complete.</p>
      ${taskSummaryHtml(updated, '#065f46')}`));
  } catch (err) {
    // Race: completed between page load and click → friendly, not an error.
    if (err.message && err.message.includes('already completed')) {
      return res.send(pageWrap('Already Completed', `
        <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Already completed</h2>
        <p style="margin:0;font-size:14px;color:#374151">This task was already marked complete.</p>`));
    }
    console.error('POST /t/:token/complete error:', err);
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">The task could not be completed. Please log in to YisraCase and try there.</p>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /t/:token/status.svg — live status badge for emails
// ─────────────────────────────────────────────────────────────────────────────

function badgeSvg(label, bg) {
  const textWidth = Math.max(40, Math.round(label.length * 7.2));
  const w = textWidth + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${htmlEscape(label)}">
  <rect width="${w}" height="22" rx="11" fill="${bg}"/>
  <text x="${w / 2}" y="15" text-anchor="middle"
        font-family="Segoe UI,Arial,sans-serif" font-size="12" font-weight="600" fill="#ffffff">${htmlEscape(label)}</text>
</svg>`;
}

router.get('/t/:token([A-Za-z0-9_\\-]{10,40})/status.svg', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.type('image/svg+xml');
  try {
    const [[row]] = await req.db.query(
      'SELECT task_status FROM tasks WHERE task_action_token = ? LIMIT 1',
      [req.params.token]
    );
    if (!row) return res.send(badgeSvg('—', '#9ca3af'));

    const status = row.task_status;
    const label  = status === 'Completed' ? '✓ Completed' : status;
    return res.send(badgeSvg(label, STATUS_COLORS[status] || '#6b7280'));
  } catch (err) {
    console.error('GET /t/:token/status.svg error:', err);
    return res.send(badgeSvg('—', '#9ca3af'));
  }
});

module.exports = router;