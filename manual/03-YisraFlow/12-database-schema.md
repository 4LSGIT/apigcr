# 12 — Database Schema

## For operators

This chapter is a reference of every table the YisraFlow automation system uses, what each column means, and how the tables relate to each other. You'll only need this if you're querying the database directly or planning a schema change.

If you just want to use the system, you don't need this chapter — the UI and APIs handle all of this.

---

## Technical reference

All tables use `utf8mb4` / `utf8mb4_general_ci`, at both table and column level. That uniformity is load-bearing, not cosmetic — see pitfall 7 below and [`ref/SCHEMA_CONVENTIONS.md`](../../ref/SCHEMA_CONVENTIONS.md) before you write a `CREATE TABLE`.

### Tables in scope

| Table | Owner | Chapter |
|---|---|---|
| `workflows` | Workflow Engine | 2 |
| `workflow_steps` | Workflow Engine | 2 |
| `workflow_versions` | Workflow Engine | 16 |
| `workflow_executions` | Workflow Engine | 2 |
| `workflow_execution_steps` | Workflow Engine | 2 |
| `sequence_template_types` | Sequence Engine | 3 |
| `sequence_templates` | Sequence Engine | 3 |
| `sequence_steps` | Sequence Engine | 3 |
| `sequence_template_versions` | Sequence Engine | 16 |
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
| `trigger_rules` | Trigger System | 15 |
| `trigger_rule_actions` | Trigger System | 15 |
| `trigger_executions` | Trigger System | 15 |
| `trigger_execution_rules` | Trigger System | 15 |
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
current_version          int             -- published version; 0 = never published (ch. 16)
draft_version            int NULL        -- unpublished draft, NULL = no pending changes
```

#### `workflow_versions` — version metadata (ch. 16)

```sql
PRIMARY KEY (workflow_id, version)   -- composite; there is NO surrogate id column
workflow_id   int          FK → workflows
version       int
name          text         -- snapshot at publish (audit)
description   text
test_input    json
published_at  datetime NULL  -- NULL = draft
published_by  varchar(100)
retired_at    datetime NULL  -- set by discard (retire-in-place; step rows kept)
created_at    datetime
```

Every published version has a row (v1 backfilled 2026-08-18); drafts get a stub row with `published_at NULL` from `ensureDraft`. `workflow_steps.version` scopes step rows per version — **every query against `workflow_steps` needs a `version` predicate** (Cookbook §5.34).

#### `workflow_steps` — ordered steps

```sql
id            int        PK
workflow_id   int        FK → workflows(id)        ON DELETE CASCADE
version       int                                  -- ch. 16; UNIQUE (workflow_id, version, step_number)
step_number   int
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

#### `sequence_template_types` — per-type cascade configuration

```sql
type             varchar(50)   PK              -- snake_case identifier, immutable PK
priority_fields  json          NOT NULL        -- ordered array of trigger_data keys, most-specific first
description      text                          -- human note
active           tinyint(1)    default 1       -- disable a whole type at once
created_at       datetime      default CURRENT_TIMESTAMP
updated_at       datetime      default CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
```

`priority_fields` example: `["appt_type", "appt_with", "case_type"]`. The ordering is the cascade priority — earlier fields dominate later ones via `2^(N-1-i)` weighting at enrollment-time scoring (see chapter 3 / cookbook §3.5). Empty array is valid (no cascade; lowest id wins).

CRUD via `/api/sequence-types`. Edited in-page via the **Manage Types** button on the Sequences tab.

#### `sequence_templates` — template

```sql
id           int unsigned   PK
name         varchar(100)
type         varchar(50)                 -- e.g. "no_show", "lead_drip"; nullable (ID-only templates)
                                          -- soft reference to sequence_template_types.type (no FK)
filters      json                        -- cascade filter values; keys must be subset of the type's
                                          -- priority_fields. NULL = generic fallback (every slot wildcard).
condition    json                        -- LEGACY (ch. 16): write-once at create; versioned truth is
                                          -- sequence_template_versions.template_condition
description  text
active       tinyint(1)     default 1
created_at, updated_at
test_input   json                        -- saved test payload
current_version  int                     -- published version; 0 = never published (ch. 16)
draft_version    int NULL                -- unpublished draft, NULL = no pending changes
```

Indexes: `idx_type (type)`, `idx_active (active)`. No FK from `type` to `sequence_template_types.type` — the reference is app-enforced (validated at template save and at enrollment time). The `type` column is nullable to support ID-only templates, which don't fit a hard FK.

