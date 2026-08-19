// services/pipelineService.js
//
/**
 * pipelineService.js — Service layer for the Case Pipeline Engine (Slice B).
 *
 * Backs routes/api.pipeline.js and the `advance_stage` internal function.
 * Owns:
 *   - resolveTemplate — pure resolution of a case → pipeline_templates row
 *     (NO pointer column on cases; template is always a function of the case
 *     ROW — as of T8 that row carries cases.pipeline_phase, the LIFECYCLE
 *     axis, alongside case_type/case_subtype, the MATTER axis).
 *   - getPipeline — { template, current, history, upcoming } read model.
 *   - advanceStage — the ONLY writer of case_stage_log; also overwrites
 *     cases.case_stage / case_status / case_rec / pipeline_phase from the
 *     entered stage (overwrite-on-advance is the decided design).
 *     pipeline_phase is taken from the entered stage's OWNING template role
 *     and is the ONLY automatic writer of that column — PATCH /api/cases/:id
 *     can still set it by hand (caseService.updateCase blocks only the PK),
 *     exactly as it can already set case_stage/case_status. Doing so on a
 *     lead moves it to a chapter board with no stage; treat it as the same
 *     class of footgun as hand-editing case_stage.
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

/**
 * T8 — the LIFECYCLE axis. True only for an explicit 'case' phase; NULL, '',
 * 'intake', or a silently-coerced bad enum value (the session lacks
 * STRICT_TRANS_TABLES, so an invalid enum write lands as '') all read as
 * intake. Intake is where every case starts, so it is the safe default.
 */
function isCasePhase(caseRow) {
  return String(caseRow && caseRow.pipeline_phase != null ? caseRow.pipeline_phase : '')
    .trim().toLowerCase() === 'case';
}

/** Defensive truncate (session lacks strict mode — DB would clip silently). */
function clip(s, max) {
  if (s == null) return null;
  s = String(s);
  return s.length <= max ? s : s.slice(0, max);
}

const domainEvents = require('../lib/domainEvents'); // Trigger T3 — safe top-level (async_hooks only)

// ─────────────────────────────────────────────────────────────────────────────
// resolveTemplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the pipeline template for a case. Pure function of the case row —
 * there is NO pointer column; changing pipeline_phase/case_type/case_subtype
 * re-resolves naturally on the next read.
 *
 * ── T8: TWO AXES, NOT ONE ────────────────────────────────────────────────
 * Branch 1 used to read `case_subtype blank/'' → intake`, using WHAT KIND OF
 * MATTER it is to answer WHERE IT IS IN ITS LIFECYCLE. That proxy is false:
 * a referral can be an obvious Chapter 7 on day one and still be an unsigned
 * lead. Cases whose chapter was known pre-retainer resolved to a chapter
 * template whose first stage is `retained` — a state not yet true — so they
 * had no valid stage to occupy and landed in the board's `unstaged` bucket
 * with their intake position erased.
 *
 * cases.pipeline_phase ('intake' | 'case') is now the LIFECYCLE axis and is
 * asked FIRST; case_type/case_subtype stay the MATTER axis and are asked
 * second. case_subtype therefore means subtype and nothing else — it is
 * legitimate, and expected, on a lead.
 *
 * Branch order (first match wins):
 *   1. pipeline_phase != 'case' → the active role='intake' template.
 *      (Anything not exactly 'case' — NULL, '', a bad enum write under the
 *      session's non-strict sql_mode — reads as intake. Intake is the safe
 *      default: it is where every case starts.)
 *   2. Active role='case' template matching (case_type, case_subtype).
 *   3. Active is_default=1 role='case' template for case_type.
 *   4. The intake template (fallback).
 * Returns the full pipeline_templates row, or null ONLY when even the intake
 * template is missing — callers degrade (empty upcoming), never throw on null.
 *
 * NOTE branch 4 is now reachable by post-retainer cases with no matching
 * template (Litigation, Adversary Proceeding, Chapter 11, and Bankruptcies
 * retained with no chapter recorded — 33 rows live at T8). They resolve to
 * Intake and sit `unstaged`. That is a VISIBLE wrong rather than a silent
 * one, and its fix is new templates, not new resolution logic. Do NOT set
 * is_default=1 on Chapter 7 to sweep them up — that files a Chapter 11 on a
 * Chapter 7 pipeline.
 *
 * One query (templates table is tiny); ties broken by lowest id.
 *
 * @param {object} db      mysql2 pool or transaction connection
 * @param {object} caseRow row carrying at least
 *                         { pipeline_phase, case_type, case_subtype }
 * @returns {object|null}  pipeline_templates row or null
 */
