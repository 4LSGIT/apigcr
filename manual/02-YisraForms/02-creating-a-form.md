# Part 2 — Creating a Form

Step-by-step guide to building a new form.

---

## Step 1: Create the HTML File

Create a file in `public/forms/`. Every form uses this skeleton:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Form Title</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"
        integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
  <link href="/css/yc-forms.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
</head>
<body>

<div class="yc-form-header">
  <div class="yc-toggle">
    <input class="form-check-input" type="checkbox" id="toggleBtn">
    <label class="form-check-label" for="toggleBtn" id="toggleLabel">View Mode</label>
  </div>
  <span class="yc-save-status" id="saveStatus"></span>
  <span class="yc-warning" id="warning">You must press SAVE to keep changes!</span>
</div>

<div class="yc-draft-banner" id="draftBanner" style="display:none;">
  <span>You have unsaved changes from <strong id="draftTimestamp"></strong></span>
  <button class="yc-btn yc-btn-sm yc-btn-primary" id="draftRestore">Restore</button>
  <button class="yc-btn yc-btn-sm yc-btn-secondary" id="draftDiscard">Discard</button>
</div>

<form id="myForm" class="yc-form">
  <!-- Your fields here -->
  <button type="button" class="yc-btn yc-btn-primary yc-btn-block" id="saveBtn" style="display:none;">Save</button>
</form>

<script src="/js/yc-forms.js"></script>
<script>
  const P = window.parent;
  const params = new URLSearchParams(location.search);
  const form = new YCForm({ /* config */ });
  form.init();
</script>
</body>
</html>
```

**Required element IDs:** `toggleBtn`, `toggleLabel`, `saveStatus`, `warning`, `draftBanner`, `draftTimestamp`, `draftRestore`, `draftDiscard`, `saveBtn`. These are hardcoded in `yc-forms.js`.

### Optional: waitForParent boot pattern

If the form reads from `P.firmData` or `P.entityData` during init, wrap `form.init()` in a boot loop so it waits for the parent to finish populating those:

```js
(function waitForParent() {
  if (P.apiSend && P.firmData && P.entityData) return form.init();
  setTimeout(waitForParent, 100);
})();
```

If the form only uses `P.apiSend`, calling `form.init()` directly is fine — `apiSend` is relayed before any iframe `src` is set by the parent.

---

## Step 2: Add Fields

Use `yc-*` CSS classes. See [04-layout-and-styling.md](04-layout-and-styling.md).

```html
<div class="yc-row">
  <div class="yc-field">
    <label class="yc-label">Case Type</label>
    <select name="case_type">
      <option value="">Select...</option>
      <option value="Bankruptcy - Ch. 7">Bankruptcy - Ch. 7</option>
    </select>
    <small class="yc-error"></small>
  </div>
  <div class="yc-field">
    <label class="yc-label">Notes</label>
    <textarea name="notes" rows="4" maxlength="2000"></textarea>
  </div>
</div>
```

---

## Step 3: Write the Config

```js
const form = new YCForm({
  formKey:       'case_basic',
  schemaVersion: 1,
  linkType:      'case',
  linkId:        params.get('case_id'),
  container:     '#myForm',
  dataMode:      'live',
  autosave:      true,
  readonly:      true,

  fields: {
    case_type: { el: '[name="case_type"]', type: 'select' },
    notes:     { el: '[name="notes"]',     type: 'textarea' },
  },

  validation: {
    case_type: { required: true },
  },

  endpoints: {
    load: { method: 'GET', url: '/api/cases/{linkId}', path: 'case' },
  },

  onSubmit: {
    patch: { method: 'PATCH', url: '/api/cases/{linkId}' },
  },
});
form.init();
```

See [03-ycform-config.md](03-ycform-config.md) for every option.

> **Do not add** `onSave: () => P.postMessage({ type: 'form-saved', ... })`. The framework sends this automatically at the end of every save. Adding it here causes the parent to refresh twice, which can overwrite unrelated unsaved state in sibling forms. Only use `onSave` for form-specific custom logic (analytics, UI reactions) — not for parent notifications.

---

## Step 4: Wire Into Parent Page

In the parent (e.g., `case2.html`):

```js
// Relay apiSend and firmData from a.html (near top of script)
window.apiSend  = P.apiSend;
window.firmData = P.firmData;

// Load the form
document.getElementById("myIframe").src = `forms/casebasic.html?case_id=${caseId}`;
```

The parent doesn't need to add its own `message` listener for `form-saved` — `case2.html` and `contact2.html` already have a centralized listener that calls `refreshEntityData()` on any save, which updates `window.entityData` and pushes fresh data into all non-dirty sibling form iframes.

See [10-hosting-and-wiring.md](10-hosting-and-wiring.md) for full details.