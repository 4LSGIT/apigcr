# 5 — API Keys (SU)

## For operators

**More → API Keys (SU).** Two different things live here:

- **External keys** — one per system that calls us (Pabbly, an adapter, a
  script). Mint, label, revoke, and see usage.
- **The internal key** — the app's credential for calling itself. One button:
  rotate.

> Not to be confused with [Readonly Keys](02-readonly-keys.md), which are
> short-lived SQL-read credentials. These are full API credentials.

### Minting a key

The raw key is shown **once**, at creation. We store only a hash — there is no
"show me that key again." If it's lost, revoke it and mint another.

Give it a label naming the system that will use it. The label is what usage
attribution keys off, so "Pabbly" is useful and "test2" is not.

### Rotating the internal key

Rotation moves the current key to a *previous* slot and makes a fresh one
current. **Both slots verify**, which is what makes rotation safe across
instances — a 60-second config-cache skew is harmless.

> **The displaced key stays valid until the next rotation.** So any external
> system still calling with the internal key survives **exactly one** rotation
> and breaks on the second. If something external is still using it, mint it a
> named key first.

### The usage log will mislead you if you let it

Read this before drawing conclusions from those numbers.

| What you might think | What's actually true |
|---|---|
| "No rows since I revoked it, so they stopped calling" | **No.** Rejected calls are invisible here — an unrecognized or revoked key never resolves to a label, so nothing is logged. Absence is not evidence |
| "This key made these calls" | Only if its label is unique. Two live keys sharing a label are **not** separable; the screen says so when it detects it |
| "I reused the label 'Pabbly', so it's ambiguous" | Reuse over *time* is fine — rows are bounded by each key's creation |

The cause is structural: there is no `api_key_id` column on
`jwt_api_audit_log`. `lib/auth.jwtOrApiKey` writes the key's **label** into
`username` (and the literal `internal` for the self-credential; pre-K1 rows used
`API_KEY`). Label → username is the only available join.

---

## Technical reference

### Rotation semantics

See `lib/firmConfig.js` and `lib/auth.jwtOrApiKey.js`.

The current effective key (`internal_api_key` setting → `INTERNAL_API_KEY` env)
moves to `internal_api_key_prev`; a fresh `yci_` key becomes current. Both slots
verify.

**Key material is never returned by rotate, never audit-logged, and never stored
in plaintext for external keys — hash only.**

### Usage-log attribution

Rows are lower-bounded at the key's `created_at` and upper-bounded at the
`created_at` of the next key sharing that label. That makes label *reuse*
unambiguous. Two keys alive at once under the same label are not separable; the
response sets `label_shared: true` so the UI can say so out loud.

### Query cost

`jwt_api_audit_log` has **no index beyond the PK** — it is write-heavy on every
authenticated request. These queries are backward PK scans with a filter, around
200ms worst case at current volume, which is fine for an admin-only screen.
Paging is **keyset** (`beforeId`) precisely so it doesn't degrade with depth.

> If the table passes ~1M rows, revisit — but weigh an index against the write
> cost on the hottest insert path in the app before adding one.

### API

Superuser only, audited.

| Route | Method | Purpose |
|---|---|---|
| `/api/api-keys` | GET | External keys + internal-key status |
| `/api/api-keys` | POST | `{label}` → mint. **Raw key returned once** |
| `/api/api-keys/:id/revoke` | POST | Immediate on this instance, ≤60s on others via cache TTL |
| `/api/api-keys/rotate-internal` | POST | Rotate the app-to-self key |
| `/api/api-keys/:id/log` | GET | Usage for one external key |
| `/api/api-keys/internal/log` | GET | Usage for the internal key |
| `/api/api-keys/rejected` | GET | App-wide 401s where no credential resolved |

`/api/api-keys/rejected` is the counterpart to the blind spot above: rejected
calls don't appear in a key's usage log, but they do appear here.
