# 4LSG Workflow Engine — Manual

This manual covers the workflow automation engine and standalone job scheduler built into the 4LSG API.

Served via `GET /manuals/:section` — each section renders as a styled HTML page suitable for iframes.

---

## Contents

| Section | File | Audience |
|---------|------|----------|
| 1 | [01-overview.md](01-overview.md) | Non-technical — what workflows are and how to use them |
| 2 | [02-api-reference.md](02-api-reference.md) | All API endpoints for workflows, executions, and jobs |
| 3 | [03-internal-functions.md](03-internal-functions.md) | Every built-in function with params and config examples |
| 4 | [04-variables-templating.md](04-variables-templating.md) | The `{{variable}}` system, `this`, `env`, and `set_vars` |
| 5 | [05-error-policies.md](05-error-policies.md) | Retry strategies, backoff, and failure handling |
| 6 | [06-execution-lifecycle.md](06-execution-lifecycle.md) | Execution statuses, delays, recovery, and the job processor |
| 7 | [07-scheduled-jobs.md](07-scheduled-jobs.md) | Standalone scheduled and recurring jobs |

---

## Quick Start

```js
// 1. Create a workflow
POST /workflows/bulk  { name, steps: [...] }

// 2. Start it
POST /workflows/:id/start  { contactId: 123, ...any init data }

// 3. Check it
GET /executions/:id?history=true

// 4. Schedule a standalone job
POST /scheduled-jobs  { type: "one_time", job_type: "webhook", delay: "10m", url: "..." }
```

## Routes

```
GET /manuals              → this index
GET /manuals/overview     → Part 1
GET /manuals/api          → Part 2
GET /manuals/functions    → Part 3
GET /manuals/variables    → Part 4
GET /manuals/errors       → Part 5
GET /manuals/lifecycle    → Part 6
GET /manuals/jobs         → Part 7
```
