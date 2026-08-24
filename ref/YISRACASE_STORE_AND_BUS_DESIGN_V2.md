# YisraCase — Sync Bus Design v2.2

**Status:** Slice 1 shipped; Slice 2 shipped; Slice 2b + 2c shipped (v2.2 amendments at the foot of this file)
**Date:** 2026-08-24 (v1: 2026-08-21; v2.1: 2026-08-23, SYNC_BUS_V2_SECONDARY_REVIEW; v2.2: Slice 2b multi-emit sniff)
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
  if (('case_stage' in fields || 'pipeline_phase' in fields) && !pwRecentlyRefreshed())
    loadPipeline();                               // C1 guard: skip if pwData set within ~1.5s (the
                                                  //   in-page advance already drew the fresh payload)
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
5. appt-updated/event-updated → **leave in place**, revisit Slice 2.

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
