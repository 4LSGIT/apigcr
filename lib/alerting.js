// lib/alerting.js
//
/**
 * Centralized error alerting — Slice 1 core.
 *
 * Exports:
 *   alert(db, opts)        — fire-and-forget single-alert recorder. NEVER
 *                            throws. Critical severity attempts immediate
 *                            (throttled) delivery; everything else waits for
 *                            the sweep digest.
 *   runErrorSweep(db, p)   — hourly sweep. Phase A scans the automation
 *                            failure tables (watermarked) into system_alerts;
 *                            Phase B emails ONE grouped digest of undigested
 *                            rows. Exposed as the `run_error_sweep` internal
 *                            function and driven by the "Error Alert Sweep"
 *                            recurring job.
 *
 * Tables: system_alerts (rows), alert_state (per-group_key first/last seen,
 * last_alerted_at throttle, lifetime occurrence_count).
 *
 * Delivery independence: the email path uses emailService with a plain-SMTP
 * sender (alert_from_email setting → AUTO_EMAIL env fallback) and must NOT
 * depend on the Connections/OAuth system. The SMS fallback (RingCentral) DOES
 * ride Connections — the two channels fail independently by design, so an
 * OAuth outage can still page via email and an SMTP outage can still page
 * via SMS.
 *
 * Settings (app_settings):
 *   alert_recipients          csv of emails (single send, csv `to`)
 *   alert_from_email          plain-SMTP sender; '' → AUTO_EMAIL env
 *   alert_critical_sms_to     csv of numbers; '' → SMS fallback skipped
 *   alert_cooldown_hours      per-group digest cooldown (default 6)
 *   alert_email_min_severity  min severity that TRIGGERS an email ('error')
 *   error_sweep_state         machine-managed watermark JSON
 *   alert_last_sweep_at       heartbeat — written ONLY on a fully successful,
 *                             non-dry sweep. A running-but-failing sweep must
 *                             look stale (slice 2 banner depends on this).
 */

const SEVERITY_RANK = { info: 0, warning: 1, error: 2, critical: 3 };
const STREAM_BATCH_LIMIT = 500;   // per-source per-sweep row cap (backlog drains over runs)
const DIGEST_GROUP_CAP   = 50;    // full group blocks per digest email
const MSG_TRUNC          = 500;   // message column truncation

// ────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────

function _trunc(s, n = MSG_TRUNC) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _sevRank(sev) {
  return SEVERITY_RANK[sev] ?? SEVERITY_RANK.error;
}

function _fmtTs(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
  catch { return String(d); }
}

async function _getSetting(db, key) {
  // Local copy of settingsService.getSetting to keep this module's require
  // surface minimal; same query.
  const [[row]] = await db.query(
    'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1', [key]
  );
  return row?.value ?? null;
}

async function _setSetting(db, key, value) {
  await db.query(
    `INSERT INTO app_settings (\`key\`, \`value\`, is_secret, is_editable)
     VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    [key, value]
  );
}

// ────────────────────────────────────────────────────────────
// Delivery helpers — internal, never throw.
// ────────────────────────────────────────────────────────────

/**
 * Send an alert email. from = alert_from_email setting, falling back to the
 * AUTO_EMAIL env var. Neither set → console.warn and report failure (caller
 * treats it as a send failure → rows stay undigested / SMS fallback fires).
 * @returns {Promise<boolean>} sent ok
 */
async function sendAlertEmail(db, { subject, html, text }) {
  try {
    const recipients = (await _getSetting(db, 'alert_recipients') || '').trim();
    if (!recipients) {
      console.warn('[alerting] alert_recipients is empty — cannot send alert email');
      return false;
    }
    // Lazy require — circular-dep safety convention. cfg() covers the
    // email_automations setting with AUTO_EMAIL env fallback.
    const { cfg } = require('./firmConfig');
    const from = (await _getSetting(db, 'alert_from_email') || '').trim()
      || cfg('email_automations')
      || '';
    if (!from) {
      console.warn('[alerting] no alert_from_email setting and no email_automations/AUTO_EMAIL — cannot send alert email');
      return false;
    }
    // Lazy require — circular-dep safety convention.
    const emailService = require('../services/emailService');
    await emailService.sendEmail(db, {
      from,
      to: recipients,         // csv passes through to nodemailer untouched
      subject,
      html,
      ...(text ? { text } : {}),
    });
    return true;
  } catch (err) {
    console.error('[alerting] sendAlertEmail failed:', err.message);
    return false;
  }
}

/**
 * SMS fallback for failed/critical deliveries. alert_critical_sms_to empty →
 * skipped with console.warn. From-line resolved the same way
 * taskService.getSmsFrom does (sms_staff_from → sms_default_from).
 * @returns {Promise<boolean>} at least one SMS sent ok
 */
async function smsFallback(db, textBody) {
  try {
    const toSetting = (await _getSetting(db, 'alert_critical_sms_to') || '').trim();
    if (!toSetting) {
      console.warn('[alerting] alert_critical_sms_to is empty — SMS fallback skipped');
      return false;
    }
    const from =
      (await _getSetting(db, 'sms_staff_from')) ||
      (await _getSetting(db, 'sms_default_from')) ||
      null;
    if (!from) {
      console.warn('[alerting] no sms_staff_from/sms_default_from — SMS fallback skipped');
      return false;
    }
    const phoneService = require('../services/phoneService');
    let anySent = false;
    for (const to of toSetting.split(',').map(s => s.trim()).filter(Boolean)) {
      try {
        await phoneService.sendSms(db, from, to, textBody);
        anySent = true;
      } catch (err) {
        console.error(`[alerting] SMS fallback to ${to} failed:`, err.message);
      }
    }
    return anySent;
  } catch (err) {
    console.error('[alerting] smsFallback failed:', err.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// alert() — single-alert recorder
// ────────────────────────────────────────────────────────────

/**
 * Record one alert. Fire-and-forget contract: NEVER throws.
 *
 * @param {object} db
 * @param {object} o
 *   source, kind, group_key, title         required
 *   severity                               'info'|'warning'|'error'|'critical' (default 'error')
 *   message, context, ref_table, ref_id    optional
 *   dedup_key                              optional; INSERT IGNORE when set
 */
async function alert(db, o = {}) {
  const severity = SEVERITY_RANK[o.severity] != null ? o.severity : 'error';
  let insertId = null;
  let inserted = false;
  let insertError = null;

  // 1. Insert the row. (INSERT IGNORE when dedup_key provided — duplicate
  //    dedup_key is a silent no-op, affectedRows 0.)
  try {
    if (!o.source || !o.kind || !o.group_key || !o.title) {
      throw new Error('alert() requires source, kind, group_key, title');
    }
    const verb = o.dedup_key ? 'INSERT IGNORE' : 'INSERT';
    const [r] = await db.query(
      `${verb} INTO system_alerts
         (source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        o.source, o.kind, o.group_key, severity,
        _trunc(o.title, 500), _trunc(o.message),
        o.context != null ? JSON.stringify(o.context) : null,
        o.ref_table ?? null, o.ref_id ?? null, o.dedup_key ?? null,
      ]
    );
    inserted = r.affectedRows > 0;
    insertId = inserted ? r.insertId : null;
  } catch (err) {
    insertError = err;
    console.error('[alerting] alert() insert failed:', err.message);
  }

  // 2. Upsert alert_state (only when a row was actually recorded — dedup
  //    re-reads must not inflate occurrence_count).
  try {
    if (inserted) {
      await db.query(
        `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count)
         VALUES (?, NOW(), NOW(), 1)
         ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1`,
        [o.group_key]
      );
    }
  } catch (err) {
    console.error('[alerting] alert() state upsert failed:', err.message);
  }

  // 3. Critical → attempt immediate delivery, throttled to once/hour per group.
  //    Partial-DB-failure best effort: if the system_alerts INSERT itself
  //    threw, still ATTEMPT the direct email before swallowing. (Known
  //    limitation: total DB death also kills emailService's credential
  //    lookup, so this only helps partial failures — e.g. system_alerts
  //    corrupt/locked while the rest of the DB answers.)
  try {
    if (severity !== 'critical') return;
    if (!inserted && !insertError) return; // duplicate dedup_key — already alerted on the first insert

    let throttled = false;
    if (!insertError) {
      try {
        const [[st]] = await db.query(
          'SELECT last_alerted_at FROM alert_state WHERE group_key = ?', [o.group_key]
        );
        throttled = !!(st?.last_alerted_at &&
          (Date.now() - new Date(st.last_alerted_at).getTime()) < 60 * 60 * 1000);
      } catch (err) {
        console.error('[alerting] throttle check failed (sending anyway):', err.message);
      }
    }
    if (throttled) return;

    const subject = `[YisraCase] CRITICAL: ${o.title}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">
        <h2 style="margin:0 0 8px;font-size:20px;color:#b91c1c">🚨 ${_esc(o.title)}</h2>
        <p style="margin:0 0 6px;font-size:13px;color:#6b7280">
          source: <strong>${_esc(o.source)}</strong> · kind: <strong>${_esc(o.kind)}</strong> · group: <strong>${_esc(o.group_key)}</strong>
        </p>
        ${o.message ? `<div style="margin:12px 0;padding:12px 14px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:13px;color:#374151;white-space:pre-wrap">${_esc(_trunc(o.message))}</div>` : ''}
        ${o.context ? `<pre style="margin:8px 0;padding:10px;background:#f9fafb;border-radius:4px;font-size:11px;color:#4b5563;overflow:auto">${_esc(JSON.stringify(o.context, null, 2))}</pre>` : ''}
        <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">Sent immediately (critical). Recurring alerts for this group are throttled to once/hour; the rest ride the digest.</p>
      </div>`;

    let delivered = await sendAlertEmail(db, { subject, html });
    if (!delivered) {
      delivered = await smsFallback(db, `YisraCase CRITICAL: ${_trunc(o.title, 120)} (${o.group_key})`);
    }

    // On SUCCESSFUL immediate delivery: digest must not re-mail it, and the
    // throttle window starts now.
    if (delivered && !insertError) {
      if (insertId) {
        await db.query('UPDATE system_alerts SET digested_at = NOW() WHERE id = ?', [insertId])
          .catch(err => console.error('[alerting] digested_at stamp failed:', err.message));
      }
      await db.query(
        `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count, last_alerted_at)
         VALUES (?, NOW(), NOW(), 1, NOW())
         ON DUPLICATE KEY UPDATE last_alerted_at = NOW()`,
        [o.group_key]
      ).catch(err => console.error('[alerting] last_alerted_at stamp failed:', err.message));
    }
  } catch (err) {
    console.error('[alerting] alert() critical-delivery path failed:', err.message);
  }
}

