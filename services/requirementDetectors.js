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
 *   validateConfigDb(db, cfg) -> Promise<errorString | null>   [OPTIONAL]
 *       (R2.6) Async write-time validation for detectors whose config
 *       references LIVE DATA (report: does the report exist, is it active,
 *       zero params, right columns). pipelineAdminService awaits it after
 *       the sync validateConfig on every create/update — no
 *       skip-on-unchanged; a save re-proves the config, same as R2's
 *       revalidate-on-detector-switch rule. Detectors without it are
 *       untouched. Same booby-trap philosophy, extended to state that only
 *       the database can confirm.
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
 *     esign 1 · checklist 2 · form 1 · event 3 · manual 0 · case_field 1 ·
 *     report 1 (key→id lookup) + one reportService.runReport per unique
 *     report_key (execution itself is the report stack's, not this file's).
 * The event detector's 3 is caseEventService.listForCases (cases, events,
 * appts) — U5 traded 1 query for the frozen §3.1 read layer and its
 * vocabulary. Still a fixed count for ALL cases and ALL requirements, which
 * is the property this section is about; the constant moved, the shape did
 * not.
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
// event — a calendar item (appt, event, or either) of the configured type in
// the wanted state. (U5: keys, not labels; all three sources live.)
// ─────────────────────────────────────────────────────────────────────────────

/** THE FROZEN SELECTOR (R2 spec; kind_or_type widened to a list in F1):
 *    { source: 'appt'|'event'|'any', kind_or_type: <string> | <string[]>,
 *      want: 'held'|'scheduled'|'missed'|'any',   default 'held'
 *      which: 'latest'|'first'|'any' }            default 'latest'
 *
 *  The SHAPE is unchanged by U5. What changed is what `kind_or_type` VALUES
 *  mean and where the rows come from.
 *
 *  ── U5: KEYS AND KINDS, NOT LABELS (v0.5 §3.3 / §6.1) ────────────────────
 *  Each configured value is matched against the row's `type_key` FIRST, then
 *  its `kind_key` — both case-insensitively, both from
 *  caseEventService's normalized rows. So:
 *
 *    ['iss', 'ss']   → exactly those two registry types
 *    ['meeting']     → every appt (appts are 'meeting' BY TABLE, v0.5 §3.3.2)
 *    ['deadline']    → every deadline event
 *    ['iss', 'deadline'] → a mixed set; a value is a type key or a kind, and
 *                    nothing stops one selector from naming both
 *
 *  The registry (`calendar_item_types`) is the vocabulary. `GET
 *  /api/calendar-types` lists it. A LABEL ('Initial Strategy Session') is no
 *  longer a match — U5's migration rewrote the one live selector to keys, and
 *  a stale label config now resolves UNSATISFIED rather than silently half-
 *  matching. That is the intended failure: labels were never a stable
 *  identity (four live spellings of one activity — see F1 below), keys are.
 *
 *  ── F1's ALIAS LIST IS NOW A KEY LIST ────────────────────────────────────
 *  F1 existed because a single label could only ever name one spelling, and
 *  the live data had four for the Initial Strategy Session ('Initial Strategy
 *  Session', 'Strategy Session', 'Consultation', the typo'd 'Intial Strategy
 *  Session'), two of them in CONCURRENT use — not a rename with a cutover
 *  date, so no migration could collapse them without falsifying history.
 *  The registry absorbed the typo as an `ingest_aliases` entry at write time,
 *  so 'Intial Strategy Session' rows carry type_key 'iss' like the rest; the
 *  three genuinely-different activities keep three keys and the selector
 *  keeps listing them. A string and a one-element array remain EXACTLY
 *  equivalent.
 *
 *  ── ALL THREE SOURCES, ONE MATCHER (U5, path 1) ──────────────────────────
 *  Rows come from `caseEventService.listForCases` — the frozen §3.1 read
 *  layer — for every source, including 'appt'. One code path, one vocabulary,
 *  and the read layer's dead-row rules for free:
 *
 *    · superseded events are excluded in ITS SQL (superseded_by_event_id IS
 *      NULL), as are appt tombstones (appt_status <> 'Rescheduled') — the
 *      same exclusion this detector used to spell out itself;
 *    · 'contact'-linked and unlinked events are not case-scoped and never
 *      appear;
 *    · a docket-anchored event reaches its case through the read layer's
 *      case_number join, which the old appt-only SQL could not see at all.
 *
 *  QUERY BUDGET: 3, not 1 (was: one appt query). listForCases is 3 for ALL
 *  cases and ALL requirements — cases, events, appts — so the batching
 *  contract ("a fixed small number for N cases × M requirements") holds; the
 *  constant moved. Asserted in tests/requirementService.test.js.
 *
 *  ── want × source ────────────────────────────────────────────────────────
 *    want held      → status_norm 'held'      (appt 'Attended' / event 'Completed')
 *         scheduled → status_norm 'scheduled'
 *         missed    → status_norm 'missed'    (appt 'No Show' ONLY — events have
 *                     no missed status; `events.event_status` is
 *                     Scheduled|Completed|Canceled and the deadline `missed`
 *                     sweep is U6/A7. want:'missed' on source 'event' is
 *                     therefore honestly unsatisfiable today, not broken.)
 *         any       → EXISTENCE. Canceled included (a canceled item still
 *                     happened as a record); dead rows already excluded above.
 *
 *  `which` picks AMONG MATCHES by starts_at: 'latest' = max, 'first' = min,
 *  'any' = existence (satisfied_at reported from the latest match). It never
 *  changes WHETHER the requirement is satisfied. (F1) "matches" is the UNION
 *  across every configured value — the list describes one work item, so
 *  'first' means the first session under ANY of its keys.
 *
 *  satisfied_at = the picked row's start, as a Date. The read layer emits a
 *  NAIVE firm-local 'YYYY-MM-DD HH:MM:SS' string; the pool runs
 *  `timezone:'Z'`, so re-reading it as if-UTC reconstructs BYTE-IDENTICALLY
 *  the Date mysql2 handed the pre-U5 detector. Every other detector returns a
 *  Date and portalCaseService feeds satisfied_at to utcToLocal — returning
 *  the bare string here would silently shift portal dates.
 *
 *  detail = the row's raw status label, mapped back from status_norm per
 *  source, so `case.html`'s requirement subtitle reads 'Attended' after U5
 *  exactly as it read 'Attended' before it. The map is 1:1 over every live
 *  status; an unknown/blank status normalizes to null and reports null detail
 *  (unchanged: the six blank-enum 2024 appts already did).
 */
