// services/availabilityService.js
//
/**
 * Availability Service — Scheduler Slice 3
 *
 * The availability engine: getSlots() computes open appointment-start slots
 * per provider over a civil-date range. Pure compute + DB reads — no routes,
 * no UI, no writes. Slice 4 wires this to an internal API; slice 6 to public
 * booking. Both faces call this one function, so its semantics ARE the
 * definition of "free."
 *
 * ── Timezone model ───────────────────────────────────────────
 * Everything is computed in firm-local wall time (Luxon, FIRM_TZ). All five
 * busy/availability sources are stored firm-local — VERIFIED against code
 * and live data, not assumed:
 *
 *   user_availability    TIME-of-day + weekday        → inherently firm-local
 *   availability_blocks  naive DATETIME               → firm-local (slice 1 convention)
 *   firm_blocks          naive DATETIME               → firm-local (slice 2 writes
 *                                                       FIRM_TZ wall time)
 *   events               DATE + TIME                  → firm-local (eventService
 *                                                       rejects tz suffixes; _gcalTimes
 *                                                       interprets in FIRM_TZ)
 *   appts.appt_date      naive DATETIME               → firm-local. NOT UTC.
 *                                                       appt_date_utc is the UTC twin,
 *                                                       but it is NULL on rows created
 *                                                       via the legacy path — never
 *                                                       read it here.
 *
 * Because every source is firm-local, no UTC conversion happens anywhere in
 * this module. All datetimes are fetched as DATE_FORMAT/TIME_FORMAT strings
 * so the mysql2 timezone:"Z" fake-UTC Date wrapping never enters the picture.
 *
 * ── Buffer semantics (binding) ───────────────────────────────
 * buffer_min pads each busy APPT interval on both sides. A slot fits if
 * [start, start + appt_length) lies fully inside a free window. Buffer is
 * NOT added to the fit test (that would double-count) and pads appts only —
 * not events, not blocks, not working-window edges. Consequence: a slot may
 * END exactly where an appt's front pad begins.
 *
 * ── Interval representation ──────────────────────────────────
 * The pure core works on half-open epoch-millisecond intervals
 * { start, end } (start inclusive, end exclusive). Touching intervals do
 * not conflict: a slot ending at ms X coexists with a busy interval
 * starting at ms X. Wall-clock concerns (grid alignment, day boundaries,
 * DST) are handled by converting through Luxon at the edges.
 *
 * ── Slot grid ────────────────────────────────────────────────
 * Slot starts align to the clock grid: minute-of-hour values that are
 * multiples of `granularity` (:00/:15/:30/:45 for 15) — NOT offsets from
 * the free-window start. A window opening at 10:23 with granularity 15
 * yields 10:30 first. granularity > 60 aligns to multiples of granularity
 * minutes from midnight wall time (unused in practice; documented for
 * completeness).
 *
 * Exports:
 *   getSlots(db, opts)                    — the engine (fetch + compose)
 *   unionIntervals, subtractIntervals,    — pure interval math
 *   walkSlots, computeProviderDaySlots,   — pure compose (offline-testable)
 *   normalizeBusyForProvider,             — row shapes → busy intervals
 *   localStrToMs, fetchGcalBusy           — helpers + live GCal freeBusy (phase 2)
 */

const { DateTime } = require('luxon');
const { FIRM_TZ } = require('./timezoneService');
const { buildHeadersForCredential } = require('../lib/credentialInjection');
const gcalService = require('./gcalService'); // reuse _resolveTarget for firm-cred resolution

const DEFAULT_EVENT_LENGTH_MIN = 60; // must match eventService._gcalTimes default
const DEFAULT_APPT_LENGTH_MIN  = 60; // defensive: legacy rows may have NULL appt_length

// ─────────────────────────────────────────────────────────────
// Pure core — interval math (epoch ms, half-open [start, end))
// ─────────────────────────────────────────────────────────────

/**
 * Merge overlapping/adjacent intervals into a sorted disjoint list.
 * Adjacent (next.start === cur.end) intervals merge — correct for working
 * windows (9–13 + 12–17 ⇒ 9–17) and harmless for busy sets.
 *
 * @param {{start:number,end:number}[]} intervals
 * @returns {{start:number,end:number}[]} sorted, disjoint
 */
function unionIntervals(intervals) {
  const valid = (intervals || []).filter(iv => iv && iv.end > iv.start);
  if (valid.length === 0) return [];
  const sorted = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    const nxt = sorted[i];
    if (nxt.start <= cur.end) {
      if (nxt.end > cur.end) cur.end = nxt.end;
    } else {
      out.push({ ...nxt });
    }
  }
  return out;
}

/**
 * Subtract busy intervals from free windows. Both half-open; a busy
 * interval starting exactly at a window's end (or ending at its start)
 * removes nothing.
 *
 * @param {{start:number,end:number}[]} windows — free windows (any order)
 * @param {{start:number,end:number}[]} busy    — busy intervals (any order)
 * @returns {{start:number,end:number}[]} remaining free, sorted disjoint
 */
