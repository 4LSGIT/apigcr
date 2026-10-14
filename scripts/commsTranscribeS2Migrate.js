#!/usr/bin/env node
// scripts/commsTranscribeS2Migrate.js
//
/**
 * Comms archive S2 — the transcription schema (ref/COMMS_ARCHIVE_DESIGN.md
 * §5, §6.3, §6.5), PART A of ref/migrations/2026-10-14_comms_s2_transcripts.sql
 * (that file RECORDS these statements; a test holds the two identical).
 *
 *   comms_transcripts      — one row per transcribed archive item
 *   comms_stt_jobs         — one row per vendor job ever submitted: the spend
 *                            ledger (the monthly cap) and the owed-delete list
 *   comms_no_transcribe    — numbers never transcribed (P6, R9)
 *   app_settings seeds     — mode (off), credential, gates, caps, Quo stereo,
 *                            keyterms (empty), language detection
 *   comms_media COMMENTs   — the doc-debt fold-in (scratch
 *                            docs/20261014_comms_media_comment_kinds): kind
 *                            voicemail, source_table rc_message / comms_media,
 *                            channel_id NULL for an RC voicemail with no
 *                            to-number, the stt_raw part vocabulary, and what
 *                            S2 fills (duration_s, audio_channels).
 *
 * USAGE (repo root, a machine whose .env reaches production — the setup
 * `npm run db:ref` uses; the Cloud SQL proxy starts if .env opts in):
 *
 *   node scripts/commsTranscribeS2Migrate.js           # CHECK — read-only, prints the plan
 *   node scripts/commsTranscribeS2Migrate.js --apply   # run it (BEFORE the backend deploy)
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 * Part B (the recurring job row) is plain SQL, run AFTER the backend is live.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION (CLAUDE.md, "a migration that needs
 *    a session") ────────────────────────────────────────────────────────────
 * The COMMENT change is an ALTER on a LIVE table (comms_media: every archive
 * tick writes it). Every ALTER takes an exclusive metadata lock; one queued
 * behind a long transaction stalls every query on the table for as long as it
 * waits, and the global lock_wait_timeout default is a year. So this session
 * sets lock_wait_timeout = 5 first — and /admin/db/batch would run that SET on
 * whichever pooled connection is free, never the ALTER's. A timeout here is a
 * clean NO-GO: re-run --apply.
 *
 * ── THE ALTER CHANGES COMMENTS ONLY — PROVEN THREE WAYS ───────────────────
 *   1. Before any write, every touched column's full definition (type,
 *      nullability, default, collation, extra, position) is asserted against
 *      EXPECTED_COLS; and its comment must be EXACTLY the old text or exactly
 *      the new one — anything else means someone changed it since this script
 *      was written: NO-GO.
 *   2. ALGORITHM=INSTANT: MySQL REFUSES it (ER 1846) for any MODIFY that would
 *      need a rebuild — a restated definition that differed in type or
 *      collation could not slip through as a metadata change.
 *   3. After: every column of the table (not only the touched ones) is
 *      re-read and compared — only the listed comments may differ — and the
 *      InnoDB TABLE_ID is unchanged (a rebuild allocates a new one; measured
 *      on 8.4.11). TABLE_ID needs PROCESS; without it the line says so.
 */

'use strict';

/** Fred, 2026-10-14: $75 for the backfill month, then $25/month (an SU-console UPDATE — §6.5). */
const CAP_SEED_CENTS = 7500;

