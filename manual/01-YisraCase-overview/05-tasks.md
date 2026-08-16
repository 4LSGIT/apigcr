# Tasks

A task is an action item assigned to a staff member, linked to a contact, case, appointment, or bill. Tasks are how the firm tracks work that needs to be done: gathering documents, following up with a client, preparing a filing, reviewing materials.

---

## What a Task Contains

| Field | Description |
|---|---|
| Title | Short description of what needs to be done |
| Description | Longer details, instructions, or context |
| Assigned to | Which staff member is responsible |
| Assigned by | Who created the task |
| Start date | When work should begin (optional) |
| Due date | Deadline |
| Status | Current state of the task |
| Link | The contact, case, appointment, or bill this task relates to |
| Notification | Whether to notify the assigner when the task is marked complete |

---

## Task Status

| Status | Meaning |
|---|---|
| **Pending** | Not yet started or in progress (also every task with no due date) |
| **Due Today** | Due date is today (firm time) |
| **Overdue** | Due date has passed without completion |
| **Completed** | Done |
| **Deleted** | Soft-deleted — no longer on anyone's queue, but still visible in history |

## Start dates — deferring work

A task can carry a **start date**: "this isn't actionable until then." Until that date arrives the task is **held back from the daily digest entirely**, so filing "call this client when they're eligible next March" no longer means emailing yourself about it every morning for a year. It stays fully visible in the task list the whole time, marked **Scheduled** with a *starts Mar 1* chip and sorted below work that's actually in play.

Three messages go out over a deferred task's life: on assignment, on the start date ("this is now live"), and on the due date. If the start and due dates are the same day, only the due-date message is sent.

The **Timing** filter (All / In play now / Scheduled) and the **Scheduled** preset chip show or hide deferred work. The sidebar and header task badges deliberately ignore it — a scheduled task is neither overdue nor due today. The **My Tasks** button shows in-play work only.

Due dates are **optional**. They used to be required on creation, on the theory that an undated task never gets done — but the daily digest lists every open task regardless of due date, so undated work is surfaced daily rather than lost. A start date with no due date is a perfectly good shape for "get to this after March, no deadline."

Open statuses are computed from the due date **at every write** — creating a task with a past due date lands it Overdue immediately, and editing a due date on an open task recomputes its status on the spot. The morning digest run remains as the day-rollover pass, flipping untouched tasks Pending → Due Today → Overdue as calendar days pass. All day math uses the firm's timezone, not the server's.

The task list additionally **derives the displayed status live** from the due date, so a task due today reads "Due Today" from midnight onward without waiting for the morning run, and open tasks with no due date display as **"No due date"** rather than Pending.

Completed and Deleted tasks remain visible in the history — they are not removed from the database. Either can be restored with the **Reopen** action, which recomputes the correct status based on the due date.

**Note on terminology:** "Incomplete" is a filter shown in the UI — it shows tasks in `Pending`, `Due Today`, or `Overdue` states. It is not itself a stored status.

---

## How Tasks Connect to Other Records

A task can be linked to any of the following:

- **Contact** — shows on the contact's detail page
- **Case** — shows on the case's detail page
- **Appointment** — shows on the appointment record
- **Bill** — shows on the billing record *(billing is a future feature)*

When you open a contact or case, the Tasks tab shows tasks linked to **that exact record** (the case log, by contrast, does expand across the case's related contacts — the task list does not). A task linked to a case appears on the case page; a task linked to the client contact appears on the contact page.

---

## Creating Tasks

Tasks can be created manually from any record's detail page, or automatically by the workflow and sequence engines. The automation system uses the `create_task` internal function to generate tasks as part of larger automated processes — for example, creating a "Gather missing documents" task when a client is marked as a no-show.

A configurable default assignee (`default_task_assignee` in app settings) is used when the automation engine creates tasks without a specific person specified.

---

## The Task UI

All three task surfaces (the main Tasks tab, the case page's Tasks tab, and the contact page's Tasks tab) are one page — `public/tasks.html` — loaded as a lazy iframe. With no URL parameters it runs in **shell mode** (the firm-wide list); with `?link_type=case&link_id=…` or `?link_type=contact&link_id=…` it runs in **entity mode**, scoped to that record with a reduced filter and column set.

Shell-mode features:

- **Preset chips** — My open · Overdue · Notices · All open — one-tap common views.
- **Filters auto-apply** — changing a select re-queries immediately; the query box is debounced.
- **Source filter** — All / Work only / Notices only. Machine-pushed notices (e-sign received, client uploads, court review, …) carry a robot chip naming their source, so they're distinguishable from human-assigned work at a glance.
- **Ordering** — within each status group, dated work sorts above undated notices.
- **Aging badge** — overdue rows show how many days overdue (`14d`), so a 2024 straggler no longer looks like yesterday's.
- **Inline actions** — ✓ Complete (one click, no dialog), ✎ Edit, ✕ Cancel (optional note) directly on the row; Reinstate on cancelled rows; Mark Incomplete on completed ones.
- **Bulk actions** — select rows with the checkboxes (or select-all) and complete or cancel them in one pass; a partial failure reports exactly which tasks failed.
- **Sidebar badge** — the Tasks item in the sidebar shows your overdue + due-today count, refreshed at login and after every task action.

Clicking a task title opens the detail view: full description, metadata, and the task's **history** — every created / updated / transferred / completed / cancelled event, including the optional note left when a task was completed or cancelled. History works for unlinked tasks too.

The **My Tasks** header button opens the Tasks tab pre-filtered to your own open tasks.

---

## Due Date Reminders

If a task has a due date, the system automatically schedules an email reminder to fire at 8:00 AM on the morning of the due date. If your profile has "Allow SMS" enabled, a short SMS is also sent. Reminders are cancelled automatically when the task is completed, deleted, or rescheduled.

---

## The Daily Task Digest

Every morning at 8:00 AM, the system sends a personalized task digest email to each staff member whose reminder frequency includes that day of the week. The digest groups your active tasks into three sections — Overdue, Due Today, and Pending — with direct links to the linked contact or case for each one. Staff with "Allow SMS" enabled also receive a short text message summary showing the count in each section.

The digest is not sent on Shabbos or Yom Tov. Status refreshes (Pending → Overdue / Due Today) still happen on those days so the Monday-morning digest reflects accurate state.

You can control which days you receive the digest in your user settings (`task_remind_freq`).

---

## Actions on a Task

Inline on any task row, and from the detail view:

- **Complete** — marks the task as done. If notifications are enabled and the person who assigned the task isn't the one completing it, they'll receive a notification email.
- **Cancel** — soft-deletes the task with an optional note explaining why (it still exists in history and can be reinstated).
- **Reopen** — restores a Completed or Deleted task. The status is recomputed from the due date.
- **Transfer** — reassigns the task to a different staff member. The new assignee is notified. Changing the assignee in the Edit dialog routes through Transfer too, so a reassignment always notifies.
- **Edit** — change title, description, start date, due date, link, or notification setting. Quick-date buttons set either date in one tap (start: +1 mo / +3 mo / +1 yr; due: Today / Tomorrow / +1 wk / +1 mo), and Clear removes it.

Every action is written to the activity log with details of what changed.