// services/phoneConsentService.js
//
/**
 * SMS consent from the phone side — YisraMail P2 (ref/YISRAMAIL_DESIGN.md
 * §4.6; rulings D3, D14, D15, D19). Every write goes through
 * optoutService.recordConsent (the ONE writer); this module only decides WHAT
 * to record, from three signals, and what staff must hear about it:
 *
 *   1. INBOUND KEYWORDS (handleInbound) — called by
 *      phoneIngestService.ingestPhoneEvent for every incoming SMS, after the
 *      dedup precheck (1b) and the catch-all write, before Layer 2. Inbound
 *      texts reach YC only through hooks 21/16 → workflows 17/18 → phone_log;
 *      the delivery sync lists OUTBOUND texts only, so this is the one path.
 *        opt-out  STOP · STOPALL · STOP ALL · UNSUBSCRIBE · CANCEL · END ·
 *                 QUIT · REVOKE · OPT OUT · OPTOUT          → scope 'all' (D3)
 *        opt-in   START · UNSTOP (both providers); SUBSCRIBE · RESUME ·
 *                 CONTINUE on RingCentral only — recorded ONLY while the
 *                 number is opted out (else it is an ordinary reply)
 *        review   a plain-language revocation (REVIEW_PHRASES, word-bounded)
 *                 or an opt-out word with only courtesy words around it
 *                 ("stop please") → one staff review task (D14: no exclusive
 *                 revocation method — plain language is honoured by a person)
 *      Exact single-message match on the normalized body; review only for a
 *      10-digit sender that is not a firm line.
 *   2. PROVIDER OPT-OUT VERDICTS (recordProviderOptOut) — a RingCentral
 *      SMS-*-413 delivery failure (phoneDeliveryService) and the read-only
 *      RingCentral consent reconcile (syncRcConsents, behind
 *      sms_rc_consent_sync_enabled). Never a push to RingCentral (D15).
 *   3. INBOUND LIVENESS (inboundLivenessCheck) — per provider with an active
 *      line, an alert when no inbound SMS has been ingested for
 *      sms_inbound_liveness_hours: the hook going quiet is the one failure
 *      the keyword handler cannot see.
 *
 * LEDGER KEYS (comm_consent_events UNIQUE (source, provider_event_id)):
 *   sms_keyword       '<provider>:<provider_message_id>'
 *   provider_optout   '<provider>:<provider_ref>' (a 413 verdict) or
 *                     '<provider>:consent:<from>:<to>:<lastModified>' (reconcile)
 * occurred_at is the PROVIDER's time, never ingest time: the state guard
 * orders by it, so a late redelivery or an old reconcile row never beats a
 * newer START.
 *
 * LOCKS. Each consent write is one pure-DB transaction (retries:1, plus one
 * retry on ER_LOCK_DEADLOCK — the whole span rolled back, nothing external in
 * it). It follows optoutService's lock order as a DIRECT caller: the
 * destination's ACTIVE contact_phones row first, through phone_active_uniq
 * (the statement recordConsent itself would run), then the state — and the
 * held row is handed to recordConsent as rowId, so nothing is locked twice.
 *
 * STAFF TASKS are post-commit side effects (never inside the transaction;
 * a failure is logged, never thrown):
 *   - stranded client: an SMS 'all' opt-out that MOVES the number from not
 *     opted out to opted out, on a contact with a Primary/Secondary link to a
 *     case in an open stage → "reach them by phone/email". A re-sighting of
 *     the same opt-out (keyword + 413 + reconcile) opens nothing.
 *   - review: one open task per number (tasks.task_dedupe_key).
 *   Both go to consent_task_user_id; unset → no task, one warning alert a day.
 *
 * QUO CONFIRMATION. RingCentral and Quo send their own confirmation for the
 * words they act on; YC never sends a second. REVOKE / OPT OUT / OPTOUT on a
 * Quo line are words Quo ignores, so YC schedules ONE confirmation text
 * (scheduled_jobs data.type 'consent_sms_confirm', lib/job_executor) — never a
 * send inside the ingest.
 */
'use strict';

const optout = require('./optoutService');
const { withTransaction } = require('../lib/withTransaction');

// ─── Settings (lib/settingsRegistry.js) ──────────────────────────────────────
const RC_SYNC_ENABLED_KEY = 'sms_rc_consent_sync_enabled';
const LIVENESS_HOURS_KEY = 'sms_inbound_liveness_hours';
const CONFIRM_TEXT_KEY = 'sms_optout_confirmation_text';
const ASSIGNEE_KEY = 'consent_task_user_id';   // owned by P3 (email unsubscribe); shared

