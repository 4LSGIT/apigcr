# Admin Tools (Super-User)

Power tools for IT / super-users only. Every tool here is gated behind
`user_auth = "authorized - SU"`, rate-limited, and writes every action to
`admin_audit_log`. They all live behind the **More** menu (the items marked
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

> **Two kinds of key, easily confused.** [Readonly Keys](02-readonly-keys.md)
> are short-lived, SELECT-only credentials for `/api/readonly/sql`.
> [API Keys](05-api-keys.md) are full inbound API credentials. If you want to
> let something read the database, you want the first one.

These are operator references, not end-user guides — they assume you know what a
SQL query, an HTTP request, and an API key are.

| # | File | What it is |
|---|------|----|
| 1 | [01-db-console.md](01-db-console.md) | Interactive MySQL console — read-only by default, opt-in writes, schema browser, saved queries. (More → DB Console) |
| 2 | [02-readonly-keys.md](02-readonly-keys.md) | Issue and revoke short-lived read-only API keys for external/AI database access via `/api/readonly/sql`. (More → Readonly Keys) |
| 3 | [03-api-tester.md](03-api-tester.md) | Send arbitrary HTTP requests from the server, with stored-credential injection and SSRF protection. (More → API Tester) |
| 4 | [04-system-alerts.md](04-system-alerts.md) | The alert console behind the shell's red banner — why non-OAuth alerts never clear themselves, the open/acked/resolved states, and the two independent delivery channels. (More → System Alerts) |
| 5 | [05-api-keys.md](05-api-keys.md) | Inbound API credentials — minting and revoking external keys, internal-key rotation and its one-rotation grace, and why the usage log's silence proves nothing. (More → API Keys) |

> Connections (the credential store these tools draw on) is documented under
> [Integrations → Connections](../04-Integrations/01-connections.md).
