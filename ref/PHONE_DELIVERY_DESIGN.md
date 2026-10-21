# Phone Outbound Delivery — design

**Arc:** phone-delivery · **Status:** CLOSED 2026-10-21, all live: S1 sync →
S2 cutover (wf19 retired, status-transition ping proven) → S3/S3b chips on
both surfaces → S4 backfill (638 texts recovered May→Oct, logged at send
time, Layer 3 skipped on all 638) → S3c failed-send dispatch (wf 54: plain
email to SS + technical to IT, live-fired on a real failure same day). S5
(digest, Quo read side) and the other deferrals live in ref/plans.md.
**Scope:** OUTBOUND SMS/MMS only — recovering texts the ingest never saw, and
learning/display of per-message delivery status. Inbound parsing stays where it
is (see §9 Q3).

Verified against live DB + repo @ 726a5a9 (2026-10-14). CTEs are blocked on the
RO endpoint; the counts below were run as plain aggregates on `hook_executions`
and `phone_event_log`.

---

## 1. The two bugs this fixes

Both live in the DB-authored half of the ingest pipeline (hook 22
`rc-message-out` + wf19 `wf_rc_message_out`), not in committed code.

**B1 — delivery status is never captured.** Hook 22's filter accepts only
`changes[].newCount > 0` and deliberately rejects status-transition events
(`updatedCount` only, no IDs — e.g. hook execution 31641). wf19 fetches
`/message-store/{id}` once, at creation time, when `messageStatus` is still
Queued/Sent, and its `set_vars` don't keep it. Nothing in the repo reads
`messageStatus` or `deliveryErrorCode`. So a text RC later marks
SendingFailed/DeliveryFailed (number can't receive texts, opt-out, carrier spam
filter) renders in comms.html identically to a delivered one. Discovered
2026-10-14: ~weekly payment-reminder texts to a client failing in the RC app
(spam-content block on 10-09, "can't receive text messages" on 10-12 and
10-14) while comms.html showed a normal thread.

**B2 — multi-ID events lose every message after the first.** Hook 22's
transform takes `newMessageIds[0]` ("rare in practice" per its description —
false). Since 2026-06-01: store events carried 4,837 new-message IDs; ingest
logged 2,355 inbound + 1,848 outbound. Dropped inbound is recovered by hook 21
(`/instant` carries the payload); dropped outbound is simply missing —
**~630 outbound texts (~25% of RC outbound)**, concentrated in batched
scheduled sends (one Monday event carried 9 IDs for the same reminder text;
only the first was logged).

`rc_sms_log` is unaffected and out of scope: it logs phoneService API-send
attempts only. Texts sent from the RC app never touch it, which is why it has
no rows for the affected client.

---

## 2. Shape: core + driver

The send side already has a clean driver model (`phoneService` ADAPTERS map,
`services/adapters/phone/<provider>.js`). This arc extends that contract with
a **read side** instead of adding more RingCentral parsing to DB-authored
steps. Provider vocabulary (`messageStatus`, `SMS-CAR-411`, `newMessageIds`)
exists ONLY inside the adapter file.

```
 RC ping (hook 22, any SMS change) ──┐          (both are just "go look now";
 scheduled_jobs tick (*/10 min) ─────┴──► fns.phone_outbound_sync   neither carries data)
                                             │ for each distinct (provider, credential_id)
                                             │ group of active, outboundSync-capable lines:
                                             ├─► adapter.listOutbound(db, {credentialId, lines,
                                             │                             sinceISO, untilISO, page})
                                             │      └─ returns NORMALIZED records (§3)
                                             ├─ unknown provider_ref → ingestPhoneEvent()   ← fixes B2
                                             └─ known provider_ref   → stamp delivery cols  ← fixes B1
```

