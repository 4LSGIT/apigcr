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
 * ref/2026-08-02_pipeline_engine_slice_a.sql (Slice A, shipped 2026-08-02);
 * pipeline_stages.lane — ref/2026-08-25_pipeline_lane.sql (R1).
 *
 * R1 — THE LANE AXIS. pipeline_stages is a flat ordered list, so an off-ramp
 * (no_show, dead_lead, dismissed, appeal, …) can only be given a
 * stage_number, and whatever number it gets makes it "upcoming" for every
 * case below it. `lane` separates the two questions: `main` is the ordered
 * happy path and is the ONLY thing getPipeline projects as upcoming;
 * `offramp` is reachable from anywhere and is never projected as next.
 * PROJECTION ONLY — history and current are lane-agnostic, because a case
 * that is at `appeal` is at `appeal`. Off-ramps also stay in the `stages`
 * list (C1 contract), because the board, the timeline and the advance picker
 * all need them. advanceStage's forwardOnly guard reads the same axis.
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

/**
 * R1 — the PROJECTION axis. True unless the stage is explicitly an off-ramp.
 *
 * Deliberately "not exactly 'offramp'" rather than "=== 'main'", mirroring
 * isCasePhase above and for the same reason: the session lacks
 * STRICT_TRANS_TABLES, so an invalid ENUM write lands as '' silently, and a
 * pre-migration row (or a stub fixture) carries undefined. Every one of those
 * reads as MAIN — a stage stays on the happy path and stays projected. The
 * opposite default would let a coerced value silently delete a stage from
 * every case's upcoming list, which is exactly the failure lane exists to
 * prevent.
 */
function isMainLane(stage) {
  return String(stage && stage.lane != null ? stage.lane : '')
    .trim().toLowerCase() !== 'offramp';
}
const isOfframp = (stage) => !isMainLane(stage);

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
 *   upcoming — active MAIN-LANE stages of the resolved template with
 *              stage_number greater than the current stage's. Current is
 *              matched to the template by stage_key, NOT stage_id — history
 *              survives template edits by design. When current is null OR its
 *              stage_key is not in the resolved template (case just branched
 *              from intake), upcoming is ALL of the template's active
 *              main-lane stages.
 *
 *              R1 — THE LANE FILTER. Off-ramps (no_show, dead_lead,
 *              dismissed, appeal, …) are reachable from anywhere in a
 *              template, so they have no correct position on the single
 *              numeric axis stage_number provides. They carry high
 *              stage_numbers only because they were appended last, which made
 *              them "upcoming" for every case below them: a lead at
 *              consult_booked was told Dead Lead was next, and an adversary
 *              proceeding at judgment was told On Appeal was next — the
 *              latter through the CLIENT PORTAL, since `appeal` is
 *              client_visible=1. lane='offramp' removes them from the
 *              PROJECTION only. See `history`/`current` below.
 *   stages   — ALL active stages of the resolved template, BOTH LANES (same
 *              projection as upcoming), regardless of position. Always present
 *              ([] when template is null). UI uses it for full-timeline
 *              rendering (client_label on past/current rows) and the
 *              show-all-stages advance control; C1 contract as of 2026-08-02.
 *              Both lanes is part of that contract and R1 does not narrow it:
 *              the board needs off-ramp columns, the widget needs off-ramp
 *              labels for history rows, and the advance picker must be able to
 *              SELECT an off-ramp. Projection includes client_visible (portal
 *              filters on it; staff surfaces may ignore it) and, as of R1,
 *              `lane` (surfaces that group or divide by it).
 *   history  — see above. LANE-AGNOSTIC, by design, as is `current`: a case
 *              that is AT `appeal` is at `appeal`, and saying so is a true
 *              statement about its position. lane governs what we project as
 *              NEXT, never where a case is. portalCaseService
 *              .buildClientTimeline keys its visible-stage map off `stages`
 *              (both lanes) and its upcoming off `upcoming` (main only), so it
 *              inherits exactly this split with no portal code change.
 *
 * (R2) opts.requirements — OPT-IN ONLY. When true, each stage row in
 * `stages` gains `requirements: [...]` (requirementService
 * .resolveRequirements output filtered to that stage_id) and the payload
 * gains NOTHING else. Resolved requirements whose stage is NOT in `stages`
 * (the intake template's, for a phase='case' case) are deliberately absent
 * from THIS payload — its shape is stage-anchored; R3 consumes
 * resolveRequirements directly for the cross-template picture. The DEFAULT
 * payload is byte-identical to pre-R2 (C1 contract — asserted in tests):
 * no opt, no extra queries, not even the require (lazy, the
 * internal_functions circular-dep-safety convention — requirementService
 * requires this file for _pickTemplate).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.requirements=false] attach resolved requirements
 *        per stage (see above).
 * @throws 404 when the case does not exist.
 */
