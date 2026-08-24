# YisraCase — Sync Bus Design v2.4

**Status:** Slice 1 shipped; Slice 2 shipped; Slice 2b + 2c shipped; Slice 3 shipped; Slice 3b shipped (amendments at the foot of this file)
**Date:** 2026-08-24 (v1: 2026-08-21; v2.1: 2026-08-23, SYNC_BUS_V2_SECONDARY_REVIEW; v2.2: Slice 2b multi-emit sniff; v2.3: Slice 3 appt/event fold-in; v2.4: Slice 3b review remediation)
**Scope:** cross-frame + cross-browser-tab data consistency in `public/`
**Verified against:** `4LSGIT/apigcr` @ main, fresh tarball 2026-08-23 + live DB
**Supersedes:** YISRACASE_STORE_AND_BUS_DESIGN.md (v1)

## v2.1 amendments (secondary review, verified)

| # | Amendment | Source |
|---|---|---|
| A1 | `_sniff` strips the query string before matching — `contact-form.html:696` retries the 409 cross-contact transfer as `PATCH /api/contacts/:id?force=true`, which the bare regex misses. `split('?')[0]`. | review A1 |
| A2 | The two form-push callers (existing `form-saved` refetch path + new bus subscriber) must be **serialized through one promise chain per page**, with queued closures reading `entityData` at run time; the bus push additionally defers ~50 ms and skips if a `form-saved` arrived in the window. Without this, concurrent `YCForm.refresh()` calls interleave at the awaited `onLoad`, and on contact.html a bus push carrying pre-refetch `entityData.contact` (stale flattened `phones`/`emails`) can land after the refetch push. Serialization + run-time reads guarantee the terminal state; the coalesce removes the redundant push. Header/pipeline updates stay outside the chain. | review A2 |
| A3 | `tabCasesGet(offset, silent)` — the bus-triggered refetch must not fire the `"No cases found!"` error toast (index.html:889) when a filtered page legitimately empties, nor red-toast a background network failure (console.warn instead). | review A3 |
| C1 | Advance double-fetch: **keep** case.html's post-advance re-GET (1612-1623) — it is the correctness path when BC is unavailable (sniff then dispatches in the shell realm only). The bus subscriber skips `loadPipeline()` when `pwData` was refreshed within ~1.5 s (timestamp stamped wherever `pwData` is assigned). | review C1, option b |
| C3 | `applyFieldsToOverview` also covers `case_caption` (+ `#captionLine` visibility) and `case_alerts` — both editable via casedetails forms, both rendered by `updateHeader`. | review C3 |
| B3 | `case_Rec` upgraded from "latent" to **live envelope bug**: `case.updated`'s `data: {...priorRow, ...safeFields}` carries both `case_rec` (stale) and `case_Rec` (new), so any rule reading `data.case_rec` sees the pre-write value. Verified 2026-08-23: **zero** trigger rules currently reference `case_rec` → fold the fix into Slice 1, no standalone hotfix. | review B3 + live DB |

## v2 changes at a glance

| # | v1 | v2 | Why |
|---|---|---|---|
| 1 | postMessage up to `window.top`, hub in index.html fans down recursively, `hop` loop guard | **`BroadcastChannel('yc-sync')`** — no hub, no fanout, no hop | Same-origin broadcast reaches every frame at any depth AND every browser tab. Kills v1 §1.4 entirely. ~40 lines instead of ~120. Subscriptions die with their frame — no dead-frame try/catch. |
| 2 | Explicit `YC.emit` at each writer (v1 Decision 1 recommendation) | **Auto-sniff in `index.html apiSend`** + explicit emit only where responses lack `changes` | All frame API traffic funnels through the shell's single `apiSend` (iframes alias it; checklistView/eventform call `window.top.apiSend`). One hook covers 9 case-PATCH + 2 contact-PATCH sites, every YCForm save, and **every future writer** — the forget-to-emit bug class dies structurally, not by discipline. |
| 3 | "Does advance return `changes`?" (v1 Decision 2, unverified) | **Verified: no.** Server tweak in Slice 1: `advanceStage` threads the written values out and attaches `payload.changes` | The exact clipped values written by overwrite-on-advance currently die inside the transaction closure. ~10 additive lines. |
| 4 | Docket endpoint unmentioned | **`PATCH /api/cases/:id/docket` gains `changes`** in Slice 1 | It's the case-number writer (CaseAdoptDialog, scripts.js:3481). The route already calls `updateCase`, which returns `changes` — it just discards it. Required for the Cases-tab case-number question (§6). |
| 5 | — | **Fix `case_Rec` → `case_rec`** at case.html:200 | DB column is `case_rec`. The capital-R key makes `buildChanges` read `priorRow['case_Rec']` = undefined → every Recommendation edit already emits a wrong `{from: null}` diff into the trigger system, and would key the bus wrongly. Pre-existing latent bug, one-char fix. |
| 6 | Cases tab: refetch on `case:*` | Same, **plus stale-flag**: hidden tab marks stale, refetches on open | Verified: the Cases tab fetches on first open only (`cases?'':tabCasesGet(0)`) — re-entry never refetches today. |
| 7 | Writer table | **+ `updateCaseNotes()`** (case.html ~463) — v1 omitted it | Covered by auto-sniff anyway. |
| 8 | — | **`updateHeader()` dirty guard** on `#overviewCaseNotes` | Existing bug: any `form-saved` refresh clobbers an unsaved Overview notes draft (the pipeline comment at case.html:1466 admits it). Same guard as `bindValue`. |

