-- 2026-10-16 — ui-custom S3.4 follow-up: entitlement_denies.item_key COMMENT
--
-- Since S3.4 an item_key may be a firm launcher item id `firm:<slug>` as well
-- as a public/js/featureRegistry.js key (services/entitlementService
-- normalizeDeny). COMMENT-only change; definition unchanged.
--
-- APPLIED BY: node scripts/uiCustomS34ItemKeyComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition asserted first,
-- ALGORITHM=INSTANT, verified after). Do not paste this into the SU console —
-- /admin/db/batch spreads statements over pooled connections, so the session
-- setting would not reach the ALTER (CLAUDE.md, migrations that need a session).

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `entitlement_denies` MODIFY COLUMN `item_key` varchar(64)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
  COMMENT 'public/js/featureRegistry.js key OR a firm launcher item id firm:<slug> (ui-custom S3.4) — validated at write; moreSettings/helpSupport refused (undeniable)',
  ALGORITHM=INSTANT;
