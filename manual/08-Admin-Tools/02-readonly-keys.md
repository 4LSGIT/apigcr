# Session Keys (SU)

Short-lived keys for a script or an AI session working on the system from
outside YisraCase: read-only SQL, cross-session notes, paging IT, and — only
when granted — the credentialed provider proxies, minting child keys, or
handing staff tasks. They used to be called
"readonly keys"; the name undersold them, so it changed. The key itself still
starts `ycro_`, and the request header is still `X-Readonly-Api-Key`.

**Where:** Admin → **Session Keys**. SU only (humans only — these endpoints
can't be reached with an API key, to avoid bootstrapping more access from less).
The one exception is a **manager key** minting short-lived keys for its own
worker sessions — see [Manager keys and child keys](#manager-keys-and-child-keys).

## What a key can do

A key reaches only the surfaces in its **scopes**:

| Scope | Lets the key call |
|---|---|
| `sql.ro` | `POST /api/readonly/sql` — read-only SQL (below) |
| `sql.ro.sensitive` | the same SQL may also read the **sensitive tables** (below) — short-lived keys only |
| `scratch` | `PUT` / `DELETE /api/scratch/…` — cross-session notes |
| `alert` | `POST /api/alert/it` — page IT |
| `keys.mint` | mint, list and revoke its own **child keys** (below) — never ticked by default |
| `tasks.own` | create **tasks** for active staff and manage the ones it created ([below](#tasks-from-a-session-key)) — the one scope that writes to the firm's records; never ticked by default |
| `temp.clio`, `temp.dropbox`, `temp.ringcentral`, `temp.zohosign` | the `/api/temp/<provider>/…` proxies — calls to that provider **with the firm's credentials** |

A new key gets `sql.ro`, `scratch` and `alert` — the boxes ticked by default
on the create form. The `temp.*` proxies are never granted by default: tick
the one the task needs (the form warns that they act with the firm's
credentials). An unknown scope is refused, not dropped. Keys issued
before scopes existed carry none recorded and keep reaching every surface —
except the sensitive tables, which only a key minted with `sql.ro.sensitive`
reads, and `keys.mint` and `tasks.own`, which only a key given them holds. A key that calls something outside its scopes gets a 403 that names
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
| `jwt_api_audit_log`, `ai_calls`, `comms_transcripts`, `comms_no_transcribe`, `comms_summary_guides`, `admin_audit_log`, `readonly_query_log`, `assistant_chats`, `assistant_chat_messages` — client communications, AI prompts and replies, Ask Casey conversations, audit trails, other sessions' SQL | only a key holding `sql.ro.sensitive`; any other key gets a 403 naming that scope |
| `ai_spend` — `ai_calls` without its error / prompt / reply text | every key: use it for AI spend and volume questions |

A table name is matched anywhere in the statement, even inside a quoted
string, so a size query that merely *lists* `ai_calls` is refused too.

## Issuing a key

1. Give it a **label** (what/who it's for).
2. Optionally set a **TTL** (how long it lives) — **default 1 day, maximum 3
   days**. Keys are meant to be short-lived; re-issue rather than making them
   long.
3. Tick its **scopes** — at least one; the default three are pre-ticked.
   The **Sensitive** box sits on its own line: ticking it asks you to
   confirm, ticks `sql.ro` with it, and caps the TTL — a sensitive key lives
   **at most 24 hours (default 4)**, and a longer TTL is refused rather than
   shortened. Grant it for the one diagnostic session that needs it.
4. Create. **The key's plaintext is shown exactly once, right now.** Copy it
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

Session keys are **not** IP-restricted. The create form once had an "IP
allowlist" box; it was never enforced, so it was removed (October 2026) and a
request that still sends one is refused.

## Manager keys and child keys

Tick **`keys.mint`** to make a **manager key**: a key for a session that runs
other sessions (a manager handing work to workers). With it, the session
mints its own **child keys** — no trip back to this pane for each worker:

| Call (header `X-Readonly-Api-Key: <manager key>`) | Does |
|---|---|
| `POST /api/readonly-keys/children` `{ label, ttlMinutes?, scopes? }` | mint a child; returns `{ id, key, expiresAt, scopes }` — the key shown once |
| `GET /api/readonly-keys/children` | list this key's own children |
| `DELETE /api/readonly-keys/children/<id>` | revoke one of this key's own children |
| `POST /api/readonly-keys/children/<id>/renew` `{ ttlMinutes? }` | give one of this key's own children a new expiry, within the child limits below |

A child is always weaker than its parent:

- **Scopes**: only `sql.ro`, `scratch` and `alert`, and only those the
  manager key itself holds. Leave `scopes` out to get all of those. Anything
  else — another `keys.mint`, `sql.ro.sensitive`, a `temp.*` proxy — is
  refused, naming the scope. A child can never mint keys of its own.
- **Lifetime**: at most 24 hours, and never past the manager key's own
  expiry. Leave `ttlMinutes` out to get the longer that allows; ask for more
  and it is refused, not shortened. The same limits apply when a child is
  renewed.
- **Dies with its parent**: revoke the manager key (or let it expire) and
  every child stops working on its next request.
- **Shares the parent's alert budget**: a manager and all its children
  together get 10 IT alerts an hour.
- A manager key may mint **10 children per hour**; there is no limit on how
  many are alive at once. It sees and revokes only its own children — any
  other id reads as "not found".

Every child mint and revoke is audited (`admin_audit_log`,
`tool='readonlyKeys'`), and a child is created under the same owner as its
manager key.

## Tasks from a session key

Tick **`tasks.own`** to let a session hand work to people as tasks. With it the
key calls `/api/key-tasks` (header `X-Readonly-Api-Key`):

| Call | Does |
|---|---|
| `POST /api/key-tasks` `{ to, title, desc?, start?, due?, link_type?, link_id?, send_assignment_email?, notify? }` | create a task for an **active staff member** (`to` is their user id) |
| `GET /api/key-tasks` `?status=` | list this key's own tasks (open ones by default) |
| `GET /api/key-tasks/<id>` | one of them |
| `PATCH /api/key-tasks/<id>` | change its title, description, dates, link, assignee (`to`), or `notify` |
| `PATCH /api/key-tasks/<id>/complete`, `/reopen`, `/delete` | the usual actions (`note` on complete / delete) |

What to know:

- **It's the only scope that writes to the firm's records** — one table, and
  only tasks the key itself created. Any other task reads as "not found".
- The task is **assigned by you** (the super-user who issued the key), its
  source reads **Session key #N**, and its history says **via session key #N**.
- The assignee gets the usual **assignment email** unless the call sends
  `send_assignment_email: false`.
- When the task is completed, **you get the completion email** (you're its
  assigner) unless the call sends `notify: false`.
- **20 new tasks per hour** per key (a manager key and its children share
  that); editing isn't limited.
- The task's one-click action link is never handed to the key — it belongs to
  the person the task is for.
- Child keys never get `tasks.own`.

## Managing keys

- **List** active (or all) keys with their labels, scopes and expiry (a key
  issued before scopes existed shows "all (legacy)"). A child key shows its
  manager key in the **Parent** column, and reads **parent revoked** /
  **parent expired** — and drops out of "active only" — once its manager key
  is dead.
- **Revoke** a key at any time (it's marked revoked and stops working
  immediately) — do this the moment a key is no longer needed or might be
  exposed.
- **Per-key usage log** — see when and how a key has been used (`?limit`/
  `?offset`).
- **Change a key's scopes** with the row's **scopes** button: the same
  checkboxes, starting from what the key holds; saving replaces the whole
  list. A key issued before scopes existed starts with everything it reaches
  today ticked — once saved it is scoped for good. A child key's choices are
  only `sql.ro`, `scratch` and `alert`. To add `sql.ro.sensitive`, the key
  must have at most 24 hours left — renew it shorter first. Taking
  `keys.mint` away from a manager key leaves its children working (they die
  with it as before, and you can still revoke them here).
- **Renew a key** with the row's **renew** button: a new lifetime counted
  from now, within the same limits as when it was created (1 day by default
  and at most 3; a sensitive key 4 hours by default and at most 24; a child at
  most 24 hours and never past its manager key). Asking for more is refused,
  not shortened. An expired key can be renewed — that brings it back. The
  date stamp at the end of the key string doesn't change by itself; the
  pane shows the new stamp, which the holder may paste over the old one (it's
  only a hint either way).
- **Revoked is final.** A revoked key can't be edited or renewed — issue a
  new one.

## Guardrails

- SU-only, humans-only.
- Key create and revoke — child keys included — are audited to
  `admin_audit_log` (`tool='readonlyKeys'`).
- Every query a `sql.ro.sensitive` key runs is flagged in its usage log
  (`readonly_query_log.sensitive_key = 1`). Such a key can read the logs
  themselves — a known, accepted limit; keep these keys short-lived.
- Plaintext keys never hit the logs — only the one-time create response.

## Related

This is the human-facing side of the same read-only access path the AI session
tools use; for write access to the live DB, see the
[DB Console](01-db-console.md) (and prefer this read-only path whenever a read
is all you need).
