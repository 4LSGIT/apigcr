# Part 10 — Database Schema

All tables use `InnoDB` with `utf8mb4` charset unless noted. `tasks` and `log` use `MyISAM` (existing tables, not converted).

---

## Workflow Engine Tables

### `workflows`
Workflow templates.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int AUTO_INCREMENT | PK |
| `active` | tinyint(1) | Default 1 |
| `name` | varchar(100) | Required |
| `description` | text | Optional |
| `default_contact_id_from` | varchar(100) | Names the `init_data` key whose value stamps `workflow_executions.contact_id` at start. NULL = untied template. See [03-sequences.md](03-sequences.md) and AI-context §6 for precedence |
| `test_input` | json | Author-provided sample `init_data` for the Test tab. NULL = no sample |
| `created_at` | datetime | |
| `updated_at` | datetime | ON UPDATE |

### `workflow_steps`
One row per step in a workflow.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int AUTO_INCREMENT | PK |
| `workflow_id` | int | FK → `workflows.id` ON DELETE CASCADE |
| `step_number` | int | Unique per workflow |
| `type` | enum | `webhook` `internal_function` `custom_code` |
| `config` | json | Shape depends on type — see [05-internal-functions.md](05-internal-functions.md) |
| `error_policy` | json | `{ strategy, max_retries, backoff_seconds }` — NULL = ignore |
| `created_at` / `updated_at` | datetime | |

Unique key: `(workflow_id, step_number)`.

### `workflow_executions`
One row per workflow run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `workflow_id` | int | FK → `workflows.id` ON DELETE RESTRICT |
| `contact_id` | int | Nullable. Set by `resolveExecutionContactId` from the explicit override or the template's `default_contact_id_from`. Tied executions show on contact2's Automations tab |
| `status` | enum | `pending` `active` `processing` `delayed` `completed` `completed_with_errors` `failed` `cancelled` |
| `init_data` | json | Original start payload — never modified |
| `variables` | json | Live variable store — updated as workflow runs |
| `current_step_number` | int | NULL when completed |
| `steps_executed_count` | int | Total steps run including retries |
| `cancel_reason` | varchar(500) | Populated by `POST /executions/:id/cancel`. Required on that endpoint (min 3 chars trimmed) |
| `created_at` / `updated_at` / `completed_at` | datetime | |

Indexes: `(workflow_id, status)`, `(status)`.

### `workflow_execution_steps`
Immutable step result log.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `workflow_execution_id` | bigint | FK → `workflow_executions.id` ON DELETE CASCADE |
| `step_number` | int | Snapshot at execution time |
| `step_id` | int | Soft ref to `workflow_steps.id` |
| `status` | enum | `success` `failed` (engine uses these two; `skipped` `delayed` reserved) |
| `output_data` | json | On success |
| `error_message` | text | On failure |
| `attempts` | int | Not currently written (always 0) |
| `duration_ms` | int | |
| `executed_at` | datetime | |

---

## Sequence Engine Tables

### `sequence_templates`
Template definitions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int unsigned AUTO_INCREMENT | PK |
| `name` | varchar(100) | |
| `type` | varchar(50) | **Nullable.** NULL = ID-only template (not cascade-matchable; reachable only via `template_id` on enroll). Otherwise an open string like `no_show`, `lead_drip` |
| `appt_type_filter` | varchar(50) | NULL = all appt types |
| `appt_with_filter` | tinyint | NULL = all staff. Matches `users.user` for cascading template selection |
| `condition` | json | Template-level condition — cancel enrollment if fails. See [03-sequences.md](03-sequences.md) |
| `description` | text | |
| `active` | tinyint(1) | 1 = active |
| `test_input` | json | Author-provided sample `trigger_data` for the Test tab. NULL = no sample |
| `created_at` / `updated_at` | datetime | |

### `sequence_steps`
One row per step in a template.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int unsigned AUTO_INCREMENT | PK |
| `template_id` | int unsigned | FK → `sequence_templates.id` ON DELETE CASCADE |
| `step_number` | int | Unique per template |
| `action_type` | enum | `sms` `email` `task` `internal_function` `webhook` `start_workflow` |
| `action_config` | json | Same shape as `workflow_steps.config` |
| `timing` | json | When to fire. See timing types in [03-sequences.md](03-sequences.md) |
| `condition` | json | Step-level condition — skip step if fails |
| `fire_guard` | json | Time-based guard — skip step if fails. `{ "min_hours_before_appt": 24 }` |
| `error_policy` | json | Same shape as workflow error_policy |
| `created_at` / `updated_at` | datetime | |

Unique key: `(template_id, step_number)`.

