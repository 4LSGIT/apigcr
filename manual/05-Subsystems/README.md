# Subsystems — Smaller Self-Contained Tools

This section collects the firm's smaller, self-contained **staff** tools — each a
complete system in its own right, but not big enough to warrant a top-level
manual section of its own like YisraForms or YisraFlow do. Most live behind the
**More** menu in the main navigation; each row below says where to find it.

Tools a *client* touches — the portal, booking pages, manage links, document
requests, landing pages — moved to [06-Client-Facing](../06-Client-Facing/).

## Contents

| # | File | What it is |
|---|------|----|
| 1 | [01-YisraVideo.md](01-YisraVideo.md) | Home-grown video sharing — upload once, share through any channel, track who watched. (More → Video Manager) |
| 2 | [02-redirects.md](02-redirects.md) | Short, branded links (`app.4lsg.com/r/<slug>`) for long URLs like Clio payment links. (More → Redirects Manager) |
| 3 | [03-feature-requests.md](03-feature-requests.md) | Staff feature-request and bug board — submit, vote, comment, track stages. (More → Feature Requests) |
| 4 | [04-reports.md](04-reports.md) | Saved questions that answer with a number — charts, filters, CSV, scheduled emails, and an AI that drafts new ones. (More → Reports) |
| 5 | [05-YisraView.md](05-YisraView.md) | Working lists built on the same engine — filter, sort, and click straight into a case. Put one on your own Home or sidebar. (More → Views) |
| 6 | [06-documents.md](06-documents.md) | The Documents registry: how files in Dropbox reach a case, the Sync panel that operates it, and the guided workflow for re-linking a case that points at the wrong folder. (More → Documents) |
| 7 | [07-checklists.md](07-checklists.md) | Checklists and notes — one board, two shapes; the `docs_needed` list the sending form, document requests and the portal all read; derived vs manual status. |
| 8 | [08-asset-manager.md](08-asset-manager.md) | The shared asset store — uploads, collections, the picker other tools read from, and why delete is a soft delete. (More → Asset Manager) |
| 9 | [09-issue-reports.md](09-issue-reports.md) | Support Inbox — the Help & Support button, what it captures automatically, and why it is deliberately not the feature-request board. (More → Support Inbox) |
| 10 | [10-court-pipeline.md](10-court-pipeline.md) | The court email pipeline — the review queue and its openness rule, the Court Preview tuning tool, and the registry-driven parser v2 being built alongside. |
| 11 | [11-calendar-types.md](11-calendar-types.md) | The calendar item-type registry — appointment/event types, their keys, and which staff pickers offer them at which lengths. (More → YisraCase Config → Calendar Types) |
| 12 | [12-calendar-tab.md](12-calendar-tab.md) | The unified Calendar tab — appointments and events in one place, two views: the filterable List with state badges and quick actions, and the month/week/day Grid with kind colors, provider filters and blocked/free shading. (Sidebar → Calendar) |
| 13 | [13-custom-fields.md](13-custom-fields.md) | Firm-defined fields on cases and contacts — the field registry, its editor, and the rules keys and options follow. Define a field and it appears by itself: on both record screens, in reports, in trigger conditions and in templates, with no developer involved — and, optionally, with a default value stamped onto new records as they are created. (More → YisraCase Config → Fields) |
| 14 | [14-firm-launcher.md](14-firm-launcher.md) | The firm's launcher, for everyone at once: hide features you don't use, rename them, and add the firm's own links, tools, saved views and pages (a tab of tiles like More Features, arranged in the editor's Firm pages tab, blocked per role with Who sees what); arrange the More Features and Admin pages and the Home and sidebar everyone starts from; choose which roles and people see each item — with a history you can restore from. Hiding declutters; it is not security. (More → YisraCase Config → Firm) |
| 15 | [15-firm-and-system-settings.md](15-firm-and-system-settings.md) | Where every firm-wide setting lives and who may change it — the Firm tab's sections (identity, senders, routing, booking, Dropbox, e-sign, automation variables), the System tab (IT), the tool-owned settings, history and restore, and why the vocabulary tabs are read-only for most staff. (More → YisraCase Config → Firm / System) |
| 16 | [16-contact-roles.md](16-contact-roles.md) | The contact role types — trustee, judge, mediator — that the contact form's Roles section offers: each type's permanent code, its structured fields, and why an option that looks like a number is stored as one. (More → YisraCase Config → Contact Roles) |
| 17 | [17-ask-yisracase.md](17-ask-yisracase.md) | The read-only conversational assistant — ask about firm records, YisraCase, general knowledge, or current weather; searches auto-run and cited records open in place. (More → Ask YisraCase) |

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
