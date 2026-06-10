// services/courtExecutor.js
//
// COURT EXECUTOR CORE. Turns a court_extract payload (the JSON emitted by
// lib/aiPrompts/courtExtract.js) into case / appt / event writes, with a HARD
// dry-run default, full before/after audit, idempotency, and conversion
// handling. The real entry point is executeCourtActions(); Slice 5's ingest
// internal_function will call it directly. routes/_courtexec.js is a thin test
// harness over it.
//
// SCOPE: no workflow triggering, no revert, no ingest rule (later slices).
//
// ── DRY-RUN SEMANTICS ─────────────────────────────────────────────────────
// In dry-run we perform NO apptService calls and NO event/case writes (and
// therefore none of apptService's side effects: GCal, sequences, confirmations)
// — BUT we DO write court_ai_log + ai_change_log rows with dry_run=1. Those two
// are the AUDIT tables; capturing intended changes there is the whole point of
// dry-run review.
//
// Effective dry-run:
//   - message_id matches /-test-/  → FORCE dryRun=true (mangled test ids must
//     never write real entities / fire side effects).
//   - else dryRun defaults true unless explicitly false.
//
// ── ENTITY DEFAULTS (verified vs live DB) ─────────────────────────────────
//   341 appt : appt_type literal '341 Meeting', appt_length=10, appt_with=1,
//              platform default 'Zoom' when payload omits it. appt_date is the
//              firm-LOCAL string `${date} ${time}:00`; apptService.createAppt
//              does localToUTC itself AND owns cases.case_341_current /
//              341_appt_id (we never write those).
//   event    : event_link_type='case_number', event_link_id=resolved.case_number
//              (SHORT docket), event_status='Scheduled', event_calendar_id='none',
//              event_created_by=NULL, event_all_day=(time?0:1), event_time=time||NULL.
//
// ── update_case_fields COLUMN POLICY ──────────────────────────────────────
//   fill_only  (write only if current NULL/''): case_file_date, case_judge, case_close_date
//   overwrite  (write if new !== current)     : case_chapter, case_trustee, case_objection
//   FORBIDDEN  (ignored)                       : case_341_current, 341_appt_id, anything else
// A Ch7-341-on-a-Ch13 CONVERSION needs no special code: chapter/trustee/objection
// overwrite here, and the 341 supersedes via apptService.

/**
 * Per-column write policy for update_case_fields. Keys ARE the allowlist; any
 * column not present is FORBIDDEN and silently ignored.
 */
const CASE_FIELD_POLICY = {
  case_file_date:  'fill_only',
  case_judge:      'fill_only',
  case_close_date: 'fill_only',
  case_chapter:    'overwrite',
  case_trustee:    'overwrite',
  case_objection:  'overwrite',
};
const CASE_DATE_FIELDS = new Set(['case_file_date', 'case_close_date', 'case_objection']);

const { resolveCase } = require('../lib/courtResolve');
const { checkCitations } = require('../lib/courtCitation');

// ─────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────

