// services/emailIngestSampleService.js
//
/**
 * Email Ingest — Sample Event Service (SOURCE ADAPTER)
 * services/emailIngestSampleService.js
 *
 * Powers GET /api/email-ingest/sample-events AND (Slice 10A) supplies the
 * historical-envelope corpus for POST /api/email-ingest/rules/test-match.
 * SOURCE ADAPTER over the shared projection core (lib/ingestSampleProjection),
 * mirroring phoneIngestSampleService — but email's sourcing is the HARD half
 * of this mission.
 *
 * WHY EMAIL CAN'T JUST PARSE raw_input (verified against live data 2026-06-01):
 *   email_ingest_executions.raw_input is ~75% of rows >=16KB and stored as a
 *   TRUNCATED preview wrapper { preview:"<cut-off JSON string>", _truncated,
 *   _original_size } — invalid JSON, unparseable. The remaining ~25% (<16KB)
 *   ARE the full unwrapped envelope and parse cleanly. So raw_input is a
 *   best-effort SUPPLEMENT, not the primary source.
 *
 * STRATEGY — HYBRID (Phase 1, approved):
 *   1. RECONSTRUCT a synthetic envelope from CLEAN columns, available on every
 *      row regardless of size:
 *        from.email        ← email_log.from_email
 *        to                ← email_log.to_email
 *        subject           ← email_log.subject
 *        source            ← email_log.source  (fallback log_extra.source)
 *        headers.message_id← log_extra.message_id (fallback email_log.message_id)
 *        auth.spf/dkim/dmarc← log_extra.auth.{spf,dkim,dmarc}
 *      → 8 of 12 catalog fields, ALWAYS present.
 *   2. OVERLAY the 4 fields that have NO clean source, ONLY when this row's
 *      raw_input happens to be the intact full envelope (~25%):
 *        from.name, kind, headers.list_id, headers.in_reply_to
 *      On truncated rows these stay ABSENT (present:false → "not captured in
 *      this sample"); they remain valid, absent-clickable catalog fields.
 *
 * ONE RECONSTRUCTION IMPLEMENTATION (Slice 10A):
 *   fetchSyntheticEnvelopes(db, {limit, since}) is the single windowed corpus
 *   fetcher. Both consumers ride it:
 *     - getSampleEvents (field-discovery panel) — {limit: SAMPLE_LIMIT}
 *     - the rules/test-match endpoint — caller-supplied limit/since
 *   Each returned row carries `fidelity`: 'full' when that row's raw_input was
 *   the intact envelope and the 4 raw-only fields were overlaid,
 *   'reconstructed' otherwise (clean-column rebuild only).
 *
 *   BODY IS FULL-FIDELITY IN THE ENVELOPE. The fetcher's envelope carries the
 *   real, uncapped email_log.body — that's what the production match engine
 *   sees, so test-match must see it too (a body-contains rule matching text
 *   past char 120 must test true). The 120-char snippet is a DISPLAY concern
 *   only; getSampleEvents applies _bodySnippet to a per-sample shallow clone
 *   just before projection, so the sample-events response is unchanged
 *   byte-for-byte.
 *
 * PRESENT vs NULL (load-bearing — see projection core header):
 *   `auth` is ALWAYS set to an object on every reconstructed envelope, so
 *   auth.spf/dkim/dmarc are present:true even when their values are null. That
 *   is the REAL outbound/from-firm case (log_extra.auth = {spf:null,dkim:null,
 *   dmarc:null,...}) — "exists and is empty", NOT "missing". We must NOT collapse
 *   a null-valued auth into an absent `auth` key. Likewise we only attach
 *   from.name / kind / headers.list_id / in_reply_to when intact raw_input
 *   actually carried them, so their absence is a true present:false.
 *
 * PROJECTION-LIMIT (NOT privacy): the synthetic envelope is shaped to EXACTLY
 * the catalog paths; we never surface raw_input's off-catalog plumbing (raw,
 * html, text, envelope). No value redaction — same posture as phone.
 *
 * getSampleEvents returns:
 *   { samples: [ { exec_id, type:'email', ts, label, fields:[...] } ] }
 *   newest first, up to SAMPLE_LIMIT. Empty list if nothing logged.
 */

const { projectEvent, _parseRawInput } = require('../lib/ingestSampleProjection');
const { MATCH_FIELDS } = require('./emailIngestMetaService');

// Newest-N window — same bounded teaching set as phone.
const SAMPLE_LIMIT = 15;

/**
 * Format a datetime into "YYYY-MM-DD HH:MM" (UTC). Mirrors phone's _fmtTs.
 */
