// lib/internal_functions/trustee.js
//
// FIL-1 — trustee validation. Fired by a trigger rule on
// case.court_processed (classification starts_with 'meeting_'), after the
// court executor has already landed the RAW extracted trustee in
// cases.case_trustee (CASE_FIELD_POLICY 'overwrite') and the 341 appt.
//
// JOB: match the extracted trustee against the trustee roster — contacts
// with a contact_roles role='trustee' row, loaded through
// lib/trusteeRoster (slice 7; the fe-trustees setting and the trustees
// TABLE are both retired, do not read them) —
// canonicalize cases.case_trustee to the exact roster spelling (downstream
// consumers — esignPrefillService._trusteeEntry among them — are exact-match
// by design), and set cases.case_341_link from the roster entry's Zoom link
// (the client portal reads that column: portalCaseService SCOPE_COLUMNS),
// and stamp the entry's contact_id into cases.case_trustee_contact_id (the
// slice-6 twin) alongside — the entry is already in hand, so no re-resolve
// through caseRoleResolver.
// The 341 APPT's connection_info is NOT touched here — the executor already
// wrote the email's verbatim meeting-id/passcode/phone there, which is
// per-case and richer than the roster's generic URL.
//
// NO MATCH / AMBIGUOUS / CHAPTER MISMATCH → an alert TASK (never a guess),
// deduped per case via tasks.task_dedupe_key (same open-task semantics as
// esignAlertService: Pending/Due Today/Overdue = open; re-occurrence touches
// the open task instead of stacking a second one).
//
// ARMING / DRY-RUN (court_ingest_live pattern):
//   app_settings 'trustee_validation_live' — absent/'0' → EVERY run is a dry
//   run, regardless of params; '1' → live. A dry run writes NOTHING to
//   cases, routes the alert task to `dry_run_alert_to` (default user 6, Fred)
//   with a "[DRY RUN]" title and its own dedupe key (so a dry-run task never
//   suppresses the later live alert), and emails a one-line summary of what
//   it did / would have done to `debug_email_to` on EVERY dry run — matched
//   runs included — so the behavior is visible without digging logs.
//   The trigger rule ships ACTIVE with the setting at '0': next real 341
//   notice produces a visible dry run; flip the setting to arm.
//
// IDEMPOTENT: re-running against an already-canonical case is a no-op
// (no UPDATE, no log row); re-running an unmatched case touches the open
// alert task rather than creating another.

'use strict';

const { matchTrustee } = require('../trusteeMatch');

const fns = {};

const OPEN_TASK_STATUSES = ['Pending', 'Due Today', 'Overdue'];
const MAX_TRUSTEE = 100;   // cases.case_trustee varchar(100) — no STRICT mode,
const MAX_LINK    = 255;   // cases.case_341_link varchar(255) — clamp or skip.

function _clip(s, n) {
  const v = String(s == null ? '' : s);
  return v.length <= n ? v : `${v.slice(0, n - 1)}…`;
}

function _docket(row) {
  return row.case_number_full || row.case_number || row.case_id;
}

/** Find an open alert task by dedupe key; touch it. Returns task_id|null. */
async function _findOpenAlert(db, key) {
  const [rows] = await db.query(
    `SELECT task_id FROM tasks
      WHERE task_dedupe_key = ? AND task_status IN (?, ?, ?)
      ORDER BY task_id DESC LIMIT 1`,
    [key, ...OPEN_TASK_STATUSES]
  );
  return rows && rows[0] ? rows[0].task_id : null;
}

