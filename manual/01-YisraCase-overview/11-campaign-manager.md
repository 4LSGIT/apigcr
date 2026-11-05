# Campaign Manager

The Campaign Manager sends bulk SMS and email messages to groups of contacts. Staff select contacts by filters (tags, case type, case stage, date range), compose a message with placeholder personalization, and send immediately or schedule for later.

Campaigns execute through the scheduled jobs system — one job per contact — so each send is atomic, retryable, and doesn't timeout on Cloud Run. Each recipient is sent to **at most once**: a send that might have gone out is never repeated (see "Unknown" below).

---

## Campaign type: operational or marketing

Every campaign has a **type** (the send *class*), chosen on the Compose tab:

- **Operational** (the default) — the message is about the recipient's case,
  appointment or account: a note to a dozen clients, a hearing change, an
  office closure. Choosing it is a statement, and the screen says so:
  *"this message is about the recipient's case, appointment or account — not
  promoting services."* An operational message must not carry promotional
  content (that can make the whole message commercial under CAN-SPAM).
  - **Opt-outs:** an operational EMAIL reaches clients who opted out of
    marketing email — opt-outs stop promotion, not case mail (ruling D18). An
    operational TEXT still skips a number that texted STOP.
  - **The cap:** up to **50 recipients** (the *Operational campaign recipient
    cap*, Config → Firm → Marketing email & consent), counted after
    duplicates are removed. Over the cap needs the **campaigns.bulk**
    capability (the admin role) and **typing the exact recipient count** to
    confirm; the send is recorded in the admin audit log. Over-cap campaigns
    are paced (below) and may use the marketing transport, still without any
    marketing footer.
- **Marketing** — newsletters and announcements. Email only, sent under a
  **topic** (e.g. Newsletter) the recipient can unsubscribe from, from a
  marketing transport, by a **campaigns.bulk** holder. Every marketing email
  carries the compliance footer, an unsubscribe link of its own and the
  one-click unsubscribe headers (see "Marketing email" below). **Switched off
  for now:** creating one is refused until the compliance checklist passes and
  a superuser turns on `marketing_send_enabled`; a marketing campaign that
  somehow got queued is recorded *skipped*, never sent. The **test send**
  works while it is off.

**Pacing.** Marketing and over-cap campaigns send at the *Paced send rate*
(60 per minute by default): their sends are spread out when the campaign is
created, and a background "pump" moves them along at that rate; on the
marketing transport no more than that many go out in any minute (a send
waits a few seconds instead). Campaigns within the cap send as before.

---

## Architecture

```
Staff creates campaign
        │
        ▼
POST /api/campaigns
        │
        ├─ validate class / cap / capability / kill switch (createCampaign)
        ├─ INSERT campaigns row (class, topic_key, bulk_confirmed_count)
        ├─ INSERT campaign_contacts (one per contact)
        ├─ INSERT scheduled_jobs (one per contact, campaign_send; staggered when paced)
        └─ paced only: ONE campaign_pump job + audit row
                │
                ▼
        /process-jobs (≤ 10 jobs a tick, ≤ 5 of them campaign sends)
        or a Cloud Tasks doorbell rung by the pump
                │
                ▼
        job_executor.js → campaignService.executeSend()
                │
                ├─ This recipient already has a result? → touch nothing
                ├─ Campaign status: paused → wait (no attempt used); canceled / finished → skipped
                ├─ Marketing → skipped while switched off; else the marketing path
                │   (transport hold, snapshot, unsubscribe token, footer, headers)
                ├─ Check the destination's consent (by class — see Opt-out below)
                ├─ Resolve {{placeholders}} via resolverService
                ├─ Reserve the result row ('sending'), then send
                ├─ Record 'sent' (or 'unknown' / 'failed')
                └─ Check if campaign is complete → finalize status
```

Each send is a standalone `one_time` scheduled job. The job system handles retries (3 attempts, 60s exponential backoff) and batch processing (Cloud Scheduler every minute).

---

## Database Schema

### `campaigns`

