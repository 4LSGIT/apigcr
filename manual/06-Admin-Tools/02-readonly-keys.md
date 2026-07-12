# Readonly Keys (SU)

Short-lived API keys that grant **read-only** SQL access to the database from
outside YisraCase — for scripts, integrations, or an AI assistant that needs to
look at data without any ability to change it.

**Where:** More → **Readonly Keys**. SU only (humans only — these endpoints
can't be reached with an API key, to avoid bootstrapping more access from less).

## What a key can do

A key authorizes one thing: `POST /api/readonly/sql` with the key in the
`X-Readonly-Api-Key` header, body `{ sql, params?, maxRows?, timeoutMs? }`.
That endpoint runs a **single read-only SQL statement** and returns the rows.
It is safe by construction, in layers:

1. Runs as the `yc_readonly` database user, which has **only SELECT** — it
   physically cannot write or change schema.
2. Multiple statements are disabled — no batching a write onto a read.
3. App-level read-only check rejects non-reads early with a friendly error.
4. `INTO OUTFILE` / `DUMPFILE` (file exfiltration) is rejected outright.
5. A per-statement execution-time limit kills runaway queries.
6. Results are row-capped (default 5,000, max 20,000) so a key can't dump the
   whole DB in one call. Timeout defaults to 30s (max 120s).

## Issuing a key

1. Click new key and give it a **label** (what/who it's for).
2. Optionally set a **TTL** (how long it lives) — **default 1 day, maximum 3
   days**. Keys are meant to be short-lived; re-issue rather than making them
   long.
3. Optionally set an **IP allowlist** to restrict where it can be used from.
4. Create. **The key's plaintext is shown exactly once, right now.** Copy it
   immediately — it is never displayed again and is never stored or logged in
   plaintext anywhere (only a hash is kept).

## Key format

A key carries its own expiry date, so whoever holds it can tell whether it's
still alive without having to try it:

```
ycro_<64 random hex chars>_20260715T1430Z
                           └─ expires 15 Jul 2026, 14:30 UTC
```

The trailing stamp is always **UTC**, to the minute. It exists because the key
string is the part that gets pasted forward — into a script, a CI config, an AI
session — while the expiry date shown at create time gets left behind. Hand
someone a key and they can now read its shelf life straight off it.

Two things to know about that stamp:

- **It's a hint, not the rule.** Expiry is enforced from the database, which is
  the only authority. The stamp is there to be read, never to be trusted.
- **Editing it doesn't buy you time — it destroys the key.** The stamp is part
  of what gets hashed, so changing so much as a digit means the key no longer
  matches anything on file and is rejected as invalid.

Keys issued before this format existed have no stamp and keep working normally.

## Managing keys

- **List** active (or all) keys with their labels and expiry.
- **Revoke** a key at any time (it's marked revoked and stops working
  immediately) — do this the moment a key is no longer needed or might be
  exposed.
- **Per-key usage log** — see when and how a key has been used (`?limit`/
  `?offset`).

## Guardrails

- SU-only, humans-only.
- Key create and revoke are audited to `admin_audit_log` (`tool='readonlyKeys'`).
- Plaintext keys never hit the logs — only the one-time create response.

## Related

This is the human-facing side of the same read-only access path the AI session
tools use; for write access to the live DB, see the
[DB Console](01-db-console.md) (and prefer this read-only path whenever a read
is all you need).
