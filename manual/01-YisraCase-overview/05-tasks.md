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
| **Pending** | Not yet started or in progress |
| **Due Today** | Set automatically at the start of the due date (during the morning digest run) |
| **Overdue** | Set automatically the day after the due date passes without completion |
| **Completed** | Done |
| **Deleted** | Soft-deleted — no longer on anyone's queue, but still visible in history |

Completed and Deleted tasks remain visible in the history — they are not removed from the database. Either can be restored with the **Reopen** action, which recomputes the correct status based on the due date.

**Note on terminology:** "Incomplete" is a filter shown in the UI — it shows tasks in `Pending`, `Due Today`, or `Overdue` states. It is not itself a stored status.

---

## How Tasks Connect to Other Records

A task can be linked to any of the following:

- **Contact** — shows on the contact's detail page
- **Case** — shows on the case's detail page
- **Appointment** — shows on the appointment record
- **Bill** — shows on the billing record *(billing is a future feature)*

When you open a contact or case, the Tasks section shows all tasks linked to that record, as well as tasks linked to any of the case's contacts. This means if you create a task linked to a case, it will appear whether you navigate to the case or to the primary client.

---

## Creating Tasks

Tasks can be created manually from any record's detail page, or automatically by the workflow and sequence engines. The automation system uses the `create_task` internal function to generate tasks as part of larger automated processes — for example, creating a "Gather missing documents" task when a client is marked as a no-show.

A configurable default assignee (`default_task_assignee` in app settings) is used when the automation engine creates tasks without a specific person specified.

---

## The Task Queue

The Tasks tab in the main interface shows your personal task queue — all tasks assigned to you, sorted by due date. You can filter by status and mark tasks complete from this view without opening the linked record.

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

From the actions dropdown on any task row:

- **Complete** — marks the task as done. If notifications are enabled and the person who assigned the task isn't the one completing it, they'll receive a notification email.
- **Delete** — soft-deletes the task (it still exists in history and can be reopened).
- **Reopen** — restores a Completed or Deleted task. The status is recomputed from the due date.
- **Transfer** — reassigns the task to a different staff member. The new assignee is notified.
- **Edit** — change title, description, due date, link, or notification setting.

Every action is written to the activity log with details of what changed.