# Mailboxes (SU)

The email addresses YisraCase reads over IMAP — and, when a send credential is
attached, sends from — plus **who may use each one**. This is the foundation of
the comms hub (design: `ref/MAILBOX_SYSTEM_DESIGN.md`).

**Where:** Admin → **Mailboxes**. Adding and editing mailboxes is SU only and
asks for [elevation](README.md) like the other SU tools.

> **Nothing reads mail yet.** Slice S0 sets up mailboxes and access. Polling
> (ingest) arrives with S1, the inbox screen with S2, sending with S3. Rows you
> create now are inert until then.

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

Every folder listed is polled and **stored in full** (once ingest is live).
**Emit to rules** additionally feeds that folder into the email-ingest rules
pipeline (court mail, case linking, the log). New mailboxes start with
`INBOX` emitting. Sent-folder names differ by host (Gmail:
`[Gmail]/Sent Mail`) — add the server's exact name, normally without Emit to
rules. Untick **Ingest enabled** to stop polling a box entirely.

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
