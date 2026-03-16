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

  return {
    date:        input.format('YYYY-MM-DDTHH:mm:ss'),
    isShabbos,
    isHoliday,
    holidayName: isHoliday ? holidayName : null,
    workday,
    workdayIn
  };
}

// ─────────────────────────────────────────────────────────────
// nextBusinessDay — forward scheduling
// ─────────────────────────────────────────────────────────────

/**
 * Find the next available business day at a target time of day,
 * optionally with a random jitter window.
 *
 * @param {Date|string|moment} fromDate — start searching from this point
 * @param {object} options
 *   timeOfDay        {string}  "HH:MM" in 24h — target time on the business day (default "09:00")
 *   randomizeMinutes {number}  ± minutes of random jitter around timeOfDay (default 0)
 *   maxDaysAhead     {number}  give up after this many days (default 30)
 *
 * @returns {Date} — the scheduled datetime
 * @throws  if no business day found within maxDaysAhead
 */
async function nextBusinessDay(fromDate, options = {}) {
  const {
    timeOfDay        = '09:00',
    randomizeMinutes = 0,
    maxDaysAhead     = 30,
  } = options;

  const from = moment.isMoment(fromDate) ? fromDate.clone() : moment(fromDate);

  // Fetch a wide range so we only call Hebcal once
  const rangeEnd  = from.clone().add(maxDaysAhead + 7, 'days');
  const events    = await fetchHebcalEvents(from.clone().subtract(1, 'day'), rangeEnd);
  const restricted = buildRestrictedSet(from.clone().subtract(1, 'day'), rangeEnd, events);

  const [targetHour, targetMin] = timeOfDay.split(':').map(Number);

  // Start from tomorrow (or today if from is before target time today)
  let candidate = from.clone().startOf('day');
  if (from.hour() >= targetHour && from.minute() >= targetMin) {
    candidate.add(1, 'day');
  }

  for (let i = 0; i < maxDaysAhead; i++) {
    const dateStr = candidate.format('YYYY-MM-DD');
    const dayOfWeek = candidate.day();

    // Skip Sunday (0) as non-business day — adjust if needed
    // Skip Saturday (always Shabbos)
    // Skip restricted (Yom Tov)
    if (dayOfWeek !== 0 && !isDayRestricted(dateStr, restricted)) {
      // Found a valid day — apply time + jitter
      const jitter = randomizeMinutes > 0
        ? Math.floor(Math.random() * (randomizeMinutes * 2 + 1)) - randomizeMinutes
        : 0;

      const result = candidate.clone()
        .set({ hour: targetHour, minute: targetMin, second: 0, millisecond: 0 })
        .add(jitter, 'minutes');

      return result.toDate();
    }

    candidate.add(1, 'day');
  }

  throw new Error(`No business day found within ${maxDaysAhead} days of ${from.format('YYYY-MM-DD')}`);
}

// ─────────────────────────────────────────────────────────────
// prevBusinessDay — backward scheduling (pre-appointment reminders)
// ─────────────────────────────────────────────────────────────

/**
 * Find the latest valid business-day slot that is at least `hoursBack`
 * hours before anchorDate (the appointment time).
 *
 * Walks the `attempts` array in order, returns the first candidate
 * that is:
 *   - On a business day (not restricted)
 *   - At least minHoursBefore hours before the anchor
 *   - In the past relative to now (i.e. not already missed — optional)
 *
 * If all attempts are blocked, returns null (caller decides: skip or fallback).
 *
 * @param {Date|string|moment} anchorDate — the appointment datetime
 * @param {object[]} attempts — ordered list of fallback rules:
 *   {
 *     hoursBack:        {number}  hours before anchorDate to target
 *     sameTimeAsAnchor: {boolean} use anchorDate's clock time instead of timeOfDay
 *     timeOfDay:        {string}  "HH:MM" — ignored if sameTimeAsAnchor
 *     randomizeMinutes: {number}  ± jitter
 *     minHoursBefore:   {number}  minimum hours before anchor (skip if too close)
 *   }
 * @param {object} defaults — fallback values for all attempts
 *   { minHoursBefore, maxDaysBack }
 *
 * @returns {{ scheduledAt: Date, attemptIndex: number } | null}
 */
