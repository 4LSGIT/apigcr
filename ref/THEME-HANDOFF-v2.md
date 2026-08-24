# YisraCase theme unification — implementation charter (v2)

Repo: `4LSGIT/apigcr`, branch `main`, work confined to `public/`.
Supersedes `THEME-HANDOFF.md`. Verified against the `main` tarball of
2026-08-24 — every count, path and line number below was read out of the repo,
not from the v1 doc.

**Goal:** one token sheet, one compact density, and a light/dark toggle in the
shell that reaches every page nested outward from `index.html`, at any depth.

**Companion files:** `theme.css`, `themeSync.js`, `TOKEN-MAP.md`.
`TOKEN-MAP.md` is the spec for the conversion — read it before touching a page.

---

## 0. What changed from v1, and why

v1 was written against a mockup, not the repo. Six of its assumptions do not
hold. Each correction below is load-bearing; do not revert to the v1 behaviour.

| v1 said | Actually |
|---|---|
| 9 pages to convert | **64 pages in scope**, 43 with `:root`/vars and 21 with raw hexes only |
| `case.html` first, "delete its `:root` block" | `case.html` has **no `:root` and zero `var()`** — 15 raw hexes. It is one of the harder pages, not the easy first one |
| Orphan tokens are an occasional per-page surprise | **93 orphans** out of 109 names in use. It is the whole job — hence Phase 0 |
| Shell uses `data-theme`; "replace the toggle handler body" | Shell uses **`body.dark`** — 41 selectors in `index.html`, key `theme` not `yc-theme`, plus a telemetry read at line 4690 |
| postMessage over `querySelectorAll('iframe')` | Only reaches direct children. **Frames nest 3 deep.** Use the top-window observer already proven in 4 pages |
| Steps 1–2 ship safely with no visual change | 41 `body.dark` rules stop matching. Needs the legacy bridge in §3. (v1 also moved `--header-h` 56→52px; that is now deferred to §8 — see §0.1) |

Plus one thing v1 never mentions, and it is the biggest visible change in the
whole arc — see §2, family B.

### 0.1 The rule that decides every borderline case

**Colour changes ship in this arc. Metric changes ship in the density arc.**

A metric is anything that moves a pixel: `font-family`, `font-size`,
`--header-h`, control heights, padding, gaps, line-height. A colour change is
invisible when it is right. A metric change is not — it re-wraps text,
re-widths table columns, and re-fits button labels, and it does so on pages
nobody opened during review.

Mixing them destroys bisectability. If a page's spacing changes in the same
commit as its colours, an unrelated layout bug becomes impossible to attribute.

Two consequences, both already applied below:

- **`--header-h` stays at 56px**, the shell's current value, even though the
  mockup says 52px. It moves in §8.
- **`style.css`'s `font-family: Arial` stays**, even though it is the single
  highest-reach line in the file. It moves in §8.

Both are the right end state. Neither is worth spending step 2's no-op
property on. When a future case is unclear, apply the rule rather than
re-deciding: does it move a pixel?

---

## 1. Scope

**In:** `index.html` and everything reachable from it by iframe, at any depth —
64 pages.

**Out, this arc:** `portal/*` (client-facing, different accent `#2563eb`, its
own branding), `book.html`, `manage.html`, `appt.html`, `docReq.html`,
`streak.html`, `survey.html`, `rating.html`, `reset-password.html`,
`caseerror.html`, `evergreen.html`, `feedback.html`, `esign/sendForm.html`,
`esign/templateAdmin.html`, `forms/341notes.html`. They keep their own
`:root`. Do not touch them.

**Deferred:** `forms/render.html` is dual-use — framed at depth 2 *and* served
externally as the public form target. Its two vars (`--yc-ext-bg-from`,
`--yc-ext-bg-to`) are undefined today. Needs a decision; leave alone.

---

## 2. The four page families

The single most important thing in this document. Every in-scope page falls
into one of four families, and **the conversion recipe differs per family.**

### Family C — already light + dark (6 pages)
`index.html`, `pipelineBoard.html`, `tasks.html`, `customView.html`,
`reports.html`, `dbConsole.html`

They have a light `:root` plus a `body.dark` override, and the first four
already follow the shell live via a `window.top` MutationObserver. Converting
these is mostly renaming: the dual values collapse onto one token that already
handles both modes. **Lowest risk — do these first**, and they prove the
whole mechanism end to end.

