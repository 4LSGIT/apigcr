# 7 — Checklists and Notes

## For operators

One board, two shapes. A **checklist** is a title plus tickable items; a **note**
is a title plus freeform text. Same table, same screen — the Google Keep model.

Either can be attached to a **case**, a **contact**, or a **person** (your own
personal list). Personal lists are what most staff use day to day; case lists
are what the rest of the system leans on.

### The one that matters to everything else

Every case can carry a **documents checklist** — the list of what we still need
from the client. It is special because three other systems read it:

- the [Sending Form](../01-YisraCase-overview/10-sending-form.md) builds the
  "homework assignment" message from it,
- the [document request](../06-Client-Facing/05-document-requests.md) page shows
  the client what's outstanding,
- the [client portal](../06-Client-Facing/02-client-portal.md) does the same.

Tick an item here and it disappears from what the client is being asked for.

**That list is identified by its tag, not its title.** You can rename it to
anything — the tag is what the other systems match on. Which is also why the tag
is shown as a badge you can't edit: staff own titles, machines own tags.

### Status works differently for the two shapes

- **A checklist's status is derived.** You don't set it; it follows the items.
  Tick them all and it's complete.
- **A note's status is manual.** It has no items to derive from, so you set it
  directly.

### Things the screen won't let you do, and why

| | Why |
|---|---|
| Add items to a note, or a body to a checklist | The two shapes are mutually exclusive |
| Convert a note into a checklist or back | It would strand your text or your items, so it's refused rather than guessing which to lose |
| Delete someone else's personal list, or re-home it away from them | It's theirs |

**But you can absolutely work on someone else's list** — create one for them,
add items, tick them off, rename them. Delegation is the point. Only
*detachment* is gated. Reads are never gated.

### Duplicate-list errors

At most **one tagged list per entity, per shape, per tag** — so a case can hold
both a `docs_needed` checklist *and* a `docs_needed` note, but not two of
either. Untagged lists are unlimited. If you get a conflict creating one, a
tagged list of that shape already exists.

---

## Technical reference

### Files

```
routes/api.checklists.js       All routes, both authed and public
lib/checklistStatus.js         Derives checklist status from items
services/portalDocsService.js  Reads the docs list for the portal
public/checklistsView.html     The board
public/checklistView.html      One list
```

### Kind is immutable

`kind` is `'checklist'` or `'note'`, set at creation and **rejected by PATCH**
thereafter. The routes enforce exclusivity in both directions: a note rejects
`items`, a checklist rejects `body`, each with a message naming the reason.

The split inverts the status rule:

| Kind | Status |
|---|---|
| `checklist` | **Derived** from items by `lib/checklistStatus.js` |
| `note` | **Manual** — PATCH writes it, and `checklistStatus` refuses to recompute it |

Manual note status deliberately emits **no domain event**. `note.completed`
would be additive to add later and breaking to remove, so it stays out until
something needs it.

### The `docs_needed` predicate lives in two places

The case documents checklist is identified by `tag='docs_needed'`, **not by
title** — titles are staff-editable. The same predicate lives in
`services/portalDocsService.js` (`listDocs`, `_caseItemMap`).

> **Change one without the other and the client portal and document-request
> pages silently go blank.** No error, no empty-state message — just nothing.

### Ownership

`link_type='user'` rows are gated **against detachment only**, via
`mayDetachPersonal()`: deleting one, or re-homing it away from its owner.
Creating a list *for* another user, and adding, checking, renaming or removing
its items, are all open — delegation is the design. Reads are never gated.

`mayDetachPersonal()` is deliberately not exported. Test it the way
`tests/portalDocsRoutes.js` tests its route: mount the router in a real express
app on an ephemeral port with `jwtOrApiKey` mocked to inject `req.auth`, and
drive owner / non-owner / SU / api_key across PATCH and DELETE over HTTP. That
exercises the gate where it actually runs.

### Tags are a system field

Writes to `tag` on either table are **api_key or SU only**, via
`mayWriteTag()`. Surfaces should render a tag as an immutable badge, never an
input.

### Uniqueness

```sql
UNIQUE KEY uq_link_kind_tag (link_type, link, kind, tag)
```

At most one tagged row per entity per kind per tag; untagged rows are unlimited
because MySQL exempts rows with a NULL in the key. POST and PATCH surface a
violation as **409, not 500**. `upsert-items` instead *recovers* from it — a
concurrent caller winning the insert race is not an error there.

### API

**Authed:**

| Route | Method | Purpose |
|---|---|---|
| `/checklists` | GET, POST | List with filters and item counts / create |
| `/checklists/:id` | GET, PATCH, DELETE | One list (+items); DELETE cascades items |
| `/checklists/:id/items` | POST | Add an item |
| `/checkitems/:id` | PATCH, DELETE | Update name/status, or remove |
| `/checklists/upsert-items` | POST | Find-or-create the `docs_needed` list and upsert items |

**Public — unauthenticated, `case_id` is the only capability:**

| Route | Method | Purpose |
|---|---|---|
| `/api/public/docs/:caseId` | GET | Name + incomplete docs items. Rate limited |
| `/api/public/get-upload-link` | POST | Dropbox temp upload link. Rate limited |
| `/api/public/upload-complete` | POST | Notifies staff + logs. Rate limited |

> Treat every value off `req.body` / `req.params` on those three as hostile:
> bind it into SQL, and `escapeHtml()` it before it reaches an email body.

### Tables

| Table | Columns |
|---|---|
| `checklists` | `id`, `title`, `kind`, `body`, `status`, `tag`, `link_type`, `link`, `created_by`, `created_date`, `updated_date` |
| `checkitems` | `id`, `checklist_id`, `name`, `status`, `position`, `tag`, `created_date`, `updated_date` |

Checklists emit domain events, so trigger rules can fire when one is finished —
see [triggers](../03-YisraFlow/15-triggers.md).
