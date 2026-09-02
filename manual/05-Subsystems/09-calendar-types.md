# Calendar Types — the item-type registry and picker options

**Where:** More → Case Config → **Calendar Types** tab.
**Tables:** `calendar_item_types` (identity), `calendar_type_options` (what pickers offer).
**Design:** `ref/UNIFIED_EVENTS_DESIGN_V0_5.md` §3.3 (A1). Shipped in Unified Events U2 (read layer) and U2b (this page + options).

## What it is

Every appointment and event in YisraCase carries a `type_key` — `iss`, `pre_filing`,
`confirmation_hearing`, `docs_deadline` … — and this page is the one place that
key vocabulary is defined. Sequences cascade on it, the 341 singleton rule reads
it, the court executor and booking views write it. Labels, lengths, aliases and
scoping are all data here; **keys are permanent**.

Two tables, deliberately:

| | `calendar_item_types` | `calendar_type_options` |
|---|---|---|
| Answers | *What is this appointment?* | *What does a staff picker show?* |
| One row per | type (`type_key`) | (type, length) |
| Referenced by | appts, events, booking views, court matches, sequence filters | nothing — appts store `type_key` + `appt_length` |
| Carries | label, kind, singleton, blocks, client-attends, default length, ingest aliases, **case types** | length, optional label override, **surfaces**, sort, active |
| Applies to | every kind | meeting types only |

A **meeting type with no option rows is offered in no staff appointment
picker.** It still resolves, still books through booking views / court / the
API. Nothing appears in a dialog by accident.

## The table

Grouped by kind. Filter by kind, tick *show inactive*. Columns:

- **#** sort order · **Label** · **Key** (mono; a lock icon means rows reference it)
- **Single** singleton · **Blocks** whose availability it blocks · **Client** client attends
- **Len** `default_length` — the fallback when no option is chosen (API, court, booking)
- **Picker options** chips like `15m·new+f/u` — one per option row; click to edit
- **Case types** — `all`, or the case types this type is scoped to
- **Aliases** count (hover for the list) · **Refs** total references (hover for the breakdown)
- **Active** toggle — inactive types leave every picker; existing rows keep resolving

Row click → the type editor. **New Type** (topbar or toolbar) → the same editor;
the key is auto-suggested from the label until you edit it.

## Rules the server enforces (the page just explains them)

- `type_key`: `^[a-z][a-z0-9_]{1,39}$`, unique, **never changes** after create.
- `kind` **locks** once anything references the key, or once it has picker
  options. Kind routes storage (meeting → `appts`, everything else → `events`),
  so changing it under live rows would orphan them. Create a new type instead.
- **Resolver unambiguity:** no two rows may claim the same string (case-
  insensitive, trimmed) as key, label or alias. A collision is refused naming
  the other row. An alias equal to the row's own label is refused too — the
  label already resolves by itself.
- **Delete** only at zero references; otherwise deactivate. Deleting a type
  removes its option rows with it.
- Options: length 1–1440, at least one surface, one row per (type, length).

## Surfaces

| Surface | Where |
|---|---|
| `new_client` (**new**) | the first-appointment box in *Add New Client* |
| `follow_up` (**f/u**) | *Schedule Appointment* on a case, a contact, the calendar, the shell Appointments tab |

Both pickers pass the case's type when they know it, so a type scoped to
*Bankruptcy* hides on a Civil Litigation case (and shows when no case type is
chosen yet).

### Editing options

Click a type's option chips. Each row: minutes, optional label override
(picker text only — the saved appointment always carries the type's own
label), surfaces, sort, active. Save per row; *Add* on the bottom row. Changes
reach the pickers immediately (the server drops its 60-second cache on every
write; open dialogs re-fetch when their case changes, or on next open).

Two lengths of one type are two rows — that is the point. "Strategy Session
Follow Up" is 15 and 30; "Schedules Completion Meeting" is 45 on both surfaces
and 20 on follow-up only. After any pick the length field stays editable, so an
odd 25-minute booking needs no option row.

## The Appointments-tab filter

Separate from the pickers above, and driven by the registry rather than by
`calendar_type_options`: the **Type** dropdown on the shell's Appointments tab
lists every *active* `kind='meeting'` type, in registry order. Surfaces do not
apply — this filters existing appointments, it does not offer new ones — so a
meeting type with no option rows still appears here.

It filters on `appts.type_key`, not on the label. That matters: an appointment
booked years ago as "Follow Up" or "Pre-filing (30 min)" carries `ss_follow_up`
/ `pre_filing` today, and only a keyed filter finds it.

Three fixed entries bracket the list:

| Entry | Means |
|---|---|
| **Default** | everything except the 341 |
| **All** | no type filter |
| **Other** | every appointment whose key is *not* one of the listed types — unmapped (`type_key IS NULL`) included |

*Other* is the complement of the list, computed on the server from the same
registry the dropdown reads. So an appointment keyed to a hearing type, or to a
type someone later deactivated, is always reachable from exactly one entry —
nothing falls between the options, and adding a meeting type in Case Config
moves it out of *Other* on the next cache turn.

## Unmapped types (footer)

"N rows carry an unmapped type" counts events with `type_key IS NULL AND
kind='other'` and appts with `type_key IS NULL`. *View* lists them read-only.
To fix one: add its stored string as an alias on the right type (or create
the type), then the backfill re-resolves it. Minting a type *from* an unmapped
row is U9.

## If the registry is unreachable

The two appointment dialogs fall back to their pre-U2b hardcoded lists
(`YC_APPT_TYPE_FALLBACK` in `scripts.js`). A registry outage never blanks a
dialog. The fallback only needs touching if a type is renamed.

The Appointments-tab filter does the same (`APPTS_TYPE_FALLBACK` in
`index.html`) — a short list, but still keyed, so it filters correctly. *Other*
narrows to unmapped-only in that state rather than claiming every appointment.

## API

```
GET    /api/calendar-types                       registry rows (event pickers, the Appointments-tab filter)
GET    /api/calendar-types/options?surface=…[&case_type=…]   picker options (appointments)
GET    /api/calendar-types-admin                 every row + refs + options
GET    /api/calendar-types-admin/unmapped
GET    /api/calendar-types-admin/case-types
GET    /api/calendar-types-admin/:type_key
POST   /api/calendar-types-admin                 create
PUT    /api/calendar-types-admin/:type_key       partial update
DELETE /api/calendar-types-admin/:type_key
POST   /api/calendar-types-admin/:type_key/options
PUT    /api/calendar-types-admin/options/:id
DELETE /api/calendar-types-admin/options/:id
```
