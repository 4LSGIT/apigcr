-- DB Console schema snapshot
-- Generated: 2026-07-19T07:54:24.352Z
-- Source: POST /admin/db/schema/save-to-ref
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
-- Table structure for table `_dead_email_router_config`
--

DROP TABLE IF EXISTS `_dead_email_router_config`;
CREATE TABLE `_dead_email_router_config` (
  `id` int NOT NULL DEFAULT '1',
  `auth_type` enum('none','api_key') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'api_key',
  `auth_config` json DEFAULT NULL,
  `capture_mode` enum('off','capturing') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'off',
  `captured_sample` json DEFAULT NULL,
  `captured_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `_dead_email_router_executions`
--

DROP TABLE IF EXISTS `_dead_email_router_executions`;
CREATE TABLE `_dead_email_router_executions` (
  `id` bigint NOT NULL,
  `raw_input` json DEFAULT NULL,
  `matched_route_id` int DEFAULT NULL,
  `resolved_slug` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `hook_execution_id` bigint DEFAULT NULL,
  `status` enum('routed','unrouted','captured','error') COLLATE utf8mb4_general_ci NOT NULL,
  `error` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `_dead_email_routes`
--

DROP TABLE IF EXISTS `_dead_email_routes`;
CREATE TABLE `_dead_email_routes` (
  `id` int NOT NULL,
  `name` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `slug` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `match_mode` enum('conditions','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json NOT NULL,
  `position` int NOT NULL DEFAULT '100',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `last_matched_at` datetime DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `admin_audit_log`
--

DROP TABLE IF EXISTS `admin_audit_log`;
CREATE TABLE `admin_audit_log` (
  `id` bigint NOT NULL,
  `tool` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'db_console, api_tester, ...',
  `user_id` int DEFAULT NULL,
  `username` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `route` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(10) COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(40) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'success/error/rejected_not_su/rejected_rate_limit/...',
  `error_message` text COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `name` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `query_text` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
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
  `prompt_key` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prompt_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `model` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mode` enum('sync','async') COLLATE utf8mb4_unicode_ci DEFAULT 'sync',
  `output_type` enum('text','json','html') COLLATE utf8mb4_unicode_ci DEFAULT 'text',
  `consumer_ref` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('ok','error','timeout') COLLATE utf8mb4_unicode_ci NOT NULL,
  `error` text COLLATE utf8mb4_unicode_ci,
  `input_tokens` int DEFAULT NULL,
  `output_tokens` int DEFAULT NULL,
  `cost_cents` decimal(10,4) DEFAULT NULL,
  `latency_ms` int DEFAULT NULL,
  `request_excerpt` text COLLATE utf8mb4_unicode_ci,
  `response` mediumtext COLLATE utf8mb4_unicode_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ai_change_log`
--

DROP TABLE IF EXISTS `ai_change_log`;
CREATE TABLE `ai_change_log` (
  `id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `source_message_id` varchar(190) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ai_call_id` int DEFAULT NULL,
  `court_ai_log_id` int DEFAULT NULL,
  `entity_type` enum('case','appt','event','workflow') COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `field` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `old_value` text COLLATE utf8mb4_unicode_ci,
  `new_value` text COLLATE utf8mb4_unicode_ci,
  `dry_run` tinyint(1) NOT NULL DEFAULT '0',
  `undone_at` datetime DEFAULT NULL,
  `undone_by` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `alert_state`
--

DROP TABLE IF EXISTS `alert_state`;
CREATE TABLE `alert_state` (
  `group_key` varchar(200) COLLATE utf8mb4_general_ci NOT NULL,
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
  `label` varchar(100) NOT NULL,
  `key_hash` char(64) NOT NULL,
  `key_prefix` varchar(12) NOT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `api_saved_requests`
--

DROP TABLE IF EXISTS `api_saved_requests`;
CREATE TABLE `api_saved_requests` (
  `id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GET',
  `url` text COLLATE utf8mb4_general_ci NOT NULL,
  `headers` json DEFAULT NULL COMMENT '{"Header-Name":"value", ...}',
  `body` mediumtext COLLATE utf8mb4_general_ci COMMENT 'raw body string (JSON or otherwise)',
  `content_type` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `credential_id` int DEFAULT NULL COMMENT 'FK-by-convention to credentials.id; resolved at send time',
  `follow_redirects` tinyint(1) NOT NULL DEFAULT '1',
  `notes` text COLLATE utf8mb4_general_ci,
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
  `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `is_secret` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'never returned by any settings API',
  `is_editable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'exposed in settings.html',
  `category` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `label` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `description` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `type` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sort_order` int DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `appts`
--

DROP TABLE IF EXISTS `appts`;
CREATE TABLE `appts` (
  `appt_id` int NOT NULL,
  `appt_client_id` int DEFAULT NULL,
  `appt_case_id` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_type` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `appt_length` tinyint DEFAULT NULL,
  `appt_form` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `appt_status` enum('Attended','No Show','Rescheduled','Canceled','Scheduled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_date` datetime NOT NULL,
  `appt_date_utc` datetime DEFAULT NULL,
  `appt_gcal` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_ref_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_note` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_platform` enum('telephone','Zoom','in-person') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `appt_create_date` datetime DEFAULT NULL,
  `appt_with` tinyint DEFAULT '1',
  `appt_end` datetime GENERATED ALWAYS AS ((`appt_date` + interval `appt_length` minute)) STORED,
  `appt_gcal_user` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider-calendar event id',
  `appt_source` varchar(60) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'booking view source_tag',
  `appt_manage_token` char(32) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'client manage-link token',
  `appt_view_id` int unsigned DEFAULT NULL COMMENT 'booking_views.id this appt was booked/rebooked through'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
  `reason` varchar(120) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `slug` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `provider_mode` enum('fixed_one','client_choice','any_auto') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'client_choice',
  `provider_ids` json NOT NULL,
  `appt_type` varchar(60) COLLATE utf8mb4_general_ci NOT NULL,
  `appt_length` smallint NOT NULL,
  `platform` enum('telephone','Zoom','in-person') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'telephone',
  `buffer_min` smallint NOT NULL DEFAULT '0',
  `min_notice_min` smallint NOT NULL DEFAULT '120',
  `horizon_days` smallint NOT NULL DEFAULT '30',
  `granularity_min` smallint NOT NULL DEFAULT '15',
  `identity_mode` enum('public','prefill') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'public',
  `source_tag` varchar(60) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `collect_note` tinyint(1) NOT NULL DEFAULT '0',
  `confirm_template` text COLLATE utf8mb4_general_ci,
  `confirm_sms` tinyint(1) NOT NULL DEFAULT '0',
  `confirm_email` tinyint(1) NOT NULL DEFAULT '0',
  `hook_id` int DEFAULT NULL,
  `title` varchar(200) COLLATE utf8mb4_general_ci NOT NULL,
  `subtitle` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `accent_color` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `logo_url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `logo_link_url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `thankyou_html` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `page_windows` json DEFAULT NULL,
  `footer_html` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `campaign_contacts`
--

DROP TABLE IF EXISTS `campaign_contacts`;
CREATE TABLE `campaign_contacts` (
  `id` int unsigned NOT NULL,
  `campaign_id` int NOT NULL,
  `contact_id` int unsigned NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `campaign_results`
--

DROP TABLE IF EXISTS `campaign_results`;
CREATE TABLE `campaign_results` (
  `result_id` int NOT NULL,
  `campaign_id` int NOT NULL,
  `contact_id` int NOT NULL,
  `status` enum('sent','failed','skipped') COLLATE utf8mb4_general_ci NOT NULL,
  `error` text COLLATE utf8mb4_general_ci,
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
  `type` enum('sms','email') COLLATE utf8mb4_general_ci NOT NULL,
  `sender` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `subject` text COLLATE utf8mb4_general_ci,
  `body` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `attachment_url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `status` enum('draft','scheduled','sending','sent','failed','partial_fail','canceled') COLLATE utf8mb4_general_ci DEFAULT 'draft',
  `scheduled_time` datetime DEFAULT NULL,
  `created_by` tinyint unsigned DEFAULT NULL,
  `result_summary` json DEFAULT NULL,
  `contact_count` int unsigned NOT NULL DEFAULT '0',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
-- Table structure for table `cases`
--

DROP TABLE IF EXISTS `cases`;
CREATE TABLE `cases` (
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_number_full` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_type` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `case_subtype` varchar(40) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `case_stage` enum('Open','Pending','Filed','Concluded','Closed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Open',
  `case_status` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_rec` varchar(128) COLLATE utf8mb4_general_ci NOT NULL,
  `case_open_date` date DEFAULT NULL,
  `case_file_date` date DEFAULT NULL,
  `case_close_date` date DEFAULT NULL,
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
  `case_source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_source_ref` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_dropbox` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_primary_reason` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_judge` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_trustee` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_341_link` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `case_chapter` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_341_current` datetime DEFAULT NULL,
  `case_341_initial` date DEFAULT NULL,
  `case_objection` date DEFAULT NULL,
  `case_180` date DEFAULT NULL,
  `case_preference` date DEFAULT NULL,
  `case_show_cause` datetime DEFAULT NULL,
  `clio_matter` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_appt_id` int NOT NULL,
  `341_status` enum('Continued','Completed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_docs` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_amend` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `341_notes` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_clio_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_alerts` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
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
-- Table structure for table `checkitems`
--

DROP TABLE IF EXISTS `checkitems`;
CREATE TABLE `checkitems` (
  `id` int NOT NULL,
  `checklist_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('incomplete','complete') COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `position` int DEFAULT NULL,
  `tag` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('incomplete','complete') COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `created_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_date` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` tinyint NOT NULL,
  `link` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `link_type` enum('contact','case','bill','appt','task','user') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tag` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL
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
  `email_optout` tinyint(1) NOT NULL DEFAULT '0',
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
  `sms_optout` tinyint(1) NOT NULL DEFAULT '0',
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
  `type_code` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `forward_label` varchar(60) COLLATE utf8mb4_general_ci NOT NULL,
  `reverse_label` varchar(60) COLLATE utf8mb4_general_ci NOT NULL,
  `is_symmetric` tinyint(1) NOT NULL DEFAULT '0',
  `allowed_statuses` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `allowed_end_reasons` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
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
  `type_code` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `status` varchar(40) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `end_reason` varchar(40) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` varchar(500) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` int NOT NULL DEFAULT '0',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `chk_no_self` CHECK ((`contact_a_id` <> `contact_b_id`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contacts`
--

DROP TABLE IF EXISTS `contacts`;
CREATE TABLE `contacts` (
  `contact_id` int unsigned NOT NULL,
  `contact_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_lfm_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_rname` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
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
  `contact_ssn` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_marital_status` enum('Single','Married','Separated','Divorced','Widowed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `contact_tags` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_notes` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_clio_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_google_resource_name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `contact_google_etag` varchar(160) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `contact_google_synced_at` datetime DEFAULT NULL,
  `contact_phone2` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_email2` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_created` datetime DEFAULT NULL,
  `contact_updated` timestamp NULL DEFAULT NULL,
  `contact_sms_optout` tinyint(1) NOT NULL DEFAULT '0',
  `contact_email_optout` tinyint(1) NOT NULL DEFAULT '0',
  `booking_token` char(32) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'opaque link-prefill id'
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

    IF OLD.contact_clio_id != NEW.contact_clio_id THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_clio_id', OLD.contact_clio_id,
            '$.new_contact_clio_id', NEW.contact_clio_id);
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
CREATE TRIGGER `contact_name_insert` BEFORE INSERT ON `contacts` FOR EACH ROW BEGIN
    DECLARE full_name VARCHAR(255);
    DECLARE lfm_name VARCHAR(255);
    DECLARE rname VARCHAR(255);
    SET full_name = CONCAT_WS(' ', 
        NEW.contact_fname, 
        COALESCE(NEW.contact_mname, ''), 
        COALESCE(NEW.contact_lname, '')
    );
SET lfm_name = TRIM(CONCAT(
    COALESCE(NEW.contact_lname, ''),
    ", ",
    NEW.contact_fname, " ",
    COALESCE(NEW.contact_mname, '')
));
    SET rname = TRIM(CONCAT_WS(' ',
        COALESCE(NEW.contact_mname, ''), 
        COALESCE(NEW.contact_lname, '')
    ));
    
    SET NEW.contact_name = REPLACE(full_name, '  ', ' ');
    SET NEW.contact_lfm_name = REPLACE(lfm_name, '  ', ' ');
    SET NEW.contact_rname = REPLACE(rname, '  ', ' ');
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `contact_name_update` BEFORE UPDATE ON `contacts` FOR EACH ROW BEGIN
    DECLARE full_name VARCHAR(255);
    DECLARE lfm_name VARCHAR(255);
    DECLARE rname VARCHAR(255);
    SET full_name = CONCAT_WS(' ', 
        NEW.contact_fname, 
        COALESCE(NEW.contact_mname, ''), 
        COALESCE(NEW.contact_lname, '')
    );
SET lfm_name = TRIM(CONCAT(
    COALESCE(NEW.contact_lname, ''),
    ", ",
    NEW.contact_fname, " ",
    COALESCE(NEW.contact_mname, '')
));
    SET rname = TRIM(CONCAT_WS(' ',
        COALESCE(NEW.contact_mname, ''), 
        COALESCE(NEW.contact_lname, '')
    ));
    
    SET NEW.contact_name = REPLACE(full_name, '  ', ' ');
    SET NEW.contact_lfm_name = REPLACE(lfm_name, '  ', ' ');
    SET NEW.contact_rname = REPLACE(rname, '  ', ' ');
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `contract_templates`
--

DROP TABLE IF EXISTS `contract_templates`;
CREATE TABLE `contract_templates` (
  `id` int unsigned NOT NULL,
  `name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `body` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'HTML, rendered to PDF in a later phase',
  `prefill_schema` json NOT NULL COMMENT '[{key,label,type,resolver,default,required}]',
  `placement_json` json NOT NULL COMMENT '{"coord_space":"pdf_user_space","fields":[{page,x,y,w,h,type,signer}]}',
  `reminder_seq_id` int unsigned DEFAULT NULL COMMENT 'sequence_templates.id; NULL = firm default sequence',
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
  `message_id` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ai_call_id` int DEFAULT NULL,
  `dry_run` tinyint(1) NOT NULL DEFAULT '1',
  `classification` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `case_number` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `resolved_case_id` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `case_name` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `actions_json` json DEFAULT NULL,
  `citations_json` json DEFAULT NULL,
  `skipped_json` json DEFAULT NULL,
  `outcome` enum('executed','queued','none','error') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `review_reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw_response` mediumtext COLLATE utf8mb4_unicode_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
-- Table structure for table `credentials`
--

DROP TABLE IF EXISTS `credentials`;
CREATE TABLE `credentials` (
  `id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('internal','bearer','api_key','basic','oauth2') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'internal',
  `config` json DEFAULT NULL,
  `allowed_urls` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `access_token` text COLLATE utf8mb4_general_ci,
  `refresh_token` text COLLATE utf8mb4_general_ci,
  `access_token_expires_at` datetime DEFAULT NULL,
  `refresh_token_expires_at` datetime DEFAULT NULL,
  `last_refreshed_at` datetime DEFAULT NULL,
  `oauth_status` enum('pending_auth','connected','refresh_failed','revoked') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_state` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_pkce_verifier` varchar(128) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `oauth_last_error` text COLLATE utf8mb4_general_ci,
  `oauth_last_error_at` datetime DEFAULT NULL,
  `refresh_failure_count` tinyint unsigned NOT NULL DEFAULT '0',
  `verbose` tinyint(1) NOT NULL DEFAULT '0'
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
-- Table structure for table `email_credentials`
--

DROP TABLE IF EXISTS `email_credentials`;
CREATE TABLE `email_credentials` (
  `id` int unsigned NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_host` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_port` int NOT NULL,
  `smtp_user` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_pass` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_secure` tinyint(1) NOT NULL DEFAULT '1',
  `provider` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'smtp',
  `credential_id` int DEFAULT NULL,
  `from_name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_credentials_backup_20260513`
--

DROP TABLE IF EXISTS `email_credentials_backup_20260513`;
CREATE TABLE `email_credentials_backup_20260513` (
  `id` int unsigned NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_host` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_port` int NOT NULL,
  `smtp_user` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_pass` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_secure` tinyint(1) NOT NULL DEFAULT '1',
  `provider` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'smtp',
  `credential_id` int DEFAULT NULL,
  `from_name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_executions`
--

DROP TABLE IF EXISTS `email_ingest_executions`;
CREATE TABLE `email_ingest_executions` (
  `id` bigint unsigned NOT NULL,
  `source_id` int unsigned DEFAULT NULL,
  `message_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('logged','duplicate','skipped_firm_to_firm','skipped_suppression','auth_failed','validation_failed','error') COLLATE utf8mb4_general_ci NOT NULL,
  `log_id` int unsigned DEFAULT NULL,
  `email_log_id` int unsigned DEFAULT NULL,
  `error` text COLLATE utf8mb4_general_ci,
  `metadata` json DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `remote_ip` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_log_suppressions`
--

DROP TABLE IF EXISTS `email_ingest_log_suppressions`;
CREATE TABLE `email_ingest_log_suppressions` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `match_mode` enum('conditions','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
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
  `position` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `action_type` enum('workflow','sequence','hook','internal_function','http') COLLATE utf8mb4_general_ci NOT NULL,
  `config` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_rules`
--

DROP TABLE IF EXISTS `email_ingest_rules`;
CREATE TABLE `email_ingest_rules` (
  `id` int unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `position` int NOT NULL DEFAULT '0',
  `match_mode` enum('conditions','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'conditions',
  `match_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `match_count` int NOT NULL DEFAULT '0',
  `last_matched_at` datetime DEFAULT NULL,
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `email_ingest_sources`
--

DROP TABLE IF EXISTS `email_ingest_sources`;
CREATE TABLE `email_ingest_sources` (
  `id` int unsigned NOT NULL,
  `name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `api_key` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `description` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `source` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `message_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `from_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `to_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `subject` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attachments` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `processed_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `events`
--

DROP TABLE IF EXISTS `events`;
CREATE TABLE `events` (
  `event_id` int unsigned NOT NULL,
  `event_type` varchar(60) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_link_type` enum('case','contact','case_number') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_link_id` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_title` varchar(200) COLLATE utf8mb4_general_ci NOT NULL,
  `event_date` date NOT NULL,
  `event_time` time DEFAULT NULL,
  `event_all_day` tinyint(1) NOT NULL DEFAULT '0',
  `event_length` int DEFAULT NULL,
  `event_location` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_link` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_note` text COLLATE utf8mb4_general_ci,
  `event_status` enum('Scheduled','Completed','Canceled') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Scheduled',
  `event_gcal` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_calendar_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `event_create_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `event_created_by` tinyint DEFAULT NULL,
  `event_updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `event_with` tinyint DEFAULT NULL COMMENT 'provider scope: users.user; NULL = firm-wide block'
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
  `comment` text COLLATE utf8mb4_general_ci NOT NULL,
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
  `title` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('bug','feature') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'feature',
  `stage` enum('considering','planning','working_on_it','implemented','future_thought','rejected') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'considering',
  `status_note` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `progress` tinyint unsigned NOT NULL DEFAULT '0',
  `is_public` tinyint(1) NOT NULL DEFAULT '1',
  `submitted_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `firm_blocks`
--

DROP TABLE IF EXISTS `firm_blocks`;
CREATE TABLE `firm_blocks` (
  `block_id` int unsigned NOT NULL,
  `block_start` datetime NOT NULL,
  `block_end` datetime NOT NULL,
  `label` varchar(120) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `source` enum('shabbos','yom_tov','manual') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
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
  `form_key` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `link_type` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `link_id` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('draft','submitted') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft',
  `version` int unsigned NOT NULL DEFAULT '0',
  `schema_version` int unsigned NOT NULL DEFAULT '1',
  `data` json NOT NULL,
  `submitted_by` int unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `draft_key` varchar(100) COLLATE utf8mb4_general_ci GENERATED ALWAYS AS ((case when (`status` = _utf8mb4'draft') then concat(`form_key`,_utf8mb4':',`link_type`,_utf8mb4':',`link_id`) else NULL end)) STORED
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
  `request_url` varchar(2048) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `request_method` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `request_body` json DEFAULT NULL,
  `response_status` int DEFAULT NULL,
  `response_body` text COLLATE utf8mb4_general_ci,
  `status` enum('success','failed') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'failed',
  `error` text COLLATE utf8mb4_general_ci,
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
  `slug` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `filter_passed` tinyint(1) DEFAULT NULL,
  `transform_output` json DEFAULT NULL,
  `status` enum('received','filtered','processing','delivered','partial','failed','captured') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'received',
  `error` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `position` int NOT NULL DEFAULT '0',
  `method` enum('GET','POST','PUT','PATCH','DELETE') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'POST',
  `url` varchar(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `headers` json DEFAULT NULL,
  `credential_id` int DEFAULT NULL,
  `body_mode` enum('transform_output','template') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'transform_output',
  `body_template` text COLLATE utf8mb4_general_ci,
  `config` json DEFAULT NULL,
  `conditions` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
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
  `slug` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `auth_type` enum('none','api_key','hmac') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'none',
  `auth_config` json DEFAULT NULL,
  `filter_mode` enum('none','conditions','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'none',
  `filter_config` json DEFAULT NULL,
  `transform_mode` enum('passthrough','mapper','code') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'passthrough',
  `transform_config` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `version` int NOT NULL DEFAULT '1',
  `last_modified_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `capture_mode` enum('off','capturing') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'off',
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
  `url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tags` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `collection` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mime` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `width` smallint unsigned DEFAULT NULL,
  `height` smallint unsigned DEFAULT NULL,
  `visibility` enum('public','private') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'public',
  `uploaded_by` tinyint unsigned DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `job_results`
--

DROP TABLE IF EXISTS `job_results`;
CREATE TABLE `job_results` (
  `id` bigint NOT NULL,
  `job_id` bigint NOT NULL,
  `attempt` int NOT NULL,
  `status` enum('success','failed') COLLATE utf8mb4_general_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `execution_number` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `judges`
--

DROP TABLE IF EXISTS `judges`;
CREATE TABLE `judges` (
  `judge_id` tinyint unsigned NOT NULL,
  `judge_3` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `judge_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `jwt_api_audit_log`
--

DROP TABLE IF EXISTS `jwt_api_audit_log`;
CREATE TABLE `jwt_api_audit_log` (
  `id` bigint NOT NULL,
  `route` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(10) COLLATE utf8mb4_general_ci NOT NULL,
  `headers` json DEFAULT NULL,
  `query_params` json DEFAULT NULL,
  `body` json DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_type` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `username` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_status` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `route` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(8) COLLATE utf8mb4_general_ci NOT NULL,
  `ip` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` text COLLATE utf8mb4_general_ci,
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
  `log_date` datetime NOT NULL,
  `log_link` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_link_type` enum('contact','case','appt','bill','phone','email','task','event') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_link_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
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
-- Table structure for table `master_contacts___leads_list___phil_tirone`
--

DROP TABLE IF EXISTS `master_contacts___leads_list___phil_tirone`;
CREATE TABLE `master_contacts___leads_list___phil_tirone` (
  `COL 1` varchar(5) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 2` varchar(28) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 3` varchar(11) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 4` varchar(26) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 5` varchar(14) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 6` varchar(15) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 7` varchar(17) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 8` varchar(38) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 9` varchar(8) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 10` varchar(3) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 11` varchar(8) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 12` varchar(14) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 13` varchar(14) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 14` varchar(4) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 15` varchar(5) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 16` varchar(7) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 17` varchar(4) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 18` varchar(25) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 19` varchar(63) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 20` varchar(9) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `COL 21` varchar(5) COLLATE utf8mb4_general_ci DEFAULT NULL
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
  `slug` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `host` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `path` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `html` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('draft','live') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'draft',
  `hook_slug` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `thankyou_url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `meta_title` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `orig_log_link_type` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `orig_log_link_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `orig_log_link` varchar(30) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `suppressed` tinyint(1) NOT NULL DEFAULT '0',
  `suppressed_by` json DEFAULT NULL,
  `log_id` int DEFAULT NULL,
  `raw_extra` json DEFAULT NULL,
  `processed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_executions`
--

DROP TABLE IF EXISTS `phone_ingest_executions`;
CREATE TABLE `phone_ingest_executions` (
  `id` bigint unsigned NOT NULL,
  `event_log_id` int unsigned DEFAULT NULL,
  `status` enum('logged','suppressed','error','duplicate') COLLATE utf8mb4_general_ci NOT NULL,
  `log_id` int DEFAULT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `metadata` json DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_ingest_rule_actions`
--

DROP TABLE IF EXISTS `phone_ingest_rule_actions`;
CREATE TABLE `phone_ingest_rule_actions` (
  `id` int unsigned NOT NULL,
  `rule_id` int unsigned NOT NULL,
  `position` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `action_type` enum('workflow','sequence','hook','internal_function','http') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `config` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `phone_lines`
--

DROP TABLE IF EXISTS `phone_lines`;
CREATE TABLE `phone_lines` (
  `id` tinyint unsigned NOT NULL,
  `phone_number` char(10) NOT NULL,
  `provider` enum('ringcentral','quo') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `display_name` varchar(50) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `provider_id` varchar(50) DEFAULT NULL,
  `credential_id` int NOT NULL,
  `mms_capable` tinyint(1) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
  `auth_type` enum('jwt','api key','password','unknown') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rc_messages_log`
--

DROP TABLE IF EXISTS `rc_messages_log`;
CREATE TABLE `rc_messages_log` (
  `id` int NOT NULL,
  `type` enum('sms','mms') COLLATE utf8mb4_general_ci NOT NULL,
  `from_number` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `to_number` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci,
  `attachment_filename` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `attachment_url` text COLLATE utf8mb4_general_ci,
  `status` enum('success','error') COLLATE utf8mb4_general_ci NOT NULL,
  `rc_response` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_general_ci,
  `timestamp` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rc_sms_log`
--

DROP TABLE IF EXISTS `rc_sms_log`;
CREATE TABLE `rc_sms_log` (
  `id` bigint unsigned NOT NULL,
  `from_number` varchar(20) NOT NULL,
  `to_number` varchar(20) NOT NULL,
  `message` text NOT NULL,
  `status` enum('success','failed') NOT NULL,
  `error` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `rc_id` varchar(255) DEFAULT NULL,
  `sent_by` varchar(50) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `readonly_api_keys`
--

DROP TABLE IF EXISTS `readonly_api_keys`;
CREATE TABLE `readonly_api_keys` (
  `id` int NOT NULL,
  `key_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `key_prefix` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `created_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `use_count` int NOT NULL DEFAULT '0',
  `ip_allowlist` text COLLATE utf8mb4_general_ci
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
  `ip` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sql_text` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `params_json` json DEFAULT NULL,
  `row_count` int DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `status` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `error_text` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `redirects`
--

DROP TABLE IF EXISTS `redirects`;
CREATE TABLE `redirects` (
  `id` int unsigned NOT NULL,
  `slug` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `target_url` text COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `hit_count` int unsigned NOT NULL DEFAULT '0',
  `expires_at` datetime DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
  `ns` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'default',
  `k` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `v` mediumtext COLLATE utf8mb4_general_ci,
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
  `type` enum('one_time','recurring','workflow_resume','sequence_step','hook_retry') COLLATE utf8mb4_general_ci NOT NULL,
  `scheduled_time` datetime NOT NULL,
  `status` enum('pending','running','completed','failed') COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `data` json NOT NULL,
  `recurrence_rule` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `idempotency_key` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL
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
  `trigger_data` json DEFAULT NULL,
  `status` enum('active','completed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `current_step` int unsigned DEFAULT '1',
  `total_steps` int unsigned NOT NULL DEFAULT '0',
  `cancel_reason` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `enrolled_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `completed_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  `status` enum('sent','skipped','failed') COLLATE utf8mb4_unicode_ci NOT NULL,
  `skip_reason` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action_config_resolved` json DEFAULT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `duration_ms` int DEFAULT '0',
  `scheduled_at` datetime DEFAULT NULL,
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_steps`
--

DROP TABLE IF EXISTS `sequence_steps`;
CREATE TABLE `sequence_steps` (
  `id` int unsigned NOT NULL,
  `template_id` int unsigned NOT NULL,
  `step_number` int NOT NULL,
  `action_type` enum('sms','email','task','internal_function','webhook','start_workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `action_config` json NOT NULL,
  `timing` json NOT NULL,
  `condition` json DEFAULT NULL,
  `fire_guard` json DEFAULT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_template_types`
--

DROP TABLE IF EXISTS `sequence_template_types`;
CREATE TABLE `sequence_template_types` (
  `type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority_fields` json NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sequence_templates`
--

DROP TABLE IF EXISTS `sequence_templates`;
CREATE TABLE `sequence_templates` (
  `id` int unsigned NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `filters` json DEFAULT NULL,
  `condition` json DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `test_input` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  `setting_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `setting_data` json NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  `slug` varchar(64) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'url key: /streak?b=<slug>',
  `title` varchar(160) COLLATE utf8mb4_general_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tz` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'America/Detroit' COMMENT 'IANA tz that defines when a day rolls over',
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
  `username` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'matches streak_boards.members[].u — deliberately not an FK',
  `checkin_date` date NOT NULL COMMENT 'the day being credited (board-local)',
  `logged_date` date NOT NULL COMMENT 'board-local day the row was actually created; logged_date > checkin_date === ticked late',
  `note` varchar(280) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'audit only — no logic reads this'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `system_alerts`
--

DROP TABLE IF EXISTS `system_alerts`;
CREATE TABLE `system_alerts` (
  `id` bigint unsigned NOT NULL,
  `source` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `group_key` varchar(200) COLLATE utf8mb4_general_ci NOT NULL,
  `severity` enum('info','warning','error','critical') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'error',
  `title` varchar(500) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci,
  `context` json DEFAULT NULL,
  `ref_table` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ref_id` bigint DEFAULT NULL,
  `dedup_key` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `digested_at` datetime DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  `acked_at` datetime DEFAULT NULL,
  `acked_by` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tasks`
--

DROP TABLE IF EXISTS `tasks`;
CREATE TABLE `tasks` (
  `task_id` int unsigned NOT NULL,
  `task_status` enum('Pending','Due Today','Overdue','Completed','Canceled','Deleted') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Pending',
  `task_from` tinyint unsigned NOT NULL,
  `task_to` tinyint unsigned NOT NULL,
  `task_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_start` date DEFAULT NULL,
  `task_due` date DEFAULT NULL,
  `task_link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_link_type` enum('contact','case','appt','bill','event') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_desc` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_notification` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'notify task assigner upon completion?',
  `task_source` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_last_update` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_due_job_id` bigint DEFAULT NULL,
  `task_action_token` char(22) COLLATE utf8mb4_general_ci DEFAULT NULL
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
  `tc_fname` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_lname` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_phone` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_email` varchar(64) COLLATE utf8mb4_general_ci NOT NULL
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
-- Table structure for table `tempusers`
--

DROP TABLE IF EXISTS `tempusers`;
CREATE TABLE `tempusers` (
  `id` int unsigned NOT NULL,
  `user_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_password` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_auth` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
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
  `lname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
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
-- Table structure for table `trustees`
--

DROP TABLE IF EXISTS `trustees`;
CREATE TABLE `trustees` (
  `trustee_id` int NOT NULL,
  `trustee_full_name` varchar(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_link` varchar(73) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_lname` varchar(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_URL20ready` varchar(28) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_case_type` tinyint NOT NULL,
  `trustee_address1` varchar(27) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_address2` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `trustee_city` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_state` varchar(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_zip` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_email` varchar(28) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `trustee_phone` varchar(14) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
  `user_real_name` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_fname` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_lname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_initials` varchar(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_auth` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user` tinyint NOT NULL,
  `email` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `default_phone` char(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `default_email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` char(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `allow_sms` tinyint(1) NOT NULL DEFAULT '0',
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ringcentral` tinyint(1) NOT NULL,
  `task_remind_freq` set('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reset_token` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reset_expires` datetime DEFAULT NULL,
  `user_custom_tab` json NOT NULL,
  `does_appts` tinyint(1) NOT NULL DEFAULT '0',
  `freebusy_calendar_ids` json DEFAULT NULL,
  `user_gcal_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'provider secondary calendar id (firm Google account)',
  CONSTRAINT `chk_does_appts_requires_phone` CHECK (((`does_appts` = 0) or (`default_phone` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `video_slug_aliases`
--

DROP TABLE IF EXISTS `video_slug_aliases`;
CREATE TABLE `video_slug_aliases` (
  `slug` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
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
  `ip_hash` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
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
  `slug` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `gcs_video_url` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `gcs_poster_url` varchar(1024) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `gcs_gif_url` varchar(1024) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `duration_seconds` int DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `related_video_ids` json DEFAULT NULL,
  `actions` json DEFAULT NULL,
  `access_level` enum('public','contact_only') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'public',
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
  `status` enum('success','failed','skipped','delayed') COLLATE utf8mb4_unicode_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `resolved_config` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `attempts` int DEFAULT '0',
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_executions`
--

DROP TABLE IF EXISTS `workflow_executions`;
CREATE TABLE `workflow_executions` (
  `id` bigint NOT NULL,
  `workflow_id` int NOT NULL,
  `contact_id` int DEFAULT NULL,
  `status` enum('pending','active','processing','delayed','completed','completed_with_errors','failed','cancelled') COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `init_data` json DEFAULT NULL,
  `variables` json DEFAULT NULL,
  `current_step_number` int DEFAULT '1',
  `steps_executed_count` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at` datetime DEFAULT NULL,
  `cancel_reason` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_steps`
--

DROP TABLE IF EXISTS `workflow_steps`;
CREATE TABLE `workflow_steps` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `step_number` int NOT NULL,
  `type` enum('webhook','internal_function','custom_code') COLLATE utf8mb4_unicode_ci NOT NULL,
  `config` json NOT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflows`
--

DROP TABLE IF EXISTS `workflows`;
CREATE TABLE `workflows` (
  `id` int NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `default_contact_id_from` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `test_input` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `_dead_email_router_config`
--
ALTER TABLE `_dead_email_router_config`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `_dead_email_router_executions`
--
ALTER TABLE `_dead_email_router_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_created_at` (`created_at`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_route` (`matched_route_id`),
  ADD KEY `idx_hook_exec` (`hook_execution_id`);

--
-- Indexes for table `_dead_email_routes`
--
ALTER TABLE `_dead_email_routes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active_position` (`active`,`position`),
  ADD KEY `idx_slug` (`slug`);

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
-- Indexes for table `appts`
--
ALTER TABLE `appts`
  ADD PRIMARY KEY (`appt_id`),
  ADD UNIQUE KEY `uq_appts_manage_token` (`appt_manage_token`),
  ADD KEY `lead_id` (`appt_case_id`),
  ADD KEY `date` (`appt_date`);

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
-- Indexes for table `case_relate`
--
ALTER TABLE `case_relate`
  ADD PRIMARY KEY (`case_relate_id`),
  ADD UNIQUE KEY `uc_case_relate_unique` (`case_relate_case_id`,`case_relate_client_id`,`case_relate_type`),
  ADD KEY `idx_case_relate_client` (`case_relate_client_id`,`case_relate_case_id`);

--
-- Indexes for table `cases`
--
ALTER TABLE `cases`
  ADD PRIMARY KEY (`case_id`),
  ADD KEY `idx_cases_case_number` (`case_number`),
  ADD KEY `idx_cases_case_number_full` (`case_number_full`);

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
  ADD UNIQUE KEY `link` (`link`),
  ADD KEY `idx_link` (`link_type`,`link`);

--
-- Indexes for table `checklists1`
--
ALTER TABLE `checklists1`
  ADD PRIMARY KEY (`checklist_id`);

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
-- Indexes for table `contacts`
--
ALTER TABLE `contacts`
  ADD PRIMARY KEY (`contact_id`),
  ADD UNIQUE KEY `uq_contacts_booking_token` (`booking_token`),
  ADD KEY `idx_contact_email` (`contact_email`),
  ADD FULLTEXT KEY `contact_name` (`contact_name`);

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
-- Indexes for table `credentials`
--
ALTER TABLE `credentials`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_oauth_refresh_window` (`oauth_status`,`refresh_token_expires_at`),
  ADD KEY `idx_oauth_state` (`oauth_state`);

--
-- Indexes for table `default`
--
ALTER TABLE `default`
  ADD PRIMARY KEY (`default_id`);

--
-- Indexes for table `email_credentials`
--
ALTER TABLE `email_credentials`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_email` (`email`),
  ADD KEY `fk_email_credentials_credential` (`credential_id`);

--
-- Indexes for table `email_credentials_backup_20260513`
--
ALTER TABLE `email_credentials_backup_20260513`
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
  ADD KEY `idx_message_id` (`message_id`);

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
-- Indexes for table `events`
--
ALTER TABLE `events`
  ADD PRIMARY KEY (`event_id`),
  ADD KEY `idx_events_link` (`event_link_type`,`event_link_id`),
  ADD KEY `idx_events_date` (`event_date`),
  ADD KEY `idx_events_status_date` (`event_status`,`event_date`);

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
-- Indexes for table `job_results`
--
ALTER TABLE `job_results`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_job` (`job_id`);

--
-- Indexes for table `judges`
--
ALTER TABLE `judges`
  ADD PRIMARY KEY (`judge_id`);

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
  ADD KEY `idx_log_link_type_id` (`log_link_type`,`log_link_id`);

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
  ADD KEY `idx_phone_event_processed_at` (`processed_at`);

--
-- Indexes for table `phone_ingest_executions`
--
ALTER TABLE `phone_ingest_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status_created` (`status`,`created_at`),
  ADD KEY `idx_event_log` (`event_log_id`);

--
-- Indexes for table `phone_ingest_rule_actions`
--
ALTER TABLE `phone_ingest_rule_actions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rule_position` (`rule_id`,`position`);

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
  ADD KEY `idx_created_by` (`created_by`,`created_at`);

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
  ADD KEY `idx_seq_enrollment` (`sequence_enrollment_id`);

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
  ADD KEY `idx_appt_id_status` (`appt_id`,`status`);

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
  ADD UNIQUE KEY `uk_template_step` (`template_id`,`step_number`),
  ADD KEY `idx_template` (`template_id`);

--
-- Indexes for table `sequence_template_types`
--
ALTER TABLE `sequence_template_types`
  ADD PRIMARY KEY (`type`);

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
-- Indexes for table `signing_request_events`
--
ALTER TABLE `signing_request_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_sre_request_occurred` (`signing_request_id`,`occurred_at`);

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
  ADD KEY `idx_task_link_type_id` (`task_link_type`,`task_link_id`);

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
-- Indexes for table `tempusers`
--
ALTER TABLE `tempusers`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `test`
--
ALTER TABLE `test`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `trustees`
--
ALTER TABLE `trustees`
  ADD PRIMARY KEY (`trustee_id`);

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
  ADD KEY `idx_wf_exec_contact` (`contact_id`);

--
-- Indexes for table `workflow_steps`
--
ALTER TABLE `workflow_steps`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_workflow_step` (`workflow_id`,`step_number`),
  ADD KEY `idx_workflow` (`workflow_id`);

--
-- Indexes for table `workflows`
--
ALTER TABLE `workflows`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `_dead_email_router_executions`
--
ALTER TABLE `_dead_email_router_executions`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `_dead_email_routes`
--
ALTER TABLE `_dead_email_routes`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

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
-- AUTO_INCREMENT for table `appts`
--
ALTER TABLE `appts`
  MODIFY `appt_id` int NOT NULL AUTO_INCREMENT;

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
-- AUTO_INCREMENT for table `default`
--
ALTER TABLE `default`
  MODIFY `default_id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_credentials`
--
ALTER TABLE `email_credentials`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `email_credentials_backup_20260513`
--
ALTER TABLE `email_credentials_backup_20260513`
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
-- AUTO_INCREMENT for table `job_results`
--
ALTER TABLE `job_results`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `judges`
--
ALTER TABLE `judges`
  MODIFY `judge_id` tinyint unsigned NOT NULL AUTO_INCREMENT;

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
-- AUTO_INCREMENT for table `tempusers`
--
ALTER TABLE `tempusers`
  MODIFY `id` int unsigned NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test`
--
ALTER TABLE `test`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `trustees`
--
ALTER TABLE `trustees`
  MODIFY `trustee_id` int NOT NULL AUTO_INCREMENT;

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
-- Constraints for table `readonly_query_log`
--
ALTER TABLE `readonly_query_log`
  ADD CONSTRAINT `fk_rqlog_key` FOREIGN KEY (`api_key_id`) REFERENCES `readonly_api_keys` (`id`) ON DELETE CASCADE;

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

SET FOREIGN_KEY_CHECKS = 1;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
