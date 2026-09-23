# Writing new UI in YisraCase — theme cheat sheet

For any new markup added to a converted page. Follow this and it themes for
free; ignore it and you get a light-mode island on a dark page.

Full detail: `ref/TOKEN-MAP.md`. This is the short version.

---

## The page must link the sheet

```html
<link rel="stylesheet" href="/theme.css">
<script src="/themeSync.js"></script>
```

Above the page's own `<style>`, and **above `style.css` / `css/yc-forms.css`**
if it loads them. Blocking `<script src>` — not `defer`, not `async`.

If you are adding to `index.html`, `case.html` or `contact.html`, this is
already there.

## Tokens you actually need

| want | use |
|---|---|
| page background | `var(--page-bg)` |
| a card / panel | `var(--surface)` |
| a chip, striped row, recessed area | `var(--surface-2)` |
| a container a card sits *inside* | `var(--surface-sunken)` |
| body text | `var(--text)` |
| secondary text | `var(--text-2)` |
| labels, captions, hints | `var(--text-muted)` |
| a border | `var(--border)` — stronger: `var(--border-strong)` |
| a link, or accent-coloured text | `var(--accent-2)` |

## The five traps

**1. `--accent` is not a text colour.** It measures 2.29–2.55 on light
surfaces. It is for solid fills and large decoration. **Accent-coloured text
uses `--accent-2`.** This one caught the sheet itself for eight slices.

**2. A hardcoded background must declare its own `color`.** If you write
`background: #1d2230` and set no colour, everything inside inherits `--text` —
near-white in dark mode, and 1.28:1 on your dark box in light. The three worst
bugs of the arc were all this, and they are invisible to a grep for colour
declarations, because the broken elements are the ones with **no** declaration.

**3. A `<button>` does not inherit `color`.** Give any themed button an
explicit colour or it keeps UA black on your themed background.

**4. Status colours have three roles.** Reaching for the wrong one is the most
common mistake:

```css
/* text, icon, or border */        color: var(--danger);
/* solid button background */      background: var(--danger-fill);
                                   color: var(--fill-text);
/* tinted badge */                 background: var(--danger-soft);
                                   color: var(--danger);
```

Same shape for `--ok` and `--warn`. `--warn-fill` takes `--warn-text`
(near-black), not `--fill-text`. A solid `--accent` button takes
`--accent-text`. A grey solid button is `--neutral-fill`.

**5. CSS inside JavaScript still needs tokens.** Template literals,
`innerHTML` strings, SweetAlert `confirmButtonColor`, `.style.background = ...`
— all of it. Six separate times this arc, a CSS grep came back clean and the
page was still broken. `var()` works in SweetAlert colour options.

## No new tokens

If something seems missing, it probably is not:

- **a tint for a colour with no `-soft`** → `color-mix(in srgb, var(--cat-teal) 7%, transparent)`
- **a hover for a fill** → `filter: brightness(0.92)`
- **a chip background** → `--surface-2`, never `--border` (that measures 4.30 and fails)

## Density is live — size in tokens too

The density arc (UDS, closed 2026-09-23) put the metric scale in play. Both
holds this section used to park are shipped (`--header-h` is 52px; Arial is
`var(--ui)` everywhere), `body` is `font-size: var(--fs)`, and users pick
Compact / Default / Comfortable on the Theme page — a second axis beside the
palette presets (state rules in `themeCustom.html`'s header; the density
axis is the ONE regex `/^--(fs|ctl-h|pad|gap)/` defined there).

- New UI states sizes in tokens — `--fs`/`--fs-sm`/`--fs-xs`/`--fs-lg`,
  `--ctl-h`, `--pad-cell`/`--pad-btn`, `--gap*` — or just inherits. A
  hardcoded px font-size is frozen out of the user's density choice.
- A width tuned to fit N things at the default size must grow with the
  scale: `max-width: max(850px, 53.125em)` (`.tab-row`, style.css) is the
  pattern. `max()`, not a bare em — Compact must never shrink what fits
  today (its rows still need 86% of the default width; fixed paddings and
  gaps don't scale).
- **`case.html` and `contact.html` render in quirks mode** (no doctype):
  tables there do NOT inherit font-size, so a table that should ride the
  scale declares it on the table element itself (`.logTable` does).
  Standards-flip is a filed slice — `ref/plans.md`.

## Lists that paginate

One pager for the whole app: `/js/ycPager.js` (the pager arc, Sep 2026).
Never hand-roll a footer and never copy the module into a page — three
verbatim copies of the old pager is how the arc started.

- Load it with `<script src="/js/ycPager.js">` in the head, **before
  `scripts.js`** where the page loads that (`renderLogFooter` renders through
  it).
- `YcPager.renderFooter(el, opts)` draws the strip; `onPage(p)` hands back a
  **0-based page index** — offset callers do `p * limit`, page-param callers
  `p + 1`. Optional slots: `sizes`/`onLimit` (per-page select), `expand`,
  `onPrint`, `onExport`. `renderPages` is the bare ‹ 1 2 … n › strip.
- Page-size memory: read `YcPager.getLimit('<key>', <default>)` at boot and
  pass `persistKey: '<key>'` — one localStorage map (`yc.pager.limits`), one
  key per surface, so every list remembers its own size. Pick a fresh key for
  a new surface: **`grep -rn "getLimit(" public/` lists the taken ones** —
  every consumer reads at boot, whereas a `persistKey` grep misses the two
  ingest pages, which write through `YcPager.setLimit(...)` from their
  toolbar Limit selects instead of the footer. The one deliberate exception:
  the log tables (index/case/contact) share `yc.log.limit` — one lever for
  every log table, by design.
- Empty page but a non-zero count? `YcPager.snapBackOffset(total, limit,
  offset)` → refetch at the returned offset when ≥ 0. It only ever moves
  strictly backwards, so it cannot loop.
- Do **not** convert load-more / keyset feeds (api-key log, form-builder
  history, triggers), activity.html's time-cursor fan-out, or capped lists
  whose footer says "narrow the window" — offset paging is the module's
  contract, and those surfaces reject it on purpose.

The long version is the module's own header; behavior is pinned in
`tests/ycPager.test.js`.

## Check it

Open the page in the shell, toggle dark, toggle back. Then:

```bash
grep -o 'var(--[a-zA-Z0-9_-]*' yourfile.html | sort -u
```

Every name must exist in `public/theme.css`. A `var()` that resolves to nothing
gives a transparent background or invisible text — it fails silently, not
loudly.