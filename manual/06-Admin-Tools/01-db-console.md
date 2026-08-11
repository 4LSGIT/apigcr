# DB Console (SU)

An interactive MySQL console against the live database, for super-users. It
replaces the old `/db-jwt` tool for interactive use.

**Where:** More → **DB Console**. SU only.

## What it does

- **Run queries** against the live DB and see the results in a table.
- **Read-only by default.** A query is allowed to run as-is only if its first
  meaningful keyword is `SELECT`, `SHOW`, `DESCRIBE`/`DESC`, or `EXPLAIN`.
  Leading `/* */` and `--` comments are stripped before the check, so a
  commented header won't fool it.
- **Writes are opt-in.** To run anything that modifies data (`INSERT`,
  `UPDATE`, `DELETE`, DDL, …) you must explicitly enable the **allow write**
  toggle for that run. Treat it as a loaded gun.
- **Browse the schema** — list tables and columns, and **download a schema
  dump** (`schema-<timestamp>.sql`) with no data and no database name in it.
- **Saved queries** — name and store queries you run often; edit and delete them.

## Running a whole script

**Run All** (`Ctrl/Cmd+Shift+Enter`) splits the editor contents on `;` and runs
every statement in order, then renders a single markdown report — one section
per statement with its SQL and result — and auto-copies it. That report format
is meant for pasting into an LLM chat.

Execution happens server-side via `POST /admin/db/batch`, in chunks of 50
statements per request. A 200-statement script therefore costs 4 requests
against the rate limit, not 200. Statements are **not** wrapped in a
transaction — each one commits on its own, exactly as if you'd run them one at
a time.

Two things stop a batch early: `stopOnError` (API-only flag, off by default) and
a 240-second server-side time budget. Anything not reached is reported as
**NOT RUN** rather than silently dropped.

## Guardrails

- **SU only**, JWT-authed.
- **Rate limited** to 120 requests/min per user for the DB Console. Each tool
  has its own independent budget — burning through the console's allowance no
  longer locks you out of the users admin or API keys. Override per tool with
  `SU_RATE_LIMIT_DB_CONSOLE`, or globally with `SU_RATE_LIMIT_DEFAULT`.
- **Every attempt is audited** to `admin_audit_log` — including the query text —
  before the result comes back. Batch runs write one row per statement (tagged
  with `batch_index`) plus a summary row. Assume anything you run is recorded.

## Gotchas

- **`WITH` is treated as a write.** MySQL 8 allows `WITH … UPDATE`, so a CTE
  that starts with `WITH` will be rejected unless you enable allow-write — even
  if it's actually a read. Rewrite as a plain `SELECT` when you can.
- **Schema-to-ref save is dev-only.** The "save dump to `ref/`" endpoint refuses
  to run outside `ENVIRONMENT=development` — Cloud Run's filesystem is
  ephemeral, so a saved file wouldn't survive anyway. Use the download instead.
- **This is the live database.** There is no staging copy behind this console.
  Read-only-by-default exists for exactly this reason; leave allow-write off
  unless you mean it.

## For routine, safer reads

If you just need to read data (or hand read access to a script or an AI tool),
prefer a **[readonly key](02-readonly-keys.md)** against `/api/readonly/sql` —
that path runs as a SELECT-only database user and can't write at all, by
construction.