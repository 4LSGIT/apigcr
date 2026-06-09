// services/calendarService.js
//
// Business calendar service — Jewish holiday + Shabbos aware.
// Extracted from routes/cal.js and extended with forward/backward scheduling.
//
// Public API:
//   isWorkday(datetime)
//     → { workday, isShabbos, isHoliday, holidayName, workdayIn }
//
//   nextBusinessDay(fromDate, options)
//     → Date — next available business day at the target time
//     options: { timeOfDay, randomizeMinutes, maxDaysAhead }
//
//   prevBusinessDay(anchorDate, options)
//     → Date | null — latest business-day slot at or before anchorDate - hoursBack
//     options: { hoursBack, timeOfDay, sameTimeAsAnchor, randomizeMinutes, minHoursBefore, maxDaysBack }
//
// Internal helpers (exported for testing):
//   fetchHebcalEvents(startDate, endDate)
//   buildRestrictedSet(startDate, endDate, events)
//   isDayRestricted(dateStr, restrictedSet)

const moment = require('moment');
const { DateTime } = require('luxon');
const DEFAULT_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';
// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

// Shabbos/holiday transition window: Fri 6pm → Sat 10pm
const START_HOUR = 18; // 6 PM — Shabbos/Yom Tov begins (prev day evening)
const END_HOUR   = 22; // 10 PM — Shabbos/Yom Tov ends

const YOM_TOV_HOLIDAYS = [
  'Rosh Hashana',
  'Yom Kippur',
  'Sukkot I',
  'Sukkot II',
  'Shmini Atzeret',
  'Simchat Torah',
  'Pesach I',
  'Pesach II',
  'Pesach VII',
  'Pesach VIII',
  'Shavuot I',
  'Shavuot II'
];

const HEBCAL_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────
// Hebcal API
// ─────────────────────────────────────────────────────────────

/**
 * Fetch Jewish holiday events from Hebcal for a date range.
 * Returns [] on network failure (fail open — don't block scheduling).
 */
