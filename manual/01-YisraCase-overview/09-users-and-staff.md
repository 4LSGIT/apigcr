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
| Roles | `roles` — any of `it`, `admin`, `staff`, `attorney`, `automation`, `form_dev`, `su` |
| Does appointments | `does_appts` — whether this person can host appointments and appear in booking-view provider lists |

> **There is no "active" flag on a user.** Deactivating someone means changing
> their auth level or clearing their password, not flipping a status column.

### Auth level and roles

`user_auth` is login status only:

| Value | Meaning |
|---|---|
| `authorized` | May log in |
| `disabled` | Cannot log in |

A disabled person also drops out of every list that hands out **new** work:
the task assignee, an appointment's provider, an event's "Blocks calendar of"
and reminder, a CTA link's attribution, and the user suggestions in the
automation builder. They stay everywhere a name is shown, in list filters
(their open tasks can still be found and moved), and as "view only" in the
Notes & Lists picker. A record that already points at them keeps them —
opening and saving it never quietly changes who it names.

What a person may *do* comes from `roles`, a set — a person can hold several.
Edit them with the **Roles** checkboxes in the user's form (Admin → Users):

| Role | Unlocks today |
|---|---|
| `su` | Super-user: the tools in [Admin Tools](../08-Admin-Tools/), and everything below |
| `it` | Firm settings edits; template code in the form builder |
| `admin` | Firm settings edits |
| `attorney` | Reading every mailbox and phone line without a per-channel grant |
| `form_dev` | Template code in the form builder |
| `staff` | Nothing extra — the everyday surface every signed-in user has |
| `automation` | Marks the automation pseudo-user (user 0); grants nothing |

Only a super-user can give or remove `su`, and nobody can remove their own.
A role change reaches the person at their next login (a session lasts up to
24 hours); checks that read the database — mailbox and phone access
(super-user and `attorney`), archive admin — see it at once.

Being a super-user is **necessary but no longer sufficient**: every SU tool also
requires a short-lived elevation token obtained by re-entering your own
password. See [the elevation gate](../08-Admin-Tools/).

### Hosting appointments

`does_appts = 1` marks someone as a provider: while their login is
`authorized` they appear in the appointment staff picker, in `GET /api/booking-views/providers`, and their working hours
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

User accounts are managed from the Admin tab (**Admin → Users (SU)**). For
security, passwords are hashed with bcrypt into `password_hash` and are never
stored or displayed in plain text. Password resets go through `reset_token` /
`reset_expires` rather than an admin ever seeing a password.

Staff members can update their own name, username, email, phone, and communication preferences from their profile page without needing admin access. Password changes go through a separate reset flow.