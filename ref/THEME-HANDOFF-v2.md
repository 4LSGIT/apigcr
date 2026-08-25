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

### Family C — already light + dark (5 pages)
`index.html`, `pipelineBoard.html`, `tasks.html`, `customView.html`,
`reports.html`

*(`dbConsole.html` was listed here in the first cut of this charter and is
wrong. The classifier matched `.dark {` inside a comment at dbConsole.html:135
which says, verbatim, that the console has no light mode. Its `:root` is
`--bg:#0f1117` — it is family B. Same false-positive class as the 44-vs-41
`body.dark` count: **a grep for a CSS pattern also matches prose about that
pattern.** Filter comments before trusting any count in this document.)*

They have a light `:root` plus a `body.dark` override, and the first four
already follow the shell live via a `window.top` MutationObserver. Converting
these is mostly renaming: the dual values collapse onto one token that already
handles both modes. **Lowest risk — do these first**, and they prove the
whole mechanism end to end.

### Family B — dark-only today, will INVERT (13 pages)
`apikeys.html`, `availabilitymanager.html`, `bookingviewsmanager.html`,
`connections.html`, `dbConsole.html`, `formBuilder.html`, `issueReports.html`,
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

### Family E — JS modules, no HTML at all (8 files)

Not in the first cut of this charter, and a real gap. These modules inject
inline-styled UI that renders against themed surfaces. Unconverted, you get
light-mode widgets sitting on dark pages.

| file | uniq hex | JS-side dark reads |
|---|---|---|
| `public/scripts.js` | 32 | 0 |
| `public/js/mascot.js` | 20 | 0 |
| `public/js/reportCharts.js` | 16 | 3 |
| `public/js/assetpicker.js` | 16 | 0 |
| `public/js/videoInsert.js` | 11 | 0 |
| `public/js/versionGuard.js` | 9 | 0 |
| `public/esign/esignActions.js` | — | injects a stylesheet via `style.textContent` |
| `public/esign/placementEditor.js` | — | same |

`scripts.js` is the important one: the shell and 9 other pages load it, and it
carries ContactPicker, the adopt dialog and the name-slot widget as
inline-styled markup. Its colours are literals — family-D-style work.

**`reportCharts.js` is different and urgent.** At :496–500 it reads tokens
through `getComputedStyle`:

```js
text: cs.getPropertyValue("--muted").trim() || "#6b7280",
grid: cs.getPropertyValue("--line").trim() || "#e5e7eb",
dark: document.body.classList.contains("dark"),
```

`--muted` and `--line` are both deleted by `TOKEN-MAP.md`. The moment
`reports.html` or `customView.html` converts, this silently falls back to its
hardcoded light greys and paints them on a dark chart. **It cannot be caught
by the `var(--` grep in §5** — `getPropertyValue("--muted")` is not `var(--muted)`.

Both consumers are in family C, so the fix is coordinated inside slice 3.
These are the only two such reads in the repo; `grep -rn getPropertyValue public/`
confirms.

### Scope table

| fam | page | orphans | uniq hex |
|---|---|---|---|
| C | `pipelineBoard.html` | 21 | 35 |
| C | `tasks.html` | 19 | 32 |
| C | `index.html` | 8 | 45 |
| C | `customView.html` | 5 | 21 |
| C | `reports.html` | 5 | 21 |
| B | `dbConsole.html` | 4 | 14 |
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
```

The inline script goes at the very top of `<head>`. **The stylesheet link does
not** — insert `theme.css` immediately above the existing `style.css` line,
wherever it sits, and change nothing else:

```html
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" type="text/css" href="style.css" />
```

In `index.html` that is lines 82/83, after the Font Awesome CDN. Lifting
`style.css` to the top of `<head>` to sit beside `theme.css` would flip its
precedence against Font Awesome for no reason. The only requirement is
`theme.css` **before** `style.css`, so `style.css` keeps winning on
`body { font-family: Arial }`, which §0.1 is holding.

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

### 3.5 Header logo — self-host the existing wordmark

**Decision taken: keep the wordmark, serve it locally.** The choice between
the wordmark and the square icon was a false one; the only argument with real
weight was the cross-domain dependency, and self-hosting removes that without
touching the design.

```html
<a href="https://app.4lsg.com/">
  <img class="hdr-logo" src="/assets/lsg-logo.webp" alt="4LSG YisraCase">
