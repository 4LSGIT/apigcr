// lib/internal_functions/court.js
const emailService   = require('../../services/emailService');
const { getSetting }              = require('../../services/settingsService');

const fns = {};

// ─────────────────────────────────────────────────────────────
// COURT EMAIL — AI EXTRACTION (Slice 5)
// ─────────────────────────────────────────────────────────────
//
// Wires the live email-ingest path to the LLM court-email extractor in a
// forced-dry-run posture. Registered for use by an email_ingest_rule_actions
// row (action_type='internal_function'); NOT meant for the workflow/sequence
// step editor, so it intentionally carries NO __meta (it reads raw envelope
// dot-paths supplied via the rule's params_mapping, which only exist in the
// ingest pipeline).
//
// INVOCATION CONVENTION (verified against lib/actionDispatchers.deliverInternalFunction):
//   called as fn(params, db). `params` is resolveParamsMapping(action.config
//   .params_mapping, transformedInput) where transformedInput is the canonical
//   email envelope (rule transform_mode='passthrough'). So each param is a
//   dot-path read off the envelope:
//     message_id      ← headers.message_id        (gmail id; carries -test- on replays)
//     exim_message_id ← envelope.exim_message_id  (fallback id source)
//     subject         ← subject
//     from_email      ← from.email
//     body            ← text   (court NEFs put the body in text; html is a fallback)
//     body_html       ← html
//
// DRY-RUN: read app_settings 'court_ingest_live'. Absent/'0' → dryRun=true;
//   '1' → dryRun=false. THIS SLICE NEVER FLIPS IT (default-dry). Additionally,
//   executeCourtActions FORCES dry-run whenever message_id matches /-test-/,
//   so GAS -test- replays are always dry regardless of the flag.
//
// SAFETY: every failure path is caught and logged (court_ai_log via
//   logExtractFailure) and returns a soft result — one bad court email must
//   never break the ingest pipeline. The forensic email_log row is already
//   durable by the time Layer 3 runs, so nothing is lost.

fns.court_extract = async (params, db) => {
    const courtExecutor = require('../../services/courtExecutor');  // lazy require (convention)
    const aiService     = require('../../services/aiService');      // lazy require (convention)
    // getSetting is imported at module scope.

    // Canonical message_id — replicate emailIngestService._resolveMessageId so
    // the id we stamp matches the email_log row exactly (incl. the -test- marker).
    const rawId =
      (params.message_id && String(params.message_id).trim()) ||
      (params.exim_message_id && String(params.exim_message_id).trim()) ||
      null;
    const messageId = rawId
      ? (rawId.replace(/^<+/, '').replace(/>+$/, '').trim() || null)
      : null;

    const subject   = params.subject != null ? String(params.subject) : '';
    const fromEmail = params.from_email != null ? String(params.from_email) : '';
    const body =
      (params.body != null && params.body !== '')
        ? String(params.body)
        : (params.body_html != null ? String(params.body_html) : '');

    // Effective dry-run flag (fail-safe to dry if the setting read throws).
    let dryRun = true;
    try {
      const liveFlag = await getSetting(db, 'court_ingest_live');
      dryRun = String(liveFlag ?? '').trim() !== '1';
    } catch (e) {
      dryRun = true;
    }

    console.log(`[COURT_EXTRACT] message_id=${messageId || '(none)'} dryRun=${dryRun}`);

    try {
      const extract = await aiService.call(db, {
        promptKey:   'court_extract',
        vars:        { message_id: messageId, subject, from_email: fromEmail },
        // SECURITY (prompt v3): subject + sender are attacker-influenceable, so
        // they ride INSIDE <untrusted_user_input> (prepended to the body) rather
        // than the trusted system block. Keep this identical to the courtPreview
        // run handler and the backtest call site.
        userInput:   `SUBJECT: ${subject}\nFROM: ${fromEmail}\n\n${body}`,
        model:       'claude-sonnet-4-6',
        outputType:  'json',
        consumerRef: `court_ingest:${messageId || 'unknown'}`,
      });

      if (!extract.ok || !extract.json) {
        await courtExecutor.logExtractFailure(db, {
          messageId,
          dryRun,
          error:     extract.error || 'no_json',
          aiCallId:  extract.callId ?? null,
        });
        return {
          success: true,
          output: {
            dry_run:     dryRun,
            skipped:     'extract_failed',
            error:       extract.error || 'no_json',
            ai_call_id:  extract.callId ?? null,
          },
        };
      }

      const payload = extract.json;
      payload.message_id = messageId;        // trust OUR canonical id, not the model echo
      payload.ai_call_id = extract.callId;

      const result = await courtExecutor.executeCourtActions(db, {
        payload,
        subject,
        body,
        dryRun,
      });

      return {
        success: true,
        output: {
          dry_run:         dryRun,
          outcome:         result.outcome,
          court_ai_log_id: result.court_ai_log_id,
          ai_call_id:      extract.callId,
          applied:         Array.isArray(result.applied) ? result.applied.length : 0,
          skipped:         Array.isArray(result.skipped) ? result.skipped.length : 0,
          review_reason:   result.review_reason || null,
        },
      };
    } catch (err) {
      // One bad court email must not break ingest — audit the failure, soft-return.
      try {
        await courtExecutor.logExtractFailure(db, {
          messageId,
          dryRun,
          error: `court_extract_threw:${err.message}`,
        });
      } catch (logErr) {
        console.error('[COURT_EXTRACT] logExtractFailure failed:', logErr.message);
      }
      console.error('[COURT_EXTRACT] error:', err.message);
      return { success: true, output: { dry_run: dryRun, skipped: 'error', error: err.message } };
    }
  };

