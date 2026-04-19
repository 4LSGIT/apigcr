# Users & Staff

Users are the firm's staff members — attorneys, paralegals, assistants, and anyone else who has a login to YisraCase. The users table is small (typically a handful of people) and is referenced throughout the system wherever an action is attributed to a person.

---

## What a User Record Contains

| Field | Description |
|---|---|
| User ID | A small integer (1, 2, 3…). Used as a foreign key throughout the system. |
| Username | Login username |
| Name | Display name shown in the interface and on log entries. Derived automatically from first + last name. |
| First / Last Name | Stored separately |
| Initials | Automatically derived from the name — first letter of each word in first + last name, up to 3 characters |
| Email | Login email and contact address |
| Active | Whether the user is active staff. Inactive users don't appear in assignment dropdowns. |

### Communication Preferences

Each user has a few preference fields that affect how the system contacts them:

| Field | Description |
|---|---|
| Phone | User's personal phone number (used for task digest SMS) |
| Allow SMS | Whether to send the user SMS reminders for task due dates and daily digest |
| Task Reminder Frequency | Which days of the week to receive the daily task digest (e.g., Mon, Tue, Wed, Thu, Fri) |
| Default Phone | Which phone line to preselect in the sending form and communicate tab dropdowns |
| Default Email | Which sender address to preselect in the sending form and communicate tab dropdowns |

Users can update all of these fields from their profile page.

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

User accounts are managed from the Admin tab. Creating, editing, and deactivating users is an administrative function. For security, passwords are hashed using bcrypt and are never stored or displayed in plain text.

Staff members can update their own name, username, email, phone, and communication preferences from their profile page without needing admin access. Password changes go through a separate reset flow.