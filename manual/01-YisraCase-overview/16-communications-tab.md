# The Communications Tab

Every contact and every case has a **Communications** tab: one feed (newest
first, or oldest first) of the emails, texts, calls and court mail that belong
to that record, with search, channel, direction and date filters, and the actions you need on each
item (open, reply, text back, file an attachment, tag a case). The contact's
tab sits where the old Send tab was; the case's tab is its own top-level tab.

The feed is assembled from two kinds of rows, and which kind an item is
decides who can see it. Read the next section before relying on what the tab
does or does not show.

---

## Two kinds of item

**Source-backed items** come from the stores the mail and phone systems write:
a stored mailbox message, or a text or call from a phone line. These are
**grant-gated**: you see a message only if you can read its mailbox (or a
mailbox alias whose slice includes it), and a text or call only if you can
read its phone line — exactly what your Mail and Comms screens show you. Two
people opening the same case can therefore see different feeds.

**Logged-only items** (marked **Logged only**) come from the activity log: an
`email`, `sms`, `call` or `court email` entry that has no mailbox or phone
source anywhere. Typical examples: a call logged by hand, a text or email
logged without sending, mail forwarded in by the ingest path, court email.
These show **whatever the Log tab shows** for the same record — they are not
checked against any mailbox or phone-line grant. If you can see the entry on
the Log tab, you can see it here.

A log entry that does have a source never also appears as a Logged-only copy,
even when the source is in a mailbox or on a line you cannot read. That is
deliberate: otherwise a hand-made log entry would show you mail that your
grants hide.

### Court mail

Court items get the **Court** badge and channel. In practice every one of them
is Logged-only today: court email reaches the system through the ingest path,
which writes the activity log but not a stored mailbox copy (0 of 9,401 court
email log entries had one, checked 2026-10-21). So the Court filter shows
exactly the court email the Log tab shows.

---

## What lands on a contact's feed

- Mail where one of the contact's email addresses is the sender or a To / Cc
  recipient, and texts and calls with one of the contact's phone numbers.
