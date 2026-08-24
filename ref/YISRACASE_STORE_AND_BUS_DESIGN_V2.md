# YisraCase — Sync Bus Design v2.6

**Status:** Slice 1 shipped; Slice 2 shipped; Slice 2b + 2c shipped; Slice 3 shipped; Slice 3b shipped; Slice 3c shipped; Slice 3d shipped (amendments at the foot of this file)
**Date:** 2026-08-24 (v1: 2026-08-21; v2.1: 2026-08-23, SYNC_BUS_V2_SECONDARY_REVIEW; v2.2: Slice 2b multi-emit sniff; v2.3: Slice 3 appt/event fold-in; v2.4: Slice 3b review remediation; v2.5: Slice 3c third-pass review remediation; v2.6: Slice 3d residuals)
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

> **CORRECTED IN v2.5.** The paragraph below said "*every* client-side write of a case or contact that an open surface can see now announces". That was an overclaim on two counts, and both are now stated where they belong (see amendment **G14**): `case_relate` writes were not covered at all until v2.5, and `apiSend` is not the only client transport — the 204 return, the `responseType` fork and external-mode `YCForm` all reach the server without passing the sniff. Read the precise statement in the v2.5 §Coverage section at the foot of this file; the paragraph is left here unedited as the record of what v2.4 claimed.

Every client-side write of a case or contact that an open surface can see now announces: field updates (`PATCH /api/cases/:id`, `/api/contacts/:id`), docket adoption, pipeline advance, **creation** (`/api/intake/*`), **merge**, plus the appt/event/setting addresses from earlier slices. The standing exception is unchanged and is the whole content of Slice 4: **server-side writers** — workflows, the court pipeline, `POST /api/events/batch`, sequence-driven changes and the Cloud Tasks runner — write without passing through any browser's `apiSend`, so nothing announces them.

### §3.6 statement

`case.html`'s new `yc_refetch` branch is the second handler in the system to answer a message with a network call, and it holds for the same reason `contact.html`'s does: `window.ycRefreshEntity()` → `refreshEntityData` → `loadEntityData` → a **GET**, which `_sniff`'s method gate drops before any matcher runs, plus form pushes that populate and never save. No emit is produced, so the invalidation cannot loop. The fenced appt/event handlers likewise end in a GET and a table repaint; `ycBecameVisible` and the `visibilitychange` listener call the same two refresh functions and add no new emit path.

---

## v2.5 amendments (Slice 3c — third-pass review remediation, verified)

**Date:** 2026-08-24 · **Verified against:** `4LSGIT/apigcr` @ main, fresh tarball 2026-08-24 + live DB

Remediates a third fresh-eyes review of the bus arc: four coverage/correctness HIGHs, seven MEDs, four LOWs, plus one ruling carried over from Slice 3b. The theme of this slice is different from 3b's — 3b closed gaps in what the bus *hears*; 3c is mostly about what the bus *costs* and what it *clobbers*.

