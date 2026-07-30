// lib/internal_functions/esign.js
//
/**
 * E-Sign internal functions.
 *
 * Auto-registered: lib/internal_functions/index.js scans this directory, so
 * dropping this file in is the whole wiring step. No index edit, no
 * job_executor edit.
 *
 * ── WHY THIS IS AN internal_function AND NOT A NEW JOB TYPE ─────────────────
 * The scheduled-jobs engine dispatches on data.type, and bespoke types
 * (campaign_send, task_due_reminder) live inline in lib/job_executor.js. That
 * pattern was RETIRED for recurring work: job_executor.js:158 records that
 * 'task_daily_digest' was replaced by data.type='internal_function' +
 * function_name='run_task_digest', and job 109 repointed accordingly. Every
 * recurring job on the live box now follows that shape — run_task_digest,
 * refresh_expiring_oauth_credentials, run_event_digest, court_review_retry,
 * gcontacts_sync_pending. This matches them.
 */

const esignService = require('../../services/esignService');
const esignWebhookService = require('../../services/esignWebhookService');
const esignAlertService = require('../../services/esignAlertService');
const { getProvider } = require('../../services/esign');
const { getSetting } = require('../../services/settingsService');

const fns = {};

/** Don't chase filing retries forever — a stale failure is a human's job. */
const REFILE_LOOKBACK_DAYS = 30;

/** Hard ceiling per run, so one bad night cannot become an API storm. */
const DEFAULT_MAX_ROWS = 200;

/**
 * How long the webhook channel may be silent before a reconcile-applied move
 * counts as evidence of a DEAD channel rather than one dropped delivery.
 *
 * A single missed webhook is routine (deploy lands mid-delivery, instance
 * suspended between the 200 and the pipeline). Silence alone is also routine —
 * a sent-but-untouched envelope emits nothing. The diagnostic conjunction is
 * BOTH at once: reconcile moved a row (a webhook definitionally should have
 * arrived) AND nothing has been let past the auth gates in this long. That is
 * what four days of the 2026-07-22 outage looked like, and the only witness
 * was a console line nobody reads.
 */
const WEBHOOK_SILENCE_HOURS = 24;

/**
 * esign_reconcile — catch what the webhook missed.
 *
 * Webhooks get lost: a deploy lands mid-delivery, Cloud Run suspends the
 * instance between our 200 and the end of the pipeline, Zoho has an outage, a
 * token gets rotated. None of those are hypothetical, and all of them look
 * identical from inside the app — an envelope that is signed at the provider
 * and 'sent' here, forever. This job is the thing that notices.
 *
 * TWO PASSES:
 *
 *   A. OUTSTANDING ROWS (sent / viewed / bounced) that carry a provider_id.
 *      Ask Zoho for the current status; if it moved, push it through the SAME
 *      processStatusChange the webhook uses, so a document discovered here is
 *      filed, logged and alerted exactly as one announced in real time.
 *
 *   B. SIGNED ROWS WITH NO STORED PDF PATH, within the lookback window.
 *      This is the specific hole the 200-then-work pattern opens: the status
 *      transition committed, then the process died before the download
 *      finished. Pass A cannot see these — a signed row is not outstanding —
 *      so without pass B a lost filing would never be retried. fileSigned-
 *      Documents is idempotent on signed_pdf_path, so a row that actually did
 *      file is a no-op here.
 *
 * Expiry is handled inside pass A rather than as a third pass: Zoho reports
 * 'expired' as a request_status, so a lapsed envelope simply shows up as a
 * status that moved, and the mapping table turns it into our 'expired'. There
 * is no need to compare expires_at ourselves, and doing so would risk marking
 * a row expired that Zoho still considers live.
 *
 * ERROR POSTURE: one bad row must not kill the run. Every row is wrapped, the
 * failure is counted and named, and the run continues. If ANY row failed, a
 * single summary task goes to office_alerts_to — one task per run, never one
 * per row, because the failure mode this protects against (a revoked token)
 * fails every row at once.
 *
 * params:
 *   max_rows {number}  optional cap per pass (default 200)
 *   dry_run  {boolean} optional — report what would change, change nothing
 */
