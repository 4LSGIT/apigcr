# YisraCase density arc — charter

The colour arc is complete. This is the other half of the original goal: making
the app read as **one compact UI** rather than sixty consistent-coloured ones.

Prerequisite: theme arc slices 1–10b merged. Read `ref/THEME-HANDOFF-v2.md`
§0.1 and §8, `ref/TOKEN-MAP.md`, and `ref/THEME-CHEATSHEET.md` first.

---

## 1. Why this is a separate arc

§0.1 held every metric change out of the colour arc, and that rule earned its
keep — ten slices bisected cleanly because a layout bug could never be confused
with a colour one. The same rule now runs in reverse: **this arc changes only
metrics.** If a colour needs fixing mid-slice, report it and move on.

Colour changes are invisible when they are right. Metric changes re-wrap text,
re-width table columns and re-fit button labels — on pages nobody opens during
review. That is the entire risk profile of this arc, and it is higher than the
colour arc's was.

## 2. What is already decided

`theme.css` ships the scale, measured off the Claude Design mockup, with usage
frequency in the comments. No new values need choosing:

```
--fs: 12.5px        base            --ctl-h: 28px       inputs, selects, row buttons
--fs-sm: 11.5px     secondary       --ctl-h-lg: 32px    toolbar / primary buttons
--fs-xs: 10.5px     badges, counts
--fs-lg: 14px       section heads   --pad-cell: 6px 8px
--fs-title: 19px    page title      --pad-btn: 7px 12px
                                    --pad-card: 13px
--gap-sm: 6px                       --pad-panel: 18px 20px
--gap: 8px
--gap-lg: 14px
```

Two items are parked from the colour arc and are this arc's first two commits,
because they are global and everything after is measured against them:

1. **`--header-h` 56px → 52px** in `theme.css`. The shell's current value is
   56; the mockup says 52. Check header vertical centring after — the logo
   renders 91×40, leaving 6px of slack per side at 52px.
2. **`font-family: Arial` → `var(--ui)`** in `style.css` and
   `css/yc-forms.css`. Its own commit. This is the highest-reach line in the
   arc: Arial and the system stack have different x-heights and advance
   widths, so text re-wraps everywhere at once. Sweep dense tables
   (`checklistView`, `campaign`, `reports`) and fixed-width buttons
   (`.big-button` 170px, `.pop-button` 75px, `.switch-button` 150px) first —
   that is where it will show.

## 3. The mechanism

Do **not** apply the scale by editing sixty pages. Build a `theme-base.css`
element layer — `input`, `select`, `button`, `table`, `td`, `th` — that pages
opt into one at a time by adding the link. Same shape as `theme.css`: additive,
revertible per page, and one place to tune.

That gives the arc the property the colour arc relied on: **a page that has not
opted in is unchanged.** A slice can stop half-done without leaving the app in
a mixed state that is hard to reason about.

`style.css` and `css/yc-forms.css` already carry element-level rules. Where
`theme-base.css` and one of those disagree, the older sheet wins on source
order — so `theme-base.css` loads after them, not before. **This is the
opposite of `theme.css`'s ordering rule** and the single easiest thing to get
wrong.

## 4. Slice shape

| # | slice | scope |
|---|---|---|
| 1 | `--header-h` 56 → 52 | `theme.css`, one line |
| 2 | Arial → `var(--ui)` | `style.css`, `css/yc-forms.css` |
| 3 | Build `theme-base.css`, opt in one page | additive |
| 4+ | Opt in pages, batched by family | per page or per directory |

Families from the colour arc still apply and are still the right batching:
family C (5) and family B (13) are the most uniform; family D (21) is the long
tail; the three `*Manager.html` shells are byte-identical to each other.

## 5. Verification, per page

Different from the colour arc — contrast is settled, layout is not.

- **Screenshot before and after at two viewport widths**, one desktop and one
  narrow. Diff them. A metric change that moves nothing is suspicious; one that
  moves everything needs explaining.
- Check text that was already tight: table headers, button labels, badge text,
  anything with `white-space: nowrap` or a fixed width.
- Check the narrow breakpoint specifically. `index.html:436` drops the logo to
  32px there, and several pages have their own media queries.
- Confirm no horizontal scrollbar appears where there was none.

## 6. Standing rules

- **Repo beats this document.** If a file does not match what is written here,
  stop and report the divergence with the line. Eleven of the colour arc's best
  findings came from a worker doing exactly that.
- **Measure before accepting a prediction, including the ones in this
  document.** Seven predictions were wrong across the colour arc and the worker
  was right every time.
- **Colour is not this arc.** Report colour defects; do not fix them. The
  reverse of §0.1, for the same reason.
- **One page per commit**, one directory per commit at most for the uniform
  families.
- **A grep for a pattern also matches prose about that pattern.** Six instances
  in the colour arc, including two that changed a page's classification.

## 7. Open colour items, carried

Not blocking, recorded so they are not lost:

- Native controls (checkbox, radio, date picker) are unthemed in dark — no
  `color-scheme` set. A one-line `theme.css` decision.
- Bootstrap components are unthemed — the app sets `data-theme`, not
  `data-bs-theme`.
- `.swal2-close` is vendor `#ccc` on white, 1.61:1 in light, on every dialog.
- `forms/render.html` stays light inside a dark shell — the deferred dual-use
  decision, now the only light frame in `case.html`.
- `--border` used as a chip background on 4 pages measures 4.30. Use
  `--surface-2`.
- ~50 `-on-soft` alias call sites could collapse to their plain tokens.
- `js/reportCharts.js`: 6 of 10 series hues fall under 3:1 on the light page
  (`#84cc16` 1.84 … `#f97316` 2.61); all 10 clear 4.23–9.06 on dark. Same
  "designed against the dark preview" pattern as the sheet's own light values.
- `ESIGN_STATUS_META`: `partially_signed` 2.77, `signed` 3.77, `bounced` 3.76
  at 11px bold. These are the 2C spec and `tests/esignActionsUi.test.js`
  asserts the hexes — a design and test change together.
- `.appointment-box`, `.input-ta` and `.input` are dead selectors with no
  markup anywhere in `public/`.
- `textarea` has a dark-mode border rule but no light-mode one in `style.css` —
  pre-existing asymmetry, now global.