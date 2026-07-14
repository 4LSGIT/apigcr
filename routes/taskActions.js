// routes/taskActions.js
//
/**
 * Task Action Links (public — no auth)
 * routes/taskActions.js
 *
 * One-click task actions from email/SMS links.
 *
 *   GET  /t/:token              — confirmation landing page (HTML)
 *   POST /t/:token/complete     — mark the task Completed, render result page
 *   POST /t/:token/cancel       — dismiss the task (soft delete), render result page
 *   GET  /t/:token/status.svg   — live status badge for embedding in emails
 *
 * Two exits, deliberately:
 *   completed = acted, canceled = dismissed. Cancel is the user-facing verb;
 *   internally it is taskService.deleteTask (soft, reversible via reopenTask).
 *   No new task_status value exists for "canceled" — Deleted IS canceled.
 *   Without this exit the only honest way to clear a task you were never going
 *   to do was to lie and mark it complete, which poisons the metric.
 *
 * The note:
 *   Both actions carry an OPTIONAL free-text note (one shared <textarea>, two
 *   submit buttons with `formaction`). It is clamped to 500 chars server-side
 *   (cleanNote) and stored inside the log row's data as `note` — not a column.
 *   On complete, the note is also rendered in the completion email to the
 *   assigner. Empty/whitespace → the key is omitted entirely, never note:"".
 *
 * Security model (deliberate, per Fred): the token authorizes the assignee's
 * complete/cancel action. Anyone holding the email holds the token — acceptable
 * for internal staff tasks. The action via link is attributed to task_to and
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
const GREY       = '#6b7280';

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

/**
 * Normalize the optional note from a form POST.
 *
 * Strips control chars (keeps \t \n \r), trims, and CLAMPS to 500 chars —
 * deliberately slicing rather than throwing: this is a human textarea behind
 * an unauthenticated link, and a 500-char ceiling is a display concern, not a
 * validation error. A 501-char note should still cancel the task.
 *
 * Returns null for absent/empty/whitespace-only input so callers can do
 * `...(note && { note })` and never write note:"" into the log payload.
 */
function cleanNote(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, 500) : null;
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

/**
 * Echo the note the user just submitted back on the result page, so the page
 * is a receipt: they can see what was recorded (and that it was recorded).
 * Same escape-then-<br> order as everywhere else.
 */
function noteEchoHtml(note) {
  if (!note) return '';
  return `
    <div style="margin:0 0 16px;padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;
                border-radius:4px;font-size:13px;color:#374151;line-height:1.6">
      <div style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;
                  text-transform:uppercase;color:#9ca3af">Your note</div>
      ${htmlEscape(note).replace(/\n/g, '<br>')}
    </div>`;
}

function notFoundPage() {
  return pageWrap('Link Not Valid', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Link not valid</h2>
    <p style="margin:0;font-size:14px;color:#374151">
      This task link is invalid or no longer exists. Log in to YisraCase to view your tasks.
    </p>`);
}

/** Shared "nothing to do — it was already completed" page. */
function alreadyCompletedPage(task) {
  return pageWrap('Already Completed', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Already completed</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">This task was already marked complete.</p>
    ${task ? taskSummaryHtml(task, '#065f46') : ''}`);
}

/** Shared "nothing to do — it was already canceled" page. */
function alreadyCanceledPage(task) {
  return pageWrap('Already Canceled', `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Task already canceled</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">
      This task was already canceled and is no longer in the queue.
    </p>
    ${task ? taskSummaryHtml(task, GREY) : ''}`);
}