async function getPipeline(db, caseId, { requirements = false } = {}) {
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
              client_label, case_stage, is_terminal, lane, default_rec, client_visible
         FROM pipeline_stages
        WHERE template_id = ? AND active = 1
        ORDER BY stage_number ASC, id ASC`,
      [template.id]
    );
    stages = stageRows;              // BOTH lanes — C1 contract, see docblock
    const mainOnly = stageRows.filter(isMainLane);
    const matched = current
      ? stageRows.find(s => s.stage_key === current.stage_key)
      : null;
    // Matching is against BOTH lanes (a case sitting on an off-ramp still has
    // a position), but the projection is main-lane only. A case at `appeal`
    // (#8) therefore keeps `appeal` as its current and gets the main stages
    // numerically after it as upcoming.
    upcoming = matched
      ? mainOnly.filter(s => s.stage_number > matched.stage_number)
      : mainOnly;   // no history yet, or branched from another template
  }

  if (requirements) {
    // Lazy require — see the opts.requirements docblock note.
    const { resolveRequirements } = require('./requirementService');
    const byCase = await resolveRequirements(db, [caseId]);
    const resolved = byCase.get(String(caseId)) || [];
    for (const s of stages) {
      s.requirements = resolved.filter((r) => Number(r.stage_id) === Number(s.stage_id));
    }
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
 * Guards (Slice E1; forwardOnly added R1) — all optional. onlyFrom /
 * onlyFromRole are consulted BEFORE target resolution (inside the same lock +
 * transaction, so the read-then-write window is race-free); forwardOnly is
 * consulted AFTER resolution, because it is a comparison between two stage
 * ROWS and cannot be evaluated until the target is one. When any guard fails
 * to match, the advance is SKIPPED: no INSERT, no UPDATE, no throw — the
 * return is { skipped: true, noop: false, from: <current stage_key or null>,
 * reason } and the lock still releases (finally). When SEVERAL guards are
 * given, ALL must pass.
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
 *   forwardOnly  boolean. "Advance, but never regress." Lets an automation
 *                express monotonicity WITHOUT enumerating every legal
 *                from-state in an onlyFrom list — the list an author has to
 *                remember to extend every time a stage is added, and whose
 *                omission is invisible (a stale list just skips forever).
 *
 * ── forwardOnly: THE COMPARISON ──────────────────────────────────────────
 * Runs AFTER the idempotency check, never before: a repeat of the case's
 * current stage is a NOOP, exactly as it is unguarded. It is never
 * reinterpreted as a backward skip — the two answers differ (noop:true vs
 * skipped:true) and callers branch on both.
 *
 * The comparison needs the LATEST log row's STAGE ROW, fetched by
 * (latest.template_id, latest.stage_key) — key-based matching, consistent
 * with the rest of the engine, since history survives template edits.
 *
 *   no latest log row .......................... PASS (nothing to regress from)
 *   latest's stage row not found ............... SKIP 'unresolved' + warn
 *       (key renamed, or the stage was deleted out from under the log row —
 *       the same class of condition _resolveTarget's soft miss warns about,
 *       and warned about for the same reason: it is either a real template
 *       edit or a bug, and neither should skip forever in silence)
 *   CROSS-TEMPLATE (target.template_id !== latest.template_id)
 *     intake → case ............................ PASS — this IS the bootstrap
 *       (_resolveTarget's cross-phase search exists to make it happen; a
 *       forwardOnly guard must not be the thing that blocks retention)
 *     case → intake ............................ SKIP 'backward'
 *     same role (matter-type change) ........... PASS
 *       DECIDED, do not "improve": stage_numbers are per-template ordinals.
 *       Ch7 #3 and Ch13 #3 are not the same milestone, so comparing them is
 *       meaningless, not merely imprecise.
 *     either template row missing .............. PASS
 *       Unreachable in practice: pipelineAdminService hard-deletes a template
 *       only at ZERO case_stage_log references, and `latest` IS such a
 *       reference. Passing (rather than skipping) keeps an impossible state
 *       from silently disarming retention if it ever becomes possible.
 *   SAME TEMPLATE
 *     target lane 'offramp' .................... PASS
 *       Entering an off-ramp is legal from anywhere in the template,
 *       INCLUDING offramp → offramp: the no-show sequence genuinely ends
 *       no_show → dead_lead. DECIDED.
 *     latest lane 'offramp', target 'main' ..... SKIP 'backward'
 *       Recovery from an off-ramp back onto the happy path is a real
 *       operation, but it is a deliberate one — explicit-guard or unguarded
 *       territory, not something a monotonic automation should do by itself.
 *     main → main .............................. PASS iff
 *                                                target.stage_number >
 *                                                latest.stage_number,
 *                                                else SKIP 'backward'
 *
 * Guarded advances also resolve the target SOFTLY: a stage_key that doesn't
 * exist in the case's currently-resolved template (or a case with no template
 * at all) is a skip, not a 400 — see _resolveTarget's soft mode. forwardOnly
 * COUNTS AS GUARDED for this purpose, so a forwardOnly-only caller gets soft
 * resolution and the bare skip shape like every other guarded caller.
 * Unguarded calls keep today's throwing behavior exactly.
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
 *                                          or a TYPO — console.warn fires);
 *                                          also the forwardOnly case where the
 *                                          LATEST row's stage has vanished
 *                           'backward'   — (R1) guards passed and the target
 *                                          resolved, but forwardOnly judged
 *                                          the move a regression
 * Callers MUST branch on `skipped` before touching pipeline fields, and
 * MUST NOT assume the reason set is closed — it has grown once already.
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
 * @param {?boolean} [opts.forwardOnly=false]       see Guards above
 * @returns see RETURN IS POLYMORPHIC above
 * @throws 400 unknown target / bad source / malformed guard; 404 unknown
 *         case; 409 lock timeout (retryable).
 */
async function advanceStage(db, caseId, target, {
  userId = null, note = null, source = 'manual',
  onlyFrom = undefined, onlyFromRole = undefined, forwardOnly = false,
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
  // forwardOnly is a BOOLEAN, and only the boolean arms it. A caller that
  // hands over a string ('true', 'false', '0') gets a 400 rather than a
  // silent disarm: `forwardOnly === true` would read every one of those as
  // "guard absent", and a safety guard that quietly stops being applied is
  // the failure mode this codebase treats as fatal (the rule-12 postmortem
  // that produced _csvGuard's quote rejection). null/undefined stay absent,
  // matching the array guards above. The string→boolean parse lives ONE
  // layer up, in lib/internal_functions/pipeline.js, where the automation
  // vocabulary ('true'/'1'/'yes') is defined and documented.
  if (forwardOnly != null && typeof forwardOnly !== 'boolean') {
    throw badRequest(
      `forwardOnly must be a boolean when provided (got ${typeof forwardOnly}) — ` +
      `parse automation strings before calling, so a typo cannot silently ` +
      `disarm the guard`
    );
  }
  const forward = forwardOnly === true;
  const guarded = onlyFrom != null || onlyFromRole != null || forward;

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
      //
      // DELIBERATELY BEFORE the forwardOnly comparison. A repeat is a NOOP,
      // never a backward skip: the two outcomes are different answers to
      // different questions ("nothing to do" vs "I refused"), and callers
      // branch on both. Reversing the order would turn every idempotent
      // re-fire of a forwardOnly automation into a skip — the same event
      // arriving twice would start reporting a refusal.
      if (latest &&
          latest.stage_key === stage.stage_key &&
          latest.template_id === stage.template_id) {
        return { noop: true };
      }

      // ── forwardOnly (R1) ───────────────────────────────────────────────
      // "Advance, never regress", without enumerating from-states. Full
      // verdict table in the docblock. No latest row → nothing to regress
      // from → pass, with zero extra queries.
      if (forward && latest) {
        // Latest's STAGE ROW by (template_id, stage_key) — key-based, like
        // every other history↔template match in the engine. No active filter:
        // a case can legitimately be sitting on a stage that was since
        // deactivated, and that is still its position.
        const [[latestStage]] = await conn.query(
          `SELECT stage_number, lane FROM pipeline_stages
            WHERE template_id = ? AND stage_key = ? LIMIT 1`,
          [latest.template_id, latest.stage_key]
        );

        if (!latestStage) {
          // The log row points at a stage that no longer exists under that
          // key — renamed, or deleted. We cannot compare, and guessing in
          // either direction is worse than saying so. Warned for the same
          // reason _resolveTarget warns on a soft miss: silence here would
          // make a real template edit indistinguishable from a working guard.
          console.warn(
            `[pipeline] forwardOnly unresolved: case=${caseId} ` +
            `target="${stage.stage_key}" from="${latest.stage_key}" ` +
            `(template ${latest.template_id}) — latest stage row not found, skipped`
          );
          return { noop: false, skipped: true, reason: 'unresolved',
                   from: latest.stage_key };
        }

        if (stage.template_id !== latest.template_id) {
          // CROSS-TEMPLATE. stage_numbers are per-template ordinals and are
          // NOT comparable across templates, so the only judgement available
          // is the lifecycle one: role. Both roles in ONE query — the ids may
          // be equal-by-accident nowhere here (we're inside the !== branch),
          // so IN(?,?) always asks for two distinct rows.
          const [roleRows] = await conn.query(
            `SELECT id, role FROM pipeline_templates WHERE id IN (?, ?)`,
            [latest.template_id, stage.template_id]
          );
          const roleOf = (id) => {
            const r = roleRows.find(x => Number(x.id) === Number(id));
            return r ? r.role : null;
          };
          const latestRole = roleOf(latest.template_id);
          const targetRole = roleOf(stage.template_id);

          // The ONLY cross-template regression is falling out of the case
          // phase back into the funnel. Everything else passes:
          //   intake → case  the retention bootstrap (must never be blocked)
          //   case   → case  a matter-type change; incomparable, so allowed
          //   either role unknown  a missing template row — unreachable while
          //                        `latest` references it; pass rather than
          //                        let an impossible state disarm retention.
          if (latestRole === 'case' && targetRole === 'intake') {
            return { noop: false, skipped: true, reason: 'backward',
                     from: latest.stage_key };
          }
          // pass — fall through to the write
        } else if (isMainLane(stage)) {
          // SAME TEMPLATE, entering the MAIN lane. (Entering an off-ramp is
          // legal from anywhere in the template — including from another
          // off-ramp, which is how the no-show sequence ends
          // no_show → dead_lead — so the offramp target case is the `if`
          // this else-branch excludes, and needs no code.)
          if (isOfframp(latestStage)) {
            // Off-ramp → main is RECOVERY. Real, but a deliberate act; not
            // something a monotonic automation gets to do on its own.
            return { noop: false, skipped: true, reason: 'backward',
                     from: latest.stage_key };
          }
          if (!(Number(stage.stage_number) > Number(latestStage.stage_number))) {
            // Equal numbers land here too: the SAME stage was already
            // returned as a noop above, so equality means two DIFFERENT
            // stages share an ordinal — not forward, so not allowed.
            return { noop: false, skipped: true, reason: 'backward',
                     from: latest.stage_key };
          }
        }
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
      //
      // Computed ONCE into locals because two consumers need them and they
      // must not drift: the UPDATE below, and `written` in the success shape
      // (the sync bus announces these values to every open frame). Clipping
      // twice, or announcing stage.internal_label instead of the clipped
      // case_status, would broadcast a value the DB does not hold — every
      // frame would paint a longer status than the row carries and disagree
      // with the next GET. `written` is BYTE-IDENTICAL to the UPDATE's
      // parameters, by construction.
      const wCaseStage = stage.case_stage;
      const wCaseStatus = clip(stage.internal_label, 50);
      const wCaseRec = clip(stage.default_rec == null ? '' : stage.default_rec, 128);

      await conn.query(
        `UPDATE cases SET case_stage = ?, case_status = ?, case_rec = ?, pipeline_phase = ?
          WHERE case_id = ?`,
        [
          wCaseStage,
          wCaseStatus,
          wCaseRec,
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
        // Exactly what the UPDATE above wrote to `cases`, for the sync bus.
        // NOT the same thing as `to` — `to` describes the STAGE (its key, its
        // template, its unclipped internal_label); `written` describes the
        // CASE ROW. They differ wherever clipping bites and wherever a column
        // name differs from the stage field it came from.
        written: {
          case_stage:     wCaseStage,
          case_status:    wCaseStatus,
          case_rec:       wCaseRec,
          pipeline_phase: newPhase,
        },
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
  // Sync bus (public/js/yc-sync.js): the four cases columns overwrite-on-
  // advance just wrote. Plain {field: value} — the bus normalizes both that
  // and the {from,to} API diff shape. Additive: existing consumers branch on
  // .skipped / .noop and never enumerate keys.
  //
  // ONLY on a real advance. A noop wrote nothing, and announcing values
  // nobody changed would make every open frame repaint (and the Cases tab
  // refetch) for a button press that did nothing. The skipped path returns
  // above and never reaches here.
  if (!outcome.noop) payload.changes = outcome.written;
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
  // (R2) internal handle — requirementService reuses the EXACT template
  // resolution getPipeline performs rather than re-deriving it. Pure
  // function over an already-loaded template list; underscore-prefixed by
  // the esignService internal-handle convention.
  _pickTemplate,
};