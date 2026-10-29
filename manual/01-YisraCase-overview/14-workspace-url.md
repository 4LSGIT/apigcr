# Keeping your place: F5, updates and shared links

YisraCase keeps your workspace in the browser's address bar. Refreshing the page (F5), the automatic reload after a YisraCase update, or opening a link someone sent you brings you back to the same place — the same open files, the one you were looking at, and the tab you had open inside it.

---

## What is remembered

| You had… | After F5, an update or a shared link |
|---|---|
| Case and contact files open in the sidebar | The same files reopen, in the same order |
| One of them on screen | That file is the one showing |
| A tab open inside a case or contact file (Documents, Tasks, Case Log, …) | The file opens on that tab |
| A main tab on screen instead (Cases, Calendar, Tasks, …) | That tab is the one showing |
| Comms on its Phone or Team tab | Comms opens on that tab |
| A panel open on a firm page — **More Features**, **Admin** or another — or on a tab of its own (Automations, Manuals, …) | The panel reopens |
| A panel that is on no page, open on a tab of its own (opened from All or Ctrl+K) | It reopens on that tab |
| One of your **firm's pages** on screen, with or without a panel open on it | The page reopens, and the panel on it |
| A tab inside **Automations** (Workflows, Triggers, Activity, …) or **YisraCase Config** (Pipelines, Custom Fields, Firm, …) | The panel reopens on that tab |

The address bar updates as you work, so it is always current — there is nothing to save.

---

## What is not remembered

- **Where you were inside a tab:** scroll position, filters, search text, a selected row, an open conversation or a folder you browsed to. The tab reopens in its normal starting state.
- **An old link to More Features or Admin** (from when they were fixed tabs)
  still works: it opens the firm page of that name, with the same panel open
  (or that panel on a tab of its own).
- **Anything you are not allowed to see.** If a link points at a tab or panel the person opening it doesn't have, they land on Home or on the page without that panel instead — quietly, with no error. A file that can't be found is skipped, with a short "could not be reopened" notice.
- **Unsaved form edits.** A reload is still a reload: save your work first.
- **A button of your own that opens as a tab.** The address never names one (it would carry your button's name), so a reload or a link from one starts on Home. See [Buttons that open as a tab](15-your-launcher.md#buttons-that-open-as-a-tab).
- **A page of your own.** The address never names one of your own pages, so a reload or a link from one starts on Home. Its name is something you typed, and the address is recorded with every request the app makes, so it is kept out. Your firm's pages are different: they come back (see the table above). See [Pages](15-your-launcher.md#pages) and [Firm pages](../05-Subsystems/14-firm-launcher.md#firm-pages).

---

## Sharing a link

Copy the address bar and send it to a colleague: it opens the same files and tabs for them (subject to their own access).

The link carries **record numbers only** — never a client's name or anything you typed — so it is safe to paste into an email or a chat.

---

## Links in emails

The links YisraCase puts in its emails — the task and event digests, appointment and event lists from automations, callback reminders — open **the exact file** they name. Links in older emails still work.

---

## Updates

When a new version of YisraCase is released, the update prompt reloads the page through the same address, so you keep every open file and tab.

---

## For developers

How it works — the address format, the per-page vocabulary, how a new page joins, and the tests — is in `ref/AI_CONTEXT.md` §12, **Workspace URL**, and the WORKSPACE URL comment block in `public/index.html`.
