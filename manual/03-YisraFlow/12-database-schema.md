# 12 — Database Schema

## For operators

This chapter is a reference of every table the YisraFlow automation system uses, what each column means, and how the tables relate to each other. You'll only need this if you're querying the database directly or planning a schema change.

If you just want to use the system, you don't need this chapter — the UI and APIs handle all of this.

---

## Technical reference

All tables use `utf8mb4` collation, mostly `utf8mb4_general_ci` (a few in `_unicode_ci` — historical drift, not meaningful).

### Tables in scope

| Table | Owner | Chapter |
|---|---|---|
| `workflows` | Workflow Engine | 2 |
| `workflow_steps` | Workflow Engine | 2 |
| `workflow_executions` | Workflow Engine | 2 |
| `workflow_execution_steps` | Workflow Engine | 2 |
| `sequence_templates` | Sequence Engine | 3 |
| `sequence_steps` | Sequence Engine | 3 |
| `sequence_enrollments` | Sequence Engine | 3 |
| `sequence_step_log` | Sequence Engine | 3 |
| `scheduled_jobs` | Scheduled Jobs | 4 |
| `job_results` | Scheduled Jobs | 4 |
| `hooks` | YisraHook | 9 |
| `hook_targets` | YisraHook | 9 |
| `hook_executions` | YisraHook | 9 |
| `hook_delivery_logs` | YisraHook | 9 |
| `credentials` | YisraHook + sequence webhook | 9 |
| `email_router_config` | Email Router (singleton) | 10 |
| `email_routes` | Email Router | 10 |
| `email_router_executions` | Email Router | 10 |
| `phone_lines` | shared (SMS routing) | 4, 9 |
| `email_credentials` | shared (email routing) | 4, 9 |
| `app_settings` | shared | — |

The legacy `sequences` / `seq_steps` / `seq_types` tables are **superseded** by `sequence_templates` / `sequence_steps` / `sequence_enrollments`. Don't write to the legacy tables — they exist for historical data only.

---

### Workflow tables

#### `workflows` — template

```sql
id                       int             PK
active                   tinyint(1)      default 1
name                     varchar(100)
description              text
created_at               datetime
updated_at               datetime
default_contact_id_from  varchar(100)    -- name of init_data key for contact-tying
test_input               json            -- saved test payload for the Test tab
```

#### `workflow_steps` — ordered steps

```sql
id            int        PK
workflow_id   int        FK → workflows(id)        ON DELETE CASCADE
step_number   int                                  UNIQUE (workflow_id, step_number)
type          enum('webhook','internal_function','custom_code')
config        json       NOT NULL
error_policy  json
created_at, updated_at
```

#### `workflow_executions` — one run

```sql
id                    bigint  PK
workflow_id           int     FK → workflows(id)   ON DELETE RESTRICT
contact_id            int                          -- nullable; from explicit override or template default
status                enum('pending','active','processing','delayed',
                          'completed','completed_with_errors','failed','cancelled')
init_data             json                         -- snapshot from POST body
variables             json                         -- mutable; merged from set_vars across steps
current_step_number   int     default 1
steps_executed_count  int     default 0
created_at, updated_at
completed_at          datetime
cancel_reason         varchar(500)
```

Indexes: `idx_workflow_status (workflow_id, status)`.

#### `workflow_execution_steps` — per-step audit

```sql
id                      bigint  PK
workflow_execution_id   bigint  FK → workflow_executions(id)  ON DELETE CASCADE
step_number             int
step_id                 int
status                  enum('success','failed','skipped','delayed')
output_data             json
error_message           text
attempts                int     default 0
duration_ms             int     default 0
executed_at             datetime
```

Indexes: `idx_execution_step (workflow_execution_id, step_number, executed_at DESC)`, `idx_execution`.

---

### Sequence tables

#### `sequence_templates` — template

