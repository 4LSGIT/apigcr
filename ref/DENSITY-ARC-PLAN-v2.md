# YisraCase density arc — plan (v2, measured)

Supersedes `ref/DENSITY-ARC-CHARTER.md`. That charter was written from the
mockup. This one was written after measuring the repo, and **two of its three
core assumptions were wrong.**

---

## 0. What the measurement changed

### The app is already compact

Font-size distribution across every in-scope file:

```
 11px  452      12px  606      13px  324      14px  128
```

Median-of-medians across the 43 pages that set sizes: **12.0px**.
The mockup's base: **12.5px**.

The premise of the original charter — apply a compact scale to an app that is
not compact — is false. The app is already at the target size. What it is not
is *consistent*: pages cluster at 11, 12, 13 and 14 with no rule.

**This shrinks the arc dramatically**, and it means "compact" is not the thing
worth chasing. Consistency is.

### `theme-base.css` should not exist

The charter's §3 proposed building an element layer for pages to opt into.
There are already two, and they are already loaded in the right places:

| layer | pages | overlap |
|---|---|---|
| `public/style.css` | 14 | none |
| `public/css/yc-forms.css` | 10 | none |
| **neither** | **45** | style themselves entirely |

Adding a third layer would mean a new file, a new link on 69 pages, and the
ordering trap the charter itself flagged as the easiest thing to get wrong.
Editing the two existing layers reaches the same 24 pages with none of that.

**The 45 self-styled pages are already at 11–13px** and need nothing from a
shared layer. Their spread is the long tail, and it is optional.

### The real gap is concentrated in one file

`style.css` is where the app is genuinely chunky, and it reaches 14 pages
including `index.html`, `case.html`, `contact.html` and `tasks.html`:

| element | current | height | target | delta |
|---|---|---|---|---|
| `input` / `select` (`:74`) | `padding:10px`, inherits 16px | 41.2px | 28px | **+13.2** |
| `.logTable td/th` (`:158`) | `padding:8px`, inherits 16px | 37.2px | 28px | **+9.2** |
| `.big-button` (`:117`) | `padding:10px 20px` | 39.2px | 32px | +7.2 |
| `.switch-button` (`:142`) | `height:50px`, `font-size:14pt` | 50.0px | 32px | **+18.0** |

A 20-row `.logTable` is **804px** today and **528px** at `--pad-cell`. That is
a third of a screen, on the tables staff read all day.

`14pt` on `.switch-button` is ≈18.7px — the largest control text in the app,
and the only place in the repo using point units.

**Also found:** `style.css:150` reads `padding: opx`. Not `0px` — the letter o.
Invalid, so the declaration is dropped and the UA default applies. Harmless
today; fix it while in there rather than "correcting" it into a real change.

### Arial is already the minority

52 pages use a system stack. Arial survives in 24 in-scope pages, and **not one
of them declares it** — all 14 `style.css` consumers and all 10 `yc-forms.css`
consumers inherit it from the shared sheet. Six more declare it themselves.

So the Arial change is bounded to two shared files plus six pages, and it is a
**consistency fix**, not an app-wide retypesetting. The original charter called
it "the highest-reach line in the arc" and overstated it.

---

## 1. Slices

| # | slice | files | risk |
|---|---|---|---|
| D1 | `--header-h` 56 → 52 | `theme.css` | trivial |
| D2 | Arial → `var(--ui)` | `style.css`, `yc-forms.css`, 6 pages | low — 52 pages already system |
| D3 | **`style.css` controls + tables** | 1 file, 14 pages | **the whole point of the arc** |
| D4 | `yc-forms.css` controls | 1 file, 10 pages | medium |
| D5 | per-page type spread → 3-step scale | 45 pages | optional, long tail |

D3 is where the value is. D1 and D2 are small and clear the parked items. D5
is genuinely optional and should not start until D3 has shipped and been lived
with — the app may already read as consistent once the shared controls match.