const SQL = {
  lockWait: 'SET SESSION lock_wait_timeout = 5',

  createTranscripts: `CREATE TABLE IF NOT EXISTS comms_transcripts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  media_id          BIGINT UNSIGNED NOT NULL
                    COMMENT 'comms_media.id — a call_recording or voicemail. Visibility is the PARENT''s: every reader JOINs comms_media (restricted, channel_id) — Restrict hides derived text (R9); nothing is copied here',
  phone_event_id    BIGINT UNSIGNED NULL
                    COMMENT 'phone_event_log.id — denormalised for joins; NULL for an RC voicemail (source_table rc_message: no call row)',
  state             VARCHAR(16)  NOT NULL DEFAULT 'pending'
                    COMMENT 'pending | transcribing | transcribed | summarized | skipped | failed | purged — app-validated (design §5)',
  skip_reason       VARCHAR(32)  NULL
                    COMMENT 'short | no_transcribe | over_cap | policy',
  stt_vendor        VARCHAR(16)  NULL
                    COMMENT 'assemblyai',
  stt_model         VARCHAR(48)  NULL
                    COMMENT 'model + variant of the canonical transcript, e.g. universal-3-5-pro+diarize',
  stt_job_ref       VARCHAR(191) NULL
                    COMMENT 'vendor transcript id (canonical variant)',
  alt_job_ref       VARCHAR(191) NULL
                    COMMENT 'sample mode only: vendor id of the other Quo-stereo variant — stored as an stt_raw child (part assemblyai-mc or assemblyai), never in this row',
  language          VARCHAR(16)  NULL,
  speakers          TINYINT UNSIGNED NULL,
  segments          JSON NULL
                    COMMENT '[{s:speaker,a:start_s,b:end_s,t:text}] — s is A, B… (diarized) or ch1, ch2… (multichannel)',
  full_text         MEDIUMTEXT NULL,
  summary           JSON NULL
                    COMMENT 'schema in COMMS_ARCHIVE_DESIGN §6.4',
  summary_text      TEXT NULL,
  summary_model     VARCHAR(48)  NULL,
  ai_call_ids       JSON NULL
                    COMMENT 'ai_calls.id of every summary attempt — purge clears their request_excerpt/response',
  grounding_dropped SMALLINT UNSIGNED NULL,
  est_audio_s       INT UNSIGNED NULL
                    COMMENT 'audio length estimated from the archived file''s header before submit (the P6 gate and the caps); comms_media.duration_s holds the vendor''s measured length',
  stt_cost_cents    DECIMAL(10,4) NULL
                    COMMENT 'total STT spend for this row: every vendor job ever submitted for it (comms_stt_jobs — resubmits and the sample variant included), the billed cost once a job completed, its estimate otherwise. Kept in step with the ledger; never cleared — cost is not content, purge leaves it',
  llm_cost_cents    DECIMAL(10,4) NULL,
  cap_released_by   TINYINT NULL
                    COMMENT 'users.user who released an over_cap skip (SU console — design §6.5)',
  attempts          INT UNSIGNED NOT NULL DEFAULT 0
                    COMMENT 'vendor-side failures only — our-side failures (storage, signing, auth, cap) never charge it',
  next_attempt_at   DATETIME NULL
                    COMMENT 'UTC; NULL = due now. Also the per-row lease and the poll schedule',
  last_error        VARCHAR(1000) NULL,
  submitted_at      DATETIME NULL
                    COMMENT 'UTC; the current vendor job was submitted',
  transcribed_at    DATETIME NULL
                    COMMENT 'UTC; month-to-date STT cost (the monthly cap) sums on it',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_transcripts_media (media_id),
  KEY idx_comms_transcripts_event (phone_event_id),
  KEY idx_comms_transcripts_work (state, next_attempt_at),
  KEY idx_comms_transcripts_month (transcribed_at),
  FULLTEXT KEY ft_comms_transcripts (full_text, summary_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Transcript + AI summary per archived call recording / voicemail (ref/COMMS_ARCHIVE_DESIGN.md §5). Never broader than its comms_media row: readers JOIN it'`,

  createJobs: `CREATE TABLE IF NOT EXISTS comms_stt_jobs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transcript_id  BIGINT UNSIGNED NOT NULL
                 COMMENT 'comms_transcripts.id the job was submitted for',
  media_id       BIGINT UNSIGNED NOT NULL
                 COMMENT 'comms_media.id (denormalised)',
  vendor         VARCHAR(16)  NOT NULL DEFAULT 'assemblyai',
  role           VARCHAR(8)   NOT NULL
                 COMMENT 'main (the transcript row''s variant) | alt (the sample-mode variant)',
  variant        VARCHAR(16)  NOT NULL
                 COMMENT 'diarize | multichannel',
  job_ref        VARCHAR(191) NULL
                 COMMENT 'the vendor''s job id. NULL = no id came back: the vendor MAY hold a job we never got an id for (state unknown — searched for by url_sha256)',
  state          VARCHAR(16)  NOT NULL
                 COMMENT 'unknown | submitted | completed | error | lost | drift | orphan | refused — app-validated. WRITE-AHEAD: every row is inserted as unknown BEFORE its POST and resolved from the answer, so a process death mid-POST still leaves the spend and the search. drift = a 2xx we could not read; lost = the vendor 404ed it; orphan = an unknown found again in the vendor list; refused = the vendor definitely took nothing (a 4xx, 500) — est 0',
  post_status    SMALLINT     NULL
                 COMMENT 'HTTP status the POST answered; 0 = no answer (timeout / network); NULL = written ahead, no answer recorded (the process ended mid-POST)',
  url_sha256     CHAR(64)     NULL
                 COMMENT 'sha256 of the signed audio_url sent (one URL per POST, so unique per job) — never the URL (a bearer link); kept while the vendor may hold a job we cannot name',
  est_cents      DECIMAL(10,4) NOT NULL
                 COMMENT 'estimated cost at submit — counted until the billed cost is known',
  cost_cents     DECIMAL(10,4) NULL
                 COMMENT 'billed cost (vendor audio_duration × the price card) once completed',
  submitted_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 COMMENT 'UTC; the monthly cap sums every job by this',
  finished_at    DATETIME     NULL,
  deleted_at     DATETIME     NULL
                 COMMENT 'UTC; the vendor CONFIRMED the delete (2xx or 404). NULL with a job_ref and no live use = a delete still owed — retried with backoff; the vendor''s 30-day TTL is the backstop',
  delete_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  delete_after   DATETIME     NULL
                 COMMENT 'UTC; next delete (or orphan search) not before this',
  last_error     VARCHAR(500) NULL,
  UNIQUE KEY uq_comms_stt_jobs_ref (vendor, job_ref),
  KEY idx_comms_stt_jobs_transcript (transcript_id),
  KEY idx_comms_stt_jobs_month (submitted_at),
  KEY idx_comms_stt_jobs_owed (deleted_at, delete_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Every STT vendor job ever submitted (comms archive S2): the spend ledger behind the monthly cap and the per-job owed-delete list. Ids and money only — never content; purge leaves it'`,

  createNoTranscribe: `CREATE TABLE IF NOT EXISTS comms_no_transcribe (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone      CHAR(10)     NOT NULL
             COMMENT '10 digits — matched against the last 10 digits of comms_media.party',
  note       VARCHAR(255) NULL,
  created_by TINYINT NULL
             COMMENT 'users.user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_no_transcribe_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Numbers whose calls are archived but never transcribed or summarised (P6). SU / SS maintain it (R9); adding a number later does not touch existing transcripts — Restrict or Purge does'`,
};