```sql
id                int unsigned   PK
name              varchar(100)
type              varchar(50)                 -- e.g. "no_show", "lead_drip"
appt_type_filter  varchar(50)                 -- cascade match (NULL = wildcard)
appt_with_filter  tinyint                     -- cascade match (NULL = wildcard)
condition         json                        -- template-level condition (cancel-level)
description       text
active            tinyint(1)     default 1
created_at, updated_at
test_input        json                        -- saved test payload
```

Indexes: `idx_type (type)`, `idx_active (active)`.

#### `sequence_steps` — ordered steps

```sql
id             int unsigned   PK
template_id    int unsigned   FK → sequence_templates(id)  ON DELETE CASCADE
step_number    int                                          UNIQUE (template_id, step_number)
action_type    enum('sms','email','task','internal_function','webhook','start_workflow')
action_config  json     NOT NULL
timing         json     NOT NULL
condition      json                          -- step-level condition (skip-level)
fire_guard     json                          -- time-based skip-only guards
error_policy   json
created_at, updated_at
```

#### `sequence_enrollments` — one contact's run

```sql
id              bigint unsigned  PK
template_id     int unsigned     FK → sequence_templates(id)  ON DELETE RESTRICT
contact_id      int unsigned
trigger_data    json                              -- frozen at enrollment time
status          enum('active','completed','cancelled')  default 'active'
current_step    int unsigned     default 1
total_steps     int unsigned     default 0       -- snapshot of steps.length at enrollment
cancel_reason   varchar(200)
enrolled_at     datetime
completed_at    datetime
updated_at      datetime
```

Indexes: `idx_contact_status (contact_id, status)`, `idx_template_status (template_id, status)`, `idx_status`.

#### `sequence_step_log` — per-step audit

```sql
id                       bigint unsigned  PK
enrollment_id            bigint unsigned  FK → sequence_enrollments(id)  ON DELETE CASCADE
step_id                  int unsigned
step_number              int
status                   enum('sent','skipped','failed')
skip_reason              varchar(200)              -- e.g. "fire_guard_failed", "step_condition_failed"
action_config_resolved   json                      -- the config after placeholder resolution
output_data              json
error_message            text
duration_ms              int     default 0
scheduled_at             datetime                  -- when the job was scheduled to fire
executed_at              datetime
```

Indexes: `idx_enrollment`, `idx_enrollment_step (enrollment_id, step_number)`.

---

### Scheduled jobs

#### `scheduled_jobs` — the unified queue

```sql
id                       bigint     PK
type                     enum('one_time','recurring','workflow_resume','sequence_step','hook_retry')
scheduled_time           datetime   NOT NULL
status                   enum('pending','running','completed','failed')  default 'pending'
name                     varchar(200)
data                     json       NOT NULL          -- per-type payload; data.type for one_time/recurring
recurrence_rule          varchar(100)                  -- cron expression for recurring
workflow_execution_id    bigint                        -- back-pointer for workflow_resume jobs
sequence_enrollment_id   bigint unsigned               -- back-pointer for sequence_step jobs
attempts                 int        default 0
max_attempts             int        default 3
backoff_seconds          int        default 300
max_executions           int                           -- recurring: stop after N runs (NULL = no limit)
expires_at               datetime                      -- recurring: stop after this datetime
execution_count          int        default 0          -- bumped on every successful run
idempotency_key          varchar(100)                  -- duplicate-prevention; non-unique by design
created_at, updated_at
```

Indexes: `idx_scheduled_pending (status, scheduled_time)`, `idx_seq_enrollment (sequence_enrollment_id)`.

> **Critical:** the `type` enum has only **5 values**. The seven-or-eight-value lists in older docs and the AI context conflate this enum with `data.type` for `one_time`/`recurring` jobs. See chapter 4.

#### `job_results` — per-attempt audit