- **Core** (`services/phoneDeliveryService.js` + `fns.phone_outbound_sync` in
  `lib/internal_functions/communication.js`): provider-agnostic. Knows only
  the normalized vocabulary (§3). Groups `phone_lines` by
  `(provider, credential_id)` — RC's two lines share extension 55880693 and
  one credential, so one RC listing covers both; grouping by line would
  double-fetch. The core reaches adapters through
  `phoneService.getAdapter(provider)` (S1) — the registry stays the one
  dispatch point; a service requiring `adapters/phone/<p>` directly is the
  drift §8 flags.
- **Driver** (`services/adapters/phone/ringcentral.js` gains
  `listOutbound()`): lists
  `GET /restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&direction=Outbound&dateFrom&dateTo&page&perPage=100`
  — same endpoint family as `listVoicemails` (probed LIGHT rate group
  2026-10-14; re-probe the first live response's `x-rate-limit-group` in S1
  and park the tick early on 429, same as the archive sweep). Maps RC fields
  to §3. Returns `{status, records, rate, errorText}`, never throws on an
  HTTP status (adapter archive-fetcher convention).
- **Quo**: `capabilities.outboundSync: false` for now. Hook 16 only fires on
  `message.delivered`, so a failed Quo send is invisible today (same bug,
  smaller line). When Quo's API is confirmed to expose delivery status, a
  `listOutbound` there slots in with zero core change.

### Window, not watermark