// ─────────────────────────────────────────────────────────────
// court_review_retry — daily auto-retry sweep over the court review queue.
//
// Re-runs OPEN queued rows with review_reason='case_not_found' whose docket
// NOW resolves (a case was created/adopted since the row was queued). Reuses
// the stored payload — NO AI call (case_not_found rows always carry a
// payload). Honors app_settings.court_ingest_live exactly like ingest:
// dryRun=!(live); this sweep NEVER flips the flag.
//
// Deliberately scoped to case_not_found ONLY. citation_miss / model_flagged
// queue because a HUMAN judgment is needed — auto-retrying replays identical
// inputs to the same verdict (pointless). extract_failed has no payload;
// retrying it would spend an AI call per row per day with no new information
// (a transient-API retry, if ever wanted, is a separate once-with-backoff
// design, not this sweep).
//
// Idempotent across runs via the queue's openness rule: a LIVE re-run that
// lands executed/none closes the row, so it won't be picked up again; a DRY
// re-run leaves it queued (re-attempted next run, harmlessly).
//
// params: { limit = 100, dry_run = false }   (dry_run here = PLAN ONLY: scan +
//   resolve, do not execute. Distinct from court_ingest_live.)

fns.court_review_retry = async ({ limit = 100, dry_run = false } = {}, db) => {
    const { resolveCase } = require('../../lib/courtResolve'); // lazy require (convention)
    const courtRerun      = require('../../services/courtRerun');

    let cap = parseInt(limit, 10);
    if (!Number.isFinite(cap) || cap <= 0) cap = 100;
    if (cap > 500) cap = 500;

    const live = await courtRerun.isLive(db);

    // Open case_not_found queued rows (latest queued row per message_id), newest
    // first. Mirrors routes/courtReview.js OPEN_QUEUE_WHERE.
    const [rows] = await db.query(
      `SELECT cal.id, cal.message_id, cal.case_number, cal.classification, cal.raw_response
         FROM court_ai_log cal
        WHERE cal.outcome = 'queued'
          AND cal.review_reason = 'case_not_found'
          AND NOT EXISTS (
            SELECT 1 FROM court_ai_log c2
             WHERE c2.message_id = cal.message_id AND c2.id > cal.id
               AND c2.dry_run = 0 AND c2.outcome IN ('executed','none'))
          AND NOT EXISTS (
            SELECT 1 FROM court_ai_log c3
             WHERE c3.message_id = cal.message_id AND c3.id > cal.id
               AND c3.outcome = 'queued')
        ORDER BY cal.id DESC
        LIMIT ?`,
      [cap]
    );

    let resolved = 0, executed = 0, stillQueued = 0, stillMissing = 0, errors = 0;
    const details = [];

    for (const row of rows) {
      let r;
      try {
        r = await resolveCase(db, row.case_number);
      } catch (e) {
        errors++;
        details.push({ id: row.id, case_number: row.case_number, action: 'resolve_error', error: e.message });
        continue;
      }
      if (!r || !r.found) {
        stillMissing++;
        continue; // case still doesn't exist — leave queued
      }
      resolved++;

      if (dry_run) {
        details.push({ id: row.id, case_number: row.case_number, case_id: r.case_id, action: 'would_rerun' });
        continue;
      }

      try {
        const rr = await courtRerun.rerunCalRow(db, row, { allowExtract: false });
        const outcome = rr.result && rr.result.outcome;
        // executed AND live (dry_run=0) means the queued row is now closed.
        if (outcome === 'executed' && rr.dry_run === false) executed++;
        else stillQueued++;
        details.push({
          id: row.id, case_number: row.case_number, case_id: r.case_id,
          action: 'reran', outcome: outcome || null, dry_run: rr.dry_run,
          new_court_ai_log_id: rr.new_court_ai_log_id || null,
        });
      } catch (e) {
        errors++;
        details.push({ id: row.id, case_number: row.case_number, action: 'rerun_error', error: e.message });
      }
    }

    console.log(
      `[COURT_REVIEW_RETRY] live=${live} dry_run=${dry_run} scanned=${rows.length} ` +
      `resolved=${resolved} executed=${executed} still_queued=${stillQueued} ` +
      `still_missing=${stillMissing} errors=${errors}`
    );

    return {
      success: true,
      output: {
        live, plan_only: !!dry_run,
        scanned: rows.length, resolved, executed,
        still_queued: stillQueued, still_missing: stillMissing, errors,
        details,
      },
    };
  };

