# 9 — Support Inbox (Issue Reports)

## For operators

The **Help & Support** button near the bottom of the sidebar. One textarea, one
send. It captures the technical state of what you were looking at automatically,
so you don't have to describe it.

It exists for *"this just broke and I don't know how to explain it"* — the
report that otherwise never gets filed.

Admins read them at **More → Support Inbox**, which shows unresolved reports by
default and lets them resolve, reopen, or **respond to the sender**.

### Casey reports

A fourth kind, **Casey**, comes from the flag under a Casey answer (or from Casey itself, when it is stuck): the report names the chat and the message. Its detail row carries **Open chat N at message M**, which opens the conversation in Admin → Casey Chats (superuser, with the step-up). Read it there, fix the cause (a Casey Note, or the app), then respond from here as for any report; the outcomes for this kind are Fixed with a Casey Note, Fixed in the app, Casey was right, and Other. The note may be empty — the flag alone was the report.

### Responding to the sender

Expand a report and press **Respond to sender**. Pick an outcome, add a message
if you like, and press **Send reply**. The person who filed it gets an email
**from IT** (the `email_it` setting), so they can simply reply to it. The email
holds:

1. the outcome's standard text,
2. your message, if you wrote one,
3. their own report, quoted back with its number and date.

**Resolve the report** is ticked by default. Untick it to reply but keep the
report open. A report that is already resolved can still be answered: a
follow-up, or a retry. Who resolved it, and when, stay as they were.

The outcomes depend on what kind of report it is:

| Kind | Outcomes |
|---|---|
| Problem | Fixed · Can't reproduce · Working as designed · Already implemented · Other |
| Idea | Done · Added to the list · Already implemented · Won't do · Other |
| Question | Answered |

**Other** and **Answered** have no standard text. Your message *is* the reply,
so they need one. The dialog shows the standard text before you send.

To resolve **without** telling anyone, use the plain **Resolve** button. It sends
nothing.

If the reply fails to send, the dialog says so and **nothing else changes**:
- a resolve you asked for is not applied;
- an earlier reply's record stays;
- the row shows **↩✗** until a reply does go out.

A sent reply shows as **↩** next to the status.

While a reply is sending, the dialog can't be closed. A second Send on the same
report is refused while one is still sending, and for 30 seconds after one went
out, so a double click, or the email's button pressed twice, sends one email.

The filer needs an email address on their user record. Without one, **Send
reply** is disabled and the dialog says why.

### From the email

The email IT gets for each report has one **Reply: …** button per outcome, plus
**Open in Support Inbox**. Each button opens YisraCase (you must be signed in as
a super-user) with that report expanded and the reply dialog open on that
outcome. A report beyond the newest page of the list isn't expanded behind the
dialog, but the dialog still opens. **Nothing is sent from the email itself.** You still press **Send
reply** in the app. These are ordinary links into the app, not one-click CTA
links.

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
routes/api.issueReports.js         The routes + the IT notification email
services/issueReportService.js     Reply outcomes, the reply email, respond()
public/issueReports.html           Admin list + the Respond dialog
scripts/supportReplyColumns.js     Migration: the five reply columns
```

### API

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/issue-reports` | POST | any authed staff | File a report |
| `/api/issue-reports` | GET | admin | List — unresolved by default |
| `/api/issue-reports/resolve` | POST | admin | Bulk resolve / reopen `{ids, resolved}` — sends nothing |
| `/api/issue-reports/:id` | GET | admin | Full row (with context) + `outcomes` for its kind + `reply_to` (the filer's address, or null) |
| `/api/issue-reports/:id/respond` | POST | admin | `{outcome, message?, resolve?}` — reply to the filer |

Admin means a super-user (the `su` role).

### The email is awaited, not detached

`api.featureRequests.js` fires its notification from a floating async IIFE after
`res.json()`. **That pattern is unreliable on Cloud Run**: with request-based
billing the instance's CPU is throttled once the response flushes, so
post-response work can stall indefinitely or never run.

Here the send is awaited and its outcome is returned to the caller, which is
what lets the dialog be honest about whether the email went out.

*(The same reasoning drove split-phase dispatch in the trigger system — see
[YisraFlow chapter 15](../03-YisraFlow/15-triggers.md).)*

### Respond: claim, send, settle

`issueReportService.respond()` runs in this order:

1. **Claim.** One guarded UPDATE stamps `reply_claimed_at`, and nothing else.
   It is refused (**409**) when:
   - another send still holds the claim (a send can take minutes, so a time
     window alone can't cover it), or
   - a reply went out in the last 30 s.

   A claim older than 15 minutes counts as abandoned (an instance died
   mid-send) and can be taken over.
2. **Send.** The email goes from `email_it` to the filer's `users.email`, read
   at send time.
3. **Settle.** Guarded on *this* call's claim stamp, so a call whose claim was
   taken over writes nothing.
   - **Success** writes `resolution`, `reply_message` and `replied_at`, clears
     `reply_error`, and resolves the report when asked.
   - **Failure** writes only `reply_error` and answers `200 {ok:false,
     reply_error}`.

   Nothing is written before the send and nothing is rolled back after it.

Other refusals:
- **400**: the outcome doesn't belong to the report's kind, a required
  message is missing, or the message is over 2000 characters.
- **422**: the filer has no email, or no `email_it` setting is configured.

The notification's buttons are deep links:
`?open=tabPanel~adminSupportInbox~r<id>~<outcome>`. The pane reads that rest
(`ycSubTab`), widens the list to every status, expands the report, and opens
the dialog on that outcome. The list shows the newest page only, so an older
report isn't expanded behind the dialog. The pane then clears the rest, so a
reload doesn't reopen the dialog.

### Trust

`context` is client-supplied. It is size-capped before insert and every value is
HTML-escaped on the way into the email. Nothing in it is ever interpreted, only
displayed.

### Settings

`email_automations` and `email_it` are read **per call** rather than at module
load, so live edits apply without a redeploy — the same convention as feature
requests.