fns.esign_reconcile = async (params = {}, db) => {
  const maxRows = Number.isInteger(Number(params.max_rows)) && Number(params.max_rows) > 0
    ? Number(params.max_rows) : DEFAULT_MAX_ROWS;
  const dryRun = params.dry_run === true || params.dry_run === 'true';

  const started = Date.now();
  const summary = {
    checked: 0, moved: 0, filed: 0, unchanged: 0, failed: 0, refiled: 0,
    webhook_silence_alerted: false,
    dry_run: dryRun, changes: [], errors: [],
  };

  // One provider instance for the whole run — it re-reads settings per call
  // anyway, so sharing it costs nothing and saves a factory round trip per row.
  let provider = null;
  try {
    provider = await getProvider(db);
  } catch (err) {
    // Not configured, or the credential is gone. Nothing can be reconciled;
    // say so once and stop, rather than failing 200 rows identically.
    console.error(`[ESIGN RECONCILE] cannot build provider: ${err.message}`);
    await esignAlertService.raiseTask(db, {
      title: 'E-sign reconciliation could not run',
      desc:
        `The nightly Zoho Sign reconciliation job could not start because the provider ` +
        `could not be built:\n\n${err.message}\n\n` +
        `Nothing was checked. Signed documents may be sitting at Zoho without being filed.\n\n` +
        `Action: check the E-Sign settings and the Zoho connection under Connections.`,
    });
    return { success: false, output: { ...summary, error: err.message, aborted: true } };
  }

  // ── PASS A — outstanding rows ─────────────────────────────────────────────
  let outstanding = [];
  try {
    outstanding = await esignService.listOutstanding(db);
  } catch (err) {
    console.error(`[ESIGN RECONCILE] listOutstanding failed: ${err.message}`);
    return { success: false, output: { ...summary, error: err.message, aborted: true } };
  }

  const checkable = outstanding.filter((r) => r.provider_id).slice(0, maxRows);
  const draftless = outstanding.length - outstanding.filter((r) => r.provider_id).length;
  if (draftless > 0) {
    // Outstanding but never sent = a bug upstream, not something to poll for.
    console.warn(`[ESIGN RECONCILE] ${draftless} outstanding row(s) have no provider_id — skipped`);
  }

  for (const row of checkable) {
    summary.checked += 1;
    try {
      const live = await provider.getStatus(row.provider_id);

      if (live.status === row.status) { summary.unchanged += 1; continue; }

      if (dryRun) {
        summary.moved += 1;
        summary.changes.push({
          request_id: row.id, tracking_id: row.tracking_id,
          from: row.status, to: live.status, provider_status: live.providerStatus,
        });
        continue;
      }

      const outcome = await esignWebhookService.processStatusChange(db, row, {
        status: live.status,
        providerStatus: live.providerStatus,
        recipients: live.recipients,
        raw: live.raw,
        provider,
        source: 'reconcile',
      });

      if (outcome.changed) {
        summary.moved += 1;
        if (outcome.filed) summary.filed += 1;
        summary.changes.push({
          request_id: row.id, tracking_id: row.tracking_id,
          from: row.status, to: live.status, filed: Boolean(outcome.filed),
        });
        console.log(
          `[ESIGN RECONCILE] request ${row.id} (${row.tracking_id}): ` +
          `${row.status} → ${live.status}${outcome.filed ? ' + filed' : ''} — webhook was missed`
        );
      } else {
        summary.unchanged += 1;
      }
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ request_id: row.id, tracking_id: row.tracking_id, error: err.message });
      console.error(`[ESIGN RECONCILE] request ${row.id} failed: ${err.message}`);
    }
  }

  // ── DEAD-CHANNEL CHECK ────────────────────────────────────────────────────
  // See WEBHOOK_SILENCE_HOURS for why this is a conjunction and not a plain
  // silence timer. One task per run, never one per row — the failure mode
  // this catches (crossed token, armed hmac) kills every delivery at once.
  // Wrapped: an alerting hiccup must not fail a run whose real work is done.
  if (!dryRun && summary.moved >= 1) {
    try {
      const lastSeenRaw = await getSetting(db, esignWebhookService.WEBHOOK_LAST_SEEN_KEY);
      const lastSeen = lastSeenRaw ? new Date(lastSeenRaw) : null;
      const lastSeenOk = lastSeen && !Number.isNaN(lastSeen.getTime());
      const staleMs = WEBHOOK_SILENCE_HOURS * 60 * 60 * 1000;
      const silent = !lastSeenOk || (Date.now() - lastSeen.getTime()) > staleMs;

      if (silent) {
        const shown = summary.changes.slice(0, 5)
          .map((c) => `  • ${c.tracking_id}: ${c.from} → ${c.to}`).join('\n');
        const more = summary.changes.length > 5
          ? `\n  …and ${summary.changes.length - 5} more (see the job result).` : '';

        const alert = await esignAlertService.raiseTask(db, {
          title: `E-sign webhooks appear to be DOWN`,
          desc:
            `Tonight's reconciliation applied ${summary.moved} status change(s) that should have ` +
            `arrived by webhook, and no webhook delivery has been accepted since ` +
            `${lastSeenOk ? lastSeen.toISOString() : 'EVER (no delivery on record)'}.\n\n` +
            `${shown}${more}\n\n` +
            `Statuses are still correct — reconciliation is catching them — but up to a day ` +
            `late. Until the channel is fixed, signed documents file overnight instead of ` +
            `immediately.\n\nCheck:\n` +
            `  • esign_webhook_hmac_mode — a misconfigured 'enforce' rejects every delivery\n` +
            `  • the token in Zoho's webhook URL against app_settings esign_webhook_token\n` +
            `  • Cloud Run logs for [ESIGN WEBHOOK] rejections`,
        });
        summary.webhook_silence_alerted = Boolean(alert.ok);
        console.warn(
          `[ESIGN RECONCILE] ${summary.moved} moved with the webhook channel silent since ` +
          `${lastSeenOk ? lastSeen.toISOString() : 'ever'} — dead-channel task ` +
          `${alert.ok ? `#${alert.taskId} raised` : 'could NOT be raised'}`
        );
      }
    } catch (err) {
      summary.errors.push({ pass: 'dead-channel-check', error: err.message });
      console.error(`[ESIGN RECONCILE] dead-channel check failed: ${err.message}`);
    }
  }

  // ── PASS B — signed but unfiled ───────────────────────────────────────────
  if (!dryRun) {
    let unfiled = [];
    try {
      const [rows] = await db.query(
        `SELECT * FROM signing_requests
          WHERE status = 'signed'
            AND signed_pdf_path IS NULL
            AND provider_id IS NOT NULL
            AND completed_at >= (NOW() - INTERVAL ? DAY)
          ORDER BY completed_at ASC
          LIMIT ?`,
        [REFILE_LOOKBACK_DAYS, maxRows]
      );
      unfiled = rows || [];
    } catch (err) {
      summary.errors.push({ pass: 'B', error: err.message });
      console.error(`[ESIGN RECONCILE] unfiled query failed: ${err.message}`);
    }

    for (const raw of unfiled) {
      try {
        // Re-read through the service so JSON columns arrive shaped.
        const row = await esignService.getById(db, raw.id);
        if (!row || row.signed_pdf_path) continue;

        const esignFilingService = require('../../services/esignFilingService');
        const filing = await esignFilingService.fileSignedDocuments(db, row, { provider });

        if (filing.filed && !filing.warnings.length) {
          summary.refiled += 1;
          console.log(`[ESIGN RECONCILE] late-filed request ${row.id} → ${filing.signedPdfPath}`);
          await esignService.appendEvent(db, row.id, {
            event: 'filed',
            payload: {
              signed_pdf_path: filing.signedPdfPath, cert_pdf_path: filing.certPdfPath,
              source: 'reconcile', late: true,
            },
          }).catch(() => {});
        } else if (!filing.skipped || filing.reason !== 'already_filed') {
          // Still cannot file it. One task, with the reason, then stop
          // retrying it every night by leaving it to a human.
          summary.failed += 1;
          summary.errors.push({ request_id: row.id, error: filing.note || filing.reason || 'filing failed' });
        }
      } catch (err) {
        summary.failed += 1;
        summary.errors.push({ request_id: raw.id, error: err.message });
        console.error(`[ESIGN RECONCILE] re-file of request ${raw.id} failed: ${err.message}`);
      }
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const line =
    `[ESIGN RECONCILE] ${summary.checked} checked, ${summary.moved} moved, ` +
    `${summary.filed} filed, ${summary.refiled} late-filed, ${summary.unchanged} unchanged, ` +
    `${summary.failed} failed in ${seconds}s${dryRun ? ' (DRY RUN)' : ''}`;
  console.log(line);

  if (summary.failed > 0 && !dryRun) {
    const shown = summary.errors.slice(0, 5)
      .map((e) => `  • request ${e.request_id ?? '?'}: ${e.error}`).join('\n');
    await esignAlertService.raiseTask(db, {
      title: `E-sign reconciliation: ${summary.failed} problem(s)`,
      desc:
        `Tonight's Zoho Sign reconciliation finished with ${summary.failed} failure(s) out of ` +
        `${summary.checked} request(s) checked.\n\n${shown}` +
        (summary.errors.length > 5 ? `\n  …and ${summary.errors.length - 5} more (see logs).` : '') +
        `\n\nIf every row failed the same way, the Zoho connection is the likely cause — ` +
        `check it under Connections. Individual failures usually mean one envelope needs ` +
        `handling by hand in the Zoho dashboard.`,
    });
  }

  return { success: true, output: { ...summary, seconds: Number(seconds), message: line } };
};

fns.esign_reconcile.__meta = {
  category: 'system',
  description:
    'Reconcile e-signature requests against the provider. Pass A re-checks every outstanding ' +
    'request (sent/viewed/bounced) and applies any status the webhook missed, filing signed ' +
    'documents to Dropbox through the same path the webhook uses. Pass B retries filing for ' +
    'requests that are signed but have no stored PDF path. Safe to run repeatedly — every ' +
    'step is idempotent. Normally runs nightly as a recurring scheduled job.',
  params: [
    { name: 'max_rows', type: 'integer', required: false, min: 1,
      description: `Cap on rows examined per pass. Default ${DEFAULT_MAX_ROWS}.`,
      example: 200 },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'Report what would change without changing anything. Skips pass B entirely.' },
  ],
  example: { dry_run: true },
};