</a>
```

Copy the existing asset to `public/assets/lsg-logo.webp` (400×175, 15,204
bytes) and change the `src`. Same image, same rendered 91×40, **zero visual
change** — so unlike the icon swap it is not a metric change and does not
collide with §0.1.

Keep `class="hdr-logo"`: it carries `flex-shrink:0` plus the narrow-viewport
`height:32px` rule at index.html:436, and `js/mascot.js:1004` binds its
long-press to `.hdr-logo`. An inline `style="height:40px"` would beat that
media query and make the logo 40px on mobile.

Swapping to `/assets/icon-192.png` (192×192 → 40×40, shifting every header
element 51px left) remains available and remains a pure aesthetic call. It is
deferred indefinitely, not rejected.

### 3.5.1 The version this replaces — NOT slice 2

The first cut of this charter put this in slice 2, next to an acceptance
criterion demanding slice 2 be a visual no-op. Those contradict, and §0.1
settles it: the logo moves pixels, so it does not ride along in the no-op
commit.

Measured in production terms:

| | source | natural | at `height:40px` |
|---|---|---|---|
| now | `https://legalsolutions.group/assets/lsg-logo.webp` | 400×175 | **91×40** |
| after | `/assets/icon-192.png` (local, 18,941 bytes) | 192×192 | **40×40** |

Every header element shifts **51px left** at desktop, 41px at the narrow
breakpoint (73×32 → 32×32).

Keep the class; do not use an inline style:

```html
<a href="https://app.4lsg.com/">
  <img class="hdr-logo" src="/assets/icon-192.png" alt="4LSG YisraCase">
</a>
```

`.hdr-logo` supplies `height:40px; width:auto` and `flex-shrink:0`
(index.html:149) plus the narrow-viewport `height:32px` rule at :436. An
inline `style="height:40px"` beats that media query and makes the logo 40px on
mobile — a metric change, which §0.1 forbids.

Two non-aesthetic points for whoever decides:

- The current logo is a **cross-domain fetch on the critical header render**.
  If `legalsolutions.group` is slow or down, the header shows broken-image alt
  text. The swap removes that dependency.
