-- Schema snapshot for `dbnwqdrfyz9vmq`
-- Generated: 2026-04-22T10:30:22.217Z
-- Source: /admin/db/schema/snapshot
-- Contains CREATE TABLE statements only (no data).

-- -----------------------------------------------------
-- Table: admin_db_console_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `admin_db_console_log`;
CREATE TABLE `admin_db_console_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `username` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `route` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(10) COLLATE utf8mb4_general_ci NOT NULL,
  `query_text` mediumtext COLLATE utf8mb4_general_ci,
  `read_only_mode` tinyint(1) NOT NULL DEFAULT '1',
  `status` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `error_message` text COLLATE utf8mb4_general_ci,
  `row_count` int DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_admin_db_console_log_user` (`user_id`,`created_at`),
  KEY `idx_admin_db_console_log_status` (`status`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: admin_saved_queries
-- -----------------------------------------------------
DROP TABLE IF EXISTS `admin_saved_queries`;
CREATE TABLE `admin_saved_queries` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `query_text` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_admin_saved_queries_user` (`user_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: app_settings
-- -----------------------------------------------------
DROP TABLE IF EXISTS `app_settings`;
CREATE TABLE `app_settings` (
  `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: appts
-- -----------------------------------------------------
DROP TABLE IF EXISTS `appts`;
CREATE TABLE `appts` (
  `appt_id` int NOT NULL AUTO_INCREMENT,
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
  `appt_workflow_execution_id` bigint DEFAULT NULL,
  PRIMARY KEY (`appt_id`),
  KEY `lead_id` (`appt_case_id`),
  KEY `date` (`appt_date`)
) ENGINE=InnoDB AUTO_INCREMENT=3836 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: campaign_contacts
-- -----------------------------------------------------
DROP TABLE IF EXISTS `campaign_contacts`;
CREATE TABLE `campaign_contacts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `campaign_id` int NOT NULL,
  `contact_id` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_campaign_contact` (`campaign_id`,`contact_id`),
  KEY `idx_contact_campaigns` (`contact_id`),
  CONSTRAINT `fk_cc_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`campaign_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cc_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=167 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: campaign_results
-- -----------------------------------------------------
DROP TABLE IF EXISTS `campaign_results`;
CREATE TABLE `campaign_results` (
  `result_id` int NOT NULL AUTO_INCREMENT,
  `campaign_id` int NOT NULL,
  `contact_id` int NOT NULL,
  `status` enum('sent','failed','skipped') COLLATE utf8mb4_general_ci NOT NULL,
  `error` text COLLATE utf8mb4_general_ci,
  `sent_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `result_meta` json DEFAULT NULL,
  PRIMARY KEY (`result_id`),
  UNIQUE KEY `uq_campaign_contact` (`campaign_id`,`contact_id`)
) ENGINE=InnoDB AUTO_INCREMENT=246 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: campaigns
-- -----------------------------------------------------
DROP TABLE IF EXISTS `campaigns`;
CREATE TABLE `campaigns` (
  `campaign_id` int NOT NULL AUTO_INCREMENT,
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
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`campaign_id`)
) ENGINE=InnoDB AUTO_INCREMENT=104 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: case_relate
-- -----------------------------------------------------
DROP TABLE IF EXISTS `case_relate`;
CREATE TABLE `case_relate` (
  `case_relate_id` int unsigned NOT NULL AUTO_INCREMENT,
  `case_relate_case_id` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_relate_client_id` int unsigned NOT NULL,
  `case_relate_type` enum('Primary','Secondary','Other','Bystander') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`case_relate_id`),
  UNIQUE KEY `uc_case_relate_unique` (`case_relate_case_id`,`case_relate_client_id`,`case_relate_type`),
  KEY `idx_case_relate_client` (`case_relate_client_id`,`case_relate_case_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2019 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: cases
-- -----------------------------------------------------
DROP TABLE IF EXISTS `cases`;
CREATE TABLE `cases` (
  `case_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `case_number` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_number_full` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `case_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
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
  `case_alerts` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`case_id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: checkitems
-- -----------------------------------------------------
DROP TABLE IF EXISTS `checkitems`;
CREATE TABLE `checkitems` (
  `id` int NOT NULL AUTO_INCREMENT,
  `checklist_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('incomplete','complete') COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `position` int DEFAULT NULL,
  `tag` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_date` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `checklist_id` (`checklist_id`),
  CONSTRAINT `checkitems_ibfk_1` FOREIGN KEY (`checklist_id`) REFERENCES `checklists` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1851 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: checkitems1
-- -----------------------------------------------------
DROP TABLE IF EXISTS `checkitems1`;
CREATE TABLE `checkitems1` (
  `checkitem_id` int unsigned NOT NULL AUTO_INCREMENT,
  `checkitem_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checkitem_list_id` int unsigned NOT NULL,
  `checkitem_status` enum('complete','incomplete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'incomplete',
  PRIMARY KEY (`checkitem_id`)
) ENGINE=MyISAM AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: checklists
-- -----------------------------------------------------
DROP TABLE IF EXISTS `checklists`;
CREATE TABLE `checklists` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('incomplete','complete') COLLATE utf8mb4_general_ci DEFAULT 'incomplete',
  `created_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_date` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` tinyint NOT NULL,
  `link` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `link_type` enum('contact','case','bill','appt','task','user') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tag` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `link` (`link`),
  KEY `idx_link` (`link_type`,`link`)
) ENGINE=InnoDB AUTO_INCREMENT=247 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: checklists1
-- -----------------------------------------------------
DROP TABLE IF EXISTS `checklists1`;
CREATE TABLE `checklists1` (
  `checklist_id` int unsigned NOT NULL AUTO_INCREMENT,
  `checklist_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checklist_link` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `checklist_status` enum('complete','incomplete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'incomplete',
  PRIMARY KEY (`checklist_id`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: contacts
-- -----------------------------------------------------
DROP TABLE IF EXISTS `contacts`;
CREATE TABLE `contacts` (
  `contact_id` int unsigned NOT NULL AUTO_INCREMENT,
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
  `contact_phone2` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_email2` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `contact_created` datetime DEFAULT NULL,
  `contact_updated` timestamp NULL DEFAULT NULL,
  `contact_sms_optout` tinyint(1) NOT NULL DEFAULT '0',
  `contact_email_optout` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`contact_id`),
  KEY `idx_contact_email` (`contact_email`),
  FULLTEXT KEY `contact_name` (`contact_name`)
) ENGINE=InnoDB AUTO_INCREMENT=1978 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: court_emails
-- -----------------------------------------------------
DROP TABLE IF EXISTS `court_emails`;
CREATE TABLE `court_emails` (
  `subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `count` int DEFAULT NULL,
  UNIQUE KEY `subject` (`subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: court_emails2
-- -----------------------------------------------------
DROP TABLE IF EXISTS `court_emails2`;
CREATE TABLE `court_emails2` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `count` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `subject` (`subject`)
) ENGINE=InnoDB AUTO_INCREMENT=1713 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: credentials
-- -----------------------------------------------------
DROP TABLE IF EXISTS `credentials`;
CREATE TABLE `credentials` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('internal','bearer','api_key','basic') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'internal',
  `config` json DEFAULT NULL,
  `allowed_urls` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: default
-- -----------------------------------------------------
DROP TABLE IF EXISTS `default`;
CREATE TABLE `default` (
  `default_id` int NOT NULL AUTO_INCREMENT,
  `default_response` enum('no results found') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`default_id`)
) ENGINE=MyISAM AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: email_credentials
-- -----------------------------------------------------
DROP TABLE IF EXISTS `email_credentials`;
CREATE TABLE `email_credentials` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_host` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_port` int NOT NULL,
  `smtp_user` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_pass` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `smtp_secure` tinyint(1) NOT NULL DEFAULT '1',
  `provider` enum('smtp','pabbly') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'smtp',
  `from_name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: email_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `email_log`;
CREATE TABLE `email_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `message_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `from_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `to_email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `subject` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `attachments` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `processed_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `message_id` (`message_id`),
  KEY `idx_message_id` (`message_id`)
) ENGINE=InnoDB AUTO_INCREMENT=25924 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: feature_request_comments
-- -----------------------------------------------------
DROP TABLE IF EXISTS `feature_request_comments`;
CREATE TABLE `feature_request_comments` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `request_id` int unsigned NOT NULL,
  `user_id` int NOT NULL,
  `parent_comment_id` int unsigned DEFAULT NULL,
  `comment` text COLLATE utf8mb4_general_ci NOT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `request_id` (`request_id`),
  KEY `parent_comment_id` (`parent_comment_id`),
  CONSTRAINT `feature_request_comments_ibfk_1` FOREIGN KEY (`request_id`) REFERENCES `feature_requests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `feature_request_comments_ibfk_2` FOREIGN KEY (`parent_comment_id`) REFERENCES `feature_request_comments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: feature_request_votes
-- -----------------------------------------------------
DROP TABLE IF EXISTS `feature_request_votes`;
CREATE TABLE `feature_request_votes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `request_id` int unsigned NOT NULL,
  `user_id` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vote` (`request_id`,`user_id`),
  CONSTRAINT `feature_request_votes_ibfk_1` FOREIGN KEY (`request_id`) REFERENCES `feature_requests` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: feature_requests
-- -----------------------------------------------------
DROP TABLE IF EXISTS `feature_requests`;
CREATE TABLE `feature_requests` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci NOT NULL,
  `type` enum('bug','feature') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'feature',
  `stage` enum('considering','planning','working_on_it','implemented','future_thought','rejected') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'considering',
  `status_note` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `progress` tinyint unsigned NOT NULL DEFAULT '0',
  `is_public` tinyint(1) NOT NULL DEFAULT '1',
  `submitted_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: form_submissions
-- -----------------------------------------------------
DROP TABLE IF EXISTS `form_submissions`;
CREATE TABLE `form_submissions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
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
  `draft_key` varchar(100) COLLATE utf8mb4_general_ci GENERATED ALWAYS AS ((case when (`status` = _utf8mb4'draft') then concat(`form_key`,_utf8mb4':',`link_type`,_utf8mb4':',`link_id`) else NULL end)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_draft_unique` (`draft_key`),
  KEY `idx_form_entity` (`form_key`,`link_type`,`link_id`,`status`),
  KEY `idx_updated` (`updated_at`)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: holidays
-- -----------------------------------------------------
DROP TABLE IF EXISTS `holidays`;
CREATE TABLE `holidays` (
  `holiday_id` int NOT NULL AUTO_INCREMENT,
  `holiday_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `holiday_date` date NOT NULL,
  `start_time` time DEFAULT '18:00:00',
  `end_time` time DEFAULT '21:00:00',
  `is_two_day` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`holiday_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: hook_delivery_logs
-- -----------------------------------------------------
DROP TABLE IF EXISTS `hook_delivery_logs`;
CREATE TABLE `hook_delivery_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
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
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_exec` (`execution_id`),
  CONSTRAINT `fk_delivery_execution` FOREIGN KEY (`execution_id`) REFERENCES `hook_executions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=51 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: hook_executions
-- -----------------------------------------------------
DROP TABLE IF EXISTS `hook_executions`;
CREATE TABLE `hook_executions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `hook_id` int NOT NULL,
  `slug` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `raw_input` json DEFAULT NULL,
  `filter_passed` tinyint(1) DEFAULT NULL,
  `transform_output` json DEFAULT NULL,
  `status` enum('received','filtered','processing','delivered','partial','failed','captured') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'received',
  `error` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hook_created` (`hook_id`,`created_at`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=61 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: hook_targets
-- -----------------------------------------------------
DROP TABLE IF EXISTS `hook_targets`;
CREATE TABLE `hook_targets` (
  `id` int NOT NULL AUTO_INCREMENT,
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
  `active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_hook_position` (`hook_id`,`position`),
  KEY `fk_hook_targets_cred` (`credential_id`),
  CONSTRAINT `fk_hook_targets_cred` FOREIGN KEY (`credential_id`) REFERENCES `credentials` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_hook_targets_hook` FOREIGN KEY (`hook_id`) REFERENCES `hooks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: hooks
-- -----------------------------------------------------
DROP TABLE IF EXISTS `hooks`;
CREATE TABLE `hooks` (
  `id` int NOT NULL AUTO_INCREMENT,
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
  `captured_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_slug` (`slug`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: image_library
-- -----------------------------------------------------
DROP TABLE IF EXISTS `image_library`;
CREATE TABLE `image_library` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mime` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `uploaded_by` tinyint unsigned DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_url` (`url`(400))
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: job_results
-- -----------------------------------------------------
DROP TABLE IF EXISTS `job_results`;
CREATE TABLE `job_results` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `job_id` bigint NOT NULL,
  `attempt` int NOT NULL,
  `status` enum('success','failed') COLLATE utf8mb4_general_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_general_ci,
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `execution_number` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_job` (`job_id`)
) ENGINE=InnoDB AUTO_INCREMENT=118 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: judges
-- -----------------------------------------------------
DROP TABLE IF EXISTS `judges`;
CREATE TABLE `judges` (
  `judge_id` tinyint unsigned NOT NULL AUTO_INCREMENT,
  `judge_3` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `judge_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`judge_id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: jwt_api_audit_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `jwt_api_audit_log`;
CREATE TABLE `jwt_api_audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
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
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=17629 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `log`;
CREATE TABLE `log` (
  `log_id` int NOT NULL AUTO_INCREMENT,
  `log_type` enum('email','sms','call','other','form','status','note','court email','docs','appt','update','task') COLLATE utf8mb4_general_ci NOT NULL,
  `log_date` datetime NOT NULL,
  `log_link` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_link_type` enum('contact','case','appt','bill') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_by` tinyint unsigned NOT NULL,
  `log_data` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_from` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_to` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_subject` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_message` varchar(10000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_form_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_form_sub` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_direction` enum('incoming','outgoing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`log_id`),
  KEY `idx_log_link` (`log_link`),
  KEY `idx_log_date` (`log_date`),
  KEY `idx_log_type` (`log_type`),
  KEY `idx_log_link_type_id` (`log_link_type`,`log_link_id`)
) ENGINE=MyISAM AUTO_INCREMENT=49080 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='text, includes email body, sms message, note, etc';

-- -----------------------------------------------------
-- Table: logtemp
-- -----------------------------------------------------
DROP TABLE IF EXISTS `logtemp`;
CREATE TABLE `logtemp` (
  `log_id` int NOT NULL AUTO_INCREMENT,
  `log_type` enum('email','sms','call','other','form','status','note','court email','docs','appt','update') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_date` datetime NOT NULL,
  `log_link` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_by` tinyint unsigned NOT NULL,
  `log_data` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_from` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_to` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_subject` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_message` varchar(10000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `log_form_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_form_sub` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `log_direction` enum('incoming','outgoing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`log_id`)
) ENGINE=MyISAM AUTO_INCREMENT=33118 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='text, includes email body, sms message, note, etc';

-- -----------------------------------------------------
-- Table: master_contacts___leads_list___phil_tirone
-- -----------------------------------------------------
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

-- -----------------------------------------------------
-- Table: mytable
-- -----------------------------------------------------
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

-- -----------------------------------------------------
-- Table: payment_failed
-- -----------------------------------------------------
DROP TABLE IF EXISTS `payment_failed`;
CREATE TABLE `payment_failed` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `amount` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `date` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `clio` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2483 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: phone_lines
-- -----------------------------------------------------
DROP TABLE IF EXISTS `phone_lines`;
CREATE TABLE `phone_lines` (
  `id` tinyint unsigned NOT NULL AUTO_INCREMENT,
  `phone_number` char(10) NOT NULL,
  `provider` enum('ringcentral','quo') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `display_name` varchar(50) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `provider_id` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_phone_number` (`phone_number`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------
-- Table: query_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `query_log`;
CREATE TABLE `query_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `username` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `auth_status` enum('authorized','unauthorized') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `query` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `auth_type` enum('jwt','api key','password','unknown') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=38448 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: rc_messages_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `rc_messages_log`;
CREATE TABLE `rc_messages_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('sms','mms') COLLATE utf8mb4_general_ci NOT NULL,
  `from_number` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `to_number` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci,
  `attachment_filename` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `attachment_url` text COLLATE utf8mb4_general_ci,
  `status` enum('success','error') COLLATE utf8mb4_general_ci NOT NULL,
  `rc_response` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_general_ci,
  `timestamp` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=197 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: rc_sms_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `rc_sms_log`;
CREATE TABLE `rc_sms_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `from_number` varchar(20) NOT NULL,
  `to_number` varchar(20) NOT NULL,
  `message` text NOT NULL,
  `status` enum('success','failed') NOT NULL,
  `error` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `rc_id` varchar(255) DEFAULT NULL,
  `sent_by` varchar(50) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_status` (`status`),
  KEY `idx_to_number` (`to_number`),
  KEY `idx_from_number` (`from_number`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------
-- Table: ringcentral_temp
-- -----------------------------------------------------
DROP TABLE IF EXISTS `ringcentral_temp`;
CREATE TABLE `ringcentral_temp` (
  `id` int NOT NULL AUTO_INCREMENT,
  `data` json NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=164 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: scheduled_jobs
-- -----------------------------------------------------
DROP TABLE IF EXISTS `scheduled_jobs`;
CREATE TABLE `scheduled_jobs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `type` enum('one_time','recurring','workflow_resume','sequence_step','hook_retry') COLLATE utf8mb4_general_ci NOT NULL,
  `scheduled_time` datetime NOT NULL,
  `status` enum('pending','running','completed','failed') COLLATE utf8mb4_general_ci DEFAULT 'pending',
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
  `idempotency_key` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_scheduled_pending` (`status`,`scheduled_time`),
  KEY `idx_seq_enrollment` (`sequence_enrollment_id`)
) ENGINE=InnoDB AUTO_INCREMENT=232 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: seq_steps
-- -----------------------------------------------------
DROP TABLE IF EXISTS `seq_steps`;
CREATE TABLE `seq_steps` (
  `seq_step_id` int unsigned NOT NULL AUTO_INCREMENT,
  `seq_step_seq_id` int NOT NULL,
  `seq_step_number` int NOT NULL,
  `seq_step_delay` int unsigned NOT NULL,
  `seq_step_action` enum('sms','email','status','alert') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_from` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_to` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_step_text` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`seq_step_id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: seq_types
-- -----------------------------------------------------
DROP TABLE IF EXISTS `seq_types`;
CREATE TABLE `seq_types` (
  `seq_type_id` int unsigned NOT NULL AUTO_INCREMENT,
  `seq_type_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_table` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_col` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_op` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_trig_val` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_type_steps` int NOT NULL,
  PRIMARY KEY (`seq_type_id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: sequence_enrollments
-- -----------------------------------------------------
DROP TABLE IF EXISTS `sequence_enrollments`;
CREATE TABLE `sequence_enrollments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `template_id` int unsigned NOT NULL,
  `contact_id` int unsigned NOT NULL,
  `trigger_data` json DEFAULT NULL,
  `status` enum('active','completed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `current_step` int unsigned DEFAULT '1',
  `total_steps` int unsigned NOT NULL DEFAULT '0',
  `cancel_reason` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `enrolled_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `completed_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_contact_status` (`contact_id`,`status`),
  KEY `idx_template_status` (`template_id`,`status`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_seq_enroll_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`contact_id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_seq_enroll_template` FOREIGN KEY (`template_id`) REFERENCES `sequence_templates` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: sequence_step_log
-- -----------------------------------------------------
DROP TABLE IF EXISTS `sequence_step_log`;
CREATE TABLE `sequence_step_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
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
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_enrollment` (`enrollment_id`),
  KEY `idx_enrollment_step` (`enrollment_id`,`step_number`),
  CONSTRAINT `fk_seq_log_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `sequence_enrollments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=37 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: sequence_steps
-- -----------------------------------------------------
DROP TABLE IF EXISTS `sequence_steps`;
CREATE TABLE `sequence_steps` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `template_id` int unsigned NOT NULL,
  `step_number` int NOT NULL,
  `action_type` enum('sms','email','task','internal_function','webhook','start_workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `action_config` json NOT NULL,
  `timing` json NOT NULL,
  `condition` json DEFAULT NULL,
  `fire_guard` json DEFAULT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_template_step` (`template_id`,`step_number`),
  KEY `idx_template` (`template_id`),
  CONSTRAINT `fk_seq_steps_template` FOREIGN KEY (`template_id`) REFERENCES `sequence_templates` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=39 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: sequence_templates
-- -----------------------------------------------------
DROP TABLE IF EXISTS `sequence_templates`;
CREATE TABLE `sequence_templates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `appt_type_filter` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `appt_with_filter` tinyint DEFAULT NULL,
  `condition` json DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `test_input` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`type`),
  KEY `idx_active` (`active`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: sequences
-- -----------------------------------------------------
DROP TABLE IF EXISTS `sequences`;
CREATE TABLE `sequences` (
  `seq_id` int unsigned NOT NULL AUTO_INCREMENT,
  `seq_type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_status` enum('active','aborted','resolved','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_next_step` tinyint NOT NULL,
  `seq_link` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_client` int unsigned NOT NULL,
  `seq_case` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_start_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`seq_id`)
) ENGINE=InnoDB AUTO_INCREMENT=136 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: settings
-- -----------------------------------------------------
DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `setting_id` int unsigned NOT NULL AUTO_INCREMENT,
  `setting_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `setting_data` json NOT NULL,
  PRIMARY KEY (`setting_id`),
  UNIQUE KEY `uniq_setting_name` (`setting_name`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: tasks
-- -----------------------------------------------------
DROP TABLE IF EXISTS `tasks`;
CREATE TABLE `tasks` (
  `task_id` int unsigned NOT NULL AUTO_INCREMENT,
  `task_status` enum('Pending','Due Today','Overdue','Completed','Canceled','Deleted') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Pending',
  `task_from` tinyint unsigned NOT NULL,
  `task_to` tinyint unsigned NOT NULL,
  `task_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_start` date DEFAULT NULL,
  `task_due` date DEFAULT NULL,
  `task_link` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_link_type` enum('contact','case','appt','bill') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_link_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `task_title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_desc` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `task_notification` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'notify task assigner upon completion?',
  `task_last_update` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `task_due_job_id` bigint DEFAULT NULL,
  PRIMARY KEY (`task_id`),
  KEY `task_to` (`task_to`),
  KEY `idx_task_link_type_id` (`task_link_type`,`task_link_id`)
) ENGINE=MyISAM AUTO_INCREMENT=1040 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: temp_contacts
-- -----------------------------------------------------
DROP TABLE IF EXISTS `temp_contacts`;
CREATE TABLE `temp_contacts` (
  `tc_id` int NOT NULL AUTO_INCREMENT,
  `tc_fname` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_lname` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_phone` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `tc_email` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`tc_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2025 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: temp_seq
-- -----------------------------------------------------
DROP TABLE IF EXISTS `temp_seq`;
CREATE TABLE `temp_seq` (
  `seq_id` int unsigned NOT NULL AUTO_INCREMENT,
  `seq_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_status` enum('active','aborted','resolved','complete') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_next_step` tinyint NOT NULL,
  `seq_link` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `seq_client` int unsigned NOT NULL,
  `seq_start_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`seq_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: tempusers
-- -----------------------------------------------------
DROP TABLE IF EXISTS `tempusers`;
CREATE TABLE `tempusers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_password` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `user_auth` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: test
-- -----------------------------------------------------
DROP TABLE IF EXISTS `test`;
CREATE TABLE `test` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `age` int DEFAULT NULL,
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `json` json NOT NULL,
  `fname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `mname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `lname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: trustees
-- -----------------------------------------------------
DROP TABLE IF EXISTS `trustees`;
CREATE TABLE `trustees` (
  `trustee_id` int NOT NULL AUTO_INCREMENT,
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
  `trustee_phone` varchar(14) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`trustee_id`)
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: users
-- -----------------------------------------------------
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
  `user` tinyint NOT NULL AUTO_INCREMENT,
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
  PRIMARY KEY (`user`),
  KEY `idx_reset_token` (`reset_token`)
) ENGINE=MyISAM AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------
-- Table: workflow_execution_steps
-- -----------------------------------------------------
DROP TABLE IF EXISTS `workflow_execution_steps`;
CREATE TABLE `workflow_execution_steps` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `workflow_execution_id` bigint NOT NULL,
  `step_number` int NOT NULL,
  `step_id` int NOT NULL,
  `status` enum('success','failed','skipped','delayed') COLLATE utf8mb4_unicode_ci NOT NULL,
  `output_data` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `attempts` int DEFAULT '0',
  `duration_ms` int DEFAULT '0',
  `executed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_execution_step` (`workflow_execution_id`,`step_number`,`executed_at` DESC),
  KEY `idx_execution` (`workflow_execution_id`),
  CONSTRAINT `fk_wf_exec_steps_execution` FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=702 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: workflow_executions
-- -----------------------------------------------------
DROP TABLE IF EXISTS `workflow_executions`;
CREATE TABLE `workflow_executions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
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
  `cancel_reason` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_workflow_status` (`workflow_id`,`status`),
  KEY `idx_status` (`status`),
  KEY `idx_wf_exec_contact` (`contact_id`),
  CONSTRAINT `fk_workflow_executions_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=86 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: workflow_steps
-- -----------------------------------------------------
DROP TABLE IF EXISTS `workflow_steps`;
CREATE TABLE `workflow_steps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workflow_id` int NOT NULL,
  `step_number` int NOT NULL,
  `type` enum('webhook','internal_function','custom_code') COLLATE utf8mb4_unicode_ci NOT NULL,
  `config` json NOT NULL,
  `error_policy` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_step` (`workflow_id`,`step_number`),
  KEY `idx_workflow` (`workflow_id`),
  CONSTRAINT `fk_workflow_steps_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=77 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------
-- Table: workflows
-- -----------------------------------------------------
DROP TABLE IF EXISTS `workflows`;
CREATE TABLE `workflows` (
  `id` int NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `default_contact_id_from` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `test_input` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
