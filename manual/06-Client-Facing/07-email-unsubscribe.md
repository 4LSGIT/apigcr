# Email Unsubscribe — the `/u/` Page and the One-Click Button

Every **marketing** email the firm sends (the newsletter and other marketing
topics) carries a private unsubscribe link:

```
https://4lsg.com/u/<22-character token>
```

and the two headers that make Gmail, Outlook and Apple Mail show their own
**Unsubscribe** button next to the sender. No login; the token *is* the
authorization, and it only ever covers one email address's **marketing**
email.

> Status: the page is live, but nothing sends marketing email yet — links are
> minted by the marketing send path (campaigns, slice C2), which is not built.
> Until then the page is reached only by test links.

**Case and appointment email is never affected.** An unsubscribe here stops
marketing email to that address — nothing else. Reminders, document
requests, payment notices and every other email about a client's case keep
going. The page says so to the client.

---

## What the client sees

Opening the link shows **Email preferences** for their address (shown
partly hidden, e.g. `p******@example.com`):

1. **Unsubscribe from <topic>** — one button for the list the email came
   from (e.g. *Newsletter*). One click and it is done.
2. **Manage preferences** — one checkbox per marketing topic (ticked = they
   get it), a **Stop all marketing email** button, an optional **Anything
   else?** box, and **Save**.
3. The firm's name, mailing address and phone, and the line that case and
   appointment email is not affected.

After any button the same page comes back with a confirmation line
("You're unsubscribed from Newsletter.", "Your preferences are saved."). A
client who is already unsubscribed sees that instead of the button. Someone
who stopped all marketing email can come back, tick a topic and save to
start receiving it again — that is their own choice at their own address.

**Opening the page changes nothing.** Mail scanners open every link in an
email automatically; only a button press records anything.

**A broken or unknown link** shows the same page without any controls —
"This link isn't valid" with the firm's contact details. The page never says
whether a link once existed.

**Links never expire.** A link from a year-old newsletter still works, and it
keeps working after it has been used.

## The mail client's own Unsubscribe button

Gmail and the others show an **Unsubscribe** button beside the sender for
messages that carry the right headers. Pressing it sends a request straight
to YisraCase (no page opens) and unsubscribes the address from **the topic
the email came from** — the same as the page's first button. It is answered
instantly and never asks the client anything.

## What each control records

Every change lands in the consent ledger with its proof (who, when, the
link used, the browser):

| Control | Records | Source shown in the ledger |
|---|---|---|
| The mail client's Unsubscribe button | opted out of that email's topic | one-click |
| **Unsubscribe from <topic>** | opted out of that topic | unsubscribe page |
| **Stop all marketing email** | opted out of all marketing email | unsubscribe page |
| A checkbox changed + **Save** | opted out of / back in to that topic | preference page |

Pressing a button that changes nothing (already unsubscribed) records
nothing. If a topic has since been deleted, the one-click button stops all
marketing email instead, so the client's request is never lost.

## The "Anything else?" box

Anything the client types there (up to 1,000 characters) becomes **one task**
for the staff member set as **Consent follow-up assignee** (More → YisraCase
Config → Firm → *Marketing email & consent*). The task names the address,
the email it came from, what the client changed, and links to the contact
when one is known. The note is also kept with the consent record.

If no assignee is set (or the setting names someone who is no longer active),
no task is created: IT gets one warning per day, and the notes stay in the
consent ledger until someone looks.

## Where staff see the result

- **The contact's email row** — a marketing opt-out of *all* marketing
  email shows on the row's "No marketing email" flag (see
  [Contacts](../01-YisraCase-overview/02-contacts.md)). Topic-level choices
  (e.g. only the newsletter) are in the consent ledger; showing them on the
  contact page is a later slice.
- **Tasks** — notes from the "Anything else?" box.
- An address that is not on any contact (an imported list) is still
  unsubscribed: consent belongs to the address, not to a contact.

## Settings

| Setting (Config → Firm → Marketing email & consent) | What it does |
|---|---|
| Consent follow-up assignee | Who gets the task for an unsubscribe-page note (and, later, for a client who texts STOP). |
| Advertisement label | The first line of the marketing footer when the topic has no affirmative consent. Blank = "Advertisement". |
| Debt-relief agency statement | The bankruptcy-law statement every marketing footer carries. Blank = the statutory wording. The firm's attorney confirms it before the first send. |

The footer also uses the firm's name, mailing address, phone and signing
attorney from **Firm identity** — a marketing email will not go out while
any of name, address or attorney is blank.

## For IT

Routes: `GET /u/:token`, `POST /u/:token` (one-click), `POST
/u/:token/prefs` (the form) — `routes/unsubActions.js`, served on the
landing host only (`routes/pageLanding.js`). Substrate:
`services/unsubService.js`; table `comm_unsub_tokens`; design
`ref/YISRAMAIL_DESIGN.md` §4.5. The one-click POST has no rate limit on
purpose (mail providers send from a few addresses); the page allows 30
views and 10 saves per minute per address.
