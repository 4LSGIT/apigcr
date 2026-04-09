# Part 9 — Advanced Features

---

## Repeater Sections

Repeaters are sections that can be duplicated — vehicles, creditors, bank accounts, etc.

### HTML

```html
<div class="yc-repeater" id="vehicles-repeater">
  <div class="yc-section-title">Vehicles</div>
  <!-- Items inserted here by JS -->
  <button type="button" class="yc-repeater-add" data-repeater="vehicles">+ Add Vehicle</button>
</div>

<template id="vehicle-template">
  <div class="yc-repeater-item">
    <div class="yc-row">
      <div class="yc-field yc-2x">
        <label class="yc-label">Make / Model</label>
        <input type="text" name="model">
      </div>
      <div class="yc-field yc-fixed-sm">
        <label class="yc-label">Year</label>
        <input type="number" name="year" min="1900" max="2099">
      </div>
      <div class="yc-field">
        <label class="yc-label">Ownership</label>
        <select name="ownership">
          <option value="">Select...</option>
          <option value="owned_free">Owned free & clear</option>
          <option value="financed">Financed</option>
          <option value="leased">Leased</option>
        </select>
      </div>
      <button type="button" class="yc-repeater-remove" title="Remove">✕</button>
    </div>
  </div>
</template>
```

### Config

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

### Data Format

Collected as an array of objects:
```json
{ "vehicles": [ { "model": "Toyota Camry", "year": 2019, "ownership": "financed" } ] }
```

On `populate()`, matching arrays auto-create and fill items.

### Behavior

- **Add** clones the `<template>` and inserts before the Add button
- **Remove** — each item has a ✕ button
- **View mode** — Add and Remove buttons hidden
- **Dirty checking** — adding/removing triggers autosave
- **No limit** — add as many as needed (some contacts may have zero)

---

## Conditional Logic

Show or hide form sections based on other field values.

### HTML

```html
<div class="yc-row" data-yc-show-when="marital_status" data-yc-show-value="Married">
  <div class="yc-field">
    <label class="yc-label">Co-Debtor Name</label>
    <input type="text" name="codebtor_name">
  </div>
</div>
```

### Supported Conditions

| Attribute | Shows when |
|-----------|-----------|
| `data-yc-show-value="X"` | Field equals X |
| `data-yc-show-value="!X"` | Field does NOT equal X |
| `data-yc-show-value="*"` | Field is non-empty |
| `data-yc-show-values="X,Y,Z"` | Field matches any value in the list |

### Important

- Evaluated on load and on every change
- Hidden elements get `display: none`
- **Hidden field data IS still collected and submitted** — visibility is UI-only, not a data concern

---

## Tabs

For multi-section forms, tabs organize content without scrolling.

### HTML

```html
<div class="yc-tabs">
  <div class="yc-tab-bar">
    <button class="active">General</button>
    <button>Financial</button>
    <button>Documents</button>
  </div>
  <div class="yc-tab-panel active"><!-- General --></div>
  <div class="yc-tab-panel"><!-- Financial --></div>
  <div class="yc-tab-panel"><!-- Documents --></div>
</div>
```

### Setup

```js
form.init().then(() => {
  form.setupTabs('.yc-tab-bar', '.yc-tab-panel');
});
```

### Tab-Sticky Content

Stays visible regardless of which tab is active:

```html
<div class="yc-tab-sticky">
  <div class="yc-row">
    <div class="yc-field yc-field-locked">
      <label class="yc-label">Case Number</label>
      <input type="text" name="case_number">
    </div>
  </div>
</div>
```

All tabs' data is collected on save/autosave — not just the active tab.

---

## Tags Input

Pill-based tag editor replacing comma-separated text with colored interactive pills.

### HTML

```html
<div class="yc-field">
  <label class="yc-label">Tags</label>
  <input type="hidden" name="tags">
</div>
```

### Config

```js
tags: { el: '[name="tags"]', type: 'tags' }
```

### How It Works

1. Hidden input kept but hidden; a `.yc-tags-wrap` container appears next to it
2. Existing tags from the comma-separated string render as colored pills
3. Type a tag → press **Enter** or **comma** → pill appears
4. **Backspace** on empty input removes the last pill
5. Click **×** to remove any pill
6. Duplicates (case-insensitive) silently rejected

### Colors

Deterministic from a hash of the tag text — same tag always gets the same color from a palette of 10 soft backgrounds. Consistent across all forms and contacts.

### Data Format

Stored as a comma-separated string: `"sandwichcrafter,blue,tag2"`. Database column unchanged.

### View Mode

Input and × buttons hidden. Only colored pills display.