`filters` JSON shape: `{ "<priority_field>": <value>, ... }` — for example `{"appt_type": "341 Meeting", "appt_with": 2}`. Keys absent or set to `null` are wildcards. Validation at template save (`validateTemplateFilters`) rejects keys not in the type's `priority_fields`.

#### `sequence_template_versions` — version metadata (ch. 16)

```sql
PRIMARY KEY (template_id, version)   -- composite; there is NO surrogate id column
template_id         int        FK → sequence_templates
version             int
name, type          --         snapshot at publish (audit)
template_condition  json       -- THE versioned template condition (executeStep reads
                               -- the enrollment-pinned version's row)
description, test_input
published_at        datetime NULL  -- NULL = draft
published_by        varchar(100)
retired_at          datetime NULL  -- discard = retire-in-place
created_at          datetime
```

#### `sequence_steps` — ordered steps

```sql
id             int unsigned   PK
template_id    int unsigned   FK → sequence_templates(id)  ON DELETE CASCADE
version        int                                          -- ch. 16; UNIQUE (template_id, version, step_number)
step_number    int
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
appt_id         int                              -- nullable; back-pointer for appt-scoped types
                                                  -- (pre_appt, iss_intake, no_show). Populated at
                                                  -- INSERT from trigger_data.appt_id. NULL for
                                                  -- contact-scoped enrollments.
trigger_data    json                              -- frozen at enrollment time
status          enum('active','completed','cancelled')  default 'active'
current_step    int unsigned     default 1
total_steps     int unsigned     default 0       -- snapshot of steps.length at enrollment
cancel_reason   varchar(200)
enrolled_at     datetime
completed_at    datetime
updated_at      datetime
```

Indexes: `idx_contact_status (contact_id, status)`, `idx_template_status (template_id, status)`, `idx_status`, `idx_appt_id_status (appt_id, status)`.

The `appt_id` column is the indexed lookup key for `sequenceEngine.cancelByApptId` — see chapter 3. The duplicate-enrollment guard in `_enrollWithTemplate` is keyed on `(contact_id, template_id, appt_id)` via the NULL-safe `<=>` operator, so two appts for the same contact can share a template type while one contact can't accidentally double-enroll under the same appt.

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

### Trigger System tables

#### `trigger_rules`

```sql
id               int unsigned   PK
event_type       varchar(64)    NOT NULL   -- must exist in triggerService.EVENT_TYPES
name             varchar(255)   NOT NULL
description      text
active           tinyint(1)     default 1
position         int            default 0  -- order within one event type
min_interval_s   int            NOT NULL default 0  -- cooldown seconds; 0 = no throttle
match_mode       enum('conditions','code')            default 'conditions'
match_config     json                      -- NULL on conditions mode = NON-match, not match-all
transform_mode   enum('passthrough','mapper','code')  default 'passthrough'
transform_config json
match_count      int            default 0  -- bumped once per matching event
last_matched_at  datetime                  -- also the cooldown reference point
error_count      int            default 0  -- bumped per event where this rule's actions/transform failed
last_error_at    datetime
last_modified_by int
created_at, updated_at
```

Index: `idx_event_active (event_type, active, position)` — the engine's only rule lookup.

#### `trigger_rule_actions`

```sql
id          int unsigned  PK
rule_id     int unsigned  NOT NULL   -- FK trigger_rules ON DELETE CASCADE
name        varchar(100)
position    int           default 0  -- dispatch order within the rule
active      tinyint(1)    default 1  -- inactive actions are kept but skipped
action_type enum('workflow','sequence','internal_function','http','hook')
config      json          NOT NULL   -- shape depends on action_type; validated at WRITE time
```

Index: `idx_rule (rule_id, active, position)`.

#### `trigger_executions` — one row per processed event

```sql
id            bigint unsigned  PK
event_type    varchar(64)  NOT NULL
contact_id    int                       -- promoted from the envelope for filtering
case_id       varchar(50)               -- ditto
depth         tinyint      default 0    -- trigger-chain depth
status        enum('matched','partial','no_match','no_rules','depth_capped','error')
rules_matched int          default 0
outcomes      json                      -- { matched_rule_ids, action_outcomes[], warnings[] }
envelope      json                      -- the full event; doubles as the UI's sample stock
error         text                      -- summary, capped at 500 chars
created_at    datetime
```

Indexes: `idx_type_time (event_type, created_at)`, `idx_case`, `idx_contact`, `idx_created`, `idx_status_id (status, id)`, `idx_event_id (event_type, id)`.

