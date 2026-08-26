// services/requirementDetectors.js
//
/**
 * requirementDetectors.js — Detector registry for Pipeline R2 stage
 * requirements.
 *
 * A DETECTOR answers "is this requirement satisfied for this case?" by
 * reading the SOURCE OBJECT the app already writes — a signed
 * signing_requests row, a complete docs checklist, a submitted form, an
 * attended appointment. Requirements derive by default; nobody marks
 * anything. The two states derivation cannot express (`na`, manual `done`)
 * live in case_requirement_overrides and are the RESOLVER's business
 * (services/requirementService.js), not this file's.
 *
 * ── REGISTRY CONTRACT ────────────────────────────────────────────────────
 * Each detector: {
 *   key           registry key, stored in pipeline_stage_requirements.detector
 *   label         human name for the admin UI's detector picker
 *   config_hint   one-line JSON example for the admin UI's config textarea
 *   validateConfig(cfg) -> errorString | null
 *       cfg is a plain object (or null/undefined). Called at WRITE time by
 *       pipelineAdminService — the trigger-rules __validateParamsMapping
 *       philosophy: a config that can only fail at read time is a booby
 *       trap. UNKNOWN KEYS ARE REJECTED (a typo'd key would otherwise
 *       silently fall back to a default and the requirement would test the
 *       wrong thing forever with no signal).
 *   batchResolve(db, caseIds, reqs) ->
 *       Map<caseId, Map<requirement_key, hit>>
 *       hit = { satisfied_at: Date|null, detail: string|null,
 *               progress: string|null }
 * }
 *
 * SATISFIED ⇔ satisfied_at IS NON-NULL. That is the whole protocol: an
 * absent map entry and a hit with satisfied_at:null both read as
 * unsatisfied; the latter exists so a detector can carry progress/detail
 * for work that is underway (checklist's "4 of 7 received"). Every
 * detector therefore GUARANTEES a non-null satisfied_at when the source
 * object says done, falling back through secondary timestamps if its
 * primary one is missing (esign: completed_at → updated_at → created_at).
 *
 * ── BATCHING IS A HARD REQUIREMENT ───────────────────────────────────────
 * One batchResolve call issues AT MOST a fixed small number of queries for
 * ALL cases and ALL requirements of its kind (WHERE case_id IN (...) AND
 * <selector> IN (...)), never per-requirement-per-case. The board and R4's
 * auto-advance will run this over whole columns of cases; N×M query
 * fan-out is the failure mode this shape exists to prevent. Query counts
 * are asserted in tests (scriptGuard style):
 *     esign 1 · checklist 2 · form 1 · event 1 · manual 0.
 *
 * ── KEY IDENTITY ─────────────────────────────────────────────────────────
 * The inner map keys by requirement_key. A key shared across templates
 * MEANS THE SAME WORK ITEM (that is the overrides-bind-by-key convention),
 * so the resolver dedupes same-key requirements before calling and the
 * first config wins. Authoring the same key with DIFFERENT configs on two
 * templates violates the convention; nothing here can detect it.
 *
 * Conventions (match services/pipelineService.js):
 *   - Every batchResolve takes the mysql2 pool (req.db) as its first arg.
 *   - mysql2 expands array params for IN (?) (portalDocsService precedent).
 *   - Session sql_mode lacks STRICT_TRANS_TABLES — nothing here writes, so
 *     no clipping concerns; comparisons lean on the tables' own
 *     utf8mb4_general_ci collation for case-insensitivity.
 */

'use strict';

// Constants only — esignService's module scope requires nothing beyond
// node:crypto, so this import is boot-safe (verified: no
// CREDENTIALS_ENCRYPTION_KEY read at load; that landmine lives in
// lib/credentialCrypto.js, which esignService does not require).
const { TERMINAL_SUCCESS } = require('./esignService');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Empty result in the contract shape. */
function emptyResult() {
  return new Map();
}

function ensureCase(map, caseId) {
  const k = String(caseId);
  if (!map.has(k)) map.set(k, new Map());
  return map.get(k);
}

/** Case-insensitive trim-equality — mirrors utf8mb4_general_ci, same as
 *  pipelineService.ciEq, so JS-side bucketing agrees with the SQL WHERE. */
function ciKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** Non-empty-string config field check. Returns error string or null. */
function reqString(cfg, field, max) {
  const v = cfg[field];
  if (typeof v !== 'string' || v.trim() === '') {
    return `${field} must be a non-empty string`;
  }
  if (v.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

/** Reject unknown keys — see REGISTRY CONTRACT. */
function unknownKeys(cfg, allowed) {
  const extra = Object.keys(cfg).filter((k) => !allowed.includes(k));
  return extra.length
    ? `unknown config key(s): ${extra.join(', ')} (allowed: ${allowed.join(', ') || 'none'})`
    : null;
}

/** Config must be a plain object (the admin layer parses JSON strings before
 *  calling; null/undefined means "no config"). */
function asObject(cfg) {
  if (cfg == null) return {};
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  return cfg;
}

/** Dedupe requirement rows by requirement_key (first wins — see KEY
 *  IDENTITY) and hand back [key, cfgObject] pairs with parsed configs.
 *  mysql2 hands JSON columns back as parsed objects, but a stub/test or a
 *  driver setting can hand a string — accept both (normalizeConfig
 *  precedent in pipelineAdminService). */
function uniqueReqs(reqs) {
  const seen = new Map();
  for (const r of reqs || []) {
    const key = String(r.requirement_key);
    if (seen.has(key)) continue;
    let cfg = r.detector_config;
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; }
    }
    seen.set(key, asObject(cfg) || {});
  }
  return [...seen.entries()];
}

// ─────────────────────────────────────────────────────────────────────────────
// esign — a signing_requests row for the case, of the configured kind, that
// reached terminal SUCCESS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status vocabulary (READ from services/esignService.js — the single source
 * of truth, exported constants):
 *   STATUSES: draft, sent, viewed, partially_signed, signed, declined,
 *             expired, recalled, bounced, satisfied_external
 *   TERMINAL_SUCCESS = { signed, satisfied_external } — the two states that
 *   stamp completed_at and fire the 'signed' trigger. declined / expired /
 *   recalled are terminal FAILURES and leave completed_at NULL; they do NOT
 *   satisfy (a declined retainer is not a signed retainer).
 *
 * satisfied_at = completed_at (stamped on terminal success only), falling
 * back to updated_at then created_at for any legacy row that predates the
 * stamp — the satisfied⇔non-null protocol requires a date when the status
 * says done.
 *
 * Multiple matching rows (re-sends): the one with the LATEST effective
 * timestamp wins.
 */