**Do not set `body { font-size }` anywhere.** Only two pages do today
(`campaign` 14px, `dbConsole` 13px), so everything else inherits the browser's
16px for any element that does not set its own size — headings, paragraphs,
labels, unsized cells. Setting it globally would shrink all of those at once,
which is the one unbounded risk in this arc and is not worth taking for a
0.5px difference from the median.

## 2. Risk surface

Measured, for D3 and D4:

- **486** `width:NNNpx` declarations
- **189** `white-space: nowrap`
- **142** `max-width:NNNpx`
- **25** files with `@media` queries

`style.css` itself pins seven fixed widths — `.input-label` 150px,
`.input-label-top` 200px, `.sub-label` 200px, `.big-button` 170px,
`.pop-button` 75px, `.switch-button` 150px, and the global control at 200px.
The last one is documented in the file as outranking ContactPicker's own
`.cp-input { width:100% }` at 0,2,1. **Changing control padding does not change
these widths, but it changes what fits inside them** — that is the thing to
screenshot.

## 3. Verification, per slice

Different from the colour arc: contrast is settled, layout is not.

- **Screenshot before and after at two widths**, one desktop and one narrow.
  Diff them. A metric change that moves nothing is suspicious; one that moves
  everything needs explaining.
- Check anything already tight: table headers, button labels, badge text,
  and the 189 `nowrap` sites.
- Check the narrow breakpoint. `index.html:436` drops the logo to 32px there,
  and 25 files carry their own media queries.
- Confirm no horizontal scrollbar appears where there was none.

## 3.1 The theme.css boundary — DENSITY out, COLOUR in

**Refined after C12.** The original wording said no element rules in
`theme.css` at all. That was too broad and it hid a live bug: 25 pages have
controls with no colour rule anywhere, so the UA renders them white in dark
mode. Only `style.css:350` paints controls dark, and only 14 pages load it.

The boundary that actually holds:

| | in `theme.css`? | why |
|---|---|---|
| **colour** baseline on `input`/`select`/`textarea` | **yes** | consistent with `body` and `a`, which it already sets. Nothing else supplies it on 25 pages |
| **density** — padding, height, font-size | **no** | the 45 pages loading no element layer are already at 11–13px and need nothing |

Density rules stay in `style.css` and `css/yc-forms.css`. The rest of this
section is about density and still stands.

The tempting move in this arc is to lift `input` / `select` / `textarea` /
`button` / `table` rules out of `style.css` and into `theme.css`, because
`theme.css` reaches 69 pages and `style.css` reaches 14. **Do not.**

- The 45 pages that load neither element layer are **already at 11–13px**.
  They need nothing. Applying control density to them is unbounded change for
  no measured benefit.
- `theme.css` is a token sheet. Its only non-token rules are `body`, `a`, and
  the class-scoped `.swal2-*` block. Element-level rules change its contract.
- It would detonate a known landmine, and probably others not yet found:

  `automation/sequences.html:3388` and `:3622` —
  ```html
  <select id="swal-cond-mode" style="…;border:1px solid var(--border);background:white">
  ```
  Unclassed, inside a Swal, `background` hardcoded and `color` unset. Safe
  today **only** because that page links `theme.css` and not `style.css`. Add
  `select { color: var(--text) }` to `theme.css` and it becomes `#e1e4e8` on
  white — **1.28:1, twice.**

  Fix that `background:white` regardless — it is a light island in dark today.

The colour arc's most expensive lesson was that widening a rule's reach has a
blast radius you must enumerate first. Slice 9c unscoped one selector and
caused two regressions. That is why the colour baseline above ships only after
a landmine sweep, not before.

## 3.2 Swal-injected DOM, and the rule that actually finds it

SweetAlert attaches its container to `<body>`. Element-level rules reach it;
page-scoped ones do not. That is why 9c's verification — which sampled
`#appHeader` and `#appSidebar` — declared unscoping safe and shipped two
regressions into dialogs.

"Open every dialog" is too blunt to act on. The precise rule, derived by
measuring all four sites in the repo:

> A control inside a Swal `html:` block breaks when it is **unclassed** *and*
> its inline style sets **only one** of `background` / `color`.

