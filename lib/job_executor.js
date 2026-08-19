// lib/job_executor.js
const vm = require("vm");
const internalFunctions = require("./internal_functions");
const taskService = require('../services/taskService');
const campaignService = require('../services/campaignService');
const { executeWebhook } = require('./webhookExecutor');

/**
 * ── CUSTOM_CODE SCRIPT TIMEOUT ──────────────────────────────────────────────
 * vm's `timeout` is a WALL-CLOCK watchdog, not a CPU-time budget. That
 * distinction is the whole reason this constant exists.
 *
 * Workflow steps run in two very different places:
 *   - inside an HTTP request (manual run, draft test-run) — Cloud Run gives
 *     the instance a full vCPU and these scripts finish in single-digit ms;
 *   - detached AFTER the response was sent (actionDispatchers.dispatchWorkflow
 *     fires advanceWorkflow without awaiting it). Under Cloud Run's default
 *     request-based billing an instance is throttled hard between requests,
 *     so the same script can take 10-100x longer in wall-clock terms.
 *
 * Measured 2026-08-19 on wf27 step 1 (a pure string formatter, ~2ms of real
 * work): the detached run blew the old hardcoded 5000ms ceiling and aborted
 * the execution, dropping an inbound lead. The SAME step, SAME input, re-run
 * manually through the UI 40 minutes later: 141ms. Nothing about the script
 * changed — only whether a request was in flight.
 *
 * A generous ceiling costs nothing when the work is fast and turns a hard
 * failure into a slow success when it isn't. The real fix for background work
 * is instance-based billing on the service (`--no-cpu-throttling`); if that is
 * enabled this simply never binds.
 *
 * Per-step override: set `timeout_ms` in the step config, same key the webhook
 * step already uses. Capped so a runaway script can't pin the event loop for
 * longer than a Cloud Run request could survive anyway.
 */
const CUSTOM_CODE_DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CUSTOM_CODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60000;
})();
const CUSTOM_CODE_MAX_TIMEOUT_MS = 300000;