- `public/js/mascot.js:1004` binds its long-press to
  `document.querySelector('.hdr-logo')`. Keeping the class keeps the easter
  egg alive; dropping it silently kills it.

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
1b. `grep -nE "getPropertyValue|classList.contains\(['\"]dark" <page>` — token
   reads and theme branches **in JavaScript**, which step 1 cannot see. A
   `getPropertyValue("--x")` on a token the page just deleted fails silently
   into a hardcoded fallback rather than rendering wrong-and-obvious. Check any
   shared module the page loads, not just the page.
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
| 3 | Family C, one page per commit: `customView` → `reports` → `tasks` → `pipelineBoard`. Includes the `reportCharts.js` fix | per page |
| 4 | Shell §3.3–3.4 — the 41 selectors + telemetry, **rewritten in place, `.tab-main` scoping kept**. Plus §3.5 logo self-host | commit |
| 5 | **`apikeys.html` alone. Stop. Fred reviews the inversion.** | commit |
| 5b | Header logo §3.5 — own commit, own review | commit |
| 6 | Family B, remaining 12 (incl. `dbConsole`) | per page |
| 7 | Family A, 25 pages. Nearly identical `:root` — batch by directory | per directory |
| 8 | *(moved into slice 4 — `index.html` was the last `body.dark` consumer once its selectors converted)* | — |
| 9 | **`css/yc-forms.css`** §6.0 — tokenise, then the six family D pages it blocks | commit + per page |
| 9b | **Prerequisite** — add the `theme.css` link to any remaining `style.css` consumer, §6.1 | per page |
| 9c | `style.css` hexes only — §7. Arial stays. Also move the shell's 33 `.tab-main` dark rules in here, unscoped, and delete `tasks.html`'s hand-rolled equivalent | commit |
| 10 | *(family D moved ahead of `style.css` — it delivers `theme.css` to most of `style.css`'s consumers, which §6.1 requires. 15 of 21 shipped in slice 8; the other 6 are blocked on §6.0)* | — |
| 10b | Family E, `public/js/` — **8 files**, `assetpicker.js` first (already loaded by a themed page), `scripts.js` last (highest reach) | per file |
| 11 | Density pass — §8. Includes `--header-h` 56→52 and `style.css` Arial → `var(--ui)`, each its own commit | separate arc |

Steps 1–2 revert as a pair. Everything after is independently revertible.

---

## 6.0 `css/yc-forms.css` — a second shared stylesheet, missed until slice 8

The charter had no step for this file and should have. 30,768 bytes, 47 hexes,
light-only, and it is **worse than `style.css`**: it sets `body { background:
#f8f9fa }`, which breaks the link ordering the charter mandates in both
directions.

| ordering | result |
|---|---|
| `theme.css` **above** it (charter §4's rule) | `yc-forms.css` wins on `body`, so the page never themes. The link is a **silent no-op** |
| `theme.css` **below** it | body themes, but `.yc-form` is a hardcoded white card declaring no `color`, so 66 descendants inherit `--text` at **1.28:1** — the whole form invisible |

11 bare light backgrounds in the file, including `body` and `.yc-form`. No
per-page link placement fixes it. **The file has to be tokenised before any
page that loads it can convert.**

Real `<link>` consumers — ten, and the same prerequisite as §6.1 applies to all
of them:

| status | pages |
|---|---|
| in scope, blocked on this | `apptform2`, `eventform`, `forms/casedetails`, `forms/contact-form`, `forms/issn`, `sendingform` |
| out of arc scope | `forms/341notes.html` |
| deferred (dual-use) | `forms/render.html` |
| **NOT backups — live primary files** | `forms/casedetails-bk.html`, `sendingform-bk.html` |

`formBuilderSimple.html` appears in a `grep -l` for the filename but only
mentions it in a comment at :451. It does not load it. (Sixth instance of a
grep matching prose about a pattern rather than the pattern.)

### The `-bk` files are not backups. Do not skip or delete them.

An earlier version of this section called them backups on the strength of the
suffix. That was wrong and it was the most dangerous error in this document.
`case.html:1424` reads:

```js
if (type === "Bankruptcy") {
  E("SendingForm").src = `sendingform-bk.html?case_id=${c.case_id}`;
  E("caseForm").src    = `forms/casedetails-bk.html?case_id=${c.case_id}`;
```

The non-`-bk` files are the **fallback** branch for case types that do not have
their own. This is a bankruptcy firm, so `-bk` is what staff open every day.
`ref/ORIGIN_SEPARATION_ROLLOUT.md:455` already said so. Both were fully
converted in slice 9.

The general lesson, and it generalises past this file: **a filename is not
evidence.** Check what loads a file before deciding what it is.

## 6.1 `style.css` has a hard prerequisite

**19 pages load `style.css`. Only 3 of them load `theme.css`.**

`style.css` cannot be tokenised — and the shell's 33 `.tab-main` dark rules
cannot be moved into it — until every one of its consumers also loads
`theme.css`. All 33 of those rules are written in `var()`; on a page without
`theme.css` they resolve to nothing, which means transparent buttons and
invisible borders rather than wrong colours.

Consumers, current state:

| loads `theme.css` | pages |
|---|---|
| yes (3) | `index.html`, `tasks.html`, `pipelineBoard.html` |
| no (16) | `case.html`, `contact.html`, `checklistView.html`, `checklistsView.html`, `formInbox.html`, `featureRequests.html`, `forms/submissionsWidget.html`, `automation/{automationsWidget,hooks,sequences,triggers,workflows}.html`, `esign/{caseWidget,dashboard,sendForm,templateAdmin}.html` |

Two of those 16 — `esign/sendForm.html` and `esign/templateAdmin.html` — are
**out of the arc's scope** and would break anyway. Tokenising `style.css`
therefore reaches past the scope boundary. Either bring those two in far enough
to load `theme.css`, or leave `style.css` alone.

**Step 8b exists for this**: add the `theme.css` link to all 19 consumers
before step 9 touches `style.css`. For the two out-of-scope pages the
stylesheet link alone is enough — they do not need `themeSync.js`, since they
are standalone and not expected to follow the shell.

Watch the `body {}` rule in `theme.css` when adding the link to a page that has
not been converted yet. It sets `margin:0`, `background`, `color` and
`font-family`. A page that does not set those itself will change. That makes
step 8b a real verification pass, not a blind insert.

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
- **Do not retune the core block of `theme.css` for taste.** The values are
  the mockup's. Additions past the CORE block are annotated with why they
  exist; match that standard.
  **A measured accessibility failure is not taste.** `--ok`, `--warn` and
  `--danger` were retuned after slice 6b showed all three failing AA as text
  on every light surface (2.87–3.96) — the mockup picked them against its dark
  preview and the light direction was never checked. When retuning for a
  measured failure: state the measurement, state what it fixes, and check
  whether the fix makes some other token redundant. That one did — it
  collapsed the whole `-on-soft` role for those three.
- Family B pages: **stop after `apikeys.html`** and get sign-off before the
  other eleven.
- **Does it move a pixel? Then it is not this arc.** §0.1. This is the rule
  that resolves the borderline cases without escalating each one.
- **A grep for a code pattern also matches prose about that pattern.** The
  `body.dark` count and the family-C list were both wrong for this reason.
  Filter comments before trusting a count — including the counts in this file.
- **CSS greps do not see JavaScript.** Before declaring a page done, check the
  shared modules it loads for `getPropertyValue` and `classList.contains('dark')`.