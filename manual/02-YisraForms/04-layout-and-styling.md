# Part 4 — Layout & Styling

All form layout is handled by CSS classes in `yc-forms.css`. No JavaScript needed — just add the right classes to your HTML.

---

## The Form Wrapper

```html
<form id="myForm" class="yc-form">
  <!-- everything inside here -->
</form>
```

`.yc-form` provides: white background, rounded corners, shadow, padding, max-width 900px, centered.

---

## Rows and Fields

The basic building block is a `.yc-row` containing one or more `.yc-field` elements. Fields share space equally by default.

```html
<div class="yc-row">
  <div class="yc-field">
    <label class="yc-label">First Name</label>
    <input type="text" name="fname">
  </div>
  <div class="yc-field">
    <label class="yc-label">Last Name</label>
    <input type="text" name="lname">
  </div>
</div>
```

Two equal-width fields side by side. On mobile (below 600px), they stack vertically.

### Width Modifiers

| Class | Effect |
|-------|--------|
| `.yc-field` | Default: `flex: 1` (equal share) |
| `.yc-field.yc-2x` | `flex: 2` — double width |
| `.yc-field.yc-3x` | `flex: 3` — triple width (for full-row fields) |
| `.yc-field.yc-fixed-sm` | Fixed ~120px (state codes, short fields) |
| `.yc-field.yc-fixed-md` | Fixed ~200px (zip codes, dates) |

**Example — address row:**

```html
<div class="yc-row">
  <div class="yc-field yc-2x">
    <input type="text" name="city" placeholder="City">
  </div>
  <div class="yc-field yc-fixed-sm">
    <input type="text" name="state" placeholder="State">
  </div>
  <div class="yc-field yc-fixed-md">
    <input type="text" name="zip" placeholder="ZIP">
  </div>
</div>
```

---

## Sections

Group related fields with a section title:

```html
<div class="yc-section">
  <div class="yc-section-title">Address</div>
  <div class="yc-section-subtitle">Primary mailing address</div>
  <div class="yc-row"><!-- fields --></div>
</div>
```

---

## Labels and Helpers

| Class | Purpose |
|-------|---------|
| `.yc-label` | Bold label above the input |
| `.yc-required` | Red asterisk: `<span class="yc-required">*</span>` inside a label |
| `.yc-sublabel` | Gray helper text below the input |
| `.yc-error` | Red error text — hidden by default, shown by validation |
| `.yc-char-counter` | Auto-injected by JS for any textarea with a `maxlength` attribute |

---

## Buttons

| Class | Style |
|-------|-------|
| `.yc-btn` | Base button |
| `.yc-btn-primary` | Green (#28a745) — save/submit |
| `.yc-btn-secondary` | Gray outline — cancel/discard |
| `.yc-btn-danger` | Red — destructive actions |
| `.yc-btn-sm` | Smaller size |
| `.yc-btn-block` | Full width with top margin |

---

## State Classes

Applied by `yc-forms.js` automatically:

| Class | Applied to | Effect |
|-------|-----------|--------|
| `.yc-readonly` | `.yc-form` | All inputs non-interactive (view mode) |
| `.yc-dirty` | `.yc-form` | Unsaved changes exist |
| `.yc-field.yc-changed` | `.yc-field` | Value differs from loaded data — blue left-border accent |
| `.yc-field-locked` | `.yc-field` | Always non-interactive, even in edit mode |

---

## Responsive

At 600px and below: `.yc-row` stacks vertically, width modifiers reset to full width, radio groups go vertical, tab bars become scrollable. Built into `yc-forms.css` — no configuration needed.
