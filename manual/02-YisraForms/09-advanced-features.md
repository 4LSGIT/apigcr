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

---

## Checkgroup (Multi-Select Checkbox Groups)

For MySQL SET columns and any multi-select that stores as a comma-separated string.

### HTML

```html
<div class="yc-check-grid" data-yc-checkgroup="missing_docs">
  <label><input type="checkbox" value="2024 Tax Return"> 2024 Tax Return</label>
  <label><input type="checkbox" value="Bank Statements"> Bank Statements</label>
  <label><input type="checkbox" value="Pay Stubs"> Pay Stubs</label>
  <label><input type="checkbox" data-yc-other value="Other"> Other</label>
  <div class="yc-other-text" id="otherDiv" style="display:none;">
    <input type="text" data-yc-other-text placeholder="Specify other">
  </div>
</div>
```

### Config

```js
missing_docs: { el: '[data-yc-checkgroup="missing_docs"]', type: 'checkgroup' }
```

### "Other" checkbox

When a checkbox has `data-yc-other`, checking it shows the `.yc-other-text` div (which contains an input with `data-yc-other-text`). The text value is appended to the comma-separated string.

On populate, if a value doesn't match any checkbox, it's treated as "Other" — the Other checkbox is auto-checked and the text input is filled.

The Other text div visibility is managed by `_setCheckgroup` automatically — on populate, it shows/hides based on whether Other values exist. For future user clicks, add a toggle listener in your form script:

```js
const otherCb = container.querySelector('input[data-yc-other]');
otherCb.addEventListener('change', () => {
  document.getElementById('otherDiv').style.display = otherCb.checked ? '' : 'none';
});
```

### Grid layout

`.yc-check-grid` defaults to 3 columns. Override inline for different layouts:
- `style="grid-template-columns: 1fr;"` — single column (vertical stack)
- `style="grid-template-columns: 1fr 1fr;"` — two columns

Collapses to 1 column on mobile automatically.

### Updating options

When checkbox options change (e.g., adding a new tax year), just edit the HTML and bump `schemaVersion`. Old submissions with removed values will show them in the "Other" text field — data is never lost.

---

## Locked Field Messages

When a user clicks a locked field in edit mode, an info toast explains why the field can't be edited.

### HTML

```html
<input type="text" name="case_id" data-yc-locked-msg="The Case ID cannot be changed">
<input type="text" name="debtor_name" data-yc-locked-msg="Edit the client name from the Contact page">
<input type="datetime-local" name="case_341_current" data-yc-locked-msg="The 341 date is managed via the 341 Notes form">
```

No config needed — just add the `data-yc-locked-msg` attribute to any input inside a `.yc-field-locked` wrapper. `yc-forms.js` sets up the click handlers automatically during `init()`.

Only fires in edit mode. In full readonly mode (view mode), everything is locked so there's no need to explain individual fields.

---

## Snapshot Banner

For snapshot-mode forms (`dataMode: 'snapshot'`), a persistent blue info bar appears when a submission exists:

```
📋 Version 2 — Submitted by Stuart on 4/7/2026 at 3:15 PM
```

- Always visible, not dismissible — different from the draft recovery banner
- Updates after each save with the new version number
- Only appears for snapshot-mode forms
- Created dynamically by `yc-forms.js` — no HTML needed

---

## Auto-Calculated Date Fields

For forms with derived date fields (like "Objection Deadline = Initial 341 + 60 days"), add calculation logic in the form's `init().then()` block:

```js
form.init().then(() => {
  const rules = [
    { source: '[name="case_341_initial"]', target: '[name="case_objection"]',
      calc: v => addDays(v, 60) },
    { source: '[name="case_file_date"]',   target: '[name="case_180"]',
      calc: v => addDays(v, 180) },
  ];

  // Fill empty targets on load
  rules.forEach(({ source, target, calc }) => {
    const srcEl = document.querySelector(source);
    const tgtEl = document.querySelector(target);
    if (srcEl && tgtEl && !tgtEl.value && srcEl.value) tgtEl.value = calc(srcEl.value);
  });

  // Recalculate when source changes
  rules.forEach(({ source, target, calc }) => {
    document.querySelector(source)?.addEventListener('change', () => {
      document.querySelector(target).value = calc(document.querySelector(source).value);
    });
  });
});
```

This is form-specific logic, not built into `yc-forms.js`. Calculated fields are still editable — users can override for court extensions or special circumstances.