/** mysql DATE/DATETIME value (Date | ISO string | 'YYYY-MM-DD ...') → 'YYYY-MM-DD' | null */
function toDatePart(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** mysql TIME/DATETIME → 'HH:MM' | null (display only). */
function toTimePart(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const m = String(v).match(/(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function eventSummary(date, time, location) {
  return `${date}${time ? ' ' + time : ''}${location ? ' [' + location + ']' : ''}`;
}

async function insertCourtAiLog(db, row) {
  const [r] = await db.query(
    `INSERT INTO court_ai_log
       (message_id, ai_call_id, dry_run, classification, case_number,
        resolved_case_id, case_name, actions_json, citations_json,
        outcome, review_reason, raw_response)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.message_id,
      row.ai_call_id ?? null,
      row.dry_run ? 1 : 0,
      row.classification ?? null,
      row.case_number ?? null,
      row.resolved_case_id ?? null,
      row.case_name ?? null,
      row.actions_json == null ? null : JSON.stringify(row.actions_json),
      row.citations_json == null ? null : JSON.stringify(row.citations_json),
      row.outcome,
      row.review_reason ?? null,
      row.raw_response == null ? null : JSON.stringify(row.raw_response),
    ]
  );
  return r.insertId;
}

async function flushChangeRows(db, rows, courtLogId) {
  for (const cr of rows) {
    await db.query(
      `INSERT INTO ai_change_log
         (source_message_id, ai_call_id, court_ai_log_id, entity_type,
          entity_id, field, old_value, new_value, dry_run)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        cr.source_message_id ?? null,
        cr.ai_call_id ?? null,
        courtLogId,
        cr.entity_type,
        cr.entity_id,
        cr.field,
        cr.old_value ?? null,
        cr.new_value ?? null,
        cr.dry_run ? 1 : 0,
      ]
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// main entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {object} db    mysql2 promise pool (write-capable; req.db)
 * @param {object} opts
 * @param {object} opts.payload  court_extract JSON
 * @param {string} opts.subject  trusted email subject (citation haystack)
 * @param {string} opts.body     raw email body (citation haystack)
 * @param {boolean} [opts.dryRun]  defaults true; forced true for -test- ids
 * @returns {Promise<{ outcome:string, court_ai_log_id:(number|null),
 *   applied:Array, skipped:Array, review_reason:(string|null), already_processed?:boolean }>}
 */
async function executeCourtActions(db, { payload, subject, body, dryRun } = {}) {
  payload = payload || {};
  const messageId = payload.message_id || null;
  const aiCallId = payload.ai_call_id ?? null;
  const classification = payload.classification || null;
  const caseNumber = payload.case_number || null;

  // Effective dry-run: -test- ids force dry-run; otherwise default true.
  const isTestId = !!(messageId && /-test-/.test(messageId));
  const effectiveDryRun = isTestId ? true : (dryRun === false ? false : true);

  // ── STEP 1: PROCESSED MARKER (live only) ──────────────────────────────
  if (!effectiveDryRun && messageId) {
    const [seen] = await db.query(
      `SELECT id, outcome, review_reason FROM court_ai_log
        WHERE message_id = ? AND dry_run = 0 AND outcome IN ('executed','none')
        ORDER BY id DESC LIMIT 1`,
      [messageId]
    );
    if (seen.length) {
      return {
        outcome: seen[0].outcome,
        court_ai_log_id: seen[0].id,
        applied: [],
        skipped: [{ reason: 'already_processed', court_ai_log_id: seen[0].id }],
        review_reason: seen[0].review_reason || null,
        already_processed: true,
      };
    }
  }

  // ── STEP 2: RESOLVE ───────────────────────────────────────────────────
  const resolved = await resolveCase(db, caseNumber);
  const caseName =
    payload.case_name || (resolved.found ? resolved.primary_contact_name : null) || null;

  if (!resolved.found) {
    const courtLogId = await insertCourtAiLog(db, {
      message_id: messageId,
      ai_call_id: aiCallId,
      dry_run: effectiveDryRun,
      classification,
      case_number: caseNumber,
      resolved_case_id: null,
      case_name: caseName,
      actions_json: payload.actions || null,
      citations_json: null,
      outcome: 'queued',
      review_reason: 'case_not_found',
      raw_response: payload,
    });
    return {
      outcome: 'queued',
      court_ai_log_id: courtLogId,
      applied: [],
      skipped: [],
      review_reason: 'case_not_found',
    };
  }

  // ── STEP 3: MODEL-FLAGGED REVIEW ──────────────────────────────────────
  if (payload.needs_review === true) {
    const reason = payload.review_reason || 'model_flagged';
    const courtLogId = await insertCourtAiLog(db, {
      message_id: messageId,
      ai_call_id: aiCallId,
      dry_run: effectiveDryRun,
      classification,
      case_number: caseNumber,
      resolved_case_id: resolved.case_id,
      case_name: caseName,
      actions_json: payload.actions || null, // record intent, do NOT apply
      citations_json: null,
      outcome: 'queued',
      review_reason: reason,
      raw_response: payload,
    });
    return {
      outcome: 'queued',
      court_ai_log_id: courtLogId,
      applied: [],
      skipped: [],
      review_reason: reason,
    };
  }

  // ── STEP 4: CITATIONS ─────────────────────────────────────────────────
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const citation = checkCitations(subject, body, actions);
  if (!citation.pass) {
    const first = citation.misses[0];
    const reason = `citation_miss:${first ? first.field : 'unknown'}`;
    const courtLogId = await insertCourtAiLog(db, {
      message_id: messageId,
      ai_call_id: aiCallId,
      dry_run: effectiveDryRun,
      classification,
      case_number: caseNumber,
      resolved_case_id: resolved.case_id,
      case_name: caseName,
      actions_json: payload.actions || null,
      citations_json: citation,
      outcome: 'queued',
      review_reason: reason,
      raw_response: payload,
    });
    return {
      outcome: 'queued',
      court_ai_log_id: courtLogId,
      applied: [],
      skipped: [],
      review_reason: reason,
    };
  }

  // ── STEP 5: DISPATCH ──────────────────────────────────────────────────
  const applied = [];
  const skipped = [];
  const reviewReasons = [];
  const changeRows = []; // buffered ai_change_log rows, flushed after court_ai_log
  let appliedOrIntended = 0;
  let curCaseRow = null; // lazily loaded current cases row for update_case_fields

  const pushChange = (entity_type, entity_id, field, old_value, new_value) => {
    changeRows.push({
      source_message_id: messageId,
      ai_call_id: aiCallId,
      entity_type,
      entity_id,
      field,
      old_value,
      new_value,
      dry_run: effectiveDryRun,
    });
  };

  // create_event used both by the create_event action AND by the ambiguous
  // update_event fallback. Honors the natural-key guard; returns event_id|null.
  async function doCreateEvent(idx, fields) {
    const time = fields.time || null;
    const ev = {
      event_type: fields.event_type || null,
      event_link_type: 'case_number',
      event_link_id: resolved.case_number,
      event_title: fields.event_title || fields.event_type || 'Court Event',
      event_date: fields.date || null,
      event_time: time,
      event_all_day: time ? 0 : 1,
      event_location: fields.location || null,
      event_status: 'Scheduled',
      event_calendar_id: 'none',
      event_created_by: null,
    };
    if (!ev.event_date) {
      reviewReasons.push('event_missing_date');
      skipped.push({ action_index: idx, type: 'create_event', reason: 'event_missing_date' });
      return null;
    }
    // NATURAL-KEY GUARD: same (link_id, type, date, title) Scheduled event.
    const [dupe] = await db.query(
      `SELECT event_id FROM events
        WHERE event_link_type='case_number' AND event_link_id=? AND event_type<=>?
          AND event_date=? AND event_title=? AND event_status='Scheduled'
        LIMIT 1`,
      [ev.event_link_id, ev.event_type, ev.event_date, ev.event_title]
    );
    if (dupe.length) {
      skipped.push({ action_index: idx, type: 'create_event', reason: 'event_exists', event_id: dupe[0].event_id });
      return null;
    }
    let eventId = null;
    if (!effectiveDryRun) {
      const [r] = await db.query(
        `INSERT INTO events
           (event_type, event_link_type, event_link_id, event_title, event_date,
            event_time, event_all_day, event_location, event_status,
            event_calendar_id, event_created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [ev.event_type, ev.event_link_type, ev.event_link_id, ev.event_title,
         ev.event_date, ev.event_time, ev.event_all_day, ev.event_location,
         ev.event_status, ev.event_calendar_id, ev.event_created_by]
      );
      eventId = r.insertId;
    }
    const eid = eventId != null ? String(eventId) : '(dry)';
    const summary = `${ev.event_type || 'event'}: ${ev.event_title} @ ${eventSummary(ev.event_date, ev.event_time, ev.event_location)}`;
    pushChange('event', eid, 'create', null, summary);
    applied.push({ action_index: idx, type: 'create_event', entity_type: 'event', entity_id: eid, summary });
    appliedOrIntended++;
    return eventId;
  }

  try {
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i] || {};
    const type = act.type;
    const fields = act.fields || {};

    if (type === 'create_appointment') {
      if (!resolved.primary_contact_id) {
        reviewReasons.push('no_primary_contact');
        skipped.push({ action_index: i, type, reason: 'no_primary_contact' });
        continue;
      }
      const date = fields.date;
      const time = fields.time;
      if (!date || !time) {
        reviewReasons.push('appt_missing_datetime');
        skipped.push({ action_index: i, type, reason: 'appt_missing_datetime' });
        continue;
      }
      const apptLocal = `${date} ${time}:00`;
      const platform = fields.platform || 'Zoom';

      // NATURAL-KEY GUARD: Scheduled 341 at the same datetime for this case.
      const [dupe] = await db.query(
        `SELECT appt_id FROM appts
          WHERE appt_case_id=? AND appt_type='341 Meeting'
            AND appt_status='Scheduled' AND appt_date=? LIMIT 1`,
        [resolved.case_id, apptLocal]
      );
      if (dupe.length) {
        skipped.push({ action_index: i, type, reason: 'appt_exists', appt_id: dupe[0].appt_id });
        continue;
      }

      let apptId = null;
      if (!effectiveDryRun) {
        // Lazy-require so this module loads in isolation (tests) and to avoid
        // any load-order coupling — still routes 341s THROUGH apptService.
        const apptService = require('./apptService');
        const res = await apptService.createAppt(db, {
          contact_id: resolved.primary_contact_id,
          case_id: resolved.case_id,
          appt_type: '341 Meeting',
          appt_length: 10,
          appt_with: 1,
          appt_platform: platform,
          appt_date: apptLocal,
          note: fields.connection_info || '',
        });
        apptId = res.appt_id;
      }
      const eid = apptId != null ? String(apptId) : '(dry)';
      const summary =
        `341 Meeting @ ${apptLocal} platform=${platform} contact=${resolved.primary_contact_id}` +
        (fields.trustee ? ` trustee=${fields.trustee}` : '');
      pushChange('appt', eid, 'create', null, summary);
      applied.push({ action_index: i, type, entity_type: 'appt', entity_id: eid, summary });
      appliedOrIntended++;
      continue;
    }

    if (type === 'create_event') {
      await doCreateEvent(i, fields);
      continue;
    }

    if (type === 'update_event') {
      const eventType = fields.event_type || null;
      const newDate = fields.date || null;
      if (!newDate) {
        reviewReasons.push('event_missing_date');
        skipped.push({ action_index: i, type, reason: 'event_missing_date' });
        continue;
      }
      const newTime = fields.time || null;
      const newLoc = fields.location || null;
      // FUTURE Scheduled events of this type for the case.
      const [matches] = await db.query(
        `SELECT event_id, event_date, event_time, event_all_day, event_location FROM events
          WHERE event_link_type='case_number' AND event_link_id=? AND event_type<=>?
            AND event_status='Scheduled' AND event_date >= CURDATE()`,
        [resolved.case_number, eventType]
      );
      if (matches.length === 1) {
        const old = matches[0];
        const oldSummary = eventSummary(toDatePart(old.event_date), toTimePart(old.event_time), old.event_location);
        const newSummary = eventSummary(newDate, newTime, newLoc);
        if (!effectiveDryRun) {
          await db.query(
            `UPDATE events SET event_date=?, event_time=?, event_all_day=?, event_location=?
              WHERE event_id=?`,
            [newDate, newTime, newTime ? 0 : 1, newLoc, old.event_id]
          );
        }
        // Slice 4b D4: persist STRUCTURED before/after state (not lossy summaries)
        // so revertCourtActions can reconstruct the row. Summaries stay in
        // applied[] for human readability.
        const oldState = JSON.stringify({
          date: toDatePart(old.event_date),
          time: toTimePart(old.event_time),
          all_day: old.event_all_day,
          location: old.event_location == null ? null : old.event_location,
        });
        const newState = JSON.stringify({
          date: toDatePart(newDate) || newDate,
          time: toTimePart(newTime),
          all_day: newTime ? 0 : 1,
          location: newLoc == null ? null : newLoc,
        });
        pushChange('event', String(old.event_id), 'update', oldState, newState);
        applied.push({ action_index: i, type, entity_type: 'event', entity_id: String(old.event_id),
          summary: `reschedule ${oldSummary} -> ${newSummary}` });
        appliedOrIntended++;
      } else {
        // zero or >1 → land the new date as a fresh event; flag for human cleanup.
        reviewReasons.push('event_update_ambiguous');
        await doCreateEvent(i, fields);
      }
      continue;
    }

    if (type === 'update_case_fields') {
      if (!curCaseRow) {
        const [rows] = await db.query(
          `SELECT case_file_date, case_judge, case_close_date,
                  case_chapter, case_trustee, case_objection
             FROM cases WHERE case_id=? LIMIT 1`,
          [resolved.case_id]
        );
        curCaseRow = rows[0] || {};
      }
      for (const [col, rawNew] of Object.entries(fields)) {
        const policy = CASE_FIELD_POLICY[col];
        if (!policy) {
          skipped.push({ action_index: i, type, field: col, reason: 'forbidden_column' });
          continue;
        }
        const newVal = rawNew == null ? '' : String(rawNew).trim();
        if (newVal === '') {
          skipped.push({ action_index: i, type, field: col, reason: 'empty_new' });
          continue;
        }
        const isDate = CASE_DATE_FIELDS.has(col);
        const curRaw = curCaseRow[col];

        let curNorm, equal, occupied, writeVal;
        if (isDate) {
          curNorm = toDatePart(curRaw);                 // 'YYYY-MM-DD' | null
          writeVal = toDatePart(newVal) || newVal;      // normalize incoming
          equal = curNorm != null && curNorm === writeVal;
          occupied = curNorm != null;
        } else {
          curNorm = curRaw == null ? '' : String(curRaw).trim();
          writeVal = newVal;
          equal = curNorm === writeVal;
          occupied = curNorm !== '';
        }

        if (policy === 'fill_only' && occupied) {
          skipped.push({ action_index: i, type, field: col, reason: 'fill_only_occupied' });
          continue;
        }
        if (equal) {
          // no-op: skip silently (no write, no log row)
          skipped.push({ action_index: i, type, field: col, reason: 'noop' });
          continue;
        }
        if (!effectiveDryRun) {
          await db.query(`UPDATE cases SET \`${col}\`=? WHERE case_id=?`, [writeVal, resolved.case_id]);
          curCaseRow[col] = writeVal; // keep in-memory consistent for later actions
        }
        pushChange('case', resolved.case_id, col, isDate ? curNorm : curNorm, writeVal);
        applied.push({ action_index: i, type, entity_type: 'case', entity_id: resolved.case_id,
          field: col, old_value: isDate ? curNorm : curNorm, new_value: writeVal });
        appliedOrIntended++;
      }
      continue;
    }

    // Unknown action type — record, don't apply.
    skipped.push({ action_index: i, type: type || '(none)', reason: 'unknown_action_type' });
  }
  } catch (err) {
    // ── HARDEN #1: AUDIT-ON-ERROR ───────────────────────────────────────
    // A mid-dispatch throw must NEVER leave per-action autocommitted entity
    // writes with zero audit. Record an 'error' court_ai_log row (with the
    // normal actions/citations/raw_response) and flush whatever change rows
    // were buffered before the throw, then return.
    const reviewReason = ('error:' + (err && err.message ? err.message : String(err))).slice(0, 255);
    const courtLogId = await insertCourtAiLog(db, {
      message_id: messageId,
      ai_call_id: aiCallId,
      dry_run: effectiveDryRun,
      classification,
      case_number: caseNumber,
      resolved_case_id: resolved.case_id,
      case_name: caseName,
      actions_json: payload.actions || null,
      citations_json: citation,
      outcome: 'error',
      review_reason: reviewReason,
      raw_response: payload,
    });
    try {
      await flushChangeRows(db, changeRows, courtLogId);
    } catch (flushErr) {
      console.error('[courtExecutor] flush after dispatch error failed:', flushErr.message);
    }
    return {
      outcome: 'error',
      court_ai_log_id: courtLogId,
      applied,
      skipped,
      review_reason: reviewReason,
      error: true,
    };
  }

  // ── STEP 6: OUTCOME + LOGS ────────────────────────────────────────────
  let outcome;
  if (reviewReasons.length) outcome = 'queued';
  else if (appliedOrIntended >= 1) outcome = 'executed';
  else outcome = 'none';

  const reviewReason = reviewReasons.length ? [...new Set(reviewReasons)].join('; ') : null;

  const courtLogId = await insertCourtAiLog(db, {
    message_id: messageId,
    ai_call_id: aiCallId,
    dry_run: effectiveDryRun,
    classification,
    case_number: caseNumber,
    resolved_case_id: resolved.case_id,
    case_name: caseName,
    actions_json: payload.actions || null,
    citations_json: citation,
    outcome,
    review_reason: reviewReason,
    raw_response: payload,
  });

  await flushChangeRows(db, changeRows, courtLogId);

  return { outcome, court_ai_log_id: courtLogId, applied, skipped, review_reason: reviewReason };
}

// ─────────────────────────────────────────────────────────────────────────
// revertCourtActions  (Slice 4b — Deliverable 5)
// ─────────────────────────────────────────────────────────────────────────

/** mysql DATE/TIME/text → normalized comparable string|null (date|time aware). */
function _eqNullable(a, b) {
  const na = a == null ? null : String(a);
  const nb = b == null ? null : String(b);
  return na === nb;
}

/**
 * Reverse previously-APPLIED (dry_run=0), not-yet-undone (undone_at IS NULL)
 * ai_change_log rows for a target — selected by source_message_id OR an explicit
 * list of change-log ids. dryRun defaults TRUE (preview: plan only, no writes,
 * no stamp).
 *
 * Per-row behavior by entity_type/field:
 *   - case/<col>  : MODIFIED-SINCE GUARD. Read current cases.<col>; revert only
 *                   if current === new_value (date-normalized for date cols).
 *                   Match → restore old_value (NULL if old_value was null).
 *                   Differ → skip {reason:'modified_since'}. <col> not in the
 *                   write allowlist → skip {reason:'unrevertable'}.
 *   - event/create: event_status='Scheduled' → set 'Canceled'; else skip
 *                   {reason:'already_gone'}.
 *   - event/update: parse old_value/new_value JSON {date,time,all_day,location}.
 *                   MODIFIED-SINCE GUARD vs current row compared to new_value;
 *                   match → restore date/time/all_day/location from old JSON;
 *                   differ → skip 'modified_since'. Unparseable JSON (legacy
 *                   lossy summary) → skip {reason:'unrevertable'}.
 *   - appt/create : SILENT cancel via apptService.cancelAppt (sms:false,
 *                   email:false — NO client-facing comms). Non-Scheduled appt →
 *                   skip {reason:'already_gone'}.
 *   - anything else → skip {reason:'unrevertable'}.
 *
 * On a real (non-dry) revert each reverted row is stamped undone_at=NOW(),
 * undone_by=actingUserId. dryRun=true stamps nothing and writes nothing.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} [opts.messageId]      source_message_id selector
 * @param {Array<number>} [opts.changeLogIds]  explicit ai_change_log id list (takes precedence)
 * @param {boolean} [opts.dryRun=true]
 * @param {number}  [opts.actingUserId=0]
 * @returns {Promise<{ dryRun:boolean,
 *   reverted:Array<{change_log_id:number, entity_type:string, entity_id:string, field:string, action:string}>,
 *   skipped:Array<{change_log_id:(number|null), reason:string}> }>}
 */
async function revertCourtActions(db, { messageId, changeLogIds, dryRun = true, actingUserId = 0 } = {}) {
  const hasIds = Array.isArray(changeLogIds) && changeLogIds.length > 0;
  if (!hasIds && !messageId) {
    throw new Error('revertCourtActions requires messageId or changeLogIds');
  }

  // Target set: live (dry_run=0) and not-yet-undone. Explicit ids win over
  // messageId. Newest-first so chained writes to one column unwind correctly.
  let rows;
  if (hasIds) {
    [rows] = await db.query(
      `SELECT id, entity_type, entity_id, field, old_value, new_value
         FROM ai_change_log
        WHERE id IN (?) AND dry_run=0 AND undone_at IS NULL
        ORDER BY id DESC`,
      [changeLogIds]
    );
  } else {
    [rows] = await db.query(
      `SELECT id, entity_type, entity_id, field, old_value, new_value
         FROM ai_change_log
        WHERE source_message_id=? AND dry_run=0 AND undone_at IS NULL
        ORDER BY id DESC`,
      [messageId]
    );
  }

  const reverted = [];
  const skipped = [];

  const stamp = async (id) => {
    if (dryRun) return;
    await db.query(
      `UPDATE ai_change_log SET undone_at=NOW(), undone_by=? WHERE id=?`,
      [actingUserId, id]
    );
  };

  for (const row of rows) {
    const { id, entity_type, entity_id, field, old_value, new_value } = row;

    // ── case/<col> ──────────────────────────────────────────────────────
    if (entity_type === 'case') {
      const policy = CASE_FIELD_POLICY[field];
      if (!policy) { skipped.push({ change_log_id: id, reason: 'unrevertable' }); continue; }

      const [cur] = await db.query(
        `SELECT \`${field}\` AS v FROM cases WHERE case_id=? LIMIT 1`,
        [entity_id]
      );
      if (!cur.length) { skipped.push({ change_log_id: id, reason: 'entity_missing' }); continue; }

      const isDate = CASE_DATE_FIELDS.has(field);
      const curVal = cur[0].v;
      let matches;
      if (isDate) {
        matches = toDatePart(curVal) === toDatePart(new_value);
      } else {
        matches = (curVal == null ? '' : String(curVal).trim()) === (new_value == null ? '' : String(new_value).trim());
      }
      if (!matches) { skipped.push({ change_log_id: id, reason: 'modified_since' }); continue; }

      if (!dryRun) {
        const writeBack = (old_value == null || old_value === '') && isDate ? null : old_value;
        await db.query(`UPDATE cases SET \`${field}\`=? WHERE case_id=?`, [writeBack, entity_id]);
      }
      await stamp(id);
      reverted.push({ change_log_id: id, entity_type, entity_id: String(entity_id), field, action: 'restored' });
      continue;
    }

    // ── event/create ────────────────────────────────────────────────────
    if (entity_type === 'event' && field === 'create') {
      const [cur] = await db.query(
        `SELECT event_status FROM events WHERE event_id=? LIMIT 1`,
        [entity_id]
      );
      if (!cur.length) { skipped.push({ change_log_id: id, reason: 'already_gone' }); continue; }
      if (cur[0].event_status !== 'Scheduled') { skipped.push({ change_log_id: id, reason: 'already_gone' }); continue; }
      if (!dryRun) {
        await db.query(`UPDATE events SET event_status='Canceled' WHERE event_id=?`, [entity_id]);
      }
      await stamp(id);
      reverted.push({ change_log_id: id, entity_type, entity_id: String(entity_id), field, action: 'canceled' });
      continue;
    }

    // ── event/update ────────────────────────────────────────────────────
    if (entity_type === 'event' && field === 'update') {
      let oldState, newState;
      try {
        oldState = JSON.parse(old_value);
        newState = JSON.parse(new_value);
      } catch (_) {
        skipped.push({ change_log_id: id, reason: 'unrevertable' });
        continue;
      }
      const [cur] = await db.query(
        `SELECT event_date, event_time, event_all_day, event_location FROM events WHERE event_id=? LIMIT 1`,
        [entity_id]
      );
      if (!cur.length) { skipped.push({ change_log_id: id, reason: 'entity_missing' }); continue; }
      const c = cur[0];
      const matches =
        _eqNullable(toDatePart(c.event_date), newState.date) &&
        _eqNullable(toTimePart(c.event_time), newState.time) &&
        Number(c.event_all_day) === Number(newState.all_day) &&
        _eqNullable(c.event_location, newState.location);
      if (!matches) { skipped.push({ change_log_id: id, reason: 'modified_since' }); continue; }

      if (!dryRun) {
        await db.query(
          `UPDATE events SET event_date=?, event_time=?, event_all_day=?, event_location=? WHERE event_id=?`,
          [oldState.date, oldState.time, oldState.all_day, oldState.location, entity_id]
        );
      }
      await stamp(id);
      reverted.push({ change_log_id: id, entity_type, entity_id: String(entity_id), field, action: 'restored' });
      continue;
    }

    // ── appt/create ─────────────────────────────────────────────────────
    if (entity_type === 'appt' && field === 'create') {
      const [cur] = await db.query(
        `SELECT appt_status FROM appts WHERE appt_id=? LIMIT 1`,
        [entity_id]
      );
      if (!cur.length || cur[0].appt_status !== 'Scheduled') {
        skipped.push({ change_log_id: id, reason: 'already_gone' });
        continue;
      }
      if (!dryRun) {
        // SILENT cancel — sms:false, email:false means apptService fires NO
        // client-facing SMS/email. GCal cleanup + automation teardown are
        // firm-side and desirable when unwinding a create.
        //
        // The status SELECT above is check-then-act: an appt could be killed by
        // another path (e.g. superseded by a later 341) between the read and
        // here, and cancelAppt throws on an already-Canceled appt. Isolate that
        // throw so one bad row skips instead of aborting the whole batch. The
        // row is NOT stamped, so it stays eligible for a later retry.
        const apptService = require('./apptService');
        try {
          await apptService.cancelAppt(db, {
            appt_id: entity_id,
            sms: false,
            email: false,
            cancel_gcal: true,
            note: 'court action revert',
            actingUserId,
          });
        } catch (cancelErr) {
          console.error(`[courtExecutor] revert cancelAppt(${entity_id}) failed:`, cancelErr.message);
          skipped.push({ change_log_id: id, reason: 'cancel_failed' });
          continue;
        }
      }
      await stamp(id);
      reverted.push({ change_log_id: id, entity_type, entity_id: String(entity_id), field, action: 'canceled' });
      continue;
    }

    // ── unknown ─────────────────────────────────────────────────────────
    skipped.push({ change_log_id: id, reason: 'unrevertable' });
  }

  return { dryRun, reverted, skipped };
}


// ─────────────────────────────────────────────────────────────────────────
// logExtractFailure  (Slice 5 — ingest extract-failure audit)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Record a court_ai_log row for an email whose LLM extraction never produced a
 * usable payload (aiService returned !ok / no json, or the court_extract
 * internal_function threw). Outcome 'queued' with review_reason
 * 'extract_failed:<msg>' so it surfaces in the dry-run review queue. The
 * forensic email_log row already exists upstream — nothing is lost.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string|null} opts.messageId
 * @param {boolean}     opts.dryRun
 * @param {string}      opts.error      short failure reason
 * @param {number|null} [opts.aiCallId] linking ai_calls.id when one was written
 * @returns {Promise<{outcome:'queued', court_ai_log_id:number, review_reason:string}>}
 */
async function logExtractFailure(db, { messageId, dryRun, error, aiCallId } = {}) {
  const reason = ('extract_failed:' + (error == null ? 'unknown' : String(error))).slice(0, 255);
  const courtLogId = await insertCourtAiLog(db, {
    message_id:       messageId || null,
    ai_call_id:       aiCallId ?? null,
    dry_run:          !!dryRun,
    classification:   null,
    case_number:      null,
    resolved_case_id: null,
    case_name:        null,
    actions_json:     null,
    citations_json:   null,
    outcome:          'queued',
    review_reason:    reason,
    raw_response:     null,
  });
  return { outcome: 'queued', court_ai_log_id: courtLogId, review_reason: reason };
}


module.exports = {
  executeCourtActions,
  revertCourtActions,
  logExtractFailure,
  CASE_FIELD_POLICY,
  CASE_DATE_FIELDS,
  // exported for tests
  _internal: { toDatePart, toTimePart },
};