```sql
id               bigint  PK
job_id           bigint
attempt          int
execution_number int                       -- bumps each time the job re-fires (for recurring)
status           enum('success','failed')
output_data      json
error_message    text
duration_ms      int     default 0
executed_at      datetime
```

---

### Hook tables

#### `hooks`

```sql
id                int            PK
slug              varchar(100)                UNIQUE (uk_slug)
name              varchar(255)
description       text
auth_type         enum('none','api_key','hmac')   default 'none'
auth_config       json
filter_mode       enum('none','conditions','code') default 'none'
filter_config     json
transform_mode   enum('passthrough','mapper','code') default 'passthrough'
transform_config  json
active            tinyint(1)     default 1
version           int            default 1    -- auto-bumped on UPDATE
last_modified_by  int
created_at, updated_at
capture_mode      enum('off','capturing')     default 'off'
captured_sample   json
captured_at       datetime
```

#### `hook_targets`

```sql
id              int        PK
hook_id         int        FK → hooks(id)         ON DELETE CASCADE
target_type     enum('http','workflow','sequence','internal_function')  default 'http'
name            varchar(255)
position        int        default 0           -- ordered execution
method          enum('GET','POST','PUT','PATCH','DELETE')  default 'POST'
url             varchar(2048)                  -- http only
headers         json
credential_id   int        FK → credentials(id)  ON DELETE SET NULL
body_mode       enum('transform_output','template')  default 'transform_output'
body_template   text                            -- when body_mode='template'
config          json                            -- target-type-specific config (workflow_id, template_id, function_name, etc.)
conditions      json                            -- target-level conditions, evaluated against transform output
transform_mode  enum('passthrough','mapper','code')  default 'passthrough'
transform_config json
active          tinyint(1) default 1
```

Indexes: `idx_hook_position (hook_id, position)`, `fk_hook_targets_cred (credential_id)`.

#### `hook_executions`

```sql
id               bigint     PK
hook_id          int
slug             varchar(100)
raw_input        json                       -- truncated to 512 KB
filter_passed    tinyint(1)
transform_output json
status           enum('received','filtered','processing','delivered','partial','failed','captured')
error            text
created_at       datetime
```

Indexes: `idx_hook_created (hook_id, created_at)`, `idx_status`.

#### `hook_delivery_logs`

```sql
id              bigint     PK
execution_id    bigint
target_id       int
request_url     varchar(2048)            -- internal://workflow/N or internal://function/name for internal targets
request_method  varchar(10)              -- INTERNAL for internal targets
request_body    json
response_status int
response_body   text
status          enum('success','failed')  default 'failed'
error           text
attempts        int        default 1
created_at      datetime
```

Indexes: `idx_exec (execution_id)`.

#### `credentials` — shared outbound auth

```sql
id            int          PK
name          varchar(255)
type          enum('internal','bearer','api_key','basic')  default 'internal'
config        json                                -- type-specific (bearer token, basic credentials, etc.)
allowed_urls  json                                -- URL prefix scoping
created_at, updated_at
```

Used by both YisraHook HTTP targets and sequence `webhook` steps.

---

### Email Router tables

#### `email_router_config` — singleton (id=1)

```sql
id              int                      PK    default 1   -- always 1
auth_type       enum('none','api_key')   default 'api_key'
auth_config     json                                      -- { header, key }
capture_mode    enum('off','capturing')  default 'off'
captured_sample json
captured_at     datetime
updated_at      timestamp
```

#### `email_routes` — rules

```sql
id               int            PK
name             varchar(120)
description      text
slug             varchar(100)              -- target hook slug
match_mode       enum('conditions','code') default 'conditions'
match_config     json    NOT NULL
position         int            default 100
active           tinyint(1)     default 1
last_matched_at  datetime
match_count      int            default 0  -- bumped on every match
last_modified_by int
created_at, updated_at
```

Indexes: `idx_active_position (active, position)`, `idx_slug`.

#### `email_router_executions`

