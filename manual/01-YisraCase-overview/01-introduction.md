# YisraCase — Introduction

YisraCase is a legal case management system built for a small law firm. It tracks every person the firm works with, the legal matters those people are involved in, every appointment that has been scheduled, and the billing that flows from that work. On top of that foundation sits a full automation engine that sends SMS messages, emails, creates calendar events, assigns tasks, and runs multi-step workflows — all without leaving the system.

This documentation is the authoritative reference for everyone who uses or administers YisraCase. It is organized into parts. This part covers the core concepts: what the system is, how its main building blocks fit together, and the basic mechanics of each.

---

## The Core Building Blocks

Everything in YisraCase revolves around a small set of interconnected record types. Understanding how they connect is the most important thing to grasp first.

**Contacts** are people. A contact record holds a person's name, phone, email, address, date of birth, and other identifying information. Every other record in the system ultimately traces back to one or more contacts.

**Matters** (called *cases* internally) are the legal engagements the firm takes on. A case always has at least one contact attached to it as the primary client. It can have additional contacts as well — spouse, co-debtor, or others. Cases track the type of matter, its stage in the legal process, court filing information, and a full history of activity.

> **Leads** are prospective matters that have not yet been formally opened. They are ordinary case records — there is no separate "Lead" stage — but they have their own dedicated tab in the interface, separate from the main Cases tab.

**Appointments** are scheduled meetings — consultations, strategy sessions, 341 meetings, and so on. An appointment always belongs to a contact. It usually also belongs to a case, but it does not have to (for example, an initial consultation before a case has been opened). The appointment record tracks the date, time, type, platform, attending staff member, and outcome status.

**Bills** will track what clients owe and what they have paid. The billing tab exists in the interface but the full feature is not yet implemented. See the Bills section for the current stub and planned scope.

---

## How the Records Connect

```
Contact ──────────────── Case (or Lead)
   │         (one contact can be on many cases;
   │          one case can have many contacts)
   │
   └── Appointment ─────── Case (optional)
          (an appt always has a contact;
           it may also be tied to a specific case)

Contact / Case / Appt / Bill
   └── Tasks  (linked to any of the above)
   └── Log    (activity history, linked to any of the above)
```

The relationship between contacts and cases is managed through a linking table. A person can be the primary client on one case, a secondary client on another, and a bystander on a third — the system models complex family and co-debtor situations accurately.

Appointments sit at the intersection of contacts and cases. When you pull up a contact, you see all their appointments. When you pull up a case, you see all the appointments tied to that case. The appointment is always anchored to the contact — the case link is supplementary context.

Tasks and log entries can be linked to a contact, a case, an appointment, or a bill. They appear on the relevant record's detail view regardless of which direction you navigate to them.

---

## Navigation Basics

YisraCase is organized into tabs down the left sidebar, in this order:

| Tab | What it is |
|---|---|
| **Home** | Landing screen with the global search box |
| **Cases** | Active and historical matters — searchable and filterable by type, stage, and status. Leads live here too; they are cases at an early stage, not a separate tab |
| **Contacts** | Search, browse, and open contact records |
| **Appointments** | All scheduled meetings; filterable by date range, type, and status |
| **Calendar** | Appointments *and* events in one list over a date window — see [Calendar tab](../05-Subsystems/12-calendar-tab.md) |
| **Events** | Dated obligations and milestones, distinct from appointments — see [Events](08-events.md) |
| **Tasks** | Your personal task queue |
| **Log** | The activity log across records — see [Activity log](06-activity-log.md) |
| **Bills** | Billing records *(placeholder; full feature in progress)* |
| **Pipeline Board** | Where every case sits by stage and lane — see [Pipelines](13-pipelines.md) |
| **Custom** | Your own pinned view, if you've pinned one — see [YisraView](../05-Subsystems/05-YisraView.md) |
| **Settings** | Personal and firm settings |
| **Admin** | Firm administration. Hidden unless your account has the authorization for it |
| **More Features** | Everything else — see below |

Opening any record takes you to a detail page that shows everything connected to it: related contacts or cases, appointments, tasks, and the full activity log.

### The More menu

Most of this manual's smaller systems don't have a sidebar tab of their own —
they live behind **More Features**, and the section READMEs refer to that as
"the **More** menu." What you'll find there:

- **Staff tools** — Reports, Views, Documents, Video Manager, Redirects Manager,
  Asset Manager, Form Builder, Form Inbox, Campaigns, Case Config, Court
  Preview, Feature Requests, Support Inbox, Signatures, Automations, Manuals
  (this manual). Covered in [05-Subsystems](../05-Subsystems/),
  [02-YisraForms](../02-YisraForms/), [03-YisraFlow](../03-YisraFlow/) and
  [07-ESign](../07-ESign/).
- **Client-facing managers** — Portal Manager, Booking Manager, Availability
  Manager, Landing Pages. Covered in [06-Client-Facing](../06-Client-Facing/).
- **Super-user tools**, marked **(SU)** and invisible to everyone else — DB
  Console, Readonly Keys, API Tester, API Keys, System Alerts, Connections,
  Users. Covered in [08-Admin-Tools](../08-Admin-Tools/) and
  [04-Integrations](../04-Integrations/).

There is also a **Help & Support** button at the bottom of the sidebar — one
textarea that files a report with the technical state attached automatically.

---

## A Note on Terminology

The system uses some shorthand internally that differs from what appears on screen:

| Screen label | Internal name | Notes |
|---|---|---|
| Matter / Lead | `case` / `cases` table | All legal engagements, at every stage |
| Contact | `contact` / `contacts` table | All people the firm works with |
| Appointment | `appt` / `appts` table | All scheduled meetings |
| Staff / Attorney | `user` / `users` table | Firm employees with system logins |

Throughout this documentation, "matter" and "case" are used interchangeably. A Lead is simply a case that has not been worked yet.
