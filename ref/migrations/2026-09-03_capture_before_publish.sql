-- Capture-before-publish slice (2026-09-03)
--
-- Adds 'captured' to hook_delivery_logs.status so a hook delivery aimed at a
-- workflow that cannot run yet (never published, or inactive) can record what
-- it actually did: it captured the payload as that workflow's init_data sample
-- instead of starting an execution.
--
-- Before this slice the never-published gate ran BEFORE the capture block at
-- all four execution-creation sites, so arming capture on a brand-new workflow
-- did nothing — the delivery logged "workflow #N has never been published" and
-- the payload was lost (live example: delivery log 10672, target 40 → wf48).
-- That deadlocked authoring: no sample → no workflow → nothing to publish →
-- never captures.
--
-- RUN THIS BEFORE DEPLOYING THE CODE PATCH — same reasoning as
-- ref/s7_migration.sql: this deployment's sql_mode lacks STRICT_TRANS_TABLES,
-- so writing 'captured' to the un-widened enum does NOT error, it silently
-- coerces to ''.
--
-- Backward compatible: existing rows untouched, DEFAULT unchanged, and the old
-- code writes only old values — safe ahead of the deploy and safe to leave in
-- place on a code rollback.
--
-- Value name matches hook_executions.status, which has carried 'captured'
-- since the hooks capture slice.

ALTER TABLE hook_delivery_logs
  MODIFY COLUMN status ENUM('success','failed','queued','captured')
  COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'failed';
