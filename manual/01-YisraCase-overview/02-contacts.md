# Contacts

A contact is a person. Every individual the firm has any relationship with — a client, a potential client, a co-debtor, a spouse — lives in the contacts table. Contacts are the foundation of the entire system. Cases, appointments, tasks, log entries, and bills all ultimately connect back to one or more contacts.

---

## What a Contact Record Contains

| Field | Description |
|---|---|
| Name | First, middle, and last name stored separately. The system automatically maintains a full name (`contact_name`), a last-first-middle format (`contact_lfm_name`), and a short last+remainder format used in some displays. |
| Phone | Primary phone number, used for SMS. |
| Email | Primary email address. |
| Address | Street, city, state, zip. |
| Date of Birth | Used for identity verification and certain legal filings. |
| SSN | Stored securely; stripped from most API responses automatically. |
| Notes | Free-text notes about the contact. |

The name fields are the most important to understand. You always write `fname`, `mname`, and `lname` — the system's database triggers automatically compute and update the derived display formats. You never need to set the formatted name fields manually.

---

## Contacts and Cases

A contact can be linked to any number of cases. The relationship type is recorded for each link:

- **Primary** — the main client on the matter
- **Secondary** — co-debtor, spouse, or other party with a direct role
- **Other** — involved but not a primary party
- **Bystander** — on record for informational purposes

When you open a case, you will see all of its linked contacts and their relationship types. When you open a contact, you will see all of their cases.

---

## Contacts and Appointments

Appointments always belong to a contact. The contact record shows the full appointment history for that person, regardless of which case (if any) the appointment was tied to. This means you can see at a glance whether someone has attended consultations in the past, no-showed, or been rescheduled.

---

## Finding a Contact

From the Contacts tab, you can search by:

- Name (partial match)
- Phone number
- Email address
- Contact ID
- Date of birth
- SSN (last 4 or full)

Results show the contact's name, phone, email, address, and any cases they are linked to.

---

## Creating and Editing Contacts

When creating a contact, provide first name, last name, and at minimum a phone number or email address. Middle name is optional.

When editing, fill in only the fields you are changing. The system will not overwrite fields you leave blank on a partial update — only the fields you submit are modified.

> **Important:** Name changes are handled by the database automatically. If you update `fname`, `mname`, or `lname`, all derived name fields update instantly. You do not need to update `contact_name` or `contact_lfm_name` separately.

---

## The Contact Log

Every contact has an activity log. Log entries are created automatically when:

- An appointment is scheduled, attended, marked no-show, or canceled
- A case is opened or its status changes
- An SMS or email is sent through the system
- A task is completed

You can also write manual log entries for phone calls, in-person conversations, or any other interaction worth recording.
