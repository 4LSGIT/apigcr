# Appointments

An appointment is a scheduled meeting between a client and a staff member. Appointments are one of the most active parts of the system — they trigger SMS and email confirmations, calendar events, automated follow-up sequences, and workflow executions.

---

## What Belongs on an Appointment

Every appointment must have:

- **A contact** — the client attending the meeting
- **A date and time** — when the meeting starts
- **A length** — duration in minutes (drives the end time and calendar block)
- **A type** — what kind of meeting it is
- **A platform** — how it will be conducted
- **A staff member** — who is conducting the meeting

Optionally, an appointment can be linked to a **case**. Most appointments should be linked to a case once one exists. An initial consultation before a case is opened might not have a case link yet — that is expected and fine.

A few fields are managed by the system and should not be edited manually: the Google Calendar event ID, the external reference ID, and the computed end time. These are set automatically when an appointment is created.

---

## Appointment Types

Common appointment types include:

- Initial Consultation
- Initial Strategy Session
- 341 Meeting (the court-required creditors meeting in bankruptcy)
- Follow-up
- Document Review

The type affects how the appointment appears in reports and which automation sequences apply to it. Scheduling a **341 Meeting** against a case automatically updates the case record with the 341 date.

---

## Appointment Platform

How the meeting will be conducted:

- **Telephone** — phone call
- **Zoom** — video call
- **In-person** — at the office

---

## Appointment Status

| Status | Meaning |
|---|---|
| **Scheduled** | Upcoming; not yet resolved |
| **Attended** | Client showed up |
| **No Show** | Client did not appear |
| **Rescheduled** | This appointment was replaced or deferred |
| **Canceled** | Canceled with no replacement |

Status changes are made from the appointment list or detail view. Each change updates the record, writes a log entry, and triggers relevant automations.

---

## How Appointments Connect to Contacts and Cases

Historically an appointment always had a **contact**. Since the U6b update it needs an **anchor**, which can be any one of three things:

- **A contact** — the classic shape. When you open a contact record, you see all their appointments across all cases.
- **A case** — the appointment appears on that case whether or not a contact is attached.
- **A docket number** — for appointments (typically a 341 Meeting written from a court email) created *before* the case exists in YisraCase. The appointment stores the docket and attaches itself to the case automatically, the moment a case with that number is created. Nothing needs to be re-linked by hand — this is the same self-healing behaviour court-created events have.

When both a contact and a case/docket are present, the contact is the **client attendee** and the case (or docket) is the anchor. The old rule "you cannot have an appointment without a contact" is gone; the new rule is "you cannot have an appointment without an anchor."

**Client-less appointments** behave sensibly: everything client-facing is simply skipped. No confirmation can be sent (asking for one is rejected before anything is written), no reminder sequences are enrolled, and the staff calendar entry has no client name — but the time is still blocked on the provider's calendar, the log is written (marked *Clientless*), and the appointment shows on the case timeline. When a client is later attached (edit the appointment and set the client), future actions treat it normally.

```
Anchor (contact, case, or docket) → Appointment
Contact (optional attendee) ──────↗
```

---

## What Happens When You Mark an Appointment

### Attended
- Status set to Attended
- Log entry written
- Any outstanding no-show sequences for this contact are automatically canceled — the system assumes if a client came in for a new meeting, any previous no-show follow-up is no longer relevant

### No Show
- Status set to No Show
- Log entry written
- Optionally enrolls the contact in the no-show follow-up sequence: a series of SMS and email reminders to reschedule, which cancels automatically if the client books a new appointment

### Canceled
- Status set to Canceled
- Log entry written
- Google Calendar event is deleted
- Any active reminder sequences tied to this appointment are canceled
- Optionally creates a follow-up task and/or sends a cancellation confirmation to the client

### Rescheduled — two modes

**Reschedule Now** — you have a new date already:
- The existing appointment is marked Rescheduled
- A new appointment is created with the updated date and time, inheriting the same contact, case, type, platform, and staff member
- The old Google Calendar event is deleted; a new one is created
- Confirmation messages (SMS, email, or both) can be sent for the new time
- The reminder workflow starts fresh for the new appointment

**Reschedule Later** — you need to call the client back to find a new time:
- The existing appointment is marked Rescheduled and the calendar event is removed
- No new appointment is created
- Optionally creates a follow-up task assigned to a staff member as a reminder to complete the rescheduling

---

## Automations Triggered by Appointments

When an appointment is **scheduled**, the system can:

- Send a confirmation SMS and/or email to the client immediately
- Create a Google Calendar event for the attending staff member
- Start a reminder sequence (e.g., reminders 24 hours and 1 hour before the appointment)

When an appointment is marked **no-show**, the system can enroll the client in a follow-up sequence to prompt them to reschedule — with automatic cancellation if they book again.

All of these happen in the background; the action completes immediately and the communications fire asynchronously.

---

## One Live Appointment per Type (singleton)

Some appointment types — most importantly the **341 Meeting** — are *singletons*: a case should have exactly one live one at a time. When a new singleton appointment is created for a case, any prior still-Scheduled appointment of the same type on that case is automatically marked **Rescheduled** (its calendar entries and reminder automation are torn down), and the new appointment records which one it replaced.

Two implementations exist, switched by the `unified_singleton_enabled` setting:

- **Off (current default):** the long-standing 341-specific behaviour — only the type named exactly "341 Meeting" supersedes, found through the case's stored 341 pointer.
- **On:** any type marked `singleton` in the calendar type registry supersedes, found by querying the appointment table directly — including court-created, docket-anchored appointments on the same case. The `case_341_current` / `341_appt_id` columns on the case keep being maintained either way.

#### If a supersession is wrong

An administrator can restore the old appointment from the database console:

```sql
UPDATE appts
   SET appt_status = 'Scheduled'
 WHERE appt_id = <the old appointment>;
```

That restores the old appointment as live. It does **not** restore what the supersession tore down: the Google Calendar entries (firm and provider) and any reminder sequence enrollments must be recreated by hand (edit-and-save the appointment to resync the calendar, and re-enroll reminders if needed). The new appointment is untouched — cancel it separately if it should not exist. If the old appointment was a 341, also correct the case's *341 Current* pointer (`case_341_current` / `341_appt_id`) to point back at it.

---

## The Appointment Form

New appointments are created using the appointment form, which can be launched from a contact's record or a case's record. When opened from an existing record, the contact and case fields are pre-filled automatically.
