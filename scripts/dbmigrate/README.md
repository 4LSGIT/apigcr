# scripts/dbmigrate — moving the database to another MySQL server

Tooling for the SiteGround → Cloud SQL move. Nothing here is specific to either
host; it works between any two MySQL 8 servers.

| File | What it does |
|---|---|
| `dump.sh` | Consistent dump of the source: `yc_data.sql.gz` (schema + data, no triggers) and `yc_triggers.sql` (triggers only, `DEFINER` stripped). Verifies its own output; `VERIFY_ONLY=1` re-checks existing files. |
| `parity.js` | Compares source and destination: server settings, database defaults, structure (the repo's schema-fingerprint rows, section by section), trigger sql_mode/definers, row counts, auto-increments, and with `--checksum` a content hash of every row. `--strict` for the cutover (data must match exactly); default is rehearsal (data drift tolerated). |

## Order

1. `dump.sh` against the source.
2. Import `yc_data.sql.gz` into an empty database on the destination created
   with the source's default charset/collation (`utf8mb4` / `utf8mb4_general_ci`).
3. Apply `yc_triggers.sql` **logged in as the account that should own the
   triggers** (the app's account) — with no `DEFINER` clause MySQL stamps the
   creating user.
4. `parity.js` — rehearsal mode while the source is live; `--strict --checksum`
   after the write freeze, before any traffic moves.

The app side is one env var: `INSTANCE_CONNECTION_NAME` (see `lib/dbTarget.js`).

Host names, account names and the step-by-step cutover live in the private
runbook (project doc `claude/DB_MIGRATION_RUNBOOK.md`), not in this public repo.

## Why these and not the obvious tools

- **Triggers are split out** because the source's definer accounts do not exist
  on the destination: importing them verbatim fails with error 1227 (verified).
- **`CHECKSUM TABLE` is not used.** It hashes stored bytes, and JSON values are
  re-encoded by a text dump (same text, different binary). On the live DB
  2026-10-11 that is 55 values in 11 tables — all false alarms. `parity.js`
  hashes JSON through the same text round trip the dump performs.
- **Row counts alone are not enough**: an in-place `UPDATE` keeps every count.
  Only `--checksum` sees it.

Both were exercised end to end against two local MySQL 8.0 servers loaded from
`ref/database.sql` (153 tables, 15 triggers), with negative controls for every
check. The production servers are 8.4 — the rehearsal is where that gets proven.
