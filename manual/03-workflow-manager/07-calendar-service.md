# Part 7 — Calendar Service

The calendar service provides Jewish business calendar awareness — Shabbos and Yom Tov holiday detection — to sequence timing and the scheduling routes. All sequence steps that use `next_business_day`, `before_appt`, or `business_days` timing types go through this service.

---

## What Counts as a Restricted Day

**Shabbos:** Friday from 6:00 PM through Saturday until 10:00 PM.

**Yom Tov (strict holidays):**
Rosh Hashana, Yom Kippur, Sukkot I & II, Shmini Atzeret, Simchat Torah, Pesach I, II, VII & VIII, Shavuot I & II.

Each holiday starts the evening before at 6:00 PM and ends at 10:00 PM on the day itself (same transition window as Shabbos).

Holiday data comes from the [Hebcal API](https://www.hebcal.com). If Hebcal is unreachable, the service fails open — it schedules without holiday awareness rather than blocking.

**Sunday** is also treated as a non-business day in `nextBusinessDay()`.

---

## Routes

### `GET /isWorkday?date=YYYY-MM-DDTHH:mm:ss`

Check whether a specific datetime falls within business hours.

```js
await apiSend("/isWorkday?date=2026-04-03T10:00:00", "GET");
```

```json
{
  "date":        "2026-04-03T10:00:00",
  "isShabbos":   false,
  "isHoliday":   true,
  "holidayName": "Pesach VIII",
  "workday":     false,
  "workdayIn":   720,
  "version":     "6"
}
```

`workdayIn` — minutes until next workday opens (0 if already a workday).

No authentication required on this route (used by other internal systems).

---

### `POST /nextBusinessDay`

Find the next available business day at a target time, with optional random jitter.

**Body:**
| Field | Default | Description |
|-------|---------|-------------|
| `fromDate` | now | ISO datetime to search from |
| `timeOfDay` | `"09:00"` | Target time on the business day (HH:MM 24h) |
| `randomizeMinutes` | `0` | ± minutes of random jitter |
| `maxDaysAhead` | `30` | Give up after N days |

```js
await apiSend("/nextBusinessDay", "POST", {
  fromDate:         new Date().toISOString(),
  timeOfDay:        "13:00",
  randomizeMinutes: 30
});
// → { scheduledAt: "2026-03-18T13:22:00.000Z", input: { ... } }
```

Useful for testing sequence timing or scheduling a job at the next available business day.

---

### `POST /prevBusinessDay`

Find the best business-day slot before an appointment. Walks a priority-ordered `attempts` array and returns the first valid slot.

**Body:**
```json
{
  "anchorDate": "2026-04-07T14:00:00Z",
  "attempts": [
    { "hoursBack": 24, "sameTimeAsAnchor": true, "minHoursBefore": 4 },
    { "hoursBack": 48, "timeOfDay": "16:00" },
    { "hoursBack": 72, "timeOfDay": "10:00" }
  ],
  "defaults": { "minHoursBefore": 2, "maxDaysBack": 14 }
}
```

**Attempt fields:**
| Field | Description |
|-------|-------------|
| `hoursBack` | Hours before anchorDate to target |
| `sameTimeAsAnchor` | Use the anchor's clock time instead of `timeOfDay` |
| `timeOfDay` | HH:MM target time (ignored if `sameTimeAsAnchor`) |
| `randomizeMinutes` | ± jitter |
| `minHoursBefore` | Skip if slot is fewer than N hours before anchor |

**Response:**
```json
{
  "scheduledAt":      "2026-04-03T14:00:00.000Z",
  "attemptIndex":     0,
  "attemptUsed":      { "hoursBack": 24, "sameTimeAsAnchor": true },
  "actualHoursBefore": 48.0,
  "walkedBack":        true
}
```

`walkedBack: true` means the engine had to move the slot earlier than requested due to holidays.

If all attempts are blocked or in the past:
```json
{ "scheduledAt": null, "reason": "all_blocked", "message": "..." }
```

---

## Sequence Timing Types That Use the Calendar

### `next_business_day`
Calls `calendarService.nextBusinessDay()`. Skips Shabbos, Yom Tov, and Sunday.

```json
{
  "type":             "next_business_day",
  "timeOfDay":        "13:00",
  "randomizeMinutes": 30,
  "maxDaysAhead":     30
}
```

### `business_days`
Calls `nextBusinessDay()` N times, chaining forward.

```json
{
  "type":      "business_days",
  "value":     2,
  "timeOfDay": "10:00"
}
```

### `before_appt`
Calls `calendarService.prevBusinessDay()`. Walks backward from `trigger_data.appt_time` to find a valid business-day slot.

```json
{
  "type":             "before_appt",
  "hoursBack":        24,
  "timeOfDay":        "10:00",
  "randomizeMinutes": 0,
  "minHoursBefore":   4,
  "maxDaysBack":      14
}
```

Requires `trigger_data.appt_time` to be set at enrollment.

### `before_appt_fixed`
Simple subtraction — no holiday check. N hours before `trigger_data.appt_time`.

```json
{ "type": "before_appt_fixed", "hoursBack": 2 }
```

Use this for last-minute reminders (e.g. 2 hours before, 30 minutes before) where holiday awareness doesn't matter because the appointment is imminent.

---

## Holiday Passover Example

Appointment on Monday April 6, 2026. Passover runs from evening of April 1 through evening of April 3.

```js
// Attempt 24h before (same time) → Sunday April 5 → Sunday (non-business)
// Attempt 48h before at 4pm     → Saturday April 4 → Shabbos (restricted)
// Attempt 72h before at 4pm     → Friday April 3 → Passover VIII until 10pm (restricted)
// Walk back from Friday → Thursday April 2 → Passover VII (restricted)
// Walk back → Wednesday April 1 → Pesach starts at 6pm, before that is OK
// → scheduledAt: Wednesday April 1, walkedBack: true, actualHoursBefore: ~120
```

If even that walk-back lands in the past or too close: `{ scheduledAt: null, reason: "all_blocked" }`.