fns.court_review_retry.__meta = {
  category: 'system',
  description: 'Re-run court review-queue rows (case_not_found) whose docket now resolves. No AI call; honors court_ingest_live.',
  params: [
    { name: 'limit', type: 'number', required: false, default: 100,
      description: 'Max open case_not_found rows to scan per run (capped at 500).' },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'Plan only — scan + resolve but do not execute. Distinct from court_ingest_live.' },
  ],
  example: {}
};

// --- COURT ACTIVITY SUMMARY ---
//
// Coverage-review digest over court_ai_log. Queries a rolling window, renders a
// 3-section HTML email (Actioned / Needs Review / Ignored–No Action) and sends
// it via emailService. The Ignored section lists EVERY no-action subject in
// full so a human can spot a court-email type we SHOULD be actioning but aren't.
// No AI call; read-only over court_ai_log (+ a correlated email_log subject
// lookup). Driven by the "Court Activity Weekly Summary" recurring job
// (params {days:7}); also callable on demand (apiTester / scheduled-job "run
// now") with any window.

// actions_json (a JSON column) → plain English, SIMPLE. mysql2 returns JSON
// columns already parsed; the readonly HTTP API returns them parsed too. Guard
// the string case defensively.
function summarizeCourtActions(actions) {
  let arr = actions;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
  if (!Array.isArray(arr) || arr.length === 0) return '(no actions)';
  const parts = arr.map((a) => {
    const f = (a && a.fields) || {};
    switch (a && a.type) {
      case 'create_appointment':
        return 'scheduled ' + (f.appt_type || 'appointment');
      case 'create_event':
        return 'added event: ' + (f.event_type || f.event_title || 'event');
      case 'update_event':
        return 'updated event';
      case 'update_case_fields': {
        const keys = Object.keys(f).map((k) => k.replace(/^case_/, ''));
        return 'updated case (' + keys.join(', ') + ')';
      }
      default:
        return (a && a.type) ? String(a.type) : 'unknown action';
    }
  });
  return parts.join('; ');
}


