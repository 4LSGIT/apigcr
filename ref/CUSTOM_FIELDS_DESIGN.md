# Custom Fields — Design & Pilot (living doc)

**Status: DESIGN RATIFIED 2026-09-22 · S0 worker prompt issued**
Living doc — update the Status line and the §7 slice table as slices ship. Doc≠code divergences found mid-work go to the docs-debt queue (scratch `ns=docs`), per house rule.
Manager boot state: scratch `ns=fred`, key `customfields_state`.
Provenance: two-instance design debate 2026-09-19 → 2026-09-22; all load-bearing claims verified against repo + live DB. Ratified by Fred 2026-09-22.

## 1. Decision

One `field_defs` registry as the single source of truth for admin-defined fields; values in one JSON column per entity; a **typed VIRTUAL generated column per active field** as the SQL surface; "promotion" of a hot field = adding an index to its virtual column, nothing more.

Expands the plans.md YC3 line: *"Tenant-defined fields: JSON column + field-definitions table + indexed generated columns for hot fields. Never EAV."*

Rejected permanently: EAV, preallocated slot columns, runtime DDL for real data columns, user-defined entities, Clio-style field-set/matter-template layers (`show_when` on a def replaces structural grouping).

## 2. Architecture

**`field_defs` registry** (sketch — S1 finalizes DDL):
`id, entity ('case'|'contact'|…), field_key, label, field_type, options JSON, validation JSON, show_when JSON, sensitive TINYINT, indexed TINYINT, sort_order, active, created_at, updated_at`
Open vocabulary, app-level validation (sql_mode is non-strict — same posture as `contact_roles`). Config versioning rides the YC3 config-as-data/undo mechanism when that exists; until then defs are rows.

**Storage:** `cases.custom`, `contacts.custom` — `JSON NOT NULL DEFAULT (JSON_OBJECT())`. Multi-select = JSON array (this pattern retires the `SET`-type and comma-string problems).

**SQL surface (load-bearing, not convenience):** a reconciler maintains, for every active def, a VIRTUAL generated column named exactly `field_key`, typed, string types declared `COLLATE utf8mb4_general_ci`. Three reasons it's mandatory:
1. **Raw-SQL consumers** can't go through an accessor: `report_definitions.sql_text` (staff + AI report builder), sequence `checkCondition`, portal cards SQL mode, RO-key holders. `query_db`'s identifier regex (`^[\w.]+$`) and the resolver's `^\w+$` check (resolverService ~:476) can only express column-shaped references.
2. **Collation semantics:** `custom->>'$.k'` compares as `utf8mb4_bin` (case-sensitive), and adding a matching functional index can silently flip results via optimizer substitution (measured: 1 row with index, 0 rows with IGNORE INDEX, same data). The declared-collation column is the only stable comparison surface.
3. **Sensitive-field enforcement:** the report validator's identifier scan blanks string literals (`stripLiterals`, lib/reportSchema/validator.js) — a JSON path inside a literal is invisible to the denylist; a virtual column name is a bare identifier the scan sees. JSON-only storage would make sensitive custom fields unenforceable against staff-authored SQL.

**Promotion = `indexed = 1`** on the def; the reconciler adds a secondary index on the virtual column (lookup measured ≈ real column, 0.27 ms vs 386 ms unindexed full scan @ 500k rows). Never a data move. STORED generated column only for the two verified corners a VIRTUAL can't serve: FK (ERROR 3733) and FULLTEXT (ERROR 3106).

**Type map** (def `field_type` → virtual column type):
| field_type | column type | note |
|---|---|---|
| text, select, url | VARCHAR/CHAR via CAST, COLLATE utf8mb4_general_ci | select stores option *value* |
| number, currency | DECIMAL(18,4) | |
| date / datetime | DATE / DATETIME | non-strict CAST of garbage → NULL on read; app validation is primary |
| boolean | TINYINT(1) | |
| multiselect | JSON-typed generated column | query via `MEMBER OF` — case/byte-sensitive, hence values ≠ labels |
| contact_ref | INT UNSIGNED | app-level integrity (twin-column precedent); STORED+FK only if ever proven needed |

