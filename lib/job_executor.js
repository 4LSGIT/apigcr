// lib/job_executor.js
const vm = require("vm");
const internalFunctions = require("./internal_functions");
const taskService = require('../services/taskService');
const campaignService = require('../services/campaignService');
const { executeWebhook } = require('./webhookExecutor');

/**
 * Execute one job (webhook, internal_function, custom_code,
 *                   task_due_reminder)
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
    //     equivalent to old axios `response.data`. This preserves
    //     `{{this.output.X}}` placeholder access for existing workflows.
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
            ? ` Complete: ${process.env.APP_URL || 'https://app.4lsg.com'}/t/${task.action_token}`
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

  // NOTE: the 'task_daily_digest' job type was retired in favor of the
  // internalFunctions.run_task_digest path (data.type='internal_function',
  // function_name='run_task_digest'); the recurring "Task Morning Routine"
  // job (id 109) was repointed accordingly. Use run_task_digest for new wiring.

  throw new Error(`Unsupported job type: ${type}`);
}

module.exports = { executeJob };