# The Calendar tab

*Shell sidebar → Calendar. Unified Events U9 / U9b.*

## What it is

Every dated thing the firm has — appointments, hearings, deadlines,
conferences, and whatever else — in one place, in one vocabulary, in two
views:

- **List** — a filterable table over a date window, with a state badge and
  quick-action buttons on every row. The view for "what is the status of
  these items?"
- **Grid** — a real calendar: month, week, and day grids, colored by kind
  and provider, with blocked and free time shaded underneath. The view for
  "what does Tuesday look like?"

The **List | Grid** toggle sits at the left of the bar. The browser remembers
which view you used last and opens it next time (per browser, not per
account). Next to the toggle, **New Appointment** and **New Event** open the
same two creation dialogs used everywhere else, with contact/case/link
pickers; the view updates itself when the save lands.

Before this tab, the answer lived in two places with different type lists and
different status words: the **Appointments** tab reads `appts`, the **Events**
tab reads `events`. Both still exist, but the Calendar tab asks the question
once — the List reads `GET /api/calendar-range` →
`services/caseEventService.listRange`, the same read layer that answers a
case's timeline, so a row here says exactly what the same row says on the
case. Retiring the old pair is a later slice.

## Filters (List view)

In List mode the bar carries the full filter set. (In Grid mode these hide —
the grid has its own bar, below.)

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

The footer also carries **Print** and **Export** (List view only). Export
downloads the rows listed as a CSV — when the list is capped, the capped
rows, so narrow the window first if you need the rest.

## The list

**Upcoming first** by default: today and later in start-time order, then the past newest first. **All-day rows come first within their day.** **Order By** (List view) — or a click on a column header — sorts by When, Kind, What, Attached to, With or State instead; the When header steps through upcoming → oldest first → newest first. The sort runs over the rows listed.

- **What** — the item's label, with its `type_key` muted beside it. A row with
  no registry type reads *unmapped* rather than showing a blank; mint it in
  *YisraCase Config → Calendar Types*.
- **Attached to** — the case, contact or docket, as a link where there is
  something to open. A docket with no matching case yet is plain text and says
  so: it resolves by itself the moment that case is created.
- **State** — `live` plain, resolved green, cancelled grey, **missed red**,
  superseded struck through. Resolved and cancelled rows show *how* they ended
  (met / moot / held / cancelled), which is the distinction `event_status`
  alone cannot make. Rows closed before outcomes shipped carry no recorded
  one; the badge shows the derived answer (met for a completed deadline, held
  for anything else completed), indistinguishable from a recorded one.

Clicking a row opens that row's own form — the appointment dialog or the event
dialog, the same two the old tabs use.

## Quick actions

The last column holds the old tabs' row buttons, for the row's own kind
(icons only on a phone):

- **Appointments** — *Attended · No Show · Cancel · Reschedule*, exactly the
  Appointments tab's: every action except the one matching the current status,
  and the same *Status Correction* warning when the appointment is already
  attended or a no-show.
- **Events** — *Complete · Cancel* while the event is live. A deadline asks the
  same outcome questions as the event form (below); every other kind confirms
  and closes.

Cancelled and superseded rows, and events already resolved, have no buttons —
open the row to change them. The list updates itself after each action.

## Deadline outcomes

Completing or cancelling a **deadline** — from the event form or from the
list's quick actions — asks *how*:

- **Complete** → *Met* (default) or *Moot — it stopped applying*.
- **Cancel** → a *no longer applies (moot)* checkbox.

Every other kind completes silently, as before: a hearing you completed, you
held — there is nothing to ask.

*Missed* is not offered. It is what the nightly sweep writes for a deadline
whose date passed untouched, not something a person sitting on the form is
describing.

## The Grid

Choose **Grid** on the toggle (or press the Appointments tab's **Calendar**
button, which lands here) and the tab becomes a full-height calendar, fed by
`GET /api/calendar-feed`. The grid shows the **live** calendar only —
scheduled appointments and events; resolved, cancelled and superseded rows
are the List's department.

### Views

**Month**, **Week** and **Day** buttons sit in the calendar's own toolbar,
with **prev / next / today** arrows on the other side. On a phone there is a
fourth button, the week **agenda** (a readable list of the week), and the
first visit opens on it — a seven-column week at phone width is too narrow to
read or tap. A desktop's first visit opens on the Week grid. After that the
grid reopens on whatever view you used last, remembered per browser.

### Colors and the legend

- **Appointments** are colored by **provider** — each provider's swatch is in
  the provider bar.
- **Events** are colored by **kind**: hearings **violet**, deadlines **red**,
  conferences **teal**, everything else (and anything unmapped) **slate**.
  The kind chips carry these swatches, so the bar is also the legend.

Timed items render as blocks (an event with no length shows as an hour);
all-day items — court deadlines, most of all — render as banners at the top
of their day. Hovering an item shows who it is with; clicking it opens a
detail popover (below).

### The bar

- **Providers** — one checkbox per appointment-taking provider, each with its
  color swatch. Unticking a provider drops their appointments, their
  personal blocked time, and events scoped to them; firm-wide events stay on
  everyone's calendar. With exactly one provider ticked, a new appointment
  created from the grid preselects that provider.
- **Kind chips** — same vocabulary and same semantics as the List's.
  *Meetings* means appointments; the other four slice events by kind.
- **Blocked** (on by default) — grey background shading for blocked time:
  firm-wide blocks and each ticked provider's personal blocks.
- **Free** (off by default) — green background shading for the windows where
  an appointment could go. Computing it is heavy, so it only draws on views
  of 14 days or less; the bar says so when a month view skips it.

### Clicking an item

- An **appointment** opens a popover — type, time, client, provider — with
  **Open Appointment** (the full appointment form, where cancel and
  reschedule live) and **Open Contact**.
- An **event** opens a popover — type, time, what it is linked to, who it is
  with, location — with **Open Event** (the same event form the List opens)
  and, where the event is linked to something, **Open Case** / **Open
  Contact**. A docket-linked event offers Open Case only when a case with
  that docket exists.

### Clicking an empty slot

Clicking an empty slot asks whether to add a **New Appointment** or a **New
Event** there, prefilled with the clicked date — and, on a week or day grid,
the clicked time. The grid repaints itself when the save lands.

## Pagination

The List has none, deliberately. The page is capped at 1000 rows server-side,
and with a 92-day window that is reachable only by asking for a quarter of
everything at once. When the cap **is** hit the footer says so in amber rather
than truncating silently. Real pagination arrives when a real user hits the cap.

## Liveness

Both views subscribe to `event:*` and `appt:*` on the sync bus. Completing a
deadline, rescheduling an appointment, a court-pipeline write from another
browser tab — the badge moves and the grid repaints without a refresh. While
the tab (or the view) is hidden the change is remembered and applied when you
come back to it.

## Getting here from Appointments

The Appointments tab's **Calendar** button opens this tab in Grid mode. It
used to open the same calendar in a small popup window; that popup is retired
— the Grid is the one calendar.

## See also

- `manual/05-Subsystems/11-calendar-types.md` — the type registry behind
  `type_key` and `kind`
- `manual/01-YisraCase-overview/04-appointments.md` /
  `08-events.md` — what the two record kinds are and what saving one does
- `ref/UNIFIED_EVENTS_DESIGN_V0_5.md` — §3.1 the row shape, §3.7 state and
  resolution