// ────────────────────────────────────────────────────────────
// Phase A — source scanners.
//
// Each scanner returns { count, rows, watermark } where rows are candidate
// system_alerts inserts (with dedup_key) and watermark is the new value for
// its key, or undefined when nothing moved. Scanners only SELECT — the sweep
// inserts (or, in dry_run, just counts). All stream scans ORDER BY id with a
// LIMIT so a pathological backlog drains across runs instead of OOMing one.
// ────────────────────────────────────────────────────────────

function _streamRow(source, kind, refTable, refId, groupKey, severity, title, message, context) {
  return {
    source, kind, group_key: groupKey, severity,
    title: _trunc(title, 500),
    message: _trunc(message),
    context,
    ref_table: refTable, ref_id: refId,
    dedup_key: `${source}:${kind}:${refTable}:${refId}`,
  };
}

async function _scanWorkflows(db, wm) {
  const [rows] = await db.query(
    `SELECT s.id, s.workflow_execution_id, s.step_number, s.error_message, s.executed_at,
            e.workflow_id, e.status AS exec_status, w.name AS workflow_name
       FROM workflow_execution_steps s
       JOIN workflow_executions e ON e.id = s.workflow_execution_id
       JOIN workflows w ON w.id = e.workflow_id
      WHERE s.status = 'failed' AND s.id > ?
      ORDER BY s.id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  const out = rows.map(r => _streamRow(
    'workflow', 'step_failed', 'workflow_execution_steps', r.id,
    `workflow:${r.workflow_id}`,
    // error if the whole execution failed; warning for an ignore-policy step
    // failure inside a completed_with_errors/active execution.
    r.exec_status === 'failed' ? 'error' : 'warning',
    `Workflow ${r.workflow_id} (${r.workflow_name}) step ${r.step_number} failed`,
    r.error_message,
    { workflow_id: r.workflow_id, execution_id: r.workflow_execution_id,
      step_number: r.step_number, exec_status: r.exec_status }
  ));
  return { count: rows.length, rows: out,
    watermark: rows.length ? rows[rows.length - 1].id : undefined };
}

async function _scanScheduledJobs(db, wm) {
  // FINALS ONLY: recurring jobs never rest at status='failed' (they
  // reschedule to pending after exhausting attempts) — the
  // attempt >= max_attempts clause catches recurring cycle finals;
  // j.status='failed' catches one-time finals. Mid-retry attempts excluded.
  //
  // SELF-EXCLUSION via JSON_EXTRACT (not LIKE): scheduled_jobs.data is a
  // verified {type, function_name, params} JSON shape, so the typed extract
  // is exact; a LIKE '%run_error_sweep%' would false-positive on any job
  // whose params merely mention the string.
  const [rows] = await db.query(
    `SELECT r.id, r.job_id, r.attempt, r.error_message, r.executed_at,
            j.name AS job_name, j.status AS job_status, j.max_attempts
       FROM job_results r
       JOIN scheduled_jobs j ON j.id = r.job_id
      WHERE r.status = 'failed' AND r.id > ?
        AND (j.status = 'failed' OR r.attempt >= j.max_attempts)
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.data, '$.function_name')), '') <> 'run_error_sweep'
      ORDER BY r.id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  // Watermark must advance past EVERY failed row scanned (including excluded
  // mid-retry rows) or they'd be re-read forever. Simplest correct watermark:
  // max(job_results.id) among status='failed' rows <= the batch ceiling. We
  // take max id from the unfiltered failed stream in the same window.
  const [[mx]] = await db.query(
    `SELECT MAX(id) AS m FROM (
       SELECT id FROM job_results WHERE status='failed' AND id > ? ORDER BY id LIMIT ${STREAM_BATCH_LIMIT}
     ) t`,
    [wm]
  );
  const out = rows.map(r => _streamRow(
    'scheduled_job', 'job_failed', 'job_results', r.id,
    `job:${r.job_id}`, 'error',
    `Job ${r.job_id} (${r.job_name}) failed (attempt ${r.attempt}/${r.max_attempts})`,
    r.error_message,
    { job_id: r.job_id, attempt: r.attempt, max_attempts: r.max_attempts, job_status: r.job_status }
  ));
  return { count: rows.length, rows: out,
    watermark: mx?.m != null ? Number(mx.m) : undefined };
}

