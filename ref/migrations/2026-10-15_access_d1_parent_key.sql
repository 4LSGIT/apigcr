-- Access-control D1 — delegated session keys: readonly_api_keys.parent_key_id
-- (stage 1, before the deploy) and the retirement of ip_allowlist (stage 2, after).
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/accessD1ParentKey.js           (CHECK)                 │
-- │   2. node scripts/accessD1ParentKey.js --apply                           │
-- │   3. land + deploy D1                                                    │
-- │ The D1 session-key auth SELECTs parent_key_id. Deployed first, that      │
-- │ SELECT fails and lib/auth.readonly fails CLOSED: EVERY ycro_ request is  │
-- │ a 500 "Auth lookup failed" until the column exists (proven on the 8.4    │
-- │ twin, tests/keyDelegation.mysql.test.js). The old backend names its      │
-- │ columns, so the new NULL column is invisible to it.                      │
-- │ ROLLBACK HAZARD: the pre-D1 backend does not know children — it would    │
-- │ authenticate a child of a revoked parent on the child's own row (its own │
-- │ ≤24h expiry and sql.ro/scratch/alert scopes still hold). Rolling the     │
-- │ backend back after children exist → revoke them first:                   │
-- │   UPDATE readonly_api_keys SET revoked_at = NOW()                        │
-- │    WHERE parent_key_id IS NOT NULL AND revoked_at IS NULL;               │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run through the script, not the SU console: it sets lock_wait_timeout and
-- (for the foreign key only, after proving there are no orphans)
-- foreign_key_checks on its own connection, refuses a pre-existing column /
-- index / constraint of another shape, verifies, and resumes.
--
-- NULL = a root key: every existing row is untouched. The index serves the
-- child-mint rate count and the child list. ON DELETE RESTRICT is deliberate:
-- CASCADE would silently delete children (and their query logs, through
-- fk_rqlog_key); SET NULL would promote children to root keys that no longer
-- die with their parent.
ALTER TABLE `readonly_api_keys`
  ADD COLUMN `parent_key_id` int NULL DEFAULT NULL
  COMMENT 'Delegation (access-control D1): NULL = a root key (SU-minted); else the id of the keys.mint key that minted this child. A child is refused at auth once its parent is revoked or expired; its effective scopes = own ∩ parent ∩ (sql.ro, scratch, alert). FK RESTRICT: no hard delete of a parent.'
  AFTER `scopes`,
  ALGORITHM=INSTANT;

ALTER TABLE `readonly_api_keys`
  ADD INDEX `idx_rok_parent` (`parent_key_id`, `created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- (the script runs this one with SET SESSION foreign_key_checks = 0, after its
-- orphan count is 0, so it is INPLACE rather than a COPY rebuild)
ALTER TABLE `readonly_api_keys`
  ADD CONSTRAINT `fk_rok_parent` FOREIGN KEY (`parent_key_id`)
  REFERENCES `readonly_api_keys` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ALGORITHM=INPLACE;

-- Session check after stage 1 (readonly SQL; expect 0 — no child exists until D1 deploys):
--   SELECT COUNT(*) FROM readonly_api_keys WHERE parent_key_id IS NOT NULL;

-- ═══ STAGE 2 — AFTER the D1 backend is deployed ═══════════════════════════
--   4. node scripts/accessD1ParentKey.js --check-drop
--   5. node scripts/accessD1ParentKey.js --apply-drop
-- ip_allowlist was stored at mint and enforced nowhere (Fred's ruling
-- 2026-10-15: retire it). The pre-D1 backend's SU mint INSERTs it and its SU
-- list SELECTs it, so this runs only once D1 (which never names it) is live —
-- the reverse of stage 1's order. The script lists the rows that still hold a
-- value before dropping.
ALTER TABLE `readonly_api_keys`
  DROP COLUMN `ip_allowlist`,
  ALGORITHM=INSTANT;