const esignDetector = {
  key: 'esign',
  label: 'E-sign document (signing_requests)',
  config_hint: '{ "kind": "retainer_prepetition" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    return unknownKeys(o, ['kind']) || reqString(o, 'kind', 64);
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const pairs = uniqueReqs(reqs);
    const ids = (caseIds || []).map(String);
    const kinds = [...new Set(pairs.map(([, cfg]) => String(cfg.kind == null ? '' : cfg.kind)))]
      .filter((k) => k !== '');
    if (!ids.length || !kinds.length) return out;

    const [rows] = await db.query(
      `SELECT linkable_id, kind, status, completed_at, updated_at, created_at
         FROM signing_requests
        WHERE linkable_type = 'case'
          AND linkable_id IN (?)
          AND kind IN (?)
          AND status IN (?)`,
      [ids, kinds, [...TERMINAL_SUCCESS]]
    );

    // Best row per (case, kind) — latest effective timestamp wins.
    const best = new Map(); // "case\u0000kind" -> { at, status }
    for (const r of rows) {
      const at = r.completed_at || r.updated_at || r.created_at;
      const k = `${String(r.linkable_id)}\u0000${ciKey(r.kind)}`;
      const prev = best.get(k);
      if (!prev || new Date(at) > new Date(prev.at)) best.set(k, { at, status: r.status });
    }

    for (const caseId of ids) {
      for (const [reqKey, cfg] of pairs) {
        const hit = best.get(`${caseId}\u0000${ciKey(cfg.kind)}`);
        if (!hit) continue;
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: hit.at || null,
          detail: 'Signed',       // both terminal successes execute the doc; keep it short (R3)
          progress: null,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// checklist — the case's tagged checklist(s) are complete.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity: checklists WHERE link_type='case' AND link=<case_id> AND
 * tag=<tag> AND kind='checklist' — the docs pipeline convention
 * (routes/api.checklists.js: "identified by tag, NOT by title"). kind gate
 * matters: a case can legally hold both a tag='docs_needed' CHECKLIST and a
 * tag='docs_needed' NOTE (S1), and a note has no completion semantics.
 *
 * Completion vocabulary: checklists.status ENUM('incomplete','complete') is
 * DERIVED by lib/checklistStatus.computeAndSaveStatus (zero items →
 * incomplete; all items 'complete' → complete). We trust the stored derived
 * status rather than re-deriving from items — one definition of "done".
 *
 * Multiple lists under one tag on one case is anomalous (upsert-items
 * find-or-creates exactly one; zero live at 2026-08-26) but reachable via a
 * merge — the rule is ALL must be complete (an incomplete second list is
 * outstanding work, not noise).
 *
 * satisfied_at = MAX(updated_date) across the tagged lists — APPROXIMATE:
 * updated_date is "last touched" (item renames bump it too), but the
 * completing item-write always bumps it, so it is never EARLIER than
 * completion. There is no completion timestamp to be exact with.
 *
 * progress is returned even when unsatisfied ("4 of 7 received") — the one
 * detector where underway-ness is worth showing. Item counts are a second
 * query (a single LEFT JOIN would multiply checklist rows per item and
 * corrupt the all-complete aggregate); two queries per pass is still
 * constant.
 */
const checklistDetector = {
  key: 'checklist',
  label: 'Checklist complete (by tag)',
  config_hint: '{ "tag": "docs_needed" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    return unknownKeys(o, ['tag']) || reqString(o, 'tag', 50);
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const pairs = uniqueReqs(reqs);
    const ids = (caseIds || []).map(String);
    const tags = [...new Set(pairs.map(([, cfg]) => String(cfg.tag == null ? '' : cfg.tag)))]
      .filter((t) => t !== '');
    if (!ids.length || !tags.length) return out;

    const [lists] = await db.query(
      `SELECT id, link, tag, status, updated_date
         FROM checklists
        WHERE link_type = 'case'
          AND kind = 'checklist'
          AND link IN (?)
          AND tag IN (?)`,
      [ids, tags]
    );
    if (!lists.length) return out;   // no tagged list yet → nothing to report

    const [itemRows] = await db.query(
      `SELECT checklist_id,
              COUNT(*) AS total,
              SUM(status = 'complete') AS done
         FROM checkitems
        WHERE checklist_id IN (?)
        GROUP BY checklist_id`,
      [lists.map((l) => l.id)]
    );
    const items = new Map(itemRows.map((r) => [Number(r.checklist_id),
      { total: Number(r.total), done: Number(r.done) }]));

    // Bucket lists per (case, tag).
    const buckets = new Map(); // "case\u0000tag" -> [list, ...]
    for (const l of lists) {
      const k = `${String(l.link)}\u0000${ciKey(l.tag)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(l);
    }

    for (const caseId of ids) {
      for (const [reqKey, cfg] of pairs) {
        const bucket = buckets.get(`${caseId}\u0000${ciKey(cfg.tag)}`);
        if (!bucket) continue;
        let total = 0, done = 0, allComplete = true, lastUpdate = null;
        for (const l of bucket) {
          if (l.status !== 'complete') allComplete = false;
          const it = items.get(Number(l.id)) || { total: 0, done: 0 };
          total += it.total; done += it.done;
          if (lastUpdate == null || new Date(l.updated_date) > new Date(lastUpdate)) {
            lastUpdate = l.updated_date;
          }
        }
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: allComplete ? (lastUpdate || null) : null,
          detail: allComplete ? 'Complete' : null,
          progress: `${done} of ${total} received`,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// form — a submitted form_submissions row exists for the case + form_key.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source table: form_submissions (the form.submitted trigger's fields are
 * the map — services/formService.submitForm inserts
 * { form_key, link_type, link_id, status:'submitted', version }, and the
 * event carries case_id = link_id when link_type='case'). Drafts never
 * satisfy. Multiple submitted versions: satisfied since the FIRST, but
 * satisfied_at reports the LATEST submission (created_at — submitted rows
 * are append-only, so created_at IS the submission time), consistent with
 * the esign detector's latest-wins.
 */
const formDetector = {
  key: 'form',
  label: 'Form submitted (form_submissions)',
  config_hint: '{ "form_key": "intake" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    return unknownKeys(o, ['form_key']) || reqString(o, 'form_key', 50);
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const pairs = uniqueReqs(reqs);
    const ids = (caseIds || []).map(String);
    const keys = [...new Set(pairs.map(([, cfg]) => String(cfg.form_key == null ? '' : cfg.form_key)))]
      .filter((k) => k !== '');
    if (!ids.length || !keys.length) return out;

    const [rows] = await db.query(
      `SELECT link_id, form_key, MAX(created_at) AS submitted_at
         FROM form_submissions
        WHERE status = 'submitted'
          AND link_type = 'case'
          AND link_id IN (?)
          AND form_key IN (?)
        GROUP BY link_id, form_key`,
      [ids, keys]
    );
    const hits = new Map(rows.map((r) =>
      [`${String(r.link_id)}\u0000${ciKey(r.form_key)}`, r.submitted_at]));

    for (const caseId of ids) {
      for (const [reqKey, cfg] of pairs) {
        const at = hits.get(`${caseId}\u0000${ciKey(cfg.form_key)}`);
        if (!at) continue;
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: at,
          detail: 'Submitted',
          progress: null,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// event — an appointment (v1) of the configured type in the wanted state.
// ─────────────────────────────────────────────────────────────────────────────

/** THE FROZEN SELECTOR (R2 spec):
 *    { source: 'appt'|'event'|'any', kind_or_type: <string>,
 *      want: 'held'|'scheduled'|'missed'|'any',   default 'held'
 *      which: 'latest'|'first'|'any' }            default 'latest'
 *
 *  v1 implements source:'appt' ONLY. validateConfig REJECTS 'event'/'any'
 *  at write time ("not yet supported; unified-events E1 pending") so no
 *  STORED config can dangle; if read time meets one anyway (future data
 *  written around the validator), the requirement resolves unsatisfied and
 *  console.warn fires — a dangling selector must not silently satisfy or
 *  crash the resolver.
 *
 *  Appt mapping (appts.appt_status ENUM('Attended','No Show','Rescheduled',
 *  'Canceled','Scheduled'), verified live):
 *    kind_or_type  = appt_type equality (utf8mb4_general_ci — live data has
 *                    'Pre-Filing Meeting' AND 'Pre-filing Meeting'; both
 *                    match, which is the collation working as intended)
 *    want held     → 'Attended'
 *         scheduled→ 'Scheduled'
 *         missed   → 'No Show'
 *         any      → any status EXCEPT the tombstones below ('Canceled'
 *                    included: a canceled appt still HAPPENED as a record;
 *                    'any' means "an appointment of this type exists")
 *    'Rescheduled' rows are TOMBSTONES (apptService supersedes the old row
 *    by flipping it to Rescheduled on rebook) — ALWAYS excluded, every
 *    want, in the SQL itself.
 *    which picks AMONG MATCHES by appt_date: 'latest' = max, 'first' = min,
 *    'any' = existence (satisfied_at reported from the latest match).
 *    which never changes WHETHER the requirement is satisfied — a match
 *    existing is satisfaction; which only chooses the row that supplies
 *    satisfied_at/detail.
 *
 *  satisfied_at = the picked row's appt_date; detail = its appt_status.
 */
const EVENT_SOURCES = ['appt', 'event', 'any'];
const EVENT_WANTS = ['held', 'scheduled', 'missed', 'any'];
const EVENT_WHICH = ['latest', 'first', 'any'];
const WANT_STATUS = { held: 'Attended', scheduled: 'Scheduled', missed: 'No Show' };

const eventDetector = {
  key: 'event',
  label: 'Appointment / event (appts — v1)',
  config_hint: '{ "source": "appt", "kind_or_type": "341 Meeting", "want": "held", "which": "latest" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    const bad = unknownKeys(o, ['source', 'kind_or_type', 'want', 'which']);
    if (bad) return bad;
    if (!EVENT_SOURCES.includes(o.source)) {
      return `source must be one of: ${EVENT_SOURCES.join(', ')}`;
    }
    if (o.source !== 'appt') {
      return `source "${o.source}" is not yet supported; unified-events E1 pending — use source "appt"`;
    }
    const ks = reqString(o, 'kind_or_type', 60);
    if (ks) return ks;
    if (o.want !== undefined && !EVENT_WANTS.includes(o.want)) {
      return `want must be one of: ${EVENT_WANTS.join(', ')} (default held)`;
    }
    if (o.which !== undefined && !EVENT_WHICH.includes(o.which)) {
      return `which must be one of: ${EVENT_WHICH.join(', ')} (default latest)`;
    }
    return null;
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const ids = (caseIds || []).map(String);
    const pairs = uniqueReqs(reqs).filter(([reqKey, cfg]) => {
      if (cfg.source === 'appt') return true;
      // Read-time guard: a stored non-appt source should be impossible
      // (validateConfig rejects it) — future data written around the
      // validator resolves UNSATISFIED, loudly, never silently satisfied.
      console.warn(
        `[requirementDetectors] event requirement "${reqKey}" has ` +
        `source="${cfg.source}" — not yet supported (unified-events E1 ` +
        `pending); resolving unsatisfied`
      );
      return false;
    });
    const types = [...new Set(pairs.map(([, cfg]) => String(cfg.kind_or_type == null ? '' : cfg.kind_or_type)))]
      .filter((t) => t !== '');
    if (!ids.length || !types.length) return out;

    const [rows] = await db.query(
      `SELECT appt_case_id, appt_type, appt_status, appt_date
         FROM appts
        WHERE appt_case_id IN (?)
          AND appt_type IN (?)
          AND appt_status <> 'Rescheduled'`,
      [ids, types]
    );

    // Bucket per (case, type) — JS bucketing uses ci keys so it agrees with
    // the general_ci SQL match that produced the rows.
    const buckets = new Map();
    for (const r of rows) {
      const k = `${String(r.appt_case_id)}\u0000${ciKey(r.appt_type)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }

    for (const caseId of ids) {
      for (const [reqKey, cfg] of pairs) {
        const want = cfg.want === undefined ? 'held' : cfg.want;
        const which = cfg.which === undefined ? 'latest' : cfg.which;
        const bucket = buckets.get(`${caseId}\u0000${ciKey(cfg.kind_or_type)}`) || [];
        const matches = bucket.filter((r) =>
          want === 'any' ? true : r.appt_status === WANT_STATUS[want]
        );
        if (!matches.length) continue;
        // 'first' = min appt_date; 'latest' and 'any' = max appt_date.
        let pick = matches[0];
        for (const r of matches.slice(1)) {
          const rd = new Date(r.appt_date), pd = new Date(pick.appt_date);
          if (which === 'first' ? rd < pd : rd > pd) pick = r;
        }
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: pick.appt_date,
          detail: pick.appt_status,
          progress: null,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// manual — never auto-satisfies; only an override completes it.
// ─────────────────────────────────────────────────────────────────────────────

const manualDetector = {
  key: 'manual',
  label: 'Manual (override only)',
  config_hint: '{}',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    return Object.keys(o).length
      ? 'manual takes no config — leave it blank'
      : null;
  },

  // Zero queries, zero hits — by definition.
  async batchResolve(_db, _caseIds, _reqs) {
    return emptyResult();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const DETECTORS = Object.freeze({
  esign: esignDetector,
  checklist: checklistDetector,
  form: formDetector,
  event: eventDetector,
  manual: manualDetector,
});

function getDetector(key) {
  return Object.prototype.hasOwnProperty.call(DETECTORS, key) ? DETECTORS[key] : null;
}

/** Admin-UI listing: metadata only, no functions over the wire. */
function listDetectors() {
  return Object.values(DETECTORS).map((d) => ({
    key: d.key, label: d.label, config_hint: d.config_hint,
  }));
}

/** Write-time validation entry point (pipelineAdminService).
 *  Returns an error string or null. Unknown detector is itself an error. */
function validateDetectorConfig(detectorKey, cfg) {
  const d = getDetector(detectorKey);
  if (!d) {
    return `unknown detector "${detectorKey}" — one of: ${Object.keys(DETECTORS).join(', ')}`;
  }
  return d.validateConfig(cfg);
}

module.exports = {
  DETECTORS,
  getDetector,
  listDetectors,
  validateDetectorConfig,
};