| site | classed | inline sets | dark |
|---|---|---|---|
| `#riNote` `index.html:4666` | no | `color` only | **1.07** |
| `.ri-kind` `index.html:4630` | no | both | island, 10.31 |
| `#clioCheckNow` `index.html:2535` | no | both | island, readable |
| `#suElevUser` `index.html:3370` | `.swal2-input` | `background` only | `theme.css` `!important` wins |

Classed controls are already protected — `theme.css` guards
`.swal2-input`/`-textarea`/`-select` with `!important`, and `style.css`
excludes `.swal2-styled`. Both halves set means a self-contained island: ugly,
readable, survivable. **Unclassed with one half set is the whole defect
class**, and it is greppable.

### The form every audit in the colour arc missed

Eleven slices of auditing grepped `#[0-9a-fA-F]`. **CSS colour keywords were
invisible to all of it.** Five in-scope sites, every one broken in dark:

- `.phr-ti` and `.ex-message` (×3): `background: white`, tokenised border, **no
  colour partner** — §3.2's defect class in a container. `--text` inherits to
  near-white on white: **1.23:1**.
- `.ex-step-num` (×2): `background: var(--cat-indigo); color: white` — both
  halves set, but `--cat-indigo` is a *text* token that lightens in dark, so
  white lands on `#8ea2ff` at ≈2.2. The `--cat-*-fill` case.

`rgb()` is 2 sites (one a comment), `hsl()` zero. **Sweep for keywords, not
just hexes**, and remember `white`/`black`/`gray` are the common ones.

**Grep it with a multi-line window.** These styles are built by string
concatenation across several lines, so a same-line grep returns zero — which
is how `#riNote` stayed unfound. Use `grep -A6` or read the block.

## 4. Standing rules

- **Repo beats this document.** Both of the previous charter's core assumptions
  were wrong and measurement found it. Nine manager predictions were wrong
  across the colour arc; the worker was right every time.
- **Colour is not this arc.** Report colour defects, do not fix them — the
  mirror of §0.1, for the same bisectability reason.
- **One file or one page per commit.**
- **Construct greps carefully, not just read them carefully.** `grep -l
  "style.css"` matches `el.style.cssText`; the real count is **14 `<link>`
  consumers, not 19.** That miscount is baked into slice 9c's own commit
  message ("19 pages load style.css … the other 16 had no dark support" —
  really 14 and 13), so **any blast radius quoted from that commit inherits
  it.** Nine instances of this class across the colour arc, twice by the
  manager after writing the rule down.
- **A same-line grep misses string-concatenated styles.** Use a window.
- **A `#hex` grep misses colour keywords.** `background: white` is the same
  defect as `background: #fff` and eleven slices of auditing never looked for
  it. Tenth instance of this class.
- **An element with no rule anywhere is invisible to a per-page conversion.**
  The colour arc tokenised what each page declared and never asked what each
  page *omitted*. That is how 25 pages ended up with white inputs in dark.

## 5. Colour items carried, not blocking

- `index.html` Help & Support dialog: `#riNote` text is `#111827` on `#1a1e2a`,
  **1.07:1** — invisible typing, live since slice 4. Four inline literals at
  `:4667`, `:4668`, `:4670`, `:4745`. Smallest real bug outstanding.
- Native controls unthemed in dark — no `color-scheme` set.
- Bootstrap components unthemed — app sets `data-theme`, not `data-bs-theme`.
- `.swal2-close` vendor `#ccc` on white, 1.61:1.
- `forms/render.html` stays light in a dark shell — deferred dual-use decision.
- `--border` as a chip background on 4 pages, 4.30.
- ~50 `-on-soft` alias call sites could collapse to plain tokens.
- `js/reportCharts.js`: 6 of 10 series hues under 3:1 on the light page.
- `ESIGN_STATUS_META`: 2.77 / 3.76 / 3.77 at 11px bold — spec + test change.
- `.appointment-box`, `.input-ta`, `.input` are dead selectors.
- `campaign.html` calls `Swal.fire` but never loads SweetAlert — framed from
  `index.html:2302`, and iframes do not share globals. Pre-existing.