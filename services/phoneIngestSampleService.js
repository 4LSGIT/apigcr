// services/phoneIngestSampleService.js
//
/**
 * Phone Ingest — Sample Event Service (SOURCE ADAPTER)
 * services/phoneIngestSampleService.js
 *
 * Powers GET /api/phone-ingest/sample-events AND (Slice 10A) supplies the
 * historical-event corpus for POST /api/phone-ingest/rules/test-match. Thin
 * SOURCE ADAPTER over the shared projection core (lib/ingestSampleProjection):
 * it fetches the N most recent captured phone events, hands each raw_input
 * object to projectEvent() against the phone catalog
 * (phoneIngestMetaService.MATCH_FIELDS), and returns a flat, newest-first list
 * of projected samples for the field-discovery panel.
 *
 * PHONE SOURCING IS EASY: the pipeline stores the full create_log params object
 * in phone_ingest_executions.raw_input. That object resolves the catalog paths
 * directly — no reconstruction needed (contrast emailIngestSampleService, which
 * must rebuild an event from clean columns because email raw_input is ~75%
 * truncated/unparseable).
 *
 * ONE SOURCING IMPLEMENTATION (Slice 10A):
 *   fetchEnvelopes(db, {limit, since}) is the single windowed corpus fetcher.
 *   Both consumers ride it:
 *     - getSampleEvents (field-discovery panel) — {limit: SAMPLE_LIMIT}
 *     - the rules/test-match endpoint — caller-supplied limit/since
 *   Phone raw_input parses cleanly in practice, so every returned row is
 *   fidelity:'full'. Rows whose raw_input does NOT parse are skipped entirely
 *   and counted in `unparseable_skipped` (they carry nothing the matcher could
 *   evaluate) — the same rows the sample path always silently dropped.
 *
 * PROJECTION-LIMIT (NOT privacy): the projection core emits ONLY the catalog
 * paths, never raw_input's off-catalog plumbing (_variables, data.fetch_records).
 * That's correctness — those paths are unstable and not matchable. There is NO
 * value redaction: the old `message` redaction (REDACT_PATHS) was removed
 * deliberately — all firm staff already see SMS bodies in the logs; the rule
 * editor is the same audience seeing the same data.
 *
 * MULTI-SAMPLE (newest 15 across all types): formerly one sample per type
 * (latest sms + latest call). Now a flat list of the 15 most recent events
 * regardless of type, newest first — so an operator paging through sees real
 * provider-to-provider and call-state shape variation (data.duration_seconds
 * present on some calls, absent on others, etc.). Each sample carries its own
 * `type`, `ts`, and a human `label` so the panel is page-agnostic.
 *
 * getSampleEvents returns:
 *   { samples: [ { exec_id, type, ts, label, fields:[{path,label,type,present,value}] } ] }
 *   newest first, up to SAMPLE_LIMIT. Empty list if nothing captured.
 */

const { projectEvent, _parseRawInput } = require('../lib/ingestSampleProjection');
const { MATCH_FIELDS } = require('./phoneIngestMetaService');

// Newest-N window. 15 is a small bounded teaching set (see Phase 1 design).
const SAMPLE_LIMIT = 15;

/**
 * Format a created_at value into a compact "YYYY-MM-DD HH:MM" label suffix.
 * Tolerant of Date objects (mysql2 datetime) and strings.
 */