function subtractIntervals(windows, busy) {
  const free = unionIntervals(windows);
  const cuts = unionIntervals(busy);
  if (cuts.length === 0) return free;

  const out = [];
  for (const w of free) {
    let cursor = w.start;
    for (const c of cuts) {
      if (c.end <= cursor) continue;       // cut entirely before remaining window
      if (c.start >= w.end) break;         // cut entirely after window (cuts sorted)
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out;
}

/**
 * Intersect two interval lists. Each input is unioned first (so overlapping
 * or adjacent fragments collapse), then a two-pointer walk emits the overlap
 * of every pair. Both half-open [start, end): touching intervals (a.end ===
 * b.start) do NOT overlap and yield nothing. Result is sorted and disjoint
 * (guaranteed by the union preprocessing). Pure.
 *
 * Used by the per-view booking-window restriction: bookable = availability ∩
 * view-windows. Intersection can only ever REMOVE time, never add it.
 *
 * @param {{start:number,end:number}[]} a
 * @param {{start:number,end:number}[]} b
 * @returns {{start:number,end:number}[]} sorted, disjoint intersection
 */
function intersectIntervals(a, b) {
  const A = unionIntervals(a);
  const B = unionIntervals(b);
  if (A.length === 0 || B.length === 0) return [];

  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const lo = Math.max(A[i].start, B[j].start);
    const hi = Math.min(A[i].end,   B[j].end);
    if (lo < hi) out.push({ start: lo, end: hi }); // strict: half-open, no touch
    // Advance whichever interval ends first (its overlaps are exhausted).
    if (A[i].end <= B[j].end) i++;
    else j++;
  }
  return out;
}

/**
 * Snap a zoned DateTime up to the next clock-grid point (inclusive — an
 * on-grid input is returned unchanged, seconds/ms truncated up).
 *
 * Grid for g ≤ 60: minute-of-hour ∈ {0, g, 2g, …} ∩ [0,60). For g that
 * doesn't divide 60 (e.g. 45 → :00/:45) the grid resets each hour, per
 * spec. Grid for g > 60: multiples of g wall-minutes from midnight.
 *
 * @param {DateTime} dt — zoned Luxon DateTime
 * @param {number} g    — granularity minutes
 * @returns {DateTime}
 */
function snapUpToGrid(dt, g) {
  let d = (dt.second || dt.millisecond)
    ? dt.startOf('minute').plus({ minutes: 1 })
    : dt;

  if (g > 60) {
    const fromMidnight = d.hour * 60 + d.minute;
    const rem = fromMidnight % g;
    return rem === 0 ? d : d.plus({ minutes: g - rem });
  }

  const rem = d.minute % g;
  if (rem === 0) return d;
  const target = d.minute + (g - rem);
  // target may be ≥ 60 only when g doesn't divide 60 (45: minute 50 → 95).
  // Roll to the next hour's :00, which is always on-grid.
  return target < 60
    ? d.set({ minute: target })
    : d.plus({ hours: 1 }).set({ minute: 0 });
}

/** True if the wall minute of a zoned DateTime is on the grid. */
function _onGrid(dt, g) {
  if (g > 60) return (dt.hour * 60 + dt.minute) % g === 0;
  return dt.minute % g === 0;
}

/**
 * Walk free windows emitting grid-aligned slot starts.
 *
 * A start s is emitted iff:
 *   - s is on the clock grid (wall time, see snapUpToGrid)
 *   - s ≥ earliestStartMs
 *   - [s, s + lengthMin) fits entirely inside one free window
 *
 * DST-safe: stepping is done on zoned DateTimes (real-duration plus),
 * with a re-snap after each step so a DST jump that lands off-grid
 * (only possible when granularity doesn't divide 60) self-corrects.
 *
 * @param {{start:number,end:number}[]} freeWindows — epoch ms, half-open
 * @param {object} o
 * @param {number} o.lengthMin
 * @param {number} o.granularityMin
 * @param {number} [o.earliestStartMs=-Infinity]
 * @param {string} [o.zone=FIRM_TZ]
 * @returns {string[]} 'yyyy-MM-dd HH:mm' firm-local starts, ascending
 */
function walkSlots(freeWindows, { lengthMin, granularityMin, earliestStartMs = -Infinity, zone = FIRM_TZ }) {
  const lengthMs = lengthMin * 60000;
  const out = [];

  for (const w of unionIntervals(freeWindows)) {
    const fromMs = Math.max(w.start, earliestStartMs);
    if (fromMs + lengthMs > w.end) continue;

    let cur = snapUpToGrid(DateTime.fromMillis(fromMs, { zone }), granularityMin);
    while (cur.toMillis() + lengthMs <= w.end) {
      out.push(cur.toFormat('yyyy-MM-dd HH:mm'));
      cur = cur.plus({ minutes: granularityMin });
      if (!_onGrid(cur, granularityMin)) cur = snapUpToGrid(cur, granularityMin);
    }
  }
  return out.sort();
}

// ─────────────────────────────────────────────────────────────
// Pure core — row-shape normalization
// ─────────────────────────────────────────────────────────────

/**
 * Firm-local naive datetime string → epoch ms.
 * Accepts 'YYYY-MM-DD HH:MM[:SS]' or ISO-T form. Invalid → null (caller
 * skips the row). DST-nonexistent wall times are shifted forward by Luxon.
 *
 * @param {string} s
 * @param {string} [zone=FIRM_TZ]
 * @returns {number|null}
 */
function localStrToMs(s, zone = FIRM_TZ) {
  if (!s) return null;
  const dt = DateTime.fromISO(String(s).trim().replace(' ', 'T'), { zone });
  return dt.isValid ? dt.toMillis() : null;
}

/**
 * Build one provider's busy-interval list from plain row shapes (exactly
 * what the SQL in getSlots returns — so tests feed identical shapes).
 *
 * Sources and rules (filters re-applied here for pure-core test coverage,
 * even where the SQL already filters):
 *   firmBlocks — all rows block everyone.
 *   events     — timed (event_all_day=0), event_status='Scheduled',
 *                event_with NULL (firm-wide) or === providerId.
 *                Interval = event_date+event_time for event_length minutes,
 *                NULL length → 60 (eventService gcal default). All-day
 *                events never block; a timed event missing its time
 *                (invariant violation) is skipped defensively.
 *   abBlocks   — availability_blocks rows with user === providerId.
 *   appts      — appt_status='Scheduled', appt_with === providerId.
 *                Interval = appt_date for appt_length minutes (NULL → 60,
 *                defensive for legacy rows), PADDED by bufferMin both sides.
 *   gcalBusy   — pre-fetched intervals (phase-2 stub returns []).
 *
 * @returns {{start:number,end:number}[]}
 */
function normalizeBusyForProvider(providerId, {
  firmBlocks = [], events = [], abBlocks = [], appts = [],
  gcalBusy = [], bufferMin = 0, zone = FIRM_TZ,
} = {}) {
  const busy = [];
  const bufMs = Math.max(0, Number(bufferMin) || 0) * 60000;
  const pid = Number(providerId);

  for (const b of firmBlocks) {
    const start = localStrToMs(b.block_start, zone);
    const end   = localStrToMs(b.block_end, zone);
    if (start != null && end != null && end > start) busy.push({ start, end });
  }

  for (const e of events) {
    if (Number(e.event_all_day) === 1) continue;
    if (e.event_status !== 'Scheduled') continue;
    if (e.event_with != null && Number(e.event_with) !== pid) continue;
    if (e.event_time == null || e.event_time === '') continue; // invariant violation — skip
    const start = localStrToMs(`${String(e.event_date).slice(0, 10)} ${e.event_time}`, zone);
    if (start == null) continue;
    const lenMin = Number(e.event_length) > 0 ? Number(e.event_length) : DEFAULT_EVENT_LENGTH_MIN;
    busy.push({ start, end: start + lenMin * 60000 });
  }

  for (const b of abBlocks) {
    if (Number(b.user) !== pid) continue;
    const start = localStrToMs(b.block_start, zone);
    const end   = localStrToMs(b.block_end, zone);
    if (start != null && end != null && end > start) busy.push({ start, end });
  }

  for (const a of appts) {
    if (a.appt_status !== undefined && a.appt_status !== 'Scheduled') continue;
    if (Number(a.appt_with) !== pid) continue;
    const start = localStrToMs(a.appt_date, zone);
    if (start == null) continue;
    const lenMin = Number(a.appt_length) > 0 ? Number(a.appt_length) : DEFAULT_APPT_LENGTH_MIN;
    busy.push({ start: start - bufMs, end: start + lenMin * 60000 + bufMs });
  }

  for (const g of gcalBusy) {
    if (g && g.end > g.start) busy.push({ start: g.start, end: g.end });
  }

  return unionIntervals(busy);
}

/**
 * Compute one provider's slots for one civil day from plain data.
 *
 * @param {object} o
 * @param {string} o.dayStr            — 'YYYY-MM-DD' firm-local civil date
 * @param {object[]} o.workingRows     — this provider's user_availability rows
 *                                       (any weekday; filtered here):
 *                                       { weekday, start_time, end_time,
 *                                         valid_from|null, valid_to|null }
 * @param {{start:number,end:number}[]} o.busy — normalized busy intervals
 * @param {number} o.lengthMin
 * @param {number} o.granularityMin
 * @param {number} [o.earliestStartMs=-Infinity]
 * @param {string} [o.zone=FIRM_TZ]
 * @param {?object[]} [o.restrictRows=null] — optional per-view weekly window
 *        restriction (booking_views.page_windows shape):
 *        [{ weekday:0–6, start?:'HH:mm', end?:'HH:mm',
 *           valid_from?:'YYYY-MM-DD', valid_to?:'YYYY-MM-DD' }, …].
 *        null/undefined = no restriction (today's behavior). When non-null the
 *        day's working windows are INTERSECTED with the entries matching this
 *        weekday AND valid on this date (valid_from/valid_to inclusive), so it
 *        can only ever remove availability. A date with NO matching valid
 *        entry is closed for this view → []. An entry with no start/end =
 *        all-day.
 * @returns {string[]} 'yyyy-MM-dd HH:mm' starts for that day
 */
/**
 * Build a provider's working windows across [fromDay, toDay] (inclusive) as
 * epoch-ms intervals — the same weekday/valid_from/valid_to filtering
 * computeProviderDaySlots applies, hoisted here so freeBusy's all-day (c) rule
 * can test whether a busy block swallows a whole working day. Pure.
 *
 * @param {object[]} workingRows — provider's user_availability rows
 * @param {DateTime} fromDay     — firm-local start-of-day
 * @param {DateTime} toDay       — firm-local start-of-day (inclusive)
 * @param {string}   [zone=FIRM_TZ]
 * @returns {{start:number,end:number}[]} unmerged windows
 */
function _providerWorkingWindows(workingRows, fromDay, toDay, zone = FIRM_TZ) {
  const out = [];
  for (let d = fromDay; d <= toDay; d = d.plus({ days: 1 })) {
    const dayStr = d.toFormat('yyyy-MM-dd');
    const weekday = d.weekday % 7; // luxon 1=Mon…7=Sun → 0=Sun…6=Sat
    for (const r of workingRows || []) {
      if (Number(r.weekday) !== weekday) continue;
      if (r.active !== undefined && Number(r.active) !== 1) continue;
      const vf = r.valid_from ? String(r.valid_from).slice(0, 10) : null;
      const vt = r.valid_to   ? String(r.valid_to).slice(0, 10)   : null;
      if (vf && dayStr < vf) continue;
      if (vt && dayStr > vt) continue;
      const start = localStrToMs(`${dayStr} ${r.start_time}`, zone);
      const end   = localStrToMs(`${dayStr} ${r.end_time}`, zone);
      if (start == null || end == null || end <= start) continue;
      out.push({ start, end });
    }
  }
  return out;
}

function computeProviderDaySlots({
  dayStr, workingRows, busy, lengthMin, granularityMin,
  earliestStartMs = -Infinity, zone = FIRM_TZ, restrictRows = null,
}) {
  const day = DateTime.fromISO(dayStr, { zone });
  if (!day.isValid) return [];
  const weekday = day.weekday % 7; // luxon 1=Mon…7=Sun → 0=Sun…6=Sat

  let windows = [];
  for (const r of workingRows || []) {
    if (Number(r.weekday) !== weekday) continue;
    if (r.active !== undefined && Number(r.active) !== 1) continue;
    const vf = r.valid_from ? String(r.valid_from).slice(0, 10) : null;
    const vt = r.valid_to   ? String(r.valid_to).slice(0, 10)   : null;
    if (vf && dayStr < vf) continue;
    if (vt && dayStr > vt) continue;
    const start = localStrToMs(`${dayStr} ${r.start_time}`, zone);
    const end   = localStrToMs(`${dayStr} ${r.end_time}`, zone);
    if (start == null || end == null || end <= start) continue;
    windows.push({ start, end });
  }

  // ── Per-view weekly restriction (booking_views.page_windows) ──
  // Pure intersection with the entries matching THIS weekday. Can only remove
  // availability, never add. A restricted view with no entry for the weekday is
  // closed that day; a zeroed-out intersection falls through the same
  // windows.length===0 early-return below.
  if (restrictRows != null) {
    // Entry counts only if its weekday matches AND dayStr is inside its
    // optional valid_from/valid_to range (inclusive, 'YYYY-MM-DD' string
    // compare) — same gating the workingRows loop applies above. A restricted
    // view with no VALID entry for this date is closed that date (fail-closed,
    // consistent with "weekday not listed = closed"; the loadView fail-open
    // for malformed JSON is a different, upstream concern).
    const dayEntries = (restrictRows || []).filter(r => {
      if (Number(r.weekday) !== weekday) return false;
      const vf = r.valid_from ? String(r.valid_from).slice(0, 10) : null;
      const vt = r.valid_to   ? String(r.valid_to).slice(0, 10)   : null;
      if (vf && dayStr < vf) return false;
      if (vt && dayStr > vt) return false;
      return true;
    });
    if (dayEntries.length === 0) return []; // weekday not offered (or no window valid on this date)
    const restrictionIntervals = [];
    for (const r of dayEntries) {
      const hasTimes = r.start != null && r.start !== '' && r.end != null && r.end !== '';
      if (hasTimes) {
        const start = localStrToMs(`${dayStr} ${r.start}:00`, zone);
        const end   = localStrToMs(`${dayStr} ${r.end}:00`,   zone);
        if (start == null || end == null || end <= start) continue;
        restrictionIntervals.push({ start, end });
      } else {
        // All-day entry: whole civil day. End via Luxon day arithmetic
        // (next day's start-of-day) — NOT dayStart+24h, which breaks on DST.
        restrictionIntervals.push({
          start: day.startOf('day').toMillis(),
          end:   day.plus({ days: 1 }).startOf('day').toMillis(),
        });
      }
    }
    // intersectIntervals([], …) === [] so an empty working set stays empty.
    windows = intersectIntervals(windows, restrictionIntervals);
  }

  if (windows.length === 0) return []; // no availability rows for this weekday → no slots

  const free = subtractIntervals(windows, busy);
  return walkSlots(free, { lengthMin, granularityMin, earliestStartMs, zone });
}

// ─────────────────────────────────────────────────────────────
// GCal freeBusy — live read, short-cached, fail-open (phase 2)
// ─────────────────────────────────────────────────────────────
//
// During slot computation the engine reads each provider's designated Google
// calendars via the firm OAuth credential's freeBusy API and subtracts the
// returned busy intervals as one more source — alongside appts/events/blocks.
//
// Design constraints (binding):
//   - LIVE read, not synced. The provider's calendar changes intraday; a
//     precomputed mirror would reintroduce double-booking. So freeBusy is
//     called inside getSlots, wrapped in a short in-process cache (~90s) so a
//     burst of slot fetches collapses to one Google call.
//   - HARD timeout (~5s) + FAIL-OPEN. On timeout/error the engine proceeds
//     WITHOUT the freeBusy blocks (availability just misses the extra
//     blocking). fetchGcalBusy NEVER throws and NEVER hangs getSlots.
//   - CREDENTIAL-PARAMETERIZED. The "which credential reads freebusy" question
//     resolves through gcalService._resolveTarget — i.e. app_settings
//     'gcal_credential_id' with the gcalService hard-default fallback. No
//     hardcoded id here. A future per-provider gcal_credential_id slots in
//     with zero engine change (pass opts.credentialId).
//   - PURE BUSY-INTERVAL UNION, no source attribution. The same appt
//     legitimately appears on several of a provider's calendars AND in the
//     appts table; overlapping intervals union-merge harmlessly. We do NOT
//     dedupe freeBusy against appts — just union everything and subtract.
//   - ALL-DAY / FULL-DAY spans are DROPPED (see _isAllDaySpan). freeBusy
//     reports all-day events (e.g. court "Schedules Deadline") as a whole-day
//     busy block; honoring those would wrongly close the entire day to client
//     booking. Mirrors the slice-3 rule that all-day *events* never block.
//     Documented limitation: real closures (vacation) must be entered as
//     YisraCase availability_blocks, not Google all-day events.

const GCAL_FREEBUSY_URL   = 'https://www.googleapis.com/calendar/v3/freeBusy';
const FREEBUSY_TIMEOUT_MS = 5000;   // hard cap; fail-open on abort
const FREEBUSY_CACHE_MS   = 90000;  // ~90s in-process cache window
const ALLDAY_MS           = 24 * 60 * 60 * 1000;

// In-process cache: key → { at:epochMs, intervals:[{start,end}] }. Keyed on
// provider + sorted calendar-id set + from + to. A short TTL bounds staleness;
// fail-open results are NOT cached (so a transient outage self-heals on the
// next fetch rather than sticking an empty result for 90s).
const _freeBusyCache = new Map();

function _freeBusyCacheKey(providerId, calendarIds, fromMs, toMs) {
  const cals = [...calendarIds].map(String).sort().join(',');
  return `${providerId}|${cals}|${fromMs}|${toMs}`;
}

/**
 * Parse a provider's freebusy_calendar_ids column value into a clean string[].
 * mysql2 returns a native json column already-parsed; tolerate a string too
 * (defensive — e.g. if the column is ever varchar/text). NULL/empty → [].
 *
 * @param {*} raw — users.freebusy_calendar_ids
 * @returns {string[]}
 */
function parseFreebusyCalendarIds(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try { arr = JSON.parse(t); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x).trim()).filter(Boolean);
}