const DEFAULT_LIVENESS_HOURS = 72;              // spans a weekend; Quo averages ~5 inbound/day
const LIVENESS_REPEAT_WINDOW_HOURS = 36;        // a nightly run's previous alert counts as "repeat"
const LOCK_EXPR = "CONCAT('sms_consent_sync:', DATABASE())";
const RC_MAX_PAGES = 20;                        // × 1000 records per page
const RC_PER_PAGE = 1000;

// ─── Vocabulary ─────────────────────────────────────────────────────────────
/** Normalized opt-out keywords — the WHOLE normalized body must equal one. */
const OPT_OUT_WORDS = Object.freeze(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'opt out', 'optout']);
/** Opt-in keywords both providers act on. */
const OPT_IN_WORDS = Object.freeze(['start', 'unstop']);
/** Opt-in keywords RingCentral acts on and Quo does not. On Quo: review (Quo keeps blocking until START). */
const OPT_IN_RC_ONLY_WORDS = Object.freeze(['subscribe', 'resume', 'continue']);
/** Opt-out words Quo does not act on (Appendix C §A): YC sends the one confirmation. */
const QUO_CONFIRM_WORDS = Object.freeze(['revoke', 'opt out', 'optout']);
/**
 * Plain-language revocations → a staff review task. Word-bounded on the
 * normalized body (apostrophes vanish: "don't" → "dont"). Live 2026-10-29:
 * 166 inbound texts contain "stop" as a substring — "stop by", "the stop
 * sign" must never match.
 */
const REVIEW_PHRASES = Object.freeze([
  'stop texting', 'stop messaging', 'stop sending', "don't text", 'do not text', 'no more texts',
  'remove me', 'take me off', 'unsubscribe me', 'wrong number', 'leave me alone',
]);
/**
 * "STOP PLEASE" is the documented Quo miss (Appendix C §A): an opt-out word
 * with nothing but courtesy words around it is a review, not a keyword.
 * CANCEL and END are left out — "cancel it" is about an appointment.
 */
const COURTESY_KEYWORDS = Object.freeze(['stop', 'stopall', 'unsubscribe', 'quit', 'revoke', 'optout']);
const COURTESY_WORDS = Object.freeze(['please', 'pls', 'plz', 'now', 'it', 'all', 'thanks', 'thank', 'you', 'thx', 'ok', 'okay']);

/**
 * Trim, case-fold, drop apostrophes, turn every run of anything that is not a
 * letter or digit (punctuation, emoji, whitespace) into one space. Linear —
 * one character class, no nesting.
 */
function normalizeBody(body) {
  if (body == null) return '';
  return String(body).normalize('NFKC').toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const OUT_SET = new Set(OPT_OUT_WORDS);
const IN_SET = new Set(OPT_IN_WORDS);
const IN_RC_SET = new Set(OPT_IN_RC_ONLY_WORDS);
const QUO_CONFIRM_SET = new Set(QUO_CONFIRM_WORDS);
const PHRASES_NORM = Object.freeze(REVIEW_PHRASES.map(normalizeBody));
const COURTESY_KW_SET = new Set(COURTESY_KEYWORDS);
const COURTESY_SET = new Set(COURTESY_WORDS);

function hasPhrase(norm) {
  const padded = ` ${norm} `;
  return PHRASES_NORM.find((p) => padded.includes(` ${p} `)) || null;
}

function courtesyOptOut(norm) {
  const words = norm.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  // "opt out please" → join the two-word keyword first.
  const joined = norm.replace(/\bopt out\b/g, 'optout').split(' ');
  const kws = joined.filter((w) => COURTESY_KW_SET.has(w));
  return kws.length === 1 && joined.every((w) => COURTESY_KW_SET.has(w) || COURTESY_SET.has(w));
}

/**
 * The body → { kind, keyword, reason }:
 *   kind     'opt_out' | 'opt_in' | 'review' | null
 *   keyword  the normalized body (keywords) or the matched phrase (review)
 *   reason   'keyword' | 'quo_optin_word' | 'phrase' | 'courtesy' | null
 * Pure. The firm-line / 10-digit gates live in handleInbound.
 */
function classifyDetail(body, provider) {
  const norm = normalizeBody(body);
  if (!norm) return { kind: null, keyword: null, reason: null, normalized: norm };
  if (OUT_SET.has(norm)) return { kind: 'opt_out', keyword: norm, reason: 'keyword', normalized: norm };
  if (IN_SET.has(norm)) return { kind: 'opt_in', keyword: norm, reason: 'keyword', normalized: norm };
  if (IN_RC_SET.has(norm)) {
    return provider === 'ringcentral'
      ? { kind: 'opt_in', keyword: norm, reason: 'keyword', normalized: norm }
      : { kind: 'review', keyword: norm, reason: 'quo_optin_word', normalized: norm };
  }
  const phrase = hasPhrase(norm);
  if (phrase) return { kind: 'review', keyword: phrase, reason: 'phrase', normalized: norm };
  if (courtesyOptOut(norm)) return { kind: 'review', keyword: norm, reason: 'courtesy', normalized: norm };
  return { kind: null, keyword: null, reason: null, normalized: norm };
}

/** classifyDetail(...).kind */
function classify(body, provider) { return classifyDetail(body, provider).kind; }

// ─── Small helpers ──────────────────────────────────────────────────────────
function norm10(v) {
  if (v == null) return '';
  const d = String(v).replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
function ten(v) { const n = norm10(v); return /^\d{10}$/.test(n) ? n : null; }
function fmtPhone(n) { return /^\d{10}$/.test(n) ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(n || ''); }
function clip(s, max) { const t = String(s == null ? '' : s); return t.length <= max ? t : `${t.slice(0, max - 1)}…`; }
function utcDate() { return new Date().toISOString().slice(0, 10); }

/** A provider timestamp → Date, or null (recordConsent then uses now). */
function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function alertLater(db, o) {
  try {
    const { alert } = require('../lib/alerting');   // lazy require (convention)
    Promise.resolve(alert(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) { /* alerting itself unavailable — the log line is the record */ }
}

// ─── The transaction ────────────────────────────────────────────────────────
// The destination's ACTIVE row, locked through the active-only unique key —
// the statement optoutService.recordConsent runs for a direct caller, with the
// two columns this module needs (attribution + the cache flag).
const ACTIVE_ROW_LOCK_SQL = 'SELECT id, contact_id, sms_optout FROM contact_phones WHERE phone_active_uniq = ? FOR UPDATE';

/** withTransaction(retries:1) + one retry on a deadlock (pure DB: the victim's span rolled back whole). */
async function consentTx(db, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, fn, { retries: 1 });
    } catch (err) {
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt === 0) continue;
      throw err;
    }
  }
}

