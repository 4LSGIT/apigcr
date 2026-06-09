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

Uploads go to the folder linked on the case (`case_dropbox`). If the case has no
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
