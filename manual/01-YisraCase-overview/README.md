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
| 2 | [02-contacts.md](02-contacts.md) | Contacts — the person record everything else hangs off. Fields, the multi-value phone/email/address tables, contact-to-contact relationships, tags, and how search actually matches |
| 3 | [03-matters.md](03-matters.md) | Matters (cases) — a legal engagement, its stages, its attached contacts |
| 4 | [04-appointments.md](04-appointments.md) | Appointments — scheduling, confirmations, calendar events, the follow-up automation they fire |
| 5 | [05-tasks.md](05-tasks.md) | Tasks — action items assigned to staff, linked to a contact, case, appointment or bill |
| 6 | [06-activity-log.md](06-activity-log.md) | The activity log — append-only history on a contact or case, and how entries get there |
| 7 | [07-bills.md](07-bills.md) | Bills — placeholder; billing is planned for a future release |
| 8 | [08-events.md](08-events.md) | Events — dated obligations and milestones, distinct from appointments and tasks. Calendar sync and the daily digest |
| 9 | [09-users-and-staff.md](09-users-and-staff.md) | Users — staff logins, auth levels and roles, who can host appointments, and how actions are attributed to a person |
| 10 | [10-sending-form.md](10-sending-form.md) | The Sending Form — composing and sending messages and document requests to case contacts |
| 11 | [11-campaign-manager.md](11-campaign-manager.md) | Campaign Manager — bulk SMS and email to filtered groups, personalization, scheduling |
| 12 | [12-sync-bus.md](12-sync-bus.md) | The sync bus — how every open screen, frame, and browser window hears about data changes. Developer reference: what announces, who listens, the fences, and the honest list of what it doesn't cover |
| 13 | [13-pipelines.md](13-pipelines.md) | Pipelines — where a case is (stages, lanes, the intake→matter hand-off) and what's left to do (derived requirements, overrides), the Steps panel, the board, the portal card, and the automation guards that move cases forward but never back |
| 14 | [14-workspace-url.md](14-workspace-url.md) | Keeping your place — what F5, an update reload or a shared link brings back (open files, the tab inside a file, Comms' tab, the open More/Admin panel), what it doesn't, and why email links open the exact file |
| 15 | [15-your-launcher.md](15-your-launcher.md) | Your own launcher — All and Ctrl+K, arranging your own Home tiles and sidebar (move, hide, add shortcuts, row breaks and section labels), hide versus remove, reset, what the firm's hides, renames, locks and firm items do to it, your own keyboard shortcuts (which combinations are blocked and why, the AltGr note), and My buttons — your own buttons for a saved view, a tool or a website link (links always open in a new window; up to 50; placing them and binding them to shortcuts; a view or tool button that opens as a tab, up to 3 kept open; where the old custom tab went), lists — a button that opens a small menu of up to 30 items (making one, opening it, what drops out of it, one level deep), and pages — a tab of your own tiles like More Features (arranging it, panels opening on it, F5 lands on Home); choosing an icon in the icon picker (every free Font Awesome icon: solid, regular and brands); Code — running pasted JavaScript as yourself (Ctrl+K → code; runs as you, every run recorded first, only run code from someone you trust) |
| 16 | [16-communications-tab.md](16-communications-tab.md) | The Communications tab on a contact and a case — one feed of email, texts, calls and court mail; source-backed items (gated by your mailbox and phone-line access) versus Logged-only items (whatever the Log tab shows); how a contact's ownership dates and a case's strict scope decide what lands there, Include contact communications (never Bystanders), why a text sent from a case is missing from the strict feed, search and filters, reply / text back / attachments / case tags, and Send / log… |
| 17 | [17-text-opt-outs.md](17-text-opt-outs.md) | Text opt-outs — what a client's STOP / START does on its own (every firm line, automated texts stop), which words count, the phone companies' own blocks and the one confirmation YisraCase sends, the stranded-client and review tasks and who gets them, how a client comes back, and IT's checks (the inbound wiring script, the nightly consent sync) |

---

## Where to go next

- **[YisraForms](../02-YisraForms/)** — the internal form framework that these
  records are edited through.
- **[YisraFlow](../03-YisraFlow/)** — the automation umbrella: workflows,
  sequences, scheduled jobs, YisraHook, triggers.
- **[Integrations](../04-Integrations/)** — Connections (credentials),
  RingCentral, Google Calendar, Dropbox.
- **[Subsystems](../05-Subsystems/)** — the smaller self-contained staff tools
  behind the **More** menu.
- **[Client-Facing](../06-Client-Facing/)** — the portal, booking pages, manage
  links, document requests and landing pages clients see.
- **[E-Signature](../07-ESign/)** — templates, placements, sending and filing.