/**
 * One SMS scope-'all' consent write.
 *   action  'opt_out' | 'opt_in'. An opt_in is written only while the number
 *           is CURRENTLY opted out (state, or the active row's cache flag where
 *           no state exists — the reader's own dual-read), read with a LOCKING
 *           read after the row lock.
 * → { recorded, duplicate, applied, state, was_opted_out, contact_id, row_id, skipped? }
 */
async function recordSmsConsent(db, {
  action, destination, source, providerEventId = null, occurredAt = null,
  lineNumber = null, contactId = null, evidence = null,
}) {
  return consentTx(db, async (conn) => {
    const [[row]] = await conn.query(ACTIVE_ROW_LOCK_SQL, [destination]);
    const rowFlag = !!(row && Number(row.sms_optout) === 1);
    let wasOut;
    if (action === 'opt_in') {
      const st = await optout.stateFlag(conn, 'sms', destination);   // FOR SHARE, after the row
      wasOut = st.exists ? st.flag === 1 : rowFlag;
      if (!wasOut) {
        return { recorded: false, duplicate: false, applied: false, state: null, was_opted_out: false,
          contact_id: row ? Number(row.contact_id) : null, row_id: row ? Number(row.id) : null, skipped: 'not_opted_out' };
      }
    } else {
      // Only decides whether staff hear about a NEW opt-out. Under the row
      // lock every other writer for this number waits, so a plain read is
      // current; a number no row holds has no contact to task anyway.
      const [[s]] = await conn.query(optout.WRITE_SQL.read, ['sms', destination, 'all']);
      wasOut = s ? s.state === 'opted_out' : rowFlag;
    }
    const cid = contactId != null ? contactId : (row ? row.contact_id : null);
    const res = await optout.recordConsent(conn, {
      channel: 'sms', destination, scope: 'all', action, source, providerEventId, occurredAt,
      contactId: cid, lineNumber, evidence, rowId: row ? row.id : null,
    });
    return {
      recorded: !res.duplicate, duplicate: !!res.duplicate, applied: !!res.applied, state: res.state,
      was_opted_out: wasOut, contact_id: cid != null ? Number(cid) : null, row_id: row ? Number(row.id) : null,
    };
  });
}

// ─── Staff tasks ────────────────────────────────────────────────────────────
// The client predicate: the portal's (case_relate_type IN ('Primary','Secondary'),
// CLAUDE.md) on a case whose lifecycle stage is open — the set commsSummarizeSweep
// uses (cases.case_stage; case_status is free text).
const OPEN_CLIENT_CASE_SQL =
  `SELECT k.case_id FROM case_relate cr JOIN cases k ON k.case_id = cr.case_relate_case_id
    WHERE cr.case_relate_client_id = ? AND cr.case_relate_type IN ('Primary','Secondary')
      AND k.case_stage IN ('Open','Pending','Filed')
    ORDER BY k.case_id LIMIT 1`;