fns.validate_case_trustee = async (params, db) => {
  // Lazy requires (module convention — circular-dep safety, jest-mockable).
  const { getSettings }      = require('../../services/settingsService');
  const taskService          = require('../../services/taskService');
  const logService           = require('../../services/logService');
  const emailService         = require('../../services/emailService');

  const {
    case_id,
    dry_run          = false,
    alert_to         = 22,                 // Rena
    dry_run_alert_to = 6,                  // Fred
    debug_email_to   = 'it@4lsg.com',
    debug_email_from = 'IT@metrodetroitbankruptcylaw.com',
  } = params;

  if (!case_id) throw new Error('validate_case_trustee requires case_id');

  const [caseRows] = await db.query(
    `SELECT case_id, case_trustee, case_chapter, case_341_link,
            case_trustee_contact_id, case_number, case_number_full
       FROM cases WHERE case_id = ? LIMIT 1`,
    [String(case_id)]
  );
  const caseRow = caseRows && caseRows[0];
  if (!caseRow) throw new Error(`validate_case_trustee: case ${case_id} not found`);

  const settings = await getSettings(db, ['trustee_validation_live']);
  const live = settings.trustee_validation_live === '1';
  const effectiveDry = dry_run === true || dry_run === 'true' || !live;

  // Roster from contacts + contact_roles (slice 7). NO try/catch: a DB
  // failure here must fail the run (retryable), not alert-task staff with a
  // phantom 'no_roster'. An EMPTY roster (no active trustee roles) → []
  // → matchTrustee 'no_roster', same as a blank setting used to.
  const { loadTrusteeRoster } = require('../trusteeRoster');
  const roster = await loadTrusteeRoster(db);

  const extracted = String(caseRow.case_trustee == null ? '' : caseRow.case_trustee).trim();
  const docket    = _docket(caseRow);

  const result = matchTrustee({
    extracted,
    chapter: caseRow.case_chapter,
    roster,
  });

  const out = {
    case_id: String(case_id),
    docket,
    status: result.status,
    method: result.method || null,
    extracted,
    canonical: null,
    trustee_updated: false,
    link_updated: false,
    twin_updated: false,
    would_update: [],        // dry-run: what a live run would have written
    notes: [],
    alert_task_id: null,
    alert_deduped: false,
    dry_run: effectiveDry,
  };

  if (result.status === 'matched') {
    const entry     = result.entry;
    const canonical = String(entry.name).trim();
    const link      = String(entry.link == null ? '' : entry.link).trim();
    out.canonical = canonical;

    const sets = [];
    const args = [];
    if (canonical && canonical !== extracted) {
      if (canonical.length > MAX_TRUSTEE) {
        // Silent truncation hazard (no STRICT_TRANS_TABLES) — refuse, note it.
        out.notes.push(`roster name exceeds ${MAX_TRUSTEE} chars — trustee not rewritten`);
      } else {
        sets.push('case_trustee = ?'); args.push(canonical);
        out.trustee_updated = true;
      }
    }
    if (link && link !== String(caseRow.case_341_link == null ? '' : caseRow.case_341_link).trim()) {
      if (link.length > MAX_LINK) {
        // A clipped URL is a broken URL — skip rather than clamp.
        out.notes.push(`roster link exceeds ${MAX_LINK} chars — link not written`);
      } else {
        sets.push('case_341_link = ?'); args.push(link);
        out.link_updated = true;
      }
    }

    // Slice-6 twin, wired here in slice 7: the matched entry carries its
    // contact_id, so the resolution IS the match — write it alongside.
    // Guarded like caseRoleResolver's entry_no_contact_id path: an invalid
    // id is never guessed at. A twin-only write (name already canonical,
    // twin NULL) rides the UPDATE but is NOT logged — courtExecutor's twin
    // writes are unlogged for the same reason, and the header's "no log row
    // on an already-canonical rerun" promise stays about what staff see.
    const twinCid = parseInt(entry.contact_id, 10);
    if (Number.isInteger(twinCid) && twinCid > 0
        && twinCid !== (caseRow.case_trustee_contact_id == null
                        ? null : Number(caseRow.case_trustee_contact_id))) {
      sets.push('case_trustee_contact_id = ?'); args.push(twinCid);
      out.twin_updated = true;
    }

    if (sets.length) {
      if (effectiveDry) {
        out.would_update = sets.map((s) => s.split(' =')[0]);
        out.trustee_updated = false;
        out.link_updated = false;
        out.twin_updated = false;
      } else {
        args.push(String(case_id));
        await db.query(`UPDATE cases SET ${sets.join(', ')} WHERE case_id = ?`, args);
        if (out.trustee_updated || out.link_updated) try {
          await logService.createLogEntry(db, {
            type: 'status',
            link_type: 'case',
            link_id: String(case_id),
            by: 0,
            subject: 'Trustee validated',
            data: `Trustee validated against roster (${result.method}): ` +
                  `'${extracted}' → '${canonical}'` +
                  (out.link_updated ? '; 341 link set from roster.' : '.'),
          });
        } catch (err) {
          console.warn(`[TRUSTEE_VAL] case ${case_id}: log write failed: ${err.message}`);
        }
      }
    }
    console.log(
      `[TRUSTEE_VAL] case=${case_id} ${docket} matched(${result.method}) ` +
      `'${extracted}' → '${canonical}' dry=${effectiveDry} ` +
      `writes=${sets.length ? sets.join(',') : 'none'}`
    );

    // FIL-3 — arrival signal for downstream consumers (the "Notice of Filing"
    // re-fire on trustee arrival, wf47, chains off this). LIVE matched runs
    // only: a dry run must never arm a client-facing workflow. Emitted even
    // when nothing was written (already-canonical rerun) — "the trustee is
    // known and valid" is the signal, not "a column changed"; consumers carry
    // their own send-once guards. emit() is fire-and-forget and never throws
    // (lib/domainEvents contract), so no try/catch needed.
    if (!effectiveDry) {
      const domainEvents = require('../domainEvents');
      domainEvents.emit(db, 'case.trustee_validated', {
        case_id: String(case_id),
        source: 'system',
        data: {
          status: 'matched',
          method: result.method || null,
          extracted,
          canonical,
          trustee_updated: out.trustee_updated,
          link_updated: out.link_updated,
          docket,
          case_chapter: caseRow.case_chapter ?? null,
        },
      });
    }
  } else {
    // ── Alert path: no_trustee / no_roster / no_match / ambiguous / chapter_mismatch ──
    const candNames = (result.candidates || []).map((c) =>
      `${c.name}${c.case_type != null ? ` (Ch ${c.case_type})` : ''}`);

    const why = {
      no_trustee:       'No trustee is recorded on the case (the court extractor did not land one).',
      no_roster:        'The trustee roster is empty — no active trustee contacts (contact_roles role=\'trustee\') exist, so NO case could match.',
      no_match:         `The recorded trustee "${extracted}" does not match any roster entry.` +
                        (candNames.length ? ` Near miss: ${candNames.join('; ')}.` : ''),
      ambiguous:        `The recorded trustee "${extracted}" matches MORE THAN ONE roster entry — not guessing. ` +
                        `Candidates: ${candNames.join('; ')}.`,
      chapter_mismatch: `The recorded trustee "${extracted}" only matches roster entries for a DIFFERENT chapter ` +
                        `(case is Ch ${caseRow.case_chapter || '?'}): ${candNames.join('; ')}.`,
    }[result.status] || `Unrecognized status ${result.status}.`;

    const to        = effectiveDry ? dry_run_alert_to : alert_to;
    const dedupeKey = _clip(`trustee-val${effectiveDry ? '-dry' : ''}:${case_id}`, 64);
    const title     = _clip(`${effectiveDry ? '[DRY RUN] ' : ''}Trustee needs review — ${docket}`, 100);
    const desc      = _clip(
      `${effectiveDry ? '[DRY RUN — nothing was written; this task went to the tester, not staff]\n\n' : ''}` +
      `${why}\n\n` +
      `The trustee was not canonicalized and the 341 Zoom link was NOT set from the roster.\n\n` +
      `Fix: open the case and select the correct trustee in the Case Info form — ` +
      `picking a roster trustee auto-fills the 341 Zoom link. ` +
      `If the trustee is genuinely new, add them as a contact with the trustee role first.`,
      1000
    );

    const existing = await _findOpenAlert(db, dedupeKey);
    if (existing) {
      await db.query('UPDATE tasks SET task_last_update = NOW() WHERE task_id = ?', [existing]);
      out.alert_task_id = existing;
      out.alert_deduped = true;
      console.log(`[TRUSTEE_VAL] case=${case_id} ${result.status} — open alert task #${existing} touched (deduped)`);
    } else {
      const { task_id } = await taskService.createTask(db, {
        from: 0,                                   // automations user
        to,
        title,
        desc,
        link_type: 'case',
        link_id: String(case_id),
        source: 'trustee_validation',
        send_assignment_email: true,
      });
      await db.query('UPDATE tasks SET task_dedupe_key = ? WHERE task_id = ?', [dedupeKey, task_id]);
      out.alert_task_id = task_id;
      console.log(`[TRUSTEE_VAL] case=${case_id} ${result.status} — alert task #${task_id} → user ${to} dry=${effectiveDry}`);
    }
  }

  // Dry-run visibility: one summary email per run, matched or not. Failure to
  // send must never fail the function.
  if (effectiveDry) {
    try {
      await emailService.sendEmail(db, {
        from: debug_email_from,
        to: debug_email_to,
        subject: `[TrusteeVal DRY] ${docket} — ${out.status}`,
        text:
          `case_id: ${case_id}\ndocket: ${docket}\nstatus: ${out.status}` +
          `${out.method ? ` (${out.method})` : ''}\n` +
          `extracted: ${extracted || '(empty)'}\ncanonical: ${out.canonical || '-'}\n` +
          `would_update: ${out.would_update.join(', ') || 'nothing'}\n` +
          `alert_task: ${out.alert_task_id || '-'}${out.alert_deduped ? ' (deduped)' : ''}\n` +
          `notes: ${out.notes.join(' | ') || '-'}\n\n` +
          `Live gate: app_settings 'trustee_validation_live' (currently not '1').`,
      });
    } catch (err) {
      console.warn(`[TRUSTEE_VAL] dry-run summary email failed: ${err.message}`);
    }
  }

  return { success: true, output: out };
};

