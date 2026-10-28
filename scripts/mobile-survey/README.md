# mobile-survey

Phone-width layout check for the staff shell. It boots the real
`public/index.html` against a mock API and opens every surface the shell
hosts, at the widths you pass:

| Group     | What it opens |
|-----------|---------------|
| `tabs`    | every sidebar tab, plus the Calendar tab's List (rows + quick actions) and Grid modes, and All's "Customize my launcher" layout editor (open on Home, its shortcut picker, the Sidebar tab and its section-label box, its Keyboard shortcuts and My buttons tabs) |
| `panels`  | every More Features / Admin panel (each `[data-target]` tile — new tiles are picked up automatically), plus sub-surfaces for some (below) |
| `files`   | a case file and a contact file, and every tab inside each (Refresh is skipped: it opens a reload confirm) |
| `dialogs` | New Client (blank, and with its already-on-file box), New Case, New Appointment, New Event, Reschedule, Show Appointment, the two deadline quick actions (complete, cancel), the two Log adopt dialogs (case docket, phone/email), the Code dialog (opened from the launcher, a long result run in it) |

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

In the launcher editor (both the personal and the firm mode) it also flags a
**tab whose label is wider than the tab**: the strip fits, so no overflow
check sees it, but the label draws over its neighbour (`box #ycLayoutEditor
.yle-tab (each holds its content)`, naming each cramped tab). Five tabs drew
over each other at 320 px that way until launcher-nits L1 let the strip wrap.

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
- `GET /api/app-settings` (settings arc): `fixtures/api/app-settings.json` —
  generated from `lib/settingsRegistry.js` with synthetic values: every home
  and section, overlong values, whitespace-padded Dropbox paths, rows with no
  value, two automation variables — filtered by `?home=` the way the route
  does; `…/:key/history` per key (`app-settings/firm_name/history.json`);
  PUT and restore echo. `credentials.json` feeds the System tab's credential
  pickers (and the API Tester's).
- `POST /__mock/persona { persona }` — who the mock answers as: `su` (the
  default, the fixture user) or `staff`, a staff-only user: `GET
  /api/ui-config` says neither gate, the settings API serves no system /
  comms rows and nothing editable, and a fixture with a `.staff` twin
  (`fixtures/api/<path>.staff.json` — `mailboxes`, `phone-lines/readable`)
  answers from the twin. The survey flips it around the steps that need it
  and puts it back.

**Settings surfaces (settings arc).** Settings' My access and Manage access
as the staff persona (`tab:tabSettings:my-access` / `:manage-access` — a
Manage grant, an attorney *via role* row, an inactive box, the card's grants
from `mailboxes/1/grants.json`); the Firm tab's setting History
(`panel:caseConfigDiv:firm-setting-history`); every other Config sub-tab as
the holder (`panel:caseConfigDiv:<id>` — Contact Roles, Lists, System and the
vocabulary tabs; a tab that does not open is a failure); the vocabulary tabs
read-only as staff (`panel:caseConfigDiv:readonly:<id>` — a missing banner is
a failure); Portal Manager → Settings; CTA Links → Link defaults.

Fixtures cover one case (`TESTCASE1`) with two contacts, appointments, log
rows, an alert, a custom-field value and a pipeline (`cases/TESTCASE1/pipeline`),
one contact (`9001`), the case and contact Communications feeds
(`cases/TESTCASE1/communications`, `contacts/9001/communications` — a
source email with an unbroken subject and overlong address, a Logged-only court
notice with an unbroken URL, a text, a call, a Logged-only email, Load older on),
tasks, documents, a one-field registry
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
hand), the Shared values list (`shared` — a 64-character name, an unbroken
180-character description, a long sentence;
`panel:sharedValuesDiv`), the Firm tab of YisraCase Config (`ui-config`, `ui-config/pickers`,
`ui-config/versions`, and for its Who sees what section `firm-data.json`'s
`ui` `visible_to` — one item with every role ticked — plus `entitlements`:
per-user hides, one item hidden from three people, one of them not in the user
list; `panel:caseConfigDiv:firm` — the step fails if the tab does not open — then its "Arrange pages
and defaults…" opens the layout editor in firm mode over the firm's layout below:
`panel:caseConfigDiv:firm-editor:home` / `:more` / `:admin` / `:more-picker`, which fail when it does not
open or its scrolling body goes wider than itself, and `panel:caseConfigDiv:firm-history-layout`, History
switched to "Pages and defaults" with a version's View open) and the firm's items (`firm-data.json`'s `ui`: a
compact tool, a 40-character label, a 40-character unbroken one, a link and a
38-character link with a long href, plus a long rename of Reports; surveyed in
`tab:tabMore` and `tab:tabAll`) placed by the firm's default **layout**
(`ui.firm.layout`, ui-custom S6c: a full More arrangement with Get Clio Code
in row 5, the four long-labelled firm items as a row of their own — the
40-character UNBROKEN label first: a desktop `.big-button` has no
`overflow-wrap`, so that word runs ~100px past its 200px tile, and in the
right-hand column at 800 that passes the viewport (the firm row placed it in
the left column; a real finding, filed) — an Admin
panel item (Users) on More that navigates to Admin, My Tasks beside Casey's
paw in More's icon row, Scratch taken off the Admin grid — so the firm row is
NOT drawn; `visible_to.admin` restricts the Admin page to it / admin like the
live firm, which wsurl.js's non-SU "staff" runs rely on). `GET /api/ui-config` answers the SAME layers —
server.js builds it from `firm-data.json`'s `ui`, with only `can_edit_firm`
and `firm_versions` from `ui-config.json` — because in production both come from one read and the
layout editor refreshes the shell when they differ), and a user's own Home and
sidebar layout (`ui.user.layout`, ui-custom S4a: both surfaces re-ordered, a
More panel and the two long-labelled firm items pinned to Home and the
sidebar, user breaks, a 39-character section label, per-surface removals (one
of them firm-locked), and `custom` — the custom tab ui-custom S5e retired — on
both, a stale id the resolver drops — on screen on every surface, the phone drawer included,
and in the layout editor (ui-custom S4b; `tab:tabAll:layout-editor`,
`…:picker`, `…:label` — these also fail when the editor's scrolling body goes
sideways, `m.boxes`) and keyboard shortcuts (`ui.user.shortcuts`, ui-custom
S4c: the longest combo the editor can draw, the two long-labelled firm items,
one binding to an item that doesn't exist so it lists as unavailable — in the
Ctrl-K palette rows (`tab:tabAll:palette`) and the editor's Keyboard shortcuts tab,
`tab:tabAll:layout-editor:shortcuts`, `…:shortcuts-add` (the picker open) and
`…:shortcuts-capture` (a long refusal message under the keys box)) and the
user's own buttons (`ui.user.items`, ui-custom S5a: a long name, an unbroken
one, a link with a long address and a retired id; one pinned to Home, one to
the sidebar and bound to a shortcut — so they are on the Home, sidebar, All
and palette surfaces too — and in the editor's My buttons tab,
`tab:tabAll:layout-editor:buttons` (its titles from `ui-config/pickers.json`),
`…:buttons-form` (a tool with the longest title picked), the icon picker
opened from that form's Choose… (ui-custom S6a: `…:icon-picker`, the whole
catalog; `…:icon-picker-search`, Brands with a 60-character query that matches
nothing — both also fail when the picker's card or its grid goes sideways,
`m.boxes`),
`…:buttons-form-error` (a refused link's message) and `…:buttons-drawer`
(a list's — a drawer's — contents with its picker open)) and a drawer (ui-custom S5b; "List" in the UI since S6c-5: one
of those buttons is a drawer with a 39-character name holding the long user
and firm labels, a role-restricted firm item (listed: the fixture user is su) and
an unknown id (dropped), pinned to Home and
the sidebar — its menu opened from the Home tile, `tab:tabHome:drawer`, and from
the sidebar row, `tab:tabHome:drawer-sidebar`, a sheet at phone width; both also
fail when the menu's list goes sideways, `m.boxes`) and a button that opens as a
tab (ui-custom S5c-b: a saved view with a 39-character name, opened through
`ycLauncher.exec` — `tab:tabUserItem`, the button tab, which also fails when its
heading goes sideways, `m.boxes`), and two PAGES (ui-custom S6c-5): the firm's
`firm:ops` (a firm item of kind page, `visible_to` it / admin — the fixture
user is su; a tile for it on More's last row; its tiles in
`ui.firm.layout.pages`: three panels incl. Users and YisraCase Config, a
break, three firm items among them the 40-character unbroken label; icons My
Tasks + Casey) and the user's `user:my-desk` (in `ui.user.items`, on Home and
the sidebar; its tiles in `ui.user.layout.pages`: Manuals (open to every
role: what a staff run drills), two panels from different hubs, the tab button, the list, the link, the long tool, the firm page, a su
tool for the gate; icons Casey, All, My Tasks) — surveyed by ITEM id as
`page:<id>` (the page's grid; its tab id is per session, so the tabs pass skips
page tabs) and `page:<id>:drilled` (its first panel open on the page itself);
`wsurl.js` (p1–p6) proves the URL never names a user's page but names a firm page (`?open=firm:ops~<panel>`, reload restores it), the in-place panel, the
same Automations iframe from More and the page, and the staff view) —
enough to fill the tables
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
