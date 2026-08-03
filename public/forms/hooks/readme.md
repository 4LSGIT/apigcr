# YisraForm template hooks

**Shared** browser-side helpers for templated forms rendered by
`public/forms/render.html`.

Since Slice 2.6 there are TWO places per-form JavaScript can live:

| Mechanism | Where the code lives | Use it for |
|---|---|---|
| `"code"` (definition key) | The template definition (DB, versioned with the form) | **Per-form logic** — the default. Edited in the builder's Form settings, ships with publish, restores with version history. |
| `"hooks"` (definition key) | This directory — `/forms/hooks/{name}.js` | **Shared code** used by several forms, or code that needs git review workflow. |

The two are **mutually exclusive** on one template (server-enforced). Neither
runs in preview mode. Both are INTERNAL-ONLY: any future external/portal render
route must REFUSE templates carrying `code`, `css`, or `hooks` (contract §8/§9
reformulated invariant, 2026-08-02 — supersedes the old "executable code lives
in the repo only, never in the DB" rule).

## Interface (identical for both mechanisms)

`code` is executed synchronously (`new Function(code)()`, try/catch-isolated);
a hooks file is loaded with `<script src>` and awaited. Both happen at the same
boot point — before `init()` — and both may define:

```js
window.ycHooks = {
  // Called at the END of render.html's generated onLoad — after $load and
  // resolver prefills, BEFORE init re-baselines (step 13c), so anything
  // written to fields here lands in the clean state and does not dirty the
  // form. May be async; it is awaited. Isolated: a throw warns and degrades.
  async onLoad(form, data) {},

  // Called from save() after the submission persists (awaited). `result` is
  // the submit response. Isolated the same way.
  async onSave(form, result) {},
};
```

A hooks file that needs the shared helpers loads `_yc_hook_util.js` itself and
gates on it (see the loadUtil pattern preserved in
`tests/fixtures/slice26/legacy_notes_341.js`). Definition `code` uses the same
pattern — the util stays a repo file either way.

## Files

- `_yc_hook_util.js` — shared helpers (entity/clients accessors, setIfEmpty,
  setRadioIfEmpty, checkgroup toggles, frame-chain api). NOT a hooks file;
  never named by a template's `hooks` key. **Keep** — definition `code` loads
  it too.

## Removed 2026-08-03 (Slice 2.6 migration)

`notes_341.js`, `case_details_bk2.js`, `issn_extras.js`, `case_details_bk.js`,
and `case_clients.js` migrated into their templates' `code` keys (or were
superseded). Pre-deletion copies live in `tests/fixtures/slice26/` (equivalence
tests) and in git history.

**Restore caveat:** restoring a pre-2.6 published version from template history
re-references a deleted hook file. That degrades gracefully (console warn, form
renders without the hook behaviours) — if the old behaviour is needed, re-add
the file from git history first.
