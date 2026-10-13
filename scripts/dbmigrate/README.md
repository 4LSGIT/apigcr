# scripts/dbmigrate — moving the database to another MySQL server

Tooling written for the SiteGround → Cloud SQL move, which ran 2026-10-13
(`ref/archive/DB_MIGRATION_2026-10.md`). Nothing here is specific to either
host; it works between any two MySQL 8 servers, and is kept for the next move
(a new region, a new project, a per-tenant database).

| File | What it does |
|---|---|
| `dump.sh` | Consistent dump of the source: `yc_data.sql.gz` (schema + data, no triggers) and `yc_triggers.sql` (triggers only, `DEFINER` stripped). Verifies its own output; `VERIFY_ONLY=1` re-checks existing files. |
| `parity.js` | Compares source and destination: server settings, database defaults, structure (the repo's schema-fingerprint rows, section by section), trigger sql_mode/definers, row counts, auto-increments, and with `--checksum` a content hash of every row. `--strict` for the cutover (data must match exactly); default is rehearsal (data drift tolerated). |

## Order

1. `dump.sh` against the source. Across a slow link, compress the
   connection by overriding the dump command (44 minutes → 13 on the 2026-10-12
   rehearsal, same output file):
   `MYSQLDUMP="docker run --rm -e MYSQL_PWD mysql:8.4 mysqldump --get-server-public-key --compression-algorithms=zstd,zlib"`.
2. Import `yc_data.sql.gz` into an empty database on the destination created
   with the source's default charset/collation (`utf8mb4` / `utf8mb4_general_ci`).
3. Apply `yc_triggers.sql` **logged in as the account that should own the
   triggers** (the app's account) — with no `DEFINER` clause MySQL stamps the
   creating user — and **with `mysql --binary-mode`**:
   `mysql --binary-mode -h… -u<app account> <db> < yc_triggers.sql`.
   Without that flag the client rewrites every CRLF in a statement to LF, and
   triggers written in phpMyAdmin carry CRLF: they would work the same and
   still fail parity (2026-10-12 rehearsal, 13 of 15 triggers). The file drops
   each trigger before creating it, so it can be applied again.
4. `parity.js` — rehearsal mode while the source is live; `--strict --checksum`
   after the write freeze, before any traffic moves.

The app side is one env var: `INSTANCE_CONNECTION_NAME` (see `lib/dbTarget.js`).

**Server settings come from `@@GLOBAL`, not from what the app sees.** The
destination's `sql_mode` must be the source's *server* value. A query run
through the app (or any mysql2 connection) shows one extra mode,
`IGNORE_SPACE`: the driver asks for it on every connection (its default
`IGNORE_SPACE` client flag), on any server. Copying that session value into
the destination's server setting changes nothing for the app and changes
parsing for every other client. `parity.js` compares `@@GLOBAL.sql_mode` and
fails on the difference (it did, 2026-10-12).

Host names, account names, the step-by-step cutover and the operator script
that drove it live in the private runbook (project doc
`claude/DB_MIGRATION_RUNBOOK.md`, with `claude/DB_MIGRATION_yc.sh`), not in this
public repo. What was done and why it went smoothly:
`ref/archive/DB_MIGRATION_2026-10.md`.

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
check, then on the production pair (8.4.6 → 8.4.11) in the rehearsal and the
cutover: the content hash is stable across those versions.