Everything else in v1 stands: address scheme, values-not-invalidations (§3.1–3.2), broadcast-the-response (§3.3), entity/query split (§3.4), store-does-not-notify (§3.5), handlers-never-emit (§3.6), store hoist deferred, server-side change feed deferred (re-verified live 2026-08-23: `cases` has no updated-timestamp column; `contacts.contact_updated` exists).

---

## 1. Endpoint response matrix (verified)

| Endpoint | Carries diff? | Shape | Bus coverage |
|---|---|---|---|
| `PATCH /api/cases/:id` | ✅ | `data.changes` = `{field:{from,to}}` | auto-sniff |
| `PATCH /api/contacts/:id` | ✅ | `data.changes` (scalars only; aggregates separate) | auto-sniff |
| `PATCH /api/cases/:id/docket` | ❌ → **add** | route discards `updateCase`'s return; add top-level `changes` | auto-sniff (new matcher) |
| `POST /api/cases/:id/pipeline/advance` | ❌ → **add** | add top-level `changes` from written values (non-noop only) | auto-sniff (new matcher) |
| `PATCH /api/appts/:id` | ❌ | `{status, message, updated_fields}` — raw UPDATE | explicit emit at writer (plain values) |
| `PATCH /api/events/:id` | ❌ | `data: <fresh row>` | explicit emit at writer (plain values) |

Aggregate arrays (`phones_changed` etc.) never ride the bus — they refresh via the existing `form-saved` path.

## 2. The bus — `public/js/yc-sync.js`

Loaded by every page that loads `scripts.js` via a `<script src>` tag — **16 files** as of 2026-08-23 (a prior count of 21 came from grepping mentions; `automation/phoneIngest.html`, `emailIngest.html`, `courtReview.html` carry comments saying they *cannot* load scripts.js). Self-contained IIFE, idempotent on double-load.

**Intentionally without `YC`:** `forms/render.html` and the hand-built forms in `public/forms/` do not load `scripts.js` and get no bus. Correct and deliberate — forms are refreshed *by* their parent's subscriber via `YCForm.refresh`; they never subscribe themselves. Do not "fix" this.

**Public API** — unchanged from v1:

```js
YC.emit(addr, changes, origin)
// addr:    'case:AAAAAAAA' | 'contact:1001' | 'appt:55' | 'event:12'
// changes: {field:{from,to}} (API shape) OR plain {field: value} — normalized
//          internally to {field: newValue}
// origin:  trace string, e.g. 'checklistView:saveBody' / 'auto:PATCH /api/cases/AAAA'

YC.on(addr, field, handler)   // field '*' = any; addr 'case:*' = wildcard; returns unsubscribe
YC.bindValue(addr, field, el) // guarded el.value setter — NOT for YCForm-managed fields

YC._sniff(method, endpoint, responseBody)  // shell-only hook, see §3
YC._log                                    // ring buffer, last 50 messages, for debugging
```