/**
 * Decide whether a busy interval [startMs, endMs) is an all-day / full-day
 * span that must be DROPPED (never blocks client booking).
 *
 * Drop when ANY of:
 *   (a) duration ≥ 24h, OR
 *   (b) it is a date-aligned span: both ends land exactly on firm-local
 *       midnight (00:00:00.000) — i.e. a date-only all-day event, even on a
 *       23h DST-spring day where (a) wouldn't trigger, OR
 *   (c) it fully covers one of the provider's working windows in range (a
 *       timed block long enough to swallow a whole working day — defensive;
 *       real all-day events are already caught by (a)/(b)).
 *
 * A TIMED block of any duration < 24h that is NOT midnight-aligned and does
 * NOT swallow a working window is HONORED (kept), per spec — multi-hour and
 * even partial-day blocks carve availability.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} zone
 * @param {{start:number,end:number}[]} [workingUnion] provider working windows
 * @returns {boolean} true → drop
 */
function _isAllDaySpan(startMs, endMs, zone, workingUnion) {
  if (endMs - startMs >= ALLDAY_MS) return true;                 // (a)
  const s = DateTime.fromMillis(startMs, { zone });
  const e = DateTime.fromMillis(endMs,   { zone });
  const atMidnight = (d) => d.hour === 0 && d.minute === 0 && d.second === 0 && d.millisecond === 0;
  if (atMidnight(s) && atMidnight(e)) return true;               // (b)
  if (workingUnion && workingUnion.length) {                     // (c)
    for (const w of workingUnion) {
      if (startMs <= w.start && endMs >= w.end) return true;
    }
  }
  return false;
}