/**
 * esign_remind — one reminder occurrence for one signing request.
 *
 * THE SEQUENCE STEP for Phase 3 reminder sequences: a sequence template's
 * steps call this on a cadence with params.signing_request_id resolved from
 * {{trigger_data.signing_request_id}}. The sequence is only a clock — the
 * reminder email itself is Zoho's (provider.remind re-sends the signing
 * invitation), and ALL judgment about whether nudging is still appropriate
 * lives HERE, not in the sequence.
 *
 * ── THE RACE GUARD (the signed-client-must-never-get-nudged rule) ───────────
 * The terminal-transition hook in esignService.applyStatus cancels the
 * enrollment the moment a request goes terminal — but that hook only fires
 * when WE learn about the transition, and webhooks get lost (the entire
 * reason esign_reconcile exists). A client who signed an hour ago, whose
 * webhook died in a deploy, must still not be nudged at 10:00. So before ANY
 * remind call this function asks the PROVIDER for live status and pushes any
 * drift through esignWebhookService.processStatusChange — the exact
 * reconcile pass-A pattern — which files/alerts/cancels as if the webhook
 * had arrived. Only a request that is verifiably still awaiting signature
 * gets the nudge.
 *
 * If the live status CANNOT be verified (Zoho outage, token trouble), this
 * THROWS rather than reminding blind — the step's error_policy decides
 * whether to retry the occurrence or let the cadence move on. A missed nudge
 * is recoverable; a nudge to a signed client is not.
 *
 * ── SKIPS ARE SUCCESSES ─────────────────────────────────────────────────────
 * A terminal/draft/bounced request is a NORMAL discovery for a clock that
 * fires on a schedule, not an error: the function returns
 * { success:true, output:{ reminded:false, skipped:<reason> } } and the
 * sequence advances quietly. Terminal discoveries also defensively cancel
 * the enrollment (belt to applyStatus's suspenders) so later steps don't
 * even fire.
 *
 * params:
 *   signing_request_id {int}  REQUIRED — signing_requests.id
 */
