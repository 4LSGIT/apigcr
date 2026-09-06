# Client Self-Service — Manage Links (`/m/`) and Their Settings

Every appointment gets a private **manage link** the moment it is created:

```
https://4lsg.com/m/<32-character token>
```

A client who opens it sees their appointment — type, date, provider — and,
depending on policy, buttons to **cancel**, **reschedule**, or (after a
cancellation) **pick a new time**. No login; the token *is* the authorization.
Which of those buttons actually appear is controlled entirely by settings —
this chapter is about those settings: what each one does, how to change them,
and the combinations that make sense.

**The one-line summary of current policy:** clients may **cancel** their own
appointments; they may **not** reschedule or rebook until the firm turns that
on. Flipping it on later is a settings change, not a code change.

---

## Where clients get these links

Three places, all sending the same kind of link:

1. **Public booking confirmations** — every booking made on a public
   `/book/<slug>` page (consult, mediate, …) fires a confirmation SMS whose
   template ends with the manage link. This is automatic; no staff involved.
   The template text lives per-view in the **Booking Views manager**.
2. **Staff appointment dialogs** — the New Appointment, Reschedule, and
   Cancel dialogs pre-fill a confirmation message containing the link
   ("…To view or cancel it: https://4lsg.com/m/…"). Staff can edit the text
   before sending; the link is just part of the default.
3. **The manage page itself** — after a client cancels or reschedules on the
   page, an optional follow-up SMS (the `manage_cancel_template` /
   `manage_reschedule_template` settings below) confirms what happened.

Two things follow from this that are worth internalizing:

- **Links are permanent.** A token never expires and is never revoked; a link
  sent months ago still opens that appointment's page today. Policy is
  therefore enforced *on the page and its API*, not by controlling who has a
  link — turning a setting off instantly disarms every link ever sent.
- **Old-host links keep working.** Links were historically sent as
  `app.4lsg.com/m/…`; those redirect to `4lsg.com/m/…` automatically. Never
  assume a link is dead because it has the old host.

---

## The settings

All of these live in **app settings** under the **Booking** category
(editable in the settings UI, or via the [database console](../08-Admin-Tools/01-db-console.md)).

### Policy toggles — who may do what

| Setting | Type | Current | What `1` allows |
|---|---|---|---|
| `manage_allow_cancel` | bool | `1` | Client cancels a Scheduled appointment from the page |
| `manage_allow_reschedule` | bool | `0` | Client moves a Scheduled appointment to a new open slot |
| `manage_allow_rebook` | bool | `0` | A **Canceled** appointment's page offers "pick a new time" |

Each toggle gates both the button on the page *and* the API behind it — a
client cannot bypass a `0` by replaying an old page or crafting a request.

> **Rule: `manage_allow_rebook` must always match `manage_allow_reschedule`.**
> Rebook-on with reschedule-off is not a restriction — a client just cancels,
> the page immediately offers "pick a new time," and they have rescheduled
> themselves in two clicks. Flip these two together, always.

**Fail-closed behavior:** if a toggle row is missing, blank, or contains
garbage, the code falls back to exactly the values in the table above
(cancel on, reschedule/rebook off). You cannot accidentally open
rescheduling by deleting a row.

### Window and limits — when self-service is possible at all

| Setting | Current | Meaning |
|---|---|---|
| `manage_cutoff_min` | `240` | No self-service inside this many minutes of the start time (4 h). Inside the window the page says "please call." Applies to cancel *and* reschedule; a reschedule also can't land inside it. |
| `manage_horizon_days` | `30` | How far ahead the reschedule picker offers slots. |

These are necessary conditions, not overrides — a toggle set to `0` blocks
the action no matter how far out the appointment is.

### Follow-up message templates

| Setting | Fires when |
|---|---|
| `manage_cancel_template` | Client cancels on the page |
| `manage_reschedule_template` | Client reschedules or rebooks on the page |

Both are SMS templates using the standard [resolver placeholders](../03-YisraFlow/06-variables-templating.md)
(`{{contacts.…}}`, `{{appts.…}}`), resolved against the appointment the
message describes — for a reschedule that is the **new** appointment, so
`{{appts.appt_manage_token|default:}}` embeds the *new* link. Blank = send
nothing. Note `manage_reschedule_template` is dormant while
`manage_allow_reschedule` is `0` — nothing can trigger it.

