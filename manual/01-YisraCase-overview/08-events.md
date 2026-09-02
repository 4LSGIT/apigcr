# Events

An event is a dated obligation or milestone — a confirmation hearing, a document deadline, an internal due date. Events are distinct from the other two date-driven records in the system: an **appointment** is a meeting between a client and a staff member; a **task** is a to-do assigned to one person. An event is simply a fact on the timeline that the firm must not miss. Events go on the firm's Google Calendar, can carry an optional reminder, and are swept by a daily digest email so upcoming deadlines are never a surprise.

---

## What Belongs on an Event

Every event must have:

- **A title** — what the event is ("Confirmation Hearing — Smith", "Docs due to trustee")
- **A date** — when it happens or is due

Everything else is optional:

- **A type** — categorizes the event (see Event Types below)
- **A time and length** — for events that happen at a specific time, like a hearing at 10:00 AM. Events without a time are **all-day** entries, which is the right shape for deadlines.
- **A link to a case, a contact, or a case number** — most events belong to a case. Some belong to a contact. Internal events (a filing-system milestone, a license renewal) can be linked to nothing at all. The **Case #** option links by docket number alone — useful when a court email announces a deadline before the case exists in the system, or for an unfiled case. The deadline still goes on the calendar and into the digest, and the moment a case with that docket number exists, the event appears on its Events tab automatically.
- **A location** — courtroom, address, or "Telephone"
- **A URL** — a Zoom link, dial-in page, or docket link
- **A note** — free text

A few fields are managed by the system and should not be edited manually: the Google Calendar event ID and the calendar override. These are set automatically.

Unlike an appointment, an event links to **one** thing — a case, a contact, a case number, *or* nothing. It never has both a client and a case side.

---

## Event Types

The type list is configurable and currently includes values like:

- Confirmation Hearing
- Docs Deadline
- Deadline
- Court Date
- Hearing
- Internal

Choosing **Other** lets you type a one-off type. The blessed list lives in a settings row (`fe-event_types`, a JSON array in app settings) — an administrator can add or remove types there and the dropdown updates everywhere with no deployment.

---

## Event Status

| Status | Meaning |
|---|---|
| **Scheduled** | Upcoming; not yet resolved |
| **Completed** | The event happened / the obligation was met |
| **Canceled** | No longer happening |

Status changes are made from the event list with the **Complete** and **Cancel** buttons, which appear only on Scheduled events. Each change writes a log entry on the linked case or contact.

### Resolution (how it ended)

Every Completed or Canceled event also carries a **resolution** — the *outcome*, which the status alone cannot express. A canceled deadline might have been withdrawn, or it might have become moot because the case converted; both are "Canceled", and only the resolution tells them apart.

| Kind | Completed may be | Canceled may be |
|---|---|---|
| hearing / conference / other | `held` | `cancelled` |
| deadline | `met` · `missed` · `moot` | `cancelled` · `moot` |

You do not have to choose one. The **Complete** and **Cancel** buttons write the sensible default (a completed deadline is `met`, a completed hearing is `held`, a cancel is `cancelled`). The API and the automation functions accept an explicit `resolution` when the default is wrong — `PATCH /api/events/:id/complete { "resolution": "missed" }`, or `complete_event` with `resolution`. A value that does not fit the event's kind is rejected (`400`) and nothing is written. A Scheduled event never carries a resolution; reopening an event clears it.

The trigger engine sees the resolution as `data.resolution` on `calendar.resolved` / `calendar.cancelled` — filter that, not the status.

### Missed deadlines (the nightly sweep)

Ahead of the date rather than behind it: a type can carry **approaching reminders** (Case Config → Calendar Types → *Approaching reminders (days before)*, e.g. `7, 1`). Each configured day makes items of that type emit a `calendar.approaching` trigger event that many days out, and a trigger rule decides what the reminder does — a task, a client text, a staff email. Off by default on every type; see *manual/05-Subsystems/09-calendar-types.md* and *manual/03-YisraFlow/15-triggers.md*.

A deadline that is still Scheduled after its date has passed is marked `Completed` / `missed` by a nightly job (`sweep_calendar_missed`) — it emits `calendar.resolved` with `resolution: 'missed'`, writes a log row, and clears the reminder task, so a rule can chase it. The job only looks at deadlines dated **on or after** a floor date set in its parameters (`since`); older past-dated deadlines were never resolved by anyone and are left alone as *unknown*, not *missed*, until a human completes or cancels them. "Today" is the firm's local day — a deadline due today is not missed until tomorrow.

### Rescheduled events (supersession)

