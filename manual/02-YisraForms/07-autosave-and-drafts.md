# Part 7 — Autosave & Drafts

When `autosave: true` is set, the form automatically saves a draft to the database after a period of inactivity.

---

## How Autosave Works

1. User changes a field → form marks as dirty
2. Debounce timer resets (default 3000ms)
3. After 3 seconds of no changes, `autosaveTick()` fires
4. Compares current JSON to last autosaved JSON
5. If identical → skip (no network request)
6. If different → POST to `/api/forms/draft`
7. Header shows "Draft saved just now"

**Autosave never validates.** Drafts can contain incomplete or invalid data.

---

## The Draft Row

One draft per form+entity, enforced by the `draft_key` database constraint. The draft is upserted — overwritten on each autosave. Draft `version` is always 0.

---

## Draft Recovery

On load, if a draft exists that's newer than the latest submission (or no submission exists), a banner appears:

```
┌─────────────────────────────────────────────────────────────┐
│ You have unsaved changes from 4/7/2026, 3:15 PM            │
│                                    [Restore]  [Discard]     │
└─────────────────────────────────────────────────────────────┘
```

- **Restore** — populates the form with draft data
- **Discard** — deletes the draft, keeps current data

If the draft's `schema_version` differs from the form's current `schemaVersion`, an extra warning appears: "This draft was saved with an older version of this form."

---

## A Draft Saved Elsewhere

A draft saved for the same record in another frame of the same browser — an
Ask Casey draft card, or the same form open in another tab — is announced on the
sync bus (`form:<link_type>:<link_id>`). A form page that loads the bus (the
form renderer, `forms/render.html`) re-reads the latest draft and submission:

- **No unsaved typing:** the form refreshes and shows the draft banner.
- **Unsaved typing:** the form is never repopulated. It shows the newer draft's
  banner and **stops autosaving** ("Draft not saved — a newer draft is
  waiting") — every autosave replaces the whole draft, so the next one would
  erase the newer draft. Restore, Discard or a save ends the hold.

The form's own autosave echo is ignored, and the refresh waits while the page
is hidden or a field has the caret. A copy open in another browser, or one of
the older hand-built form pages, does not hear it and sees the draft on reload.

---

## What Happens on Submit

The draft is NOT deleted on submit. It becomes stale — the next autosave overwrites it, and on next load the submission is newer so no banner appears.

---

## Config

```js
autosave:   true,   // enable (default: false)
autosaveMs: 3000,   // debounce interval in ms (default: 3000)
```

---

## Efficiency

- JSON comparison before sending — no request if nothing changed
- Full form data is typically under 5KB
- Single upsert query — no SELECT + conditional logic
