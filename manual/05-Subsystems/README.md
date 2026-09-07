# Subsystems — Smaller Self-Contained Tools

This section collects the firm's smaller, self-contained **staff** tools — each a
complete system in its own right, but not big enough to warrant a top-level
manual section of its own like YisraForms or YisraFlow do. Every one of these
lives behind the **More** menu in the main navigation.

Tools a *client* touches — the portal, booking pages, manage links, document
requests, landing pages — moved to [06-Client-Facing](../06-Client-Facing/).

## Contents

| # | File | What it is |
|---|------|----|
| 1 | [01-YisraVideo.md](01-YisraVideo.md) | Home-grown video sharing — upload once, share through any channel, track who watched. (More → Video Manager) |
| 2 | [02-redirects.md](02-redirects.md) | Short, branded links (`app.4lsg.com/r/<slug>`) for long URLs like Clio payment links. (More → Redirects Manager) |
| 3 | [03-feature-requests.md](03-feature-requests.md) | Staff feature-request and bug board — submit, vote, comment, track stages. (More → Feature Requests) |
| 4 | [04-reports.md](04-reports.md) | Saved questions that answer with a number — charts, filters, CSV, scheduled emails, and an AI that drafts new ones. (More → Reports) |
| 5 | [05-YisraView.md](05-YisraView.md) | Working lists built on the same engine — filter, sort, and click straight into a case. Pin one to your own sidebar tab. (More → Views) |
| 6 | [06-documents.md](06-documents.md) | The Documents registry: how files in Dropbox reach a case, the Sync panel that operates it, and the guided workflow for re-linking a case that points at the wrong folder. (More → Documents) |
| 7 | [07-checklists.md](07-checklists.md) | Checklists and notes — one board, two shapes; the `docs_needed` list the sending form, document requests and the portal all read; derived vs manual status. |
| 8 | [08-asset-manager.md](08-asset-manager.md) | The shared asset store — uploads, collections, the picker other tools read from, and why delete is a soft delete. (More → Asset Manager) |
| 9 | [09-issue-reports.md](09-issue-reports.md) | Support Inbox — the Help & Support button, what it captures automatically, and why it is deliberately not the feature-request board. (More → Support Inbox) |
| 10 | [10-court-review.md](10-court-review.md) | The court review queue — what lands there, the four resolutions, the openness rule that defines "still needs review", and why dismiss is terminal. |
| 11 | [11-calendar-types.md](11-calendar-types.md) | The calendar item-type registry — appointment/event types, their keys, and which staff pickers offer them at which lengths. (More → Case Config → Calendar Types) |
| 12 | [12-calendar-tab.md](12-calendar-tab.md) | The unified Calendar tab — appointments and events in one list over a date window, its filters, its state/resolution badges, and the deadline outcome prompts. (Sidebar → Calendar) |

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
  sequences, scheduled jobs, YisraHook, email/phone ingest, triggers.
- **[Integrations](../04-Integrations/)** — Connections (credentials),
  RingCentral, Google Calendar, Dropbox.
- **[Client-Facing](../06-Client-Facing/)** — the portal, booking pages, manage
  links, document requests, landing pages.
