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
 *   localStrToMs, fetchGcalBusy           — helpers / phase-2 stub
 */

const { DateTime } = require('luxon');
const { FIRM_TZ } = require('./timezoneService');

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
 * @returns {string[]} 'yyyy-MM-dd HH:mm' starts for that day
 */
function computeProviderDaySlots({
  dayStr, workingRows, busy, lengthMin, granularityMin,
  earliestStartMs = -Infinity, zone = FIRM_TZ,
}) {
  const day = DateTime.fromISO(dayStr, { zone });
  if (!day.isValid) return [];
  const weekday = day.weekday % 7; // luxon 1=Mon…7=Sun → 0=Sun…6=Sat

  const windows = [];
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
  if (windows.length === 0) return []; // no availability rows for this weekday → no slots

  const free = subtractIntervals(windows, busy);
  return walkSlots(free, { lengthMin, granularityMin, earliestStartMs, zone });
}

// ─────────────────────────────────────────────────────────────
// GCal freeBusy — phase 2 stub
// ─────────────────────────────────────────────────────────────

/**
 * Google Calendar freeBusy lookup for a provider over [fromMs, toMs).
 * // phase 2 — will call gcalService freeBusy per provider calendar and
 * // return busy intervals as { start, end } epoch ms. Until then, GCal
 * // adds no busy time beyond what appts/events already mirror.
 *
 * @returns {Promise<{start:number,end:number}[]>}
 */
async function fetchGcalBusy(/* db, providerId, fromMs, toMs */) {
  return [];
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
    const gcalBusy = await fetchGcalBusy(db, pid, fromDay.toMillis(),
                                         toDay.plus({ days: 1 }).toMillis()); // phase 2: []
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
  walkSlots,
  computeProviderDaySlots,
  normalizeBusyForProvider,
  localStrToMs,
  snapUpToGrid,
  fetchGcalBusy,
  DEFAULT_EVENT_LENGTH_MIN,
  DEFAULT_APPT_LENGTH_MIN,
};