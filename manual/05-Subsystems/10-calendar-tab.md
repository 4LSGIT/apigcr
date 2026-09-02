# The Calendar tab

*Shell sidebar → Calendar. Unified Events U9.*

## What it is

One list of every dated thing the firm has, over a date window — appointments,
hearings, deadlines, conferences, and whatever else — in one vocabulary.

Until now that answer lived in two places. The **Appointments** tab reads
`appts`; the **Events** tab reads `events`. They have different type lists,
different status words, and different ideas of what a dead row is. Anyone asking
"what is happening next week?" had to look at both and merge them by eye.

The Calendar tab asks the question once. It reads
`GET /api/calendar-range` → `services/caseEventService.listRange`, the same read
layer that answers a case's timeline, so a row here says exactly what the same
row says on the case.

**All three tabs ship together this release.** Calendar sits between the two it
unifies so its answer can be checked against theirs on live data. Retiring the
old pair is a later slice.

## Filters

| Control | What it does |
|---|---|
| **Kind chips** | All · Meetings · Hearings · Deadlines · Conferences · Other. Multi-select. Deselecting the last named kind falls back to *All* rather than to an empty list. |
| **State** | Live (default) · Resolved · Cancelled · All |
| **+ superseded** | A checkbox *beside* the state select, not a value inside it. Ticking it **adds** the dead rows to whatever state is selected. |
| **With** | A provider. Firm-wide events (`event_with` NULL) match **every** provider — they block everyone's calendar, so they are on everyone's day. |
| **Date range** | Defaults to today → +30 days. Presets: Today / Week / 30d / 90d. |

The window is capped at **92 days**. Wider is a 400 — a firm-wide read with no
ceiling is a table scan waiting for the day somebody types 1970 into a date
input.

Filters refetch automatically (debounced). The footer names the active filters,
so an empty list always says *why* it is empty.

## The list

Sorted by start time, ascending; **all-day rows come first within their day**.

- **What** — the item's label, with its `type_key` muted beside it. A row with
  no registry type reads *unmapped* rather than showing a blank; mint it in
  *Case Config → Calendar Types*.
- **Attached to** — the case, contact or docket, as a link where there is
  something to open. A docket with no matching case yet is plain text and says
  so: it resolves by itself the moment that case is created.
- **State** — `live` plain, resolved green, cancelled grey, **missed red**,
  superseded struck through. Resolved and cancelled rows show *how* they ended
  (met / moot / held / cancelled), which is the distinction `event_status`
  alone cannot make.

Clicking a row opens that row's own form — the appointment dialog or the event
dialog, the same two the old tabs use.

## Pagination

There is none, deliberately. The page is capped at 1000 rows server-side, and
with a 92-day window that is reachable only by asking for a quarter of
everything at once. When the cap **is** hit the footer says so in amber rather
than truncating silently. Real pagination arrives when a real user hits the cap.

## Liveness

The tab subscribes to `event:*` and `appt:*` on the sync bus. Completing a
deadline, rescheduling an appointment, a court-pipeline write from another
browser tab — the badge moves without a refresh. While the tab is hidden the
change is remembered and applied when you come back to it.

## Deadline outcomes

Completing or cancelling a **deadline** from the event form asks *how*:

- **Complete** → *Met* (default) or *Moot — it stopped applying*.
- **Cancel** → a *no longer applies (moot)* checkbox.

Every other kind completes silently, as before: a hearing you completed, you
held — there is nothing to ask.

*Missed* is not offered. It is what the nightly sweep writes for a deadline
whose date passed untouched, not something a person sitting on the form is
describing.

Rows closed before this shipped carry no recorded outcome. They show the
derived answer, in italics, with a tooltip saying so.

## See also

- `manual/05-Subsystems/09-calendar-types.md` — the type registry behind
  `type_key` and `kind`
- `ref/UNIFIED_EVENTS_DESIGN_V0_5.md` — §3.1 the row shape, §3.7 state and
  resolution