| Column | Type | Notes |
|--------|------|-------|
| `campaign_id` | int PK | Auto-increment |
| `type` | enum: `sms`, `email` | Channel |
| `sender` | varchar(255) | Phone number or email address |
| `subject` | text | Email only, supports `{{placeholders}}` |
| `body` | mediumtext | Message body, supports `{{placeholders}}`. HTML for email, plain text for SMS |
| `attachment_url` | varchar(500) | MMS image URL (SMS+RingCentral only, nullable) |
| `class` | enum: `operational`, `marketing` | The send class (default `operational`) |
| `topic_key` | varchar(40) | Marketing only: the topic recipients can unsubscribe from |
| `bulk_confirmed_count` | int | Operational over the cap only: the count the sender typed to confirm (marks the campaign over-cap) |
| `status` | enum | `draft`, `scheduled`, `sending`, `sent`, `failed`, `partial_fail`, `canceled`, `paused` |
| `scheduled_time` | datetime | Firm-local time. NULL = sent immediately |
| `contact_count` | int | Denormalized count for display |
| `created_by` | tinyint | FK → users |
| `created` | timestamp | |
| `updated_at` | datetime | Auto-updated |
| `result_summary` | json | Final rollup: `{ sent, failed, skipped, unknown }` |
| `send_snapshot` | json | Marketing only: the send-start snapshot (footer values, topic, reply-to, the template with its footer), written once by the first send |

### `campaign_contacts`

Junction table linking campaigns to contacts. Frozen at campaign creation time.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | Auto-increment |
| `campaign_id` | int | FK → campaigns (CASCADE) |
| `contact_id` | int | FK → contacts (CASCADE) |
| | | UNIQUE on `(campaign_id, contact_id)` |

### `campaign_results`

One row per contact per campaign. Written by `executeSend()`.

| Column | Type | Notes |
|--------|------|-------|
| `result_id` | int PK | |
| `campaign_id` | int | |
| `contact_id` | int | |
| `status` | enum: `sent`, `failed`, `skipped`, `sending`, `unknown` | `sending` = reserved, the send is in flight; `unknown` = the provider stopped answering mid-send (see below) |
| `error` | text | Error message on failure |
| `sent_at` | datetime | |
| `result_meta` | json | Provider response, messageId, etc. |
| `provider_message_id` | varchar(128) | The provider's id for the send (SES), stored when the send returns one; the second way a provider event finds this row |
| `delivery_status` | enum: `unknown`, `delivered`, `bounced_hard`, `bounced_soft`, `complained`, `rejected` | What the provider later reported; only ever moves to a stronger outcome |
| `delivered_at` / `bounced_at` / `complained_at` | datetime(3) | First time each was reported (UTC) |
| `delivery_diag` | varchar(255) | The provider's reason behind `delivery_status` |
| `bounce_subtype` | varchar(40) | The provider's bounce subtype (SES), e.g. `General`, `MailboxFull`, `OnAccountSuppressionList` — a suppression-list bounce still opts the address out but does not count toward the bounce rate |
| | | UNIQUE on `(campaign_id, contact_id)` |

**Delivery events (marketing email, YisraMail T2).** Mail sent through the
marketing transport (Amazon SES) reports back what happened to it: delivered,
bounced, complained (marked as spam), rejected. Those reports arrive through
the hook `ses-events` and fill the delivery columns above — campaigns sent
before then, and every SMS or operational send, stay `unknown`. A **hard
bounce** (the address does not exist) or a **spam complaint** opts that
address out of marketing email, recorded in the consent history like any other
opt-out (source "provider bounce" / "provider complaint"); case and
operational email to it are not blocked, but they will bounce too. When the
bouncing address belongs to a **client** (a contact on an open case as Primary
or Secondary), the firm's consent follow-up person gets **one** task to get a
new address; a non-client's bounce only counts in the statistics. Each spam
complaint raises a warning alert, and a hard-bounce rate above 5 % in a day
(once 200 messages were delivered) raises an error alert.

### `image_library`

Reusable uploaded images for email campaigns.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `url` | varchar(500) | GCS public URL |
| `filename` | varchar(255) | Randomized filename in bucket |
| `original_name` | varchar(255) | User's filename |
| `mime` | varchar(50) | |
| `uploaded_by` | tinyint | FK → users |
| `created_at` | datetime | |

### Opt-out — the destination's consent

Consent belongs to the number or address the campaign sends to, read through
`services/optoutService.js` (the destination's consent state, plus the
`sms_optout` / `email_optout` flag on its ACTIVE row while that flag is still
kept in step). What a send checks depends on its class
(`campaignService.consentOptsFor`, one answer for the send, the contact search
and the preview):