const OPEN_TASK_STATUSES = Object.freeze(['Pending', 'Due Today', 'Overdue']);

/**
 * consent_task_user_id → a user id, or null. ONE rule for every consent task,
 * P3's: unsubService.resolveAssignee (the key must name an ACTIVE user).
 * No usable assignee → the same daily warning P3 raises (one shared dedup
 * key, so a day of opt-outs and unsubscribe notes pages once), never a
 * silent drop.
 */
async function taskAssignee(db, what) {
  const { resolveAssignee } = require('./unsubService');   // lazy require (convention)
  const id = await resolveAssignee(db);
  if (id) return id;
  alertLater(db, {
    source: 'consent', kind: 'consent_task_unassigned', group_key: 'consent_task_unassigned', severity: 'warning',
    title: `${ASSIGNEE_KEY} unset — consent tasks are not being created`,
    message: `A ${what} task was not created: app_setting ${ASSIGNEE_KEY} is unset or not an active user ` +
      '(Config → Firm → Marketing email & consent). The consent change itself is recorded in comm_consent_events.',
    dedup_key: `consent_task_unassigned:${utcDate()}`,
  });
  return null;
}

async function contactName(db, contactId) {
  const [[c]] = await db.query('SELECT contact_name FROM contacts WHERE contact_id = ?', [contactId]);
  return c && c.contact_name ? String(c.contact_name) : `contact #${contactId}`;
}

/**
 * The stranded-client task. Only for a TRANSITION into opted out (was not,
 * is now) on a contact with an open Primary/Secondary case. → task_id | null
 */
async function strandedTask(db, { result, destination, lineNumber, how }) {
  if (!result || !result.recorded || result.state !== 'opted_out' || result.was_opted_out) return null;
  if (result.contact_id == null) return null;
  const [[open]] = await db.query(OPEN_CLIENT_CASE_SQL, [result.contact_id]);
  if (!open) return null;
  const to = await taskAssignee(db, 'stranded-client');
  if (!to) return null;
  const name = await contactName(db, result.contact_id);
  const { createTask } = require('./taskService');   // lazy require (convention)
  const desc = clip(
    `${name} — ${fmtPhone(destination)} opted out of ALL texts from the firm (${how}` +
    `${lineNumber ? `, on line ${fmtPhone(lineNumber)}` : ''}). Automated texts to this number now stop, ` +
    'and the phone provider blocks texts too. Reach them by phone or email instead. ' +
    'Texts resume only when they text START to a firm line, or when, after they agree on a call or by email, ' +
    'you untick "SMS opted out" on this number on the contact.', 1000);
  const t = await createTask(db, {
    from: 0, to, title: 'Client opted out of texts — reach by phone/email', desc,
    source: 'consent', link_type: 'contact', link_id: result.contact_id,
    log_extra: { destination, line: lineNumber || null, how, case_id: open.case_id },
  });
  return t && t.task_id != null ? t.task_id : null;
}

/** The firm's business-day calendar (Shabbos/Yom Tov aware) — 3rd business day, firm-local date. Calendar +3 on failure. */
async function reviewDueDate(now = new Date()) {
  const { DateTime } = require('luxon');
  const tz = process.env.FIRM_TIMEZONE || 'America/Detroit';
  try {
    const calendar = require('./calendarService');   // lazy require (convention)
    let cur = now;
    for (let i = 0; i < 3; i++) cur = await calendar.nextBusinessDay(cur, { timeOfDay: '09:00', minDaysAhead: 1 });
    return DateTime.fromJSDate(cur, { zone: tz }).toISODate();
  } catch (err) {
    console.warn(`[phone_consent] business-day calendar failed (${err.message}) — review due in 3 calendar days`);
    return DateTime.fromJSDate(now, { zone: tz }).plus({ days: 3 }).toISODate();
  }
}

/**
 * The plain-language review task — at most one OPEN per number
 * (tasks.task_dedupe_key 'consent_review:<number>', the create_task FIL-3
 * pattern). → { task_id, deduped }
 */