// Build the 3-section coverage digest. Pure: takes the window rows (newest-first)
// + opts {days, firmTz}; returns { html, counts }. Inline styles only (email
// clients). Partitions internally so the test and the runtime call share one
// renderer.
function buildCourtSummaryHtml(rows, opts = {}) {
  const { DateTime } = require('luxon');
  const firmTz = opts.firmTz || process.env.FIRM_TIMEZONE || 'America/Detroit';
  const days   = Number(opts.days) || 7;

  const list = Array.isArray(rows) ? rows : [];
  const actioned    = list.filter((r) => r.outcome === 'executed');
  const needsReview = list.filter((r) => r.outcome === 'queued');
  const ignoredAll  = list.filter((r) => r.outcome === 'none' || r.outcome === 'error'); // newest-first across both
  const noneCount   = list.filter((r) => r.outcome === 'none').length;
  const errorCount  = list.filter((r) => r.outcome === 'error').length;

  const processed = list.length;
  const anyDry = list.some((r) => Number(r.dry_run) === 1);
  const allDry = processed > 0 && list.every((r) => Number(r.dry_run) === 1);

  const counts = {
    processed,
    actioned: actioned.length,
    queued: needsReview.length,
    ignored: noneCount,
    errors: errorCount,
    anyDry, allDry,
  };

  const end   = DateTime.now().setZone(firmTz);
  const start = end.minus({ days });
  const windowLabel = `${start.toFormat('LLL d')} – ${end.toFormat('LLL d, yyyy')}`;
  const stamp = end.toFormat('yyyy-LL-dd HH:mm ZZZZ');

  // ---- escapers / formatters ----
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDate = (d) => {
    try { return DateTime.fromJSDate(new Date(d)).setZone(firmTz).toFormat('LLL d'); }
    catch { return esc(d); }
  };
  const caseLabel = (r) => {
    const num = String(r.case_number || '').trim();
    const nm  = String(r.case_name || '').trim();
    if (num && nm) return esc(num) + ' — ' + esc(nm);
    return esc(num || nm || '—');
  };
  const trimReason = (s) => {
    s = String(s || '');
    return esc(s.length > 120 ? s.slice(0, 119) + '…' : s);
  };
  // Per-row DR tag only matters in MIXED mode; in all-dry mode the banner says it.
  const drTag = (r) => (!allDry && Number(r.dry_run) === 1)
    ? '<span style="display:inline-block;background:#fde68a;color:#92400e;font-size:11px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">DR</span>'
    : '';

  const td = (html, extra = '') =>
    `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;${extra}">${html}</td>`;
  const sectionH = (title, accent, sub) =>
    `<h3 style="font-size:15px;margin:20px 0 2px;color:#111827;border-left:4px solid ${accent};padding-left:8px;">` +
    `${title}${sub != null ? ` <span style="font-weight:400;color:#9ca3af;font-size:13px;">(${sub})</span>` : ''}</h3>`;
  const table = (headers, bodyRows, accent) => {
    if (!bodyRows.length) return '<p style="color:#9ca3af;font-size:13px;margin:4px 0 8px;">None.</p>';
    const ths = headers.map((h) =>
      `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid ${accent};font-size:11px;` +
      `letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">${h}</th>`).join('');
    return `<table cellpadding="0" cellspacing="0" border="0" width="100%" ` +
      `style="border-collapse:collapse;font-size:13px;margin:4px 0 8px;table-layout:fixed;">` +
      `<thead><tr>${ths}</tr></thead><tbody>${bodyRows.join('')}</tbody></table>`;
  };

  // ---- §A ACTIONED ----
  const rowsA = actioned.map((r) => {
    const proposed = Number(r.dry_run) === 1
      ? ' <span style="color:#92400e;font-size:12px;">(proposed)</span>' : '';
    return '<tr>' +
      td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
      td(drTag(r) + esc(r.subject || '(no subject)'), 'font-weight:600;') +
      td(caseLabel(r), 'color:#374151;') +
      td(esc(summarizeCourtActions(r.actions_json)) + proposed) +
      '</tr>';
  });
  const secA = sectionH('Actioned', '#16a34a', actioned.length) +
    table(['Date', 'Subject', 'Case', 'Actions'], rowsA, '#16a34a');

  // ---- §B NEEDS REVIEW ----
  const rowsB = needsReview.map((r) =>
    '<tr>' +
    td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
    td(drTag(r) + esc(r.subject || '(no subject)'), 'font-weight:600;') +
    td(caseLabel(r), 'color:#374151;') +
    td(trimReason(r.review_reason || '—'), 'color:#b91c1c;') +
    '</tr>');
  const secB = sectionH('Needs Review', '#dc2626', needsReview.length) +
    '<p style="font-size:12px;color:#6b7280;margin:2px 0 4px;">A human must act on these.</p>' +
    table(['Date', 'Subject', 'Case', 'Reason'], rowsB, '#dc2626');

  // ---- §C IGNORED / NO ACTION (coverage review — full subjects, no actions col) ----
  // "Model thought" = classification, EXCEPT when a none-row carries a review_reason
  // (queued-then-dismissed by a human) — that note is the real signal, not the bare
  // class. review_reason is already SELECTed by COURT_SUMMARY_SQL.
  const rowsC = ignoredAll.map((r) => {
    let thought;
    if (r.outcome === 'error') thought = 'extract error';
    else if (r.review_reason && String(r.review_reason).trim()) thought = String(r.review_reason).trim();
    else thought = r.classification || '(unclassified)';
    if (thought.length > 120) thought = thought.slice(0, 119) + '…';
    return '<tr>' +
      td(fmtDate(r.created_at), 'white-space:nowrap;color:#6b7280;width:64px;') +
      td(drTag(r) + esc(r.subject || '(no subject)')) +
      td(esc(thought), 'color:#6b7280;font-style:italic;width:240px;') +
      '</tr>';
  });
  const secC = sectionH('Ignored / No Action', '#9ca3af', ignoredAll.length) +
    '<p style="font-size:12px;color:#6b7280;margin:2px 0 4px;">Read every subject — catch a type we should be actioning but aren\'t.</p>' +
    table(['Date', 'Subject', 'Model thought / note'], rowsC, '#9ca3af');

  // ---- banner ----
  let banner = '';
  if (allDry) {
    banner = '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;' +
      'margin:12px 0;color:#92400e;font-size:14px;"><strong>DRY RUN</strong> — these are ' +
      '<strong>proposed</strong> actions; nothing was written to live records.</div>';
  } else if (anyDry) {
    banner = '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;' +
      'margin:12px 0;color:#92400e;font-size:14px;">Some rows are dry-run (proposed); see the ' +
      '<strong>DR</strong> tag per row.</div>';
  }

  const tally = `<div style="font-size:14px;margin:10px 0 6px;color:#374151;">` +
    `<strong>${processed}</strong> processed — <strong>${actioned.length}</strong> actioned, ` +
    `<strong>${needsReview.length}</strong> queued for review, <strong>${noneCount}</strong> ignored, ` +
    `<strong>${errorCount}</strong> errors</div>`;

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;' +
    'max-width:760px;margin:0 auto;padding:4px;">' +
    `<h2 style="margin:0 0 2px;font-size:20px;color:#0f172a;">Court Email Activity</h2>` +
    `<div style="font-size:14px;color:#6b7280;margin:0 0 6px;">${windowLabel}</div>` +
    banner +
    tally +
    secA +
    secB +
    secC +
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:8px;">` +
    `Generated from court_ai_log · window ${days}d · ${stamp}</p>` +
    '</div>';

  return { html, counts };
}