async function _scanSequences(db, wm) {
  // sequence_step_log 'failed' rows are FINALS (verified: sequenceEngine
  // retries in an in-memory loop and calls logStep('failed') exactly once,
  // after retries are exhausted) — no per-attempt filtering needed.
  // sequence identity = sequence_enrollments.template_id (there is no
  // sequence_id column; templates ARE the sequences).
  const [rows] = await db.query(
    `SELECT l.id, l.enrollment_id, l.step_number, l.error_message, l.executed_at,
            en.template_id, t.name AS template_name
       FROM sequence_step_log l
       JOIN sequence_enrollments en ON en.id = l.enrollment_id
       LEFT JOIN sequence_templates t ON t.id = en.template_id
      WHERE l.status = 'failed' AND l.id > ?
      ORDER BY l.id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  const out = rows.map(r => _streamRow(
    'sequence', 'step_failed', 'sequence_step_log', r.id,
    `sequence:${r.template_id}`, 'error',
    `Sequence ${r.template_id} (${r.template_name || 'unknown'}) step ${r.step_number} failed (enrollment ${r.enrollment_id})`,
    r.error_message,
    { template_id: r.template_id, enrollment_id: r.enrollment_id, step_number: r.step_number }
  ));
  return { count: rows.length, rows: out,
    watermark: rows.length ? rows[rows.length - 1].id : undefined };
}

async function _scanHooks(db, wm) {
  const [rows] = await db.query(
    `SELECT id, hook_id, slug, status, error, created_at
       FROM hook_executions
      WHERE status IN ('failed','partial') AND id > ?
      ORDER BY id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  const out = rows.map(r => _streamRow(
    'hook', 'delivery_failed', 'hook_executions', r.id,
    `hook:${r.slug}`, 'error',
    `Hook '${r.slug}' delivery ${r.status}`,
    r.error,
    { hook_id: r.hook_id, slug: r.slug, status: r.status }
  ));
  return { count: rows.length, rows: out,
    watermark: rows.length ? rows[rows.length - 1].id : undefined };
}

/**
 * Summarize failed Layer-3 action outcomes from an executions metadata JSON.
 * Verified shape (identical in email + phone pipelines —
 * emailIngestService._buildMetadata / phoneIngestService._buildMetadata):
 *   metadata.action_outcomes = [{ rule_id, rule_action_id, action_type,
 *                                 status:'success'|'failed'
 *                                       |'skipped_test_envelope',
 *                                 error?, result? }]
 *
 * THREE entry shapes now reach this function, all counted identically by the
 * action_failure_count generated column:
 *   real action  { rule_id:N,    rule_action_id:N,    action_type:<dispatchable> }
 *   transform    { rule_id:N,    rule_action_id:null, action_type:'transform' }      T6/F-3
 *   evaluator    { rule_id:null, rule_action_id:null, action_type:'rule_evaluation' } T7/F-8
 * The null ids are meaningful, not missing data: a failed transform skips the
 * whole action set (no single action to blame), and a thrown evaluator never
 * matched a rule at all. _describeOutcome renders each without printing
 * "null" at a reader.
 */
function _describeOutcome(f) {
  const where = f.rule_id != null
    ? (f.rule_action_id != null ? `rule ${f.rule_id} action ${f.rule_action_id}`
                                : `rule ${f.rule_id}`)
    : 'layer 3';
  return `${where} (${f.action_type}): ${f.error || 'failed'}`;
}
function _failedOutcomes(metadata) {
  let m = metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return []; } }
  const arr = m?.action_outcomes;
  if (!Array.isArray(arr)) return [];
  return arr.filter(a => a && a.status === 'failed');
}

async function _scanEmailIngest(db, wm) {
  // action_failure_count is T2's indexed VIRTUAL generated column
  // (ref/2026-08-19_ingest_action_failure_count.sql). Using it instead of a
  // JSON_SEARCH predicate keeps ONE definition of "a failed outcome" (the
  // column expression) and lets the optimizer use idx_action_failures —
  // observed as an index_merge sort_union with idx_status_created on a
  // cold/backlogged watermark, or a PRIMARY range when `id > ?` is already
  // tiny. _failedOutcomes() below still parses metadata for the alert BODY;
  // only the row-selection predicate keys off the column.
  const [rows] = await db.query(
    `SELECT id, source_id, message_id, status, error, metadata, remote_ip, created_at
       FROM email_ingest_executions
      WHERE id > ?
        AND (status IN ('error','auth_failed','validation_failed')
             OR action_failure_count > 0)
      ORDER BY id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  const out = rows.map(r => {
    const errorStatuses = ['error', 'auth_failed', 'validation_failed'];
    const failed = _failedOutcomes(r.metadata);
    // ONE row per execution: status-kind wins when status is in the error
    // set; otherwise (clean status, failed action) → action_failed.
    const kind = errorStatuses.includes(r.status) ? r.status : 'action_failed';

    let title, message, context;
    if (kind === 'auth_failed') {
      // 'missing key' vs 'unknown key' is stored verbatim in `error` by
      // routes/api.emailIngest.js. "unknown key from a consistent IP" is the
      // broken-GAS-forwarder signature — surface the distinction.
      const keyState = r.error || 'unknown';
      title = `Email ingest auth failed (${keyState}) from ${r.remote_ip || 'unknown IP'}`;
      message = `${keyState} — remote_ip ${r.remote_ip || 'unknown'}`;
      context = { remote_ip: r.remote_ip, key_state: keyState, execution_id: r.id };
    } else if (kind === 'action_failed') {
      const summ = failed.map(_describeOutcome).join('; ');
      // 'failure(s)' not 'action(s)': the set now includes transform
      // (T6/F-3) and evaluator (T7/F-8) entries, which are not actions.
      // `kind` stays 'action_failed' — it feeds dedup_key and group_key,
      // and renaming it would orphan every existing alert row.
      title = `Email ingest: ${failed.length} Layer-3 failure(s) (execution ${r.id})`;
      message = summ;
      context = { execution_id: r.id, source_id: r.source_id, message_id: r.message_id,
                  failed_actions: failed.map(f => ({ rule_id: f.rule_id, rule_action_id: f.rule_action_id,
                    action_type: f.action_type, error: f.error || null })) };
    } else {
      title = `Email ingest execution ${r.id} ${kind}`;
      message = r.error;
      context = { execution_id: r.id, source_id: r.source_id, message_id: r.message_id,
                  remote_ip: r.remote_ip, ...(failed.length ? { also_failed_actions: failed.length } : {}) };
    }
    return _streamRow('email_ingest', kind, 'email_ingest_executions', r.id,
      `email_ingest:${kind}`, 'error', title, message, context);
  });
  return { count: rows.length, rows: out,
    watermark: rows.length ? rows[rows.length - 1].id : undefined };
}

async function _scanPhoneIngest(db, wm) {
  // Phone metadata shape verified separately — phoneIngestService._buildMetadata
  // and phoneIngestRuleService._dispatchAction are line-identical to email's
  // (same action_outcomes entry shape). Statuses differ: phone is
  // logged|suppressed|error|duplicate ('duplicate' added by MTH-2 — a true
  // provider redelivery; Layer 2/3 skipped, metadata null, so it can never
  // carry a failed outcome and needs no predicate here).
  //
  // action_failure_count predicate: same rationale as _scanEmailIngest —
  // single source of truth for "failed outcome" + idx_action_failures.
  const [rows] = await db.query(
    `SELECT id, event_log_id, status, error, metadata, created_at
       FROM phone_ingest_executions
      WHERE id > ?
        AND (status = 'error'
             OR action_failure_count > 0)
      ORDER BY id
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wm]
  );
  const out = rows.map(r => {
    const failed = _failedOutcomes(r.metadata);
    const kind = r.status === 'error' ? 'error' : 'action_failed';
    let title, message, context;
    if (kind === 'action_failed') {
      const summ = failed.map(_describeOutcome).join('; ');
      // 'failure(s)' not 'action(s)': the set now includes transform
      // (T6/F-3) and evaluator (T7/F-8) entries, which are not actions.
      // `kind` stays 'action_failed' — it feeds dedup_key and group_key,
      // and renaming it would orphan every existing alert row.
      title = `Phone ingest: ${failed.length} Layer-3 failure(s) (execution ${r.id})`;
      message = summ;
      context = { execution_id: r.id, event_log_id: r.event_log_id,
                  failed_actions: failed.map(f => ({ rule_id: f.rule_id, rule_action_id: f.rule_action_id,
                    action_type: f.action_type, error: f.error || null })) };
    } else {
      title = `Phone ingest execution ${r.id} error`;
      message = r.error;
      context = { execution_id: r.id, event_log_id: r.event_log_id,
                  ...(failed.length ? { also_failed_actions: failed.length } : {}) };
    }
    return _streamRow('phone_ingest', kind, 'phone_ingest_executions', r.id,
      `phone_ingest:${kind}`, 'error', title, message, context);
  });
  return { count: rows.length, rows: out,
    watermark: rows.length ? rows[rows.length - 1].id : undefined };
}

