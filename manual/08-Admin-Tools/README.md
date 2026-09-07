# Admin Tools (Super-User)

Power tools for IT / super-users only. Every tool here is gated behind
`user_auth = "authorized - SU"`, rate-limited, and writes every action to
`admin_audit_log`. They all live behind the **More** menu (the items marked
**(SU)**) and won't appear for regular staff.

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
