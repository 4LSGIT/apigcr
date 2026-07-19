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

const fns = {};

/** Don't chase filing retries forever — a stale failure is a human's job. */
const REFILE_LOOKBACK_DAYS = 30;

/** Hard ceiling per run, so one bad night cannot become an API storm. */
const DEFAULT_MAX_ROWS = 200;

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

module.exports = fns;
