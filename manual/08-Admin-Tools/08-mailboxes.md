# Mailboxes (SU)

The email addresses YisraCase reads over IMAP — and, when a send credential is
attached, sends from — plus **who may use each one**. This is the foundation of
the comms hub (design: `ref/MAILBOX_SYSTEM_DESIGN.md`).

**Where:** Admin → **Mailboxes**. Adding and editing mailboxes is SU only and
asks for [elevation](README.md) like the other SU tools.

> **Polling, reading and sending are live (S1–S3).** Every active mailbox with
> **Ingest enabled** is read over IMAP every 5 minutes and stored in
> YisraCase; people with **Read** see it in **Comms**, people with **Send**
> write and reply from it there (both below).

## A mailbox is connection data

Each row holds only what a mail client would: the **address**, an IMAP
**host / port / login**, a **secret**, and optionally a **send credential** (a
Connections sender). Nothing about the provider is baked in, so moving a box
from one host to another is just editing the row.

- **Address** is stored lower-cased and must be unique. Its domain is derived
  from it.
- **Host** is the bare host name — no `https://`, no port.
- **Port** is the IMAP port: 993 (or 143). The sending ports (587, 465, 25,
  2525) are refused — with one there, every check, the folder listing and
  the copy to Sent fail.
- **Send credential**: none means the box is **read-only** in YisraCase. It
  must be an SMTP or Google sender — a Pabbly sender cannot send replies or
  Cc/Bcc, so Comms greys the box out. A **Google** sender must be the one
  for the box's own address: Google sends any other address under its own
  name, so Comms refuses that pairing too. The sender's name and signature are
  used only when the sender's own address is the box's; a shared domain
  sender sends as the box's bare address, without a signature.
- **Mailboxes are never deleted** — stored mail will reference them. Untick
  **Active** to retire one.

## Colour

Each mailbox has a **colour** that tells it apart in Comms — the stripe beside
its messages and the dot on its tag, the same for everyone. A new mailbox
starts on a **random colour no other box uses** (shown in the form before you
save — **Random** picks another, or choose your own). Change it any time:
click the round swatch beside the address in the list, or use the edit form.
Anyone who can **Manage** the box may change it, like its name.

- Any colour works. Where one would be hard to see — pale yellow on the light
  theme, navy on the dark one — Comms draws a deeper or brighter shade of the
  same colour on that theme; the form says so under the picker. Your choice
  itself is kept as picked.

## The secret is write-only

The IMAP password (or identity credential) is encrypted when saved and **never
shown again** — not in the list, not in the edit form, not in the audit log.
The table only says whether one is **set** or **missing**.

- Editing: leave the field **blank to keep** the stored secret; typing a value
  **replaces** it; **Clear the stored secret** removes it.
- **Changing the host or port requires re-entering the secret** in the same
  save. Otherwise an edit could point a stored password at a different server.

## Folders

Every folder listed is polled and **stored in full**. **Emit to rules**
additionally feeds that folder's **new** mail into the email-ingest rules
pipeline (court mail, case linking, the log). New mailboxes start with
`INBOX` emitting. Folder names are the server's exact names — Sent differs by
host (SiteGround: `INBOX.Sent`, Gmail: `[Gmail]/Sent Mail`) — normally added
without Emit to rules. A misspelt folder shows up as a polling error (below).
Untick **Ingest enabled** to stop polling a box entirely.

- **The first poll stores history but never emits it.** Mail already in a
  folder when YisraCase first reads it is stored (newest first, a few hundred
  messages per run, after new mail) but never fed to rules — replaying months
  of court or e-sign mail into rules would re-fire every one of them. Emit to
  rules means "mail that arrives from now on".
