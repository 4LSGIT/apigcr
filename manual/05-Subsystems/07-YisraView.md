# YisraView — Working Lists

A **view** answers *which cases need me today* — not with a number, but with a
list you can click into.

Views run on the same engine as [Reports](06-reports.md): the same saved SQL, the
same curated schema, the same read-only database user, the same guards. The
difference is what comes out and what you can do with it. A report gives you a
chart and a figure. A view gives you rows, filters at the top, sortable columns,
and cells you can click to open the case or the client.

The rule of thumb: **a report is a number, a view is a to-do list.**

## What you can do with it

- **Open a working list** — leads needing follow-up, hearings coming up, fees
  outstanding.
- **Filter it** with dropdowns and search boxes at the top.
- **Sort any column** by clicking its header. Blanks always sort last.
- **Click straight into a case or client** — the row opens it as a file, exactly
  as if you'd searched for it.
- **Copy a value** — a docket number, a hearing dial-in link — with one click.
- **Export to CSV**.
- **Pin one view to your own sidebar tab**, named and iconed however you like.

## Where to find it

**More → Views** shows every view you can see, and lets you move between them.

You can also put a single view on **your own tab** in the sidebar — see
[Your own tab](#your-own-tab) below. That's the intended home for the one list
you look at every morning.

---

## Using a view

**Filters** sit in a panel at the top. Dropdowns re-run the view as soon as you
change them; text boxes run on Enter, or press **Run**.

Two conventions worth learning:

- **"All" means no filter.** Picking it removes the filter rather than searching
  for the word "All."
- **"None" / "Not set" means genuinely empty** — a case where nobody has recorded
  anything in that field yet. Usually that's the point of the list: *which leads
  have we not sent the course info to.*

**Sorting** — click a column header once for ascending, again for descending.
Sorting works on everything you've loaded, not just the page you're looking at.

**Paging** — 100 rows at a time, with the total shown at the bottom left. If a
view says its results were cut off, tighten the filters rather than trusting the
tail.

**Row actions** — some cells are links or have a small copy button:

| Looks like | Does |
|---|---|
| Case ID as a link | Opens the case as a file |
| Client name as a link | Opens the contact as a file |
| A copy icon next to a value | Copies that value to your clipboard |

Opening a case from a view is the same as opening it anywhere else — if it's
already open, you're taken to it rather than getting a duplicate.

**Caveats** are printed under the table, and **Show the SQL behind this view**
sits under those. Same principle as reports: nothing here is a black box.

---

## The views that ship

| View | What it's for |
|---|---|
| **Leads — Follow Ups** | Open cases and where each one stands: first credit-counseling course, pre-petition contract, notes. Defaults to Open cases with nothing sent yet. |
| **341 Hearings** | Section 341 meetings, soonest first, with docket, chapter, trustee and the dial-in link. Set **From** to a past date to review recent hearings. |
| **Filing Fees & Installments** | Cases on an installment filing fee: where the fee stands, when the final installment is due, any live show-cause order. Closed cases hidden unless you ask for them. |

These are starting points, not the limit. Ask IT for a view of anything the
database actually knows.

---

## Your own tab

**Settings → My Custom Tab** gives you one tab in the sidebar that's yours.

1. **Shows** — pick a view, "All views (browse)", or one of the app pages listed.
2. **Tab Name** — up to 40 characters. It's suggested from your choice; change it
   to whatever you'd actually call it.
3. **Icon** — click one from the grid, or type any
   [Font Awesome](https://fontawesome.com/icons) free-solid name into the box
   next to it (`paw`, `rocket`, `gavel`). The grid is a shortcut, not a limit.
4. Check the **Preview**, then **Save Custom Tab**. The sidebar updates
   immediately — no reload.

**Remove Tab** takes it back off your sidebar. Nothing else is affected.

A few notes:

- The tab is **yours alone**. Changing it affects nobody else's sidebar.
- Pick **a specific view** and the tab opens straight into it. Pick **All views**
  and the tab opens the list, so one tab reaches everything.
- Tabs can only point at pages **inside YisraCase**. If you need an outside site
  embedded, ask IT — they can set that up for you, and once it's set you can
  still rename and re-icon the tab without losing it.

---

## Authoring a view (super-users)

A view **is a report** — the same `report_definitions` row, with `kind` set to
`view`. There is deliberately no second table, no second editor and no second
validator to drift apart. Use the Reports editor, or ask the AI, exactly as you
would for a report; the differences are these three.

### 1. `viz` is `{"type":"table"}`

That's what makes it draw as a list rather than a chart.

### 2. `columns_meta` describes the columns

```jsonc
[
  { "key": "case_id",      "label": "Case",   "format": "text",
    "action": { "type": "open_case", "idKey": "case_id" } },
  { "key": "contact_name", "label": "Client",
    "action": { "type": "open_contact", "idKey": "contact_id" } },
  { "key": "contact_id",   "hidden": true },
  { "key": "case_notes",   "label": "Notes",  "width": 320 }
]
```

| Field | Meaning |
|---|---|
| `key` | Must match a column name the SQL returns. |
| `label` | Column heading. Defaults to a tidied-up version of the key. |
| `format` | `text`, `number`, `percent`, `currency`, `days`, `date`. |
| `align` | `left`, `right`, `center`. |
| `width` | Pixels, clamped to 40–600. |
| `hidden` | In the result but not shown — how you carry a `contact_id` for a link without showing the number. |
| `action` | See below. |

Any column the SQL returns that you don't describe is still shown, with a
tidied-up heading. You can't accidentally hide data by forgetting to list it.

### 3. Actions come from a fixed list

| `type` | What the renderer does |
|---|---|
| `open_case` | Opens `row[idKey]` as a case |
| `open_contact` | Opens `row[idKey]` as a contact |
| `open_bill` | Opens `row[idKey]` as a bill |
| `copy` | Copies the cell value to the clipboard |

An action carries **only a registry name and column references** — never a URL,
never a snippet of JavaScript, never a template. That boundary is deliberate and
enforced on the way in. If you need behaviour that isn't on this list, it needs
to be added to the renderer, not smuggled through a definition.

Bad hints are forgiving: an unknown action type or a missing `idKey` drops the
action and keeps the column, with a warning, rather than failing the save. A
wrong hint should never cost you a correct view.

### Writing the SQL

Two traps account for nearly every broken view.

**Trap 1 — one `?` per parameter.** The natural way to write an optional filter
uses two placeholders for one parameter, and is rejected:

```sql
AND (? IS NULL OR c.case_stage = ?)        -- rejected: two ? for one param
```

The single-placeholder forms, all of which are in use in the shipped views:

```sql
-- Ordinary column, blank = no filter.
-- Use <=> (NULL-safe equality), NOT =. With plain =, a row where the column is
-- NULL fails the test against itself and vanishes from the results.
AND c.case_stage <=> COALESCE(?, c.case_stage)

-- Same, but where the filter has a default and still needs a real "All" option.
-- A blank value falls back to the default, so "All" has to be a sentinel the
-- SQL recognises and throws away.
AND c.case_stage <=> COALESCE(NULLIF(?, '__all__'), c.case_stage)

-- Free-text contains-search, blank = no filter.
AND c.case_status LIKE CONCAT('%', COALESCE(?, ''), '%')

-- A yes/no toggle, blank = no.
AND (c.case_stage <> 'Closed' OR ? = 'yes')
```

**Trap 2 — multi-value columns.** A dozen columns on `cases` are MySQL `SET`
columns and read back as comma-separated strings:
`case_1st_course`, `case_2nd_course`, `case_pre_petition`, `case_post_petition`,
`case_garnish`, `case_issues_bk_vehicle`, `case_issues_bk_other`, `matrix`,
`schedules`, `filing_fee`, `docs`.

A row's value is `'Sent Info,Received'`, not `'Received'`. So:

```sql
WHERE case_1st_course = 'Received'     -- returns ZERO rows. Always.
```

This is the worst kind of bug, because the view looks like it works and simply
says nothing needs doing. Test membership properly:

```sql
-- Optional multi-value filter, blank = no filter.
AND COALESCE(FIND_IN_SET(?, c.case_1st_course), 1)

-- Same, but with a "None" option for rows where nothing is set at all.
AND COALESCE(FIND_IN_SET(?, CONCAT(IF(c.case_1st_course = '', '__none__', ''),
                                   ',', c.case_1st_course)), 1)
```

Do **not** reach for `LIKE '%Received%'` on these. Tokens are substrings of each
other — searching for `Sent` also matches every `Sent Info` row, and you'd never
notice.

### Filters that are dropdowns

Add `control` and `options` to a parameter:

```jsonc
{
  "name": "stage", "type": "string", "label": "Stage", "default": "Open",
  "control": "select",
  "options": [
    { "value": "__all__", "label": "All" },
    { "value": "Open",    "label": "Open" },
    { "value": "Closed",  "label": "Closed" }
  ]
}
```

An option with `"value": null` sends nothing at all, so the parameter's own
default applies. An option with a sentinel value like `__all__` sends that
sentinel, which the SQL then discards — that's the form to use when the parameter
has a default you need to be able to override.

### Publishing it

Save it, then either point someone's custom tab at
`/customView.html?key=<report_key>`, or just tell them it's in **More → Views** —
every shared view appears there automatically.

---

## A few things to know

### A view is only as honest as its filters

The most dangerous view is one that silently returns nothing because a filter
never matches — see the multi-value trap above. When a new view is built, run it
once with filters wide open and confirm the row count looks like the real world
before anyone relies on it.

### Views don't change anything

Everything here is read-only, all the way down to the database user, which holds
no permission to write. A view can show you that ten cases need a contract sent;
it can't send them. Clicking through to the case is how you act on it.

### The page keeps no memory

A view tab with a `?key=` opens that view every time. A tab without one always
opens the list. Nothing is remembered between loads, and **all views** is always
available in the top-left, so no view can trap you.

### Big lists are capped

Views are capped at a couple of thousand rows. If you hit that, the view is
telling you it's the wrong shape for the question — narrow the filters, or ask
for a report that counts instead of a list that enumerates.
