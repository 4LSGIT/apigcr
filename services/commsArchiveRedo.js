// services/commsArchiveRedo.js
//
/**
 * Comms archive S2c-2 — REDO: send stored transcripts (or only their summaries)
 * back to be made again (ref/COMMS_ARCHIVE_DESIGN.md §8). Driven by POST
 * /api/comms-archive/redo (SU, staff JWT, step-up); a DRY RUN unless apply.
 *
 *   mode 'transcript'  the row goes back to 'pending' with its summary cleared
 *                      and a comms_redo marker written (when, who, the old
 *                      stt_model) in the same transaction; its comms_summaries
 *                      row is deleted (the summarize sweep rediscovers it once
 *                      the row is transcribed again). The OLD TEXT STAYS in the
 *                      row: every reader shows only transcribed / summarized
 *                      rows, so it is hidden while the redo runs, and the new
 *                      text replaces it in one UPDATE — never half-replaced. A
 *                      redo that ends failed or skipped is RESTORED by the sweep
 *                      to 'transcribed' with the old text (_restoreFailedRedos).
 *                      The transcribe sweep submits marked rows FIRST, with
 *                      today's settings (variant, speaker cap, keyterms), and
 *                      retires the old vendor JSON only when the new one is
 *                      stored. Cost stays (stt / llm _cost_cents).
 *   mode 'summary'     'summarized' → 'transcribed' and its comms_summaries row
 *                      deleted: the summarize sweep makes a new one with
 *                      today's model. The OLD summary stays readable until the
 *                      new one replaces it in one UPDATE.
 *
 * SELECTION — exactly one selector:
 *   {quo_stereo_diarized: true}  transcript: Quo, ≥ 2 channels, made with diarize
 *   {mono_min_speakers: N}       transcript: 1 channel, speakers ≥ N (2–50),
 *                                not already made with a speaker cap (+max)
 *   {capped: true}               transcript: made under the S2c-1 speaker cap
 *                                (stt_model '…+diarize+max<N>') — Fred dropped
 *                                the cap 2026-10-15: it merged real voices
 *   {summary_model: '<model>'}   summary: summarised with that model
 *   {media_ids: [..]}            either mode: these items (1–200)
 * NEVER selected: restricted or non-archived items; transcripts not in
 * transcribed / summarized (summary mode: summarized); numbers on
 * comms_no_transcribe; comms_eval_items (lane D's evaluation set) unless named
 * in media_ids; a row whose summary call is IN FLIGHT ('calling' — its
 * done-write is fenced on 'transcribed' and would take the purge branch, so the
 * summary would be skipped as 'purged' and never remade): reported as busy.
 * The apply re-checks state / archived / restricted / not-calling in the SAME
 * conditional UPDATE, so a row that changed since the selection is left alone.
 *
 * MONEY: the estimate is per row — STT at today's variant (vendor.costCents on
 * comms_media.duration_s, the vendor-measured length), the summary at its
 * WORST case (what the summarize sweep reserves per call). The headroom is the
 * cap minus month-to-date minus what the sweeps have still to spend
 * (_queuedCents: marker rows' STT while pending; every summary to come — marker
 * rows, and every transcribed row with no queue row or a pending one — while
 * the summarize sweep would make it). An apply whose batch estimate exceeds it is
 * REFUSED: rows would otherwise sit waiting until the cap resets. So is an
 * apply when the sweep that must do the work is not 'on' (or 'sample' and the
 * batch is not all evaluation items), when a transcript redo would clear
 * summaries the summarize sweep will not remake (it is off, or in sample mode
 * for non-evaluation rows — code summaries_off), or with wrong settings.
 *
 * Idempotent and resumable: a flipped row no longer matches; call again until
 * remaining = 0. Grant-blind like every service: the route does the checks
 * and the audit (ids and counts — never content).
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');
const vendor = require('./commsTranscribeVendor');

const MODES = new Set(['transcript', 'summary']);
const MAX_IDS = 200;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  e.expose = true;
  return e;
}

/** Body → { mode, select: {kind, value}, limit, apply } or throws a 400. */
function parseRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const mode = b.mode;
  if (!MODES.has(mode)) throw bad("mode must be 'transcript' or 'summary'");
  const sel = b.select && typeof b.select === 'object' && !Array.isArray(b.select) ? b.select : null;
  const keys = sel ? Object.keys(sel) : [];
  if (keys.length !== 1) throw bad('select must have exactly one of quo_stereo_diarized, mono_min_speakers, capped, summary_model, media_ids');
  const [kind] = keys;
  const v = sel[kind];
  let value;
  if (kind === 'quo_stereo_diarized') {
    if (mode !== 'transcript') throw bad('quo_stereo_diarized is a transcript selector');
    if (v !== true) throw bad('quo_stereo_diarized must be true');
    value = true;
  } else if (kind === 'mono_min_speakers') {
    if (mode !== 'transcript') throw bad('mono_min_speakers is a transcript selector');
    if (!Number.isInteger(v) || v < 2 || v > 50) throw bad('mono_min_speakers must be a whole number 2–50');
    value = v;
  } else if (kind === 'capped') {
    if (mode !== 'transcript') throw bad('capped is a transcript selector');
    if (v !== true) throw bad('capped must be true');
    value = true;
  } else if (kind === 'summary_model') {
    if (mode !== 'summary') throw bad('summary_model is a summary selector');
    if (typeof v !== 'string' || !/^[a-z0-9.-]{1,48}$/.test(v)) throw bad('summary_model must be a model name');
    value = v;
  } else if (kind === 'media_ids') {
    if (!Array.isArray(v) || !v.length || v.length > MAX_IDS || !v.every(x => Number.isInteger(x) && x > 0)) {
      throw bad(`media_ids must be 1–${MAX_IDS} item ids`);
    }
    value = [...new Set(v)];
  } else {
    throw bad(`unknown selector ${String(kind).slice(0, 40)}`);
  }
  let limit = DEFAULT_LIMIT;
  if (b.limit !== undefined) {
    if (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > MAX_LIMIT) throw bad(`limit must be 1–${MAX_LIMIT}`);
    limit = b.limit;
  }
  if (b.apply !== undefined && typeof b.apply !== 'boolean') throw bad('apply must be true or false');
  return { mode, select: { kind, value }, limit, apply: b.apply === true };
}

