# YisraCase token map — Phase 0 output

Every `var(--…)` name in use across the in-scope pages, mapped to its
replacement in `theme.css`. Built by indexing all 90 html/css files under
`public/` on the `main` tarball of 2026-08-24.

**This table is the spec.** Once it is agreed, every page conversion is a
find-and-replace plus a delete, with no per-page design decisions left. Do not
invent a mapping mid-conversion — if a name is not in this table, stop and add
it here first.

Counts: 109 distinct var names in use, 28 defined by the original token sheet,
**93 orphans** — resolved below into the extended sheet.

---

## 1. Surfaces and text

| orphan | uses | current value(s) | → |
|---|---|---|---|
| `--bg` | 47 | `#f1f5f9` light fam / `#0f1117` dark fam | `--page-bg` |
| `--panel` | 24 | `#161a23`, `#f9fafb`, `#1d2230` | `--surface` |
| `--panel-2` | 9 | `#1d2230` | `--surface-2` |
| `--panel2` | 2 | `#1b2030`, `#f7f9fc` | `--surface-2` |
| `--card` | 1 | `#ffffff` | `--surface` |
| `--surface-bg` | 1 | `#ffffff` / `#1a1e2a` | `--surface` |
| `--muted` | 44 | `#6b7280`, `#94a3b8`, `#8a93a3`… | `--text-muted` |
| `--text2` | 17 | `#475569` | `--text-2` |
| `--fg` | 7 | `#1f2430`, `#1f2937`, `#d8dde6` | `--text` |
| `--fg2` | 1 | `#374151` | `--text-2` |
| `--ink` | 1 | `#1d2330` | `--text` |
| `--line` | 3 | `#e5e7eb` / `#2a313d` | `--border` |
| `--border2` | 1 | `#eef1f6` | `--border` |
| `--bd` | 1 | `#d4d7dd` | `--border-strong` |

`--surface` is already a core token and several pages define it locally at
`#ffffff`. Delete the local definition; the value is identical.

## 2. Accent

| orphan | uses | current | → |
|---|---|---|---|
| `--accent-2` | 6 | `#82c0ff` | `--accent-2` *(promoted to core)* |
| `--accent-text` | 6 | `#ffffff` | `--accent-text` *(promoted to core)* |
| `--accentbg` | 1 | `#e6f6fe` | `--accent-soft` |
| `--accent2` | 1 | `#5856d6` | `--cat-indigo` |
| `--brand` | 1 | **undefined — broken today** | `--accent` |

Pages that locally redefine `--accent` to something other than `#07ADEF`
— `customView.html` (`#2563eb`), `connections.html` (`#6ea8fe`),
`customView.html` dark (`#60a5fa`) — lose that override and move to brand
blue. **That is an intended visual change, not a regression.** Expect it.

`--brand` in `automation/workflows.html` resolves to nothing today, so
whatever it paints is currently transparent or inherited. Fixing it will
change that element's appearance. Verify it looks right rather than assuming.

## 3. Status

| orphan | uses | current | → |
|---|---|---|---|
| `--red` | 17 | `#ef4444` | `--danger` |
| `--blue` | 20 | `#4f8ef7` | `--info` |
| `--blue2` | 17 | `#3a7de8` | `--info-dark` |
| `--green` | 10 | `#22c55e` | `--ok` |
| `--amber` | 5 | `#f59e0b` | `--warn` |
| `--good` | 1 | `#15803d` | `--ok` |
| `--done` | 2 | `#059669` | `--ok` |
| `--bad` | 1 | `#b91c1c` | `--danger` |
| `--fail` | 2 | `#dc2626` | `--danger` |
| `--danger-bg` | 3 | `#fef2f2` | `--danger-soft` |
| `--warnbg` | 1 | `#fef7e7` | `--warn-soft` |
| `--admin-bg` | 1 | `#fff8e1` | `--warn-soft` |
| `--admin-bdr` | 1 | `#f6cc2f` | `--warn` |
| `--tag-bug` | 1 | `#fff0f0` | `--danger-soft` |
| `--tag-bug-c` | 1 | `#c53030` | `--danger` |
| `--tag-feat` | 1 | `#f0f7ff` | `--accent-soft` |
| `--tag-feat-c` | 1 | `#2b6cb0` | `--accent` |

