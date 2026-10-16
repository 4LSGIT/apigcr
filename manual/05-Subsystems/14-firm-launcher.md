# Firm Launcher — hide, rename and add launcher items for the whole firm

**Where:** More → YisraCase Config → **Firm** tab → the **Launcher** and **Who sees
what** sections.
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
| **Firm items** | Adds the firm's own entries — a link, a tool or a saved view — as tiles at the end of the More grid, under **Firm** in All, and in Ctrl-K. |

The Firm tab is a page of sections. **Launcher** is the first; **Who sees what**
(below) decides which roles and people see each item. Firm-wide settings from
other areas join them as sections of their own.

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
| **Tool** | one of the **live** tools from the list, and a **Dialog size** | over the app, in a dialog |
| **Saved view** | one of the active saved views, and a **Dialog size** | over the app, in a dialog |

- **Icon** is a [Font Awesome](https://fontawesome.com/icons) name, such as
  `money-check` or `calendar`. A preview shows beside the box; a question mark
  means the name isn't valid.
- **Order** — the arrow buttons move an item up or down. Firm items show in this
  order in the More grid's firm row and under **Firm** in the All tab.
- **Delete** — the bin button.
- **Dialog size** (tools and saved views): **Large**, the big working dialog
  (full screen on a phone), or **Compact**, a small card for something short
  like a code. Items saved before this choice existed open Large.
- **Tools** are written by SU (Admin → **Tools (SU)**); the list here shows only
  the ones that are **live**. A tool is how the firm gets a button that *does*
  something — see [Tool actions](../08-Admin-Tools/11-tool-actions.md).
  **Saved views** come from YisraView (More → Views).
- A link may not point at a tool page or a saved view directly (`/tool/…`,
  `/customView…`): those only work inside the app, so pick **Tool** or **Saved
  view** for them instead.
- Firm items appear as tiles in a row of their own at the **end of the More
  grid**, in this order, and in **All** and **Ctrl-K**. They don't get a
  firm-wide tile on Home, the sidebar or the Admin grid; each person can pin one
  to their own Home or sidebar
  ([Your own launcher](../01-YisraCase-overview/15-your-launcher.md)).

**An item's id is permanent.** The id (shown under the item, like
`firm:payroll`) is made from the label the first time the item is saved. After
that, renaming the item changes its label but never its id. Other settings
point at items by id, so a new item never takes an id the launcher settings still
refer to — it gets `firm:payroll-2` instead.

## Who sees what

The second section decides who sees each launcher item. It lists every item —
the features and the firm's own saved items — grouped like the **All** tab.

**Everyone or Hidden, except.** Each item is set to one of two things:

- **Everyone** — the default. Every person at the firm sees it.
- **Hidden, except…** — the item is hidden from everyone *except* the roles you
  tick: Admin, Attorney, Staff, IT, Form dev, Automation. A person sees it if
  they hold **at least one** ticked role. **SU** is always ticked and can't be
  unticked: superusers always see everything. Ticking nothing else means only
  superusers see it.

**New roles see nothing restricted.** A role only sees a restricted item if
someone ticks it. A role added to YisraCase later starts out ticked on nothing,
so it doesn't see any restricted item until you tick it here.

**Settings** and **Help & Support** are always *Everyone* and can't be changed.
An item ticked **Hide** in the Launcher section is hidden from everyone,
superusers included, whatever this section says.

Role choices are kept by the page's **Save**, together with any Launcher
changes, in one save.

**Hidden from these people.** Under each item, you can hide it from particular
people, for example "hide Automations from this one person". Pick the person
and press **Hide**. Press **×** beside a name to stop hiding it from them. The
list offers active users only.

- These per-person changes are **saved the moment you make them**. They aren't
  part of **Save**, and **Refresh** doesn't undo them.
- They reach that person the next time they load YisraCase.
- A per-person hide applies even if the person holds a ticked role, and it
  applies to superusers too.

**This is decluttering, not security.** Like Hide, this only removes buttons.
It doesn't take away anyone's access to a feature: what a person may open is
decided by their role, and the server enforces that whether or not a button is
showing.

## Saving

**Save** (top right) shows only while there are unsaved changes; the line
beside each section title says *Unsaved changes* or *All changes saved*. One
**Save** keeps both sections' changes together. The per-person hides under
**Who sees what** are the exception: they save as you make them.

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

- **View** shows what a version hid, renamed, added and restricted to roles,
  without changing anything.
- **Restore** makes that version the firm's launcher again, for everyone. It is
  saved as a new version, so a restore can itself be undone from History.
  Restoring discards any unsaved changes on the page (it asks first).
- A very old version can be refused if it breaks a rule added since it was
  saved; the message lists what's wrong with it, and nothing changes.

## Not here (yet)

- **Locking** items so a person can't hide them from their own Home or
  sidebar. The launcher honours a lock (a locked item shows *Locked* in each
  person's editor and can't be hidden there), but this page has no control to
  set one yet. Personal layouts themselves are each person's own:
  [Your own launcher](../01-YisraCase-overview/15-your-launcher.md).
- **Placing** firm items for everyone anywhere but the More grid's firm row (a
  firm-wide spot on Home, the sidebar, or in a grid).
- Per-role launcher **layouts** (a different arrangement for each role). **Who
  sees what** decides which items a role sees, not where they sit.
- Hides by role or for the whole firm aren't offered under **Hidden from these
  people**: use **Hidden, except** for roles, and Hide for the whole firm.