- **Store history** (ticked by default) decides whether that first poll
  stores the folder's existing mail at all. Untick it for very large folders
  (the firm's Google inbox holds over 60,000 messages — copying them would
  run into Gmail's daily download limit and swell the database): only mail
  arriving after the first read is stored. It is decided at that first read;
  ticking it later does not go back for the old mail.
- **Never tick Emit to rules on a box whose mail already reaches YisraCase
  another way** — for example a SiteGround address that forwards into the
  Google inbox the Apps Script ingest reads. The pipeline only recognises a
  repeat **within one source**, so every message would be logged twice and
  every rule would fire twice. Store-only (Emit unticked) is always safe.
- The same message in two YisraCase mailboxes (To: one, Cc: the other) is
  logged once; both stored copies link to that log entry.
- **Drafts are never copied** — not stored, not fed to rules — in any folder.
  They are unsent, and Gmail saves a new copy of a draft every few seconds
  while you type. The message you finally send is copied normally.
- **Google mailboxes: poll `[Gmail]/All Mail` and nothing else.** Google
  shows each label as its own folder, so the same email sits in several;
  All Mail holds every email once — received, sent, and whatever your filters
  file away under labels. Never list All Mail **together with** other
  folders: every labelled email would be stored twice (the superuser folder
  listing warns about it).

## Emitting as another source (the Google inbox)

A mailbox normally feeds rules as the `mailbox-imap` source, identified by
each message's Message-ID. The Google inbox is different: the older Apps
Script ingest already feeds the same mail as `gmail-firm`, identified by
Google's own message id. So that mailbox is switched to **emit as
`gmail-firm` (provider id)** — the same identity — and the two feeds land on
one log entry instead of two.

- The switch is a superuser **console** step from the pilot checklist
  (`ref/MAILBOX_GMAIL_PARITY.md`), not a form field, because it only becomes
  safe after a live check. The mailbox list shows it read-only:
  *emits as gmail-firm (provider id)*.
- A message that arrives without a Google id is **stored but not fed to
  rules**, and a warning is recorded — it is never fed under a different id.
- The Google inbox reads **All Mail only**, so its **sent** mail feeds rules
  and the log too — as the Apps Script ingest always did (replies to clients
  land on their timelines); firm-to-firm mail is skipped as usual.
- In the **Comms hub**, that mailbox reads like Gmail: its Inbox is what
  Google had in the Inbox when each email arrived, its sent mail is tagged
  **Sent**, and mail Google filed away or archived is tagged **Archived** and
  shows under **All folders** only (Google labels, below).
- To undo it, set both values back to empty in one save together with Emit
  to rules off on All Mail (the checklist has the exact call). Do **not** turn
  the `gmail-firm` source off: that also cuts off the Apps Script ingest.
- Superusers can list a mailbox's folders from the console
  (`GET /api/mailboxes/<id>/folders`): exact folder names, message counts,
  whether each configured folder exists, whether it is All Mail (with a
  warning when All Mail is listed alongside other folders), and whether the
  server hands out Google ids.

## Google labels

All Mail is one folder, so Comms tells a Google mailbox's Inbox, Sent and
archived mail apart by **Google's labels**, which YisraCase records with each
email when it is stored. They are a **snapshot**: archiving or re-labelling an
email in Gmail afterwards does not move it in Comms (a later slice keeps them
in sync). Other mailboxes go by their folders, as before.

Emails stored before labels were recorded (and any time you want them
refreshed) get them from the superuser console — one call per batch of up to
1,000, repeated until it says `done`:

```js
const ID = 2; // the Google mailbox
let after = 0, r = null;
do {
  try {
    r = await apiSend(`/api/mailboxes/${ID}/labels/snapshot`, 'POST', { after_uid: after, limit: 500 });
  } catch (e) {
    if (e.status === 409 && e.body && e.body.retry) { await new Promise((ok) => setTimeout(ok, 30000)); continue; }
    throw e; // anything else: stop and read it
  }
  console.log(r.scanned, 'checked,', r.updated, 'labelled', r.done ? '(done)' : '');
  after = r.next_after_uid;
} while (!r || !r.done);
```

It only reads labels from Google and writes them onto stored emails: nothing
is re-ingested, nothing reaches rules, the sync's bookmarks are untouched.
While the 5-minute sync is running it answers **409** and the loop above waits
and retries; a sync that starts during a call (a few seconds each) skips that
turn and the next one catches up. Only a folder the mailbox currently polls
can be labelled; on a non-Google mailbox it answers `labels_supported: false`
and changes nothing.

## Attachments

Attachments are **not copied** into YisraCase: the message's text and the
list of its attachments are stored, and an attachment is fetched from the
mail server when someone opens it (anyone with **Read** on the box).

- If the message was deleted on the server (webmail, Outlook), its
  attachments are gone from YisraCase too.
- PDFs and images open in the browser; anything else (including HTML and SVG
  attachments) downloads as a file.
- "This mailbox is re-syncing" means the server renumbered the folder (a host
  move does this). The next poll re-matches stored mail by Message-ID; try
  again in about five minutes.

## When polling fails

Each folder keeps its own record (`ingest_state` on the mailbox row): the
last error, and how many runs in a row have failed. The streak clears itself
on the next good run. One alert per streak, naming the box and folder:

- a folder that **feeds rules** (emit to rules on, under an active source):
  an **error** after **3 failed runs in a row** (about 15 minutes) — it emails
  IT, because while it fails its mail reaches no rule from YisraCase;
- a **store-only** folder, or the history backfill: a **warning** after **5**
  (about 25 minutes) — warnings ride the alert digest and do not email on
  their own.

Usual causes: a changed password (re-enter the secret), a misspelt folder, or
the mail server down. An `INCOMPLETE_FETCH` error is usually harmless: the
server answered a message with flag updates instead of its contents (someone
was reading it at that moment), nothing was stored, and the next run fetches
it again.

### Quarantined messages

A failure that belongs to ONE message — the ingest pipeline refusing it, or
the server never sending it — would hold its folder: nothing after it is
stored or emitted. So after **3 runs in a row failing on the same message**,
YisraCase **quarantines** it: skips it for good and moves on, and records one
**error** alert, *Mailbox ingest skipped a message*, naming the box, the
folder, the message's UID and — when it got that far — its Message-ID. An
outage (the mail server, the network or the database going away) never
quarantines anything: those failures don't belong to a message.

If a **second** message in the same folder fails the same way within a day,
it is **held, not quarantined**: a fault that hits message after message is
YisraCase's, not the mail's, and skipping each in turn would lose mail every
15 minutes. The folder waits, and its failing-folder error alert says *held,
not quarantined*. That needs IT straight away.

A quarantined message's trip through the rules never completed: it may be
missing from the case log, and its automations (court, Clio, the docs@
digest) may not have run. To handle one:

1. Find it in the mailbox. For the Google inbox, search Gmail for
   `rfc822msgid:<the Message-ID from the alert>`. If it was stored before it
   failed it also shows in Comms.
2. Check the case log. If it isn't there, **Link to case** in Comms puts it on
   a case's log (or log it by hand).
3. Do by hand whatever else its rules should have done and didn't (a forward,
   a court or Clio step).
