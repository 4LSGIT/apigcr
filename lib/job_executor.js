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
 *     used to fire advanceWorkflow without awaiting it; since the 2026-08
 *     background-CPU slice, starts are queued and advances run request-bound
 *     inside /process-jobs — except POST /workflows/:id/start and
 *     /executions/:id/resume, which still detach advanceWorkflow after their
 *     202; this ceiling stays as defense-in-depth). Under
 *     Cloud Run's default request-based billing an instance is throttled hard
 *     between requests, so the same script can take 10-100x longer in
 *     wall-clock terms.
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

// A custom_code step runs in a forked child, never in this process.
// lib/customCodeRunner.js carries the reasoning and the limits; the short
// version is that `vm` is not a security boundary, and in-process an escape
// reached `process.env` and the app's DB credentials. The child is given no
// environment, so an escape finds no secrets there.
//
// NOT containment: the child keeps its own filesystem and outbound network,
// and on Cloud Run that includes the instance metadata server, whose
// service-account token is plausibly worth more than the DB password. The
// hardening below (no mainModule to require through, outbound network
// refused) raises the cost; only an isolate with no reachable host realm
// (isolated-vm) or egress restriction closes it. Recorded in ref/plans.md.
//
// execArgv is inherited on purpose: the Dockerfile's
// --enable-experimental-regexp-engine is load-bearing, and inheriting it
// keeps a step's own regexes behaving exactly as they do in-process today.
// Grace on top of the vm's own ceiling before the parent kills the child. The
// vm timeout cannot interrupt a script that escaped into async work; a kill
// can. This is a backstop: nothing reachable from the sandbox today can
// outlive the vm timeout, so it has no behavioural test — only the options
// below are asserted.
const CUSTOM_CODE_KILL_GRACE_MS = 2000;

// The child's options are a named value so they can be asserted directly. The
// security properties here cannot be observed from inside the sandbox — a
// sandbox that could see its own `process.env` would be the bug — so the test
// checks the options rather than printing a probe and hoping. Defined once in
// lib/customCodeRunner.js and shared with lib/guestCode.js (trigger / ingest /
// hook code bodies), so the two fork sites cannot drift apart.
const { customCodeChildOptions } = require('./customCodeRunner.js');

function runCustomCode({ code, input, timeout, jobId, engine }) {
  const { fork } = require('child_process');
  const runner = require.resolve('./customCodeRunner.js');
  const { revive } = require('./customCodeRunner.js');

  let inputJson;
  try {
    inputJson = JSON.stringify(input === undefined ? {} : input);
  } catch (err) {
    return Promise.reject(new Error(`custom code input could not be serialized: ${err.message}`));
  }

  return new Promise((resolve, reject) => {
    // Refuse the require() an escaped script would reach for, and refuse
    // outbound sockets, before the step's code runs.
    const child = fork(runner, ['--custom-code-child'], customCodeChildOptions());

    // The vm timeout cannot interrupt a script that escaped into async work;
    // killing the child can. Strictly stronger than the in-process ceiling.
    let settled = false;
    // Deterministic teardown on EVERY path. A child left connected keeps an
    // IPC handle open, which is enough to stop the process that forked it from
    // exiting — under jest that killed the worker and failed an unrelated
    // suite with empty error bodies, while this suite passed on its own.
    const finish = (fn) => {
      if (settled) return false;
      settled = true;
      clearTimeout(killAt);
      try { if (child.connected) child.disconnect(); } catch (_) { /* already gone */ }
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      child.unref();
      fn();
      return true;
    };

    const killAt = setTimeout(() => finish(() => reject(timeoutError(timeout, timeout))),
      timeout + CUSTOM_CODE_KILL_GRACE_MS);

    child.on('message', (out) => {
      finish(() => {
        for (const line of (out && out.logs) || []) console.log(`[CUSTOM CODE ${jobId}]`, line);
        // A throw here is inside an IPC listener, so nothing catches it and
        // server.js's uncaughtException handler exits the process. A final
        // value JSON cannot carry (a function, a symbol) arrives with no
        // valueJson: that is a step error, never a parse of undefined.
        if (out && out.ok) {
          if (typeof out.valueJson !== 'string') {
            return reject(new Error('custom code returned a value that cannot be passed on (a function or symbol?) — end the script with data: an object, array, string, number, boolean or null'));
          }
          let value;
          try { value = revive(JSON.parse(out.valueJson)); }
          catch (e) { return reject(new Error(`custom code result could not be read: ${e.message}`)); }
          return resolve(value);
        }
        if (out && out.timedOut) return reject(timeoutError(timeout, out.elapsed));
        reject(new Error((out && out.message) || 'custom code failed with no message'));
      });
    });

    child.on('error', (err) => finish(() =>
      reject(new Error(`custom code child could not start: ${err.message}`))));

    // 'close', not 'exit': 'exit' comes from the process handle, apart from
    // the IPC pipe, so a child that sent its result and exited can be reaped
    // while the result is still unread in the pipe (Linux reaps every exited
    // child on any SIGCHLD) — and finish()'s disconnect then drops it. 'close'
    // waits for the pipe's end-of-file, after every message has been emitted.
    child.on('close', (codeNum, signal) => finish(() =>
      reject(new Error(`custom code child exited without a result (code ${codeNum}, signal ${signal})`))));

    child.send({ code, inputJson, timeout, engine });
  });
}

// vm's timeout error names the limit but not how long the ceiling actually
// was in a throttled instance, which is the diagnostic that matters.
function timeoutError(timeout, elapsed) {
  const e = new Error(
    `Script execution timed out after ${timeout}ms (elapsed ${elapsed}ms). ` +
    `Pure-CPU scripts that exceed this are almost always a throttled ` +
    `Cloud Run instance, not slow code — check whether the step ran detached.`
  );
  e.code = 'CUSTOM_CODE_TIMEOUT';
  return e;
}