**Transport:** `new BroadcastChannel('yc-sync')`. `emit` = dispatch to local subscribers (BC skips the sender's own context) + `bc.postMessage(msg)`. Receiver: `bc.onmessage` → dispatch. Message: `{addr, fields, origin, ts}` — no `__yc`, no `hop`, no origin checks (BC is same-origin by construction; zero collision surface with the four existing `postMessage` users).

BC unavailable (feature-detect) → local-only degrade, console.warn once. All shipped browsers have it; jsdom needs a test polyfill (§8).

**Cross-browser-tab behavior (new capability):** two shell windows open — a stage change in one updates the case file, Kanban, and Cases tab in the other. Subscribers behave identically; nothing special-cases it.

**Dirty guard** in `bindValue` — unchanged from v1 §4.1: skip when `el === document.activeElement` or `el.dataset.ycDirty === '1'`. Binding sites set `ycDirty` on input, clear on successful save.

**§3.6 restated, load-bearing:** a handler that receives an announcement must never emit. `bindValue` sets `.value` programmatically → no `change` event → no PATCH → no loop. `YCForm.refresh` and checklistView `render` never save. Keep it that way.

## 3. Auto-sniff in `apiSend`

Hook at the success-return point of `index.html`'s `apiSend` (the single funnel — iframes alias it, deep frames call `window.top.apiSend`):

```js
try { window.YC && YC._sniff(options.method, endpoint, data); } catch (_) {}
```

Matcher table inside yc-sync:

```js
[/^\/api\/cases\/([A-Za-z0-9_-]+)$/,                    'case',    r => r?.data?.changes],
[/^\/api\/contacts\/(\d+)$/,                            'contact', r => r?.data?.changes],
[/^\/api\/cases\/([A-Za-z0-9_-]+)\/docket$/,            'case',    r => r?.changes],
[/^\/api\/cases\/([A-Za-z0-9_-]+)\/pipeline\/advance$/, 'case',    r => r?.changes],
```

The endpoint is normalized before matching — `const path = String(endpoint || '').split('?')[0]` — because the `?force=true` retry idiom is established (contact-form.html:696, :1399; scripts.js:3726) and the force-retry contact save is the one most likely to have just moved data between contacts. Fires only for PATCH/POST with a matcher hit AND a non-empty changes object. Origin string `auto:PATCH /api/cases/AAAA` + `YC._log` answer v1's traceability objection.

Covers with zero writer edits: the four inline Overview writers, `updateCaseNotes`, checklistView case/contact native cards, every YCForm save (hand-built and template-driven — both submit through `apiSend`), CaseAdoptDialog, both pipeline-advance callers, and all future writers of these endpoints.

The "standalone" pages (automationManager, caseConfigManager, portalManager, formInbox, esign/templateAdmin) are **relays**, not independent transports — their local `apiSend` forwards to the parent/shell function, so they sniff too. The only genuinely un-sniffed writers are the hand-rolled `fetch` + lifted-JWT sites (assetManager, videoManager, esign/esignActions.js, portal/portal.js, dbConsole, apiTester) — none write case/contact scalars. Duplicate emits (a writer that also emits explicitly) are free — idempotence, v1 §3.1.

## 4. Explicit emits remaining

One site: `checklistView.saveBody` after a successful native PATCH —

```js
YC.emit(`${TYPE_BY_ENDPOINT[cl.native.endpoint]}:${cl.native.entityId}`,
        { [cl.native.field]: value }, 'checklistView:saveBody');
```

Needed for appt/event notes (no `changes` in those responses); harmlessly double-covers case/contact. `appt:*`/`event:*` addresses have no Slice-1 readers — that's fine, dead traffic is free.

## 5. Readers (Slice 1)

**case.html** — one subscriber replaces per-element wiring:

```js
YC.on(`case:${caseID}`, '*', (fields) => {
  const c = window.entityData.case; if (!c) return;
  Object.assign(c, fields);                       // ← also fixes: inline writers never updated entityData
  applyFieldsToOverview(fields);                  // guarded writes: stage/status/rec/source, notes,
                                                  //   case-number header, caption (+#captionLine), alerts,
                                                  //   type selects if case_type changed
  if ('pipeline_phase' in fields && !pwRecentlyRefreshed())
    loadPipeline();                               // C1 guard: skip if pwData set within ~1.5s (the
                                                  //   in-page advance already drew the fresh payload).
                                                  //   pipeline_phase ONLY (v2.4 F13): a bare case_stage
                                                  //   change is an Overview-select edit, which moves no
                                                  //   pipeline position.
  queueFormPush('bus');                           // serialized + coalesced — see below
});
```

`pushFormsFromEntityData` = the existing sibling-YCForm loop from `refreshEntityData`, factored so the two callers cannot drift. `refreshEntityData` keeps its refetch (it serves the aggregate/array case); the bus path passes merged data with zero network.

**Serialization + coalesce (A2).** `YCForm.refresh()` is not reentrant — two concurrent push loops interleave at the awaited `onLoad`, and on contact.html a bus push carrying pre-refetch flattened aggregates can land after the `form-saved` refetch push. Both callers therefore enqueue onto **one promise chain per page**; queued closures read `window.entityData` at run time (this is what makes the terminal state correct regardless of order). The bus-side enqueue defers ~50 ms and skips entirely if a `form-saved` message arrived in the window — the refetch push strictly dominates it. Header/overview/pipeline updates run immediately, outside the chain.

The post-advance re-GET at case.html:1612-1623 **stays** — when BC is unavailable the sniff dispatches in the shell realm only and never reaches case.html, so deleting it would turn the graceful degrade into silent staleness in the frame that matters most.

Overview notes textarea gains `ycDirty` tracking (`oninput` sets, `updateCaseNotes` success clears) and `updateHeader()` skips it when dirty/focused (v2 change #8).

**contact.html** — equivalent: merge into `entityData.contact`, guarded header bits (name/phone if present in fields), `pushFormsFromEntityData`.

**checklistView.html** — per native card: `YC.on(addr, field, ...)` → if `d.dirty || d.inflight` skip; else `cl.body = value` + minimal repaint (draft-wins `shownBody` is the second fence). Covers contact-group cards (W3) too — their addr is `contact:<id>`. Subscriptions collected and unsubscribed at the top of `load()` (cards are rebuilt).

**index.html Cases tab:**

```js
YC.on('case:*', '*', () => {
  if (casesTabVisible() && !document.hidden) debounce250(() => tabCasesGet(currentOffset));
  else casesStale = true;                       // refetch on next tab open / visibility return
});
```

Refetches the current page with current filters/sort/offset — server recomputes membership, ordering, page boundaries (v1 §3.4). Never cell-patch. Bus-triggered refetches pass `silent = true`: no `"No cases found!"` toast when a filtered page legitimately empties (that emptying is the advertised feature), and background fetch failures console.warn instead of red-toasting a user who did nothing. `offsets.cases` (set at the top of `tabCasesGet`) is the current-offset source.

**Echo note:** the writing frame receives its own emit back (shell dispatch + local dispatch). Harmless by idempotence, and useful — it's what keeps `entityData` current for the inline writers.

## 6. YisraForms compatibility (verified)

The question: template forms vs hand-built forms vs snapshots.

**Live forms — participate automatically, no per-form work.** At the push boundary, template-driven (`render.html?form_key=…` Normal mode — e.g. the `341` iframe) and hand-built (casedetails, casedetails-bk, contact-form, issn) are indistinguishable: both are YCForm instances exposing `window.ycForm` with `endpoints.load` configured. `YCForm.refresh()` carries the fences (`isDirty()` → `skipped-dirty`; `_userEditSeq` typing fence around the awaited `onLoad`). `changes` keys are DB columns; `entityData.case` is column-keyed; `apiColumn` load-mapping resolves in `populate` as it does today. Resolver prefill (ifEmpty) and `derive` (fills only empty) are refresh-safe — already exercised by the `form-saved` path.

**Snapshots — excluded on three independent grounds:**
1. `render.html?view_submission=N` frames live inside submissionsWidget/formInbox — grandchildren. The push loop walks only the entity page's own iframes; it structurally cannot reach them.
2. View mode boots with `linkId ''` — entity-load paths are off; the stored submission is the only populate source; the form is locked, autosave/save off.
3. Snapshot viewers never subscribe. BC delivers everywhere, but delivery without a subscriber is a no-op.

Preview mode: same discipline, form-builder context only. Legacy Jotform ISSN iframes (`case_ISSN_form` back-compat): cross-origin — the push loop's existing try/catch skips them.

## 7. Does the shell Cases list update? (specific direction, answered)

**Yes.** Any change to a case field — stage from the Overview select, stage/status/rec from a pipeline advance (in-page or Kanban, once §1's advance tweak lands), case number from a docket adopt (once §1's docket tweak lands), notes, anything through the sniffed endpoints — hits `case:*`, and the Cases tab refetches its current page. Row values update, a row vanishes if it no longer matches the active stage filter, sort reshuffles correctly — all server-computed. If the tab is hidden it marks stale and refetches on open, which is strictly better than today (today it never refetches after first open).

## 8. Tests

- `tests/ycSync.test.js` — normalize (`{from,to}` and plain), wildcard + field matching, unsubscribe detaches, `bindValue` guards (focused, `ycDirty`), sniffer (fires on matched PATCH/POST with non-empty changes; fires on `PATCH /api/contacts/5?force=true` → `contact:5`; silent on GET, unmatched endpoints, empty changes).
- `tests/helpers/bcPolyfill.js` — ~15-line shared-registry BroadcastChannel for jsdom (jsdom 26 lacks it). **Per-window injection:** the harness is `testEnvironment: 'node'` with hand-rolled `new JSDOM(...)` per file, and Node 22 has a process-global `BroadcastChannel` — the feature-detect and constructor must resolve against the same window global yc-sync sees at runtime, not the Node realm. If any test touches Node's real BC, `close()` in `afterEach` or jest hangs. One cross-window test: emit in window A observed in window B.
- Suite baseline 3598 pass — must stay green; the two server tweaks are additive keys, but `tests/pipelineService.test.js` (jest-mocks `buildChanges`) and any docket route test asserting the `data` envelope must be checked.
- `node --check` on touched inline scripts.

## 9. Slices

**Slice 1** — bus + sniff + both reported bugs + Cases-tab liveness + advance/docket `changes` + `case_Rec` fix + `updateHeader` guard. Gate: case-notes card↔Overview sync both directions; stage change from any writer updates Overview selects, pipeline panel, Cases tab, and a case file open in another browser tab; Kanban advance updates an open case file; `form-saved` untouched and green; suite green.

**Slice 2** — coverage sweep: settings.html `fe-*` rows → stale dropdowns in open tabs (needs a `settings` address + firmData refresh), pipelineBoard as a *reader*, appt/event readers, `appt-updated`/`event-updated` fold-in decision, docket dialog surfaces, `tabLeads`.

**Slice 3** — store hoist: still optional, still deferred, unchanged from v1 §4.2–4.3.

**Slice 4** — server-side change feed: separate charter, blocked on `cases.case_updated` (schema verified absent 2026-08-23).

## 10. Decisions — resolved

1. Explicit vs auto → **auto-sniff + one explicit site** (§3–4). Reverses v1's recommendation; rationale in v2 changes table.
2. Advance `changes` → **verified absent; add server-side** (Slice 1).
3. case_notes double surface → **keep both editable, bus-synced** (v1's own lean, now cheap).
4. Store hoist → **deferred** (unchanged).
5. appt-updated/event-updated → ~~**leave in place**, revisit Slice 2.~~ **RESOLVED in Slice 3: full migration, sniff-side emit. The postMessage system is retired.** See the v2.3 amendments.

---

## v2.2 amendments (Slices 2b + 2c — multi-emit sniff, verified)

**Date:** 2026-08-24 · **Verified against:** `4LSGIT/apigcr` @ main, fresh tarball 2026-08-24

| # | Amendment | Source |
|---|---|---|
| D1 | **§3.1 exception, NAMED: the cross-contact transfer.** `PATCH /api/contacts/:id?force=true` ends a phone/email row on a DONOR contact and re-creates it on the recipient. The donor's change is an **absence** — a child row left — and an absence has no `{column: value}` representation, so there is nothing for a values-only bus to carry. The sniff therefore emits `{yc_refetch: 1}` to `contact:<donor>`, **once per unique donor** (a phone and an email from the same donor are one message), and the entity page answers with its queued refetch. This is the ONE sanctioned invalidation. Everything else on the bus remains values. | close-out B7, manager decision: Option B |
| D2 | **Getter contract v2.** A matcher's getter is now called `(responseBody, urlCapture)` and may return EITHER a fields object — legacy, one emit to `${type}:${capture}` — OR an **array of `{addr, fields}`**, one emit per entry, each carrying the same `auto:` origin. The address comes from the ENTRY, which is what lets one response announce a second entity the URL never named (the donor) and an entity whose address only exists in the body (app-settings create). Empty array → nothing; an entry whose fields normalize to empty is dropped by `emit` itself. All five pre-2b getters keep the object shape and are byte-identical. | Slice 2b item 1 |
| D3 | **Reserved field `yc_refetch`.** Carries no value; means "refetch this entity". A handler receiving it MUST NOT merge it into entity state — it is not a column, and on an entity page it would be pushed into every YCForm as one. Answer it with a refetch and return. Documented in the yc-sync header docblock. | Slice 2b item 1 |
| D4 | **Close-out Finding 2 CLOSED** by a capture-less create matcher: `[/^\/api\/app-settings$/, 'setting', getter, ['POST']]`, whose getter reads `r.setting.key` out of the 201 body. Zero `settings.html` edits: every open frame's `setting:*` / `setting:fe-…` subscriber already handles the message, and that includes the WRITING shell — `emit` dispatches locally before it hits the wire, so `index.html`'s `setting:*` subscriber refreshes that realm's `firmData.settings` on the echo. The create handler not calling `loadFirmData()` (unlike its PUT siblings) stops mattering for any frame that is open. **Verified against the code.** | close-out Finding 2 |
| D6 | **The SECOND transfer endpoint (Slice 2c).** `contact-form.html` has two 409-force flows, not one: the aggregate form save (D1) and `reviveRow`'s `POST /api/contact-{phones,emails}?force=true` (:1399), which also ends the value on whoever holds it. The revive path was completely unannounced through 2b. It now has its own donor matchers. **Its response shape differs from the PATCH path in all three ways that matter** — `transferred_from` is TOP-LEVEL (not under `data`), SINGULAR (an object, not an array), and keyed `contact_id` (not `from_contact_id`). A getter copied from the contacts matcher reads `undefined` and silently announces nothing; three tests pin that. **DONOR ONLY:** the recipient is the page that clicked Revive and already refetches twice (reviveRow's own GET, then the `form-saved` refetch); a recipient emit would make it three, because `contact.html`'s `yc_refetch` branch has no `lastFormSavedAt`-style coalescing fence. No `/api/contact-addresses` matcher — addresses have no cross-contact uniqueness, so that route has no `force` opt and no `transferred_from` at all. | Slice 2b gate walkthrough |
| D5 | **Contacts tab is now a reader.** `index.html` gains the Cases-tab twin: `tabContactsGet(offset, silent)`, a debounced `contact:*` subscriber with a hidden-tab stale flag, `openContactsTab()` collapsing the two inline openers, and the Contacts half of the one `visibilitychange` listener. The donor's stale row is covered by this wildcard for free — `yc_refetch` is just another `contact:*` message here, and the tab refetches regardless of fields. | Slice 1 gap |

**§3.6 still holds, and this is the first handler that answers a message with a network call.** `contact.html`'s `yc_refetch` branch calls `window.ycRefreshEntity()` → `refreshEntityData` → a **GET**, which `_sniff`'s method gate drops before any matcher runs → plus form pushes, which populate and never save. No emit is produced, so the invalidation cannot loop.

### Accepted gap, documented

A **recipient** contact open in a THIRD frame or browser tab still misses aggregate additions: the scalar `changes` diff arrives and merges, but the newly created phone/email row does not (aggregates never ride the bus — v1 §3.1). Same absence-class as the donor, materially lower severity: the recipient's own scalar mirror is announced and correct, and the missing row is an addition rather than a stale row claiming to be current. Deliberately **not fixed** — extending `yc_refetch` to the recipient would make every aggregate save on the page cost a refetch in every other frame, which is the cost the values-only design exists to avoid. Revisit only if it surfaces in practice.

The revive path (D6) inherits this gap in a slightly sharper form: it carries no `changes` at all, so a recipient open elsewhere misses the scalar mirror move too (`auto_promoted: true` means `contacts.contact_phone` was recomputed) and not just the new row. Still left open, for the same reason plus the reviving page's own triple-fetch. If this is ever closed, close it by giving `contact.html`'s `yc_refetch` branch a coalescing fence FIRST — the fence is the prerequisite, not the emit.


---

## v2.3 amendments (Slice 3 — appt/event fold-in, verified)

**Date:** 2026-08-24 · **Verified against:** `4LSGIT/apigcr` @ main, fresh tarball 2026-08-24

| # | Amendment | Source |
|---|---|---|
| E1 | **Decision 5 RESOLVED: full migration, sniff-side emit.** Every client-side appt/event writer already funnels through the shell's `apiSend`, so eight new matchers cover them all with ZERO writer edits — including three paths the old system never covered (apptform2's `linkCase`/`createCase` PATCHes, which never called `notifyParent()`, and every future writer of these endpoints). Readers subscribe to `appt:*` / `event:*` directly instead of being walked. | Slice 3 item 0 + 1 |
| E2 | **DELETED, and this is the complete list.** `index.html`: both `message` walk-listeners, `eventsChanged()` and its three callback args, `showAppt()`'s and `showEvent()`'s `didClose` blocks. `apptform2.html`: `notifyParent()` and its five call sites (plus the dead `P.onApptUpdate` hook it called, which nothing anywhere ever set). `eventform.html`: `efNotifyShell()` and its two call sites. No `postMessage` of `appt-updated` or `event-updated` remains anywhere in `public/`. | Slice 3 item 2b |
| E3 | **`appt:*` / `event:*` address semantics.** These addresses carry TWO kinds of traffic: `{yc_refetch:1}` markers from the sniff (every write endpoint) and real note values from `checklistView.saveBody` (`appt_note` / `event_note` — the only writer that knows what it wrote). Both coexist on the same address; a note save produces one of each. **Every current reader is a query view, so the correct handling of ANY message here is "refetch", never "parse the fields".** Wildcard readers must not branch on field names. | Slice 3 item 1 |
| E4 | **`yc_refetch` now has a SECOND sanctioned shape.** v2.2 admitted it for one thing: the change is an ABSENCE (the transfer donor). Slice 3 adds: the RESPONSE DOES NOT CARRY THE VALUES. `PATCH /api/appts/:id` returns `{status, message, updated_fields}` — the written column NAMES, never their values. The status actions return `{status, title, message}`, whose real effect (appt_status, log rows, sequence enrollment, a successor appointment) is wider than any field list anyway. | Slice 3 item 1 |
| E5 | **Event PATCH returns the full row and STILL emits a marker.** `PATCH /api/events/:id`, `/complete` and `/cancel` all return `data: <fresh row>`. A marker is emitted for uniformity: every reader refetches regardless, so values would buy nothing and would fork the appt/event reader contract into two shapes. Values-on-event is a clean future extension — return `r.data` instead of the marker — the day an entity-scoped reader wants them. | Slice 3 item 1 |
| E6 | **THREE-LINE ROUTE CHANGE (`routes/api.appts.js`), approved out-of-band.** `POST /api/appts/cancel` and `POST /api/appts/reschedule` name their appointment in the REQUEST body only, and the sniff sees responses. Both now echo the service's canonical id: `cancel` → `appt_id`; `reschedule` → `appt_id` (the old appt) plus `new_appt_id` (the successor, reschedule-now only). Taken from the service return, not `req.body`. Without this, cancel and reschedule — the primary status writers, reachable from both the shell and apptform2 — would have been the two flows the migration silently dropped. The alternative considered and rejected was extending `_sniff` to a fourth `requestBody` argument (getter contract v3); the route echo is smaller and keeps the getter contract at v2. | Slice 3 item 0, finding D1 |
| E7 | **No DELETE matchers, and the gate is the thing to change if that alters.** Neither resource has a DELETE route (verified 2026-08-24) — cancel is the delete analogue on both. `_sniff`'s global method gate still drops DELETE before any matcher runs, so a future DELETE route needs the GATE widened first, not just a matcher added. | Slice 3 item 0, finding D1 |
| E8 | **No `/api/events/batch` matcher.** It has no client-side caller; workflows and the court pipeline call it server-side where there is no `apiSend` to sniff. See accepted cost 2. | Slice 3 item 0 |
| E9 | **Appts and Events tabs are readers** (`index.html`), the Cases/Contacts twin: `silent` flag on both fetchers, debounced wildcard subscriber, hidden-tab stale flag, `openApptsTab()` / `openEventsTab()` collapsing all four inline openers, and both halves added to the ONE `visibilitychange` listener the Cases block owns. | Slice 3 item 2a |
| E10 | **ECHO FENCE on the Appts tab, deliberately NOT on Events.** `apptUpdate()` refetches the list in all six of its branches and the New Appointment button passes `onCreated: () => tabApptsGet(0)` (a deliberate jump to page 1 the bus cannot reproduce, since it refetches the CURRENT offset). Without a fence every appt status action costs two full list fetches. `tabApptsGet` therefore stamps `apptsLastLoad` before its await and the subscriber drops messages inside 1500 ms — `pipelineBoard`'s `boardLastLoad` pattern. The Events tab has no local refetch-after-write left once `eventsChanged` and `didClose` are gone, so a fence there would be dead code; a comment says to copy the appts one if that ever changes. Same fence on both entity pages (`refreshAppts` / `refreshEvents` are already the success callbacks for their own row buttons) and on the calendar (`onDateClick`'s `onCreated`). | Slice 3 items 2a, 3, 4 |
| E11 | **`calendar.html` gets its first remote refresh, ever.** It previously redrew only on a view change, a filter toggle, or an appt created from its own `dateClick` — an appointment cancelled anywhere else left a ghost on the grid until someone navigated. Now `appt:*` / `event:*` → `refetchEvents()`, behind the board's visibility pattern. `calState.seq` makes this safe against an in-flight feed fetch: `fetchFeed` takes a ticket at entry and drops its own response if a newer fetch started, so the last request always owns the canvas. | Slice 3 item 4 |
| E12 | **The shell ping does NOT reach the calendar** (contradicts the Slice 3 charter, verified). `calendar.html` is framed ONLY by `tabApptsCal()`'s Swal, not by a `.tab-main` div, so `pingBecameVisible()` — which walks the iframes of the tab it just showed — structurally cannot reach it. `window.ycBecameVisible` is defined anyway (free, house contract, correct the day the calendar moves into a real tab); the path that carries weight today is `visibilitychange`, since the modal is either open or does not exist and the only way to be stale is a backgrounded browser window — exactly the cross-window case. | Slice 3 item 4 |
| E13 | **`esign/caseWidget.html` was NOT touched** (contradicts the charter, verified). It is the SIGNATURES widget: it defines `refresh` / `window.refreshEsign`, has no appt or event surface, and never had a `refreshAppts`. Nothing to subscribe. | Slice 3 item 3, finding D2 |
| E14 | **There was no relay to preserve** (contradicts the charter, verified). The old walk was `document.querySelectorAll('iframe')` in the SHELL document only — it reached `case.html` / `contact.html` and nothing deeper. `refreshAppts` is `GET → putAppts()`; `refreshEvents` is `GET → putEvents()`. Neither touches a child frame. The charter's supporting quote — apptform2's "case/contact only relay it" — is about **`apiSend`**, not about `appt-updated`. The `window.refreshEvents` exports are kept as parent hooks with corrected comments. | Slice 3 item 0, finding D3 |
| E15 | **REFETCH-ON-WRITE SUPERSEDES REFETCH-ON-CLOSE — a behaviour change.** `showAppt`/`showEvent`'s `didClose` refetched the shell's list on EVERY close, including the many closes with no write; it was a proxy for "something might have happened in there", and it existed because the pieces that could tell us did not talk to the shell (`notifyParent()` only fired on a status action; the W4 note card saves through checklistView). The bus answers properly — every write inside those iframes is announced from the frame that made it — so opening an appointment to READ it now costs nothing. | Slice 3 item 2b |

