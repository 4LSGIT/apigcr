# 2 — Templates

## For operators

A **contract template** is the reusable half of a signature request: the
document, where each person signs, and which blanks get filled from the case.
Build it once, send it a hundred times.

**More → Signatures → Templates.**

A template carries:

| | |
|---|---|
| **Name and kind** | What it is and how it's categorized |
| **The document** | The PDF itself |
| **Placements** | Boxes on the page — signature, initials, date, text |
| **Prefill schema** | Which blanks fill from the case, and from what |
| **Filing subfolder** | Where the signed copy lands in Dropbox |
| **Expiration** | How long the client has |
| **Reminders** | Optional nudges — or off |

### Two kinds of box, and the difference matters

- **Signer fields** — signature, initials, date, and the interactive ones
  (free text, checkbox, dropdown, radio). These go to the provider, which draws
  them on the signing page for the client to act on.
- **Text fields** — filled in by *us*, before the document leaves the building.
  The provider never sees them. This is how a case number or a debtor's address
  gets onto the page.

The practical rule: **if the client should touch it, it's a signer field; if it
should already be filled in when they open it, it's a text field.**

### Errors surface when you save, not when you send

Every rule that can be checked without a case is checked at **save** time — an
unknown resolver, a placeholder you declared but never used, a malformed
placement. The person who can fix a template error is the person authoring it,
and they're looking at the editor right now. Not the staff member sending a
retainer three weeks later.

### Templates are never deleted

There's a **Deactivate** button and no delete. Signed requests point back at the
template they came from; deleting one would orphan the record of what was
actually signed. Deactivating takes it out of the picker and leaves the history
intact.

---

## Technical reference

### Placement schema

Neutral — no vendor coordinates. `services/esign/placements.js` is the
validator and *only* the validator; the Zoho coordinate transform stays in the
vendor file.

```js
{ coord_space: 'pdf_user_space',   // optional; the only accepted value
  fields: [ {
    page:   number,   // 1-BASED
    x:      number,   // points from the page's LEFT edge
    y:      number,   // points from the page's BOTTOM edge
    w:      number,
    h:      number,
    type:   'signature' | 'initial' | 'date' | 'text' |
            'input_text' | 'checkbox' | 'dropdown' | 'radio',
    signer: number,   // signer fields: matches Recipient.order (1-based)
    label:  string,   // signer fields except radio: what the SIGNER sees
    key:    string,   // TEXT fields: which prefill key fills this box
    font_size: number // TEXT fields, optional
  } ] }
```

Per-type extras, all signer-class: `max_length` (input_text, 1–2048),
`default` (input_text prefill the signer can edit; dropdown pre-selection, must
be one of `options`), `checked` (checkbox/radio), `options` (dropdown,
required), `group` + `value` (radio, both required; `value` unique in group).

> **Set `label` on signer fields.** Zoho renders the field name in the box, so
> without one the client sees `Signature_4`.

**The schema is validated twice, deliberately.** `esignSendService` validates
*before* `createRequest` so a bad placement never mints an orphan draft row;
`zohoSignProvider` validates again before the network call so a bad placement
never costs an API call or a credit.

### Text fields never leave the building

`services/esign/pdfFill.js` draws the resolved value into the box with `pdf-lib`
before the document is transmitted, and `neutralToZohoFields` skips text fields
entirely. A text field carries `key` (which prefill value fills it) where a
signer field carries `signer` (who acts on it).

### Prefill resolvers

A template's `prefill_schema` declares keys; each key may name a **resolver**.

**The whitelist is literal.** `RESOLVERS` is an explicit map from resolver
string to function. There is no dot-path evaluation and no dynamic property
walk — `debtor1.name` is an opaque *name* that happens to contain a dot, not a
path into anything. A resolver that isn't a key of that map does not exist, and
the template service rejects it at save time with `ESIGN_BAD_RESOLVER`.

| Group | Resolvers |
|---|---|
| `case` | `case_name`, `case_number`, `case_number_full`, `debtor_names`, `docket`, `chapter`, `open_date`, `file_date`, `judge`, `trustee` |
| `debtor1` / `debtor2` | `name`, `email`, `phone`, `address_street`, `address_csz`, `ssn_last4`, `ssn_masked` |
| `trustee` | `name`, `address_street`, `address_csz`, `phone`, `email` |
| `firm` | `name`, `phone`, `email`, `website`, `address`, `address_line1`, `address_line2` |
| `attorney` | `name` |

There is no full-SSN resolver, only `ssn_last4` and `ssn_masked` — the full
number cannot be placed on a document through this path at all.

Formatting helpers (`formatPhone`, `formatDate`, `formatMoney`, `formatNumber`)
normalize output so two templates don't render the same value differently.

### `contract_templates`

| Column | Purpose |
|---|---|
| `name`, `kind`, `template_type`, `purpose` | Identity and categorization |
| `body` | The document |
| `prefill_schema` | Declared keys → resolvers |
| `placement_json` | The placement schema above |
| `file_subfolder` | Where the signed copy is filed |
| `completion_targets` | What to do on completion |
| `reminder_seq_id`, `reminders_off` | Reminder sequence, or explicitly none |
| `expiration_days` | Client's window |
| `active` | The soft-delete flag — there is no hard delete |

`esignTemplateService` is the **only writer**; readers are
`esignSendService.sendFromTemplate` and the template routes.

### Kinds are free vocabulary

Templates may declare kinds beyond the four built-ins (≤64 chars, non-empty).
The send-time legal set is the union, computed by
`esignSendService.legalKinds()` consulting `listActiveTemplateKinds()`.
Dependency direction is one-way: send requires template, never the reverse.