**Policy wiring:** `sensitive=1` on a def feeds resolver blocklist, report/`query_db` denylists, and envelope exclusion — computed from the registry, caches bumped on def change. Static hand-kept lists are the disease this replaces (the same field list is hand-kept in ~10 places today, with live drift: `updateCase` blocks only the PK; the two contact ALLOWED lists coincide only by luck; sensitive lists disagree across resolver/reports/query_db).

## 3. Rules (invariants — write code against these)

- **Nothing anywhere compares on raw `custom->>'$.k'`** — only the named virtual column (or the write chokepoint).
- Write per key with `JSON_SET(custom, '$.k', ?)` composed into the **same UPDATE** as core columns; never read-modify-write the whole bag (concurrent form save + executor write would lose one).
- Never store JSON null (`->>` returns the string `'null'`); clearing a field = `JSON_REMOVE`.
- `changes` emitted per field key, never on the bag (`_diffNorm` does `String(v)` → `[object Object]`).
- Raw `custom` is excluded from envelopes, resolver, and reports **always**; sensitive `cf_` virtual columns excluded per registry. Note `SELECT *` includes virtual columns — exclusion must be per-column and registry-driven, and every active def widens every `SELECT *` (envelope size, AI-consumer tokens); acceptable, monitored.
- Namespace: `field_key` matches `^cf_[a-z][a-z0-9_]{1,60}$`; collision with any real column rejected at def creation (information_schema check). `cf_` is reserved.
- Validation is app-level from the def. `CHECK (JSON_SCHEMA_VALID(...))` DOES throw under non-strict (verified) but altering it is ALGORITHM=COPY — deferred; at most a coarse invariant (custom is an object).
- Reconciler: idempotent diff of defs vs information_schema; ADD/DROP VIRTUAL is ALGORITHM=INSTANT and spends no instant-DDL row versions (measured: 70 cycles → 0); still takes a brief exclusive MDL, so run with low `lock_wait_timeout` + retry, never mid-transaction-storm. Dropping a virtual column destroys no data (values live in JSON) — versioned-undo survives.

## 4. Fences

- **No completion semantics, companion dates, reminders, or stage gating in `field_defs`, ever.** That accretion is how Clio got its field-set layer. Trackers belong to checklists/`pipeline_stage_requirements`. The fence is behavioral, not numerical — the true-custom count drifting up is fine; one tracker sneaking in is not.
- Flat per-entity namespace; conditional display is `show_when` on the def.
- No user-defined entities (fixed entity set + custom fields covers the customizable-CRM goal; revisit only with a real need).
- `contact_roles.attrs` / `attrs_schema` stays exactly as-is; folding role attrs into the registry is a later question.
- **Integration/sync state is not a custom field.** Test: does the column carry concurrency semantics (conditional claim-writes, deliberate timestamp handling)? The Google sync trio (`contact_google_resource_name/_etag/_synced_at`) fails the test — `_persistLink` deliberately doesn't bump `contact_updated` (that's what terminates the drift sweep) and the reconcile-linker does a conditional claim-write. Those belong to the driver/external-refs layer. The pilot's Clio IDs are *passive* refs — acceptable as custom fields now, **graduate to `external_refs` in v3** (recorded so pilot success isn't read as "integration refs are custom fields forever").

## 5. v3 decomposition of today's `cases` (84 columns)

Custom fields are one of five registries; "domain-agnostic" = each registry absorbs its bucket. The BK vertical becomes seed data ("packages").

| Bucket | n | v3 home |
|---|---|---|
| Core matter | 17 | real columns |
| People on the matter | 4 | contact roles (in flight) |
| External refs | 3 | `external_refs` / driver layer |
| Dates, deadlines, meetings | 19 | unified events (`calendar_item_types` registry live) |
| Step trackers (SET "Sent/Signed/Filed", worksheet cells) | 22 | checklists / stage requirements — **right home, real design task** (per-item multi-state, not just done/not-done); not "already built" |
| Form linkage | 6 | `form_submissions` |
| True custom attributes | 13 | `field_defs` + `custom` |

Evidence the old approach doesn't self-correct: 19 `bk_*` columns added 2026-09-01, 0/1,088 populated, permanent in every `SELECT *`; `341_status` NOT NULL enum, no default → non-strict wrote 'Continued' to 1,088/1,089 rows. Absent JSON keys can't do either.

## 6. Tenancy & engine posture

