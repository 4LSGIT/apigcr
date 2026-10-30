# Text opt-outs (STOP and START)

When a client texts **STOP** to any firm line, YisraCase records that they
opted out of **all** texts from the firm — automated reminders included — and
tells a staff member to reach them another way. This chapter is the staff
side: what happens on its own, which words count, the two tasks you may get,
and how a client comes back. The per-number checkbox itself is described in
[Contacts](02-contacts.md) (phones: **SMS opted out**).

## What happens on its own

| The client texts | What YisraCase does |
|---|---|
| **STOP**, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPTOUT — the whole message, any capitals or punctuation | Records an opt-out for that **number** (every contact holding it), effective for every firm line. Automated texts to it stop at once; staff sending a text by hand are asked to confirm first. |
| **START** or **UNSTOP** — and on RingCentral lines also SUBSCRIBE, RESUME, CONTINUE | If the number is currently opted out: records that they opted back in, and texts can go again. If it isn't opted out, it's an ordinary reply and nothing changes. |
| Something that sounds like a request to stop ("please stop texting me", "remove me", "wrong number", "STOP PLEASE") | Nothing is recorded — a person decides. A **review task** is opened (below). |

Only the exact keyword counts: "STOP" opts out, "stop by tomorrow?" does not.
Every change is kept with its proof — the message, the line it came in on and
when — so the firm can show who opted out and how.

**The phone companies block too.** RingCentral blocks texts from the line that
received the STOP to that number; Quo blocks the number on **every** Quo line.
Each sends its own "you've been unsubscribed" reply for every word in the
table above — Quo for REVOKE and OPT OUT too, although its documentation
doesn't list them (seen live 2026-10-30). YisraCase never sends a second
confirmation.

They lift their blocks differently. Quo lifts its block only when the person
texts **START**. RingCentral lifts it as soon as the person texts that line
again — any text, even "hi". YisraCase does neither on a "hi": a client stays
opted out here until they text START (or UNSTOP), or until you untick the
box.

YisraCase also learns about opt-outs it never saw as a text: when RingCentral
refuses one of our texts because the person opted out, that refusal is
recorded as an opt-out too. A nightly reconcile against RingCentral's own
opt-out list can be turned on as well (IT — see below).

## The two tasks you may get

Both go to the staff member set as **Consent follow-up assignee** (Config →
Firm → Marketing email & consent — the same person who gets unsubscribe-page
notes). If nobody is set, or that person is no longer an active user, no task
is created — the opt-out itself is still recorded and IT gets an alert once a
day.

- **Client opted out of texts — reach by phone/email.** Opened when a contact
  with an open case (as Primary or Secondary) opts out. Texts to them have
  stopped, so anything that relied on a text reminder needs a call or an
  email. Opened once per opt-out — the same opt-out seen again (the provider's
  refusal of a later text, the nightly list) does not open another.
- **Possible text opt-out — review.** Opened for a message that sounds like a
  request to stop but isn't a keyword. Read it. If it is an opt-out, open the
  contact, tick **SMS opted out** on that number and save. The law gives the
  firm 10 business days; the task is due in three. While one review task is
  open for a number, further messages from that number don't open another.
  (A "Possible text opt-in — review" task means someone who is opted out
  texted RESUME or similar to a Quo line: Quo keeps blocking them until they
  text **START**, so ask them to.)

## How a client comes back

- They text **START** (or UNSTOP) to a firm line. That also lifts the phone
  company's block on that line.
- Or, after they agree on a call or in an email, a staff member unticks **SMS
  opted out** on their number. That is recorded as your decision. Quo may
  still block until they text START themselves (RingCentral, until they text
  that line again).
- A client who opted out and later texts something else ("hi", a question)
  is still opted out here: automated texts stay off, and a text you send by
  hand asks you to confirm first. Ask them, and untick the box if they agree.

## For IT

- Inbound texts reach YisraCase only through the RingCentral and Quo webhooks
  (workflows 17 and 18). `node scripts/yisramailP2CheckInbound.js` checks that
  wiring and prints GO / NO-GO (it reads only).
- The nightly **SMS Consent Sync** recurring job (08:20 UTC; Scheduled Jobs)
  runs `sms_consent_sync`. The function is hidden from the job editor's
  picker, so the row was created from the SU console
  (`ref/migrations/2026-10-30_yisramail_p2_sms_consent_sync_job.sql`). It runs the
  RingCentral opt-out reconcile (off unless `sms_rc_consent_sync_enabled` is
  `1`; `dry_run: true` shows what it would record) and an alert when a phone
  provider has sent no inbound text for `sms_inbound_liveness_hours` (default
  72) — a silent webhook would mean STOPs are being missed.
- Design and rules: `ref/YISRAMAIL_DESIGN.md` §4.6.
