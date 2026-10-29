-- DB Console schema snapshot
-- Generated: 2026-10-29T20:03:34.514Z
-- Source: scripts/dump-schema.js
-- Fingerprint: sha256:9daf0c4836094c364a6232bda59638d4
-- Contains schema only (no data, no database identifier).

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";
SET FOREIGN_KEY_CHECKS = 0;

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

-- --------------------------------------------------------

--
-- Table structure for table `admin_audit_log`
--

DROP TABLE IF EXISTS `admin_audit_log`;
CREATE TABLE `admin_audit_log` (
  `id` bigint NOT NULL,
  `tool` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'db_console, api_tester, ...',
  `user_id` int DEFAULT NULL,
  `username` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `route` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'success/error/rejected_not_su/rejected_rate_limit/...',
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT NULL,
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `details` json DEFAULT NULL COMMENT 'tool-specific fields (query_text/read_only_mode/row_count for db_console)',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `admin_saved_queries`
--

DROP TABLE IF EXISTS `admin_saved_queries`;
CREATE TABLE `admin_saved_queries` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `query_text` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_calls`
--

DROP TABLE IF EXISTS `ai_calls`;
CREATE TABLE `ai_calls` (
  `id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `prompt_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `prompt_version` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `model` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `mode` enum('sync','async') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'sync',
  `output_type` enum('text','json','html') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'text',
  `consumer_ref` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('ok','error','timeout') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `input_tokens` int DEFAULT NULL,
  `output_tokens` int DEFAULT NULL,
  `cost_cents` decimal(10,4) DEFAULT NULL,
  `latency_ms` int DEFAULT NULL,
  `request_excerpt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `response` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_change_log`
--

DROP TABLE IF EXISTS `ai_change_log`;
CREATE TABLE `ai_change_log` (
  `id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `source_message_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ai_call_id` int DEFAULT NULL,
  `court_ai_log_id` int DEFAULT NULL,
  `entity_type` enum('case','appt','event','workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `entity_id` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `field` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `old_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `new_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `dry_run` tinyint(1) NOT NULL DEFAULT '0',
  `undone_at` datetime DEFAULT NULL,
  `undone_by` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_match_sets`
--

DROP TABLE IF EXISTS `ai_match_sets`;
CREATE TABLE `ai_match_sets` (
  `id` int unsigned NOT NULL,
  `set_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `prompt_preamble` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `version` int unsigned NOT NULL DEFAULT '1',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_match_types`
--

DROP TABLE IF EXISTS `ai_match_types`;
CREATE TABLE `ai_match_types` (
  `id` int unsigned NOT NULL,
  `set_id` int unsigned NOT NULL,
  `type_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `disposition` enum('act','ignore','out_of_scope') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'ignore',
  `item_type` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `verb` enum('scheduled','rescheduled','cancelled','occurred','status_changed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `subject_match` json DEFAULT NULL,
  `recognition_hints` json DEFAULT NULL,
  `fields` json DEFAULT NULL,
  `collapse_same_date` tinyint(1) NOT NULL DEFAULT '0',
  `workflow_id` int DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `alert_state`
--

DROP TABLE IF EXISTS `alert_state`;
CREATE TABLE `alert_state` (
  `group_key` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `first_seen` datetime NOT NULL,
  `last_seen` datetime NOT NULL,
  `last_alerted_at` datetime DEFAULT NULL,
  `occurrence_count` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `api_keys`
--

DROP TABLE IF EXISTS `api_keys`;
CREATE TABLE `api_keys` (
  `id` int NOT NULL,
  `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `key_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `key_prefix` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL COMMENT 'NULL = non-expiring (legacy and infrastructure keys); checked at lookup',
  `scopes` json DEFAULT NULL COMMENT 'Key scopes (access-control B1): NULL = legacy full surface; else a JSON array of scope strings — surface (sql.ro, scratch, alert, temp.*), route:/<path>, or a capability name. Vocabulary: lib/capabilities.js KEY_SCOPES.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `api_saved_requests`
--

DROP TABLE IF EXISTS `api_saved_requests`;
CREATE TABLE `api_saved_requests` (
  `id` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GET',
  `url` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `headers` json DEFAULT NULL COMMENT '{"Header-Name":"value", ...}',
  `body` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'raw body string (JSON or otherwise)',
  `content_type` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `credential_id` int DEFAULT NULL COMMENT 'FK-by-convention to credentials.id; resolved at send time',
  `follow_redirects` tinyint(1) NOT NULL DEFAULT '1',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `app_settings`
--

DROP TABLE IF EXISTS `app_settings`;
CREATE TABLE `app_settings` (
  `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'The setting''s name; the primary key. utf8mb4_general_ci PAD SPACE: a lookup ignores case and trailing spaces (WHERE `key` = ''Firm_Name '' reads the firm_name row), and two keys that differ only so cannot coexist. lib/settingsRegistry.js matches keys exactly, so code that judges a key by name compares the row''s own key with it byte for byte (routes/api.appSettings.js, set_setting / get_setting).',
  `value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `is_secret` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'never returned by any settings API',
  `is_editable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'UNREGISTERED rows only (keys not in lib/settingsRegistry.js, the automation variables): 1 = listed and editable in YisraCase Config, Firm tab, Automation variables; 0 = served by no settings API. Ignored for a registered key: its edit posture comes from the registry.',
  `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'UNREGISTERED rows only: the grouping shown with an automation variable. A registered key takes its section from lib/settingsRegistry.js; this column is ignored for it.',
  `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'UNREGISTERED rows only: display label (blank = the key). Registered keys take theirs from lib/settingsRegistry.js.',
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'UNREGISTERED rows only: the operator hint. Registered keys take theirs from lib/settingsRegistry.js.',
  `type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'UNREGISTERED rows only: the validator type (string, template, number, bool, email, csv, phone, url, json, json_array, date; anything else is stored verbatim). A registered key validates by its lib/settingsRegistry.js type.',
  `sort_order` int DEFAULT NULL COMMENT 'UNREGISTERED rows only: the order among the automation variables. Registered keys take theirs from lib/settingsRegistry.js.',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Key / value settings. lib/settingsRegistry.js owns every key the code reads (kind, editor home, type, label, edit posture); for those rows only key, value, is_secret and updated_at carry meaning. The metadata columns describe UNREGISTERED rows: the automation variables created in YisraCase Config, Firm tab. Value history: app_settings_versions.';

-- --------------------------------------------------------

--
-- Table structure for table `app_settings_versions`
--

DROP TABLE IF EXISTS `app_settings_versions`;
CREATE TABLE `app_settings_versions` (
  `id` int unsigned NOT NULL,
  `setting_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'app_settings.key the change was to (no foreign key: the history outlives a deleted row)',
  `old_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'The value before this change; NULL = there was no row (a create, or the first write of a registered key) or it held NULL. Restore puts this back (NULL as an empty string).',
  `new_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'The value this change stored.',
  `changed_by` tinyint DEFAULT NULL COMMENT 'users.user of the staff JWT that made the change; NULL = a machine key (x-api-key)',
  `changed_via` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'ui (staff PUT) | api_key (machine PUT) | create (POST) | restore. App-validated.',
  `changed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the change was made.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Change history of app_settings values: one row per value change made through routes/api.appSettings.js (PUT, POST create, restore), written in the same transaction as the change; none when a save left the value unchanged. Never holds a secret: those routes never write one. Writes made elsewhere (automation set_setting / update_db, runtime state, key rotation, the SU db console) are not recorded.';

-- --------------------------------------------------------

--
-- Table structure for table `appts`
--

DROP TABLE IF EXISTS `appts`;
CREATE TABLE `appts` (
  `appt_id` int NOT NULL,
  `appt_client_id` int DEFAULT NULL,
  `appt_case_id` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_link_type` enum('case','contact','case_number') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'A3a anchor form. Derived by apptService (create + PATCH rewrites); NULL = unlinked (held slot) or pre-backfill. case_number = docket-anchored, resolves query-side.',
  `appt_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Anchor id for appt_link_type: case_id | contact_id | docket (either form). Derived, never PATCHed directly.',
  `appt_type` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `type_key` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'U2: calendar_item_types.type_key (by value, no FK). NULL = appt_type NULL, unresolved, or pre-backfill.',
  `appt_length` smallint DEFAULT NULL COMMENT 'minutes; smallint since 2026-10-28 — was signed tinyint, relaxed sql_mode clamped >127 to 127 silently',
  `appt_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `appt_status` enum('Attended','No Show','Rescheduled','Canceled','Scheduled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_date` datetime NOT NULL COMMENT 'Firm-local NAIVE datetime (America/Detroit). Pool runs UTC — use CONVERT_TZ/DATE_FORMAT, Luxon server-side',
  `appt_date_utc` datetime DEFAULT NULL,
  `appt_gcal` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_ref_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_platform` enum('telephone','Zoom','in-person') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_create_date` datetime DEFAULT NULL,
  `appt_with` tinyint DEFAULT '1',
  `appt_end` datetime GENERATED ALWAYS AS ((`appt_date` + interval `appt_length` minute)) STORED,
  `appt_gcal_user` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider-calendar event id',
  `appt_source` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'booking view source_tag',
  `appt_manage_token` char(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'client manage-link token (/m/<t>); 22-char base62 via lib/token, legacy 32-hex; _bin: case-sensitive bearer',
  `appt_view_id` int unsigned DEFAULT NULL COMMENT 'booking_views.id this appt was booked/rebooked through',
  `rescheduled_from_appt_id` int DEFAULT NULL COMMENT 'E0a atom: the appt this row replaced (reschedule or manage-page rebook). NULL = original booking, or pre-2026-08-27 row (not backfilled). No FK by convention (appts carries none).'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `assistant_action_ledger`
--

DROP TABLE IF EXISTS `assistant_action_ledger`;
CREATE TABLE `assistant_action_ledger` (
  `user_id` tinyint NOT NULL,
  `draft_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Server-minted UUID v4; user-scoped, never model-chosen',
  `kind` varchar(64) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Closed versioned action kind; old versions remain readable',
  `status` enum('in_flight','applied') COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'NULL is not-applied; in_flight without result is unknown forever, never retry',
  `claim_token` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT 'Receipt capability, not a session credential; never included in chat payload',
  `result` json DEFAULT NULL COMMENT 'Only the canonical task/event/appt/contact numeric id; no evidence or credentials',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Applied-result receipts; retained until actor deletion, independently of chat retention';

-- --------------------------------------------------------

--
-- Table structure for table `assistant_chat_messages`
--

DROP TABLE IF EXISTS `assistant_chat_messages`;
CREATE TABLE `assistant_chat_messages` (
  `id` bigint unsigned NOT NULL,
  `chat_id` bigint unsigned NOT NULL,
  `role` enum('user','assistant') COLLATE utf8mb4_general_ci NOT NULL,
  `message_text` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `payload` json DEFAULT NULL COMMENT 'assistant entities, citations, suggestions and compact query-count metadata; never SQL',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Ordered messages displayed in one user-private YisrAI chat';

-- --------------------------------------------------------

--
-- Table structure for table `assistant_chats`
--

DROP TABLE IF EXISTS `assistant_chats`;
CREATE TABLE `assistant_chats` (
  `id` bigint unsigned NOT NULL,
  `user_id` tinyint NOT NULL COMMENT 'users.user; ownership boundary for every read/write',
  `title` varchar(120) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'first question, whitespace-normalized and truncated',
  `model_mode` enum('better_quality','faster_speed') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'better_quality' COMMENT 'product-level model choice; provider model ids remain server-owned',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Ask YisrAI recent chats, private to the creating staff user';

-- --------------------------------------------------------

--
-- Table structure for table `availability_blocks`
--

DROP TABLE IF EXISTS `availability_blocks`;
CREATE TABLE `availability_blocks` (
  `id` int unsigned NOT NULL,
  `user` tinyint NOT NULL,
  `block_start` datetime NOT NULL,
  `block_end` datetime NOT NULL,
  `reason` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `booking_views`
--

DROP TABLE IF EXISTS `booking_views`;
CREATE TABLE `booking_views` (
  `id` int unsigned NOT NULL,
  `slug` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `provider_mode` enum('fixed_one','client_choice','any_auto') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'client_choice',
  `provider_ids` json NOT NULL,
  `appt_type` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `type_key` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `appt_length` smallint NOT NULL,
  `platform` enum('telephone','Zoom','in-person') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'telephone',
  `buffer_min` smallint NOT NULL DEFAULT '0',
  `min_notice_min` smallint NOT NULL DEFAULT '120',
  `horizon_days` smallint NOT NULL DEFAULT '30',
  `granularity_min` smallint NOT NULL DEFAULT '15',
  `identity_mode` enum('public','prefill') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'public',
  `source_tag` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `collect_note` tinyint(1) NOT NULL DEFAULT '0',
  `confirm_template` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `confirm_sms` tinyint(1) NOT NULL DEFAULT '0',
  `confirm_email` tinyint(1) NOT NULL DEFAULT '0',
  `hook_id` int DEFAULT NULL,
  `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `subtitle` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `accent_color` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `logo_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `logo_link_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `thankyou_html` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `page_windows` json DEFAULT NULL,
  `footer_html` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `calendar_approaching_emitted`
--

DROP TABLE IF EXISTS `calendar_approaching_emitted`;
CREATE TABLE `calendar_approaching_emitted` (
  `source` enum('appt','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'which table source_id points at — appts.appt_id | events.event_id',
  `source_id` int NOT NULL,
  `offset_days` smallint NOT NULL COMMENT 'days before item_date; 0 = on the day',
  `item_date` date NOT NULL COMMENT 'the item date this claim was made against. IN THE KEY on purpose: an in-place date move invalidates the old claim and re-arms every rung for the new date.',
  `emitted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='U8/A6: calendar.approaching claim ledger. INSERT IGNORE; affectedRows=1 = claimed.';

-- --------------------------------------------------------

--
-- Table structure for table `calendar_item_types`
--

DROP TABLE IF EXISTS `calendar_item_types`;
CREATE TABLE `calendar_item_types` (
  `type_key` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `kind` enum('hearing','meeting','deadline','conference','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'byte-identical to events.kind (E0a). meeting → appts, else → events (v0.5 §3.3.2).',
  `singleton` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'U2: data only. Enforced by the U6 write API behind unified_singleton_enabled.',
  `blocks_default` enum('attendee','firm','none') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'attendee' COMMENT 'U2: data only (was court_item_policy.blocks). Read at U6/U7.',
  `client_attends` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'U2: data only (was court_item_policy.attendance). Read at U6/U7.',
  `default_length` smallint DEFAULT NULL COMMENT 'minutes; court_v2 schema_gaps duration lands here (U7)',
  `approaching_offsets` json DEFAULT NULL COMMENT 'U8/A6: days-before offsets that emit calendar.approaching, e.g. [7,1]. NULL/[] = none. Distinct ints 0..365.',
  `ingest_aliases` json DEFAULT NULL COMMENT 'inbound free text → this key, WRITE TIME ONLY; never the row''s own label (ci)',
  `case_types` json DEFAULT NULL COMMENT 'picker scoping; NULL = all case types',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'gates pickers only; inactive types still resolve',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `calendar_type_options`
--

DROP TABLE IF EXISTS `calendar_type_options`;
CREATE TABLE `calendar_type_options` (
  `id` int unsigned NOT NULL,
  `type_key` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'FK-by-convention → calendar_item_types.type_key (no FK constraints, repo convention). Meeting types only.',
  `label` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'picker text override; NULL = the type''s label. Display only — appt_type is always the TYPE label.',
  `length` smallint unsigned NOT NULL COMMENT 'minutes offered by this option (1..1440)',
  `surfaces` json NOT NULL COMMENT 'non-empty subset of the closed surface vocabulary',
  `sort_order` int NOT NULL DEFAULT '0' COMMENT 'within the type; types order by calendar_item_types.sort_order first',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'inactive options are not offered; the type''s own active flag also gates',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='U2b: staff-picker options per calendar item type (length × surfaces). Presentation, not identity.';

-- --------------------------------------------------------

--
-- Table structure for table `campaign_contacts`
--

DROP TABLE IF EXISTS `campaign_contacts`;
CREATE TABLE `campaign_contacts` (
  `id` int unsigned NOT NULL,
  `campaign_id` int NOT NULL,
  `contact_id` int unsigned NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `campaign_results`
--

DROP TABLE IF EXISTS `campaign_results`;
CREATE TABLE `campaign_results` (
  `result_id` int NOT NULL,
  `campaign_id` int NOT NULL,
  `contact_id` int NOT NULL,
  `status` enum('sent','failed','skipped') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `sent_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `result_meta` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `campaigns`
--

DROP TABLE IF EXISTS `campaigns`;
CREATE TABLE `campaigns` (
  `campaign_id` int NOT NULL,
  `type` enum('sms','email') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `sender` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `subject` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `body` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `attachment_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `include_signature` tinyint(1) NOT NULL DEFAULT '0',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `status` enum('draft','scheduled','sending','sent','failed','partial_fail','canceled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'draft',
  `scheduled_time` datetime DEFAULT NULL,
  `created_by` tinyint unsigned DEFAULT NULL,
  `result_summary` json DEFAULT NULL,
  `contact_count` int unsigned NOT NULL DEFAULT '0',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `case_folder_cache`
--

DROP TABLE IF EXISTS `case_folder_cache`;
CREATE TABLE `case_folder_cache` (
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `folder_external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'utf8mb4_bin ON PURPOSE — case-sensitive Dropbox folder id; pairs with documents.external_id',
  `path_lower` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `path_display` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `resolve_error` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `resolved_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `relink_dismissed_at` datetime DEFAULT NULL,
  `relink_dismissed_by` tinyint DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `case_relate`
--

DROP TABLE IF EXISTS `case_relate`;
CREATE TABLE `case_relate` (
  `case_relate_id` int unsigned NOT NULL,
  `case_relate_case_id` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_relate_client_id` int unsigned NOT NULL,
  `case_relate_type` enum('Primary','Secondary','Other','Bystander') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `case_relate`
--
DELIMITER $$
CREATE TRIGGER `trg_prevent_duplicate_insert` BEFORE INSERT ON `case_relate` FOR EACH ROW BEGIN
    IF EXISTS (
        SELECT 1
        FROM case_relate
        WHERE case_relate_case_id = NEW.case_relate_case_id
        AND case_relate_client_id = NEW.case_relate_client_id
        AND case_relate_type = NEW.case_relate_type
    ) THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Duplicate entry based on case_id, client_id, and case_relate_type is not allowed';
    END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_prevent_duplicate_update` BEFORE UPDATE ON `case_relate` FOR EACH ROW BEGIN
    IF EXISTS (
        SELECT 1
        FROM case_relate
        WHERE case_relate_case_id = NEW.case_relate_case_id
        AND case_relate_client_id = NEW.case_relate_client_id
        AND case_relate_type = NEW.case_relate_type
    ) THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Duplicate entry based on case_id, client_id, and case_relate_type is not allowed';
    END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `case_requirement_overrides`
--

DROP TABLE IF EXISTS `case_requirement_overrides`;
CREATE TABLE `case_requirement_overrides` (
  `id` int unsigned NOT NULL,
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `requirement_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('na','done') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `set_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `case_stage_aged_emitted`
--

DROP TABLE IF EXISTS `case_stage_aged_emitted`;
CREATE TABLE `case_stage_aged_emitted` (
  `id` bigint unsigned NOT NULL,
  `stage_log_id` bigint unsigned NOT NULL,
  `threshold_days` int NOT NULL,
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `emitted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `case_stage_log`
--

DROP TABLE IF EXISTS `case_stage_log`;
CREATE TABLE `case_stage_log` (
  `id` bigint unsigned NOT NULL,
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `template_id` int unsigned DEFAULT NULL,
  `stage_id` int unsigned DEFAULT NULL,
  `stage_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_stage` enum('Open','Pending','Filed','Concluded','Closed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status_label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `entered_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `entered_by` tinyint DEFAULT NULL,
  `source` enum('manual','system','import') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cases`
--

DROP TABLE IF EXISTS `cases`;
CREATE TABLE `cases` (
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'OPAQUE free text server-side; docket-shape parsing is client-only (BK-specific). Collision check = equality',
  `case_number_full` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_caption` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_our_role` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_type` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_subtype` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `pipeline_phase` enum('intake','case') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'intake' COMMENT 'T8 lifecycle axis: intake funnel vs post-retainer case. Written by pipelineService.advanceStage from the entered stage template role.',
  `case_stage` enum('Open','Pending','Filed','Concluded','Closed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Open',
  `case_status` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_rec` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_open_date` date DEFAULT NULL,
  `case_file_date` date DEFAULT NULL,
  `case_close_date` date DEFAULT NULL,
  `case_discharge_date` date DEFAULT NULL,
  `case_garnish` set('Pre-Petition','Post-Petition') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'BK',
  `case_issues_bk_vehicle` set('Reaffirmation','Redemption','Replacement') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_issues_bk_other` set('Automatic Stay Violation','Student Loans','Confirmation Objections','Other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_pre_petition` set('Sent','Signed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_post_petition` set('Sent','Signed','N/A') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_1st_course` set('Sent Info','Received','Filed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_2nd_course` set('Sent Info','Received','Filed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `matrix` set('Extension Motion','Uploaded') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `matrix_date_original` date DEFAULT NULL,
  `matrix_date_proposed` date DEFAULT NULL,
  `schedules` set('Extension Motion','Filed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `schedules_due_original` date DEFAULT NULL,
  `schedules_due_proposed` date DEFAULT NULL,
  `filing_fee` set('Order Uploaded','Order Issued','Show Cause','Deadline Extended','Fee Paid','Fee Waived') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `final_installment` date DEFAULT NULL,
  `show_cause` datetime DEFAULT NULL,
  `filing_fee_extended_deadline` date DEFAULT NULL,
  `docs` set('Uploaded','Missing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `docs_due` date DEFAULT NULL,
  `docs_missing` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_intake_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_detailed_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_detailed_link` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_ISSN_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_341_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_source` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_source_ref` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_dropbox` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_primary_reason` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_judge` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Free text, AUTHORITATIVE. case_judge_contact_id fills on match / NULLs on miss; resolution never blocks a write',
  `case_judge_contact_id` int unsigned DEFAULT NULL,
  `case_trustee` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Free text, AUTHORITATIVE. Twin: case_trustee_contact_id. Canonical vocab = trustee roster (contacts with Trustee role; lib/trusteeRoster)',
  `case_trustee_contact_id` int unsigned DEFAULT NULL,
  `case_341_link` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `case_chapter` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_341_current` datetime DEFAULT NULL,
  `case_341_initial` date DEFAULT NULL,
  `case_objection` date DEFAULT NULL,
  `case_180` date DEFAULT NULL,
  `case_preference` date DEFAULT NULL,
  `341_appt_id` int NOT NULL,
  `341_status` enum('Continued','Completed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_docs` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_amend` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_alerts` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `bk_fee_application` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_fee_order_proposed` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_fee_order_issued` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_fee_amounts` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `bk_fee_dates_due` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `bk_fee_due` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_funding_app` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_clio_pay_schedule` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_reaffirmation` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_ch13_plan_filed` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_ch13_plan_cos` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_dismissal_notice` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_confirmation_hearing` date DEFAULT NULL,
  `bk_confirmation_exp_discharge` date DEFAULT NULL,
  `bk_confirmation_cert` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_2nd_course_due` date DEFAULT NULL,
  `bk_outcome` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_followup_email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `bk_7steps_course` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `custom` json NOT NULL DEFAULT (json_object()) COMMENT 'Custom-field values (ref/CUSTOM_FIELDS_DESIGN.md). Keys are field_defs.field_key (cf_*, entity=case). Written ONLY by caseService.updateCase: per-key JSON_SET/JSON_REMOVE in the same UPDATE as core columns, never read-modify-write. NEVER read or compare custom->>''$.k'' in SQL (the S3 virtual column is the only comparison surface). Never store JSON null (clear = JSON_REMOVE). Excluded by name from event envelopes, resolver and reports.',
  `cf_clio_matter` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (json_value(`custom`, _utf8mb4'$.cf_clio_matter' returning char(255) character set utf8mb4)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `cases`
--
DELIMITER $$
CREATE TRIGGER `trg_cases_ct_compat_ins` BEFORE INSERT ON `cases` FOR EACH ROW BEGIN
  -- Block A: legacy normalize
  IF NEW.case_type LIKE 'Bankruptcy - Ch%' THEN
    SET NEW.case_subtype = CONCAT('Chapter ', TRIM(SUBSTRING_INDEX(NEW.case_type, '.', -1)));
    SET NEW.case_type = 'Bankruptcy';
  END IF;
  -- Block B: fill whichever side is missing
  IF NEW.case_type = 'Bankruptcy' THEN
    IF NEW.case_chapter <> '' AND NEW.case_subtype = '' THEN
      SET NEW.case_subtype = CONCAT('Chapter ', NEW.case_chapter);
    ELSEIF NEW.case_subtype LIKE 'Chapter %' AND NEW.case_chapter = '' THEN
      SET NEW.case_chapter = SUBSTRING(NEW.case_subtype, 9);
    END IF;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_cases_ct_compat_upd` BEFORE UPDATE ON `cases` FOR EACH ROW BEGIN
  -- Block A: legacy normalize
  IF NEW.case_type LIKE 'Bankruptcy - Ch%' THEN
    SET NEW.case_subtype = CONCAT('Chapter ', TRIM(SUBSTRING_INDEX(NEW.case_type, '.', -1)));
    SET NEW.case_type = 'Bankruptcy';
  END IF;
  -- Block B: changed field wins
  IF NEW.case_type = 'Bankruptcy' THEN
    IF NEW.case_chapter <> OLD.case_chapter AND NEW.case_chapter <> '' THEN
      SET NEW.case_subtype = CONCAT('Chapter ', NEW.case_chapter);
    ELSEIF NEW.case_subtype <> OLD.case_subtype THEN
      IF NEW.case_subtype LIKE 'Chapter %' THEN
        SET NEW.case_chapter = SUBSTRING(NEW.case_subtype, 9);
      ELSEIF NEW.case_subtype = '' THEN
        SET NEW.case_chapter = '';
      END IF;
    END IF;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `channel_grants`
--

DROP TABLE IF EXISTS `channel_grants`;
CREATE TABLE `channel_grants` (
  `id` int unsigned NOT NULL,
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention); never 0 - automation bypasses grants (D6)',
  `channel_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'mailbox | phone_line - app-validated vocabulary, VARCHAR not ENUM so a new channel needs no ALTER',
  `channel_id` int unsigned NOT NULL COMMENT 'mailboxes.id when mailbox; phone_lines.id when phone_line (FK by convention)',
  `can_read` tinyint(1) NOT NULL DEFAULT '0',
  `can_send` tinyint(1) NOT NULL DEFAULT '0',
  `can_manage` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'grant others on this channel + edit its non-connection settings; never implies read/send',
  `granted_by` tinyint NOT NULL COMMENT 'users.user who created the row; history of later flag edits lives in admin_audit_log (tool=mailboxes for mailbox rows, tool=phone_lines for phone_line rows)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Channel access grants (D6). Enforced on INTERACTIVE routes only - never inside emailService/phoneService, so automation sends bypass. SU short-circuits in mailboxService; users.roles attorney READS every mailbox and every phone line without a row (send/manage still need one). phone_line rows since S-PH (2026-10-12): the Comms phone tab, the phone-line send route, and staff-JWT /internal/sms|mms/send';

-- --------------------------------------------------------

--
-- Table structure for table `checkitems`
--

DROP TABLE IF EXISTS `checkitems`;
CREATE TABLE `checkitems` (
  `id` int NOT NULL,
  `checklist_id` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('incomplete','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `position` int DEFAULT NULL,
  `tag` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_date` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `checkitems1`
--

DROP TABLE IF EXISTS `checkitems1`;
CREATE TABLE `checkitems1` (
  `checkitem_id` int unsigned NOT NULL,
  `checkitem_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checkitem_list_id` int unsigned NOT NULL,
  `checkitem_status` enum('complete','incomplete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'incomplete'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `checkitems1`
--
DELIMITER $$
CREATE TRIGGER `insert_checklist_status` AFTER INSERT ON `checkitems1` FOR EACH ROW BEGIN
    DECLARE total_checkitems INT;
    DECLARE completed_checkitems INT;

    SELECT COUNT(*) INTO total_checkitems FROM checkitems1 WHERE checkitem_list_id = NEW.checkitem_list_id;
    SELECT COUNT(*) INTO completed_checkitems FROM checkitems1 WHERE checkitem_list_id = NEW.checkitem_list_id AND checkitem_status = 'complete';

    IF total_checkitems = completed_checkitems THEN
        UPDATE checklists SET checklist_status = 'complete' WHERE checklist_id = NEW.checkitem_list_id;
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Checklist is complete';
    ELSE
        UPDATE checklists SET checklist_status = 'incomplete' WHERE checklist_id = NEW.checkitem_list_id;
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Checklist is incomplete';
    END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `update_checklist_status` AFTER UPDATE ON `checkitems1` FOR EACH ROW BEGIN
    DECLARE total_checkitems INT;
    DECLARE completed_checkitems INT;

    SELECT COUNT(*) INTO total_checkitems FROM checkitems1 WHERE checkitem_list_id = NEW.checkitem_list_id;
    SELECT COUNT(*) INTO completed_checkitems FROM checkitems1 WHERE checkitem_list_id = NEW.checkitem_list_id AND checkitem_status = 'complete';

    IF total_checkitems = completed_checkitems THEN
        UPDATE checklists SET checklist_status = 'complete' WHERE checklist_id = NEW.checkitem_list_id;
        SIGNAL SQLSTATE '02999' SET MESSAGE_TEXT = 'Checklist is complete';
    ELSE
        UPDATE checklists SET checklist_status = 'incomplete' WHERE checklist_id = NEW.checkitem_list_id;
        SIGNAL SQLSTATE '02999' SET MESSAGE_TEXT = 'Checklist is incomplete';
    END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `checklists`
--

DROP TABLE IF EXISTS `checklists`;
CREATE TABLE `checklists` (
  `id` int NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `kind` enum('checklist','note') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'checklist',
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `status` enum('incomplete','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `created_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_date` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` tinyint NOT NULL,
  `link` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `link_type` enum('contact','case','bill','appt','task','user','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tag` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `checklists1`
--

DROP TABLE IF EXISTS `checklists1`;
CREATE TABLE `checklists1` (
  `checklist_id` int unsigned NOT NULL,
  `checklist_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checklist_link` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checklist_status` enum('complete','incomplete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'incomplete'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `comm_consent_events`
--

DROP TABLE IF EXISTS `comm_consent_events`;
CREATE TABLE `comm_consent_events` (
  `id` bigint unsigned NOT NULL,
  `channel` enum('email','sms') COLLATE utf8mb4_general_ci NOT NULL,
  `destination` varchar(254) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'normalized: 10 digits (contactPhoneService.normalizePhone) | trimmed lowercased address (contactEmailService.normalizeEmail)',
  `scope` varchar(40) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'sms: all | topic; email: marketing | topic. There is NO email all (D18: an email opt-out is marketing-only)',
  `action` enum('opt_out','opt_in') COLLATE utf8mb4_general_ci NOT NULL,
  `source` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'staff | unsub_page | one_click | pref_page | sms_keyword | sms_review | provider_optout | provider_bounce | provider_complaint | import | web_form | migration | row_replace (app-validated, optoutService.SOURCES)',
  `provider_event_id` varchar(128) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'dedup key with source (uk_source_event): a provider event id, or migration:phone|email:<row id>; NULL never collides',
  `occurred_at` datetime(3) NOT NULL COMMENT 'UTC; when it happened (provider time when known). Orders the state: (occurred_at, id) newest wins',
  `contact_id` int unsigned DEFAULT NULL COMMENT 'best-effort attribution at the time — consent belongs to the destination, not the contact',
  `line_number` char(10) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'SMS: the firm line it arrived on / was sent from',
  `send_ref` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'campaign_results id / provider message id',
  `evidence` json DEFAULT NULL COMMENT 'proof: row_id, via (casey + draft_id), ip, user_agent, keyword text, raw inbound body, consent wording, form id …',
  `actor_user_id` int DEFAULT NULL COMMENT 'users.user of a staff change; NULL for automation / provider / migration',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Consent ledger (the proof). Append-only: never updated, never deleted. ONE writer: optoutService.recordConsent';

-- --------------------------------------------------------

--
-- Table structure for table `comm_consent_state`
--

DROP TABLE IF EXISTS `comm_consent_state`;
CREATE TABLE `comm_consent_state` (
  `channel` enum('email','sms') COLLATE utf8mb4_general_ci NOT NULL,
  `destination` varchar(254) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'same normalization as comm_consent_events.destination',
  `scope` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `state` enum('opted_out','opted_in') COLLATE utf8mb4_general_ci NOT NULL,
  `occurred_at` datetime(3) NOT NULL COMMENT 'occurred_at of the event that set this row',
  `last_event_id` bigint unsigned NOT NULL COMMENT 'comm_consent_events.id that set this row; an event wins only if (occurred_at, id) is newer',
  `updated_at` datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Current consent per (channel, destination, scope) — THE truth sends read (D2 a). contact_phones.sms_optout / contact_emails.email_optout cache the sms all / email marketing rows for one release. Written ONLY by optoutService.recordConsent';

-- --------------------------------------------------------

--
-- Table structure for table `comm_topics`
--

DROP TABLE IF EXISTS `comm_topics`;
CREATE TABLE `comm_topics` (
  `topic_key` varchar(40) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'scope name a consent row / send uses for this topic; [a-z0-9_]{1,40} (optoutService interpolates it into SQL, the shape is load-bearing)',
  `channel` enum('email','sms') COLLATE utf8mb4_general_ci NOT NULL COMMENT 'the one channel this topic belongs to; a marketing send on another channel treats the topic as unknown (blocked)',
  `label` varchar(100) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'shown on the preference page (P3)',
  `description` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'shown on the preference page (P3)',
  `consent_model` enum('opt_out','opt_in') COLLATE utf8mb4_general_ci NOT NULL COMMENT 'opt_out: sendable unless opted out; opt_in: sendable ONLY with state(topic)=opted_in (marketing SMS, D1)',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '0 = retired: a marketing send naming it is blocked for every destination (fail closed)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='YisraMail marketing topics (config-as-data). Read only through services/optoutService.js';

-- --------------------------------------------------------

--
-- Table structure for table `comms_eval_items`
--

DROP TABLE IF EXISTS `comms_eval_items`;
CREATE TABLE `comms_eval_items` (
  `media_id` bigint unsigned NOT NULL COMMENT 'comms_media.id (kind call_recording) in the S0 evaluation sample',
  `stratum` varchar(4) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'S1..S7 — the rubric §1 stratum it was drawn for',
  `seed` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'the selection seed (ORDER BY SHA2(id + seed)); fixed before the draw',
  `audio_s` int unsigned DEFAULT NULL COMMENT 'ESTIMATED audio length at draw time, seconds: comms_media.bytes ÷ the provider byte rate (rubric amendment A1) — the review windows are drawn inside it',
  `added_by` tinyint NOT NULL COMMENT 'users.user (SU) who inserted it',
  `added_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms archive S0 evaluation sample (lane D). Ids only — never call content';

-- --------------------------------------------------------

--
-- Table structure for table `comms_eval_reviews`
--

DROP TABLE IF EXISTS `comms_eval_reviews`;
CREATE TABLE `comms_eval_reviews` (
  `id` bigint unsigned NOT NULL,
  `reviewer_id` tinyint NOT NULL COMMENT 'users.user',
  `media_id` bigint unsigned NOT NULL COMMENT 'comms_eval_items.media_id',
  `stage` varchar(16) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'transcript | transcript_alt | summary — app-validated',
  `scores` json NOT NULL COMMENT 'validated: numbers, booleans, enum tags only (commsEvalService.validateScores)',
  `transcript_seen_at` datetime DEFAULT NULL COMMENT 'UTC; first time this reviewer was served the transcript — the noise tag is frozen from then on (blind rule)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms archive S0 evaluation scores (lane D). Never call content';

-- --------------------------------------------------------

--
-- Table structure for table `comms_media`
--

DROP TABLE IF EXISTS `comms_media`;
CREATE TABLE `comms_media` (
  `id` bigint unsigned NOT NULL,
  `channel` varchar(8) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'phone | mail — app-validated',
  `kind` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'call_recording | voicemail | mms_file | stt_raw | mail_raw | mail_attachment — app-validated',
  `source_table` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'phone_event_log (calls, MMS, Quo voicemails) | rc_message (RC voicemails: source_id = the RC message id — no call row) | comms_media (stt_raw: source_id = the parent row) | mail_messages',
  `source_id` bigint unsigned NOT NULL COMMENT 'id in source_table',
  `part` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' COMMENT 'provider recording / attachment id; '''' = placeholder before the provider lists any. Discovery tests existence on (source_table, source_id, kind) REGARDLESS of part — a recovered placeholder changes its part, so the unique key alone would re-insert it. stt_raw: the transcript''s source — ''quo'', the RC AudioTranscription attachment id, ''assemblyai'' (diarized; S2) or ''assemblyai-mc'' (multichannel; S2)',
  `provider` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'ringcentral | quo — phone_event_log.provider',
  `channel_id` int unsigned DEFAULT NULL COMMENT 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess). NULL = the source line is not a phone_lines row (orphan), or an RC voicemail left with no to-number (who may see it: S4)',
  `party` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'other party (10-digit) for phone — the log-style read-time anchor',
  `object_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'name inside comms_archive_bucket (ids only, design §4); NULL until archived',
  `mime` varchar(128) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'content-type as stored (allowlisted at fetch)',
  `bytes` bigint unsigned DEFAULT NULL,
  `sha256` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'hex sha256 of the stored bytes, computed in flight (or by re-hash on adopt)',
  `duration_s` int unsigned DEFAULT NULL COMMENT 'measured media length in seconds: the STT vendor''s audio_duration, written by the transcribe sweep (S2); NULL until transcribed',
  `audio_channels` tinyint unsigned DEFAULT NULL COMMENT 'channel count read from the archived file''s header by the transcribe sweep (S2); NULL until read',
  `captured_at` datetime DEFAULT NULL COMMENT 'provider time of the call/message, UTC wall clock (pool convention). Phone calls: raw_extra.started_at, else phone_event_log.processed_at when started_at is blank (tsi: rows). RC voicemails: the message creationTime. stt_raw: the parent''s. The cliff clock',
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending' COMMENT 'pending | archived | none | gone | failed | purged — app-validated (design §5)',
  `restricted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = SU/SS-only visibility (Restrict, design §8)',
  `attempts` int unsigned NOT NULL DEFAULT '0' COMMENT 'provider-side attempts only — our-side failures (bucket, auth, no line) never charge it',
  `next_attempt_at` datetime DEFAULT NULL COMMENT 'UTC; NULL = due now. Also the sweep''s per-row lease: a claim sets it ahead, so a crashed tick''s rows come back when it passes',
  `last_error` varchar(1000) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  `purged_at` datetime DEFAULT NULL,
  `purged_by` tinyint DEFAULT NULL COMMENT 'users.user',
  `purge_reason` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms archive registry (ref/COMMS_ARCHIVE_DESIGN.md). One row per archived file. Never deleted — purge clears content and stamps purged_*';

-- --------------------------------------------------------

--
-- Table structure for table `comms_no_transcribe`
--

DROP TABLE IF EXISTS `comms_no_transcribe`;
CREATE TABLE `comms_no_transcribe` (
  `id` int unsigned NOT NULL,
  `phone` char(10) COLLATE utf8mb4_general_ci NOT NULL COMMENT '10 digits — matched against the last 10 digits of comms_media.party',
  `note` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_by` tinyint DEFAULT NULL COMMENT 'users.user',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Numbers whose calls are archived but never transcribed or summarised (P6). SU / SS maintain it (R9); adding a number later does not touch existing transcripts — Restrict or Purge does';

-- --------------------------------------------------------

--
-- Table structure for table `comms_redo`
--

DROP TABLE IF EXISTS `comms_redo`;
CREATE TABLE `comms_redo` (
  `transcript_id` bigint unsigned NOT NULL COMMENT 'comms_transcripts.id sent back to be transcribed again (POST /api/comms-archive/redo). Written in the same transaction as the row''s flip to pending; deleted when the new transcript is stored (a stale one is harmless) and by purge',
  `requested_at` datetime NOT NULL COMMENT 'UTC. The transcribe sweep submits marked rows first, retires the old vendor JSON just before the new POST, and counts only main-job failures since this',
  `requested_by` tinyint DEFAULT NULL COMMENT 'users.user of the SU who asked',
  `prev_model` varchar(48) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'comms_transcripts.stt_model of the transcript being redone. The old text stays (hidden) in the row until the new one is stored; a redo that ends failed or skipped is RESTORED to transcribed with this model (the submit overwrote stt_model)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms archive S2c-2: transcripts being redone. A side table because comms_transcripts cannot take an ADD COLUMN without ALGORITHM=COPY (its FULLTEXT index refuses INSTANT and INPLACE — ref/COMMS_ARCHIVE_DESIGN.md §5, the schema landmine). Ids and times only';

-- --------------------------------------------------------

--
-- Table structure for table `comms_stt_jobs`
--

DROP TABLE IF EXISTS `comms_stt_jobs`;
CREATE TABLE `comms_stt_jobs` (
  `id` bigint unsigned NOT NULL,
  `transcript_id` bigint unsigned NOT NULL COMMENT 'comms_transcripts.id the job was submitted for',
  `media_id` bigint unsigned NOT NULL COMMENT 'comms_media.id (denormalised)',
  `vendor` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'assemblyai',
  `role` varchar(8) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'main (the transcript row''s variant) | alt (the sample-mode variant)',
  `variant` varchar(16) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'diarize | multichannel',
  `job_ref` varchar(191) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'the vendor''s job id. NULL = no id came back: the vendor MAY hold a job we never got an id for (state unknown — searched for by url_sha256)',
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'unknown | submitted | completed | error | lost | drift | orphan | refused — app-validated. WRITE-AHEAD: every row is inserted as unknown BEFORE its POST and resolved from the answer, so a process death mid-POST still leaves the spend and the search. drift = a 2xx we could not read; lost = the vendor 404ed it; orphan = an unknown found again in the vendor list; refused = the vendor definitely took nothing (a 4xx, 500) — est 0',
  `post_status` smallint DEFAULT NULL COMMENT 'HTTP status the POST answered; 0 = no answer (timeout / network); NULL = written ahead, no answer recorded (the process ended mid-POST)',
  `url_sha256` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'sha256 of the signed audio_url sent (one URL per POST, so unique per job) — never the URL (a bearer link); kept while the vendor may hold a job we cannot name',
  `est_cents` decimal(10,4) NOT NULL COMMENT 'estimated cost at submit — counted until the billed cost is known',
  `cost_cents` decimal(10,4) DEFAULT NULL COMMENT 'billed cost (vendor audio_duration × the price card) once completed',
  `submitted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC; the monthly cap sums every job by this',
  `finished_at` datetime DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL COMMENT 'UTC; the vendor CONFIRMED the delete (2xx or 404). NULL with a job_ref and no live use = a delete still owed — retried with backoff; the vendor''s 30-day TTL is the backstop',
  `delete_attempts` smallint unsigned NOT NULL DEFAULT '0',
  `delete_after` datetime DEFAULT NULL COMMENT 'UTC; next delete (or orphan search) not before this',
  `last_error` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Every STT vendor job ever submitted (comms archive S2): the spend ledger behind the monthly cap and the per-job owed-delete list. Ids and money only — never content; purge leaves it';

-- --------------------------------------------------------

--
-- Table structure for table `comms_summaries`
--

DROP TABLE IF EXISTS `comms_summaries`;
CREATE TABLE `comms_summaries` (
  `id` bigint unsigned NOT NULL,
  `transcript_id` bigint unsigned NOT NULL COMMENT 'comms_transcripts.id — the summary itself is written there (summary, summary_text, …); this row is only the work queue',
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending' COMMENT 'pending | calling | done | skipped | failed — app-validated. calling = a model call in flight (written AHEAD of it, so the monthly cap counts est_cents even if the process dies mid-call)',
  `skip_reason` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'restricted (back to pending once unrestricted) | short | empty | no_speech | not_transcribed | refused | purged',
  `model` varchar(48) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'the model of the latest call',
  `effort` varchar(8) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `est_cents` decimal(10,4) DEFAULT NULL COMMENT 'estimated cost of the call in flight; the cap counts it while state = calling (ai_calls holds the billed cost)',
  `attempts` int unsigned NOT NULL DEFAULT '0' COMMENT 'failed calls (timeout, 5xx, unusable output) — our-side stops (cap, credential, configuration) never charge it',
  `next_attempt_at` datetime DEFAULT NULL COMMENT 'UTC; NULL = due now. Also the per-row lease',
  `last_error` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'codes and reasons only — NEVER model output or transcript text',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI summary work queue, one row per transcript (comms archive S3). No content — that is on comms_transcripts';

-- --------------------------------------------------------

--
-- Table structure for table `comms_summary_guides`
--

DROP TABLE IF EXISTS `comms_summary_guides`;
CREATE TABLE `comms_summary_guides` (
  `transcript_id` bigint unsigned NOT NULL COMMENT 'comms_transcripts.id. One row = the CURRENT guide: a staff request (POST /api/comms-archive/media/:id/resummarize) replaces it. It drives EVERY later summary of this transcript (bulk and transcript redos included); purge deletes it',
  `model` varchar(48) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'the summary model asked for (claude-sonnet-5-5 | claude-haiku-5-5 — app-validated); overrides comms_summary_model for this transcript',
  `note` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'a staff hint about the call''s context, sent to the model as UNTRUSTED input (escaped, inside the user turn) — never a source for quotes or names. NULL = no note; a new request without a note clears it. Content: purge deletes the row; Restrict hides it with the summary',
  `note_by` tinyint DEFAULT NULL COMMENT 'users.user who wrote the note (NULL with no note)',
  `requested_at` datetime NOT NULL COMMENT 'UTC; the latest request. The summarize sweep runs a pending guide first',
  `requested_by` tinyint NOT NULL COMMENT 'users.user who asked',
  `version` int unsigned NOT NULL DEFAULT '1' COMMENT 'bumped on every request: the identity of a request (requested_at is seconds-precise, two requests can share it). The sweep''s write-ahead and its outcome stamp are conditional on the version it read',
  `outcome` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'NULL = pending (summary_pending) | done | failed | skipped — app-validated; set by the summarize sweep',
  `outcome_at` datetime DEFAULT NULL COMMENT 'UTC'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms archive S3c: the model + staff note a transcript''s summary is made with. A side table because both redo modes delete comms_summaries rows';

-- --------------------------------------------------------

--
-- Table structure for table `comms_transcripts`
--

DROP TABLE IF EXISTS `comms_transcripts`;
CREATE TABLE `comms_transcripts` (
  `id` bigint unsigned NOT NULL,
  `media_id` bigint unsigned NOT NULL COMMENT 'comms_media.id — a call_recording or voicemail. Visibility is the PARENT''s: every reader JOINs comms_media (restricted, channel_id) — Restrict hides derived text (R9); nothing is copied here',
  `phone_event_id` bigint unsigned DEFAULT NULL COMMENT 'phone_event_log.id — denormalised for joins; NULL for an RC voicemail (source_table rc_message: no call row)',
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending' COMMENT 'pending | transcribing | transcribed | summarized | skipped | failed | purged — app-validated (design §5)',
  `skip_reason` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'short | no_transcribe | over_cap | policy',
  `stt_vendor` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'assemblyai',
  `stt_model` varchar(48) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'model + variant of the canonical transcript, e.g. universal-3-5-pro+diarize',
  `stt_job_ref` varchar(191) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'vendor transcript id (canonical variant)',
  `alt_job_ref` varchar(191) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'sample mode only: vendor id of the other Quo-stereo variant — stored as an stt_raw child (part assemblyai-mc or assemblyai), never in this row',
  `language` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `speakers` tinyint unsigned DEFAULT NULL,
  `segments` json DEFAULT NULL COMMENT '[{s:speaker,a:start_s,b:end_s,t:text}] — s is A, B… (diarized) or ch1, ch2… (multichannel)',
  `full_text` mediumtext COLLATE utf8mb4_general_ci,
  `summary` json DEFAULT NULL COMMENT 'schema in COMMS_ARCHIVE_DESIGN §6.4',
  `summary_text` text COLLATE utf8mb4_general_ci,
  `summary_model` varchar(48) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ai_call_ids` json DEFAULT NULL COMMENT 'ai_calls.id of every summary attempt — purge clears their request_excerpt/response',
  `grounding_dropped` smallint unsigned DEFAULT NULL,
  `est_audio_s` int unsigned DEFAULT NULL COMMENT 'audio length estimated from the archived file''s header before submit (the P6 gate and the caps); comms_media.duration_s holds the vendor''s measured length',
  `stt_cost_cents` decimal(10,4) DEFAULT NULL COMMENT 'total STT spend for this row: every vendor job ever submitted for it (comms_stt_jobs — resubmits and the sample variant included), the billed cost once a job completed, its estimate otherwise. Kept in step with the ledger; never cleared — cost is not content, purge leaves it',
  `llm_cost_cents` decimal(10,4) DEFAULT NULL,
  `cap_released_by` tinyint DEFAULT NULL COMMENT 'users.user who released an over_cap skip (SU console — design §6.5)',
  `attempts` int unsigned NOT NULL DEFAULT '0' COMMENT 'vendor-side failures only — our-side failures (storage, signing, auth, cap) never charge it',
  `next_attempt_at` datetime DEFAULT NULL COMMENT 'UTC; NULL = due now. Also the per-row lease and the poll schedule',
  `last_error` varchar(1000) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `submitted_at` datetime DEFAULT NULL COMMENT 'UTC; the current vendor job was submitted',
  `transcribed_at` datetime DEFAULT NULL COMMENT 'UTC; month-to-date STT cost (the monthly cap) sums on it',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Transcript + AI summary per archived call recording / voicemail (ref/COMMS_ARCHIVE_DESIGN.md §5). Never broader than its comms_media row: readers JOIN it';

-- --------------------------------------------------------

--
-- Table structure for table `contact_addresses`
--

DROP TABLE IF EXISTS `contact_addresses`;
CREATE TABLE `contact_addresses` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `address1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `address2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `city` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `state` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `zip` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `country` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'US',
  `label` enum('Home','Work','Mailing','Other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Home',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `verified` tinyint(1) NOT NULL DEFAULT '0',
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `end_reason` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created_by` int NOT NULL DEFAULT '0',
  `updated_by` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_primary_uniq` int unsigned GENERATED ALWAYS AS (if(((`is_primary` = 1) and (`end_date` is null)),`contact_id`,NULL)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_emails`
--

DROP TABLE IF EXISTS `contact_emails`;
CREATE TABLE `contact_emails` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` enum('Personal','Work','Other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Personal',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `email_optout` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'messaging consent: 1 = opted out of email. THE consent flag (services/optoutService.js); only the active row (end_date IS NULL) counts; automation refuses, staff sends warn',
  `verified` tinyint(1) NOT NULL DEFAULT '0',
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `end_reason` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created_by` int NOT NULL DEFAULT '0',
  `updated_by` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_primary_uniq` int unsigned GENERATED ALWAYS AS (if(((`is_primary` = 1) and (`end_date` is null)),`contact_id`,NULL)) VIRTUAL,
  `email_active_uniq` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (if((`end_date` is null),`email`,NULL)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_phones`
--

DROP TABLE IF EXISTS `contact_phones`;
CREATE TABLE `contact_phones` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `phone` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` enum('Mobile','Home','Work','Office','Fax','Other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Mobile',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `sms_optout` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'messaging consent: 1 = opted out of SMS/MMS. THE consent flag (services/optoutService.js); only the active row (end_date IS NULL) counts; automation refuses, staff sends warn',
  `mms_capable` tinyint(1) NOT NULL DEFAULT '1',
  `verified` tinyint(1) NOT NULL DEFAULT '0',
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `end_reason` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created_by` int NOT NULL DEFAULT '0',
  `updated_by` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_primary_uniq` int unsigned GENERATED ALWAYS AS (if(((`is_primary` = 1) and (`end_date` is null)),`contact_id`,NULL)) VIRTUAL,
  `phone_active_uniq` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (if((`end_date` is null),`phone`,NULL)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_relation_types`
--

DROP TABLE IF EXISTS `contact_relation_types`;
CREATE TABLE `contact_relation_types` (
  `type_code` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `forward_label` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `reverse_label` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `is_symmetric` tinyint(1) NOT NULL DEFAULT '0',
  `allowed_statuses` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `allowed_end_reasons` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `sort_order` smallint NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_relations`
--

DROP TABLE IF EXISTS `contact_relations`;
CREATE TABLE `contact_relations` (
  `id` int unsigned NOT NULL,
  `contact_a_id` int unsigned NOT NULL,
  `contact_b_id` int unsigned NOT NULL,
  `type_code` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `status` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `end_reason` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` int NOT NULL DEFAULT '0',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `chk_no_self` CHECK ((`contact_a_id` <> `contact_b_id`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_role_types`
--

DROP TABLE IF EXISTS `contact_role_types`;
CREATE TABLE `contact_role_types` (
  `role_code` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `attrs_schema` json DEFAULT NULL,
  `sort_order` smallint NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contact_roles`
--

DROP TABLE IF EXISTS `contact_roles`;
CREATE TABLE `contact_roles` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `role` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `attrs` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` smallint NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contacts`
--

DROP TABLE IF EXISTS `contacts`;
CREATE TABLE `contacts` (
  `contact_id` int unsigned NOT NULL,
  `contact_kind` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'person' COMMENT 'ENTITY axis: person|org. contact_type is a dirty free-text role label — never overload it; roles live in contact_roles',
  `contact_org_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `contact_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_lfm_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_rname` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_fname` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_mname` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_lname` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_pname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_phone` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_email` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_address` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_city` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_state` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_zip` char(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_dob` date DEFAULT NULL,
  `contact_ssn` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'SSN for persons, EIN for orgs BY DESIGN — one column, two meanings; branch on contact_kind. Ordinary readable/writable column since the 2026-09-24 ruling (staff, resolver, esign templates, reports). Still refused by portal cards (client-facing) and stripped from domain-event envelopes (they outlive the row). NOT NULL but usually empty; format inconsistent (both 123456789 and 123-45-6789 occur) — strip non-digits before comparing.',
  `contact_marital_status` enum('Single','Married','Separated','Divorced','Widowed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `contact_tags` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_google_resource_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `contact_google_etag` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `contact_google_synced_at` datetime DEFAULT NULL,
  `contact_phone2` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_email2` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_created` datetime DEFAULT NULL,
  `contact_updated` timestamp NULL DEFAULT NULL,
  `contact_token` char(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'opaque per-contact bearer: booking prefill + video attribution; 22-char base62 via lib/token, legacy 32-hex; _bin: case-sensitive',
  `portal_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `portal_session_version` int NOT NULL DEFAULT '1',
  `custom` json NOT NULL DEFAULT (json_object()) COMMENT 'Custom-field values (ref/CUSTOM_FIELDS_DESIGN.md). Keys are field_defs.field_key (cf_*, entity=contact). Written ONLY by contactService.updateContact: per-key JSON_SET/JSON_REMOVE in the same UPDATE as core columns, never read-modify-write. NEVER read or compare custom->>''$.k'' in SQL (the S3 virtual column is the only comparison surface). Never store JSON null (clear = JSON_REMOVE). Excluded by name from event envelopes, resolver and reports.',
  `cf_clio_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (json_value(`custom`, _utf8mb4'$.cf_clio_id' returning char(255) character set utf8mb4)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `contacts`
--
DELIMITER $$
CREATE TRIGGER `after_contact_update` AFTER UPDATE ON `contacts` FOR EACH ROW BEGIN
    DECLARE log_data TEXT;
    SET log_data = JSON_OBJECT();
    SET log_data = JSON_OBJECT(
        'contact_id', NEW.contact_id
    );
    -- Compare each column and add changed fields to log_data
    IF OLD.contact_type != NEW.contact_type THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_type', OLD.contact_type,
            '$.new_contact_type', NEW.contact_type);
    END IF;

    IF OLD.contact_name != NEW.contact_name THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_name', OLD.contact_name,
            '$.new_contact_name', NEW.contact_name);
    END IF;


    IF OLD.contact_pname != NEW.contact_pname THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_pref_name', OLD.contact_pname,
            '$.new_contact_pref_name', NEW.contact_pname);
    END IF;

    IF OLD.contact_phone != NEW.contact_phone THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone', OLD.contact_phone,
            '$.new_contact_phone', NEW.contact_phone);
    END IF;

    IF OLD.contact_email != NEW.contact_email THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email', OLD.contact_email,
            '$.new_contact_email', NEW.contact_email);
    END IF;

    IF OLD.contact_address != NEW.contact_address THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_address', OLD.contact_address,
            '$.new_contact_address', NEW.contact_address);
    END IF;

    IF OLD.contact_city != NEW.contact_city THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_city', OLD.contact_city,
            '$.new_contact_city', NEW.contact_city);
    END IF;

    IF OLD.contact_state != NEW.contact_state THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_state', OLD.contact_state,
            '$.new_contact_state', NEW.contact_state);
    END IF;

    IF OLD.contact_zip != NEW.contact_zip THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_zip', OLD.contact_zip,
            '$.new_contact_zip', NEW.contact_zip);
    END IF;

    IF OLD.contact_dob != NEW.contact_dob THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_dob', OLD.contact_dob,
            '$.new_contact_dob', NEW.contact_dob);
    END IF;

    IF OLD.contact_ssn != NEW.contact_ssn THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_ssn', OLD.contact_ssn,
            '$.new_contact_ssn', NEW.contact_ssn);
    END IF;

    IF OLD.contact_marital_status != NEW.contact_marital_status THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_marital_status', OLD.contact_marital_status,
            '$.new_contact_marital_status', NEW.contact_marital_status);
    END IF;

    IF OLD.contact_tags != NEW.contact_tags THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_tags', OLD.contact_tags,
            '$.new_contact_tags', NEW.contact_tags);
    END IF;

    IF OLD.contact_notes != NEW.contact_notes THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_notes', OLD.contact_notes,
            '$.new_contact_notes', NEW.contact_notes);
    END IF;

    IF OLD.contact_phone2 != NEW.contact_phone2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone2', OLD.contact_phone2,
            '$.new_contact_phone2', NEW.contact_phone2);
    END IF;

    IF OLD.contact_email2 != NEW.contact_email2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email2', OLD.contact_email2,
            '$.new_contact_email2', NEW.contact_email2);
    END IF;

    -- Insert log entry if any changes were made
    IF JSON_LENGTH(log_data) > 1 THEN
        INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
        VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), NEW.contact_id, 1, log_data);
    END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `contact_name_insert` BEFORE INSERT ON `contacts` FOR EACH ROW SET
  NEW.contact_name = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(CONCAT_WS(' ',
        NEW.contact_fname,
        COALESCE(NEW.contact_mname, ''),
        COALESCE(NEW.contact_lname, '')
      ), CONCAT(' ', ' '), ' ')),
  NEW.contact_lfm_name = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(TRIM(CONCAT(
        COALESCE(NEW.contact_lname, ''),
        ', ',
        NEW.contact_fname, ' ',
        COALESCE(NEW.contact_mname, '')
      )), CONCAT(' ', ' '), ' ')),
  NEW.contact_rname = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(TRIM(CONCAT_WS(' ',
        COALESCE(NEW.contact_mname, ''),
        COALESCE(NEW.contact_lname, '')
      )), CONCAT(' ', ' '), ' '))
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `contact_name_update` BEFORE UPDATE ON `contacts` FOR EACH ROW SET
  NEW.contact_name = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(CONCAT_WS(' ',
        NEW.contact_fname,
        COALESCE(NEW.contact_mname, ''),
        COALESCE(NEW.contact_lname, '')
      ), CONCAT(' ', ' '), ' ')),
  NEW.contact_lfm_name = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(TRIM(CONCAT(
        COALESCE(NEW.contact_lname, ''),
        ', ',
        NEW.contact_fname, ' ',
        COALESCE(NEW.contact_mname, '')
      )), CONCAT(' ', ' '), ' ')),
  NEW.contact_rname = IF(NEW.contact_kind = 'org',
      TRIM(COALESCE(NEW.contact_org_name, '')),
      REPLACE(TRIM(CONCAT_WS(' ',
        COALESCE(NEW.contact_mname, ''),
        COALESCE(NEW.contact_lname, '')
      )), CONCAT(' ', ' '), ' '))
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `contract_template_pdfs`
--

DROP TABLE IF EXISTS `contract_template_pdfs`;
CREATE TABLE `contract_template_pdfs` (
  `template_id` int unsigned NOT NULL,
  `pdf` mediumblob NOT NULL,
  `size` int unsigned NOT NULL COMMENT 'byte length of pdf; listable without touching the blob',
  `original_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contract_templates`
--

DROP TABLE IF EXISTS `contract_templates`;
CREATE TABLE `contract_templates` (
  `id` int unsigned NOT NULL,
  `name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `template_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'html' COMMENT 'html = body rendered to PDF; pdf = stored source PDF filled via pdf-lib',
  `purpose` enum('esign','generate','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'esign' COMMENT 'esign = Send-for-Signature picker only; generate = Generate-document picker only; both = both',
  `file_subfolder` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Generated Documents' COMMENT 'Subfolder under the case Dropbox folder where generated (non-esign) output files',
  `body` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'HTML, rendered to PDF in a later phase',
  `prefill_schema` json NOT NULL COMMENT '[{key,label,type,resolver,default,required}]',
  `placement_json` json NOT NULL COMMENT '{"coord_space":"pdf_user_space","fields":[{page,x,y,w,h,type,signer}]}',
  `reminder_seq_id` int unsigned DEFAULT NULL COMMENT 'sequence_templates.id; NULL = firm default sequence',
  `completion_targets` json DEFAULT NULL,
  `reminders_off` tinyint(1) NOT NULL DEFAULT '0',
  `expiration_days` int NOT NULL DEFAULT '14',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `court_ai_log`
--

DROP TABLE IF EXISTS `court_ai_log`;
CREATE TABLE `court_ai_log` (
  `id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `message_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'utf8mb4_general_ci — SAME as email_log.message_id since the 2026-10-05 verification (this column was utf8mb4_unicode_ci once). The explicit COLLATE utf8mb4_general_ci clauses on the court-side joins (routes/courtReview.js, services/courtRerun.js, lib/internal_functions/court.js) are no-ops kept as insurance against re-divergence',
  `ai_call_id` int DEFAULT NULL,
  `dry_run` tinyint(1) NOT NULL DEFAULT '1',
  `classification` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_number` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `resolved_case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `actions_json` json DEFAULT NULL,
  `citations_json` json DEFAULT NULL,
  `skipped_json` json DEFAULT NULL,
  `outcome` enum('executed','queued','none','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `review_reason` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `raw_response` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `court_email_hashes`
--

DROP TABLE IF EXISTS `court_email_hashes`;
CREATE TABLE `court_email_hashes` (
  `content_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'sha256 hex (lowercase) of normWs(subject) + LF + normWs(body) - see lib/internal_functions/court.js CONTENT DEDUPE',
  `message_id` varchar(255) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'the OWNER: first message_id that reached court_extract with this content. Same id later = re-extract (proceeds); different id = duplicate delivery (skipped, court_ai_log duplicate_of:<owner>)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC) - first sighting'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='court_extract content dedupe: one row per distinct court-email content hash, owned by the first message_id. No time window - ECF bodies embed the entered-on timestamp, so an identical hash means identical input.';

-- --------------------------------------------------------

--
-- Table structure for table `court_emails`
--

DROP TABLE IF EXISTS `court_emails`;
CREATE TABLE `court_emails` (
  `subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `count` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `court_emails2`
--

DROP TABLE IF EXISTS `court_emails2`;
CREATE TABLE `court_emails2` (
  `subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `count` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `court_item_policy`
--

DROP TABLE IF EXISTS `court_item_policy`;
CREATE TABLE `court_item_policy` (
  `type_id` int unsigned NOT NULL,
  `storage` enum('appt','event','none') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `attendance` enum('none','ss','ss_client','client','staff') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `blocks` enum('none','ss','firm') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `calendar` enum('ss','firm','none') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `credentials`
--

DROP TABLE IF EXISTS `credentials`;
CREATE TABLE `credentials` (
  `id` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('internal','bearer','api_key','basic','oauth2') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'internal',
  `config` json DEFAULT NULL,
  `allowed_urls` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `access_token` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `refresh_token` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `access_token_expires_at` datetime DEFAULT NULL,
  `refresh_token_expires_at` datetime DEFAULT NULL,
  `last_refreshed_at` datetime DEFAULT NULL,
  `oauth_status` enum('pending_auth','connected','refresh_failed','revoked') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_state` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_pkce_verifier` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_last_error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `oauth_last_error_at` datetime DEFAULT NULL,
  `refresh_failure_count` tinyint unsigned NOT NULL DEFAULT '0',
  `verbose` tinyint(1) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cta_executions`
--

DROP TABLE IF EXISTS `cta_executions`;
CREATE TABLE `cta_executions` (
  `id` bigint unsigned NOT NULL,
  `cta_id` bigint unsigned NOT NULL,
  `option_value` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('running','success','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'running' COMMENT 'inserted running (same transaction as the claim) BEFORE step 1; running older than 15 min = crashed plan (sweep warns)',
  `plan_result` json DEFAULT NULL COMMENT 'per-step [{fn, ok, output|error, ms}], outputs truncated ~2k/step; readable via RO keys - redact accordingly',
  `responded_via` enum('link','app','api','timeout') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `responder_user_id` int DEFAULT NULL,
  `responder_ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `inputs` json DEFAULT NULL COMMENT 'clicker inputs (CTA_DESIGN §12) as the plan ran with them: {name: normalized value}, defaults applied, omitted optionals absent; NULL = option declares no inputs. SU-only like plan_result - readable via RO keys, redact accordingly'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='One row per CTA plan run. Never add to QUERY_DB_ALLOWED_TABLES / WRITE_POLICY (R3)';

-- --------------------------------------------------------

--
-- Table structure for table `cta_links`
--

DROP TABLE IF EXISTS `cta_links`;
CREATE TABLE `cta_links` (
  `id` bigint unsigned NOT NULL,
  `token` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'CTA bearer (/c/<t>); 22-char base62 via lib/token; _bin: case-sensitive',
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'internal label (SU list); never shown publicly',
  `prompt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'shown to the recipient; ESCAPED text — context_html is the only raw-HTML slot',
  `context_html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'TRUSTED HTML, same contract as decision_requests.context_html',
  `options` json NOT NULL COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?,inputs?}] 1-10; value "respond" reserved; params frozen literals (no {{...}}, no _-prefixed keys) EXCEPT "[[input:name]]" binding a declared input into a param its function opens via __meta.ctaInputParams: as the whole top-level value, or inline in the text of a content (never recipient) param. inputs (CTA_DESIGN §12): [{name,label,hint?,type,required,maxlen,choices?,choice_labels?,display?,pattern?,default?}] <=10, type text|phone|email|number|enum|date|html, maxlen <=1000, hint <=200, default stored normalized; enum only: choice_labels parallel to choices (page text, the value stays the choice), display select|radio (select not stored)',
  `mode` enum('once','repeatable') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'once' COMMENT 'app-validated too (relaxed sql_mode)',
  `max_uses` int unsigned DEFAULT NULL COMMENT 'repeatable only; NULL = until expiry',
  `uses_count` int unsigned NOT NULL DEFAULT '0' COMMENT 'once: 0|1 (the claim sets 1); repeatable: guarded increment; reset to 0 by re-enable from used (else the timeout claim is dead)',
  `expires_at` datetime NOT NULL COMMENT 'UTC; always set, <=365d out. expired is DERIVED from this, never stored in status',
  `timeout_option` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'once only: option value auto-run at expiry if unused (cta_expiry_sweep claims first)',
  `protection` enum('none','password') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'none',
  `password_hash` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'bcrypt, BCRYPT_ROUNDS=12; never a user password',
  `failed_attempts` int unsigned NOT NULL DEFAULT '0' COMMENT 'cumulative wrong passwords; alerts at 20 (warning) / 100 (error); never auto-disables',
  `return_plan_result` tinyint NOT NULL DEFAULT '0' COMMENT 'JSON respond surface may include raw plan_result (agent mints)',
  `attributed_user_id` int DEFAULT NULL COMMENT 'log attribution for link/password responses (assertion by mint, not authentication); never used by timeout executions',
  `status` enum('active','used','disabled','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active' COMMENT 'used = once claimed; disabled = PATCH, reversible; cancelled = permanent (R8). expired/exhausted are derived, never stored',
  `mint_source` enum('su','workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'su' COMMENT 'su: click-time check that minted_by is still an active SU (B1); workflow: no SU check',
  `source_execution_id` bigint unsigned DEFAULT NULL COMMENT 'workflow mints: the minting execution',
  `minted_by` int NOT NULL COMMENT 'users.user of the minting SU; 0 for workflow mints',
  `link_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'logService ABOUT_TYPES value set (log_link_type family), app-validated',
  `link_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'normalized like log about-links (phone 10 digits, email lowercased)',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='CTA links (ref/CTA_DESIGN.md). Never add to QUERY_DB_ALLOWED_TABLES / WRITE_POLICY (R3)';

-- --------------------------------------------------------

--
-- Table structure for table `decision_requests`
--

DROP TABLE IF EXISTS `decision_requests`;
CREATE TABLE `decision_requests` (
  `id` bigint NOT NULL,
  `token` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'decision bearer (/d/<t>); 22-char base62 via lib/token, legacy base64url; _bin: case-sensitive',
  `workflow_execution_id` bigint NOT NULL,
  `step_number` int NOT NULL,
  `resume_step` int NOT NULL,
  `recipient_kind` enum('user','contact','raw') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `recipient_user_id` int DEFAULT NULL,
  `recipient_contact_id` int DEFAULT NULL,
  `recipient_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `recipient_phone` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `question` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `context_html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `options` json NOT NULL,
  `result_var` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `timeout_value` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `status` enum('pending','responded','timed_out','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  `response_value` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `responded_at` datetime DEFAULT NULL,
  `responded_via` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `paired_task_id` bigint DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `default`
--

DROP TABLE IF EXISTS `default`;
CREATE TABLE `default` (
  `default_id` int NOT NULL,
  `default_response` enum('no results found') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `document_links`
--

DROP TABLE IF EXISTS `document_links`;
CREATE TABLE `document_links` (
  `id` bigint unsigned NOT NULL,
  `document_id` bigint unsigned NOT NULL,
  `link_type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `link_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `relation` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `document_sync_roots`
--

DROP TABLE IF EXISTS `document_sync_roots`;
CREATE TABLE `document_sync_roots` (
  `id` int unsigned NOT NULL,
  `path` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `syncing_since` datetime DEFAULT NULL,
  `sync_cursor` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `backfill_done` tinyint(1) NOT NULL DEFAULT '0',
  `last_sync_at` datetime DEFAULT NULL,
  `last_error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `stats` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `documents`
--

DROP TABLE IF EXISTS `documents`;
CREATE TABLE `documents` (
  `id` bigint unsigned NOT NULL,
  `source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'dropbox',
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'utf8mb4_bin ON PURPOSE — Dropbox ids are case-sensitive; never normalize this collation',
  `name` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `path` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `path_lower` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `path_hash` char(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ext` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `mime` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `content_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `rev` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `server_modified` datetime DEFAULT NULL,
  `shared_link` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `doc_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tags` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ai_meta` json DEFAULT NULL,
  `status` enum('active','deleted','missing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `pending_delete_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `domain_event_queue`
--

DROP TABLE IF EXISTS `domain_event_queue`;
CREATE TABLE `domain_event_queue` (
  `id` bigint unsigned NOT NULL,
  `event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `root_id` bigint unsigned DEFAULT NULL,
  `envelope` json NOT NULL,
  `status` enum('pending','running','done','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  `dispatches` int unsigned NOT NULL DEFAULT '0',
  `attempts` int unsigned NOT NULL DEFAULT '0',
  `claimed_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Scheduling AUTHORITY for split-phase trigger dispatch; the Cloud Task is only a doorbell';

-- --------------------------------------------------------

--
-- Table structure for table `email_credentials`
--

DROP TABLE IF EXISTS `email_credentials`;
CREATE TABLE `email_credentials` (
  `id` int unsigned NOT NULL,
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_host` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_port` int NOT NULL,
  `smtp_user` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_pass` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_secure` tinyint(1) NOT NULL DEFAULT '1',
  `provider` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'smtp',
  `credential_id` int DEFAULT NULL,
  `from_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `signature_html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `signature_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `owner_user` tinyint DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_executions`
--

DROP TABLE IF EXISTS `email_ingest_executions`;
CREATE TABLE `email_ingest_executions` (
  `id` bigint unsigned NOT NULL,
  `source_id` int unsigned DEFAULT NULL,
  `message_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('logged','duplicate','skipped_firm_to_firm','skipped_suppression','auth_failed','validation_failed','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_id` int unsigned DEFAULT NULL,
  `email_log_id` int unsigned DEFAULT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `metadata` json DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `remote_ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `action_failure_count` int unsigned GENERATED ALWAYS AS (coalesce(json_length(json_search(json_extract(`metadata`,_utf8mb4'$.action_outcomes[*].status'),_utf8mb4'all',_utf8mb4'failed')),0)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_log_suppressions`
--

DROP TABLE IF EXISTS `email_ingest_log_suppressions`;
CREATE TABLE `email_ingest_log_suppressions` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `match_mode` enum('conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_rule_actions`
--

DROP TABLE IF EXISTS `email_ingest_rule_actions`;
CREATE TABLE `email_ingest_rule_actions` (
  `id` int unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `position` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `action_type` enum('workflow','sequence','hook','internal_function','http') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `config` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_rule_changes`
--

DROP TABLE IF EXISTS `email_ingest_rule_changes`;
CREATE TABLE `email_ingest_rule_changes` (
  `id` bigint unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL COMMENT 'email_ingest_rules.id. No FK: the row outlives a deleted rule',
  `change_kind` varchar(20) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'create|update|activate|deactivate|delete|duplicate|action_add|action_update|action_delete (app-validated)',
  `action_id` int unsigned DEFAULT NULL COMMENT 'the email_ingest_rule_actions row, for the action_* kinds',
  `duplicated_from_rule_id` int unsigned DEFAULT NULL COMMENT 'duplicate: the source rule',
  `actor_user_id` int DEFAULT NULL COMMENT 'users.user of a staff JWT; NULL for an API key',
  `actor_key_id` int DEFAULT NULL COMMENT 'api_keys.id of a machine caller; NULL for staff and the internal key',
  `actor_label` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'the username, or api_key:<label>',
  `changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `definition_updated_at` datetime(3) DEFAULT NULL COMMENT 'the rule edit stamp AFTER this change; NULL for delete',
  `before_json` json DEFAULT NULL COMMENT '{rule, actions} before; NULL for create and duplicate. http url and literal header values redacted; over 256 KB a size + sha256 marker',
  `after_json` json DEFAULT NULL COMMENT '{rule, actions} after; NULL for delete. Same redaction and cap'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='APPEND-ONLY change log of email ingest rule definitions: one row per real change (the rule fields or its action rows), before and after, with the actor, written inside the edit transaction (services/ingestRuleChangeLog.js). The app never UPDATEs or DELETEs a row.';

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_rules`
--

DROP TABLE IF EXISTS `email_ingest_rules`;
CREATE TABLE `email_ingest_rules` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `position` int NOT NULL DEFAULT '0',
  `match_mode` enum('conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'NOT an edit stamp: ON UPDATE moves it on every match (the match_count bump), and an action edit never moves it. The edit stamp is definition_updated_at.',
  `definition_updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_sources`
--

DROP TABLE IF EXISTS `email_ingest_sources`;
CREATE TABLE `email_ingest_sources` (
  `id` int unsigned NOT NULL,
  `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `api_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `description` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_log`
--

DROP TABLE IF EXISTS `email_log`;
CREATE TABLE `email_log` (
  `id` int NOT NULL,
  `source` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `message_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `from_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `to_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `subject` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attachments` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `delivery_info` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Outbound SMTP only: JSON of what the transport said at handoff — {response, accepted, rejected, envelope}, or {error, responseCode, response, command} on the FAILED path. A row WITHOUT this proves nothing about delivery: it means the relay returned 250 and no more. response holds the relay queue id, the only handle that traces the message further. rejected can be non-empty on a RESOLVED send (nodemailer does not throw if one recipient was accepted). NULL for inbound/ingest rows and non-SMTP adapters.',
  `processed_at` datetime NOT NULL COMMENT 'MIXED wall clock BY WRITER (found 2026-10-09): ingest rows (services/emailIngestService.js — gmail-firm, mailbox-imap, siteground...) write Eastern via CONVERT_TZ(NOW(), @@session.time_zone, EST5EDT); outbound-* rows (services/adapters/email/gmail|smtp|pabbly.js) write NOW() = pool UTC. Cross-source time arithmetic is off by 4-5 h — compare within one source, or normalize per source first'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `entitlement_denies`
--

DROP TABLE IF EXISTS `entitlement_denies`;
CREATE TABLE `entitlement_denies` (
  `id` int unsigned NOT NULL,
  `scope` enum('firm','role','user') COLLATE utf8mb4_general_ci NOT NULL COMMENT 'firm = everyone; role = holders of scope_ref; user = users.user scope_ref',
  `scope_ref` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' COMMENT 'empty string = firm (sentinel; NOT NULL so the UNIQUE holds); role = a users.roles SET member; user = users.user as digits',
  `item_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'public/js/featureRegistry.js key OR a firm launcher item id firm:<slug> (ui-custom S3.4) — validated at write; moreSettings/helpSupport refused (undeniable)',
  `created_by` tinyint NOT NULL COMMENT 'users.user of the writer; 0 = an x-api-key caller',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Launcher entitlement DENIES (access-control A5). Deny-only: absent = allowed; any matching row denies. Visibility-only in v2 — no route enforcement.';

-- --------------------------------------------------------

--
-- Table structure for table `events`
--

DROP TABLE IF EXISTS `events`;
CREATE TABLE `events` (
  `event_id` int unsigned NOT NULL,
  `event_type` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `kind` enum('hearing','meeting','deadline','conference','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'E0a atom: what the event IS, independent of event_type free text. NULL = unclassified. Populated by E0b (judgment-gated), not here.',
  `type_key` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'U2: calendar_item_types.type_key (by value, no FK). NULL = unresolved/raw passthrough or pre-backfill.',
  `event_link_type` enum('case','contact','case_number') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `event_date` date NOT NULL,
  `event_time` time DEFAULT NULL,
  `event_all_day` tinyint(1) NOT NULL DEFAULT '0',
  `event_length` int DEFAULT NULL,
  `event_location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_link` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `event_status` enum('Scheduled','Completed','Canceled','Rescheduled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Scheduled' COMMENT 'U6c: Rescheduled = superseded by a successor row (paired with superseded_by_event_id + supersede_reason=''rescheduled''). Mirrors appt_status.Rescheduled. Canceled still means court-cancelled ONLY.',
  `event_resolution` enum('held','met','missed','moot','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'U3: HOW the event ended, per v0.5 §3.7. NULL = not recorded; the read layer falls back to met (deadline) / held (else) on Completed and cancelled on Canceled. No writer until U6.',
  `event_gcal` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_calendar_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_create_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `event_created_by` tinyint DEFAULT NULL,
  `event_updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `event_with` tinyint DEFAULT NULL COMMENT 'provider scope: users.user; NULL = firm-wide block',
  `superseded_by_event_id` int unsigned DEFAULT NULL COMMENT 'E0a atom: the event that replaced this one. NULL = this row is not superseded. No FK by convention (events carries none).',
  `supersede_reason` enum('rescheduled','duplicate') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'E0a atom: why this row was superseded. rescheduled = the court moved it; duplicate = tombstoned dedup artifact. NULL iff superseded_by_event_id IS NULL.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `feature_request_comments`
--

DROP TABLE IF EXISTS `feature_request_comments`;
CREATE TABLE `feature_request_comments` (
  `id` int unsigned NOT NULL,
  `request_id` int unsigned NOT NULL,
  `user_id` int NOT NULL,
  `parent_comment_id` int unsigned DEFAULT NULL,
  `comment` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `feature_request_votes`
--

DROP TABLE IF EXISTS `feature_request_votes`;
CREATE TABLE `feature_request_votes` (
  `id` int unsigned NOT NULL,
  `request_id` int unsigned NOT NULL,
  `user_id` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `feature_requests`
--

DROP TABLE IF EXISTS `feature_requests`;
CREATE TABLE `feature_requests` (
  `id` int unsigned NOT NULL,
  `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('bug','feature') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'feature',
  `stage` enum('considering','planning','working_on_it','implemented','future_thought','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'considering',
  `status_note` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `progress` tinyint unsigned NOT NULL DEFAULT '0',
  `is_public` tinyint(1) NOT NULL DEFAULT '1',
  `submitted_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `field_defs`
--

DROP TABLE IF EXISTS `field_defs`;
CREATE TABLE `field_defs` (
  `id` int unsigned NOT NULL,
  `entity` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'case | contact (v1 set; app-validated — sql_mode is non-strict). IMMUTABLE after create.',
  `field_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '^cf_[a-z][a-z0-9_]{1,56}$ (60 chars max, so the S3 index name idx_<key> fits MySQL''s 64-char identifier cap) — the JSON path in <entity>.custom AND the VIRTUAL column name on the entity table (the S3 reconciler creates it). IMMUTABLE after create; must not collide with a real column (checked at create).',
  `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `field_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'text | number | date | select | multiselect | boolean (v1 set; app-validated). Drives the S3 virtual column type (design doc §2 type map).',
  `options` json DEFAULT NULL COMMENT 'select/multiselect ONLY (NULL otherwise): [{"value","label"}]. value is the STORED form — byte-sensitive under MEMBER OF, so values are not labels. Unique case-insensitively.',
  `validation` json DEFAULT NULL COMMENT 'v1 keys: required, max_len, pattern (text), min, max (number). Enforced at write time from S2; S1 only stores it.',
  `show_when` json DEFAULT NULL COMMENT 'Conditional display, evaluated CLIENT-SIDE since S4 (2026-09-25): public/js/yc-custom-fields.js parseShowWhen/evalShowWhen; authored in the caseconfig fields builder. v1 vocabulary: ONE condition object {field, op, value?} — op eq|ne (scalar value) | in (non-empty scalar array) | not_empty|empty (no value). Any other shape VOIDS the condition (field always shown, stored value left untouched, console warning). NULL = always shown',
  `indexed` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Promotion flag for the S3 reconciler (secondary index on the virtual column). Not writable through the v1 API.',
  `sort_order` smallint NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'active=0 is RETIREMENT — there is no hard delete. Values already stored under the key persist in the JSON by design.',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `default_value` json DEFAULT NULL COMMENT 'Optional value stamped into <entity>.custom ONCE, at record creation, by the two create chokepoints: contactService.createContact and caseService.createCase (the only INSERT INTO contacts / INTO cases in the codebase) — ref/CUSTOM_FIELDS_DESIGN.md §3. NEVER retroactive (a def gaining or changing a default affects future creates only; backfilling existing records is a deliberate one-off UPDATE). Stamped regardless of show_when (data, not display). NULL = no default; there is no "default to clear". Validated at def save through validateValue against the merged def, so a stored default always satisfies its own field; select/multiselect defaults must name an ACTIVE option at save time, though a later-retired option keeps working (writes accept retired). Holds the JSON value itself — JSON string for text/date/select, number, boolean, or ARRAY for multiselect.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Custom-fields registry (ref/CUSTOM_FIELDS_DESIGN.md). Single source of truth for admin-defined fields; read through services/fieldDefService.js (cached).';

-- --------------------------------------------------------

--
-- Table structure for table `firm_blocks`
--

DROP TABLE IF EXISTS `firm_blocks`;
CREATE TABLE `firm_blocks` (
  `block_id` int unsigned NOT NULL,
  `block_start` datetime NOT NULL,
  `block_end` datetime NOT NULL,
  `label` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `source` enum('shabbos','yom_tov','manual') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
  `generated_for` date DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `form_submissions`
--

DROP TABLE IF EXISTS `form_submissions`;
CREATE TABLE `form_submissions` (
  `id` bigint unsigned NOT NULL,
  `form_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `link_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('draft','submitted') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft',
  `version` int unsigned NOT NULL DEFAULT '0',
  `schema_version` int unsigned NOT NULL DEFAULT '1',
  `data` json NOT NULL,
  `submitted_by` int unsigned DEFAULT NULL,
  `linked_by` int unsigned DEFAULT NULL,
  `linked_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `draft_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS ((case when (`status` = _utf8mb4'draft') then concat(`form_key`,_utf8mb4':',`link_type`,_utf8mb4':',`link_id`) else NULL end)) STORED
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `form_template_versions`
--

DROP TABLE IF EXISTS `form_template_versions`;
CREATE TABLE `form_template_versions` (
  `id` int unsigned NOT NULL,
  `template_id` int unsigned NOT NULL,
  `schema_version` int unsigned NOT NULL,
  `definition` json NOT NULL,
  `published_by` int unsigned DEFAULT NULL,
  `published_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `form_templates`
--

DROP TABLE IF EXISTS `form_templates`;
CREATE TABLE `form_templates` (
  `id` int unsigned NOT NULL,
  `form_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `link_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `schema_version` int unsigned NOT NULL DEFAULT '1',
  `definition` json DEFAULT NULL,
  `draft_definition` json NOT NULL,
  `published_at` datetime DEFAULT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `visibility` enum('internal','portal','public') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'internal'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `holidays`
--

DROP TABLE IF EXISTS `holidays`;
CREATE TABLE `holidays` (
  `holiday_id` int NOT NULL,
  `holiday_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `holiday_date` date NOT NULL,
  `start_time` time DEFAULT '18:00:00',
  `end_time` time DEFAULT '21:00:00',
  `is_two_day` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `hook_delivery_logs`
--

DROP TABLE IF EXISTS `hook_delivery_logs`;
CREATE TABLE `hook_delivery_logs` (
  `id` bigint NOT NULL,
  `execution_id` bigint NOT NULL,
  `target_id` int NOT NULL,
  `request_url` varchar(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `request_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `request_body` json DEFAULT NULL,
  `response_status` int DEFAULT NULL,
  `response_body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `status` enum('success','failed','queued','captured') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'failed',
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attempts` int NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `hook_executions`
--

DROP TABLE IF EXISTS `hook_executions`;
CREATE TABLE `hook_executions` (
  `id` bigint NOT NULL,
  `hook_id` int NOT NULL,
  `slug` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `filter_passed` tinyint(1) DEFAULT NULL,
  `transform_output` json DEFAULT NULL,
  `status` enum('received','filtered','processing','delivered','partial','failed','captured') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'received' COMMENT 'received = queued for the drain (claimed_at NULL) or running filter and transform (claimed_at set, completed_at NULL); processing = transform written, targets running; filtered | delivered | partial | failed | captured = final. A row stuck in processing after its claim must NOT be re-run automatically — targets may have fired. (Async receiver, 2026-10-28)',
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `claimed_at` datetime(3) DEFAULT NULL COMMENT 'Async receiver (2026-10-28): when a drain — the Cloud Tasks doorbell POST /process-hook-execution/:id or the /process-jobs cron — claimed this row to run filter, transform and targets. NULL = still queued (status received), or a row that predates the async receiver. The claim is ONE conditional UPDATE (WHERE status = received AND claimed_at IS NULL): Cloud Tasks delivers at least once and the loser of the claim does nothing. A synchronous run (dry run, live-test, /internal/hook-replay, the kill-switch path) sets claimed_at at INSERT so the drain never picks it up.',
  `completed_at` datetime(3) DEFAULT NULL COMMENT 'Async receiver: when the drain finished and status became final. completed_at - created_at is the end-to-end pipeline time (created_at is receipt). NULL while queued or running, and on rows that predate the async receiver.',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0' COMMENT 'Async receiver: claims so far, bumped AT claim time (a run that killed its instance has already spent its attempt). The stale sweep (lib/hookDrain.js) re-queues or fails a claimed row that never completed; its window and cap live there.',
  `dedup_key` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Async hook receiver S3 (2026-10-27): the provider event id resolved from hooks.dedup_path at receipt (longer than 191 chars: sha256 hex). UNIQUE with hook_id — a redelivered event fails its INSERT and is answered 200 with no row. NULL when the hook has no path, the event no value, or the row was written by a synchronous run (live-test, replay, kill-switch path) — NULLs never collide.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `hook_targets`
--

DROP TABLE IF EXISTS `hook_targets`;
CREATE TABLE `hook_targets` (
  `id` int NOT NULL,
  `hook_id` int NOT NULL,
  `target_type` enum('http','workflow','sequence','internal_function') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'http',
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `position` int NOT NULL DEFAULT '0',
  `method` enum('GET','POST','PUT','PATCH','DELETE') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'POST',
  `url` varchar(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `headers` json DEFAULT NULL,
  `credential_id` int DEFAULT NULL,
  `body_mode` enum('transform_output','template') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'transform_output',
  `body_template` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `config` json DEFAULT NULL,
  `conditions` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `hooks`
--

DROP TABLE IF EXISTS `hooks`;
CREATE TABLE `hooks` (
  `id` int NOT NULL,
  `slug` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `auth_type` enum('none','api_key','hmac') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'none',
  `auth_config` json DEFAULT NULL,
  `filter_mode` enum('none','conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'none',
  `filter_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `dedup_path` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Async hook receiver S3 (2026-10-27): dot-path into the received event ({body,headers,query,method,meta}) of the PROVIDER event id — RingCentral body.uuid, Quo body.id. The receiver stores the resolved value as hook_executions.dedup_key; a second event with the same id for this hook is answered 200 and NOT recorded (no row, nothing runs). NULL = no dedup. Edited in the hook editor (Filter tab).',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `version` int NOT NULL DEFAULT '1',
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `capture_mode` enum('off','capturing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'off',
  `captured_sample` json DEFAULT NULL,
  `captured_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `image_library`
--

DROP TABLE IF EXISTS `image_library`;
CREATE TABLE `image_library` (
  `id` int unsigned NOT NULL,
  `url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `filename` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `original_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tags` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `collection` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `mime` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `width` smallint unsigned DEFAULT NULL,
  `height` smallint unsigned DEFAULT NULL,
  `visibility` enum('public','private') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'public',
  `uploaded_by` tinyint unsigned DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `inbox_views`
--

DROP TABLE IF EXISTS `inbox_views`;
CREATE TABLE `inbox_views` (
  `id` int unsigned NOT NULL,
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention)',
  `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `mailbox_ids` json DEFAULT NULL COMMENT '[mailboxes.id, ...]; NULL or [] = all boxes the viewer can read. A view never grants access: every id must be readable at write time and is re-checked / intersected against channel_grants at every read (S2)',
  `filters` json DEFAULT NULL COMMENT 'Saved-view filter vocabulary = services/mailbox/mailReadService.js FILTER_KEYS (S2, grown since: unread_only/has_case/no_case/client_only/has_files/all_folders/sent_only booleans + from_domain + q). Unknown keys are REFUSED on write and ignored on read; the stored shape keeps only narrowing entries',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Per-user saved mixed-inbox views (S2). Created in S0, read by nothing until S2';

-- --------------------------------------------------------

--
-- Table structure for table `issue_reports`
--

DROP TABLE IF EXISTS `issue_reports`;
CREATE TABLE `issue_reports` (
  `id` bigint NOT NULL,
  `user_id` int DEFAULT NULL,
  `user_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `kind` enum('problem','idea','question') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'problem',
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `page_url` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `context` json DEFAULT NULL,
  `emailed_at` datetime DEFAULT NULL,
  `email_error` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  `resolved_by` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `job_results`
--

DROP TABLE IF EXISTS `job_results`;
CREATE TABLE `job_results` (
  `id` bigint NOT NULL,
  `job_id` bigint NOT NULL,
  `attempt` int NOT NULL,
  `status` enum('success','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `execution_number` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `jwt_api_audit_log`
--

DROP TABLE IF EXISTS `jwt_api_audit_log`;
CREATE TABLE `jwt_api_audit_log` (
  `id` bigint NOT NULL,
  `route` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `headers` json DEFAULT NULL,
  `query_params` json DEFAULT NULL,
  `body` json DEFAULT NULL,
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `username` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `legacy_route_log`
--

DROP TABLE IF EXISTS `legacy_route_log`;
CREATE TABLE `legacy_route_log` (
  `id` bigint NOT NULL,
  `ts` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `route` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `ip` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `query_json` json DEFAULT NULL,
  `body_json` json DEFAULT NULL,
  `headers_json` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `log`
--

DROP TABLE IF EXISTS `log`;
CREATE TABLE `log` (
  `log_id` int NOT NULL,
  `log_type` enum('email','sms','call','other','form','status','note','court email','docs','appt','update','task','event','esign') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_date` datetime NOT NULL COMMENT 'Firm-local wall clock written under THREE spellings that are today the same offset (found 2026-09-25): logService.createLogEntry CONVERT_TZ(..., EST5EDT), the after_contact_update DB trigger CONVERT_TZ(..., America/New_York), and the firm zone America/Detroit (FIRM_TIMEZONE env). A future zone change touches all three literals, in two languages. CONVERT_TZ with named zones returns NULL on a MySQL without tz tables loaded and this column is NOT NULL — a real-engine clone needs mysql_tzinfo_to_sql first',
  `log_link` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_link_type` enum('contact','case','appt','bill','phone','email','task','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_link_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_about_type` enum('contact','case','appt','bill','phone','email','task','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_about_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_by` tinyint unsigned NOT NULL,
  `log_data` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_extra` json DEFAULT NULL,
  `log_from` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_to` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_subject` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_message` varchar(10000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_form_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_form_sub` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_direction` enum('incoming','outgoing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='text, includes email body, sms message, note, etc';

-- --------------------------------------------------------

--
-- Table structure for table `mail_image_senders`
--

DROP TABLE IF EXISTS `mail_image_senders`;
CREATE TABLE `mail_image_senders` (
  `id` int unsigned NOT NULL,
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention) - whose trust this is; every query carries user = caller',
  `address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'sender address as the hub parses From (the <angle> part), lowercased at write; app-validated',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Comms hub: per-user "always show images from" senders (S2). Remote images are blocked by default (read receipts); a row here makes this user''s view of mail From this address load them. Never a grant, never firm-wide.';

-- --------------------------------------------------------

--
-- Table structure for table `mail_messages`
--

DROP TABLE IF EXISTS `mail_messages`;
CREATE TABLE `mail_messages` (
  `id` bigint unsigned NOT NULL,
  `mailbox_id` int unsigned NOT NULL COMMENT 'mailboxes.id (FK by convention)',
  `folder` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `uid` int unsigned DEFAULT NULL COMMENT 'IMAP UID within (mailbox, folder, UIDVALIDITY). NULLABLE on purpose: UIDVALIDITY re-key parks rows at NULL, then sets finals (§4.1) - UNIQUE allows many NULLs. Never make NOT NULL',
  `message_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Message-ID header (brackets stripped). Secondary dedupe + re-key match key for rows WITHOUT provider_id; the emit key under the default emission (mailbox-imap)',
  `provider_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider-native message id: Gmail = lowercase hex X-GM-MSGID (the id Gmail web/API/Apps Script use, = gmail-firm email_log.message_id); NULL for hosts without one. Identity for secondary dedupe + re-key where present; the emit key when mailboxes.emit_id_kind = provider (S1-G)',
  `gmail_labels` json DEFAULT NULL COMMENT 'Gmail labels at ingest (S2-L): the X-GM-LABELS list fetched with the message - system labels keep their leading backslash (Inbox, Sent, Important...), user labels as named; [] = none (archived). NULL = not Gmail (no X-GM-EXT-1) or stored before S2-L. A SNAPSHOT: archiving/relabelling in Gmail later is not seen until POST /api/mailboxes/:id/labels/snapshot re-fetches it (sync is S4). Never read by ingest or emission; the hub reads it through in_inbox',
  `in_inbox` tinyint unsigned GENERATED ALWAYS AS (((`folder` = _utf8mb4'INBOX') or (0 <> coalesce(concat(convert(char(92) using utf8mb4),_utf8mb4'Inbox') member of (`gmail_labels`),0)))) VIRTUAL NOT NULL COMMENT 'GENERATED (S2-L): 1 = in the Inbox for the comms hub - folder INBOX, OR the gmail_labels snapshot holds the Inbox system label (backslash + Inbox; CHAR(92) keeps the DDL free of escapes). The ONE definition of Inbox for the hub list, unread and view counts and mark-all (services/mailbox/mailReadService.js); indexed with mailbox_id + date',
  `in_reply_to` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `thread_key` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'thread root, written by the worker: the first References id, else In-Reply-To, else the message''s own Message-ID (brackets stripped) - the whole rule (OQ1, answered in S2: no subject/participants fallback). The hub groups a thread by it across every readable mailbox',
  `from_addr` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'first From: address in display form - Name <a@b> (name quoted when it has specials) or bare a@b; emails lowercased',
  `to_addrs` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'To: list, comma-separated display forms (see from_addr); NULL when empty',
  `cc_addrs` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Cc: list, comma-separated display forms (see from_addr); NULL when empty',
  `subject` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `date` datetime DEFAULT NULL COMMENT 'Date header, stored UTC (DB pool runs UTC); IMAP INTERNALDATE when the header is missing or outside 1970-2100',
  `snippet` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `body_text` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'inline per D1',
  `body_html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'inline per D1; untrusted mail HTML - sanitize/sandbox at render (S2)',
  `attachments` json DEFAULT NULL COMMENT '[{part, filename, size, mime, cid?}] - STRUCTURE ONLY, no bytes (D1); every non-body leaf incl. inline images (cid) and attached messages; size = the server''s ENCODED size. Parts stream on demand via GET /api/mailboxes/:id/messages/:mid/parts/:part, grant-checked',
  `raw_ref` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'reserved for the GCS archival slice (S6): raw .eml pointer. NULL in v1',
  `gcs_ref` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'reserved for the GCS archival slice (S6): attachments pointer. NULL in v1',
  `size` int unsigned DEFAULT NULL,
  `flags` set('seen','answered','flagged','draft') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' COMMENT 'SERVER flags (mailbox-level), mirrored read-mostly. Per-user read state lives in mail_read_state, NOT here; v1 never writes \\Seen back (§4.3)',
  `log_id` int DEFAULT NULL COMMENT 'log.log_id bridge to the curated log tier / case linking (FK by convention); NULL = not emitted or not logged',
  `ingested_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'when the S1 worker stored the row (UTC). The OQ2 2-year pruning axis: `date` is the sender-supplied header and can be absent or lie'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Tier-1 mailbox store (D1): every message in every ingested folder, grant-controlled. 2-year full-body mirror window (OQ2); the provider + future GCS archive are the long-term record; pruning lands by S4';

-- --------------------------------------------------------

--
-- Table structure for table `mail_read_state`
--

DROP TABLE IF EXISTS `mail_read_state`;
CREATE TABLE `mail_read_state` (
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention)',
  `message_fk` bigint unsigned NOT NULL COMMENT 'mail_messages.id (FK by convention); delete with the message on prune / orphan purge',
  `read_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='PER-USER read state (§4.3): IMAP \\Seen is per-mailbox and cannot represent many users. Row present = read';

-- --------------------------------------------------------

--
-- Table structure for table `mail_sends`
--

DROP TABLE IF EXISTS `mail_sends`;
CREATE TABLE `mail_sends` (
  `id` int unsigned NOT NULL,
  `mailbox_id` int unsigned NOT NULL COMMENT 'mailboxes.id (FK by convention) - the box sent AS (an alias box keeps its own id; the copy lands in the parent)',
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention) - who clicked Send; the hub is interactive-only, never 0/automation',
  `message_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'RFC Message-ID, brackets stripped as in mail_messages.message_id; NULL for a Gmail send (Gmail rewrites it - provider_id is the key there)',
  `provider_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Gmail hex id (lowercase X-GM-MSGID), as mail_messages.provider_id; NULL for SMTP sends',
  `email_log_id` int DEFAULT NULL COMMENT 'email_log.id of the adapter''s outbound-* row (best-effort lookup; NULL if the fire-and-forget row was not found)',
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'cases.case_id the sender asked to link the sent copy to (composer Case field); NULL = none asked',
  `case_link_state` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'app-validated: NULL (no case asked) | pending (mail_sent_case_link job will link the stored copy) | linked (case_log_id set) | failed (job gave up; error alert raised)',
  `case_log_id` int DEFAULT NULL COMMENT 'log.log_id the sent copy was linked to (via mailReadService.caseLink, or created at send when no copy will ever be stored)',
  `sent_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC) - when the dispatch succeeded'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='S2P: one row per comms-hub send - attribution (Sent by X via YisraCase, design OQ4) + the Case field''s link state. Written post-dispatch, best-effort (a failed insert never fails the send); read by thread/message responses (sent_by).';

-- --------------------------------------------------------

--
-- Table structure for table `mailboxes`
--

DROP TABLE IF EXISTS `mailboxes`;
CREATE TABLE `mailboxes` (
  `id` int unsigned NOT NULL,
  `address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'mailbox email address, lowercased at write; unique (general_ci = case-insensitive)',
  `domain` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'derived from address at write (part after @) by mailboxService; never client-supplied',
  `display_name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `color` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'comms hub colour (S2): #rrggbb lowercase, app-validated; NULL = none chosen (neutral). Set at create (pick, else a random unused public/js/mailboxColor.js PALETTE entry) and editable by SU or the box''s can_manage holders. Cosmetic only - drawn as given where it clears 3:1 on the theme, else a lighter/darker shade of the same hue',
  `imap_host` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'row data, never a code constant (D2); changing host/port requires re-entering imap_secret in the same write (credential-redirect guard)',
  `imap_port` int NOT NULL DEFAULT '993',
  `imap_user` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `imap_secret` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'ENCv1 ciphertext via lib/credentialCrypto (same pattern as email_credentials.smtp_pass); identity creds or mailbox password per D3 - transport-agnostic. WRITE-ONLY: no API response carries it in any shape (has_secret boolean instead). NULL = not set',
  `send_credential_id` int unsigned DEFAULT NULL COMMENT 'email_credentials.id (FK by convention); NULL = read-only mailbox. Grant checks for sending live on interactive routes only, never in emailService (D6)',
  `alias_of` int unsigned DEFAULT NULL COMMENT 'S3-R: parent mailboxes.id (FK by convention). NOT NULL = this row is a send-as ALIAS of that box - the ONE definition of SEND-ONLY (mailReadService.SEND_ONLY_SQL). An alias never polls (ingest stays off, no secret; host/login copied from the parent) and a can_read grant on it reads the alias SLICE of the parent: rows labelled alias_label or carrying the address in From/To/Cc; within it From = the alias is Sent, the rest Inbox. SU may re-point it to another real box (PATCH; host/login re-copied) - never cleared, never set on a full box, never an alias of an alias',
  `alias_label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'S3-R: the Gmail label whose filter files this ALIAS box''s mail in the parent (exact spelling, case-sensitive in JSON MEMBER OF - live: IT / Rena / Shoshana). Catches Bcc and list mail the From/To/Cc half of the slice misses. NULL = address matching only. A USER label: a system label (backslash-led, e.g. Inbox) is refused. Meaningful on alias rows (alias_of) only; SU-editable',
  `ingest_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `ingest_folders` json DEFAULT NULL COMMENT 'per-folder CONFIG: {"<folder>": {"emit_to_rules": bool, "backfill"?: false}} - which folders the worker polls, which emit into the rules pipeline (§4.1), and (S1-G) backfill:false = store only mail arriving after first sight (no history; decided at first sight; a later re-key stores only above the highest re-mapped UID). Everything polled is stored to mail_messages regardless - except drafts, never stored nor emitted (DRAFT GUARD, §4.1: the IMAP Draft flag OR the Gmail Draft label - Gmail does not flag drafts in All Mail; label patch 2026-10-11). mailboxService always writes it (backfill only when false); v1 default {"INBOX":{"emit_to_rules":true}} (Sent is opt-in, emit_to_rules false - host Sent names vary). Gmail: [Gmail]/All Mail as the ONLY folder (one copy of inbound, sent and labelled mail; sent mail emits too) - never All Mail alongside other folders (every labelled message stored twice)',
  `ingest_state` json DEFAULT NULL COMMENT 'per-folder CURSOR, written only by services/mailbox/mailboxIngestService.js (its header is the contract): {"<folder>": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-keyed backfill:false folder stores only above it, backfill_emit_after = ISO emit horizon from a re-key (null = store-only), backfill_skipped_below / _at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / _uid = stored, not emitted, drafts_skipped_total = Drafts never stored, poison = {uid, attempts, ..., held?} UID the new pass keeps failing on, quarantined = [...] last 20 UIDs skipped for good, quarantined_total (POISON MESSAGES)}}. First poll baselines at UIDNEXT: existing mail stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge. A folder dropped from ingest_folders keeps its key. NULL = never ingested',
  `emit_source_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'emission override (S1-G): email_ingest_sources.name the worker emits this mailbox under. NULL (with emit_id_kind NULL) = mailbox-imap. SU PATCH only, set as a pair, must be an ACTIVE source row; decides the email_log dedupe space — see services/mailbox/mailboxIngestService.js EMISSION IDENTITY',
  `emit_id_kind` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'emission override (S1-G): rfc | provider (app-validated). The (source, message_id) key: rfc = RFC Message-ID, provider = mail_messages.provider_id. A provider mailbox NEVER falls back to the RFC id - a message without provider_id is stored, counted, alerted, never emitted. provider never under mailbox-imap; one provider mailbox per source',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'no hard delete - mail_messages rows reference mailboxes forever; 0 = deactivated',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='YC-native mailboxes (ref/MAILBOX_SYSTEM_DESIGN.md). Provider-blind connection rows; access via channel_grants(channel_type=mailbox)';

-- --------------------------------------------------------

--
-- Table structure for table `master_contacts___leads_list___phil_tirone`
--

DROP TABLE IF EXISTS `master_contacts___leads_list___phil_tirone`;
CREATE TABLE `master_contacts___leads_list___phil_tirone` (
  `COL 1` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 2` varchar(28) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 3` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 4` varchar(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 5` varchar(14) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 6` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 7` varchar(17) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 8` varchar(38) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 9` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 10` varchar(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 11` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 12` varchar(14) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 13` varchar(14) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 14` varchar(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 15` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 16` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 17` varchar(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 18` varchar(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 19` varchar(63) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 20` varchar(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 21` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mytable`
--

DROP TABLE IF EXISTS `mytable`;
CREATE TABLE `mytable` (
  `Full Name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Zoom link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Last Name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `URL%20ready` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Type` tinyint NOT NULL,
  `Address1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Address2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `City` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `State` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Zip` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Email` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `Phone` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pages`
--

DROP TABLE IF EXISTS `pages`;
CREATE TABLE `pages` (
  `id` int unsigned NOT NULL,
  `slug` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `host` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('draft','live') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft',
  `hook_slug` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `thankyou_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `meta_title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `payment_failed`
--

DROP TABLE IF EXISTS `payment_failed`;
CREATE TABLE `payment_failed` (
  `id` int unsigned NOT NULL,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `amount` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `date` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `clio` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phase_c_backup_20260526`
--

DROP TABLE IF EXISTS `phase_c_backup_20260526`;
CREATE TABLE `phase_c_backup_20260526` (
  `log_id` int NOT NULL,
  `orig_log_link_type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `orig_log_link_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `orig_log_link` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `backed_up_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_event_log`
--

DROP TABLE IF EXISTS `phone_event_log`;
CREATE TABLE `phone_event_log` (
  `id` int unsigned NOT NULL,
  `provider` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `provider_ref` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `provider_event_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_type` enum('sms','call') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `direction` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `from_number` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `to_number` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `other_party` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `line_number` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (if((`direction` = _utf8mb4'incoming'),`to_number`,`from_number`)) VIRTUAL COMMENT 'S-PH: the firm line this event belongs to (incoming → to_number, else from_number) - equal to raw_extra.line on every live row. Joins phone_lines.phone_number by plain equality; no match = an orphan (a number that is not a phone_lines row), invisible in the Comms phone tab. Indexed with processed_at (idx_phone_event_line). Code names this column directly (generated-column substitution for the base expression is collation-fragile) and forces the index on per-line walks',
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `suppressed` tinyint(1) NOT NULL DEFAULT '0',
  `suppressed_by` json DEFAULT NULL,
  `log_id` int DEFAULT NULL,
  `raw_extra` json DEFAULT NULL,
  `processed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivery_state` varchar(12) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'outbound delivery, normalized by phoneDeliveryService: pending|sent|delivered|failed. NULL = incoming row, call, or never synced. Vocabulary: ref/PHONE_DELIVERY_DESIGN.md §3',
  `delivery_reason` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'failure reason (delivery_state=failed): unreachable|opted_out|spam_content|sender_flagged|unknown',
  `delivery_code` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'raw provider error code (e.g. SMS-CAR-411). Tooltip/forensics only — only the provider adapter may interpret it',
  `delivery_checked_at` datetime DEFAULT NULL COMMENT 'last phone_outbound_sync stamp (UTC)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_executions`
--

DROP TABLE IF EXISTS `phone_ingest_executions`;
CREATE TABLE `phone_ingest_executions` (
  `id` bigint unsigned NOT NULL,
  `event_log_id` int unsigned DEFAULT NULL,
  `status` enum('logged','suppressed','error','duplicate') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_id` int DEFAULT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `metadata` json DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `action_failure_count` int unsigned GENERATED ALWAYS AS (coalesce(json_length(json_search(json_extract(`metadata`,_utf8mb4'$.action_outcomes[*].status'),_utf8mb4'all',_utf8mb4'failed')),0)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_rule_actions`
--

DROP TABLE IF EXISTS `phone_ingest_rule_actions`;
CREATE TABLE `phone_ingest_rule_actions` (
  `id` int unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `position` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `action_type` enum('workflow','sequence','hook','internal_function','http') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `config` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_rule_changes`
--

DROP TABLE IF EXISTS `phone_ingest_rule_changes`;
CREATE TABLE `phone_ingest_rule_changes` (
  `id` bigint unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL COMMENT 'phone_ingest_rules.id. No FK: the row outlives a deleted rule',
  `change_kind` varchar(20) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'create|update|activate|deactivate|delete|duplicate|action_add|action_update|action_delete (app-validated)',
  `action_id` int unsigned DEFAULT NULL COMMENT 'the phone_ingest_rule_actions row, for the action_* kinds',
  `duplicated_from_rule_id` int unsigned DEFAULT NULL COMMENT 'duplicate: the source rule',
  `actor_user_id` int DEFAULT NULL COMMENT 'users.user of a staff JWT; NULL for an API key',
  `actor_key_id` int DEFAULT NULL COMMENT 'api_keys.id of a machine caller; NULL for staff and the internal key',
  `actor_label` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'the username, or api_key:<label>',
  `changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `definition_updated_at` datetime(3) DEFAULT NULL COMMENT 'the rule edit stamp AFTER this change; NULL for delete',
  `before_json` json DEFAULT NULL COMMENT '{rule, actions} before; NULL for create and duplicate. http url and literal header values redacted; over 256 KB a size + sha256 marker',
  `after_json` json DEFAULT NULL COMMENT '{rule, actions} after; NULL for delete. Same redaction and cap'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='APPEND-ONLY change log of phone ingest rule definitions: one row per real change (the rule fields or its action rows), before and after, with the actor, written inside the edit transaction (services/ingestRuleChangeLog.js). The app never UPDATEs or DELETEs a row.';

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_rules`
--

DROP TABLE IF EXISTS `phone_ingest_rules`;
CREATE TABLE `phone_ingest_rules` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `position` int NOT NULL DEFAULT '0',
  `match_mode` enum('conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'NOT an edit stamp: ON UPDATE moves it on every match (the match_count bump), and an action edit never moves it. The edit stamp is definition_updated_at.',
  `definition_updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_lines`
--

DROP TABLE IF EXISTS `phone_lines`;
CREATE TABLE `phone_lines` (
  `id` tinyint unsigned NOT NULL,
  `phone_number` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `provider` enum('ringcentral','quo') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `display_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `provider_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `credential_id` int NOT NULL,
  `mms_capable` tinyint(1) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_log_suppressions`
--

DROP TABLE IF EXISTS `phone_log_suppressions`;
CREATE TABLE `phone_log_suppressions` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `match_mode` enum('conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pipeline_stage_requirements`
--

DROP TABLE IF EXISTS `pipeline_stage_requirements`;
CREATE TABLE `pipeline_stage_requirements` (
  `id` int unsigned NOT NULL,
  `stage_id` int unsigned NOT NULL,
  `requirement_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `internal_label` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `client_label` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `client_visible` tinyint(1) NOT NULL DEFAULT '1',
  `required` tinyint(1) NOT NULL DEFAULT '1',
  `owner` enum('client','staff','system') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'client',
  `kind` enum('task','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'task',
  `hint` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `effort` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `group_label` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `detector` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `detector_config` json DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pipeline_stages`
--

DROP TABLE IF EXISTS `pipeline_stages`;
CREATE TABLE `pipeline_stages` (
  `id` int unsigned NOT NULL,
  `template_id` int unsigned NOT NULL,
  `stage_number` int NOT NULL,
  `stage_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `internal_label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `client_label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_stage` enum('Open','Pending','Filed','Concluded','Closed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `client_visible` tinyint(1) NOT NULL DEFAULT '1',
  `is_terminal` tinyint(1) NOT NULL DEFAULT '0',
  `lane` enum('main','offramp') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'main' COMMENT 'R1 projection axis: main = happy path (feeds getPipeline.upcoming); offramp = reachable from anywhere, never projected as next. Position/history are lane-agnostic.',
  `default_rec` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `config` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pipeline_templates`
--

DROP TABLE IF EXISTS `pipeline_templates`;
CREATE TABLE `pipeline_templates` (
  `id` int unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_type` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `case_subtype` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `role` enum('intake','case') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'case',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `portal_access_log`
--

DROP TABLE IF EXISTS `portal_access_log`;
CREATE TABLE `portal_access_log` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned DEFAULT NULL,
  `case_id` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `route` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `status` smallint DEFAULT NULL,
  `event` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `meta` json DEFAULT NULL,
  `ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `portal_cards`
--

DROP TABLE IF EXISTS `portal_cards`;
CREATE TABLE `portal_cards` (
  `id` int unsigned NOT NULL,
  `card_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `body_type` enum('template','coded') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'template',
  `body_template` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `coded_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `link_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `link_label` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `conditions` json DEFAULT NULL,
  `placement` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'case',
  `sort` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `portal_login_pins`
--

DROP TABLE IF EXISTS `portal_login_pins`;
CREATE TABLE `portal_login_pins` (
  `id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `channel` enum('sms','email') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `destination` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `pin_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `consumed_at` datetime DEFAULT NULL,
  `ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `query_log`
--

DROP TABLE IF EXISTS `query_log`;
CREATE TABLE `query_log` (
  `id` int NOT NULL,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `username` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_status` enum('authorized','unauthorized') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `query` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `auth_type` enum('jwt','api key','password','unknown') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rc_messages_log`
--

DROP TABLE IF EXISTS `rc_messages_log`;
CREATE TABLE `rc_messages_log` (
  `id` int NOT NULL,
  `type` enum('sms','mms') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `from_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `to_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attachment_filename` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `attachment_url` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `status` enum('success','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `rc_response` json DEFAULT NULL,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `timestamp` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rc_sms_log`
--

DROP TABLE IF EXISTS `rc_sms_log`;
CREATE TABLE `rc_sms_log` (
  `id` bigint unsigned NOT NULL,
  `from_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `to_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('success','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `rc_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sent_by` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `readonly_api_keys`
--

DROP TABLE IF EXISTS `readonly_api_keys`;
CREATE TABLE `readonly_api_keys` (
  `id` int NOT NULL,
  `key_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `key_prefix` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `created_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `use_count` int NOT NULL DEFAULT '0',
  `scopes` json DEFAULT NULL COMMENT 'Key scopes (access-control B1): NULL = legacy full surface; else a JSON array of scope strings — surface (sql.ro, scratch, alert, temp.*), route:/<path>, or a capability name. Vocabulary: lib/capabilities.js KEY_SCOPES.',
  `parent_key_id` int DEFAULT NULL COMMENT 'Delegation (access-control D1): NULL = a root key (SU-minted); else the id of the keys.mint key that minted this child. A child is refused at auth once its parent is revoked or expired; its effective scopes = own ∩ parent ∩ (sql.ro, scratch, alert). FK RESTRICT: no hard delete of a parent.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `readonly_query_log`
--

DROP TABLE IF EXISTS `readonly_query_log`;
CREATE TABLE `readonly_query_log` (
  `id` bigint NOT NULL,
  `api_key_id` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sql_text` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `params_json` json DEFAULT NULL,
  `row_count` int DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `status` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `sensitive_key` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = the session key held sql.ro.sensitive (access SEC-3)',
  `error_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `redirects`
--

DROP TABLE IF EXISTS `redirects`;
CREATE TABLE `redirects` (
  `id` int unsigned NOT NULL,
  `slug` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `target_url` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `hit_count` int unsigned NOT NULL DEFAULT '0',
  `expires_at` datetime DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `report_definition_versions`
--

DROP TABLE IF EXISTS `report_definition_versions`;
CREATE TABLE `report_definition_versions` (
  `id` int unsigned NOT NULL,
  `report_id` int unsigned NOT NULL,
  `version_no` int unsigned NOT NULL,
  `report_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `title` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `category` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'General',
  `kind` enum('report','view') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'report',
  `visibility` enum('private','shared') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'shared',
  `sql_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `params` json DEFAULT NULL,
  `columns_meta` json DEFAULT NULL,
  `viz` json DEFAULT NULL,
  `caveats` json DEFAULT NULL,
  `row_limit` int unsigned NOT NULL DEFAULT '1000',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `source` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
  `change_note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `snapshot_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `report_definitions`
--

DROP TABLE IF EXISTS `report_definitions`;
CREATE TABLE `report_definitions` (
  `id` int unsigned NOT NULL,
  `report_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `category` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'General',
  `kind` enum('report','view') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'report',
  `visibility` enum('private','shared') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'shared',
  `sql_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `params` json DEFAULT NULL,
  `columns_meta` json DEFAULT NULL,
  `viz` json DEFAULT NULL,
  `caveats` json DEFAULT NULL,
  `row_limit` int unsigned NOT NULL DEFAULT '1000',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_by` int DEFAULT NULL,
  `updated_by` int DEFAULT NULL,
  `source` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_locked` tinyint(1) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `report_runs`
--

DROP TABLE IF EXISTS `report_runs`;
CREATE TABLE `report_runs` (
  `id` bigint unsigned NOT NULL,
  `report_id` int unsigned DEFAULT NULL,
  `report_key` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `run_by` int DEFAULT NULL,
  `params_json` json DEFAULT NULL,
  `sql_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `row_count` int DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `status` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `error_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `request_idempotency`
--

DROP TABLE IF EXISTS `request_idempotency`;
CREATE TABLE `request_idempotency` (
  `id` bigint unsigned NOT NULL,
  `user_id` tinyint NOT NULL COMMENT 'users.user of the acting staff member; 0 (Automations) when the request carries no staff user, e.g. an x-api-key caller. Part of the unique key: one user can never replay another user''s result',
  `scope` varchar(64) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'operation name, one fixed literal chosen server-side per route (tasks.create, appts.create, ...). Never read from the request, so a caller cannot aim a key at another operation',
  `idem_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'opaque key from the Idempotency-Key request header. utf8mb4_bin (not the table default general_ci) because it is a token, never a join key: two keys differing only in case must stay two keys. App-validated to 8-100 chars of [A-Za-z0-9._:-] before any write — sql_mode is relaxed, so a longer key would store TRUNCATED and alias two keys into one false replay',
  `status` enum('in_flight','applied') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'in_flight' COMMENT 'in_flight = claimed, outcome not yet known; applied = the operation committed and `result` holds its canonical response. An operation that FAILED deletes its row, so the key is reusable. A row left in_flight (process died between claim and settle) is the UNKNOWN outcome: a repeat is refused 409 and the row is never taken over — a takeover is the double-apply this table exists to prevent',
  `result` json DEFAULT NULL COMMENT 'the canonical route result, replayed value-for-value to a repeat of the same key (MySQL re-orders JSON object keys on write, so the replayed bytes are not identical - compare key-order-insensitively). Never auth/session material and never raw sensitive evidence',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'claim time, then settle time. The in_flight staleness window is measured from it SERVER-side (TIMESTAMPDIFF against NOW()), never in JS'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Request idempotency claims: makes a wired create exactly-once per caller-minted key. lib/requestIdempotency.js';

-- --------------------------------------------------------

--
-- Table structure for table `ringcentral_temp`
--

DROP TABLE IF EXISTS `ringcentral_temp`;
CREATE TABLE `ringcentral_temp` (
  `id` int NOT NULL,
  `data` json NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rw_scratch`
--

DROP TABLE IF EXISTS `rw_scratch`;
CREATE TABLE `rw_scratch` (
  `id` bigint NOT NULL,
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'default',
  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `v` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `meta` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `scheduled_jobs`
--

DROP TABLE IF EXISTS `scheduled_jobs`;
CREATE TABLE `scheduled_jobs` (
  `id` bigint NOT NULL,
  `type` enum('one_time','recurring','workflow_resume','sequence_step','hook_retry') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `scheduled_time` datetime NOT NULL,
  `status` enum('pending','running','completed','failed','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `data` json NOT NULL,
  `recurrence_rule` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `workflow_execution_id` bigint DEFAULT NULL,
  `sequence_enrollment_id` bigint unsigned DEFAULT NULL,
  `attempts` int DEFAULT '0',
  `max_attempts` int DEFAULT '3',
  `backoff_seconds` int DEFAULT '300',
  `max_executions` int DEFAULT NULL COMMENT 'Stop recurring job after this many successful executions. NULL = no limit.',
  `expires_at` datetime DEFAULT NULL COMMENT 'Stop recurring job after this datetime. NULL = no expiry.',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `execution_count` int NOT NULL DEFAULT '0',
  `idempotency_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `seq_steps`
--

DROP TABLE IF EXISTS `seq_steps`;
CREATE TABLE `seq_steps` (
  `seq_step_id` int unsigned NOT NULL,
  `seq_step_seq_id` int NOT NULL,
  `seq_step_number` int NOT NULL,
  `seq_step_delay` int unsigned NOT NULL,
  `seq_step_action` enum('sms','email','status','alert') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_from` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_to` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_text` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `seq_steps`
--
DELIMITER $$
CREATE TRIGGER `insert_seq_type_steps` AFTER INSERT ON `seq_steps` FOR EACH ROW BEGIN
    UPDATE seq_types
    SET seq_type_steps = (
        SELECT COUNT(*)
        FROM seq_steps
        WHERE seq_step_seq_id = NEW.seq_step_seq_id
    )
    WHERE seq_type_id = NEW.seq_step_seq_id;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `update_seq_type_steps` AFTER UPDATE ON `seq_steps` FOR EACH ROW BEGIN
    UPDATE seq_types
    SET seq_type_steps = (
        SELECT COUNT(*)
        FROM seq_steps
        WHERE seq_step_seq_id = NEW.seq_step_seq_id
    )
    WHERE seq_type_id = NEW.seq_step_seq_id;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `seq_types`
--

DROP TABLE IF EXISTS `seq_types`;
CREATE TABLE `seq_types` (
  `seq_type_id` int unsigned NOT NULL,
  `seq_type_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_table` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_col` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_op` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_val` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_steps` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_enrollments`
--

DROP TABLE IF EXISTS `sequence_enrollments`;
CREATE TABLE `sequence_enrollments` (
  `id` bigint unsigned NOT NULL,
  `template_id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `appt_id` int DEFAULT NULL,
  `signing_request_id` int unsigned DEFAULT NULL,
  `trigger_data` json DEFAULT NULL,
  `status` enum('active','completed','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `current_step` int unsigned DEFAULT '1',
  `total_steps` int unsigned NOT NULL DEFAULT '0',
  `cancel_reason` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `enrolled_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `completed_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `template_version` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_step_log`
--

DROP TABLE IF EXISTS `sequence_step_log`;
CREATE TABLE `sequence_step_log` (
  `id` bigint unsigned NOT NULL,
  `enrollment_id` bigint unsigned NOT NULL,
  `step_id` int unsigned NOT NULL,
  `step_number` int NOT NULL,
  `status` enum('sent','skipped','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `skip_reason` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `action_config_resolved` json DEFAULT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT '0',
  `scheduled_at` datetime DEFAULT NULL,
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_steps`
--

DROP TABLE IF EXISTS `sequence_steps`;
CREATE TABLE `sequence_steps` (
  `id` int unsigned NOT NULL,
  `template_id` int unsigned NOT NULL,
  `step_number` int NOT NULL,
  `action_type` enum('sms','email','task','internal_function','webhook','start_workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `action_config` json NOT NULL,
  `timing` json NOT NULL,
  `condition` json DEFAULT NULL,
  `fire_guard` json DEFAULT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `version` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_template_types`
--

DROP TABLE IF EXISTS `sequence_template_types`;
CREATE TABLE `sequence_template_types` (
  `type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `priority_fields` json NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_template_versions`
--

DROP TABLE IF EXISTS `sequence_template_versions`;
CREATE TABLE `sequence_template_versions` (
  `template_id` int unsigned NOT NULL,
  `version` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `template_condition` json DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `test_input` json DEFAULT NULL,
  `published_at` datetime DEFAULT NULL,
  `published_by` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `retired_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_templates`
--

DROP TABLE IF EXISTS `sequence_templates`;
CREATE TABLE `sequence_templates` (
  `id` int unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `filters` json DEFAULT NULL,
  `condition` json DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `test_input` json DEFAULT NULL,
  `capture_mode` enum('off','capturing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'off',
  `captured_input` json DEFAULT NULL,
  `captured_at` datetime DEFAULT NULL,
  `current_version` int NOT NULL DEFAULT '0',
  `draft_version` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequences`
--

DROP TABLE IF EXISTS `sequences`;
CREATE TABLE `sequences` (
  `seq_id` int unsigned NOT NULL,
  `seq_type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_status` enum('active','aborted','resolved','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_next_step` tinyint NOT NULL,
  `seq_link` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_client` int unsigned NOT NULL,
  `seq_case` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_start_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `settings`
--

DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `setting_id` int unsigned NOT NULL,
  `setting_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `setting_data` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `shared_namespaces`
--

DROP TABLE IF EXISTS `shared_namespaces`;
CREATE TABLE `shared_namespaces` (
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'namespace name, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin so case never folds two names together (it is still PAD SPACE, so trailing spaces would: the pattern refusing spaces keeps every name distinct)',
  `description` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'what the namespace is for (free text, shown in listings)',
  `write_mode` enum('staff','creator','own_key') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'staff' COMMENT 'who may write values: staff = any staff; creator = created_by or a firm.settings holder; own_key = each user only the key equal to their users.user (firm.settings any). App-validated (relaxed sql_mode stores an unknown value as an empty string, which writes refuse)',
  `max_value_bytes` int unsigned NOT NULL DEFAULT '65536' COMMENT 'largest value (UTF-8 bytes) a write may store; refused at the route BEFORE SQL (relaxed sql_mode would truncate silently). 1..1048576',
  `max_keys` int unsigned NOT NULL DEFAULT '1000' COMMENT 'most keys the namespace may hold; a create beyond it is refused. 1..10000',
  `created_by` tinyint NOT NULL COMMENT 'users.user who created it (manages it, with firm.settings holders)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Shared values: staff-created namespaces of staff-written key/value pairs (routes/api.shared.js). Values are UNTRUSTED text: render with textContent, never as HTML. Not config: app_settings is.';

-- --------------------------------------------------------

--
-- Table structure for table `shared_values`
--

DROP TABLE IF EXISTS `shared_values`;
CREATE TABLE `shared_values` (
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns (FK, cascade delete)',
  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'key within the namespace, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin',
  `v` mediumtext COLLATE utf8mb4_general_ci NOT NULL COMMENT 'the value, verbatim (UNTRUSTED staff-written text; size capped per namespace by the route)',
  `rev` int unsigned NOT NULL DEFAULT '1' COMMENT 'compare-and-set revision: 1 on create, +1 per write; a write names the rev it read and is refused (409) when it moved',
  `updated_by` tinyint NOT NULL COMMENT 'users.user of the last writer, stamped by the server from the JWT (a live View-as: the target user)',
  `updated_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session that made the last write; NULL otherwise',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Shared values (routes/api.shared.js): one row per key. UNTRUSTED staff-written text — render with textContent. Kept out of update_db / insert_db / query_db.';

-- --------------------------------------------------------

--
-- Table structure for table `shared_values_history`
--

DROP TABLE IF EXISTS `shared_values_history`;
CREATE TABLE `shared_values_history` (
  `id` bigint unsigned NOT NULL,
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns at the time of the write (no FK: history outlives a deleted namespace); utf8mb4_bin like the source column',
  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'shared_values.k; NULL = a namespace event (ns_create / ns_update / ns_delete)',
  `op` enum('ns_create','ns_update','ns_delete','create','update','delete') COLLATE utf8mb4_general_ci NOT NULL COMMENT 'what the write did. App-written only (relaxed sql_mode would store an unknown value as an empty string)',
  `old_v` mediumtext COLLATE utf8mb4_general_ci COMMENT 'before: the value (update / delete), or the namespace rules as JSON (ns_update; ns_delete adds key_count). NULL for a create. UNTRUSTED staff-written text',
  `new_v` mediumtext COLLATE utf8mb4_general_ci COMMENT 'after: the value (create / update), or the namespace rules as JSON (ns_create / ns_update). NULL for a delete. UNTRUSTED staff-written text',
  `old_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev before the write (update / delete); NULL otherwise',
  `new_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev after the write (create = 1 / update); NULL otherwise',
  `changed_by` tinyint NOT NULL COMMENT 'users.user who wrote it, stamped by the server from the JWT (a live View-as: the target user)',
  `changed_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session; NULL otherwise',
  `changed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Shared values write history (routes/api.shared.js _history; the Shared values admin page): one row per successful write, in its transaction. UNTRUSTED staff-written text — render with textContent. No retention yet (ref/plans.md).';

-- --------------------------------------------------------

--
-- Table structure for table `signing_request_events`
--

DROP TABLE IF EXISTS `signing_request_events`;
CREATE TABLE `signing_request_events` (
  `id` int unsigned NOT NULL,
  `signing_request_id` int unsigned NOT NULL,
  `event` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'created/sent/delivered/viewed/signed/declined/bounced/reminded/recalled/expired/satisfied_external/...',
  `recipient_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `occurred_at` datetime NOT NULL COMMENT 'provider-reported time; NO default on purpose, so a missing one is visible',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'our ingest time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `signing_request_sources`
--

DROP TABLE IF EXISTS `signing_request_sources`;
CREATE TABLE `signing_request_sources` (
  `signing_request_id` int unsigned NOT NULL,
  `pdf` longblob NOT NULL,
  `size` int unsigned NOT NULL COMMENT 'byte length of pdf',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `signing_requests`
--

DROP TABLE IF EXISTS `signing_requests`;
CREATE TABLE `signing_requests` (
  `id` int unsigned NOT NULL,
  `provider` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'e.g. zoho_sign',
  `provider_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider-side request id; NULL until sent',
  `linkable_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'case | contact',
  `linkable_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'cases.case_id (string) OR contacts.contact_id (int as string)',
  `kind` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'retainer_prepetition | retainer_postpetition | schedules | other',
  `status` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft' COMMENT 'draft/sent/viewed/signed/declined/expired/recalled/bounced/satisfied_external',
  `document_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'debtor-visible, human-friendly',
  `tracking_id` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'YC-{linkable_id}-{kind}-{suffix}; opaque, do not parse',
  `recipients` json NOT NULL COMMENT '[{name,email,order,status,signed_at,ip}]',
  `placement_json` json DEFAULT NULL,
  `template_id` int unsigned DEFAULT NULL COMMENT 'contract_templates.id',
  `seq_instance_id` bigint unsigned DEFAULT NULL COMMENT 'sequence_enrollments.id — for reminder cancellation',
  `completion_targets` json DEFAULT NULL,
  `signed_pdf_path` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Dropbox path; convention defined in slice 1C',
  `cert_pdf_path` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL COMMENT 'stamped on terminal SUCCESS only (signed, satisfied_external)',
  `expires_at` datetime DEFAULT NULL,
  `raw_payload` json DEFAULT NULL COMMENT 'last provider payload seen',
  `created_by` int unsigned NOT NULL DEFAULT '0' COMMENT 'users.user; 0 = system/automations',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `streak_boards`
--

DROP TABLE IF EXISTS `streak_boards`;
CREATE TABLE `streak_boards` (
  `id` int unsigned NOT NULL,
  `slug` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'url key: /streak?b=<slug>',
  `title` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tz` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'America/Detroit' COMMENT 'IANA tz that defines when a day rolls over',
  `members` json NOT NULL COMMENT '[{"u":"fred","name":"Fred","h":"<bcrypt>"}]',
  `archived` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `streak_checkins`
--

DROP TABLE IF EXISTS `streak_checkins`;
CREATE TABLE `streak_checkins` (
  `id` int unsigned NOT NULL,
  `board_id` int unsigned NOT NULL,
  `username` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'matches streak_boards.members[].u — deliberately not an FK',
  `checkin_date` date NOT NULL COMMENT 'the day being credited (board-local)',
  `logged_date` date NOT NULL COMMENT 'board-local day the row was actually created; logged_date > checkin_date === ticked late',
  `note` varchar(280) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'audit only — no logic reads this'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `streak_messages`
--

DROP TABLE IF EXISTS `streak_messages`;
CREATE TABLE `streak_messages` (
  `id` int unsigned NOT NULL,
  `board_id` int unsigned NOT NULL,
  `username` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'matches streak_boards.members[].u — deliberately not an FK',
  `body` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC-backed; always read via UNIX_TIMESTAMP()'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `system_alerts`
--

DROP TABLE IF EXISTS `system_alerts`;
CREATE TABLE `system_alerts` (
  `id` bigint unsigned NOT NULL,
  `source` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `group_key` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `severity` enum('info','warning','error','critical') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'error',
  `title` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `context` json DEFAULT NULL,
  `ref_table` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ref_id` bigint DEFAULT NULL,
  `dedup_key` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `digested_at` datetime DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  `acked_at` datetime DEFAULT NULL,
  `acked_by` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tasks`
--

DROP TABLE IF EXISTS `tasks`;
CREATE TABLE `tasks` (
  `task_id` int unsigned NOT NULL,
  `task_status` enum('Pending','Due Today','Overdue','Completed','Canceled','Deleted') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Pending',
  `task_from` tinyint unsigned NOT NULL,
  `task_to` tinyint unsigned NOT NULL,
  `task_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_start` date DEFAULT NULL,
  `task_due` date DEFAULT NULL,
  `task_link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_link_type` enum('contact','case','appt','bill','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_desc` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_notification` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'notify task assigner upon completion?',
  `task_source` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_session_key_id` int DEFAULT NULL COMMENT 'Session-key tasks (access-control D3): NULL = not created by a session key; else readonly_api_keys.id of the tasks.own key that created it and alone may manage it via /api/key-tasks. Ownership lives HERE, never in task_source (free text). No FK: hot table; key ids are never reused.',
  `task_dedupe_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_last_update` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_due_job_id` bigint DEFAULT NULL,
  `task_start_job_id` bigint DEFAULT NULL,
  `task_action_token` char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'one-click action bearer (/t/<t>); 22-char base62 via lib/token, legacy base64url; _bin: case-sensitive'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `tasks`
--
DELIMITER $$
CREATE TRIGGER `before_insert_tasks` BEFORE INSERT ON `tasks` FOR EACH ROW BEGIN
    IF NEW.task_due = '1000-01-01' THEN
        SET NEW.task_due = NULL;
    END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `before_update_tasks` BEFORE UPDATE ON `tasks` FOR EACH ROW BEGIN
    IF NEW.task_due = '1000-01-01' THEN
        SET NEW.task_due = NULL;
    END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `temp_contacts`
--

DROP TABLE IF EXISTS `temp_contacts`;
CREATE TABLE `temp_contacts` (
  `tc_id` int NOT NULL,
  `tc_fname` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `tc_lname` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `tc_phone` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `tc_email` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `temp_seq`
--

DROP TABLE IF EXISTS `temp_seq`;
CREATE TABLE `temp_seq` (
  `seq_id` int unsigned NOT NULL,
  `seq_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_status` enum('active','aborted','resolved','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_next_step` tinyint NOT NULL,
  `seq_link` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_client` int unsigned NOT NULL,
  `seq_start_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test`
--

DROP TABLE IF EXISTS `test`;
CREATE TABLE `test` (
  `id` int NOT NULL,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `age` int DEFAULT NULL,
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `json` json NOT NULL,
  `fname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `mname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `lname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `test` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers for table `test`
--
DELIMITER $$
CREATE TRIGGER `parse_contact_name_trigger` BEFORE INSERT ON `test` FOR EACH ROW BEGIN
    DECLARE suffixes VARCHAR(255);
    DECLARE parts VARCHAR(255);
    DECLARE firstName VARCHAR(255);
    DECLARE middleName VARCHAR(255);
    DECLARE lastName VARCHAR(255);

    SET suffixes = 'jr,sr,i,ii,iii,iv,v,vi,vii,viii,ix,x';
    SET parts = NEW.name;
    SET firstName = SUBSTRING_INDEX(parts, ' ', 1);
    SET middleName = '';
    SET lastName = '';

    IF CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) >= 1 THEN
        IF FIND_IN_SET(SUBSTRING_INDEX(parts, ' ', -1), REPLACE(suffixes, ',', '')) AND CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) >= 2 THEN
            SET lastName = CONCAT(SUBSTRING_INDEX(parts, ' ', -2), ' ', SUBSTRING_INDEX(parts, ' ', -1));
            SET middleName = TRIM(BOTH ' ' FROM REPLACE(SUBSTRING_INDEX(parts, 2, CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) - 2), ' ', ','));
        ELSE
            SET lastName = SUBSTRING_INDEX(parts, ' ', -1);
            SET middleName = TRIM(BOTH ' ' FROM REPLACE(SUBSTRING_INDEX(parts, 2, CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) - 1), ' ', ','));
        END IF;
    END IF;

    SET NEW.fname = firstName;
    SET NEW.mname = middleName;
    SET NEW.lname = lastName;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `parse_contact_name_update_trigger` BEFORE UPDATE ON `test` FOR EACH ROW BEGIN
    DECLARE suffixes VARCHAR(255);
    DECLARE parts VARCHAR(255);
    DECLARE firstName VARCHAR(255);
    DECLARE middleName VARCHAR(255);
    DECLARE lastName VARCHAR(255);

    SET suffixes = 'jr,sr,i,ii,iii,iv,v,vi,vii,viii,ix,x';
    SET parts = NEW.name;
    SET firstName = SUBSTRING_INDEX(parts, ' ', 1);
    SET middleName = '';
    SET lastName = '';

    IF CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) >= 1 THEN
        IF FIND_IN_SET(SUBSTRING_INDEX(parts, ' ', -1), REPLACE(suffixes, ',', '')) AND CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) >= 2 THEN
            SET lastName = CONCAT(SUBSTRING_INDEX(parts, ' ', -3), ' ', SUBSTRING_INDEX(parts, ' ', -2), ' ', SUBSTRING_INDEX(parts, ' ', -1));
            SET middleName = TRIM(BOTH ' ' FROM REPLACE(SUBSTRING_INDEX(parts, 2, CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) - 3), ' ', ','));
        ELSE
            SET lastName = SUBSTRING_INDEX(parts, ' ', -1);
            SET middleName = TRIM(BOTH ' ' FROM REPLACE(SUBSTRING_INDEX(parts, 2, CHAR_LENGTH(parts) - CHAR_LENGTH(REPLACE(parts, ' ', '')) - 1), ' ', ','));
        END IF;
    END IF;

    SET NEW.fname = firstName;
    SET NEW.mname = middleName;
    SET NEW.lname = lastName;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `tool_versions`
--

DROP TABLE IF EXISTS `tool_versions`;
CREATE TABLE `tool_versions` (
  `id` int NOT NULL,
  `tool_id` int NOT NULL,
  `html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `saved_by` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `saved_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tools`
--

DROP TABLE IF EXISTS `tools`;
CREATE TABLE `tools` (
  `id` int NOT NULL,
  `tool_key` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `status` enum('draft','live') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft',
  `html` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `updated_by` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trigger_execution_rules`
--

DROP TABLE IF EXISTS `trigger_execution_rules`;
CREATE TABLE `trigger_execution_rules` (
  `id` bigint unsigned NOT NULL,
  `execution_id` bigint unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL,
  `rule_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `action_count` int NOT NULL DEFAULT '0',
  `failed_count` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trigger_executions`
--

DROP TABLE IF EXISTS `trigger_executions`;
CREATE TABLE `trigger_executions` (
  `id` bigint unsigned NOT NULL,
  `event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_id` int DEFAULT NULL,
  `case_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `depth` tinyint NOT NULL DEFAULT '0',
  `status` enum('matched','partial','no_match','no_rules','depth_capped','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `rules_matched` int NOT NULL DEFAULT '0',
  `outcomes` json DEFAULT NULL,
  `envelope` json DEFAULT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trigger_rule_actions`
--

DROP TABLE IF EXISTS `trigger_rule_actions`;
CREATE TABLE `trigger_rule_actions` (
  `id` int unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `position` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `action_type` enum('workflow','sequence','internal_function','http','hook') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `config` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trigger_rules`
--

DROP TABLE IF EXISTS `trigger_rules`;
CREATE TABLE `trigger_rules` (
  `id` int unsigned NOT NULL,
  `event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `position` int NOT NULL DEFAULT '0',
  `min_interval_s` int NOT NULL DEFAULT '0',
  `match_mode` enum('conditions','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `error_count` int NOT NULL DEFAULT '0',
  `last_error_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ui_config`
--

DROP TABLE IF EXISTS `ui_config`;
CREATE TABLE `ui_config` (
  `id` int unsigned NOT NULL,
  `scope` enum('system','firm','user') COLLATE utf8mb4_general_ci NOT NULL COMMENT 'firm = everyone (user_id 0); user = one user (user_id = users.user); system RESERVED (refused at write - the platform tier is code). sql_mode is relaxed here: an invalid value is stored as empty string with a warning, NOT rejected - the app layer (lib/uiConfigShape.js) is the only real validator',
  `user_id` tinyint NOT NULL DEFAULT '0' COMMENT 'users.user (signed tinyint, FK by convention) for scope user; sentinel 0 for scope firm. NOT NULL is load-bearing: MySQL unique indexes never collide on NULL, so a nullable user_id would allow duplicate firm rows',
  `role` varchar(20) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' COMMENT 'RESERVED: empty string only until a role model lands (writes refuse anything else). NOT NULL sentinel is load-bearing for uq_ui_config_scope, same reason as user_id',
  `config_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides, layout | user layout, shortcuts, items, prefs',
  `config` json NOT NULL COMMENT 'the normalized document lib/uiConfigShape.js returned. MySQL re-orders object keys on write - compare key-order-insensitively',
  `updated_by` tinyint DEFAULT NULL COMMENT 'users.user of the last writer (staff JWT only)',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='ui-custom config documents (PLAN §6): the firm launcher overlay + per-user layers (layout, shortcuts, own buttons, theme prefs), delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.';

-- --------------------------------------------------------

--
-- Table structure for table `ui_config_versions`
--

DROP TABLE IF EXISTS `ui_config_versions`;
CREATE TABLE `ui_config_versions` (
  `id` int unsigned NOT NULL,
  `ui_config_id` int unsigned NOT NULL COMMENT 'ui_config.id (FK, ON DELETE CASCADE)',
  `config_key` varchar(50) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'copy of ui_config.config_key at save time',
  `config` json NOT NULL COMMENT 'the NEW document saved - the newest row equals ui_config.config (routes/api.tools.js versioning convention); no row when a save left the document unchanged',
  `saved_by` tinyint DEFAULT NULL COMMENT 'users.user of the writer',
  `saved_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Save history of FIRM-scope ui_config rows: one row per firm save that changed the document, holding the new document. User scope is not versioned (PLAN §6).';

-- --------------------------------------------------------

--
-- Table structure for table `user_availability`
--

DROP TABLE IF EXISTS `user_availability`;
CREATE TABLE `user_availability` (
  `id` int unsigned NOT NULL,
  `user` tinyint NOT NULL,
  `weekday` tinyint NOT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `valid_from` date DEFAULT NULL,
  `valid_to` date DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_type` tinyint(1) NOT NULL DEFAULT '1',
  `user_real_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_fname` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_lname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_initials` varchar(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_auth` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user` tinyint NOT NULL,
  `email` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `default_phone` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `default_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `allow_sms` tinyint(1) NOT NULL DEFAULT '0',
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ringcentral` tinyint(1) NOT NULL,
  `task_remind_freq` set('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reset_token` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'password-reset bearer; 22-char base62 via lib/token, legacy 64-hex; _bin: case-sensitive',
  `reset_expires` datetime DEFAULT NULL,
  `does_appts` tinyint(1) NOT NULL DEFAULT '0',
  `freebusy_calendar_ids` json DEFAULT NULL,
  `user_gcal_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider secondary calendar id (firm Google account)',
  `roles` set('it','admin','staff','attorney','automation','form_dev','su') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  CONSTRAINT `chk_does_appts_requires_phone` CHECK (((`does_appts` = 0) or (`default_phone` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `video_slug_aliases`
--

DROP TABLE IF EXISTS `video_slug_aliases`;
CREATE TABLE `video_slug_aliases` (
  `slug` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `video_id` int NOT NULL,
  `archived_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `video_views`
--

DROP TABLE IF EXISTS `video_views`;
CREATE TABLE `video_views` (
  `id` bigint NOT NULL,
  `video_id` int NOT NULL,
  `contact_id` int DEFAULT NULL,
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ip_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `opened_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `played_at` timestamp NULL DEFAULT NULL,
  `watch_seconds` int NOT NULL DEFAULT '0',
  `completion_pct` tinyint NOT NULL DEFAULT '0',
  `cta_clicks` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `videos`
--

DROP TABLE IF EXISTS `videos`;
CREATE TABLE `videos` (
  `id` int NOT NULL,
  `slug` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `gcs_video_url` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `gcs_poster_url` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `gcs_gif_url` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `duration_seconds` int DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `related_video_ids` json DEFAULT NULL,
  `actions` json DEFAULT NULL,
  `access_level` enum('public','contact_only') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'public',
  `is_published` tinyint(1) NOT NULL DEFAULT '0',
  `view_count` int NOT NULL DEFAULT '0',
  `analytics_reset_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_execution_steps`
--

DROP TABLE IF EXISTS `workflow_execution_steps`;
CREATE TABLE `workflow_execution_steps` (
  `id` bigint NOT NULL,
  `workflow_execution_id` bigint NOT NULL,
  `step_number` int NOT NULL,
  `step_id` int NOT NULL,
  `status` enum('success','failed','skipped','delayed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `resolved_config` json DEFAULT NULL,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attempts` int DEFAULT '0',
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_executions`
--

DROP TABLE IF EXISTS `workflow_executions`;
CREATE TABLE `workflow_executions` (
  `id` bigint NOT NULL,
  `workflow_id` int NOT NULL,
  `contact_id` int DEFAULT NULL,
  `status` enum('pending','active','processing','delayed','completed','completed_with_errors','failed','cancelled','held') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `init_data` json DEFAULT NULL,
  `variables` json DEFAULT NULL,
  `current_step_number` int DEFAULT '1',
  `steps_executed_count` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at` datetime DEFAULT NULL,
  `cancel_reason` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `workflow_version` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_steps`
--

DROP TABLE IF EXISTS `workflow_steps`;
CREATE TABLE `workflow_steps` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `step_number` int NOT NULL,
  `type` enum('webhook','internal_function','custom_code') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `config` json NOT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `version` int NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_versions`
--

DROP TABLE IF EXISTS `workflow_versions`;
CREATE TABLE `workflow_versions` (
  `workflow_id` int NOT NULL,
  `version` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `test_input` json DEFAULT NULL,
  `published_at` datetime DEFAULT NULL,
  `published_by` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `retired_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflows`
--

DROP TABLE IF EXISTS `workflows`;
CREATE TABLE `workflows` (
  `id` int NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `default_contact_id_from` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `test_input` json DEFAULT NULL,
  `capture_mode` enum('off','capturing','intercept') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'off',
  `captured_input` json DEFAULT NULL,
  `captured_at` datetime DEFAULT NULL,
  `current_version` int NOT NULL DEFAULT '0',
  `draft_version` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Structure for view `ai_spend`
--

DROP VIEW IF EXISTS `ai_spend`;
CREATE VIEW `ai_spend` AS select `ai_calls`.`id` AS `id`,`ai_calls`.`created_at` AS `created_at`,`ai_calls`.`prompt_key` AS `prompt_key`,`ai_calls`.`prompt_version` AS `prompt_version`,`ai_calls`.`model` AS `model`,`ai_calls`.`mode` AS `mode`,`ai_calls`.`output_type` AS `output_type`,`ai_calls`.`consumer_ref` AS `consumer_ref`,`ai_calls`.`status` AS `status`,`ai_calls`.`input_tokens` AS `input_tokens`,`ai_calls`.`output_tokens` AS `output_tokens`,`ai_calls`.`cost_cents` AS `cost_cents`,`ai_calls`.`latency_ms` AS `latency_ms` from `ai_calls`;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admin_audit_log`
--
ALTER TABLE `admin_audit_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_admin_audit_tool` (`tool`,`created_at`),
  ADD KEY `idx_admin_audit_user` (`user_id`,`created_at`),
  ADD KEY `idx_admin_audit_status` (`status`,`created_at`);

--
-- Indexes for table `admin_saved_queries`
--
ALTER TABLE `admin_saved_queries`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_admin_saved_queries_user` (`user_id`,`name`);

--
-- Indexes for table `ai_calls`
--
ALTER TABLE `ai_calls`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ai_calls_consumer_ref` (`consumer_ref`),
  ADD KEY `idx_ai_calls_created_at` (`created_at`);

--
-- Indexes for table `ai_change_log`
--
ALTER TABLE `ai_change_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ai_change_log_source_message_id` (`source_message_id`),
  ADD KEY `idx_ai_change_log_entity` (`entity_type`,`entity_id`);

--
-- Indexes for table `ai_match_sets`
--
ALTER TABLE `ai_match_sets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_set_key` (`set_key`);

--
-- Indexes for table `ai_match_types`
--
ALTER TABLE `ai_match_types`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_set_type` (`set_id`,`type_key`),
  ADD KEY `idx_set_disposition` (`set_id`,`disposition`);

--
-- Indexes for table `alert_state`
--
ALTER TABLE `alert_state`
  ADD PRIMARY KEY (`group_key`);

--
-- Indexes for table `api_keys`
--
ALTER TABLE `api_keys`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_api_keys_hash` (`key_hash`);

--
-- Indexes for table `api_saved_requests`
--
ALTER TABLE `api_saved_requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_api_saved_requests_sort` (`sort_order`,`name`);

--
-- Indexes for table `app_settings`
--
ALTER TABLE `app_settings`
  ADD PRIMARY KEY (`key`);

--
-- Indexes for table `app_settings_versions`
--
ALTER TABLE `app_settings_versions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_app_settings_versions_key` (`setting_key`,`id`);

--
-- Indexes for table `appts`
--
ALTER TABLE `appts`
  ADD PRIMARY KEY (`appt_id`),
  ADD UNIQUE KEY `uq_appts_manage_token` (`appt_manage_token`),
  ADD KEY `lead_id` (`appt_case_id`),
  ADD KEY `date` (`appt_date`),
  ADD KEY `idx_appts_rescheduled_from` (`rescheduled_from_appt_id`),
  ADD KEY `idx_appts_type_key` (`type_key`),
  ADD KEY `idx_appts_link` (`appt_link_type`,`appt_link_id`);

--
-- Indexes for table `assistant_action_ledger`
--
ALTER TABLE `assistant_action_ledger`
  ADD PRIMARY KEY (`user_id`,`draft_id`);

--
-- Indexes for table `assistant_chat_messages`
--
ALTER TABLE `assistant_chat_messages`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_assistant_chat_messages_chat` (`chat_id`,`id`);

--
-- Indexes for table `assistant_chats`
--
ALTER TABLE `assistant_chats`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_assistant_chats_user_recent` (`user_id`,`updated_at` DESC,`id` DESC);

--
-- Indexes for table `availability_blocks`
--
ALTER TABLE `availability_blocks`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ab_user_start` (`user`,`active`,`block_start`);

--
-- Indexes for table `booking_views`
--
ALTER TABLE `booking_views`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_bv_slug` (`slug`);

--
-- Indexes for table `calendar_approaching_emitted`
--
ALTER TABLE `calendar_approaching_emitted`
  ADD PRIMARY KEY (`source`,`source_id`,`offset_days`,`item_date`);

--
-- Indexes for table `calendar_item_types`
--
ALTER TABLE `calendar_item_types`
  ADD PRIMARY KEY (`type_key`),
  ADD KEY `idx_cit_kind_active` (`kind`,`active`);

--
-- Indexes for table `calendar_type_options`
--
ALTER TABLE `calendar_type_options`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_cto_type_length` (`type_key`,`length`),
  ADD KEY `idx_cto_type_active` (`type_key`,`active`);

--
-- Indexes for table `campaign_contacts`
--
ALTER TABLE `campaign_contacts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_campaign_contact` (`campaign_id`,`contact_id`),
  ADD KEY `idx_contact_campaigns` (`contact_id`);

--
-- Indexes for table `campaign_results`
--
ALTER TABLE `campaign_results`
  ADD PRIMARY KEY (`result_id`),
  ADD UNIQUE KEY `uq_campaign_contact` (`campaign_id`,`contact_id`);

--
-- Indexes for table `campaigns`
--
ALTER TABLE `campaigns`
  ADD PRIMARY KEY (`campaign_id`);

--
-- Indexes for table `case_folder_cache`
--
ALTER TABLE `case_folder_cache`
  ADD PRIMARY KEY (`case_id`),
  ADD KEY `idx_cfc_ext` (`folder_external_id`);

--
-- Indexes for table `case_relate`
--
ALTER TABLE `case_relate`
  ADD PRIMARY KEY (`case_relate_id`),
  ADD UNIQUE KEY `uc_case_relate_unique` (`case_relate_case_id`,`case_relate_client_id`,`case_relate_type`),
  ADD KEY `idx_case_relate_client` (`case_relate_client_id`,`case_relate_case_id`);

--
-- Indexes for table `case_requirement_overrides`
--
ALTER TABLE `case_requirement_overrides`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_case_reqkey` (`case_id`,`requirement_key`);

--
-- Indexes for table `case_stage_aged_emitted`
--
ALTER TABLE `case_stage_aged_emitted`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_stage_threshold` (`stage_log_id`,`threshold_days`),
  ADD KEY `idx_case` (`case_id`);

--
-- Indexes for table `case_stage_log`
--
ALTER TABLE `case_stage_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_case_time` (`case_id`,`entered_at`),
  ADD KEY `idx_stage` (`stage_id`);

--
-- Indexes for table `cases`
--
ALTER TABLE `cases`
  ADD PRIMARY KEY (`case_id`),
  ADD KEY `idx_cases_case_number` (`case_number`),
  ADD KEY `idx_cases_case_number_full` (`case_number_full`),
  ADD KEY `idx_cases_judge_contact` (`case_judge_contact_id`),
  ADD KEY `idx_cases_trustee_contact` (`case_trustee_contact_id`);

--
-- Indexes for table `channel_grants`
--
ALTER TABLE `channel_grants`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_channel_grants_user_channel` (`user`,`channel_type`,`channel_id`),
  ADD KEY `idx_channel_grants_channel` (`channel_type`,`channel_id`);

--
-- Indexes for table `checkitems`
--
ALTER TABLE `checkitems`
  ADD PRIMARY KEY (`id`),
  ADD KEY `checklist_id` (`checklist_id`);

--
-- Indexes for table `checkitems1`
--
ALTER TABLE `checkitems1`
  ADD PRIMARY KEY (`checkitem_id`);

--
-- Indexes for table `checklists`
--
ALTER TABLE `checklists`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_link_kind_tag` (`link_type`,`link`,`kind`,`tag`),
  ADD KEY `idx_link` (`link_type`,`link`);

--
-- Indexes for table `checklists1`
--
ALTER TABLE `checklists1`
  ADD PRIMARY KEY (`checklist_id`);

--
-- Indexes for table `comm_consent_events`
--
ALTER TABLE `comm_consent_events`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_source_event` (`source`,`provider_event_id`),
  ADD KEY `ix_dest` (`channel`,`destination`,`occurred_at`);

--
-- Indexes for table `comm_consent_state`
--
ALTER TABLE `comm_consent_state`
  ADD PRIMARY KEY (`channel`,`destination`,`scope`);

--
-- Indexes for table `comm_topics`
--
ALTER TABLE `comm_topics`
  ADD PRIMARY KEY (`topic_key`);

--
-- Indexes for table `comms_eval_items`
--
ALTER TABLE `comms_eval_items`
  ADD PRIMARY KEY (`media_id`);

--
-- Indexes for table `comms_eval_reviews`
--
ALTER TABLE `comms_eval_reviews`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_eval_reviews` (`reviewer_id`,`media_id`,`stage`),
  ADD KEY `idx_comms_eval_reviews_media` (`media_id`);

--
-- Indexes for table `comms_media`
--
ALTER TABLE `comms_media`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_media_source` (`source_table`,`source_id`,`kind`,`part`),
  ADD KEY `idx_comms_media_work` (`state`,`next_attempt_at`),
  ADD KEY `idx_comms_media_party` (`party`,`captured_at`),
  ADD KEY `idx_comms_media_channel` (`channel`,`channel_id`,`captured_at`);

--
-- Indexes for table `comms_no_transcribe`
--
ALTER TABLE `comms_no_transcribe`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_no_transcribe_phone` (`phone`);

--
-- Indexes for table `comms_redo`
--
ALTER TABLE `comms_redo`
  ADD PRIMARY KEY (`transcript_id`);

--
-- Indexes for table `comms_stt_jobs`
--
ALTER TABLE `comms_stt_jobs`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_stt_jobs_ref` (`vendor`,`job_ref`),
  ADD KEY `idx_comms_stt_jobs_transcript` (`transcript_id`),
  ADD KEY `idx_comms_stt_jobs_month` (`submitted_at`),
  ADD KEY `idx_comms_stt_jobs_owed` (`deleted_at`,`delete_after`);

--
-- Indexes for table `comms_summaries`
--
ALTER TABLE `comms_summaries`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_summaries_transcript` (`transcript_id`),
  ADD KEY `idx_comms_summaries_work` (`state`,`next_attempt_at`);

--
-- Indexes for table `comms_summary_guides`
--
ALTER TABLE `comms_summary_guides`
  ADD PRIMARY KEY (`transcript_id`);

--
-- Indexes for table `comms_transcripts`
--
ALTER TABLE `comms_transcripts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_comms_transcripts_media` (`media_id`),
  ADD KEY `idx_comms_transcripts_event` (`phone_event_id`),
  ADD KEY `idx_comms_transcripts_work` (`state`,`next_attempt_at`),
  ADD KEY `idx_comms_transcripts_month` (`transcribed_at`),
  ADD FULLTEXT KEY `ft_comms_transcripts` (`full_text`,`summary_text`);

--
-- Indexes for table `contact_addresses`
--
ALTER TABLE `contact_addresses`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_one_active_primary` (`is_primary_uniq`),
  ADD KEY `idx_contact_active` (`contact_id`,`end_date`),
  ADD KEY `idx_zip` (`zip`);

--
-- Indexes for table `contact_emails`
--
ALTER TABLE `contact_emails`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_one_active_primary` (`is_primary_uniq`),
  ADD UNIQUE KEY `uk_email_active` (`email_active_uniq`),
  ADD KEY `idx_email_history` (`email`,`start_date`,`end_date`),
  ADD KEY `idx_contact_active` (`contact_id`,`end_date`);

--
-- Indexes for table `contact_phones`
--
ALTER TABLE `contact_phones`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_one_active_primary` (`is_primary_uniq`),
  ADD UNIQUE KEY `uk_phone_active` (`phone_active_uniq`),
  ADD KEY `idx_phone_history` (`phone`,`start_date`,`end_date`),
  ADD KEY `idx_contact_active` (`contact_id`,`end_date`);

--
-- Indexes for table `contact_relation_types`
--
ALTER TABLE `contact_relation_types`
  ADD PRIMARY KEY (`type_code`),
  ADD KEY `idx_active_sort` (`active`,`sort_order`);

--
-- Indexes for table `contact_relations`
--
ALTER TABLE `contact_relations`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uc_relation` (`contact_a_id`,`contact_b_id`,`type_code`),
  ADD KEY `idx_b` (`contact_b_id`),
  ADD KEY `idx_type` (`type_code`);

--
-- Indexes for table `contact_role_types`
--
ALTER TABLE `contact_role_types`
  ADD PRIMARY KEY (`role_code`);

--
-- Indexes for table `contact_roles`
--
ALTER TABLE `contact_roles`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_contact_role` (`contact_id`,`role`),
  ADD KEY `idx_role_active` (`role`,`active`);

--
-- Indexes for table `contacts`
--
ALTER TABLE `contacts`
  ADD PRIMARY KEY (`contact_id`),
  ADD UNIQUE KEY `uq_contacts_contact_token` (`contact_token`),
  ADD KEY `idx_contact_email` (`contact_email`),
  ADD KEY `idx_contacts_kind` (`contact_kind`),
  ADD FULLTEXT KEY `contact_name` (`contact_name`);

--
-- Indexes for table `contract_template_pdfs`
--
ALTER TABLE `contract_template_pdfs`
  ADD PRIMARY KEY (`template_id`);

--
-- Indexes for table `contract_templates`
--
ALTER TABLE `contract_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ct_kind_active` (`kind`,`active`);

--
-- Indexes for table `court_ai_log`
--
ALTER TABLE `court_ai_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_court_ai_log_message_id` (`message_id`),
  ADD KEY `idx_court_ai_log_outcome` (`outcome`),
  ADD KEY `idx_court_ai_log_created_at` (`created_at`);

--
-- Indexes for table `court_email_hashes`
--
ALTER TABLE `court_email_hashes`
  ADD PRIMARY KEY (`content_hash`);

--
-- Indexes for table `court_emails`
--
ALTER TABLE `court_emails`
  ADD UNIQUE KEY `subject` (`subject`);

--
-- Indexes for table `court_emails2`
--
ALTER TABLE `court_emails2`
  ADD UNIQUE KEY `subject` (`subject`);

--
-- Indexes for table `court_item_policy`
--
ALTER TABLE `court_item_policy`
  ADD PRIMARY KEY (`type_id`);

--
-- Indexes for table `credentials`
--
ALTER TABLE `credentials`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_oauth_refresh_window` (`oauth_status`,`refresh_token_expires_at`),
  ADD KEY `idx_oauth_state` (`oauth_state`);

--
-- Indexes for table `cta_executions`
--
ALTER TABLE `cta_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ctaexec_cta` (`cta_id`);

--
-- Indexes for table `cta_links`
--
ALTER TABLE `cta_links`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_cta_token` (`token`),
  ADD KEY `idx_cta_status_expires` (`status`,`expires_at`);

--
-- Indexes for table `decision_requests`
--
ALTER TABLE `decision_requests`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_decision_token` (`token`),
  ADD KEY `idx_decision_exec` (`workflow_execution_id`,`status`);

--
-- Indexes for table `default`
--
ALTER TABLE `default`
  ADD PRIMARY KEY (`default_id`);

--
-- Indexes for table `document_links`
--
ALTER TABLE `document_links`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_doc_target` (`document_id`,`link_type`,`link_id`),
  ADD KEY `idx_dl_target` (`link_type`,`link_id`);

--
-- Indexes for table `document_sync_roots`
--
ALTER TABLE `document_sync_roots`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `documents`
--
ALTER TABLE `documents`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_source_ext` (`source`,`external_id`),
  ADD KEY `idx_docs_path_hash` (`path_hash`),
  ADD KEY `idx_docs_type` (`doc_type`),
  ADD KEY `idx_docs_status` (`status`),
  ADD KEY `idx_docs_updated` (`updated_at`),
  ADD KEY `idx_docs_modified` (`server_modified`),
  ADD KEY `idx_docs_pending_delete` (`pending_delete_at`),
  ADD KEY `idx_docs_path_lower` (`path_lower`(191)),
  ADD FULLTEXT KEY `ft_docs` (`name`,`title`,`tags`);

--
-- Indexes for table `domain_event_queue`
--
ALTER TABLE `domain_event_queue`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status_created` (`status`,`created_at`),
  ADD KEY `idx_created` (`created_at`);

--
-- Indexes for table `email_credentials`
--
ALTER TABLE `email_credentials`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_email` (`email`),
  ADD KEY `fk_email_credentials_credential` (`credential_id`);

--
-- Indexes for table `email_ingest_executions`
--
ALTER TABLE `email_ingest_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_source_created` (`source_id`,`created_at`),
  ADD KEY `idx_status_created` (`status`,`created_at`),
  ADD KEY `idx_message_id` (`message_id`),
  ADD KEY `idx_action_failures` (`action_failure_count`,`created_at`),
  ADD KEY `idx_matched_rules` ((cast(json_extract(`metadata`,_utf8mb4'$.matched_rules') as unsigned array)));

--
-- Indexes for table `email_ingest_log_suppressions`
--
ALTER TABLE `email_ingest_log_suppressions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active` (`active`);

--
-- Indexes for table `email_ingest_rule_actions`
--
ALTER TABLE `email_ingest_rule_actions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_position` (`rule_id`,`position`);

--
-- Indexes for table `email_ingest_rule_changes`
--
ALTER TABLE `email_ingest_rule_changes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_changed` (`rule_id`,`changed_at`);

--
-- Indexes for table `email_ingest_rules`
--
ALTER TABLE `email_ingest_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active` (`active`);

--
-- Indexes for table `email_ingest_sources`
--
ALTER TABLE `email_ingest_sources`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `ux_name` (`name`),
  ADD UNIQUE KEY `ux_api_key` (`api_key`);

--
-- Indexes for table `email_log`
--
ALTER TABLE `email_log`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `ux_email_log_source_message` (`source`,`message_id`),
  ADD KEY `idx_email_log_message_id` (`message_id`);

--
-- Indexes for table `entitlement_denies`
--
ALTER TABLE `entitlement_denies`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_entitlement_denies_scope_item` (`scope`,`scope_ref`,`item_key`);

--
-- Indexes for table `events`
--
ALTER TABLE `events`
  ADD PRIMARY KEY (`event_id`),
  ADD KEY `idx_events_link` (`event_link_type`,`event_link_id`),
  ADD KEY `idx_events_date` (`event_date`),
  ADD KEY `idx_events_status_date` (`event_status`,`event_date`),
  ADD KEY `idx_events_superseded_by` (`superseded_by_event_id`),
  ADD KEY `idx_events_type_key` (`type_key`);

--
-- Indexes for table `feature_request_comments`
--
ALTER TABLE `feature_request_comments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `request_id` (`request_id`),
  ADD KEY `parent_comment_id` (`parent_comment_id`);

--
-- Indexes for table `feature_request_votes`
--
ALTER TABLE `feature_request_votes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_vote` (`request_id`,`user_id`);

--
-- Indexes for table `feature_requests`
--
ALTER TABLE `feature_requests`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `field_defs`
--
ALTER TABLE `field_defs`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_field_defs_entity_key` (`entity`,`field_key`);

--
-- Indexes for table `firm_blocks`
--
ALTER TABLE `firm_blocks`
  ADD PRIMARY KEY (`block_id`),
  ADD UNIQUE KEY `uq_fb_source_for` (`source`,`generated_for`),
  ADD KEY `idx_fb_start` (`active`,`block_start`);

--
-- Indexes for table `form_submissions`
--
ALTER TABLE `form_submissions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_draft_unique` (`draft_key`),
  ADD KEY `idx_form_entity` (`form_key`,`link_type`,`link_id`,`status`),
  ADD KEY `idx_updated` (`updated_at`);

--
-- Indexes for table `form_template_versions`
--
ALTER TABLE `form_template_versions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tpl` (`template_id`,`published_at`);

--
-- Indexes for table `form_templates`
--
ALTER TABLE `form_templates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_form_key` (`form_key`);

--
-- Indexes for table `holidays`
--
ALTER TABLE `holidays`
  ADD PRIMARY KEY (`holiday_id`);

--
-- Indexes for table `hook_delivery_logs`
--
ALTER TABLE `hook_delivery_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_exec` (`execution_id`);

--
-- Indexes for table `hook_executions`
--
ALTER TABLE `hook_executions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_hook_dedup` (`hook_id`,`dedup_key`),
  ADD KEY `idx_hook_created` (`hook_id`,`created_at`),
  ADD KEY `idx_status` (`status`);

--
-- Indexes for table `hook_targets`
--
ALTER TABLE `hook_targets`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_hook_position` (`hook_id`,`position`),
  ADD KEY `fk_hook_targets_cred` (`credential_id`);

--
-- Indexes for table `hooks`
--
ALTER TABLE `hooks`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_slug` (`slug`);

--
-- Indexes for table `image_library`
--
ALTER TABLE `image_library`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_url` (`url`(400)),
  ADD KEY `idx_il_collection` (`collection`),
  ADD KEY `idx_il_created` (`created_at`),
  ADD KEY `idx_il_deleted` (`deleted_at`);

--
-- Indexes for table `inbox_views`
--
ALTER TABLE `inbox_views`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_inbox_views_user` (`user`,`sort_order`);

--
-- Indexes for table `issue_reports`
--
ALTER TABLE `issue_reports`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_issue_reports_created` (`created_at`),
  ADD KEY `idx_issue_reports_open` (`resolved_at`,`created_at`);

--
-- Indexes for table `job_results`
--
ALTER TABLE `job_results`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_job` (`job_id`);

--
-- Indexes for table `jwt_api_audit_log`
--
ALTER TABLE `jwt_api_audit_log`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `legacy_route_log`
--
ALTER TABLE `legacy_route_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_route_ts` (`route`,`ts`);

--
-- Indexes for table `log`
--
ALTER TABLE `log`
  ADD PRIMARY KEY (`log_id`),
  ADD KEY `idx_log_link` (`log_link`),
  ADD KEY `idx_log_date` (`log_date`),
  ADD KEY `idx_log_type` (`log_type`),
  ADD KEY `idx_log_link_type_id` (`log_link_type`,`log_link_id`),
  ADD KEY `idx_log_about` (`log_about_type`,`log_about_id`);

--
-- Indexes for table `mail_image_senders`
--
ALTER TABLE `mail_image_senders`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_mail_image_senders_user_address` (`user`,`address`);

--
-- Indexes for table `mail_messages`
--
ALTER TABLE `mail_messages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_mail_messages_folder_uid` (`mailbox_id`,`folder`,`uid`),
  ADD KEY `idx_mail_messages_mailbox_date` (`mailbox_id`,`date`),
  ADD KEY `idx_mail_messages_message_id` (`message_id`(191)),
  ADD KEY `idx_mail_messages_thread_key` (`thread_key`(191)),
  ADD KEY `idx_mail_messages_mailbox_ingested` (`mailbox_id`,`ingested_at`),
  ADD KEY `idx_mail_messages_mailbox_provider` (`mailbox_id`,`provider_id`),
  ADD KEY `idx_mail_messages_mailbox_inbox_date` (`mailbox_id`,`in_inbox`,`date`);

--
-- Indexes for table `mail_read_state`
--
ALTER TABLE `mail_read_state`
  ADD PRIMARY KEY (`user`,`message_fk`),
  ADD KEY `idx_mail_read_state_message` (`message_fk`);

--
-- Indexes for table `mail_sends`
--
ALTER TABLE `mail_sends`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_mail_sends_message_id` (`message_id`(191)),
  ADD KEY `idx_mail_sends_provider_id` (`provider_id`),
  ADD KEY `idx_mail_sends_user_sent` (`user`,`sent_at`);

--
-- Indexes for table `mailboxes`
--
ALTER TABLE `mailboxes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_mailboxes_address` (`address`);

--
-- Indexes for table `pages`
--
ALTER TABLE `pages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pages_slug` (`slug`),
  ADD KEY `idx_pages_host_path` (`host`,`path`);

--
-- Indexes for table `payment_failed`
--
ALTER TABLE `payment_failed`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `phase_c_backup_20260526`
--
ALTER TABLE `phase_c_backup_20260526`
  ADD PRIMARY KEY (`log_id`);

--
-- Indexes for table `phone_event_log`
--
ALTER TABLE `phone_event_log`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `ux_phone_event_provider_ref` (`provider`,`provider_ref`),
  ADD KEY `idx_phone_event_other_party` (`other_party`),
  ADD KEY `idx_phone_event_processed_at` (`processed_at`),
  ADD KEY `idx_phone_event_delivery` (`delivery_state`,`processed_at`),
  ADD KEY `idx_phone_event_line` (`line_number`,`processed_at`);

--
-- Indexes for table `phone_ingest_executions`
--
ALTER TABLE `phone_ingest_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status_created` (`status`,`created_at`),
  ADD KEY `idx_event_log` (`event_log_id`),
  ADD KEY `idx_action_failures` (`action_failure_count`,`created_at`),
  ADD KEY `idx_matched_rules` ((cast(json_extract(`metadata`,_utf8mb4'$.matched_rules') as unsigned array)));

--
-- Indexes for table `phone_ingest_rule_actions`
--
ALTER TABLE `phone_ingest_rule_actions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_position` (`rule_id`,`position`);

--
-- Indexes for table `phone_ingest_rule_changes`
--
ALTER TABLE `phone_ingest_rule_changes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_changed` (`rule_id`,`changed_at`);

--
-- Indexes for table `phone_ingest_rules`
--
ALTER TABLE `phone_ingest_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active` (`active`);

--
-- Indexes for table `phone_lines`
--
ALTER TABLE `phone_lines`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_phone_number` (`phone_number`),
  ADD KEY `fk_phone_lines_credential` (`credential_id`);

--
-- Indexes for table `phone_log_suppressions`
--
ALTER TABLE `phone_log_suppressions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active` (`active`);

--
-- Indexes for table `pipeline_stage_requirements`
--
ALTER TABLE `pipeline_stage_requirements`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_stage_reqkey` (`stage_id`,`requirement_key`),
  ADD KEY `idx_req_stage` (`stage_id`);

--
-- Indexes for table `pipeline_stages`
--
ALTER TABLE `pipeline_stages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_template_key` (`template_id`,`stage_key`),
  ADD KEY `idx_template_order` (`template_id`,`stage_number`);

--
-- Indexes for table `pipeline_templates`
--
ALTER TABLE `pipeline_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_type_subtype` (`case_type`,`case_subtype`),
  ADD KEY `idx_role_active` (`role`,`active`);

--
-- Indexes for table `portal_access_log`
--
ALTER TABLE `portal_access_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_pal_contact` (`contact_id`,`created_at`),
  ADD KEY `idx_pal_event` (`event`);

--
-- Indexes for table `portal_cards`
--
ALTER TABLE `portal_cards`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_portal_cards_key` (`card_key`);

--
-- Indexes for table `portal_login_pins`
--
ALTER TABLE `portal_login_pins`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_pins_contact` (`contact_id`,`created_at`);

--
-- Indexes for table `query_log`
--
ALTER TABLE `query_log`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `rc_messages_log`
--
ALTER TABLE `rc_messages_log`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `rc_sms_log`
--
ALTER TABLE `rc_sms_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_created_at` (`created_at`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_to_number` (`to_number`),
  ADD KEY `idx_from_number` (`from_number`);

--
-- Indexes for table `readonly_api_keys`
--
ALTER TABLE `readonly_api_keys`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `key_hash` (`key_hash`),
  ADD KEY `idx_expires` (`expires_at`),
  ADD KEY `idx_created_by` (`created_by`,`created_at`),
  ADD KEY `idx_rok_parent` (`parent_key_id`,`created_at`);

--
-- Indexes for table `readonly_query_log`
--
ALTER TABLE `readonly_query_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_key_time` (`api_key_id`,`created_at`);

--
-- Indexes for table `redirects`
--
ALTER TABLE `redirects`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_slug` (`slug`);

--
-- Indexes for table `report_definition_versions`
--
ALTER TABLE `report_definition_versions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_rdv_report_version` (`report_id`,`version_no`),
  ADD KEY `idx_rdv_report` (`report_id`,`id`);

--
-- Indexes for table `report_definitions`
--
ALTER TABLE `report_definitions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_report_key` (`report_key`),
  ADD KEY `idx_active_category` (`is_active`,`category`),
  ADD KEY `idx_kind_active` (`kind`,`is_active`);

--
-- Indexes for table `report_runs`
--
ALTER TABLE `report_runs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_report_created` (`report_id`,`created_at`),
  ADD KEY `idx_created` (`created_at`);

--
-- Indexes for table `request_idempotency`
--
ALTER TABLE `request_idempotency`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_request_idempotency_actor_scope_key` (`user_id`,`scope`,`idem_key`),
  ADD KEY `idx_request_idempotency_created` (`created_at`);

--
-- Indexes for table `ringcentral_temp`
--
ALTER TABLE `ringcentral_temp`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `rw_scratch`
--
ALTER TABLE `rw_scratch`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_ns_k` (`ns`,`k`),
  ADD KEY `idx_ns_upd` (`ns`,`updated_at`);

--
-- Indexes for table `scheduled_jobs`
--
ALTER TABLE `scheduled_jobs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_scheduled_pending` (`status`,`scheduled_time`),
  ADD KEY `idx_seq_enrollment` (`sequence_enrollment_id`),
  ADD KEY `idx_sj_wf_exec` (`workflow_execution_id`,`type`,`status`);

--
-- Indexes for table `seq_steps`
--
ALTER TABLE `seq_steps`
  ADD PRIMARY KEY (`seq_step_id`);

--
-- Indexes for table `seq_types`
--
ALTER TABLE `seq_types`
  ADD PRIMARY KEY (`seq_type_id`);

--
-- Indexes for table `sequence_enrollments`
--
ALTER TABLE `sequence_enrollments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_contact_status` (`contact_id`,`status`),
  ADD KEY `idx_template_status` (`template_id`,`status`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_appt_id_status` (`appt_id`,`status`),
  ADD KEY `idx_seq_enroll_signing_request` (`signing_request_id`);

--
-- Indexes for table `sequence_step_log`
--
ALTER TABLE `sequence_step_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_enrollment` (`enrollment_id`),
  ADD KEY `idx_enrollment_step` (`enrollment_id`,`step_number`);

--
-- Indexes for table `sequence_steps`
--
ALTER TABLE `sequence_steps`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_template_version_step` (`template_id`,`version`,`step_number`),
  ADD KEY `idx_template` (`template_id`);

--
-- Indexes for table `sequence_template_types`
--
ALTER TABLE `sequence_template_types`
  ADD PRIMARY KEY (`type`);

--
-- Indexes for table `sequence_template_versions`
--
ALTER TABLE `sequence_template_versions`
  ADD PRIMARY KEY (`template_id`,`version`);

--
-- Indexes for table `sequence_templates`
--
ALTER TABLE `sequence_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_type` (`type`),
  ADD KEY `idx_active` (`active`);

--
-- Indexes for table `sequences`
--
ALTER TABLE `sequences`
  ADD PRIMARY KEY (`seq_id`);

--
-- Indexes for table `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`setting_id`),
  ADD UNIQUE KEY `uniq_setting_name` (`setting_name`);

--
-- Indexes for table `shared_namespaces`
--
ALTER TABLE `shared_namespaces`
  ADD PRIMARY KEY (`ns`);

--
-- Indexes for table `shared_values`
--
ALTER TABLE `shared_values`
  ADD PRIMARY KEY (`ns`,`k`);

--
-- Indexes for table `shared_values_history`
--
ALTER TABLE `shared_values_history`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_shared_values_history_ns_k_id` (`ns`,`k`,`id`),
  ADD KEY `idx_shared_values_history_ns_id` (`ns`,`id`);

--
-- Indexes for table `signing_request_events`
--
ALTER TABLE `signing_request_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_sre_request_occurred` (`signing_request_id`,`occurred_at`);

--
-- Indexes for table `signing_request_sources`
--
ALTER TABLE `signing_request_sources`
  ADD PRIMARY KEY (`signing_request_id`);

--
-- Indexes for table `signing_requests`
--
ALTER TABLE `signing_requests`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_sr_tracking` (`tracking_id`),
  ADD UNIQUE KEY `uq_provider` (`provider`,`provider_id`),
  ADD KEY `idx_sr_linkable` (`linkable_type`,`linkable_id`),
  ADD KEY `idx_sr_status` (`status`);

--
-- Indexes for table `streak_boards`
--
ALTER TABLE `streak_boards`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_streak_boards_slug` (`slug`);

--
-- Indexes for table `streak_checkins`
--
ALTER TABLE `streak_checkins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_streak_checkin` (`board_id`,`username`,`checkin_date`),
  ADD KEY `idx_streak_board_date` (`board_id`,`checkin_date`);

--
-- Indexes for table `streak_messages`
--
ALTER TABLE `streak_messages`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_streak_msg_board` (`board_id`,`id`);

--
-- Indexes for table `system_alerts`
--
ALTER TABLE `system_alerts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_sa_dedup` (`dedup_key`),
  ADD KEY `idx_sa_digested` (`digested_at`),
  ADD KEY `idx_sa_group` (`group_key`),
  ADD KEY `idx_sa_created` (`created_at`);

--
-- Indexes for table `tasks`
--
ALTER TABLE `tasks`
  ADD PRIMARY KEY (`task_id`),
  ADD UNIQUE KEY `uq_tasks_action_token` (`task_action_token`),
  ADD KEY `task_to` (`task_to`),
  ADD KEY `idx_task_link_type_id` (`task_link_type`,`task_link_id`),
  ADD KEY `idx_task_source_dedupe` (`task_source`,`task_dedupe_key`,`task_status`),
  ADD KEY `idx_tasks_session_key` (`task_session_key_id`,`task_date`);

--
-- Indexes for table `temp_contacts`
--
ALTER TABLE `temp_contacts`
  ADD PRIMARY KEY (`tc_id`);

--
-- Indexes for table `temp_seq`
--
ALTER TABLE `temp_seq`
  ADD PRIMARY KEY (`seq_id`);

--
-- Indexes for table `test`
--
ALTER TABLE `test`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `tool_versions`
--
ALTER TABLE `tool_versions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tool_versions_tool` (`tool_id`);

--
-- Indexes for table `tools`
--
ALTER TABLE `tools`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tool_key` (`tool_key`);

--
-- Indexes for table `trigger_execution_rules`
--
ALTER TABLE `trigger_execution_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_time` (`rule_id`,`id`),
  ADD KEY `idx_execution` (`execution_id`);

--
-- Indexes for table `trigger_executions`
--
ALTER TABLE `trigger_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_type_time` (`event_type`,`created_at`),
  ADD KEY `idx_case` (`case_id`),
  ADD KEY `idx_contact` (`contact_id`),
  ADD KEY `idx_created` (`created_at`),
  ADD KEY `idx_status_id` (`status`,`id`),
  ADD KEY `idx_event_id` (`event_type`,`id`);

--
-- Indexes for table `trigger_rule_actions`
--
ALTER TABLE `trigger_rule_actions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule` (`rule_id`,`active`,`position`);

--
-- Indexes for table `trigger_rules`
--
ALTER TABLE `trigger_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_event_active` (`event_type`,`active`,`position`);

--
-- Indexes for table `ui_config`
--
ALTER TABLE `ui_config`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_ui_config_scope` (`scope`,`user_id`,`role`,`config_key`);

--
-- Indexes for table `ui_config_versions`
--
ALTER TABLE `ui_config_versions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ui_config_versions_config` (`ui_config_id`,`id`);

--
-- Indexes for table `user_availability`
--
ALTER TABLE `user_availability`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ua_user_weekday` (`user`,`weekday`,`active`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`user`),
  ADD KEY `idx_reset_token` (`reset_token`);

--
-- Indexes for table `video_slug_aliases`
--
ALTER TABLE `video_slug_aliases`
  ADD PRIMARY KEY (`slug`),
  ADD KEY `idx_video_id` (`video_id`);

--
-- Indexes for table `video_views`
--
ALTER TABLE `video_views`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_video_contact` (`video_id`,`contact_id`),
  ADD KEY `idx_contact_opened` (`contact_id`,`opened_at`);

--
-- Indexes for table `videos`
--
ALTER TABLE `videos`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `slug` (`slug`),
  ADD KEY `idx_slug_published` (`slug`,`is_published`);

--
-- Indexes for table `workflow_execution_steps`
--
ALTER TABLE `workflow_execution_steps`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_execution_step` (`workflow_execution_id`,`step_number`,`executed_at` DESC),
  ADD KEY `idx_execution` (`workflow_execution_id`);

--
-- Indexes for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_workflow_status` (`workflow_id`,`status`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_wf_exec_contact` (`contact_id`),
  ADD KEY `idx_wf_exec_created` (`created_at`);

--
-- Indexes for table `workflow_steps`
--
ALTER TABLE `workflow_steps`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_workflow_version_step` (`workflow_id`,`version`,`step_number`),
  ADD KEY `idx_workflow` (`workflow_id`);

--
-- Indexes for table `workflow_versions`
--
ALTER TABLE `workflow_versions`
  ADD PRIMARY KEY (`workflow_id`,`version`);

--
-- Indexes for table `workflows`
--
ALTER TABLE `workflows`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admin_audit_log`
--
ALTER TABLE `admin_audit_log`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `admin_saved_queries`
--
ALTER TABLE `admin_saved_queries`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ai_calls`
--
ALTER TABLE `ai_calls`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ai_change_log`
--
ALTER TABLE `ai_change_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ai_match_sets`
--
ALTER TABLE `ai_match_sets`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ai_match_types`
--
ALTER TABLE `ai_match_types`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `api_keys`
--
ALTER TABLE `api_keys`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `api_saved_requests`
--
ALTER TABLE `api_saved_requests`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `app_settings_versions`
--
ALTER TABLE `app_settings_versions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `appts`
--
ALTER TABLE `appts`
  MODIFY `appt_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `assistant_chat_messages`
--
ALTER TABLE `assistant_chat_messages`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `assistant_chats`
--
ALTER TABLE `assistant_chats`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `availability_blocks`
--
ALTER TABLE `availability_blocks`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `booking_views`
--
ALTER TABLE `booking_views`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `calendar_type_options`
--
ALTER TABLE `calendar_type_options`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `campaign_contacts`
--
ALTER TABLE `campaign_contacts`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `campaign_results`
--
ALTER TABLE `campaign_results`
  MODIFY `result_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `campaigns`
--
ALTER TABLE `campaigns`
  MODIFY `campaign_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `case_relate`
--
ALTER TABLE `case_relate`
  MODIFY `case_relate_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `case_requirement_overrides`
--
ALTER TABLE `case_requirement_overrides`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `case_stage_aged_emitted`
--
ALTER TABLE `case_stage_aged_emitted`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `case_stage_log`
--
ALTER TABLE `case_stage_log`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `channel_grants`
--
ALTER TABLE `channel_grants`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `checkitems`
--
ALTER TABLE `checkitems`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `checkitems1`
--
ALTER TABLE `checkitems1`
  MODIFY `checkitem_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `checklists`
--
ALTER TABLE `checklists`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `checklists1`
--
ALTER TABLE `checklists1`
  MODIFY `checklist_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comm_consent_events`
--
ALTER TABLE `comm_consent_events`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_eval_reviews`
--
ALTER TABLE `comms_eval_reviews`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_media`
--
ALTER TABLE `comms_media`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_no_transcribe`
--
ALTER TABLE `comms_no_transcribe`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_stt_jobs`
--
ALTER TABLE `comms_stt_jobs`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_summaries`
--
ALTER TABLE `comms_summaries`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comms_transcripts`
--
ALTER TABLE `comms_transcripts`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contact_addresses`
--
ALTER TABLE `contact_addresses`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contact_emails`
--
ALTER TABLE `contact_emails`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contact_phones`
--
ALTER TABLE `contact_phones`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contact_relations`
--
ALTER TABLE `contact_relations`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contact_roles`
--
ALTER TABLE `contact_roles`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contacts`
--
ALTER TABLE `contacts`
  MODIFY `contact_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contract_templates`
--
ALTER TABLE `contract_templates`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `court_ai_log`
--
ALTER TABLE `court_ai_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `credentials`
--
ALTER TABLE `credentials`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cta_executions`
--
ALTER TABLE `cta_executions`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cta_links`
--
ALTER TABLE `cta_links`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `decision_requests`
--
ALTER TABLE `decision_requests`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `default`
--
ALTER TABLE `default`
  MODIFY `default_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `document_links`
--
ALTER TABLE `document_links`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `document_sync_roots`
--
ALTER TABLE `document_sync_roots`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `documents`
--
ALTER TABLE `documents`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `domain_event_queue`
--
ALTER TABLE `domain_event_queue`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_credentials`
--
ALTER TABLE `email_credentials`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_executions`
--
ALTER TABLE `email_ingest_executions`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_log_suppressions`
--
ALTER TABLE `email_ingest_log_suppressions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_rule_actions`
--
ALTER TABLE `email_ingest_rule_actions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_rule_changes`
--
ALTER TABLE `email_ingest_rule_changes`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_rules`
--
ALTER TABLE `email_ingest_rules`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_ingest_sources`
--
ALTER TABLE `email_ingest_sources`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_log`
--
ALTER TABLE `email_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `entitlement_denies`
--
ALTER TABLE `entitlement_denies`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `events`
--
ALTER TABLE `events`
  MODIFY `event_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `feature_request_comments`
--
ALTER TABLE `feature_request_comments`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `feature_request_votes`
--
ALTER TABLE `feature_request_votes`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `feature_requests`
--
ALTER TABLE `feature_requests`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `field_defs`
--
ALTER TABLE `field_defs`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `firm_blocks`
--
ALTER TABLE `firm_blocks`
  MODIFY `block_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `form_submissions`
--
ALTER TABLE `form_submissions`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `form_template_versions`
--
ALTER TABLE `form_template_versions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `form_templates`
--
ALTER TABLE `form_templates`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `holidays`
--
ALTER TABLE `holidays`
  MODIFY `holiday_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `hook_delivery_logs`
--
ALTER TABLE `hook_delivery_logs`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `hook_executions`
--
ALTER TABLE `hook_executions`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `hook_targets`
--
ALTER TABLE `hook_targets`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `hooks`
--
ALTER TABLE `hooks`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `image_library`
--
ALTER TABLE `image_library`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `inbox_views`
--
ALTER TABLE `inbox_views`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `issue_reports`
--
ALTER TABLE `issue_reports`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `job_results`
--
ALTER TABLE `job_results`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `jwt_api_audit_log`
--
ALTER TABLE `jwt_api_audit_log`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `legacy_route_log`
--
ALTER TABLE `legacy_route_log`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `log`
--
ALTER TABLE `log`
  MODIFY `log_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mail_image_senders`
--
ALTER TABLE `mail_image_senders`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mail_messages`
--
ALTER TABLE `mail_messages`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mail_sends`
--
ALTER TABLE `mail_sends`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mailboxes`
--
ALTER TABLE `mailboxes`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pages`
--
ALTER TABLE `pages`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `payment_failed`
--
ALTER TABLE `payment_failed`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_event_log`
--
ALTER TABLE `phone_event_log`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_ingest_executions`
--
ALTER TABLE `phone_ingest_executions`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_ingest_rule_actions`
--
ALTER TABLE `phone_ingest_rule_actions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_ingest_rule_changes`
--
ALTER TABLE `phone_ingest_rule_changes`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_ingest_rules`
--
ALTER TABLE `phone_ingest_rules`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_lines`
--
ALTER TABLE `phone_lines`
  MODIFY `id` tinyint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `phone_log_suppressions`
--
ALTER TABLE `phone_log_suppressions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pipeline_stage_requirements`
--
ALTER TABLE `pipeline_stage_requirements`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pipeline_stages`
--
ALTER TABLE `pipeline_stages`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pipeline_templates`
--
ALTER TABLE `pipeline_templates`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `portal_access_log`
--
ALTER TABLE `portal_access_log`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `portal_cards`
--
ALTER TABLE `portal_cards`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `portal_login_pins`
--
ALTER TABLE `portal_login_pins`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `query_log`
--
ALTER TABLE `query_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `rc_messages_log`
--
ALTER TABLE `rc_messages_log`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `rc_sms_log`
--
ALTER TABLE `rc_sms_log`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `readonly_api_keys`
--
ALTER TABLE `readonly_api_keys`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `readonly_query_log`
--
ALTER TABLE `readonly_query_log`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `redirects`
--
ALTER TABLE `redirects`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `report_definition_versions`
--
ALTER TABLE `report_definition_versions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `report_definitions`
--
ALTER TABLE `report_definitions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `report_runs`
--
ALTER TABLE `report_runs`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `request_idempotency`
--
ALTER TABLE `request_idempotency`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ringcentral_temp`
--
ALTER TABLE `ringcentral_temp`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `rw_scratch`
--
ALTER TABLE `rw_scratch`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `scheduled_jobs`
--
ALTER TABLE `scheduled_jobs`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `seq_steps`
--
ALTER TABLE `seq_steps`
  MODIFY `seq_step_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `seq_types`
--
ALTER TABLE `seq_types`
  MODIFY `seq_type_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sequence_enrollments`
--
ALTER TABLE `sequence_enrollments`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sequence_step_log`
--
ALTER TABLE `sequence_step_log`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sequence_steps`
--
ALTER TABLE `sequence_steps`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sequence_templates`
--
ALTER TABLE `sequence_templates`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sequences`
--
ALTER TABLE `sequences`
  MODIFY `seq_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `settings`
--
ALTER TABLE `settings`
  MODIFY `setting_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `shared_values_history`
--
ALTER TABLE `shared_values_history`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `signing_request_events`
--
ALTER TABLE `signing_request_events`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `signing_requests`
--
ALTER TABLE `signing_requests`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `streak_boards`
--
ALTER TABLE `streak_boards`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `streak_checkins`
--
ALTER TABLE `streak_checkins`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `streak_messages`
--
ALTER TABLE `streak_messages`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `system_alerts`
--
ALTER TABLE `system_alerts`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tasks`
--
ALTER TABLE `tasks`
  MODIFY `task_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `temp_contacts`
--
ALTER TABLE `temp_contacts`
  MODIFY `tc_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `temp_seq`
--
ALTER TABLE `temp_seq`
  MODIFY `seq_id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test`
--
ALTER TABLE `test`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tool_versions`
--
ALTER TABLE `tool_versions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tools`
--
ALTER TABLE `tools`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `trigger_execution_rules`
--
ALTER TABLE `trigger_execution_rules`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `trigger_executions`
--
ALTER TABLE `trigger_executions`
  MODIFY `id` bigint unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `trigger_rule_actions`
--
ALTER TABLE `trigger_rule_actions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `trigger_rules`
--
ALTER TABLE `trigger_rules`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ui_config`
--
ALTER TABLE `ui_config`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ui_config_versions`
--
ALTER TABLE `ui_config_versions`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_availability`
--
ALTER TABLE `user_availability`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `user` tinyint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `video_views`
--
ALTER TABLE `video_views`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `videos`
--
ALTER TABLE `videos`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_execution_steps`
--
ALTER TABLE `workflow_execution_steps`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_steps`
--
ALTER TABLE `workflow_steps`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflows`
--
ALTER TABLE `workflows`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `ai_match_types`
--
ALTER TABLE `ai_match_types`
  ADD CONSTRAINT `fk_amt_set` FOREIGN KEY (`set_id`) REFERENCES `ai_match_sets` (`id`);

--
-- Constraints for table `assistant_action_ledger`
--
ALTER TABLE `assistant_action_ledger`
  ADD CONSTRAINT `fk_assistant_action_ledger_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user`) ON DELETE CASCADE;

--
-- Constraints for table `assistant_chat_messages`
--
ALTER TABLE `assistant_chat_messages`
  ADD CONSTRAINT `fk_assistant_chat_messages_chat` FOREIGN KEY (`chat_id`) REFERENCES `assistant_chats` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `assistant_chats`
--
ALTER TABLE `assistant_chats`
  ADD CONSTRAINT `fk_assistant_chats_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user`) ON DELETE CASCADE;

--
-- Constraints for table `campaign_contacts`
--
ALTER TABLE `campaign_contacts`
  ADD CONSTRAINT `fk_cc_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`campaign_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_cc_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE CASCADE;

--
-- Constraints for table `checkitems`
--
ALTER TABLE `checkitems`
  ADD CONSTRAINT `checkitems_ibfk_1` FOREIGN KEY (`checklist_id`) REFERENCES `checklists` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `contact_addresses`
--
ALTER TABLE `contact_addresses`
  ADD CONSTRAINT `fk_contact_addresses_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE CASCADE;

--
-- Constraints for table `contact_emails`
--
ALTER TABLE `contact_emails`
  ADD CONSTRAINT `fk_contact_emails_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE CASCADE;

--
-- Constraints for table `contact_phones`
--
ALTER TABLE `contact_phones`
  ADD CONSTRAINT `fk_contact_phones_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE CASCADE;

--
-- Constraints for table `contact_relations`
--
ALTER TABLE `contact_relations`
  ADD CONSTRAINT `fk_cr_contact_a` FOREIGN KEY (`contact_a_id`) REFERENCES `contacts` (`contact_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `fk_cr_contact_b` FOREIGN KEY (`contact_b_id`) REFERENCES `contacts` (`contact_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `fk_cr_type_code` FOREIGN KEY (`type_code`) REFERENCES `contact_relation_types` (`type_code`) ON DELETE RESTRICT;

--
-- Constraints for table `court_item_policy`
--
ALTER TABLE `court_item_policy`
  ADD CONSTRAINT `fk_cip_type` FOREIGN KEY (`type_id`) REFERENCES `ai_match_types` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `email_credentials`
--
ALTER TABLE `email_credentials`
  ADD CONSTRAINT `fk_email_credentials_credential` FOREIGN KEY (`credential_id`) REFERENCES `credentials` (`id`);

--
-- Constraints for table `email_ingest_executions`
--
ALTER TABLE `email_ingest_executions`
  ADD CONSTRAINT `fk_eie_source` FOREIGN KEY (`source_id`) REFERENCES `email_ingest_sources` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `email_ingest_rule_actions`
--
ALTER TABLE `email_ingest_rule_actions`
  ADD CONSTRAINT `fk_eira_rule` FOREIGN KEY (`rule_id`) REFERENCES `email_ingest_rules` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `feature_request_comments`
--
ALTER TABLE `feature_request_comments`
  ADD CONSTRAINT `feature_request_comments_ibfk_1` FOREIGN KEY (`request_id`) REFERENCES `feature_requests` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `feature_request_comments_ibfk_2` FOREIGN KEY (`parent_comment_id`) REFERENCES `feature_request_comments` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `feature_request_votes`
--
ALTER TABLE `feature_request_votes`
  ADD CONSTRAINT `feature_request_votes_ibfk_1` FOREIGN KEY (`request_id`) REFERENCES `feature_requests` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `hook_delivery_logs`
--
ALTER TABLE `hook_delivery_logs`
  ADD CONSTRAINT `fk_delivery_execution` FOREIGN KEY (`execution_id`) REFERENCES `hook_executions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `hook_targets`
--
ALTER TABLE `hook_targets`
  ADD CONSTRAINT `fk_hook_targets_cred` FOREIGN KEY (`credential_id`) REFERENCES `credentials` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_hook_targets_hook` FOREIGN KEY (`hook_id`) REFERENCES `hooks` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `phone_ingest_rule_actions`
--
ALTER TABLE `phone_ingest_rule_actions`
  ADD CONSTRAINT `fk_pira_rule` FOREIGN KEY (`rule_id`) REFERENCES `phone_ingest_rules` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `phone_lines`
--
ALTER TABLE `phone_lines`
  ADD CONSTRAINT `fk_phone_lines_credential` FOREIGN KEY (`credential_id`) REFERENCES `credentials` (`id`);

--
-- Constraints for table `readonly_api_keys`
--
ALTER TABLE `readonly_api_keys`
  ADD CONSTRAINT `fk_rok_parent` FOREIGN KEY (`parent_key_id`) REFERENCES `readonly_api_keys` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

--
-- Constraints for table `readonly_query_log`
--
ALTER TABLE `readonly_query_log`
  ADD CONSTRAINT `fk_rqlog_key` FOREIGN KEY (`api_key_id`) REFERENCES `readonly_api_keys` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `request_idempotency`
--
ALTER TABLE `request_idempotency`
  ADD CONSTRAINT `fk_request_idempotency_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user`) ON DELETE CASCADE;

--
-- Constraints for table `sequence_enrollments`
--
ALTER TABLE `sequence_enrollments`
  ADD CONSTRAINT `fk_seq_enroll_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `fk_seq_enroll_template` FOREIGN KEY (`template_id`) REFERENCES `sequence_templates` (`id`) ON DELETE RESTRICT;

--
-- Constraints for table `sequence_step_log`
--
ALTER TABLE `sequence_step_log`
  ADD CONSTRAINT `fk_seq_log_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `sequence_enrollments` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `sequence_steps`
--
ALTER TABLE `sequence_steps`
  ADD CONSTRAINT `fk_seq_steps_template` FOREIGN KEY (`template_id`) REFERENCES `sequence_templates` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `sequence_template_versions`
--
ALTER TABLE `sequence_template_versions`
  ADD CONSTRAINT `fk_stv_template` FOREIGN KEY (`template_id`) REFERENCES `sequence_templates` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `shared_values`
--
ALTER TABLE `shared_values`
  ADD CONSTRAINT `fk_shared_values_ns` FOREIGN KEY (`ns`) REFERENCES `shared_namespaces` (`ns`) ON DELETE CASCADE;

--
-- Constraints for table `tool_versions`
--
ALTER TABLE `tool_versions`
  ADD CONSTRAINT `fk_tool_versions_tool` FOREIGN KEY (`tool_id`) REFERENCES `tools` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `trigger_execution_rules`
--
ALTER TABLE `trigger_execution_rules`
  ADD CONSTRAINT `fk_trigger_execution_rules_exec` FOREIGN KEY (`execution_id`) REFERENCES `trigger_executions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `trigger_rule_actions`
--
ALTER TABLE `trigger_rule_actions`
  ADD CONSTRAINT `fk_trigger_rule_actions_rule` FOREIGN KEY (`rule_id`) REFERENCES `trigger_rules` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `ui_config_versions`
--
ALTER TABLE `ui_config_versions`
  ADD CONSTRAINT `fk_ui_config_versions_config` FOREIGN KEY (`ui_config_id`) REFERENCES `ui_config` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `video_slug_aliases`
--
ALTER TABLE `video_slug_aliases`
  ADD CONSTRAINT `fk_video_slug_aliases_video` FOREIGN KEY (`video_id`) REFERENCES `videos` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `video_views`
--
ALTER TABLE `video_views`
  ADD CONSTRAINT `fk_video_views_video` FOREIGN KEY (`video_id`) REFERENCES `videos` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_execution_steps`
--
ALTER TABLE `workflow_execution_steps`
  ADD CONSTRAINT `fk_wf_exec_steps_execution` FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  ADD CONSTRAINT `fk_workflow_executions_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE RESTRICT;

--
-- Constraints for table `workflow_steps`
--
ALTER TABLE `workflow_steps`
  ADD CONSTRAINT `fk_workflow_steps_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_versions`
--
ALTER TABLE `workflow_versions`
  ADD CONSTRAINT `fk_wfv_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