async function prevBusinessDay(anchorDate, attempts = [], defaults = {}) {
  const {
    minHoursBefore = 2,
    maxDaysBack    = 14,
  } = defaults;

  if (!attempts.length) {
    throw new Error('prevBusinessDay requires at least one attempt rule');
  }

  const anchor = moment.isMoment(anchorDate) ? anchorDate.clone() : moment(anchorDate);
  const now    = moment();

  // Fetch a wide range once
  const rangeStart = anchor.clone().subtract(maxDaysBack + 7, 'days');
  const events     = await fetchHebcalEvents(rangeStart, anchor.clone().add(1, 'day'));
  const restricted  = buildRestrictedSet(rangeStart, anchor.clone().add(1, 'day'), events);

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

    // Calculate raw candidate time
    let candidate;
    if (sameTimeAsAnchor) {
      // Same clock time N calendar days before
      const daysBack = Math.ceil(hoursBack / 24);
      candidate = anchor.clone().subtract(daysBack, 'days');
    } else {
      // N hours before anchor, then snap to timeOfDay
      candidate = anchor.clone().subtract(hoursBack, 'hours');
      if (timeOfDay) {
        const [h, m] = timeOfDay.split(':').map(Number);
        candidate.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      }
    }

    // Apply jitter
    if (randomizeMinutes > 0) {
      const jitter = Math.floor(Math.random() * (randomizeMinutes * 2 + 1)) - randomizeMinutes;
      candidate.add(jitter, 'minutes');
    }

    // Too close to appointment?
    const hoursUntilAnchor = anchor.diff(candidate, 'hours', true);
    if (hoursUntilAnchor < effectiveMin) {
      console.log(`[calendar] Attempt ${ai + 1}: too close (${hoursUntilAnchor.toFixed(1)}h < ${effectiveMin}h min) — trying next`);
      continue;
    }

    // Already passed?
    if (candidate.isBefore(now)) {
      console.log(`[calendar] Attempt ${ai + 1}: already in the past — trying next`);
      continue;
    }

    // Is the candidate day restricted?
    const dayOfWeek = candidate.day();
    const dateStr   = candidate.format('YYYY-MM-DD');

    if (dayOfWeek === 0 || isDayRestricted(dateStr, restricted)) {
      // Walk backward to the nearest available business day
      let walkBack = candidate.clone().subtract(1, 'day');
      let found = false;
      for (let d = 0; d < maxDaysBack; d++) {
        const wStr  = walkBack.format('YYYY-MM-DD');
        const wDay  = walkBack.day();
        if (wDay !== 0 && !isDayRestricted(wStr, restricted)) {
          // Preserve the time from the original candidate
          walkBack.set({
            hour:        candidate.hour(),
            minute:      candidate.minute(),
            second:      0,
            millisecond: 0
          });

          // Re-check min hours before
          const hoursCheck = anchor.diff(walkBack, 'hours', true);
          if (hoursCheck < effectiveMin) {
            console.log(`[calendar] Attempt ${ai + 1} walked back: still too close — trying next attempt`);
            break;
          }

          if (walkBack.isBefore(now)) {
            console.log(`[calendar] Attempt ${ai + 1} walked back: in the past — trying next attempt`);
            break;
          }

          candidate = walkBack;
          found = true;
          break;
        }
        walkBack.subtract(1, 'day');
      }

      if (!found) continue;
    }

    console.log(`[calendar] Attempt ${ai + 1}: scheduled at ${candidate.format('YYYY-MM-DDTHH:mm:ss')}`);
    return { scheduledAt: candidate.toDate(), attemptIndex: ai };
  }

  // All attempts exhausted
  console.log('[calendar] All reminder attempts blocked or in the past — returning null');
  return null;
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  isWorkday,
  nextBusinessDay,
  prevBusinessDay,
  fetchHebcalEvents,
  buildRestrictedSet,
  isDayRestricted,
  // Constants exposed for reference
  START_HOUR,
  END_HOUR,
  YOM_TOV_HOLIDAYS,
};