function _fmtTs(ts) {
  if (!ts) return '';
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * A short subject snippet for sample / test-match labels (trim + cap at 40
 * chars). Exported (Slice 10A) so the test-match endpoint labels rows the
 * same way the sample panel does.
 */
function _subjectSnippet(subject) {
  const s = (subject == null ? '' : String(subject)).replace(/\s+/g, ' ').trim();
  if (!s) return '(no subject)';
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/**
 * Cap the body for DISPLAY in the sample panel. email_log.body is often a full
 * HTML body (tens of KB); the panel shows one-line field values, so we collapse
 * whitespace and cap to a short snippet. Preserves the present-vs-null contract:
 *   null  → null  (present:true, value:null in the projection — "exists, empty")
 *   ''    → ''     (present:true, empty string)
 *   text  → snippet (≤120 chars, '…' suffix)
 * This is display-only; the match engine — production ingest AND the
 * test-match endpoint — runs against the real, uncapped body.
 */
function _bodySnippet(body) {
  if (body == null) return null;
  const s = String(body).replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

/**
 * Coerce a possibly-JSON column (log_extra) into an object. mysql2 returns JSON
 * columns as objects, but tolerate strings/null.
 */
function _asObject(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch { return {}; } }
  return {};
}

/**
 * If this row's raw_input is the INTACT full envelope (not the truncated
 * preview wrapper), return it; otherwise null. The intact envelope is
 * identified positively by the presence of a `from` object (the preview
 * wrapper has only { preview, _truncated, _original_size } and parses — if it
 * parses at all — to something without `from`).
 */
function _intactEnvelope(rawInput) {
  const obj = _parseRawInput(rawInput);
  if (!obj || typeof obj !== 'object') return null;
  if (obj._truncated === true) return null;            // explicit truncation flag
  if (!obj.from || typeof obj.from !== 'object') return null; // preview wrapper / unknown shape
  return obj;
}

/**
 * Build a synthetic event object shaped to the catalog paths from the clean
 * columns, then overlay the 4 raw-only fields when intact raw_input is present.
 *
 * NOTE (Slice 10A): body is carried FULL here (see module header) — display
 * capping happens in getSampleEvents, not in reconstruction.
 *
 * @param {object} row  { from_email, to_email, subject, body, el_source, el_mid, log_extra, raw_input }
 * @param {object|null} [intact]  precomputed _intactEnvelope(row.raw_input);
 *   computed internally when omitted (backward-compatible signature).
 * @returns {object} synthetic envelope
 */
function _buildEnvelope(row, intact) {
  const lx = _asObject(row.log_extra);
  const lxAuth = _asObject(lx.auth);

  // ── 1. CLEAN reconstruction (always present) ──
  // `from` and `headers` and `auth` are ALWAYS objects so their leaf paths
  // resolve present:true (with possibly-null values — the real outbound case).
  const env = {
    from: {
      email: row.from_email != null ? row.from_email : null,
      // from.name intentionally NOT set here — clean columns don't carry it.
      // Overlaid from intact raw_input below, else absent (present:false).
    },
    to:      row.to_email != null ? row.to_email : null,
    subject: row.subject  != null ? row.subject  : null,
    // body: the REAL, uncapped email_log.body — a clean column, so body is
    // always "present" (null → present:true value:null). The 120-char display
    // snippet is applied downstream by getSampleEvents only; the match engine
    // (production and test-match) evaluates against this full value.
    body:    row.body != null ? row.body : null,
    source:  (row.el_source != null ? row.el_source
             : (lx.source != null ? lx.source : null)),
    headers: {
      message_id: (lx.message_id != null ? lx.message_id
                  : (row.el_mid != null ? row.el_mid : null)),
      // headers.list_id / headers.in_reply_to NOT set here — raw-only.
    },
    auth: {
      // Genuine nulls on outbound/from-firm mail — present:true, value:null.
      spf:   ('spf'   in lxAuth) ? lxAuth.spf   : null,
      dkim:  ('dkim'  in lxAuth) ? lxAuth.dkim  : null,
      dmarc: ('dmarc' in lxAuth) ? lxAuth.dmarc : null,
    },
  };

  // ── 2. OVERLAY raw-only fields when raw_input is intact (~25% of rows) ──
  if (intact === undefined) intact = _intactEnvelope(row.raw_input);
  if (intact) {
    // from.name
    if (intact.from && typeof intact.from === 'object' && ('name' in intact.from)) {
      env.from.name = intact.from.name;
    }
    // kind
    if ('kind' in intact) env.kind = intact.kind;
    // headers.list_id / headers.in_reply_to
    const ih = (intact.headers && typeof intact.headers === 'object') ? intact.headers : null;
    if (ih) {
      if ('list_id'     in ih) env.headers.list_id     = ih.list_id;
      if ('in_reply_to' in ih) env.headers.in_reply_to = ih.in_reply_to;
    }
  }

  return env;
}

/**
 * Normalize a `since` bound (ISO string / Date) into a UTC
 * 'YYYY-MM-DD HH:MM:SS' literal — same approach as the Slice 7 endpoints in
 * routes/api.hooks.js (server + DB run TZ=UTC; a 'Z'-suffixed ISO string must
 * never hit MySQL's datetime parser raw). Throws on unparseable input; routes
 * pre-validate to turn that into a clean 400.
 */
function _normSince(since) {
  const d = (since instanceof Date) ? since : new Date(since);
  if (isNaN(d.getTime())) throw new Error('Invalid since datetime');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Slice 10A — THE windowed corpus fetcher (single reconstruction impl).
 *
 * Fetches the newest `limit` LOGGED email executions (optionally bounded by
 * created_at >= since) and reconstructs a synthetic envelope for each — the
 * exact object the production matcher receives.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.limit          required row cap (newest-N)
 * @param {string|Date} [opts.since]   optional created_at lower bound
 * @returns {Promise<{rows: Array<{exec_id:number, ts:*, envelope:object,
 *   fidelity:'full'|'reconstructed'}>}>}  newest first.
 *   fidelity 'full'          → raw_input was intact; all 12 catalog fields real
 *   fidelity 'reconstructed' → clean-column rebuild; the 4 raw-only fields absent
 *   (Email reconstruction never SKIPS a row — contrast phone's
 *   unparseable_skipped — so there is no skip count here.)
 */
async function fetchSyntheticEnvelopes(db, { limit, since } = {}) {
  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1) {
    throw new Error('fetchSyntheticEnvelopes: limit must be a positive integer');
  }

  const where = [`eie.status = 'logged'`];
  const params = [];
  if (since != null && since !== '') {
    where.push('eie.created_at >= ?');
    params.push(_normSince(since));
  }
  params.push(lim);

  // status='logged' → rows that actually produced an email_log + log row, so
  // the joins resolve and we have something to reconstruct. Newest first.
  const [rows] = await db.query(
    `SELECT eie.id          AS exec_id,
            eie.created_at  AS created_at,
            eie.raw_input   AS raw_input,
            el.from_email   AS from_email,
            el.to_email     AS to_email,
            el.subject      AS subject,
            el.body         AS body,
            el.source       AS el_source,
            el.message_id   AS el_mid,
            l.log_extra     AS log_extra
       FROM email_ingest_executions eie
       JOIN email_log el ON el.id      = eie.email_log_id
       JOIN log       l  ON l.log_id   = eie.log_id
      WHERE ${where.join(' AND ')}
      ORDER BY eie.id DESC
      LIMIT ?`,
    params
  );

  const out = rows.map((row) => {
    const intact = _intactEnvelope(row.raw_input);
    return {
      exec_id:  row.exec_id,
      ts:       row.created_at,
      envelope: _buildEnvelope(row, intact),
      fidelity: intact ? 'full' : 'reconstructed',
    };
  });

  return { rows: out };
}

/**
 * Build the sample-events payload: the SAMPLE_LIMIT most recent LOGGED email
 * executions, each reconstructed + projected to the catalog, newest first.
 *
 * @param {object} db
 * @returns {Promise<{samples: Array<{exec_id,type,ts,label,fields:Array}>}>}
 */
async function getSampleEvents(db) {
  // Fail-loud: if the meta service is stale/not-deployed and MATCH_FIELDS is
  // missing, projectEvent() returns [] for every sample → the panel shows the
  // stepper but an EMPTY field grid with no error. 500 here so the cause (the
  // catalog import) is obvious, without taking down the rest of the ingest UI
  // (this throws only on /sample-events, not at module load).
  if (!Array.isArray(MATCH_FIELDS) || !MATCH_FIELDS.length) {
    throw new Error('emailIngestSampleService: MATCH_FIELDS catalog missing/empty — emailIngestMetaService must export MATCH_FIELDS (redeploy/restart the meta service).');
  }

  const { rows } = await fetchSyntheticEnvelopes(db, { limit: SAMPLE_LIMIT });

  const samples = rows.map(({ exec_id, ts, envelope }) => {
    // Display-only body cap (see _bodySnippet). Shallow clone so the fetcher's
    // envelope — which other consumers may hold — is never mutated. Nested
    // objects are shared read-only with projectEvent, which does not mutate.
    const displayEnv = { ...envelope, body: _bodySnippet(envelope.body) };
    return {
      exec_id,
      type:    'email',
      ts,
      label:   `email · ${_subjectSnippet(envelope.subject)}`,
      fields:  projectEvent(displayEnv, MATCH_FIELDS),
    };
  });

  return { samples };
}

module.exports = {
  getSampleEvents,
  fetchSyntheticEnvelopes,
  SAMPLE_LIMIT,
  // exported for testing / label reuse
  _buildEnvelope,
  _intactEnvelope,
  _subjectSnippet,
};