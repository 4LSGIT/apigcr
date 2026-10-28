# Shared values — values staff and tools write together

**Where:** Admin → **Shared values**.
**Who:** the tile shows for admins, IT and super-users, but every staff member
may read and write shared values (a tool on the launcher does it with their
login). What each person may change is decided by each namespace's own rule.

## What it is

Some values are not settings: they change all the time, and many people write
them. An office **high score** in a game, a **counter** a tool keeps, a
**"who is on call"** note. These live in **shared values**, not in the firm's
settings.

Shared values are grouped in **namespaces**. A namespace is a named box (for
example `carve`, the Carve game's box), and each value inside it has a **key**
(for example `best`). Names are lowercase letters, digits, `-` and `_`, up to
64 characters.

Everything in a shared value was typed by a person or a tool. The page always
shows it as plain text, never as part of the page.

## Namespaces

The first screen lists every namespace: what it is for, who may write in it,
how many keys it holds, who created it and when it last changed. Click one to
open it. **New namespace** at the bottom creates one — any staff member may.

Each namespace has a rule for **who may write values**:

| Rule | Who may write |
|---|---|
| Any staff member | everyone (the usual choice; the Carve high score uses it) |
| Its creator (and admins) | only the person who created it, and firm admins |
| Each user only their own key | each person writes only the key named by their own user number — for per-person values |

It also has two limits: the **largest value** (64 KB by default) and the **most
keys** (1,000 by default).

**Edit rules** changes the description, the rule or the limits. **Delete
namespace** deletes it and every value in it; you must type its name to
confirm. Only the namespace's creator or a firm admin may do either. Anyone
else sees the reason the server gives.

## Keys and values

A namespace's page lists its keys with the start of each value, its
**revision** (rev) and who wrote it last. **More keys** loads the next 100.
**New key** adds one.

Click a key to see its whole value. Under it, **Change it** lets you edit the
value and **Save**.

**Two people changing the same value.** Each value has a revision number that
goes up with every change. A save only goes through if the value is still at
the revision you opened. If someone changed it first, the page says so, shows
what is there now and who wrote it, and offers **Retry my change** on the new
revision — your text is kept, so you can decide whether to save it over theirs.
Nothing is ever overwritten without you seeing it first.

**Delete key** asks first, and also refuses if someone changed the value since
you opened it.

## History

Every change is recorded: who made it, when, the value before and the value
after, and the revision. A namespace's page shows its whole history; a key's
page shows just that key's. **Older** loads further back.

Namespace changes are recorded too (created, rules changed, deleted). The
history **outlives a delete**: a deleted namespace is no longer listed, but
typing its name in **History by name** (the box at the bottom of the first
screen) and pressing **Open** shows its history, under a note that it no longer
exists. For a namespace that still exists, the same box simply opens it.
Changes made by an admin viewing as someone else (View-as) show both people.

**A name used twice.** If a namespace is deleted and another is later created
with the same name, they share one history: the new namespace's history also
shows the old one's changes. Each **namespace created** row marks where one of
them began.

The history is never trimmed today.

## For tool writers

A tool on the launcher reads and writes shared values through the shell, with
the signed-in person's login: `window.parent.ycTool.apiSend(path, method,
body, { quiet: true })` (see [Tool actions](11-tool-actions.md)).

| Call | What it does |
|---|---|
| `GET /api/shared/<ns>/<key>` | read one value: `{ value: { v, rev, updated_by, updated_at, … } }`; 404 if there is none yet |
| `PUT /api/shared/<ns>/<key>` `{ v, rev }` | write it. `rev: null` creates it (refused if it exists); otherwise the rev you read. A lost race is a 409 whose `current` is the value now there — re-check it and try again |
| `DELETE /api/shared/<ns>/<key>?rev=<n>` | delete it, only from that revision |
| `GET /api/shared/<ns>` | the namespace's keys and values, a page at a time |
| `GET /api/shared/<ns>/_history` | its history, newest first (`?k=<key>` for one key) |

Values are strings: store JSON as a string. Show them with `textContent`,
never as HTML — any staff member can write any text. Who wrote a value
(`updated_by`) is stamped by the server and cannot be faked; what the value
says is up to whoever wrote it.