/** app_settings seeds — never clobber an existing value. [key, value, is_editable, label, type, sort, description] */
const SETTINGS = [
  ['comms_transcribe_mode', 'off', 1, 'Comms Transcription', 'string', 50,
    'off | sample | on. off: no NEW submissions — jobs already sent are still polled, stored and deleted at the vendor. sample: only the archive items listed in comms_eval_items (the S0 evaluation), both Quo-stereo variants. on: every archived call recording and voicemail. Restricted calls are never sent. Anything else = off. Read uncached every tick.'],
  ['comms_stt_credential_id', '14', 0, 'Comms STT Credential', 'number', 51,
    'credentials.id of the AssemblyAI api_key credential the transcription sweep calls through. Missing / not a number = transcription stops (alerted).'],
  ['comms_min_transcribe_s', '15', 0, 'Comms Transcribe Minimum (s)', 'number', 52,
    'Audio shorter than this (estimated from the archived file) is skipped as short (P6). Not applied to voicemails or in sample mode.'],
  ['comms_stt_max_min_per_call', '300', 0, 'Comms STT Per-Call Cap (min)', 'number', 53,
    'Audio longer than this is skipped as over_cap; an SU releases one from the db console (design §6.5).'],
  ['comms_ai_monthly_cap_cents', String(CAP_SEED_CENTS), 0, 'Comms AI Monthly Cap (cents)', 'number', 54,
    'Month-to-date transcription (+ summary, S3) spend that stops new submissions; archiving never stops. 7500 for the backfill month, then 2500 (an SU-console UPDATE — design §6.5). Missing / not a number = 0 = nothing submitted.'],
  ['comms_stt_quo_stereo', 'diarize', 0, 'Comms STT Stereo Mode', 'string', 55,
    'diarize | multichannel — how a 2-channel recording is transcribed in mode on (sample mode runs both). diarize = one mixed channel + speaker labels (one-channel price); multichannel = one transcript per channel (billed per channel). Anything else = diarize.'],
  ['comms_stt_keyterms', '[]', 0, 'Comms STT Keyterms', 'json', 56,
    'JSON array of words / phrases (≤ 6 words each) sent as keyterms_prompt. Empty = off; non-empty adds $0.05 per audio hour.'],
  ['comms_stt_language_detection', '1', 0, 'Comms STT Language Detection', 'bool', 57,
    '1 = the vendor detects the language (some clients do not speak English). Anything else = English (en_us).'],
];

