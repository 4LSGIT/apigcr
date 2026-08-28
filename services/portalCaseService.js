// services/portalCaseService.js
//
/**
 * portalCaseService.js — Client Portal Slice 2 + E1: read-only case status.
 *
 * Backs routes/portal.cases.js. Owns:
 *   - listCases   — the contact's Primary/Secondary cases, list-shaped.
 *   - getCaseView — one case with the client-facing pipeline timeline plus
 *                   the configurable cards array (E1 card engine);
 *                   returns null when out of scope (route → uniform 404).
 *
 * E1 (card engine): the payload gains `cards` from
 * lib/portalCardEngine.renderCards — the configurable replacement for the
 * previously hardcoded payment + 341 cards. The 341 card's GATES (BK-only,
 * past-date suppression) now live SOLELY in the engine's conditions (the
 * seeded meeting341 row — ref/2026-08-07_portal_cards_e1.sql translates the
 * shipped gates exactly); this service no longer applies them. Double-gating
 * hides bugs — the engine decides whether the 341 card appears, and
 * formatMeeting341 below is a pure FORMATTER included when (and only when)
 * that card passed. Parity with pre-E1 output is pinned by
 * tests/portalCardEngine.test.js.
 *
 * HARD INVARIANTS (portal contract — violating any is a defect):
 *   - Hidden stages never leave the server. ALL client_visible filtering
 *     happens here; the payload carries no trace of hidden stages.
 *   - Client vocabulary only: client_label, never internal_label. Labels
 *     come from the resolved template at read time — staff edit them live
 *     in the admin UI, nothing is hardcoded.
 *   - Projection whitelists only. Never SELECT cases.* / contacts.*.
 *     The payload contains EXACTLY the specced fields — in particular NO
 *     case_status (internal vocabulary), NO internal_label, NO log-row
 *     note / entered_by / source / status_label, no stage_keys or ids,
 *     no internal user ids.
 *   - Docket values (case_number, case_number_full) are OPAQUE free-text:
 *     display-only passthrough — never parsed, validated, or split.
 *   - Out-of-scope is indistinguishable from nonexistent: getCaseView
 *     returns null for both (manage.js philosophy; route emits one 404).
 *
 * Visibility rules (ratified 2026-08-06 — fixed, not relaxable here):
 *   - Portal shows ONLY stages with client_visible = 1, labeled by
 *     client_label.
 *   - History rows whose stage is client_visible = 0 OR absent from the
 *     resolved template (e.g. branched-from-intake rows): skipped silently.
 *   - "Current" is the LATEST history row whose stage is visible in the
 *     resolved template; if none qualifies, the timeline has NO current
 *     marker — never a hidden-stage fallback.
 *
 * Pipeline source of truth: services/pipelineService.getPipeline — reused
 * per case (clients have 1–3 cases; N is small, one source of truth beats a
 * parallel query). Its `upcoming` is computed from the case's REAL latest
 * log row (hidden or not); the portal filters that list to visible stages
 * rather than recomputing from the visible current — this keeps upcoming
 * anchored to the case's true position without ever naming the hidden stage
 * (skipped stages stay skipped; no phantom "still coming" entries).
 *
 * (R3.1) A LEAD's `upcoming` ends at the last intake stage — which is not the
 * end of what we can honestly tell that client, because the next pipeline is
 * a DIFFERENT TEMPLATE the case has not entered. getPipeline's R2.5
 * `projected` block supplies that continuation, and BOTH client surfaces
 * built here now end with it: the "Your next steps" card and the Case
 * Progress timeline. They read it through ONE helper (projectedLabels), so
 * two views stacked on the same page cannot disagree about what comes next.
 *
 * Dates: case_stage_log.entered_at is real UTC (DEFAULT CURRENT_TIMESTAMP;
 * see services/timezoneService.js column reference — NOW() columns are UTC).
 * The portal emits firm-local DATE-ONLY strings (YYYY-MM-DD, FIRM_TIMEZONE)
 * — no times, no client-side timezone math.
 *
 * Conventions: every function takes the mysql2 pool (req.db) first; errors
 * carry `.status` where meaningful (pipelineService pattern).
 */