/**
 * Pure parse of a Google freeBusy response body into kept busy intervals
 * (epoch ms, firm-local). All-day/full-day spans are dropped; per-calendar
 * `errors` entries are collected and that calendar skipped (the rest of the
 * batch still parses). Exported for offline testing.
 *
 * Google returns busy start/end as RFC3339 with an explicit offset (usually
 * Z). We parse with setZone:true to honor that offset, then take epoch ms —
 * the engine's interval representation. Firm-local conversion only matters for
 * the all-day midnight test, which _isAllDaySpan does against `zone`.
 *
 * @param {object} body — parsed freeBusy JSON
 * @param {string} zone
 * @param {{start:number,end:number}[]} [workingUnion]
 * @returns {{intervals:{start:number,end:number}[], dropped:object[], calErrors:object[]}}
 */
function parseFreeBusyResponse(body, zone, workingUnion) {
  const intervals = [];
  const dropped = [];
  const calErrors = [];
  const cals = (body && body.calendars) || {};
  for (const [cid, v] of Object.entries(cals)) {
    if (v && Array.isArray(v.errors) && v.errors.length) {
      calErrors.push({ calendarId: cid, errors: v.errors });
      continue; // lost access etc. — skip this calendar, keep the batch
    }
    for (const iv of (v && v.busy) || []) {
      const s = DateTime.fromISO(iv.start, { setZone: true });
      const e = DateTime.fromISO(iv.end,   { setZone: true });
      if (!s.isValid || !e.isValid) continue;
      const startMs = s.toMillis();
      const endMs   = e.toMillis();
      if (endMs <= startMs) continue;
      if (_isAllDaySpan(startMs, endMs, zone, workingUnion)) {
        dropped.push({ calendarId: cid, start: iv.start, end: iv.end });
        continue;
      }
      intervals.push({ start: startMs, end: endMs });
    }
  }
  return { intervals: unionIntervals(intervals), dropped, calErrors };
}

