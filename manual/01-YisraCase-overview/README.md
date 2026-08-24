# YisraCase — Overview

The core of the system: the records the firm works with every day, and the
screens that manage them. Everything else in this manual — forms, automation,
integrations, the smaller tools — is built on top of the entities described
here.

Start with the introduction if you're new. Otherwise the chapters are
independent: read the one matching the record you're working with.

## Contents

| # | File | What's in it |
|---|------|----|
| 1 | [01-introduction.md](01-introduction.md) | What YisraCase is, how the main building blocks fit together, how this manual is organized |
| 2 | [02-contacts.md](02-contacts.md) | Contacts — the person record everything else hangs off. Fields, relationships, tags, dedupe |
| 3 | [03-matters.md](03-matters.md) | Matters (cases) — a legal engagement, its stages, its attached contacts |
| 4 | [04-appointments.md](04-appointments.md) | Appointments — scheduling, confirmations, calendar events, the follow-up automation they fire |
| 5 | [05-tasks.md](05-tasks.md) | Tasks — action items assigned to staff, linked to a contact, case, appointment or bill |
| 6 | [06-activity-log.md](06-activity-log.md) | The activity log — append-only history on a contact or case, and how entries get there |
| 7 | [07-bills.md](07-bills.md) | Bills — placeholder; billing is planned for a future release |
| 8 | [08-events.md](08-events.md) | Events — dated obligations and milestones, distinct from appointments and tasks. Calendar sync and the daily digest |
| 9 | [09-users-and-staff.md](09-users-and-staff.md) | Users — staff logins, auth levels, and how actions are attributed to a person |
| 10 | [10-sending-form.md](10-sending-form.md) | The Sending Form — composing and sending messages and document requests to case contacts |
| 11 | [11-campaign-manager.md](11-campaign-manager.md) | Campaign Manager — bulk SMS and email to filtered groups, personalization, scheduling |
| 12 | [12-sync-bus.md](12-sync-bus.md) | The sync bus — how every open screen, frame, and browser window hears about data changes. Developer reference: what announces, who listens, the fences, and the honest list of what it doesn't cover |

---

## Where to go next

- **[YisraForms](../02-YisraForms/)** — the internal form framework that these
  records are edited through.
- **[YisraFlow](../03-YisraFlow/)** — the automation umbrella: workflows,
  sequences, scheduled jobs, YisraHook, triggers.
- **[Integrations](../04-Integrations/)** — Connections (credentials),
  RingCentral, Google Calendar, Dropbox.
- **[Subsystems](../05-Subsystems/)** — the smaller self-contained tools behind
  the **More** menu.
