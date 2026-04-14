# Sending Form — Document Request & Message Builder

## What It Is

The Sending Form is a standalone action UI for composing and sending messages to case contacts. It lives at `public/sendingform.html` and is loaded in an iframe inside `case.html`.

**This is NOT a YisraForm.** It does not use the `YCForm` class, `form_submissions` table, drafts, autosave, or schema versioning. It uses `yc-forms.css` for visual consistency but is otherwise a custom page. There is nothing to save — you check options, preview, send, and it's done. The log entries and checklist records are the history.

---

## How to Load It

In `case.html`:
```js
E("SendingForm").src = `sendingform.html?case_id=${caseData.case_id}`;
```

Note: it's in `public/`, not `public/forms/`.

---

## Page Structure

### Contact Cards
Pre-filled from the case's Primary and Secondary contacts. Phone and email fields are **editable** — staff can correct them right there for this send without modifying the contact record in the database.

### Send Settings Bar
- **Send to:** checkboxes for Primary and Secondary (Secondary only visible if one exists)
- **Method:** SMS and/or Email checkboxes (both default on)
- **SMS from:** dropdown populated from `phone_lines` table, preselects current user's `default_phone`
- **Email from:** dropdown populated from `email_credentials` table, preselects current user's `default_email`

### Action Items
Each is a checkbox section. Checking it enables that action on send. Multiple can be selected simultaneously — they send independently.

| Action | SMS Behavior | Email Behavior |
|--------|-------------|----------------|
| Credit Counseling Info | MMS with image attachment | Email with image attached |
| SOS Title Instructions | SMS with link to PDF | Email with PDF attached |
| IRS.GOV / ID.ME Instructions | MMS with video attachment + PDF link | Email with video + PDF attached |
| Documents Needed | Composed bullet list (split into chunks if >600 chars) | HTML list with doc items |
| Allan Anchill | Canned message with phone number | Same message |
| Detailed BK Questionnaire | Link to questionnaire | Link to questionnaire |
| Other Message | Free text textarea | Subject + Quill rich text editor |
| Contract | Placeholder — not yet wired | — |

### Documents Needed Sub-Checklist
The largest section. Each doc item is a checkbox. Some have sub-selectors that expand directly beneath them when checked:

| Doc Item | Sub-Selector |
|----------|-------------|
| Pay stubs / proof of income | "From" month dropdown |
| Spouse's pay stubs | "From" month dropdown |
| Tax Returns | Year × Type grid (Federal/State rows, year columns) |
| IRS.GOV documents | Year checkboxes (current year down to 2015) |
| Bank statements | "From" month dropdown + bank checkboxes (25+ banks + "Other") |
| Property Deed | Address text field |
| Other Documents | Free text field |

Two items are checked by default: "Photo of government ID" and "Pay stubs."

At the bottom, a radio group controls the instruction paragraph appended to the message: "Send to DOCS@4LSG or portal" (default, includes case-specific portal link), "Send .PDF to DOCS@4LSG", or "Neither."

### Preview
The "Preview Message" button calls the compose endpoint and displays the full assembled message. Warnings appear if a doc item was checked but its required sub-selector was left empty (e.g., Tax Returns checked but no years selected). These items are skipped from the message.

### Send
Confirmation dialog → sends each action type to each selected recipient via selected methods → shows success/error summary with checkmarks. Warnings trigger a "Send anyway?" dialog before proceeding.

---

## Backend Routes

All in `routes/api.sending.js`. Mount with `app.use('/', require('./routes/api.sending'))`.

### GET /api/phone-lines
Returns active phone lines from `phone_lines` table: `{ lines: [{ id, phone_number, display_name, provider }] }`.

### GET /api/email-from
Returns email sender addresses from `email_credentials` table: `{ emails: [{ id, email, from_name, provider }] }`.

### GET /api/users/me
Returns current user's defaults based on JWT: `{ user: { user, user_name, email, default_phone, default_email } }`.

### POST /api/compose-docs-message
Server-side message assembly. Takes raw checkbox selections and returns composed messages.

