// lib/caseySqlRules.js — Casey v2 S1 (ref/CASEY_V2_DESIGN.md §4.1, §8.5).
//
// The three GENERIC rules Casey's sql_read applies on top of the report
// validator (lib/reportSchema/validator.js) and the least-privilege yc_report
// account (startup/dbReport). Copied from v1's assistantService.validateStep
// (v1 is frozen and keeps its own copy until S6 deletes it; these stay) with
// one correction: v1 reads the LIMIT and the date bounds off the raw text, so
// `-- LIMIT 5` satisfied it while MySQL saw no LIMIT (S1 review). Here they
// are judged on the text with string literals AND comments blanked:
//
//   1. DENIED NAMES — a column name Casey may not read even where the manifest
//      allows the table (contact_ssn, contact_dob, credentials, tokens, mail
//      attachments / delivery_info). Scanned as whole words over the SQL with
//      string-literal CONTENTS blanked (a search for LIKE '%password%' is not
//      refused; a bare, backticked or operator-adjacent `password` is).
//   2. A MANDATORY trailing LIMIT 1–MAX_ROWS — the model's own bound, before
//      the report service's row cap.
//   3. A LOWER DATE BOUND on the two unbounded log tables: log.log_date and
//      email_log.processed_at. An unbounded scan of either is the one query
//      that reliably hits the EXPLAIN gate after 20 s of wasted work.
//
// Pure functions, no I/O. checkSql() refuses BEFORE the report service is
// called, so a refused statement writes no report_runs row (the twin
// tests/caseySqlRead.mysql.test.js proves it).

'use strict';

const MAX_SQL = 6000;
const MAX_ROWS = 250;      // hard ceiling on the trailing LIMIT (v1: 50)
const DEFAULT_ROWS = 50;   // the cap sql_read applies when the caller names none

// v1's ASSISTANT_DENIED (services/assistantService.js), minus delivery_info (below).
const DENIED_NAMES = Object.freeze([
  'contact_ssn', 'contact_dob', 'password', 'password_hash', 'reset_token',
  'contact_token', 'appt_manage_token', 'task_action_token', 'track_token', 'draft_key',
  'attachments',
  // `delivery_info` was on v1's list and is NOT here (S3a, checkpoint finding F1,
  // 2026-11-22): email_log.delivery_info is the relay's SMTP transcript — the
  // only record of whether an outbound email was accepted — not a secret.
]);

// Blank ONLY the contents of '…' / "…" string literals, with MySQL's default
// semantics (backslash escapes on, doubled quotes, no ANSI_QUOTES). Everything
// else — backticked identifiers and comment text included — stays in the scan
// so a mis-tokenized region can only over-block. A quote inside a backticked
// name or a comment does not open a string (MySQL: `--` is a comment only when
// followed by whitespace/control or the end). Unterminated literal → the raw
// SQL is scanned whole (fail closed). (v1's blankStringLiterals, verbatim.)
function blankStringLiterals(sql) {
  const src = String(sql || '');
  let out = '';
  let i = 0;
  const copyUntil = (end) => { out += src.slice(i, end); i = end; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '`' && src[j + 1] !== '`')) j += src[j] === '`' ? 2 : 1;
      copyUntil(Math.min(src.length, j + 1));
      continue;
    }
    if (ch === '#' || (ch === '-' && src[i + 1] === '-' && (i + 2 >= src.length || /[\s\x00-\x1f]/.test(src[i + 2])))) {
      const nl = src.indexOf('\n', i);
      copyUntil(nl === -1 ? src.length : nl);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      copyUntil(close === -1 ? src.length : close + 2);
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch && src[j + 1] === ch) { j += 2; continue; }
        if (src[j] === ch) { closed = true; break; }
        j += 1;
      }
      if (!closed) return src;
      out += `${ch}${' '.repeat(j - i - 1)}${ch}`;
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** blankStringLiterals, then every comment (the `-- ` and `#` line forms and
 *  the slash-star block form) replaced by spaces of the same length — the text
 *  the LIMIT and date-bound rules read. */
function blankComments(sql) {
  const src = blankStringLiterals(sql);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '`' && src[j + 1] !== '`')) j += src[j] === '`' ? 2 : 1;
      out += src.slice(i, Math.min(src.length, j + 1)); i = Math.min(src.length, j + 1);
      continue;
    }
    if (ch === '#' || (ch === '-' && src[i + 1] === '-' && (i + 2 >= src.length || /[\s\x00-\x1f]/.test(src[i + 2])))) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i); i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      out += ' '.repeat(end - i); i = end;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** The first denied name the statement mentions outside a string literal, or null. */
function deniedName(sql) {
  const scanned = blankStringLiterals(sql).toLowerCase();
  return DENIED_NAMES.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(scanned)) || null;
}

/** The trailing `LIMIT n` of the statement as a number, or null when absent —
 *  read with comments blanked, so a LIMIT inside a comment is no LIMIT. */
function trailingLimit(sql) {
  const m = blankComments(String(sql)).match(/\bLIMIT\s+(\d+)\s*;?\s*$/i);
  return m ? Number(m[1]) : null;
}

/**
 * checkSql(sql, tables) → { ok: true, limit } | { ok: false, error }
 * `tables` is the validator's table list for this statement (validateSql(sql).tables).
 */
// email_log.body: the manifest lists email_log's ENVELOPE columns, but the
// report account's grants are built from information_schema (every column),
// so `body` — inbound mail text — is readable by the account. Casey's own
// description says mail bodies are not readable, and §8.5 of the design means
// it, so a statement that names email_log AND the word body is refused here
// (S3a review; v1's rule list never did this). Statement-level: a statement
// that reads email_log and says `body` anywhere is refused, another table's
// `body` in the same join included (fails closed); a statement without
// email_log may read any `body`. Judged on the text with string literals AND
// comments blanked, like the bounds.
function mailBody(code, tables) {
  return Array.isArray(tables) && tables.includes('email_log') && /\bbody\b/i.test(code);
}

function checkSql(sql, tables = []) {
  const text = String(sql || '').trim();
  if (!text) return { ok: false, error: 'SQL is empty' };
  if (text.length > MAX_SQL) return { ok: false, error: `SQL is longer than ${MAX_SQL} characters` };
  const denied = deniedName(text);
  if (denied) return { ok: false, error: `asks for a field Casey may not read: ${denied}` };
  const limit = trailingLimit(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    return { ok: false, error: `must end with LIMIT 1-${MAX_ROWS}` };
  }
  const t = Array.isArray(tables) ? tables : [];
  const code = blankComments(text); // a bound inside a comment is no bound
  if (t.includes('log')) {
    const hasBound = /\blog_date\s+(?:between|>=|>|=)/i.test(code)
      || /\blog_date\s*<\s*(?:date|now|current_)/i.test(code);
    if (!hasBound) return { ok: false, error: 'must put a concrete lower date bound on log.log_date' };
  }
  if (t.includes('email_log') && !/\bprocessed_at\s+(?:between|>=|>|=)/i.test(code)) {
    return { ok: false, error: 'must put a concrete lower date bound on email_log.processed_at' };
  }
  if (mailBody(blankStringLiterals(code), t)) return { ok: false, error: 'asks for a field Casey may not read: email_log.body (mail text)' };
  return { ok: true, limit };
}

module.exports = { MAX_SQL, MAX_ROWS, DEFAULT_ROWS, DENIED_NAMES, blankStringLiterals, blankComments, deniedName, trailingLimit, mailBody, checkSql };
