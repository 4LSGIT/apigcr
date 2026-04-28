# 7 — Calendar Service

## For operators

The firm doesn't work on Shabbos or Yom Tov. The calendar service makes the automation system aware of that.

When a sequence step or scheduled job uses one of the **business-day-aware timing types** (`next_business_day`, `business_days`, `before_appt`), the service finds the next valid slot — skipping Shabbos (Friday 6pm – Saturday 10pm), the eleven strict Yom Tov holidays, and Sundays.

What the system does **not** do automatically: gate **recurring scheduled jobs** by Jewish calendar. A recurring cron `0 9 * * 1-5` will fire at 9am every weekday, including a Yom Tov that lands on a Tuesday. To make a recurring job skip Jewish holidays, do the gate check inside the job's action:

```js
const { workday } = await calendarService.isWorkday(new Date().toISOString());
if (!workday) return { skipped: 'non-workday' };
```

When you need to pick a real datetime — e.g. setting a follow-up for "next Tuesday morning" — and want to be sure it lands on a workday, you can hit the test endpoint `POST /nextBusinessDay` to see what the service would pick.

---

## Technical reference

### Module: `services/calendarService.js`

Exports three functions:

```js
isWorkday(dateIso)                              // → { isShabbos, isHoliday, holidayName, workday, workdayIn, nextDay }
nextBusinessDay(fromDate, options)              // → Date (UTC)
prevBusinessDay(fromDate, attempts, options)    // → { scheduledAt, attemptUsed }
```

### Restricted days

**Shabbos** — Friday 18:00 (firm-local) through Saturday 22:00 (firm-local). The 22:00 close-out is `START_HOUR=18` plus the four-hour buffer that gives the same end-of-Shabbos behavior across timezones.

**Yom Tov** — eleven strict holidays where work is restricted:
- Rosh Hashana (1 day)
- Yom Kippur (1 day)
- Sukkot I and II (first two days)
- Shmini Atzeret (1 day)
- Simchat Torah (1 day)
- Pesach I, II, VII, VIII (first two and last two days)
- Shavuot I and II (both days)

Each holiday window opens 18:00 local on the eve and closes 22:00 local on the day itself — same shape as Shabbos.

