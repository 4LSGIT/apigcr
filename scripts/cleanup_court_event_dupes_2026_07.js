#!/usr/bin/env node
// scripts/cleanup_court_event_dupes_2026_07.js
//
// Slice 4 Phase B — ONE-SHOT cleanup of the duplicate court events diagnosed in
// Phase A. Cancels 25 duplicate Scheduled events and repairs one malformed
// title. SAFE TO RE-RUN: an already-Canceled event is skipped, not re-cancelled.
//
// ─── WHY IT GOES THROUGH THE API AND NOT RAW SQL ──────────────────────────────
// PATCH /api/events/:id/cancel → eventService.cancelEvent (eventService.js:1164),
// which does three things a bare `UPDATE events SET event_status='Canceled'`
// would silently skip:
//   1. deletes the Google Calendar entry (events 58/59/60/61 are the only ones in
//      this list that ever reached GCal — external-automation rows are the sole
//      creator that didn't hard-code event_calendar_id='none'),
//   2. soft-deletes the event's reminder task(s) via cancelReminderTasks →
//      taskService.deleteTask, which ALSO cancels that task's scheduled
//      due-reminder job, and
//   3. writes a 'canceled' log entry so the case log shows what happened.
// courtExecutor.revertCourtActions does the raw UPDATE and orphans (1) and (2) —
// do not copy that pattern here.
//
//   *** CANCELLING EVENT 59 CASCADES TASK 1051 ***
//   ("Reminder: Docs due to trustee - 26-46639-mar - Moneika Nashay Brown",
//    status Overdue, task_due_job_id 1208). That is INTENDED: its twin task 1050
//   hangs off event 52, which we are KEEPING. The script asserts the cascade in
//   its output and prints the verification query.
//
// ─── KEEP — DO NOT TOUCH ──────────────────────────────────────────────────────
//   95, 96, 97   real, UNDUPLICATED deadlines (Docs / Confirmation Certificate /
//                Schedules) for 26-47542. No surviving pipeline recreates these
//                types; cancelling them would silently drop real obligations.
//                Grandfathered by manager ruling.
//   89 + 108     26-44274, both 2026-09-02 14:00 — Confirmation Hearing AND an
//   71 + 110     Order to Show Cause. 26-46899, both 2026-09-01 — two different
//                deadlines. Same slot, DIFFERENT obligations. These are the
//                false-positive proof for the dedupe guard: they must survive.
//   51, 69, 94   the external-automation copy of each 3-way confirmation-hearing
//                cluster. Manager ruling: they are the ONLY rows on Google
//                Calendar, so they are the ones that stay.
//   anything already Canceled (incl. event 87).
//
// ─── USAGE ────────────────────────────────────────────────────────────────────
//   Auth — EITHER of:
//     YC_TOKEN=<jwt>          → cancels are logged as YOU (preferred; real audit trail)
//     YC_API_KEY=<INTERNAL_API_KEY> → cancels are logged as acting_user 0 (automation)
//
//   APP_URL=https://app.4lsg.com YC_TOKEN=… node scripts/cleanup_court_event_dupes_2026_07.js --dry-run
//   APP_URL=https://app.4lsg.com YC_TOKEN=… node scripts/cleanup_court_event_dupes_2026_07.js
//
// RUN --dry-run FIRST. It only GETs; it prints each event's current status,
// title, and whether it is on Google Calendar, and tells you exactly what the
// live run would do.

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const JWT     = process.env.YC_TOKEN  || '';
const APIKEY  = process.env.YC_API_KEY || '';
const DRY     = process.argv.includes('--dry-run');

if (!APP_URL) {
  console.error('APP_URL is required (e.g. APP_URL=https://app.4lsg.com)');
  process.exit(1);
}
if (!JWT && !APIKEY) {
  console.error('Set YC_TOKEN (a JWT — preferred, gives a real acting user in the log)\n' +
                '  or YC_API_KEY (INTERNAL_API_KEY — cancels log as acting_user 0).');
  process.exit(1);
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  ...(JWT ? { Authorization: `Bearer ${JWT}` } : { 'X-Api-Key': APIKEY }),
};

// ─── THE LOCKED CANCEL LIST (25), grouped by cluster for the log ──────────────
const CANCEL = [
  { why: '26-31193  wf24 — 06-10 GAS forwardTestTrigger() replay dupes   (keep 15,16,17,20,21,22)',
    ids: [27, 28, 29, 31, 33, 36] },
  { why: '26-42040  wf25 — 06-10 GAS replay dupes                        (keep 23,24)',
    ids: [25, 26] },
  { why: '26-44883  wf25 — 06-10 GAS replay dupes                        (keep 18,19)',
    ids: [35, 37] },
  { why: '26-46899  wf24 — clerk re-docketed the 341 notice (2 real NEFs) (keep 73,75,76,77,78)',
    ids: [79, 81, 82, 83, 84] },
  { why: '26-46639  external — 06-12 re-fire dupes  (keep 52,53,54)  [59 CASCADES task 1051]',
    ids: [59, 60, 61] },
  { why: '26-44743  courtExecutor — pre-fix title-variance dupe          (keep 90)',
    ids: [93] },
  { why: '26-46639  conf hearing 3-way cluster — KEEP 51 (external, on GCal)',
    ids: [46, 58] },
  { why: '26-46899  conf hearing 3-way cluster — KEEP 69 (external, on GCal)',
    ids: [74, 80] },
  { why: '26-47542  conf hearing 3-way cluster — KEEP 94 (external, on GCal)',
    ids: [99, 104] },
];

