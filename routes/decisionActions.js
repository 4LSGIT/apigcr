// routes/decisionActions.js
//
/**
 * Decision Action Links (public — no auth)
 * routes/decisionActions.js
 *
 * The response surface for request_decision (lib/internal_functions/decisions.js).
 *
 *   GET  /d/:token          — landing page: question + one button per option
 *   GET  /d/:token/:value   — pre-selected confirmation page for one option
 *                             (what the per-option email buttons link to)
 *   POST /d/:token/respond  — record the choice, resume the workflow
 *
 * Scanner safety (same rule as routes/taskActions.js): GET never mutates.
 * Outlook SafeLinks / Gmail scanners prefetch every GET in an email; the
 * mutation lives behind a form POST, which scanners don't submit. This is
 * why the email buttons land on a confirm page instead of firing directly.
 *
 * Security model (deliberate, mirrors task action links): the token
 * authorizes the recipient's response. Anyone holding the email/SMS holds
 * the token — acceptable for a small trusted firm; link responses are
 * recorded with responded_via='link' and attributed to the stored recipient.
 *
 * Response flow — race analysis lives in decisions.js's header. Order here
 * is load-bearing:
 *   1. Atomic claim   (status pending→responded, expires_at > NOW())
 *   2. Merge variable (result_var = chosen value) — BEFORE flipping the
 *      execution, so even a boundary race with the timeout resume branches
 *      on the response value.
 *   3. Delete the pending timeout workflow_resume job.
 *   4. Guarded flip   (delayed → active at resume_step) + detached advance.
 *   5. Complete paired task, write outcome log (both best-effort).
 *
 * The claim's expires_at > NOW() and the timeout job's scheduled_time <=
 * NOW() are mutually exclusive on the same DB clock, so a response and a
 * timeout can never both win.
 */

const express = require('express');
const router  = express.Router();
const { mergeVariables, advanceWorkflow } = require('../lib/workflow_engine');

// Read per call so live edits of the app_url setting apply without redeploy.
const APP_URL = () => require('../lib/firmConfig').cfg('app_url') || 'https://app.4lsg.com';

const INDIGO = '#312e81';
const GREEN  = '#065f46';
const GREY   = '#6b7280';

const TOKEN_PATTERN = ':token([A-Za-z0-9_\\-]{10,40})';
const VALUE_PATTERN = ':value([A-Za-z0-9_\\-]{1,64})';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deliberately duplicated (self-contained convention — see taskActions.js). */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtFirmTime(dt) {
  const { DateTime } = require('luxon');
  const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';
  const d = dt instanceof Date
    ? DateTime.fromJSDate(dt, { zone: 'utc' })
    : DateTime.fromISO(String(dt), { zone: 'utc' });
  return d.setZone(FIRM_TZ).toFormat("MMM d, yyyy 'at' h:mm a ZZZZ");
}

/** Load a decision row by token with options parsed. Returns row or null. */
async function getDecisionByToken(db, token) {
  const [[row]] = await db.query(
    `SELECT * FROM decision_requests WHERE token = ? LIMIT 1`,
    [token]
  );
  if (!row) return null;
  if (typeof row.options === 'string') {
    try { row.options = JSON.parse(row.options); } catch { row.options = []; }
  }
  if (!Array.isArray(row.options)) row.options = [];
  return row;
}