async function reviewTask(db, { destination, lineNumber, body, provider, providerRef, detail, contactId }) {
  const dkey = `consent_review:${destination}`;
  const [open] = await db.query(
    'SELECT task_id FROM tasks WHERE task_dedupe_key = ? AND task_status IN (?) ORDER BY task_id DESC LIMIT 1',
    [dkey, OPEN_TASK_STATUSES]);
  if (open && open[0]) {
    await db.query('UPDATE tasks SET task_last_update = NOW() WHERE task_id = ?', [open[0].task_id]);
    return { task_id: open[0].task_id, deduped: true };
  }
  const to = await taskAssignee(db, 'text opt-out review');
  if (!to) return { task_id: null, deduped: false };
  const optInWord = detail.reason === 'quo_optin_word';
  const who = contactId != null ? `${await contactName(db, contactId)} — ` : '';
  const desc = clip(optInWord
    ? `${who}${fmtPhone(destination)} texted "${clip(body, 300)}" to ${provider} line ${fmtPhone(lineNumber)}. ` +
      'They may want texts again, but that line\'s provider keeps blocking them until they text START. ' +
      'If they want texts, ask them to reply START.'
    : `${who}${fmtPhone(destination)} texted ${provider} line ${fmtPhone(lineNumber)}: "${clip(body, 500)}". ` +
      'This may be a request to stop texting them (the law honours any reasonable wording; act within 10 business days). ' +
      'If it is an opt-out: open the contact, tick "SMS opted out" on this number, save.', 1000);
  const { createTask } = require('./taskService');   // lazy require (convention)
  const t = await createTask(db, {
    from: 0, to,
    title: optInWord ? 'Possible text opt-in — review' : 'Possible text opt-out — review',
    desc, due: await reviewDueDate(), source: 'consent_review',
    link_type: contactId != null ? 'contact' : null, link_id: contactId != null ? contactId : null,
    log_extra: { destination, line: lineNumber || null, provider, provider_ref: providerRef || null, matched: detail.keyword },
  });
  // Stamped after creation (createTask does not know the column) — the
  // create_task FIL-3 / trustee pattern; a crash between the two costs at most
  // one duplicate review later, never a lost one.
  await db.query('UPDATE tasks SET task_dedupe_key = ? WHERE task_id = ?', [dkey, t.task_id]);
  return { task_id: t.task_id, deduped: false };
}

/** The active row's contact (no lock) — attribution for a review task. */
async function activeContactId(db, destination) {
  const [[r]] = await db.query('SELECT contact_id FROM contact_phones WHERE phone_active_uniq = ? LIMIT 1', [destination]);
  return r && r.contact_id != null ? Number(r.contact_id) : null;
}

// ─── Quo confirmation job ───────────────────────────────────────────────────
const CONFIRM_JOB_TYPE = 'consent_sms_confirm';

/**
 * ONE scheduled_jobs row per provider message (idempotency_key — any existing
 * row, whatever its status, means it was scheduled: one attempt, never a
 * resend). Due now; rung through the Cloud Tasks doorbell (never rejects).
 * → job id | null
 */
async function scheduleQuoConfirmation(db, { line, to, providerMessageId }) {
  const key = `consent_confirm:quo:${providerMessageId}`;
  if (key.length > 100) throw new Error('scheduleQuoConfirmation: idempotency key exceeds 100 characters');
  const [existing] = await db.query('SELECT id FROM scheduled_jobs WHERE idempotency_key = ? LIMIT 1', [key]);
  if (existing && existing[0]) return null;
  const [ins] = await db.query(
    `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds, idempotency_key)
     VALUES ('one_time', NOW(), 'pending', ?, ?, 1, 0, ?)`,
    [`SMS opt-out confirmation to ${fmtPhone(to)} (Quo)`,
      JSON.stringify({ type: CONFIRM_JOB_TYPE, line, to, provider_message_id: providerMessageId }), key]);
  const jobId = ins && ins.insertId ? ins.insertId : null;
  if (jobId) {
    const { enqueueJobDispatch } = require('../lib/taskQueue');   // lazy require (convention)
    await enqueueJobDispatch(jobId, Date.now());
  }
  return jobId;
}

/** The confirmation's words: the setting verbatim, else the default naming the firm. */
async function confirmationText(db) {
  const { getSettings } = require('./settingsService');   // lazy require (convention)
  const s = await getSettings(db, [CONFIRM_TEXT_KEY, 'firm_name']);
  const custom = s[CONFIRM_TEXT_KEY] != null ? String(s[CONFIRM_TEXT_KEY]).trim() : '';
  if (custom) return custom;
  const firm = s.firm_name != null && String(s.firm_name).trim() ? String(s.firm_name).trim() : 'this firm';
  return `You've been unsubscribed from texts from ${firm}. Reply START to resume.`;
}

// ─── 1. Inbound keywords ────────────────────────────────────────────────────
/**
 * One incoming SMS. Never called for outgoing texts or calls.
 *   { provider, providerRef, line, from10, body, ts, contactId?, firmToFirm }
 * → { kind, recorded, state?, task_id?, job_id?, reason? }
 * Throws only on a consent-write failure (the caller alerts and carries on).
 */
