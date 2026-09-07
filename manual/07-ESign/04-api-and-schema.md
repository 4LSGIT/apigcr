# 4 — API and Schema

## Endpoints

All under `jwtOrApiKey` except the provider webhook, which is HMAC-verified.

### Requests

| Route | Method | Purpose |
|---|---|---|
| `/api/esign` | GET | List signature requests |
| `/api/esign/:id` | GET | One request with its event trail |
| `/api/esign/:id/source` | GET | The source document as sent |
| `/api/esign/send` | POST | Send an ad-hoc document |
| `/api/esign/send-from-template` | POST | Send a template for a case |
| `/api/esign/:id/remind` | POST | Nudge outstanding signers |
| `/api/esign/:id/resend` | POST | Re-send after a bounce |
| `/api/esign/:id/recall` | POST | Pull it back — terminal |
| `/api/esign/:id/satisfied-external` | POST | Signed on paper — terminal, counts as done |
| `/api/esign/resolve-prefills` | POST | Resolve a template's prefills against a case |
| `/api/esign/inline-images` | POST | Inline images for generated documents |

### Templates

| Route | Method | Purpose |
|---|---|---|
| `/api/esign/templates` | GET, POST | List / create |
| `/api/esign/templates/:id` | GET, PUT | One template; PUT re-runs save-time validation |
| `/api/esign/templates/:id/deactivate` | POST | Soft delete — **there is no hard delete** |
| `/api/esign/templates/:id/pdf` | GET, POST | Fetch / upload the document |
| `/api/esign/templates/:id/prefills` | POST | Set the prefill schema |
| `/api/esign/templates/:id/preview` | POST | Render with placements drawn |
| `/api/esign/template-meta` | GET | Field types, resolver names, kinds — drives the editor |

`GET /api/esign/template-meta` is the live source of truth for the resolver
whitelist and placement field types. [Chapter 2](02-templates.md) lists them for
reading; that endpoint is what the editor actually enforces against.

---

## Tables

### `signing_requests` — one row per document sent or about to be

| Column | Notes |
|---|---|
| `provider`, `provider_id` | Which vendor, and its id for this envelope. `provider_id` is written by `markSent` |
| `linkable_type`, `linkable_id` | What it's attached to — a case or a contact |
| `kind` | From the built-ins or a template-declared kind |
| `status` | The lifecycle — see [chapter 1](01-overview.md) |
| `document_name` | |
| `tracking_id` | Minted at `createRequest`, stamped into the footer. **A retry must reuse it** |
| `recipients` | JSON; `order` is the signing order and is what placement `signer` matches |
| `placement_json` | Resolved placements for this send |
| `template_id` | Points at `contract_templates` — why templates are never deleted |
| `seq_instance_id` | Reminder sequence, if enrolled |
| `completion_targets` | What runs on completion |
| `signed_pdf_path`, `cert_pdf_path` | Where filing put them |
| `sent_at` | Written by `markSent` |
| `completed_at` | **Only `signed` and `satisfied_external` stamp this.** The column that separates outstanding from abandoned |
| `expires_at` | |
| `raw_payload` | Last provider payload |
| `created_by`, `created_at`, `updated_at` | |

### `signing_request_events` — append-only

| Column | Notes |
|---|---|
| `signing_request_id` | |
| `event` | What happened |
| `recipient_email` | Which signer, when the event names one |
| `payload` | The provider's raw event |
| `occurred_at` | **Provider time** — may be out of order |
| `created_at` | **Our time** — always monotonic |

Two timestamps because they answer different questions. `occurred_at` is when
the provider says it happened; `created_at` is when we learned. A late `viewed`
after `signed` shows as out-of-order in the first and in-order in the second,
which is exactly how you confirm out-of-order delivery rather than a bug.

Append-only for legal defensibility — nothing in the codebase updates or
deletes a row here.

### `contract_templates`

Covered in [chapter 2](02-templates.md).

### `signing_request_sources`

| Column | Notes |
|---|---|
| `signing_request_id` | |
| `pdf`, `size` | The document exactly as sent |

Kept separate from `signing_requests` so listing requests never drags document
bytes through the query. This is what `GET /api/esign/:id/source` serves — the
copy the client actually received, not a re-render that might differ.

---

## Migrations

| File | What it added |
|---|---|
| `ref/2026-07-19_esign_phase1c.sql` | Data layer, audit trail |
| `ref/2026-07-20_esign_phase2e.sql` | Signer-class placement field types |
| `ref/2026-07-21_esign_phase3.sql` | Reminders, sequence wiring |
| `ref/2026-07-22_esign_webhook_hmac.sql` | Webhook authenticity |
