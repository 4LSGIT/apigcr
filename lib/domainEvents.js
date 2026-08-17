// lib/domainEvents.js
//
/**
 * Domain Events — internal event emitter for the Trigger System (Slice T1)
 * lib/domainEvents.js
 *
 * Services call emit() at their post-commit choke points; the trigger engine
 * (services/triggerService.js) evaluates trigger_rules for the event type and
 * fires their actions through the same hookFilter / hookMapper /
 * actionDispatchers primitives the YisraHook and ingest-rule systems use.
 *
 * CONTRACT
 *   emit(db, eventType, payload) is FIRE-AND-FORGET and NEVER THROWS/REJECTS.
 *   Call it bare from service post-commit zones — no .catch() needed:
 *
 *     domainEvents.emit(db, 'appt.attended', {
 *       contact_id, case_id, source, actor: { user_id: actingUserId },
 *       data: {...row snapshot}, extra: { prior_status },
 *     });
 *
 *   Any engine failure is console.error'd and raised through lib/alerting
 *   (kind 'trigger_engine_error'); the caller's flow is never affected.
 *
 * ENVELOPE (what rules filter/transform against)
 *   {
 *     event:      'appt.attended',        // dot-namespaced type string
 *     ts:         ISO timestamp,
 *     depth:      0,                      // trigger-chain depth (see LOOP GUARD)
 *     chain:      [],                     // trigger_rules.id path that led here
 *     source:     'manual'|'system'|'client'|'booking'|null,  // best-effort
 *     actor:      { user_id } | null,
 *     contact_id: number|null,            // promoted for uniform filter paths
 *     case_id:    string|null,            //   + trigger_executions columns
 *     data:       {...entity row AFTER the mutation} | null,
 *     changes:    { field: {from,to} } | null,   // update-class events only
 *     extra:      {...per-event specifics} | null,
 *   }
 *   contact_ssn is stripped from `data` unconditionally — envelopes persist
 *   into trigger_executions.envelope and must not replicate SSNs.
 *
 * LOOP GUARD (AsyncLocalStorage)
 *   Trigger actions run inside runAsAction(ruleId, fn), which enters an ALS
 *   scope with depth+1 and the rule id appended to the chain. Any emit()
 *   fired from code reached *synchronously-in-async-chain* by an action
 *   (internal_function actions — the dangerous tight-loop case — and the
 *   inline portion of workflow starts) inherits that scope, so
 *   trigger → action → mutation → emit chains carry an increasing depth.
 *   triggerService drops events at depth >= MAX_DEPTH and records a
 *   'depth_capped' execution row + alert.
 *
 *   KNOWN LIMITATION: workflow steps deferred through scheduled_jobs (waits)
 *   resume on the job executor with a fresh ALS context — depth resets to 0
 *   for anything they mutate. Acceptable: deferred steps are throttled by the
 *   executor cadence, so they cannot form a tight loop; envelope.source and
 *   envelope.chain still let rule authors gate explicitly.
 *
 * Requires Node >= 12.17 (AsyncLocalStorage). We run Node 24.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Depth at which triggerService refuses to process an event. */
const MAX_DEPTH = 4;

function _scope() {
  return als.getStore() || { depth: 0, chain: [], counters: { dispatches: 0, budgetAlerted: false } };
}

/**
 * Per-root-event counters (Review S6): shared BY REFERENCE down the whole
 * trigger chain of one root event, so triggerService can enforce a total
 * dispatch budget across nesting — MAX_DEPTH bounds chain LENGTH, this
 * bounds total WORK. Returns null outside any trigger scope.
 */
function currentCounters() {
  const s = als.getStore();
  return s ? s.counters : null;
}

/**
 * Deep-copy with Date → ISO-string conversion (depth-limited).
 *
 * The mysql2 pool runs timezone:'Z', so datetime columns arrive as JS Date
 * objects. Left raw, hookFilter's String(actual) would compare against
 * "Sun Aug 17 2026 …" at match time while JSON.stringify stores ISO in the
 * trigger_executions sample — a rule authored from a sample would never
 * match live. Serializing here makes matching and samples see identical
 * values. Buffers → null (never useful in an envelope).
 */