async function _scanCampaigns(db, wmSentAt) {
  // campaign_results rows are UPSERTED on retry — id watermarks unsafe.
  // Overlap-inclusive >= on sent_at is intentional: the dedup_key absorbs
  // boundary re-reads. Watermark = max(sent_at) seen (as 'YYYY-MM-DD HH:MM:SS').
  const [rows] = await db.query(
    `SELECT result_id, campaign_id, contact_id, status, error, sent_at
       FROM campaign_results
      WHERE status = 'failed' AND sent_at >= ?
      ORDER BY sent_at
      LIMIT ${STREAM_BATCH_LIMIT}`,
    [wmSentAt]
  );
  const out = rows.map(r => _streamRow(
    'campaign', 'send_failed', 'campaign_results', r.result_id,
    `campaign:${r.campaign_id}`, 'error',
    `Campaign ${r.campaign_id} send failed (contact ${r.contact_id})`,
    r.error,
    { campaign_id: r.campaign_id, contact_id: r.contact_id, result_id: r.result_id }
  ));
  let watermark;
  if (rows.length) {
    const maxTs = rows[rows.length - 1].sent_at;
    watermark = new Date(maxTs).toISOString().slice(0, 19).replace('T', ' ');
  }
  return { count: rows.length, rows: out, watermark };
}

/**
 * Stateful oauth source — open/close, dedup_key NULL.
 * OPEN: refresh_failed credential with no open alert row → one critical row.
 *   NOT routed through the immediate-send path — it rides this sweep's digest
 *   at the top (critical-first ordering).
 * CLOSE: any open oauth row whose group_key doesn't match a currently-
 *   refresh_failed credential gets resolved — covers both recovered AND
 *   deleted credentials in one pass.
 */
async function _scanOauth(db, dryRun) {
  const [failing] = await db.query(
    `SELECT id, name, oauth_last_error, oauth_last_error_at
       FROM credentials
      WHERE type = 'oauth2' AND oauth_status = 'refresh_failed'`
  );
  const [openRows] = await db.query(
    `SELECT id, group_key FROM system_alerts
      WHERE source = 'oauth' AND resolved_at IS NULL`
  );
  const openByGroup = new Map(openRows.map(r => [r.group_key, r.id]));
  const failingGroups = new Set(failing.map(c => `oauth:${c.id}`));

  const toOpen = failing.filter(c => !openByGroup.has(`oauth:${c.id}`));
  const toClose = openRows.filter(r => !failingGroups.has(r.group_key));

  let opened = 0, closed = 0;
  if (!dryRun) {
    for (const c of toOpen) {
      const gk = `oauth:${c.id}`;
      try {
        await db.query(
          `INSERT INTO system_alerts
             (source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key)
           VALUES ('oauth', 'refresh_failed', ?, 'critical', ?, ?, ?, 'credentials', ?, NULL)`,
          [
            gk,
            _trunc(`OAuth credential ${c.id} (${c.name}) refresh failed`, 500),
            _trunc(`oauth_last_error: ${c.oauth_last_error || '(none recorded)'}`),
            JSON.stringify({ credential_id: c.id, name: c.name,
              oauth_last_error_at: c.oauth_last_error_at }),
            c.id,
          ]
        );
        await db.query(
          `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count)
           VALUES (?, NOW(), NOW(), 1)
           ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1`,
          [gk]
        );
        opened++;
      } catch (err) {
        console.error(`[alerting] oauth open for ${gk} failed:`, err.message);
      }
    }
    if (toClose.length) {
      const [r] = await db.query(
        `UPDATE system_alerts SET resolved_at = NOW()
          WHERE source = 'oauth' AND resolved_at IS NULL AND group_key IN (?)`,
        [toClose.map(r => r.group_key)]
      );
      closed = r.affectedRows;
    }
  } else {
    opened = toOpen.length;
    closed = toClose.length;
  }
  return { opened, closed, failingCount: failing.length };
}

/**
 * Stateful stuck-execution source — open/close, dedup_key NULL.
 * Catches workflow executions that stopped moving but never reached a
 * terminal status — invisible to every stream scanner above (no row
 * anywhere says 'failed'):
 *   - 'processing' stale > STUCK_EXEC_MINUTES: recoverStuckJobs (1-min
 *     poll cadence, 15-min window) should have flipped it within ~16 min —
 *     if it's still 'processing', recovery itself is down or erroring.
 *   - 'active' stale with no pending/running workflow_resume job: zombie —
 *     the detached advance died and nothing will ever resume it (observed
 *     7×, 2026-03→2026-08: executions 16, 17, 850, 4850, 5060, 6702, 8336).
 *   - 'delayed' stale with no pending/running workflow_resume job:
 *     orphaned delay — its resume job was cancelled or lost.
 * 'held' is deliberate parking (capture slice) — excluded.
 * OPEN: stuck execution with no open alert row → one 'error' row per
 *   execution (rides this sweep's digest).
 * CLOSE: open row whose execution no longer matches the predicate —
 *   covers auto-resume success, manual remediation, and deletion.
 */
const STUCK_EXEC_MINUTES = 30;