const insertSetting = `INSERT INTO app_settings (\`key\`, \`value\`, is_secret, is_editable, category, label, description, \`type\`, sort_order)
VALUES (?, ?, 0, ?, 'Automations', ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE \`key\` = \`key\``;

// ── comms_media COMMENTs ────────────────────────────────────────────────────
// The full current definition of each touched column (information_schema, as
// measured on 8.4.11 against the S1a migration) — asserted before the ALTER.
const EXPECTED_COLS = {
  kind:           { type: 'varchar(20)', nullable: 'NO', dflt: null, coll: 'utf8mb4_general_ci', extra: '', pos: 3, ddl: 'VARCHAR(20) COLLATE utf8mb4_general_ci NOT NULL' },
  source_table:   { type: 'varchar(32)', nullable: 'NO', dflt: null, coll: 'utf8mb4_general_ci', extra: '', pos: 4, ddl: 'VARCHAR(32) COLLATE utf8mb4_general_ci NOT NULL' },
  part:           { type: 'varchar(64)', nullable: 'NO', dflt: '', coll: 'utf8mb4_general_ci', extra: '', pos: 6, ddl: "VARCHAR(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''" },
  channel_id:     { type: 'int unsigned', nullable: 'YES', dflt: null, coll: null, extra: '', pos: 8, ddl: 'INT UNSIGNED NULL' },
  duration_s:     { type: 'int unsigned', nullable: 'YES', dflt: null, coll: null, extra: '', pos: 14, ddl: 'INT UNSIGNED NULL' },
  audio_channels: { type: 'tinyint unsigned', nullable: 'YES', dflt: null, coll: null, extra: '', pos: 15, ddl: 'TINYINT UNSIGNED NULL' },
  captured_at:    { type: 'datetime', nullable: 'YES', dflt: null, coll: null, extra: '', pos: 16, ddl: 'DATETIME NULL' },
};