### Family B — dark-only today, will INVERT (12 pages)
`apikeys.html`, `availabilitymanager.html`, `bookingviewsmanager.html`,
`connections.html`, `formBuilder.html`, `issueReports.html`,
`pageManager.html`, `readonlyKeys.html`, `redirects.html`, `settings.html`,
`systemAlerts.html`, `users.html`

These have `--bg: #0f1117` as the **default** `:root` value. They are
permanently dark today and ignore the shell toggle entirely. After conversion
they become light by default and follow the toggle.

**This is the change most likely to produce a "why does it look wrong"
report.** It is intended — but Fred should see one converted page and sign off
before the other eleven ship. Recommend `apikeys.html` as the sample: 4
orphans, 11 hexes, small surface area.

### Family A — light-only (25 pages)
The whole `automation/*` set, `caseconfig/*`, `portaladmin/*`, the three
`*Manager.html` pages, `assetManager`, `featureRequests`, `formBuilderSimple`,
`courtpreview`, `manuals`, `videoManager`.

Light `:root`, no dark block. They gain a dark mode they never had. Mechanical
once `TOKEN-MAP.md` is applied — these share a near-identical `:root`
(`--bg/--surface/--border/--muted/--text/--text2` + the `--blue/--green/--red`
palette), so the same edit repeats.

### Family D — raw hexes, no vars at all (21 pages)
`case.html`, `contact.html`, `campaign.html`, `checklistView.html`,
`apiTester.html`, `automation/automationsWidget.html`, `apptform2.html`,
`formInbox.html`, `checklistsView.html`, `communicate.html`,
`forms/contact-form.html`, `sendingform.html`, `eventform.html`,
`forms/submissionsWidget.html`, `calendar.html`, `esign/dashboard.html`,
`forms/liveHost.html`, `esign/caseWidget.html`, `forms/issn.html`,
`forms/casedetails.html`, `etch.html`

No `:root` to delete and no `var()` to remap — every colour is a literal.
**This is a different and slower job:** each hex has to be read in context to
know whether it is a surface, a border, a status or a brand colour. There is
no mechanical shortcut and no punch list to grep for. Budget accordingly.
`etch.html` has zero hexes and converts for free; `checklistView.html` (41),
`campaign.html` (36) and `contact.html` (36) are the expensive ones.

### Scope table

| fam | page | orphans | uniq hex |
|---|---|---|---|
| C | `pipelineBoard.html` | 21 | 35 |
| C | `tasks.html` | 19 | 32 |
| C | `index.html` | 8 | 45 |
| C | `customView.html` | 5 | 21 |
| C | `reports.html` | 5 | 21 |
| C | `dbConsole.html` | 4 | 14 |
| B | `formBuilder.html` | 7 | 19 |
| B | `settings.html` | 5 | 15 |
| B | `connections.html` | 5 | 14 |
| B | `pageManager.html` | 5 | 14 |
| B | `bookingviewsmanager.html` | 5 | 13 |
| B | `redirects.html` | 5 | 13 |
| B | `availabilitymanager.html` | 5 | 12 |
| B | `issueReports.html` | 5 | 12 |
| B | `systemAlerts.html` | 4 | 12 |
| B | `apikeys.html` | 4 | 11 |
| B | `readonlyKeys.html` | 4 | 10 |
| B | `users.html` | 4 | 9 |
| A | `automation/activity.html` | 11 | 30 |
| A | `automation/workflows.html` | 10 | 69 |
| A | `featureRequests.html` | 10 | 35 |
| A | `automation/courtReview.html` | 10 | 32 |
| A | `automation/hooks.html` | 9 | 40 |
| A | `formBuilderSimple.html` | 9 | 30 |
| A | `caseconfig/pipelines.html` | 9 | 24 |
| A | `automation/sequences.html` | 8 | 69 |
| A | `automation/phoneIngest.html` | 8 | 52 |
| A | `automation/emailIngest.html` | 8 | 51 |
| A | `automation/scheduledJobs.html` | 8 | 35 |
| A | `portaladmin/portalCards.html` | 8 | 34 |
| A | `assetManager.html` | 8 | 17 |
| A | `portaladmin/portalSettings.html` | 7 | 19 |
| A | `videoManager.html` | 7 | 19 |
| A | `automation/triggers.html` | 6 | 29 |
| A | `caseconfig/types.html` | 6 | 16 |
| A | `courtpreview.html` | 6 | 15 |
| A | `portaladmin/portalAccess.html` | 5 | 22 |
| A | `automationManager.html` | 5 | 17 |
| A | `caseConfigManager.html` | 5 | 16 |
| A | `portalManager.html` | 5 | 16 |
| A | `manuals.html` | 4 | 19 |
| A | `caseconfig/fields.html` | 3 | 3 |
| D | `checklistView.html` | 0 | 41 |
| D | `campaign.html` | 0 | 36 |
| D | `contact.html` | 0 | 36 |
| D | `apiTester.html` | 0 | 35 |
| D | `automation/automationsWidget.html` | 0 | 34 |
| D | `apptform2.html` | 0 | 31 |
| D | `formInbox.html` | 0 | 20 |
| D | `checklistsView.html` | 0 | 19 |
| D | `communicate.html` | 0 | 18 |
| D | `forms/contact-form.html` | 0 | 17 |
| D | `sendingform.html` | 0 | 16 |
| D | `case.html` | 0 | 15 |
| D | `eventform.html` | 0 | 15 |
| D | `forms/submissionsWidget.html` | 0 | 13 |
| D | `calendar.html` | 0 | 10 |
| D | `esign/dashboard.html` | 0 | 7 |
| D | `forms/liveHost.html` | 0 | 5 |
| D | `esign/caseWidget.html` | 0 | 4 |
| D | `forms/issn.html` | 0 | 3 |
| D | `forms/casedetails.html` | 0 | 1 |
| D | `etch.html` | 0 | 0 |