### Accepted costs

**1. The BC-absent degrade is strictly worse than it was for appts/events.** The old postMessage walk worked without BroadcastChannel and reached the shell's direct children; the bus degrades to local-only dispatch in that case, so a case file open in an iframe would not hear a write made from the shell. All shipped browsers have BroadcastChannel (§2), and the degrade already applies to every other address type, so this is uniformity rather than a new class of failure — but it IS a capability the postMessage walk had and this does not.

**2. Server-side writers remain invisible.** Workflows, the court pipeline, `POST /api/events/batch`, sequence-driven appt changes and the Cloud Tasks job runner all write appts and events without passing through any browser's `apiSend`, so nothing announces them. Unchanged from every prior slice, and unchanged until the Slice-4 server-side change feed.

**3. The echo fence can drop a real message.** A genuinely unrelated write from another browser window that lands within 1500 ms of a fetch the reader started itself is dropped, and the reader shows it on its next refresh. Sub-second window, and the tradeoff `pipelineBoard` already ships — inherited knowingly rather than re-litigated mid-slice.

### §3.6 statement

Every handler added in this slice ends in a GET (`tabApptsGet` / `tabEventsGet` / `refreshAppts` / `refreshEvents` / `refetchEvents` → `/api/calendar-feed`) followed by a DOM write. `_sniff`'s method gate drops GET before any matcher runs, so none of them can produce an emit. Nothing loops.

