// services/requirementService.js
//
/**
 * requirementService.js — Batched resolver + per-case overrides for Pipeline
 * R2 stage requirements.
 *
 * ── WHY A SIBLING FILE, NOT pipelineService.js ───────────────────────────
 * pipelineService.js is 1000+ lines with a tight declared ownership set
 * (resolveTemplate / getPipeline / advanceStage) and is the engine every
 * frozen consumer leans on; folding ~450 lines of resolver + override CRUD
 * into it muddies that contract. Import graph: this file requires
 * pipelineService at module scope (for _pickTemplate — the SAME template
 * resolution getPipeline uses, reused rather than re-derived) and
 * requirementDetectors; pipelineService's getPipeline lazy-requires THIS
 * file only when its new { requirements:true } opt is set — the documented
 * circular-dep-safety convention (lib/internal_functions/log.js), and it
 * keeps the default getPipeline path free of even the require cost.
 *
 * ── THE READ MODEL ───────────────────────────────────────────────────────
 * resolveRequirements(db, caseIds, { clientOnly }) →
 *   Map<caseId, Array<resolvedRequirement>>
 *
 * resolvedRequirement = {
 *   requirement_key, stage_id, stage_key, internal_label, client_label,
 *   client_visible, required, owner, kind, hint, effort, group_label,
 *   sort_order, status, satisfied_at, detail, progress,
 *   override: null | { status, note, set_by, at }
 * }
 *
 * status ∈ 'na' | 'done' | 'skipped' | 'active' | 'upcoming'.
 * This shape is FROZEN — it is R2.5/R3/R4's input.
 *
 * ── WHICH REQUIREMENTS APPLY TO A CASE ───────────────────────────────────
 * Requirements attach to stages; which template's stages apply comes from
 * the SAME resolution getPipeline performs (pipelineService._pickTemplate
 * over the active template list — reused, not re-derived):
 *   - the RESOLVED template's active stages, always; plus
 *   - the INTAKE template's active stages when the resolved template is
 *     role='case'. A filed case's intake questionnaire is real history —
 *     it must resolve `done` (satisfied in March) or `skipped`, and it can
 *     only do either if it is IN the list. When resolution itself falls
 *     back to intake (branch 1 or 4), the set is just intake — projecting
 *     a not-yet-chosen chapter template's requirements is R2.5's forward
 *     projection, deliberately out of scope here.
 * Inactive stages and inactive requirements are excluded — deactivation
 * removes work from the model exactly as it removes stages from the
 * projection.
 *
 * ── CANONICAL PRECEDENCE (per requirement, per case) ─────────────────────
 *   1. Override row exists → status = its value ('na' | 'done'; 'done'
 *      takes override.at as satisfied_at, 'na' carries satisfied_at null).
 *      Detector detail/progress ride along either way — they are
 *      independent facts about the source object, and "4 of 7 received" is
 *      still useful under an 'na'.
 *   2. Else detector satisfied (hit.satisfied_at non-null — the registry
 *      protocol) → 'done' with the detector's satisfied_at/detail.
 *      DETECTOR BEFORE POSITION: a satisfied requirement is 'done' even
 *      when its stage is behind — a filed case whose questionnaire was
 *      submitted in March reads "done", never "skipped".
 *   3. Else the requirement's stage is BEHIND the case's position →
 *      'skipped'. "Behind" is:
 *        (a) same template as the case's current matched stage and
 *            stage_number < that stage's stage_number, or
 *        (b) the requirement's stage lives on a role='intake' template
 *            while the case's LATEST LOG ROW is on a role='case' template.
 *      Off-ramp current positions compare by stage_number like any other —
 *      the deliberately simple rule (per-template ordinals are the only
 *      axis there is; inventing a second one here would be R1's lane
 *      mistake in reverse).
 *   4. Else stage IS the current stage (stage_key match within the same
 *      template, the engine's key-based convention) → 'active'; ahead →
 *      'upcoming'; no pipeline history → everything 'upcoming', nothing
 *      'active'.
 *
 * ── BATCHING ─────────────────────────────────────────────────────────────
 * One resolver pass = a fixed number of queries regardless of how many
 * cases/requirements: cases(1) + templates(1) + stages(1) + requirements(1)
 * + latest-log(1) + latest-template-roles(0..1, only for template ids
 * missing from the active list) + overrides(1) + each detector kind's
 * constant batch (esign 1 · checklist 2 · form 1 · event 1 · manual 0).
 * Empty requirement tables short-circuit after the requirements query —
 * the zero-behavior-change deploy gate.
 *
 * ── OVERRIDES ────────────────────────────────────────────────────────────
 * setOverride / clearOverride back the /api/cases/:id/pipeline/
 * requirements/:key/override routes. Any authenticated staff. Every
 * set/clear writes a case log row through the SAME mechanism a pipeline
 * advance lands in the case log: logService.createLogEntry with
 * type='status', link_type='case' (the live "Stage change -> case log"
 * rule's create_log action funnels into exactly this call with exactly
 * these constants; we call it directly since there is no domain event
 * here). extra carries { source:'staff' } — the actor class, mirrored from
 * the advance convention. The log write is post-write fire-and-forget: it
 * must never fail the override, same as the advance's post-commit
 * emission never fails the advance.
 *
 * Unknown requirement_key on set → 400, NOT warn-and-store: overrides for
 * keys that exist on no active requirement are typos, and the
 * template-switch-survival property is served by keys SHARED across
 * templates — which do exist somewhere. Clearing = DELETE.
 *
 * Conventions (match services/pipelineService.js):
 *   - Every function takes the mysql2 pool (req.db) as its first argument.
 *   - Failures throw Error with `.status` (400/404); routes map
 *     `err.status || 500`.
 *   - Session sql_mode lacks STRICT_TRANS_TABLES — note clipped to 255 in
 *     JS.
 */