// Subject is NOT on court_ai_log. We hydrate it from email_log via a CORRELATED
// SUBQUERY (LIMIT 1, newest el.id), NOT a LEFT JOIN: email_log holds duplicate
// message_id rows, so a JOIN fans out / inflates the partition the first time a
// court message_id is logged twice. This mirrors EMAIL_SUBJECT_SUBQ in
// routes/courtReview.js. COLLATE coerces court_ai_log.message_id (utf8mb4_unicode_ci)
// to email_log's utf8mb4_general_ci. The NOT EXISTS clause collapses to the
// LATEST court_ai_log row per message_id (a reran/dismissed message has several;
// show only its final state).
const COURT_SUMMARY_SQL = `
  SELECT cal.id, cal.created_at, cal.message_id, cal.classification, cal.outcome,
         cal.review_reason, cal.case_number, cal.case_name, cal.dry_run, cal.actions_json,
         (SELECT el.subject FROM email_log el
            WHERE el.message_id = cal.message_id COLLATE utf8mb4_general_ci
            ORDER BY el.id DESC LIMIT 1) AS subject
    FROM court_ai_log cal
   WHERE cal.created_at >= (NOW() - INTERVAL ? DAY)
     AND NOT EXISTS (
       SELECT 1 FROM court_ai_log c2
        WHERE c2.message_id = cal.message_id AND c2.id > cal.id)
   ORDER BY cal.created_at DESC`;

