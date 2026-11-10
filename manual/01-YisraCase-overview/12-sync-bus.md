# The Sync Bus — how open screens stay current

**Audience:** developers (Fred + manager/worker Claude sessions returning cold). Every other manual chapter describes a tool staff use; this one describes plumbing staff never see — the reason two open windows agree with each other.

**Code:** `public/js/yc-sync.js` (the whole mechanism), plus subscriber blocks in the pages listed below.
**Design history:** `ref/YISRACASE_STORE_AND_BUS_DESIGN_V2.md` (v2.5 + amendments) — the *why* behind every decision here, with every accepted gap argued. This page is the *what*.

---

## What it is

When any frame saves case/contact/appt/event/settings data, every other open surface — other tabs in the shell, other iframes, other **browser windows** — hears about it and updates, without reloads. It exists because the pre-bus app accumulated one-off `postMessage` wires and tab-switch reloads that missed cases constantly (the founding bugs: a stage change from the Kanban never reached an open case file; a note saved in the Notes card never reached the Overview textarea).

Core doctrine: **the bus carries values, not "something changed" pings** — a message says `{case_stage: 'Filed'}`, and receivers paint it or merge it without refetching. The two named exceptions are below (`yc_refetch`).

## The pieces

- **Transport:** `BroadcastChannel('yc-sync')`. Flat — every same-origin browsing context at any iframe depth in any browser window receives every message directly. Nothing relays frame-to-frame.
- **API** (per frame that loads `yc-sync.js`):
  - `YC.emit(addr, changes, origin)` — accepts `{field:{from,to}}` (API `changes` shape) or plain `{field: value}`; normalizes to new-values; dispatches locally then broadcasts.
  - `YC.on(addr, field, fn)` — `field '*'` = any; `addr 'case:*'` = wildcard over one type (cannot cross types). Returns unsubscribe.
  - `YC.bindValue(addr, field, el)` — guarded input binding (skips focused / `ycDirty` elements).
  - `YC._log` — ring buffer of the last 50 messages, for debugging.
- **Addresses:** `case:<id>` · `contact:<id>` · `appt:<id>` · `event:<id>` · `setting:<key>` · `document:<id>` (one `documents` row) · `doclink:<link_type>:<link_id>` (the set of documents on one case or contact) · `checklist:<link_type>:<link>` (the set of notes & lists on one record) · `form:<link_type>:<link_id>` (a record's form rows — drafts and adopted submissions) · `mail:<id>` (one stored email, `mail_messages.id`) · `comms:case:<case_id>` (a case's communications set) · `relations:contact:<id>` (a contact's relation set) · `roles:contact:<id>` (a contact's role rows).
- **Message:** `{addr, fields, origin, ts}`. `origin` is a trace string (`auto:PATCH /api/cases/AAAA`, `checklistView:saveBody`).

## How announcements happen — the sniff

