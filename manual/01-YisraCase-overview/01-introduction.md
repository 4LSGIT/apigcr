# YisraCase — Introduction

YisraCase is a legal case management system built for a small law firm. It tracks every person the firm works with, the legal matters those people are involved in, every appointment that has been scheduled, and the billing that flows from that work. On top of that foundation sits a full automation engine that sends SMS messages, emails, creates calendar events, assigns tasks, and runs multi-step workflows — all without leaving the system.

This documentation is the authoritative reference for everyone who uses or administers YisraCase. It is organized into parts. This part covers the core concepts: what the system is, how its main building blocks fit together, and the basic mechanics of each.

---

## The Core Building Blocks

Everything in YisraCase revolves around a small set of interconnected record types. Understanding how they connect is the most important thing to grasp first.

**Contacts** are people. A contact record holds a person's name, phone, email, address, date of birth, and other identifying information. Every other record in the system ultimately traces back to one or more contacts.

**Matters** (called *cases* internally) are the legal engagements the firm takes on. A case always has at least one contact attached to it as the primary client. It can have additional contacts as well — spouse, co-debtor, or others. Cases track the type of matter, its stage in the legal process, court filing information, and a full history of activity.

> **Leads** are prospective matters that have not yet been formally opened. They use the same case record structure, but with a stage of "Lead." Leads have their own dedicated tab in the interface, separate from the main Cases tab.

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

YisraCase is organized into tabs in the main interface:

- **Contacts** — search, browse, and open contact records
- **Leads** — prospective matters filtered to Lead stage; dedicated follow-up view
- **Cases** — active and historical matters; searchable and filterable by type, stage, and status
- **Appointments** — all scheduled meetings; filterable by date range, type, and status
- **Tasks** — your personal task queue
- **Bills** — billing records *(placeholder; full feature in progress)*
- **Settings** — documentation, workflow manager, and admin tools

Opening any record takes you to a detail page that shows everything connected to it: related contacts or cases, appointments, tasks, and the full activity log.

---

## A Note on Terminology

The system uses some shorthand internally that differs from what appears on screen:

| Screen label | Internal name | Notes |
|---|---|---|
| Matter / Lead | `case` / `cases` table | All legal engagements, at every stage |
| Contact | `contact` / `contacts` table | All people the firm works with |
| Appointment | `appt` / `appts` table | All scheduled meetings |
| Staff / Attorney | `user` / `users` table | Firm employees with system logins |

Throughout this documentation, "matter" and "case" are used interchangeably. A Lead is simply a case at an early stage.
