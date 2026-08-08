#!/usr/bin/env node
// scripts/backfill_court_event_calendars_2026_08.js
//
// Show-cause arc — ONE-SHOT backfill. Every event the court executor created
// before 2026-08 carries event_calendar_id='none' (the "GCal sync is a
// separate, unmade decision" neutralization), so 50+ hearings and deadlines —
// including a stay-relief hearing and two show-cause hearings — exist ONLY
// inside YisraCase. The decision is now made (courtExecutor doCreateEvent,
// same slice as this script):
//
//   timed   → event_calendar_id='primary' (Stuart's own Google calendar —
//             gcal credential 11 IS stuart@4lsg.com) + event_with=1
//             (availabilityService then blocks only SS, not RG's intake slots)
//   all-day → event_calendar_id=NULL (firm group calendar via app_settings
//             gcal_calendar_id, same as wf24 deadlines). All-day never blocks.
//
// This script converges the FUTURE backlog to the same policy, through
// PATCH /api/events/:id → eventService.updateEvent — NEVER raw SQL —
// because event_calendar_id is GCAL_AFFECTING: updateEvent itself creates the
// Google Calendar entry after the column flips. One PATCH per event does both.
//
// ─── SCOPE RULES ──────────────────────────────────────────────────────────────
//   INCLUDED  Scheduled events, event_calendar_id='none', event_date STRICTLY
//             AFTER today (firm time). Today's hearings have already happened
//             or are in progress — syncing them now is calendar noise.
//   SKIPPED   event_type '341' — 341s are APPOINTMENTS in this system; the
//             appt pipeline owns their calendar sync. A '341'-typed event row
//             (wf24-era artifact) syncing too would double-book the calendar.
//             Printed, never touched.
//   SKIPPED   anything not 'none' (already on a calendar) or not Scheduled.
//
// SAFE TO RE-RUN: a converged event no longer has calendar_id 'none' and falls
// out of the include filter.
//
// ─── USAGE ────────────────────────────────────────────────────────────────────
//   Auth — EITHER of:
//     YC_TOKEN=<jwt>                → updates logged as YOU
//     YC_API_KEY=<INTERNAL_API_KEY> → updates logged as acting_user 0
//
//   APP_URL=https://app.4lsg.com YC_TOKEN=… node scripts/backfill_court_event_calendars_2026_08.js --dry-run
//   APP_URL=https://app.4lsg.com YC_TOKEN=… node scripts/backfill_court_event_calendars_2026_08.js
//
// RUN --dry-run FIRST. It only GETs and prints the exact PATCH each live run
// would send.

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
                '  or YC_API_KEY (INTERNAL_API_KEY — updates log as acting_user 0).');
  process.exit(1);
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  ...(JWT ? { Authorization: `Bearer ${JWT}` } : { 'X-Api-Key': APIKEY }),
};

async function api(method, path, body) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: AUTH_HEADERS,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* leave null */ }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

/** 'YYYY-MM-DD' for tomorrow in the firm timezone (strictly-future cutoff). */
function firmTomorrow() {
  const tz = process.env.FIRM_TIMEZONE || 'America/Detroit';
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

const datePart = (v) => {
  const m = String(v ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

(async () => {
  const from = firmTomorrow();
  console.log(`${DRY ? '[DRY-RUN] ' : ''}Backfill court-event calendars — Scheduled events from ${from} onward\n`);

  // Page through GET /api/events (listEvents has no calendar_id filter — we
  // filter client-side on event_calendar_id === 'none').
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api('GET', `/api/events?status=Scheduled&from=${from}&limit=100&offset=${offset}&sort=asc`);
    const rows = (page && page.data) || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }

  const targets = all.filter(e => e.event_calendar_id === 'none');
  const skipped341 = targets.filter(e => String(e.event_type || '').trim() === '341');
  const work       = targets.filter(e => String(e.event_type || '').trim() !== '341');

  console.log(`Scheduled future events: ${all.length}  |  calendar_id='none': ${targets.length}  |  341-typed (skipped): ${skipped341.length}  |  to converge: ${work.length}\n`);

  for (const e of skipped341) {
    console.log(`  SKIP  #${e.event_id}  ${datePart(e.event_date)}  341  ${e.event_title} — appt pipeline owns 341 calendar sync`);
  }
  if (skipped341.length) console.log('');

  let ok = 0, failed = 0;
  for (const e of work) {
    const timed = Number(e.event_all_day) === 0 && e.event_time;
    const patch = timed
      ? { event_calendar_id: 'primary', event_with: 1 }
      : { event_calendar_id: null };
    const label = `#${String(e.event_id).padEnd(5)} ${datePart(e.event_date)} ${timed ? (String(e.event_time).slice(0, 5) + ' ') : 'allday'} ${String(e.event_type || '-').padEnd(28)} ${e.event_link_id || '-'}`;
    if (DRY) {
      console.log(`  PLAN  ${label} → ${JSON.stringify(patch)}`);
      continue;
    }
    try {
      await api('PATCH', `/api/events/${e.event_id}`, patch);
      ok++;
      console.log(`  OK    ${label} → ${JSON.stringify(patch)}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${label} → ${err.message}`);
    }
  }

  console.log(`\n${DRY ? 'Dry-run complete — no writes.' : `Done. ${ok} converged, ${failed} failed.`}`);
  if (!DRY && ok) {
    console.log('\nVerify (readonly SQL):');
    console.log(`  SELECT event_id, event_type, event_date, event_calendar_id, event_with, event_gcal IS NOT NULL AS synced`);
    console.log(`    FROM events WHERE event_status='Scheduled' AND event_date > CURDATE() ORDER BY event_date;`);
    console.log('Expect: no calendar_id \'none\' rows except 341-typed; timed rows synced=1 within a few seconds.');
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});