| # | Amendment | Source |
|---|---|---|
| G1 | **LEAD-SOURCE CLOBBER FIXED — `syncLeadSourceList` split in two.** The function did two unrelated things: write the input's VALUE from the case row, and rebuild the datalist's OPTIONS from `firmData`. The `setting:fe-lead_sources` subscriber called it for the options half — so editing the lead-source vocabulary in settings.html, in any window, reached into every open case file and overwrote whatever was in the Lead Source box with the stored value. An unsaved edit, typed and not yet blurred, silently reverted. Every other bus paint on the page is fenced on focus and `ycDirty` precisely to stop that; this path had no fence because it was never meant to be a value write. `syncLeadSourceOptions()` is now the options-only half and is what the subscriber calls; `syncLeadSourceList(c)` is unchanged for `updateHeader` and boot, which legitimately want both. The subscriber's `if (window.entityData.case)` guard falls away with it — the datalist is built from `firmData`, not from the row, so a page whose case load failed should still track the vocabulary. | review HIGH 1 |
| G2 | **`case_relate` IS COVERED — four verbs, one matcher.** `POST /api/cases/:id/contacts`, `PATCH /api/cases/:id/contacts/:contactId` and `DELETE /api/cases/:id/contacts/:contactId` all emit `{yc_refetch:1}` to `case:<id>`. **This is the largest coverage gap the arc had left**, and it is invisible from the `cases` table: the PRIMARY contact is not a column — it is the `case_relate` row whose type is `'Primary'` — so the case's client name and phone, its Cases-tab row, its Kanban card headline and every "who is this case about" surface derive from a table the bus did not watch. Changing a Primary wrote nothing to `cases`, announced nothing, and left every other open surface naming the wrong person until its next full load. A marker rather than values, and there is no honest alternative: none of the three responses carries the case's new client list, and "who is Primary now" is a query over the table rather than a column anyone could carry. | review HIGH 2 |
| G3 | **THE PATCH ROUTE IS REAL AND WAS UNDOCUMENTED.** The review guessed at the route set from `api.cases.js`'s file header, which lists only GET/POST/DELETE. `PATCH /api/cases/:id/contacts/:contactId` also exists (`api.cases.js:439`), declared 130 lines below its siblings and absent from that header — and it is the relate-type writer, i.e. **the exact route the Primary-swap gate depends on**. `case.html:926` calls it. Verified against the code, not the comment. The file header should be updated the next time that file is touched. | worker verification |
| G4 | **THE GLOBAL METHOD GATE NOW ADMITS DELETE, and the Slice-3 test predicted it.** `_sniff` gated on PATCH/POST/PUT, so the `case_relate` DELETE — the destructive half, and the half a stale surface renders most wrongly (a removed client keeps showing) — could not have reached a matcher however the matcher was written. `tests/ycSync.test.js`'s "DELETE reaches no matcher" test said in as many words that *the gate, not the matcher, is the thing to change*. That day came; the test was rewritten to cash the prediction rather than deleted. GET and HEAD are still dropped, which is what keeps §3.6 structural. | review HIGH 2 + Slice 3 prediction |
| G5 | **EVERY MATCHER NOW NAMES ITS OWN VERBS.** The four Slice-1 matchers omitted the optional 4th element and leaned on the global gate. That was fine while the gate was PATCH/POST/PUT and stopped being fine the moment it had to admit DELETE: an omitted list means "whatever the gate allows", which turns every future gate widening into a silent widening of those four. Now pinned — `cases/:id` PATCH, `contacts/:id` PATCH, `/docket` PATCH, `/pipeline/advance` POST — verified against the routes. **Manager decision:** the gate widening is precisely what made the absence load-bearing, so it was closed in the same slice. | manager decision, worker-proposed |
| G6 | **A VERB MISS NOW `continue`s THE SCAN INSTEAD OF ENDING IT.** A matcher that matches the PATH but rejects the VERB is not an answer — it is a matcher that does not apply. `return` made the first path-match authoritative for every verb. Inert today (no two matchers share a path), and that is exactly why it was safe to change now rather than on the day a second matcher is added to a path and the first silently eats its traffic. | review LOW 2 |
| G7 | **BOOKING LINK IS COVERED, with REAL VALUES.** `POST /api/contacts/:id/booking-link` mints `contacts.contact_token`; the response *is* the written value, so `{contact_token: token}` merges into `entityData.contact` on any open contact file with no refetch at all — one of the few writes that can honestly carry its own change. **Accepted cost, pinned by a test:** all three success branches (already had one, minted one, lost the mint race) return the same `{success:true, token}`, so a get-or-mint that **wrote nothing** announces too. Harmless by idempotence, but it costs the shell's Contacts tab a wildcard refetch. Distinguishing them needs a ROUTE change (echo a `minted` flag) — a getter cannot do it, and the test says so. | review HIGH 3 |
| G8 | **BOARD MID-DRAG TEARDOWN FIXED.** `loadBoard()` ends in `render()`, which destroys every Sortable instance and replaces the board's `innerHTML` — with the card currently in the user's hand among the nodes it discards. A write from another window landing mid-drag yanked the DOM out from under an in-progress drag: the card vanishes in mid-air, `onEnd` fires against detached nodes, and `handleDrop` reads `evt.to.dataset.stageKey` off an element no longer in the document. The subscriber now defers (`if (dragging) { boardStale = true; return; }`) and the drag-end timeout flushes (`setTimeout(() => { dragging = false; boardRefreshIfStale(); }, 50)`). The flush is in `onEnd`, not `handleDrop`, so it runs on **every** drag end — cancelled, same-column, dropped-on-Unstaged — not only the ones that advance. | review HIGH 4 |
| G9 | **BOARD SCROLL POSITION SURVIVES A REBUILD.** `render()` blanks the host, so every column body's `scrollTop` went to zero — and on a board refreshed by the bus that meant a remote write snapped a reader back to the top of a long column mid-read. Positions are captured per column before the blank and restored after, **keyed on `data-stage-key`, not on index**: a column can appear or disappear between renders (a stage added in Case Config, include-closed toggled), and an index-keyed restore would pour one column's position into another. A key with no column in the new board is simply never read. | review MED |
| G10 | **ENTITY-SUBSCRIBER NETWORK FENCES — the cost fix 3b left half-done.** Slice 3b fenced the appt/event readers and left the ENTITY subscriber unfenced, so a parked case file still answered every merge, intake create and (as of G2) every `case_relate` change with a full case GET, and every advance anywhere with a `/pipeline` GET. Both are now deferred behind flags. **THE FENCE IS AROUND THE NETWORK CALL, NOT THE MESSAGE** — merge and paint stay unfenced, deliberately, because nothing re-renders a hidden page when it is shown again: its DOM has to track messages as they arrive or it comes back showing values the database stopped holding minutes ago. | review MED |
| G11 | **ONE FLUSH, THREE FLAGS — and the restructure was mandatory, not tidying.** `apptEventRefreshIfStale` opened with `if (!apptEventStale \|\| !pageVisible()) return;`. Adding `entityStale` and `pipelineStale` beside it under that shape would have **stranded both**: a file that went stale on a merge but not on an appointment would return to screen, hit the early return, and never refetch. `ycRefreshIfStale()` checks visibility once up front and then each flag on its own. Pinned by a test on both pages. Separate flags rather than one, because the three answer with different work — and `refreshEntityData` does **not** call `loadPipeline` (verified), so a refetch is not a superset of a pipeline refresh. | review MED + worker verification |
| G12 | **The `yc_refetch` fence is mirrored on `contact.html`.** Same unfenced `ycRefreshEntity()`, same cost argument, and its writers fire on ordinary staff work (the cross-contact transfer on both endpoints, the intake upsert). One flag suffices there — no pipeline widget, so the refetch is the only network call that subscriber can make. | review MED |
| G13 | **`pwAdvance` REPAINTS THROUGH THE FENCES LIKE EVERYTHING ELSE.** It wrote the three inputs with bare `E(...).value =`, which made it the one painter on the page with no focus/`ycDirty` guard — an advance landing while someone had the Status box open, mid-edit, ate what they were typing. Now `Object.assign(entityData.case, d.case)` + `applyFieldsToOverview({case_stage:1, case_status:1, case_rec:1})`, which takes its argument as a **presence filter** and paints from `entityData.case`. `Object.assign` rather than `entityData.case = d.case`: replacing the object drops any column the bus merged in between the advance and its response, and hands the form-push loop a different object than the one it read. The GET itself stays (C1) — it is the correctness path when BroadcastChannel is unavailable. | review MED |
| G14 | **§Coverage overclaim corrected.** v2.4 said "every client-side write of a case or contact that an open surface can see now announces". Wrong twice: `case_relate` was not covered at all (G2), and `apiSend` is not the only client transport (G15). The precise statement is in §Coverage below; the v2.4 paragraph is annotated in place rather than rewritten, so the record of what was claimed survives. | review |
| G15 | **THE THIRD SNIFF-BLIND TRANSPORT, NAMED.** v2.4's F14 documented two paths that reach the server above the sync-bus hook (`apiSend`'s 204 return and its `responseType` fork). There is a third and it is not a variant of them: **external-mode `YCForm`** (`public/js/yc-forms.js:2021`) forks on `config.external` and issues a bare `fetch(config.baseUrl + url)`, never touching `apiSend` at all — so widening the hook inside `apiSend` would not reach it. Harmless today (an external submission writes `form_submissions`, not case/contact scalars, and no external frame subscribes — §6), but it belongs on the carve-out list rather than being rediscovered. Now stated in the yc-sync header beside the other two. | review MED |
| G16 | **AUTO-EMIT CIRCUIT BREAKER — a per-address rate limit on the sniff path.** Eight auto-emits to one address inside four seconds; over that, the emit is dropped and one `console.warn` per address per window is logged. `YC.emit` is **exempt** — those call sites are hand-placed and auditable (there is one). **Why it exists:** a form's per-form `code` hook lives in the DATABASE, not the repo. Those hooks run inside `form.refresh()`, which runs inside a bus-triggered form push — so a hook that WRITES is a handler that emits, one indirection from §3.6, and no amount of reading `public/` can prove none does. An idempotent hook-write self-terminates (the second identical PATCH diffs empty and `emit` drops it); a value-varying one — a timestamp, a counter, a re-derive that never settles — would not. **Manager decision over the review's suggestion** of a sniff-suppression flag held around push windows: a flag cannot tell a loop from a legitimate cross-frame write that lands inside the window, and would swallow the second kind to stop the first. The breaker never does — under the threshold it is invisible, and over it the only thing lost is the tail of a burst that was already pathological. Per-address, so a bulk action announcing fifty different cases is unaffected. | manager decision |
| G17 | **`dry_run` FLIPPED to a truthy check — the asymmetry, reversed.** Slice 3b required `dry_run === false` and went silent on a plan that had lost the key. Wrong side: a **missing emit on a real merge** reopens the exact HIGH the matcher exists to close, invisibly, on every open surface; a **wrong emit on a preview** costs one idempotent refetch of correct data that nobody perceives as a bug. An unrecognised shape now defaults to announcing. The dry-run silence is unchanged and keys on the flag being present and truthy. **Carried ruling from Slice 3b.** | 3b carry-over |
| G18 | **PRODUCER CONTRACT TEST for the merge plan** (`tests/caseMergeShapes.test.js`, the `contactTransferShapes` precedent). The flip above makes the dry-run side load-bearing, and until now `dry_run` was pinned client-side only — which catches a bus regression and nothing else, since a client fixture happily keeps asserting against its own hand-written copy of a shape production no longer sends. Pins `dry_run:false` on a real merge, `true` on a preview, and — the premise the silence rests on — that a dry run opens no transaction and issues no UPDATE or DELETE. | review + 3b carry-over |
| G19 | **`maxlength` AT THE THREE OVERVIEW WRITERS** — `case_status` 50, `case_rec` 128, `case_source` 40 (verified live 2026-08-24). Not cosmetic: `sql_mode` has no `STRICT_TRANS_TABLES`, so an over-length value is **truncated by the server with a warning, not rejected**. The row then holds 50 characters, the emitted `changes` carry the 70 the client sent, and every other open window paints a value that does not exist in the database until it reloads. **The robust half is DEFERRED as its own decision:** clipping in `updateCase` the way `advanceStage` already does would change write semantics for every caller of that service, which is more than a review remediation should decide. | review MED |
| G20 | **`checklistView`'s emit comment corrected.** It claimed to be "the only announcement" for appt/event notes. Stale since Slice 3 — the sniff now covers all four endpoints (`cases`/`contacts` with a `changes` diff, `appts`/`events` with a marker). What the emit still adds is the note's **VALUE** on the appt/event addresses, where the sniff can only manage a marker; no reader wants it yet (every appt/event subscriber is a query view forbidden from reading fields — E3), but an entity-scoped reader would, and this is the only writer that knows what it wrote. | review |
| G21 | **The `_diffNorm` TRIM CLASS named at the empty-fields guard.** `emit`'s empty-changes guard also swallows a narrow class of real writes: `changes` comes from `domainEvents.buildChanges`, which compares through `_diffNorm`, and `_diffNorm` **trims**. Saving `"Filed "` over `"Filed"` writes the database and produces an empty diff, so the bus says nothing and a second frame keeps showing the untrimmed value until it reloads. Left alone deliberately — the normalization is the producer's and is right for the trigger system it was written for, and a whitespace-only difference is not one anybody is looking at. Fix at `_diffNorm` if it ever matters; never by loosening the guard. | review LOW 3 |
| G22 | **The BC-degrade asymmetry, stated.** Accepted cost 1 (v2.3) said the BroadcastChannel-absent degrade is local-only dispatch. The asymmetry it did not spell out: `_sniff` runs in the SHELL's realm, so on degrade the shell's own readers (Cases, Contacts, Appts, Events tabs) **keep working** off local dispatch, while every iframe — case files, contact files, the Kanban board, checklistView — goes **silent**, with no error and nothing on screen to say so. Graceful in the shell, silent in the frames. The frames do each warn once in their own console when their own BC construction fails, which is the only signal. | review MED 7 |
| G23 | **The uniform script-tag decision, written down.** `yc-sync.js` is loaded by every page that loads `scripts.js`, including several with no subscriber at all. **Deliberate, chosen in Slice 1:** uniform loading over per-page judgement, because "does this page need the bus?" is a question that gets answered wrong the moment someone adds a subscriber and forgets the tag — a failure that is silent and looks like a bus bug. The idle cost of a page that never subscribes is one bounded ring buffer (50 messages) and one BroadcastChannel per frame. | review LOW 4 |

