# YisraCase — Manual

The system's documentation, kept next to the code it describes and served in the
app at **More → Manuals**.

## Sections

| # | Section | What's in it |
|---|---|---|
| 1 | [YisraCase Overview](01-YisraCase-overview/) | The records the firm works with every day — contacts, matters, appointments, tasks, events, pipelines — and the screens that manage them. **Start here.** |
| 2 | [YisraForms](02-YisraForms/) | The internal form framework: building forms, the config reference, templates, the builder, public forms. |
| 3 | [YisraFlow](03-YisraFlow/) | Everything that runs by itself — workflows, sequences, scheduled jobs, YisraHook, email/phone ingest, triggers. |
| 4 | [Integrations](04-Integrations/) | Connections (the credential store) and the services built on it: RingCentral, Google Calendar, Dropbox. |
| 5 | [Subsystems](05-Subsystems/) | Smaller self-contained **staff** tools behind the More menu — reports, views, documents, checklists, and the rest. |
| 6 | [Client-Facing](06-Client-Facing/) | Everything a **client** touches — the portal, booking pages, manage links, document requests, landing pages. |
| 7 | [E-Signature](07-ESign/) | Templates, placements, sending, tracking and filing signed documents. |
| 8 | [Admin Tools](08-Admin-Tools/) | Super-user only: DB console, readonly keys, API tester, system alerts, API keys. |

## How to read it

Each section has a **README** listing its chapters with a one-line description.
Most chapters open with a **For operators** part — plain English, what it does
and how to use the screen — followed by a **Technical reference** for everyone
else. Read as much as you need and stop.

If you're new, read
[01-introduction](01-YisraCase-overview/01-introduction.md) first: it explains
the building blocks, the navigation, and where the More menu leads.

## How it's maintained

- **Section READMEs are load-bearing.** `routes/manuals.js` harvests each TOC
  table at request time — the third column becomes the chapter description in
  the app, and the prose around the table becomes the section intro and outro.
  A chapter missing from its README still lists, but renders with no
  description.
- **`tests/manualReadmeCoverage.test.js` guards that**: every chapter listed,
  every description non-empty, every relative link resolvable. Run it after
  adding or moving a page.
- **Adding a chapter** means dropping the `.md` in the folder *and* adding its
  row to the section README. Nothing else — the file list is generated from the
  filesystem.
- **When code and docs disagree, the code wins.** Where a chapter quotes a
  count or a list that lives in code, it says which endpoint serves the live
  version. Prefer linking to that over restating it.
