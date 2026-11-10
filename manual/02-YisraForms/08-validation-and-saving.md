# Part 8 — Validation & Saving

---

## Validation

Validation only runs on explicit save — never on autosave. Drafts can contain incomplete or invalid data.

### How It Works

1. User clicks Save
2. `validate()` runs all rules from the `validation` config
3. Failing fields show their `.yc-error` element with the error message
4. If any field fails, the save is aborted
5. On the next save attempt, all errors are cleared first, then re-evaluated

### Defining Rules

```js
validation: {
  case_type: { required: true },
  phone:     { required: true, mask: 'phone' },
  email:     { email: true },
  notes:     { maxLength: 2000 },
  custom_field: {
    custom: (value, allValues) => {
      if (value < 0) return 'Must be positive';
      return true;
    }
  }
}
```

Rules check in order: `required` → `minLength` → `maxLength` → `email` → `pattern` → `mask` → `custom`. First failure stops — one error per field.

### Error Display

Every validatable field needs a `.yc-error` element:

```html
<div class="yc-field">
  <label class="yc-label">Phone <span class="yc-required">*</span></label>
  <input type="text" name="phone" data-yc-mask="phone">
  <small class="yc-error"></small>
</div>
```

Hidden by default, gets `.visible` class on failure. Always hidden in view mode.

---

## The Save Flow

When the user clicks Save, `form.save()` runs:

```
 1. Guard check — if already saving, return (prevents double-click)
 2. Validate — if fails, show errors, return
 3. getDiff() — if no changes, toast "No changes to save", return
 4. Show loading overlay (blocks UI, gives visual feedback)
 5. PATCH to entity table (if onSubmit.patch configured)
      → only changed fields, excluding readonly fields
      → field names mapped back via apiMap or _buildPatchPayload
 6. POST /api/forms/submit — record in form_submissions
      → always happens; version auto-increments
 7. DELETE /api/forms/draft — remove the now-superseded draft row
      → fire-and-forget — a failure doesn't fail the save
 8. Trigger workflow(s) (onSubmit.workflows, 1–3, or the legacy onSubmit.workflow)
      → POST /workflows/:id/start per entry, fire-and-forget — doesn't block the save
 9. POST /api/log — audit entry with change diff
      → non-blocking — failure doesn't fail the save
10. Reset state — update snapshot, clear dirty markers
11. Return to view mode (if form uses the view/edit toggle)
12. Success toast
13. Framework side-effects (fires last):
      a. Call user's onSave(submitResult) callback — for form-specific logic only
      b. Send postMessage({ type: 'form-saved', form, linkType, linkId }) to parent
         — unless external mode
         — this is the ONLY place this postMessage is sent
14. finally: clear loading overlay and saving guard
```

If steps 5–6 fail: error toast, loading dismissed, guard cleared.

External mode (public links) replaces steps 5–9 with one POST to the external
submit route, which re-validates and starts the workflows server-side
([15-external-forms.md](15-external-forms.md)).

**Important — postMessage ownership.** Step 13b is the framework's job. Forms must not send their own `form-saved` postMessage from within `onSave` — doing so causes the parent to run `refreshEntityData` twice in quick succession, which can clobber sibling forms' unsaved state during the push-back phase.

---

## The PATCH Payload

Only changed, non-readonly fields are sent. Field names are mapped back through `apiMap`:

```js
// User changed fname "Fred" → "Frederick" and phone "" → "3135551234"
// PATCH /api/contacts/1001:
{
  "contact_fname": "Frederick",
  "contact_phone": "3135551234"
}
```

Mask formatting is stripped — raw values sent (`3135551234`, not `(313) 555-1234`).

---

## Workflow Triggers

```js
onSubmit: {
  workflows: [{ id: 12, initData: { source: 'form' } }],   // 1–3 entries
  pdf: true,                                              // optional
}
```

Each workflow's init data is the form's field values (top level, so `{{fieldName}}`
works), then that entry's `initData`, then the system fields, which win any name
clash: `form_key`, `form_title` (the template's title), `link_type`, `link_id`,
`submission_id`, `make_pdf` (`onSubmit.pdf`, always true or false) and `_values`
(all the field values as one object). Each start is fire-and-forget and
independent — one failing never fails the save or its siblings. The legacy
singular `onSubmit.workflow` is one entry.

---

## Audit Logging

Every save writes to the `log` table:

```json
{
  "type": "form",
  "link_type": "contact",
  "link_id": "1001",
  "data": "{\"form_key\":\"contact_info\",\"action\":\"form_submit\",\"version\":3,\"changes\":\"{...}\"}"
}
```

The `changes` field contains only modified fields as `{ fieldName: [oldValue, newValue] }`. Non-blocking.

---

## Submitting a Stored Draft from the Server

`POST /api/forms/submissions/submit-draft` runs this whole flow on the server for a
draft that is already saved — for Ask Casey and any caller without the form open.
Body `{ submission_id, expected_updated_at? }` (the draft row's id; the optional
`updated_at` refuses the submit with 409 when the draft was saved again since it
was read). A signed-in user only — an API key gets 403.

In the page's order: the published template's validation (the external route's
validator — 400 naming the first failing field by key and label), the PATCH of
the apiColumn changes, the submission row, the draft delete, the workflows, the
log entry. The PATCH is worked out the way the page works it out — the draft
against the form as it would load (the record's current row, or the latest
submission for a snapshot form) — and written through the same writer as the
PATCH route, so the docket guard, note limits and `case.updated` all apply. Two
differences from the button: a draft equal to the record still submits (only the
PATCH is skipped), and a draft saved under an older version of the form is
refused (409) instead of re-rendered — re-save it on the current version first.
The answer reports every outcome (`patched`, `draft_deleted`, `workflows[]`,
`log_id`); a second call for the same draft is a 404, because the draft is gone.
Details: [11-api-reference.md](11-api-reference.md).

---

## Testing Checklist

- [ ] Validation errors shown on Save with invalid data
- [ ] Validation does NOT prevent draft autosave
- [ ] Save button cannot be double-clicked (loading overlay blocks)
- [ ] PATCH contains only changed, non-readonly fields with API column names
- [ ] form_submissions row created with correct version
- [ ] Log entry created with change diff
- [ ] Form returns to view mode after save
- [ ] Success toast on success, error toast on failure
- [ ] Parent page receives exactly ONE `form-saved` postMessage (not two)