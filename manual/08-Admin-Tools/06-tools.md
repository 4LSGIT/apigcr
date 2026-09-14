# Tools (SU)

A place to write small internal HTML utilities and have them live at a real
URL, without adding a file to the codebase or waiting for a deploy. You paste
(or write) a page, give it a key, flip it live, and it is served at
`/tool/<your-key>`.

**Where:** Admin → **Tools**. SU only, and — like every tool in this section —
it asks for your password first (see the elevation note in the section intro).

## What a tool is

An ordinary HTML page stored in the database. When someone opens
`/tool/<key>`, the page is served on the app's own origin and runs inside the
shell exactly like the built-in screens do, which means it can call the API
through the shell's `apiSend` without any setup of its own. That is the whole
point: a tool gets the same access a normal YisraCase screen has.

**So a tool is trusted code, not a sandbox.** Nothing stops a tool from doing
anything a logged-in screen can do. The protection is that only a super-user
with elevation can write one — not that the page is somehow contained. Don't
paste in HTML you didn't read, and don't treat the Tools screen as a safe
place to try a snippet from the internet.

## Writing one

1. **New tool.** Give it a **key** — lowercase letters, numbers and hyphens,
   up to 80 characters (`month-end-check`, `trustee-lookup`). The key is the
   URL, and it has to be unique.
2. Give it a **title** (what you'll see in the list) and paste the **HTML**.
3. Leave the **status** on **draft** while you work.
4. When it's ready, switch the status to **live**.

## Draft vs live

This is the only thing standing between your page and anyone who knows the
URL:

- **draft** — `/tool/<key>` returns 404. Only you, in this screen, can see it.
- **live** — `/tool/<key>` is served to anyone who requests it. **There is no
  login on that URL.**

So treat "live" as publishing. A tool that displays client data is readable by
whoever has the link, and a link gets forwarded. If a utility only makes sense
for staff, the safe pattern is to have it *fetch* its data through the API —
the API still requires the caller to be logged in — rather than baking any
real data into the page body.

Pages are served with no-cache and `noindex, nofollow`, so search engines
won't pick them up, but that is not access control.

## Version history

Every save that actually changes the HTML keeps a copy. The list of saved
versions sits alongside the editor, newest first, with who saved it and when.

- **Restore** copies an old version back into the tool. It doesn't delete
  anything — restoring is itself a save, so you can always go forward again.
- **Delete** removes a single old version. You cannot delete the newest one,
  because the newest saved version is the tool's current content — the screen
  will refuse with an error rather than leave the history out of step.
- Changing only the title or the status does **not** create a version. Only
  content changes do.

## Deleting a tool

Deleting a tool deletes its whole version history with it, and frees the key
for reuse. There is no undo and no trash — if you might want the HTML back,
copy it out first. The URL starts returning 404 immediately.

## What gets logged

Creating, editing, deleting and restoring all write to the admin audit log
with your username. Opening a tool or reading its history does not — reads
aren't audited anywhere in this section.