// Workflow start-latency thresholds (see _scanStartLatency below).
// Start latency = workflow_executions.created_at → the EARLIEST executed_at
// of that execution's step_number = 1 row(s). Measured on live data
// 2026-08-01 → 08-22, split on the 2026-08-20 07:20:38 dispatch deploy that
// introduced a uniform 0–60s wait before the first step:
//     before   n=1586,   10 starts >20s  ( 0.6%),  max  55s
//     after    n= 197,  147 starts >20s  (74.6%),  max  61s
// Two orders of magnitude apart, so a plain rate-over-threshold separates
// them cleanly and no percentile function is warranted.
const START_LAT_BREACH_S   = 20;  // a start slower than this is a breach
const START_LAT_WINDOW_MIN = 60;  // trailing window. NB the sweep (job 867)
                                  // runs */15, so this window is evaluated
                                  // ~4x/hour with 75% overlap — overlap
                                  // smooths; stateful open/close can't flap.
const START_LAT_MIN_SAMPLE = 5;   // below this the rate is noise — skip entirely
const START_LAT_OPEN_PCT   = 25;  // open above this breach rate (0.6% vs 74.6%)

async function _scanStuckExecutions(db, dryRun) {
  const [stuck] = await db.query(
    `SELECT e.id, e.workflow_id, e.status, e.current_step_number,
            e.steps_executed_count, e.updated_at, w.name AS workflow_name
       FROM workflow_executions e
       LEFT JOIN workflows w ON w.id = e.workflow_id
      WHERE e.updated_at < NOW() - INTERVAL ${STUCK_EXEC_MINUTES} MINUTE
        AND (
             e.status = 'processing'
          OR (e.status IN ('active','delayed') AND NOT EXISTS (
                SELECT 1 FROM scheduled_jobs j
                 WHERE j.workflow_execution_id = e.id
                   AND j.type = 'workflow_resume'
                   AND j.status IN ('pending','running')))
        )
      LIMIT 200`
  );
  const [openRows] = await db.query(
    `SELECT id, group_key FROM system_alerts
      WHERE source = 'workflow' AND kind = 'execution_stuck' AND resolved_at IS NULL`
  );
  const openByGroup = new Map(openRows.map(r => [r.group_key, r.id]));
  const stuckGroups = new Set(stuck.map(e => `wf_exec_stuck:${e.id}`));

  const toOpen = stuck.filter(e => !openByGroup.has(`wf_exec_stuck:${e.id}`));
  const toClose = openRows.filter(r => !stuckGroups.has(r.group_key));

  let opened = 0, closed = 0;
  if (!dryRun) {
    for (const e of toOpen) {
      const gk = `wf_exec_stuck:${e.id}`;
      try {
        await db.query(
          `INSERT INTO system_alerts
             (source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key)
           VALUES ('workflow', 'execution_stuck', ?, 'error', ?, ?, ?, 'workflow_executions', ?, NULL)`,
          [
            gk,
            _trunc(`Workflow ${e.workflow_id} (${e.workflow_name || 'unknown'}) execution ${e.id} stuck at '${e.status}'`, 500),
            _trunc(
              `No progress since ${e.updated_at instanceof Date ? e.updated_at.toISOString() : e.updated_at}. ` +
              `${e.steps_executed_count ?? 0} step(s) executed, step pointer ${e.current_step_number ?? 'NULL'}. ` +
              `Needs triage: resume, or mark completed/cancelled.`
            ),
            JSON.stringify({
              execution_id: e.id, workflow_id: e.workflow_id,
              exec_status: e.status, current_step_number: e.current_step_number,
              steps_executed_count: e.steps_executed_count,
            }),
            e.id,
          ]
        );
        await db.query(
          `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count)
           VALUES (?, NOW(), NOW(), 1)
           ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1`,
          [gk]
        );
        opened++;
      } catch (err) {
        console.error(`[alerting] stuck-exec open for ${gk} failed:`, err.message);
      }
    }
    if (toClose.length) {
      const [r] = await db.query(
        `UPDATE system_alerts SET resolved_at = NOW()
          WHERE source = 'workflow' AND kind = 'execution_stuck' AND resolved_at IS NULL
            AND group_key IN (?)`,
        [toClose.map(r => r.group_key)]
      );
      closed = r.affectedRows;
    }
  } else {
    opened = toOpen.length;
    closed = toClose.length;
  }
  return { opened, closed, stuckCount: stuck.length };
}

/**
 * Stateful start-latency source — open/close, dedup_key NULL.
 *
 * WHY THIS EXISTS: on 2026-08-20 a dispatch change added a uniform 0–60s
 * wait before hook-started workflows ran their first step. It went unnoticed
 * for ~36 hours and surfaced only as a stale Clio 2FA code two layers
 * downstream. The regression was plainly visible in this data the whole
 * time — nothing was looking at it. This scanner looks at it.
 *
 * METRIC: per execution, created_at → MIN(executed_at) across its
 * step_number = 1 rows, over a trailing START_LAT_WINDOW_MIN window.
 * Three details in that query are load-bearing:
 *
 *   MIN(), not a bare join. A step 1 that fails and retries writes a SECOND
 *   step_number = 1 row rather than updating the first (live proof:
 *   execution 9609 — row 41414 failed at +9s, row 41427 succeeded at
 *   +2518s). A bare join both double-counts the denominator and scores the
 *   RETRY as a slow start; that one row is the entire difference between a
 *   2518s and a 55s pre-deploy maximum. Step failure/retry is
 *   _scanWorkflows' job, not this one's.
 *
 *   executed_at IS NOT NULL on the join. An execution in flight, or one
 *   that never started at all, contributes to NEITHER numerator nor
 *   denominator — it cannot be scored as a zero-latency start, and it
 *   cannot be scored as a breach.
 *
 *   GREATEST(diff, 0). A negative diff is a clock artifact or a backdated
 *   created_at, never evidence of slowness. Clamping keeps the row in the
 *   denominator without letting it score as a breach; dropping it instead
 *   would quietly shrink the sample during exactly the sort of
 *   infrastructure incident this exists to catch. (0 observed since
 *   2026-08-01.)
 *
 * SEVERITY IS 'error', DELIBERATELY. Phase B sends email only when an
 * eligible group meets alert_email_min_severity (default 'error');
 * sub-threshold groups piggyback on someone else's digest but never trigger
 * one alone. A 'warning' here could therefore sit unread for days waiting
 * for an unrelated error to ride in on — the precise failure this scanner
 * exists to prevent.
 *
 * ONE GLOBAL GROUP, not one per workflow. The failure mode is systemic (a
 * shared dispatch path), so per-workflow rows would fire several at once
 * and all say the same thing. The per-workflow breakdown rides in context.
 *
 * OPEN:  breach rate > START_LAT_OPEN_PCT with no open row → one 'error' row.
 * CLOSE: an open row on a later sweep where the rate is back under the bar.
 *
 * BLIND SPOT (documented, not accidental): if dispatch dies COMPLETELY, no
 * execution ever gets a step-1 row, sampleSize is 0, and this scanner stays
 * silent — total failure is indistinguishable here from a quiet night. That
 * case belongs to _scanStuckExecutions, which covers 'processing' /
 * 'active' / 'delayed' but NOT 'pending' — so a dispatcher that never picks
 * anything up at all is presently unwatched by either. Flagged, not fixed
 * here.
 */
const START_LAT_GROUP_KEY = 'wf_start_latency:global';