fns.esign_remind = async (params = {}, db) => {
  const esignSendService = require('../../services/esignSendService');
  const { cancelEnrollment } = require('../sequenceEngine');

  const id = Number(params.signing_request_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(
      `esign_remind requires a positive integer signing_request_id ` +
      `(got ${JSON.stringify(params.signing_request_id)}) — check the sequence step's ` +
      `action_config and that trigger_data carried the id.`
    );
  }

  let row = await esignService.getById(db, id);
  if (!row) {
    // The row is gone but the clock is still ticking — say so and stop the clock.
    console.warn(`[ESIGN REMIND] signing request ${id} not found — skipping`);
    return { success: true, output: { reminded: false, skipped: 'not_found', request_id: id } };
  }

  const defensiveCancel = async (why) => {
    if (!row.seq_instance_id) return false;
    try {
      await cancelEnrollment(db, row.seq_instance_id, why);
      return true;
    } catch (err) {
      console.error(`[ESIGN REMIND] defensive cancel of enrollment ${row.seq_instance_id} failed: ${err.message}`);
      return false;
    }
  };

  // ── local row already terminal ─────────────────────────────────────────────
  // applyStatus should have cancelled the enrollment at transition time; that
  // this step ran anyway means it didn't (crash between UPDATE and cancel, a
  // pre-Phase-3 row, a manual DB edit). Skip AND stop the clock.
  if (esignService.TERMINAL.has(row.status)) {
    const cancelled = await defensiveCancel(`esign_${row.status}_lazy`);
    return {
      success: true,
      output: { reminded: false, skipped: 'terminal', status: row.status, request_id: id, enrollment_cancelled: cancelled },
    };
  }

  // Never sent — nothing at the provider to remind about. Draft rows can
  // still become real sends (retry path keeps the row), so the clock is left
  // running; a draft that later sends re-enrolls fresh anyway (dup guard
  // tolerates: same enrollment, still active).
  if (row.status === 'draft' || !row.provider_id) {
    return { success: true, output: { reminded: false, skipped: 'not_sent', status: row.status, request_id: id } };
  }

  // ── RACE GUARD: verify live status BEFORE nudging ──────────────────────────
  let provider;
  try {
    provider = await getProvider(db, row.provider);
  } catch (err) {
    throw new Error(`esign_remind: provider unavailable for request ${id}: ${err.message}`);
  }

  let live;
  try {
    live = await provider.getStatus(row.provider_id);
  } catch (err) {
    // Cannot verify → cannot nudge. Throwing hands the decision to the
    // step's error_policy (retry the occurrence, or skip it) — the one thing
    // this function will never do is remind on stale local state.
    throw new Error(`esign_remind: live status check failed for request ${id}: ${err.message}`);
  }

  if (live.status && live.status !== row.status) {
    // The webhook was missed. Apply the truth through THE choke point — the
    // same call reconcile makes — so filing, alerting and the terminal
    // cancellation hook all happen exactly as if the webhook had landed.
    const outcome = await esignWebhookService.processStatusChange(db, row, {
      status: live.status,
      providerStatus: live.providerStatus,
      recipients: live.recipients,
      raw: live.raw,
      provider,
      source: 'reminder_check',
    });
    row = (outcome && outcome.changed) ? await esignService.getById(db, id) : row;

    if (esignService.TERMINAL.has(row.status)) {
      // applyStatus's hook just cancelled the enrollment; the defensive
      // cancel below is a no-op belt in case it could not.
      const cancelled = await defensiveCancel(`esign_${row.status}_lazy`);
      console.log(
        `[ESIGN REMIND] request ${id}: provider says '${row.status}' — webhook was missed; ` +
        `reminder suppressed`
      );
      return {
        success: true,
        output: {
          reminded: false, skipped: 'became_terminal', status: row.status,
          request_id: id, webhook_was_missed: true, enrollment_cancelled: cancelled,
        },
      };
    }
  }

  // ── nudge ──────────────────────────────────────────────────────────────────
  // remindPipeline owns the guards (REMINDABLE = sent/viewed) and the
  // 'reminded' event. 'bounced' is deliberately NOT remindable — Zoho would
  // re-send to a dead mailbox; the staff resend flow is the fix — so a
  // bounced row skips here rather than letting the pipeline throw.
  if (row.status === 'bounced') {
    return { success: true, output: { reminded: false, skipped: 'bounced', request_id: id } };
  }

  const out = await esignSendService.remindPipeline(db, id, { createdBy: null });
  console.log(`[ESIGN REMIND] request ${id} (${row.tracking_id}): reminder sent`);
  return {
    success: true,
    output: { reminded: true, remindedAll: Boolean(out.remindedAll), status: row.status, request_id: id },
  };
};

