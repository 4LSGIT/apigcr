# mobile-survey

Phone-width layout check for the staff shell. It boots the real
`public/index.html` against a mock API and opens every surface the shell
hosts, at the widths you pass:

| Group     | What it opens |
|-----------|---------------|
| `tabs`    | every sidebar tab, plus the Calendar tab's List (rows + quick actions) and Grid modes |
| `panels`  | every More Features / Admin panel (each `[data-target]` tile — new tiles are picked up automatically), plus sub-surfaces for some (below) |
| `files`   | a case file and a contact file, and every tab inside each (Refresh is skipped: it opens a reload confirm) |
| `dialogs` | New Client, New Case, New Appointment, New Event, Reschedule, Show Appointment, the two deadline quick actions (complete, cancel), the two Log adopt dialogs (case docket, phone/email) |

For each surface it records **horizontal overflow**: the shell document, the
pane document, any visible nested frame (e.g. `tasks.html` inside a case tab),
and an open SweetAlert dialog, where it flags a card that is off-screen,
content poking out of the card, or a content box that scrolls sideways. In
each document it also flags a visible element **cut off at the right edge
while the document itself fits** — `position:fixed` chrome such as the shell
header never widens the document, so a document-width check alone is blind to
it (the header clipped Log Out at 769–1150 px for a long time while every
surface said ok). It also takes a screenshot and collects page errors: puppeteer's
`pageerror` (uncaught exceptions) **and** a window `error` / `unhandledrejection`
listener in every frame, which is the only place "ResizeObserver loop completed
with undelivered notifications" shows up. An exception reaches both; it is
counted once.

It exits **1 if anything overflows**, so it can gate a UI change. It does not
judge looks — read the screenshots for that.

**Manuals** (`panel:manualsDiv:*`): the index, the `03-YisraFlow` section, four
real chapters (`03-YisraFlow/05-internal-functions`, `03-YisraFlow/15-triggers`,
`05-Subsystems/13-custom-fields` — wide tables, long inline code —
and `02-YisraForms/11-api-reference` — API paths in headings), search results
for `workflow` (the capped 50-row list, highlighted snippets) and the chapter
its first result lands on (`search-hit`, terms highlighted), and the phone
contents drawer (with the search box). `manuals.html` scrolls its whole body inside `#content`, so a
too-wide table or an unbroken word pushes `#content` sideways while the
document stays the viewport's width. These surfaces therefore ALSO fail when
`#content` scrolls sideways (`box #content scrollW/clientW`, naming the
outermost element — or `text in <tag>` for an unbreakable run — past its
content edge). The check is per-surface (`m.boxes` in `survey.js`), not
applied to every pane.

## Run

```sh
node scripts/mobile-survey/survey.js --widths 320,375,414
```

Phone widths are the default gate, but mid widths matter too: tablet and
narrow-desktop layouts (769–1200 px) are where the header and the wide tables
broke unseen. For a change to the shell, a header, a table or anything with a
desktop breakpoint, also run `--widths 800,1000,1200`.

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
fix, not its descendants. When the document fits (`docW` equals `clientW`), the
line reads `cut off at the edge:` and names the visible elements past the edge
with their right edge in px, e.g.
`shell 320/320 cut off at the edge: div#hdrUserArea.hdr-right (139px, right 362)`.

What counts as visible: rendered (`checkVisibility` — not `display:none`, not
`visibility:hidden`, not `opacity:0`, on it or an ancestor), not zero-size, not
inside an ancestor that scrolls or clips sideways, and not **parked** — an
element that is positioned (`absolute`/`fixed`) or transformed and lies wholly
past the right edge, the way an off-canvas drawer or a hidden toast waits. No
selector allowlist. (A document that scrolls sideways still lists every
element past the edge, visible or not, as it always did.)

## Manual heading ordinals

```sh
node scripts/mobile-survey/manualOrdinals.js
```

Manual search (`GET /manual/search`) names a hit's heading by its ordinal
among the chapter's h1..h6, counted by the server's parser in
`routes/manuals.js`; the viewer resolves it against the h1..h6 that marked
rendered in the browser. This walks every chapter on the same mock origin and
checks the two heading lists agree (text and order), then opens three hits
per chapter through the real router and checks each lands on its heading.
One `GO` / `NO-GO` line; exit 1 on any mismatch or page error. No
screenshots. **Run it after bumping the marked pin in `manuals.html`, or
after changing the heading parser in `routes/manuals.js`.**

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
- `GET /manual`, `/manual/:section`, `/manual/:section/:file`: the REAL
  `routes/manuals.js`, reading the repo's `manual/` from disk (no DB, no
  fixture). Only its auth middleware is stubbed: `lib/auth.jwtOrApiKey` is
  pre-seeded in `require.cache` with a pass-through while the router loads,
  then the cache is restored. The Manuals panel therefore surveys real
  chapters — a manual edit can fail the gate.

