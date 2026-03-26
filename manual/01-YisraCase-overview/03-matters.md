# Matters (Cases)

A matter — called a *case* in the system — is a legal engagement. It represents a specific piece of work the firm is doing for a client: a bankruptcy filing, a debt negotiation, a consultation that may develop into a full engagement. Every case has at least one contact attached to it as the primary client.

---

## Case Identifiers

Each case is assigned a short unique ID when it is created (e.g. `uT7EU36v`). This is the internal identifier used throughout the system. Separately, once a case is filed with the court, it receives a court-assigned case number, which is stored alongside the internal ID.

---

## Case Type

The case type describes the kind of legal matter. Examples include:

- Bankruptcy - Ch. 7
- Bankruptcy - Ch. 13
- Debt Settlement
- Consultation

Case type drives several behaviors in the system — which workflow templates apply, which appointment types are relevant, and how the case is displayed and filtered.

---

## Case Stage vs. Case Status

These are two distinct fields that work together to describe where a matter stands.

**Case Stage** is a fixed set of values that tracks the matter's position in the legal lifecycle:

| Stage | Meaning |
|---|---|
| **Lead** | A prospective client — interest has been expressed but the firm has not yet formally taken the matter. See below. |
| **Open** | Active engagement; work is in progress |
| **Pending** | Awaiting something before proceeding — documents, payment, a court action, client response |
| **Filed** | Petition or filing has been submitted to the court |
| **Concluded** | The legal process has reached its end (e.g., discharge granted, settlement reached) but the file is not yet closed |
| **Closed** | The firm's engagement is fully concluded and the matter is archived |

**Case Status** is a free-text field for the current operational state within a stage — more specific notes like "Waiting on docs," "Contract sent," or "341 rescheduled." Status is set and updated manually and does not have a fixed list of values.

Think of Stage as the milestone and Status as the current note on that milestone.

---

## The Lead Stage

Leads are prospective matters. They are stored as cases with `case_stage = 'Lead'` and have their own dedicated **Leads tab** in the main interface, separate from the Cases tab. The Leads tab shows supplementary fields relevant to the intake process (first course completion, pre-petition course status, etc.).

A few things to know about Leads:

- Leads are created automatically through the intake process when a new prospective client is entered
- The stage dropdown on the case edit page starts at Open — Lead is not an option there. Once a case moves past Lead stage, it stays moved
- Leads that do not convert to open matters should be set to Closed or left as Lead for reporting purposes

---

## Contacts on a Case

Every case has at least one contact linked as **Primary**. Additional contacts can be added with the following relationship types:

- **Primary** — the main client
- **Secondary** — co-debtor, spouse, or other party with a substantive role
- **Other** — involved party
- **Bystander** — on record for reference

A contact can appear on multiple cases in different roles. The same person might be Primary on their own bankruptcy and Secondary on a spouse's filing. The system prevents the same contact from being added to the same case in the same role twice.

---

## What a Case Record Contains

Beyond the type, stage, and linked contacts, a case record holds:

- **Dates** — open date, file date, close date
- **Court information** — case number, judge (stored by name, not ID), trustee (stored by name, not ID), district
- **Bankruptcy-specific fields** — pre-petition garnishments, vehicle disposition elections (reaffirmation, redemption, replacement), pre-petition and post-petition course completion, 341 meeting date, and more
- **Notes** — free-text notes visible on the case record
- **Appointments** — all meetings tied to this case
- **Tasks** — tasks linked to this case or to any of its clients
- **Log** — full activity history

---

## Case Records Are Permanent

Cases are legal records and are not deleted from the system. If a matter is no longer active, set its stage to Closed. The full history — appointments, tasks, log entries, communications — remains accessible indefinitely.

---

## Opening a New Case

Cases can be created from a contact's record or through the intake flow. When creating a case:

1. Select the case type
2. The system generates a unique case ID automatically, retrying if a collision occurs
3. At least one contact must be linked as Primary
4. After creation, a Dropbox folder is created for the client's documents via an automated workflow

The open date is set to the creation date automatically.

---

## Finding a Case

From the Cases tab, you can filter by:

- Type
- Stage / Status (text search on the status field)
- Search text (matches case ID, court case number, or primary contact name)

The Leads tab has its own separate filter set tailored to the intake process. Results in both tabs sort by open date descending by default.
