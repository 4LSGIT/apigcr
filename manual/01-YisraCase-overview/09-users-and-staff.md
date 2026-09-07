# Users & Staff

Users are the firm's staff members — attorneys, paralegals, assistants, and anyone else who has a login to YisraCase. The users table is small (typically a handful of people) and is referenced throughout the system wherever an action is attributed to a person.

---

## What a User Record Contains

| Field | Description |
|---|---|
| User ID | A small integer (1, 2, 3…) in the `user` column. Used as a foreign key throughout the system. |
| Username | Login username (`username`) |
| Display name | `user_name` — what appears in the interface and on log entries. **Stored and editable**, not computed |
| First / Last name | `user_fname` / `user_lname`, stored separately |
| Initials | `user_initials` — up to 3 characters. **Also stored and editable**: they are typed in, not derived, so a Robert who signs RJT can have RJT |
| Email | Login email and contact address |
| Auth level | `user_auth` — see below |
| Roles | `roles` — any of `it`, `admin`, `staff`, `attorney`, `automation`, `form_dev` |
| Does appointments | `does_appts` — whether this person can host appointments and appear in booking-view provider lists |

> **There is no "active" flag on a user.** Deactivating someone means changing
> their auth level or clearing their password, not flipping a status column.

### Auth level and roles

`user_auth` is the gate everything security-related reads:

| Value | Who |
|---|---|
| `authorized` | Ordinary staff |
| `authorized - SU` | Super-user — the only level that can open the tools in [Admin Tools](../08-Admin-Tools/) |

Being a super-user is **necessary but no longer sufficient**: every SU tool also
requires a short-lived elevation token obtained by re-entering your own
password. See [the elevation gate](../08-Admin-Tools/).

`roles` is a separate, additive set used for finer-grained routing and feature
access — `form_dev` for form authors, `automation` for the pseudo-user
automation acts as, and so on. A person can hold several.

### Hosting appointments

`does_appts = 1` marks someone as a provider: they appear in the appointment
staff picker, in `GET /api/booking-views/providers`, and their working hours
drive [availability](../06-Client-Facing/04-booking-and-scheduling.md).

A database constraint enforces that a provider must have a `default_phone` —
you cannot set `does_appts = 1` on a user without one.

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

Two more, both calendar-related: `user_gcal_id` (the person's secondary calendar
on the firm's Google account) and `freebusy_calendar_ids` (the calendars
consulted when computing whether they are free). See
[Google Calendar](../04-Integrations/04-google-calendar.md).

`user_custom_tab` holds the view pinned to that person's **Custom** sidebar tab —
see [YisraView](../05-Subsystems/05-YisraView.md).

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

User accounts are managed from the Admin tab (**More → Users (SU)**). For
security, passwords are hashed with bcrypt into `password_hash` and are never
stored or displayed in plain text. Password resets go through `reset_token` /
`reset_expires` rather than an admin ever seeing a password.

Staff members can update their own name, username, email, phone, and communication preferences from their profile page without needing admin access. Password changes go through a separate reset flow.