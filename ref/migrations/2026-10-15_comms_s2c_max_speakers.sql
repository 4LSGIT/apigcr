-- ref/migrations/2026-10-15_comms_s2c_max_speakers.sql
--
-- Comms archive S2c-1 — the diarize speaker cap (ref/COMMS_ARCHIVE_DESIGN.md §6.3, §6.5).
--
--   Part A — BEFORE the backend: one settings row. Plain SQL (the SU console
--            is fine): no ALTER, no session variables.
--
-- The new backend reads this key uncached every tick and treats a MISSING or
-- garbage value as a configuration problem: transcription stops, alerted.
-- So this runs FIRST, or the deployed sweep submits nothing until it does.
--
-- Re-runnable: an edited value is never clobbered.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. The speaker cap for diarized (mono / mixed) jobs ────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_max_speakers', '2', 0, 0, 'Automations', 'Comms STT Max Speakers',
  '0–10. A diarized transcript (mono calls, voicemails, a stereo call when comms_stt_quo_stereo = diarize) is sent with this hard cap on speaker labels: extra voices merge into existing labels. 0 = no cap (the vendor default: up to 10 speakers on 2–10 min audio, 30 beyond). Multichannel jobs never get it. Anything else = transcription stops (alerted).',
  'number', 62)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SELECT `key`, `value` FROM app_settings WHERE `key` = 'comms_stt_max_speakers';
