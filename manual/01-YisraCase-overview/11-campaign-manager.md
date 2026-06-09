# Campaign Manager

The Campaign Manager sends bulk SMS and email messages to groups of contacts. Staff select contacts by filters (tags, case type, case stage, date range), compose a message with placeholder personalization, and send immediately or schedule for later.

Campaigns execute through the scheduled jobs system — one job per contact — so each send is atomic, retryable, and doesn't timeout on Cloud Run.

---

## Architecture

```
Staff creates campaign
        │
        ▼
POST /api/campaigns
        │
        ├─ INSERT campaigns row
        ├─ INSERT campaign_contacts (one per contact)
        └─ INSERT scheduled_jobs (one per contact, type=campaign_send)
                │
                ▼
        /process-jobs picks up jobs in batches of 10
                │
                ▼
        job_executor.js → campaignService.executeSend()
                │
                ├─ Check campaign status (bail if canceled)
                ├─ Check contact opt-out
                ├─ Resolve {{placeholders}} via resolverService
                ├─ Send via smsService or emailService
                ├─ Record result in campaign_results
                └─ Check if campaign is complete → finalize status
```

Each send is a standalone `one_time` scheduled job. The job system handles retries (3 attempts, 60s exponential backoff) and batch processing (10 per minute via Cloud Scheduler).

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
| `status` | enum | `draft`, `scheduled`, `sending`, `sent`, `failed`, `partial_fail`, `canceled` |
| `scheduled_time` | datetime | Firm-local time. NULL = sent immediately |
| `contact_count` | int | Denormalized count for display |
| `created_by` | tinyint | FK → users |
| `created` | timestamp | |
| `updated_at` | datetime | Auto-updated |
| `result_summary` | json | Final rollup: `{ sent, failed, skipped }` |

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
| `status` | enum: `sent`, `failed`, `skipped` | |
| `error` | text | Error message on failure |
| `sent_at` | datetime | |
| `result_meta` | json | Provider response, messageId, etc. |
| | | UNIQUE on `(campaign_id, contact_id)` |

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

### Opt-out columns on `contacts`

| Column | Type | Default |
|--------|------|---------|
| `contact_sms_optout` | tinyint(1) | 0 |
| `contact_email_optout` | tinyint(1) | 0 |

---

## API Reference

All routes require JWT auth via `jwtOrApiKey`.

### Campaign CRUD

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/campaigns` | List campaigns (paginated). Query: `status`, `page`, `limit` |
| `POST` | `/api/campaigns` | Create campaign + contacts + jobs |
| `GET` | `/api/campaigns/:id` | Single campaign with results summary |
| `GET` | `/api/campaigns/:id/results` | Per-contact result details |
| `PATCH` | `/api/campaigns/:id` | Cancel: `{ status: "canceled" }` |

### Contact Selection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/campaigns/contacts` | Filter contacts for campaign selection |

**Query parameters** (all optional):

| Param | Example | Notes |
|-------|---------|-------|
| `channel` | `email` or `sms` | Filters by has-email/phone + opt-out |
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

### Image Upload & Library

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload image (multipart or base64 JSON) |
| `GET` | `/api/image-library` | List all library images |
| `POST` | `/api/image-library` | Add URL to library manually |
| `DELETE` | `/api/image-library/:id` | Remove from library (file stays in bucket) |

**Upload body (JSON):** `{ image: "base64...", filename: "logo.png", contentType: "image/png", addToLibrary: true }`