Each run re-lists a fixed window (default `now − 48h → now`, overridable
params for backfill). No sync cursor to store, no gap when a tick dies, and
late carrier verdicts (RC's SMS-CAR-104: "check again after an hour") are
re-checked for two days. Writes are no-ops unless state/code changed, so the
re-listing is churn-free. Idempotency comes from the existing
`ux_phone_event_provider_ref (provider, provider_ref)` unique key — the sync
inserts via `ingestPhoneEvent`, which already dedupes on it (MTH-2).

### Concurrency & failure posture

- `GET_LOCK(CONCAT('phone_outbound_sync:', DATABASE()), 0)` — skip, don't
  queue, when a run is live (archive-sweep pattern).
- Gate setting `phone_delivery_sync_enabled` ('1' to run), read via
  `settingsService.getSetting` (pattern: `comms_archive_enabled`), registered
  in `lib/settingsRegistry.js` (firm/comms/bool — a new app_settings key means
  a registry entry in the same slice; the inventory test enforces it).
- Alert severity per the house convention: transient (timeout/429/5xx) AND
  first occurrence for its credential → `warning`; repeated or non-transient
  → `error`.
- Delivery stamping is pure-DB (`retries:1` fine). `ingestPhoneEvent` manages
  its own spans; the sync never wraps it in an outer transaction.

---

## 3. Normalized vocabulary & adapter contract extension

`phoneService`'s adapter contract (its file header) gains an optional read
side:

```js
//   capabilities: { sms, mms, outboundSync?: bool },
//   async listOutbound(db, { credentialId, lines, sinceISO, untilISO, page })
//     → { status, records: [NormalizedOutbound], rate, errorText }
//     Never throws on an HTTP status; throws err.code 'NO_AUTH' before
//     sending when the credential yields no auth header.
```

`NormalizedOutbound` — everything core/UI ever sees:

```js
{
  provider:     'ringcentral',
  provider_ref: '3092550772018',      // = provider_message_id (ingest dedupe key half)
  from: '2485592400', to: '2482405969',  // 10-digit, adapter-normalized
  body: '…', ts: '2026-10-14T13:13:02.000Z',
  conversation_id: '…', attachments: [{id, type, contentType}],
  delivery: {
    state:  'pending' | 'sent' | 'delivered' | 'failed',
    reason: null | 'unreachable' | 'opted_out' | 'spam_content'
                 | 'sender_flagged' | 'unknown',       // failed only
    provider_code: 'SMS-CAR-411' | null,  // raw, tooltip-only, never branched on
    checked_at: <run time ISO>,
  },
}
```

RC mapping (lives ONLY in `ringcentral.js`):

| RC `messageStatus` | state |
|---|---|
| Queued | pending |
| Sent | sent |
| Delivered | delivered |
| SendingFailed, DeliveryFailed | failed |

| RC `deliveryErrorCode` | reason |
|---|---|
| SMS-RC-410, SMS-UP-410, SMS-CAR-400/411/412 | unreachable |
| SMS-RC-413, SMS-UP-413, SMS-CAR-413 | opted_out |
| SMS-RC-430, SMS-UP-430/433 | spam_content |
| SMS-UP-431 | sender_flagged |
| SMS-CAR-104/199, anything else | unknown |

Source: developers.ringcentral.com/guide/messaging/sms/sms-errors.

Terminal-state guard in core: a row already `failed` or `delivered` is never
downgraded to `pending`/`sent` by a later run.

---

## 4. Schema migration (S1, runs FIRST — deploy order is absolute)

New columns on `phone_event_log` (ruled 2026-10-14: columns, not
`raw_extra` JSON — the digest and the pane filter query them). Varchar, not
enum, per house convention (app-validated; sql_mode is relaxed).

```sql
ALTER TABLE phone_event_log
  ADD COLUMN delivery_state varchar(12) NULL
    COMMENT 'outbound delivery, normalized by phoneDeliveryService: pending|sent|delivered|failed. NULL = incoming row, call, or never synced. Vocabulary: ref/PHONE_DELIVERY_DESIGN.md §3',
  ADD COLUMN delivery_reason varchar(16) NULL
    COMMENT 'failure reason (delivery_state=failed): unreachable|opted_out|spam_content|sender_flagged|unknown',
  ADD COLUMN delivery_code varchar(32) NULL
    COMMENT 'raw provider error code (e.g. SMS-CAR-411). Tooltip/forensics only — only the provider adapter may interpret it',
  ADD COLUMN delivery_checked_at datetime NULL
    COMMENT 'last phone_outbound_sync stamp (UTC)',
  ADD INDEX idx_phone_event_delivery (delivery_state, processed_at);
```

Index serves the digest ("failed since X") and the pane. ~10.7k rows live —
instant ALTER, but still: low `lock_wait_timeout` first, per the house
migration rule.

---

## 5. Slices

- **S1 — core + RC driver + migration + tick.**
  Migration above → `phoneDeliveryService.js` → `ringcentral.listOutbound` →
  `fns.phone_outbound_sync` (with `__meta`; **added to `CTA_FN_DENYLIST`** —
  spends the shared RC budget and writes logs, same reasoning as the archive
  sweeps) → `scheduled_jobs` recurring row (`*/10 * * * *`,
  `internal_function`, same shape as Comms Archive Sweep id 10475) →
  setting `phone_delivery_sync_enabled`. Runs safely ALONGSIDE wf19: both
  paths funnel through `ingestPhoneEvent`'s (provider, provider_ref) dedupe.
  From deploy, dropped texts are recovered within ~10 min and statuses stamp.
  Tests: real-engine harness on a fixture `listOutbound`; mutation-check the
  terminal-state guard and the no-op-write comparison.
- **S2 — cutover (DB config only, via apiSend; assert-before-write).**
  Hook 22 filter → accept any SMS change (new OR updated); target 26 →
  one-step workflow calling `phone_outbound_sync` (a ping — the event body is
  ignored). wf19 steps retire. Hook 22's description rewritten (its "multi-ID
  rare in practice" claim is the falsified doc — fixed here, where it lives).
- **S3 — display.** `phoneCommsService` LATEST/thread SQL + `threadItem` gain
  `delivery {state, reason}`; comms.html bubble chip for `failed`
  ("Not delivered — can't receive texts / blocked as spam / opted out"),
  tooltip carries `delivery_code`. Thread bubbles only; list rows unchanged.
  Second surface since 2026-10-17: `entityCommsService.loadPhone` reads
  `phone_event_log` for the case/contact comms feeds — its SMS items gain the
  same `delivery` fields as S3b (same columns, one more SELECT list + chip).
- **S4 — backfill.** `phone_outbound_sync` run by hand (SU console /
  one-shot `scheduled_jobs` row) with explicit `{since:'2026-05-20',
  until:…}` params, paged by month to respect the rate group. Recovers the
  ~630 missing texts and stamps history.
- **S3c — failed-send dispatch (ruled yes 2026-10-21).** When a LIVE run
  transitions a row's verdict to `failed` (fresh verdict or null→failed —
  never a re-check no-op, never a failed→failed code refinement, never the
  backfill, same reasoning as §6 — and NEVER when the failed text's recipient
  is one of the firm's own lines, active or not (S3c-b loop guard, 2026-10-21:
  wf 54 itself texts a staff line, so dispatching on a failed notification
  would send another at status-ping speed; firm-to-firm failures stay visible
  as chips and count as `dispatch_skipped_firm`)), the sync starts the
  workflow named by
  `app_settings.phone_delivery_failed_workflow_id` (blank = off) through
  `actionDispatchers.dispatchWorkflow` — the standard hook-target path, so
  inactive/unpublished refusals, init_data capture and the queued start all
  behave exactly as a hook dispatch. Init data:
  `{kind:'sms_delivery_failed', provider, provider_ref, to, from, body, ts,
  reason, code}`. The WORKFLOW owns the action (task, email, nothing) — code
  never hardcodes one. Known noise shape: a chronically unreachable number
  re-fails on every new send (new row = new transition), so the workflow
  should expect weekly repeats per client.