const OLD_COMMENTS = {
  kind: 'call_recording | mms_file | stt_raw | mail_raw | mail_attachment — app-validated',
  source_table: 'phone_event_log | mail_messages | comms_media (stt_raw)',
  part: "provider recording / attachment id; '' = placeholder before the provider lists any. Discovery tests existence on (source_table, source_id, kind) REGARDLESS of part — a recovered placeholder changes its part, so the unique key alone would re-insert it",
  channel_id: 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess). NULL = the source line is not a phone_lines row (orphan)',
  duration_s: 'media duration; NULL until known (S1a does not fetch it)',
  audio_channels: '',
  captured_at: 'provider time of the call/message, UTC wall clock (pool convention). Phone calls: raw_extra.started_at, else phone_event_log.processed_at when started_at is blank (tsi: rows). The cliff clock',
};

const NEW_COMMENTS = {
  kind: 'call_recording | voicemail | mms_file | stt_raw | mail_raw | mail_attachment — app-validated',
  source_table: 'phone_event_log (calls, MMS, Quo voicemails) | rc_message (RC voicemails: source_id = the RC message id — no call row) | comms_media (stt_raw: source_id = the parent row) | mail_messages',
  part: "provider recording / attachment id; '' = placeholder before the provider lists any. Discovery tests existence on (source_table, source_id, kind) REGARDLESS of part — a recovered placeholder changes its part, so the unique key alone would re-insert it. stt_raw: the transcript's source — 'quo', the RC AudioTranscription attachment id, 'assemblyai' (diarized; S2) or 'assemblyai-mc' (multichannel; S2)",
  channel_id: 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess). NULL = the source line is not a phone_lines row (orphan), or an RC voicemail left with no to-number (who may see it: S4)',
  duration_s: "measured media length in seconds: the STT vendor's audio_duration, written by the transcribe sweep (S2); NULL until transcribed",
  audio_channels: "channel count read from the archived file's header by the transcribe sweep (S2); NULL until read",
  captured_at: "provider time of the call/message, UTC wall clock (pool convention). Phone calls: raw_extra.started_at, else phone_event_log.processed_at when started_at is blank (tsi: rows). RC voicemails: the message creationTime. stt_raw: the parent's. The cliff clock",
};

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

SQL.alterComments = 'ALTER TABLE comms_media\n' +
  Object.keys(EXPECTED_COLS).map(c => `  MODIFY ${c} ${EXPECTED_COLS[c].ddl} COMMENT ${sqlStr(NEW_COMMENTS[c])}`).join(',\n') +
  ',\n  ALGORITHM=INSTANT';

/** Expected columns of the new tables (name → [COLUMN_TYPE, IS_NULLABLE]) — the resume / drift check. */
const TRANSCRIPT_COLS = [
  ['id', 'bigint unsigned', 'NO'], ['media_id', 'bigint unsigned', 'NO'], ['phone_event_id', 'bigint unsigned', 'YES'],
  ['state', 'varchar(16)', 'NO'], ['skip_reason', 'varchar(32)', 'YES'], ['stt_vendor', 'varchar(16)', 'YES'],
  ['stt_model', 'varchar(48)', 'YES'], ['stt_job_ref', 'varchar(191)', 'YES'], ['alt_job_ref', 'varchar(191)', 'YES'],
  ['language', 'varchar(16)', 'YES'], ['speakers', 'tinyint unsigned', 'YES'], ['segments', 'json', 'YES'],
  ['full_text', 'mediumtext', 'YES'], ['summary', 'json', 'YES'], ['summary_text', 'text', 'YES'],
  ['summary_model', 'varchar(48)', 'YES'], ['ai_call_ids', 'json', 'YES'], ['grounding_dropped', 'smallint unsigned', 'YES'],
  ['est_audio_s', 'int unsigned', 'YES'], ['stt_cost_cents', 'decimal(10,4)', 'YES'], ['llm_cost_cents', 'decimal(10,4)', 'YES'],
  ['cap_released_by', 'tinyint', 'YES'], ['attempts', 'int unsigned', 'NO'], ['next_attempt_at', 'datetime', 'YES'],
  ['last_error', 'varchar(1000)', 'YES'], ['submitted_at', 'datetime', 'YES'], ['transcribed_at', 'datetime', 'YES'],
  ['created_at', 'datetime', 'NO'], ['updated_at', 'datetime', 'NO'],
];
const JOBS_COLS = [
  ['id', 'bigint unsigned', 'NO'], ['transcript_id', 'bigint unsigned', 'NO'], ['media_id', 'bigint unsigned', 'NO'],
  ['vendor', 'varchar(16)', 'NO'], ['role', 'varchar(8)', 'NO'], ['variant', 'varchar(16)', 'NO'],
  ['job_ref', 'varchar(191)', 'YES'], ['state', 'varchar(16)', 'NO'], ['post_status', 'smallint', 'YES'], ['url_sha256', 'char(64)', 'YES'],
  ['est_cents', 'decimal(10,4)', 'NO'], ['cost_cents', 'decimal(10,4)', 'YES'], ['submitted_at', 'datetime', 'NO'],
  ['finished_at', 'datetime', 'YES'], ['deleted_at', 'datetime', 'YES'], ['delete_attempts', 'smallint unsigned', 'NO'],
  ['delete_after', 'datetime', 'YES'], ['last_error', 'varchar(500)', 'YES'],
];
const NO_TRANSCRIBE_COLS = [
  ['id', 'int unsigned', 'NO'], ['phone', 'char(10)', 'NO'], ['note', 'varchar(255)', 'YES'],
  ['created_by', 'tinyint', 'YES'], ['created_at', 'datetime', 'NO'],
];