Fixtures cover one case (`TESTCASE1`) with two contacts, appointments, log
rows, an alert, a custom-field value and a pipeline (`cases/TESTCASE1/pipeline`),
one contact (`9001`), tasks, documents, a one-field registry
(`field-defs`) and a CTA list covering every link state (`cta`, plus
`cta/2/executions` and — for clicker inputs, declarations and submitted
values — `cta/10/executions` for browsing a detail by hand), two mailboxes
(`mailboxes` — one with an overlong address and display name), and the comms
hub (`mail/mailboxes`, `mail/messages`, `mail/views`, plus one conversation at
`mail/threads/t1%40example-firm.test` — the list's first row — for browsing a
thread by hand; the survey itself opens the list only), the comms Phone tab
(`phone-lines/readable`, `phone-lines/1/conversations`, `phone-lines/1/calls`,
one conversation at `phone-lines/1/conversations/5555550199` — overlong names,
an unbroken URL, a short code — and one with a number no contact holds at
`…/conversations/5555550198` (Add to contact, an attachment-only text, a
call), and All numbers at `phone-lines/all/{conversations,calls}` +
`…/all/conversations/5555550199` (line tags, "via" bubbles, the From pickers)
— surveyed as `tab:tabComms:phone-*`, with the tabs row's admin-tools slot
showing (`comms-archive/admin` says archive admin) and its Do-not-transcribe
dialog opened from Comms (`tab:tabComms:phone-no-transcribe`); the 5555550199 thread also carries the
comms archive's fields — a summary, Listen / Transcript, a voicemail, MMS
thumbnails / chips / a purge tombstone, admin ⋯ buttons, a call with no
transcript and its status line, a six-digit `#` reference number — with
`comms-archive/media/<id>/{url,transcript}` behind the transcript viewer, the
archive file viewer, the Purge dialog and the Re-summarise dialog (a noted
Sonnet summary, a pending voicemail summary), `tab:tabComms:phone-archive-*`; and
the In call transcripts group from `comms-archive/search`,
`tab:tabComms:phone-search-transcripts`), the
System Alerts pane's Comms archive section (`comms-archive/health`,
`panel:systemAlertsDiv:comms-archive`), the Calendar tab's list
(`calendar-range` — one row per action-cell shape, surveyed as
`tab:tabCalendar:list`; Grid is `tab:tabCalendar:grid`, against an empty
`calendar-feed`), the
Connections phone-line Access editor (`phone-lines/admin`,
`phone-lines/1/grants`, `users`; `panel:connectionsDiv:phone-access`) and its
Do-not-transcribe dialog (`comms-archive/no-transcribe` — a long note, an
unbroken one; `panel:connectionsDiv:phone-no-transcribe`), the
Scratch Browser list (`admin/scratch` — an unbroken overlong key, a stale and
an oversized row; plus `admin/scratch/fred/demo_state` for opening a value by
hand) — enough to fill the tables
that tend to overflow and to put every conditional Overview / Case Details box
on screen. The mock ignores
query strings, so `field-defs` answers for contacts too (a case def on the
contact form): fine for layout, not a behaviour fixture. **They are synthetic and must stay that way** (the repo
is treated as public): no real staff, client names, phones or emails. To
survey a surface with real-shaped data, add a fixture at the endpoint's path.

## Limits

- Layout only. No API behaviour is exercised; saves go nowhere.
- Right edge only. Nothing checks the left edge, or vertical clipping (a
  fixed bar or sheet cut off at the bottom).
- Content clipped INSIDE a box (`overflow:hidden`/`auto` on an ancestor) is
  skipped by design — the box is the fix, or it scrolls. That also skips a
  fixed element under such an ancestor, even though a fixed element escapes
  the clip.
- The parked rule trusts positioning: a positioned or transformed element
  pushed WHOLLY past the edge by a layout bug reads as parked. An in-flow
  element pushed wholly off (a flex item past a fixed header's end) does count.
- Page errors are uncaught exceptions, unhandled rejections and window
  `error` events. `console.error` calls and failed requests are not counted,
  and errors fail the run only with `--fail-on-errors`.
- The current user is a superuser, so Admin panels open. Role-gated
  rendering is not covered.
- The builder editors under Automations, YisraCase Config and Portal Manager
  are surveyed for overflow, but they are desktop editors by decision; their
  screenshots on a phone are expected to be cramped.