**Upload body (multipart):** Standard file upload with field name `file`. Auto-added to library.

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
  "scheduledTime": "2026-04-20T09:00:00"
}
```

- `scheduledTime` is firm-local time (America/Detroit). Converted to UTC internally for job scheduling.
- Omit `scheduledTime` or set to `null` for immediate send.
- `contactIds` are frozen into `campaign_contacts` at creation. The list does not re-evaluate.
- Placeholders use `resolverService` syntax: `{{contacts.contact_fname}}`, `{{contacts.contact_email|email_mask}}`, etc.

**Response:**
```json
{
  "campaignId": 87,
  "contactCount": 4,
  "jobsCreated": 4,
  "status": "scheduled"
}
```

**What happens internally:**
1. Single transaction: INSERT campaign → batch INSERT campaign_contacts → batch INSERT scheduled_jobs
2. Each job has `idempotency_key = campaign:{id}:{contactId}` to prevent duplicates
3. Job `name = campaign:{id}:send:{contactId}` for LIKE-based cleanup on cancellation
4. Status is `sending` for immediate, `scheduled` for future sends

---

## Campaign Execution

When `/process-jobs` picks up a `campaign_send` job, `job_executor.js` delegates to `campaignService.executeSend(db, campaignId, contactId)`:

1. **Load campaign** — get type, sender, subject, body
2. **Check status** — if `canceled`, record as `skipped`, return
3. **Load contact** — get phone/email
4. **Check opt-out** — `contact_sms_optout` or `contact_email_optout` → record as `skipped`
5. **Check channel info** — missing phone for SMS or email for email → record as `failed`
6. **Resolve placeholders** — `resolverService.resolve()` with `refs: { contacts: { contact_id } }`
7. **Send** — `smsService.sendSms()` or `emailService.sendEmail()` (handles text↔html auto-conversion)
8. **Record result** — INSERT into `campaign_results` (INSERT IGNORE for retry safety)
9. **Check completion** — if all contacts processed, finalize campaign status

**Error handling:** Infrastructure errors (DB down) throw → job system retries. Send errors (SMTP reject) are caught → recorded as `failed`, job completes normally.

**Completion logic:** After each send, counts `campaign_contacts` vs `campaign_results`. When equal: all sent → `sent`, all failed → `failed`, mixed → `partial_fail`. The WHERE guard prevents overwriting a `canceled` status.

---

## Campaign Cancellation

`PATCH /api/campaigns/:id` with `{ status: "canceled" }`:

1. Sets campaign status to `canceled`
2. Deletes pending jobs: `DELETE FROM scheduled_jobs WHERE name LIKE 'campaign:{id}:%' AND status = 'pending'`
3. Already-running jobs check campaign status at execution time and record as `skipped`

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

---

## Frontend (campaign.html)

Loaded as an iframe in the main app. Uses `P.apiSend()` for all API calls and `P.Swal` for dialogs.

### Tab 1: Select Contacts

Filter controls for channel, tags, case type, case stage, and case open date range. Results display in a checkbox table. Info banner shows eligible count and excluded count (opt-out or missing contact info). Selected contacts are stored in memory for the Compose tab.

### Tab 2: Compose

- **Sender** — dropdown populated from `/api/phone-lines` (SMS) or `/api/email-from` (email)
- **Subject** (email only) — with placeholder inserter and character count hint
- **Body** — channel-dependent:
  - **Email:** Dual editor (Rich Text via Quill / HTML Code via textarea). Quill syncs to the textarea on every change; textarea is always the source of truth. Swal warns when switching HTML → Rich Text (may simplify complex formatting). Image button opens upload/URL/library dialog with size picker.
  - **SMS:** Plain textarea with placeholder inserter
- **Schedule** — Send Now or datetime picker (firm local time)
- **Preview** — resolves placeholders against first selected contact, shows in Swal

### Tab 3: View Campaigns

Campaign list with status filter. Shows inline progress bar for `sending` campaigns (auto-polls every 8 seconds). Stats button opens per-contact results in Swal. Cancel and Duplicate actions available.

### Image Handling

The Quill image button provides three insertion methods:

1. **Upload file** — reads as base64, sends to `POST /api/upload`, auto-saves to image library
2. **Enter URL** — inserts a hosted image directly
3. **Browse Library** — thumbnail grid of previously uploaded images with delete option

All paths lead to a size picker (600px full / 400px medium / 200px small / original) before inserting. Images are inserted with email-safe inline styles (`display:block; max-width:100%; height:auto`).

A custom Quill Image blot preserves `width`, `style`, and `alt` attributes that the default blot would strip. Inserted images can be resized by clicking them in the editor (shows size picker again).

---

## Email Rendering

- `emailService.sendEmail()` handles text↔HTML auto-conversion via `normalizeBodies()`
- If only HTML is provided (campaign body), plain text is auto-generated
- Campaign body is stored as HTML regardless of which editor produced it
- Images use hosted URLs (GCS bucket), never base64 — avoids spam filter issues and message bloat

---

## Throughput

- `process-jobs` claims 10 jobs per batch, called every ~1 minute by Cloud Scheduler
- Effective rate: ~10 sends per minute, ~600 per hour
- A 200-contact campaign completes in ~20 minutes
- For the firm's scale (50–200 contacts per campaign), this is well within limits

---

## Files

| File | Purpose |
|------|---------|
| `services/campaignService.js` | All business logic |
| `routes/campaign.js` | Thin HTTP wrappers, JWT auth |
| `routes/upload.js` | Image upload + library routes |
| `lib/job_executor.js` | `campaign_send` job type dispatch |
| `public/campaign.html` | Frontend (iframe) |