/**
 * Part A as literal SQL, in run order — what ref/migrations/2026-10-14_comms_s2_transcripts.sql
 * records between its "PART A" and "PART B" banners (a test holds them identical).
 */
function partASql() {
  const seeds = SETTINGS.map(([k, v, ed, label, type, sort, desc]) =>
    'INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)\n' +
    `VALUES (${sqlStr(k)}, ${sqlStr(v)}, 0, ${ed}, 'Automations', ${sqlStr(label)}, ${sqlStr(desc)}, ${sqlStr(type)}, ${sort})\n` +
    'ON DUPLICATE KEY UPDATE `key` = `key`;');
  return [`${SQL.lockWait};`, `${SQL.createTranscripts};`, `${SQL.createJobs};`, `${SQL.createNoTranscribe};`, ...seeds, `${SQL.alterComments};`];
}

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

async function _cols(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS pos, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS dflt, COLLATION_NAME AS coll, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
  return rows.map(r => ({ ...r, pos: Number(r.pos) }));
}

async function _tableId(conn) {
  try {
    const [[r]] = await conn.query(
      `SELECT TABLE_ID AS id FROM information_schema.INNODB_TABLES WHERE NAME = CONCAT(DATABASE(), '/comms_media')`);
    return r ? String(r.id) : null;
  } catch (_) {
    return null;   // needs PROCESS
  }
}

async function readState(conn) {
  const media = await _cols(conn, 'comms_media');
  const transcripts = await _cols(conn, 'comms_transcripts');
  const jobs = await _cols(conn, 'comms_stt_jobs');
  const noTranscribe = await _cols(conn, 'comms_no_transcribe');
  const [srows] = await conn.query('SELECT `key`, `value` FROM app_settings WHERE `key` IN (?)', [SETTINGS.map(s => s[0])]);
  const settings = Object.fromEntries(srows.map(r => [r.key, r.value]));
  return { media, transcripts, jobs, noTranscribe, settings, tableId: await _tableId(conn) };
}

function _colsMatch(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every(([n, t, nl], i) => actual[i] && actual[i].name === n && actual[i].type === t && actual[i].nullable === nl);
}

