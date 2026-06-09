# Admin Tools (Super-User)

Power tools for IT / super-users only. Every tool here is gated behind
`user_auth = "authorized - SU"`, rate-limited, and writes every action to
`admin_audit_log`. They all live behind the **More** menu (the items marked
**(SU)**) and won't appear for regular staff.

These are operator references, not end-user guides — they assume you know what a
SQL query, an HTTP request, and an API key are.

| # | File | What it is |
|---|------|----|
| 1 | [01-db-console.md](01-db-console.md) | Interactive MySQL console — read-only by default, opt-in writes, schema browser, saved queries. (More → DB Console) |
| 2 | [02-readonly-keys.md](02-readonly-keys.md) | Issue and revoke short-lived read-only API keys for external/AI database access via `/api/readonly/sql`. (More → Readonly Keys) |
| 3 | [03-api-tester.md](03-api-tester.md) | Send arbitrary HTTP requests from the server, with stored-credential injection and SSRF protection. (More → API Tester) |

> Connections (the credential store these tools draw on) is documented under
> [Integrations → Connections](../04-Integrations/01-connections.md).