/** SQL: is this row's item in lane D's evaluation set? ('0' on a database without comms_eval_items.) */
async function _evalExprOf(db) {
  return (await _hasEvalTable(db)) ? 'EXISTS (SELECT 1 FROM comms_eval_items e WHERE e.media_id = t.media_id)' : '0';
}

async function _hasEvalTable(db) {
  const [[r]] = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comms_eval_items'");
  return Number(r.n) > 0;
}

/** The selector's rows, with everything the eligibility rules read. Newest first. */
async function _candidates(db, { mode, select }) {
  const evalExpr = await _evalExprOf(db);
  let where;
  const params = [];
  if (select.kind === 'quo_stereo_diarized') {
    where = "m.provider = 'quo' AND m.audio_channels >= 2 AND t.stt_model LIKE '%+diarize%'";
  } else if (select.kind === 'mono_min_speakers') {
    where = "m.audio_channels = 1 AND t.speakers >= ? AND t.stt_model NOT LIKE '%+max%'";
    params.push(select.value);
  } else if (select.kind === 'capped') {
    where = "t.stt_model LIKE '%+diarize+max%'";
  } else if (select.kind === 'summary_model') {
    where = 't.summary_model = ?';
    params.push(select.value);
  } else {
    where = 't.media_id IN (?)';
    params.push(select.value);
  }
  const [rows] = await db.query(
    `SELECT t.id AS transcript_id, t.media_id, t.state, t.speakers, t.stt_model, t.summary_model, t.est_audio_s,
            CHAR_LENGTH(t.full_text) AS text_len, (t.summary_text IS NOT NULL) AS has_summary,
            m.kind, m.provider, m.audio_channels, m.duration_s, m.state AS m_state, m.restricted,
            EXISTS (SELECT 1 FROM comms_no_transcribe n
                     WHERE n.phone = RIGHT(REGEXP_REPLACE(COALESCE(m.party, ''), '[^0-9]', ''), 10)) AS no_transcribe,
            ${evalExpr} AS is_eval, ${await _guideExprOf(db)} AS guide_model,
            (SELECT s.state FROM comms_summaries s WHERE s.transcript_id = t.id) AS s_state
       FROM comms_transcripts t JOIN comms_media m ON m.id = t.media_id
      WHERE ${where}
      ORDER BY m.captured_at DESC, t.id DESC`, params);
  return rows;
}