async function handleInbound(db, { provider, providerRef, line, from10, body, ts, contactId = null, firmToFirm = false } = {}) {
  const detail = classifyDetail(body, provider);
  if (!detail.kind) return { kind: null, recorded: false };
  const destination = optout.normalizeDestination('sms', from10 == null ? '' : String(from10));
  if (!destination) return { kind: detail.kind, recorded: false, reason: 'sender_not_10_digit' };
  const lineNumber = ten(line);
  const occurredAt = toDate(ts);

  if (detail.kind === 'review') {
    if (firmToFirm !== false) return { kind: 'review', recorded: false, reason: 'firm_line' };
    const hits = await optout.findOptedOut(db, 'sms', destination);
    // Only a number YC holds opted out can be asking to come back; a number
    // already opted out has nothing left to stop.
    if (detail.reason === 'quo_optin_word' && !hits.length) return { kind: null, recorded: false };
    if (detail.reason !== 'quo_optin_word' && hits.length) return { kind: 'review', recorded: false, reason: 'already_opted_out' };
    const cid = contactId != null ? contactId : await activeContactId(db, destination);
    let task = { task_id: null };
    try {
      task = await reviewTask(db, { destination, lineNumber, body, provider, providerRef, detail, contactId: cid });
    } catch (err) {
      console.error(`[phone_consent] review task failed for ${destination}: ${err.message}`);
    }
    return { kind: 'review', recorded: false, task_id: task.task_id };
  }

  const providerEventId = provider && providerRef ? clip(`${provider}:${providerRef}`, 128) : null;
  const evidence = { keyword: detail.keyword, body: clip(body, 500), provider: provider || null, provider_ref: providerRef || null };
  const result = await recordSmsConsent(db, {
    action: detail.kind, destination, source: 'sms_keyword', providerEventId, occurredAt,
    lineNumber, contactId, evidence,
  });
  const out = { kind: detail.kind, recorded: result.recorded, state: result.state };
  if (result.skipped) out.reason = result.skipped;

  // Post-commit side effects — never thrown.
  if (detail.kind === 'opt_out' && result.recorded) {
    try {
      out.task_id = await strandedTask(db, { result, destination, lineNumber, how: `texted "${detail.keyword.toUpperCase()}"` });
    } catch (err) {
      console.error(`[phone_consent] stranded-client task failed for ${destination}: ${err.message}`);
    }
    // One confirmation per opt-out: only when THIS message moved the number
    // into opted out. Already out (an earlier STOP — Quo then blocks our send
    // anyway — or an RC opt-out) or a REVOKE older than a newer START → none.
    if (provider === 'quo' && QUO_CONFIRM_SET.has(detail.keyword) && result.recorded && result.state === 'opted_out'
        && !result.was_opted_out && providerRef && lineNumber) {
      try {
        out.job_id = await scheduleQuoConfirmation(db, { line: lineNumber, to: destination, providerMessageId: providerRef });
      } catch (err) {
        console.error(`[phone_consent] Quo confirmation not scheduled for ${destination}: ${err.message}`);
        alertLater(db, {
          kind: 'consent_confirm_unscheduled', group_key: 'phone_consent_confirm', severity: 'error',
          title: 'SMS opt-out confirmation could not be scheduled',
          message: `${fmtPhone(destination)} texted ${detail.keyword.toUpperCase()} on Quo line ${fmtPhone(lineNumber)}; the opt-out is recorded but the one confirmation text was not scheduled: ${err.message}`,
          dedup_key: `phone_consent_confirm:${providerRef}`,
        });
      }
    }
  }
  return out;
}

// ─── 2. Provider opt-out verdicts ───────────────────────────────────────────
const LEDGER_HAS_SQL = 'SELECT id FROM comm_consent_events WHERE source = ? AND provider_event_id = ? LIMIT 1';

/**
 * A provider says this number is opted out (a 413 verdict, a consent-list
 * row). Idempotent: an event already in the ledger is a no-op before any lock.
 *   notify  false = record only, no staff task (the delivery backfill)
 * → { recorded, duplicate, state?, task_id?, reason? }
 */