fns.esign_remind.__meta = {
  category: 'system',
  description:
    'Send one reminder for one e-signature request — the step body for reminder sequences. ' +
    'Verifies LIVE provider status before nudging: a request the provider reports as ' +
    'signed/declined/recalled/expired is never reminded, the missed webhook is applied through ' +
    'the normal status pipeline (filing, alerts, reminder cancellation included), and the ' +
    'occurrence is skipped. Draft, bounced and terminal rows skip quietly. Throws if the live ' +
    'status cannot be verified — it will not remind on stale local state.',
  params: [
    // type 'string' + placeholderAllowed, NOT 'integer' — the house
    // convention for id params that normally carry a {{placeholder}} in a
    // sequence step (create_task.link_id / contact_id are the precedent).
    // An 'integer' type here breaks TWICE: the sequences UI renders integer
    // params as <input type="number">, which shows a placeholder string as
    // BLANK and clobbers it to '' on save; and validateParamsAgainstMeta's
    // integer branch rejects the token at save time. The runtime does its own
    // Number() check with a precise error either way.
    { name: 'signing_request_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'signing_requests.id — in a sequence step, pass {{trigger_data.signing_request_id}}.',
      example: '{{trigger_data.signing_request_id}}' },
  ],
  example: { signing_request_id: '{{trigger_data.signing_request_id}}' },
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION FUNCTIONS (Slice: esign workflow actions)
//
// The two functions above are system/maintenance. The three below are the
// ACTION vocabulary — what a workflow or sequence step calls to send, check,
// or recall a document. All three are thin wrappers over the same service
// pipelines the HTTP routes use (esignSendService / esignService), so a
// document sent by a workflow is indistinguishable — audit trail, reminders,
// filing, alerts — from one sent by staff.
//
// createdBy: 0 everywhere. resolveCreatedBy in routes/api.esign.actions.js
// already uses 0 as its "no authenticated user" fallback, so 0 = automation
// is consistent with the existing data rather than inventing a sentinel.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve recipient_contact_ids ("12" or "12,384") into the recipients array
 * shape sendPipeline expects. Order of ids = signing order. Name follows the
 * repo-wide display convention (contact_name, the same column debtor1.name
 * resolves from), with fname+lname as fallback for rows where contact_name is
 * blank. A contact with no usable email is a HARD error — better a failed
 * step than an envelope Zoho bounces or, worse, silently drops.
 */
async function _recipientsFromContactIds(db, raw) {
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => Number(s));

  if (!ids.length || ids.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(
      `recipient_contact_ids must be a comma-separated list of positive contact ids ` +
      `(got ${JSON.stringify(raw)}).`
    );
  }

  // Dedupe keeping first occurrence — a duplicated id is a config slip, not
  // a request for the same person to sign twice.
  const seen = new Set();
  const unique = ids.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));

  const [rows] = await db.query(
    `SELECT contact_id, contact_name, contact_fname, contact_lname, contact_email
       FROM contacts WHERE contact_id IN (${unique.map(() => '?').join(',')})`,
    unique
  );
  const byId = new Map((rows || []).map((r) => [Number(r.contact_id), r]));

  return unique.map((id, i) => {
    const c = byId.get(id);
    if (!c) throw new Error(`recipient_contact_ids: contact ${id} not found.`);
    const email = String(c.contact_email == null ? '' : c.contact_email).trim();
    if (!email || !email.includes('@')) {
      throw new Error(
        `recipient_contact_ids: contact ${id} (${c.contact_name || 'unnamed'}) has no usable ` +
        `email address — it cannot receive a signing invitation. Fix the contact record or ` +
        `pass an explicit recipients array.`
      );
    }
    const name =
      String(c.contact_name == null ? '' : c.contact_name).trim() ||
      `${String(c.contact_fname || '').trim()} ${String(c.contact_lname || '').trim()}`.trim() ||
      null;
    return { name, email, order: i + 1 };
  });
}

/**
 * esign_send_from_template — send a contract template for signature.
 *
 * The workflow/sequence counterpart of POST /api/esign/send-from-template.
 * Resolvers do the heavy lifting: a template whose prefill_schema is fully
 * resolver-backed (debtor1.*, case.*, firm.*, expressions) needs NO values at
 * all — pass template + linkable + recipients and the document fills itself.
 * `values` covers manually-declared keys; the engines' deep placeholder
 * resolution means {"fee": "{{vars.fee}}"} works in both workflows and
 * sequences.
 *
 * ── RECIPIENTS: TWO SHAPES, EXACTLY ONE ─────────────────────────────────────
 *   recipients            explicit [{name,email,order?}, …] (placeholders ok)
 *   recipient_contact_ids "12" or "12,384" — looked up from contacts, listed
 *                         order = signing order. The joint-debtor case is
 *                         "{{vars.debtor1_id}},{{vars.debtor2_id}}".
 * Save-time validation enforces exactly-one (exclusiveOneOf); the runtime
 * re-checks because hook/ingest paths can reach here without that gate.
 *
 * ── on_missing ──────────────────────────────────────────────────────────────
 * Required prefill keys still empty after resolvers + values:
 *   'fail' (default) → throw ESIGN_MISSING_PREFILL; the step's error_policy
 *                      decides (retry / stop / continue).
 *   'task'           → raise a task to office_alerts_to naming the missing
 *                      keys and return { sent:false, skipped:'missing_prefill' }
 *                      as a SUCCESS — the human takes over, the automation
 *                      moves on. Branch on {{this.sent}} downstream if needed.
 *
 * Every other failure (provider down, bad recipients, inactive template)
 * throws — those are not conditions a staff task fixes better than the
 * step's own error policy.
 *
 * Reminder enrollment, filing on completion, alerting: all inherited from
 * sendFromTemplate/sendPipeline. Nothing to configure here.
 *
 * params:
 *   template_id            {int}    REQUIRED — contract_templates.id
 *   linkable_type          {enum}   REQUIRED — 'case' | 'contact'
 *   linkable_id            {string} REQUIRED — usually a {{placeholder}}
 *   recipients             {array}  one-of — explicit recipient objects
 *   recipient_contact_ids  {string} one-of — comma-separated contact ids
 *   values                 {object} optional — prefill key → value
 *   document_name          {string} optional — defaults from template + case
 *   expiration_days        {int}    optional — defaults from template
 *   on_missing             {enum}   optional — 'fail' (default) | 'task'
 */
