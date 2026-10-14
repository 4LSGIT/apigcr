# Session Keys (SU)

Short-lived keys for a script or an AI session working on the system from
outside YisraCase: read-only SQL, cross-session notes, paging IT, and — only
when granted — the credentialed provider proxies. They used to be called
"readonly keys"; the name undersold them, so it changed. The key itself still
starts `ycro_`, and the request header is still `X-Readonly-Api-Key`.

**Where:** Admin → **Session Keys**. SU only (humans only — these endpoints
can't be reached with an API key, to avoid bootstrapping more access from less).

## What a key can do

A key reaches only the surfaces in its **scopes**:

| Scope | Lets the key call |
|---|---|
| `sql.ro` | `POST /api/readonly/sql` — read-only SQL (below) |
| `sql.ro.sensitive` | the same SQL may also read the **sensitive tables** (below) — short-lived keys only |
| `scratch` | `PUT` / `DELETE /api/scratch/…` — cross-session notes |
| `alert` | `POST /api/alert/it` — page IT |
| `temp.clio`, `temp.dropbox`, `temp.ringcentral`, `temp.zohosign` | the `/api/temp/<provider>/…` proxies — calls to that provider **with the firm's credentials** |

A new key gets `sql.ro`, `scratch` and `alert` — the boxes ticked by default
on the create form. The `temp.*` proxies are never granted by default: tick
the one the task needs (the form warns that they act with the firm's
credentials). An unknown scope is refused, not dropped. Keys issued
before scopes existed carry none recorded and keep reaching every surface —
except the sensitive tables, which only a key minted with `sql.ro.sensitive`
reads. A key that calls something outside its scopes gets a 403 that names
the missing scope.

The SQL surface, `POST /api/readonly/sql` with the key in the
`X-Readonly-Api-Key` header, body `{ sql, params?, maxRows?, timeoutMs? }`,
runs a **single read-only SQL statement** and returns the rows.
It is safe by construction, in layers:

1. Runs as the `yc_readonly` database user, which has **only SELECT** — it
   physically cannot write or change schema.
2. Multiple statements are disabled — no batching a write onto a read.
3. App-level read-only check rejects non-reads early with a friendly error.
4. `INTO OUTFILE` / `DUMPFILE` (file exfiltration) is rejected outright.
5. A per-statement execution-time limit kills runaway queries.
6. Results are row-capped (default 5,000, max 20,000) so a key can't dump the
   whole DB in one call. Timeout defaults to 30s (max 120s).
7. Some tables are withheld:

| Tables | Who can read them |
|---|---|
| `app_settings`, `email_ingest_sources` — live credentials | **no key, ever** (400). Use the [DB Console](01-db-console.md). |
| `jwt_api_audit_log`, `ai_calls`, `comms_transcripts`, `comms_no_transcribe`, `admin_audit_log`, `readonly_query_log` — client communications, AI prompts and replies, audit trails, other sessions' SQL | only a key holding `sql.ro.sensitive`; any other key gets a 403 naming that scope |
| `ai_spend` — `ai_calls` without its error / prompt / reply text | every key: use it for AI spend and volume questions |

A table name is matched anywhere in the statement, even inside a quoted
string, so a size query that merely *lists* `ai_calls` is refused too.

## Issuing a key

1. Give it a **label** (what/who it's for).
2. Optionally set a **TTL** (how long it lives) — **default 1 day, maximum 3
   days**. Keys are meant to be short-lived; re-issue rather than making them
   long.
3. Optionally set an **IP allowlist** to restrict where it can be used from.
4. Tick its **scopes** — at least one; the default three are pre-ticked.
   The **Sensitive** box sits on its own line: ticking it asks you to
   confirm, ticks `sql.ro` with it, and caps the TTL — a sensitive key lives
   **at most 24 hours (default 4)**, and a longer TTL is refused rather than
   shortened. Grant it for the one diagnostic session that needs it.
5. Create. **The key's plaintext is shown exactly once, right now.** Copy it
   immediately — it is never displayed again and is never stored or logged in
   plaintext anywhere (only a hash is kept).

## Key format

A key carries its own expiry date, so whoever holds it can tell whether it's
still alive without having to try it:

```
ycro_<22 random letters and digits>_20260715T1430Z
                                    └─ expires 15 Jul 2026, 14:30 UTC
```

Keys issued before the October 2026 format change carry 64 hex characters in
the middle instead; they keep working exactly as before.

The trailing stamp is always **UTC**, to the minute. It exists because the key
string is the part that gets pasted forward — into a script, a CI config, an AI
session — while the expiry date shown at create time gets left behind. Hand
someone a key and they can now read its shelf life straight off it.

Two things to know about that stamp:

- **It's a hint, not the rule.** Expiry is enforced from the database, which is
  the only authority. The stamp is there to be read, never to be trusted.
- **Editing it changes nothing.** Only the part before the second underscore
  (`ycro_<random part>`) identifies the key. Everything after it is a free
  note: rewrite the stamp, replace it with your own note, or drop it, and the
  key still works — and still expires when the database says.

Keys issued before this format existed have no stamp and keep working normally.

## Managing keys

- **List** active (or all) keys with their labels, scopes and expiry (a key
  issued before scopes existed shows "all (legacy)").
- **Revoke** a key at any time (it's marked revoked and stops working
  immediately) — do this the moment a key is no longer needed or might be
  exposed.
- **Per-key usage log** — see when and how a key has been used (`?limit`/
  `?offset`).

## Guardrails

- SU-only, humans-only.
- Key create and revoke are audited to `admin_audit_log` (`tool='readonlyKeys'`).
- Every query a `sql.ro.sensitive` key runs is flagged in its usage log
  (`readonly_query_log.sensitive_key = 1`). Such a key can read the logs
  themselves — a known, accepted limit; keep these keys short-lived.
- Plaintext keys never hit the logs — only the one-time create response.

## Related

This is the human-facing side of the same read-only access path the AI session
tools use; for write access to the live DB, see the
[DB Console](01-db-console.md) (and prefer this read-only path whenever a read
is all you need).