```sql
id                 bigint   PK
raw_input          json                    -- truncated to 512 KB
matched_route_id   int                     -- FK soft-link to email_routes
resolved_slug      varchar(100)
hook_execution_id  bigint                  -- soft-link to hook_executions; populated after dispatch
status             enum('routed','unrouted','captured','error')
error              text
created_at         datetime
```

Indexes: `idx_created_at`, `idx_status`, `idx_route (matched_route_id)`, `idx_hook_exec (hook_execution_id)`.

---

### Shared tables (relevant to YisraFlow)

#### `phone_lines` — SMS routing

```sql
id            tinyint unsigned  PK
phone_number  char(10)
provider      enum('ringcentral','quo')         -- two values only
display_name  varchar(50)
active        tinyint(1)        default 1
provider_id   varchar(50)                        -- provider-specific account/line ID
```

> Note: the AI context document also lists `'openphone'` as a third enum value. The actual schema does not — it's a 2-value enum. If you need OpenPhone support, the migration to extend the enum hasn't been run.

#### `email_credentials` — email routing

```sql
id           int unsigned   PK
email        varchar(255)
smtp_host    varchar(255)
smtp_port    int
smtp_user    varchar(255)
smtp_pass    varchar(255)
smtp_secure  tinyint(1)     default 1
provider     enum('smtp','pabbly')   default 'smtp'
from_name    varchar(64)
```

#### `app_settings` — generic key/value

```sql
key         varchar(100)  PK
value       text
updated_at  timestamp
```

Used by automations to read system-wide values like `appt_reminder_workflow_id`. Not to be confused with the `settings` table (legacy, also exists).

---

### FK relationships at a glance

```
workflows ──────────► workflow_executions ──────► workflow_execution_steps
                                                  (CASCADE on parent delete)
workflow_steps ◄────── workflows
                       (CASCADE)

sequence_templates ──► sequence_enrollments ────► sequence_step_log
                                                  (CASCADE on enrollment delete)
sequence_steps ◄────── sequence_templates
                       (CASCADE)

hooks ────────────────► hook_targets    (CASCADE)
hook_targets ─────────► credentials     (SET NULL on credential delete)
hook_executions, hook_delivery_logs    -- soft-linked, no FK
                                       -- (preserves audit if hooks/targets deleted)

email_routes ──────────► (no FK to hooks; soft-linked by slug string)
email_router_executions ──► email_routes (soft-linked by id)
                          ──► hook_executions (soft-linked by id)

scheduled_jobs ──► workflow_executions (back-pointer column, no FK)
                ──► sequence_enrollments (back-pointer column, no FK)
job_results ──► scheduled_jobs (no FK; preserves audit)
```

The hook + email-router log tables and `job_results` are intentionally **soft-linked** so deleting a parent row doesn't cascade through the audit tables. This keeps a permanent record of what happened even if you delete the underlying hook / route / job.

---

### Common pitfalls

1. **`scheduled_jobs.type` is a 5-value enum, not 8.** Older docs conflate it with `data.type`. See chapter 4.
2. **`phone_lines.provider` is `('ringcentral','quo')`** — only two values. The AI context document is wrong on this.
3. **`appt_status` and `campaigns.status` use `'canceled'` (one L)** — not `'cancelled'` (two Ls). `sequence_enrollments.status` and `workflow_executions.status` use `'cancelled'` (two Ls). Inconsistent across the schema; don't typo.
4. **`cases.case_id` is varchar** (8-char alphanumeric like `"uT7EU36v"`) — not an int. Workflow `init_data.case_id` and sequence `trigger_data.case_id` should be string.
5. **`users.user` is the PK** of the users table — not `users.user_id` or `users.id`. `req.auth.userId` is the property name on the auth context.
6. **Two `condition` columns are reserved-word in MySQL** — `sequence_templates.condition` and `sequence_steps.condition`. Always backtick-quote them in raw SQL: `\`condition\``.