| | Operational | Marketing |
|---|---|---|
| SMS | skips a number opted out of texts (a STOP) | not offered |
| Email | **checks nothing** — reaches "No marketing email" contacts (D18) | skips an address opted out of marketing email or of the campaign's topic |

Before YisraMail C1 every email campaign skipped marketing opt-outs; since C1
an operational email campaign does not. That is the ruled design: the
operational class is the honest way to tell everyone, opted out or not, about
their case or the office.

**What consent removes from a selection.** After the selection, the type or
the topic changes, the page asks `POST /api/consent/preview`
`{ channel, class, topic, contact_ids }` (≤ 5,000 ids; any staff login; `class`
defaults to operational) and shows, beside "N selected", **"N will be skipped
(texts stopped)"** for SMS or **"N will be skipped (opted out of marketing
email)"** for marketing email — nothing when it is 0, and always nothing for an
operational email. The count is computed the way the send itself decides, so
it matches the `skipped` results the campaign will record. The contact search
(which takes the same `class` / `topic`) already leaves out contacts opted out
at search time, so the line usually stays empty; it catches consent that
changed after the search. It never blocks the send.

---

## API Reference

All routes require JWT auth via `jwtOrApiKey`.

### Campaign CRUD

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/campaigns` | List campaigns (paginated). Query: `status`, `page`, `limit` |
| `POST` | `/api/campaigns` | Create campaign + contacts + jobs |
| `GET` | `/api/campaigns/:id` | Single campaign with results summary (`results`: sent, failed, skipped, sending, unknown, pending). Marketing email campaigns also carry `delivery` (delivered, bounced, complained, unsubscribed, opened, clicked — from the provider's events and the consent ledger), `links` (top 10 clicked URLs with click and distinct-clicker counts) and `transport` (the sender's 24 h rates + held state; null when the sender row is gone) |
| `GET` | `/api/campaigns/:id/results` | Per-contact result details |
| `PATCH` | `/api/campaigns/:id` | `{ status: "canceled" }` (from scheduled / sending / paused), `{ status: "paused" }` (from scheduled / sending), `{ status: "sending" }` = resume (from paused). 404 missing, 409 not allowed from the current status |
| `GET` | `/api/campaigns/compose-options` | What the Compose tab offers: marketing senders (each with `held` / `held_reason`), active email topics, the cap, whether marketing is switched on, whether you hold campaigns.bulk, the footer-slot marker |
| `POST` | `/api/campaigns/test-send` | Marketing "send a test to me": `{ sender, subject, body, topic_key, contactId, attachmentUrl? }` → `{ sent, to, messageId }`. campaigns.bulk; works while marketing is switched off; 422 `transport_held` |
| `POST` | `/api/campaigns/transports/:id/release` | Lift a marketing transport's hold. Superuser + step-up, audited (`mail_transport_release`); 404 unknown, 409 not held |

### Saved segments

A segment is a **named filter** — exactly the contact-selection filters below, saved under a name and re-run whenever it is picked. It is never a frozen contact list: the campaign's recipients are chosen when the campaign is created, and consent is re-checked per recipient at send, so "Newsletter — everyone" picked next month finds next month's people. A segment never stores the campaign type or topic.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/campaigns/segments` | List (newest first). Query: `q` (name search), `include_archived=1` |
| `POST` | `/api/campaigns/segments` | `{ name, filter }` → `{ success, id }`. An unknown filter key or wrong shape is a 400 `segment_rejected` |
| `PUT` | `/api/campaigns/segments/:id` | Rename / re-point in place |
| `PATCH` | `/api/campaigns/segments/:id` | `{ archived: true\|false }` — archived segments leave the picker, nothing is deleted |

### Contact Selection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/campaigns/contacts` | Filter contacts for campaign selection |

**Query parameters** (all optional):

| Param | Example | Notes |
|-------|---------|-------|
| `channel` | `email` or `sms` | Filters by has-email/phone + opt-out |
| `class` | `operational` (default) or `marketing` | Decides the email opt-out question (operational excludes none) |
| `topic` | `newsletter` | Marketing only |
| `tags` | `intake,vip` | Comma-separated, OR logic (has any) |
| `case_type` | `Chapter 7` | Exact match via case_relate → cases |
| `case_stage` | `Open,Filed` | Comma-separated, IN match |
| `case_open_after` | `2025-01-01` | Date range on case_open_date |
| `case_open_before` | `2025-12-31` | |