fns.court_activity_summary = async (
  { days = 7, to = null, from = null, skip_if_empty = false } = {},
  db
) => {
  const { DateTime } = require('luxon'); // lazy require (file convention)
  const firmTz = process.env.FIRM_TIMEZONE || 'America/Detroit';

  // Window clamp: default 7, floor 1, cap 90.
  let win = parseInt(days, 10);
  if (!Number.isFinite(win) || win < 1) win = 7;
  if (win > 90) win = 90;

  const [rows] = await db.query(COURT_SUMMARY_SQL, [win]);

  const { html, counts } = buildCourtSummaryHtml(rows, { days: win, firmTz });
  const { processed, actioned, queued, ignored, errors } = counts;

  // skip_if_empty: a "0 processed" email is normally reassuring (confirms
  // liveness), so default false. When true and the window is empty, send nothing.
  if (skip_if_empty && processed === 0) {
    console.log(`[COURT_SUMMARY] window=${win}d processed=0 — skip_if_empty set, nothing sent`);
    return {
      success: true,
      output: { processed: 0, actioned: 0, queued: 0, ignored: 0, errors: 0, sent: false, to: null },
    };
  }

  // from: identical fallback chain to the other automation funcs (rc_renew).
  const fromAddr = from
    || (await getSetting(db, 'email_automations'))
    || process.env.AUTO_EMAIL
    || 'automations@4lsg.com';

  // to: explicit param wins (the job row controls recipients without code). Else
  // the firm review list: Stuart + Rena + IT. IT resolves via setting for parity
  // with rc_renew; Stuart/Rena have no setting keys so they are literal.
  const itAddr = (await getSetting(db, 'email_it')) || process.env.IT_EMAIL || 'it@4lsg.com';
  const toRaw = to || `stuart@4lsg.com, Rena@4lsg.com, ${itAddr}`;
  const recipients = String(toRaw).split(',').map((s) => s.trim()).filter(Boolean);

  // Subject window label — mirror the body's label (same tz + win + "now").
  const end = DateTime.now().setZone(firmTz);
  const start = end.minus({ days: win });
  const windowLabel = `${start.toFormat('LLL d')} – ${end.toFormat('LLL d, yyyy')}`;
  const subject = `Court Email Activity — ${windowLabel}`;

  // Send per-recipient (mirrors run_task_digest): one address per call, each in
  // its own try/catch so one bad address can't sink the rest. html-only is fine —
  // emailService.normalizeBodies derives the text part.
  let sentCount = 0;
  for (const addr of recipients) {
    try {
      await emailService.sendEmail(db, { from: fromAddr, to: addr, subject, html });
      sentCount++;
    } catch (e) {
      console.error(`[COURT_SUMMARY] send failed for ${addr}: ${e.message}`);
    }
  }
  const sent = sentCount > 0;

  console.log(
    `[COURT_SUMMARY] window=${win}d processed=${processed} actioned=${actioned} ` +
    `queued=${queued} ignored=${ignored} errors=${errors} sent=${sent} (${sentCount}/${recipients.length})`
  );

  return {
    success: true,
    output: { processed, actioned, queued, ignored, errors, sent, to: recipients.join(', ') },
  };
};

fns.court_activity_summary.__meta = {
  category: 'system',
  description:
    'Coverage-review digest of court_ai_log over a rolling window. Emails a 3-section ' +
    'HTML summary (Actioned / Needs Review / Ignored–No Action); the Ignored section lists ' +
    'every no-action subject in full so a human can catch a type we should be actioning but ' +
    'aren\'t. No AI call; read-only over court_ai_log. Sends per-recipient via emailService.',
  params: [
    { name: 'days', type: 'number', required: false, default: 7,
      description: 'Window size in days (created_at >= NOW() - INTERVAL N DAY). Floored at 1, capped at 90. 7 = weekly; 1 = daily.' },
    { name: 'to', type: 'string', required: false,
      description: 'Comma-separated recipient override. Default: stuart@4lsg.com, Rena@4lsg.com, <email_it>. One send per address.' },
    { name: 'from', type: 'string', required: false,
      description: 'Sender override (must exist in email_credentials). Default: setting email_automations → AUTO_EMAIL → automations@4lsg.com.' },
    { name: 'skip_if_empty', type: 'boolean', required: false, default: false,
      description: 'If true and the window has 0 rows, send nothing (returns sent:false). Default false — a "0 processed" email confirms liveness.' },
  ],
  example: { days: 7 }
};

// Test handles (filtered from the registry by the __ prefix, like __getMeta /
// __getAllMeta). scripts/courtSummaryTest.js requires these.
fns.__summarizeCourtActions = summarizeCourtActions;
fns.__buildCourtSummaryHtml = buildCourtSummaryHtml;

module.exports = fns;