- **S5 — later.** Failed-texts daily digest (query on the new columns) as the
  grouped alternative if the S3c dispatch proves noisy; Quo `listOutbound`
  when its API is confirmed.

---

## 6. Backfill semantics (ruled 2026-10-14)

Backfilled ingest **skips Layer 3** (phone ingest rules / automation
actions): firing June's rules in October is retroactive automation on stale
events. Mechanism: `ingestPhoneEvent(db, event, { skipAutomation: true })` —
an explicit opts flag, defaulting false; the executions row still writes, with
`metadata.automation = { skipped: 'backfill' }` so the trail says why.
**Layer 2 (suppression) still runs** — it governs the log write, and a
backfilled firm-to-firm text must be as suppressible as a live one. Backfilled
events carry `extra.backfill = true` (queryable in `log_extra`/`raw_extra`).
Live S1 sync runs (48h window) do NOT skip Layer 3 — a text recovered minutes
late should fire exactly what it would have fired on time.

> Reviewer ruling (Fable, 2026-10-14): **confirmed.** The 48h-window live/
> backfill boundary is the right line because Layer-3 rule conditions are
> written against "a text just happened"; beyond the window that premise is
> false. One sharpening: the flag is per-call opts, NOT inferred from event
> age — inference would silently skip Layer 3 for any legitimately late
> provider redelivery.

---

## 7. Open questions

**Q3 (carried from scoping) — move INBOUND parsing into adapters
(`adapter.parseWebhook`) in this arc?** Tentative: no — later, its own arc.

> Reviewer ruling (Fable, 2026-10-14): **later, own arc — confirmed.**
> (a) It touches three live hooks (16/17/21) + wf17/18 and re-verifying the
> whole inbound path is unrelated risk in an outbound-scoped arc;
> (b) the same DB-authored-transform debt exists on the email side, and a
> coherent "ingest parsing into drivers" arc should take both;
> (c) nothing in S1–S5 depends on it. Filed in ref/plans.md at S2 close.

Resolved at close: SS now hears about every new failure through wf 54's
email; the digest stays a deferral in ref/plans.md, built only if the
per-failure emails get loud.

---

## 8. Pointers

- Adapter contract: `services/phoneService.js` header (extended in S1).
- Ingest pipeline + dedupe: `services/phoneIngestService.js` header (MTH-2).
- Archive-fetcher conventions this copies (never-throw shape, rate headers,
  GET_LOCK, enabled-setting, tick): `services/commsArchiveSweep.js` +
  `ref/COMMS_ARCHIVE_DESIGN.md` §6.
- Known adjacent drift (NOT this arc): `commsArchiveSweep.js:240` and
  `commsArchiveMediaSweep.js:562` lazy-require adapters directly instead of
  dispatching through the registry — flagged to the archive arc 2026-10-14.