function _jsonSafe(val, depth = 0) {
  if (val == null || typeof val !== 'object') return val;
  if (val instanceof Date) return val.toISOString();
  if (Buffer.isBuffer(val)) return null;
  if (depth >= 6) return null; // cycle/pathology guard
  if (Array.isArray(val)) return val.map(v => _jsonSafe(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(val)) out[k] = _jsonSafe(v, depth + 1);
  return out;
}

/**
 * Build the canonical envelope for an event at the current chain scope.
 * Exported for triggerService's dry-run endpoint and for tests.
 */
function buildEnvelope(eventType, payload = {}) {
  const s = _scope();
  const {
    contact_id = null,
    case_id    = null,
    source     = null,
    actor      = null,
    data       = null,
    changes    = null,
    extra      = null,
  } = payload || {};

  // Deep-copy with Date→ISO conversion, then redact secret-bearing columns —
  // envelopes persist into trigger_executions (30–90d retention, readable by
  // any staff JWT/API key and the readonly SQL endpoint, rendered by the
  // samples panel). Review M2: a bare contact_ssn strip was not enough once
  // full-row snapshots (contact.updated: 32 cols, case.updated: 61) started
  // flowing — contact_token (renamed from booking_token 2026-08-17;
  // now also gates video contact_only) is bearer-ish and was being replicated.
  //
  // DENYLIST (not the reviewer-preferred catalog allowlist), deliberately:
  // the field catalog is a DISCOVERY aid — the Custom-path escape hatch and
  // arbitrary-column `changes.<col>` rules are designed features, and an
  // allowlist projection would break both. The suffix PATTERN future-proofs
  // against new token/secret-named columns being auto-published.
  let safeData = _redact(_jsonSafe(data));
  const safeChanges = _redact(_jsonSafe(changes));
  const safeExtra = _jsonSafe(extra);

  return {
    event:      eventType,
    ts:         new Date().toISOString(),
    depth:      s.depth,
    chain:      s.chain.slice(),
    source:     source ?? null,
    actor:      actor ?? null,
    // '' case_id (createAppt's default) normalizes to null so `exists`
    // conditions and the executions column behave.
    contact_id: contact_id ?? null,
    case_id:    (case_id === '' || case_id == null) ? null : String(case_id),
    data:       safeData,
    changes:    safeChanges ?? null,
    extra:      safeExtra ?? null,
  };
}

const REDACT_KEYS = new Set([
  'contact_ssn', 'contact_token', 'portal_session_version',
]);
const REDACT_PATTERN = /(_token|_secret|_password|password|_pin|pin_hash|api_key|apikey)$/i;

/**
 * Delete secret-bearing TOP-LEVEL keys from a (fresh-copy) object in place.
 * Top-level is sufficient: envelope data/changes are row-shaped (column-keyed);
 * changes values are {from,to} under the column key, so the key check covers
 * both directions.
 */
function _redact(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  for (const k of Object.keys(obj)) {
    if (REDACT_KEYS.has(k) || REDACT_PATTERN.test(k)) delete obj[k];
  }
  return obj;
}

/**
 * Emit a domain event. Fire-and-forget; never throws, never rejects.
 * Returns a promise that always resolves (awaitable in tests).
 *
 * @param {object} db         mysql2 pool
 * @param {string} eventType  e.g. 'appt.created'
 * @param {object} payload    see ENVELOPE above
 */
function emit(db, eventType, payload = {}) {
  let envelope;
  try {
    envelope = buildEnvelope(eventType, payload);
  } catch (err) {
    console.error(`[domainEvents] envelope build failed for ${eventType}:`, err.message);
    try {
      const { alert } = require('./alerting');
      alert(db, {
        source: 'app', kind: 'trigger_engine_error', severity: 'warning',
        group_key: 'trigger_engine',
        title: `Trigger envelope build failed for ${eventType}`,
        message: err.message,
      }).catch(() => {});
    } catch (_) {}
    return Promise.resolve();
  }

  return (async () => {
    // Lazy require — triggerService pulls in actionDispatchers / hook engines
    // which transitively reach back into services; keep the load-time graph
    // acyclic (same convention as hookService's delivery engines).
    const triggerService = require('../services/triggerService');
    if (als.getStore()) {
      // Nested emission — inherit the root event's scope (and its budget
      // counters) as-is.
      await triggerService.processEvent(db, envelope);
    } else {
      // Root emission — establish the scope that carries the shared
      // dispatch-budget counters for this event's whole trigger tree.
      await als.run(
        { depth: 0, chain: [], counters: { dispatches: 0, budgetAlerted: false } },
        () => triggerService.processEvent(db, envelope)
      );
    }
  })().catch((err) => {
    console.error(`[domainEvents] trigger processing failed for ${eventType}:`, err.message);
    try {
      const { alert } = require('./alerting');
      alert(db, {
        source:    'app',
        kind:      'trigger_engine_error',
        severity:  'warning',
        group_key: 'trigger_engine',
        title:     `Trigger engine failed on ${eventType}`,
        message:   err.message,
        context:   { event: eventType, depth: envelope.depth },
      }).catch(() => {});
    } catch (_) { /* alerting unavailable — already console.error'd */ }
  });
}

/**
 * Run fn inside a child trigger scope (depth+1, ruleId appended to chain).
 * triggerService wraps every action dispatch in this so re-emissions from
 * action side effects carry the incremented depth.
 *
 * @param {number} ruleId
 * @param {function(): Promise<any>} fn
 */
function runAsAction(ruleId, fn) {
  const s = _scope();
  // counters intentionally SHARED (same object) — the dispatch budget is
  // per ROOT EVENT, across all nesting levels.
  return als.run({ depth: s.depth + 1, chain: [...s.chain, ruleId], counters: s.counters }, fn);
}

// ─────────────────────────────────────────────────────────────
// CHANGE-DIFF HELPER (T3) — used by updateContact / updateCase
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a value for change comparison. Handles the mysql2 fake-UTC
 * convention: DATE/DATETIME columns arrive as JS Dates whose ISO string IS
 * the stored wall clock; the caller's new value is a 'YYYY-MM-DD[ HH:mm:ss]'
 * string. Both sides normalize to the same canonical form so an unchanged
 * date isn't flagged as changed. ISO 'T' is only replaced when the string
 * actually looks like an ISO datetime (never inside ordinary text).
 */
function _diffNorm(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z')
      ? iso.slice(0, 10)
      : iso.slice(0, 19).replace('T', ' ');
  }
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) s = s.replace('T', ' ').slice(0, 19);
  return s;
}

/**
 * Compute a { field: {from, to} } change map between a pre-write row and the
 * fields about to be (or just) written. Only `keys` are compared. Unchanged
 * fields (after normalization) are omitted. False positives are possible on
 * exotic value shapes and are cosmetic — an extra changes entry, never a
 * missed one for scalar columns.
 *
 * @param {object|null} priorRow  pre-write row (or null → empty map)
 * @param {object} nextFields    the written values keyed by column
 * @param {string[]} [keys]      columns to compare (default: nextFields keys)
 */
function buildChanges(priorRow, nextFields, keys) {
  const changes = {};
  if (!priorRow) return changes;
  for (const k of (keys || Object.keys(nextFields || {}))) {
    if (_diffNorm(priorRow[k]) !== _diffNorm(nextFields[k])) {
      changes[k] = { from: priorRow[k] ?? null, to: nextFields[k] ?? null };
    }
  }
  return changes;
}

module.exports = { emit, buildEnvelope, buildChanges, runAsAction, currentCounters, MAX_DEPTH };