**Response:** `{ contacts: [...], total: 150, excluded: 8 }`

`excluded` count reflects contacts filtered out by opt-out or missing phone/email.

### Preview

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/campaigns/preview` | Resolve placeholders for one contact |

**Body:** `{ body, subject, contactId }`

**Response:** `{ body: "resolved text", subject: "resolved subject", unresolved: ["{{contacts.bad_field}}"] }`

### Images

Campaigns no longer have image endpoints of their own. Both the Quill image
button and the MMS attachment picker call the shared **AssetPicker**
(`/js/assetpicker.js`), which talks to `/api/assets` — see
[Asset Manager](../05-Subsystems/08-asset-manager.md).

The older `/api/upload` and `/api/image-library` shims were removed once this
screen migrated; only the `image_library` table survives, and it is what the
asset store writes to.

---

## Creating a Campaign

### POST /api/campaigns

**Body:**
```json
{
  "type": "email",
  "sender": "shoshana@metrodetroitbankruptcylaw.com",
  "subject": "Important update for {{contacts.contact_fname}}",
  "body": "<p>Hi {{contacts.contact_fname}},</p><p>Your case status has been updated.</p>",
  "contactIds": [101, 102, 103, 104],
  "scheduledTime": "2026-04-20T09:00:00",
  "class": "operational"
}
```

- `class` — `operational` (default) or `marketing`, spelled exactly; `topic_key` for marketing only.
- `confirmCount` — over the operational cap: the recipient count typed to confirm.
- Refusals carry an HTTP status and a `code`: `400` (bad class / topic, unknown or wrong sender), `403 bulk_capability_required` (marketing, or over the cap, without campaigns.bulk — `count` / `cap` included), `409 over_cap_confirmation` (no or wrong `confirmCount` — `count` is the real deduplicated number, so the page re-prompts), `422 marketing_disabled` (the switch is off) / `marketing_sms_refused`.

- `scheduledTime` is firm-local time (America/Detroit). Converted to UTC internally for job scheduling. At most **366 days** ahead — a later date (often a year typo, "2926" for "2026") is refused with `400 schedule_too_far`; the Compose date picker offers nothing later.
- Omit `scheduledTime` or set to `null` for immediate send.
- `contactIds` are frozen into `campaign_contacts` at creation. The list does not re-evaluate.
- Placeholders use `resolverService` syntax: `{{contacts.contact_fname}}`, `{{contacts.contact_email|email_mask}}`, etc.

**Response:**
```json
{
  "campaignId": 87,
  "contactCount": 4,
  "jobsCreated": 4,
  "status": "scheduled",
  "class": "operational",
  "overCap": false,
  "paced": false
}
```

**What happens internally:**
1. Single transaction: INSERT campaign → batch INSERT campaign_contacts → batch INSERT scheduled_jobs (→ the pump job and the audit row when paced)
2. Each job has `idempotency_key = campaign:{id}:{contactId}` to prevent duplicates
3. Job `name = campaign:{id}:send:{contactId}` (the pump: `campaign:{id}:pump`) for LIKE-based cleanup on cancellation
4. Status is `sending` for immediate, `scheduled` for future sends (the first send flips it to `sending`)

---

## Campaign Execution

When `/process-jobs` picks up a `campaign_send` job, `job_executor.js` delegates to `campaignService.executeSend(db, campaignId, contactId)`:

1. **Load campaign** — type, class, topic, sender, subject, body, status
2. **Already recorded?** — a result row that is final (`sent`, `failed`, `skipped`, `unknown`) means a replayed job: nothing is touched. A `sending` row means an earlier attempt reserved the send and never finished — it becomes `unknown`, never resent
3. **Check status** — `paused` (only a job already claimed when the pause parked the rest): the job waits 5 minutes, using no attempt and recording nothing; `canceled`: `skipped`; `sent` / `failed` / `partial_fail`: a straggler, `skipped`
4. **Marketing** — recorded `skipped` `marketing_disabled` while the switch is off; switched on, the marketing path below
5. **Load contact**, **check opt-out** by class (`sms_optout` / `email_optout` → `skipped`; a marketing campaign asks for its topic — an opt-in topic needs the address opted in), **check channel info** (missing phone / email → `failed`), **resolve placeholders** (unresolved → `failed`; a marketing body is resolved at step 7)
6. **Marketing transport checks** — the transport **hold** (held → the campaign pauses, the job waits, nothing recorded — "Transport hold" below) and the campaign's **send-start snapshot** (taken by its first send). Then the **rate window** — a campaign on the marketing transport (marketing, or over-cap): if that transport already took the paced rate in the last 60 seconds, the job waits 2–8 seconds (no attempt used)
7. **Reserve** — the result row is written as `sending` BEFORE the provider is called. Marketing then mints the recipient's **unsubscribe token**, renders the email with the footer and checks the result (a missing footer or unsubscribe link → `failed` `footer_missing`, nothing sent)
8. **Send** — `phoneService`, `emailService.sendEmail()`, or through the marketing transport `emailService.sendEmailDirect(…, {bulk:true})`: marketing with the footer, the text part and the unsubscribe headers; over-cap operational with no footer or marketing headers
9. **Record** — `sent` (+ the provider's message id when it gave one)
10. **Check completion** — if every contact has a final result, finalize the campaign

**Error handling:** a provider REFUSAL (an SMTP or HTTP error reply, a connection that never opened) clears the reservation; a temporary one (SMTP 4xx, HTTP 429/5xx, network) throws so the job retries and sends again, a permanent one is recorded `failed`. A send where the provider **stopped answering** (timeout, dropped connection) is recorded **`unknown`** and never retried — and so is a send whose outcome could not be written down on its last attempt (it may have gone out).

**Provider paused the account.** If Amazon SES answers a marketing send with "sending paused for this account" (or suspended), the recipient goes back to the queue (no attempt used), the transport is **held** and every running marketing campaign on it is paused — instead of failing every remaining recipient.

**"Unknown" means** the message may or may not have reached the provider — the app cannot tell, so it does not send again (a missed message is better than a duplicate). Check with the recipient if it matters. Unknown counts like failed for the campaign's final status.

**Completion logic:** counts `campaign_contacts` vs the final results (a `sending` row is not final). When every contact has one: everything sent → `sent`, nothing sent → `failed`, otherwise → `partial_fail`; `result_summary` carries all four counts. The WHERE guard prevents overwriting a `canceled` status; a `paused` campaign whose sends all finished is finalized too.

---

## Campaign Cancellation

`PATCH /api/campaigns/:id` with `{ status: "canceled" }`:

1. Sets campaign status to `canceled` (allowed from `scheduled`, `sending` and `paused`)
2. Deletes pending jobs — the sends and the pump: `DELETE FROM scheduled_jobs WHERE name LIKE 'campaign:{id}:%' AND status = 'pending'`
3. Already-running jobs check campaign status at execution time and record as `skipped`

## Marketing email

What a marketing send adds, per recipient:

- **An unsubscribe link of its own** — a token row (`comm_unsub_tokens`) minted with the send. The link opens the unsubscribe page (unsubscribe from this topic, stop all marketing email, preferences); mail clients' one-click unsubscribe uses the same link. If a send is retried after the provider refused it, the same link is reused.
- **The compliance footer** — the advertisement label (topics without opt-in consent), why they got it + the unsubscribe link + "Manage preferences", the firm's name, postal address and phone, the responsible attorney and the debt-relief-agency statement (Config → Firm → Identity and Marketing email & consent). It goes before `</body>` — or wherever the body has the marker `<!-- yc:footer-slot -->` (every Designer email has it, in its locked footer block — see "Designer" below). If the firm's name, address or attorney is missing, the recipient is recorded `failed` (`footer_missing`) and nothing is sent; after rendering, the send checks that the footer and the unsubscribe link really are in both the HTML and the plain-text version, and refuses to send otherwise.
- **A plain-text version** written from the HTML, links kept as visible URLs, the footer at the end.
- **Headers** — `List-Unsubscribe` (the link), `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `List-Id` (`<topic.sending-domain>`, e.g. `<newsletter.news.4lsg.com>`), and the **Reply-To**: *Marketing reply-to address* (Config → Firm → Marketing email & consent), or the firm email when blank. No signature is appended.
- **The send log** (`email_log`) keeps who / when / the provider's reply, not the body — the campaign's snapshot is the copy.

