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
| **Due Today** | Set automatically when today matches the due date |
| **Overdue** | Set automatically when the due date has passed without completion |
| **Completed** | Done |
| **Canceled** | No longer needed |

Status transitions are tracked in the task record. Completed tasks remain visible in the history — they are not deleted.

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