'use strict';

const pipelineService = require('./pipelineService');
const requirementService = require('./requirementService');
const portalCardEngine = require('../lib/portalCardEngine');
const { utcToLocal } = require('./timezoneService');

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** entered_at (real-UTC Date/string from mysql2) → firm-local 'YYYY-MM-DD'. */
function toLocalIsoDate(enteredAt) {
  if (!enteredAt) return null;
  const local = utcToLocal(enteredAt);
  return local && local.isValid ? local.toISODate() : null;
}

/**
 * Client-facing title. S2-locked vocabulary:
 *   chapter non-empty → "Chapter {chapter} {case_type || 'Bankruptcy'}"
 *   else case_type; final fallback 'Your Case'.
 * (Live data 2026-08-06: chapter is only ever set alongside
 * case_type='Bankruptcy', so the concatenation reads "Chapter 7 Bankruptcy".)
 */
function deriveTitle(caseRow) {
  const chapter = String(caseRow.case_chapter == null ? '' : caseRow.case_chapter).trim();
  const type = String(caseRow.case_type == null ? '' : caseRow.case_type).trim();
  if (chapter) return `Chapter ${chapter} ${type || 'Bankruptcy'}`;
  if (type) return type;
  return 'Your Case';
}

/** Opaque docket passthrough — full form preferred, short fallback, else null.
 *  NEVER parsed / validated / split (case-number principle). */
function deriveDocket(caseRow) {
  return caseRow.case_number_full || caseRow.case_number || null;
}

/**
 * S2.1 (D8), reshaped by E1: the client-facing 341 block — now a pure
 * FORMATTER. The former gates (BK-exclusivity, past-date suppression) moved
 * VERBATIM onto the meeting341 card's engine conditions
 * (ref/2026-08-07_portal_cards_e1.sql — the single place they live;
 * double-gating hides bugs, per the E1 ruling). getCaseView calls this only
 * after the engine has passed the card; parity with the pre-E1 gated output
 * is pinned by tests/portalCardEngine.test.js.
 *
 * case_341_current is FIRM-LOCAL WALL TIME (apptService writes appt_date —
 * the local column — into it; live values sit at 8:30a–1:00p). mysql2
 * (timezone:'Z') hands it back as a fake-UTC Date whose naive components
 * ARE the firm-local wall clock — so this reads the components with NO
 * timezone conversion (formatLocal semantics), unlike the S2 timeline
 * dates, which are real UTC. The engine's date_future operator reads the
 * column the SAME naive way — the two stay in lockstep by design.
 *
 * Manager ruling 2026-08-06 (still binding):
 *   - NO status wording. Live `341_status` reads 'Continued' on 100% of
 *     rows (NOT-NULL enum, no default → first member is the de-facto unset
 *     state), so any mapping from it would put a false statement on nearly
 *     every card. When the write path becomes trustworthy, a server-side
 *     mapping drops in here with zero client change.
 *   - `link` (Fred ruling: link in): case_341_link passes through only when
 *     it is a real http(s) URL — staff-entered varchar; the scheme guard
 *     keeps '' and non-URL junk out of an href. The link only exists inside
 *     the card, so it is suppressed with the card.
 *
 * Formatting-integrity nulls remain (no 341 value / unparseable value →
 * null): those are "nothing safe to format", not gates. getCaseView treats a
 * null here on a PASSED card as a defect signal and drops the card
 * (fail-closed) rather than shipping an empty coded card.
 *
 * @returns {{ date:string, time:string, link:string|null } | null}
 *          date 'YYYY-MM-DD', time 'HH:mm' — both firm-local wall values.
 */
function formatMeeting341(caseRow) {
  if (!caseRow.case_341_current) return null;

  const d = caseRow.case_341_current instanceof Date
    ? caseRow.case_341_current
    : new Date(caseRow.case_341_current);
  if (isNaN(d.getTime())) return null;

  const naive = d.toISOString().slice(0, 19);   // firm-local wall clock
  const date = naive.slice(0, 10);
  const time = naive.slice(11, 16);

  const rawLink = String(caseRow.case_341_link == null ? '' : caseRow.case_341_link).trim();
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : null;

  return { date, time, link };
}