/**
 * Fire a fail-open alert about a freeBusy outage. Never throws (wrapped).
 */
function _alertFreeBusyFailure(db, providerId, detail) {
  try {
    // Lazy require — circular-dep safety convention (matches gcalService/oauthService).
    const { alert } = require('../lib/alerting');
    alert(db, {
      source: 'scheduler',
      kind: 'gcal_freebusy_failed',
      group_key: `gcal_freebusy_failed:${providerId}`,
      severity: 'warning', // rides the digest; not a per-slot critical email storm
      title: `GCal freeBusy read failed for provider ${providerId}`,
      message: detail,
      context: { providerId },
    }).catch(() => {});
  } catch (_) { /* alerting unavailable — swallow, fail-open is the priority */ }
}

/**
 * Google Calendar freeBusy lookup for one provider over [fromMs, toMs).
 *
 * ONE batched POST covering all the provider's calendars. Returns kept busy
 * intervals as { start, end } epoch ms (all-day spans dropped). Short-cached.
 * FAIL-OPEN: any timeout/error → alert (fire-and-forget) + return []. Never
 * throws; never hangs longer than FREEBUSY_TIMEOUT_MS.
 *
 * @param {object} db — mysql2 pool
 * @param {object} o
 * @param {number}   o.providerId
 * @param {string[]} o.calendarIds   — this provider's freebusy_calendar_ids
 * @param {number}   o.from          — range start, epoch ms (firm-local day 00:00)
 * @param {number}   o.to            — range end, epoch ms (exclusive)
 * @param {number}  [o.credentialId] — override; default resolves via gcalService
 * @param {{start:number,end:number}[]} [o.workingUnion] — for the all-day (c) rule
 * @param {string}  [o.zone=FIRM_TZ]
 * @returns {Promise<{start:number,end:number}[]>}
 */
