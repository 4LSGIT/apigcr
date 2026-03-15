# Part 1 — Overview (Non-Technical)

## What Is a Workflow?

A workflow is an automated sequence of actions that runs when something happens — a new contact is created, an appointment is booked, a form is submitted, etc. Instead of manually sending follow-up emails, creating tasks, or making calls, a workflow does it automatically, in order, on a schedule.

Each workflow is made up of **steps**. Each step does one thing: send a message, look something up, wait a while, make a decision. The engine runs through the steps one by one, passing information forward as it goes.

---

## A Simple Example

Here is a 5-step workflow that runs when a new contact comes in:

```
Step 1 — Load the contact's name, email, and phone from the database
Step 2 — Send a welcome email to the contact
Step 3 — Wait 5 minutes
Step 4 — Send a follow-up SMS to the contact
Step 5 — Email the IT team with a summary
```

This runs automatically, every time, for every contact — without anyone doing anything manually.

---

## How Workflows Are Triggered

A workflow is started by calling an API endpoint from anywhere in the application:

```js
await apiSend("/workflows/1/start", "POST", {
  contactId: 123,
  contactName: "Fred Smith",
  source: "web"
});
```

Anything you pass in the body is available to every step in the workflow as a variable. So `{{contactId}}`, `{{contactName}}`, and `{{source}}` can all be used in step configs, email bodies, SMS messages, etc.

---

## What Kinds of Steps Exist?

There are three kinds of steps:

**Webhook** — calls an external URL (any third-party API, Zapier, webhook.site, etc.)

**Internal Function** — runs a built-in action like sending an SMS, looking up a contact, waiting a set time, or making a branching decision. This is what most steps use.

**Custom Code** — runs a small JavaScript snippet for one-off logic. Useful for data transformation.

---

## How Does Branching Work?

Sometimes you need a workflow to take different paths. For example: if the contact already has an appointment, go to step 8; otherwise go to step 4.

This is done with the `evaluate_condition` function. You tell it what variable to check, what to compare it to, and which step to go to for each outcome:

```
If appt_status == "confirmed" → go to step 8
Otherwise → go to step 4
```

You can also jump unconditionally with `set_next`, which simply tells the engine "go to step N next" regardless of any condition.

---

## How Do Delays Work?

A step can pause the workflow for a set amount of time and then resume automatically. For example:

- `wait_for "5m"` — resume in 5 minutes
- `wait_for "24h"` — resume in 24 hours
- `wait_until_time "09:00" "America/Detroit"` — resume at 9am Detroit time

While the workflow is waiting, its status shows as `delayed`. When the time comes, the job processor automatically resumes it.

---

## What Happens If a Step Fails?

Each step has an **error policy** that tells the engine what to do if that step fails:

- **ignore** — log the failure and continue to the next step (default)
- **abort** — stop the entire workflow immediately
- **retry then ignore** — try again up to N times, then continue
- **retry then abort** — try again up to N times, then stop

See [05-error-policies.md](05-error-policies.md) for full details.

---

## How Do I Check on a Running Workflow?

```
GET /executions/:id           — current status, variables, step position
GET /executions/:id?history=true  — full step-by-step history with outputs
GET /executions              — list all executions (filterable by status, workflow)
```

You can also cancel a running workflow:

```
POST /executions/:id/cancel
```

---

## Worked Example — Contact Intake Sequence

This is the canonical test workflow. It is triggered with:

```js
await apiSend("/workflows/1/start", "POST", { contactId: 123 });
```

| Step | Type | What It Does |
|------|------|--------------|
| 1 | `lookup_contact` | Fetches contact row; maps email, phone, name into variables |
| 2 | `send_email` | Sends welcome email to contact from `stuart@4lsg.com` |
| 3 | `wait_for` | Pauses 5 minutes |
| 4 | `send_sms` | Sends follow-up SMS from `2485592400` |
| 5 | `send_email` | Notifies `it@4lsg.com` with contact data and execution ID |

Variables flow forward automatically — the email in step 2 uses `{{contact_email}}` that was set in step 1, and step 5 uses `{{env.executionId}}` which the engine provides automatically.
