# Mailboxes (SU)

The email addresses YisraCase reads over IMAP — and, when a send credential is
attached, sends from — plus **who may use each one**. This is the foundation of
the comms hub (design: `ref/MAILBOX_SYSTEM_DESIGN.md`).

**Where:** Admin → **Mailboxes**. Adding and editing mailboxes is SU only and
asks for [elevation](README.md) like the other SU tools.

> **Polling is live (S1); there is no inbox screen yet.** Every active mailbox
> with **Ingest enabled** is read over IMAP every 5 minutes and stored in
> YisraCase. The inbox screen arrives with S2, sending with S3.

## A mailbox is connection data

Each row holds only what a mail client would: the **address**, an IMAP
**host / port / login**, a **secret**, and optionally a **send credential** (a
Connections sender). Nothing about the provider is baked in, so moving a box
from one host to another is just editing the row.

- **Address** is stored lower-cased and must be unique. Its domain is derived
  from it.
- **Host** is the bare host name — no `https://`, no port.
- **Send credential**: none means the box is **read-only** in YisraCase.
- **Mailboxes are never deleted** — stored mail will reference them. Untick
  **Active** to retire one.

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
- To undo it, set both values back to empty in one save together with Emit
  to rules off on INBOX (the checklist has the exact call). Do **not** turn
  the `gmail-firm` source off: that also cuts off the Apps Script ingest.
- Superusers can list a mailbox's folders from the console
  (`GET /api/mailboxes/<id>/folders`): exact folder names, message counts,
  whether each configured folder exists, and whether the server hands out
  Google ids.

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
| **Read** | sees the box's mail in their inbox (S2) |
| **Send** | can send as the box (S3) |
| **Manage** | can grant and revoke access on this box, and rename it |

- Ticks **save immediately**. A grant keeps at least one tick — use **Remove**
  to take access away entirely.
- **Superusers need no grant** — they see every mailbox.
- **Automations need no grant**: workflow, sequence and campaign sends are not
  checked against mailbox access (and the automations user cannot hold one).
- A **Manage** holder who is not a superuser may change who has access to that
  box and its display name — nothing else; host, login, secret, send
  credential, folders and Active stay superuser-only. The server enforces
  this today, but the Admin tab is superuser-only, so their screen for it
  arrives with the comms hub (S2).

Every change — mailbox or grant — is recorded in `admin_audit_log` under the
tool `mailboxes`.
