# Part 12 — Database Schema

---

## `form_submissions` Table

Stores all drafts and submissions for all forms.

```sql
CREATE TABLE form_submissions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  form_key        VARCHAR(50)   NOT NULL,
  link_type       VARCHAR(20)   NOT NULL,
  link_id         VARCHAR(20)   NOT NULL,
  status          ENUM('draft','submitted') NOT NULL DEFAULT 'draft',
  version         INT UNSIGNED  NOT NULL DEFAULT 0,
  schema_version  INT UNSIGNED  NOT NULL DEFAULT 1,
  data            JSON          NOT NULL,
  submitted_by    INT UNSIGNED  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  draft_key       VARCHAR(100)  GENERATED ALWAYS AS (
                    CASE WHEN status = 'draft'
                         THEN CONCAT(form_key, ':', link_type, ':', link_id)
                         ELSE NULL
                    END
                  ) STORED,

  UNIQUE INDEX idx_draft_unique (draft_key),
  INDEX idx_form_entity (form_key, link_type, link_id, status),
  INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

---

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint PK | Auto-incrementing row ID |
| `form_key` | varchar(50) | Which form: `'contact_info'`, `'341_notes'`, `'issn'`, etc. |
| `link_type` | varchar(20) | Entity type: `'contact'`, `'case'`, `'appt'` |
| `link_id` | varchar(20) | Entity ID (varchar to support case_id format) |
| `status` | enum | `'draft'` or `'submitted'` |
| `version` | int | `0` for drafts. Submissions increment: 1, 2, 3... |
| `schema_version` | int | The form's `schemaVersion` when this row was created |
| `data` | json | Full form payload |
| `submitted_by` | int / null | User ID. NULL for external submissions |
| `created_at` | datetime | Row creation time |
| `updated_at` | datetime | Auto-updated on every change |
| `draft_key` | varchar(100) | Generated column for draft uniqueness |

---

## The `draft_key` Constraint

`draft_key` is a generated (computed) column:

- **Draft rows:** computes `form_key:link_type:link_id` (e.g., `contact_info:contact:1001`)
- **Submitted rows:** `NULL`

The `UNIQUE` index means:

- Only **one draft** per form+entity (database rejects a second)
- **Unlimited submitted rows** (MySQL allows multiple NULLs in unique indexes)

Autosave uses `INSERT ... ON DUPLICATE KEY UPDATE` — no SELECT needed, no race conditions.

---

## Row Types

### Drafts
- `status = 'draft'`, `version = 0` (always)
- One per form+entity (enforced by constraint)
- Upserted by autosave — overwritten repeatedly
- Not deleted on submit — becomes stale

### Submissions
- `status = 'submitted'`, `version` increments: 1, 2, 3...
- Append-only — each save creates a new row
- Never modified after creation

---

## Useful Queries

**Latest submission:**
```sql
SELECT * FROM form_submissions
WHERE form_key = '341_notes' AND link_type = 'case' AND link_id = 'uT7EU36v'
  AND status = 'submitted'
ORDER BY version DESC LIMIT 1;
```

**Current draft:**
```sql
SELECT * FROM form_submissions
WHERE form_key = 'contact_info' AND link_type = 'contact' AND link_id = '1001'
  AND status = 'draft' LIMIT 1;
```

**All forms filled for a case:**
```sql
SELECT DISTINCT form_key FROM form_submissions
WHERE link_type = 'case' AND link_id = 'uT7EU36v' AND status = 'submitted';
```

**Submission count:**
```sql
SELECT COUNT(*) FROM form_submissions
WHERE form_key = 'contact_info' AND link_type = 'contact' AND link_id = '1001'
  AND status = 'submitted';
```

---

## Relationships

`form_submissions` is standalone — no foreign keys. This is intentional:

- `link_id` is varchar (polymorphic — references contacts, cases, or appts)
- `submitted_by` references `users.user` conceptually but has no FK (allows NULL for external)
- Follows the same polymorphic pattern as `log.log_link_type` + `log.log_link_id`

---

## Schema Versioning

The `schema_version` column enables:

- **Draft recovery warnings** — mismatched version shows a warning on the banner
- **Historical context** — see which form version produced each submission
- **Safe evolution** — adding fields doesn't break old drafts (`populate` ignores unknown keys, leaves missing keys empty)

Bump `schemaVersion` in the `YCForm` config when you add, remove, or rename fields.