---

## v2.4 amendments (Slice 3b — review remediation, verified)

**Date:** 2026-08-24 · **Verified against:** `4LSGIT/apigcr` @ main, fresh tarball 2026-08-24

Remediates a second-eyes review of the completed bus arc: two coverage gaps that let whole entities appear and disappear unannounced, one cost fix, and the corrections the review found in comments and in this document.

| # | Amendment | Source |
|---|---|---|
| F1 | **CASE MERGE is covered, survivor only.** `POST /api/cases/:survivor/merge` repoints every child record of the absorbed case onto the survivor, additively fills its empty columns, may adopt docket values, and deletes the loser — and until now no open surface heard any of it. New matcher emits `{yc_refetch:1}` to `case:<data.survivor_id>`. A marker rather than values because the survivor's change is mostly a change in what is *attached* to it: `data.fields.filled` names filled columns but not their values, and no field list represents "eleven log rows and three appointments moved here". | review HIGH 1 |
| F2 | **The absorbed case is deliberately NOT addressed. Accepted gap.** A remote page still sitting on the loser would answer a refetch with a GET for a deleted row and land in a 404 error state — strictly worse than stale-but-readable, for a rare race (the same absorbed case open in a second window at the moment of the merge). The writing page already self-handles: `mergeCaseDialog` replaces its body with a "was merged into X" notice and opens the survivor through the shell. A `deleted` bus concept is future work if it ever earns its keep; pinned by a test so a loser emit cannot be added without a design decision. | manager decision |
| F3 | **The merge matcher fails closed TWICE, and one of them is a deliberate silent-failure tradeoff.** (a) DRY RUN: the preview and the real merge are the same endpoint with the same 200 shape, and `data.dry_run` is the only thing separating them — a preview writes nothing, so announcing one would cost every open surface a refetch for a dialog someone may yet cancel. (b) SHAPE: `dry_run` must be present and boolean-`false`. If a future refactor drops the key, merges go **silent** (stale survivor) rather than **noisy** (dry runs announcing). Chosen because a wrong emit reaches every open frame while a missing one delays one page to its next reload — but that refactor must update this matcher with it. Stated in the matcher comment for the same reason. | review HIGH 1 |
| F4 | **INTAKE CREATE/UPDATE is covered, both endpoints, both writing actions.** `POST /api/intake/contact` and `POST /api/intake/case` are the app's two entity-creation endpoints (callers: `scripts.js` NewCaseForm :1855/:3308, `forms/issn.html` :959, `apptform2.html` :696, formInbox adopt) and were the only writes of a whole row that no query view ever heard about. Both emit `{yc_refetch:1}` off the response `id`. `intake/contact` is an **upsert** — it resolves the payload's phone/email against existing contacts and updates the match — so `updated` announces as loudly as `created`: that write lands on a contact that may be open in three frames. | review HIGH 2 |
| F5 | **`action` is an ALLOW-LIST, and that is load-bearing — the charter's response-shape assumption was incomplete.** `POST /api/intake/case` has a THIRD success shape: `{status:'success', action:'found', id}`, returned when an active case of the same type already exists for the contact and is reused (`routes/api.intake.js` :597). **Nothing is written on that path** — it is a lookup that returns an id. Announcing it would make every "create a case" click that lands on an existing case cost a refetch on every open Cases tab, Kanban board and case file for a row that did not change. The getters therefore allow-list `created` and `updated`; `found`, and any action a future branch adds, is silent until someone widens the list deliberately. | Slice 3b item 3, verified against the route |
| F6 | **Response-shape enumeration (verified 2026-08-24).** `intake/contact` has **two** success `res.json` sites, not three: :353 `action:'updated'` → `{id, contact_id, name}` and :426 `action:'created'` → same keys. `intake/case` has two: :597 `action:'found'` → `{id}` and :677 `action:'created'` → `{id, case_relate}`. Every other `.json` site in both handlers is a 4xx/5xx, which `apiSend` throws on **before** the sniff hook runs — error shapes are structurally unreachable by a getter. `id` is the one key all four shapes share and is what both getters read. | Slice 3b item 3 |
| F7 | **`case.html` answers `yc_refetch`.** It had no branch for the reserved field at all — a marker fell through to `Object.assign`, polluting `entityData.case` with a non-column that is then pushed into every YCForm as one, and then did the header, pipeline and form-push work the refetch supersedes. Now handled first and returning, **before** the `!entityData.case` bail, so a page whose initial load failed still answers a refetch rather than staying deaf. `contact.html` made the same choice for the same reason; this is a straight port of its branch, comment included. Prerequisite for F1. | review HIGH 1 |
| F8 | **ENTITY-PAGE VISIBILITY FENCE — a cost fix on both files.** `case.html` and `contact.html` refetched **both** lists on every appt/event write anywhere, including while parked behind another file or another shell tab, and in background browser windows: 2 GETs × open pages × windows, per write. Both now carry the board's pattern — stale flag when not visible, `pageVisible()` (`frameElement` rect + `document.hidden`), `window.ycBecameVisible` → refresh-if-stale, and a `visibilitychange` listener that runs the same guarded check (so returning to the browser window while the file sits behind ANOTHER file does not spend the flag on tables nobody can see). The existing echo fences are untouched; the visibility fence wraps around them. | review MED |
| F9 | **ONE stale flag per page, covering both subscribers.** Coming back on screen runs a single refresh pass over both tables, so tracking which of the two went stale would buy nothing but a second flag to keep in sync — the two lists are refetched by two independent GETs either way. Noted in a comment at the flag. | Slice 3b item 4 |
| F10 | **The shell ping DOES reach these iframes** (unlike the calendar — contrast E12). File divs are created with `class="tab-main file"` and switched through `openMainTab()`, which ends in `pingBecameVisible(target)` → `contentWindow.ycBecameVisible?.()` on every non-zero-width frame in the div (`index.html` :3097, :3061). No shell edits were needed for F8. Verified 2026-08-24. | Slice 3b item 4 |
| F11 | **The scalar subscribers stay UNFENCED, deliberately.** Only the two GET-refetch subscribers per page take the visibility fence. `case:<id>` / `contact:<id>` do DOM-write work off data they were handed, cost no request, and must keep applying immediately so a file switched back to is already correct. Pinned by a test on contact.html. | Slice 3b item 4 |
| F12 | **Shell tab-comment claim corrected.** The Cases-tab liveness comment said "any case write anywhere in the app". It is now precise: every write through the shell's `apiSend` — every client-side writer at every frame depth, plus other browser tabs — across the sniffed endpoints, **including intake creation and merges as of this slice**; server-side writers (workflows, court pipeline, sequences, Cloud Tasks) remain invisible until Slice 4. The Contacts comment, which inherits the claim by reference ("structural twin"), carries a pointer to it plus its own intake note. | review |
| F13 | **`loadPipeline` trigger line corrected in THIS document.** §5's reader sketch (~line 127) shows `if ('case_stage' in fields \|\| 'pipeline_phase' in fields)`. **The code is right and the doc was stale**: `case.html` fires on `pipeline_phase` only, because a bare `case_stage` change is someone editing the column from the Overview select — it moves no pipeline position and would buy a `/pipeline` GET that re-renders identical markup. `pipeline_phase` present is the advance signature (`written` is never partial). Widen only if a writer appears that appends a log row without touching `pipeline_phase`. | review |
| F14 | **`apiSend`'s two SNIFF-BLIND early returns are now commented at the code.** The `204` return and the `responseType` block (`'blob'` / `'text'` / `'response'`) both return **above** the sync-bus hook, so a matched endpoint reached through either is invisible to the bus with no error anywhere. Harmless today — no sniffed endpoint answers 204, and the non-json callers are PDF/export/upload reads — but a future DELETE route, or a matched write that starts returning a blob, would go silent. Widen deliberately; do not discover it in production as "the bus stopped working for that button". | review |
| F15 | **`checklistView`'s in-flight DROP (not defer) documented as accepted.** A bus message arriving while a card's own save is in flight is dropped, not queued for after it. Correct as it stands: the server is last-write-wins, so the dropped message describes a value the save is about to overwrite anyway, and the card self-corrects on its next `load()`. Deferring would mean holding a message across an await and repainting a card the user may have kept typing into — strictly more machinery for a state that resolves itself. Revisit only if a card is observed showing a stale body after a concurrent save. | review LOW |
| F16 | **Settings-key percent-encoding accepted, noted at the matcher.** `setting:<key>` addresses are built from the raw URL segment with no `decodeURIComponent`, so a key needing escaping would address `setting:fe%2Dx`. Unreachable: the create route's `KEY_RE` forbids every character that would need escaping, and the live `app_settings` table is clean (re-verified 2026-08-24). One-line note at the matcher's charset comment says to decode if that changes. | review LOW |

### Coverage after this slice

Every client-side write of a case or contact that an open surface can see now announces: field updates (`PATCH /api/cases/:id`, `/api/contacts/:id`), docket adoption, pipeline advance, **creation** (`/api/intake/*`), **merge**, plus the appt/event/setting addresses from earlier slices. The standing exception is unchanged and is the whole content of Slice 4: **server-side writers** — workflows, the court pipeline, `POST /api/events/batch`, sequence-driven changes and the Cloud Tasks runner — write without passing through any browser's `apiSend`, so nothing announces them.

### §3.6 statement

`case.html`'s new `yc_refetch` branch is the second handler in the system to answer a message with a network call, and it holds for the same reason `contact.html`'s does: `window.ycRefreshEntity()` → `refreshEntityData` → `loadEntityData` → a **GET**, which `_sniff`'s method gate drops before any matcher runs, plus form pushes that populate and never save. No emit is produced, so the invalidation cannot loop. The fenced appt/event handlers likewise end in a GET and a table repaint; `ycBecameVisible` and the `visibilitychange` listener call the same two refresh functions and add no new emit path.