### The fallback button

| Setting | Current |
|---|---|
| `manage_fallback_url` | `{"url":"https://4lsg.com/book/consult","button_text":"Book a new time"}` |

Whenever a manage page has **no in-page action** — the appointment is
Attended, No Show, Rescheduled, Canceled-but-rebook-is-off, or the token is
invalid — this renders as a button. It is a plain link (usually to public
booking), **not** a rebook of the old appointment: clicking it books a brand
new appointment through the normal public flow, same as any website visitor.

The value must be a JSON object with `url` (required, http/https) and
`button_text` (optional). Blank or invalid → the page falls back to the
firm website link (`fe-firm_site_url`), and with that also unset, to plain
"please call" copy with `fe-firm_phone`.

> Don't be alarmed by a "Book a new time" button on a locked-down page —
> that is this setting, not a hole in the policy toggles. If even that door
> is unwanted, blank the setting (Example 4 below).

---

## Examples

All examples are settings-UI edits or single database-console statements.
None require a deploy, and all take effect on the next page load — including
for links already in clients' hands.

### 1 — Current state: cancel-only (for reference)

```sql
-- What the toggles look like today:
SELECT `key`, `value` FROM app_settings WHERE `key` LIKE 'manage_allow%';
-- manage_allow_cancel      1
-- manage_allow_rebook      0
-- manage_allow_reschedule  0
```

A client's page shows the appointment, a **Cancel** button, and "Need a
different time? Please call (248) 417-9800."

### 2 — Enable client self-rescheduling (once approved)

Flip **both** reschedule and rebook — see the rule above:

```sql
UPDATE app_settings SET `value` = '1'
 WHERE `key` IN ('manage_allow_reschedule', 'manage_allow_rebook');
```

Pages immediately grow a **Reschedule** button; canceled-appointment pages
grow **Pick a new time**. Every link ever sent starts offering this — there
is no per-client rollout.

### 3 — Lock everything down (e.g., something looks wrong)

```sql
UPDATE app_settings SET `value` = '0'
 WHERE `key` IN ('manage_allow_cancel', 'manage_allow_reschedule', 'manage_allow_rebook');
```

Every manage page becomes read-only ("please call…"). Reverse by setting
`manage_allow_cancel` back to `1`.

### 4 — Remove the "Book a new time" fallback button

```sql
UPDATE app_settings SET `value` = '' WHERE `key` = 'manage_fallback_url';
```

No-action pages then show "Visit our website →" (from `fe-firm_site_url`),
or just the phone number if that is also blank. To keep the button but make
it read less like a rebook:

```sql
UPDATE app_settings SET `value` =
  '{"url":"https://4lsg.com/book/consult","button_text":"Schedule a consultation"}'
 WHERE `key` = 'manage_fallback_url';
```

### 5 — Tighten the self-service window to 24 hours

```sql
UPDATE app_settings SET `value` = '1440' WHERE `key` = 'manage_cutoff_min';
```

Clients can no longer cancel or reschedule within a day of the start time.

### 6 — Add a confirmation SMS when a client cancels

```sql
UPDATE app_settings SET `value` =
  'Hi {{contacts.contact_fname}}, your appointment has been canceled. Need a new time? https://4lsg.com/book/consult'
 WHERE `key` = 'manage_cancel_template';
```

---

## Verifying what a client sees

The page's state is fully described by one API call — useful when a client
reports something unexpected:

```
GET https://4lsg.com/api/m/<token>
```

Returns the status plus the resolved flags: `can_cancel`, `can_reschedule`,
`can_rebook`, and the `fallback` object. If the flags say `false`, the
buttons cannot appear and the actions cannot succeed, whatever the page
looks like in a stale browser tab (a cached page might *show* a button, but
the server rejects the action).

---

## Related

- **[Appointments](../01-YisraCase-overview/04-appointments.md)** — the staff-side
  confirmation dialogs where these links are embedded.
- **Booking Views manager** — the public `/book/<slug>` pages and their
  per-view confirmation SMS templates (where "Manage or cancel: …" lives).
- **[Variables & templating](../03-YisraFlow/06-variables-templating.md)** — placeholder syntax
  used in the message templates.
- **[Database console](../08-Admin-Tools/01-db-console.md)** — running the example statements.
