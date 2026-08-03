# Part 14 — The Form Builder

`public/formBuilder.html` is the visual editor for template definitions ([13-template-system.md](13-template-system.md)). It runs as an iframe inside the `index.html` shell — **More Features → Form Builder** — and talks to the template API through the shell's `apiSend` relay. Any authenticated user can use it.

Mental model: **the builder is an editor for a JSON record; the renderer is the product.** The canvas is structural, not WYSIWYG — use the Preview tab to see what users see.

---

## The Template List

Opening the builder without a template shows the admin list: every template with its key, title, link type, version badge (`vN` published / `never published`), and last update. A filter box narrows by key, title, or link type as you type.

- **Open** — loads the template into the editor.
- **Delete** — offered only on never-published templates. The server additionally refuses when submissions exist for the key; that rejection surfaces verbatim.
- **New template** — key (permanent once published), link type, and title. Created templates start with one empty section and are unpublished until you say otherwise.

The `⇄ Open` button in the editor's top bar returns here (with an unsaved-changes guard).

---

## The Editor

Three panes: **palette** (left) — field types and structure to drag in or click-to-add; **canvas** (center) — sections, rows, and field chips; **inspector** (right) — properties of the current selection, or the form settings when nothing is selected.

Everything drags: sections by their header, rows by their handle, fields anywhere. Field chips show the name, type, and badges for database column (⛁), visibility condition (⚡), and prefill. Dropping a field **directly on a section's row area** — including an empty section — wraps it in a new row at the drop position.

Working rules worth knowing:

- **Names auto-follow labels** until you edit the name manually. Renaming a field updates every `showWhen` condition that references it; a rename still counts as remove+add for schema versioning.
- **Repeaters accept only** `text`, `number`, `date`, `select`, `checkbox` — a blocked drop snaps back with a toast explaining why.
- **Deletes are reference-aware** — deleting a field/row/section that other conditions depend on lists the affected nodes and cascade-removes the conditions after you confirm.
- **Save draft** writes `draft_definition` only. Server validation failures surface verbatim next to the button, naming the offending JSON path.

### Tabbed layout (Slice 2.6)

Turn on **Form settings → Layout → Tabbed layout** to convert a flat form into tabs (everything lands on one tab; the reverse toggle only works with a single tab and no sticky sections). A tabbed canvas shows:

- A **tab strip** — click to switch, double-click (or ✎) to rename, **+ Tab** to add (a new tab is seeded with one section — every tab must keep at least one to save), ◀ ▶ to reorder, × to delete (**only when empty** — move its sections out first).
- **Sticky top / sticky bottom** dashed regions above and below the tab's sections — these render on every tab (case header, running notes).
- Dragging reorders sections **within** a region only. Moving a section to another tab or a sticky region goes through the **Move to…** button on its header — the section lands at the end of the target region and the canvas follows it. New sections (palette click or drop) land on the **active tab**.
- Emptying a tab via Move-to is fine as a working state, but an empty tab can't be **saved** (the server rejects it, message verbatim) — delete it or give it a section before saving.

Conditions, renames, deletes, and field drags work across tabs exactly as before — names are form-wide.

### Embed fields (Slice 2.6)

The palette's **embed** type renders an https iframe (Calendly, KBB, dashboards) — display-only: never collected, validated, or saved, and it never affects schema versioning. The inspector takes the URL (https-only, validated as you type), an optional pixel height (default 600), a width, and a visibility condition. **Internal forms only.**

### Tabs

| Tab | What it is |
|-----|------------|
| **Canvas** | The structural editor above |
| **JSON** | The raw draft definition. Escape hatch — paste, edit, **Apply** replaces the working model (both edit the same in-memory model) |
| **Preview** | The production renderer in an iframe, rendering the **saved draft** (the draft is auto-saved before every refresh). No autosave, no prefill, no hooks, no template code, save disabled; with a test link id the entity loads read-only. Safe to click anything |
| **Live** | The **real published form** in normal mode — drafts, autosave, and Save actually write, and any configured PATCH/workflow fires. Requires a published template and a link id. Shows a hint when your draft differs from what's published. `↗ New tab` / `Copy link` give a standalone URL (via `liveHost.html`) |
| **History** | Version history + submissions browser (below) |

---

## Publish & Versioning

**Publish** saves the draft, then asks for confirmation with a prediction of the version outcome:

- First publish → v1.
- Field set unchanged → republish at the same version, and the history row is labeled **no schema change**.
- Field set changed → version bumps, and older drafts against the previous version will show a recovery warning.

The client prediction is display-only; the server recomputes and is the authority. The result (`Published vN`, bumped or not) shows in the top bar.

---

## History Tab

Two read-only lists side by side:

**Published versions** — every publish, newest first, with the version, timestamp, publisher, and the "no schema change" label on same-field-set republishes.

- **View** — the version's full definition JSON, read-only.
- **Restore** — copies that version's definition into the **draft** (server-side; the published form is untouched). The confirm dialog states the current draft will be replaced — and warns extra if you have unsaved edits in the session. After restoring, the canvas shows the restored draft; publish it when ready. Restore-then-publish is the rollback path.

**Submissions** — every `form_submissions` row for this form key, across all entities: id, status, link id, submission + schema version, timestamp, user. Filter by status and link id; **Load more** pages older rows. **View** shows the submission's `data` JSON read-only. Nothing here edits or deletes — it's a viewer.

---

## Safety Properties

- All template-sourced strings reach the DOM via `textContent`/`setAttribute` — no `innerHTML` path exists for model data (in the builder and the renderer both).
- Preview is quadruple-guarded against writes; Live is honest about being real and gated on published + explicit link id.
- **Custom code** (Form settings) stores per-form JavaScript in the definition — syntax-checked as you type (never executed in the builder), ≤ 32 KB, mutually exclusive with a hooks file (each editor disables while the other is set). It runs on the live form only, never in Preview; publishing a template that carries code is superuser-gated. Shared multi-form code still lives in repo hook files (`/forms/hooks/`). Internal surfaces only — see contract §8/§9.
- If the SortableJS CDN is unreachable, the builder degrades to click-to-add: palette clicks insert at the selection, "+ row" still works. Nothing breaks.

---

## Building Your First Form — the short version

1. Template list → New template (pick the key carefully — it's permanent once published).
2. Drag a section's worth of fields in; set labels; set **Database column** on fields that should read/write the entity; add validation.
3. Form settings (click the canvas background): confirm data mode, load endpoint, and whether saving should PATCH the entity and/or trigger a workflow.
4. Save draft → Preview (with a test link id) until it looks right.
5. Publish → Live tab with a test entity id → fill and Save for a real end-to-end check.
6. Host it where it belongs: an iframe pointing at `/forms/render.html?form_key=K&case_id={id}` (Part 10 wiring applies unchanged).