Nearly nothing emits by hand. Every frame's API traffic funnels through the **shell's one `apiSend`** (iframes alias it; deep frames call `window.top.apiSend` — the funnel works at any depth because it's the same function object executing in the shell realm). A hook at its success return runs `YC._sniff(method, endpoint, body)` against a matcher table; a matched endpoint whose response carries usable data emits automatically. **A new writer of an already-matched endpoint gets sync for free, forever.**

Matched endpoints (read `MATCHERS` in yc-sync.js for the always-current list — as of Slice 3d):

| Endpoint | Verbs | Emits |
|---|---|---|
| `/api/cases/:id` | PATCH | real values from `data.changes` |
| `/api/contacts/:id` | PATCH | values from `data.changes` **+ `yc_refetch` to each transfer donor** |
| `/api/cases/:id/docket` · `/pipeline/advance` | PATCH · POST | values from top-level `changes` |
| `/api/cases/:id/contacts[/:contactId]` | POST/PATCH/DELETE | `yc_refetch` (relate changes have no column diff) |
| `/api/cases/:id/merge` | POST | `yc_refetch` to the **survivor only**; dry-run silent |
| `/api/contacts/:id/booking-link` | POST | `{contact_token}` real value |
| `/api/contact-phones` · `/api/contact-emails` · `/api/contact-addresses` | POST · PATCH `/:id` | `yc_refetch` to the row's own contact; a forced phone/email create (revive) also to the donor (shape differs from the PATCH transfer — see the matcher comments; contract tests pin both producers) |
| `/api/app-settings/:key` (PUT) · `/api/app-settings` (POST create) · `/api/app-settings/:key/restore` (POST) | | `setting:<key>` with `{value}` |
| `/api/intake/contact` · `/api/intake/case` | POST | `yc_refetch` for `created`/`updated`; `found` is silent (writes nothing) |
| `/api/appts…` (PATCH, attended/no-show, create, cancel, reschedule — reschedule emits **both** old and new ids) · `/api/events…` (PATCH, complete/cancel, create) | | `yc_refetch` markers |
| `/api/documents/:id` | PATCH | real values `{title, doc_type, tags, status}` to `document:<id>` (state, not a diff) |
| `/api/documents/:id/share` | POST | `{shared_link}` real value to `document:<id>`; a non-string answer is silent |
| `/api/documents/:id/links` (POST, DELETE) · `/api/documents/upload-commit` · `/api/documents/generate` (POST) | | `yc_refetch` to `doclink:<link_type>:<link_id>` — the TARGET whose set changed (both link verbs echo it), never `document:<id>`; an upload or generate with no target is silent. `/api/documents/register` is not matched |
| `/api/documents/relink` | POST | the case's new link as a real value, `{case_dropbox}` to `case:<case_id>`, and `yc_refetch` to `doclink:case:<case_id>` (both from `result`); a `skipped` answer (sync off), or one without the case id or link, is silent. The dismiss and candidates routes are not matched |
| `/checklists` (POST) · `/checklists/:id` (PATCH, DELETE) · `/checklists/:id/items` (POST) · `/checkitems/:id` (PATCH, DELETE) — root routes, no `/api` | | `yc_refetch` to `checklist:<link_type>:<link>`, the list's record (from the list row; the list DELETE echoes `{id, link_type, link}` and the item routes `checklist: {id, link_type, link}` for it; a PATCH that re-homes the list also answers `moved_from`, announced too); an unlinked list is silent. `/checklists/upsert-items` is not matched |
| `/api/forms/draft` (POST) · `/api/forms/submissions/:id/link` (PATCH) | | `yc_refetch` to `form:<link_type>:<link_id>`, the record the form rows belong to (the draft POST echoes `form_key`, `link_type`, `link_id` for it; the link PATCH answers the target); an unlinked row is silent. The draft DELETE (it echoes its query's `form_key`, `link_type`, `link_id`) announces the same marker only when `deleted === true`. `POST /api/forms/submit` and the PDF routes are not matched |
| `/api/contact-relations` (POST) · `/api/contact-relations/:id` (PATCH, DELETE) | | `yc_refetch` to `relations:contact:<id>` for BOTH ends (from `relation`; the DELETE answers `contact_a_id` / `contact_b_id` for it) |
| `/api/contacts/:id/roles` (POST) · `/api/contacts/:id/roles/:rowId` (PATCH, DELETE) | | `yc_refetch` to `roles:contact:<id>` from the URL; a DELETE answering `removed: 0` is silent |
| `/api/mail/messages/:id/read` (POST, DELETE) · `/api/mail/messages/:id/case-link` (POST) | | real values to `mail:<id>` — `{unread}` from the read answer, `{log_id, case_id}` from the link answer — and, for a link, `yc_refetch` to `comms:case:<case_id>`. Fails closed on an answer for another id or without the value. The bulk POST `/api/mail/read` (a count, no ids), views, image senders and send are not matched; no log route (POST `/api/log`, PUT `/api/log/:id/about`) announces |

**`yc_refetch` is a reserved field**: "refetch this entity." It exists for the two shapes values can't express — an *absence* (a row left: transfers, relate removals) and a *response that carries no values* (appts/events). Handlers must never merge it into entity state. It is the only sanctioned invalidation on the bus.

**The one hand-written emit:** checklistView's `saveBody` — it's the only writer that knows the note *value*; the sniff double-covers case/contact harmlessly (emits are idempotent) and it is load-bearing for nothing since Slice 3 (comment at the site explains).

**Circuit breaker:** auto-emits are rate-limited per address (8 in 4s → dropped + one warn). Defense against loops from DB-stored form `code` hooks (unauditable from the repo) or any future handler-emits bug.

## Who listens

| Surface | Subscribes | Does |
|---|---|---|
| Shell Cases/Contacts/Appts/Events tabs | `<type>:*` | debounced silent refetch of the current page when visible; stale-flag + refetch on tab re-entry / window return |
| Shell | `setting:*` | writes `firmData.settings` in place (`applyFeSetting`) |
| case.html | `case:<own>`, `setting:fe-*`, `appt:*`, `event:*` | merge into `entityData` → fenced paints (Overview inputs, notes, header, caption, alerts) → pipeline refetch on `pipeline_phase` → serialized form push; `yc_refetch` → queued full refetch |
| contact.html | `contact:<own>`, `appt:*`, `event:*`, `relations:contact:<own>` | same shape, no pipeline; a relations marker re-reads the Relationships tab — only while that tab shows (entry reloads it anyway), parked while off screen, skipped within 1.5s of its own load |
| contact-form.html (the contact's Roles section) | `roles:contact:<own>`, through the HOST's bus (`parent.YC`) — it does not load yc-sync itself, which would switch on YCForm's `form:` listener for the contact form | re-reads the roles; skipped on its own writes (`roleApi` stamps them, 1.5s), parked while the section / frame / tab is not showing or a card is typed in, a "+ Role" card is open or the caret is in a role field |
| checklistView | per native card; `checklist:*` | updates the card body behind dirty/inflight/value-equality fences; a `checklist:` marker for its own record or (case board) a contact group reloads the board — skipped on its own echo (api() stamps writes, 1.5s), parked while hidden or typed in and reloaded on refocus / visibility / tab re-entry |
| YCForm (any form host that loads yc-sync — render.html in normal internal mode) | `form:*` | a marker for its own record re-reads `/api/forms/latest`: a clean form repopulates through `refresh()` and shows the draft banner; a form with unsaved typing is never repopulated — it shows the newer draft's banner and holds its autosave until Restore / Discard. Skipped on its own autosave / discard echo (`_api` stamps draft POSTs and DELETEs, 1.5s), parked while hidden, mid-save or typed in |
| comms.html (the comms hub) | `mail:*` | `unread` repaints the list row and the open card with no GET (a merged row stays unread while any copy is) and refreshes the counts; a link repaints the open card's log line and re-reads the list quietly — skipped for a row or card already on that case (its own write) |
| entityCommunications.html (a case's / contact's Comms tab) | `comms:case:<own case>`, `mail:*` (field `case_id`) | re-reads its feed (debounced); `mail:` only when it shows that message under another case — so its own case-tag write is skipped; parked while hidden, refreshed on return |
| documents.html (the global Documents page and the per-case / per-contact Documents widget) | `document:*`; the scoped widget also `doclink:*` | `document:` values merge into a row on screen and repaint it with no GET (a status that moves the row out of the list, or a `yc_refetch`, re-queries); a `doclink:` marker for its own target — or, under Include related, any target in the last response's `related_targets` — refetches the list (debounced; skipped within 1.5 s of its own link write) |
| pipelineBoard | `case:*` | full board refetch (query view — membership is server-computed), scroll preserved |
| calendar | `appt:*`, `event:*` | FullCalendar `refetchEvents()` |

**Forms** (hand-built and template `render.html` alike) never subscribe — their parent pushes merged `entityData` into non-dirty `ycForm`s via `refresh()`. Snapshot/preview renders are structurally excluded (grandchildren, entity-load off, locked).

## The fences (all of them)

1. **Dirty is a comparison, not a latch.** Every editable bound surface re-derives dirtiness per keystroke against the stored value (`markNotesDirty`, checklistView `d.dirty`). Focused elements and dirty elements are never painted over. Latch-style flags strand elements — this failed once and is now doctrine.
2. **Echo stamps** — a page that just caused/performed a fetch skips its own bus echo for ~1.5s: `pwLastSet` (pipeline), `boardLastLoad`, `apptsLastRefresh` (both entity pages), `entityLastRefetch` (both entity pages, stamped at refetch *start*), calendar's stamp. Ordering is safe because the local `await` continuation is a microtask while BC delivery is a task — **fragile if any of these pages ever ran in the shell's own realm** (they'd hear the local dispatch synchronously and the fence would invert).
3. **Visibility fences** — network-triggering handlers on hidden surfaces set a stale flag instead of fetching; DOM merge/paint stays unfenced (hidden pages don't re-render on show, so their DOM must track messages). Flags flush via `ycBecameVisible` — pinged by the shell's `openMainTab` walk — and a guarded `visibilitychange`.
4. **Form-push serialization** — one promise chain per entity page; queued closures read `entityData` at run time (this, not the 50ms coalesce, is the correctness mechanism); the coalesce just drops a redundant pass when `form-saved` won the race.
5. **The board defers mid-drag** (`dragging` → stale, flushed on drop).

## What it does NOT do (the honest list)

- **Server-side writers are invisible.** Workflows, sequences, court pipeline, `/api/events/batch` — anything not going through a browser's `apiSend`. Fixing this is the "server-side change feed" charter, blocked on a `cases.case_updated` column that doesn't exist yet. *This is the biggest gap.*
- **BC-absent degrade is asymmetric:** shell subscribers keep working (local dispatch); every iframe goes silently deaf. Accepted — BC is universal in target browsers; case.html's post-advance re-GET is kept as the backstop (design C1).
- **External-mode YCForms** (`config.external` → bare `fetch`, public host) bypass the funnel. **204/`responseType` responses** return from `apiSend` before the sniff (commented at the site).
- **A merged-away case's remote surfaces** aren't told (refetching a deleted case would 404; the writing page shows its banner). **A recipient's aggregates** from an aggregate-PATCH transfer (the new phone/email row) don't reach a *third* frame — scalars do. (The revive path and the child phone/email/address routes do: they refetch the row's contact.)
- **Get-or-mint booking-link announces even when it wrote nothing** (route can't distinguish; idempotent, accepted).
- **Stamp windows drop, not defer**, a legitimate remote event landing inside ~1.5s of the local one; checklistView's inflight fence likewise drops a concurrent remote note. Next event or reload self-corrects.
- **Whitespace-only edits never ride** (`buildChanges` trims for comparison).
- **Three auxiliaries are one-layer** even though the bus is flat: the `ycBecameVisible` ping only reaches the shell's direct iframes; the form push only reaches an entity page's direct children; BC-absent local dispatch only serves the shell realm.
- Eleven pages load yc-sync and never reference `YC` — deliberate uniform boot (bounded idle cost), not evidence of wiring.

## Recipes

**New writer of a matched endpoint:** do nothing. **New endpoint:** add a matcher — getter returns a fields object (addressed from the URL capture) or an array of `{addr, fields}` (addressed from the response — creates, multi-target). Fail closed on shape surprises; if the response carries real column values, emit them; if not, `yc_refetch`. Note the method gate: GET is dropped globally (that's what makes refetch handlers loop-proof); a matcher's verb list gates the rest.

**New reader:** load `/js/yc-sync.js`, `YC.on(...)`, then walk the fence checklist above — dirty guards for anything editable, an echo stamp if the page also writes, a visibility fence if the handler fetches, and **never emit from a handler** (§3.6 — the one absolute rule).

## Testing

`tests/ycSync.test.js` (matchers, breaker, contract) · `caseUi/contactUi/pipelineBoardUi/calendarUi.sync.test.js`, `contactFormRoles.sync.test.js` (real pages booted in jsdom against the real bus) · `tests/contactTransferShapes.test.js` + merge producer pins (shape drift breaks at the producer) · `tests/helpers/bcPolyfill.js`.

Harness traps, all learned the hard way: jsdom boots at `visibilityState: 'prerender'` (`document.hidden === true` — set it explicitly or you silently test the off-screen path); `const`/`let` don't survive separate `window.eval`s (pages are evaluated as ONE concatenated eval to match browser multi-`<script>` scope); the BC polyfill must be injected **per jsdom window**, never on the Node global (Node 22 has a real BC that holds jest open); stub sniffs must defer by a macrotask (`setTimeout 0`) or the echo-fence ordering inverts and the test passes for the wrong reason; synchronous test blocks race timestamps that production separates by task boundaries.