When a hearing is adjourned, the system does **not** edit the old event's date. It creates a new event and marks the old one as *superseded by* the new one (`superseded_by_event_id`). The old row keeps its status but is dead: it comes off Google Calendar, its reminder task is cleared, it stops blocking availability, it leaves the digest and the calendar feed, and the trigger engine fires `calendar.rescheduled` for it (`extra.via = 'supersede'`, `extra.superseded_by` = the new event). The chain — first setting, every adjournment, current date — is preserved as data.

Superseded rows are hidden from event lists by default. The case and contact Events tabs (which show every status) still show the 31 historical duplicate rows the July 2026 cleanup marked, because those are Canceled and always were; what the lists hide is a superseded row that would otherwise *look* live. `GET /api/events?include_superseded=1` shows everything.

**Singleton types.** Some item types can only have one live occurrence per case at a time — a confirmation hearing, a 341 meeting, the standard bankruptcy deadlines. For those, creating a new event automatically supersedes the previous live one on the same case (the two can be linked by case id or by docket; both count as the same case). This is the registry's `singleton` flag and it is switched on with the `unified_singleton_enabled` setting (`1` = on; write `0`, not blank, to turn it off). While it is off, creating a second confirmation hearing on a case simply creates a second event, as before.

#### If a supersession is wrong

An administrator can undo the pointer from the database console:

```sql
UPDATE events
   SET superseded_by_event_id = NULL, supersede_reason = NULL,
       event_updated_at = event_updated_at
 WHERE event_id = <the old event>;
```

That restores the old event as live. It does **not** restore what the supersession tore down: the Google Calendar entry and any reminder task must be recreated by hand (edit the event and save with its calendar id re-asserted, or re-add the reminder). The new event is untouched — cancel it separately if it should not exist.

---

## What Happens When You…

### Create an event
- The record is saved and a log entry is written on the linked case or contact
- A Google Calendar entry is created — a timed block for timed events, an all-day banner for deadlines
- If you set a reminder (see below), a task is created for the chosen staff member

### Edit an event
- If the date, time, title, location, or link changed, the old calendar entry is deleted and a fresh one is created — the calendar always matches the record
- The reminder can be changed or cleared
- A log entry records what changed

### Complete an event
- Status becomes Completed, with a resolution (`met` for a deadline, `held` otherwise, unless you say otherwise)
- The calendar entry is **left in place** — it really happened, and the calendar is the historical record
- Any open reminder task for the event is cleared

### Cancel an event
- Status becomes Canceled, with resolution `cancelled` (or `moot`, deadlines only, when asked)
- The calendar entry is **deleted**
- Any open reminder task for the event is cleared

---

## Reminders

When creating or editing an event you can attach one reminder: pick a staff member and a date. This creates a **task** assigned to that person, due on that date — so the reminder flows through everything the task system already does: the morning task digest, due-today emails, and SMS. The task shows up linked as "Event #N".

Completing or canceling the event automatically clears its reminder task.

For obligations that need more than one nudge, the automation engine can layer additional reminders — see Automation below.

---

## The Daily Events Digest

Every workday afternoon, the system emails a digest of **tomorrow's scheduled events** to the configured recipients. This is the safety net that makes sure no deadline arrives unannounced.

The digest is aware of the firm's calendar:

- It never sends on Shabbos or Yom Tov.
- On the last workday before a closure, the digest **extends its window across the closed days through the next workday**. Before a three-day Yom Tov/Shabbos stretch, for example, Thursday's digest covers Friday, Saturday, Sunday, *and* Monday — so nothing falls into the gap.

Recipients come from the `event_digest_recipients` setting (a list of staff user IDs). If that is not set, the digest falls back to the firm's default inbound address. If there are no events in the window, no email is sent.

---

## Where Events Appear

- **The Events tab** in the main interface — all events, filterable by type, status, date range, and text search, sortable by date. New events created here can be linked to a case, a contact, or left unlinked.
- **A case's Events tab** — every event linked to that case. New events created here are locked to the case.
- **A contact's Events tab** — every event linked to that contact, locked the same way.

Edit, Complete, and Cancel are available wherever the event is listed.

---

## Automation

Events are first-class citizens of the automation engine. Workflows and sequences can create, update, complete, and look up events through internal functions (`create_event`, `update_event`, `complete_event`, `lookup_event`, `get_events`, and the nightly `sweep_calendar_missed` / `emit_calendar_approaching`). This is the foundation for automations like:

- Creating a **docs deadline** event automatically when a 341 Meeting is scheduled, dated a set number of business days before it
- Creating a **confirmation hearing** event automatically from the court's email, using the explicit date in the email text

These automations run in the background; the events they create behave exactly like manually entered ones — calendar entry, digest coverage, reminders and all.