# YisraFlow — Automation System

YisraFlow is the umbrella name for everything in YisraCase that *runs by itself*: it sends the SMS without you, fires the workflow when the appointment is booked, drips the follow-up over five days, retries the failed webhook, routes the inbound email to the right hook. This manual covers all of it.

There are five subsystems, all sharing one job queue and one heartbeat:

| Subsystem | What it does | When you reach for it |
|---|---|---|
| **Workflow Engine** | Multi-step processes with branching and data flow between steps | Anything that needs "if this, then that," variable passing, or auditable step-by-step history |
| **Sequence Engine** | Contact-tied drip series with auto-cancel | Follow-ups that should stop themselves when the reason no longer applies (no-show, intake reminder, post-call) |
| **Scheduled Jobs** | Single actions at a future time, or recurring on a cron | Daily digests, one-off future actions, recurring reports |
| **YisraHook** | Configurable inbound webhook receiver | Replacing per-integration custom routes — Calendly, JotForm, Stripe, etc. |
| **Email Router** | Routing layer in front of YisraHook for inbound email | Sending all firm email through one adapter and dispatching to different hooks based on subject/sender/etc. |

---

## Reading order

If you've never used the system before, read these in order:

| # | File | What's in it |
|---|------|----|
| 1 | [01-overview.md](01-overview.md) | The five subsystems explained, decision tree for picking one, how they share infrastructure |
| 2 | [02-workflows.md](02-workflows.md) | Workflow Engine — concepts, lifecycle, step types, branching, contact-tying |
| 3 | [03-sequences.md](03-sequences.md) | Sequence Engine — templates, enrollment, conditions, timing, all six step types |
| 4 | [04-scheduled-jobs.md](04-scheduled-jobs.md) | One-time and recurring jobs, the unified `scheduled_jobs` queue |
| 5 | [05-internal-functions.md](05-internal-functions.md) | All 23 built-in functions with params and examples |
| 6 | [06-variables-templating.md](06-variables-templating.md) | Workflow variables, the universal `{{table.column}}` resolver, `trigger_data`, modifiers |
| 7 | [07-calendar-service.md](07-calendar-service.md) | Jewish business calendar, timing types, holiday handling, randomization |
| 8 | [08-error-policies.md](08-error-policies.md) | Retry strategies and backoff |
| 9 | [09-yisrahook.md](09-yisrahook.md) | Webhook receiver — auth, filter, transform, four target types, capture mode |
| 10 | [10-email-router.md](10-email-router.md) | Inbound email routing layer in front of YisraHook |
| 11 | [11-api-reference.md](11-api-reference.md) | Every endpoint across all five subsystems |
| 12 | [12-database-schema.md](12-database-schema.md) | Every table, every column, every index |
| 13 | [13-cookbook.md](13-cookbook.md) | Patterns and pitfalls catalog. Practical answers to "I need X — which engine, what shape, what gotchas." |

Each chapter opens with a short **For operators** section — plain-English summary of what it does and how to use the UI — followed by **Technical reference** for everyone else.

---

## Companion documents

- **YISRACASE_AI_CONTEXT.md** — the broader system context (auth, services, conventions, pending work). Not engine-specific.
