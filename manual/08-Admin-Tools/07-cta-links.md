# CTA Links (SU)

A CTA ("call to action") is a tokenized link you mint that runs a
**pre-authorized set of actions** when the recipient clicks a button and
confirms. You decide the actions at mint time; the recipient only picks an
option. Think of it as a decision link (`/d/…`) that doesn't need a workflow
waiting on the other end — and that can optionally be reused.

**Where:** **Admin → CTA Links (SU)** — list, inspect, extend, disable,
mint and send (below). The same API (`/api/cta`, SU only) stays available to
a Claude session that composes the email around the mint. The links
themselves live at `4lsg.com/c/<token>`, on the public landing host like
`/d/` and `/t/`.

## What a CTA can do

Each option on the link carries a **plan**: a sequence of the same internal
functions workflows use (`advance_stage`, `create_task`, `send_email`,
`start_workflow`, `update_case`, …). Plans are frozen when you mint — a click
can never change *what* happens, only *whether* it happens. Control-flow and
plumbing functions are excluded, and anything the plan produces is logged per
click under the link's executions.

A live example: the spam alert RG receives for a website hit the AI gate
rejected carries a **"Not spam — re-run intake"** button. Its plan re-runs
workflow 27 with the original submission plus an override flag, so the lead
is created as if the gate had passed it.

## Once vs. repeatable

- **once** (default): first confirmed click wins, atomically — a second
  click shows "already used". If nobody clicks by the expiry, an optional
  `timeout_option` runs automatically.
- **repeatable**: every click runs the plan, until the expiry or an optional
  `max_uses` cap. Use this for standing actions ("run the resync") or, with
  a `result_template`, for live lookup links ("show this contact's current
  email") you can hand to someone — or to an AI session — without an account.

## Protection levels

- **none** — anyone holding the link can execute. Fine for low-stakes
  actions sent to known recipients.
- **password** — the confirm page asks for a secret. By default the mint
  **generates** one (shown exactly once, in the mint response — copy it then)
  and links that return information default to this level. This is never a
  YisraCase account password; don't reuse one.

Attempts are rate-limited and counted; a brute-force burst records an alert
but deliberately never kills the link.

## Lifecycle

Links always expire (default 3 days for once, 30 for repeatable). You don't
re-mint when one lapses: `PATCH /api/cta/:id` extends the expiry, raises
`max_uses`, disables (kill switch) or re-enables. Re-enabling a used link
whose plan failed re-runs the **whole** plan on the next click — check its
executions first. `cancelled` is permanent.

## Reading results

`GET /api/cta` lists links with use counts; `GET /api/cta/:id/executions`
shows every click — who/when/via which surface, and the full per-step plan
output. That detail is deliberately **SU-only**: the public pages and the
JSON surface return only success/failure (plus the curated `result_template`
text, when the option defines one).

## Clicker inputs (new)

An option can declare **inputs** the clicker fills in before confirming — a
phone number, a message, a choice from a list. You name the field, its type
and limits at mint; the server validates and (for anything landing in an
email body) escapes what the clicker typed, and every execution records the
submitted values. Risky shapes ask you to acknowledge them at mint
(reusable link with an open recipient; raw-HTML input), and a reusable link
with an open recipient always needs a use cap. **For now inputs are minted
via the API only** — the pane's builder support (S2i) is next.

## Minting from a workflow

Workflows mint CTAs with the `create_cta` function (that's how the RG button
is made). Workflow mints can't use password protection — the generated
secret would end up in step output.

## The pane

Like every SU tool it asks for your password first (elevation, 15 minutes).

- **List** — every link with its status, uses, expiry (firm time), runs and
  source (SU or workflow + execution id). *expired* and *exhausted* are
  derived from the expiry and the use cap — the filter handles them, but
  search and those two filters only cover the links loaded so far (200 per
  page, **Load more** for the rest).
- **Detail** — click a row: the full record, each option's confirm URL with a
  copy button and its plan (function names), then every execution; click one
  to see each step's output or error. Actions: **Extend / limits** (new expiry
  — typed in firm time, or +1/+7/+30 days — and the max-uses cap),
  **Disable**, **Re-enable** (offered only when the server would allow it),
  **Cancel** (permanent), **Duplicate** and, on an active link, **Send…**.
  Refusals come back in the server's own words. An active link also has an
  **Email** block — the receipt's **Copy email** / **Copy buttons** / copy
  text / HTML source and a preview — so the email is never lost with the
  receipt. It is the *default* email, rebuilt from the link each time you
  open it (an extended link's email shows the new expiry); a custom template
  used at mint isn't stored, so for that wording paste **Copy buttons** into
  your own message.
- **Duplicate** (list row or detail) — opens the builder pre-filled from that
  link, named "… (copy)", for changing and minting a new one. Not carried
  over: the expiry (the firm default is selected), the email template (never
  stored) and the password (a new one is generated). A copy of a
  workflow-minted link is an ordinary SU mint.
- **+ New CTA** — the mint builder: every mint field, options with ordered
  plan steps (`fn` + params JSON; the picker lists the eligible functions),
  and — for single-use links, under the options — which option to run on its
  own if nobody clicks before expiry.
  **Preview (dry run)** validates everything, shows the default protection
  the server would apply, the placeholder URLs and the rendered email — and
  creates nothing. **Mint** shows the receipt: token, URLs, a generated
  password **once** (the pane asks before you leave it uncopied), **Send…**
  (below), and **Copy email** / **Copy buttons**. Those put two versions on
  the clipboard: the formatted email, which pastes as-is into a Gmail or
  Outlook message, and a plain one with one "Label: URL" line per option,
  for wherever the paste comes out as plain text. **copy text** copies only
  the plain one, and the raw HTML source is one click away for templates and
  workflows. If a paste into Gmail comes out plain, the formatted version
  was refused at the paste end: Gmail's *Plain text mode* (⋮ in the compose
  window; Gmail keeps it on for later messages), a paste with
  Ctrl+Shift+V / Cmd+Shift+V, or a clipboard tool or remote-desktop session
  that passes only text. **Send…** sidesteps all of that.
- **Send…** (receipt, an **active** link's detail, or its list row — on
  small phones the row buttons hide, so open the link) — emails or texts
  the link from YisraCase. Pick Email or SMS, the recipient, and the sender
  (blank = the firm default: `email_automations` for email, the staff line
  for SMS — the same senders decision requests use). Email: optional subject
  (default "Action requested: <prompt>"; the link tokens work in it) and the
  default CTA email or your own HTML with the same tokens — from the receipt
  the mint's custom template is pre-filled; it's never stored, so a later
  send from the detail starts from the default. SMS: the message box starts
  as the default — the prompt and the link to the page — and is yours to
  edit, as long as it keeps a link (`[[cta_url]]`, or `[[respond_url:VALUE]]`
  for one option's confirm page) and stays within 1000 characters once the
  links are filled in. **Reset to default** puts the default back; the text
  is never stored.
  **Preview** shows exactly what would go out and sends nothing. A password
  is **never** sent; give it to the recipient another way. Only active links
  can be sent (used, disabled, cancelled, expired or exhausted → refused).
  When the link is attached to a case or contact, the send is logged there
  (an email row, or a note for an SMS — the SMS row itself arrives from the
  phone provider), and every send is in the admin audit log.

Design + internals: `ref/CTA_DESIGN.md`.