### Per-page orphan punch lists

Grep targets. After deleting a page's `:root`, every name on its line below is
a `var()` that now resolves to nothing. Resolve each via `TOKEN-MAP.md`.

- **`pipelineBoard.html`** — `--pb-bg`, `--pb-card-bg`, `--pb-card-border`, `--pb-card-shadow`, `--pb-chip-bg`, `--pb-chip-fg`, `--pb-col-bg`, `--pb-col-border`, `--pb-count`, `--pb-count-un`, `--pb-days-bg`, `--pb-days-fg`, `--pb-fg`, `--pb-hot-bg`, `--pb-hot-fg`, `--pb-input-bg`, `--pb-input-border`, `--pb-link`, `--pb-muted`, `--pb-warm-bg`, `--pb-warm-fg`
- **`tasks.html`** — `--tk-age-bg`, `--tk-age-fg`, `--tk-bg`, `--tk-border`, `--tk-bulk-bg`, `--tk-chip-bg`, `--tk-chip-fg`, `--tk-completed`, `--tk-deleted`, `--tk-duetoday`, `--tk-fg`, `--tk-link`, `--tk-muted`, `--tk-nodue`, `--tk-overdue`, `--tk-pending`, `--tk-robot-bg`, `--tk-robot-fg`, `--tk-surface`
- **`index.html`** — `--backdrop`, `--logout-color`, `--logout-hover-bg`, `--shadow-drawer`, `--sidebar-active-bg`, `--sidebar-hover`, `--sidebar-skinny-w`, `--surface-bg`
- **`customView.html`** — `--bg`, `--fg`, `--line`, `--muted`, `--panel`
- **`reports.html`** — `--bg`, `--fg`, `--line`, `--muted`, `--panel`
- **`dbConsole.html`** — `--bg`, `--muted`, `--panel`, `--panel-2`
- **`formBuilder.html`** — `--bg`, `--fg`, `--line`, `--muted`, `--panel`, `--panel2`, `--repeat`
- **`settings.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`connections.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`pageManager.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`bookingviewsmanager.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`redirects.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`availabilitymanager.html`** — `--accent-2`, `--bg`, `--muted`, `--panel`, `--panel-2`
- **`issueReports.html`** — `--bg`, `--idea`, `--muted`, `--panel`, `--panel-2`
- **`systemAlerts.html`** — `--bg`, `--muted`, `--panel`, `--panel-2`
- **`apikeys.html`** — `--bg`, `--fg`, `--muted`, `--panel`
- **`readonlyKeys.html`** — `--bg`, `--fg`, `--muted`, `--panel`
- **`users.html`** — `--bg`, `--fg`, `--muted`, `--panel`
- **`automation/activity.html`** — `--amber`, `--bg`, `--blue`, `--blue2`, `--green`, `--indigo`, `--muted`, `--pink`, `--purple`, `--teal`, `--text2`
- **`automation/workflows.html`** — `--amber`, `--bg`, `--blue`, `--blue2`, `--brand`, `--muted`, `--navy`, `--navy2`, `--red`, `--text2`
- **`featureRequests.html`** — `--accent2`, `--admin-bdr`, `--admin-bg`, `--bg`, `--card`, `--muted`, `--tag-bug`, `--tag-bug-c`, `--tag-feat`, `--tag-feat-c`
- **`automation/courtReview.html`** — `--amber`, `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--navy2`, `--purple`, `--red`, `--text2`
- **`automation/hooks.html`** — `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--navy`, `--navy2`, `--red`, `--text2`
- **`formBuilderSimple.html`** — `--accentbg`, `--bg`, `--border2`, `--fg`, `--fg2`, `--muted`, `--panel`, `--panel2`, `--warnbg`
- **`caseconfig/pipelines.html`** — `--amber`, `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--purple`, `--red`, `--text2`
- **`automation/sequences.html`** — `--bg`, `--blue`, `--blue2`, `--muted`, `--navy`, `--navy2`, `--red`, `--text2`
- **`automation/phoneIngest.html`** — `--bg`, `--blue`, `--blue2`, `--muted`, `--navy`, `--navy2`, `--red`, `--text2`
- **`automation/emailIngest.html`** — `--bg`, `--blue`, `--blue2`, `--muted`, `--navy`, `--navy2`, `--red`, `--text2`
- **`automation/scheduledJobs.html`** — `--amber`, `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--red`, `--text2`
- **`portaladmin/portalCards.html`** — `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--purple`, `--red`, `--text2`
- **`assetManager.html`** — `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--navy`, `--red`, `--text2`
- **`portaladmin/portalSettings.html`** — `--bg`, `--blue`, `--blue2`, `--green`, `--muted`, `--red`, `--text2`
- **`videoManager.html`** — `--bg`, `--blue`, `--blue2`, `--muted`, `--navy`, `--red`, `--text2`
- **`automation/triggers.html`** — `--bg`, `--blue`, `--green`, `--muted`, `--red`, `--text2`
- **`caseconfig/types.html`** — `--bg`, `--blue`, `--blue2`, `--muted`, `--red`, `--text2`
- **`courtpreview.html`** — `--bad`, `--bd`, `--bg`, `--good`, `--ink`, `--muted`
- **`portaladmin/portalAccess.html`** — `--bg`, `--blue`, `--green`, `--muted`, `--text2`
- **`automationManager.html`** — `--bg`, `--blue`, `--blue2`, `--navy`, `--red`
- **`caseConfigManager.html`** — `--bg`, `--blue`, `--blue2`, `--navy`, `--red`
- **`portalManager.html`** — `--bg`, `--blue`, `--blue2`, `--navy`, `--red`
- **`manuals.html`** — `--bg`, `--blue`, `--muted`, `--navy`
- **`caseconfig/fields.html`** — `--bg`, `--muted`, `--text2`

---

## 3. Shell — `index.html`

The shell is family C but gets its own section because it drives everything
else and because the migration has to stay incremental.

### 3.1 Pre-paint inline script

First thing in `<head>`, before any stylesheet and before any iframe:

```html
<script>
(function () {
  var t = null;
  try {
    t = localStorage.getItem('yc-theme');
    if (t === null) {                       // one-time migration off the old key
      var old = localStorage.getItem('theme');
      if (old) { t = old; localStorage.setItem('yc-theme', old); }
    }
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
})();
</script>
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/style.css">
```

This must be inline, not `themeSync.js`. The shell is the source of truth —
it sets the attribute that every frame observes, so it cannot be waiting on a
network fetch to do it.

### 3.2 `applyTheme` with a legacy bridge

```js
function applyTheme(t) {
  t = (t === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('yc-theme', t); } catch (e) {}

  // LEGACY BRIDGE — remove only when the last body.dark consumer is converted.
  // Keeps the 41 unconverted body.dark rules in this file, and the four pages
  // still observing top's body class, working during the migration. Without
  // it the arc becomes big-bang.
  document.body.classList.toggle('dark', t === 'dark');

  var icon = document.getElementById('themeIcon');
  if (icon) icon.className = (t === 'dark') ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}
```

Call `applyTheme(document.documentElement.getAttribute('data-theme'))` once on
load so the bridge and the icon are in sync with what §3.1 already set.

No iframe broadcast. No `load` re-broadcast. Frames pull; see §4.

### 3.3 The 41 `body.dark` selectors

Rewrite each `body.dark X` → `html[data-theme="dark"] X`. They are all in the
`<style>` block, concentrated around lines 420–600. Do this **after** the
bridge is in and verified, as its own commit, so a mistake here is one revert.

Once they are all converted and every family-C page is off the old observer,
delete the bridge line from `applyTheme`.

### 3.4 Telemetry, line ~4690

```js
theme: safe(() => document.body.classList.contains('dark') ? 'dark' : 'light', null),
```
→
```js
theme: safe(() => document.documentElement.getAttribute('data-theme') || 'light', null),
```

Works either way while the bridge is up; update it with §3.3 so it does not
get orphaned.

### 3.5 Header logo

```html
<a href="https://app.4lsg.com/">
  <img src="/assets/icon-192.png" alt="4LSG YisraCase" style="height:40px;width:auto">
</a>
```

`public/assets/icon-192.png` exists — verified, 18,941 bytes.

### 3.6 `--header-h` — leave at 56px

`theme.css` ships `--header-h: 56px`, matching the shell today. The mockup's
52px is correct and is where this lands, but it moves in §8 under the §0.1
rule. Deleting the shell's `:root` must not change the header's height.

If you find yourself wanting to "just take the 4px while we're in here" —
that is exactly the instinct §0.1 exists to stop.

---

## 4. Per-page conversion recipe

Add to `<head>`, **before** the page's own `<style>` or stylesheet:

```html
<link rel="stylesheet" href="/theme.css">
<script src="/themeSync.js"></script>
```

Plain blocking `<script src>`. Not `defer`, not `async`, not `type=module`.

Then, by family:

- **A / B / C:** delete the local `:root` block (and for B and C, the
  `body.dark` block too — its values are now in `theme.css`). Grep
  `var(--` and resolve every name against `TOKEN-MAP.md`.
- **C only:** remove the page's own `window.top` / `body.dark` MutationObserver
  — `themeSync.js` replaces it. `reports.html` is the exception: keep its
  Chart.js redraw, rebound to the `yc-theme` window event:
  ```js
  addEventListener('yc-theme', () => { if (chartState) drawCurrent(); });
  ```
- **D:** no `:root`, no vars. Replace literals with tokens by reading each in
  context. Slower, no punch list.

### Why `window.top` and not postMessage

`document.querySelectorAll('iframe')` from the shell only reaches direct
children. Actual nesting:

```
index.html → automationManager.html → automation/triggers.html
index.html → caseConfigManager.html → caseconfig/fields.html
index.html → portalManager.html     → portaladmin/*.html
index.html → case.html              → caseForm / 341 / det / SendingForm / tasksFrame / …
```

`automation/triggers.html` and `caseconfig/fields.html` were both on the v1
page list and both sit at depth 2 — v1's broadcast would never have reached
them. It also misses the SweetAlert modal frames (`calendar.html`,
`apptform2.html`, `eventform.html`, `etch.html`), created after the shell has
booted.

`window.top` + MutationObserver is depth-independent, needs no relay, and
handles frames created at any time. It is already the repo's own pattern —
`pipelineBoard.html`, `tasks.html`, `customView.html` and `reports.html` all
run it today against `body.dark`. `themeSync.js` is that pattern generalised.

---

## 5. Verification, per page

Run all five before committing:

1. `grep -o 'var(--[a-zA-Z0-9_-]*' <page> | sort -u` — every name must exist
   in `theme.css`.
2. Open the page in the shell. Toggle. Both modes legible, nothing invisible,
   nothing transparent that should not be.
3. If the page is nested (`automation/*`, `caseconfig/*`, `portaladmin/*`,
   the `case.html` form frames) — toggle with it **open** and confirm it
   follows live, not just on reload. This is the regression the design is
   there to prevent.
4. Family B only: confirm light mode is actually legible. These pages have
   never rendered light; contrast was never checked against a white surface.
5. No new console errors.

---

## 6. Rollout order

| # | slice | revert unit |
|---|---|---|
| 1 | Add `theme.css` + `themeSync.js`. Purely additive, nothing references them yet | commit 1 |
| 2 | Shell §3.1–3.2 + 3.5 + 3.6. Bridge keeps `body.dark` alive | commit 2 |
| 3 | Family C, one page per commit. `dbConsole` → `customView` → `reports` → `tasks` → `pipelineBoard` (ascending orphan count) | per page |
| 4 | Shell §3.3–3.4 — the 41 selectors + telemetry | commit |
| 5 | **`apikeys.html` alone. Stop. Fred reviews the inversion.** | commit |
| 6 | Family B, remaining 11 | per page |
| 7 | Family A, 25 pages. Nearly identical `:root` — batch by directory | per directory |
| 8 | Remove the legacy bridge from `applyTheme` | commit |
| 9 | `style.css` hexes only — §7. Arial stays | commit |
| 10 | Family D, 21 pages, ascending hex count | per page |
| 11 | Density pass — §8. Includes `--header-h` 56→52 and `style.css` Arial → `var(--ui)`, each its own commit | separate arc |

Steps 1–2 revert as a pair. Everything after is independently revertible.

---

## 7. `style.css`

31 unique hexes, no `:root`, 234 lines. Three specific problems beyond the
mechanical swap:

- **`.big-button`, `.pop-button`, `.switch-button` use `#007bff`.** That is
  Bootstrap blue, not the brand `#07ADEF`. `index.html` already has
  `body.dark .tab-main .big-button` rules forcing them back to `var(--accent)`
  in dark mode — so today the primary CTA is a *different blue* in light than
  in dark. Fixing it to `var(--accent)` in both makes those shell overrides
  redundant; delete them.
- **`.logTable th` uses `#26abe2`** — a third blue. → `var(--accent)`.
- **`body` and `.logTable` set `font-family: Arial`. LEAVE THEM.** The mockup
  drops Arial deliberately and `var(--ui)` is the right end state — but a
  typeface swap changes x-height and advance widths on every page at once, so
  text re-wraps, table columns re-width, and button labels re-fit. That is a
  metric change (§0.1) and it belongs in §8, as its own commit, revertible on
  its own. Do not fold it into the hex pass.

Also `iframe { height: 100vh }` is global here. Harmless for theming, but it
is why nested frames can overflow — out of scope, noted so it is not
mistaken for a regression introduced by this work.

---

## 8. Density pass (separate arc — do not start until §6 step 10 is done)

Colour unification alone does not make the app compact. It makes it *consistent*.
Compactness needs the type and control scale actually applied, and that is a
layout change on every page — much higher regression risk than colour.

`theme.css` ships the scale as tokens (`--fs`, `--ctl-h`, `--pad-cell`,
`--pad-btn`, `--gap*`) measured off the mockup, so they are available and
agreed. Applying them is its own arc with its own verification, driven by a
`theme-base.css` element layer (`input`, `select`, `button`, `table`) that
pages opt into one at a time.

Two items are parked here by §0.1 and should be the arc's first two commits,
because they are global and everything after is measured against them:

1. **`--header-h` 56px → 52px** in `theme.css`. Check header vertical centring
   after — the logo is 40px, leaving 6px of slack per side at 52px.
2. **`style.css`: `body` and `.logTable` `font-family: Arial` → `var(--ui)`.**
   Its own commit. Sweep for text that now wraps differently — dense tables
   (`checklistView`, `campaign`, `reports`) and fixed-width buttons
   (`.big-button` 170px, `.pop-button` 75px, `.switch-button` 150px) are where
   it will show first.

Do not sneak density changes into the colour commits. When a page's spacing
changes in the same commit as its colours, an unrelated layout bug becomes
impossible to bisect.

---

## 9. Standing rules for the worker

- **Repo beats this document.** If a file does not match what is written here,
  stop and report the divergence. Do not work around it.
- **One page per commit.** The regression stays isolated to the page in hand.
  That is the entire reason for the ordering in §6.
- **No new tokens without adding them to `TOKEN-MAP.md` first.** If a page
  needs a concept the sheet lacks, that is a finding to report, not a local
  `:root` to reintroduce.
- **Do not retune the core block of `theme.css`.** The values are the
  mockup's. Additions past the CORE block are annotated with why they exist;
  match that standard.
- Family B pages: **stop after `apikeys.html`** and get sign-off before the
  other eleven.
- **Does it move a pixel? Then it is not this arc.** §0.1. This is the rule
  that resolves the borderline cases without escalating each one.