4. Send IT the alert: the failure is a bug (its last error names it), and
   there is no re-emit button yet.

The folder's record keeps its last 20 quarantined messages
(`ingest_state.<folder>.quarantined`).

**Emergency stop for rules:** setting the `mailbox-imap` row in
`email_ingest_sources` to inactive stops every mailbox from emitting on the
next run. Mail is still stored; mail stored while it is off is never emitted
afterwards.

## Access

Click **Access** on a row. Each person gets any mix of:

| Flag | Means |
|---|---|
| **Read** | sees the box's mail in Comms |
| **Send** | can write and reply as the box in Comms |
| **Manage** | can grant and revoke access on this box, rename it and change its colour |

- Ticks **save immediately**. A grant keeps at least one tick — use **Remove**
  to take access away entirely.
- **Superusers need no grant** — they see every mailbox.
- **Attorneys read every mailbox without a grant** (the `attorney` role in
  Users — Stuart). Read only: sending or managing a box still needs the tick
  — Stuart sends only from the boxes he has **Send** on.
  The role is checked on every request, so removing it takes effect at once.
- **Automations need no grant**: workflow, sequence and campaign sends are not
  checked against mailbox access (and the automations user cannot hold one).
- A **Manage** holder who is not a superuser may change who has access to that
  box, its display name and its colour — nothing else; host, login, secret, send
  credential, folders and Active stay superuser-only. Their screen for the
  grants is **Settings → Manage access** (More → Settings): one card per box
  or line they manage, with the same ticks, **Remove** and an **Add** row
  (active staff not already on it). It needs no elevation — a Manage grant is
  the authority, not a superuser bypass. Unticking your own Manage asks first
  and the card then disappears. The display name and colour have no screen for
  them yet: the server allows the change, but the Mailboxes tile is
  superuser-only.
- Everyone sees what they hold in **Settings → My access**: each mailbox and
  line with Read / Send / Manage, *via role (attorney)* where the attorney
  role — not a grant — gives the read.

Every change — mailbox or grant — is recorded in `admin_audit_log` under the
tool `mailboxes`.

## Reading mail — Comms