### `sequence_enrollments`
One row per contact+sequence run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint unsigned AUTO_INCREMENT | PK |
| `template_id` | int unsigned | FK → `sequence_templates.id` ON DELETE RESTRICT |
| `contact_id` | int unsigned | FK → `contacts.contact_id` ON DELETE RESTRICT |
| `trigger_data` | json | Context at enrollment: `{ appt_id, appt_time, case_id, enrolled_by, ... }` |
| `status` | enum | `active` `completed` `cancelled` |
| `current_step` | int unsigned | Currently waiting step number |
| `total_steps` | int unsigned | Snapshot of step count at enrollment time |
| `cancel_reason` | varchar(200) | e.g. `new_appointment_booked` |
| `enrolled_at` / `completed_at` / `updated_at` | datetime | |

Indexes: `(contact_id, status)`, `(template_id, status)`, `(status)`.

### `sequence_step_log`
Immutable step execution log.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint unsigned AUTO_INCREMENT | PK |
| `enrollment_id` | bigint unsigned | FK → `sequence_enrollments.id` ON DELETE CASCADE |
| `step_id` | int unsigned | Soft ref to `sequence_steps.id` |
| `step_number` | int | |
| `status` | enum | `sent` `skipped` `failed` |
| `skip_reason` | varchar(200) | e.g. `condition_failed`, `fire_guard_failed`, `enrollment_cancelled` |
| `action_config_resolved` | json | Exact config after placeholder resolution — what was actually sent |
| `output_data` | json | Provider response on success |
| `error_message` | text | On failure |
| `duration_ms` | int | |
| `scheduled_at` | datetime | When the job was scheduled to fire |
| `executed_at` | datetime | |

---

## YisraHook Tables

### `hooks`
Hook definitions. Each row is one external-webhook receiver slug.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int AUTO_INCREMENT | PK |
| `slug` | varchar(100) | Unique. Routes `POST /hooks/:slug` |
| `name` | varchar(255) | Human-readable label |
| `description` | text | |
| `auth_type` | enum | `none` `api_key` `hmac`. Default `none` |
| `auth_config` | json | Shape depends on `auth_type` |
| `filter_mode` | enum | `none` `conditions` `code`. Default `none` |
| `filter_config` | json | Condition list or code string depending on mode |
| `transform_mode` | enum | `passthrough` `mapper` `code`. Default `passthrough` |
| `transform_config` | json | Mapper rules or code string depending on mode |
| `active` | tinyint(1) | Default 1 |
| `version` | int | Auto-increments on PUT |
| `last_modified_by` | int | FK → `users.user` |
| `capture_mode` | enum | `off` `capturing`. v1.2.1. Guarded atomic flip in `executeHook` |
| `captured_sample` | json | Snapshot of last captured event (unified `{body,headers,query,method,meta}` shape). Truncated at 512KB. Not cleared on arm/cancel — only on a successful capture |
| `captured_at` | datetime | Nullable. Set on successful capture |
| `created_at` / `updated_at` | datetime | |

### `hook_targets`
Delivery targets for a hook. Many per hook, fan-out is parallel-independent.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int AUTO_INCREMENT | PK |
| `hook_id` | int | FK → `hooks.id` ON DELETE CASCADE |
| `target_type` | enum | `http` `workflow` `sequence` `internal_function`. Default `http` (v1.2) |
| `name` | varchar(255) | |
| `position` | int | Ordering within the hook. Default 0 |
| `method` | enum | `GET` `POST` `PUT` `PATCH` `DELETE`. Default `POST`. HTTP targets only |
| `url` | varchar(2048) | **Nullable since v1.2** — internal targets have no URL |
| `headers` | json | HTTP targets only |
| `credential_id` | int | FK → `credentials.id` ON DELETE SET NULL. HTTP targets only |
| `body_mode` | enum | `transform_output` `template`. Default `transform_output`. HTTP targets only |
| `body_template` | text | Used when `body_mode='template'`. Supports `{{path\|transforms}}` template syntax |
| `config` | json | Internal-target routing params. v1.2. Shape varies by `target_type` (see AI-context §16) |
| `conditions` | json | Per-target condition evaluated against transform output |
| `transform_mode` | enum | `passthrough` `mapper` `code`. Per-target transform layer |
| `transform_config` | json | |
| `active` | tinyint(1) | Default 1 |

### `hook_executions`
Per-invocation log of a hook. One row per `POST /hooks/:slug`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `hook_id` | int | |
| `slug` | varchar(100) | Denormalized for query convenience |
| `raw_input` | json | Unified event shape. Capped at 512KB |
| `filter_passed` | tinyint(1) | NULL = filter did not run (filtered-out OR captured) |
| `transform_output` | json | Post-transform payload delivered to targets |
| `status` | enum | `received` `filtered` `processing` `delivered` `partial` `failed` `captured` (v1.2.1) |
| `error` | text | |
| `created_at` | datetime | |

