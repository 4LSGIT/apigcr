# Part 3 — YCForm Config Reference

Every form creates `new YCForm(config)`. This page documents every option.

---

## Identity

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `formKey` | string | `''` | Unique form identifier. Stored in `form_submissions.form_key`. |
| `schemaVersion` | number | `1` | Increment when fields change. Stored with drafts/submissions. |
| `linkType` | string | `''` | Entity type: `'contact'`, `'case'`, `'appt'` |
| `linkId` | string | `''` | Entity ID. Usually from URL params. |
| `container` | string | `''` | CSS selector for the `<form>` element. |

## Behavior

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataMode` | string | `'live'` | `'live'` = always from entity table. `'snapshot'` = from latest submission once one exists. See [06-data-modes.md](06-data-modes.md). |
| `autosave` | boolean | `false` | Enable draft autosave to `form_submissions` table. |
| `autosaveMs` | number | `3000` | Debounce interval in ms before autosave fires. |
| `readonly` | boolean | `true` | Start in view mode. |
| `external` | boolean | `false` | Use `fetch()` instead of `P.apiSend()`. For future client-facing forms. |
| `baseUrl` | string | `''` | Base URL for API calls in external mode. |

## Fields

Maps form field names to DOM elements and behavior.

```js
fields: {
  fname:        { el: '[name="fname"]',   type: 'text' },
  phone:        { el: '[name="phone"]',   type: 'text' },
  status:       { el: '[name="status"]',  type: 'select' },
  dob:          { el: '[name="dob"]',     type: 'date' },
  notes:        { el: '[name="notes"]',   type: 'textarea' },
  tags:         { el: '[name="tags"]',    type: 'tags' },
  married:      { el: '[name="married"]', type: 'checkbox' },
  method:       { el: '[name="method"]',  type: 'radio' },
  missing_docs: { el: '[data-yc-checkgroup="missing_docs"]', type: 'checkgroup' },
  case_id:      { el: '[name="case_id"]', type: 'text', readonly: true },
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `el` | string | Yes | CSS selector for the DOM element. |
| `type` | string | Yes | See [05-field-types.md](05-field-types.md). |
| `readonly` | boolean | No | Always non-editable, even in edit mode. Excluded from PATCH payload. |

**All fields are collected on save**, including hidden and readonly. Readonly fields are excluded from the PATCH payload but included in form_submissions data.

## Repeaters

```js
repeaters: {
  vehicles: {
    container: '#vehicles-repeater',
    template:  '#vehicle-template',
    fields: {
      model:     { type: 'text' },
      year:      { type: 'number' },
      ownership: { type: 'select' },
    }
  }
}
```

Data collected as `{ "vehicles": [ { "model": "Camry", "year": 2019 }, ... ] }`. See [09-advanced-features.md](09-advanced-features.md).

## Validation

Only blocks explicit save — never blocks autosave.

```js
validation: {
  case_type: { required: true },
  phone:     { required: true, mask: 'phone' },
  email:     { email: true },
  notes:     { maxLength: 2000 },
  custom_field: { custom: (val, allVals) => val < 0 ? 'Must be positive' : true }
}
```

Rules: `required`, `minLength`, `maxLength`, `email`, `pattern` (+`patternMessage`), `mask`, `custom`. See [08-validation-and-saving.md](08-validation-and-saving.md).

## Endpoints

```js
endpoints: {
  load: { method: 'GET', url: '/api/contacts/{linkId}', path: 'contact' }
}
```

`path` is optional — extracts a nested key from the API response (e.g., `GET /api/contacts/:id` returns `{ contact: {...}, cases: [...] }`, `path: 'contact'` extracts the contact object). URL placeholders: `{linkId}`, `{linkType}`, `{formKey}`.

**The `path` key doubles as the `window.parent.entityData` lookup key.** When a form is hosted inside `case2.html` or `contact2.html`, `yc-forms.js` first checks `window.parent.entityData[endpoints.load.path]` — if present, it uses that data without making an API call. This is how the parent-as-data-source pattern works. See [10-hosting-and-wiring.md](10-hosting-and-wiring.md).

## apiMap

Maps API response keys to form field names (bidirectional).

```js
apiMap: {
  'contact_fname': 'fname',    // API → form (on load)
  'contact_phone': 'phone',    // form → API (on save, reversed)
}
```

Not needed if API keys match form field names exactly.

## onSubmit

```js
onSubmit: {
  patch:    { method: 'PATCH', url: '/api/contacts/{linkId}' },  // optional
  workflow: { id: 12, initData: { source: 'form' } },           // optional
}
```

Both are optional and can be combined. The form_submissions insert always happens regardless.

Workflow receives all `collect()` values as top-level variables (e.g., `{{outcome}}`, `{{missing_docs}}`), plus `form_key`, `link_type`, `link_id`, `submission_id`, plus anything in `initData`.

## Callbacks

```js
onLoad:  async (data) => { },  // after form is populated (can be async)
onSave:  (result) => { },      // after successful save; result = { id, version, updated_at }
onError: (err) => { },         // on any init or save error
```

`onLoad` is `await`ed — async operations (like resolver calls) complete before the loading overlay dismisses.

`onLoad` can access the full API response via `form._loadResult` for extra data beyond what `path` extracts (e.g., clients array, appointments).

**`onSave` is for form-specific custom logic only.** The framework has already sent the `form-saved` postMessage to the parent by the time `onSave` fires. Do NOT add `P.postMessage({ type: 'form-saved', ... })` here — it causes the parent to run `refreshEntityData` twice, which can clobber unsaved state in sibling form iframes. Use `onSave` for things like analytics events, triggering a local UI reaction, or calling another form's refresh — not for parent notifications.

---

## Behavior Notes

### Always-edit forms (no toggle)
Set `readonly: false`. Hide the toggle div in HTML with `style="display:none;"`. Make the save button always visible (remove `style="display:none;"` from it). After save, the form stays in edit mode.

### Custom PATCH payloads
Override `form._buildPatchPayload` after creating the YCForm instance to control exactly which fields and column names go to the PATCH endpoint. Used when form field names don't match DB columns or when only some fields should be PATCHed:

```js
form._buildPatchPayload = function() {
  const diff = this.getDiff();
  const payload = {};
  const map = { 'vehicle': 'case_issues_bk_vehicle', 'first_course': 'case_1st_course' };
  for (const [fieldName, [_old, newVal]] of Object.entries(diff)) {
    if (this.config.fields[fieldName]?.readonly) continue;
    payload[map[fieldName] || fieldName] = newVal;
  }
  return payload;
};
```

### Hidden fields for workflow data
Use `<input type="hidden">` fields with `readonly: true` to pass data to workflows without displaying it. Populate in `onLoad`. The values flow through `collect()` into workflow variables automatically.

### Accessing the form instance from the parent
`yc-forms.js` assigns `window.ycForm = this` in the YCForm constructor. Scope is per-iframe (no cross-iframe collision — each iframe has its own `window`). Parent pages use this to check `isDirty()` and push fresh data into non-dirty forms during the refresh-after-save flow.