function isExpired(row) {
  return row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

/** Page shell — visually consistent with the task action pages. */
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
        <td style="background:${INDIGO};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">YisraCase — Decision</span>
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
            YisraCase workflow decision page.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function questionBlock(row, color = INDIGO) {
  const qHtml = htmlEscape(row.question).replace(/\n/g, '<br>');
  return `
    <div style="margin:0 0 18px;padding:14px 16px;background:#f5f3ff;border-left:3px solid ${color};
                border-radius:4px;font-size:15px;color:#111827;line-height:1.6;font-weight:600">
      ${qHtml}
    </div>`;
}

function optionLabel(row, value) {
  const opt = row.options.find(o => o && o.value === value);
  return opt ? opt.label : value;
}

function notFoundPage() {
  return pageWrap('Link Not Valid', `
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Link not valid</h2>
    <p style="margin:0;font-size:14px;color:#374151">
      This decision link is invalid or no longer exists.
    </p>`);
}

function respondedPage(row, { justNow = false } = {}) {
  const label = optionLabel(row, row.response_value);
  const when  = row.responded_at ? fmtFirmTime(row.responded_at) : '';
  return pageWrap(justNow ? 'Response Recorded' : 'Already Answered', `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREEN}">✓ ${justNow ? 'Response recorded' : 'Already answered'}</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">
      ${justNow
        ? 'Thank you — your response has been recorded and the workflow is continuing.'
        : 'This decision has already been answered.'}
    </p>
    ${questionBlock(row, GREEN)}
    <p style="margin:0;font-size:14px;color:#374151">
      Recorded response: <strong style="color:${GREEN}">${htmlEscape(label)}</strong>${when ? ` <span style="color:${GREY}">(${htmlEscape(when)})</span>` : ''}
    </p>`);
}

function expiredPage(row) {
  return pageWrap('Request Expired', `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">Request expired</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">
      The response window for this decision closed
      ${htmlEscape(fmtFirmTime(row.expires_at))}. The workflow has continued with its default action,
      so responses can no longer be recorded here.
    </p>
    ${questionBlock(row, GREY)}`);
}

function cancelledPage(row) {
  return pageWrap('No Longer Needed', `
    <h2 style="margin:0 0 8px;font-size:22px;color:${GREY}">No longer needed</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#374151">
      This decision request was cancelled — the workflow that asked it is no longer waiting.
    </p>
    ${questionBlock(row, GREY)}`);
}

/** Route a non-pending (or expired-pending) row to the right terminal page. */
function terminalPage(row) {
  if (row.status === 'responded') return respondedPage(row);
  if (row.status === 'cancelled') return cancelledPage(row);
  // timed_out, or still-pending-but-past-expiry (cleanup job hasn't fired yet)
  return expiredPage(row);
}

/**
 * Outcome log row. Duplicated from lib/internal_functions/decisions.js
 * (self-contained convention). Keep them in sync.
 */
async function logDecisionOutcome(db, row, { outcome, value = null, label = null, via = null }) {
  const logService = require('../services/logService');
  const q = String(row.question || '').replace(/\s+/g, ' ').slice(0, 200);
  let message;
  if (outcome === 'responded') {
    message = `Decision "${q}" — responded "${label || value}" (${value})${via ? ` via ${via}` : ''}`;
  } else {
    message = `Decision "${q}" — no response by deadline; defaulted to "${row.timeout_value}"`;
  }
  const entry = {
    type: 'note',
    by: outcome === 'responded' ? (row.recipient_user_id || 0) : 0,
    subject: 'Workflow decision',
    message,
    data: {
      decision_request_id: row.id,
      workflow_execution_id: row.workflow_execution_id,
      outcome,
      ...(value != null && { value }),
    },
  };
  const [[exec]] = await db.query(
    `SELECT contact_id FROM workflow_executions WHERE id = ?`,
    [row.workflow_execution_id]
  );
  if (exec?.contact_id) {
    entry.link_type = 'contact';
    entry.link_id   = exec.contact_id;
  }
  await logService.createLogEntry(db, entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /d/:token — landing page (all options)
// ─────────────────────────────────────────────────────────────────────────────

router.get(`/d/${TOKEN_PATTERN}`, async (req, res) => {
  try {
    const row = await getDecisionByToken(req.db, req.params.token);
    if (!row) return res.status(200).send(notFoundPage());

    res.set('Cache-Control', 'no-store');

    if (row.status !== 'pending' || isExpired(row)) {
      return res.send(terminalPage(row));
    }

    // ONE form, one submit button per option (name="value" routes the choice).
    // No JS required; the POST is the only mutation.
    const base = `${APP_URL()}/d/${row.token}`;
    const buttons = row.options.map(o => `
      <button type="submit" name="value" value="${htmlEscape(o.value)}"
              style="background:${INDIGO};color:#ffffff;border:none;border-radius:6px;
                     padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;
                     margin:0 10px 10px 0">
        ${htmlEscape(o.label)}
      </button>`).join('');

    const body = `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Your decision is needed</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">
        Review the question below and choose a response. Your choice is recorded immediately
        and the workflow continues with it.
      </p>
      ${questionBlock(row)}
      <form method="POST" action="${base}/respond" style="margin:20px 0 0">
        ${buttons}
      </form>
      <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">
        This request expires ${htmlEscape(fmtFirmTime(row.expires_at))}. If no response is received
        by then, the default action will be taken automatically.
      </p>`;

    res.send(pageWrap('Decision needed', body));
  } catch (err) {
    console.error('GET /d/:token error:', err);
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">Please try the link again in a moment.</p>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /d/:token/:value — pre-selected confirmation page
// (what the per-option email buttons link to — still zero mutation)
// ─────────────────────────────────────────────────────────────────────────────

router.get(`/d/${TOKEN_PATTERN}/${VALUE_PATTERN}`, async (req, res) => {
  try {
    const row = await getDecisionByToken(req.db, req.params.token);
    if (!row) return res.status(200).send(notFoundPage());

    res.set('Cache-Control', 'no-store');

    if (row.status !== 'pending' || isExpired(row)) {
      return res.send(terminalPage(row));
    }

    const value = req.params.value;
    const opt = row.options.find(o => o && o.value === value);
    if (!opt) {
      // Unknown value — fall back to the full landing page choices.
      return res.redirect(302, `${APP_URL()}/d/${row.token}`);
    }

    const base = `${APP_URL()}/d/${row.token}`;
    const body = `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Confirm your response</h2>
      ${questionBlock(row)}
      <p style="margin:0 0 18px;font-size:15px;color:#374151">
        You selected: <strong style="color:${INDIGO};font-size:16px">${htmlEscape(opt.label)}</strong>
      </p>
      <form method="POST" action="${base}/respond" style="margin:0">
        <input type="hidden" name="value" value="${htmlEscape(opt.value)}">
        <button type="submit"
                style="background:#059669;color:#ffffff;border:none;border-radius:6px;
                       padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer">
          ✓ Confirm: ${htmlEscape(opt.label)}
        </button>
        <a href="${base}"
           style="display:inline-block;margin-left:12px;color:${GREY};font-size:14px;
                  text-decoration:underline">Choose a different option</a>
      </form>
      <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">
        Nothing is recorded until you confirm. Expires ${htmlEscape(fmtFirmTime(row.expires_at))}.
      </p>`;

    res.send(pageWrap('Confirm your response', body));
  } catch (err) {
    console.error('GET /d/:token/:value error:', err);
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">Please try the link again in a moment.</p>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /d/:token/respond — record the choice, resume the workflow
// ─────────────────────────────────────────────────────────────────────────────

router.post(`/d/${TOKEN_PATTERN}/respond`, async (req, res) => {
  const db = req.db;
  try {
    const row = await getDecisionByToken(db, req.params.token);
    if (!row) return res.status(200).send(notFoundPage());

    const value = String(req.body?.value ?? '').trim();
    const opt = row.options.find(o => o && o.value === value);
    if (!opt) {
      return res.status(200).send(pageWrap('Invalid Option', `
        <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Invalid option</h2>
        <p style="margin:0 0 18px;font-size:14px;color:#374151">
          That option isn't part of this decision.
          <a href="${APP_URL()}/d/${row.token}" style="color:#4f46e5">Choose from the available options.</a>
        </p>`));
    }

    // 1. ATOMIC CLAIM — the single arbiter. expires_at > NOW() is mutually
    //    exclusive with the timeout job's scheduled_time <= NOW() fire
    //    condition on the same DB clock.
    const [claim] = await db.query(
      `UPDATE decision_requests
          SET status = 'responded', response_value = ?, responded_at = NOW(),
              responded_via = 'link', updated_at = NOW()
        WHERE id = ? AND status = 'pending' AND expires_at > NOW()`,
      [value, row.id]
    );

    if (claim.affectedRows === 0) {
      // Lost — already responded, expired, or cancelled. Re-read for honesty.
      const fresh = await getDecisionByToken(db, req.params.token);
      return res.send(fresh ? terminalPage(fresh) : notFoundPage());
    }

    // 2. Merge the chosen value BEFORE flipping the execution — a boundary
    //    race with the timeout resume then still branches on this value.
    await mergeVariables(row.workflow_execution_id, { [row.result_var]: value }, db);

    // 3. Kill the pending timeout resume so it can't fire later.
    await db.query(
      `DELETE FROM scheduled_jobs
        WHERE type = 'workflow_resume' AND workflow_execution_id = ? AND status = 'pending'`,
      [row.workflow_execution_id]
    );

    // 4. Guarded flip + detached advance. affectedRows=0 means the execution
    //    isn't waiting anymore (operator moved it, or a boundary race) — the
    //    response is still recorded; the variable merge above already made it
    //    visible to whatever runs next.
    const [flip] = await db.query(
      `UPDATE workflow_executions
          SET status = 'active', current_step_number = ?, updated_at = NOW()
        WHERE id = ? AND status = 'delayed'`,
      [row.resume_step, row.workflow_execution_id]
    );

    if (flip.affectedRows === 1) {
      (async () => {
        try {
          const result = await advanceWorkflow(row.workflow_execution_id, db);
          console.log(`[DECISION] Execution ${row.workflow_execution_id} resumed after decision ${row.id}: ${result.status}`);
        } catch (err) {
          console.error(`[DECISION] Resume advance failed for execution ${row.workflow_execution_id}:`, err.message);
        }
      })();
    } else {
      console.warn(`[DECISION] Decision ${row.id} recorded but execution ${row.workflow_execution_id} was not 'delayed' — no resume issued`);
    }

    // 5. Best-effort side effects — never fail the response over these.
    if (row.paired_task_id) {
      try {
        await require('../services/taskService').completeTask(
          db, row.paired_task_id, row.recipient_user_id || 0, { via: 'decision_link', note: `Responded: ${opt.label}` }
        );
      } catch (err) {
        console.warn(`[DECISION] Could not complete paired task ${row.paired_task_id}:`, err.message);
      }
    }
    try {
      await logDecisionOutcome(db, row, { outcome: 'responded', value, label: opt.label, via: 'link' });
    } catch (err) {
      console.warn(`[DECISION] Outcome log failed for decision ${row.id}:`, err.message);
    }

    console.log(`[DECISION] Decision ${row.id} responded "${value}" (exec ${row.workflow_execution_id})`);

    // Render the receipt from the updated state.
    row.status = 'responded';
    row.response_value = value;
    row.responded_at = new Date();
    res.send(respondedPage(row, { justNow: true }));
  } catch (err) {
    console.error('POST /d/:token/respond error:', err);
    res.status(500).send(pageWrap('Error', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151">
        Your response may not have been recorded. Please try again from the link.
      </p>`));
  }
});

module.exports = router;