**Body:**
```json
{
  "docs": ["Photo of government issued ID...", "Tax Returns", "PDF copies of bank statements"],
  "income_from": "January",
  "tax_federal": ["2023", "2024"],
  "tax_state": ["2024"],
  "irs_years": ["2024", "2023"],
  "bank_from": "February",
  "banks": ["Chase", "Comerica"],
  "property_address": "123 Main St",
  "other_docs_text": "",
  "send_docs_to": "portal",
  "case_id": "uT7EU36v"
}
```

**Response:**
```json
{
  "status": "success",
  "sms": "HOMEWORK ASSIGNMENT\nWe need the following documents:\n\n• Photo of...\n• Federal tax returns for 2023 and 2024\n...\n\nPlease send the requested documents to DOCS@4LSG.COM or use our secure document upload portal at app.4lsg.com/docReq?case=uT7EU36v . Thanks!",
  "email_text": "...",
  "email_html": "<h3>Homework Assignment</h3><ul>...</ul><p><strong>Please send... <a href='...'>secure document upload portal</a>...</strong></p>",
  "checklist_items": ["Photo of...", "Federal tax returns for 2023 and 2024", "..."],
  "warnings": ["IRS.GOV checked but no years selected"]
}
```

The compose endpoint handles all the string building: pay stubs from-month insertion, tax year formatting ("Federal tax returns for 2023 and 2024"), IRS year formatting ("for the years 2024, 2023 and 2022"), bank list formatting ("Chase, Comerica & Bank One"), property deed with address, and the portal link paragraph.

### POST /internal/mms/send
JWT-authenticated MMS sending. In `routes/internal.mms.js`. Mount with `app.use('/', require('./routes/internal.mms'))`.

**Body:** `{ from, to, text, attachment_url }`

Validates that `from` is an active RingCentral number in `phone_lines`. URL-only — no file upload. Delegates to `ringcentralService.sendMms()`.

---

## Database Changes

Migration: `migrations/sending_form_setup.sql`

1. `email_credentials` — added `id` auto-increment column (email remains unique key)
2. `users` — added `default_phone` (char 10) and `default_email` (varchar 255) for preselecting from dropdowns

---

## On Send: What Happens

1. **Credit Counseling** → MMS via `/internal/mms/send` + email via `/internal/email/send` (with attachment)
2. **SOS Title** → SMS via `/internal/sms/send` (link in text) + email with PDF attached
3. **IRS/ID.ME** → MMS via `/internal/mms/send` (video attached, PDF link in text) + email with both files attached
4. **Documents Needed** → compose via `/api/compose-docs-message` → checklist upsert via `/checklists/upsert-items` → SMS (split into 600-char chunks) + email (HTML formatted)
5. **Allan Anchill** → SMS + email with canned message
6. **Questionnaire** → SMS + email with link; optionally enrolls in reminder sequence via `/internal/sequence/enroll`
7. **Other** → SMS from textarea + email from Quill editor

SMS sends are logged automatically by the SMS service. Emails are logged by the email service. The checklist upsert creates trackable items for the docs request.

---

## Cloning for Other Case Types

The sending form is built for bankruptcy cases but the structure is modular. To create a version for a different case type:

1. **Copy `sendingform.html`** to e.g. `sendingform-debt.html`
2. **Modify the action sections** — add/remove checkbox sections in the HTML
3. **Update `collectActions()`** — add/remove action types
4. **Update the preview function** — add preview lines for new actions
5. **Update the send function** — add send blocks for new actions
6. **Optionally update the compose endpoint** — if the new case type has its own doc checklist, you could add a `case_type` parameter to the compose endpoint, or create a separate compose endpoint

The infrastructure is fully reusable: contact cards, send settings, from dropdowns, preview/send flow, SMS splitting, MMS sending, email with attachments.

---

## Deferred / Future Items

- **Contract section** — placeholder in the UI, not yet wired
- **Questionnaire reminder sequence** — the enrollment call is wired but the sequence template needs to be built
- **Template system** — the compose endpoint could evolve into a template system where doc lists are stored in the database rather than hardcoded in HTML, enabling non-developers to modify the checklist
- **SMS character counting** — could add a live character counter showing how many SMS chunks the message will split into
