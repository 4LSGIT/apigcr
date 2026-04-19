# Part 1 — Overview

## What YisraForms Is

YisraForms is an internal form system that replaces JotForm across YisraCase. Instead of embedding third-party forms via URL query strings, forms are standalone HTML pages that load inside iframes, fetch their own data from the API, and save via the same REST endpoints the rest of the app uses.

Every form uses two shared files — `yc-forms.css` for styling and `yc-forms.js` for behavior — so building a new form is mostly writing HTML and a small config block.

---

## Architecture — The Four Layers

| Layer | File | Purpose |
|-------|------|---------|
| **CSS** | `public/css/yc-forms.css` | Shared component styles — rows, fields, buttons, toggle, draft banner, tags, repeaters, tabs, loading, toasts |
| **JS** | `public/js/yc-forms.js` | The `YCForm` class — init, populate, collect, validate, autosave, save, masks, dirty-checking, draft recovery, repeaters, conditionals, tags |
| **HTML** | `public/forms/*.html` | Individual form files, each a standalone page with a `YCForm` config |
| **API** | `routes/api.forms.js` + `services/formService.js` | REST endpoints for drafts, submissions, and history |

---

## How It Fits Into YisraCase

Forms are loaded as iframes inside parent pages like `contact2.html`, `case2.html`, or any other page that needs an editable form.

```
a.html  (has apiSend, firmData, entityData relay)
  └─ contact2.html  (window.apiSend = P.apiSend; window.firmData = P.firmData)
       └─ forms/contact-form.html  (uses P.apiSend for all API calls)
```

The form always looks one level up for `apiSend` — calling `window.parent.apiSend()`. This works at any nesting depth because each host page relays `apiSend` from its own parent.

---

## Key Concepts

### Form Key
Every form has a unique `formKey` string — like `'contact_info'`, `'341_notes'`, `'issn'`. Stored in `form_submissions.form_key` and used to look up drafts/submissions for a given form + entity.

### Link Type + Link ID
Every form is connected to an entity: a contact, case, or appointment. `linkType` (`'contact'`, `'case'`, `'appt'`) and `linkId` (the entity's ID) together identify what record this form is about.

### Data Mode
Forms operate in one of two modes. **Live** — always loads fresh data from the entity table (for editing living records). **Snapshot** — loads from the latest submission once one exists (for capturing moments in time). See [06-data-modes.md](06-data-modes.md).

### Schema Version
Each form declares a `schemaVersion` integer. Bump it when you add, remove, or rename fields. Stored with every draft/submission so the system detects when a draft was saved with an older form layout.

### Draft vs Submission
**Draft** — autosaved periodically while the user edits. One per form+entity (DB constraint enforced). Overwritten on each autosave. Version always 0.
**Submission** — created on explicit save. Append-only. Version increments (1, 2, 3...).

### Parent-as-Data-Source
Parent pages (`case2.html`, `contact2.html`) fetch entity data once and expose it on `window.entityData`. Forms read from there on init instead of making their own API calls. On save, the parent re-fetches and pushes refreshed data into all non-dirty sibling forms. See [10-hosting-and-wiring.md](10-hosting-and-wiring.md).

---

## Files Reference

| File | Location | Purpose |
|------|----------|---------|
| `yc-forms.css` | `public/css/` | All form component styles |
| `yc-forms.js` | `public/js/` | The YCForm class |
| `api.forms.js` | `routes/` | REST endpoints |
| `formService.js` | `services/` | Database operations |
| `form_submissions` | Database table | Drafts and submissions storage |
| `forms/*.html` | `public/forms/` | Individual form files (e.g., `contact-form.html`, `341notes.html`, `casedetails.html`, `issn.html`) |

---

## Future: Form Builder / Schema-Driven Rendering

The current system requires writing an HTML file per form. A future extension could make forms schema-driven:

**Tier 1 — Config-driven renderer.** Store form definitions in a `form_templates` table (field list, layout, validation, endpoints). A single generic page like `forms/render.html?form=341_notes` fetches the template and builds the DOM dynamically. The `YCForm` config is already structured like a template — this just moves it from inline JS to a database record. Non-developers could then create simple forms by editing template records without touching code.

**Tier 2 — Visual drag-and-drop builder.** A dedicated page for dragging field types into rows, setting properties in a sidebar, live preview, and export. Builds on Tier 1 — the builder would be an editor for the template record, not a separate system.

**Recommendation:** Build Tier 1 first if/when the need arises. The CSS classes are a finite set, the config structure is predictable, and most forms follow the same patterns. Tier 2 is a nice-to-have on top.