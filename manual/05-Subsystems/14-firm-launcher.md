# Firm Launcher — hide, rename, add and arrange launcher items for the whole firm

**Where:** More → YisraCase Config → **Firm** tab → the **Launcher** and **Who sees
what** sections; the Launcher section's **Arrange pages and defaults…** opens the
arrangement editor.
**Who:** staff holding the *firm settings* permission — the **admin**, **IT** and
**SU** roles. Nobody else sees the Firm tab, and the server refuses their saves
anyway: the tab being hidden is not what protects it.
**Stored as:** two firm-wide documents (`ui_config`, keys `registry_overrides`
for hides, renames, firm items and who sees what, and `layout` for the
arrangement), with every save of either kept in a history.

## What it is

The launcher is every way into a feature: the sidebar, the Home tiles, the More
Features and Admin grids, the **All** tab and the **Ctrl-K** (⌘K) search. The
Launcher section changes it for **everyone at the firm** in three ways:

| Part | What it does |
|---|---|
| **Hide** | Takes a feature off every launcher surface — sidebar, Home, the grids, All and the Ctrl-K search. |
| **Rename** | Gives a feature a firm name, shown everywhere that feature appears (for example *Cases* → *Matters*). |
| **Firm items** | Adds the firm's own entries — a link, a tool, a saved view or a **page** — as tiles on More Features, under **Firm** in All, and in Ctrl-K. |
| **Arrange** | Sets out the **More Features** and **Admin** pages, the **Home** and **sidebar** everyone starts from, and the tiles of the firm's own pages (see [Arranging pages and defaults](#arranging-pages-and-defaults)). |

The Firm tab is a page of sections: the firm's settings first (see
[Firm and system settings](15-firm-and-system-settings.md)), then **Launcher**
and **Who sees what** (below), which decides which roles and people see each
item.

## Hiding is decluttering, not security

**Hiding a feature removes its button. It does not take away anyone's access to
it.** What a person may open is decided by their role, and the server enforces
that whether or not a button is showing. Hide what your firm doesn't use; never
hide something to keep it from someone.

Three items can't be hidden — **Settings**, **Help & Support** and **All**.
Their Hide checkbox is greyed out, can't be ticked, and is labelled *Always*.
All is always there (the small grid icon under everyone's Home tiles, and
Ctrl-K), so nobody can lose their way back.

## Hide and rename

One row per feature, grouped the way the **All** tab groups them (Records,
Actions, Settings, More, Admin).

- **Hide** — tick it to take that feature off everyone's launcher.
- **Rename to** — type the firm's name for it. Leave it empty to keep the usual
  name, which shows greyed in the box. Up to 40 characters, plain text.

## Firm items

Each firm item has a **label**, an **icon** and what it **opens**:

| Opens | You choose | How it opens |
|---|---|---|
| **Link** | an address: `https://…` for another site, or an app path like `/reports` | in a new window |
| **Tool** | one of the **live** tools from the list, and a **Dialog size** | over the app, in a dialog |
| **Saved view** | one of the active saved views, and a **Dialog size** | over the app, in a dialog |
| **Page** | nothing more here — its tiles are arranged after it is saved (see [Firm pages](#firm-pages)) | as a main tab of its own, like More Features |

- **Icon**: press **Choose…** and pick any free
  [Font Awesome](https://fontawesome.com/icons) icon: solid, regular or a brand
  logo. Search by name or a related word; the families filter the list. The
  icon and its name show beside the button. See
  [Choosing an icon](../01-YisraCase-overview/15-your-launcher.md#choosing-an-icon).
- **Order** — the arrow buttons move an item up or down. Firm items show in this
  order under **Firm** in the All tab, and in the More grid's firm row until
  the firm arranges More Features.
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
- Firm items appear in **All** and **Ctrl-K**, and as tiles on More Features:
  in a row of their own at the **end of the More grid**, in this order, until
  the firm arranges More Features — from then on, wherever the arrangement puts
  them (and nowhere on More if it leaves one out). The arrangement can also
  give one a firm-wide tile on Home, a row on the sidebar or a place on the
  Admin page ([Arranging pages and defaults](#arranging-pages-and-defaults)), and
  each person can pin one to their own Home or sidebar
  ([Your own launcher](../01-YisraCase-overview/15-your-launcher.md)).

**An item's id is permanent.** The id (shown under the item, like
`firm:payroll`) is made from the label the first time the item is saved. After
that, renaming the item changes its label but never its id. Other settings
point at items by id, so a new item never takes an id the launcher settings still
refer to — it gets `firm:payroll-2` instead.

## Arranging pages and defaults

**Arrange pages and defaults…** (at the top of the Launcher section) opens the
arrangement editor over the app: a card on a computer, the whole screen on a
phone. It has four tabs:

| Tab | What it arranges |
|---|---|
| **Home & sidebar** | The **Home** tiles, the small buttons under them, and the **sidebar** that everyone starts from. |
| **More Features** | The More Features page: its tiles, where a row breaks, where your firm items sit, and the small buttons under the tiles (Casey's paw). |
| **Admin** | The Admin page: its tiles, rows and small buttons. |
| **Firm pages** | Each of the firm's own pages: its tiles and its small buttons (see [Firm pages](#firm-pages)). |

Each section lists that part as everyone sees it now, top to bottom, with the
same buttons as each person's own editor
([Customizing Home and the sidebar](../01-YisraCase-overview/15-your-launcher.md#customizing-home-and-the-sidebar)):
**↑ / ↓** to move, the **eye with a slash** to hide a standard item, **×** to
remove one you added, **Add a shortcut** (on the small-button rows, **Add a
small button**), **Add a row break** on Home, More Features and Admin, and
**Add a section label** on the sidebar. Tags say **Firm** (one of your firm
items) or **Added** (not there in the app's standard layout). A dot on a tab
means it has unsaved changes.

- **The More Features list starts with the page as it is.** Until you save an
  arrangement of More Features, your firm items sit at its end, after a row
  break, exactly as the page shows them. Move them where you want them (for
  example, Get Clio Code up into the row with a gap), and take out a row
  break you no longer need with its **×**.
- **All always stays** among the small buttons under the Home tiles: it can
  move, but not leave (the row shows **Always here**). The sidebar's All is an
  ordinary item.
- A hidden feature (ticked **Hide** in the Launcher section) isn't offered: it
  shows nowhere. Save a new firm item here first, then arrange it.
- **Save** keeps the arrangement for everyone. It saves on its own, not with
  this page's Save. Your own screen changes straight away; everyone else gets it
  the next time they load YisraCase.
- **Reset to standard** puts one part back to the app's standard layout (it
  asks first; it takes effect when you Save).
- If someone else saved the arrangement after you opened the editor, Save says
  so and keeps your changes on screen. Nothing of theirs is overwritten.
  **Reload the firm's arrangement** shows theirs, discarding your changes.

**What people see.** Everyone's More Features and Admin pages follow the
arrangement. Home and the sidebar are where each person **starts**: someone who
has already arranged their own Home or sidebar keeps it, and a later change
here only **adds** new items for them, next to their neighbours (Reset in their
own editor brings back the firm's). The Admin page still shows each person only the
tiles they can open, and only people allowed the Admin page see it (**Who sees
what**). Like Hide, arranging is about tidiness, not access.

**Who.** Anyone who can open this tab: the admin, IT and SU roles. The admin
role can arrange the Admin page too.

## Firm pages

A **firm page** is a tab of tiles like More Features, made by the firm for
everyone who sees it: a heading, big tiles, a row of small buttons under them.
It is a **firm item** of kind **Page**, so its name, icon and who sees it live
in this tab; what is on it lives in the arrangement.

1. **Make it:** in **Firm items**, **Add item**, set **Opens** to **Page**, give
   it a label and an icon, and **Save** the page. (Its id, `firm:<slug>`, is
   permanent from here on, like any firm item's.)
2. **Fill it:** press **Arrange its tiles…** on the item's row (it is greyed
   until the item is saved). The arrangement editor opens on its **Firm pages**
   tab, at this page: **Tiles** (any feature, More Features or Admin panel, or
   firm item — a page never holds itself; **Add a row break** starts a new row;
   up to 100 entries) and **Small buttons** (up to 12). **Save** there.
3. **Decide who sees it** in **Who sees what**, like any firm item: Everyone,
   or Hidden except the ticked roles (SU always). A person who may not see it
   has no tab, no tile and no row for it anywhere, and can't open it from All,
   Ctrl-K or a shortcut. Blocking a page hides the page, not what is on it:
   the features on it stay in that person's All.

What people see: everyone the page is visible to gets it as a main tab — from
its tile on More Features (the firm row, or wherever the arrangement puts it),
a tile or row they add to their own Home or sidebar, All, Ctrl-K or a
shortcut. A **panel** tile on the page (Automations, Users…) opens that panel
on the page itself, with the page's own pill strip; each person still sees
only the tiles they may open (a superuser-only tool is simply not on the page
for anyone else). Like More Features, the page's tiles are the firm's to
arrange, not each person's; people arrange their own pages instead
([Your own launcher → Pages](../01-YisraCase-overview/15-your-launcher.md#pages)).

Reloading the browser while on a firm page lands on Home (the address bar
never names a page); More Features and Admin come back as before.

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
A switch at its top chooses which settings: **Hide, rename and items** (this
page's Save, including Who sees what) or **Pages and defaults** (the
arrangement).

- **View** shows what a version hid, renamed, added and restricted to roles —
  or, for the arrangement, each part's tiles row by row and what it hides, and
  each firm page's tiles and small buttons — without changing anything.
- **Restore** makes that version the firm's launcher again, for everyone. It is
  saved as a new version, so a restore can itself be undone from History.
  Restoring hide / rename / items discards any unsaved changes on the page (it
  asks first). Restoring an arrangement is refused if someone saved the
  arrangement after the list opened: reopen History to see the newest.
- A very old version can be refused if it breaks a rule added since it was
  saved; the message lists what's wrong with it, and nothing changes.

## Not here (yet)

- **Locking** items so a person can't hide them from their own Home or
  sidebar. The launcher honours a lock (a locked item shows *Locked* in each
  person's editor and can't be hidden there), but this page has no control to
  set one yet. Personal layouts themselves are each person's own:
  [Your own launcher](../01-YisraCase-overview/15-your-launcher.md).
- Per-role launcher **layouts** (a different arrangement for each role). **Who
  sees what** decides which items a role sees, not where they sit.
- Hides by role or for the whole firm aren't offered under **Hidden from these
  people**: use **Hidden, except** for roles, and Hide for the whole firm.
- **People's own buttons.** Each person can add buttons of their own (links,
  tools, saved views, lists holding several items, and pages of their own).
  The firm's Hide and **Who sees what** don't reach those buttons, because
  they are that person's own; a feature or firm item the firm hides, or keeps
  from someone, still drops out of that person's lists and pages. See
  [Your own launcher → My buttons](../01-YisraCase-overview/15-your-launcher.md#my-buttons).