// ─── THE ONE TITLE REPAIR ─────────────────────────────────────────────────────
const RETITLE = {
  event_id: 94,
  event_title: 'Confirmation Hearing - 26-47542 - Marquita Renea Smith',
  why: 'the external automation wrote a blank docket: "Confirmation Hearing -  - Marquita Renea Smith"',
};

const TASK_CASCADE = { event_id: 59, task_id: 1051, due_job_id: 1208 };

const KEEP_UNTOUCHED = [95, 96, 97, 89, 108, 71, 110, 51, 69, 94];

async function api(method, path, body) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: AUTH_HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json };
}

/** GET /api/events/:id → the event row (routes/api.events.js:47). */
async function getEvent(id) {
  const r = await api('GET', `/api/events/${id}`);
  if (!r.ok) return { err: `HTTP ${r.status}: ${(r.json && (r.json.message || r.json.error)) || ''}` };
  const ev = (r.json && (r.json.data || r.json.event)) || r.json;
  if (!ev || ev.event_id == null) return { err: 'unexpected response shape' };
  return { ev };
}

(async () => {
  const all = CANCEL.flatMap(g => g.ids);
  console.log(`\n${DRY ? '━━━ DRY RUN — reads only, nothing is written ━━━' : '━━━ LIVE ━━━'}`);
  console.log(`target : ${APP_URL}`);
  console.log(`auth   : ${JWT ? 'JWT (acting user = you)' : 'X-Api-Key (acting user = 0 / automation)'}`);
  console.log(`plan   : cancel ${all.length} events, retitle 1 event\n`);

  let did = 0, already = 0, failed = 0;

  for (const group of CANCEL) {
    console.log(`── ${group.why}`);
    for (const id of group.ids) {
      const { ev, err } = await getEvent(id);

      if (err) {
        // In DRY mode a read failure is fatal to the preview. In LIVE mode we
        // still attempt the cancel — cancelEvent is authoritative and idempotent.
        console.log(`   [${String(id).padStart(3)}] GET failed — ${err}`);
        if (DRY) { failed++; continue; }
      }

      const status = ev ? ev.event_status : '(unknown)';
      const title  = ev ? String(ev.event_title || '').slice(0, 44) : '';
      const onCal  = ev && ev.event_gcal ? ' [ON GCAL]' : '';

      if (DRY) {
        const verdict = status === 'Canceled' ? 'SKIP (already Canceled)' : 'CANCEL';
        console.log(`   [${String(id).padStart(3)}] ${String(status).padEnd(10)} "${title}"${onCal}  → would ${verdict}`);
        if (status === 'Canceled') already++; else did++;
        if (id === TASK_CASCADE.event_id) {
          console.log(`         ↳ cancelEvent will ALSO soft-delete reminder task ${TASK_CASCADE.task_id} ` +
                      `and cancel its due-job ${TASK_CASCADE.due_job_id}`);
        }
        continue;
      }

      if (ev && status === 'Canceled') {
        already++;
        console.log(`   [${String(id).padStart(3)}] skip — already Canceled (idempotent)`);
        continue;
      }

      const r = await api('PATCH', `/api/events/${id}/cancel`, { delete_gcal: true });
      const msg = (r.json && (r.json.message || r.json.error)) || '';

      if (r.ok) {
        did++;
        console.log(`   [${String(id).padStart(3)}] CANCELED  "${title}"${onCal}`);
        if (id === TASK_CASCADE.event_id) {
          console.log(`         ↳ ASSERT: cancelEvent's cancelReminderTasks soft-deleted task ` +
                      `${TASK_CASCADE.task_id} and cancelled due-job ${TASK_CASCADE.due_job_id}.`);
          console.log(`         ↳ VERIFY: SELECT task_status FROM tasks WHERE task_id=${TASK_CASCADE.task_id};  -- expect 'Deleted'`);
        }
      } else if (/already Canceled/i.test(msg)) {
        already++;
        console.log(`   [${String(id).padStart(3)}] skip — already Canceled (idempotent)`);
      } else {
        failed++;
        console.log(`   [${String(id).padStart(3)}] FAILED (${r.status}) — ${msg || '(no message)'}`);
      }
    }
  }

  // ── Title repair ──────────────────────────────────────────────────────────
  console.log(`\n── retitle event ${RETITLE.event_id} — ${RETITLE.why}`);
  if (DRY) {
    const { ev, err } = await getEvent(RETITLE.event_id);
    console.log(err
      ? `   [ 94] GET failed — ${err}`
      : `   [ 94] now: "${ev.event_title}"\n         → would PATCH event_title = "${RETITLE.event_title}"`);
  } else {
    const r = await api('PATCH', `/api/events/${RETITLE.event_id}`, { event_title: RETITLE.event_title });
    if (r.ok) {
      console.log(`   [ 94] RETITLED → "${RETITLE.event_title}"`);
    } else {
      failed++;
      console.log(`   [ 94] FAILED (${r.status}) — ${(r.json && (r.json.message || r.json.error)) || ''}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(74)}`);
  console.log(`${DRY ? 'would cancel' : 'cancelled'}: ${did}    already done: ${already}    failed: ${failed}`);
  console.log(`untouched by design: ${KEEP_UNTOUCHED.join(', ')}`);
  console.log(`  95,96,97 = real unduplicated deadlines · 89,108 + 71,110 = same slot, different obligations`);
  console.log(`  51,69,94 = the kept external copies (the only rows on Google Calendar)`);
  if (DRY) console.log(`\nre-run without --dry-run to apply.`);
  console.log('');

  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