fns.esign_send_from_template = async (params = {}, db) => {
  const esignSendService = require('../../services/esignSendService');

  const templateId = Number(params.template_id);
  if (!Number.isInteger(templateId) || templateId < 1) {
    throw new Error(
      `esign_send_from_template requires a positive integer template_id ` +
      `(got ${JSON.stringify(params.template_id)}).`
    );
  }

  const linkableType = params.linkable_type;
  const linkableId = params.linkable_id;
  if (linkableId == null || String(linkableId).trim() === '') {
    throw new Error(
      'esign_send_from_template requires linkable_id — check that the placeholder resolved ' +
      '(an unresolved {{token}} or empty variable arrives here as blank).'
    );
  }

  const hasArray = Array.isArray(params.recipients) && params.recipients.length > 0;
  const hasIds = params.recipient_contact_ids != null && String(params.recipient_contact_ids).trim() !== '';
  if (hasArray === hasIds) {
    throw new Error(
      'esign_send_from_template requires exactly one of recipients (array) or ' +
      'recipient_contact_ids (comma-separated contact ids).'
    );
  }

  const recipients = hasIds
    ? await _recipientsFromContactIds(db, params.recipient_contact_ids)
    : params.recipients;

  const onMissing = params.on_missing === 'task' ? 'task' : 'fail';

  // ── completion-target override (Slice 2) ──────────────────────────────────
  // KEY-PRESENCE semantics, mirroring sendFromTemplate's merge: an absent
  // param keeps the template's trigger; a provided {type,id} replaces it; an
  // explicit null clears it for this send. No params → undefined → template
  // defaults apply untouched.
  let completionTargets;
  if ('on_signed' in params || 'on_declined' in params) {
    completionTargets = {};
    if ('on_signed' in params)   completionTargets.signed   = params.on_signed;
    if ('on_declined' in params) completionTargets.declined = params.on_declined;
  }

  let out;
  try {
    out = await esignSendService.sendFromTemplate(db, {
      templateId,
      linkableType,
      linkableId,
      values: params.values && typeof params.values === 'object' ? params.values : null,
      recipients,
      documentName: params.document_name || null,
      expirationDays: params.expiration_days != null ? Number(params.expiration_days) : null,
      createdBy: 0,
      completionTargets,
    });
  } catch (err) {
    if (err && err.code === 'ESIGN_MISSING_PREFILL' && onMissing === 'task') {
      // The human path. Name the template (best-effort — the lookup cannot be
      // allowed to mask the real situation) and every missing key, then report
      // the skip as a success so the automation continues.
      const missing = Array.isArray(err.missing) ? err.missing : [];
      let templateName = `#${templateId}`;
      try {
        const t = await require('../../services/esignTemplateService').getTemplate(db, templateId);
        if (t && t.name) templateName = `"${t.name}" (#${templateId})`;
      } catch (_) { /* name is garnish */ }

      const alert = await esignAlertService.raiseTask(db, {
        title: `E-sign send needs values: ${templateName}`,
        desc:
          `An automated send of template ${templateName} for ${linkableType} ${linkableId} ` +
          `stopped because required value(s) are still empty:\n\n` +
          missing.map((k) => `  • ${k}`).join('\n') +
          `\n\nNothing was sent and no credit was spent. ` +
          `Action: open the ${linkableType} and send the document manually, filling the ` +
          `missing value(s) — or fix the data the template's resolvers read and re-run.`,
      });

      console.warn(
        `[ESIGN SEND FN] template ${templateId} for ${linkableType} ${linkableId}: ` +
        `missing prefill [${missing.join(', ')}] — task ${alert.ok ? `#${alert.taskId} raised` : 'NOT raised'}`
      );
      return {
        success: true,
        output: {
          sent: false,
          skipped: 'missing_prefill',
          missing,
          task_id: alert.ok ? alert.taskId : null,
          template_id: templateId,
        },
      };
    }
    throw err;
  }

  const row = out.row;
  console.log(
    `[ESIGN SEND FN] template ${templateId} → request ${row.id} (${row.tracking_id}) ` +
    `for ${linkableType} ${linkableId}, ${recipients.length} recipient(s)` +
    (out.testing ? ' [TESTING MODE]' : '')
  );
  return {
    success: true,
    output: {
      sent: true,
      signing_request_id: row.id,
      tracking_id: row.tracking_id,
      status: row.status,
      document_name: row.document_name,
      testing: Boolean(out.testing),
    },
  };
};