async function fetchGcalBusy(db, {
  providerId, calendarIds, from, to, credentialId, workingUnion, zone = FIRM_TZ,
} = {}) {
  // Normalize + dedupe: the freeBusy batch must never list a calendar twice
  // (a provider whose user_gcal_id is also in their explicit list → one item).
  const cals = [...new Set(
    (calendarIds || []).map(String).map(s => s.trim()).filter(Boolean)
  )];
  if (!cals.length) return []; // feature off for this provider — no call

  const cacheKey = _freeBusyCacheKey(providerId, cals, from, to);
  const cached = _freeBusyCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < FREEBUSY_CACHE_MS) {
    return cached.intervals;
  }

  // Resolve the firm credential id through gcalService's indirection
  // (params → app_settings 'gcal_credential_id' → hard default). calendarId is
  // irrelevant to freeBusy (we pass items[] ourselves) but _resolveTarget
  // returns it harmlessly.
  let credId = credentialId;
  if (credId == null) {
    try {
      ({ credentialId: credId } = await gcalService._resolveTarget(db, {}));
    } catch (err) {
      _alertFreeBusyFailure(db, providerId, `credential resolve failed: ${err.message}`);
      return [];
    }
  }

  let headers;
  try {
    headers = await buildHeadersForCredential(db, credId, GCAL_FREEBUSY_URL);
  } catch (err) {
    _alertFreeBusyFailure(db, providerId, `auth header build failed (cred ${credId}): ${err.message}`);
    return [];
  }
  if (!headers || !headers.Authorization) {
    // Not connected, or URL out of allowed_urls scope (needs googleapis host).
    _alertFreeBusyFailure(db, providerId,
      `no Authorization for credential ${credId} — not connected, or freeBusy URL out of allowed_urls scope`);
    return [];
  }

  const timeMin = DateTime.fromMillis(from, { zone }).toISO();
  const timeMax = DateTime.fromMillis(to,   { zone }).toISO();
  const reqBody = { timeMin, timeMax, items: cals.map(id => ({ id })) };

  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), FREEBUSY_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(GCAL_FREEBUSY_URL, {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    _alertFreeBusyFailure(db, providerId,
      err.name === 'AbortError'
        ? `freeBusy timed out after ${FREEBUSY_TIMEOUT_MS}ms`
        : `freeBusy request failed: ${err.message}`);
    return []; // fail-open
  } finally {
    clearTimeout(tHandle);
  }

  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON */ } }

  if (!res.ok) {
    const gErr = parsed && parsed.error;
    const detail = gErr ? (gErr.message || JSON.stringify(gErr)) : (text ? text.slice(0, 300) : '(empty)');
    _alertFreeBusyFailure(db, providerId, `freeBusy ${res.status}: ${detail}`);
    return []; // fail-open
  }

  const { intervals, dropped, calErrors } = parseFreeBusyResponse(parsed, zone, workingUnion);
  if (calErrors.length) {
    // Partial failure — some calendars lost access. Warn but keep the rest.
    _alertFreeBusyFailure(db, providerId,
      `freeBusy partial: ${calErrors.map(c => `${c.calendarId}(${(c.errors[0]||{}).reason || '?'})`).join(', ')}`);
  }
  void dropped; // (kept for clarity / future debug logging)

  _freeBusyCache.set(cacheKey, { at: Date.now(), intervals });
  return intervals;
}