/** → { problems[], todo: {transcripts, noTranscribe, settings[], comments[]} } */
function plan(s) {
  const problems = [];
  const todo = { transcripts: false, jobs: false, noTranscribe: false, settings: [], comments: [] };

  if (!s.media.length) problems.push('comms_media does not exist — S1a has not been applied here');
  else {
    const by = Object.fromEntries(s.media.map(c => [c.name, c]));
    for (const [name, e] of Object.entries(EXPECTED_COLS)) {
      const c = by[name];
      if (!c) { problems.push(`comms_media.${name} is missing`); continue; }
      const diff = [];
      if (c.type !== e.type) diff.push(`type ${c.type}`);
      if (c.nullable !== e.nullable) diff.push(`nullable ${c.nullable}`);
      if ((c.dflt ?? null) !== e.dflt) diff.push(`default ${JSON.stringify(c.dflt)}`);
      if ((c.coll ?? null) !== e.coll) diff.push(`collation ${c.coll}`);
      if ((c.extra || '') !== e.extra) diff.push(`extra ${c.extra}`);
      if (c.pos !== e.pos) diff.push(`position ${c.pos}`);
      if (diff.length) { problems.push(`comms_media.${name} definition differs from the expected (${diff.join(', ')}) — the MODIFY would change it; NOT touching it`); continue; }
      const cm = c.comment || '';
      if (cm === NEW_COMMENTS[name]) continue;
      if (cm === OLD_COMMENTS[name]) todo.comments.push(name);
      else problems.push(`comms_media.${name} comment is neither the S1 text nor the S2 text — changed since this script was written`);
    }
  }

  if (!s.transcripts.length) todo.transcripts = true;
  else if (!_colsMatch(s.transcripts, TRANSCRIPT_COLS)) problems.push('comms_transcripts exists with different columns — not this migration\'s table');
  if (!s.jobs.length) todo.jobs = true;
  else if (!_colsMatch(s.jobs, JOBS_COLS)) problems.push('comms_stt_jobs exists with different columns — not this migration\'s table');
  if (!s.noTranscribe.length) todo.noTranscribe = true;
  else if (!_colsMatch(s.noTranscribe, NO_TRANSCRIBE_COLS)) problems.push('comms_no_transcribe exists with different columns — not this migration\'s table');

  for (const row of SETTINGS) if (!(row[0] in s.settings)) todo.settings.push(row[0]);
  return { problems, todo };
}

function _describe(todo) {
  const out = [];
  if (todo.transcripts) out.push('CREATE TABLE comms_transcripts');
  if (todo.jobs) out.push('CREATE TABLE comms_stt_jobs');
  if (todo.noTranscribe) out.push('CREATE TABLE comms_no_transcribe');
  if (todo.settings.length) out.push(`app_settings: seed ${todo.settings.join(', ')}`);
  if (todo.comments.length) out.push(`comms_media COMMENT (ALGORITHM=INSTANT): ${todo.comments.join(', ')}`);
  return out;
}

/** Compare every comms_media column before/after: only the listed comments may differ. */
function _onlyCommentsChanged(before, after, allowed) {
  const bad = [];
  if (before.length !== after.length) bad.push(`column count ${before.length} → ${after.length}`);
  const ab = Object.fromEntries(after.map(c => [c.name, c]));
  for (const b of before) {
    const a = ab[b.name];
    if (!a) { bad.push(`${b.name} vanished`); continue; }
    for (const k of ['pos', 'type', 'nullable', 'dflt', 'coll', 'extra']) {
      if ((a[k] ?? null) !== (b[k] ?? null)) bad.push(`${b.name}.${k} ${JSON.stringify(b[k])} → ${JSON.stringify(a[k])}`);
    }
    if ((a.comment || '') !== (b.comment || '') && !allowed.includes(b.name)) bad.push(`${b.name} comment changed (not in this migration)`);
  }
  return bad;
}

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────

