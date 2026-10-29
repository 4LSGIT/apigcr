# Firm and System settings — where every firm-wide setting lives

**Where:** More → YisraCase Config → the **Firm** tab (the firm's own
settings) and the **System** tab (IT's). A few settings live with the tool
they belong to — Portal Manager → Settings, CTA Links → Link defaults — and
the vocabularies have their own Config tabs.
**Who:** the Firm tab needs the *firm settings* permission (admin, IT, SU);
the System tab needs the *system settings* permission (IT and SU — not
admin). Without it a tab does not show, and the server refuses the save
anyway.
**Stored as:** one row per setting in `app_settings` (the value), described
by the settings registry in code (`lib/settingsRegistry.js`), with every
change kept in `app_settings_versions`.

## One editor per setting

Every setting has exactly one place where it is changed:

| Where | What |
|---|---|
| Config → **Firm** | Firm identity, senders, notifications & routing, client self-service & booking, Dropbox filing, E-Sign, marketing email & consent, and the firm's automation variables |
| Portal Manager → **Settings** | The client portal's switch, branding, senders and assignees — see [the client portal](../06-Client-Facing/02-client-portal.md) |
| Config → **Lists** | The lead sources offered on a case, and the legacy event-type list |
| Config → **Types & Subtypes** | Case types (with usage checks and pipeline repointing) |
| CTA Links → **Link defaults** | How long a CTA link lasts when minted without an expiry — see [CTA links](../08-Admin-Tools/07-cta-links.md) |
| Config → **System** | Platform wiring, kill switches, alert thresholds, integration credentials, the comms engine's knobs, and read-only runtime state |
| SU db console only | Secrets (API keys, webhook secrets), the interim comms access lists, retired settings |

**My Settings** (More → Settings) holds only your own things — your account,
password, signature and who can reach which mailbox and line.

## The Firm tab

The Firm tab is a page of sections: the firm's settings first, then the
launcher's (see [Firm launcher](14-firm-launcher.md)). Each setting is a row
with its name, what it does, and a control that suits it — an on/off switch,
a staff picker, a list you can add to, a box for text. **Save** at the top
saves every section you changed; leaving the tab with unsaved changes asks
first.

| Section | What is in it |
|---|---|
| **Firm identity** | Name, logo, phone, website, office email, mailing address, signing attorney — on generated documents and client-facing pages |
| **Senders** | The automations address, the default sender, the firm's email domains, the default and staff text lines |
| **Notifications & routing** | Where IT and system alerts go, the catch-all inbox, and who gets office alerts, billing tasks, appointment follow-ups and the events digest; the payment-failure drip cooldown |
| **Client self-service & booking** | What a client may do from their manage link (cancel, reschedule, rebook), the cutoff and horizon, the texts sent, and the Shabbos booking window |
| **Dropbox filing** | The case folder templates and the "unsorted" folders for uploads, forms, generated and signed documents |
| **E-Sign** | Test mode, the default reminder sequence, and the credit balance and its low-credit alert |
| **Marketing email & consent** | Who gets consent follow-up tasks (unsubscribe-page notes, opted-out clients), and the marketing footer's advertisement label and debt-relief-agency statement — see [Email unsubscribe](../06-Client-Facing/07-email-unsubscribe.md) |
| **Automation variables** | Settings the firm made for its own workflows (below) |

**Marketing email & consent** holds three settings: *Consent follow-up
assignee* (a staff picker — unset, or a user who is no longer active, means
no task is created and IT is warned once a day), *Advertisement label*
(blank = "Advertisement") and *Debt-relief agency statement* (blank = the
statutory wording; the firm's attorney confirms it before the first
marketing send). The marketing footer also reads the firm's name, mailing
address, phone and signing attorney from **Firm identity**.

**Spaces are kept exactly.** Dropbox folder names carry leading spaces on
purpose (they set the sort order), so nothing here trims what you type.

**A setting with no value** shows *Not set — the code's default applies*.
Saving it creates it.

**A blank value** means "unset" for most settings. A few refuse blank because
blank would break them — the portal's PIN-email sender and its callback
assignee.

## History and restore

Every change made here is recorded — who, when, the value before and after.
A setting's **History** lists them, newest first; **Restore this value** puts
back the value from before that change (and is itself recorded). Secrets are
never in the history.

## Automation variables

A workflow can read any setting that is not a secret with **get_setting** /
**get_settings**. To give a workflow a value of its own — a cooldown, a
threshold — add an **automation variable** in this section: a key, a type, a
label and a value. A key is refused when it differs from one of the firm's
settings only in capitals (`Firm_Name`): the database treats the two as the
same key. Workflows name a setting exactly as it is spelled — `get_setting`
of `FIRM_NAME` says there is no such setting. Workflows may write automation variables with
**set_setting**; they may not write the firm's real settings (only the Clio
login code, which a phone rule stores, is allowed). See
[internal functions](../03-YisraFlow/05-internal-functions.md).

## The Lists tab

Two simple lists. **Lead sources** can be changed by any staff member (anyone
with the *staff* role — every user created from the Users pane has it); **Event
types** only by the *firm settings* holders (everyone else sees that list
read-only):

- **Lead sources** — the suggestions offered in a case's Lead Source box. They
  are only suggestions: the box still accepts anything typed. Every staff
  member may add, remove and reorder them; each change keeps its history.
- **Event types (legacy list)** — the list the new-event dialog and the Events
  tab's filter offer, and the event form's fallback when Calendar Types cannot
  be read (Calendar Types is the event form's real vocabulary). Add, rename,
  reorder and remove entries; removing one asks first, and saving after a
  rename asks too. An empty name, or one that repeats another (in any
  capitals), is refused before anything is saved. Renaming or removing a type
  does **not** change events that already have it.

Case types are not here: they live in **Types & Subtypes**, which checks where
a type is used before it changes.

## The System tab (IT)

| Section | What is in it |
|---|---|
| **Platform** | The app's URL and buckets (read-only — changed from the SU console), the force-reload date, the Cloud Tasks accelerator, the mail send budget, the landing hosts (read-only) |
| **Switches** | The documents sync, court ingest and trustee validation kill switches |
| **Alert thresholds** | Which severity emails, and the repeat cooldown |
| **Integrations** | Which Connections credential Dropbox, e-sign and Google use, and the firm calendar |
| **Ask Casey** | Every Casey switch — one per action family, each on unless set to 0 — plus the monthly AI spend cap (read-only — changed from the SU console) |
| **Comms archive & AI** | The comms archive's modes and limits, shown here until the comms tools get a settings page of their own; most are changed from the SU console |
| **Runtime state** | Watermarks, heartbeats and counters the system keeps — read-only text, for diagnosis (JSON shown laid out) |

## Vocabularies: read-only for everyone else

Everyone can open YisraCase Config's vocabulary tabs — Types & Subtypes,
Pipelines, Custom Fields, Contact Roles, Calendar Types, Lists — but only the
*firm settings* holders can change them. Others see a banner, *Read-only —
changing YisraCase Config needs the admin permission*, the editing controls
are gone, and detail dialogs open to view. The one exception is the Lead
sources list on the Lists tab, which every staff member may change (no
banner there; Event types beside it stays read-only).

## For IT: the registry

`lib/settingsRegistry.js` lists every setting the code reads: its kind, its
one home, its type and who may change it. A new setting is an entry there in
the same change (a test fails otherwise). The database row holds only the
value. Detail: `ref/AI_CONTEXT.md` §32.