**Sunday** — treated as non-business by `nextBusinessDay()` regardless of religious calendar (the firm doesn't work Sundays).

### Holiday data source — Hebcal

The service fetches holiday dates from the [Hebcal API](https://www.hebcal.com). One call per `nextBusinessDay()` invocation, fetching the full window (`maxDaysAhead + 7`) so the lookup stays lightweight.

**Fail-open behavior.** If Hebcal is unreachable, the service schedules **without** holiday awareness rather than blocking. In practice this means a job might be scheduled on a Yom Tov in the rare case Hebcal is down at scheduling time — better than the alternative of every sequence step throwing 500.

### Timezone handling

`timeOfDay` is interpreted in the requested timezone (default: `FIRM_TIMEZONE` env, which is `America/Detroit`). The returned `Date` is real UTC, ready to insert into `scheduled_jobs.scheduled_time` directly.

### `isWorkday(dateIso)`

```js
const r = await calendarService.isWorkday('2026-04-03T10:00:00');
// {
//   date:        '2026-04-03T10:00:00',
//   isShabbos:   false,
//   isHoliday:   true,
//   holidayName: 'Pesach VIII',
//   workday:     false,
//   workdayIn:   720,         // minutes until next workday opens (0 if already in one)
//   nextDay:     '2026-04-06T08:00:00.000Z'
// }
```

Used by:
- `GET /isWorkday` (no auth — used by other internal systems)
- Manual gate checks inside recurring jobs (see operator section above)
- Sequence engine when computing `before_appt` slots

### `nextBusinessDay(fromDate, options)`

```js
const utc = await calendarService.nextBusinessDay(new Date(), {
  timeOfDay:        '13:00',     // HH:MM in 24h, in `timezone` (default firm TZ)
  randomizeMinutes: 30,           // ±30 min jitter on the chosen time
  maxDaysAhead:     30,           // give up after this many days
  timezone:         'America/Detroit'
});
// → 2026-03-18T13:22:00.000Z
```

**Algorithm:**
1. Snapshot today as a candidate. If the current time is past `timeOfDay`, advance to tomorrow.
2. Loop forward up to `maxDaysAhead` days, skipping Sundays, Saturdays (Shabbos), and Yom Tov-restricted days.
3. On a valid day, apply `timeOfDay` + `randomizeMinutes` jitter, return UTC.

If the loop exits without finding a valid day, throws.

### `prevBusinessDay(fromDate, attempts, options)`

Used by `before_appt` sequence timing. Walks an ordered list of "attempt rules" backward from a target appointment time. The first rule that produces a valid slot wins.

```js
// Attempt N hours before, with progressive fallbacks
const attempts = [
  { hoursBack: 24, sameTimeAsAnchor: false, timeOfDay: '10:00', randomizeMinutes: 30, minHoursBefore: 12 },
  { hoursBack: 48, sameTimeAsAnchor: false, timeOfDay: '10:00', randomizeMinutes: 30, minHoursBefore: 24 }
];
const result = await calendarService.prevBusinessDay(apptTime, attempts, {
  maxDaysBack: 14,
  timezone:    'America/Detroit'
});
// → { scheduledAt: Date (UTC), attemptUsed: 0 }
// or null if no attempt produced a valid slot
```

Each attempt rule:

| Field | Description |
|---|---|
| `hoursBack` | Initial offset before the anchor time |
| `sameTimeAsAnchor` | If true, use the anchor's time-of-day on the chosen business day |
| `timeOfDay` | If `sameTimeAsAnchor` is false, target this time-of-day |
| `randomizeMinutes` | ± jitter applied to the resulting time |
| `minHoursBefore` | Reject any slot less than N hours before the anchor — bounces to the next earlier business day |

`minHoursBefore` is the safeguard that prevents the engine from picking, say, "30 minutes before the appointment" when you asked for "24 hours before" but the 24-hour-prior moment is on a Saturday — it walks back further until it finds a Friday slot at least N hours out.

### Random jitter (`randomizeMinutes`)

Symmetric: an integer between `-N` and `+N` is added to the computed time. Distribution is uniform over `[-N, +N]` minutes inclusive. Capped at `1440` (24 hours).

Why: spread out a batch of enrollments that would otherwise all fire at exactly `09:00:00` on the same morning. If 20 contacts are enrolled in a no-show sequence in the same hour, all of them firing at 9:00am on Monday would burst the SMS provider; with `randomizeMinutes: 30` they spread across 8:30–9:30 instead.

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /isWorkday?date=ISO` | none | Check if a specific datetime is in business hours |
| `POST /nextBusinessDay` | jwt | Test the next-business-day picker against arbitrary input |
| `POST /prevBusinessDay` | jwt | Test the prev-business-day picker against arbitrary input |

All return JSON. The `isWorkday` route is unauth'd because it's used by other internal systems that don't have a JWT context.

### Where it's called from

- `sequenceEngine.calculateStepTime()` for `next_business_day`, `business_days`, `before_appt` timing types
- `apptService` (workday-aware reminder scheduling)
- The three test/inspect routes above
- Manually via the gate-check pattern inside recurring scheduled jobs

### Common pitfalls

1. **Recurring scheduled jobs do NOT auto-skip holidays.** The cron is dumb. Add a workday gate inside the action.
2. **Shabbos timing crosses midnight in firm TZ.** A datetime of "Saturday 9pm Detroit time" is still in the Shabbos window — the system correctly treats it as non-workday until 22:00.
3. **Yom Tov dates shift each year.** Hebcal handles this — but if you're testing locally with Hebcal blocked, the fail-open will let scheduling go through and you'll wonder why your no-show sequence fired during Pesach.
4. **`nextBusinessDay` is not idempotent under randomization.** Two calls with the same input but `randomizeMinutes > 0` return different times. Keep this in mind when comparing scheduled times.