## 4. Categorical hues

`automation/activity.html` colour-codes event categories. These carry no
status meaning — folding them into ok/warn/danger would make unrelated rows
read as errors.

| orphan | uses | current | → |
|---|---|---|---|
| `--purple` | 4 | `#8b5cf6` | `--cat-purple` |
| `--teal` | 1 | `#14b8a6` | `--cat-teal` |
| `--indigo` | 1 | `#6366f1` | `--cat-indigo` |
| `--pink` | 1 | `#ec4899` | `--cat-pink` |
| `--idea` | 1 | `#c084fc` | `--cat-purple` |
| `--repeat` | 1 | `#9a6ff0` | `--cat-purple` |

## 5. Code surface

`--navy` / `--navy2` are **not** chrome. Every use is a `<pre>` background,
always paired with a hardcoded `color:#e2e8f0` in the same inline style
(hooks.html lines 568, 603, 2087, 2881 and the equivalents in workflows,
sequences, emailIngest, phoneIngest, assetManager).

| orphan | uses | current | → |
|---|---|---|---|
| `--navy` | 11 | `#1a1a2e` | `--code-bg` |
| `--navy2` | 6 | `#16213e` | `--code-bg-2` |

**Also replace the paired literal:** `color:#e2e8f0` → `color:var(--code-fg)`
on those same elements. If you swap the background token and leave the text
literal, the pre block still works — but it silently stops being themeable and
the next person has to find it again.

## 6. Shell chrome (index.html only)

| orphan | current | → |
|---|---|---|
| `--sidebar-hover` | `#e8eaed` / `#2a2f3d` | `--hover` |
| `--sidebar-active-bg` | `rgba(7,173,239,0.12)` / `.22` | `--accent-soft` |
| `--sidebar-skinny-w` | `56px` | `--sidebar-skinny-w` *(promoted)* |
| `--shadow-drawer` | `2px 0 12px rgba(0,0,0,0.18)` | `--shadow-drawer` *(promoted)* |
| `--backdrop` | `rgba(0,0,0,0.4)` | `--backdrop` *(promoted)* |
| `--logout-color` | `#d9534f` / `#ff7670` | `--danger` |
| `--logout-hover-bg` | `#fdecea` / `#3a1f1f` | `--danger-soft` |

`--header-h` changes **56px → 52px**. That is a real layout shift in the
shell, not a no-op. It is the mockup's value and the compact direction, so
take it — but take it knowingly, and eyeball the header after.

## 7. `--pb-*` — pipelineBoard.html

Already fully dual-mode (light `:root` + `body.dark`). Both value columns
below; the mapping collapses them into one token that handles both.

