# Schema conventions

**Applies to:** anything that writes DDL — the `ref/2026-*_*.sql` migrations in
this directory, and the schema they dump into [`database.sql`](database.sql).
**Enforced by:** [`tests/schemaConventions.test.js`](../tests/schemaConventions.test.js).

Two things about this database bite people who write migrations. Neither is
obvious from reading a `CREATE TABLE`, and both fail silently.

## Never write `DEFAULT CHARSET` without `COLLATE`

The schema default is `utf8mb4` / **`utf8mb4_general_ci`**. Every join key in
the system — `cases.case_id`, `contacts.contact_id`, `case_stage_log.case_id` —
uses it.

Writing `DEFAULT CHARSET=utf8mb4` with no `COLLATE` does **not** inherit that.
It resets to the *charset's* default, which on MySQL 8 is
`utf8mb4_0900_ai_ci`. Saying nothing at all would have been correct; saying
half of it breaks the table.

```sql
CREATE TABLE x (...) ENGINE=InnoDB;                                          -- ✅ inherits general_ci
CREATE TABLE x (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                                   COLLATE=utf8mb4_general_ci;               -- ✅ explicit, also fine
CREATE TABLE x (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;                  -- ❌ silently 0900_ai_ci
```

**Why it matters:** MySQL refuses `column = column` comparison across
collations. A table on the wrong one can never be joined to the core tables:

```sql
SELECT ... FROM trigger_executions t JOIN cases c ON c.case_id = t.case_id;
-- ERROR 1267: Illegal mix of collations for operation '='
```

**Why it hides for months:** `WHERE case_id = ?` never errors — a bound
literal is coercible and adopts the column's collation. Only column-to-column
joins fail. So the table works perfectly until the day someone writes the
first report across it, which is typically long after whoever wrote the
migration has moved on. 26 of 119 tables were created this way before anyone
noticed.

`utf8mb4_0900_ai_ci` is genuinely the better collation. It loses anyway: the
target has to be whatever the core tables already use, and moving 100+ tables
to reach 26 is not a trade. One collation beats the best collation.

**Enforced by** `tests/schemaConventions.test.js`, which lints
`ref/database.sql` in CI. If you add a table, run `npm run db:ref` and the
test will tell you before the join does. Normalization migration:
`ref/2026-08-17_collation_normalize.sql`.

## `sql_mode` has no `STRICT_TRANS_TABLES`

Over-length writes truncate silently and implicit NOT-NULL defaults are
accepted rather than rejected. Size columns to match what writes into them
and validate at the door in application code — the database will not do it
for you. Do not enable strict mode without first giving affected columns real
defaults; it would break case creation and `listCases`.
