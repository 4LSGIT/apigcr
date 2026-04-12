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
  fname:   { el: '[name="fname"]',   type: 'text' },
  phone:   { el: '[name="phone"]',   type: 'text' },
  status:  { el: '[name="status"]',  type: 'select' },
  dob:     { el: '[name="dob"]',     type: 'date' },
  notes:   { el: '[name="notes"]',   type: 'textarea' },
  tags:    { el: '[name="tags"]',    type: 'tags' },
  married: { el: '[name="married"]', type: 'checkbox' },
  method:  { el: '[name="method"]',  type: 'radio' },
  case_id: { el: '[name="case_id"]', type: 'text', readonly: true },
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

Workflow receives: `form_key`, `link_type`, `link_id`, `submission_id`, `data`, plus anything in `initData`.

## Callbacks

```js
onLoad:  (data) => { },       // after form is populated
onSave:  (result) => { },     // after successful save; result = { id, version, updated_at }
onError: (err) => { },        // on any init or save error
```

`onSave` is commonly used for `P.postMessage({ type: 'form-saved', form: 'my_form' }, '*')`.
