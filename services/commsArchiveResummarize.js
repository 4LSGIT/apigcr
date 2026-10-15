// services/commsArchiveResummarize.js
//
/**
 * Comms archive S3c — PER-CALL re-summarise (ref/COMMS_ARCHIVE_DESIGN.md §6.4):
 * a staff user who may read a call asks for its summary to be made again —
 * or made for the first time — with a model (Sonnet by default) and an
 * optional NOTE. Driven by POST /api/comms-archive/media/:id/resummarize; the
 * route does the staff-JWT, canReadMedia (404), rate and audit checks — this
 * module the summary rules, in one transaction.
 *
 * The request is a GUIDE (comms_summary_guides, one row per transcript): its
 * model and note drive EVERY later summary of the transcript (bulk and
 * transcript redos included); a new request replaces it, and one without a
 * note clears the note. The summarize sweep runs a pending guide first (the
 * next tick), sends the note as UNTRUSTED input (escaped, inside the user turn)
 * and stamps its outcome (done / failed / skipped) — summary_pending.
 *
 * Refusals (409, nothing changed): restricted (never sent — R5, even for an
 * archive admin); not_transcribed (no transcribed / summarized transcript);
 * empty (no text to summarise); busy (a summary call in flight); summaries_off
 * (the sweep would not run it); settings (the summary settings are wrong);
 * over_cap (this call's worst case over the monthly cap's headroom).
 *
 * The transaction: lock the queue row (FOR UPDATE — the sweep's write-ahead
 * waits on it; 'calling' → busy), lock the transcript row and re-check it,
 * summarized → transcribed (the OLD summary stays readable until the new one
 * replaces it), the queue row → pending (made if absent: the first summary of
 * a skipped / failed / never-made row; attempts 0), the guide upserted.
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');
const { httpError } = require('./commsArchiveAdmin');

const NOTE_MAX = 500;
const DEFAULT_MODEL = 'claude-sonnet-5-5';

function refuse(code, message) {
  const e = httpError(409, message);
  e.code = code;
  e.expose = true;
  return e;
}

/** Body → { model, note } or a 400. */
function parseRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const sum = require('./commsSummarizeSweep'); // lazy require (convention)
  const model = b.model === undefined || b.model === null ? DEFAULT_MODEL : b.model;
  if (!sum.MODELS.has(model)) {
    const e = httpError(400, `model must be one of ${[...sum.MODELS].join(' | ')}`);
    e.expose = true;
    throw e;
  }
  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') { const e = httpError(400, 'note must be text'); e.expose = true; throw e; }
    const t = b.note.trim();
    if (t.length > NOTE_MAX) { const e = httpError(400, `note is at most ${NOTE_MAX} characters`); e.expose = true; throw e; }
    note = t || null;
  }
  return { model, note };
}

/**
 * → { media_id, model, has_note, requested_at, summary_pending: true } — or throws a 400 / 409 (err.code).
 * `media` is the comms_media row the route loaded and canReadMedia cleared.
 */
async function resummarize(db, media, { userId, body }) {
  const { model, note } = parseRequest(body);
  if (Number(media.restricted) === 1) throw refuse('restricted', 'A restricted call is never sent for a summary');

  const [[t]] = await db.query(
    'SELECT id, state, segments, full_text, CHAR_LENGTH(full_text) AS text_len FROM comms_transcripts WHERE media_id = ?', [media.id]);
  if (!t || !['transcribed', 'summarized'].includes(t.state)) throw refuse('not_transcribed', 'This call has no transcript to summarise');
  const ground = require('./commsSummaryGround'); // lazy require (convention)
  let segments = t.segments;
  if (typeof segments === 'string') { try { segments = JSON.parse(segments); } catch (_) { segments = []; } }
  if (!ground.transcriptText(segments, t.full_text).trim()) throw refuse('empty', 'The transcript has no words to summarise');

  const sSweep = require('./commsSummarizeSweep'); // lazy require (convention)
  const tSweep = require('./commsTranscribeSweep'); // lazy require (convention)
  const redo = require('./commsArchiveRedo');       // lazy require (convention)
  const cfgS = await sSweep.readConfig(db);
  const cfgT = await tSweep.readConfig(db);
  if (cfgS.problems.length) throw refuse('settings', 'The summary settings are wrong — see the comms summary config alert');
  let isEval = false;
  if (cfgS.mode === 'sample') {
    try {
      const [[e]] = await db.query('SELECT 1 AS hit FROM comms_eval_items WHERE media_id = ? LIMIT 1', [media.id]);
      isEval = !!e;
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
  }
  if (!(cfgS.mode === 'on' || (cfgS.mode === 'sample' && isEval))) throw refuse('summaries_off', `Summaries are ${cfgS.mode}`);

  // The cap: this call's worst case at ITS model, on top of what is spent and what is queued.
  const worst = redo._summaryWorstCents({ text_len: (Number(t.text_len) || 0) + (note ? note.length + 40 : 0), guide_model: model }, cfgS);
  const mtd = await tSweep.monthToDateCents(db);
  const queued = await redo._queuedCents(db, cfgT, cfgS, await redo._evalExprOf(db));
  if (mtd + queued + worst > cfgS.capCents) throw refuse('over_cap', 'Over this month\'s AI spending cap — ask an SU');

  const requestedAt = await withTransaction(db, async (conn) => {
    const [[s]] = await conn.query('SELECT id, state FROM comms_summaries WHERE transcript_id = ? FOR UPDATE', [t.id]);
    if (s && s.state === 'calling') throw refuse('busy', 'A summary for this call is being made right now');
    const [[tt]] = await conn.query(
      `SELECT t.state, m.restricted, m.state AS m_state FROM comms_transcripts t JOIN comms_media m ON m.id = t.media_id
        WHERE t.id = ? FOR UPDATE`, [t.id]);
    if (!tt || Number(tt.restricted) === 1) throw refuse('restricted', 'A restricted call is never sent for a summary');
    if (tt.m_state !== 'archived' || !['transcribed', 'summarized'].includes(tt.state)) {
      throw refuse('not_transcribed', 'This call has no transcript to summarise');
    }
    if (tt.state === 'summarized') await conn.query("UPDATE comms_transcripts SET state = 'transcribed' WHERE id = ? AND state = 'summarized'", [t.id]);
    if (s) {
      await conn.query(
        `UPDATE comms_summaries SET state = 'pending', skip_reason = NULL, attempts = 0, next_attempt_at = NULL,
                last_error = NULL, est_cents = NULL
          WHERE id = ? AND state <> 'calling'`, [s.id]);
    } else {
      await conn.query("INSERT INTO comms_summaries (transcript_id, state) VALUES (?, 'pending')", [t.id]);
    }
    await conn.query(
      `INSERT INTO comms_summary_guides (transcript_id, model, note, note_by, requested_at, requested_by, outcome, outcome_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE model = VALUES(model), note = VALUES(note), note_by = VALUES(note_by),
                               requested_at = VALUES(requested_at), requested_by = VALUES(requested_by),
                               outcome = NULL, outcome_at = NULL, version = version + 1`,
      [t.id, model, note, note ? userId : null, userId]);
    const [[g]] = await conn.query('SELECT requested_at FROM comms_summary_guides WHERE transcript_id = ?', [t.id]);
    return g.requested_at;
  });
  return {
    media_id: Number(media.id), model, has_note: !!note,
    requested_at: new Date(requestedAt).toISOString(), summary_pending: true,
  };
}

module.exports = { resummarize, parseRequest, NOTE_MAX, DEFAULT_MODEL };
