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
 * SPLIT-PHASE DISPATCH (2026-08-30)
 *   emit() no longer evaluates anything. It writes the envelope to
 *   domain_event_queue and rings a Cloud Tasks doorbell — two cheap
 *   operations. The trigger tree is evaluated by lib/domainEventDrain.js from
 *   a REQUEST-BOUND handler (POST /process-domain-event/:id, with the 60s
 *   /process-jobs cron as the fallback), at full CPU.
 *
 *   WHY: Cloud Run allocates CPU per REQUEST. Everything emit() used to do
 *   ran in a detached post-response tail, throttled, where wall time is real
 *   work plus however long until something grants the instance CPU again —
 *   unbounded. trigger_executions#458 lost rule 4's transform (~8ms of real
 *   work) to a 200ms vm ceiling that way. Raising the ceiling to 15000ms
 *   narrowed the odds; this removes the exposure.
 *
 *   The queue row is the SCHEDULING AUTHORITY; the task is a doorbell. Same
 *   invariant as scheduled_jobs vs. lib/taskQueue.js. Trade made knowingly:
 *   a correctness risk (tree aborted mid-flight, audit rows silently skipped)
 *   becomes a bounded latency risk (~60s worst case, no loss).
 *
 *   The INSERT + doorbell still technically run in the detached tail, because
 *   emit()'s fire-and-forget contract is unchanged (below) and 26 of the 27
 *   call sites ignore the returned promise. Two operations is not an
 *   unbounded tree, and the doorbell already degrades safely to the cron.
 *   Making call sites await emit() is a separate slice needing a per-site
 *   audit — several are deliberately post-response (advanceStage must never
 *   block the primary action).
 *
 *   LOOP GUARD ACROSS THE SPLIT: envelope.depth and envelope.chain are built
 *   here and persist with the envelope, and the drain re-establishes the ALS
 *   scope from them before calling processEvent — so depth-capping is
 *   unaffected. The `counters` object is shared mutable state and CANNOT
 *   survive serialisation; domain_event_queue.dispatches carries it instead,
 *   correlated by root_id. See runInEventScope + lib/domainEventDrain.js.
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
  //
  // `extra` is redacted on the SAME terms as data/changes. It carries
  // emit-site-chosen keys rather than row snapshots, and no current emit
  // site puts a secret there — but "no current emit site does X" is exactly
  // the assumption that stops being true when someone adds the twelfth emit
  // site, and this field persists for 90 days in a staff-readable table.
  // Verified against every live emit site: nothing currently emitted is
  // redacted by this call (from_stage, to_stage, note, surface,
  // recipient_email, prior_status, stage_log_id, replayed_from/at all pass).
  let safeData = _redact(_jsonSafe(data));
  const safeChanges = _redact(_jsonSafe(changes));
  const safeExtra = _redact(_jsonSafe(extra));

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

  // Root correlation for the cross-process dispatch budget. Read BEFORE the
  // async boundary, while we are still synchronously inside the caller's ALS
  // scope. Rides on the `counters` object rather than on the scope itself
  // because runAsAction already shares counters BY REFERENCE down the whole
  // chain — so rootId propagates for free and runAsAction needs no change.
  // Null here means "root emission": the drain then treats the new row's own
  // id as the root.
  const scope = als.getStore();
  const rootId = (scope && scope.counters && scope.counters.rootId) || null;

  return (async () => {
    // PHASE 1 — persist. This row is the scheduling authority: once it is
    // committed the event cannot be lost, whatever happens to this instance.
    //
    // db is the autocommit pool at all 27 emit sites (verified structurally:
    // none is lexically inside a withTransaction callback), so the row is
    // committed the moment this resolves and the doorbell below cannot beat
    // it. INVARIANT: if a future emit site ever passes a TRANSACTION
    // connection, the task would fire against an invisible row and burn
    // itself as already-claimed, leaving the event to the 60s cron. Commit
    // first, or accept cron latency for that site.
    const [res] = await db.query(
      `INSERT INTO domain_event_queue (event_type, root_id, envelope) VALUES (?, ?, ?)`,
      [eventType, rootId, JSON.stringify(envelope)]
    );
    const queueId = res.insertId;

    // PHASE 2 — ring the doorbell. Latency optimisation ONLY. If Cloud Tasks
    // is disabled, misconfigured, throttled or down, enqueueDomainEventDispatch
    // warns and returns false, and the row rides the 60s /process-jobs cron
    // exactly as it would have. AWAITED for the same reason scheduleResume
    // awaits its enqueue: nothing user-visible is waiting on this return, so
    // awaiting costs nothing and buys determinism — the warn line lands before
    // the caller moves on instead of floating as an unreferenced promise.
    const { enqueueDomainEventDispatch } = require('./taskQueue');
    await enqueueDomainEventDispatch(queueId);
  })().catch((err) => {
    // Unchanged failure contract: console.error + alert, never throw. The
    // only difference is WHAT can fail here — an INSERT and an RPC, not the
    // whole trigger tree.
    console.error(`[domainEvents] queueing failed for ${eventType}:`, err.message);
    try {
      const { alert } = require('./alerting');
      alert(db, {
        source:    'app',
        kind:      'trigger_engine_error',
        severity:  'warning',
        group_key: 'trigger_engine',
        title:     `Trigger engine failed on ${eventType}`,
        message:   err.message,
        context:   { event: eventType, depth: envelope.depth, phase: 'enqueue' },
      }).catch(() => {});
    } catch (_) { /* alerting unavailable — already console.error'd */ }
  });
}

/**
 * Re-establish a trigger scope from a PERSISTED envelope, then run fn inside
 * it. The drain's counterpart to the als.run() emit() used to do inline.
 *
 * depth and chain come off the envelope, so the depth cap and the chain
 * audit behave exactly as they did in-process. `counters` is passed in by the
 * caller because it cannot be serialised — lib/domainEventDrain.js seeds it
 * from domain_event_queue.dispatches on the root row and flushes the delta
 * back afterwards, which is what keeps MAX_DISPATCHES_PER_ROOT a per-ROOT
 * budget across the split.
 *
 * Additive export. Nothing was removed or renamed from module.exports.
 *
 * @param {object} envelope  as persisted by emit()
 * @param {object} counters  { dispatches, budgetAlerted, rootId }
 * @param {function(): Promise<any>} fn
 */
function runInEventScope(envelope, counters, fn) {
  return als.run({
    depth:    envelope?.depth ?? 0,
    chain:    Array.isArray(envelope?.chain) ? envelope.chain.slice() : [],
    counters,
  }, fn);
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

module.exports = {
  emit, buildEnvelope, buildChanges, runAsAction, currentCounters, MAX_DEPTH,
  runInEventScope,
};