# mobile-survey

Phone-width layout check for the staff shell. It boots the real
`public/index.html` against a mock API and opens every surface the shell
hosts, at the widths you pass:

| Group     | What it opens |
|-----------|---------------|
| `tabs`    | every sidebar tab |
| `panels`  | every More Features / Admin panel (each `[data-target]` tile — new tiles are picked up automatically) |
| `files`   | a case file and a contact file, and every tab inside each (Refresh is skipped: it opens a reload confirm) |
| `dialogs` | New Client, New Case, New Appointment, New Event, Reschedule, the appointments calendar, Show Appointment, the two Log adopt dialogs (case docket, phone/email) |

For each surface it records **horizontal overflow**: the shell document, the
pane document, any visible nested frame (e.g. `tasks.html` inside a case tab),
and an open SweetAlert dialog, where it flags a card that is off-screen,
content poking out of the card, or a content box that scrolls sideways. It
also takes a screenshot and collects page errors.

It exits **1 if anything overflows**, so it can gate a UI change. It does not
judge looks — read the screenshots for that.

## Run

```sh
node scripts/mobile-survey/survey.js --widths 320,375,414
```

| Option | Default | |
|---|---|---|
| `--widths` | `375` | comma-separated viewport widths (phones: 320 small Android / old SE, 375 iPhone, 414 large iPhone) |
| `--only` | all | any of `tabs,panels,files,dialogs` |
| `--out` | `$TMPDIR/yc-mobile-survey` | screenshots + `report.json` |
| `--fail-on-errors` | off | page errors also fail the run |

Chrome comes from `PUPPETEER_EXECUTABLE_PATH`, else the standard macOS and
Linux install paths (`puppeteer-core` is already a dependency; nothing is
downloaded). A full run at three widths is ~250 surfaces and takes a few
minutes.

Output looks like:

```
375  ok        case:Overview
320  OVERFLOW  case:Sending Form
          nested /sendingform-bk.html?case_id=TESTCASE1 322/308 div.sf-contact-card (296px)
```

`docW/clientW` is the document's scroll width against its visible width; the
named elements are the **outermost** ones past the right edge — the thing to
fix, not its descendants.

## Browsing by hand

```sh
node scripts/mobile-survey/server.js        # http://127.0.0.1:8765
```

Open it in a browser with device emulation at phone width. Any username and
password log in (the mock `/login` hands back an unsigned token; nothing
verifies it).

## The mock

`server.js` serves `public/` through `express.static`, as `server.js` at the
repo root does — the `text/html; charset=UTF-8` header matters, because
`case.html` and `contact.html` have no `<meta charset>`. API answers:

- `POST /login`: a fake unsigned token.
- `GET /api/firm-data`: `fixtures/firm-data.json`.
- any `/api/<path>` or `/admin/<path>`: `fixtures/api/<path>.json` if it
  exists (exact path, no prefix fallback), else an empty-success envelope
  that covers the list shapes the panes read (`data`, `rows`, `entries`,
  `documents`, …), so an un-fixtured pane renders its empty state.

Fixtures cover one case (`TESTCASE1`) with two contacts, appointments, log
rows, an alert, a custom-field value and a pipeline (`cases/TESTCASE1/pipeline`),
one contact (`9001`), tasks, documents, a one-field registry
(`field-defs`) and a CTA list covering every link state (`cta`, plus
`cta/2/executions` and — for clicker inputs, declarations and submitted
values — `cta/10/executions` for browsing a detail by hand) — enough to fill the tables
that tend to overflow and to put every conditional Overview / Case Details box
on screen. The mock ignores
query strings, so `field-defs` answers for contacts too (a case def on the
contact form): fine for layout, not a behaviour fixture. **They are synthetic and must stay that way** (the repo
is treated as public): no real staff, client names, phones or emails. To
survey a surface with real-shaped data, add a fixture at the endpoint's path.

## Limits

- Layout only. No API behaviour is exercised; saves go nowhere.
- The current user is a superuser, so Admin panels open. Role-gated
  rendering is not covered.
- The builder editors under Automations, YisraCase Config and Portal Manager
  are surveyed for overflow, but they are desktop editors by decision; their
  screenshots on a phone are expected to be cramped.
