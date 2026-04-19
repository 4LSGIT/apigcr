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
 7. Trigger workflow (if onSubmit.workflow configured)
      → fire-and-forget — doesn't block the save
 8. POST /api/log — audit entry with change diff
      → non-blocking — failure doesn't fail the save
 9. Reset state — update snapshot, clear dirty markers
10. Return to view mode (if form uses the view/edit toggle)
11. Success toast
12. Framework side-effects (fires last):
      a. Call user's onSave(submitResult) callback — for form-specific logic only
      b. Send postMessage({ type: 'form-saved', form, linkType, linkId }) to parent
         — unless external mode
         — this is the ONLY place this postMessage is sent
13. finally: clear loading overlay and saving guard
```

If steps 5–6 fail: error toast, loading dismissed, guard cleared.

**Important — postMessage ownership.** Step 12b is the framework's job. Forms must not send their own `form-saved` postMessage from within `onSave` — doing so causes the parent to run `refreshEntityData` twice in quick succession, which can clobber sibling forms' unsaved state during the push-back phase.

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
  workflow: { id: 12, initData: { source: 'form' } },
}
```

The workflow receives: `form_key`, `link_type`, `link_id`, `submission_id`, `data` (full payload), plus anything in `initData`. Fire-and-forget — doesn't block the save.

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