# Contacts

A contact is a person. Every individual the firm has any relationship with — a client, a potential client, a co-debtor, a spouse — lives in the contacts table. Contacts are the foundation of the entire system. Cases, appointments, tasks and log entries all ultimately connect back to one or more contacts.

---

## What a Contact Record Contains

| Field | Description |
|---|---|
| Name | First, middle, and last name stored separately. The system automatically maintains a full name (`contact_name`), a last-first-middle format (`contact_lfm_name`), and a short last+remainder format used in some displays. |
| Preferred name | `contact_pname` — what the person actually goes by, when it isn't their first name. |
| Phone | The primary number, used for SMS. A contact may hold **many** — see below. |
| Email | The primary address. Again, a contact may hold many. |
| Address | Street, city, state, zip — likewise. |
| Date of Birth | Used for identity verification and certain legal filings. |
| SSN | Stored securely; stripped from most API responses automatically. |
| Tags | Free-form labels on the contact, used to filter the contact list. |
| Notes | Free-text notes about the contact. |
| Opt-outs | `contact_sms_optout` / `contact_email_optout` — set these and campaigns and automation skip the contact. |
| Type | What kind of contact this is (client, opposing party, and so on). |

Not shown on the form but worth knowing about: `contact_token`, a per-contact
bearer minted at creation that makes booking and video links resolve without a
separate step, and `portal_enabled` / `portal_session_version`, which govern
[client portal](../06-Client-Facing/02-client-portal.md) access.

### More than one phone, email or address

The fields above are the *primary* of each. Behind them sit three child tables —
`contact_phones`, `contact_emails`, `contact_addresses` — and a contact can hold
any number of rows in each. Every row carries:

- a **label** (Mobile / Home / Work / Office / Fax / Other for phones; Personal /
  Work / Other for emails; Home / Work / Mailing / Other for addresses),
- **`is_primary`**, which is the one mirrored onto the contact record,
- **`verified`**,
- **`start_date` / `end_date` / `end_reason`** — so a number the client no longer
  uses is *ended*, not deleted. History is preserved and an old message still
  links to the right person.

Phones additionally carry their own `sms_optout` and `mms_capable`; emails their
own `email_optout`.

Search reaches into these tables, so looking up an old number still finds the
contact — including numbers that have been ended.

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

## Contacts and Each Other

Separately from cases, two contacts can be related **to one another** — a
co-debtor, a spouse, a parent, an employer, whoever referred them. These live in
`contact_relations` and use a registry of typed relationships, each with a
direction:

| Type | Forward | Reverse |
|---|---|---|
| `co_debtor` | Co-debtor with | *(symmetric)* |
| `domestic_partner` | Domestic partner of | *(symmetric)* |
| `sibling`, `sibling_in_law` | Sibling of | *(symmetric)* |
| `business_partner`, `opposing_party`, `other` | … | *(symmetric)* |
| `parent_child` | Parent of | Child of |
| `parent_in_law` | Parent-in-law of | Child-in-law of |
| `employer_employee` | Employer of | Employee of |
| `attorney_client` | Attorney for | Client of |
| `opposing_counsel` | Opposing counsel for | Represented by (opposing) |
| `guarantor` | Guarantor for | Guaranteed by |
| `power_of_attorney` | Power of attorney for | POA held by |
| `emergency_contact` | Emergency contact: | Emergency contact for |
| `referred_by` | Referred by | Referred |

Symmetric types read the same both ways; the rest render the forward label from
one contact and the reverse from the other, so you never have to record the pair
twice. Relations carry `start_date` / `end_date` and an `active` flag, so a
former spouse stays on the record as a former spouse.

The registry is data (`contact_relation_types`), not code — a new relationship
type is a row, and `GET /api/relation-types` serves the live list.

---

## Contacts and Appointments

Appointments always belong to a contact. The contact record shows the full appointment history for that person, regardless of which case (if any) the appointment was tied to. This means you can see at a glance whether someone has attended consultations in the past, no-showed, or been rescheduled.

---

## Finding a Contact

From the Contacts tab, what you type is classified and matched accordingly:

| You type | What it matches |
|---|---|
| Digits, 7 or more | A phone number — the primary, the secondary, **and** any row in `contact_phones`, including ended ones |
| Digits, fewer than 7 | A contact ID |
| Anything containing `@` | An email — primary, secondary, and any row in `contact_emails` |
| Anything else | A name — full-text on `contact_name`, plus partial matches on the full name, first + last, first alone and last alone |

There is also a **tags** filter, and sorting by any column.

> **You cannot search by date of birth or SSN.** Neither is a search key
> anywhere in the system. If you only have a birth date, narrow by name first.

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
