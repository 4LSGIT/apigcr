# Subsystems — Smaller Self-Contained Tools

This section collects the firm's smaller, self-contained tools — each a
complete system in its own right, but not big enough to warrant a top-level
manual section of its own like YisraForms or YisraFlow do. Every one of these
lives behind the **More** menu in the main navigation.

| # | File | What it is |
|---|------|----|
| 1 | [01-YisraVideo.md](01-YisraVideo.md) | Home-grown video sharing — upload once, share through any channel, track who watched. (More → Video Manager) |
| 2 | [02-redirects.md](02-redirects.md) | Short, branded links (`app.4lsg.com/r/<slug>`) for long URLs like Clio payment links. (More → Redirects Manager) |
| 3 | [03-landing-pages.md](03-landing-pages.md) | Hosted marketing/intake pages, optionally on a custom domain, with form submissions wired into a YisraHook. (More → Landing Pages) |
| 4 | [04-feature-requests.md](04-feature-requests.md) | Staff feature-request and bug board — submit, vote, comment, track stages. (More → Feature Requests) |
| 5 | [05-document-requests.md](05-document-requests.md) | Asking a client for documents and receiving them back — no attachments, no logins, nothing landing on our servers. |
| 6 | [06-reports.md](06-reports.md) | Saved questions that answer with a number — charts, filters, CSV, scheduled emails, and an AI that drafts new ones. (More → Reports) |
| 7 | [07-YisraView.md](07-YisraView.md) | Working lists built on the same engine — filter, sort, and click straight into a case. Pin one to your own sidebar tab. (More → Views) |
| 8 | [08-documents.md](08-documents.md) | The Documents registry: how files in Dropbox reach a case, the Sync panel that operates it, and the guided workflow for re-linking a case that points at the wrong folder. (More → Documents) |
| 9 | [09-calendar-types.md](09-calendar-types.md) | The calendar item-type registry — appointment/event types, their keys, and which staff pickers offer them at which lengths. (More → Case Config → Calendar Types) |
| 10 | [10-calendar-tab.md](10-calendar-tab.md) | The unified Calendar tab — appointments and events in one list over a date window, its filters, its state/resolution badges, and the deadline outcome prompts. (Sidebar → Calendar) |

> **Reports and Views are the same system.** One saved SQL definition, one
> curated schema, one set of guards — a report renders it as a number, a view
> renders it as a clickable list. Read whichever matches the question you have;
> each page links to the other.

---

## Bigger systems with their own section

These are also "subsystems," but each is large enough to have its own top-level
manual section. They're linked here so this is one place to see everything:

- **[YisraForms](../02-YisraForms/)** — the internal form framework (replaces
  JotForm).
- **[YisraFlow](../03-YisraFlow/)** — the automation umbrella: workflows,
  sequences, scheduled jobs, YisraHook, email router.
- **[Integrations](../04-Integrations/)** — Connections (credentials),
  RingCentral, Google Calendar, Dropbox.