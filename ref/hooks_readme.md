# YisraForm template hooks

Per-form escape hatch for templated forms rendered by `public/forms/render.html`.
**Executable code lives in this repo only — never in the DB** (locked decision;
portal XSS + git review). A template opts in by setting its definition's
top-level `"hooks"` key to a file name (no path, no extension) matching
`^[a-zA-Z0-9_-]{1,50}$` — e.g. `"hooks": "intake_extras"` loads
`/forms/hooks/intake_extras.js`.

## Interface

The file runs as a plain browser script (loaded and awaited by render.html
BEFORE the YCForm is constructed) and may define:

```js
window.ycHooks = {
  // Called at the END of render.html's generated onLoad — after resolver
  // prefill has written its values, and BEFORE init re-baselines (step 13c),
  // so anything you write to fields here lands in the clean state and will
  // not make the form report dirty. May be async; it is awaited.
  //   form — the live YCForm instance (form.el, form.collect(), …)
  //   data — the resolved data source init populated the form from
  onLoad(form, data) {},

  // Called from the form's onSave after a successful save (awaited by
  // yc-forms save() step 11, which re-baselines afterward unless the user
  // typed during the await).
  //   form   — the live YCForm instance
  //   result — the /api/forms/submit response ({ id, version, updated_at, … })
  onSave(form, result) {},
};
```

Both members are optional. Errors thrown by either are caught and
console.warn-ed by render.html — a broken hook degrades, it never aborts the
form.

## Rules

- A missing/broken hooks file is non-fatal: render.html warns and renders
  without hooks.
- Hooks are **not** loaded in preview mode (`?preview=1`) — preview must never
  execute side-effecting per-form code.
- Reach the API through `window.parent.apiSend(url, method, body)` (same relay
  every internal form uses), or via the `form` instance's `_api`.
- Keep hooks additive: field writes in `onLoad` land before the baseline, so
  prefer the if-empty pattern (`if (!el.value) el.value = …`) when mixing with
  drafts/snapshot data — same discipline as the hand-built forms' onLoad.