async function recordProviderOptOut(db, { destination, providerEventId, occurredAt = null, lineNumber = null, evidence = null, how = 'provider opt-out', notify = true } = {}) {
  const dest = optout.normalizeDestination('sms', destination == null ? '' : String(destination));
  if (!dest) return { recorded: false, duplicate: false, reason: 'not_10_digit' };
  if (providerEventId) {
    const [hit] = await db.query(LEDGER_HAS_SQL, ['provider_optout', providerEventId]);
    if (hit && hit[0]) return { recorded: false, duplicate: true };
  }
  const line = ten(lineNumber);
  const result = await recordSmsConsent(db, {
    action: 'opt_out', destination: dest, source: 'provider_optout', providerEventId,
    occurredAt: toDate(occurredAt), lineNumber: line, evidence,
  });
  const out = { recorded: result.recorded, duplicate: result.duplicate, state: result.state };
  if (result.recorded && notify) {
    try {
      out.task_id = await strandedTask(db, { result, destination: dest, lineNumber: line, how });
    } catch (err) {
      console.error(`[phone_consent] stranded-client task failed for ${dest}: ${err.message}`);
    }
  }
  return out;
}

// ─── RingCentral consent reconcile (read-only; D15) ─────────────────────────
/** First occurrence for this group in the window → warning; repeat → error (CLAUDE.md convention). */
async function repeatSeverity(db, groupKey, windowHours) {
  try {
    const [[r]] = await db.query(
      `SELECT 1 AS hit FROM system_alerts WHERE group_key = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? HOUR LIMIT 1`,
      [groupKey, windowHours]);
    return r ? 'error' : 'warning';
  } catch (_) {
    return 'error';   // can't tell → don't under-page
  }
}

async function escalatingAlert(db, groupKey, o) {
  const severity = await repeatSeverity(db, groupKey, LIVENESS_REPEAT_WINDOW_HOURS);
  alertLater(db, { ...o, group_key: groupKey, severity, dedup_key: `${groupKey}:${severity}:${utcDate()}` });
  return severity;
}

/**
 * One reconcile run over every active (provider, credential) group whose
 * adapter lists consents (capabilities.consentList + listConsents — the
 * adapter owns the provider's vocabulary). Each opted-out pair → one
 * provider_optout event for the recipient, scope 'all' (D3), occurred_at = the
 * record's last-modified time, so an old opt-out never overwrites a newer
 * START. Fail-closed on sms_rc_consent_sync_enabled; GET_LOCK; bounded pages.
 *   opts.dryRun  list only, write nothing (runs even while the setting is off
 *                — the look before the switch is flipped)
 */
async function syncRcConsents(db, opts = {}) {
  const { getSetting } = require('./settingsService');   // lazy require (convention)
  const phoneService = require('./phoneService');         // lazy require (convention)
  const { acquireLock } = require('./commsArchiveCommon'); // lazy require (convention)
  const dryRun = opts.dryRun === true;
  const out = {
    enabled: false, dry_run: dryRun, skipped: null, groups: 0, pages: 0, listed: 0,
    recorded: 0, duplicates: 0, ignored: 0, would_record: 0, errors: [],
  };
  out.enabled = (await getSetting(db, RC_SYNC_ENABLED_KEY)) === '1';
  if (!out.enabled && !dryRun) { out.skipped = `${RC_SYNC_ENABLED_KEY} is not "1"`; return out; }

  const lock = await acquireLock(db, LOCK_EXPR);
  if (!lock) { out.skipped = 'locked'; return out; }
  try {
    const [groups] = await db.query(
      `SELECT provider, credential_id FROM phone_lines
        WHERE active = 1 AND credential_id IS NOT NULL GROUP BY provider, credential_id`);
    for (const g of groups) {
      const adapter = phoneService.getAdapter(g.provider);
      if (!adapter || !adapter.capabilities || !adapter.capabilities.consentList || typeof adapter.listConsents !== 'function') continue;
      out.groups += 1;
      const groupKey = `sms_consent_reconcile:${g.provider}:${g.credential_id}`;
      try {
        let pageToken = null;
        for (let page = 1; page <= RC_MAX_PAGES; page++) {
          const res = await adapter.listConsents(db, { credentialId: g.credential_id, status: 'opt_out', pageToken, perPage: RC_PER_PAGE });
          if (res.status === 429) { out.errors.push(`${g.provider}/${g.credential_id}: 429 on page ${page} (parked)`); break; }
          if (res.status !== 200) throw new Error(`listConsents ${res.status} on page ${page}: ${res.errorText || ''}`.trim());
          out.pages += 1;
          out.listed += res.records.length;
          for (const rec of res.records) {
            const dest = ten(rec.to);
            if (rec.status !== 'opt_out' || !dest) { out.ignored += 1; continue; }
            const at = toDate(rec.at);
            const pid = clip(`${g.provider}:consent:${norm10(rec.from) || rec.from || '*'}:${dest}:${at ? at.toISOString() : 'unknown'}`, 128);
            if (dryRun) {
              const [hit] = await db.query(LEDGER_HAS_SQL, ['provider_optout', pid]);
              if (hit && hit[0]) out.duplicates += 1; else out.would_record += 1;
              continue;
            }
            const r = await recordProviderOptOut(db, {
              destination: dest, providerEventId: pid, occurredAt: at, lineNumber: rec.from,
              evidence: { via: 'consent_reconcile', provider: g.provider, provider_source: rec.source || null, last_modified: rec.at || null },
              how: `${g.provider} reports the number opted out`,
            });
            if (r.recorded) out.recorded += 1; else if (r.duplicate) out.duplicates += 1; else out.ignored += 1;
          }
          if (!res.nextPageToken) break;
          pageToken = res.nextPageToken;
        }
      } catch (err) {
        out.errors.push(`${g.provider}/${g.credential_id}: ${err.message}`);
        await escalatingAlert(db, groupKey, {
          kind: 'sms_consent_reconcile_failed',
          title: `SMS consent reconcile: ${g.provider} failed`,
          message: err.message, context: { provider: g.provider, credential_id: g.credential_id },
        });
      }
    }
  } finally {
    await lock.release();
  }
  return out;
}