fns.validate_case_trustee.__meta = {
  category: 'court',
  description:
    'Validate cases.case_trustee against the trustee roster (contacts with a ' +
    "contact_roles role='trustee' row, via lib/trusteeRoster). " +
    'On a match: canonicalize the stored trustee to the exact roster spelling, set ' +
    'cases.case_341_link from the roster Zoom link, and stamp case_trustee_contact_id. ' +
    'On no-match/ambiguous/chapter-mismatch: ' +
    'create a deduped alert task (never guesses). Gated by app_settings trustee_validation_live — ' +
    "absent/'0' forces dry-run (no case writes; alert routed to dry_run_alert_to; summary email sent).",
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case to validate.' },
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: "Force a dry run even when trustee_validation_live='1'." },
    { name: 'alert_to', type: 'integer', required: false, default: 22,
      description: 'users.user who receives the live no-match alert task.' },
    { name: 'dry_run_alert_to', type: 'integer', required: false, default: 6,
      description: 'users.user who receives the alert task on DRY runs.' },
    { name: 'debug_email_to', type: 'string', required: false, default: 'it@4lsg.com' },
    { name: 'debug_email_from', type: 'string', required: false, default: 'IT@metrodetroitbankruptcylaw.com' },
  ],
  example: { case_id: '{{case_id}}' },
};

module.exports = fns;