const EVENT_SOURCES = ['appt', 'event', 'any'];
const EVENT_WANTS = ['held', 'scheduled', 'missed', 'any'];
const EVENT_WHICH = ['latest', 'first', 'any'];

const KIND_OR_TYPE_MAX = 60;

/** status_norm → the raw status label of the table it came from. The inverse
 *  of caseEventService's *_STATUS_NORM maps, which are 1:1 over live data.
 *  'Rescheduled' has no entry on purpose — it is a tombstone the read layer
 *  never returns by default. */
const EVENT_STATUS_LABEL = Object.freeze({
  appt:  Object.freeze({ held: 'Attended',  scheduled: 'Scheduled', missed: 'No Show', canceled: 'Canceled' }),
  event: Object.freeze({ held: 'Completed', scheduled: 'Scheduled', canceled: 'Canceled' }),
});

/** (F1) kind_or_type accepts a bare string OR a non-empty array of them.
 *  Normalized to an array so caller and validator share one shape; a
 *  non-conforming value yields [] and the caller reports the error. */
function kindList(v) {
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v : [];
}

/** Naive firm-local 'YYYY-MM-DD HH:MM:SS' → the Date mysql2 would have made
 *  of the same column under the pool's `timezone:'Z'`. Round-trip exact. */
function naiveToDate(s) {
  if (s == null || s === '') return null;
  const d = new Date(`${String(s).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const eventDetector = {
  key: 'event',
  label: 'Appointment / event (registry keys)',
  config_hint: '{ "source": "appt", "kind_or_type": ["iss", "ss"], "want": "held", "which": "latest" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    const bad = unknownKeys(o, ['source', 'kind_or_type', 'want', 'which']);
    if (bad) return bad;
    if (!EVENT_SOURCES.includes(o.source)) {
      return `source must be one of: ${EVENT_SOURCES.join(', ')}`;
    }
    // (F1) string | non-empty string[]. Each element goes through the SAME
    // reqString check the single-string form has always used, so the string
    // case is byte-identical and the array case cannot smuggle a blank or an
    // over-length value past a check the scalar form applies.
    if (Array.isArray(o.kind_or_type)) {
      if (o.kind_or_type.length === 0) {
        return 'kind_or_type must be a non-empty string or a non-empty array of non-empty strings';
      }
      for (let i = 0; i < o.kind_or_type.length; i++) {
        const v = o.kind_or_type[i];
        if (typeof v !== 'string' || v.trim() === '') {
          return `kind_or_type[${i}] must be a non-empty string`;
        }
        if (v.length > KIND_OR_TYPE_MAX) {
          return `kind_or_type[${i}] must be at most ${KIND_OR_TYPE_MAX} characters`;
        }
      }
    } else {
      const ks = reqString(o, 'kind_or_type', KIND_OR_TYPE_MAX);
      if (ks) return ks;
    }
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
      if (EVENT_SOURCES.includes(cfg.source)) return true;
      // Read-time guard: validateConfig rejects an unknown source at write
      // time, so a stored one means data written around the validator. It
      // resolves UNSATISFIED, loudly — never silently satisfied, never a
      // crash that takes the whole resolver pass with it.
      console.warn(
        `[requirementDetectors] event requirement "${reqKey}" has ` +
        `source="${cfg.source}" — not a known source ` +
        `(${EVENT_SOURCES.join('|')}); resolving unsatisfied`
      );
      return false;
    });
    // Every configured value from EVERY requirement is matched in JS against
    // one batched read; the selector list costs nothing per entry.
    const anyValues = pairs.some(([, cfg]) =>
      kindList(cfg.kind_or_type).some((t) => String(t).trim() !== ''));
    if (!ids.length || !pairs.length || !anyValues) return out;   // 0 queries

    // Lazy require — the reportService precedent below. caseEventService pulls
    // luxon + calendarTypeService at load; this file is required from
    // pipelineService's dependency graph and stays boot-cheap.
    const caseEventService = require('./caseEventService');

    // 3 queries, whatever N is. Defaults: superseded events and Rescheduled
    // appt tombstones excluded; no attendees; no date bounds.
    const byCase = await caseEventService.listForCases(db, ids);

    // listForCases keys by the CANONICAL cases.case_id. The caller's ids are
    // already canonical today (requirementService takes them from its own
    // `cases` query), but the read layer matches case ids case-insensitively
    // and so must the bucketing here — the same rule ciKey exists for.
    const rowsByKey = new Map();
    for (const [cid, rows] of byCase) rowsByKey.set(ciKey(cid), rows);

    for (const caseId of ids) {
      const rows = rowsByKey.get(ciKey(caseId));
      if (!rows || !rows.length) continue;

      for (const [reqKey, cfg] of pairs) {
        const want = cfg.want === undefined ? 'held' : cfg.want;
        const which = cfg.which === undefined ? 'latest' : cfg.which;
        const wanted = new Set(
          kindList(cfg.kind_or_type).map((t) => ciKey(t)).filter((t) => t !== '')
        );
        if (!wanted.size) continue;

        const matches = rows.filter((r) => {
          if (cfg.source !== 'any' && r.source !== cfg.source) return false;
          // type_key FIRST, then kind_key (v0.5 §6). A value naming a kind
          // matches every row of that kind; a value naming a type matches
          // only that type. Unmapped rows carry their raw label as type_key
          // (caseEventService's passthrough) and so cannot accidentally match
          // a key a consumer bound.
          const tk = ciKey(r.type_key);
          const kk = ciKey(r.kind_key);
          if (!(tk && wanted.has(tk)) && !(kk && wanted.has(kk))) return false;
          if (want !== 'any' && r.status_norm !== want) return false;
          // satisfied_at IS the protocol (see the registry contract), and a
          // row with no start cannot supply one. Both date columns are NOT
          // NULL, so this is defensive, not a live path.
          return r.starts_at != null;
        });
        if (!matches.length) continue;

        // 'first' = min starts_at; 'latest' and 'any' = max. The read layer's
        // naive 'YYYY-MM-DD HH:MM:SS' shape is fixed-width, so lexicographic
        // order IS chronological order — no Date parsing in the hot loop.
        let pick = matches[0];
        for (const r of matches.slice(1)) {
          if (which === 'first' ? r.starts_at < pick.starts_at : r.starts_at > pick.starts_at) {
            pick = r;
          }
        }
        const at = naiveToDate(pick.starts_at);
        if (!at) continue;
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: at,
          detail: (EVENT_STATUS_LABEL[pick.source] || {})[pick.status_norm] || null,
          progress: null,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// case_field — a whitelisted DATE/DATETIME column on `cases` is set. (R2.6
// Tier 1: the typed, batched, everyday tier.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE WHITELIST IS A CODE MAP, and the map is the contract: stored configs
 * hold FIELD_MAP keys, the map holds the physical column. Keys equal column
 * names in v1 (identity mapping); a future column rename edits the map, not
 * every stored config. The SQL column list is built ONLY from map values —
 * never from config strings — so a config that somehow bypassed
 * validateConfig still cannot name an arbitrary column (belt and
 * suspenders; validateConfig is the belt).
 *
 * Entries verified against live information_schema 2026-08-26: all DATE,
 * except show_cause and case_341_current (DATETIME).
 *
 * NO '0000-00-00' DEFENSIVE FILTERS — the reportSchema manifest records the
 * 2026-07-29 zero-date purge; write paths normalize blank→NULL, and
 * comparing a DATE column to that literal is a hard error under
 * NO_ZERO_DATE. `IS NOT NULL` is the whole test.
 *
 * satisfied_at = the column value; detail = the date formatted short
 * (YYYY-MM-DD, LOCAL date parts — toISOString would shift a local-midnight
 * DATE to the previous UTC day); progress = null.
 */
const FIELD_MAP = Object.freeze({
  case_open_date:               { column: 'case_open_date',               label: 'Open date' },
  case_file_date:               { column: 'case_file_date',               label: 'File date' },
  case_close_date:              { column: 'case_close_date',              label: 'Close date' },
  case_discharge_date:          { column: 'case_discharge_date',          label: 'Discharge date' },
  case_341_initial:             { column: 'case_341_initial',             label: '341 initial date' },
  case_341_current:             { column: 'case_341_current',             label: '341 current date' },
  docs_due:                     { column: 'docs_due',                     label: 'Docs due' },
  show_cause:                   { column: 'show_cause',                   label: 'Show cause' },
  schedules_due_original:       { column: 'schedules_due_original',       label: 'Schedules due (original)' },
  schedules_due_proposed:       { column: 'schedules_due_proposed',       label: 'Schedules due (proposed)' },
  matrix_date_original:         { column: 'matrix_date_original',         label: 'Matrix date (original)' },
  matrix_date_proposed:         { column: 'matrix_date_proposed',         label: 'Matrix date (proposed)' },
  filing_fee_extended_deadline: { column: 'filing_fee_extended_deadline', label: 'Filing fee extended deadline' },
  final_installment:            { column: 'final_installment',            label: 'Final installment' },
  case_objection:               { column: 'case_objection',               label: 'Objection deadline' },
  case_180:                     { column: 'case_180',                     label: '180-day deadline' },
  case_preference:              { column: 'case_preference',              label: 'Preference date' },
});

/** Short local-date format for hit.detail. Accepts Date or string. */
function fmtDateShort(v) {
  if (v instanceof Date) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

const caseFieldDetector = {
  key: 'case_field',
  label: 'Case field set (date columns)',
  config_hint: '{ "field": "case_discharge_date" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    const bad = unknownKeys(o, ['field']);
    if (bad) return bad;
    if (!Object.prototype.hasOwnProperty.call(FIELD_MAP, o.field)) {
      return `field must be one of: ${Object.keys(FIELD_MAP).join(', ')}`;
    }
    return null;
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const ids = (caseIds || []).map(String);
    const pairs = uniqueReqs(reqs).filter(([reqKey, cfg]) => {
      if (Object.prototype.hasOwnProperty.call(FIELD_MAP, cfg.field)) return true;
      // Read-time guard (event-detector pattern): a stored non-whitelist
      // field should be impossible; if data was written around the
      // validator it resolves UNSATISFIED, loudly — and, because the SQL
      // column list below is built from FIELD_MAP values only, it can
      // never reach the query.
      console.warn(
        `[requirementDetectors] case_field requirement "${reqKey}" has ` +
        `field="${cfg.field}" — not in the whitelist; resolving unsatisfied`
      );
      return false;
    });
    const columns = [...new Set(pairs.map(([, cfg]) => FIELD_MAP[cfg.field].column))];
    if (!ids.length || !columns.length) return out;

    // ONE query for all cases and all field-requirements: the union of
    // referenced columns. Column names come from the frozen map, never
    // from stored strings.
    const [rows] = await db.query(
      `SELECT case_id, ${columns.join(', ')} FROM cases WHERE case_id IN (?)`,
      [ids]
    );

    const byCase = new Map();
    for (const r of rows) byCase.set(String(r.case_id), r);

    for (const caseId of ids) {
      const row = byCase.get(caseId);
      if (!row) continue;
      for (const [reqKey, cfg] of pairs) {
        const v = row[FIELD_MAP[cfg.field].column];
        if (v == null) continue;   // IS NOT NULL is the whole test
        ensureCase(out, caseId).set(reqKey, {
          satisfied_at: v,
          detail: fmtDateShort(v),
          progress: null,
        });
      }
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// report — a saved report (report_definitions) says so. (R2.6 Tier 2: the
// escape hatch for arbitrary lookups — any manifest-allowed table, joins —
// reusing the existing report execution stack: RO MySQL user, manifest
// validator, EXPLAIN gate, row caps, report_runs logging. Generic SQL in
// detector_config was considered and REJECTED; this lane already exists and
// already has the guardrails.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CONTRACT FOR A BACKING REPORT:
 *   - kind 'report' or 'view' (the only kinds report_definitions allows);
 *   - ZERO params — the detector supplies none and validateConfigDb refuses
 *     a definition that declares any;
 *   - columns MUST include `case_id` and `satisfied_at`; `detail` and
 *     `progress` are optional. A row with non-null satisfied_at = that case
 *     satisfied. A row with NULL satisfied_at is an unsatisfied hit that
 *     still carries detail/progress (the checklist detector's
 *     "4 of 7 received" shape — the resolver already renders it).
 *   - if the report emits multiple rows for one case, a satisfied row beats
 *     an unsatisfied one; among rows of equal standing the first wins.
 *     Author reports to emit at most one row per case.
 *   - recommend is_locked=1 on backing reports (reportService already
 *     enforces lock protection) — a casually edited report silently changes
 *     what a requirement MEANS.
 *
 * Referenced by report_key, not id: keys are immutable after creation
 * (enforced in reportService), survive definition restores, and read as
 * intent in stored config — the lib/internal_functions/reports.js
 * rationale, verbatim.
 *
 * KEY→ID LOOKUP DIVERGENCE (flagged per R2.6): reportService.runReport
 * resolves by id ONLY (getReport(db, id); no key path exists). Both
 * validateConfigDb and batchResolve therefore do a one-query
 * report_definitions key→id lookup — the internal_functions precedent,
 * verbatim — before handing execution to runReport. Resolution/lookup is
 * not execution: caps, manifest, EXPLAIN gate and run logging all still
 * belong to the report stack. batchResolve's lookup is ONE query for ALL
 * keys (IN (?)); tests assert 1 db.query, not 0.
 *
 * READ-TIME FAIL-SOFT (event-detector philosophy): any runReport throw —
 * report deleted, deactivated, manifest retired a table, EXPLAIN refusal —
 * warns naming the requirement + report_key + error and resolves that key
 * unsatisfied for all cases. A broken report must never 500 getPipeline or
 * the board. A broad report runs fully even when resolving one case —
 * bounded by row caps + the EXPLAIN gate; accepted.
 *
 * userId 0 on runs — the machine-caller convention (internal_functions
 * precedent): report_runs rows are attributable to automation, and every
 * guard still applies.
 */
const REPORT_KEY_MAX = 60;

const reportDetector = {
  key: 'report',
  label: 'Saved report (advanced)',
  config_hint: '{ "report_key": "req_tax_returns" }',

  validateConfig(cfg) {
    const o = asObject(cfg);
    if (!o) return 'config must be a JSON object';
    return unknownKeys(o, ['report_key']) || reqString(o, 'report_key', REPORT_KEY_MAX);
  },

  async validateConfigDb(db, cfg) {
    // Lazy require — boot-safety by construction (internal_functions
    // convention); this file must stay loadable with zero env.
    const reportService = require('./reportService');
    const key = String((cfg || {}).report_key || '').trim();

    const [[found]] = await db.query(
      `SELECT id FROM report_definitions WHERE report_key = ? LIMIT 1`,
      [key]
    );
    if (!found) return `no report with report_key "${key}"`;

    const report = await reportService.getReport(db, found.id);
    if (!report.is_active) return `report "${key}" is inactive`;
    const nParams = (report.params || []).length;
    if (nParams > 0) {
      return `report "${key}" declares ${nParams} param(s) — a backing report must take zero`;
    }

    // Run it ONCE at save time — the booby-trap philosophy applied: a
    // report that cannot run or has the wrong shape must fail at
    // authoring, not on the board.
    let result;
    try {
      result = await reportService.runReport(db, found.id, {}, 0);
    } catch (e) {
      return `report "${key}" failed to run: ${e.message}`;
    }
    const names = (result.fields || []).map((f) => f.name);
    const missing = ['case_id', 'satisfied_at'].filter((n) => !names.includes(n));
    if (missing.length) {
      return `report "${key}" is missing required column(s): ${missing.join(', ')} ` +
             `(must select case_id and satisfied_at)`;
    }
    return null;
  },

  async batchResolve(db, caseIds, reqs) {
    const out = emptyResult();
    const reportService = require('./reportService');
    const ids = (caseIds || []).map(String);
    const pairs = uniqueReqs(reqs).filter(([reqKey, cfg]) => {
      if (typeof cfg.report_key === 'string' && cfg.report_key.trim() !== '') return true;
      console.warn(
        `[requirementDetectors] report requirement "${reqKey}" has a blank ` +
        `report_key; resolving unsatisfied`
      );
      return false;
    });
    const keys = [...new Set(pairs.map(([, cfg]) => String(cfg.report_key).trim()))];
    if (!ids.length || !keys.length) return out;

    // ONE lookup for all keys (see docblock divergence note).
    const [defs] = await db.query(
      `SELECT id, report_key FROM report_definitions WHERE report_key IN (?)`,
      [keys]
    );
    const idByKey = new Map(defs.map((d) => [ciKey(d.report_key), d.id]));

    // One runReport per unique key; fail-soft per key.
    const hitsByKey = new Map();   // ciKey(report_key) -> Map(caseId -> hit)
    for (const key of keys) {
      const reqNames = pairs
        .filter(([, cfg]) => ciKey(cfg.report_key) === ciKey(key))
        .map(([k]) => k).join(', ');
      const reportId = idByKey.get(ciKey(key));
      if (!reportId) {
        console.warn(
          `[requirementDetectors] report requirement(s) ${reqNames}: no report ` +
          `with report_key "${key}"; resolving unsatisfied`
        );
        continue;
      }
      let result;
      try {
        result = await reportService.runReport(db, reportId, {}, 0);
      } catch (e) {
        console.warn(
          `[requirementDetectors] report requirement(s) ${reqNames}: report ` +
          `"${key}" failed (${e.message}); resolving unsatisfied`
        );
        continue;
      }
      const hits = new Map();
      for (const r of result.rows || []) {
        if (r == null || r.case_id == null) continue;
        const ck = String(r.case_id);
        const hit = {
          satisfied_at: r.satisfied_at == null ? null : r.satisfied_at,
          detail: r.detail == null ? null : String(r.detail),
          progress: r.progress == null ? null : String(r.progress),
        };
        const prev = hits.get(ck);
        if (!prev || (hit.satisfied_at != null && prev.satisfied_at == null)) {
          hits.set(ck, hit);
        }
      }
      hitsByKey.set(ciKey(key), hits);
    }

    for (const caseId of ids) {
      for (const [reqKey, cfg] of pairs) {
        const hits = hitsByKey.get(ciKey(cfg.report_key));
        if (!hits) continue;
        const hit = hits.get(caseId);
        if (hit) ensureCase(out, caseId).set(reqKey, hit);
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
  case_field: caseFieldDetector,
  report: reportDetector,
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