### `hook_delivery_logs`
Per-target delivery log. Many per `hook_executions` row (one per target fired).

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `execution_id` | bigint | FK → `hook_executions.id` ON DELETE CASCADE |
| `target_id` | int | |
| `request_url` | varchar(2048) | `internal://workflow/N`, `internal://sequence/<type>`, etc. for internal targets |
| `request_method` | varchar(10) | `INTERNAL` for internal targets |
| `request_body` | json | |
| `response_status` | int | |
| `response_body` | text | Truncated at 10KB |
| `status` | enum | `success` `failed`. Default `failed` |
| `error` | text | |
| `attempts` | int | Default 1 |
| `created_at` | datetime | |

### `credentials`
Shared outbound auth store. HTTP hook targets and sequence-step `webhook` actions both reference this.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int AUTO_INCREMENT | PK |
| `name` | varchar(255) | |
| `type` | enum | `internal` `bearer` `api_key` `basic`. Default `internal` |
| `config` | json | Shape depends on `type` (token, user/pass pair, header-name/value, etc.) |
| `allowed_urls` | json | URL scope list. If set, injected URLs must match |
| `created_at` / `updated_at` | datetime | |

---

## Shared Tables

### `scheduled_jobs`
Unified job queue for all three engines.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `type` | enum | `one_time` `recurring` `workflow_resume` `sequence_step` `task_due_reminder` `task_daily_digest` `hook_retry` `campaign_send` |
| `scheduled_time` | datetime | When to fire |
| `status` | enum | `pending` `running` `completed` `failed` |
| `name` | varchar(200) | Human-readable label |
| `data` | json | Payload — shape varies by type |
| `recurrence_rule` | varchar(100) | Cron expression (recurring only) |
| `workflow_execution_id` | bigint | For `workflow_resume` jobs only |
| `sequence_enrollment_id` | bigint | For `sequence_step` jobs only |
| `attempts` | int | Attempts in current cycle |
| `max_attempts` | int | Default 3 |
| `backoff_seconds` | int | Default 300 |
| `execution_count` | int | Total successful completions |
| `max_executions` | int | Stop recurring job after N successful runs. NULL = no limit. |
| `expires_at` | datetime | Stop scheduling after this datetime. NULL = no expiry. |
| `idempotency_key` | varchar(100) | Prevents duplicate resume/step jobs |
| `created_at` / `updated_at` | datetime | |

Index: `(status, scheduled_time)` — used by the claim query in `/process-jobs`.

### `job_results`
Attempt log for standalone scheduled jobs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint AUTO_INCREMENT | PK |
| `job_id` | bigint | Soft ref to `scheduled_jobs.id` |
| `execution_number` | int | Which execution cycle |
| `attempt` | int | Which attempt within that cycle |
| `status` | enum | `success` `failed` |
| `output_data` | json | On success |
| `error_message` | text | On failure |
| `duration_ms` | int | |
| `executed_at` | datetime | |

---

## Entity Relationships

```
workflows (1)
  └── workflow_steps (many)           ON DELETE CASCADE
  └── workflow_executions (many)      ON DELETE RESTRICT
        └── workflow_execution_steps  ON DELETE CASCADE

sequence_templates (1)
  └── sequence_steps (many)           ON DELETE CASCADE
  └── sequence_enrollments (many)     ON DELETE RESTRICT
        └── sequence_step_log (many)  ON DELETE CASCADE

hooks (1)
  └── hook_targets (many)             ON DELETE CASCADE
  └── hook_executions (many)          soft ref (no FK)
        └── hook_delivery_logs (many) ON DELETE CASCADE

credentials (1)
  └── hook_targets (many)             ON DELETE SET NULL  (HTTP targets only)

scheduled_jobs (1)
  └── job_results (many)              soft ref (no FK)

contacts (1)
  └── sequence_enrollments (many)     ON DELETE RESTRICT
  └── workflow_executions (many)      soft ref, nullable (contact-tied executions)
```

---

## Task & Log Link Columns

Both `tasks` and `log` have been extended with polymorphic link columns:

| Table | New columns | Old column |
|-------|-------------|------------|
| `tasks` | `task_link_type` enum(`contact`,`case`,`appt`,`bill`), `task_link_id` varchar(20) | `task_link` varchar(50) — kept for backward compat |
| `log` | `log_link_type` enum(`contact`,`case`,`appt`,`bill`), `log_link_id` varchar(20) | `log_link` varchar(30) — kept for backward compat |

New code should use `task_link_type` / `task_link_id` and `log_link_type` / `log_link_id`. Old columns will be dropped once all callers are updated.