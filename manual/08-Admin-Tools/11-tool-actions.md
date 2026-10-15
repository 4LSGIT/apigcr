# Tool actions — writing a tool the firm can put on its launcher (SU)

**Write it:** Admin → **Tools (SU)** (see [Tools](06-tools.md)).
**Place it:** More → YisraCase Config → **Firm** → Launcher → **Firm items**
(see [Firm Launcher](../05-Subsystems/14-firm-launcher.md)).
**Who:** a super-user writes the tool; a firm admin (admin, IT or SU) places it.

## The idea

When the firm wants a button that *does* something — fetch a code and show it,
run a check, open a short form — the button is a **tool**. There is no special
"action" kind of launcher item: a super-user writes a small tool page that does
the job, and a firm admin adds it as a firm item that opens that tool. It then
appears:

- as a tile at the end of the **More** grid (the firm row),
- under **Firm** in the **All** tab,
- in the **Ctrl-K** (⌘K) search.

Clicking it opens the tool in a dialog over the app. **Get Clio Code** is the
first one built this way (worked example below).

## The tool shell API

A tool runs in a frame inside YisraCase. It talks to the app through one
object, `window.parent.ycTool`. That object never hands out the sign-in token,
so a tool never needs to touch it.

| Member | What it does |
|---|---|
| `version` | `1`. New members may be added; existing ones never change meaning. |
| `apiSend(path, method, body, { quiet })` | Calls the YisraCase API as the signed-in person. Returns a promise of the response. `path` must start with `/` (another site is refused). Errors reject with the server's message (`err.status`, `err.body`). See *Quiet or blocking* below. |
| `authReady()` | `true` while a sign-in exists and hasn't expired. Never asks anyone to sign in. |
| `toast(message, kind)` | Shows the app's small notice at the top. Plain text, up to 300 characters. `kind`: `success`, `error`, `warning`, `info` (the default) or `question`. |
| `close(window)` | Closes the dialog your tool is in. Pass your own `window`. |
| `resize(size, window)` | Switches your dialog between `'compact'` and `'large'`. Pass your own `window`. |
| `openCase(caseId, window)` | Opens a case file. If your tool is in the dialog, the dialog closes first, so the file is in front. |
| `openContact(contactId, window)` | The same for a contact. `contactId` is a number. |
| `exec(id)` | Opens any launcher item by its id (`cases`, `moreReports`, `firm:payroll`, …), exactly as clicking it would; an open tool dialog closes first. Items the person can't see are refused. |

Details that matter:

- **Pass `window` to `close`, `resize`, `openCase` and `openContact`.** That is
  how the app knows the call comes from the tool in the dialog. A tool that is
  not in a dialog (for example one shown on someone's custom tab) gets `false`
  from `close` and `resize`, and nothing happens.
- `openCase` / `openContact` look the id up first. An id that doesn't exist, or
  isn't a valid id, opens nothing and returns `false`.
- Apart from `apiSend`, every member returns `true` / `false` (the two `open…`
  members a promise of it), so a tool can tell whether it worked. None of them
  throws for a bad argument.

## A minimal tool

A contact finder: type a name, click a result to open the contact.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/theme.css">
  <script src="/themeSync.js"></script>
</head>
<body style="background: var(--surface); padding: 12px">
  <input id="q" placeholder="Name"> <button id="go">Find</button>
  <ul id="out"></ul>
  <script>
    const T = window.parent.ycTool;
    const out = document.getElementById('out');
    if (!T) out.textContent = 'Open this from YisraCase.';
    else document.getElementById('go').onclick = async () => {
      out.textContent = '';
      try {
        const d = await T.apiSend('/api/search', 'GET', { q: document.getElementById('q').value, type: 'contact', limit: 10 });
        for (const r of d.results || []) {
          const li = document.createElement('li');
          li.textContent = r.name;                 // server text: always as text
          li.onclick = () => T.openContact(r.id, window);
          out.appendChild(li);
        }
        if (!out.children.length) T.toast('No matches', 'info');
      } catch (e) {
        T.toast(e.message, 'error');
      }
    };
  </script>
</body>
</html>
```

`/theme.css` plus `/themeSync.js` give the page the app's colours and keep it
in step with light and dark mode. Use the colour names in `theme.css`
(`var(--surface)`, `var(--text)`, `var(--accent)`, …) rather than fixed colours.

## Quiet or blocking

By default `apiSend` behaves like every screen in the app: if the sign-in has
expired, it shows the **sign-in box** and carries on after the person signs in.
That is right when the person just clicked something.

It is wrong for work that runs **by itself** — a timer that checks every few
seconds. If the sign-in lapses while it waits, a sign-in box would pop up over
the tool out of nowhere. For that, pass `{ quiet: true }`:

```js
T.apiSend('/clio-code', 'GET', null, { quiet: true })
```

With no valid sign-in, a quiet call fails straight away (`err.name` is
`'ToolAuthError'`) and shows nothing. Skip that round and try again later; the
person's next click signs them in as usual. You can also check `T.authReady()`
before a round.

A quiet call checks only the sign-in the browser holds. It does not stop the
prompts that come from the server's answer: if the server turns the request
down as signed out (rare), the normal sign-in box still appears, and if the
route is a super-user one asking for the password step-up, the password
prompt still appears. Don't poll SU-only routes from a background loop.

## Size

The dialog comes in two sizes, never in pixels:

- **Large** (the default) — the big working dialog. On a phone it fills the
  screen.
- **Compact** — a small card in the middle of the screen, for something like a
  code or a short form. It stays a card on a phone.

The firm item chooses the size the tool opens in (**Dialog size** on the item).
The tool can switch with `T.resize('compact', window)` or
`T.resize('large', window)`, for example when it moves from a short question to
a long result.

## Placing it (firm admin)

1. The tool must be **live** in Admin → Tools (SU).
2. More → YisraCase Config → **Firm** → Launcher → **Firm items** → **Add**.
3. Give it a label and an icon, set **Opens** to **Tool**, pick the tool, and
   choose the **Dialog size**.
4. **Save**. Your own launcher updates straight away; everyone else's on their
   next load.

## What a tool must never do

- **Read the sign-in token.** Not `AUTH_STATE`, not `localStorage`, not the
  app's own `apiSend` internals. The token only ever travels inside
  `ycTool.apiSend`. A tool that reads it is a leak waiting for a bug.
- **Open itself in its own window or tab.** Outside the app a tool has no
  sign-in, so every call fails. Tool items open in the dialog only; opening one
  in a window is a separate decision that hasn't been made.
- **Put server text into the page as HTML.** Use `textContent`. A name with
  `<` in it is text, not markup.
- **Carry data in its HTML.** A live tool's page is served without a sign-in
  (see [Tools](06-tools.md)). Fetch data through `apiSend`, which does need one.

Older tools that call `window.parent.apiSend` directly keep working. New tools
use `ycTool`.

## Worked example: Get Clio Code

The Clio sign-in code tool. It shows the latest code if it is fresh (under
three minutes old). If the last code is older, it says so — showing the old
code inside a sentence that says it won't work — and checks every 5 seconds for
up to 2 minutes for the new one. Meanwhile it nudges the app's job queue so the
new code arrives in seconds rather than at the next minute tick. Those
background checks are **quiet**, so a sign-in that lapses while it waits never
pops a sign-in box. **Copy Code** copies the code and closes the dialog;
clicking the code itself copies it and leaves the dialog open, as does
clicking the old code in the waiting message.

Its source is kept in the repository at `ref/tools/clio-code.html`. That file's
header has the install steps:

1. Admin → Tools (SU) → **New tool**: key `clio-code`, title *Get Clio Code*,
   paste the whole file, save, set it **live**.
2. Firm tab → Firm items → **Add**: label *Get Clio Code*, icon `c`, Opens
   **Tool** → *Get Clio Code*, Dialog size **Compact**. Save.

If the tool is changed in Tools (SU), copy the new version back into that file,
so the repository and the live tool stay the same.