async function run(conn, { apply = false, say = console.log } = {}) {
  const s = await readState(conn);
  const p = plan(s);
  say(`comms archive S2 migration — ${apply ? 'APPLY' : 'CHECK (read-only)'}`);
  for (const pr of p.problems) say(`  ✗ ${pr}`);
  const steps = _describe(p.todo);
  for (const st of steps) say(`  · to do: ${st}`);

  if (p.problems.length) {
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, plan: p };
  }
  if (!steps.length) {
    const line = 'ALREADY APPLIED — GO. Next: deploy the backend (git go), then run Part B of ref/migrations/2026-10-14_comms_s2_transcripts.sql.';
    say(`\n${line}`);
    return { ok: true, line, plan: p };
  }
  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/commsTranscribeS2Migrate.js --apply';
    say(`\n${line}`);
    return { ok: true, line, plan: p };
  }

  const done = [];
  try {
    await conn.query(SQL.lockWait);
    if (p.todo.transcripts) { await conn.query(SQL.createTranscripts); done.push('comms_transcripts'); say('  ✓ comms_transcripts created'); }
    if (p.todo.jobs) { await conn.query(SQL.createJobs); done.push('comms_stt_jobs'); say('  ✓ comms_stt_jobs created'); }
    if (p.todo.noTranscribe) { await conn.query(SQL.createNoTranscribe); done.push('comms_no_transcribe'); say('  ✓ comms_no_transcribe created'); }
    for (const row of SETTINGS.filter(r => p.todo.settings.includes(r[0]))) {
      const [key, value, editable, label, type, sort, desc] = row;
      await conn.query(insertSetting, [key, value, editable, label, desc, type, sort]);
      done.push(`setting ${key}`);
    }
    if (p.todo.settings.length) say(`  ✓ seeded ${p.todo.settings.length} setting(s)`);
    if (p.todo.comments.length) {
      await conn.query(SQL.alterComments);
      done.push('comms_media comments');
      await say('  ✓ comms_media comments (INSTANT)');   // awaited: a test hook can act between the ALTER and the verify
    }
  } catch (err) {
    const line = `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'} (${err.code || ''} ${err.message}). ` +
      'Re-running --apply resumes from the live state. Do NOT deploy until it says GO.';
    say(`\n${line}`);
    return { ok: false, line, done };
  }

  // Verify the end state.
  const after = await readState(conn);
  const p2 = plan(after);
  const bad = [...p2.problems, ..._describe(p2.todo).map(x => `still to do: ${x}`)];
  bad.push(..._onlyCommentsChanged(s.media, after.media, Object.keys(EXPECTED_COLS)));
  for (const [k, v] of Object.entries(after.settings)) {
    const seed = SETTINGS.find(r => r[0] === k);
    if (p.todo.settings.includes(k) && seed && v !== seed[1]) bad.push(`setting ${k} = ${JSON.stringify(v)}, expected the seed`);
  }
  if (s.tableId && after.tableId && s.tableId !== after.tableId) bad.push(`comms_media was REBUILT (TABLE_ID ${s.tableId} → ${after.tableId})`);
  if (bad.length) {
    for (const b of bad) say(`  ✗ ${b}`);
    const line = `NO-GO — the end state is wrong (${bad.length} problem(s) above). Paste this output. Do NOT deploy.`;
    say(`\n${line}`);
    return { ok: false, line, done };
  }
  say(`  ✓ verified: tables, settings, comments; every other comms_media column unchanged; ` +
    (s.tableId && after.tableId ? `no rebuild (TABLE_ID ${after.tableId})` : 'TABLE_ID not readable (needs PROCESS) — rebuild check skipped; INSTANT would have refused one'));
  const line = 'S2 PART A APPLIED — GO. Next: deploy the backend (git go), then run Part B of ref/migrations/2026-10-14_comms_s2_transcripts.sql. Delete scratch docs/20261014_comms_media_comment_kinds.';
  say(`\n${line}`);
  return { ok: true, line, done };
}

module.exports = {
  SQL, SETTINGS, insertSetting, EXPECTED_COLS, OLD_COMMENTS, NEW_COMMENTS, TRANSCRIPT_COLS, JOBS_COLS, NO_TRANSCRIBE_COLS,
  CAP_SEED_CENTS, readState, plan, run, partASql,
};

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
