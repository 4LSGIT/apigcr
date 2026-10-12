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
last error, and how many runs in a row have failed. After **5 failed runs in a
row** (about 25 minutes) one **warning** naming the box and folder is recorded
in system alerts (warnings ride the alert digest; they do not email on their
own). The streak clears itself on the next good run. Usual causes: a changed
password (re-enter the secret), a misspelt folder, or the mail server down.
Once the Apps Script ingest is retired and YisraCase is the only thing reading
the Google inbox, that mailbox's streaks on folders that feed rules are
recorded as **errors** (they email IT): its mail would otherwise reach no
rules at all.

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
  credential, folders and Active stay superuser-only. The server enforces
  this today, but Mailboxes is on the superuser-only Admin tab, so they have
  no screen for it yet (the comms hub itself is in the sidebar now).

Every change — mailbox or grant — is recorded in `admin_audit_log` under the
tool `mailboxes`.

## Reading mail — Comms

**Where:** **Comms** in the sidebar (and on Home), with your unread count on
it — shown once at least one mailbox is shared with you. It piloted under
Admin → Comms. It shows the mail of every box you can read in one list; the
**Phone** tab is a placeholder until the phone slice.

- **The list** is the Inbox of every box you can read, newest first, with
  the box shown when you can read more than one. Mail arrives with the
  5-minute check; **Refresh** (the circular arrow) re-reads the list and also
  checks the mail servers right away (at most once every 30 seconds for the
  whole office), so new mail shows within moments. For the Google mailbox the
  Inbox comes from Google's labels (above); an email that is not in the Inbox
  carries a small tag saying where it is — **Sent**, **Archived**, or the
  folder name. Each mailbox has its own
  colour (the stripe on the left of a message and the dot on its mailbox
  tag), the same for everyone — chosen in Admin → Mailboxes (Colour, above).
  Narrow it with the **mailbox picker** (tick
  any combination of boxes — say shoshana@ and billing@ together), the
  search (sender or subject — not the message text), a sender domain, and
  the filter buttons (a pressed button is on): **Inbox** / **Sent** / **All
  folders** (one at a time — **Sent** is the mail the boxes sent: Google's
  Sent label, or a polled Sent folder; **All folders** is everything; a
  message a mailbox sent shows who it went to, "To: …"),
  **Unread**, **Client mail**, **Has files**, **On a case** / **Not on a
  case** (one or the other).
- **On a wide screen** your saved views and the mailboxes sit in a column
  on the left instead of the two menus: click a view (or **All mail** — every
  box, no filters) to show it; tick mailboxes to combine them. Each box shows
  your unread count and your access (R read · S send · M manage); each view
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
  you last looked; **Mark unread** / **Mark read** on a message switches it
  (the tag then says **Unread**).
  YisraCase never marks anything read on the mail server, so Outlook and
  webmail are unaffected. **Mark all read** clears exactly what the list
  shows — the ticked boxes and the filters on screen, including pages not
  loaded yet — after asking you to confirm (there is no undo).
- **Conversations** gather every message with the same thread across all the
  boxes you can read. The same email in two boxes appears once. A very long
  conversation shows its latest 100 messages.
- **Images are hidden** until you click **Show images**: a remote image tells
  the sender that you opened the message. Message content is displayed
  boxed off from YisraCase — scripts and forms in an email never run, and
  links open in a new tab. **Always show from <sender>** remembers that
  sender for you (only you): their mail then opens with images shown, and
  **Stop** on that line hides them again. It trusts the exact address, not
  the whole domain; a fake From line borrowing that address could learn you
  opened it, nothing more.
- **Attachments** show as a paperclip and count on the message in the list
  and on its header in the conversation, and as a row of buttons under it.
  Clicking the name of a PDF or a picture opens it in a viewer (**New tab**
  there opens a PDF full size; some phones cannot show a PDF inside a page,
  so use New tab or Download); anything else downloads. The eye button views,
  the arrow downloads, and the folder button **saves it to a case**: pick the
  case — the email's own case and the cases of the clients in the
  conversation are offered first, or search — and it goes into that case's
  Dropbox folder and onto its Documents tab, exactly like an upload from the
  case. Every file comes from the mail server when you click it (see
  Attachments above). Only an image drawn inside the message itself (a
  signature logo) is not listed — it appears when you click **Show images**.
- **In this conversation** (under the subject) lists the people in the
  conversation who are contacts in YisraCase — sender first — with the cases
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
- **Subject** is "Re: …" on a reply. Changing it is allowed; YisraCase still
  keeps the reply in the original conversation (Gmail may show it as a new
  one).
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
2. Admin → Mailboxes → **Add**: Address = that address (e.g. it@4lsg.com);
   Host `imap.gmail.com`, Login `stuart@4lsg.com`; **no password**; untick
   **Ingest enabled**; Send credential = that address's sender.
3. **Access** → give **Send** to whoever may send as it — per address
   (Read on it means nothing: its mail is read in Stuart's box).

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
- It is never checked for mail and never shows in the mailbox list — its mail
  is in Stuart's box. The copy of what it sends lands there too (Google files
  it under Sent), already marked read for the sender.
- It counts toward the same Google daily limit as every other 4lsg.com
  address.
- A box with no password and Ingest off is what makes it send-only. Two boxes
  can never both check one account: ticking **Ingest enabled** on a box whose
  host and login another active box already checks is refused (it would
  store, log and fire rules twice).
- Reading is not per address yet: to read mail sent to it@, a person needs
  Read on Stuart's box (all of it). Someone with only Send on it@ gets Comms
  and can write new email as it@, but cannot see or answer the replies — give
  alias Send only to people who already read Stuart's box.