function _fmtTs(ts) {
  if (!ts) return '';
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Normalize a `since` bound (ISO string / Date) into a UTC
 * 'YYYY-MM-DD HH:MM:SS' literal — same approach as the Slice 7 endpoints in
 * routes/api.hooks.js. Throws on unparseable input; routes pre-validate to
 * turn that into a clean 400.
 */
function _normSince(since) {
  const d = (since instanceof Date) ? since : new Date(since);
  if (isNaN(d.getTime())) throw new Error('Invalid since datetime');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Slice 10A — test-match row label: `${type} · ${message excerpt or duration}`.
 * Derived only from what the envelope reliably carries:
 *   sms  → message excerpt (40-char cap, same shape as email's subject snippet)
 *   call → duration ("245s") when data.duration_seconds is numeric, else the
 *          call status, else the event timestamp.
 * Exported for the route + harnesses.
 */
function _testLabel(envelope, eventType, ts) {
  const type = (envelope && envelope.type) || eventType || 'event';
  // sms-style: a message body to excerpt
  const msg = envelope && envelope.message;
  if (msg != null && String(msg).trim() !== '') {
    const s = String(msg).replace(/\s+/g, ' ').trim();
    return `${type} · ${s.length > 40 ? s.slice(0, 39) + '…' : s}`;
  }
  // call-style: duration, else status, else timestamp
  const dur = envelope && envelope.data && envelope.data.duration_seconds;
  if (typeof dur === 'number' && isFinite(dur)) return `${type} · ${dur}s`;
  const status = (envelope && envelope.data && envelope.data.status)
              || (envelope && envelope.extra && envelope.extra.provider_status);
  if (status != null && String(status).trim() !== '') return `${type} · ${status}`;
  const tsStr = _fmtTs(ts);
  return tsStr ? `${type} · ${tsStr}` : type;
}

/**
 * Slice 10A — THE windowed corpus fetcher (single sourcing impl).
 *
 * Fetches the newest `limit` captured phone events (optionally bounded by
 * created_at >= since) and parses each raw_input into the event object the
 * production matcher receives. Unparseable rows are skipped and counted.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.limit          required row cap (newest-N, applied in SQL —
 *                                     skipped rows are not backfilled, matching
 *                                     the sample path's historical behavior)
 * @param {string|Date} [opts.since]   optional created_at lower bound
 * @returns {Promise<{
 *   rows: Array<{exec_id:number, ts:*, event_type:string|null,
 *                envelope:object, fidelity:'full'}>,
 *   unparseable_skipped: number
 * }>}  newest first.
 */
async function fetchEnvelopes(db, { limit, since } = {}) {
  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1) {
    throw new Error('fetchEnvelopes: limit must be a positive integer');
  }

  const where = ['e.raw_input IS NOT NULL'];
  const params = [];
  if (since != null && since !== '') {
    where.push('e.created_at >= ?');
    params.push(_normSince(since));
  }
  params.push(lim);

  const [rows] = await db.query(
    `SELECT e.id AS exec_id, e.raw_input, e.created_at, pel.event_type
       FROM phone_ingest_executions e
       JOIN phone_event_log pel ON pel.id = e.event_log_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT ?`,
    params
  );

  const out = [];
  let unparseable = 0;
  for (const row of rows) {
    const envelope = _parseRawInput(row.raw_input);
    if (!envelope) { unparseable++; continue; } // defensive — phone raw_input is clean
    out.push({
      exec_id:    row.exec_id,
      ts:         row.created_at,
      event_type: row.event_type != null ? row.event_type : null,
      envelope,
      fidelity:   'full',
    });
  }

  return { rows: out, unparseable_skipped: unparseable };
}

/**
 * Build the sample-events payload: the SAMPLE_LIMIT most recent captured phone
 * events, each projected to the catalog, newest first.
 *
 * @param {object} db
 * @returns {Promise<{samples: Array<{exec_id,type,ts,label,fields:Array}>}>}
 */
async function getSampleEvents(db) {
  // Fail-loud (symmetry with email): missing/empty catalog → empty grids, no
  // error. 500 only on /sample-events, not at module load.
  if (!Array.isArray(MATCH_FIELDS) || !MATCH_FIELDS.length) {
    throw new Error('phoneIngestSampleService: MATCH_FIELDS catalog missing/empty — phoneIngestMetaService must export MATCH_FIELDS.');
  }

  const { rows } = await fetchEnvelopes(db, { limit: SAMPLE_LIMIT });

  const samples = rows.map(({ exec_id, ts, event_type, envelope }) => {
    const type = event_type || 'event';
    const tsStr = _fmtTs(ts);
    return {
      exec_id,
      type,
      ts,
      label:  tsStr ? `${type} · ${tsStr}` : type,
      fields: projectEvent(envelope, MATCH_FIELDS),
    };
  });

  return { samples };
}

module.exports = {
  getSampleEvents,
  fetchEnvelopes,
  SAMPLE_LIMIT,
  // exported for the test-match route + harnesses
  _testLabel,
};