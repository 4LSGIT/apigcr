# Users & Staff

Users are the firm's staff members — attorneys, paralegals, assistants, and anyone else who has a login to YisraCase. The users table is small (typically a handful of people) and is referenced throughout the system wherever an action is attributed to a person.

---

## What a User Record Contains

| Field | Description |
|---|---|
| User ID | A small integer (1, 2, 3…). Used as a foreign key throughout the system. |
| Name | Display name shown in the interface and on log entries |
| Initials | Automatically derived from the name — first letter of each word, up to 3 characters |
| Email | Login email and contact address |
| Role | Controls what the user can access and do in the system |

---

## Users vs. Contacts

Users and contacts are completely separate record types. A staff member is a **user**, not a contact. Contacts are clients and other external people the firm works with. There is no overlap between the two tables.

---

## Users on Appointments

Every appointment has an `appt_with` field that references a user ID — this is the staff member conducting the meeting. When viewing appointment lists, the staff member's name is displayed next to each appointment. Staff members can filter the appointments view to show only their own schedule.

---

## Users on Tasks

Tasks have two user references: `task_from` (who created the task) and `task_to` (who it is assigned to). Both are user IDs. Tasks are assigned between staff members — clients are never assigned tasks directly in this system.

---

## Users on Log Entries

Every log entry records `log_by` — the user ID of whoever (or whatever process) created the entry. Automated system entries use user ID `0` by convention, which resolves to a "System" label in the interface.

---

## Managing Users

User accounts are managed from the Admin tab. Creating, editing, and deactivating users is an administrative function. For security, passwords are hashed and are never stored or displayed in plain text.

Staff members can update their own name and password from their profile page without needing admin access.