/** Why a candidate is NOT selected, or null. */
function whyNot(row, { mode, explicit }) {
  const okStates = mode === 'transcript' ? ['transcribed', 'summarized'] : ['summarized'];
  if (!okStates.includes(row.state)) return 'state';
  if (row.m_state !== 'archived') return 'not_archived';
  if (Number(row.restricted) === 1) return 'restricted';
  if (Number(row.no_transcribe) === 1) return 'no_transcribe';
  if (Number(row.is_eval) === 1 && !explicit) return 'eval';
  if (row.s_state === 'calling') return 'busy';
  return null;
}

function _variantFor(row, cfgT) {
  const ch = Number(row.audio_channels) || 1;
  return ch >= 2 ? cfgT.stereo : 'diarize';
}

function _sttCents(row, cfgT) {
  const audioS = Number(row.duration_s ?? row.est_audio_s ?? 0) || 0;
  const ch = Number(row.audio_channels) || 1;
  return vendor.costCents({ audioS, variant: _variantFor(row, cfgT), channels: ch, keyterms: cfgT.keyterms.length > 0 });
}

function _summaryWorstCents(row, cfgS) {
  const { computeCostCents } = require('./aiService'); // lazy require (convention)
  const sum = require('./commsSummarizeSweep');        // lazy require (convention)
  const inTok = Math.ceil((Number(row.text_len) || 0) / 4) + sum.limits.systemTokens;
  // S3c: a transcript with a staff guide is summarised with ITS model, whatever comms_summary_model says.
  const model = row.guide_model && sum.MODELS.has(row.guide_model) ? row.guide_model : cfgS.model;
  return computeCostCents(inTok, sum.limits.maxTokens, model) || 0;
}

/** SQL: this transcript's guided model (S3c comms_summary_guides), or NULL — 'NULL' on a database without the table. */
async function _guideExprOf(db) {
  const [[r]] = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comms_summary_guides'");
  return Number(r.n) > 0 ? '(SELECT g.model FROM comms_summary_guides g WHERE g.transcript_id = t.id)' : 'NULL';
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Spend the sweeps have still to make that month-to-date does not hold yet: marker rows still pending (their STT)
 * and — while the summarize sweep would summarise them — every row that will need a summary: marker rows pending /
 * transcribing, and every 'transcribed' row with no comms_summaries row or one still 'pending' (a summary-redone
 * row, a redone row whose new transcript is stored, the ordinary backlog), each at the summary's worst case.
 * Restricted rows and calls under the summary minimum are never summarised, so they are not counted.
 */
async function _queuedCents(db, cfgT, cfgS, evalExpr) {
  let c = 0;
  const guideExpr = await _guideExprOf(db);
  const [marked] = await db.query(
    `SELECT t.state, t.est_audio_s, CHAR_LENGTH(t.full_text) AS text_len, m.audio_channels, m.duration_s,
            m.kind, m.restricted, ${evalExpr} AS is_eval, ${guideExpr} AS guide_model
       FROM comms_redo rd JOIN comms_transcripts t ON t.id = rd.transcript_id JOIN comms_media m ON m.id = t.media_id
      WHERE t.state IN ('pending', 'transcribing')`);
  for (const r of marked) if (r.state === 'pending') c += _sttCents(r, cfgT);
  const [awaiting] = await db.query(
    `SELECT CHAR_LENGTH(t.full_text) AS text_len, m.kind, m.restricted, m.duration_s, ${evalExpr} AS is_eval,
            ${guideExpr} AS guide_model
       FROM comms_transcripts t JOIN comms_media m ON m.id = t.media_id
      WHERE t.state = 'transcribed'
        AND NOT EXISTS (SELECT 1 FROM comms_summaries s WHERE s.transcript_id = t.id AND s.state <> 'pending')`);
  for (const r of [...marked, ...awaiting]) if (_willSummarise(r, cfgS)) c += _summaryWorstCents(r, cfgS);
  return c;
}

/** Would the summarize sweep make a summary for this row (its mode, the restricted and short gates)? */
function _willSummarise(r, cfgS) {
  if (cfgS.problems.length) return false;
  if (!(cfgS.mode === 'on' || (cfgS.mode === 'sample' && Number(r.is_eval) === 1))) return false;
  if (Number(r.restricted) === 1) return false;
  if (cfgS.mode === 'on' && r.kind === 'call_recording' && r.duration_s != null && Number(r.duration_s) < cfgS.minS) return false;
  return true;
}

function _groups(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = `${r.kind}|${r.provider}|${Number(r.audio_channels) || '?'}ch|${r.speakers == null ? '?' : r.speakers}sp`;
    g.set(k, (g.get(k) || 0) + 1);
  }
  return Object.fromEntries([...g.entries()].sort());
}