// ─────────────────────────────────────────────────────────────
// The engine — fetch shell
// ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compute open slot starts per provider over [from, to] (inclusive
 * firm-local civil dates).
 *
 * Provider-selection modes (fixed_one / client_choice / any_auto union +
 * least-loaded pick) are caller concerns — this function just returns the
 * per-provider slot lists.
 *
 * One query per source for the whole range × all providers; grouping and
 * composition in JS.
 *
 * @param {object} db — mysql2 pool
 * @param {object} opts
 * @param {number[]} opts.providerIds      — users.user values
 * @param {number}   opts.appt_length      — minutes, required
 * @param {number}  [opts.buffer_min=0]    — pads appt busy intervals only
 * @param {string}   opts.from             — 'YYYY-MM-DD' firm-local, inclusive
 * @param {string}   opts.to               — 'YYYY-MM-DD' firm-local, inclusive
 * @param {number}  [opts.granularity=15]  — slot grid minutes
 * @param {number}  [opts.min_notice_min=0]
 * @param {DateTime|Date|string} [opts.now] — injectable clock for tests;
 *                                            default DateTime.now() in FIRM_TZ
 * @param {?object[]} [opts.restrict_windows] — optional per-view weekly window
 *        restriction (booking_views.page_windows shape). null/undefined = no
 *        restriction. Threaded verbatim into computeProviderDaySlots; see there.
 *        Only ever narrows availability (pure intersection).
 * @returns {Promise<Object<string, string[]>>}
 *          { [providerId]: ['YYYY-MM-DD HH:mm', …] } sorted ascending
 */