The row is inserted **before** actions dispatch and finalized after (so a mid-dispatch crash still leaves evidence the event was seen). `envelope` is written on every status including `no_match` — that's what the authoring UI's sample panel reads. `no_rules` rows are capped at 20 per event type per 7 days so unconsumed events don't cost a JSON insert per mutation forever.

#### `trigger_execution_rules` — one row per matched rule per execution

```sql
id           bigint unsigned  PK
execution_id bigint unsigned  NOT NULL   -- FK trigger_executions ON DELETE CASCADE
rule_id      int unsigned     NOT NULL   -- NO FK, deliberately (see below)
rule_name    varchar(255)     NOT NULL   -- denormalized survivor
action_count int              default 0  -- outcomes dispatched for this rule
failed_count int              default 0  -- non-success outcomes; a failed transform = 0/1
created_at   datetime
```

Indexes: `idx_rule_time (rule_id, id)`, `idx_execution (execution_id)`.

**No FK to `trigger_rules`** — these rows must outlive the rule they describe, which is also why `rule_name` is denormalized at write time and sized to match `trigger_rules.name` exactly (sql_mode has no `STRICT_TRANS_TABLES`, so a narrower column would truncate a long name silently). The FK to `trigger_executions` **is** present with `ON DELETE CASCADE`, so the retention sweep stays a single batched DELETE and orphans are structurally impossible.

Only *matched* rules get a row. Non-matching and cooldown-suppressed rules produce none — they weren't runs.

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

Used by automations to read system-wide values like `sms_default_from`, `email_default_from`, `default_task_assignee`. Not to be confused with the `settings` table (legacy, also exists).

The `appt_reminder_workflow_id` key was retired in May 2026 when the appointment reminder system moved from a single 31-step workflow to the `pre_appt` + `iss_intake` sequence pair — see chapter 3.

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

trigger_rules ────────► trigger_rule_actions      (CASCADE)
trigger_executions ───► trigger_execution_rules   (CASCADE — retention rides this)
trigger_execution_rules.rule_id  -- soft-linked, NO FK
                                 -- (audit must outlive the rule; rule_name denormalized)
```

The hook + email-router log tables and `job_results` are intentionally **soft-linked** so deleting a parent row doesn't cascade through the audit tables. This keeps a permanent record of what happened even if you delete the underlying hook / route / job.

---

### Common pitfalls

1. **`scheduled_jobs.type` is a 5-value enum, not 8.** Older docs conflate it with `data.type`. See chapter 4.
2. **`phone_lines.provider` is `('ringcentral','quo')`** — only two values. The AI context document is wrong on this.
3. **`appt_status` and `campaigns.status` use `'canceled'` (one L)** — not `'cancelled'` (two Ls). `sequence_enrollments.status` and `workflow_executions.status` use `'cancelled'` (two Ls). Inconsistent across the schema; don't typo.
4. **`cases.case_id` is varchar** (8 opaque chars — new ids uppercase Base32 like `"7XK4MQ2R"`, legacy ids mixed-case base64url like `"uT7EU36v"`) — not an int. Workflow `init_data.case_id` and sequence `trigger_data.case_id` should be string.
5. **`users.user` is the PK** of the users table — not `users.user_id` or `users.id`. `req.auth.userId` is the property name on the auth context.
6. **Two `condition` columns are reserved-word in MySQL** — `sequence_templates.condition` and `sequence_steps.condition`. Always backtick-quote them in raw SQL: `\`condition\``.
7. **Never write `DEFAULT CHARSET=utf8mb4` without `COLLATE=utf8mb4_general_ci`.** It does *not* inherit the schema default — it falls back to the charset default, `utf8mb4_0900_ai_ci` on MySQL 8. Omitting the whole clause is correct; writing half of it breaks the table. The damage is that MySQL refuses `column = column` across collations, so the new table can never be joined to `cases`, `contacts`, or anything else keyed on a varchar — `JOIN cases c ON c.case_id = t.case_id` fails with ER_CANT_AGGREGATE_2COLLATIONS. It hides for months because `WHERE case_id = ?` never errors (a bound literal adopts the column's collation); only column-to-column joins fail, so it surfaces on the day someone writes the first report across the table. 26 of 129 tables were created this way before it was caught. `tests/schemaConventions.test.js` now lints `ref/database.sql` for it in CI — run `npm run db:ref` after adding a table.
8. **`sql_mode` has no `STRICT_TRANS_TABLES`.** Over-length writes truncate silently and implicit NOT-NULL defaults are accepted rather than rejected — the database will not catch bad data for you. Size columns to match what actually writes into them and validate in application code. Don't enable strict mode without first giving affected columns real defaults; as-is it would break case creation and `listCases`.