async function _scanStartLatency(db, dryRun) {
  const [perWf] = await db.query(
    `SELECT t.workflow_id,
            COALESCE(w.name, CONCAT('workflow ', t.workflow_id)) AS workflow_name,
            COUNT(*)                           AS n,
            SUM(t.lat > ${START_LAT_BREACH_S}) AS breaches,
            ROUND(AVG(t.lat), 1)               AS avg_s,
            MAX(t.lat)                         AS max_s
       FROM (
         SELECT e.id, e.workflow_id,
                GREATEST(TIMESTAMPDIFF(SECOND, e.created_at, MIN(s.executed_at)), 0) AS lat
           FROM workflow_executions e
           JOIN workflow_execution_steps s
             ON s.workflow_execution_id = e.id
            AND s.step_number = 1
            AND s.executed_at IS NOT NULL
          WHERE e.created_at >= NOW() - INTERVAL ${START_LAT_WINDOW_MIN} MINUTE
          GROUP BY e.id, e.workflow_id
       ) t
       LEFT JOIN workflows w ON w.id = t.workflow_id
      GROUP BY t.workflow_id, w.name
      ORDER BY breaches DESC, n DESC`
  );

  const byWorkflow = (perWf || []).map(r => ({
    workflow_id:   r.workflow_id,
    workflow_name: r.workflow_name,
    n:             Number(r.n)        || 0,
    breaches:      Number(r.breaches) || 0,
    avg_s:         Number(r.avg_s)    || 0,
    max_s:         Number(r.max_s)    || 0,
  }));
  const sampleSize = byWorkflow.reduce((a, r) => a + r.n, 0);
  const breaches   = byWorkflow.reduce((a, r) => a + r.breaches, 0);

  const [openRows] = await db.query(
    `SELECT id FROM system_alerts
      WHERE source = 'workflow' AND kind = 'start_latency'
        AND group_key = ? AND resolved_at IS NULL`,
    [START_LAT_GROUP_KEY]
  );
  const isOpen = (openRows || []).length > 0;

  // QUIET-HOUR GATE — below the sample floor we do NOTHING: no open, and no
  // close either. CHOSE SKIP OVER CLOSE. A window holding two starts is not
  // evidence that latency is healthy, so resolving on one would let a live
  // regression clear itself at 03:00 and go quiet. Concretely: on
  // 2026-08-20 the hourly sample fell below 5 seven times while the
  // regression was active — closing on those would have flapped this alert
  // open and shut five separate times instead of opening once and staying
  // open until the fix landed.
  if (sampleSize < START_LAT_MIN_SAMPLE) {
    return {
      opened: 0, closed: 0, breachRate: null, sampleSize,
      breaches, skipped: 'below_min_sample', alreadyOpen: isOpen,
    };
  }

  const breachRate = breaches / sampleSize;
  const pct        = Math.round(breachRate * 100);
  const degraded   = pct > START_LAT_OPEN_PCT;

  let opened = 0, closed = 0;

  if (degraded && !isOpen) {
    if (dryRun) {
      opened = 1;
    } else {
      try {
        const shown = byWorkflow.filter(r => r.breaches > 0).slice(0, 5);
        const more  = byWorkflow.filter(r => r.breaches > 0).length - shown.length;
        await db.query(
          `INSERT INTO system_alerts
             (source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key)
           VALUES ('workflow', 'start_latency', ?, 'error', ?, ?, ?, NULL, NULL, NULL)`,
          [
            START_LAT_GROUP_KEY,
            _trunc(
              `Workflow start latency degraded — ${pct}% of starts over ` +
              `${START_LAT_BREACH_S}s in the last hour (n=${sampleSize})`, 500),
            _trunc(
              `${breaches} of ${sampleSize} workflow start(s) in the last ` +
              `${START_LAT_WINDOW_MIN}min exceeded ${START_LAT_BREACH_S}s from execution ` +
              `creation to first step. Baseline is under 1%.\nPer workflow:\n` +
              shown.map(r =>
                `  #${r.workflow_id} ${r.workflow_name}: ${r.breaches}/${r.n} over, ` +
                `avg ${r.avg_s}s max ${r.max_s}s`).join('\n') +
              (more > 0 ? `\n  …and ${more} more` : '') +
              `\nLook at the dispatch path that starts step 1, not the workflows.`
            ),
            JSON.stringify({
              window_minutes:     START_LAT_WINDOW_MIN,
              window_start:       new Date(Date.now() - START_LAT_WINDOW_MIN * 60000).toISOString(),
              window_end:         new Date().toISOString(),
              breach_threshold_s: START_LAT_BREACH_S,
              open_threshold_pct: START_LAT_OPEN_PCT,
              sample_size:        sampleSize,
              breaches,
              breach_rate:        Number(breachRate.toFixed(3)),
              by_workflow:        byWorkflow,
            }),
          ]
        );
        await db.query(
          `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count)
           VALUES (?, NOW(), NOW(), 1)
           ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1`,
          [START_LAT_GROUP_KEY]
        );
        opened = 1;
      } catch (err) {
        console.error(`[alerting] start-latency open for ${START_LAT_GROUP_KEY} failed:`, err.message);
      }
    }
  } else if (!degraded && isOpen) {
    if (dryRun) {
      closed = openRows.length;
    } else {
      const [r] = await db.query(
        `UPDATE system_alerts SET resolved_at = NOW()
          WHERE source = 'workflow' AND kind = 'start_latency'
            AND group_key = ? AND resolved_at IS NULL`,
        [START_LAT_GROUP_KEY]
      );
      closed = r.affectedRows;
    }
  }

  return {
    opened, closed,
    breachRate: Number(breachRate.toFixed(3)),
    sampleSize, breaches,
  };
}

// ────────────────────────────────────────────────────────────
// runErrorSweep
// ────────────────────────────────────────────────────────────

const WM_DEFS = [
  // [stateKey, scanner, initializer]
  ['wf_step_id',      _scanWorkflows,     (db) => _maxId(db, 'workflow_execution_steps')],
  ['job_result_id',   _scanScheduledJobs, (db) => _maxId(db, 'job_results')],
  ['seq_log_id',      _scanSequences,     (db) => _maxId(db, 'sequence_step_log')],
  ['hook_exec_id',    _scanHooks,         (db) => _maxId(db, 'hook_executions')],
  ['email_ingest_id', _scanEmailIngest,   (db) => _maxId(db, 'email_ingest_executions')],
  ['phone_ingest_id', _scanPhoneIngest,   (db) => _maxId(db, 'phone_ingest_executions')],
  ['campaign_sent_at', _scanCampaigns,    () => Promise.resolve(_nowSql())],
];

const SOURCE_LABEL = {
  wf_step_id: 'workflow', job_result_id: 'scheduled_job', seq_log_id: 'sequence',
  hook_exec_id: 'hook', email_ingest_id: 'email_ingest', phone_ingest_id: 'phone_ingest',
  campaign_sent_at: 'campaign',
};

async function _maxId(db, table) {
  const [[r]] = await db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM \`${table}\``);
  return Number(r.m);
}

