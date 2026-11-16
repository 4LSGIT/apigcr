-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-11-16 — comms-polish-2 bundle C2: a task can link to an EMAIL.
--
--   A. tasks.task_link_type ENUM gains 'email' (appended — the storage size
--      is unchanged, so the MODIFY is ALGORITHM=INSTANT, metadata only).
--      task_link_id then holds mail_messages.id (the hub's stored message).
--      Readers: services/taskService.js shapeRow ('email' → the message's
--      subject as the title, through LEFT JOIN mail_messages ON mm.id =
--      CAST(t.task_link_id AS UNSIGNED)); public/tasks.html openLinked opens
--      Comms at that message (index.html openCommsMessage → comms.html
--      ycOpenMessage / the workspace rest `email~m<id>`). Writers: the Comms
--      task dialog's "This email" chip (POST /api/tasks link_type 'email').
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST (house order), and here it MATTERS more than usual: sql_mode is
-- relaxed (no STRICT_TRANS_TABLES), so an INSERT with an enum value the
-- column lacks does not fail — it stores '' with a warning. A C2 backend
-- deployed before this ALTER would create tasks with an EMPTY link type and
-- an orphan link_id. taskService refuses unknown link types itself on create
-- and update (TASK_LINK_TYPES), so nothing but the six values reaches the
-- column; an 'email' link is written only by a signed-in reader of that
-- message (routes/api.tasks.js assertEmailLinkReadable).
-- Run through scripts/commsPolish2TasksEmailLink.js (CHECK, then --apply).
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- The script applies the MODIFY only while the enum lacks 'email'; the
-- statement itself is a full restatement of the column.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Only with no 'email' rows (SELECT COUNT(*) FROM tasks WHERE task_link_type
-- = 'email'): MODIFY back to the five values. With rows, NULL them first.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `tasks`
  MODIFY `task_link_type` enum('contact','case','appt','bill','event','email') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
    COMMENT 'What task_link_id names: contact (contacts.contact_id), case (cases.case_id), appt, bill, event, or — comms-polish-2 C2, 2026-11-16 — email (mail_messages.id, the Comms hub''s stored message; the tasks page opens Comms at it). App-validated too (taskService TASK_LINK_TYPES): relaxed sql_mode would store '''' for an unknown value',
  ALGORITHM=INSTANT;
