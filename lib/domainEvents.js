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
  return als.getStore() || { depth: 0, chain: [] };
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

  // Deep-copy with Date→ISO conversion, then strip SSN from the data
  // snapshot — envelopes persist into trigger_executions and must not
  // replicate SSNs.
  let safeData = _jsonSafe(data);
  if (safeData && typeof safeData === 'object' && 'contact_ssn' in safeData) {
    delete safeData.contact_ssn;
  }
  const safeChanges = _jsonSafe(changes);
  if (safeChanges && typeof safeChanges === 'object' && 'contact_ssn' in safeChanges) {
    delete safeChanges.contact_ssn;
  }
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
    return Promise.resolve();
  }

  return (async () => {
    // Lazy require — triggerService pulls in actionDispatchers / hook engines
    // which transitively reach back into services; keep the load-time graph
    // acyclic (same convention as hookService's delivery engines).
    const triggerService = require('../services/triggerService');
    await triggerService.processEvent(db, envelope);
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
  return als.run({ depth: s.depth + 1, chain: [...s.chain, ruleId] }, fn);
}

module.exports = { emit, buildEnvelope, runAsAction, MAX_DEPTH };
