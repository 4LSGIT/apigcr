# Part 5 — Field Types

Every field in the `fields` config has a `type` property that determines how it's populated, collected, and displayed.

---

## Standard Types

### `text`
Standard text input.
```html
<input type="text" name="fname" placeholder="First name">
```
```js
fname: { el: '[name="fname"]', type: 'text' }
```

### `textarea`
Multi-line text. If the element has a `maxlength` attribute, a character counter is auto-injected — no config needed.
```html
<textarea name="notes" rows="4" maxlength="1000"></textarea>
```
```js
notes: { el: '[name="notes"]', type: 'textarea' }
```

### `select`
Dropdown. Options defined in HTML.
```html
<select name="case_type">
  <option value="">Select...</option>
  <option value="Bankruptcy - Ch. 7">Bankruptcy - Ch. 7</option>
</select>
```
```js
case_type: { el: '[name="case_type"]', type: 'select' }
```

### `date`
Uses `<input type="date">`. YCForm normalizes Date objects, ISO strings, and YYYY-MM-DD strings from the API automatically.
```html
<input type="date" name="dob">
```
```js
dob: { el: '[name="dob"]', type: 'date' }
```

### `checkbox`
Single checkbox. Collected as `true`/`false`.
```html
<div class="yc-check">
  <input type="checkbox" name="confirmed" id="confirmed">
  <label for="confirmed">Confirmed</label>
</div>
```
```js
confirmed: { el: '[name="confirmed"]', type: 'checkbox' }
```

### `radio`
Radio button group. The `el` selector matches one radio; YCForm finds all radios with the same `name`.
```html
<div class="yc-radio-group">
  <label><input type="radio" name="method" value="Telephone"> Telephone</label>
  <label><input type="radio" name="method" value="Zoom"> Zoom</label>
  <label><input type="radio" name="method" value="In-person"> In-person</label>
</div>
```
```js
method: { el: '[name="method"]', type: 'radio' }
```
Collected as the `value` of the checked radio, or `''` if none selected.

---

## Special Types

### `tags`
Pill-based tag editor. Replaces a hidden input with colored pills and a text input. Tags are stored as a comma-separated string. See [09-advanced-features.md](09-advanced-features.md) for full details.
```html
<input type="hidden" name="tags">
```
```js
tags: { el: '[name="tags"]', type: 'tags' }
```

---

## Input Masks

Masks format values for display and strip formatting when collecting raw data.

**Apply via HTML:**
```html
<input type="text" name="phone" data-yc-mask="phone">
```

**Or via validation config:**
```js
validation: { phone: { mask: 'phone' } }
```

### Available Masks

| Mask | Display | Raw value | Digits |
|------|---------|-----------|--------|
| `phone` | `(313) 555-1234` | `3135551234` | 10 |
| `ssn` | `123-45-6789` | `123456789` | 9 |
| `zip` | `48226` or `48226-1234` | `48226` or `482261234` | 5 or 9 |
| `ein` | `12-3456789` | `123456789` | 9 |
| `currency` | `$1,234.56` | `1234.56` | N/A |

Formatting is applied on blur. The raw value is what gets collected and sent in the PATCH payload.

---

## The `readonly` Property

```js
case_id: { el: '[name="case_id"]', type: 'text', readonly: true }
```

**Field-level readonly** (`readonly: true` in config) is different from **form-level readonly** (`setReadonly(true)`):

| Concept | Effect |
|---------|--------|
| Form-level readonly | Entire form non-interactive. Toggle shows "View Mode". |
| Field-level readonly | This field is ALWAYS non-interactive, even in edit mode. Gets `.yc-field-locked` class. |

Readonly fields are collected by `collect()` (so they appear in drafts and submissions) but excluded from the PATCH payload (they're never sent to the entity update endpoint).