**Attachments** (every email campaign and the test send) must be an `https://` link — the attach button's uploads always are; anything else is refused when the campaign is created. The file goes out once.

**Send-start snapshot.** The campaign's first send stores the footer values (firm name, address, attorney…), the topic, the reply-to and the template with its footer on the campaign (`campaigns.send_snapshot`, kept at least 2 years — MRPC 7.2(b)). Every recipient's footer comes from it, so editing the firm's settings while a campaign is sending changes nothing for that campaign; the next campaign uses the new values.

**Test send.** "Send test to me" on the Compose tab (marketing type, campaigns.bulk) sends the email rendered for the first selected contact to your own address, with `[TEST]` before the subject, the real footer, headers and reply-to, through the marketing transport. Its unsubscribe link is a placeholder that does nothing; no campaign or result is created. It works while marketing campaigns are still switched off, so the footer can be checked first. It is refused while the transport is held.

**Triggered marketing (C7).** The second kind of marketing email — sent to one person when something triggers it (a birthday, a milestone) rather than to a list at once — goes out from an automation: a workflow or sequence `send_email` step with `promotional: true`, optionally sending a saved Designer template (`design_id`). It uses the same consent check, footer, unsubscribe token, headers and transport rules as a campaign send and skips opted-out recipients; see the [internal functions reference](../03-YisraFlow/05-internal-functions.md) "Promotional sends" — authoring one needs the same campaigns.bulk right as sending a marketing campaign. These sends create no campaign, so they show in the email log, not in campaign stats or the daily digest.

