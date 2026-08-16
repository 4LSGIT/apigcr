// services/pipelineService.js
//
/**
 * pipelineService.js — Service layer for the Case Pipeline Engine (Slice B).
 *
 * Backs routes/api.pipeline.js and the `advance_stage` internal function.
 * Owns:
 *   - resolveTemplate — pure resolution of a case → pipeline_templates row
 *     (NO pointer column on cases; template is always a function of the case).
 *   - getPipeline — { template, current, history, upcoming } read model.
 *   - advanceStage — the ONLY writer of case_stage_log; also overwrites
 *     cases.case_stage / case_status / case_rec from the entered stage
 *     (overwrite-on-advance is the decided design).
 *   - resolveStageField — stable-key → column resolver stub for future
 *     stage config (config JSON stays unread in v1).
 *
 * Schema: pipeline_templates / pipeline_stages / case_stage_log —
 * ref/2026-08-02_pipeline_engine_slice_a.sql (Slice A, shipped 2026-08-02).
 *
 * Concurrency (advanceStage): per-case MySQL named lock
 * (GET_LOCK('pipeline_case_<id>', 5)) acquired INSIDE the withTransaction
 * callback on the transaction's own connection — named locks are
 * per-connection, so acquire and release MUST run on the same conn (the
 * pool-level GET_LOCK in oauthService works because that flow never mixes
 * lock and transaction; here they must share a connection). The named lock
 * is the mutex; the latest-log read is a plain SELECT — no FOR UPDATE
 * (deliberate: gap/next-key locking on an append-only log under
 * ORDER BY … LIMIT 1 is the design this replaces). ROLLBACK does NOT
 * release named locks, so RELEASE_LOCK runs in `finally` on the same conn;
 * a dead connection releases its locks on close, which is why the release
 * itself is guarded rather than allowed to mask the original error.
 *
 * withTransaction retry note: the callback's only side effects are DB-side
 * (lock, insert, update), so the helper's single transient-error retry is
 * safe — a retry lands on a fresh connection and re-acquires the lock
 * (the dead connection's lock is gone with it).
 *
 * Conventions (match services/formTemplateService.js):
 *   - Every function takes the mysql2 pool (req.db) — or, internally, a
 *     transaction connection — as its first argument.
 *   - Business-rule / not-found failures throw an Error carrying `.status`
 *     (400 / 404 / 409); the route maps `err.status || 500`.
 *   - Session sql_mode lacks STRICT_TRANS_TABLES — over-length strings would
 *     truncate SILENTLY at the DB. All writes truncate defensively in JS:
 *     status_label ≤ 100, cases.case_status ≤ 50, cases.case_rec ≤ 128,
 *     note ≤ 255.
 *   - No JSON columns are written in v1 (pipeline_stages.config stays
 *     unread/unwritten), so no JSON.stringify concerns here yet.
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS / HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_SECONDS = 5;                       // GET_LOCK wait (per spec)
const SOURCES = new Set(['manual', 'system', 'import']); // case_stage_log.source enum

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (msg) => httpError(400, msg);
const notFound   = (msg) => httpError(404, msg);

/** Case-insensitive string equality — mirrors utf8mb4_general_ci, so JS-side
 *  template matching agrees with what an equivalent SQL WHERE would match. */
function ciEq(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() ===
         String(b == null ? '' : b).trim().toLowerCase();
}