**Where:** **Comms** in the sidebar (and on Home), with your unread count on
it. Everyone sees it; with nothing shared, the Email and Phone tabs each say
so and who to ask. It piloted under
Admin → Comms. It shows the mail of every box you can read in one list; the
**Phone** tab shows texts and calls on the firm's phone lines ([Phone lines —
Comms](#phone-lines--comms), below).

- **The list** is the Inbox of every box you can read, newest first, with
  the box shown when you can read more than one. **One row per email:** the
  same email stored in two of your boxes shows once, with a small tag for
  each box it sits in (the box's display name, or the part before the @),
  and the unread counts on the tab and the sidebar count emails the same
  way. Mail arrives with the
  5-minute check; **Refresh** (the circular arrow) re-reads the list and also
  checks the mail servers right away (at most once every 30 seconds for the
  whole office), so new mail shows within moments. The grey line above the
  list says when the servers were last checked ("Checked 3 min ago" — the
  oldest among the boxes shown); a box that has not been checked for a
  while, or whose checks are failing, gets a small warning tag there (IT
  sees the error itself in the tag's tooltip). For the Google mailbox the
  Inbox comes from Google's labels (above); an email that is not in the Inbox
  carries a small tag saying where it is — **Sent**, **Archived**, or the
  folder name. Each mailbox has its own
  colour (the stripe on the left of a message and the dot on its mailbox
  tag), the same for everyone — chosen in Admin → Mailboxes (Colour, above).
  Narrow it with the **mailbox picker** (tick
  any combination of boxes — say shoshana@ and billing@ together), the
  search (sender or subject — not the message text; type **from:court.gov**
  in it to keep one sender domain), and
  the filter buttons (a pressed button is on): **Inbox** / **Sent** / **All
  folders** (one at a time — **Sent** is the mail the boxes sent: Google's
  Sent label, or a polled Sent folder; **All folders** is everything; a
  message a mailbox sent shows who it went to, "To: …"),
  **Any** / **On a case** / **Not on a case** (one at a time),
  **Unread**, **Client mail**, **Has files**. On a phone the filters sit
  behind a **Filters** button (it shows how many are on); search and the
  menus stay put.
- **On a wide screen** your saved views and the mailboxes sit in a column
  on the left instead of the two menus: click a view (or **All mail** — every
  box, no filters) to show it; tick mailboxes to combine them. Each box shows
  your unread count, and a **read-only** tag when you cannot send as it; each view
  shows how many unread Inbox messages it holds under its own filters (the
  same count appears in the view menu; a view of **Sent** shows none — sent
  mail is never unread). When the screen no longer matches
  the view you picked, **Unsaved changes** offers **Save as view** or
  **Update** that view; **Manage** renames, deletes or sets the default.
  **«** hides the column (the menus come back above the list, and the
  conversation gets the room); the column button next to the menus brings it
  back, and your browser remembers which you chose. The Email tab shows your
  unread total.
  - **Client mail** keeps mail to or from a client — someone who is Primary or
    Secondary on a case — by its sender or one of its first five recipients
    (To, then Cc). The firm's own addresses never count, even when a staff
    member is set up as a client on a test case, and neither do the firm's
    mailboxes. An attorney or trustee on a case is not a client of it.
  - **Has files** keeps mail with a real attachment — what the paperclip
    counts; a signature logo drawn inside the message is not a file.
  - **Not on a case** is mail not yet on any case's log. **Client mail** +
    **Has files** + **Not on a case**, saved as a view, is a "documents
    clients sent that nobody has filed yet" queue.
- **Read / unread is yours alone.** An unread message stands out in the
  list: a blue dot, bold sender, subject and date, on a white row (the lighter
  row in the dark theme); read ones are plain, on the page's grey. Opening a
  conversation marks it read for you, not for the other people on the box. In
  the conversation, messages that were unread when you opened it keep a
  **New** tag (and a blue left edge), so you can still see what arrived since
  you last looked; **Mark unread** / **Mark read** in a message's **⋯** menu
  switches it (the tag then says **Unread**).
  YisraCase never marks anything read on the mail server, so Outlook and
  webmail are unaffected. **Mark all read** clears exactly what the list
  shows — the ticked boxes and the filters on screen, including pages not
  loaded yet — after asking you to confirm (there is no undo).
- **Conversations** gather every message with the same thread across all the
  boxes you can read. The same email in two boxes appears once. A very long
  conversation shows its latest 100 messages. Each message's header is one
  line — who, when, a paperclip count, **Reply** / **Reply all** and the
  **⋯** menu (Mark read / unread, Plain text / Formatted, Taller, **Task**,
  and Always show images where it applies); the small chevron beside them
  opens the full addresses and which of your boxes hold the message.
- **Under the header, one line says where the email stands with the log** —
  and it is where you act on that:
  - *On the log of 26-41823 · Change* — it is on that case's log;
  - *On the firm log, not on a case · Link to case*;
  - *Still syncing; its log entry is on the way* — the 5-minute sync has it
    and the log entry follows;
  - *Not on the log: mail between firm addresses is skipped / a suppression
    rule skipped it / the mail rules failed on it / this mailbox only stores
    mail*, or *Older mail, stored before YisraCase read this mailbox* — each
    with **Link to case** to put it on a case now.
  When a colleague sent the email from YisraCase, the same line says
  **· Sent by <name> via YisraCase** — on a shared box you can finally see
  who replied. A reply sent with a **Case** picked (below) shows *Linking to
  26-41823…* until its copy arrives, and says so if the link failed.
- **Images are hidden** until you click **Show**: a remote image tells
  the sender that you opened the message. Message content is displayed
  boxed off from YisraCase — scripts and forms in an email never run, and
  links open in a new tab. **Always for this sender** remembers that
  sender for you (only you): their mail then opens with images shown, and
  **Stop** on that line hides them again. It trusts the exact address, not
  the whole domain; a fake From line borrowing that address could learn you
  opened it, nothing more.
- **Attachments** show as a paperclip and count on the message in the list
  and on its header in the conversation, and as one row of compact chips
  under it. Clicking the name of a PDF or a picture opens it in a viewer
  (**New tab** there opens a PDF full size; some phones cannot show a PDF
  inside a page, so use New tab or Download); clicking any other file's name
  downloads it. On every chip
  the arrow downloads, and the folder button **saves it to a case**: pick the
  case — the email's own case and the cases of the clients in the
  conversation are offered first, or search — and it goes into that case's
  Dropbox folder and onto its Documents tab, exactly like an upload from the
  case. Every file comes from the mail server when you click it (see
  Attachments above). Only an image drawn inside the message itself (a
  signature logo) is not listed — it appears when you click **Show**.
- **Task** (in the ⋯ menu, and its own button on a wide screen) turns the
  email into a task: the title and description start from the email, the
  task is yours unless you assign it, due today (**+1 business day** moves
  it past a weekend), and **Link** offers the email's case, the
  conversation's client cases and contacts, or none. **Open tasks** on the
  confirmation jumps to the Tasks tab. The task does not link back to the
  email yet.
- **In this conversation** (under the subject) starts as one line — the
  first person and their case, with **+N ▸** to open the full strip: every
  contact in the conversation — sender first — with the cases
  they are a client on, open ones first. Click a name to open the contact,
  a case to open the case. The firm's own addresses are never listed, and an
  attorney or trustee shows as a name without their cases.
- **Add to a client** (the dashed names on the same strip) lists the
  addresses in the conversation that no contact has yet — the first three,
  then **+N more**. No-reply and mailer-daemon style senders are left out.
  Clicking one opens the same **Attach email to contact** window as the
  Log's attach button: attach the address to an existing contact (the search
  starts with the name the email carried) or **Create new contact** with it
  (the name is filled in too). The **start date on contact** is filled in
  with the earliest the address was seen — its first email in the boxes you
  can read, or its first log entry, whichever is earlier — so its older mail
  and log entries count as that contact's; change it if you know better.
  Once attached, the name moves up to the contacts on the strip.
- **Link to case** puts the email on a case's log. If the email is already
  on the log (the old Gmail sync logs Stuart's inbox, for instance), that entry
  is linked — never a second copy. If it is not on the log yet (a box that
  does not emit to rules, Sent mail) it is added now, dated when it was sent.
  "Still being processed" means the 5-minute sync has not finished with that
  message; "arrived in the last few minutes" means another sync may still log
  it — both clear within about 10 minutes.
- **Saved views** (the bookmark button) keep the ticked mailboxes plus the
  filters under a name; one can be your default. **Update** on a view
  replaces its mailboxes and filters with the ones on screen. A view only
  narrows what you can already read — if every box in it stops being shared
  with you, it shows nothing.

## Sending mail — Comms

**Who:** people with **Send** on a box (Access, above), and superusers — who
confirm their password first ([elevation](README.md)), as for the other
superuser changes. Comms shows **Compose** and the **Reply** buttons to
anyone who may send from at least one box.

- **Compose** (top of the left column on a wide screen, else in the bar
  above the list) writes a new email. **Reply** and **Reply all** sit on
  every message in a conversation; the reply opens at the end of the
  conversation.
- **From** lists the boxes you can send as, in their colours. A box that
  cannot send right now is greyed out with the reason — no send credential
  (read-only), switched off, a Pabbly sender, or a Google sender for a
  different address. A reply starts from the address the email was sent
  to — its **To**, then its **Cc** — when you may send as it (so mail to
  it@4lsg.com is answered from it@4lsg.com, not stuart@), else from the box
  the email sits in; a reply to mail your own box sent starts from the
  address it was sent from.
- **To / Cc / Bcc**: type an address, or part of a contact's name or email —
  matching contacts are offered with their cases — and press Enter, Tab or a
  comma; a pasted list is split for you. **At most 10 recipients** in all:
  Comms is for one-to-one mail, not bulk (that is what campaigns are for).
  **Reply** goes to the sender; **Reply all** also copies everyone else on
  the email except the box you send from. Replying to an email your own box
  sent — anything under **Sent**, automation emails included — goes to that
  email's recipients. Switching between Reply and Reply all keeps what you
  wrote.
- **Opted-out recipients.** If a recipient's address is marked
  *opted out* on the contact (the SMS / email opt-out on that phone or email
  row), Send stops and asks first: the message names who opted out, and **OK**
  sends anyway, **Cancel** sends nothing and keeps what you wrote. Send anyway
  only when they asked for this message — a client who opted out can still get
  a reply they requested. The override is recorded (IT can see who confirmed
  it). Automations never get this choice: they skip an opted-out recipient
  ([error policies](../03-YisraFlow/08-error-policies.md)), and so does Ask
  YisraCase.
- **Subject** is "Re: …" on a reply. Changing it is allowed; YisraCase still
  keeps the reply in the original conversation (Gmail may show it as a new
  one).
- **Case** (optional) puts what you send on a case's log. A reply starts
  with the email's own case; otherwise it is empty, with one-click
  suggestions — the cases of contacts you pick as recipients, and on a
  reply the conversation's client cases too (a new message belongs to no
  conversation, so it never offers the cases of the email open behind it)
  — plus **Pick a case…** to search. It never picks
  one for you, and **Remove** sends without a link. An unknown case stops
  the send before anything goes out. The sent copy joins the case's log once
  the mail sync stores it (its log-status line shows *Linking to …* until
  then); for a SiteGround box whose Sent folder is not polled, the log entry
  is written at send time instead. If the link cannot be made, IT is
  alerted and the line on the sent copy says it failed — **Link to case**
  still works by hand.
- **The message** is plain text — a blank line starts a new paragraph.
  **Add signature** (ticked when the box has a signature of its own —
  Connections → Email Senders) adds it under your text. A reply quotes the
  original under your text; **Original message** → untick **Include it** to
  leave it out. Attachments cannot be sent from Comms yet.
- **Send** sends straight away — there is no undo and no scheduling. While
  it says **Sending…** the window stays open; if the mail server refuses one
  of several recipients you are told which.
  **✕** (or Esc) closes the window and keeps what you wrote until the page
  is reloaded — nothing is saved on the server; **Discard** throws it away;
  leaving the page with unsent text asks first.
- **Where it shows.** A sent email appears after the box's next check —
  about 5 minutes — under **Sent**, already marked read for you; an open
  conversation re-reads itself for a few minutes after you reply.
  - **The Google mailbox**: Google files the email in Sent itself and the
    poll of All Mail picks it up, exactly like mail sent from Gmail —
    including reaching the log the way Gmail's own sent mail does.
  - **Other mailboxes (SiteGround)**: YisraCase also saves a copy in the
    box's Sent folder, so Outlook and webmail show it. It appears in Comms
    only if that Sent folder is one of the box's polled folders (Folders,
    above). If the copy cannot be saved, the email still went out — you are
    told, and IT gets a warning. Like other Sent mail of these boxes it is
    not put on any log by itself — use **Link to case** on it.
- **Daily limit.** Each sending account (one Google account, or one SMTP
  login) may send a set number of emails in any 24 hours — counting
  automation emails through the same account, and attempts the provider
  refused: by default 1,500 for Google and 300 for SMTP, changed with the
  `mail_send_daily_budget` app setting (`{"gmail": n, "smtp": n}`). At the
  limit Comms refuses to send (nothing goes out), says so, and IT is
  emailed (the hourly alert digest; once a day per account). Automations
  are not stopped by it. Separately, more than 30 sends by one person within
  10 minutes are refused for a few minutes.
- Every send, refused send and failed send is recorded in `admin_audit_log`
  under the tool `mail_send` — who, which box, how many recipients; never
  the text or the addresses.

## Send-as addresses (one Google account, many addresses)

All the firm's 4lsg.com addresses — stuart@, it@, billing@, office@ and the
rest — are one Google account (Stuart's): mail to any of them lands in the
**Stuart — Workspace** box, and Google sends as any of them. To let someone
send as one of those addresses, give that address its **own box** — a
*send-only* box:

1. Connections → Email Senders: the address must already be a Google sender
   there (it@4lsg.com, billing@4lsg.com … are).
2. Admin → Mailboxes → **Add** → pick **Send-as address of an existing
   box**: Address = that address (e.g. it@4lsg.com); **Of mailbox** =
   Stuart's box; **Gmail label** = the label the account's Gmail filter puts
   on this address's mail (exact spelling — `IT`, `Rena` …; one of the
   account's own labels — a system label such as `\Inbox` is refused); Send
   credential = that address's sender. The connection is copied from
   Stuart's box automatically; there is no password and no ingest to
   configure (the box never checks mail — it couldn't, two boxes may never
   both check one account).
3. **Access** → give **Send** to whoever may send as it, and **Read** to
   whoever should read its mail — both per address.

What that gives:

- The address appears under **From** for the people with Send on it, with
  its own name and signature from its sender row.
- **Reply** to mail sent to that address starts from it automatically —
  also mail one 4lsg.com address sent another: Stuart's note to it@,
  answered as it@, goes back to Stuart (not to it@ itself). Answered as
  stuart@, it is a follow-up to it@.
- A superuser can send as every box; Comms picks the address from the Send
  ticks they actually hold first.
- **From** lists real mailboxes first, then the send-as addresses, so a new
  email starts from a real mailbox.
- It is never checked for mail — its mail is in Stuart's box. The copy of
  what it sends lands there too (Google files it under Sent), already marked
  read for the sender. In Admin → Mailboxes it shows as a **send-as** row
  naming its box and label; its own row carries no password or ingest. To
  point it at a different box, **Edit** it and choose another **Of
  mailbox** (its connection follows; mailboxes are never deleted, so this is
  the only way).
- It counts toward the same Google daily limit as every other 4lsg.com
  address.
- Being created as a send-as address is what makes it send-only — a plain
  box that merely has Ingest off and no password is just a paused box.
- **Reading IS per address**: **Read** on the send-as box shows, in Comms,
  exactly that address's slice of Stuart's box — mail addressed to it (From,
  To or Cc), plus mail the account's Gmail filter filed under its label
  (that is how Bcc'd and mailing-list mail is caught, so keep the filter and
  the box's **Gmail label** in step). The slice appears as its own mailbox
  in Comms — its own colour, its own unread count on the sidebar badge, its
  own **Sent** (mail *from* the address) and **Inbox** (everything else —
  including the firm's own mail *to* it, such as the automations@ digests,
  which Google files as sent mail of the account) — and attachments open
  from it like any other mail. Nothing else of Stuart's box is visible
  through it. Someone with Send but not Read still gets Comms and can write
  as the address, but sees no list.
- Someone who reads Stuart's box as well (an attorney, a superuser) sees the
  send-as address in Comms too, as a narrower view of mail they already
  have: its count shows on its own row, but the sidebar badge and **All
  mail** count Stuart's Inbox once and never add the address's slice on
  top.

## Phone lines — Comms

The **Phone** tab of Comms shows the texts and calls the phone system
recorded on each firm phone line you have access to — RingCentral and Quo
lines alike (design: `ref/MAILBOX_SYSTEM_DESIGN.md` §4.4, slice S-PH).

**Where:** Comms → **Phone**. It loads the first time you open it.

- **Lines.** On a wide screen the lines are listed on the left (with your
  access: **R** read · **S** send · **M** manage); on a narrow one pick the
  line in the bar. Your last line is remembered in this browser.
- **All numbers** (first in the list when you can read more than one line)
  shows every line at once: one row per number, tagged with the lines it
  used. Opening it shows its texts and calls on all of them together, each
  marked "via" its line; a reply has a **From** picker (it starts on the
  line of their latest text, if you can send from it). **Calls** shows every
  line's calls, each tagged with its line. Texts between two of the firm's
  own lines are left out of this list — open that line to see them.
- **Texts · All · Calls** — the toggle in the bar picks the list. **All**
  (the default) lists the line's conversations — one per number that
  texted or called the line (or was texted or called from it), newest
  activity first, the contact's name when the number belongs to a client on
  file (**Open contact** opens their file). A row whose latest event was a
  call shows the call instead of a text (**Missed call** in red, "Incoming
  call · 3m 05s", "Outgoing call · no answer"). Opening one shows the texts as
  bubbles — yours on the right, theirs on the left — with the **calls** with
  that number among them as small call boxes (incoming on the left, outgoing
  on the right: direction and length, **Missed call** in red, "no answer"
  when nobody picked up), all in the order they happened; **Load earlier**
  goes back further. Every confirmed text and call ends with its reference
  number (**#12345**, at the right of its time line; a text you just sent
  gets one once the phone system confirms it) — click it to select it, then
  copy, to point someone at exactly that text or call. Typing it into the
  search box (below) finds that text or call again.
- **Texts** is the same list for texts only: a number that only ever called
  is not in it, and each row shows its latest text. It filters the list, not
  the conversation — opening a number still shows its calls among the texts.
- **A number that is not a contact** shows as the number alone, with **Add
  to contact**: attach it to an existing contact or create a new contact
  with it (the same dialog as the Log's orphan rows). The start date is
  preset to the first text or call with that number on any line you can
  read, or the Log's first row with it if that is older. Short codes are not
  offered.
- **Calls** is the line's call log, newest first — direction, length, and
  **Missed call** for an unanswered incoming call. Clicking a call opens the
  conversation with that number — its calls and texts — even when the
  number only ever called. (Only Quo reports unanswered calls; a RingCentral
  call nobody picked up still shows as answered.)
- **Search** — the box under the toggle finds a conversation by **phone
  number** in any form ("(202) 670-2603", "+1 202 670 2603", "2026702603",
  or just part of it such as "2603"; at least 3 digits), by **contact name**
  (the numbers that contact has now), or by **case number or caption** (the
  numbers of the case's clients, Primary and Secondary). It looks for all
  three at once, so a docket like "24-41234" also finds a number containing
  those digits; a row found through a case says which case. It searches the
  line you are on (or **All numbers**) in whichever list you are in — Texts,
  All or Calls — and stays on when you switch either. Two characters at
  least; clear the box (or press Esc) for the whole list again. When a short
  name matches very many contacts, only the first 200 numbers each are
  searched and the line under the bar says so — type more of the name.
  Only numbers on file as a contact's *current* number are found by name, so
  a number no contact holds is found by its digits.
  A **reference number** finds one text or call: type it with its **#**
  ("#12345") and nothing else is searched — the list shows that item's
  conversation (in **Calls**, that one call). Typed without the # ("12345")
  it is searched as a reference number AND as digits of a phone number, so
  both kinds of row can show; the one found by its reference number says
  "Reference #12345". Open that row — or press **Enter** in the box — and the
  conversation opens at that bubble, scrolled to it and briefly ringed
  (earlier messages load as needed, up to 10 pages; past that a note says to
  use **Load earlier**). It finds only what the list you are in can show: a
  text or call on a line you can read, not one hidden from the phone log; a
  call is not found in **Texts**, and a text not in **Calls**. With a word of 3 or more
  letters or digits (but not a #reference number) it also searches what was SAID on calls — **In call transcripts**,
  under the list ([Comms archive](10-comms-archive.md)).
- **Sending.** With **Send** on an active line, a conversation has a message
  box at the bottom and the bar has **New text** (a US number, up to 1,000
  characters, text only — no pictures here). What you send shows as
  "waiting for the phone system to confirm" until the phone system reports
  it back (seconds, usually); then it is an ordinary bubble. A short code
  (e.g. a 5-digit verification sender) cannot be texted back. Superusers
  confirm their password first ([elevation](README.md)).
- **Opted-out recipients.** If a recipient's number is marked
  *opted out* on the contact (the SMS / email opt-out on that phone or email
  row), Send stops and asks first: the message names who opted out, and **OK**
  sends anyway, **Cancel** sends nothing and keeps what you wrote. Send anyway
  only when they asked for this message — a client who opted out can still get
  a reply they requested. The override is recorded (IT can see who confirmed
  it). Automations never get this choice: they skip an opted-out recipient
  ([error policies](../03-YisraFlow/08-error-policies.md)), and so does Ask
  YisraCase.
- **Recordings, voicemails, pictures and files** come from the comms
  archive: a call has **Listen** (and **Transcript** once transcribed), a
  voicemail shows on the call it was left on, and a text shows its pictures
  inline and other files as chips — see [Comms archive](10-comms-archive.md).
  A text whose file the archive does not hold yet says "archiving, check back
  soon"; one the archive does not hold at all still says **Attachment — not
  shown here yet** (and "Attachment" in the list).
- **Not shown:** texts and calls the spam filters caught (suppressed), and
  numbers on the phone system that are not set up as a line in Connections →
  Phone Lines. To make such a number readable, add it there — leave it
  **inactive** if it should never be texted from (an inactive line can be
  read and granted, never sent from, and stays out of every "From" list).
  For **texts** that alone is not enough: the hooks that receive them carry
  their own list of the firm's numbers (`rc-message-in` for RingCentral,
  `quo-message` for Quo — More Features → Automations → Hooks), so add a new
  line to that hook's list too. Until then its texts file under the wrong
  line: a RingCentral text under the first number it was sent to, a Quo
  group text under its first recipient.
- No unread counts on phone yet.

### Who can read and send — Connections → Phone Lines → Access

Phone-line access works like mailbox access: click **Access** on a line in
**Connections → Phone Lines** (superusers).

| Flag | Means |
|---|---|
| **Read** | sees the line's texts and calls in Comms → Phone |
| **Send** | can text from the line — in Comms, on a contact's **Communicate** tab, and in the case **Sending Form** |
| **Manage** | can grant and revoke access on this line |

- Ticks save immediately; a grant keeps at least one tick — **Remove** takes
  access away. Every change is recorded in `admin_audit_log` under the tool
  `phone_lines`; texts sent from Comms under `phone_send`.
- **Superusers need no grant.** **Attorneys read every line without one** —
  but sending still needs **Send**.
- **Send is checked everywhere a person texts:** the Communicate tab and the
  Sending Form only list the lines you may send from, and the server refuses
  the others. At launch (2026-10-12) each person got Read + Send on their
  own default line (Stuart → his line, Shoshana → hers, Rena → hers).
- **Automations are never checked**: workflow, sequence, campaign and
  reminder texts go out from any line, as before.
- A non-superuser with **Manage** on a line edits its access in **Settings →
  Manage access**, as for mailboxes — but only for a line they can also
  **Read**: the list behind that screen holds the lines a person reads, so a
  send- or manage-only grant does not show there (no one holds one today).

### Do-not-transcribe — Connections → Phone Lines, or Comms → Phone

**Do-not-transcribe** opens the list of numbers whose calls are archived but
never sent for transcription. It sits in two places, and both open the same
list: on **Connections → Phone Lines**, left of **+ Add Line** (superusers),
and in **Comms → Phone**, at the right end of the Email / Phone / Team tabs —
shown only to archive admins, and only while Phone is selected (on a phone it
is just its icon). What it does, and who it belongs to:
[Comms Transcription](09-comms-transcription.md#what-never-gets-transcribed).