| orphan | light | dark | → |
|---|---|---|---|
| `--pb-bg` | `#fff` | `#151a23` | `--page-bg` |
| `--pb-fg` | `#1e293b` | `#e6e8ee` | `--text` |
| `--pb-muted` | `#999` | `#9aa3b2` | `--text-muted` |
| `--pb-link` | `#1a73b7` | `#60a5fa` | `--accent` |
| `--pb-col-bg` | `#f4f6f8` | `#1d2230` | `--surface-2` |
| `--pb-col-border` | `#dde3e8` | `#2a313d` | `--border` |
| `--pb-card-bg` | `#fff` | `#232a3a` | `--surface` |
| `--pb-card-border` | `#d6dde4` | `#323b4d` | `--border` |
| `--pb-card-shadow` | `rgba(0,0,0,.06)` | `rgba(0,0,0,.35)` | **see note** |
| `--pb-chip-bg` | `#eef1f4` | `#2a313d` | `--surface-2` |
| `--pb-chip-fg` | `#555` | `#b8c0cc` | `--text-2` |
| `--pb-count` | `#2b7fb0` | `#26abe2` | `--accent` |
| `--pb-count-un` | `#8a93a3` | `#5b6472` | `--text-muted` |
| `--pb-days-bg` | `#e3f0e6` | `#1e3325` | `--ok-soft` |
| `--pb-days-fg` | `#2c7a3d` | `#6fd08c` | `--ok` |
| `--pb-hot-bg` | `#fbe3e3` | `#3a1d1d` | `--danger-soft` |
| `--pb-hot-fg` | `#b32222` | `#f08c8c` | `--danger` |
| `--pb-warm-bg` | `#fdf0dc` | `#3a2f16` | `--warn-soft` |
| `--pb-warm-fg` | `#a4700d` | `#e0b341` | `--warn` |
| `--pb-input-bg` | `#fff` | `#1d2230` | `--surface` |
| `--pb-input-border` | `#ccc` | `#2a313d` | `--border-strong` |

**`--pb-card-shadow` note:** it is a shadow *colour*, consumed as
`box-shadow: 0 1px 2px var(--pb-card-shadow)`. `--shadow` is a complete
shadow value. Replace the whole declaration with `box-shadow: var(--shadow)`
— do not substitute token-for-token or you get `0 1px 2px 0 1px 3px …`.

## 8. `--tk-*` — tasks.html

Also already dual-mode.

| orphan | light | dark | → |
|---|---|---|---|
| `--tk-bg` | `#fff` | `#151a23` | `--page-bg` |
| `--tk-surface` | `#f8f9fb` | `#1d2230` | `--surface-2` |
| `--tk-fg` | `#111827` | `#e6e8ee` | `--text` |
| `--tk-muted` | `#6b7280` | `#9aa3b2` | `--text-muted` |
| `--tk-border` | `#d1d5db` | `#2a313d` | `--border` |
| `--tk-link` | `#1a73b7` | `#60a5fa` | `--accent` |
| `--tk-chip-bg` | `#eef1f4` | `#2a313d` | `--surface-2` |
| `--tk-chip-fg` | `#555` | `#b8c0cc` | `--text-2` |
| `--tk-age-bg` | `#fbe3e3` | `#3a1d1d` | `--danger-soft` |
| `--tk-age-fg` | `#b32222` | `#f08c8c` | `--danger` |
| `--tk-overdue` | `#dc2626` | `#f08c8c` | `--danger` |
| `--tk-duetoday` | `#d97706` | `#e0b341` | `--warn` |
| `--tk-nodue` | `#6b7280` | `#9aa3b2` | `--text-muted` |
| `--tk-completed` | `#065f46` | `#6fd08c` | `--ok` |
| `--tk-deleted` | `#6b7280` | `#9aa3b2` | `--text-muted` |
| `--tk-pending` | `#4f46e5` | `#8ea2ff` | `--cat-indigo` |
| `--tk-robot-bg` | `#eef2ff` | `#232a4a` | `--accent-soft` |
| `--tk-robot-fg` | `#4f46e5` | `#8ea2ff` | `--cat-indigo` |
| `--tk-bulk-bg` | `#eef2ff` | `#232a4a` | `--accent-soft` |

Note `--tk-pending` and `--tk-robot-fg` share a value and both become
`--cat-indigo` — "machine did this" is a category, not a status. Keeping them
distinct from `--accent` preserves the distinction the page was making.

## 9. Deferred

| orphan | file | disposition |
|---|---|---|
| `--yc-ext-bg-from` | `forms/render.html` | **undefined today.** render.html is dual-use — framed at depth 2 *and* served externally as the public form target. Needs a decision before touching. Leave alone this arc. |
| `--yc-ext-bg-to` | `forms/render.html` | same |
