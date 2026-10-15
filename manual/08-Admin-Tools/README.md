# Admin Tools (Super-User)

Power tools for IT / super-users only. Every tool here is gated behind
the `su` role, rate-limited, and writes every action to
`admin_audit_log`. They all live on the **Admin** tab in the sidebar (the items marked
**(SU)**) and won't appear for regular staff.

---

## Before any of them will work: elevation

Being a super-user is no longer enough on its own. Every tool in this section
also requires a **short-lived elevation token**, and you get one by re-entering
**your own password**. It lasts **15 minutes**.

So the flow is: open an SU tool → it asks for your password → you have 15
minutes of SU access → it asks again.

**Why.** A stolen or leaked staff JWT must not be enough to run the DB console,
mint API keys, or read Connections. Elevation makes those tools require
something the token alone can't supply.

Two properties worth knowing:

- **Elevation adds, it never substitutes.** The SU check runs *first*; a
  non-super-user is refused before the password is even read, and a forged
  elevation token still gets them nowhere.
- **API keys can't elevate.** Elevation is a human act — the guard chain
  rejects API-key auth outright. Anything automated cannot reach these tools,
  by design.

The mint endpoint is `POST /admin/elevate` with `{password}`, returning
`{token, expires_in: 900}`; the token rides on the `X-SU-Elevation` header.
It is rate-limited to **10/min** — with a stolen JWT this endpoint would
otherwise be an online oracle for the super-user's password, so the ceiling is
deliberately low.

Failures are specific: `401 bad_password` for a wrong or empty password,
`403 no_password` if the account has no password hash set.

---

> **Two kinds of key, easily confused.** [Session Keys](02-readonly-keys.md)
> are short-lived, scoped credentials for a script or an AI session (read-only
> SQL, scratch notes, IT alerts by default). [API Keys](05-api-keys.md) are
> full inbound API credentials. If you want to let something read the
> database, you want the first one.

These are operator references, not end-user guides — they assume you know what a
SQL query, an HTTP request, and an API key are.

| # | File | What it is |
|---|------|----|
| 1 | [01-db-console.md](01-db-console.md) | Interactive MySQL console — read-only by default, opt-in writes, schema browser, saved queries. (Admin → DB Console) |
| 2 | [02-readonly-keys.md](02-readonly-keys.md) | Session keys: issue, edit, renew and revoke short-lived, scoped keys for scripts and AI sessions — read-only SQL via `/api/readonly/sql`, scratch, IT alerts; manager keys mint their own child keys; a tasks.own key hands staff tasks. (Admin → Session Keys) |
| 3 | [03-api-tester.md](03-api-tester.md) | Send arbitrary HTTP requests from the server, with stored-credential injection and SSRF protection. (Admin → API Tester) |
| 4 | [04-system-alerts.md](04-system-alerts.md) | The alert console behind the shell's red banner — why non-OAuth alerts never clear themselves, the open/acked/resolved states, and the two independent delivery channels. (Admin → System Alerts) |
| 5 | [05-api-keys.md](05-api-keys.md) | Inbound API credentials — minting, editing (scopes, expiry) and revoking external keys, internal-key rotation and its one-rotation grace, and why the usage log's silence proves nothing. (Admin → API Keys) |
| 6 | [06-tools.md](06-tools.md) | SU-authored HTML utilities stored in the database and served at `/tool/<key>` — writing one, what draft vs live actually means, and the version history. (Admin → Tools) |
| 7 | [07-cta-links.md](07-cta-links.md) | CTA links — SU-minted `/c/` buttons that run a pre-authorized action plan when the recipient confirms: once vs repeatable, password protection, clicker inputs (typed fields the clicker fills, bound into the plan, with the use-cap rule and risk acknowledgments), expiry refresh, reading executions, and sending a link by email or SMS. (Admin → CTA Links) |
| 8 | [08-mailboxes.md](08-mailboxes.md) | YisraCase-native mailboxes — IMAP connection rows with a write-only secret, the re-enter-on-host-change rule, ingest folders and Emit to rules, and per-person read / send / manage access (superusers and automations need no grant), what polling stores and emits (Store history, emitting as another source for the Google inbox), attachments on demand, polling failures, and reading it all in Comms (the attorney read bypass, per-person read state, hidden images, linking an email to a case, saved views); the Comms **Phone** tab (texts and calls per phone line) and phone-line read / send / manage access. (Admin → Mailboxes; Connections → Phone Lines → Access; Comms in the sidebar) |
| 9 | [09-comms-transcription.md](09-comms-transcription.md) | Comms archive transcription (AssemblyAI) and AI summaries (Claude): redoing transcripts or summaries with today's settings (dry run first), the off / sample / on switches, what is never transcribed (restricted calls, the do-not-transcribe list, calls under 15 s of audio, the per-call cap and how to release one), the monthly spending cap and the after-backfill drop to $25, the other settings, summaries (model, effort, what is never summarised, every quoted item checked against the transcript, the view audit), the alerts and what to do, and privacy (no training, vendor copies deleted, Restrict and Purge). (DB Console; System Alerts) |
| 10 | [10-comms-archive.md](10-comms-archive.md) | The private archive of call recordings, voicemails and MMS files — Listen, transcripts and files in Comms → Phone, searching inside transcripts (In call transcripts), who sees what (access follows the line; restricted = archive admins only), Restrict / Unrestrict / Purge with the password re-check, the audit trail, and the health section in System Alerts. (Comms → Phone; Admin → System Alerts (SU)) |

> Connections (the credential store these tools draw on) is documented under
> [Integrations → Connections](../04-Integrations/01-connections.md).
