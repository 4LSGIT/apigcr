# Reports — Overview

Reports answer questions about the firm with a **number**: how many cases opened
last quarter, what the appointment no-show rate looks like month by month, how
long a case takes to go from open to filed.

A report is a **saved question**. Someone writes it once — or asks the AI to
write it — and from then on anyone can run it, filter it, chart it, export it,
or have it emailed on a schedule. The answer is recalculated live against the
database every single time, so a report you saved in March is still telling you
the truth in November.

Its sibling, **[Views](07-YisraView.md)**, uses the same engine to answer a
different kind of question — *which cases need me today* — as a working list
instead of a number. If you want a list you can click into, read that page
instead.

## What you can do with it

- **Run any saved report** — pick it from the list, adjust the filters, get an
  answer in a second or two.
- **Chart it** — bars, lines, pies, stat cards. Switch chart type on the fly
  without changing the report, and save the chart as a PNG.
- **Export to CSV** — for anything that needs to go into a spreadsheet.
- **See the SQL** — every report will show you exactly how it got its number.
- **Ask for a new report in plain English** (super-users) — describe what you
  want, review what the AI writes, save it if it's right.
- **Email a report automatically** — through YisraFlow, on a schedule.

## Where to find it

**More → Reports** in the main navigation. Any logged-in user can run any saved
report. **Creating and editing** reports is limited to super-users, because a
report definition is stored SQL, and writing one is a different act from running
one somebody has already reviewed.

---

## Running a report

1. Open **More → Reports**. Reports are grouped by category.
2. Click one. It runs immediately — reports are cheap, so you get an answer
   without having to press anything.
3. If it has **filters**, they appear in a row above the result. Change them and
   press **Run**.
4. Use the chart-type buttons above the chart to reshape it, **PNG** to save the
   picture, or **CSV** to download the underlying rows.
5. **Show the SQL** at the bottom reveals the query. You never have to trust a
   number you can't check.

### Filters and dates

Filters are declared by whoever wrote the report. Leaving one blank usually means
"no filter" — but that depends on how the report was written, so read the
description.

Date filters understand **relative shorthand** as well as real dates:

| You type | You get |
|---|---|
| `today` | today's date |
| `yesterday` | yesterday |
| `-30d`, `-90d` | 30 / 90 days ago |
| `-6m` | six months ago |
| `month_start` | the 1st of this month |
| `last_month_start`, `last_month_end` | the bounds of last month |
| `year_start` | 1 January this year |

These resolve **on the server, at run time**. That matters: a report whose start
date is saved as `-30d` always means "the last 30 days," whether you run it today
or next year, and whether you're on your laptop or your phone. It never depends
on your computer's clock or timezone.

A filter named `end`, `to`, `until` or `before` automatically covers the whole of
its closing day, so a range ending `2026-07-31` includes everything up to
11:59:59 pm that night rather than stopping at midnight.

### Reading the caveats

Many reports carry **caveats** — short warnings printed with the result. These
are not boilerplate. They're there because this database has genuine traps in
it, and a number without its caveat can be confidently wrong. For example:

- `case_chapter` is blank on about 83% of cases, because chapter is only recorded
  once a case is actually filed. Any chapter breakdown covers filed cases only.
- `case_file_date` is populated on roughly 16% of cases.
- `case_source` contains booking-channel junk (`https://api.calendly`, `Acuity`)
  on rows written before August 2026 — those are not lead sources.

If a caveat is printed, quote it when you pass the number on.

---

## Asking the AI for a report (super-users)

Click **Ask**, describe what you want in plain English, and press **Draft it**.

> *appointment no-show rate by month for the last 6 months*

The model does **not** answer your question. It writes the SQL that answers your
question — a report *definition* you can read, run, edit and save. From the
moment you save it, no AI is involved ever again. That separation is the whole
point: the output is reviewable and it produces the same number every time.

You get one of three outcomes:

- **Drafted** — you see the SQL, up to 50 preview rows, and the caveats it wrote
  for itself. Press **Save as report**, or **Edit first** to open it in the
  editor.
- **Refused** — the data genuinely can't answer the question, and it says why.
  This is a useful answer, not a failure. (See *What reports can't tell you*
  below.)
- **Invalid** — it wrote something the validator rejected twice. Rephrase, or
  write the SQL yourself.

Not happy with the draft? Use the **Refine** box — *break it down by month*,
*exclude closed cases* — and it rewrites the definition.

### What the model can and can't see