const TPL_SQL = `SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC`;

/** PURE — branches 2 and 3 of the order above (the MATTER axis), over an
 *  already-loaded template list. Null when no role='case' template matches,
 *  so a caller can tell "no matter template" from "fell back to intake". */
function _pickMatter(templates, caseRow) {
  const subtype = String(caseRow.case_subtype == null ? '' : caseRow.case_subtype).trim();

  const exact = templates.find(t =>
    t.role === 'case' &&
    ciEq(t.case_type, caseRow.case_type) &&
    ciEq(t.case_subtype, subtype)
  );
  if (exact) return exact;                                                 // 2

  return templates.find(t =>                                              // 3
    t.role === 'case' && t.is_default && ciEq(t.case_type, caseRow.case_type)
  ) || null;
}

/** PURE — the whole branch order, over an already-loaded template list. */
function _pickTemplate(templates, caseRow) {
  const intake = templates.find(t => t.role === 'intake') || null;
  if (!isCasePhase(caseRow)) return intake;                                // 1
  return _pickMatter(templates, caseRow) || intake;                        // 2 / 3 / 4
}

async function resolveTemplate(db, caseRow) {
  const [templates] = await db.query(TPL_SQL);
  return _pickTemplate(templates, caseRow);
}

/**
 * Resolve the template a case WOULD land on if its phase were 'case' — the
 * matter-axis answer, ignoring lifecycle. Used ONLY by _resolveTarget's
 * cross-phase search (see there); never by the read model.
 *
 * Returns null when no role='case' template matches, so a caller can tell
 * "no matter template" apart from "fell back to intake".
 */
