# Part 6 — Data Modes

Forms operate in one of two modes, set by the `dataMode` config option.

---

## Live Mode (`dataMode: 'live'`)

**The form is an editor for a living record.** It always loads fresh data from the entity table.

**Use for:** Contact information, appointment details, case overview fields — any form where the entity table is the source of truth.

| Scenario | What loads |
|----------|-----------|
| No submission, no draft | Entity table data |
| No submission, has draft | Entity table + draft recovery banner |
| Has submissions, no draft | Entity table (submissions are just history) |
| Has submissions, has newer draft | Entity table + draft recovery banner |

**Example:** Stuart opens Contact #1001. The form fetches `GET /api/contacts/1001`. If he edits the phone number and saves, the contacts table is PATCHed. Next time anyone opens it, they see current data from the contacts table.

---

## Snapshot Mode (`dataMode: 'snapshot'`)

**The form captures a moment in time.** Once submitted, the submission IS the record.

**Use for:** Strategy session notes, 341 meeting notes, intake questionnaires — any form where the data represents a specific event.

| Scenario | What loads |
|----------|-----------|
| No submission, no draft | Entity table data (one-time pre-fill) |
| No submission, has draft | Entity table + draft recovery banner |
| Has submissions, no draft | **Latest submission** (not entity table) |
| Has submissions, has newer draft | Latest submission + draft recovery banner |

**Example:** Stuart fills out the ISSN during a strategy session with the client's phone as 313-555-1234. The client later changes their phone to 248-555-9999. Next time anyone opens the ISSN, it still shows 313-555-1234 — that's what was true during the session.

---

## Comparison

| Behavior | Live | Snapshot |
|----------|------|---------|
| Source of truth | Entity table (always) | Latest submission (once one exists) |
| Pre-fill from entity table | Every load | First load only |
| Reflects external changes | Yes | No |
| Typical `onSubmit.patch` | Yes | Sometimes / No |
| Use case | Edit forms | Event capture |

---

## Choosing a Mode

**"If someone changes the underlying data after this form was submitted, should this form show the changed data?"**

- **Yes** → `'live'`
- **No** → `'snapshot'`

If unsure, start with `'live'`. You can switch later — it's a client-side config change only, no database migration needed.

---

## Current Forms

| Form | Mode | Reason |
|------|------|--------|
| Contact Info | `live` | Always shows current contact data |
| 341 Meeting Notes | `snapshot` | Record of a specific hearing |
| ISSN (Strategy Session) | `snapshot` | Record of a specific meeting |
| Case Details | `live` | Always shows current case data |
| Sending Form | `live` | Editing current case fields |
| Detailed Questionnaire | `snapshot` | Point-in-time client information |