/** True only for an explicit visible flag (tinyint 1 / boolean true). */
function isVisible(stage) {
  return stage.client_visible === 1 || stage.client_visible === true;
}

/**
 * (R2.5 source, R3.1 shared) THE SINGLE READER of `pipeline.projected` —
 * the client-visible labels of the forward projection, or [] when there is
 * no projection, it is malformed, or nothing in it is visible.
 *
 * Both surfaces that show the projection call this: buildNextSteps (the R3
 * card's greyed tail) and buildClientTimeline (the R3.1 timeline tail). One
 * reader means the two can never disagree about what the projection says —
 * which matters more than the four lines it saves, because they render one
 * above the other on the same page and a divergence would be visible.
 *
 * Read for LABELS ONLY. Projected stages belong to a template the case has
 * NOT entered: they carry no stage_id and no requirements, so they can never
 * become steps or timeline history. client_visible + client_label, the same
 * whitelist as everything else that reaches a client — and NEVER the
 * projection's `source` or `template.name`: a client is not shown a template
 * name, subtype-matched or generic (ratified).
 *
 * Truthiness, not `'projected' in pipeline`, on purpose: this answers "what
 * does the projection SAY", and a null/malformed one says nothing. Whether
 * the KEY is emitted at all is the caller's decision — see
 * buildClientTimeline.
 *
 * @param {object} pipeline getPipeline payload
 * @returns {{label:string}[]}
 */
function projectedLabels(pipeline) {
  const out = [];
  const proj = pipeline && pipeline.projected;
  if (!proj || !Array.isArray(proj.stages)) return out;
  for (const s of proj.stages) {
    if (!isVisible(s)) continue;
    const l = String(s.client_label == null ? '' : s.client_label).trim();
    if (l) out.push({ label: l });
  }
  return out;
}

/**
 * THE shared visibility/label/current helper — the single place the ratified
 * rules are applied. Used by both listCases and getCaseView.
 *
 * (R3.1) FORWARD TAIL. When getPipeline shipped a `projected` block — i.e.
 * the case resolved to the INTAKE template, so it is a LEAD — the timeline
 * gains a `projected` array of the projection's client-visible labels. This
 * closes the gap where a lead's Case Progress stopped at the last intake
 * stage while the "Your next steps" card directly above it was already
 * showing the continuation: two answers to "what happens next" on one page,
 * one of them truncated.
 *
 * THE KEY IS ABSENT (not empty, not null) whenever `projected` is absent from
 * the pipeline payload, so a phase='case' view is byte-identical to pre-R3.1
 * and a pre-R2.5 server is too. Feature test is `'projected' in pipeline`,
 * mirroring the contract getPipeline states for its own emission — the
 * CONTENT is then read by projectedLabels, the same reader buildNextSteps
 * uses.
 *
 * These are POSSIBILITIES, not history: they carry a label and nothing else —
 * no date (there is none; the case has not entered that template) and no
 * position among `done`/`current`/`upcoming`. They are a separate key rather
 * than flagged entries appended to `upcoming` precisely because a consumer
 * that forgot the flag would present a possibility as a commitment;
 * `upcoming` stays exactly what it has always been.
 *
 * @param {object} pipeline getPipeline payload
 *                          ({ template, current, history, upcoming, stages }
 *                           + `projected` on intake-resolved cases)
 * @returns {{ done: {label:string, date:string|null}[],
 *             current: {label:string, since:string|null} | null,
 *             upcoming: {label:string}[],
 *             projected?: {label:string}[] }}
 */
