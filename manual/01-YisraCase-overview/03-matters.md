# Matters (Cases)

A matter — called a *case* in the system — is a legal engagement. It represents a specific piece of work the firm is doing for a client: a bankruptcy filing, a debt negotiation, a consultation that may develop into a full engagement. Every case has at least one contact attached to it as the primary client.

---

## Case Identifiers

Each case is assigned a short unique ID when it is created. This is the internal identifier used throughout the system. IDs created from August 2026 onward are 8 uppercase characters drawn from an alphabet with the letters I, L, O, and U removed (e.g. `7XK4MQ2R`) — so there is no 1-vs-I or 0-vs-O ambiguity when an ID is read aloud, handwritten, or typed. Older IDs (e.g. `uT7EU36v`) remain valid and are not renamed. Separately, once a case is filed with the court, it receives a court-assigned case number, which is stored alongside the internal ID.

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
| **Open** | Active engagement; work is in progress — the default for a newly created matter, including a prospective one |
| **Pending** | Awaiting something before proceeding — documents, payment, a court action, client response |
| **Filed** | Petition or filing has been submitted to the court |
| **Concluded** | The legal process has reached its end (e.g., discharge granted, settlement reached) but the file is not yet closed |
| **Closed** | The firm's engagement is fully concluded and the matter is archived |

**Case Status** is a free-text field for the current operational state within a stage — more specific notes like "Waiting on docs," "Contract sent," or "341 rescheduled." Status is set and updated manually and does not have a fixed list of values.

Think of Stage as the milestone and Status as the current note on that milestone.

> **With pipelines enabled, both are set by the pipeline.** Each pipeline stage maps to one of the five Stage values and carries a status label; advancing a case writes both. Status stays editable, but the next advance replaces it. See [Pipelines](13-pipelines.md).

---

## Leads

Leads are prospective matters. There is no separate "Lead" stage and **no
separate Leads tab** — a lead is an ordinary case that has not progressed yet,
carrying the normal `Open` default, and it lives in the Cases tab with
everything else. The Cases list labels its id column *Lead ID* for historical
reasons; it is `case_id`, the same identifier every case has.

What actually distinguishes a lead is `pipeline_phase`, which is `intake` until
the case is retained and `case` afterwards. That is the field
[pipelines](13-pipelines.md) advance, and the intake→matter hand-off is a
pipeline transition, not a stage change.

A few things to know about Leads:

- Leads are created automatically through the intake process when a new prospective client is entered
- Leads that do not convert should be set to Closed

> **The Stage filter's "Lead" option matches nothing.** The Cases tab offers
> All / Lead / Filed / Closed, and the filter compares against `case_stage`,
> whose only values are Open, Pending, Filed, Concluded and Closed. Selecting
> **Lead** therefore returns an empty list — it is a leftover from before the
> stage set settled. Filter on `pipeline_phase` (or use a
> [view](../05-Subsystems/05-YisraView.md)) to list leads.

---

## Contacts on a Case

Every case has at least one contact linked as **Primary**. Additional contacts can be added with the following relationship types:

- **Primary** — the main client
- **Secondary** — co-debtor, spouse, or other party with a substantive role
- **Other** — involved party
- **Bystander** — on record for reference

A contact can appear on multiple cases in different roles. The same person might be Primary on their own bankruptcy and Secondary on a spouse's filing.

A database trigger blocks the exact same combination of case, contact **and** role from being added twice. Note what that permits: the same contact *can* be linked to one case under two different roles, because the guard keys on all three columns.

---

## What a Case Record Contains

Beyond the type, stage, and linked contacts, a case record holds:

- **Dates** — open date, file date, close date
- **Court information** — case number (short `25-12345` and full `2:25-bk-12345` forms), judge and trustee (both stored by name, not ID)
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
4. After creation, a Dropbox folder is created for the client's documents

The open date is set to the creation date automatically.

**The Dropbox folder is stage-aware.** A case that already carries a docket
number is treated as *active* and gets the Active-tree naming convention plus
the four staff subfolders; anything else is *potential*. The naming templates
live in the `dropbox_case_folder_templates` setting rather than in code, so
changing the convention is a settings edit, not a deploy. If a case ends up
without a folder, the case page shows a **Create Dropbox Folder** repair button
that runs the same operation. See
[Dropbox](../04-Integrations/05-dropbox.md).

---

## Finding a Case

From the Cases tab, you can filter by:

- Type
- Stage / Status (text search on the status field)
- Search text (matches case ID, court case number, or primary contact name)

The Leads tab has its own separate filter set tailored to the intake process. Results in both tabs sort by open date descending by default.