function _nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Error sweep — job 867, every 15 minutes. Phase A scans + records; Phase B digests + emails.
 *
 * @param {object} db
 * @param {object} params
 * @param {boolean} [params.dry_run] — scan + build digest, send nothing,
 *   advance no watermarks, write no rows; return what WOULD happen.
 *   NOTES on dry_run semantics (documented limitations, not bugs):
 *     - new_alerts is the candidate count (upper bound — dedup against
 *       already-inserted rows is not simulated).
 *     - Phase B evaluates EXISTING undigested rows only (the dry candidates
 *       were never inserted, so they can't appear in the digest preview).
 *     - First-run watermark initialization is NOT persisted; the first real
 *       run re-initializes.
 */
async function runErrorSweep(db, params = {}) {
  const dryRun = !!params.dry_run;
  const out = {
    scanned: {}, new_alerts: 0, opened: 0, closed: 0,
    groups_digested: 0, groups_suppressed: 0, warnings_included: 0,
    email_sent: false, sms_fallback_used: false, dry_run: dryRun,
  };
  let sweepHealthy = true;

  // ── PHASE A — SCAN ──────────────────────────────────────────
  let state = {};
  try {
    const raw = await _getSetting(db, 'error_sweep_state');
    state = raw ? JSON.parse(raw) : {};
    if (state == null || typeof state !== 'object') state = {};
  } catch (err) {
    console.error('[alerting] error_sweep_state unreadable, treating as fresh:', err.message);
    state = {};
  }

  const persistState = async () => {
    if (dryRun) return;
    try { await _setSetting(db, 'error_sweep_state', JSON.stringify(state)); }
    catch (err) { sweepHealthy = false; console.error('[alerting] watermark persist failed:', err.message); }
  };

  // Initialize missing watermarks to current max / NOW() — first run alerts
  // on nothing historical. Persist the initialized state immediately.
  let initialized = false;
  for (const [key, , init] of WM_DEFS) {
    if (state[key] == null) {
      try { state[key] = await init(db); initialized = true; }
      catch (err) {
        sweepHealthy = false;
        console.error(`[alerting] watermark init for ${key} failed:`, err.message);
      }
    }
  }
  if (initialized) await persistState();

  for (const [key, scanner] of WM_DEFS) {
    const source = SOURCE_LABEL[key];
    try {
      if (state[key] == null) throw new Error(`watermark ${key} uninitialized`);
      const res = await scanner(db, state[key]);
      out.scanned[source] = res.count;

      if (!dryRun) {
        for (const row of res.rows) {
          try {
            const [r] = await db.query(
              `INSERT IGNORE INTO system_alerts
                 (source, kind, group_key, severity, title, message, context, ref_table, ref_id, dedup_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [row.source, row.kind, row.group_key, row.severity, row.title, row.message,
               row.context != null ? JSON.stringify(row.context) : null,
               row.ref_table, row.ref_id, row.dedup_key]
            );
            if (r.affectedRows > 0) {
              out.new_alerts++;
              await db.query(
                `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count)
                 VALUES (?, NOW(), NOW(), 1)
                 ON DUPLICATE KEY UPDATE last_seen = NOW(), occurrence_count = occurrence_count + 1`,
                [row.group_key]
              );
            }
          } catch (err) {
            sweepHealthy = false;
            console.error(`[alerting] insert for ${row.dedup_key} failed:`, err.message);
          }
        }
        // Persist this source's watermark immediately after its inserts —
        // the dedup_key makes a crash between insert and watermark harmless.
        if (res.watermark !== undefined) {
          state[key] = res.watermark;
          await persistState();
        }
      } else {
        out.new_alerts += res.count; // upper bound (see dry_run notes)
      }
    } catch (err) {
      // One broken source query must not kill the rest.
      sweepHealthy = false;
      console.error(`[alerting] scan for source '${source}' failed:`, err.message);
      out.scanned[source] = null;
      if (!dryRun) {
        await alert(db, {
          source: 'sweep', kind: 'scan_error', group_key: `sweep:${source}`,
          severity: 'error',
          title: `Error sweep: '${source}' scan failed`,
          message: err.message,
          context: { source, watermark_key: key, watermark_value: state[key] ?? null },
          // Date-bucketed dedup: one ledger row per broken source per day —
          // without this a persistently broken scan inserts 24 rows/day.
          dedup_key: `sweep:scan_error:${source}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }
  }

  // Stateful: oauth open/close.
  try {
    const oc = await _scanOauth(db, dryRun);
    out.opened = oc.opened;
    out.closed = oc.closed;
    out.scanned.oauth = oc.failingCount;
  } catch (err) {
    sweepHealthy = false;
    console.error('[alerting] oauth scan failed:', err.message);
    out.scanned.oauth = null;
    if (!dryRun) {
      await alert(db, {
        source: 'sweep', kind: 'scan_error', group_key: 'sweep:oauth',
        severity: 'error', title: `Error sweep: 'oauth' scan failed`, message: err.message,
        dedup_key: `sweep:scan_error:oauth:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }

  // Stateful: stuck workflow executions open/close.
  try {
    const sc = await _scanStuckExecutions(db, dryRun);
    out.opened += sc.opened;
    out.closed += sc.closed;
    out.scanned.stuck_executions = sc.stuckCount;
  } catch (err) {
    sweepHealthy = false;
    console.error('[alerting] stuck-execution scan failed:', err.message);
    out.scanned.stuck_executions = null;
    if (!dryRun) {
      await alert(db, {
        source: 'sweep', kind: 'scan_error', group_key: 'sweep:stuck_executions',
        severity: 'error', title: `Error sweep: 'stuck_executions' scan failed`, message: err.message,
        dedup_key: `sweep:scan_error:stuck_executions:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }

  // Stateful: workflow start-latency degradation open/close.
  try {
    const lc = await _scanStartLatency(db, dryRun);
    out.opened += lc.opened;
    out.closed += lc.closed;
    out.scanned.start_latency = lc.sampleSize;
    out.start_latency = lc;   // breachRate/sampleSize — makes a sweep run legible
  } catch (err) {
    sweepHealthy = false;
    console.error('[alerting] start-latency scan failed:', err.message);
    out.scanned.start_latency = null;
    if (!dryRun) {
      await alert(db, {
        source: 'sweep', kind: 'scan_error', group_key: 'sweep:start_latency',
        severity: 'error', title: `Error sweep: 'start_latency' scan failed`, message: err.message,
        dedup_key: `sweep:scan_error:start_latency:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }

  // ── PHASE B — DIGEST ────────────────────────────────────────
  try {
    const cooldownHours = Number(await _getSetting(db, 'alert_cooldown_hours')) || 6;
    const minSevName = (await _getSetting(db, 'alert_email_min_severity')) || 'error';
    const minSev = _sevRank(minSevName);

    const [rows] = await db.query(
      `SELECT a.id, a.source, a.kind, a.group_key, a.severity, a.title, a.message,
              a.ref_table, a.ref_id, a.created_at,
              st.first_seen, st.last_alerted_at, st.occurrence_count
         FROM system_alerts a
         LEFT JOIN alert_state st ON st.group_key = a.group_key
        WHERE a.digested_at IS NULL AND a.acked_at IS NULL AND a.resolved_at IS NULL
        ORDER BY a.id`
    );

    // Group by group_key.
    const groups = new Map();
    for (const r of rows) {
      let g = groups.get(r.group_key);
      if (!g) {
        g = { group_key: r.group_key, source: r.source, rows: [], maxSev: 0,
              first_seen: r.first_seen, last_alerted_at: r.last_alerted_at,
              occurrence_count: r.occurrence_count };
        groups.set(r.group_key, g);
      }
      g.rows.push(r);
      g.maxSev = Math.max(g.maxSev, _sevRank(r.severity));
    }

    // Cooldown: groups alerted within the window stay undigested (counted
    // for the footer).
    const now = Date.now();
    const eligible = [];
    for (const g of groups.values()) {
      const la = g.last_alerted_at ? new Date(g.last_alerted_at).getTime() : null;
      if (la && (now - la) < cooldownHours * 3600 * 1000) out.groups_suppressed++;
      else eligible.push(g);
    }

    // EMAIL TRIGGER RULE: send ONLY if at least one eligible group meets the
    // min-severity bar. Sub-threshold ("warning") groups piggyback as compact
    // lines but never trigger an email alone. INTENTIONAL: with no
    // error/critical for days, warnings accumulate undigested and ride the
    // next real digest as a visible backlog.
    const triggering = eligible.filter(g => g.maxSev >= minSev);
    const piggyback  = eligible.filter(g => g.maxSev < minSev);

    if (triggering.length && !dryRun) {
      triggering.sort((a, b) => b.maxSev - a.maxSev || a.group_key.localeCompare(b.group_key));

      const totalRows = triggering.reduce((n, g) => n + g.rows.length, 0)
                      + piggyback.reduce((n, g) => n + g.rows.length, 0);
      const sources = new Set([...triggering, ...piggyback].map(g => g.source));
      const anyCritical = triggering.some(g => g.maxSev >= SEVERITY_RANK.critical);
      const subject = `${anyCritical ? 'CRITICAL: ' : ''}[YisraCase] ${totalRows} failure(s) across ${sources.size} source(s)`;

      const sevColor = { critical: '#b91c1c', error: '#dc2626', warning: '#d97706', info: '#6b7280' };
      const blocks = [];
      const shown = triggering.slice(0, DIGEST_GROUP_CAP);
      for (const g of shown) {
        const latest = g.rows[g.rows.length - 1];
        const first = g.rows[0];
        const sevName = Object.keys(SEVERITY_RANK).find(k => SEVERITY_RANK[k] === g.maxSev) || 'error';
        const ongoing = (g.occurrence_count && g.occurrence_count > g.rows.length)
          ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px">(ongoing since ${_fmtTs(g.first_seen)}, ${g.occurrence_count} total)</div>`
          : '';
        const refs = g.rows.slice(-5).map(r => `${r.ref_table || '?'}#${r.ref_id ?? '?'}`).join(', ');
        blocks.push(`
          <div style="margin:0 0 18px;padding:12px 14px;border:1px solid #e5e7eb;border-left:4px solid ${sevColor[sevName] || '#dc2626'};border-radius:4px">
            <div style="font-size:14px;font-weight:700;color:#111827">${_esc(g.group_key)} — ${g.rows.length} failure(s)</div>
            <div style="font-size:12px;color:#6b7280;margin:2px 0 6px">
              ${_esc(sevName)} · first ${_fmtTs(first.created_at)} · last ${_fmtTs(latest.created_at)} · refs: ${_esc(refs)}
            </div>
            <div style="font-size:13px;color:#374151;margin:0 0 4px">${_esc(latest.title)}</div>
            ${latest.message ? `<div style="font-size:12px;color:#4b5563;background:#f9fafb;padding:8px 10px;border-radius:3px;white-space:pre-wrap">${_esc(_trunc(latest.message, 400))}</div>` : ''}
            ${ongoing}
          </div>`);
      }
      if (triggering.length > DIGEST_GROUP_CAP) {
        blocks.push(`<p style="font-size:12px;color:#6b7280">…and ${triggering.length - DIGEST_GROUP_CAP} more group(s) not shown (${triggering.slice(DIGEST_GROUP_CAP).reduce((n, g) => n + g.rows.length, 0)} failures).</p>`);
      }

      let warnSection = '';
      if (piggyback.length) {
        const lines = piggyback.map(g => {
          const latest = g.rows[g.rows.length - 1];
          return `<tr>
            <td style="padding:4px 8px 4px 0;font-size:12px;color:#92400e;font-weight:600;white-space:nowrap">${_esc(g.group_key)}</td>
            <td style="padding:4px 8px 4px 0;font-size:12px;color:#6b7280;white-space:nowrap">×${g.rows.length}</td>
            <td style="padding:4px 0;font-size:12px;color:#4b5563">${_esc(_trunc(latest.message || latest.title, 140))}</td>
          </tr>`;
        }).join('');
        warnSection = `
          <h3 style="margin:20px 0 6px;font-size:14px;color:#92400e">Warnings (piggybacked)</h3>
          <table cellpadding="0" cellspacing="0" style="width:100%">${lines}</table>`;
      }

      const footer = out.groups_suppressed > 0
        ? `<p style="margin:16px 0 0;font-size:12px;color:#9ca3af">${out.groups_suppressed} ongoing group(s) suppressed by cooldown.</p>`
        : '';

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px">
          <h2 style="margin:0 0 14px;font-size:20px;color:#111827">${anyCritical ? '🚨' : '⚠️'} YisraCase failure digest</h2>
          ${blocks.join('')}
          ${warnSection}
          ${footer}
        </div>`;

      const sent = await sendAlertEmail(db, { subject, html });
      out.email_sent = sent;

      if (sent) {
        // ON SUCCESSFUL SEND ONLY: stamp included rows (warnings too) and
        // included groups.
        const includedGroups = [...shown, ...piggyback];
        const ids = includedGroups.flatMap(g => g.rows.map(r => r.id));
        if (ids.length) {
          await db.query('UPDATE system_alerts SET digested_at = NOW() WHERE id IN (?)', [ids]);
        }
        const gks = includedGroups.map(g => g.group_key);
        if (gks.length) {
          await db.query(
            `INSERT INTO alert_state (group_key, first_seen, last_seen, occurrence_count, last_alerted_at)
             VALUES ${gks.map(() => '(?, NOW(), NOW(), 0, NOW())').join(', ')}
             ON DUPLICATE KEY UPDATE last_alerted_at = NOW()`,
            gks
          );
        }
        out.groups_digested = shown.length;
        out.warnings_included = piggyback.length;
      } else {
        // Rows stay undigested — next sweep retries. SMS fallback.
        sweepHealthy = false;
        const pending = triggering.reduce((n, g) => n + g.rows.length, 0);
        out.sms_fallback_used = await smsFallback(
          db, `YisraCase: alert email delivery failed. ${pending} alerts pending.`
        );
      }
    } else if (triggering.length && dryRun) {
      out.groups_digested = Math.min(triggering.length, DIGEST_GROUP_CAP);
      out.warnings_included = piggyback.length;
      out.email_sent = false; // would have sent
    }
  } catch (err) {
    sweepHealthy = false;
    console.error('[alerting] digest phase failed:', err.message);
  }

  // ── HEARTBEAT — only on a fully successful, non-dry run ────
  if (!dryRun && sweepHealthy) {
    try { await _setSetting(db, 'alert_last_sweep_at', new Date().toISOString()); }
    catch (err) { console.error('[alerting] heartbeat write failed:', err.message); }
  }

  return out;
}

module.exports = { alert, runErrorSweep, sendAlertEmail, smsFallback };