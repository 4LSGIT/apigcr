# Activity Log

The activity log is a running history of everything that has happened on a contact or case. It is append-only — entries are never edited or deleted. If something happened, the log records it.

---

## What Gets Logged

Log entries are created automatically for:

- Appointment outcomes (scheduled, attended, no-show, canceled, rescheduled)
- Status changes on cases
- SMS messages sent through the system
- Emails sent through the system
- Task completions
- Case creation
- Contact field updates

Manual log entries can also be written for phone calls, in-person conversations, or anything else worth recording.

---

## Log Entry Fields

| Field | Description |
|---|---|
| Type | Category of the entry: `appt`, `update`, `sms`, `email`, `note`, etc. |
| Date | When the event occurred (stored in local firm time) |
| By | Which staff member (or system process) created the entry |
| Link | The contact, case, or other record this entry belongs to |
| Data | A JSON payload with the relevant details of the event |
| Direction | For communications: `inbound` or `outbound` |
| From / To | Sender and recipient for SMS and email entries |
| Subject | Subject line for email entries |

---

## Where Logs Appear

The log appears on both the **contact** detail page and the **case** detail page. Entries linked directly to the case, and entries linked to any of the case's contacts, all appear together on the case record. This gives you a unified view of everything that has happened in the context of a matter.

The most recent 200 entries are shown by default, sorted newest first.

---

## Log as Audit Trail

Because log entries are never modified, the log serves as a reliable audit trail. If there is ever a question about what was communicated to a client, when a status was changed, or who took an action, the log is the authoritative record.

The automation system also writes log entries when workflows and sequences execute actions, so automated communications are recorded the same way manual ones are.