Per plans.md (2026-09-14): multi-tenancy is a v3 maybe, **lean DB-per-tenant**, hold on tenant_id columns; **MySQL stays**. This design is engine-neutral and tenancy-neutral, and DB-per-tenant removes the fragile parts (shared index budget, facade views, cross-tenant `cf_` collisions). Per-tenant defs/columns/RO keys come free.

## 7. v2 pilot — slices

Both entities from row one (cases + contacts); the two write paths differ deliberately (blocklist single-statement vs ALLOWED-list transaction with reconcilers + Google push) and that difference is what the pilot must survive.

| Slice | Scope | Status |
|---|---|---|
| S0 | `update_contact` internal fn → delegate to `contactService.updateContact` (mirror of the `update_case`→service shape); strip `contact_ssn` at the fn (automation surface); wf37 step 424 keeps working through the service | **prompt issued 2026-09-22** |
| S1 | `field_defs` + editor cloned from the Contact Roles schema builder (`public/settings.html`, `routes/api.contactRoles.js`); entity-aware from row one | pending |
| S2 | `custom` columns + write chokepoint inside `updateCase`/`updateContact` (both entrances converge); fn ALLOWED lists become registry lookups; closes the updateCase any-column hole; per-field `changes` | pending |
| S3 | Reconciler: virtual columns for all active defs; index for one. **Pre-flight: re-run the spike suite (row-versions, INSTANT, collation-substitution demo) on a MySQL 8.4 clone** — spikes ran on 8.0.46; prod is Percona 8.4.6 | pending |
| S4 | Consumers with no bespoke code: auto-rendered Details section on case+contact forms (generalize the role-card renderer), one report, one trigger condition, one placeholder — **plus policy wiring** (sensitive flag → denylists, cache bump on def change) | pending |
| S5 | Migrate pilot fields into JSON keeping the same names (virtual column preserves every consumer verbatim, incl. wf37 step 405's `query_db` read); retire `case_clio_id` (drop, no migration) — this is also the retirement path for surplus columns | pending |

**Pilot fields** (fill @ 2026-09-22): `clio_matter` 240/1,089; `contact_clio_id` 245/1,086 (consumers: wf37 steps 405+424, one trigger-condition label); `case_clio_id` 0/1,089 (retirement demo). Rejected: the Google sync trio (§4).

**Kept-small fences:** contacts scoping is `contact_kind` only; other bypass writers (`contactMirror`, `routes/booking.js`, `gContactsService`) untouched (core columns only); no Google mapping for custom fields; nothing portal-visible; create paths are create-then-patch.

**Known consequences (expected, not regressions):** custom-field edits appear in event envelopes but not the contact log view (`after_contact_update` DB trigger doesn't cover `custom` — extend it or accept); any custom write bumps `contact_updated` → queues a no-op push in the Google drift sweep.

**Success criteria:** no consumer code changes in S4 beyond what the registry drives; the collation-semantics test passes; wf37 runs unchanged after S5's storage move; SS can add a field without a developer; a report referencing a sensitive `cf_` field by name is blocked by the validator.

**Not in the pilot:** tenancy, packages, Ask-AI, STORED promotion.

## 8. Measurements (local 8.0.46 @ prod sql_mode, 500k rows, 100 tenants × 5k — re-verify on 8.4 before S3)

| Operation | median |
|---|---|
| tenant-scoped JSON equality, no index (5k rows) | 3.8 ms |
| tenant-scoped JSON date range, no index | 6.6 ms |
| tenant-scoped sort on JSON date | 4.8 ms |
| whole-table (500k) JSON equality, no index | 386 ms |
| lookup via indexed virtual column | 0.27 ms |

At current scale (~1k cases), unindexed JSON scans are far below noticeable; `indexed=1` exists for fields that earn it.

## 9. Open items

- S3 pre-flight spike re-run on 8.4 clone (§7).
- Checklist/requirements absorption design for the 22 SET trackers — separate arc, prerequisite for retiring that bucket.
- `external_refs` graduation of the Clio IDs (v3).
- Registry unification (later): `contact_role_types.attrs_schema`, forms field configs, `reportSchema/manifest.js` all describe fields — converge on `field_defs` incrementally, never big-bang.
- Contact log view coverage for custom edits (§7 consequences) — decide extend-vs-accept during S4.
- Docs debt filed: report manifest calls `contact_updated` "auto-updating" — column has no `ON UPDATE`; every write path bumps it explicitly (verified: EXTRA is empty).