// ─── 3. Inbound liveness ────────────────────────────────────────────────────
/**
 * Per provider with at least one active line: when the newest ingested
 * inbound SMS is older than sms_inbound_liveness_hours (default 72), alert —
 * warning first, error when the previous run already alerted (36 h window).
 * → [{ provider, last_at, silent_hours, alerted }]
 */
async function inboundLivenessCheck(db) {
  const { getSetting } = require('./settingsService');   // lazy require (convention)
  const raw = await getSetting(db, LIVENESS_HOURS_KEY);
  const h = Number(String(raw == null ? '' : raw).trim());
  const hours = raw != null && String(raw).trim() !== '' && Number.isFinite(h) && h > 0 ? h : DEFAULT_LIVENESS_HOURS;
  const [providers] = await db.query('SELECT DISTINCT provider FROM phone_lines WHERE active = 1 ORDER BY provider');
  const out = [];
  for (const { provider } of providers) {
    const [[last]] = await db.query(
      `SELECT processed_at, TIMESTAMPDIFF(MINUTE, processed_at, NOW()) AS silent_min
         FROM phone_event_log
        WHERE provider = ? AND event_type = 'sms' AND direction = 'incoming'
        ORDER BY processed_at DESC LIMIT 1`, [provider]);
    const silentMin = last ? Number(last.silent_min) : null;
    const silent = !last || !(silentMin <= hours * 60);
    const row = { provider, last_at: last ? last.processed_at : null, silent_hours: silentMin == null ? null : Math.floor(silentMin / 60), alerted: null };
    if (silent) {
      row.alerted = await escalatingAlert(db, `sms_inbound_liveness:${provider}`, {
        kind: 'sms_inbound_silent',
        title: `No inbound texts from ${provider} for ${row.silent_hours == null ? 'ever' : `${row.silent_hours} h`}`,
        message: `No incoming SMS from ${provider} has been ingested ${last ? `since ${new Date(last.processed_at).toISOString()}` : 'at all'} ` +
          `(threshold ${hours} h). Inbound texts are the only way a STOP reaches YC: check the provider's webhook subscription ` +
          '(RingCentral hook rc-message-in / Quo hook quo-message), the hook executions, and workflows 17/18 — ' +
          'node scripts/yisramailP2CheckInbound.js checks the workflow wiring.',
        context: { provider, last_at: row.last_at, threshold_hours: hours },
      });
    }
    out.push(row);
  }
  return out;
}

module.exports = {
  // keywords
  classify,
  classifyDetail,
  normalizeBody,
  handleInbound,
  // provider signals
  recordProviderOptOut,
  syncRcConsents,
  // liveness
  inboundLivenessCheck,
  // Quo confirmation (lib/job_executor)
  confirmationText,
  scheduleQuoConfirmation,
  CONFIRM_JOB_TYPE,
  // vocabulary + keys (tests, docs)
  OPT_OUT_WORDS,
  OPT_IN_WORDS,
  OPT_IN_RC_ONLY_WORDS,
  QUO_CONFIRM_WORDS,
  REVIEW_PHRASES,
  COURTESY_KEYWORDS,
  COURTESY_WORDS,
  RC_SYNC_ENABLED_KEY,
  LIVENESS_HOURS_KEY,
  CONFIRM_TEXT_KEY,
  ASSIGNEE_KEY,
  DEFAULT_LIVENESS_HOURS,
  LOCK_EXPR,
  // internals (tests)
  recordSmsConsent,
  reviewDueDate,
  OPEN_CLIENT_CASE_SQL,
  ACTIVE_ROW_LOCK_SQL,
};
