# 9 — Support Inbox (Issue Reports)

## For operators

The **Help & Support** button at the bottom of the sidebar. One textarea, one
send. It captures the technical state of what you were looking at automatically,
so you don't have to describe it.

It exists for *"this just broke and I don't know how to explain it"* — the
report that otherwise never gets filed.

Admins read them at **More → Support Inbox**, which shows unresolved reports by
default and lets them resolve or reopen.

### How it differs from Feature Requests

Deliberately the opposite end of the spectrum:

| | Feature Requests | Support Inbox |
|---|---|---|
| Shape | You sit down and write a title and a description | One button, one textarea |
| Audience | Public board — everyone reads and votes | Admins only |
| Context | You supply it | Attached automatically |
| For | "We should build…" | "This just broke" |

**They don't share a table on purpose.** Half-formed panic notes must not land
on a board every member of staff can read and vote on.

### The dialog tells you the truth

When you hit send, the confirmation distinguishes *"sent"* from *"saved, but the
email didn't go out."* That costs about a second on a button press you're
already watching, and it means a report never silently fails to reach anyone.

---

## Technical reference

### Files

```
routes/api.issueReports.js   The whole surface
public/issueReports.html     Admin list
```

### API

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/issue-reports` | POST | any authed staff | File a report |
| `/api/issue-reports` | GET | admin | List — unresolved by default |
| `/api/issue-reports/:id` | PATCH | admin | Resolve / reopen |

Admin means `authorized - SU` or `authorized - admin`.

### The email is awaited, not detached

`api.featureRequests.js` fires its notification from a floating async IIFE after
`res.json()`. **That pattern is unreliable on Cloud Run**: with request-based
billing the instance's CPU is throttled once the response flushes, so
post-response work can stall indefinitely or never run.

Here the send is awaited and its outcome is returned to the caller, which is
what lets the dialog be honest about whether the email went out.

*(The same reasoning drove split-phase dispatch in the trigger system — see
[YisraFlow chapter 15](../03-YisraFlow/15-triggers.md).)*

### Trust

`context` is client-supplied. It is size-capped before insert and every value is
HTML-escaped on the way into the email. Nothing in it is ever interpreted, only
displayed.

### Settings

`email_automations` and `email_it` are read **per call** rather than at module
load, so live edits apply without a redeploy — the same convention as feature
requests.
