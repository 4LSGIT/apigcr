# Documents — Sync & Re-linking

The engine that fills the Documents registry from Dropbox, the panel that
operates it, and the guided workflow for fixing a case that points at the wrong
folder.

**Where:** More → **Documents**. The **Sync** button in the toolbar opens the
operations panel; it is collapsed until you open it and only exists on the full
Documents page — the Documents tab inside a case or contact never shows it.

Not SU-gated: any signed-in staff member can open this page and the Sync panel.

For the Dropbox integration underneath (credentials, folder templates, the
`dropbox_*` internal functions) see
[Integrations → Dropbox](../04-Integrations/05-dropbox.md).

---

## How documents get into YisraCase at all

Nobody uploads them here. Every file lives in Dropbox, and a background job
walks the folders we tell it to watch and records what it finds — name, size,
type, path, when it last changed. That record is the "registry". The file itself
never moves and never gets copied.

A document then gets attached to a case **by where it sits**. If a file is
anywhere under a case's Dropbox folder, it belongs to that case. That is the
whole rule, and everything in this chapter is a consequence of it.

Two things have to be true for a case's documents to show up:

1. The case's Dropbox folder is **inside a watched folder** (a "sync root").
2. `Case → Dropbox link` on the case record points at **the folder the
   documents are actually in**.

When documents are missing, it is almost always number 2.

---

## Sync roots — the folders we watch

The panel lists every watched folder with its state:

| State | Means |
|---|---|
| **incremental** | Normal. It has read the whole folder once and now only asks Dropbox what changed. |
| **backfilling** | Still reading the folder for the first time. Can take days for a large tree. Automations are **off** during this. |
| **empty** | The folder does not exist in Dropbox yet. **Not an error** — three of ours are created on demand and will start working the moment they appear. |
| **disabled** | Switched off. Keeps its place; can be switched back on. |
| **running** | A sync is walking it right now. |

### Adding one

Paste the **full Dropbox path, including leading spaces**. Our folders are named
` Active Cases` with spaces in front because that is how they sort in Dropbox,
and those spaces are part of the name. The panel shows paths in a monospaced
font specifically so you can see them.

A folder that does not exist yet is fine — you get a yellow "will sync when
created" note and the root is added anyway.

You cannot add a folder that sits inside a folder we already watch (or that
contains one). Everything underneath would be read twice for no benefit.

### Why there is no Delete button

A document's registry entry does not remember which root found it. Delete a root
and you strand every file underneath it: still listed, never checked again,
nothing marking it stale. **Disable** does the safe version of the same thing and
can be undone. If a path is simply wrong, disable it and add the right one — you
also cannot edit a root's path, for the same reason.

### Sync now

Runs one small batch against that root immediately. Useful for "did my new root
work". It deliberately does **not** run the whole backfill — that is the
scheduled job's work.

If it comes back **"Skipped — already running"**, that is normal: the scheduled
job had that folder open. Pressing again will not help.

---

## The kill switch

`documents_sync_enabled` in Settings. Anything other than exactly `1` stops the
whole engine — no folders walked, no files registered, no re-linking.

A red banner sits at the top of the panel whenever it is off, because a tidy
table of roots with old timestamps otherwise looks like everything is fine.

Turning it off is the right move if the engine is misbehaving; nothing is lost,
and everything resumes where it stopped.

---

## The Unlinked view

Documents → filter **Unlinked** shows every document with no case attached.

**The number is around 130,000 and that is not a problem.** The firm's Dropbox
covers decades and practice areas the case list never covered — old matters,
firm admin, scans that predate YisraCase. Most of those documents are correctly
unattached and always will be. The line under the count says so; read it before
escalating.

What is worth looking at is a document you *expected* to be on a case. That is a
re-linking question, below.

---

## Diagnostics

Two reports, both read-only.

### Cases outside every sync root

Cases whose Dropbox folder is not under any watched folder. Their documents will
**never** appear, because nothing ever looks at that folder. Fix by adding a
root, or by moving the case folder into a watched tree.

### Cases with a folder but no documents

Cases whose Dropbox link resolves perfectly and that still have nothing attached.
The **Run report** button produces this on demand — it takes a few seconds,
reads the whole registry, and changes nothing.

This is the report the re-linking workflow exists for.

---

## Re-linking a case to its real folder

### What the queue actually is

At the time of writing, 418 cases have a folder that resolves cleanly and hold
no documents. It is tempting to read that as 418 broken cases. It is not:

- **410 of them were never filed.** They are potential-case intake folders,
  created when the lead came in, still empty because the client never sent a
  document. That is the ordinary end state of a lead that did not convert.
- **None of them** has a single file under the folder the case points at.
- Searching all of Dropbox for a folder matching the client's name or docket
  number finds a plausible one for about **24**.

So the panel shows you those ~24 first, and puts the rest behind a collapsed
"no matching folder" strip. That is the honest shape of the work.

The cases that *are* fixable are the ones where the folder moved and the case
record was not updated with it — usually at filing, when a matter graduates from
the Potential tree to the Active tree and gets a new folder.

### The rule that governs all of this

> **A wrong link puts one client's documents on another client's case page.**

They then also appear on every contact related to that case. So nothing is ever
re-linked automatically, no matter how confident a match looks. Every change is a
folder *you* picked for a case *you* looked at.

### Working the queue

Each row shows the client, the case, and — in grey — the folder the case
currently points at. That grey path is what you are moving **away** from.

Click a row to see suggested folders. Each suggestion carries a coloured label:

| Label | What matched | How much to trust it |
|---|---|---|
| **docket number** | The case's docket number appears in the folder name | Strong. Docket numbers are unique. |
| **client name** | Both the surname **and** the first name appear in the folder name | Good, but check it. |
| **surname only** | Only the last name matched | **Usually a different client.** Hidden by default. |

Each suggestion also shows how many documents are in that folder and when it was
last touched — which is often the fastest way to tell two candidates apart.

Some suggestions appear greyed out with **"already linked to case ABC12345"**.
Those cannot be selected. That is deliberate, and it is useful information in
itself: it usually means the documents you are looking for already found their
way to a different case record, and the real fix may be merging the two cases
rather than re-linking this one.

You may also see notes like *"sits inside case ABC12345's folder"*. Common with
joint filings — a husband and wife each have a case record, one folder holds
both their documents. That may well be correct; you are the one who knows.

### Confirming

The confirm box shows the old path, the new path, and how many documents are
about to appear. Read both paths. Then:

- The case's `Dropbox link` is rewritten to the new folder.
- Documents already in that folder attach to the case, usually within seconds.
- A **note is written to the case's activity log** recording who did it, both
  paths, and how many documents moved.

Surname-only matches need a second tick confirming you actually looked at the
folder in Dropbox. Take that seriously — a same-surname collision is the most
likely explanation for a surname-only match, not the least.

**If you get it wrong:** re-link again to the correct folder. The old
attachments are not removed automatically, so tell IT — the previous case may
need documents detaching by hand.

### Dismissing

**Dismiss** clears a case from the queue. It changes **nothing** — no document,
no case, nothing in Dropbox. It is a note saying "I looked, there is nothing to
do here." It can be undone with the checkbox at the bottom of the block.

**Dismiss all** does the same for every case in the "no matching folder" strip at
once. Safe for exactly the same reason, and the only realistic way to clear a few
hundred dead leads.

### Checking your work

Press **Run report** in the diagnostics block. The "cases with a folder but no
documents" count should have dropped by the number you re-linked.

It will **not** drop to zero, or anywhere near it. The remaining cases have no
folder to link to — the client never sent anything. Dismissing is the only thing
that clears those, and dismissing is the right answer for them.

---

## When something looks wrong

**"A case shows no documents but I know they exist."**
Find the case in the re-link queue and look at its suggestions. If nothing is
suggested, search Dropbox by hand — the folder may be named in a way nothing can
match. There is no way to type a path in directly; ask IT.

**"Documents from the wrong client are on a case."**
Tell IT immediately, with both case numbers. Do not try to fix it by re-linking.

**"A whole folder of documents never appeared."**
Check the diagnostics for *cases outside every sync root* first, then check the
roots table for that tree. A root in **backfilling** state has simply not reached
them yet.

**"The panel says sync is disabled."**
Someone turned the kill switch off. Nothing is broken and nothing is lost, but
nothing is updating either. Ask before turning it back on — it is usually off on
purpose.

---

## Known limits

- **Automations do not fire for documents attached by a re-link, or by the
  background reconciler.** A single re-link can attach hundreds of files at once
  and firing a rule for each would run automations over documents years old. If
  you need a rule that sees every document attachment, it needs a scheduled check
  of its own — ask IT.
- **Two people confirming the same folder for different cases in the same second**
  can both succeed. Vanishingly unlikely, and the activity log records both.
- **A case folder is assumed to be one folder.** A case whose documents are
  genuinely split across two unrelated folders cannot be represented; only one
  can be linked.
