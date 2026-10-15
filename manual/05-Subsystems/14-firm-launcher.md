# Firm Launcher — hide, rename and add launcher items for the whole firm

**Where:** More → YisraCase Config → **Firm** tab → **Launcher** section.
**Who:** staff holding the *firm settings* permission — the **admin**, **IT** and
**SU** roles. Nobody else sees the Firm tab, and the server refuses their saves
anyway: the tab being hidden is not what protects it.
**Stored as:** one firm-wide document (`ui_config`, key `registry_overrides`),
with every save kept in a history.

## What it is

The launcher is every way into a feature: the sidebar, the Home tiles, the More
Features and Admin grids, the **All** tab and the **Ctrl-K** (⌘K) search. The
Launcher section changes it for **everyone at the firm** in three ways:

| Part | What it does |
|---|---|
| **Hide** | Takes a feature off every launcher surface — sidebar, Home, the grids, All and the Ctrl-K search. |
| **Rename** | Gives a feature a firm name, shown everywhere that feature appears (for example *Cases* → *Matters*). |
| **Firm items** | Adds the firm's own entries — a link, a tool or a saved view — listed under **Firm** in All and found by Ctrl-K. |

The Firm tab is a page of sections. Launcher is the first; firm-wide settings
from other areas join it as sections of their own.

## Hiding is decluttering, not security

**Hiding a feature removes its button. It does not take away anyone's access to
it.** What a person may open is decided by their role, and the server enforces
that whether or not a button is showing. Hide what your firm doesn't use; never
hide something to keep it from someone.

Two items can't be hidden — **Settings** and **Help & Support**. Their Hide
checkbox is greyed out, can't be ticked, and is labelled *Always*. The **All**
tab isn't an item at all; it's always there, so nobody can lose their way back.

## Hide and rename

One row per feature, grouped the way the **All** tab groups them (Records,
Actions, Settings, More, Admin).

- **Hide** — tick it to take that feature off everyone's launcher.
- **Rename to** — type the firm's name for it. Leave it empty to keep the usual
  name, which shows greyed in the box. Up to 40 characters, plain text.
- **Custom Tab** can be hidden but not renamed: each person titles their own.

## Firm items

Each firm item has a **label**, an **icon** and what it **opens**:

| Opens | You choose | How it opens |
|---|---|---|
| **Link** | an address: `https://…` for another site, or an app path like `/reports` | in a new window |
| **Tool** | one of the **live** tools from the list | over the app, in a dialog |
| **Saved view** | one of the active saved views | over the app, in a dialog |

- **Icon** is a [Font Awesome](https://fontawesome.com/icons) name, such as
  `money-check` or `calendar`. A preview shows beside the box; a question mark
  means the name isn't valid.
- **Order** — the arrow buttons move an item up or down. Firm items show in this
  order under **Firm** in the All tab.
- **Delete** — the bin button.
- **Tools** are written by SU (Admin → **Tools (SU)**); the list here shows only
  the ones that are **live**. **Saved views** come from YisraView (More → Views).
- A link may not point at a tool page or a saved view directly (`/tool/…`,
  `/customView…`): those only work inside the app, so pick **Tool** or **Saved
  view** for them instead.
- Firm items appear in **All** and **Ctrl-K** only. They don't get a tile on Home
  or the grids yet.

**An item's id is permanent.** The id (shown under the item, like
`firm:payroll`) is made from the label the first time the item is saved. After
that, renaming the item changes its label but never its id. Other settings
point at items by id, so a new item never takes an id the launcher settings still
refer to — it gets `firm:payroll-2` instead.

## Saving

**Save** (top right) shows only while there are unsaved changes; the line
beside the section title says *Unsaved changes* or *All changes saved*.

- Your own launcher changes **straight away**, without reloading.
- **Everyone else** sees the change the next time they load YisraCase.
- If a box is outlined in red, fix it first — the message under it says why.
  The server checks every save again and can refuse one; its reason shows under
  the field it is about.
- **Refresh** (and reloading or closing the app) asks before throwing away
  unsaved changes. Switching to another Config tab and back keeps them.

If a save says ***Your session predates a permissions change — sign out and back
in***, do exactly that: your sign-in was issued before your permissions were set,
and signing in again picks them up.

If a save says ***Another admin saved changes since you opened this — reload to
see them; your edits are kept until you reload***, someone saved the launcher
after you opened the page. Nothing of theirs was overwritten and nothing of yours
was saved. **Refresh** to load their version (it asks before discarding your
edits), then make your changes again. Restore checks the same way.

## History and restore

**History** (beside the section title) lists the latest 200 saved versions,
newest first, with who saved it and when. The one in use is marked **current**.

- **View** shows what a version hid, renamed and added, without changing
  anything.
- **Restore** makes that version the firm's launcher again, for everyone. It is
  saved as a new version, so a restore can itself be undone from History.
  Restoring discards any unsaved changes on the page (it asks first).
- A very old version can be refused if it breaks a rule added since it was
  saved; the message lists what's wrong with it, and nothing changes.

## Not here (yet)

- **Locking** items so a person can't remove them from their own launcher, and
  **personal layouts**: these come with per-user launcher editing.
- **Placing** firm items on Home or the grids.
- Per-role launchers.