### Transport hold

The marketing transport is **held** (stopped) automatically when, over the last 24 hours with at least 200 delivered, spam complaints pass **0.3 %** or hard bounces pass **5 %** — or when the provider pauses the account. While held: every marketing campaign on it is paused, a send that comes due pauses its campaign and waits, new marketing campaigns and test sends are refused, and IT gets one error alert a day per hold. Complaints over 0.1 % only warn (once a day). The compose sender list shows the transport as "— HELD".

Only a **superuser** releases it, through the API — `POST /api/campaigns/transports/:id/release` with step-up (there is no button); recorded in the admin audit log. Fix the cause first. Paused campaigns stay paused after the release; resume each one (Resume is refused while the transport is still held).

### Daily digest

Every morning (12:00 UTC — 7 am/8 am Detroit) the **Marketing Mail Digest** job emails a summary of the last 24 hours of marketing email: per campaign, how many were sent, delivered, hard-bounced, complained about and unsubscribed; per marketing sender, the current bounce and complaint rates and whether it is held. It sends **only on a day that saw marketing activity** — quiet days send nothing. A hold or any bounce/complaint/unsubscribe marks the subject `[attention]`.

It goes to *Marketing digest recipient(s)* (Config → System → Alerts), or to the IT alert list when that is blank. *Marketing mail digest* in the same section turns it off (`0`). The job is engine plumbing (`mail_bounce_digest`), not offered in the Scheduled Jobs picker. A held transport on a day with no marketing activity sends no digest — the hold raised its own error alert when it was set.

## Pause and resume