/**
 * Execute one job (webhook, internal_function, custom_code,
 *                   task_due_reminder, task_start_reminder,
 *                   mail_sent_read_seed, mail_sent_case_link)
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
    const { code, input = {}, timeout_ms, code_mode } = jobData;
    if (!code) throw new Error('Custom code job missing "code"');

    // Mode dispatch, FAIL CLOSED. 'safe' runs the body in a guest engine
    // (QuickJS/WASM, lib/safeCodeRunner.js) inside the scrubbed child —
    // ALWAYS, independent of the child-process flag below, because the mode is
    // a stored property of the step with no caller-selectable fallback: a step
    // authored against the safe contract must never run where an escape is
    // possible. Absent means 'standard' (every pre-existing step). Anything
    // else throws rather than running standard — this is the one dispatch
    // choke point (workflow engine, test-step and scheduled jobs all arrive
    // here), so the check here covers every execution path at once.
    const mode = code_mode === undefined ? 'standard' : code_mode;
    if (mode !== 'standard' && mode !== 'safe') {
      throw new Error(`Unknown custom code mode "${code_mode}" — expected "standard" or "safe"`);
    }

    // Per-step override, else env/default. Non-positive / NaN → default.
    // See CUSTOM_CODE_DEFAULT_TIMEOUT_MS above for why this is not 5000.
    const rawTimeout = Number(timeout_ms);
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), CUSTOM_CODE_MAX_TIMEOUT_MS)
      : CUSTOM_CODE_DEFAULT_TIMEOUT_MS;

    if (mode === 'safe') {
      return await runCustomCode({ code, input, timeout, jobId: job.id, engine: 'quickjs' });
    }

    // The step runs in a scrubbed child process instead of this one: `vm` is
    // not a security boundary, and in-process an escape reached `process.env`
    // — the app's own DB credentials. lib/customCodeRunner.js explains both
    // boundaries and what they do not cover. The step contract is identical
    // either way: `input` and `console.log` in, the script's FINAL EXPRESSION
    // out (no `return` — several live steps end in a bare `__out;`).
    //
    // FAIL CLOSED on the flag (`custom_code_child_process`): only an explicit
    // '0' selects the legacy in-process path. An absent row, a blank value
    // with no env var, or any other value runs the child. It was the reverse
    // until 2026-10-26 — `=== '1'` meant a missing row silently ran every
    // standard step in-process, with the escape. The flag stays as the
    // rollback lever it was built as: a flip, not a deploy.
    if (require('./firmConfig').cfg('custom_code_child_process') !== '0') {
      return await runCustomCode({ code, input, timeout, jobId: job.id });
    }

    // Legacy in-process path. Kept ONLY as the flag's explicit '0' position;
    // it is the path with the escape, so do not reach for it as a default.
    const sandbox = {
      input,
      console: { log: (...args) => console.log(`[CUSTOM CODE ${job.id}]`, ...args) },
    };
    const startedAt = Date.now();
    try {
      return new vm.Script(code).runInNewContext(sandbox, { timeout });
    } catch (err) {
      if (/Script execution timed out/i.test(err.message || '')) {
        throw timeoutError(timeout, Date.now() - startedAt);
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

  // ─────────────────────────────────────────────────────────────────────────
  // mail_sent_read_seed (mailbox S3)
  //
  // A comms-hub send's copy arrives with a LATER ingest tick, so the send
  // schedules this: mark that copy read for the person who sent it
  // (services/mailbox/mailboxSendService.seedSentReadState). Not stored yet →
  // it throws and the job retries with its backoff; on the LAST attempt it
  // completes quietly instead, so a copy that is never stored (an unpolled
  // Sent folder) raises no failed-job alert. job.attempts counts the attempts
  // BEFORE this one (routes/process_jobs.js: attempt = job.attempts + 1).
  // ─────────────────────────────────────────────────────────────────────────

  if (type === 'mail_sent_read_seed') {
    const { seedSentReadState } = require('../services/mailbox/mailboxSendService');
    const final = Number(job.attempts || 0) + 1 >= Number(job.max_attempts || 1);
    return seedSentReadState(db, jobData, { final });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // mail_sent_case_link (mailbox S2P)
  //
  // The composer's Case field: link a hub send's STORED copy to the case the
  // sender asked for (services/mailbox/mailboxSendService.linkSentCase —
  // mailReadService.caseLink run AS the sender, same grant seat). Copy not
  // stored yet, or caseLink 409 (emission pending / store-only grace) →
  // throw and retry on the backoff; revoked access (403/404) or the last
  // attempt → it records case_link_state='failed' + ONE error alert itself
  // and completes, so the generic failed-job path never double-reports.
  // ─────────────────────────────────────────────────────────────────────────

  if (type === 'mail_sent_case_link') {
    const { linkSentCase } = require('../services/mailbox/mailboxSendService');
    const final = Number(job.attempts || 0) + 1 >= Number(job.max_attempts || 1);
    return linkSentCase(db, jobData, { final });
  }

  // NOTE: the 'task_daily_digest' job type was retired in favor of the
  // internalFunctions.run_task_digest path (data.type='internal_function',
  // function_name='run_task_digest'); the recurring "Task Morning Routine"
  // job (id 109) was repointed accordingly. Use run_task_digest for new wiring.

  throw new Error(`Unsupported job type: ${type}`);
}

module.exports = { executeJob, customCodeChildOptions, CUSTOM_CODE_KILL_GRACE_MS };