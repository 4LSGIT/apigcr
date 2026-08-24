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
- **Addresses:** `case:<id>` · `contact:<id>` · `appt:<id>` · `event:<id>` · `setting:<key>`.
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
| `/api/contact-phones` · `/api/contact-emails` | POST | `yc_refetch` to the revive donor (shape differs from the PATCH transfer — see the matcher comments; contract tests pin both producers) |
| `/api/app-settings/:key` (PUT) · `/api/app-settings` (POST create) | | `setting:<key>` with `{value}` |
| `/api/intake/contact` · `/api/intake/case` | POST | `yc_refetch` for `created`/`updated`; `found` is silent (writes nothing) |
| `/api/appts…` (PATCH, attended/no-show, create, cancel, reschedule — reschedule emits **both** old and new ids) · `/api/events…` (PATCH, complete/cancel, create) | | `yc_refetch` markers |

**`yc_refetch` is a reserved field**: "refetch this entity." It exists for the two shapes values can't express — an *absence* (a row left: transfers, relate removals) and a *response that carries no values* (appts/events). Handlers must never merge it into entity state. It is the only sanctioned invalidation on the bus.

**The one hand-written emit:** checklistView's `saveBody` — it's the only writer that knows the note *value*; the sniff double-covers case/contact harmlessly (emits are idempotent) and it is load-bearing for nothing since Slice 3 (comment at the site explains).

**Circuit breaker:** auto-emits are rate-limited per address (8 in 4s → dropped + one warn). Defense against loops from DB-stored form `code` hooks (unauditable from the repo) or any future handler-emits bug.

## Who listens

| Surface | Subscribes | Does |
|---|---|---|
| Shell Cases/Contacts/Appts/Events tabs | `<type>:*` | debounced silent refetch of the current page when visible; stale-flag + refetch on tab re-entry / window return |
| Shell | `setting:*` | writes `firmData.settings` in place (`applyFeSetting`) |
| case.html | `case:<own>`, `setting:fe-*`, `appt:*`, `event:*` | merge into `entityData` → fenced paints (Overview inputs, notes, header, caption, alerts) → pipeline refetch on `pipeline_phase` → serialized form push; `yc_refetch` → queued full refetch |
| contact.html | `contact:<own>`, `appt:*`, `event:*` | same shape, no pipeline |
| checklistView | per native card | updates the card body behind dirty/inflight/value-equality fences |
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
- **A merged-away case's remote surfaces** aren't told (refetching a deleted case would 404; the writing page shows its banner). **A recipient's aggregates** (new phone row from a transfer/revive) don't reach a *third* frame — scalars do.
- **Get-or-mint booking-link announces even when it wrote nothing** (route can't distinguish; idempotent, accepted).
- **Stamp windows drop, not defer**, a legitimate remote event landing inside ~1.5s of the local one; checklistView's inflight fence likewise drops a concurrent remote note. Next event or reload self-corrects.
- **Whitespace-only edits never ride** (`buildChanges` trims for comparison).
- **Three auxiliaries are one-layer** even though the bus is flat: the `ycBecameVisible` ping only reaches the shell's direct iframes; the form push only reaches an entity page's direct children; BC-absent local dispatch only serves the shell realm.
- Eleven pages load yc-sync and never reference `YC` — deliberate uniform boot (bounded idle cost), not evidence of wiring.

## Recipes

**New writer of a matched endpoint:** do nothing. **New endpoint:** add a matcher — getter returns a fields object (addressed from the URL capture) or an array of `{addr, fields}` (addressed from the response — creates, multi-target). Fail closed on shape surprises; if the response carries real column values, emit them; if not, `yc_refetch`. Note the method gate: GET is dropped globally (that's what makes refetch handlers loop-proof); a matcher's verb list gates the rest.

**New reader:** load `/js/yc-sync.js`, `YC.on(...)`, then walk the fence checklist above — dirty guards for anything editable, an echo stamp if the page also writes, a visibility fence if the handler fetches, and **never emit from a handler** (§3.6 — the one absolute rule).

## Testing

`tests/ycSync.test.js` (matchers, breaker, contract) · `caseUi/contactUi/pipelineBoardUi/calendarUi.sync.test.js` (real pages booted in jsdom against the real bus) · `tests/contactTransferShapes.test.js` + merge producer pins (shape drift breaks at the producer) · `tests/helpers/bcPolyfill.js`.

Harness traps, all learned the hard way: jsdom boots at `visibilityState: 'prerender'` (`document.hidden === true` — set it explicitly or you silently test the off-screen path); `const`/`let` don't survive separate `window.eval`s (pages are evaluated as ONE concatenated eval to match browser multi-`<script>` scope); the BC polyfill must be injected **per jsdom window**, never on the Node global (Node 22 has a real BC that holds jest open); stub sniffs must defer by a macrotask (`setTimeout 0`) or the echo-fence ordering inverts and the test passes for the wrong reason; synchronous test blocks race timestamps that production separates by task boundaries.