/**
 * Execute one job (webhook, internal_function, custom_code,
 *                   task_due_reminder, task_start_reminder)
 * Used by both standalone scheduler and workflow steps
*
* apparently, sequence_step type is handled by process_jobs as a special case
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
    // Webhook credential injection slice — delegated to the shared
    // lib/webhookExecutor so workflows + scheduled-job webhook flavor get
    // credential injection, configurable timeout (default 30s, capped at
    // 120s), and JSON response parsing for free.
    //
    // Backward-compat notes:
    //   - method default stays 'GET' here (legacy executeJob default), passed
    //     explicitly so the helper's own 'POST' default doesn't kick in.
    //   - return value is `result.data` — the parsed JSON body or raw text,
    //     equivalent to old axios `response.data`.
    //
    //     PLACEHOLDER ACCESS IS `{{this.X}}`, NOT `{{this.output.X}}`. This
    //     line previously claimed the latter; it is wrong and cost real
    //     debugging time (2026-08-14). The value returned here becomes the
    //     step's rawResult, and workflow_engine sets `context.this = rawResult`
    //     before resolving set_vars — so for a webhook step `this` IS the
    //     response body. (`{{this.output.X}}` works for INTERNAL_FUNCTION
    //     steps only, whose rawResult is `{success, output, set_vars}`.)
    //     Live proof: wf16 step 2 `{{this.records.0.result}}`, wf15 step 2
    //     `{{this.to.0.phoneNumber}}`, wf40 step 3 `{{this}}`. Getting this
    //     wrong fails SILENTLY — an unresolved workflow placeholder resolves
    //     to '' (see manual/03-YisraFlow/06-variables-templating.md).
    //   - timeout was previously hardcoded at 10s. Jobs without an explicit
    //     `timeout_ms` now run with the helper's 30s default. If you need
    //     the old 10s ceiling, set `timeout_ms: 10000` in the job data.
    const { url, method = "GET", headers = {}, body, credential_id, timeout_ms } = jobData;
    if (!url) throw new Error('Webhook job missing "url"');

    const result = await executeWebhook(db, {
      url, method, headers, body, credential_id, timeout_ms,
    });

    return result.data;
  }

  if (type === "internal_function") {
    const { function_name, params = {} } = jobData;
    const fn = internalFunctions[function_name];
    if (!fn) throw new Error(`Unknown internal function: ${function_name}`);
    return await fn(params, db);
  }

  if (type === "custom_code") {
    const { code, input = {}, timeout_ms } = jobData;
    if (!code) throw new Error('Custom code job missing "code"');

    const sandbox = {
      input,
      console: {
        log: (...args) => console.log(`[CUSTOM CODE ${job.id}]`, ...args),
      },
    };

    // Per-step override, else env/default. Non-positive / NaN → default.
    // See CUSTOM_CODE_DEFAULT_TIMEOUT_MS above for why this is not 5000.
    const rawTimeout = Number(timeout_ms);
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), CUSTOM_CODE_MAX_TIMEOUT_MS)
      : CUSTOM_CODE_DEFAULT_TIMEOUT_MS;

    const startedAt = Date.now();
    const script = new vm.Script(code);
    try {
      return script.runInNewContext(sandbox, { timeout });
    } catch (err) {
      // vm's timeout error names the limit but not how long the ceiling
      // actually was in a throttled instance, which is the diagnostic that
      // matters. Re-throw enriched; the message lands in
      // workflow_execution_steps.error_message.
      if (/Script execution timed out/i.test(err.message || '')) {
        const e = new Error(
          `${err.message} (elapsed ${Date.now() - startedAt}ms). ` +
          `Pure-CPU scripts that exceed this are almost always a throttled ` +
          `Cloud Run instance, not slow code — check whether the step ran detached.`
        );
        e.code = 'CUSTOM_CODE_TIMEOUT';
        throw e;
      }
      throw err;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  // campaign_send
  //
  // Sends one campaign message to one contact.
  // Created by campaignService.createCampaign() — one job per contact.
  // All logic lives in campaignService.executeSend().
  // ─────────────────────────────────────────────────────────────────────────
 
  if (type === 'campaign_send') {
    const { campaign_id, contact_id } = jobData;
    if (!campaign_id) throw new Error('campaign_send: missing campaign_id');
    if (!contact_id)  throw new Error('campaign_send: missing contact_id');

    // Pass attempt context so executeSend can distinguish "transient — let
    // job system retry" from "final attempt — record as failed and stop."
    // job.attempts is the number of PRIOR attempts (0 on first run, 1 after
    // first retry, etc.), so the current attempt is attempts + 1.
    const attempt     = (job.attempts || 0) + 1;
    const maxAttempts = job.max_attempts || 1;

    return await campaignService.executeSend(db, campaign_id, contact_id, { attempt, maxAttempts });
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
          const actionUrl = task.action_token
            ? ` Mark complete: ${require('./firmConfig').cfg('app_url') || 'https://app.4lsg.com'}/t/${task.action_token}`
            : ' Log in to YisraCase to complete it.';
          await require('../services/phoneService').sendSms(db, smsFrom, toUser.phone,
            `Task due today: "${task.title}".${actionUrl}`
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
  // task_start_reminder
  //
  // Fires at 8 AM on the task's START date — the moment a deferred task
  // becomes live. Until then run_task_digest suppresses it, so this is the
  // assignee's first notice since the assignment email. Same skip rules as
  // task_due_reminder.
  // ─────────────────────────────────────────────────────────────────────────

  if (type === 'task_start_reminder') {
    const { task_id } = jobData;
    if (!task_id) throw new Error('task_start_reminder: missing task_id');

    const task = await taskService.getTask(db, task_id);

    if (!task) {
      console.log(`[TASK START] Task #${task_id} not found — skipping`);
      return { skipped: true, reason: 'task not found' };
    }

    if (['Completed', 'Deleted'].includes(task.status)) {
      console.log(`[TASK START] Task #${task_id} already ${task.status} — skipping`);
      return { skipped: true, reason: `task already ${task.status}` };
    }

    const [[toUser]] = await db.query(
      'SELECT email, phone, allow_sms FROM users WHERE user = ?',
      [task.to.id]
    );

    if (!toUser?.email) {
      console.log(`[TASK START] No email for user ${task.to.id} — skipping`);
      return { skipped: true, reason: 'no email for assignee' };
    }

    const from = await taskService.getFromEmail(db);
    const html = taskService.buildStartReminderEmail(task);

    await require('../services/emailService').sendEmail(db, {
      from,
      to:      toUser.email,
      subject: `\u{1F514} Task Starts Today: ${task.title}`,
      html
    });

    if (toUser.allow_sms && toUser.phone) {
      try {
        const smsFrom = await taskService.getSmsFrom(db);
        if (smsFrom) {
          const actionUrl = task.action_token
            ? ` Mark complete: ${require('./firmConfig').cfg('app_url') || 'https://app.4lsg.com'}/t/${task.action_token}`
            : ' Log in to YisraCase to complete it.';
          await require('../services/phoneService').sendSms(db, smsFrom, toUser.phone,
            `Task starts today: "${task.title}".${actionUrl}`
          );
        }
      } catch (smsErr) {
        console.error(`[TASK START] SMS failed for task #${task_id}:`, smsErr.message);
      }
    }

    console.log(`[TASK START] Sent start reminder for task #${task_id} to ${toUser.email}`);
    return { task_id, sent_to: toUser.email, sms: !!(toUser.allow_sms && toUser.phone) };
  }

  // NOTE: the 'task_daily_digest' job type was retired in favor of the
  // internalFunctions.run_task_digest path (data.type='internal_function',
  // function_name='run_task_digest'); the recurring "Task Morning Routine"
  // job (id 109) was repointed accordingly. Use run_task_digest for new wiring.

  throw new Error(`Unsupported job type: ${type}`);
}

module.exports = { executeJob };