**Pause** (`{ status: "paused" }`, the Pause button) stops a `scheduled` or `sending` campaign without losing anything: its pending sends stay queued but are set aside (their scheduled time moved 1,000 years out, so a paused campaign never holds up other campaigns' sends), and the pump stops. A send already being processed when you pause finishes normally, or waits 5 minutes and is picked up again on resume. **Resume** (`{ status: "sending" }`, the Resume button) brings every waiting send back — spread out from now at the paced rate (within-cap campaigns: all at once); a campaign paused before its scheduled start keeps its start — and restarts the pump. Cancel works on a paused campaign too.

---

## Placeholders

Campaigns use the universal resolver (`resolverService`). In campaign context, only `contacts` refs are available:

| Placeholder | Output |
|-------------|--------|
| `{{contacts.contact_fname}}` | First name |
| `{{contacts.contact_lname}}` | Last name |
| `{{contacts.contact_name}}` | Full name |
| `{{contacts.contact_pname}}` | Preferred name |
| `{{contacts.contact_phone\|phone}}` | Formatted phone |
| `{{contacts.contact_email}}` | Email address |
| `{{contacts.contact_address}}` | Street address |
| `{{contacts.contact_city}}` | City |
| `{{contacts.contact_state}}` | State |
| `{{contacts.contact_zip}}` | Zip code |

All resolver modifiers work: `|phone`, `|upper`, `|cap`, `|email_mask`, `|default:fallback`, etc.

The preview endpoint (`POST /api/campaigns/preview`) resolves against a sample contact so staff can verify placeholders before sending.

Contact values are always inserted as text. In an email body they are HTML-escaped — a name containing `<` or `&` shows those characters, never markup — both in the preview and in the email that goes out, and the email preview renders inside a sandboxed frame. Subjects and SMS bodies are plain text and are inserted as typed.

---

## Frontend (campaign.html)

Loaded as an iframe in the main app. Uses `P.apiSend()` for all API calls and `P.Swal` for dialogs.

### Tab 1: Select Contacts

Filter controls for channel, tags, case type, case stage, and case open date range. Results display in a checkbox table. Info banner shows eligible count and excluded count (opt-out or missing contact info). Beside "N selected", a line says how many of the checked contacts the send will skip for consent (see "What consent removes from a selection" above). Selected contacts are stored in memory for the Compose tab.

**Segment** (the picker at the end of the filter bar) applies a saved filter and searches at once — "Newsletter — everyone" is one pick each month. **Save segment** stores the current filter under a name (keep a picked segment's name to update it, change it to save a new one); **Archive** retires the picked one. If a saved case type no longer exists in the data, the pick warns and searches without it rather than silently matching nothing.

### Tab 2: Compose

- **Campaign type** — Operational (default; shows the honesty line and the cap) or Marketing (email only; a Topic select appears and the sender list switches to the marketing transports from `/api/campaigns/compose-options`)
- **Sender** — dropdown from the shell's firm data: phone lines (SMS) or the email senders (email; never a marketing transport), or the marketing senders for a marketing campaign (a held one reads "— HELD")
- **Subject** (email only) — with placeholder inserter and character count hint
- **Body** — channel-dependent:
  - **Email:** three editor modes — Rich Text (Quill) / HTML Code (textarea) / **Designer** (a drag-and-drop newsletter builder, below). Quill syncs to the textarea on every change; the textarea is the body for those two. Swal warns when switching HTML → Rich Text (may simplify complex formatting). Image button opens upload/URL/library dialog with size picker. In Designer the body is the designed email; the Rich Text / HTML content is left as it was.
  - **SMS:** Plain textarea with placeholder inserter
- **Schedule** — Send Now or datetime picker (firm local time), at most 366 days ahead
- **Preview** — resolves placeholders against first selected contact, shows in Swal
- **Send test to me** (marketing, campaigns.bulk) — the real marketing email for the first selected contact to your own address, `[TEST]` subject ("Marketing email" above)
- **Create** — over the cap, the page asks you to type the recipient count and resends; a refusal (no capability, marketing switched off) shows its message

### Designer

Pick **Designer** in the editor-mode list beside the placeholder list (it takes a few seconds the first time — the builder loads only when you pick it). It opens on a starter newsletter: a header, a greeting, two columns, a button, and the **locked footer block** at the bottom.

- **Building:** drag blocks in from the Blocks panel (one or two columns, text, button, image, divider, spacer, and a Header block). Double-click text to edit it (bold, italic, underline, link — there is no strike-through); the text toolbar has a **{{ }}** list of merge tags (the same list as "Insert placeholder…", which also inserts into the text you are editing). Select a button or image and open its settings to set the link — the same merge-tag list sits under the link box. A link must be a full address starting with `https://` (or `mailto:` / `tel:`); a merge tag can go after the start, never in place of it. Double-click an image to replace it from the image library (upload, link or browse — the same picker as everywhere else). Pasting into a text block keeps the words and line breaks only; formatting is dropped.
- **The locked footer:** the bottom block cannot be deleted, moved, copied, edited or styled, and nothing can be placed below it. It holds an invisible marker: when the campaign is sent as **marketing**, the compliance footer (unsubscribe link, firm details, attorney, statements) is put exactly there, inside the email. The dashed lines in the editor only **preview** it — they are never saved or sent. To see the real footer with the firm's details, use **Send test to me** (marketing type). An operational campaign built in Designer gets no footer; the marker is invisible.
- **Designs library:** **Save design** saves it (name it in the box beside the buttons); **Save as new** saves a copy; **New** starts again from the starter newsletter; **Designs…** lists saved designs — search, Open, Duplicate (opens a copy to save under a new name), Archive / Restore. If you open or start another design with unsaved changes, it asks first. If the server refuses a design, the message names the rule and the reason (for example a link that is not an `http(s)`, `mailto:` or `tel:` address).
- **Sending:** Preview, Send test to me and Create use the designed email. **Append sender's signature** is greyed out in Designer — put the sign-off in the design. **Insert Video Link** is not available in Designer (link a button or image to the video page instead). When you create a campaign from a saved, unchanged design, the campaign remembers which design it came from, and **Dup** on that campaign later reopens the design in Designer; if the design has unsaved changes, Create asks whether to save it first or send without linking it.

### Tab 3: View Campaigns

Campaign list with status filter (Paused included). Shows inline progress bar for `sending` and `paused` campaigns ("N in flight" while sends are reserved; auto-polls every 8 seconds while any is sending). Marketing and over-cap campaigns carry a badge. Stats opens per-contact results with the class, topic and the sent / failed / skipped / unknown / in-flight counts — and, for a marketing email campaign, the delivered / bounced / complaints / unsubscribed counts plus the sender's 24-hour bounce and complaint rates (marked "low volume — rates not decisive" under 200 delivered, and "HELD" with the reason when the transport is held). Since C6 it also shows **Clicked and Opened** with the most-clicked links: read clicks as the real signal — opens are inflated because Apple Mail and others prefetch images whether or not anyone looked. Opens and clicks SES flags as likely bots (mail scanners) are ignored outright. Unsubscribe and preference links are never tracked — in the footer or placed in the body — so an unsubscribe never shows up as a click. Note the tracking rides the marketing transport's SES configuration set, so an **over-cap operational campaign** (it sends from the same bulk sender) is tracked too, pixel and wrapped links, though its results don't surface anywhere today. Pause (scheduled / sending), Resume (paused), Cancel and Duplicate actions.

### Image Handling

The Quill image button opens the shared **AssetPicker** (`/js/assetpicker.js`, collection `comms-images`, images only, 10 MB), which offers three ways in:

1. **Upload file** — read as base64 and sent to `POST /api/assets`; "Save to library for reuse" (on by default) registers it in the library
2. **Paste an image URL** — inserts a hosted image directly (nothing is uploaded or registered)
3. **Browse the library** — thumbnail grid of earlier uploads (`GET /api/assets`); remove hides one from the picker (`DELETE /api/assets/:id`, a soft delete — the file stays hosted)

All paths lead to a size picker (600px full / 400px medium / 200px small / original) before inserting. Images are inserted with email-safe inline styles (`display:block; max-width:100%; height:auto`).

A custom Quill Image blot preserves `width`, `style`, and `alt` attributes that the default blot would strip. Inserted images can be resized by clicking them in the editor (shows size picker again).

---

## Email Rendering

- `emailService.sendEmail()` handles text↔HTML auto-conversion via `normalizeBodies()`
- If only HTML is provided (campaign body), plain text is auto-generated — except marketing, which builds its own plain-text version with visible link URLs and the footer
- Campaign body is stored as HTML regardless of which editor produced it
- Images use hosted URLs (GCS bucket), never base64 — avoids spam filter issues and message bloat

---

## Throughput

- `process-jobs` claims up to 10 jobs per minute (Cloud Scheduler), **at most 5 of them campaign sends** — other due jobs claim first, so a large campaign never starves reminders or workflows
- Campaigns within the cap ride that cron: ~5 sends a minute
- Paced campaigns (marketing, over-cap) are driven by their pump: about once a minute (it re-arms itself 55 seconds out and rings its own doorbell) it rings Cloud Tasks doorbells for sends due in the next 90 seconds, at most the paced rate × 55/60 per tick (55 at 60/min — never more than the rate per minute), overdue ones included — 2,000 recipients ≈ 33 minutes

---

## Files

| File | Purpose |
|------|---------|
| `services/campaignService.js` | All business logic |
| `routes/campaign.js` | Thin HTTP wrappers, JWT auth |
| `routes/api.assets.js` | The shared [asset store](../05-Subsystems/08-asset-manager.md), reached through `/js/assetpicker.js` |
| `public/js/campaignDesigner.js` | The Designer editor mode (GrapesJS + MJML, loaded on first use): locked footer slot, merge tags, images, export, the designs-library calls |
| `lib/job_executor.js` | `campaign_send` / `campaign_pump` dispatch; a deferral sentinel (`deferJob`) |
| `routes/process_jobs.js` | The claim (campaign-send quota) and the deferral handling |
| `scripts/yisramailC1Migrate.js` | The C1 schema migration (class, topic_key, bulk_confirmed_count, paused, sending / unknown, the kill-switch row) |
| `public/campaign.html` | Frontend (iframe) |