- Only while the contact owned that address or number: the start and end
  dates on the contact's phone and email entries are applied to the day the
  message happened (the firm's calendar day). A blank start date means "since
  forever", a blank end date "still theirs". A number that changed hands shows
  each owner only their own traffic.
- The contact's own Logged-only entries, as the contact's Log tab shows them.

## What lands on a case's feed

By default the case feed is **strict**: it shows only what is tied to the case
itself —

- log entries filed on the case or tagged as being about it (the same rows the
  case's Log tab lists for the case itself);
- mailbox messages connected to one of those log entries, including other
  stored copies of the same email;
- mail sent from a mailbox composer with this case chosen (a reply sent from
  the case's own feed is one);
- texts and calls whose log entry is one of those.

### Include contact communications

Ticking **Include contact communications** widens the case feed to the
contact feed of each Primary, Secondary and Other contact on the case — the
same contacts the case's Log tab includes by default. **Bystanders are never
included.** The widening adds nothing that bypasses a grant: a contact's
mail and phone traffic is still filtered by your mailbox and phone-line access,
and each added item carries the contact's name as a badge. Untick it to go back
to the strict view.

### A real text sent from a case does not show up in the strict feed

Sending a real text from a case's **Send / log…** goes out through the phone
provider, and the log entry is written later by the provider's delivery
webhook — which knows the phone numbers but not which case you were on. Until a
bridge for that exists, the text appears on the contact's feed and on the case
feed with **Include contact communications** ticked, but not on the strict
case feed. Emails and calls you log from a case, and texts you log without
sending, are stamped as being about the case and do appear strictly. To put a
sent text on the case permanently, open it on the contact's feed and use
**Add case tag** once the webhook has logged it (usually within seconds).

---

## Filters and search

- **Channel**: All, Direct (email + texts + calls, no court), Email, Phone
  (texts + calls), Texts, Calls, Court.
- **Direction**: incoming or outgoing.
- **From date / To date**: only items that happened on or between those days
  (the firm's calendar day; either end may be left blank). A call or note
  logged after the fact counts on the day it was given, not the day it was
  typed.
- **Order**: newest first (the default) or oldest first.
- **Search** matches what you can read on the item: the participant and contact
  name, subject, preview / body text, addresses and phone numbers, and the
  channel and direction words ("text", "call", "court", "incoming"…). A
  phone-number search ignores formatting — `(313) 555-0100`, `313-555-0100` and
  `3135550100` find the same texts. Search does not look inside the full email
  body (only the preview), attachments, or call transcripts.

The feed loads 50 items at a time; **Load older** fetches the next page.

An item whose time was set by hand (Log Call's When, the time Log Without
Sending asks for) also shows, under its date, when it was really typed:
*entered Oct 22, 2026, 3:10 PM*.

---

## Working with an item

Click an item to expand it.

- **Email**: the full message renders in place, with its attachments —
  download one, or **Add to Documents** to file it into the case's Documents.
  **Reply** answers in the same thread from the same mailbox (to the sender;
  when you reply from a case feed, the sent mail is tied to that case).
- **Text / call**: the message body or the call's status and duration, plus
  any archived recording, voicemail, transcript or summary you are allowed to
  see. **Text back** sends from the same phone line.
- **Logged-only**: the logged body and details. There is no reply — nothing
  connects a log entry to a mailbox or line.
- **Add case tag / Change case tag** (contact feed only): ties the item to one
  of the contact's cases. For a stored email it tags the email's log entry
  (creating one if needed); for a text, call or Logged-only item it sets the
  log entry's "about" case — a text or call with no log entry yet has no tag
  control. A tagged item then appears on that case's strict feed.

**Send / log…** opens the classic composer (SMS, email, log a call, log
without sending). On a case it first asks which of the case's contacts the
message is for; anything logged from there is filed on that contact and marked
as being about the case. **Back to history** returns to the feed and refreshes
it.

---

## Replying to someone who opted out

Replies from this tab (and texts / emails from the contact's **Send** form)
go through the same check as Comms: when the number or address is marked
*opted out* on the contact's phone or email row, you are asked first — **OK**
sends anyway, **Cancel** sends nothing. Send anyway only when the client asked
for the message. See [Mailboxes → Sending mail](../08-Admin-Tools/08-mailboxes.md#sending-mail--comms).

## Texts that didn't arrive

An outbound text whose phone carrier reported a failure wears a red
**Not delivered** badge on these feeds, and a red "Not delivered — …" line on
its bubble in Comms → Phone. The tooltip carries the reason in plain words:

- *this number can't receive texts* — a landline, a disconnected number, or
  one blocking texts. Reach the client another way.
- *the recipient opted out (STOP)* — don't text them again unless they
  re-consent; call instead.
- *a carrier spam filter blocked the message wording* — reword it and resend,
  or call.
- *our sending number was flagged* — stop texting and tell IT.

Delivery status arrives from the carrier minutes after a send, so a
just-sent text shows nothing at first; most texts simply never get a mark.
Statuses are stamped by an automatic sync (every 10 minutes, plus instantly
when the provider reports a change) — see the design doc
`ref/PHONE_DELIVERY_DESIGN.md` for the machinery.

Each NEW failure also sends two automatic emails: a plain-words one to Stuart
and a technical one to IT. That notice is an ordinary workflow (**Failed SMS
workflow**, id 54) — edit it in the workflow builder to change wording or
recipients; the Config → System setting **Failed-text workflow** says which
workflow runs (blank switches the emails off). The same unreachable client
fails again on every new send, so a weekly reminder to a dead number means a
weekly email until someone fixes the number on the contact.

---

## Related chapters

- [The activity log](06-activity-log.md) — where Logged-only items come from.
- [Contacts](02-contacts.md) — the phone and email entries, and their start
  and end dates, that decide a contact's feed.
- [Matters](03-matters.md) — case contacts and their relationship types.
