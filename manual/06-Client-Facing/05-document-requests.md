# Document Requests & Client Upload — Overview

This is how the firm asks a client for documents and lets them send those
documents back — without email attachments, logins, or anything touching our
own servers. You mark which documents a case needs, send the client a link, and
they see a personalized checklist with an upload button. Their files go straight
into the case's Dropbox folder.

## What you can do with it

- **List the documents a case needs** — the "Docs Needed" checklist on the case.
- **Send the client a request link** — a clean public page that shows them
  exactly what's outstanding.
- **Let the client upload** — files upload directly to the case's Dropbox
  folder; the bytes never pass through YisraCase.

## How it fits together

1. **You** keep a **Docs Needed** checklist on the case (check items off as they
   come in).
2. **You** send the client the document-request link (from the case's Sending
   Form).
3. **The client** opens the link, sees their name and the list of still-needed
   documents, and uploads files.
4. **The files** land in the case's Dropbox folder, under a **Client Uploads**
   subfolder.

---

## Setting up the request (staff side)

### 1. Mark what's needed

On the case, maintain the **Docs Needed** checklist — each item is one document
("Photo ID", "Last 2 pay stubs", "2023 tax return"). The client only ever sees
the items still marked **incomplete**, so checking an item off removes it from
their list.

### 2. The case must have a Dropbox folder

Uploads go to the folder linked on the case (its `entity_folders` binding — the `case_dropbox` field on the case page). If the case has no
Dropbox folder linked, the upload step can't issue a link and the client will be
told there's nowhere to put files — so link the folder first.

### 3. Send the link

Use the **Sending Form** on the case to send the client the document-request
link. It points to the public "Documents Needed" page for that case.

## What the client sees

A public page (no login) titled **Documents Needed**, greeting them by first
name, listing the outstanding documents, and an **Upload Your Documents**
section. When they pick a file, it uploads directly to Dropbox. Large or
multiple files are fine — each file gets its own direct upload link.

## What staff see when files arrive

Every way a client's documents reach the firm leaves the **same kind of line in
the case's log** (log type **docs**), so a case reads the same however the files
came in:

| How they came in | The log line |
|---|---|
| This document-request page | "Client uploaded 3 documents" |
| Client portal → Documents | "Client uploaded 3 documents via portal" |
| Emailed to docs@4lsg.com (the docs@ automation files them) | "Jane Doe emailed 3 documents to docs@4lsg.com" |
| Filed from an email in Comms (File attachments) | "Fred filed 3 emailed documents from Comms" |
| Moved into the case afterwards (a "which case?" answer, or Comms' move) | "3 emailed documents moved to this case" |

Open the line for the details: each file's name and where it landed, the
client's comment (upload pages), whether the files went to the case folder or
to Unsorted, and — for email — which email they came from and any file that
could not be filed.

### The notice

Every door also emails the same person — the **Client documents review** user
(`email_attachments_reviewer`, YisraCase Config → Firm → Routing) — the same
kind of notice: where the files went (with the Dropbox folder, the case and the
Docs Needed list one click away), each file linked to itself, the client's
comment, and the case's still-open Docs Needed items so the reviewer can check
them off. An upload notice's subject starts "Client upload — "; an emailed
one's "New email to Docs@4LSG.com — " (docs@) or "Filed from Comms — ". Unset
the reviewer and no notice goes anywhere; the log line still writes.

Emailed files that went to **Unsorted** because no case could be picked are
logged on the **client's contact** when the sender is a known client; files from
an unknown sender get their line when someone moves them into a case.

### When the client closes the page mid-upload

The upload pages (this one and the portal's Documents page) report each file to
YisraCase the moment it lands in Dropbox, not only at the end. So if the client
closes the tab, loses signal, or locks their phone before the upload finishes,
the files that made it are still reported: about **10 minutes after the last
file landed**, the reviewer gets the usual notice and the case gets its **docs**
log line, covering what had landed by then. The notice says so — "The client's
page closed before it finished — this is what had landed by then." — so check
with the client whether anything is missing. (Before this, such files sat in
Client Uploads with no notice and no log line until someone happened to look.)

In the rare case a single very large file was still uploading when that notice
went out and then finished, it arrives in a second, short notice of its own.

---

## A few things to know

### Files never touch our server

The client's browser uploads straight to Dropbox using a temporary link we hand
out per file. This keeps large uploads fast and keeps file bytes off
YisraCase entirely.

### The list is always live

The client always sees the current state of the Docs Needed checklist. Check an
item off and it disappears from their page on their next load — no need to
re-send the link.

### The page is rate-limited

The public page and the upload step are rate-limited to discourage abuse, since
they're reachable without a login. Normal client use is well under the limit.

### No Dropbox folder = no uploads

If a client reports they "can't upload," the most common cause is that the case
has no Dropbox folder linked yet. Link it on the case and they're good.

---

*Related: the **Docs Needed** checklist lives on the case alongside the case's
other checklists; Dropbox folder linking is covered under
[Integrations → Dropbox](../04-Integrations/05-dropbox.md).*