It sees a **curated description of the database**: 23 allowlisted tables with
hand-written notes about what each column actually means, how full it is, and
where it lies. It does **not** see the raw schema, and it does **not** see the
110-table reality of the database.

It never sees **result rows** — not on the first attempt, not on a retry. If a
query fails, the model is handed the error message and the row count, and nothing
else. Free-text columns in this database (case notes, missing-document notes) are
partly written by clients through intake forms, so feeding rows back to something
that writes SQL would open a door for no benefit.

**What can I report on?** — the button next to **Ask** — shows you the same
curated table list the model gets.

---

## Writing a report by hand (super-users)

**New** opens the editor. The fields:

| Field | What it is |
|---|---|
| **Key** | Permanent handle, lowercase with underscores (`cases_by_stage`). Used by scheduled emails. **Cannot be changed later.** |
| **Title** | What people see in the list. |
| **Category** | Groups it in the list. |
| **Description** | One or two lines. Worth writing — it's the only context anyone else gets. |
| **SQL** | A single `SELECT`. `?` placeholders in left-to-right order. |
| **Params** | JSON array declaring those placeholders. |
| **Caveats** | JSON array of warning strings, printed with every result. |
| **Viz** | Chart hint, e.g. `{"type":"bar","x":"stage","y":"n"}`, or `null`. |

**Validate & preview** runs it without saving anything, so you can iterate freely.

A parameter declaration looks like:

```json
[
  { "name": "start", "type": "date",   "label": "From",  "default": "-90d" },
  { "name": "stage", "type": "string", "label": "Stage", "required": false }
]
```

Types are `date`, `datetime`, `number`, `string`. The number of declared params
must exactly match the number of `?` in the SQL, and they bind in order.

> **One `?` per parameter.** The obvious "optional filter" pattern —
> `AND (? IS NULL OR c.case_stage = ?)` — uses two placeholders for one
> parameter and is rejected. The single-placeholder forms are listed in the
> [Views page](07-YisraView.md#writing-the-sql), and they apply equally here.

---

## Emailing a report

YisraFlow's **`report_email`** internal function runs a saved report by key and
sends it. Use it in a scheduled job for a weekly digest, or in a workflow.

Key arguments: `report_key`, `to` (comma-separated, required — there is no
default audience), `format` (`chart`, `table`, or `text`), and `report_params`
for the filters. Relative date tokens resolve at send time, so
`{"start":"-30d"}` always means the last 30 days.

Every guard that applies in the browser applies here too, the run is logged like
any other, and **the caveats travel with the number** — an emailed report carries
its own warnings.

See [YisraFlow → Internal Functions](../03-YisraFlow/05-internal-functions.md).

---

## What reports can't tell you

Worth knowing before you spend ten minutes phrasing a question that has no
answer:

- **Anything historical about case stages.** There is no stage-history table.
  Time-in-stage, stage transitions, funnel conversion, "how many cases were open
  as of March" — none of it is answerable. The only progression signals are the
  open, file and close dates.
- **Money.** No billing or payments data is in the reporting set. Revenue, fees
  collected and accounts receivable can't be reported on.
- **Client SSNs or dates of birth, or any password or access token.** These are
  permanently blocked, in every form, including through an alias or a subquery.

If you ask for one of these, the AI will refuse and tell you why. That refusal is
correct — take it at face value rather than rephrasing until something slips
through.

---

## A few things to know

### Why reports are safe to hand out

Report SQL runs as a **separate, read-only database user** that holds permission
to read and nothing else. It physically cannot change or delete anything,
whatever a report says. On top of that:

- The SQL is checked against the curated table list, the blocked-column list, and
  a ban on `SELECT *` — **when it's saved and again on every single run**. That
  second check matters: if a table is later retired from reporting, reports built
  on it start failing loudly instead of quietly reading something they shouldn't.
- Every query is planned before it runs. If the database estimates the work is
  enormous — an accidental cross join, say — the report is refused before it can
  slow anything down for anyone else.
- Every query is capped at 20 seconds.
- Filter values are always bound as parameters, never pasted into the SQL, so
  nothing you type in a filter box can change what the query does.

### Every run is recorded

Each run writes to the run history: who ran it, with which filters, how many rows,
how long it took, and any error. It's the first place to look when someone says
"the report was different yesterday."

### The number can change and the report can still be right

Reports read live data. Two runs an hour apart can legitimately differ. If a
number moved and you want to know why, check the run history first and the
caveats second.

### A report you can't explain is a report you shouldn't send

Every result has **Show the SQL** underneath it. Before a number leaves the
firm, it's worth thirty seconds to open that and check the query is asking what
you think it's asking.