function errorPage(what) {
  return pageWrap('Error', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
    <p style="margin:0;font-size:14px;color:#374151">The task could not be ${what}. Please log in to YisraCase and try there.</p>`);
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
        <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Task canceled</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">This task has been canceled and can no longer be acted on from this link.</p>
        ${taskSummaryHtml(task, GREY)}`;
    } else {
      // ONE form, TWO submit buttons. `formaction` (HTML5 attribute on the
      // button — not scripting) routes the POST per-button, so a single shared
      // <textarea> can feed either verb without JS. The form's own `action`
      // is the complete route as the belt-and-braces default.
      //
      // The Cancel button's onclick=confirm() is progressive enhancement only:
      // with JS off it simply submits, which is still the correct verb.
      const base = `${APP_URL}/t/${task.action_token}`;
      body = `
        <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Complete this task?</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">
          Review the task below, then mark it complete — or cancel it if it's not needed.
        </p>
        ${taskSummaryHtml(task)}
        <form method="POST" action="${base}" style="margin:20px 0 0">
          <label for="note" style="display:block;font-size:12px;font-weight:600;color:#6b7280;
                                   letter-spacing:.5px;margin:0 0 6px">Note (optional)</label>
          <textarea id="note" name="note" rows="2" maxlength="500"
                    placeholder="Optional note…"
                    style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;
                           font-family:inherit;color:#111827;border:1px solid #d1d5db;
                           border-radius:6px;resize:vertical;margin:0 0 16px"></textarea>
          <button type="submit" formaction="${base}/complete"
                  style="background:#059669;color:#ffffff;border:none;border-radius:6px;
                         padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer">
            ✓ Mark Complete
          </button>
          <button type="submit" formaction="${base}/cancel"
                  onclick="return confirm('Cancel this task? It will be removed from the queue.')"
                  style="background:#ffffff;color:${GREY};border:1px solid #d1d5db;border-radius:6px;
                         padding:14px 22px;font-size:15px;font-weight:600;cursor:pointer;
                         margin-left:10px">
            Cancel Task
          </button>
          <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">
            Canceling removes the task from the queue. It can be reopened by logging in.
          </p>
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
  const note = cleanNote(req.body?.note);
  try {
    const task = await getTaskByToken(req.db, req.params.token);
    if (!task) return res.status(200).send(notFoundPage());

    if (task.status === 'Completed') return res.send(alreadyCompletedPage(task));

    if (task.status === 'Deleted') {
      return res.send(pageWrap('Task Canceled', `
        <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Task canceled</h2>
        <p style="margin:0;font-size:14px;color:#374151">This task has been canceled and cannot be completed.</p>`));
    }

    // Attribute the action to the assignee; flag the channel in the log.
    // `note` is omitted entirely when empty — never written as note:"".
    const updated = await taskService.completeTask(
      req.db, task.id, task.to.id, { via: 'email_link', ...(note && { note }) }
    );

    res.send(pageWrap('Task Completed', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Task completed</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">Nice work — the task has been marked complete.</p>
      ${taskSummaryHtml(updated, '#065f46')}
      ${noteEchoHtml(note)}`));
  } catch (err) {
    // Races between page load and click → friendly, not an error.
    if (err.message && err.message.includes('already completed')) {
      return res.send(alreadyCompletedPage(null));
    }
    // Now genuinely reachable: someone canceled it from the other button /
    // from the app while this page sat open.
    if (err.message && err.message.includes('Cannot complete a deleted task')) {
      return res.send(alreadyCanceledPage(null));
    }
    console.error('POST /t/:token/complete error:', err);
    res.status(500).send(errorPage('completed'));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /t/:token/cancel — dismiss the task (soft delete)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/t/:token([A-Za-z0-9_\\-]{10,40})/cancel', async (req, res) => {
  const note = cleanNote(req.body?.note);
  try {
    const task = await getTaskByToken(req.db, req.params.token);
    if (!task) return res.status(200).send(notFoundPage());

    // A Completed task is NOT cancelable from a link. deleteTask itself permits
    // deleting a Completed task — legitimate in-app (an admin cleaning up),
    // wrong from an email link where it would silently erase a done result.
    // Guard here, in the route; service semantics stay untouched.
    if (task.status === 'Completed') {
      return res.send(pageWrap('Already Completed', `
        <h2 style="margin:0 0 8px;font-size:22px;color:#065f46">✓ Already completed</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">
          This task was completed before you canceled it, so nothing was changed.
        </p>
        ${taskSummaryHtml(task, '#065f46')}`));
    }

    if (task.status === 'Deleted') return res.send(alreadyCanceledPage(task));

    const updated = await taskService.deleteTask(
      req.db, task.id, task.to.id, { via: 'email_link', ...(note && { note }) }
    );

    res.send(pageWrap('Task Canceled', `
      <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Task canceled</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        The task has been removed from the queue.
      </p>
      ${taskSummaryHtml(updated, GREY)}
      ${noteEchoHtml(note)}
      <p style="margin:4px 0 0;font-size:13px;color:#9ca3af">
        Canceled by mistake? <a href="${APP_URL}" style="color:#4f46e5">Log in to YisraCase</a> to reopen it.
      </p>`));
  } catch (err) {
    // Race: canceled between page load and click → friendly, not an error.
    if (err.message && err.message.includes('already deleted')) {
      return res.send(alreadyCanceledPage(null));
    }
    console.error('POST /t/:token/cancel error:', err);
    res.status(500).send(errorPage('canceled'));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /t/:token/status.svg — live status badge for emails
// ─────────────────────────────────────────────────────────────────────────────

function badgeSvg(label, bg, withCheck = false) {
  const textWidth = Math.max(40, Math.round(label.length * 7.2));
  const checkW    = withCheck ? 16 : 0;
  const w         = textWidth + 24 + checkW;
  const checkPath = withCheck
    ? `<path d="M10 11.5 l3.5 3.5 l6.5 -7" stroke="#ffffff" stroke-width="2.5"
             fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${htmlEscape(label)}">
  <rect width="${w}" height="22" rx="11" fill="${bg}"/>
  ${checkPath}
  <text x="${12 + checkW + textWidth / 2}" y="15" text-anchor="middle"
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
    return res.send(badgeSvg(status, STATUS_COLORS[status] || '#6b7280', status === 'Completed'));
  } catch (err) {
    console.error('GET /t/:token/status.svg error:', err);
    return res.send(badgeSvg('—', '#9ca3af'));
  }
});

module.exports = router;