### Coverage after this slice (the precise statement — supersedes v2.4's)

**Client-side writes that pass through `apiSend` announce**, for the matched endpoints: case and contact field updates, docket adoption, pipeline advance, entity creation (`/api/intake/*`), merge, **case↔contact links (`case_relate`, all three writing verbs)**, **booking-link minting**, plus the appt/event/setting addresses from earlier slices.

Four named carve-outs, none of them "the bus is broken":

1. **`apiSend`'s 204 return** — above the hook. No sniffed endpoint answers 204 today.
2. **`apiSend`'s `responseType` fork** (`blob`/`text`/`response`) — likewise above the hook. Today's non-json callers are PDF/export/upload reads.
3. **External-mode `YCForm`** — a bare `fetch`, not `apiSend` at all (G15). Not reachable by widening the hook.
4. **Server-side writers** — workflows, the court pipeline, `POST /api/events/batch`, sequence-driven changes, the Cloud Tasks runner. Never involve a browser. This is Slice 4's entire content and is unchanged from every prior slice.

### Deferred, deliberately (not gaps — decisions with a named reason)

- **`updateCase` value clipping** (G19). Changes write semantics for every caller; needs its own decision, not a remediation slice.
- **Distinguishing booking-link mint from return** (G7). Needs a route change; a getter structurally cannot.
- **`_diffNorm`'s trim** (G21). The producer's normalization is correct for its own purpose.
- **The absorbed case in a merge** (v2.4 F2) and the **recipient aggregate gap** (v2.2) — both unchanged, both still pinned by tests.