/**
 * The whole request: select, classify, estimate; apply when asked and allowed.
 * → { outcome: 'dry_run' | 'applied' | 'refused', ... } — ids and counts only.
 */
async function redo(db, body, { userId = null } = {}) {
  const req = parseRequest(body);
  const { mode, select, limit } = req;
  const explicit = select.kind === 'media_ids';
  const tSweep = require('./commsTranscribeSweep');   // lazy require (convention)
  const sSweep = require('./commsSummarizeSweep');    // lazy require (convention)
  const cfgT = await tSweep.readConfig(db);
  const cfgS = await sSweep.readConfig(db);

  const rows = await _candidates(db, req);
  const eligible = [];
  const skipped = {};
  for (const r of rows) {
    const why = whyNot(r, { mode, explicit });
    if (why) skipped[why] = (skipped[why] || 0) + 1;
    else eligible.push(r);
  }
  const notFound = explicit ? select.value.filter(id => !rows.some(r => Number(r.media_id) === id)) : [];
  if (notFound.length) skipped.not_found = notFound.length;
  const batch = eligible.slice(0, limit);

  const cost = (list) => {
    let stt = 0, summary = 0;
    for (const r of list) {
      if (mode === 'transcript') stt += _sttCents(r, cfgT);
      if (!cfgS.problems.length) summary += _summaryWorstCents(r, cfgS);
    }
    return { stt_cents: r2(stt), summary_worst_cents: r2(summary), total_cents: r2(stt + summary) };
  };
  const mtd = await tSweep.monthToDateCents(db);
  const queued = await _queuedCents(db, cfgT, cfgS, await _evalExprOf(db));
  const capCents = cfgT.capCents;
  const out = {
    mode, select: { [select.kind]: select.value }, apply: req.apply,
    eligible: eligible.length, batch: batch.length, remaining: eligible.length - batch.length,
    skipped, not_found_ids: notFound,
    groups: _groups(batch),
    target_variants: mode === 'transcript'
      ? batch.reduce((a, r) => { const v = _variantFor(r, cfgT); a[v] = (a[v] || 0) + 1; return a; }, {}) : undefined,
    estimate: { batch: cost(batch), all_eligible: cost(eligible) },
    cap: { mtd_cents: r2(mtd), queued_cents: r2(queued), cap_cents: capCents, headroom_cents: r2(capCents - mtd - queued) },
    settings: mode === 'transcript'
      ? { transcribe_mode: cfgT.mode, quo_stereo: cfgT.stereo, max_speakers: cfgT.maxSpeakers, summarize_mode: cfgS.mode, summary_model: cfgS.model }
      : { summarize_mode: cfgS.mode, summary_model: cfgS.model },
    media_ids: batch.map(r => Number(r.media_id)),
  };

  if (!req.apply) return { outcome: 'dry_run', ...out };

  // The sweep that must do the work: settings sane, and running for these rows.
  const cfg = mode === 'transcript' ? cfgT : cfgS;
  const allEval = batch.length > 0 && batch.every(r => Number(r.is_eval) === 1);
  let refusal = null;
  if (cfg.problems.length || cfgS.problems.length) refusal = { code: 'settings', message: `${mode === 'transcript' ? 'Transcription' : 'Summary'} settings are wrong — fix them first (see the comms config alert)` };
  else if (!(cfg.mode === 'on' || (cfg.mode === 'sample' && allEval))) refusal = { code: 'mode', message: `comms_${mode === 'transcript' ? 'transcribe' : 'summarize'}_mode is ${cfg.mode}: these rows would wait unseen` };
  else if (mode === 'transcript' && batch.some(r => Number(r.has_summary) === 1
    && (cfgS.mode === 'off' || (cfgS.mode === 'sample' && Number(r.is_eval) !== 1)))) {
    refusal = { code: 'summaries_off', message: `comms_summarize_mode is ${cfgS.mode}: the summaries this would clear would not be remade` };
  } else if (out.estimate.batch.total_cents > out.cap.headroom_cents) refusal = { code: 'over_cap', message: 'The batch estimate is over the monthly cap headroom: lower limit, or raise the cap first' };
  if (refusal) return { outcome: 'refused', refusal, ...out };

  let applied = 0, lost = 0;
  const appliedIds = [];
  for (const r of batch) {
    const done = await withTransaction(db, async (conn) => {
      const [u] = mode === 'transcript'
        ? await conn.query(
          `UPDATE comms_transcripts t JOIN comms_media m ON m.id = t.media_id
              SET t.state = 'pending', t.skip_reason = NULL, t.summary = NULL, t.summary_text = NULL,
                  t.summary_model = NULL, t.grounding_dropped = NULL, t.stt_job_ref = NULL, t.alt_job_ref = NULL,
                  t.submitted_at = NULL, t.attempts = 0, t.next_attempt_at = NULL, t.last_error = NULL
            WHERE t.id = ? AND t.state IN ('transcribed', 'summarized') AND m.state = 'archived' AND m.restricted = 0
              AND NOT EXISTS (SELECT 1 FROM comms_summaries s WHERE s.transcript_id = t.id AND s.state = 'calling')`,
          [r.transcript_id])
        : await conn.query(
          `UPDATE comms_transcripts t JOIN comms_media m ON m.id = t.media_id
              SET t.state = 'transcribed'
            WHERE t.id = ? AND t.state = 'summarized' AND m.state = 'archived' AND m.restricted = 0
              AND NOT EXISTS (SELECT 1 FROM comms_summaries s WHERE s.transcript_id = t.id AND s.state = 'calling')`,
          [r.transcript_id]);
      if (u.affectedRows !== 1) return false;
      if (mode === 'transcript') {
        await conn.query(
          `INSERT INTO comms_redo (transcript_id, requested_at, requested_by, prev_model)
           SELECT t.id, UTC_TIMESTAMP(), ?, t.stt_model FROM comms_transcripts t WHERE t.id = ?
           ON DUPLICATE KEY UPDATE requested_at = VALUES(requested_at), requested_by = VALUES(requested_by),
                                   prev_model = VALUES(prev_model)`,
          [userId, r.transcript_id]);
      }
      await conn.query("DELETE FROM comms_summaries WHERE transcript_id = ? AND state <> 'calling'", [r.transcript_id]);
      return true;
    });
    if (done) { applied++; appliedIds.push(Number(r.media_id)); } else lost++;
  }
  return { outcome: 'applied', ...out, applied, changed_since_selection: lost, media_ids: appliedIds };
}

module.exports = { redo, parseRequest, whyNot, MAX_IDS, MAX_LIMIT, DEFAULT_LIMIT, _queuedCents, _evalExprOf, _summaryWorstCents };
