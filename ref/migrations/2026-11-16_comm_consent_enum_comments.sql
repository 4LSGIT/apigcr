-- 2026-11-16 — COMMENTs for the five enum-ish consent columns P1 left bare
--
-- comm_consent_events.channel / .action and comm_consent_state.channel /
-- .scope / .state shipped without a COMMENT in
-- 2026-10-29_yisramail_p1_consent_core.sql; every other value column of the
-- two tables carries its vocabulary. Found by the docs review #4 schema sweep
-- (2026-11-15). COMMENT-only; definitions unchanged — no charset / COLLATE
-- clause in the MODIFY, so the columns keep inheriting the tables'
-- utf8mb4_general_ci (the script asserts it first) and the dumped DDL changes
-- in nothing but the COMMENT; ALGORITHM=INSTANT (proven on 8.4.11, 2026-11-16).
--
-- APPLIED BY: node scripts/commConsentEnumComments.js --apply
-- (one session: lock_wait_timeout = 5, the table collations, the live
-- definitions and the empty comments asserted first, verified after; a
-- column already carrying its text is skipped). Not for the SU console.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `comm_consent_events` MODIFY COLUMN `channel` enum('email','sms') NOT NULL COMMENT 'sms | email: the channel of the destination (MMS is recorded as sms, optoutService.CHANNELS). Picks the scope vocabulary: sms has all + topics, email has marketing + topics', MODIFY COLUMN `action` enum('opt_out','opt_in') NOT NULL COMMENT 'opt_out | opt_in (app-validated, optoutService.ACTIONS). Sets comm_consent_state.state to opted_out | opted_in when (occurred_at, id) is newest. An opt_in is recorded by staff (a signed-in user; automation and API keys are refused), by the preference page, or by an SMS START keyword while the number is opted out; providers and imports only opt out', ALGORITHM=INSTANT;
ALTER TABLE `comm_consent_state` MODIFY COLUMN `channel` enum('email','sms') NOT NULL COMMENT 'sms | email, as comm_consent_events.channel (MMS is sms). Primary key (channel, destination, scope)', MODIFY COLUMN `scope` varchar(40) NOT NULL COMMENT 'as comm_consent_events.scope: sms all | topic, email marketing | topic (no email all, D18). A send reads sms all (every text) and email marketing (marketing mail only), plus the topic row of a topic send. A row exists only for a scope an event has set', MODIFY COLUMN `state` enum('opted_out','opted_in') NOT NULL COMMENT 'opted_out | opted_in: the newest decision by (occurred_at, id). opted_out blocks a send that checks this scope. An opt_in topic (comm_topics.consent_model) sends ONLY to a destination whose topic row is opted_in, so no row = not sendable there; an opt_out topic sends unless opted_out', ALGORITHM=INSTANT;