async function getSlots(db, {
  providerIds,
  appt_length,
  buffer_min = 0,
  from, to,
  granularity = 15,
  min_notice_min = 0,
  now = undefined,
  restrict_windows = undefined,
} = {}) {
  // ── Validation ──
  if (!Array.isArray(providerIds) || providerIds.length === 0) {
    throw new Error('getSlots: providerIds must be a non-empty array');
  }
  const pids = providerIds.map(Number);
  if (pids.some(p => !Number.isInteger(p))) {
    throw new Error('getSlots: providerIds must be integers');
  }
  const lengthMin = Number(appt_length);
  if (!Number.isFinite(lengthMin) || lengthMin <= 0) {
    throw new Error('getSlots: appt_length must be a positive number of minutes');
  }
  const granularityMin = Number(granularity);
  if (!Number.isFinite(granularityMin) || granularityMin <= 0) {
    throw new Error('getSlots: granularity must be a positive number of minutes');
  }
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) {
    throw new Error('getSlots: from/to must be YYYY-MM-DD');
  }
  if (String(to) < String(from)) {
    throw new Error('getSlots: to must be >= from');
  }
  // Light validation only — deep per-entry shape validation lives at the write
  // boundary (api.bookingViews) and the read boundary (booking.js loadView,
  // fail-open). null/undefined = unrestricted; an array threads through as-is.
  if (restrict_windows != null && !Array.isArray(restrict_windows)) {
    throw new Error('getSlots: restrict_windows must be an array when provided');
  }

  const zone = FIRM_TZ;
  const fromDay = DateTime.fromISO(from, { zone }).startOf('day');
  const toDay   = DateTime.fromISO(to,   { zone }).startOf('day');
  if (!fromDay.isValid || !toDay.isValid) {
    throw new Error('getSlots: invalid from/to date');
  }

  // ── Earliest permissible start = max(from 00:00, now + min_notice) ──
  let nowDt;
  if (now === undefined || now === null) {
    nowDt = DateTime.now().setZone(zone);
  } else if (DateTime.isDateTime(now)) {
    nowDt = now.setZone(zone);
  } else if (now instanceof Date) {
    nowDt = DateTime.fromJSDate(now).setZone(zone);
  } else {
    nowDt = DateTime.fromISO(String(now).replace(' ', 'T'), { zone });
    if (!nowDt.isValid) throw new Error('getSlots: invalid now');
  }
  const noticeMin = Math.max(0, Number(min_notice_min) || 0);
  const earliestStartMs = Math.max(
    fromDay.toMillis(),
    nowDt.toMillis() + noticeMin * 60000
  );

  // ── Range bounds as firm-local strings (all five tables are firm-local,
  //    so plain string comparison in SQL is correct) ──
  const rangeStartStr = `${from} 00:00:00`;
  const rangeEndStr   = toDay.plus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm:ss');
  // Look back one civil day for point-start sources (events ≤ ~24h,
  // appts ≤ 127 min + buffer) that began before `from` but overlap into it.
  const lookbackStr   = fromDay.minus({ days: 1 }).toFormat('yyyy-MM-dd');

  // ── One query per source for the whole range × all providers ──
  const [uaRows] = await db.query(
    `SELECT user, weekday,
            TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
            TIME_FORMAT(end_time,   '%H:%i:%s') AS end_time,
            DATE_FORMAT(valid_from, '%Y-%m-%d') AS valid_from,
            DATE_FORMAT(valid_to,   '%Y-%m-%d') AS valid_to
       FROM user_availability
      WHERE active = 1 AND user IN (?)`,
    [pids]
  );

  // Per-provider freebusy_calendar_ids (native json → mysql2 returns parsed).
  // One query for all providers; parsed per-provider in the compose loop.
  const [fbCalRows] = await db.query(
    `SELECT user, freebusy_calendar_ids, user_gcal_id FROM users WHERE user IN (?)`,
    [pids]
  );

  const [fbRows] = await db.query(
    `SELECT DATE_FORMAT(block_start, '%Y-%m-%d %H:%i:%s') AS block_start,
            DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i:%s') AS block_end
       FROM firm_blocks
      WHERE active = 1 AND block_end > ? AND block_start < ?`,
    [rangeStartStr, rangeEndStr]
  );

  const [evRows] = await db.query(
    `SELECT DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date,
            TIME_FORMAT(event_time, '%H:%i:%s') AS event_time,
            event_all_day, event_length, event_status, event_with
       FROM events
      WHERE event_all_day = 0
        AND event_status = 'Scheduled'
        AND (event_with IS NULL OR event_with IN (?))
        AND event_date BETWEEN ? AND ?`,
    [pids, lookbackStr, to]
  );

  const [abRows] = await db.query(
    `SELECT user,
            DATE_FORMAT(block_start, '%Y-%m-%d %H:%i:%s') AS block_start,
            DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i:%s') AS block_end
       FROM availability_blocks
      WHERE active = 1 AND user IN (?)
        AND block_end > ? AND block_start < ?`,
    [pids, rangeStartStr, rangeEndStr]
  );

  const [apRows] = await db.query(
    `SELECT appt_with,
            DATE_FORMAT(appt_date, '%Y-%m-%d %H:%i:%s') AS appt_date,
            appt_length, appt_status
       FROM appts
      WHERE appt_status = 'Scheduled'
        AND appt_with IN (?)
        AND appt_date > ? AND appt_date < ?`,
    [pids, `${lookbackStr} 00:00:00`, rangeEndStr]
  );

  // ── Compose per provider × day through the pure core ──
  const result = {};
  for (const pid of pids) {
    const workingRows = uaRows.filter(r => Number(r.user) === pid);

    // Provider's freebusy calendars (per-user JSON column). Read inside the
    // loop so getSlots' signature is unchanged — callers (slices 4/6/9/manage)
    // are unaffected. NULL/empty → no freeBusy reads for this provider.
    const fbRow = fbCalRows.find(r => Number(r.user) === pid) || {};
    const explicitCals = parseFreebusyCalendarIds(fbRow.freebusy_calendar_ids);

    // Auto-include the provider's OWN YisraCase write-target calendar
    // (users.user_gcal_id, slice 5). Native appts on it are already blocked via
    // the appts table, but a manually-added Google event lives only there and
    // would otherwise never block. Only the provider's own write-target — NOT
    // the shared main YisraCase calendar (auto-including a shared cal would
    // cross-block providers). Deduped against the explicit list below.
    const selfCal = (fbRow.user_gcal_id == null ? '' : String(fbRow.user_gcal_id)).trim();
    const fbCalendarIds = selfCal && !explicitCals.includes(selfCal)
      ? [...explicitCals, selfCal]
      : explicitCals;

    // Working-window union over the whole range — feeds the freeBusy all-day
    // (c) drop rule (a timed block that swallows a whole working day).
    // DELIBERATELY the BASE working windows, NOT narrowed by restrict_windows:
    // the (c) rule drops a Google block only when it covers a WHOLE working
    // window. If it tested against a narrowed window, a 2h GCal block spanning
    // a `Mon 14–16` restriction would look "all-day" and be dropped — which
    // would OPEN slots. The per-view restriction must only ever remove time, so
    // it is applied later (in computeProviderDaySlots), after busy subtraction.
    const workingUnion = unionIntervals(
      _providerWorkingWindows(workingRows, fromDay, toDay, zone)
    );

    // Live, short-cached, fail-open. One batched call per provider per range.
    const gcalBusy = await fetchGcalBusy(db, {
      providerId:   pid,
      calendarIds:  fbCalendarIds,
      from:         fromDay.toMillis(),
      to:           toDay.plus({ days: 1 }).toMillis(),
      workingUnion,
      zone,
    });
    const busy = normalizeBusyForProvider(pid, {
      firmBlocks: fbRows,
      events:     evRows,
      abBlocks:   abRows,
      appts:      apRows,
      gcalBusy,
      bufferMin:  buffer_min,
      zone,
    });

    const slots = [];
    for (let d = fromDay; d <= toDay; d = d.plus({ days: 1 })) {
      slots.push(...computeProviderDaySlots({
        dayStr: d.toFormat('yyyy-MM-dd'),
        workingRows, busy, lengthMin, granularityMin, earliestStartMs, zone,
        restrictRows: restrict_windows,
      }));
    }
    result[pid] = slots; // per-day output already ascending; days iterated ascending
  }
  return result;
}

module.exports = {
  getSlots,
  // pure core — exported for offline testing
  unionIntervals,
  subtractIntervals,
  intersectIntervals,
  walkSlots,
  computeProviderDaySlots,
  normalizeBusyForProvider,
  localStrToMs,
  snapUpToGrid,
  fetchGcalBusy,
  parseFreeBusyResponse,
  parseFreebusyCalendarIds,
  _isAllDaySpan,
  _providerWorkingWindows,
  DEFAULT_EVENT_LENGTH_MIN,
  DEFAULT_APPT_LENGTH_MIN,
};