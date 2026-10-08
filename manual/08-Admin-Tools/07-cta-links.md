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

## Clicker inputs

An option can ask the clicker for values before its plan runs — a number to
text, a message, a choice from a list — and pass each value into a step. You
set it up in the builder; the server checks every value again on every click.

**In the builder** — each option has a **Clicker inputs** block:

- **+ Add input** (up to 10 per option, reorder with ↑/↓). Give it a
  **label** (what the clicker sees), a **name** (used in bindings; it
  follows the label until you edit it or bind it), a **type**, and whether
  it is **required**.
- **Types:** Text · Phone number (normalized to +1…) · Email address (one
  address, lowercased) · Number · Choice from a list (you list the choices;
  each is also the value passed on) · Date · HTML (raw markup — see the
  acknowledgments below).
- **Max length** (text, email, number, HTML — phone, date and choice
  lengths are fixed by the pane), an optional **Default** (pre-filled on the
  page, used when left blank) and an optional **Pattern**: a regular
  expression the whole value must match, after tidying (a phone as
  +1XXXXXXXXXX). Patterns run on a linear-time engine — no lookahead or
  backreferences, repeat counts up to 16 (write `\d{9}\d{8}`, not `\d{17}`,
  or `\d+` with a max length), at most 100 characters. A mismatch only tells
  the clicker "not in the expected format", so say the format in the label.
- **Bind to:** pick a step param and the pane writes `"[[input:name]]"`
  into that step's params as the param's whole value (typing it yourself
  works too). Only params a function opens to clicker input are offered;
  each step's description says which, in words — today `send_sms` (`to`,
  `message`), `send_email` (`to`, `subject`, `html`), `create_task`
  (`description`) and `create_log` (`message`). A recipient (`to`) only
  takes a matching Phone number or Email address input. Every input has to
  be bound — the line under **Bind to** says where it goes, or that it
  isn't bound yet.
- A **result template** can echo an input with `[[input:name]]`.

**Escaping.** Text a clicker types into an email body (`send_email.html`) is
escaped, line breaks kept — they write a message, not markup. Only an
HTML-type input passes through raw.

**Protection.** Inputs make the default **password**. Choosing *none* is
allowed — the builder notes that the choice is your acceptance.

**Use cap and acknowledgments.**

- A **repeatable** link where the clicker picks the **recipient** must have
  **Max uses** — the field turns required. It can be raised later, never
  removed (Extend / limits locks *No cap* on such a link).
- Two shapes need a tick before they mint. The box sits above **Preview** /
  **Mint** and spells out the risk: *the clicker picks who gets the message,
  on a reusable link* (whoever holds it can text or email anyone from the
  firm's line or address, once per use) and *the clicker writes raw HTML*.
  Your tick is recorded in the receipt and the audit log. A copy made with
  **Duplicate** asks again.
- A single-use link's timeout option can only be an option whose inputs all
  have defaults — at expiry nobody is there to fill them in.

**Test values (dry run only).** Under the form, each option's inputs appear
as its confirm page will show them. Type what a clicker might enter and
**Preview** runs a second check on the server with those values — type,
length, pattern, then every bound step with the values filled in — and shows
where each input goes (and how it is escaped) and the result text with them.
A refused value is flagged next to its field. Test values are never stored
or sent with the mint.

**Errors.** When the server rejects a preview or a mint, its message appears
under the field it is about, and in full below the buttons with **Show the
field**.

**Reading results.** The detail lists each option's inputs (type, limits,
default, pattern, where bound). Expand an execution to see its **submitted
inputs** — the values as the server stored them after tidying, labelled and
shown as text, never rendered. Like the plan output they are SU-only.

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
  copy button, its plan (function names) and its clicker inputs, then every
  execution; click one to see each step's output or error and the inputs
  the clicker submitted. Actions: **Extend / limits** (new expiry
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
  link, named "… (copy)", for changing and minting a new one. Clicker
  inputs and their bindings come along. Not carried over: the expiry (the
  firm default is selected), the email template (never stored), the
  password (a new one is generated) and any risk acknowledgment (tick it
  again). A copy of a workflow-minted link is an ordinary SU mint.
- **+ New CTA** — the mint builder: every mint field, options with ordered
  plan steps (`fn` + params JSON; the picker lists the eligible functions),
  clicker inputs (above), and — for single-use links, under the options —
  which option to run on its own if nobody clicks before expiry.
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
