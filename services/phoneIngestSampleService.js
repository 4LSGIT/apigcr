// services/phoneIngestSampleService.js
//
/**
 * Phone Ingest — Sample Event Service (SOURCE ADAPTER)
 * services/phoneIngestSampleService.js
 *
 * Powers GET /api/phone-ingest/sample-events. Thin SOURCE ADAPTER over the
 * shared projection core (lib/ingestSampleProjection): it fetches the N most
 * recent captured phone events, hands each raw_input object to projectEvent()
 * against the phone catalog (phoneIngestMetaService.MATCH_FIELDS), and returns
 * a flat, newest-first list of projected samples for the field-discovery panel.
 *
 * PHONE SOURCING IS EASY: the pipeline stores the full create_log params object
 * in phone_ingest_executions.raw_input. That object resolves the catalog paths
 * directly — no reconstruction needed (contrast emailIngestSampleService, which
 * must rebuild an event from clean columns because email raw_input is ~75%
 * truncated/unparseable).
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
 * Returns:
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
  const [rows] = await db.query(
    `SELECT e.id AS exec_id, e.raw_input, e.created_at, pel.event_type
       FROM phone_ingest_executions e
       JOIN phone_event_log pel ON pel.id = e.event_log_id
      WHERE e.raw_input IS NOT NULL
      ORDER BY e.id DESC
      LIMIT ?`,
    [SAMPLE_LIMIT]
  );

  const samples = [];
  for (const row of rows) {
    const event = _parseRawInput(row.raw_input);
    if (!event) continue; // phone raw_input is clean, but be defensive
    const type = row.event_type || 'event';
    const tsStr = _fmtTs(row.created_at);
    samples.push({
      exec_id: row.exec_id,
      type,
      ts:      row.created_at,
      label:   tsStr ? `${type} · ${tsStr}` : type,
      fields:  projectEvent(event, MATCH_FIELDS),
    });
  }

  return { samples };
}

module.exports = {
  getSampleEvents,
  SAMPLE_LIMIT,
};