async function resolveMatterTemplate(db, caseRow) {
  const [templates] = await db.query(TPL_SQL);
  return _pickMatter(templates, caseRow);
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
    `SELECT case_id, case_type, case_subtype, pipeline_phase
       FROM cases WHERE case_id = ?`,
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
 * Soft misses console.warn (with latestKey, passed by advanceStage, for
 * context): unlike a guard miss — the expected, high-volume, silent path —
 * an unresolved key under a passing guard is either the template-moved edge
 * or a TYPO in the caller's stage_key, and a typo that skips forever with no
 * signal would be an observability regression vs the old loud 400.
 *
 * @throws 400 on missing/unknown target or (when !soft) when no template
 *         resolves / the key is not in the template.
 */
async function _resolveTarget(conn, caseRow, target, { soft = false, latestKey = null } = {}) {
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

  const [templates] = await conn.query(TPL_SQL);
  const template = _pickTemplate(templates, caseRow);
  if (!template) {
    if (soft) {
      console.warn(
        `[pipeline] guarded advance unresolved: case=${caseRow.case_id} ` +
        `target="${s}" from=${latestKey == null ? 'null' : `"${latestKey}"`} ` +
        `template=none — skipped`
      );
      return null;
    }
    throw badRequest(
      `No pipeline template resolves for case ${caseRow.case_id} — ` +
      `cannot advance by stage_key "${s}" (numeric stage_id still works)`
    );
  }

  // T8 — CROSS-PHASE KEY SEARCH. The phase-resolved template is tried FIRST;
  // the case's MATTER template is the fallback. This is what makes the
  // intake→case transition self-bootstrapping, and it is load-bearing:
  //
  //   workflow 42 step 5 asks for 'retained' while the case is still phase
  //   'intake'. Phase resolution returns the Intake template, where
  //   `retained` is active=0 and unreachable. Without this fallback the
  //   retainer advance would resolve nothing and (being guarded) skip
  //   SILENTLY — every retention in the firm would stop being recorded.
  //   Same shape for api.intake.petition.js's 'filed' advance on a
  //   brand-new case.
  //
  // advanceStage then writes pipeline_phase from the ENTERED stage's
  // template role, so the very first case-template stage flips the case to
  // phase 'case' and every later read resolves there directly. No case
  // creator has to set the phase, and there is no chicken-and-egg.
  //
  // This does NOT open a back door into the case phase: `docs` and the other
  // post-retainer keys are only ever advanced by callers guarded
  // onlyFrom:['retained'] or an only_from list of case-phase keys, and the
  // intake keys don't exist on any case template, so the fallback can only
  // fire on a genuine lifecycle transition.
  //
  // Phase template first (ORDER BY) so a key present on BOTH — `retained`
  // lives on Intake (inactive) and on every chapter template — resolves
  // deterministically to where the case actually is.
  // Same single template load as above — no second round-trip.
  const matter = isCasePhase(caseRow) ? null : _pickMatter(templates, caseRow);
  const searchIds = matter && matter.id !== template.id
    ? [template.id, matter.id]
    : [template.id];

  const [[stage]] = await conn.query(
    `SELECT * FROM pipeline_stages
      WHERE template_id IN (${searchIds.map(() => '?').join(', ')})
        AND stage_key = ? AND active = 1
      ORDER BY (template_id = ?) DESC, template_id ASC
      LIMIT 1`,
    [...searchIds, s, template.id]
  );
  if (!stage) {
    if (soft) {
      console.warn(
        `[pipeline] guarded advance unresolved: case=${caseRow.case_id} ` +
        `target="${s}" from=${latestKey == null ? 'null' : `"${latestKey}"`} ` +
        `template="${template.name}" — skipped`
      );
      return null;
    }
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
 *                      case_rec = <stage default_rec>,
 *                      pipeline_phase = <entered stage's template role>
 *                                                       — overwrite-on-advance.
 *     (T8: the phase write is what makes _resolveTarget's cross-phase search
 *     a one-time bootstrap rather than a permanent crutch.)
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
 * ── RETURN IS POLYMORPHIC ────────────────────────────────────────────────
 * Two shapes, keyed by `skipped`:
 *   skipped:false → the full getPipeline payload (template/current/history/
 *                   upcoming/stages) + { noop, skipped:false } — today's
 *                   shape, plus the skipped key.
 *   skipped:true  → BARE { skipped:true, noop:false, from, reason } and
 *                   NOTHING else — no template, no history. Nothing was
 *                   written, so no getPipeline re-read is spent (the docs
 *                   hook fires on every upsert-items call and skips on most).
 *                   reason: 'guard'      — a guard didn't match (expected,
 *                                          high-volume, silent)
 *                           'unresolved' — guards passed but the stage_key
 *                                          doesn't exist in the case's
 *                                          current template (template moved,
 *                                          or a TYPO — console.warn fires)
 * Callers MUST branch on `skipped` before touching pipeline fields.
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
 * @returns see RETURN IS POLYMORPHIC above
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
        `SELECT case_id, case_type, case_subtype, pipeline_phase
           FROM cases WHERE case_id = ?`,
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

        if (!ok) return { noop: false, skipped: true, reason: 'guard', from: fromKey };
      }

      const stage = await _resolveTarget(conn, caseRow, target, {
        soft: guarded,
        latestKey: latest ? latest.stage_key : null,
      });
      if (!stage) {
        // soft mode only (guarded): key didn't resolve in the case's current
        // template — the case moved templates since its latest log row, or
        // the caller typo'd the key (_resolveTarget already warned).
        return { noop: false, skipped: true, reason: 'unresolved',
                 from: latest ? latest.stage_key : null };
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

      // T8 — the entered stage's OWNING template decides the case's phase.
      // Stage rows never move between templates, so this is the authoritative
      // lifecycle signal: entering any role='case' stage means retained,
      // entering any role='intake' stage means (back) in the funnel.
      // Sub-selected rather than carried in JS so it cannot drift from
      // pipeline_templates.role. A missing template row falls back to
      // 'intake' rather than leaving the phase alone — unreachable in
      // practice, since pipelineAdminService only hard-deletes a template
      // with zero case_stage_log references and the INSERT above has already
      // created one for this stage inside this transaction.
      const [[stageTpl]] = await conn.query(
        `SELECT role FROM pipeline_templates WHERE id = ?`, [stage.template_id]
      );
      const newPhase = stageTpl && stageTpl.role === 'case' ? 'case' : 'intake';

      // Overwrite-on-advance for all four (decided design). case_status is
      // varchar(50) — clip in JS; without strict mode the DB would clip
      // silently mid-word.
      await conn.query(
        `UPDATE cases SET case_stage = ?, case_status = ?, case_rec = ?, pipeline_phase = ?
          WHERE case_id = ?`,
        [
          stage.case_stage,
          clip(stage.internal_label, 50),
          clip(stage.default_rec == null ? '' : stage.default_rec, 128),
          newPhase,
          caseId,
        ]
      );

      // Success shape widened (Trigger T3): carry from/to details out of the
      // transaction for the case.stage_advanced emission. Existing consumers
      // branch on .skipped / .noop only — additive keys are safe.
      return {
        noop: false,
        from_stage:       latest ? latest.stage_key   : null,
        from_template_id: latest ? latest.template_id : null,
        to: {
          stage_id:       stage.id,
          template_id:    stage.template_id,
          stage_key:      stage.stage_key,
          case_stage:     stage.case_stage,
          internal_label: stage.internal_label,
        },
        case_type:    caseRow.case_type,
        case_subtype: caseRow.case_subtype,
      };
    } finally {
      // Guarded: a dead connection releases its named locks on close, and an
      // unguarded throw here would mask the real error from the try block.
      try { await conn.query(`SELECT RELEASE_LOCK(?)`, [lockKey]); }
      catch (_) { /* see comment above */ }
    }
  });

  if (outcome.skipped) {
    // Nothing was written — no getPipeline re-read, no Slice E dispatch.
    // Deliberately minimal shape: { skipped, noop, from, reason }. The HTTP
    // route never passes guards, so this shape never reaches the frontends;
    // the guarded callers (doc-request advance, retainer send/sign) branch
    // on .skipped and want exactly this.
    return { skipped: true, noop: false, from: outcome.from, reason: outcome.reason };
  }

  if (!outcome.noop) {
    // ── Slice E insertion point — LIVE (Trigger System T3) ───────────────
    // Fire-and-forget, strictly AFTER commit: the case.stage_advanced domain
    // event feeds trigger_rules (stage-change log, hooks, workflows, …).
    // Must stay post-commit (never inside the transaction — withTransaction
    // may retry the callback) and must never fail the advance —
    // domainEvents.emit never throws.
    domainEvents.emit(db, 'case.stage_advanced', {
      case_id: String(caseId),
      source,
      actor: { user_id: userId ?? 0 },
      data: {
        stage_key:    outcome.to.stage_key,
        stage_id:     outcome.to.stage_id,
        template_id:  outcome.to.template_id,
        case_stage:   outcome.to.case_stage,
        status_label: outcome.to.internal_label,
        case_type:    outcome.case_type,
        case_subtype: outcome.case_subtype,
      },
      extra: {
        from_stage:       outcome.from_stage,
        from_template_id: outcome.from_template_id,
        note: note || null,
      },
    });
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
  resolveMatterTemplate,
  getPipeline,
  advanceStage,
  resolveStageField,
};