fns.esign_send_from_template.__meta = {
  category: 'esign',
  description:
    'Send a contract template for e-signature, linked to a case or contact. Resolver-backed ' +
    'prefill keys (debtor1.*, case.*, firm.*, expressions) fill automatically; pass `values` ' +
    'for the rest. Recipients come from an explicit array OR from recipient_contact_ids ' +
    '(comma-separated, list order = signing order). If required values are still missing, ' +
    'on_missing decides: fail the step (default) or raise a staff task and skip. Reminders, ' +
    'filing and alerts behave exactly as for a staff-sent document. Returns ' +
    'signing_request_id / tracking_id for downstream steps.',
  params: [
    { name: 'template_id', type: 'integer', required: true, min: 1,
      description: 'contract_templates.id — pick from the template admin list.',
      example: 3 },
    { name: 'linkable_type', type: 'enum', required: true, enum: ['case', 'contact'],
      description: 'What the request is linked to.' },
    { name: 'linkable_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case or contact id — usually a placeholder.',
      example: '{{trigger_data.case_id}}' },
    { name: 'recipients', type: 'array', required: false,
      description: 'Explicit recipients: [{"name":"…","email":"…"}, …]. Placeholders resolve ' +
        'inside. Use this OR recipient_contact_ids, not both.',
      example: [{ name: '{{contacts.contact_name}}', email: '{{contacts.contact_email}}' }] },
    { name: 'recipient_contact_ids', type: 'string', required: false, placeholderAllowed: true,
      description: 'Comma-separated contact ids; name/email looked up, list order = signing ' +
        'order. Use this OR recipients, not both.',
      example: '{{contact_id}}' },
    { name: 'values', type: 'object', required: false,
      description: 'Prefill values for keys not covered by resolvers: {"fee": "1500"}. ' +
        'Placeholders resolve inside.' },
    { name: 'document_name', type: 'string', required: false, placeholderAllowed: true,
      description: 'Override the document name (default: template name + case/contact).' },
    { name: 'expiration_days', type: 'integer', required: false, min: 1,
      description: 'Override the template\'s expiration window (1–90 days).' },
    { name: 'on_missing', type: 'enum', required: false, enum: ['fail', 'task'],
      description: "'fail' (default): throw if required prefill values are empty. 'task': " +
        'raise a staff task, skip the send, and report success with sent:false.' },
    { name: 'on_signed', type: 'object', required: false,
      description: 'Completion trigger override: {"type": "workflow"|"sequence", "id": N} — ' +
        'started when the request is signed (or satisfied externally). Omit to use the ' +
        "template's own trigger; pass null to clear it for this send.",
      example: { type: 'workflow', id: 12 } },
    { name: 'on_declined', type: 'object', required: false,
      description: 'Completion trigger override: {"type": "workflow"|"sequence", "id": N} — ' +
        "started when the request is declined. Omit to use the template's; null clears.",
      example: { type: 'sequence', id: 4 } },
  ],
  exclusiveOneOf: [['recipients', 'recipient_contact_ids']],
  example: {
    template_id: 3,
    linkable_type: 'case',
    linkable_id: '{{trigger_data.case_id}}',
    recipient_contact_ids: '{{trigger_data.contact_id}}',
    on_missing: 'task',
  },
};

/**
 * esign_get_status — read a signing request's status into step output.
 *
 * The branching primitive: set_vars the output, then evaluate_condition on
 * {{vars.esign_status}} / {{vars.esign_signed}}. Pure read by default.
 *
 * live:true additionally verifies against the PROVIDER, and any drift is
 * applied through esignWebhookService.processStatusChange — the identical
 * race-guard pattern esign_remind uses — so a missed webhook discovered here
 * files/alerts/cancels exactly as if it had arrived. A workflow deciding
 * "did the client sign?" should use live:true: local state can be a lost
 * webhook stale, and the whole point of the check is the truth. If the live
 * check cannot complete, this THROWS rather than answering from stale state —
 * error_policy decides what happens next.
 *
 * params:
 *   signing_request_id {int}  REQUIRED
 *   live               {bool} optional, default false
 */
