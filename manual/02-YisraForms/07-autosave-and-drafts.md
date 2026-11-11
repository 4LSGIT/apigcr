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

Each autosave names the draft row the form last saw — the one it loaded, its
own last save, or the one it restored (`expected_draft_id` +
`expected_updated_at`; both `null` when it holds none). The server writes only
when the draft is still that row, to the millisecond, or is gone (then a new
draft is saved). Any other draft is **never replaced**: the save is refused
(see Two browsers below). An external form's server draft names no row — the
client's autosave replaces it whole.

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
sync bus (`form:<link_type>:<link_id>`). Every form page in use loads the
bus — the form renderer (`forms/render.html`) and the hand-built pages
(`casedetails`, `casedetails-bk`, `issn`, `contact-form`) — and re-reads the
latest draft and submission:

- **No unsaved typing:** the form refreshes and shows the draft banner.
- **Unsaved typing:** the form is never repopulated. It shows the newer draft's
  banner and **stops autosaving** ("Draft not saved — a newer draft is
  waiting") — the next autosave would replace the newer draft whole. Restore,
  Discard or a save ends the hold.

The form's own autosave echo is ignored, and the refresh waits while the page
is hidden or a field has the caret.

### Two browsers

The sync bus does not cross browsers (one per browser), so a copy of the form
open in another browser — a colleague's machine — hears nothing. Its next
autosave names the draft row it last saw, which is no longer the draft, and the
server refuses it. The form then shows the newer draft's banner, keeps the
typing on screen, and **stops autosaving** with "Draft not saved — *name* saved
a newer draft at *time*: Restore or Discard it first". Restore loads the newer
draft (and autosave resumes on top of it); Discard deletes it (and the next
autosave saves the typing as a new draft). Nothing retries on its own.

A draft **discarded** elsewhere (the banner's Discard, an Ask Casey discard
card, or a submit's draft cleanup) is announced the same way when a draft was
actually deleted: an open copy re-reads and its stale draft banner comes down.
A copy with unsaved typing keeps that typing, and its next autosave saves a new
draft. The form's own Discard is not re-read.

A form **submitted** elsewhere is announced too, whether or not it ever saved a
draft: an open copy re-reads, repopulates when it holds no unsaved typing, and
its status line shows the new "Last saved by". The form's own Save is not
re-read.

---

## What Happens on Submit

Once the submission is recorded, the form deletes the draft row
(`DELETE /api/forms/draft`, fire-and-forget — a failed delete never fails the
save; the leftover draft is older than the submission, so no banner appears on
the next load). An external form deletes its server draft the same way, or
clears its browser copy. Submitting a stored draft from the server
(`POST /api/forms/submissions/submit-draft`, Part 8) deletes it too.

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