function buildClientTimeline(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];

  // Visible template stages, keyed by stage_key (history↔template matching
  // is by stage_key by design — history survives template edits).
  const visibleByKey = new Map();
  for (const s of stages) {
    if (isVisible(s)) visibleByKey.set(s.stage_key, s);
  }

  // History → visible rows only (client_visible=0 and absent-from-template
  // rows skip silently). getPipeline history is already ascending.
  const visibleHistory = [];
  for (const h of Array.isArray(pipeline.history) ? pipeline.history : []) {
    const stage = visibleByKey.get(h.stage_key);
    if (!stage) continue;
    visibleHistory.push({
      label: stage.client_label,
      date: toLocalIsoDate(h.entered_at),
    });
  }

  // Ratified current rule: latest VISIBLE history row, else no marker.
  let current = null;
  let done = visibleHistory;
  if (visibleHistory.length) {
    const latest = visibleHistory[visibleHistory.length - 1];
    current = { label: latest.label, since: latest.date };
    done = visibleHistory.slice(0, -1);
  }

  // Upcoming: getPipeline's real-position upcoming, filtered to visible.
  const upcoming = [];
  for (const s of Array.isArray(pipeline.upcoming) ? pipeline.upcoming : []) {
    if (visibleByKey.has(s.stage_key)) upcoming.push({ label: s.client_label });
  }

  const timeline = { done, current, upcoming };

  // (R3.1) The forward tail — see the docblock. KEY PRESENCE mirrors
  // getPipeline's own contract: emitted iff the payload carries `projected`,
  // so every non-intake view keeps the exact three-key shape it has shipped
  // since S2. An intake payload whose projection is malformed or entirely
  // hidden emits `projected: []` — the key is a statement that this case HAS
  // a forward view, and "[] visible entries" is a different fact from "no
  // forward view exists".
  if (pipeline && 'projected' in pipeline) {
    timeline.projected = projectedLabels(pipeline);
  }

  return timeline;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Your next steps" (R3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The client-facing WORK LIST — stages are positions, requirements are the
 * parallel work items inside them, and this card is the only surface that
 * tells a client what THEY still have to do.
 *
 * ── THE SET ──────────────────────────────────────────────────────────────
 * Client-visible requirements of the CURRENT + UPCOMING MAIN-LANE stages,
 * ordered stage → sort_order. Deliberately NOT the whole resolver output:
 *   - Requirements of stages the case has already left are history, and a
 *     client asking "what do I still have to do" is not asking for a
 *     changelog. (They are also, structurally, exactly the intake-template
 *     rows on a phase='case' case — resolved `skipped`/`done`.)
 *   - `upcoming` arrives ALREADY main-lane-filtered from getPipeline (R1),
 *     so off-ramps cannot enter through it. The CURRENT stage is checked
 *     against `stages` for its own lane: a case sitting on an off-ramp is
 *     at a legitimate position, but "your next steps" is a statement about
 *     the happy path, and Dismissed has no next step to offer.
 *
 * ── WHAT IS HIDDEN ───────────────────────────────────────────────────────
 * `skipped` and `na` never reach a client (v1, frozen). A skipped step is
 * work the case moved past without doing; an `na` is staff saying it does
 * not apply. Both are true and neither is the client's business — showing
 * either invites "why does it say I skipped something?".
 *
 * ── THE SINGLE ACTIVE-NOW RULE (frozen) ──────────────────────────────────
 * EXACTLY ONE or ZERO steps carry `active_now`. It is the first step, in
 * render order, that is simultaneously status='active', required=1 and
 * owner='client'. The three conditions are all load-bearing:
 *   status  — an upcoming step is not actionable yet.
 *   required— an optional step must never be the one thing we point at.
 *   owner   — staff/system steps still RENDER (the client should see that
 *             the 341 date is coming) but can never be the client's ask.
 *             Their subtitle comes from `hint` ("Set by the court after
 *             filing"), which is authored for exactly this.
 * One chip, because two "do this now"s is no instruction at all.
 *
 * ── VOCABULARY / PROJECTION ──────────────────────────────────────────────
 * client_label ONLY. A client_visible requirement with a NULL client_label
 * is a config hole, and the portal's answer to a config hole is silence,
 * never a fallback to internal_label: the step is DROPPED (and drops out of
 * the header count with it) and a warn is logged for staff. No
 * requirement_key, no stage_key, no ids — the same whitelist discipline the
 * timeline follows.
 *
 * ── DATES ────────────────────────────────────────────────────────────────
 * satisfied_at is real UTC (detector timestamps and override updated_at
 * alike), so it goes through toLocalIsoDate — the SAME firm-local date-only
 * conversion the timeline uses. No new formatter, no client-side tz math.
 *
 * @param {object} pipeline getPipeline payload
 * @param {object[]} resolved resolveRequirements output for this case,
 *        already filtered to client_visible (clientOnly:true).
 * @returns {{ remaining:number,
 *             steps: {done:boolean, active_now:boolean, kind:string,
 *                     number:number|null, label:string,
 *                     subtitle:string|null, date:string|null}[],
 *             projected: {label:string}[] } | null}
 *          null when there is nothing to show — the card is absent from the
 *          payload and the page falls back to the timeline alone. An empty
 *          shell would be worse than no card.
 */
function buildNextSteps(pipeline, resolved) {
  const list = Array.isArray(resolved) ? resolved : [];
  if (!list.length) return null;

  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  const byStageId = new Map(stages.map((s) => [Number(s.stage_id), s]));

  // Ordered stage ids: the current stage (only if it is main-lane and in the
  // resolved template), then getPipeline's already-main-lane-only upcoming.
  const stageIds = [];
  const cur = pipeline.current
    ? stages.find((s) => s.stage_key === pipeline.current.stage_key)
    : null;
  // Same "not exactly offramp" default as pipelineService.isMainLane: a stage
  // with no lane (pre-migration row, stub fixture) is main.
  const isMain = (s) =>
    String(s && s.lane != null ? s.lane : '').trim().toLowerCase() !== 'offramp';
  if (cur && isMain(cur)) stageIds.push(Number(cur.stage_id));
  for (const s of Array.isArray(pipeline.upcoming) ? pipeline.upcoming : []) {
    const id = Number(s.stage_id);
    if (!stageIds.includes(id) && byStageId.has(id)) stageIds.push(id);
  }
  if (!stageIds.length) return null;

  // Bucket by stage, preserving the resolver's within-stage order
  // (stage_number, sort_order, id) — nothing is re-sorted here.
  const inScope = [];
  for (const id of stageIds) {
    for (const r of list) {
      if (Number(r.stage_id) === id) inScope.push(r);
    }
  }

  const steps = [];
  let remaining = 0;
  let numbered = 0;
  let activeTaken = false;

  for (const r of inScope) {
    if (r.status === 'skipped' || r.status === 'na') continue;   // hidden, v1

    const label = String(r.client_label == null ? '' : r.client_label).trim();
    if (!label) {
      // Config hole — never fall back to internal_label (portal invariant).
      console.warn(
        `[portalCaseService] client-visible requirement "${r.requirement_key}" has no ` +
        `client_label — step dropped from the portal card (staff: set one in Case Config)`
      );
      continue;
    }

    const done = r.status === 'done';
    const isEvent = r.kind === 'event';

    // THE SINGLE ACTIVE-NOW RULE — see the docblock.
    const activeNow = !activeTaken && !done &&
      r.status === 'active' && !!r.required && r.owner === 'client';
    if (activeNow) activeTaken = true;

    if (!done && r.required) remaining += 1;

    // Number chips count the actionable steps only. Event-kind steps carry a
    // calendar glyph instead and do NOT consume a number, so the chips read
    // 1, 2, 3 with no gaps — a gap would read as a step we forgot to show.
    let number = null;
    if (!done && !isEvent) number = ++numbered;

    const subtitleParts = [];
    const base = r.detail || r.progress || r.hint || null;
    if (base) subtitleParts.push(String(base));
    if (r.effort) subtitleParts.push(String(r.effort));

    steps.push({
      done,
      active_now: activeNow,
      kind: isEvent ? 'event' : 'task',
      number,
      label,
      subtitle: subtitleParts.length ? subtitleParts.join(' · ') : null,
      date: done ? toLocalIsoDate(r.satisfied_at) : null,
    });
  }

  if (!steps.length) return null;

  // (R2.5) FORWARD PROJECTION — feature-detected. The key is ABSENT (not
  // null) from the PIPELINE payload unless the resolved template is
  // role='intake', i.e. it exists only for LEADS, who are exactly the clients
  // with nothing after the intake stages to look at. Absent on a pre-R2.5
  // server too; either way the card renders without the greyed tail rather
  // than breaking.
  //
  // (R3.1) The read itself moved to projectedLabels — the ONE reader
  // buildClientTimeline now shares, so the card's greyed tail and the
  // timeline's greyed tail cannot drift apart. Behaviour here is unchanged:
  // same truthiness guard, same client_visible + client_label filter, same
  // `[]` for absent/malformed. THIS card's key is always present (unlike the
  // timeline's, which is emitted only when the pipeline carries one) —
  // pinned by tests/portalNextSteps.test.js.
  const projected = projectedLabels(pipeline);

  return { remaining, steps, projected };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE
// ─────────────────────────────────────────────────────────────────────────────

// Portal scope = the contact's cases related as Primary or Secondary.
// (Other/Bystander are staff-side relations — excluded.) The join is by
// value equality — case_relate_case_id is varchar(8) vs cases.case_id
// varchar(20); that's historical, the join works, leave it alone.
// Projection whitelist ONLY — cases carries internal columns (case_status
// among them) that must never ride along.
const SCOPE_COLUMNS =
  `c.case_id, c.case_chapter, c.case_type, c.case_number, c.case_number_full`;

// getCaseView additionally reads the 341 columns (S2.1). List rows never
// need them — the list payload has no meeting341.
const VIEW_COLUMNS =
  `${SCOPE_COLUMNS}, c.case_341_current, c.case_341_link`;

/** Fetch the contact's in-scope case rows (whitelisted columns), newest
 *  case_open_date first (NULL dates last), deterministic tiebreak. */
async function _scopedCaseRows(db, contactId) {
  const [rows] = await db.query(
    `SELECT ${SCOPE_COLUMNS}, c.case_open_date
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')
      ORDER BY (c.case_open_date IS NULL), c.case_open_date DESC, c.case_id ASC`,
    [contactId]
  );
  // Dedupe by case_id in JS (a contact holding both Primary AND Secondary on
  // one case would otherwise duplicate; none exist today — cheap insurance
  // that avoids DISTINCT/GROUP BY sql_mode edge cases). case_open_date is
  // ORDER BY fuel only — it never enters the payload.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.case_id)) continue;
    seen.add(r.case_id);
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// listCases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contact's portal case list.
 *
 * Closed cases stay visible (ratified) — no status filtering.
 *
 * @param {object} db        mysql2 pool
 * @param {number} contactId authenticated portal contact
 * @returns {Promise<{case_id:string, title:string, docket:string|null,
 *                    current_stage_label:string|null}[]>}
 */
async function listCases(db, contactId) {
  const rows = await _scopedCaseRows(db, contactId);

  const out = [];
  for (const row of rows) {
    let currentLabel = null;
    try {
      const pipeline = await pipelineService.getPipeline(db, row.case_id);
      const timeline = buildClientTimeline(pipeline);
      currentLabel = timeline.current ? timeline.current.label : null;
    } catch (err) {
      // 404 = case vanished between the scope read and the pipeline read
      // (delete race) — degrade the label, keep the list alive. Anything
      // else is a real error and must surface.
      if (err.status !== 404) throw err;
    }
    out.push({
      case_id: row.case_id,
      title: deriveTitle(row),
      docket: deriveDocket(row),
      current_stage_label: currentLabel,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// getCaseView
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One case, portal-shaped. Scope check FIRST; out-of-scope and nonexistent
 * are both null — the route turns null into the uniform 404 (no oracle).
 *
 * R3.1: on a LEAD, `timeline.projected` carries the same forward view
 * `next_steps.projected` does — BY DESIGN, and not a duplication bug. The
 * card answers "what do I have to do" and the timeline answers "where is my
 * case"; a lead's honest answer to the second one runs past the end of the
 * intake template, so both surfaces end with it. One reader
 * (projectedLabels) feeds both, so they always agree word for word.
 *
 * E1: `cards` = portalCardEngine.renderCards for the case-view placements
 * ('case_top' above the timeline, 'case' below — the client splits by each
 * card's placement). `meeting341` is included when — and ONLY when — the
 * engine passed the coded meeting341 card; its gates live in that card's
 * conditions, not here. A card that passed but yields nothing formattable
 * (formatMeeting341 → null; a datetime column makes this near-impossible) is
 * dropped fail-closed rather than shipped empty.
 *
 * @param {object} db        mysql2 pool
 * @param {number} contactId authenticated portal contact
 * @param {string} caseId    requested cases.case_id
 * R3: `next_steps` = the client work list (buildNextSteps — see there), or
 * null when there is nothing to show. Fail-open: a resolver error degrades to
 * null and the page renders exactly the pre-R3 case view.
 *
 * @returns {Promise<{case_id:string, title:string, docket:string|null,
 *   meeting341: { date:string, time:string, link:string|null } | null,
 *   next_steps: { remaining:number, steps:object[], projected:object[] } | null,
 *   timeline: { done: {label:string, date:string|null}[],
 *               current: {label:string, since:string|null} | null,
 *               upcoming: {label:string}[],
 *               projected?: {label:string}[] },     // R3.1 — leads only
 *   cards: Array<{key:string, title:string, body:string|null,
 *                 link:{url:string,label:string}|null,
 *                 coded_key:string|null, placement:string}>} | null>}
 */
async function getCaseView(db, contactId, caseId) {
  const [[row]] = await db.query(
    `SELECT ${VIEW_COLUMNS}
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_case_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')
      LIMIT 1`,
    [contactId, caseId]
  );
  if (!row) return null;

  let pipeline;
  try {
    // row.case_id (canonical casing from cases) — utf8mb4_general_ci means
    // the scope match is case-insensitive; downstream uses the DB's value.
    pipeline = await pipelineService.getPipeline(db, row.case_id);
  } catch (err) {
    if (err.status === 404) return null; // delete race → same uniform 404
    throw err;
  }

  // E1 card engine — fail-closed internally; never throws, never 500s the
  // view. Refs/params inside are pinned to (contactId, row.case_id).
  const cards = await portalCardEngine.renderCards(db, {
    caseId: row.case_id,
    contactId,
    placement: ['case_top', 'case'],
  });

  // (R3) "Your next steps". FAIL-OPEN to the timeline: the work list is
  // additive, and a resolver failure (a detector's source table locked, a
  // registry key pulled out from under stored rows) must degrade to the case
  // view we have shipped since S2 rather than 500 a client's only window into
  // their case. Empty requirement tables short-circuit inside the resolver,
  // so a firm with nothing authored pays one cheap query and gets null.
  let nextSteps = null;
  try {
    const resolved = await requirementService.resolveRequirements(db, [row.case_id],
      { clientOnly: true });
    nextSteps = buildNextSteps(pipeline, resolved.get(String(row.case_id)) || []);
  } catch (err) {
    console.warn(`[portalCaseService] next-steps resolve failed for case ${row.case_id}:`, err.message);
  }

  // 341 data rides ONLY behind the engine-passed coded card (dispatch is by
  // coded_key — the code binding; card_key is staff vocabulary).
  let meeting341 = null;
  const idx341 = cards.findIndex(c => c.coded_key === 'meeting341');
  if (idx341 !== -1) {
    meeting341 = formatMeeting341(row);
    if (!meeting341) {
      // Passed card with nothing formattable = misconfig/defect — drop the
      // card (fail-closed) instead of rendering an empty shell.
      console.warn('[portalCaseService] meeting341 card passed but formatter returned null — card dropped');
      cards.splice(idx341, 1);
    }
  }

  return {
    case_id: row.case_id,
    title: deriveTitle(row),
    docket: deriveDocket(row),
    meeting341,
    next_steps: nextSteps,
    timeline: buildClientTimeline(pipeline),
    cards,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listCases,
  getCaseView,
  // Exposed for tests (repo pattern: logService cross-exports its helpers).
  // E1: _buildMeeting341 → _formatMeeting341 (gates moved to the card
  // engine's conditions; this is the pure formatter).
  _buildClientTimeline: buildClientTimeline,
  _buildNextSteps: buildNextSteps,
  _formatMeeting341: formatMeeting341,
  _deriveTitle: deriveTitle,
  _deriveDocket: deriveDocket,
};