'use strict';

const { _pickTemplate } = require('./pipelineService');
const detectors = require('./requirementDetectors');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const badRequest = (msg) => httpError(400, msg);
const notFound   = (msg) => httpError(404, msg);

/** Defensive truncate (session lacks strict mode — DB would clip silently). */
function clip(s, max) {
  if (s == null) return null;
  s = String(s);
  return s.length <= max ? s : s.slice(0, max);
}

const OVERRIDE_STATUSES = new Set(['na', 'done']);

// ─────────────────────────────────────────────────────────────────────────────
// resolveRequirements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Batched read model — full contract in the file header.
 *
 * @param {object} db mysql2 pool (or transaction connection)
 * @param {string[]} caseIds cases.case_id values. Unknown ids are simply
 *        absent from the returned map (batch semantics; the single-case
 *        HTTP surface, getPipeline, already 404s before reaching here).
 * @param {object} [opts]
 * @param {boolean} [opts.clientOnly=false] only client_visible=1
 *        requirements (portal surface).
 * @returns {Promise<Map<string, object[]>>} caseId → resolvedRequirement[]
 *        (ordered: intake-template requirements first — pipeline
 *        chronology — then the resolved template's; within a template by
 *        stage_number, sort_order, id).
 */
async function resolveRequirements(db, caseIds, { clientOnly = false } = {}) {
  const out = new Map();
  const ids = [...new Set((caseIds || []).map(String))].filter((s) => s !== '');
  if (!ids.length) return out;

  // 1 — case rows (the resolution inputs).
  const [caseRows] = await db.query(
    `SELECT case_id, case_type, case_subtype, pipeline_phase
       FROM cases WHERE case_id IN (?)`,
    [ids]
  );
  if (!caseRows.length) return out;
  for (const c of caseRows) out.set(String(c.case_id), []);

  // 2 — active templates, id ASC (the exact load resolveTemplate performs).
  const [templates] = await db.query(
    `SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC`
  );
  const intake = templates.find((t) => t.role === 'intake') || null;
  const roleById = new Map(templates.map((t) => [Number(t.id), t.role]));

  // Applicable template ids per case — see WHICH REQUIREMENTS APPLY.
  const applicable = new Map(); // caseId -> ordered template id list
  const tplIds = new Set();
  for (const c of caseRows) {
    const resolved = _pickTemplate(templates, c);
    const list = [];
    if (resolved) {
      if (resolved.role === 'case' && intake && intake.id !== resolved.id) {
        list.push(intake.id);       // intake first — pipeline chronology
      }
      list.push(resolved.id);
    }
    applicable.set(String(c.case_id), list);
    for (const id of list) tplIds.add(id);
  }
  if (!tplIds.size) return out;

  // 3 — active stages of every applicable template.
  const [stageRows] = await db.query(
    `SELECT id, template_id, stage_key, stage_number, lane
       FROM pipeline_stages
      WHERE template_id IN (?) AND active = 1
      ORDER BY stage_number ASC, id ASC`,
    [[...tplIds]]
  );
  if (!stageRows.length) return out;
  const stageById = new Map(stageRows.map((s) => [Number(s.id), s]));
  const stagesByTpl = new Map();
  for (const s of stageRows) {
    const k = Number(s.template_id);
    if (!stagesByTpl.has(k)) stagesByTpl.set(k, []);
    stagesByTpl.get(k).push(s);
  }

  // 4 — active requirements of those stages. EMPTY → short-circuit: the
  // zero-behavior-change deploy gate (no log/override/detector queries).
  const [reqRows] = await db.query(
    `SELECT * FROM pipeline_stage_requirements
      WHERE stage_id IN (?) AND active = 1${clientOnly ? ' AND client_visible = 1' : ''}
      ORDER BY sort_order ASC, id ASC`,
    [stageRows.map((s) => s.id)]
  );
  if (!reqRows.length) return out;
  const reqsByStage = new Map();
  for (const r of reqRows) {
    const k = Number(r.stage_id);
    if (!reqsByStage.has(k)) reqsByStage.set(k, []);
    reqsByStage.get(k).push(r);
  }

  // 5 — latest log row per case (board's groupwise-max precedent, bounded;
  // (entered_at DESC, id DESC) — the exact "latest" the engine uses).
  const [latestRows] = await db.query(
    `SELECT l.case_id, l.template_id, l.stage_key
       FROM case_stage_log l
       LEFT JOIN case_stage_log l2
         ON l2.case_id = l.case_id
        AND (l2.entered_at > l.entered_at
             OR (l2.entered_at = l.entered_at AND l2.id > l.id))
      WHERE l2.id IS NULL AND l.case_id IN (?)`,
    [ids]
  );
  const latestByCase = new Map(latestRows.map((r) => [String(r.case_id), r]));

  // 5b — roles for latest template_ids NOT in the active list (a case can
  // legitimately sit on a deactivated template's stage). 0 or 1 query.
  const missingTplIds = [...new Set(latestRows
    .map((r) => (r.template_id == null ? null : Number(r.template_id)))
    .filter((id) => id != null && !roleById.has(id)))];
  if (missingTplIds.length) {
    const [roleRows] = await db.query(
      `SELECT id, role FROM pipeline_templates WHERE id IN (?)`,
      [missingTplIds]
    );
    for (const r of roleRows) roleById.set(Number(r.id), r.role);
  }

  // 6 — overrides for these cases.
  const [ovRows] = await db.query(
    `SELECT case_id, requirement_key, status, note, set_by, updated_at
       FROM case_requirement_overrides
      WHERE case_id IN (?)`,
    [ids]
  );
  const ovByCaseKey = new Map(ovRows.map((r) =>
    [`${String(r.case_id)}\u0000${r.requirement_key}`, r]));

  // 7 — detector batches: per kind, over the cases that carry ≥1 requirement
  // of that kind. The registry dedupes same-key requirements (first config
  // wins — shared key ⇒ same meaning, the overrides-bind-by-key convention).
  const kindReqs = new Map();   // detector key -> [req rows]
  const kindCases = new Map();  // detector key -> Set<caseId>
  for (const [caseId, list] of applicable) {
    for (const tplId of list) {
      for (const s of stagesByTpl.get(Number(tplId)) || []) {
        for (const r of reqsByStage.get(Number(s.id)) || []) {
          if (!kindReqs.has(r.detector)) {
            kindReqs.set(r.detector, []);
            kindCases.set(r.detector, new Set());
          }
          kindReqs.get(r.detector).push(r);
          kindCases.get(r.detector).add(caseId);
        }
      }
    }
  }
  const hitsByKind = new Map(); // detector key -> Map<caseId, Map<reqKey, hit>>
  for (const [kind, reqs] of kindReqs) {
    const d = detectors.getDetector(kind);
    if (!d) {
      // Admin validation makes this unreachable for new writes; a registry
      // key removed out from under stored rows resolves unsatisfied, loudly.
      console.warn(`[requirementService] unknown detector "${kind}" — resolving unsatisfied`);
      hitsByKind.set(kind, new Map());
      continue;
    }
    hitsByKind.set(kind, await d.batchResolve(db, [...kindCases.get(kind)], reqs));
  }

  // 8 — assemble, per case, in template order (intake first), stage order,
  // sort order.
  for (const [caseId, tplList] of applicable) {
    const latest = latestByCase.get(caseId) || null;
    const latestRole = latest && latest.template_id != null
      ? (roleById.get(Number(latest.template_id)) || null)
      : null;
    const resolved = [];

    for (const tplId of tplList) {
      const tplRole = roleById.get(Number(tplId)) || null;
      const stages = stagesByTpl.get(Number(tplId)) || [];
      // Current stage matched WITHIN this template by stage_key — the
      // engine's key-based convention (history survives template edits).
      const matched = latest
        ? stages.find((s) => s.stage_key === latest.stage_key) || null
        : null;
      // Cross-template "behind" (rule 3b): intake-template requirements are
      // history once the case's latest log row is on a case template.
      const crossBehind = tplRole === 'intake' && latestRole === 'case';

      for (const s of stages) {
        for (const r of reqsByStage.get(Number(s.id)) || []) {
          const ov = ovByCaseKey.get(`${caseId}\u0000${r.requirement_key}`) || null;
          const hit = (hitsByKind.get(r.detector) || new Map())
            .get(caseId)?.get(r.requirement_key) || null;
          const detectorDone = !!(hit && hit.satisfied_at != null);

          let status, satisfied_at;
          if (ov) {                                              // rule 1
            status = ov.status;
            satisfied_at = ov.status === 'done' ? ov.updated_at : null;
          } else if (detectorDone) {                             // rule 2
            status = 'done';
            satisfied_at = hit.satisfied_at;
          } else if (crossBehind ||                              // rule 3
                     (matched && s.stage_number < matched.stage_number)) {
            status = 'skipped';
            satisfied_at = null;
          } else if (matched && s.stage_key === matched.stage_key) { // rule 4
            status = 'active';
            satisfied_at = null;
          } else {
            status = 'upcoming';
            satisfied_at = null;
          }

          resolved.push({
            requirement_key: r.requirement_key,
            stage_id: Number(s.id),
            stage_key: s.stage_key,
            internal_label: r.internal_label,
            client_label: r.client_label,
            client_visible: r.client_visible ? 1 : 0,
            required: r.required ? 1 : 0,
            owner: r.owner,
            kind: r.kind,
            hint: r.hint,
            effort: r.effort,
            group_label: r.group_label,
            sort_order: Number(r.sort_order),
            status,
            satisfied_at,
            detail: hit ? (hit.detail || null) : null,
            progress: hit ? (hit.progress || null) : null,
            override: ov
              ? { status: ov.status, note: ov.note, set_by: ov.set_by, at: ov.updated_at }
              : null,
          });
        }
      }
    }
    out.set(caseId, resolved);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDES
// ─────────────────────────────────────────────────────────────────────────────

/** Case-log write shared by set/clear — fire-and-forget (see header). */
async function _logOverride(db, caseId, userId, text, extra) {
  try {
    // Lazy-require: logService sits high in the service graph; the
    // internal_functions circular-dep-safety convention applies.
    const { createLogEntry } = require('./logService');
    await createLogEntry(db, {
      type: 'status',
      link_type: 'case',
      link_id: String(caseId),
      by: userId == null ? 0 : userId,
      data: text,
      extra,
    });
  } catch (err) {
    console.warn(`[requirementService] override log write failed for case ${caseId}:`, err.message);
  }
}

/**
 * Set (upsert) a per-case requirement override.
 *
 * @param {object} db
 * @param {string} caseId
 * @param {string} requirementKey
 * @param {object} opts { status: 'na'|'done', note?, userId? }
 * @returns {{ case_id, requirement_key, status, note }}
 * @throws 400 bad status / unknown key; 404 unknown case
 */
async function setOverride(db, caseId, requirementKey, { status, note = null, userId = null } = {}) {
  const key = String(requirementKey == null ? '' : requirementKey).trim();
  if (!key) throw badRequest('requirement key is required');
  if (!OVERRIDE_STATUSES.has(status)) {
    throw badRequest(`status must be "na" or "done" (got ${JSON.stringify(status)}) — every other state is derived`);
  }

  const [[caseRow]] = await db.query(
    `SELECT case_id FROM cases WHERE case_id = ?`, [caseId]
  );
  if (!caseRow) throw notFound(`Case ${caseId} not found`);

  // The key must exist on SOME active requirement (any stage, any template —
  // keys shared across templates are the point). Unknown keys are typos: 400.
  const [[ref]] = await db.query(
    `SELECT COUNT(*) AS n FROM pipeline_stage_requirements
      WHERE requirement_key = ? AND active = 1`,
    [key]
  );
  if (!Number(ref.n)) {
    throw badRequest(
      `Unknown requirement key "${key}" — no active requirement carries it. ` +
      `Overrides bind by key; a key that exists nowhere is a typo, not a ` +
      `future-proofing.`
    );
  }

  const clippedNote = clip(note, 255);
  const setBy = userId == null ? 0 : Number(userId);   // 0 = api-key/system (created_by convention)

  await db.query(
    `INSERT INTO case_requirement_overrides (case_id, requirement_key, status, note, set_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), note = VALUES(note), set_by = VALUES(set_by)`,
    [String(caseRow.case_id), key, status, clippedNote, setBy]
  );

  await _logOverride(db, caseRow.case_id, userId,
    `Requirement ${key}: marked ${status === 'na' ? 'N/A' : 'done'} (override)` +
      (clippedNote ? ` - ${clippedNote}` : ''),
    { source: 'staff', requirement_key: key, override_status: status });

  return { case_id: String(caseRow.case_id), requirement_key: key, status, note: clippedNote };
}

/**
 * Clear (DELETE) a per-case requirement override. Clearing is the only way
 * out of 'na'/'done' — the derived state takes back over on the next read.
 *
 * @returns {{ cleared: true, case_id, requirement_key }}
 * @throws 404 unknown case / no override to clear
 */
async function clearOverride(db, caseId, requirementKey, { userId = null } = {}) {
  const key = String(requirementKey == null ? '' : requirementKey).trim();
  if (!key) throw badRequest('requirement key is required');

  const [[caseRow]] = await db.query(
    `SELECT case_id FROM cases WHERE case_id = ?`, [caseId]
  );
  if (!caseRow) throw notFound(`Case ${caseId} not found`);

  const [res] = await db.query(
    `DELETE FROM case_requirement_overrides WHERE case_id = ? AND requirement_key = ?`,
    [String(caseRow.case_id), key]
  );
  if (!res.affectedRows) {
    throw notFound(`No override on requirement "${key}" for case ${caseId}`);
  }

  await _logOverride(db, caseRow.case_id, userId,
    `Requirement ${key}: override cleared`,
    { source: 'staff', requirement_key: key, override_status: null });

  return { cleared: true, case_id: String(caseRow.case_id), requirement_key: key };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  resolveRequirements,
  setOverride,
  clearOverride,
};