/** Defensive truncate (session lacks strict mode — DB would clip silently). */
function clip(s, max) {
  if (s == null) return null;
  s = String(s);
  return s.length <= max ? s : s.slice(0, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveTemplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the pipeline template for a case. Pure function of the case row —
 * there is NO pointer column; changing case_type/case_subtype re-resolves
 * naturally on the next read.
 *
 * Branch order (first match wins):
 *   1. case_subtype blank/'' → the active role='intake' template.
 *   2. Active role='case' template matching (case_type, case_subtype).
 *   3. Active is_default=1 role='case' template for case_type.
 *   4. The intake template (fallback).
 * Returns the full pipeline_templates row, or null ONLY when even the intake
 * template is missing — callers degrade (empty upcoming), never throw on null.
 *
 * One query (templates table is tiny); ties broken by lowest id.
 *
 * @param {object} db      mysql2 pool or transaction connection
 * @param {object} caseRow row carrying at least { case_type, case_subtype }
 * @returns {object|null}  pipeline_templates row or null
 */
async function resolveTemplate(db, caseRow) {
  const [templates] = await db.query(
    `SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC`
  );

  const subtype = String(caseRow.case_subtype == null ? '' : caseRow.case_subtype).trim();
  const intake  = templates.find(t => t.role === 'intake') || null;

  if (subtype === '') return intake;                                       // 1

  const exact = templates.find(t =>
    t.role === 'case' &&
    ciEq(t.case_type, caseRow.case_type) &&
    ciEq(t.case_subtype, subtype)
  );
  if (exact) return exact;                                                 // 2

  const dflt = templates.find(t =>
    t.role === 'case' && t.is_default && ciEq(t.case_type, caseRow.case_type)
  );
  if (dflt) return dflt;                                                   // 3

  return intake;                                                           // 4
}

// ─────────────────────────────────────────────────────────────────────────────
// getPipeline
// ─────────────────────────────────────────────────────────────────────────────

function projectLogRow(r) {
  return {
    stage_id:     r.stage_id,
    stage_key:    r.stage_key,
    case_stage:   r.case_stage,
    status_label: r.status_label,
    entered_at:   r.entered_at,
    entered_by:   r.entered_by,
    source:       r.source,
    note:         r.note,
  };
}

/**
 * Read model for a case's pipeline.
 *
 * @param {object} db     mysql2 pool (or transaction connection)
 * @param {string} caseId cases.case_id (varchar)
 * @returns {{template: object|null, current: object|null, history: object[], upcoming: object[], stages: object[]}}
 *   template — {id, name, role, case_type, case_subtype} from resolveTemplate
 *              (null when no template resolves — degrade, don't throw).
 *   current  — latest case_stage_log row (entered_at DESC, id DESC), projected;
 *              null when the case has no log rows (the universal day-one state).
 *   history  — ALL log rows ascending (oldest first), same projection.
 *   upcoming — active stages of the resolved template with stage_number greater
 *              than the current stage's. Current is matched to the template by
 *              stage_key, NOT stage_id — history survives template edits by
 *              design. When current is null OR its stage_key is not in the
 *              resolved template (case just branched from intake), upcoming is
 *              ALL of the template's active stages.
 *   stages   — ALL active stages of the resolved template (same projection as
 *              upcoming), regardless of position. Always present ([] when
 *              template is null). UI uses it for full-timeline rendering
 *              (client_label on past/current rows) and the show-all-stages
 *              advance control; C1 contract as of 2026-08-02. Projection
 *              includes client_visible (portal filters on it; staff surfaces
 *              may ignore it).
 * @throws 404 when the case does not exist.
 */
async function getPipeline(db, caseId) {
  const [[caseRow]] = await db.query(
    `SELECT case_id, case_type, case_subtype FROM cases WHERE case_id = ?`,
    [caseId]
  );
  if (!caseRow) throw notFound(`Case ${caseId} not found`);

  const template = await resolveTemplate(db, caseRow);

  // One ascending query serves both history (whole list) and current (last).
  const [logRows] = await db.query(
    `SELECT stage_id, stage_key, case_stage, status_label,
            entered_at, entered_by, source, note
       FROM case_stage_log
      WHERE case_id = ?
      ORDER BY entered_at ASC, id ASC`,
    [caseId]
  );
  const history = logRows.map(projectLogRow);
  const current = history.length ? history[history.length - 1] : null;

  let upcoming = [];
  let stages = [];
  if (template) {
    const [stageRows] = await db.query(
      `SELECT id AS stage_id, stage_key, stage_number, internal_label,
              client_label, case_stage, is_terminal, default_rec, client_visible
         FROM pipeline_stages
        WHERE template_id = ? AND active = 1
        ORDER BY stage_number ASC, id ASC`,
      [template.id]
    );
    stages = stageRows;
    const matched = current
      ? stageRows.find(s => s.stage_key === current.stage_key)
      : null;
    upcoming = matched
      ? stageRows.filter(s => s.stage_number > matched.stage_number)
      : stageRows;   // no history yet, or branched from another template
  }

  return {
    template: template
      ? {
          id: template.id,
          name: template.name,
          role: template.role,
          case_type: template.case_type,
          case_subtype: template.case_subtype,
        }
      : null,
    current,
    history,
    upcoming,
    stages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// advanceStage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an advance target to a pipeline_stages row (transaction-scoped).
 *
 *   - Numeric target (number or all-digit string) → direct pipeline_stages id
 *     lookup, ANY template — the explicit escape hatch. No active filter:
 *     by-id is deliberate and unrestricted.
 *   - String target → stage_key resolved WITHIN resolveTemplate's template
 *     for this case; must be an active stage of that template.
 *
 * soft mode (Slice E1 — set only for GUARDED advances, i.e. onlyFrom /
 * onlyFromRole present): the two key-resolution failures — no template
 * resolves, or the stage_key is not in the resolved template — return NULL
 * instead of throwing 400. Rationale: a guarded advance is opportunistic by
 * definition, and "the target stage doesn't exist where this case now lives"
 * is the same condition as "the case isn't where the guard expected" — the
 * case changed templates between its latest log row and now (e.g. subtype set
 * or cleared by hand). Skip, don't alert. A blank target and an unknown
 * NUMERIC id still throw in soft mode — those are caller config errors that a
 * guard should never mask.
 *
 * @throws 400 on missing/unknown target or (when !soft) when no template
 *         resolves / the key is not in the template.
 */
async function _resolveTarget(conn, caseRow, target, { soft = false } = {}) {
  if (target === undefined || target === null || String(target).trim() === '') {
    throw badRequest('stage is required (stage_key or numeric stage_id)');
  }
  const s = String(target).trim();

  if (/^\d+$/.test(s)) {
    const [[stage]] = await conn.query(
      `SELECT * FROM pipeline_stages WHERE id = ?`, [Number(s)]
    );
    if (!stage) throw badRequest(`Unknown stage_id ${s}`);
    return stage;
  }

  const template = await resolveTemplate(conn, caseRow);
  if (!template) {
    if (soft) return null;
    throw badRequest(
      `No pipeline template resolves for case ${caseRow.case_id} — ` +
      `cannot advance by stage_key "${s}" (numeric stage_id still works)`
    );
  }
  const [[stage]] = await conn.query(
    `SELECT * FROM pipeline_stages
      WHERE template_id = ? AND stage_key = ? AND active = 1`,
    [template.id, s]
  );
  if (!stage) {
    if (soft) return null;
    throw badRequest(`Unknown stage_key "${s}" in template "${template.name}"`);
  }
  return stage;
}

/**
 * Advance a case to a pipeline stage. Skipping stages is legal by design
 * (there is no "next only" rule); moving backwards is likewise just an
 * append — the log is the record.
 *
 * Writes, under a per-case named lock + transaction (same connection):
 *   - INSERT case_stage_log (append-only history; status_label snapshots the
 *     stage's internal_label at entry time).
 *   - UPDATE cases SET case_stage = <stage bucket>,
 *                      case_status = <internal_label, clipped to 50>,
 *                      case_rec = <stage default_rec>   — overwrite-on-advance.
 *
 * Idempotency: if the case's latest log row already carries the same
 * stage_key AND template_id as the resolved target, nothing is written and
 * the returned payload carries noop:true.
 *
 * Guards (Slice E1) — both optional, both consulted BEFORE target resolution
 * (inside the same lock + transaction, so the read-then-write window is
 * race-free). When any guard fails to match, the advance is SKIPPED: no
 * INSERT, no UPDATE, no throw — the return is
 * { skipped: true, noop: false, from: <current stage_key or null> } and the
 * lock still releases (finally). When BOTH guards are given, both must match.
 *
 *   onlyFrom     array of stage_key strings the case's latest log row must
 *                carry for the advance to proceed. A `null` MEMBER means
 *                "case has no log rows yet".
 *   onlyFromRole array of pipeline_templates.role values ('intake'|'case')
 *                matched against the LATEST LOG ROW's template_id → role —
 *                deliberately NOT the currently-resolved template, so a case
 *                whose subtype was just written (re-resolving it to a case
 *                template) still counts as "coming from intake" until a
 *                case-template stage is actually logged. A `null` member
 *                means "case has no log rows yet", same as onlyFrom.
 *
 * Guarded advances also resolve the target SOFTLY: a stage_key that doesn't
 * exist in the case's currently-resolved template (or a case with no template
 * at all) is a skip, not a 400 — see _resolveTarget's soft mode. Unguarded
 * calls keep today's throwing behavior exactly.
 *
 * @param {object} db       mysql2 pool
 * @param {string} caseId   cases.case_id
 * @param {string|number} target stage_key or numeric pipeline_stages.id
 * @param {object} [opts]
 * @param {number|null} [opts.userId=null] users.user for entered_by (null for system)
 * @param {string|null} [opts.note=null]   log note (clipped to 255)
 * @param {string} [opts.source='manual']  'manual' | 'system' | 'import'
 * @param {?Array<string|null>} [opts.onlyFrom]     see Guards above
 * @param {?Array<string|null>} [opts.onlyFromRole] see Guards above
 * @returns fresh getPipeline payload with `noop` + `skipped:false` added; OR
 *          { skipped: true, noop: false, from } when a guard didn't match /
 *          a guarded target didn't resolve (no getPipeline re-read — nothing
 *          was written).
 * @throws 400 unknown target / bad source / malformed guard; 404 unknown
 *         case; 409 lock timeout (retryable).
 */
async function advanceStage(db, caseId, target, {
  userId = null, note = null, source = 'manual',
  onlyFrom = undefined, onlyFromRole = undefined,
} = {}) {
  if (!SOURCES.has(source)) {
    throw badRequest(`Invalid source "${source}" (manual | system | import)`);
  }

  // Guard shape validation — up front, before any connection work (matches
  // the source check above). null/undefined = absent (defensive: a caller
  // computing `cond ? arr : null` should get today's behavior, not a 400);
  // anything else must be a non-empty array.
  for (const [name, v] of [['onlyFrom', onlyFrom], ['onlyFromRole', onlyFromRole]]) {
    if (v == null) continue;
    if (!Array.isArray(v) || v.length === 0) {
      throw badRequest(
        `${name} must be a non-empty array when provided ` +
        `(a null MEMBER means "case has no log rows yet")`
      );
    }
  }
  const guarded = onlyFrom != null || onlyFromRole != null;

  const outcome = await withTransaction(db, async (conn) => {
    // Per-case cross-instance mutex. MUST be on the transaction's connection
    // (named locks are per-connection) and released in finally — ROLLBACK
    // does not release named locks.
    const lockKey = `pipeline_case_${caseId}`;
    const [[lockRes]] = await conn.query(
      `SELECT GET_LOCK(?, ?) AS lockAcquired`,
      [lockKey, LOCK_TIMEOUT_SECONDS]
    );
    if (!lockRes || lockRes.lockAcquired !== 1) {
      throw httpError(409, `Pipeline advance already in progress for case ${caseId} — retry`);
    }

    try {
      const [[caseRow]] = await conn.query(
        `SELECT case_id, case_type, case_subtype FROM cases WHERE case_id = ?`,
        [caseId]
      );
      if (!caseRow) throw notFound(`Case ${caseId} not found`);

      // Latest entry — plain SELECT; the named lock above is the mutex.
      // Slice E1: this read MOVED ABOVE _resolveTarget so the guards are
      // consulted before target resolution — otherwise a guarded advance
      // whose target key doesn't exist on the case's current template (the
      // ISS doc-request path: 'docs' on an Intake-template case) would 400
      // before the guard could skip it.
      const [[latest]] = await conn.query(
        `SELECT id, template_id, stage_key
           FROM case_stage_log
          WHERE case_id = ?
          ORDER BY entered_at DESC, id DESC
          LIMIT 1`,
        [caseId]
      );

      if (guarded) {
        const fromKey = latest ? latest.stage_key : null;
        let ok = true;

        if (onlyFrom != null) {
          ok = onlyFrom.some((m) =>
            m === null ? !latest : (latest && String(m) === latest.stage_key)
          );
        }

        if (ok && onlyFromRole != null) {
          if (!latest) {
            ok = onlyFromRole.includes(null);
          } else {
            const [[tpl]] = await conn.query(
              `SELECT role FROM pipeline_templates WHERE id = ?`,
              [latest.template_id]
            );
            const role = tpl ? tpl.role : null;   // missing template → no role → skip
            ok = role != null &&
                 onlyFromRole.some((m) => m !== null && String(m) === role);
          }
        }

        if (!ok) return { noop: false, skipped: true, from: fromKey };
      }

      const stage = await _resolveTarget(conn, caseRow, target, { soft: guarded });
      if (!stage) {
        // soft mode only (guarded): key didn't resolve in the case's current
        // template — the case moved templates since its latest log row.
        return { noop: false, skipped: true, from: latest ? latest.stage_key : null };
      }

      // Idempotency guard: same stage in the same template → no-op.
      if (latest &&
          latest.stage_key === stage.stage_key &&
          latest.template_id === stage.template_id) {
        return { noop: true };
      }

      await conn.query(
        `INSERT INTO case_stage_log
           (case_id, template_id, stage_id, stage_key, case_stage,
            status_label, entered_by, source, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          caseId,
          stage.template_id,
          stage.id,
          stage.stage_key,
          stage.case_stage,
          clip(stage.internal_label, 100),   // status_label snapshot
          userId,
          source,
          clip(note, 255),
        ]
      );

      // Overwrite-on-advance for all three (decided design). case_status is
      // varchar(50) — clip in JS; without strict mode the DB would clip
      // silently mid-word.
      await conn.query(
        `UPDATE cases SET case_stage = ?, case_status = ?, case_rec = ? WHERE case_id = ?`,
        [
          stage.case_stage,
          clip(stage.internal_label, 50),
          clip(stage.default_rec == null ? '' : stage.default_rec, 128),
          caseId,
        ]
      );

      return { noop: false };
    } finally {
      // Guarded: a dead connection releases its named locks on close, and an
      // unguarded throw here would mask the real error from the try block.
      try { await conn.query(`SELECT RELEASE_LOCK(?)`, [lockKey]); }
      catch (_) { /* see comment above */ }
    }
  });

  if (outcome.skipped) {
    // Nothing was written — no getPipeline re-read, no Slice E dispatch.
    // Deliberately minimal shape: { skipped, noop, from }. The HTTP route
    // never passes guards, so this shape never reaches the frontends; the
    // guarded callers (doc-request advance, retainer send/sign) branch on
    // .skipped and want exactly this.
    return { skipped: true, noop: false, from: outcome.from };
  }

  if (!outcome.noop) {
    // ── Slice E insertion point ──────────────────────────────────────────
    // Fire-and-forget, strictly AFTER commit: pipeline-stage-entered trigger
    // dispatch (hooks / workflow triggers) plugs in here. Must stay
    // post-commit (never inside the transaction — withTransaction may retry
    // the callback) and must never fail the advance.
    (async () => { /* no-op until Slice E */ })().catch(() => {});
  }

  const payload = await getPipeline(db, caseId);
  payload.noop = outcome.noop;
  payload.skipped = false;
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveStageField
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable-key → column resolver for stage config.
 *
 * Intent: future pipeline_stages.config (dates to stamp, fields to require,
 * etc.) references STABLE KEYS, never raw cases column names — so columns can
 * be renamed/remapped in exactly one place without touching stored config.
 * v1 is an identity passthrough over an (empty) map; entries get added as
 * config starts referencing fields (config JSON is deliberately unread in
 * Slice B).
 *
 * @param {string} key stable field key
 * @returns {string} the cases column name (identity until the map grows)
 */
const STAGE_FIELD_MAP = Object.freeze({
  // 'filed_date': 'case_file_date',   // ← shape of future entries
});
function resolveStageField(key) {
  return Object.prototype.hasOwnProperty.call(STAGE_FIELD_MAP, key)
    ? STAGE_FIELD_MAP[key]
    : key;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  resolveTemplate,
  getPipeline,
  advanceStage,
  resolveStageField,
};