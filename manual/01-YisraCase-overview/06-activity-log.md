# Activity Log

The activity log is a running history of everything that has happened on a contact or case. It is append-only — entries are never edited or deleted. If something happened, the log records it.

---

## What Gets Logged

Log entries are created automatically for:

- Appointment outcomes (scheduled, attended, no-show, canceled, rescheduled)
- Status changes on cases
- SMS messages sent through the system (inbound and outbound)
- Emails sent through the system (inbound and outbound)
- Phone calls logged through the Communication tab
- Task events (created, completed, deleted, reopened, transferred)
- Case creation
- Contact field updates *(written directly by a database trigger)*
- Form submissions

Manual log entries can also be written for any interaction worth recording — the "Log Without Sending" and "Log Call" options on a contact's Communication tab are the usual entry point.

---

## Log Entry Fields

| Field | Description |
|---|---|
| Type | Category of the entry. Drives how the entry is displayed and filtered. |
| Date | When the event occurred, in firm local time |
| By | Which staff member (or automated process) created the entry |
| Link | The contact, case, appointment, or bill this entry belongs to |
| Data | A JSON payload with the details of the event |
| Direction | For communications: `incoming` or `outgoing` |
| From / To | Sender and recipient for SMS, email, and call entries |
| Subject | Subject line for email entries |
| Message | The body content — email text, SMS message, note content, etc. |

### Log Types

The type field is a fixed list:

| Type | Used for |
|---|---|
| `email` | Email sent or received |
| `sms` | SMS sent or received |
| `call` | Phone call (logged manually) |
| `appt` | Appointment event (scheduled, attended, no-show, canceled, rescheduled) |
| `task` | Task event (created, completed, deleted, reopened, transferred) |
| `status` | Case status or stage change |
| `update` | Field change on a contact or case |
| `note` | Manual free-text entry |
| `form` | Form submission |
| `docs` | Document-related activity |
| `court email` | Court-related correspondence |
| `other` | Catch-all |

---

## Where Logs Appear

The log appears on both the **contact** detail page and the **case** detail page. Entries linked directly to the case, and entries linked to any of the case's contacts, all appear together on the case record. This gives you a unified view of everything that has happened in the context of a matter.

The most recent 200 entries are shown by default, sorted newest first. You can filter by type, direction, date range, or keyword search within the log content.

---

## Log as Audit Trail

Because log entries are never modified, the log serves as a reliable audit trail. If there is ever a question about what was communicated to a client, when a status was changed, or who took an action, the log is the authoritative record.

The automation system also writes log entries when workflows and sequences execute actions, so automated communications are recorded the same way manual ones are. Automated entries show "System" as the author.

---

## How Log Entries Are Written

Most log entries are created by the application code through a central service — any SMS send, email send, task action, or appointment status change writes a log entry as part of the action's flow.

**One exception:** changes to contact records are logged automatically by a database trigger (`after_contact_update`), not by the application code. If you edit a contact's phone number or address through the contact form, the log entry reflecting the change is written by the database itself. This is transparent in normal use, but is worth knowing if you are ever tracing which code path wrote a given entry.