fns.esign_get_status = async (params = {}, db) => {
  const esignSendService = require('../../services/esignSendService');

  const id = Number(params.signing_request_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(
      `esign_get_status requires a positive integer signing_request_id ` +
      `(got ${JSON.stringify(params.signing_request_id)}).`
    );
  }

  let row = await esignService.getById(db, id);
  if (!row) throw new Error(`Signing request ${id} not found.`);

  const wantLive = params.live === true || params.live === 'true';
  let liveChecked = false;
  let webhookWasMissed = false;

  // A terminal or never-sent row has nothing to verify — its local status IS
  // the truth (terminal states have no exits; drafts don't exist at Zoho).
  if (wantLive && row.provider_id && row.status !== 'draft' && !esignService.TERMINAL.has(row.status)) {
    const provider = await getProvider(db, row.provider); // throws if unavailable — no stale answers on live:true
    const live = await provider.getStatus(row.provider_id);
    liveChecked = true;

    if (live.status && live.status !== row.status) {
      const outcome = await esignWebhookService.processStatusChange(db, row, {
        status: live.status,
        providerStatus: live.providerStatus,
        recipients: live.recipients,
        raw: live.raw,
        provider,
        source: 'status_check',
      });
      if (outcome && outcome.changed) {
        webhookWasMissed = true;
        row = await esignService.getById(db, id);
        console.log(
          `[ESIGN STATUS FN] request ${id}: provider says '${row.status}' — missed webhook applied`
        );
      }
    }
  }

  return {
    success: true,
    output: {
      request_id: row.id,
      tracking_id: row.tracking_id,
      status: row.status,
      is_terminal: esignService.TERMINAL.has(row.status),
      is_signed: esignService.TERMINAL_SUCCESS.has(row.status),
      kind: row.kind,
      document_name: row.document_name,
      linkable_type: row.linkable_type,
      linkable_id: row.linkable_id,
      recipient_count: Array.isArray(row.recipients) ? row.recipients.length : 0,
      sent_at: row.sent_at || null,
      completed_at: row.completed_at || null,
      expires_at: row.expires_at || null,
      days_pending: esignSendService._daysPending(row.sent_at),
      live_checked: liveChecked,
      webhook_was_missed: webhookWasMissed,
    },
  };
};

fns.esign_get_status.__meta = {
  category: 'esign',
  description:
    'Read an e-signature request\'s status for branching. Returns status plus is_signed / ' +
    'is_terminal booleans, timestamps and days_pending — map them with set_vars, then ' +
    'evaluate_condition. With live:true the provider is consulted first and any missed ' +
    'webhook is applied through the normal status pipeline (filing and alerts included) ' +
    'before answering; throws if the live check cannot complete rather than answering stale.',
  params: [
    { name: 'signing_request_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'signing_requests.id — typically {{vars.signing_request_id}} captured ' +
        'from an earlier esign_send_from_template step.',
      example: '{{vars.signing_request_id}}' },
    { name: 'live', type: 'boolean', required: false, default: false,
      description: 'Verify against the provider before answering. Use true whenever the ' +
        'answer gates a decision.' },
  ],
  example: { signing_request_id: '{{vars.signing_request_id}}', live: true },
};

/**
 * esign_recall — pull back an outstanding signing request.
 *
 * The automation shape of the staff recall: same recallPipeline, so the
 * provider recall, the audit event, and the client "why" notification all
 * happen identically. Divergence from the staff flow is TOLERANCE: a
 * workflow recalling "whatever is outstanding" (case closed, client
 * converted, document superseded) must not error on a row that already went
 * terminal — a signed row is a NORMAL discovery for that workflow, not a
 * failure. Terminal rows skip as successes; everything the pipeline itself
 * refuses (outstanding-but-no-provider_id inconsistency) still throws.
 *
 * params:
 *   signing_request_id {int}    REQUIRED
 *   reason             {string} optional — reaches the CLIENT verbatim in the
 *                               recall notice email; default is deliberately
 *                               client-safe generic.
 */
fns.esign_recall = async (params = {}, db) => {
  const esignSendService = require('../../services/esignSendService');

  const id = Number(params.signing_request_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(
      `esign_recall requires a positive integer signing_request_id ` +
      `(got ${JSON.stringify(params.signing_request_id)}).`
    );
  }

  const row = await esignService.getById(db, id);
  if (!row) {
    // Row gone (never possible today — rows are never deleted — but a wrong
    // id from a stale variable lands here). Skip, don't fail: there is
    // nothing outstanding to recall, which is the caller's goal state.
    console.warn(`[ESIGN RECALL FN] signing request ${id} not found — skipping`);
    return { success: true, output: { recalled: false, skipped: 'not_found', request_id: id } };
  }

  if (esignService.TERMINAL.has(row.status)) {
    return {
      success: true,
      output: { recalled: false, skipped: 'terminal', status: row.status, request_id: id, tracking_id: row.tracking_id },
    };
  }

  const reason = (params.reason != null && String(params.reason).trim() !== '')
    ? String(params.reason).trim()
    : 'This document has been withdrawn by the firm. Please disregard the signing request.';

  const out = await esignSendService.recallPipeline(db, id, { reason, createdBy: 0 });
  console.log(`[ESIGN RECALL FN] request ${id} (${row.tracking_id}): recalled from '${row.status}'`);
  return {
    success: true,
    output: {
      recalled: true,
      status: out.row.status,
      from_status: row.status,
      request_id: id,
      tracking_id: row.tracking_id,
    },
  };
};

fns.esign_recall.__meta = {
  category: 'esign',
  description:
    'Recall an outstanding e-signature request — same pipeline as the staff recall (provider ' +
    'recall, audit event, client notification with the reason). Tolerant by design: a request ' +
    'that is already signed/declined/expired/recalled skips as a success (recalled:false, ' +
    'skipped:"terminal"), so a cleanup workflow can recall whatever is outstanding without ' +
    'erroring on the ones that resolved themselves. The reason reaches the client verbatim.',
  params: [
    { name: 'signing_request_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'signing_requests.id',
      example: '{{vars.signing_request_id}}' },
    { name: 'reason', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'Sent to the client in the recall notice. Default: a generic ' +
        '"withdrawn by the firm" message.' },
  ],
  example: { signing_request_id: '{{vars.signing_request_id}}' },
};

module.exports = fns;