async function fetchHebcalEvents(startDate, endDate) {
  const start = moment.isMoment(startDate) ? startDate : moment(startDate);
  const end   = moment.isMoment(endDate)   ? endDate   : moment(endDate);

  const url = `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on` +
              `&start=${start.format('YYYY-MM-DD')}&end=${end.format('YYYY-MM-DD')}`;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), HEBCAL_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);

    if (!response.ok) {
      console.error(`[calendar] Hebcal API returned ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.error('[calendar] Hebcal API error:', err.message);
    return []; // fail open — treat as no holidays, proceed with scheduling
  }
}

// ─────────────────────────────────────────────────────────────
// Restricted day set builder
// ─────────────────────────────────────────────────────────────

/**
 * Build a Set of 'YYYY-MM-DD' strings that are restricted
 * (Shabbos Saturdays + Yom Tov holidays).
 * Used for fast per-day lookups without re-querying Hebcal.
 */
function buildRestrictedSet(startDate, endDate, events) {
  const restricted = new Set();
  const start = moment.isMoment(startDate) ? startDate.clone() : moment(startDate);
  const end   = moment.isMoment(endDate)   ? endDate           : moment(endDate);

  for (let d = start.clone().startOf('day'); d.isSameOrBefore(end); d.add(1, 'day')) {
    const dateStr = d.format('YYYY-MM-DD');

    // Saturday is always restricted
    if (d.day() === 6) {
      restricted.add(dateStr);
      continue;
    }

    // Check Yom Tov
    for (const event of events) {
      if (
        event.date.startsWith(dateStr) &&
        event.category === 'holiday' &&
        !event.title.startsWith('Erev')
      ) {
        const isYomTov = YOM_TOV_HOLIDAYS.some(h =>
          h === 'Rosh Hashana'
            ? event.title.includes('Rosh Hashana')
            : event.title === h
        );
        if (isYomTov) {
          restricted.add(dateStr);
          break;
        }
      }
    }
  }

  return restricted;
}

/**
 * Check if a given day string is restricted,
 * accounting for the evening transition (Fri after 6pm = Shabbos).
 * Pass the candidate moment object for transition-window checks.
 */
function isDayRestricted(dateStr, restrictedSet) {
  return restrictedSet.has(dateStr);
}

/**
 * Time-aware restriction check for a scheduling candidate.
 *
 * A slot is restricted when EITHER:
 *   - its firm-tz civil date is in the restricted set (Saturday + Yom Tov), OR
 *   - it falls in an "erev" evening window — from START_HOUR (6 PM) onward on
 *     the day BEFORE a restricted date. This catches Friday evening (erev
 *     Shabbos) and erev Yom Tov, which the date-only `isDayRestricted` misses
 *     because Friday's (or erev-YT's) civil date is not itself in the set.
 *
 * Sunday is NOT restricted — the firm works Sundays (matches isWorkday).
 * Saturday is handled wholesale via the restricted set (all day off), so we
 * deliberately do not carve out a motzaei-Shabbos late-Saturday send window.
 *
 * @param {DateTime} dt          luxon DateTime already anchored in firm tz
 * @param {Set}      restricted  from buildRestrictedSet
 * @returns {boolean}
 */
function isSlotRestricted(dt, restricted) {
  const dateStr = dt.toFormat('yyyy-LL-dd');
  if (isDayRestricted(dateStr, restricted)) return true;

  // Erev Shabbos / erev Yom Tov: 6 PM onward, when the NEXT civil day is
  // restricted, the restriction has already begun.
  if (dt.hour >= START_HOUR) {
    const nextStr = dt.plus({ days: 1 }).toFormat('yyyy-LL-dd');
    if (isDayRestricted(nextStr, restricted)) return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// isWorkday — check a specific datetime
// ─────────────────────────────────────────────────────────────

/**
 * Check whether a given datetime falls within business hours
 * (not Shabbos, not Yom Tov).
 *
 * @param {string|Date|moment} datetime
 * @returns {{ workday, isShabbos, isHoliday, holidayName, workdayIn, date }}
 *   workdayIn: minutes until next workday opens (0 if already workday)
 */
async function isWorkday(datetime) {
  const input = moment.isMoment(datetime)
    ? datetime.clone()
    : moment(String(datetime).replace(' ', 'T'), moment.ISO_8601, true);

  if (!input.isValid()) {
    throw new Error(`Invalid datetime: "${datetime}"`);
  }

  // Shabbos window: Fri >= 6pm OR Sat < 10pm
  let isShabbos = false;
  if (input.day() === 5) {
    const shabbosStart = input.clone().set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (input.isSameOrAfter(shabbosStart)) isShabbos = true;
  } else if (input.day() === 6) {
    const shabbosEnd = input.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (input.isBefore(shabbosEnd)) isShabbos = true;
  }

  // Fetch events around the input date
  const rangeStart = input.clone().subtract(1, 'day').startOf('day');
  const rangeEnd   = input.clone().add(3,  'day').endOf('day');
  const events     = await fetchHebcalEvents(rangeStart, rangeEnd);

  // Build restricted set
  const restricted = buildRestrictedSet(rangeStart, rangeEnd, events);

  // Holiday window check (evening before → 10pm on the day)
  let isHoliday    = false;
  let holidayName  = null;

  if (!isShabbos) {
    for (const event of events) {
      if (event.category !== 'holiday' || event.title.startsWith('Erev')) continue;
      const isYomTov = YOM_TOV_HOLIDAYS.some(h =>
        h === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === h
      );
      if (!isYomTov) continue;

      const holidayStart = moment(event.date).subtract(1, 'day')
        .set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
      const holidayEnd   = moment(event.date)
        .set({ hour: END_HOUR,   minute: 0, second: 0, millisecond: 0 });

      if (input.isSameOrAfter(holidayStart) && input.isBefore(holidayEnd)) {
        isHoliday   = true;
        holidayName = event.title;
        break;
      }
    }
  }

  const workday = !isShabbos && !isHoliday;

  // Calculate workdayIn (minutes until next open)
  let workdayIn = 0;
  if (!workday) {
    // Find which restricted day's evening window we're in
    let coveringDay = null;
    for (let d = rangeStart.clone(); d.isSameOrBefore(rangeEnd); d.add(1, 'day')) {
      const dateStr     = d.format('YYYY-MM-DD');
      if (!restricted.has(dateStr)) continue;
      const periodStart = d.clone().subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
      const periodEnd   = d.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
      if (input.isSameOrAfter(periodStart) && input.isBefore(periodEnd)) {
        coveringDay = d.clone();
      }
    }

    if (coveringDay) {
      // Walk forward past any consecutive restricted days
      let lastRestricted = coveringDay.clone();
      while (restricted.has(lastRestricted.clone().add(1, 'day').format('YYYY-MM-DD'))) {
        lastRestricted.add(1, 'day');
      }
      const reopenTime = lastRestricted.clone()
        .set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
      workdayIn = input.isSameOrAfter(reopenTime) ? 0 : reopenTime.diff(input, 'minutes');
    }
  }
  // Calculate nextDay (minimal add-on)
  let nextDay = input.format('YYYY-MM-DDTHH:mm:ss');
  if (workdayIn !== 0) {
    let temp = input.clone().add(workdayIn, 'minutes');
    if (temp.hour() >= 9) {
      temp.add(1, 'day');
    }
    nextDay = temp.set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
      .format('YYYY-MM-DDTHH:mm:ss');
  }

  return {
    date:        input.format('YYYY-MM-DDTHH:mm:ss'),
    isShabbos,
    isHoliday,
    holidayName: isHoliday ? holidayName : null,
    workday,
    workdayIn,
    nextDay
  };
}

// ─────────────────────────────────────────────────────────────
// nextBusinessDay — forward scheduling
// ─────────────────────────────────────────────────────────────

/**
 * Find the next available business day at a target time of day,
 * optionally with a random jitter window.
 *
 * timeOfDay is interpreted in the given timezone (default: FIRM_TIMEZONE).
 * The returned Date is real UTC — ready for scheduled_jobs.
 *
 * @param {Date|string|moment} fromDate — start searching from this point
 * @param {object} options
 *   timeOfDay        {string}  "HH:MM" in 24h — in the specified timezone (default "09:00")
 *   randomizeMinutes {number}  ± minutes of random jitter around timeOfDay (default 0)
 *   maxDaysAhead     {number}  give up after this many days (default 30)
 *   timezone         {string}  IANA timezone for timeOfDay (default: FIRM_TIMEZONE env)
 *
 * @returns {Date} — the scheduled datetime in UTC
 * @throws  if no business day found within maxDaysAhead
 */
async function nextBusinessDay(fromDate, options = {}) {
  const {
    timeOfDay        = '09:00',
    randomizeMinutes = 0,
    maxDaysAhead     = 30,
    timezone         = DEFAULT_TZ,
  } = options;

  // Anchor everything in the firm timezone. "Have we passed today's target
  // time?", "what calendar day are we on?", and "is this day restricted?"
  // are all firm-local questions, not server-local. The previous moment-
  // based path mixed moment's local TZ (UTC on Cloud Run) with firm-TZ
  // target times, which (a) compared UTC hour to firm-TZ hour — wrong by
  // tzOffset hours — and (b) used a UTC-frame startOf('day') for the
  // restricted-day lookup, which worked by accident under Detroit's
  // negative offset but would silently misfire under other configurations.
  // See post-mortem (May 2026).
  let fromDt;
  if (DateTime.isDateTime(fromDate)) {
    fromDt = fromDate.setZone(timezone);
  } else if (moment.isMoment(fromDate)) {
    fromDt = DateTime.fromJSDate(fromDate.toDate(), { zone: timezone });
  } else if (fromDate instanceof Date) {
    fromDt = DateTime.fromJSDate(fromDate, { zone: timezone });
  } else {
    fromDt = DateTime.fromISO(String(fromDate), { zone: timezone });
  }

  // Build the moment-anchored range that fetchHebcalEvents and
  // buildRestrictedSet still consume. We feed them moments derived from
  // firm-tz YYYY-MM-DD strings so the dateStr keys they generate match
  // firm-local civil dates — which is the frame Hebcal returns events in
  // and the frame our candidate loop iterates in below.
  const rangeStartStr = fromDt.minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const rangeEndStr   = fromDt.plus({ days: maxDaysAhead + 7 }).toFormat('yyyy-LL-dd');
  const events     = await fetchHebcalEvents(moment(rangeStartStr), moment(rangeEndStr));
  const restricted = buildRestrictedSet(moment(rangeStartStr), moment(rangeEndStr), events);

  const [targetHour, targetMin] = timeOfDay.split(':').map(Number);

  // "today at target time" in firm tz. Compare to fromDt as instants.
  const todayTargetDt = fromDt.set({
    hour: targetHour, minute: targetMin, second: 0, millisecond: 0,
  });

  // Start the candidate at today's calendar day in firm tz. Advance to
  // tomorrow only if we're already past today's target moment. Comparing
  // DateTime objects (Luxon) compares instants regardless of zone — no
  // hour/minute field arithmetic.
  let candidateDt = fromDt.startOf('day');
  if (fromDt >= todayTargetDt) {
    candidateDt = candidateDt.plus({ days: 1 });
  }

  for (let i = 0; i < maxDaysAhead; i++) {
    // Build the candidate AT its target time first, so the restriction check
    // is time-aware: a Friday-evening (erev Shabbos) or erev-Yom-Tov slot is
    // rejected even though its civil date is not itself in the restricted
    // set. Sunday is a normal workday and is NOT skipped (matches isWorkday);
    // Saturday + Yom Tov are caught by isSlotRestricted via the restricted set.
    //
    // Jitter is applied via `.plus({ minutes: jitter })` (NOT by passing
    // `minute: targetMin + jitter` to fromObject). Luxon rejects out-of-range
    // field values — a negative or >59 minute makes the DateTime invalid,
    // which silently becomes `Invalid Date` downstream and explodes when
    // mysql2 tries to insert it as NULL into a NOT NULL
    // scheduled_jobs.scheduled_time column. See enrollment 61 / step 3
    // post-mortem (May 2026). The `.plus` path normalizes hour/day rollover
    // correctly. Near day boundaries this can push across a day; non-issue
    // for business-hours targets.
    const jitter = randomizeMinutes > 0
      ? Math.floor(Math.random() * (randomizeMinutes * 2 + 1)) - randomizeMinutes
      : 0;

    const localDt = candidateDt
      .set({ hour: targetHour, minute: targetMin, second: 0, millisecond: 0 })
      .plus({ minutes: jitter });

    if (!isSlotRestricted(localDt, restricted)) {
      return localDt.toUTC().toJSDate();
    }

    candidateDt = candidateDt.plus({ days: 1 });
  }

  throw new Error(`No business day found within ${maxDaysAhead} days of ${fromDt.toFormat('yyyy-LL-dd')}`);
}

// ─────────────────────────────────────────────────────────────
// prevBusinessDay — backward scheduling (pre-appointment reminders)
// ─────────────────────────────────────────────────────────────

/**
 * Find the latest valid business-day slot that is at least `hoursBack`
 * hours before anchorDate (the appointment time).
 *
 * timeOfDay in attempts is interpreted in the given timezone.
 * The returned scheduledAt Date is real UTC.
 *
 * @param {Date|string|moment} anchorDate — the appointment datetime
 * @param {object[]} attempts — ordered list of fallback rules
 * @param {object} defaults
 *   { minHoursBefore, maxDaysBack, timezone }
 *
 * @returns {{ scheduledAt: Date, attemptIndex: number } | null}
 */
async function prevBusinessDay(anchorDate, attempts = [], defaults = {}) {
  const {
    minHoursBefore = 2,
    maxDaysBack    = 14,
    timezone       = DEFAULT_TZ,
    notBefore      = null,   // floor: reject slots before this instant (default = now)
  } = defaults;

  if (!attempts.length) {
    throw new Error('prevBusinessDay requires at least one attempt rule');
  }

  // Anchor everything in firm tz via Luxon. Day-of-week, dateStr, and
  // target hour/minute are firm-local concerns; "is it in the past?"
  // and "is the gap to anchor large enough?" are instant comparisons
  // that work regardless of representation zone. Mirrors the
  // nextBusinessDay rewrite (same family of bugs — UTC-frame
  // .day()/.format() on moment when server TZ is UTC misidentified
  // restricted days when the candidate's UTC date and firm-TZ date
  // diverge late evening). Also fixes a latent DST bug in the walk-
  // back time-preserve branch, which previously preserved UTC hour
  // (causing the reminder to shift 1h across spring-forward / fall-
  // back boundaries) instead of firm-TZ hour.
  let anchorDt;
  if (DateTime.isDateTime(anchorDate)) {
    anchorDt = anchorDate.setZone(timezone);
  } else if (moment.isMoment(anchorDate)) {
    anchorDt = DateTime.fromJSDate(anchorDate.toDate(), { zone: timezone });
  } else if (anchorDate instanceof Date) {
    anchorDt = DateTime.fromJSDate(anchorDate, { zone: timezone });
  } else {
    anchorDt = DateTime.fromISO(String(anchorDate), { zone: timezone });
  }
  const nowDt = DateTime.now().setZone(timezone);
  // Past-rejection floor: a candidate before this instant is "behind us" and
  // rejected. Defaults to now. The sequence engine passes the prior scheduled
  // step's time (always <= now), so a same-offset conditional twin lands on
  // the same slot instead of being rejected as "past" the moment its sibling
  // fired. Short-notice bookings still skip out-of-runway offsets (the natural
  // slot is < the enrollment-time floor).
  const floorDt = notBefore
    ? DateTime.fromJSDate(notBefore instanceof Date ? notBefore : new Date(notBefore), { zone: timezone })
    : nowDt;

  // Feed buildRestrictedSet firm-tz YYYY-MM-DD strings so its keys live
  // in the same frame as our candidate iteration below.
  const rangeStartStr = anchorDt.minus({ days: maxDaysBack + 7 }).toFormat('yyyy-LL-dd');
  const rangeEndStr   = anchorDt.plus({ days: 1 }).toFormat('yyyy-LL-dd');
  const events     = await fetchHebcalEvents(moment(rangeStartStr), moment(rangeEndStr));
  const restricted = buildRestrictedSet(moment(rangeStartStr), moment(rangeEndStr), events);

  for (let ai = 0; ai < attempts.length; ai++) {
    const attempt = attempts[ai];
    const {
      hoursBack,
      sameTimeAsAnchor = false,
      timeOfDay,
      randomizeMinutes = 0,
      minHoursBefore:  attemptMin,
    } = attempt;

    const effectiveMin = attemptMin ?? minHoursBefore;
    if (hoursBack == null) continue;

    // ── Build raw candidate ──
    let candidateDt;
    if (sameTimeAsAnchor) {
      const daysBack = Math.ceil(hoursBack / 24);
      candidateDt = anchorDt.minus({ days: daysBack });
    } else {
      candidateDt = anchorDt.minus({ hours: hoursBack });
      if (timeOfDay) {
        const [h, m] = timeOfDay.split(':').map(Number);
        candidateDt = candidateDt.set({
          hour: h, minute: m, second: 0, millisecond: 0,
        });
      }
    }

    // ── Apply jitter via .plus (never field arithmetic — see jitter
    //    comment in nextBusinessDay for the Luxon-rejects-out-of-range
    //    rationale that crashed enrollment 61). ──
    if (randomizeMinutes > 0) {
      const jitter = Math.floor(Math.random() * (randomizeMinutes * 2 + 1)) - randomizeMinutes;
      candidateDt = candidateDt.plus({ minutes: jitter });
    }

    // ── Too close to anchor? ──
    // Checked on the raw candidate. Walking back over restricted days only
    // moves earlier (gap grows), so this never newly trips post-walk.
    const hoursUntilAnchor = anchorDt.diff(candidateDt, 'hours').hours;
    if (hoursUntilAnchor < effectiveMin) {
      console.log(`[calendar] Attempt ${ai + 1}: too close (${hoursUntilAnchor.toFixed(1)}h < ${effectiveMin}h min) — trying next`);
      continue;
    }

    // ── Walk back over restricted slots (Shabbos / Yom Tov and their eves) ──
    // Time-aware via isSlotRestricted: candidateDt carries its target
    // time-of-day, so a Friday-evening (erev Shabbos) or erev-Yom-Tov slot is
    // rejected even though its civil date is not itself in the restricted set
    // — this is the fix for reminders landing Friday night during Shabbos.
    // Sunday is a normal workday and is NOT skipped (matches isWorkday).
    // Each walked-back day re-applies the intended firm-tz wall-clock time so
    // the reminder lands at the same local time (DST-stable), via `.plus`
    // (NOT minute field-arithmetic, which crashes Luxon on out-of-range mins).
    let placed = !isSlotRestricted(candidateDt, restricted);

    if (!placed) {
      let walkBackDt = candidateDt;
      for (let d = 0; d < maxDaysBack; d++) {
        walkBackDt = walkBackDt.minus({ days: 1 });

        if (timeOfDay && !sameTimeAsAnchor) {
          const [h, m] = timeOfDay.split(':').map(Number);
          const jitter = randomizeMinutes > 0
            ? Math.floor(Math.random() * (randomizeMinutes * 2 + 1)) - randomizeMinutes
            : 0;
          walkBackDt = walkBackDt
            .set({ hour: h, minute: m, second: 0, millisecond: 0 })
            .plus({ minutes: jitter });
        } else {
          walkBackDt = walkBackDt.set({
            hour:        candidateDt.hour,
            minute:      candidateDt.minute,
            second:      0,
            millisecond: 0,
          });
        }

        if (isSlotRestricted(walkBackDt, restricted)) continue;

        // Valid slot — enforce gap + not-in-past on the walked-back slot.
        const hoursCheck = anchorDt.diff(walkBackDt, 'hours').hours;
        if (hoursCheck < effectiveMin) {
          console.log(`[calendar] Attempt ${ai + 1} walked back: still too close — trying next attempt`);
          break;
        }
        if (walkBackDt < floorDt) {
          console.log(`[calendar] Attempt ${ai + 1} walked back: in the past — trying next attempt`);
          break;
        }

        candidateDt = walkBackDt;
        placed = true;
        break;
      }
    } else {
      // Raw candidate is a valid slot. Too-close already passed above; still
      // enforce not-in-past (possible when the anchor itself is near-now).
      if (candidateDt < floorDt) {
        console.log(`[calendar] Attempt ${ai + 1}: already in the past — trying next`);
        continue;
      }
    }

    if (!placed) continue;   // restricted run exhausted maxDaysBack — next attempt

    console.log(`[calendar] Attempt ${ai + 1}: scheduled at ${candidateDt.toUTC().toISO()}`);
    return { scheduledAt: candidateDt.toUTC().toJSDate(), attemptIndex: ai };
  }

  console.log('[calendar] All reminder attempts blocked or in the past — returning null');
  return null;
}

// ─────────────────────────────────────────────────────────────
// nextFriendlyTime — daytime-safe offset
//
// Used by sequence enrollers that want to schedule a "soon-but-not-rude"
// fire time: now + N minutes, *unless* that lands Friday evening or the
// weekend, in which case roll forward to the next Monday at fallbackTime.
//
// Deliberately narrow scope — covers the welcome / intake-request slots
// of iss_intake. Other "schedule politely" rules (mid-week-late, cap-at-hour,
// skip-Saturdays-only) belong in sibling helpers if and when they're needed;
// trying to make one helper handle every variant proved to be a fool's
// errand in the design pass.
// ─────────────────────────────────────────────────────────────

/**
 * Compute a "friendly" send time = from + offsetMs, rolled forward to the
 * next Monday at `fallbackTime` (firm-local) if the raw result lands in
 * Friday-after-`friCutoffHour` or any weekend day.
 *
 * @param {Date|string} from
 * @param {number}      offsetMs
 * @param {object}      [opts]
 * @param {string}      [opts.timezone='America/Detroit']  — IANA tz
 * @param {number}      [opts.friCutoffHour=19]            — Friday >= this hour rolls
 * @param {string}      [opts.fallbackTime='09:00']        — H:MM, applied on the rolled day
 * @returns {Date}  JS Date in UTC; call .toISOString() for trigger_data
 */
/**
 * nextOpenTime — next "open" send time for an ENROLLMENT-anchored step
 * (e.g. the ISS welcome). Walks FORWARD from `from + delay` (contrast
 * prevBusinessDay, which walks backward from an appointment).
 *
 * Behavior:
 *   - base = from + delayMs, with ± jitterMin applied.
 *   - If base lands in a Shabbos/Yom Tov block (incl. the erev evening from
 *     START_HOUR before a restricted date), roll FORWARD to just after the
 *     block ends — the last contiguous restricted date at END_HOUR — plus a
 *     small FORWARD jitter, so it reads like an organic "saw this Saturday
 *     night" message rather than a havdalah-sharp blast.
 *   - Optional `dayWindow {start,end}` (hours): a result outside the window
 *     rolls to `rollTime` (else `start`:00); before-window → same day,
 *     at/after → next day. OFF by default (sends any hour that isn't blocked).
 *   - Optional `noSunday`: roll a Sunday result to Monday. OFF by default
 *     (Sunday is a workday for this firm).
 *
 * Async because it builds the Shabbos/YT set from Hebcal, like prevBusinessDay.
 *
 * @param {Date|string|number} from
 * @param {object} opts {delayMs, jitterMin, rollTime, dayWindow, noSunday, timezone}
 * @returns {Promise<Date>}
 */
async function nextOpenTime(from, opts = {}) {
  const {
    delayMs   = 0,
    jitterMin = 0,
    rollTime  = null,
    dayWindow = null,
    noSunday  = false,
    timezone  = DEFAULT_TZ,
  } = opts;

  const fromMs = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const jit = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  let base = DateTime.fromJSDate(new Date(fromMs + delayMs), { zone: timezone });
  if (jitterMin > 0) base = base.plus({ minutes: jit(-jitterMin, jitterMin) });

  // Restricted set over a forward window wide enough for any YT block + roll.
  const rangeStartStr = base.minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const rangeEndStr   = base.plus({ days: 16 }).toFormat('yyyy-LL-dd');
  const events     = await fetchHebcalEvents(moment(rangeStartStr), moment(rangeEndStr));
  const restricted = buildRestrictedSet(moment(rangeStartStr), moment(rangeEndStr), events);

  // Roll out of a Shabbos/YT block to just after it ends.
  if (isSlotRestricted(base, restricted)) {
    let cursor = base.startOf('day');
    // erev evening: base's own date is open, the block starts the next day
    if (!isDayRestricted(cursor.toFormat('yyyy-LL-dd'), restricted)) {
      cursor = cursor.plus({ days: 1 });
    }
    // walk to the last contiguous restricted date
    let guard = 0;
    while (guard < 16 && isDayRestricted(cursor.plus({ days: 1 }).toFormat('yyyy-LL-dd'), restricted)) {
      cursor = cursor.plus({ days: 1 });
      guard++;
    }
    base = cursor.set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (jitterMin > 0) base = base.plus({ minutes: jit(0, jitterMin) }); // forward only — never back into the block
  }

  // Optional sending-hours window.
  if (dayWindow && (base.hour < dayWindow.start || base.hour >= dayWindow.end)) {
    const [rh, rm] = (rollTime || `${String(dayWindow.start).padStart(2, '0')}:00`).split(':').map(Number);
    let target = base.hour >= dayWindow.end ? base.plus({ days: 1 }) : base;
    base = target.set({ hour: rh, minute: rm, second: 0, millisecond: 0 });
    let guard = 0;
    while (guard < 16 && isSlotRestricted(base, restricted)) {
      base = base.plus({ days: 1 }).set({ hour: rh, minute: rm, second: 0, millisecond: 0 });
      guard++;
    }
  }

  // Optional Sunday skip.
  if (noSunday && base.weekday === 7) {
    const [rh, rm] = (rollTime || '09:00').split(':').map(Number);
    let guard = 0;
    do {
      base = base.plus({ days: 1 }).set({ hour: rh, minute: rm, second: 0, millisecond: 0 });
      guard++;
    } while (guard < 16 && (base.weekday === 7 || isSlotRestricted(base, restricted)));
  }

  return base.toUTC().toJSDate();
}

function nextFriendlyTime(from, offsetMs, opts = {}) {
  const {
    timezone      = DEFAULT_TZ,
    friCutoffHour = 19,
    fallbackTime  = '09:00',
  } = opts;

  const startMs = (from instanceof Date ? from.getTime() : new Date(from).getTime()) + offsetMs;
  let target = DateTime.fromJSDate(new Date(startMs), { zone: timezone });

  // Luxon weekday: 1 = Mon ... 7 = Sun
  const isFriLate = target.weekday === 5 && target.hour >= friCutoffHour;
  const isWeekend = target.weekday === 6 || target.weekday === 7;

  if (isFriLate || isWeekend) {
    let next = target;
    do {
      next = next.plus({ days: 1 });
    } while (next.weekday !== 1); // roll to Monday

    const [h, m] = fallbackTime.split(':').map(Number);
    target = next.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  }

  return target.toJSDate();
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  isWorkday,
  nextBusinessDay,
  prevBusinessDay,
  nextOpenTime,
  fetchHebcalEvents,
  buildRestrictedSet,
  isDayRestricted,
  nextFriendlyTime,
  // Constants exposed for reference
  START_HOUR,
  END_HOUR,
  YOM_TOV_HOLIDAYS,
};