### §3.6 statement

Nothing in this slice adds an emit path. The new `case_relate` and booking-link matchers are sniff-side only. Every fence added is a *narrowing* — a network call deferred, never a new one — and the deferred calls are the same GETs that were already there (`ycRefreshEntity` → `loadEntityData`, `loadPipeline`, `refreshAppts`/`refreshEvents`, `loadBoard`), all of which the method gate drops before any matcher runs. `ycRefreshIfStale` on both entity pages and `boardRefreshIfStale` on the board call those same functions and add no emit path. The circuit breaker (G16) only ever *removes* emits.

The breaker is also the first thing in the arc that defends §3.6 rather than merely relying on it: §3.6 is a rule about code in this repository, and DB-stored form `code` hooks are code that runs inside a bus-triggered push without being in it. The rule still holds for everything auditable; the breaker is the floor under everything that is not.

---

## v2.6 amendments (Slice 3d — post-3c residuals)

**Date:** 2026-08-24 · **Verified against:** `4LSGIT/apigcr` @ main + the 3c working tree

Two residuals found by a manager pass over the shipped 3c work. Small, but the first is a lie in load-bearing documentation and the second is a cost regression 3c introduced.

| # | Amendment | Source |
|---|---|---|
| H1 | **THE MERGE MATCHER'S TRADEOFF BLOCK NOW MATCHES THE SHIPPED CODE.** G17 flipped `dry_run` to a truthy check and rewrote the comment *at the guard*, but the matcher's block comment 300 lines above still read "`dry_run` must be present AND boolean-false… if a future refactor drops `dry_run` from the plan, merges go silent (stale survivor) rather than noisy". That is not a stale comment — it is **the reverse of the shipped behaviour, stating the reverse rationale**, in the one place the tradeoff was written down to be found. Anyone reasoning about a merge regression would have reasoned from it and been wrong twice. Now: fails closed on a truthy `dry_run`, fails **open** on a missing key, with the asymmetry spelled out (a missing emit on a real merge goes stale on EVERY open surface, not "one page" as the old text claimed; a wrong emit on a preview costs idempotent refetches of correct data) and the residual tradeoff restated in the right direction. | manager pass |
| H2 | **THE RELATE-WRITE ECHO DOUBLE-GET IS FENCED** — `entityLastRefetch` / `ENTITY_FRESH_MS` (1500ms), the `pwLastSet` and `boardLastLoad` idiom applied to the entity refetch. G2 put `case_relate` on the bus, which gave the WRITING page an unfenced echo of its own write: a Primary swap cost a local contacts GET *and* a full-include entity GET to learn what the page had already applied. Stamped by `refreshEntityData`, `_refreshCaseClients` and `modifyCaseClient`'s tail; the `yc_refetch` branch returns inside the window **above the visibility check**, so a hidden page does not flag itself stale on its own echo either (which would defer the redundant GET rather than remove it). Slice 2c predicted exactly this when it deferred the recipient emit: *"the fence is the prerequisite."* | manager pass |
| H3 | **STAMPED BEFORE THE AWAIT, NOT AFTER — worker correction.** The rider specified the stamp sites; taken literally at the *end* of `_refreshCaseClients` it would lose the race it exists to win. The write that prompted the refresh has already resolved, so its echo is a macrotask **already in flight** while the GET is still awaiting, and an after-the-fact stamp arrives too late. `boardLastLoad` is stamped at the start of `loadBoard` for this exact reason and says so in its comment. Both `refreshEntityData` and `_refreshCaseClients` now stamp at entry. `modifyCaseClient`'s tail is genuinely a tail and is correct there — its continuation is a microtask off the write's own `await`, strictly before the echo. | worker verification |
| H4 | **The mirror on `contact.html` lands the 2c prerequisite.** Same stamp, same constant, stamped in `refreshEntityData`. This is what finally makes the recipient emit affordable: the revive flow announced the recipient *and* every donor, so the recipient page heard its own write and bought a second full contact GET on top of the refetch it had already issued. That collapses to the accepted "a coalesce can lose its race" semantics the rest of the arc already runs on. | manager pass |
| H5 | **BOOT IS DELIBERATELY NOT STAMPED.** `loadEntityData()` is called bare from the boot IIFE on both pages, so `entityLastRefetch` is 0 after a page opens and a remote write landing immediately is still honoured. Correct: nobody's write caused the boot, so there is no echo to suppress, and fencing there would silently drop the first remote change on every freshly-opened file. Pinned by a test on both pages so it reads as a decision rather than an oversight. | worker decision |

**The tradeoff, restated once for all four stamps in the arc** (`pwLastSet`, `boardLastLoad`, and now `entityLastRefetch` on both entity pages): a *legitimate* remote refetch landing inside the window is dropped and the page waits for the next event or a reload. The loser is a race between a remote write and a local one on the same record within 1.5 seconds, and losing it costs stale-but-readable data. Accepted uniformly, and now pinned uniformly.

### §3.6 statement

Unchanged, and strengthened in the same direction as every fence in 3c: the echo fence only ever *removes* a network call. No new emit path exists on either page.
