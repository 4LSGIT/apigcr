// lib/sequenceEngine.js
//
// Sequence Engine — enrollment, step execution, cancellation.
//
// Public API:
//   enrollContact(db, contactId, templateType, triggerData)
//     → { enrollmentId, templateName, totalSteps, firstJobScheduledAt }
//
//   validateTemplateFilters(db, type, filters)
//     → { valid: true } | { valid: false, error }
//
//   executeStep(db, enrollmentId, stepId)
//     → { status: 'sent'|'skipped'|'failed', reason? }
//
//   cancelSequences(db, contactId, templateType, reason)
//     → { cancelled: number }
//
// Internal helpers (exported for testing):
//   checkCondition(db, condition, triggerData)
//   checkFireGuard(fireGuard, triggerData)
//   calculateStepTime(timing, triggerData, fromDate)
//   buildRefsForStep(triggerData, contactId)

const { resolve }          = require('../services/resolverService');
const { executeJob }       = require('./job_executor');
const calendar             = require('../services/calendarService');
const { parseUserDateTime } = require('../services/timezoneService');

// Slop on the floor comparison for appt-anchored steps: absorbs the
// second-precision truncation of the stored prior-step time (and ~1-min job
// poll jitter) so a twin whose computed time equals the floor isn't dropped.
const SCHEDULE_PAST_SLOP_MS = 90 * 1000; // 90s

// ─────────────────────────────────────────────────────────────
// Condition checker
// Used for both template-level (cancel enrollment) and
// step-level (skip step) conditions.
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a condition object against the DB.
 *
 * Condition shape:
 * {
 *   query:       "SELECT appt_status FROM appts WHERE appt_id = :appt_id",
 *   params:      { "appt_id": "trigger_data.appt_id" },
 *   assert:      { "appt_status": { "in": ["no_show","cancelled"] } },
 *   assert_mode: "all" | "any"   (default "all")
 * }
 *
 * Assert operators per field:
 *   scalar         → strict equality
 *   { in: [...] }  → value in array
 *   { is_null: true/false } → null / not-null check
 *
 * @returns {boolean} true = condition passes (proceed), false = condition fails (skip/cancel)
 */
async function checkCondition(db, condition, triggerData) {
  if (!condition) return true; // no condition = always passes

  const { query, params: paramMap = {}, assert = {}, assert_mode = 'all' } = condition;

  if (!query || typeof query !== 'string') {
    console.error('[sequenceEngine] Invalid condition: missing query');
    return false;
  }

  // Only SELECT allowed
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    console.error('[sequenceEngine] Condition query must be a SELECT');
    return false;
  }

  // Resolve :param placeholders from trigger_data using dot-path.
  //
  // Single-pass tokenization: scan the query for :name tokens in order of
  // appearance and push positional params in the SAME order. This fixes three
  // bugs in the previous per-key loop (which called .replace(':name', '?')):
  //   (1) .replace with a string pattern only replaces the FIRST occurrence,
  //       so queries using the same placeholder twice (e.g.
  //         "... WHERE appt_id = :appt_id OR ref_appt_id = :appt_id")
  //       left the second token unreplaced → MySQL parse error → silent false.
  //   (2) Params were pushed in paramMap iteration order, but MySQL ? params
  //       bind by position in the query. If the JSON author wrote the paramMap
  //       keys in a different order than placeholders appear in the query,
  //       values were silently misaligned.
  //   (3) .replace(':foo', '?') also matches the prefix of :foo_bar. Greedy
  //       \w+ here treats each :name as a whole token, so :foo and :foo_bar
  //       don't collide.
  const resolvedParams      = [];
  const unknownPlaceholders = [];

  let resolvedQuery = query.replace(/:(\w+)/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(paramMap, name)) {
      unknownPlaceholders.push(name);
      return `:${name}`; // leave as-is; surface below
    }
    const sourcePath = paramMap[name];
    const value = getNestedValue(triggerData, sourcePath.replace('trigger_data.', ''));
    if (value === undefined || value === null) {
      console.warn(`[sequenceEngine] Condition param :${name} resolved to null (path: ${sourcePath})`);
    }
    resolvedParams.push(value ?? null);
    return '?';
  });

  if (unknownPlaceholders.length) {
    console.error(
      `[sequenceEngine] Condition query has unknown placeholders: ${unknownPlaceholders.map(n => ':' + n).join(', ')} — paramMap keys: ${Object.keys(paramMap).join(', ') || '(none)'}`
    );
    return false;
  }

  // Add LIMIT 1 if not already present
  if (!/LIMIT\s+\d+/i.test(resolvedQuery)) {
    resolvedQuery += ' LIMIT 1';
  }

  let row;
  try {
    const [rows] = await db.query(resolvedQuery, resolvedParams);
    row = rows[0] || null;
  } catch (err) {
    console.error('[sequenceEngine] Condition query failed:', err.message, resolvedQuery);
    return false;
  }

  if (!row) {
    console.warn('[sequenceEngine] Condition query returned no rows — treating as failed');
    return false;
  }

  // Evaluate assertions
  const assertEntries = Object.entries(assert);
  const results = assertEntries.map(([field, expected]) => {
    const actual = row[field];
    return evaluateAssertion(actual, expected);
  });

  if (assert_mode === 'any') return results.some(Boolean);
  return results.every(Boolean);
}

function evaluateAssertion(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual == null;
  }
  if (typeof expected === 'object') {
    if ('in' in expected) {
      return expected.in.includes(actual);
    }
    if ('is_null' in expected) {
      const isEmpty = actual === null || actual === undefined || actual === '';
      return expected.is_null ? isEmpty : !isEmpty;
    }
  }
  // Scalar: loose equality (handles "1" == 1 etc.)
  // eslint-disable-next-line eqeqeq
  return actual == expected;
}

// ─────────────────────────────────────────────────────────────
// Fire guard checker
// Lightweight time-based check — no DB query.
// ─────────────────────────────────────────────────────────────

/**
 * Check time-based guards against trigger_data.
 * Returns true = ok to fire, false = skip this step.
 */
function checkFireGuard(fireGuard, triggerData) {
  if (!fireGuard) return true;

  const { min_hours_before_appt } = fireGuard;

  if (min_hours_before_appt != null) {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) {
      console.warn('[sequenceEngine] fire_guard.min_hours_before_appt set but trigger_data.appt_time missing');
      return true; // fail open — don't block if we can't check
    }
    const hoursUntilAppt = (new Date(apptTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilAppt < min_hours_before_appt) {
      console.log(`[sequenceEngine] Fire guard: ${hoursUntilAppt.toFixed(1)}h until appt < ${min_hours_before_appt}h minimum — skipping`);
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Timing calculator
// ─────────────────────────────────────────────────────────────

/**
 * Calculate the datetime a step should fire.
 *
 * @param {object} timing     — the step's timing JSON
 * @param {object} triggerData — enrollment trigger_data
 * @param {Date}   fromDate   — reference point (enrollment time for step 1, prev execution for step 2+)
 * @returns {Date}
 */
async function calculateStepTime(timing, triggerData, fromDate, floorDate) {
  const from  = fromDate  ? new Date(fromDate)  : new Date();
  // The "floor" is the timeline position we've already reached: the previous
  // scheduled step's time (or enrollment time for step 1). Appt-anchored steps
  // (before_appt / before_appt_fixed) are SKIPPED only when they fall before
  // this floor — i.e. their checkpoint is genuinely behind us — NOT merely
  // before `now`. This is what lets two conditional twins share the same
  // before_appt offset: when the first fires, the second's computed time
  // equals the floor (not < it), so it schedules and fires right after,
  // instead of being dropped as "past". And it's what makes past pairs skip
  // together (both < floor) with no burst. Defaults to `from` when unset.
  const floor = floorDate ? new Date(floorDate) : from;

  if (!timing || timing.type === 'immediate') {
    return new Date(from.getTime() + 5000); // 5 seconds from now
  }

  if (timing.type === 'delay') {
    // Two modes, distinguished by field presence:
    //
    //   Relative: { value, unit, randomizeMinutes? }
    //   Absolute: { at, randomizeMinutes? }
    //
    // `at` accepts ISO-with-Z, ISO-with-offset, naive ISO (FIRM_TIMEZONE),
    // SQL-style "YYYY-MM-DD HH:MM:SS" (FIRM_TIMEZONE), or date-only "YYYY-MM-DD"
    // (FIRM_TIMEZONE midnight). Past times are returned as-is — the next
    // /process-jobs tick will fire them. {{trigger_data.X}} placeholders
    // are resolved before parsing.
    let scheduled;
    if (typeof timing.at === 'string') {
      const resolvedAt = resolveTriggerDataPlaceholders(timing.at, triggerData);
      const parsed = parseUserDateTime(resolvedAt);
      if (!parsed) {
        // Distinguishing case: original was a placeholder that resolved to
        // empty. Throw so the step's error_policy decides what to do; we
        // intentionally do not silently no-op here (sequences have no
        // skipToStep equivalent).
        throw new Error(
          `delay.at resolved to empty after placeholder resolution: ` +
          `original="${timing.at}", resolved="${resolvedAt}"`
        );
      }
      scheduled = parsed;
    } else {
      const ms = durationToMs(timing.value, timing.unit);
      scheduled = new Date(from.getTime() + ms);
    }
    return applyRandomJitter(scheduled, timing.randomizeMinutes);
  }

  if (timing.type === 'next_business_day') {
    return calendar.nextBusinessDay(from, {
      timeOfDay:        timing.timeOfDay        || '09:00',
      randomizeMinutes: timing.randomizeMinutes || 0,
      maxDaysAhead:     timing.maxDaysAhead     || 30,
      timezone:         timing.timezone,  // undefined = calendarService uses DEFAULT_TZ
    });
  }

  if (timing.type === 'business_days') {
    // N business days from now — walk forward N times
    let current = from;
    for (let i = 0; i < (timing.value || 1); i++) {
      current = await calendar.nextBusinessDay(current, {
        timeOfDay:        timing.timeOfDay        || '09:00',
        randomizeMinutes: timing.randomizeMinutes || 0,
        timezone:         timing.timezone,
      });
    }
    return current;
  }

  if (timing.type === 'open_delay') {
    // Enrollment-anchored "soon, but not during Shabbos/YT" delay. Uses `from`
    // (the scheduling moment), NOT the floor — this isn't an appt-relative
    // step. delay may be 0. See calendarService.nextOpenTime for roll rules.
    const delayMs = timing.delay
      ? durationToMs(timing.delay.value, timing.delay.unit)
      : 0;
    return await calendar.nextOpenTime(from, {
      delayMs,
      jitterMin: timing.jitter    || 0,
      rollTime:  timing.rollTime  || null,
      dayWindow: timing.dayWindow || null,
      noSunday:  timing.noSunday  || false,
      timezone:  timing.timezone,
    });
  }

  if (timing.type === 'before_appt_fixed') {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) throw new Error('before_appt_fixed requires trigger_data.appt_time');
    const hoursMs = durationToMs(timing.hoursBack, 'hours');
    const scheduled = new Date(new Date(apptTime).getTime() - hoursMs);
    // Skip only if the computed time is before the floor (the prior scheduled
    // step's time / enrollment time) — meaning this checkpoint is behind us.
    // A small slop absorbs second-precision truncation of the stored floor.
    // When the time is between floor and now, we still schedule it (at the
    // computed past instant); process_jobs fires it on the next tick.
    if (scheduled.getTime() < floor.getTime() - SCHEDULE_PAST_SLOP_MS) return null;
    return scheduled;
  }

  if (timing.type === 'before_appt') {
    const apptTime = triggerData?.appt_time;
    if (!apptTime) throw new Error('before_appt requires trigger_data.appt_time');

    const attempts = [{
      hoursBack:        timing.hoursBack,
      sameTimeAsAnchor: timing.sameTimeAsAnchor || false,
      timeOfDay:        timing.timeOfDay,
      randomizeMinutes: timing.randomizeMinutes || 0,
      minHoursBefore:   timing.minHoursBefore   || 1,
    }];

    // NOTE: `minHoursBefore` lives on the attempt rule above — not in the
    // outer defaults. `prevBusinessDay` resolves per-attempt first
    // (attemptMin ?? defaults.minHoursBefore), and since we always set the
    // attempt value here, passing it as a default too would be dead config.
    const result = await calendar.prevBusinessDay(new Date(apptTime), attempts, {
      maxDaysBack:    timing.maxDaysBack     || 14,
      timezone:       timing.timezone,
      // Floor: reject slots before the timeline position we've reached, rather
      // than before "now" — so a same-offset conditional twin (computed == the
      // sibling's slot == floor) is NOT rejected as past, and short-notice
      // bookings still skip out-of-runway offsets.
      notBefore:      floor,
    });

    // No placeable business-day slot at/before this offset (e.g. a 7-day
    // reminder on an appt booked 2 days out). Return null to signal "skip"
    // — the scheduler advances to the next still-placeable step instead of
    // wedging the enrollment. (Previously threw, which left an active
    // enrollment with no scheduled job — see the short-notice-booking wedge.)
    if (!result) return null;
    return result.scheduledAt;
  }

  throw new Error(`Unknown timing type: "${timing.type}"`);
}

// ─────────────────────────────────────────────────────────────
// Helpers for absolute-time / randomized timing
// ─────────────────────────────────────────────────────────────

/**
 * Lightweight placeholder resolver scoped to {{trigger_data.X.Y}}. Only
 * used by `delay.at` (absolute mode) — we deliberately do not pull in the
 * full resolverService here because (a) timing must run before the action's
 * config is resolved, (b) we don't want to hit the DB for a timing decision,
 * and (c) the only use case is "let workflows pre-compute an ISO into
 * trigger_data".
 *
 * Unknown paths resolve to "" (same soft-fail behavior as the universal
 * resolver). Modifiers (|date:, |default:, etc.) are NOT supported here —
 * pass a fully-formed ISO string in.
 */
function resolveTriggerDataPlaceholders(str, triggerData) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*trigger_data\.([\w.]+)\s*\}\}/g, (_match, path) => {
    const val = path.split('.').reduce((cur, key) => cur?.[key], triggerData);
    return val == null ? '' : String(val);
  });
}

/**
 * Symmetric ±N minute jitter on a Date. Mirrors the implementation in
 * services/calendarService.js so behavior is consistent across timing types.
 *
 * randomizeMinutes <= 0 (or non-numeric) → no jitter.
 * Distribution: uniform integer minutes in [-N, +N] inclusive.
 */
function applyRandomJitter(date, randomizeMinutes) {
  const n = Number(randomizeMinutes) || 0;
  if (n <= 0) return date;
  const jitter = Math.floor(Math.random() * (n * 2 + 1)) - n;
  return new Date(date.getTime() + jitter * 60 * 1000);
}

function durationToMs(value, unit) {
  const v = Number(value) || 0;
  switch (unit) {
    case 'seconds': return v * 1000;
    case 'minutes': return v * 60 * 1000;
    case 'hours':   return v * 60 * 60 * 1000;
    case 'days':    return v * 24 * 60 * 60 * 1000;
    default:        return v * 60 * 1000; // default: minutes
  }
}

// ─────────────────────────────────────────────────────────────
// Refs builder for resolver
// ─────────────────────────────────────────────────────────────

/**
 * Build the refs object for resolverService.resolve()
 * based on what IDs are available in trigger_data.
 *
 * `trigger_data` itself is also passed through as a pseudo-table, so that
 * action_config placeholders like {{trigger_data.amount}} or
 * {{trigger_data.missed_date|date:dddd}} resolve directly from the enrollment
 * payload without needing a column on a real table.
 */
function buildRefsForStep(triggerData, contactId) {
  const refs = {
    contacts:     { contact_id: contactId },
    trigger_data: triggerData || {},
  };

  if (triggerData?.appt_id)  refs.appts = { appt_id: triggerData.appt_id };
  if (triggerData?.case_id)  refs.cases = { case_id: triggerData.case_id };
  if (triggerData?.task_id)  refs.tasks = { task_id: triggerData.task_id };

  // users — fallback order: explicit `user` → `user_id` → `appt_with`. The
  // users PK column is `user` (not `user_id`). Using `appt_with` as last
  // fallback gives appt-triggered sequences a sensible default user (the
  // staffer the appt is with) without the enrollment site having to copy
  // appt_with into trigger_data.user explicitly.
  //
  // Common reachable columns: users.default_email, users.default_phone,
  // users.user_name. Useful for staff-facing messages that reference the
  // assigned attorney/persona without snapshotting their info into
  // trigger_data at enrollment time.
  const userVal = triggerData?.user ?? triggerData?.user_id ?? triggerData?.appt_with;
  if (userVal) refs.users = { user: userVal };

  return refs;
}

// ─────────────────────────────────────────────────────────────
// enrollContact — generalized cascading template match (Slice E Phase 2)
//
// Replaces the prior hardcoded appt_type / appt_with cascade with a config-
// driven scoring algorithm:
//
//   1. Load the type's row from sequence_template_types (priority_fields,
//      active flag).
//   2. Load every active template of this type.
//   3. Score each template against triggerData per priority_fields:
//        • For priority_fields[i] of length N, a match contributes
//          weight 2^(N-1-i). Earlier fields dominate later ones; the
//          binary weighting guarantees a more-specific template (matches
//          on field K) always outranks any combination of less-specific
//          fields (K+1..N-1), regardless of how many of the latter match.
//        • A template's filter is "wildcard" when its filters JSON has
//          the field absent or null — contributes 0, never disqualifies.
//        • A template's filter is "specific" when filters[field] is set
//          to a value — must equal triggerData[field] or the template is
//          disqualified. If trigger has no value for that field, the
//          specific-filter template is disqualified.
//   4. Sort qualified templates by (score DESC, id ASC). Throw if none.
//
// Cascade fields now flow via triggerData, not a separate filters arg.
// Callers that need cascade specificity flatten the relevant fields into
// triggerData at the call site (see services/apptService.js markNoShow).
//
// Edge cases:
//   • priority_fields = []   → all templates score 0; lowest id wins.
//   • template.filters NULL  → treated as {} (generic fallback).
// ─────────────────────────────────────────────────────────────

/**
 * Enroll a contact in a sequence using cascade template matching.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} templateType   — e.g. 'no_show', 'lead_drip'
 * @param {object} triggerData    — context + cascade fields:
 *                                  { appt_id, appt_time, case_id, enrolled_by, ... }.
 *                                  Any field named in the type's
 *                                  priority_fields acts as a cascade key.
 * @returns {{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }}
 * @throws if type missing/inactive, no templates, or no qualified candidates.
 */
async function enrollContact(db, contactId, templateType, triggerData = {}) {
  // Belt-and-suspenders guard matching the route-level check in POST /sequences/enroll.
  // Without this, a null/empty templateType silently produces zero cascade matches
  // (MySQL `WHERE type = NULL` is always false), then throws "No active template
  // found for type: null" which is confusing. Reject early with a clearer message
  // that tells the caller which function to use for ID-based enrollment.
  if (!templateType || !String(templateType).trim()) {
    throw new Error(
      'enrollContact requires a non-empty templateType; use enrollContactByTemplateId for ID-based enrollment'
    );
  }

  // ── 1. Load type config ──
  const [typeRows] = await db.query(
    `SELECT type, priority_fields, active FROM sequence_template_types WHERE type = ?`,
    [templateType]
  );
  if (!typeRows.length) {
    throw new Error(`Unknown sequence type: "${templateType}" — no row in sequence_template_types`);
  }
  const typeRow = typeRows[0];
  if (!typeRow.active) {
    throw new Error(`Sequence type "${templateType}" is inactive`);
  }
  const priorityFields = Array.isArray(typeRow.priority_fields)
    ? typeRow.priority_fields
    : (typeof typeRow.priority_fields === 'string'
        ? JSON.parse(typeRow.priority_fields)
        : []);

  if (!Array.isArray(priorityFields)) {
    throw new Error(`sequence_template_types["${templateType}"].priority_fields is not a JSON array`);
  }

  // ── 2. Load all active templates of this type ──
  const [templates] = await db.query(
    `SELECT * FROM sequence_templates WHERE type = ? AND active = 1`,
    [templateType]
  );
  if (!templates.length) {
    throw new Error(`No active sequence template found for type: ${templateType}`);
  }

  // ── 3. Score each template ──
  // Filter values from triggerData treat null/undefined uniformly as
  // "field not provided" — same way priorityFields with no triggerData
  // entry collapse to "filter wants value, none provided → disqualify".
  const N = priorityFields.length;
  const scored = [];
  for (const t of templates) {
    let templateFilters;
    if (t.filters == null) {
      templateFilters = {};
    } else if (typeof t.filters === 'string') {
      try { templateFilters = JSON.parse(t.filters); }
      catch { templateFilters = {}; }
    } else {
      templateFilters = t.filters;
    }

    let score = 0;
    let qualified = true;
    for (let i = 0; i < N; i++) {
      const field = priorityFields[i];
      const filterVal = templateFilters[field];
      // Wildcard: filter absent or explicitly null in JSON.
      if (filterVal === undefined || filterVal === null) continue;

      const triggerVal = triggerData[field];
      if (triggerVal === undefined || triggerVal === null) {
        qualified = false;
        break;
      }
      // Multi-value filters: a filter field may hold a single value, a JSON
      // array, or a delimiter-separated string (bar `|` preferred; comma also
      // accepted). The trigger qualifies if it matches ANY listed value.
      // Loose equality throughout ("2" == 2), matching the prior behavior.
      // A list match scores the same as a single exact match — a match is a
      // match; it does not earn extra cascade weight.
      let matched;
      if (Array.isArray(filterVal)) {
        // eslint-disable-next-line eqeqeq
        matched = filterVal.some(v => v == triggerVal);
      } else if (typeof filterVal === 'string' && /[|,]/.test(filterVal)) {
        // eslint-disable-next-line eqeqeq
        matched = filterVal.split(/[|,]/).map(s => s.trim()).some(v => v == triggerVal);
      } else {
        // eslint-disable-next-line eqeqeq
        matched = filterVal == triggerVal;
      }
      if (matched) {
        score += Math.pow(2, N - 1 - i);
      } else {
        qualified = false;
        break;
      }
    }
    if (qualified) {
      scored.push({ template: t, score });
    }
  }

  if (!scored.length) {
    throw new Error(
      `No qualifying sequence template for type "${templateType}" — ` +
      `${templates.length} active template(s) considered, all disqualified by trigger_data`
    );
  }

  // ── 4. Sort: score DESC, id ASC ──
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.template.id - b.template.id;
  });
  const winner = scored[0];
  const template = winner.template;

  console.log(
    `[sequence] Cascade match for type="${templateType}" → "${template.name}" ` +
    `(id: ${template.id}, score: ${winner.score}, candidates: ${templates.length}, ` +
    `qualified: ${scored.length}, priority_fields: ${JSON.stringify(priorityFields)})`
  );

  return _enrollWithTemplate(db, contactId, template, triggerData);
}

// ─────────────────────────────────────────────────────────────
// validateTemplateFilters — used by routes/sequences.js on template
// save (POST/PUT) to ensure the filters JSON only contains keys
// declared in the type's priority_fields. Returns a structured result
// rather than throwing so the route can map directly to a 400.
// ─────────────────────────────────────────────────────────────

/**
 * Validate a template's filters JSON against its type's priority_fields.
 *
 * @param {object} db
 * @param {string} type      — sequence_template_types.type
 * @param {object|null} filters — filters JSON to validate (or null/undefined)
 * @returns {Promise<{valid: true} | {valid: false, error: string}>}
 */
async function validateTemplateFilters(db, type, filters) {
  // Empty filters always valid — generic-fallback templates.
  if (filters === null || filters === undefined) return { valid: true };
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    return { valid: false, error: 'filters must be a JSON object or null' };
  }
  const keys = Object.keys(filters);
  if (keys.length === 0) return { valid: true };

  // Type-less templates (ID-only) can't have filters — there's no
  // priority_fields list to validate against.
  if (!type) {
    return {
      valid: false,
      error: 'filters cannot be set on a template without a type (ID-only templates have no cascade)',
    };
  }

  const [rows] = await db.query(
    `SELECT priority_fields FROM sequence_template_types WHERE type = ?`,
    [type]
  );
  if (!rows.length) {
    return { valid: false, error: `Unknown sequence type: ${type}` };
  }
  const pf = rows[0].priority_fields;
  const priorityFields = Array.isArray(pf)
    ? pf
    : (typeof pf === 'string' ? JSON.parse(pf) : []);

  const allowed = new Set(priorityFields);
  const unknown = keys.filter(k => !allowed.has(k));
  if (unknown.length) {
    return {
      valid: false,
      error:
        `filters contain key(s) not in priority_fields for type "${type}": ` +
        `${unknown.join(', ')}. Allowed: ${priorityFields.join(', ') || '(none)'}`,
    };
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// scheduleStepJob — insert into scheduled_jobs
// ─────────────────────────────────────────────────────────────

async function scheduleStepJob(db, enrollmentId, step, scheduledAt) {
  const idempotencyKey = `seq-${enrollmentId}-step-${step.step_number}`;

  // Prevent duplicate jobs for same enrollment+step
  const [existing] = await db.query(
    `SELECT id FROM scheduled_jobs
     WHERE idempotency_key = ? AND status IN ('pending','running') LIMIT 1`,
    [idempotencyKey]
  );

  if (existing.length) {
    console.log(`[sequence] Skipping duplicate job for ${idempotencyKey}`);
    return;
  }

  await db.query(
    `INSERT INTO scheduled_jobs
     (type, scheduled_time, status, name, data, sequence_enrollment_id, idempotency_key)
     VALUES ('sequence_step', ?, 'pending', ?, ?, ?, ?)`,
    [
      scheduledAt,
      `Seq enrollment ${enrollmentId} step ${step.step_number}`,
      JSON.stringify({ enrollmentId, stepId: step.id, stepNumber: step.step_number }),
      enrollmentId,
      idempotencyKey,
    ]
  );

  console.log(`[sequence] Scheduled step ${step.step_number} for enrollment ${enrollmentId} at ${scheduledAt.toISOString()}`);
}

// ─────────────────────────────────────────────────────────────
// Webhook action (sequence step type 'webhook')  — Slice 3.3
//
// NOT retry-idempotent — duplicate delivery on retry is acceptable; the
// receiver must tolerate duplicates (same caveat as internal-function hook
// targets, Cookbook §5.18). Shares credential injection with YisraHook HTTP
// targets via lib/credentialInjection.
//
// Webhook credential injection slice — body lifted into lib/webhookExecutor
// so workflow + scheduled-job webhook flavors share the same auth/timeout
// path. This wrapper preserves sequence-specific behavior:
//   - default body is '{}' when caller supplies null/undefined (pre-refactor
//     behavior — workflow/scheduled-job paths instead omit the body entirely
//     to match their old axios `data: undefined` semantics)
//   - return shape is { status_code, response_body_truncated } (the helper
//     returns a fuller envelope; we project down to what the sequence
//     execution log expects)
// ─────────────────────────────────────────────────────────────

/**
 * Execute a 'webhook' sequence step.
 *
 * @param {object} db
 * @param {object} resolvedConfig — action_config with placeholders already resolved.
 *                                  Expected shape: { method, url, credential_id,
 *                                  headers, body, timeout_ms }
 * @returns {Promise<object>} { status_code, response_body_truncated }
 * @throws on HTTP non-2xx or fetch error — caller's retry policy handles it.
 */
async function executeWebhookAction(db, resolvedConfig) {
  const { executeWebhook } = require('./webhookExecutor');

  // Preserve sequence's pre-refactor behavior: when body is missing / not an
  // object, send '{}' instead of omitting the body. The shared helper will
  // serialize an object to JSON, so passing `{}` here gets `body: '{}'` on
  // the wire — matching what the old in-line implementation did.
  const b = resolvedConfig.body;
  const bodyForHelper = (b && typeof b === 'object') ? b : {};

  const result = await executeWebhook(db, {
    method:        resolvedConfig.method,        // helper defaults to POST
    url:           resolvedConfig.url,           // helper throws if missing
    credential_id: resolvedConfig.credential_id,
    headers:       resolvedConfig.headers,
    body:          bodyForHelper,
    timeout_ms:    resolvedConfig.timeout_ms,    // helper defaults to 30s, caps at 120s
  });

  return {
    status_code:             result.status_code,
    response_body_truncated: result.response_body_truncated,
  };
}

// ─────────────────────────────────────────────────────────────
// Start-workflow action (sequence step type 'start_workflow')  — Slice 3.3
//
// Fourth INSERT site for workflow_executions (see Cookbook §5.21, now stale —
// the three-site claim needs to be updated to four). The other three are:
//   - routes/workflows.js         POST /workflows/:id/start
//   - services/apptService.js     createAppt (appt-reminder workflow)
//   - services/hookService.js     deliverWorkflow (hook → workflow target)
// A future slice should consolidate all four into a shared
// createWorkflowExecution() helper.
// ─────────────────────────────────────────────────────────────

/**
 * Execute a 'start_workflow' sequence step. Retry-safe via a check on
 * sequence_step_log.output_data — if this (enrollment, step_number) already
 * produced a workflow_execution_id and that execution still exists, reuse it
 * instead of creating a duplicate.
 *
 * @param {object} db
 * @param {number} enrollmentId
 * @param {object} step            — sequence_steps row (parsed)
 * @param {object} enrollment      — sequence_enrollments row (parsed)
 * @param {object} resolvedConfig  — { workflow_id, init_data, tie_to_contact,
 *                                     contact_id_override } with placeholders resolved
 * @returns {Promise<object>} { workflow_execution_id, contact_id, reused? }
 */
async function executeStartWorkflowAction(db, enrollmentId, step, enrollment, resolvedConfig) {
  const { resolveExecutionContactId, advanceWorkflow } = require('./workflow_engine');

  const workflowIdNum = Number(resolvedConfig.workflow_id);
  if (!Number.isInteger(workflowIdNum) || workflowIdNum <= 0) {
    throw new Error(`start_workflow step: workflow_id is required and must be a positive integer (got ${JSON.stringify(resolvedConfig.workflow_id)})`);
  }

  // Retry-safety short-circuit (see D5 comment at findPriorStartWorkflowResult).
  const prior = await findPriorStartWorkflowResult(db, enrollmentId, step.step_number);
  if (prior) {
    // Confirm the execution row still exists. If retention or manual cleanup
    // removed it, log a warning and fire a new one rather than blocking.
    const [[exists]] = await db.query(
      `SELECT id FROM workflow_executions WHERE id = ? LIMIT 1`,
      [prior.workflow_execution_id]
    );
    if (exists) {
      console.log(`[sequence] start_workflow enrollment ${enrollmentId} step ${step.step_number}: reusing prior execution ${prior.workflow_execution_id} (retry-safe skip)`);
      return {
        workflow_execution_id: prior.workflow_execution_id,
        contact_id: prior.contact_id ?? null,
        reused: true,
      };
    }
    console.warn(`[sequence] start_workflow enrollment ${enrollmentId} step ${step.step_number}: prior execution ${prior.workflow_execution_id} no longer exists — creating a new one`);
  }

  // Contact-id precedence:
  //   1. tie_to_contact: true (default)   → enrollment.contact_id (explicit override)
  //   2. tie_to_contact: false + non-empty contact_id_override → resolve override
  //   3. tie_to_contact: false + empty override                → rely on template default
  const tieToContact = resolvedConfig.tie_to_contact !== false; // default true
  let explicitContactId;

  if (tieToContact) {
    explicitContactId = enrollment.contact_id;
  } else {
    const override = resolvedConfig.contact_id_override;
    if (override !== undefined && override !== null && String(override).trim() !== '') {
      // Override may be a literal int (or numeric string); the resolver already
      // substituted any {{ }} placeholders before we got here.
      const n = Number(override);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`start_workflow step: contact_id_override must resolve to a positive integer (got ${JSON.stringify(override)})`);
      }
      explicitContactId = n;
    } else {
      explicitContactId = undefined; // fall through to template default
    }
  }

  // Load template default for fallback (+ active for the inactive-target
  // check below).
  const [[wfRow]] = await db.query(
    `SELECT id, active, default_contact_id_from FROM workflows WHERE id = ?`,
    [workflowIdNum]
  );
  if (!wfRow) {
    throw new Error(`start_workflow step: workflow #${workflowIdNum} not found`);
  }
  // Slice 6R alignment — the hook dispatcher (actionDispatchers.deliverWorkflow)
  // and the wf→wf internal function both refuse to start an inactive target;
  // this step historically didn't check. A sequence step pointing at an
  // inactive workflow is a misconfiguration → fail loudly per the step's
  // error handling rather than silently starting a turned-off workflow.
  // (Runs AFTER the retry-safety short-circuit above, so a retry of a step
  // that already started its child before the target was deactivated still
  // reuses the prior execution instead of throwing.)
  if (!wfRow.active) {
    throw new Error(`start_workflow step: workflow #${workflowIdNum} is inactive`);
  }

  const initData = (resolvedConfig.init_data && typeof resolvedConfig.init_data === 'object' && !Array.isArray(resolvedConfig.init_data))
    ? resolvedConfig.init_data
    : {};

  const contactId = resolveExecutionContactId({
    explicitContactId,
    initData,
    defaultKey: wfRow.default_contact_id_from,
  });

  // INSERT — fourth workflow_executions creation site (Cookbook §5.21).
  const [result] = await db.query(
    `INSERT INTO workflow_executions
     (workflow_id, contact_id, status, init_data, variables, current_step_number)
     VALUES (?, ?, 'active', ?, ?, 1)`,
    [workflowIdNum, contactId, JSON.stringify(initData), JSON.stringify(initData)]
  );
  const executionId = result.insertId;

  // Fire-and-forget advance — mirrors apptService.createAppt and
  // hookService.deliverWorkflow. A background failure in advanceWorkflow
  // does NOT re-fire this sequence step; the execution row will be marked
  // 'failed' by markExecutionCompleted.
  (async () => {
    try {
      await advanceWorkflow(executionId, db);
    } catch (err) {
      console.error(`[sequence→WF] advanceWorkflow failed for execution ${executionId}:`, err.message);
    }
  })();

  return {
    workflow_execution_id: executionId,
    contact_id: contactId,
  };
}

/**
 * Look up a prior 'sent' sequence_step_log row for this (enrollment, step_number)
 * carrying a workflow_execution_id in output_data. Used by start_workflow
 * retry-safety.
 *
 * D5 (known gap, intentionally accepted): this check covers process_jobs-level
 * retries — the log row exists by the time a later job claim re-invokes
 * executeStep. It does NOT cover in-loop retries within a single executeStep
 * invocation, because the retry loop runs BEFORE logStep writes. In practice
 * the only work in executeStartWorkflowAction is INSERT + fire-and-forget
 * advance, so a successful INSERT breaks the loop and no in-loop retry can
 * happen; a failed INSERT means no execution row was created, so a retry is
 * safe.
 *
 * @returns {Promise<{workflow_execution_id: number, contact_id: number|null}|null>}
 */
async function findPriorStartWorkflowResult(db, enrollmentId, stepNumber) {
  const [rows] = await db.query(
    `SELECT output_data FROM sequence_step_log
     WHERE enrollment_id = ? AND step_number = ? AND status = 'sent'
     ORDER BY id DESC LIMIT 1`,
    [enrollmentId, stepNumber]
  );
  if (!rows.length) return null;

  let out = rows[0].output_data;
  if (typeof out === 'string') {
    try { out = JSON.parse(out); } catch { return null; }
  }
  if (!out || typeof out !== 'object') return null;
  if (!out.workflow_execution_id) return null;

  return {
    workflow_execution_id: Number(out.workflow_execution_id),
    contact_id: out.contact_id ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// safeAdvanceToNextStep — wrap advanceToNextStep with wedge-tolerant catch
//
// Why this exists: advanceToNextStep does two things — UPDATE current_step
// on the enrollment, then calculateStepTime + scheduleStepJob for the next
// step. If anything in that second stage throws (Hebcal timeout chain →
// Invalid Date → NOT NULL violation, transient DB blip, etc.) AFTER the
// current step's action has already succeeded and been logged, the
// detached executor in routes/process_jobs.js will catch the exception
// and mark this step's scheduled_jobs row 'failed' — even though the
// action ran cleanly. Worse, the enrollment is left in an "active with
// no future scheduled_jobs row" state with no operator-visible signal
// beyond a failed job buried in history. See enrollment 61 / step 3
// post-mortem (May 2026).
//
// Containing the throw here means:
//   - executeStep returns its real status ('sent'/'skipped'/'failed'-ignored)
//   - process_jobs marks the job 'completed' (action did succeed)
//   - the enrollment's "active + no pending scheduled_jobs row" state
//     is the durable wedge signal the recovery UI keys off of (the
//     "Recover stuck enrollment" buttons in contact.html and the
//     sequences manager)
//   - the wedge is loud in container logs so operators can spot it
//
// Returns the scheduledAt Date on success, null on failure or terminal.
// ─────────────────────────────────────────────────────────────
async function safeAdvanceToNextStep(db, enrollment, completedStep, triggerData, floorDate) {
  try {
    return await advanceToNextStep(db, enrollment, completedStep, triggerData, floorDate);
  } catch (err) {
    console.error(
      `[sequence] WEDGE — advanceToNextStep failed for enrollment=${enrollment.id} ` +
      `after step=${completedStep.step_number}: ${err.message}\n` +
      `Enrollment is still 'active' but no next-step job exists. ` +
      `Use the Recover button in the enrollment detail view to re-schedule. ` +
      `Underlying error stack: ${err.stack}`
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// executeStep — called by process_jobs when a sequence_step fires
// ─────────────────────────────────────────────────────────────

/**
 * Execute one sequence step.
 * Handles: enrollment check, template condition, fire guard, step condition,
 *          placeholder resolution, action execution, logging, scheduling next step.
 *
 * @param {object} db
 * @param {number} enrollmentId
 * @param {number} stepId
 * @returns {{ status: 'sent'|'skipped'|'failed', reason?, nextScheduledAt? }}
 */
async function executeStep(db, enrollmentId, stepId) {
  const startTime = Date.now();

  // ── Load enrollment ──
  const [enrollments] = await db.query(
    `SELECT e.*, t.\`condition\` AS template_condition, t.name AS template_name, t.type AS template_type
     FROM sequence_enrollments e
     JOIN sequence_templates t ON t.id = e.template_id
     WHERE e.id = ?`,
    [enrollmentId]
  );

  if (!enrollments.length) {
    return { status: 'skipped', reason: 'enrollment_not_found' };
  }

  const enrollment = enrollments[0];

  // Parse JSON fields
  const triggerData = typeof enrollment.trigger_data === 'string'
    ? JSON.parse(enrollment.trigger_data)
    : (enrollment.trigger_data || {});

  const templateCondition = typeof enrollment.template_condition === 'string'
    ? JSON.parse(enrollment.template_condition)
    : enrollment.template_condition;

  // ── Guard 1: enrollment must be active ──
  if (enrollment.status !== 'active') {
    await logStep(db, enrollmentId, stepId, null, 'skipped', 'enrollment_not_active', null, null, null, Date.now() - startTime);
    return { status: 'skipped', reason: 'enrollment_not_active' };
  }

  // ── Load step ──
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE id = ?`,
    [stepId]
  );

  if (!steps.length) {
    return { status: 'failed', reason: 'step_not_found' };
  }

  const step = steps[0];

  // Parse step JSON fields
  if (typeof step.timing        === 'string') step.timing        = JSON.parse(step.timing);
  if (typeof step.action_config === 'string') step.action_config = JSON.parse(step.action_config);
  if (typeof step.condition     === 'string') step.condition     = JSON.parse(step.condition);
  if (typeof step.fire_guard    === 'string') step.fire_guard    = JSON.parse(step.fire_guard);
  if (typeof step.error_policy  === 'string') step.error_policy  = JSON.parse(step.error_policy);

  const scheduledAt = await getJobScheduledAt(db, enrollmentId, step.step_number);

  // ── Guard 2: template-level condition (cancel enrollment if fails) ──
  if (templateCondition) {
    const conditionPasses = await checkCondition(db, templateCondition, triggerData);
    if (!conditionPasses) {
      console.log(`[sequence] Template condition failed for enrollment ${enrollmentId} — cancelling`);
      await cancelEnrollment(db, enrollmentId, 'condition_failed');
      await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'condition_failed', null, null, scheduledAt, Date.now() - startTime);
      return { status: 'skipped', reason: 'condition_failed' };
    }
  }

  // ── Guard 3: fire guard (time-based, skip only) ──
  if (!checkFireGuard(step.fire_guard, triggerData)) {
    await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'fire_guard_failed', null, null, scheduledAt, Date.now() - startTime);
    await safeAdvanceToNextStep(db, enrollment, step, triggerData, scheduledAt);
    return { status: 'skipped', reason: 'fire_guard_failed' };
  }

  // ── Guard 4: step-level condition (skip only, don't cancel) ──
  if (step.condition) {
    const stepConditionPasses = await checkCondition(db, step.condition, triggerData);
    if (!stepConditionPasses) {
      console.log(`[sequence] Step condition failed for step ${step.step_number} — skipping`);
      await logStep(db, enrollmentId, stepId, step.step_number, 'skipped', 'step_condition_failed', null, null, scheduledAt, Date.now() - startTime);
      await safeAdvanceToNextStep(db, enrollment, step, triggerData, scheduledAt);
      return { status: 'skipped', reason: 'step_condition_failed' };
    }
  }

  // ── Resolve placeholders in action_config ──
  const refs            = buildRefsForStep(triggerData, enrollment.contact_id);
  let   resolvedConfig  = step.action_config;

  try {
    const configStr    = JSON.stringify(step.action_config);
    const resolveResult = await resolve({ db, text: configStr, refs, strict: false });
    resolvedConfig     = JSON.parse(resolveResult.text);

    if (resolveResult.unresolved.length) {
      console.warn(`[sequence] Step ${step.step_number}: unresolved placeholders:`, resolveResult.unresolved);
    }
  } catch (err) {
    console.error(`[sequence] Placeholder resolution failed for step ${step.step_number}:`, err.message);
    // Continue with unresolved config rather than failing the step
  }

  // ── Execute action ──
  const policy     = step.error_policy || { strategy: 'ignore' };
  const strategy   = policy.strategy   || 'ignore';
  const maxRetries = Number(policy.max_retries)    || 0;
  const backoffSec = Number(policy.backoff_seconds) || 5;

  let   rawResult;
  let   actionError;
  let   attempt = 1;

  while (true) {
    try {
      if (step.action_type === 'webhook') {
        // Slice 3.3 — first-class webhook. Uses shared credential injection
        // (lib/credentialInjection) — NOT executeJob's webhook path, which
        // has no cred injection and a hardcoded 10s timeout.
        rawResult = await executeWebhookAction(db, resolvedConfig);
      } else if (step.action_type === 'start_workflow') {
        // Slice 3.3 — first-class workflow start. Retry-safe via
        // findPriorStartWorkflowResult.
        rawResult = await executeStartWorkflowAction(db, enrollmentId, step, enrollment, resolvedConfig);
      } else {
        // sms / email / task / internal_function — all routed through
        // executeJob as internal_function. (The old fossil 'webhook' and
        // 'custom_code' dispatch branches here were unreachable: the
        // sequence_steps.action_type enum did not include those values.
        // Removed in Slice 3.3 — 'webhook' is now handled above with the
        // credential-injecting path, and 'custom_code' was never wired in
        // at any layer.)
        const jobData = {
          type: 'internal_function',
          ...resolvedConfig
        };
        rawResult = await executeJob({ data: jobData }, db);
      }
      break;
    } catch (err) {
      actionError = err.message;
      if (attempt > maxRetries) break;
      await new Promise(r => setTimeout(r, backoffSec * 1000 * attempt));
      attempt++;
    }
  }

  const duration = Date.now() - startTime;

  if (actionError && attempt > maxRetries) {
    const shouldAbort = strategy === 'abort' || strategy === 'retry_then_abort';

    await logStep(db, enrollmentId, stepId, step.step_number, 'failed', null, resolvedConfig, null, scheduledAt, duration, actionError);

    if (shouldAbort) {
      await cancelEnrollment(db, enrollmentId, `step_${step.step_number}_failed`);
      return { status: 'failed', reason: 'action_failed_abort' };
    }

    // ignore / retry_then_ignore → log and continue
    console.log(`[sequence] Step ${step.step_number} failed (ignored), advancing`);
    await safeAdvanceToNextStep(db, enrollment, step, triggerData, scheduledAt);
    return { status: 'failed', reason: 'action_failed_ignored' };
  }

  // ── Success ──
  await logStep(db, enrollmentId, stepId, step.step_number, 'sent', null, resolvedConfig, rawResult, scheduledAt, duration);

  const nextScheduledAt = await safeAdvanceToNextStep(db, enrollment, step, triggerData, scheduledAt);

  return {
    status:         'sent',
    nextScheduledAt: nextScheduledAt?.toISOString() || null,
  };
}

// ─────────────────────────────────────────────────────────────
// scheduleFromStep — find the next placeable step and schedule it
//
// Walks forward from `startStepNumber`, skipping any step whose timing can't
// be placed right now (calculateStepTime returns null — see before_appt /
// before_appt_fixed). Each skipped step is logged 'skipped'/'unschedulable'
// and current_step is advanced past it. The first step that DOES place gets a
// scheduled_jobs row and current_step points at it. If no step places, the
// enrollment is completed.
//
// This is the single scheduling entry point shared by enrollment (first step)
// and advanceToNextStep (subsequent steps), so the "drop the steps whose
// runway is gone, keep the ones that still fit" behavior is identical in both.
//
// NOTE on errors vs skips: only a null return from calculateStepTime is a
// "skip" signal. A THROW (e.g. malformed timing, missing appt_time on an
// appt-scoped step) still propagates — that's a real config error, and the
// caller's existing wedge-tolerant handling (safeAdvanceToNextStep / the
// enroll-site catch) keeps the loud, recoverable wedge behavior. We do not
// swallow throws as skips, or genuine misconfigurations would vanish silently.
//
// @returns {Date|null} scheduledAt of the placed step, or null if none placed
//                      (enrollment completed).
// ─────────────────────────────────────────────────────────────
async function scheduleFromStep(db, enrollment, startStepNumber, triggerData, floorDate) {
  // Floor = the timeline position already reached (prior scheduled step's
  // time, or enrollment time for step 1). Passed to calculateStepTime so
  // appt-anchored steps skip only when behind this floor, not behind "now".
  const floor = floorDate ? new Date(floorDate) : new Date();
  // Cap the walk at total_steps+1 so a pathological all-null template can't
  // loop unbounded.
  const cap = (Number(enrollment.total_steps) || 0) + 2;
  let stepNumber = startStepNumber;

  for (let guard = 0; guard < cap; guard++) {
    const [rows] = await db.query(
      `SELECT * FROM sequence_steps WHERE template_id = ? AND step_number = ?`,
      [enrollment.template_id, stepNumber]
    );

    if (!rows.length) {
      // No step at this number — sequence is exhausted. Complete it, leaving
      // current_step on the last real step (stepNumber - 1).
      await db.query(
        `UPDATE sequence_enrollments
         SET status = 'completed', current_step = ?, completed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [Math.max(stepNumber - 1, 1), enrollment.id]
      );
      console.log(`[sequence] Enrollment ${enrollment.id} completed (no further placeable steps)`);
      return null;
    }

    const step = rows[0];
    if (typeof step.timing === 'string') step.timing = JSON.parse(step.timing);

    const scheduledAt = await calculateStepTime(step.timing, triggerData, new Date(), floor);

    if (scheduledAt === null) {
      // Window gone / no valid slot — skip this step and advance.
      await db.query(
        `UPDATE sequence_enrollments SET current_step = ?, updated_at = NOW() WHERE id = ?`,
        [stepNumber, enrollment.id]
      );
      await logStep(db, enrollment.id, step.id, stepNumber, 'skipped', 'unschedulable', null, null, null, 0);
      console.log(`[sequence] Enrollment ${enrollment.id} step ${stepNumber} unschedulable (window passed) — skipping`);
      stepNumber += 1;
      continue;
    }

    // Placeable — point current_step here and schedule the job.
    await db.query(
      `UPDATE sequence_enrollments SET current_step = ?, updated_at = NOW() WHERE id = ?`,
      [stepNumber, enrollment.id]
    );
    await scheduleStepJob(db, enrollment.id, step, scheduledAt);
    return scheduledAt;
  }

  // Cap hit (all-null template) — complete defensively.
  await db.query(
    `UPDATE sequence_enrollments
     SET status = 'completed', current_step = ?, completed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [Math.max(stepNumber - 1, 1), enrollment.id]
  );
  console.warn(`[sequence] Enrollment ${enrollment.id} completed after skip-cap — no step placed`);
  return null;
}

// ─────────────────────────────────────────────────────────────
// advanceToNextStep — schedule the next placeable step after a completed one
// (thin wrapper over scheduleFromStep, preserved as the call site used by
//  safeAdvanceToNextStep / executeStep).
// ─────────────────────────────────────────────────────────────

async function advanceToNextStep(db, enrollment, completedStep, triggerData, floorDate) {
  return scheduleFromStep(db, enrollment, completedStep.step_number + 1, triggerData, floorDate);
}

// ─────────────────────────────────────────────────────────────
// cancelSequences
// ─────────────────────────────────────────────────────────────

/**
 * Cancel all active enrollments of a given type for a contact.
 * Also deletes any pending scheduled_jobs for those enrollments.
 *
 * Call this from: new appointment booked, appointment attended,
 *                 incoming SMS/email, manual override.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} templateType   — e.g. 'no_show'. Pass null to cancel ALL types.
 * @param {string} reason         — logged in cancel_reason column
 * @returns {{ cancelled: number }}
 */
async function cancelSequences(db, contactId, templateType, reason = 'manual') {
  // Find active enrollments
  let query  = `SELECT e.id FROM sequence_enrollments e
                JOIN sequence_templates t ON t.id = e.template_id
                WHERE e.contact_id = ? AND e.status = 'active'`;
  const params = [contactId];

  if (templateType) {
    query += ` AND t.type = ?`;
    params.push(templateType);
  }

  const [enrollments] = await db.query(query, params);
  if (!enrollments.length) return { cancelled: 0 };

  const ids = enrollments.map(e => e.id);

  // Cancel enrollments
  await db.query(
    `UPDATE sequence_enrollments
     SET status = 'cancelled', cancel_reason = ?, updated_at = NOW()
     WHERE id IN (?)`,
    [reason, ids]
  );

  // TODO: remove ~1 week after cutover once old-system no-shows are cleared
  if (templateType === 'no_show') {
    await db.query(
      `UPDATE appts SET appt_status = 'Canceled'
       WHERE appt_client_id = ? AND appt_status = 'No Show'`,
      [contactId]
    );
  }
  
  // Cancel pending/running scheduled jobs for these enrollments.
  // Mark as 'failed' rather than deleting — preserves audit trail.
  // Running jobs are mid-execution; they will check enrollment.status on completion
  // and exit cleanly since status is now 'cancelled'.
  const [cancelResult] = await db.query(
    `UPDATE scheduled_jobs
     SET status = 'failed', updated_at = NOW()
     WHERE sequence_enrollment_id IN (?)
       AND status IN ('pending', 'running')`,
    [ids]
  );

  console.log(`[sequence] Cancelled ${ids.length} enrollment(s) for contact ${contactId} (type: ${templateType || 'all'}, reason: ${reason}). Cancelled ${cancelResult.affectedRows} pending jobs.`);

  return { cancelled: ids.length };
}

// ─────────────────────────────────────────────────────────────
// cancelEnrollment — cancel a single enrollment
// ─────────────────────────────────────────────────────────────

async function cancelEnrollment(db, enrollmentId, reason) {
  await db.query(
    `UPDATE sequence_enrollments
     SET status = 'cancelled', cancel_reason = ?, updated_at = NOW()
     WHERE id = ?`,
    [reason, enrollmentId]
  );

  await db.query(
    `UPDATE scheduled_jobs
     SET status = 'failed', updated_at = NOW()
     WHERE sequence_enrollment_id = ? AND status IN ('pending', 'running')`,
    [enrollmentId]
  );

  console.log(`[sequence] Enrollment ${enrollmentId} cancelled: ${reason}`);
}

// ─────────────────────────────────────────────────────────────
// cancelByApptId — cancel every active enrollment tied to an appt
//
// Called by apptService.cancelApptAutomation. Called from appt
// status-change paths (markAttended, markNoShow, cancelAppt, rescheduleAppt)
// to tear down sequences whose continued execution no longer makes sense.
//
// Looks up enrollments via the indexed appt_id column (NOT JSON_EXTRACT),
// then delegates each cancellation to cancelEnrollment to preserve the
// existing job-cancellation + log behavior.
// ─────────────────────────────────────────────────────────────

/**
 * Cancel all active sequence enrollments associated with a given appointment.
 *
 * @param {object} db
 * @param {number} apptId
 * @param {string} reason   — written to sequence_enrollments.cancel_reason
 * @returns {{ cancelled: number, enrollmentIds: number[] }}
 */
async function cancelByApptId(db, apptId, reason = 'manual') {
  if (!apptId) return { cancelled: 0, enrollmentIds: [] };

  const [rows] = await db.query(
    `SELECT id FROM sequence_enrollments
     WHERE appt_id = ? AND status = 'active'`,
    [apptId]
  );

  if (!rows.length) return { cancelled: 0, enrollmentIds: [] };

  const ids = [];
  for (const r of rows) {
    try {
      await cancelEnrollment(db, r.id, reason);
      ids.push(r.id);
    } catch (err) {
      console.error(`[sequence] cancelByApptId(${apptId}): cancelEnrollment ${r.id} threw:`, err.message);
    }
  }

  console.log(
    `[sequence] cancelByApptId(${apptId}): cancelled ${ids.length}/${rows.length} enrollment(s), reason: ${reason}`
  );
  return { cancelled: ids.length, enrollmentIds: ids };
}

// ─────────────────────────────────────────────────────────────
// logStep
// ─────────────────────────────────────────────────────────────

async function logStep(db, enrollmentId, stepId, stepNumber, status, skipReason, resolvedConfig, outputData, scheduledAt, durationMs, errorMessage) {
  try {
    await db.query(
      `INSERT INTO sequence_step_log
       (enrollment_id, step_id, step_number, status, skip_reason,
        action_config_resolved, output_data, error_message,
        duration_ms, scheduled_at, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        enrollmentId,
        stepId,
        stepNumber,
        status,
        skipReason || null,
        resolvedConfig ? JSON.stringify(resolvedConfig) : null,
        outputData    ? JSON.stringify(outputData)      : null,
        errorMessage  || null,
        durationMs    || 0,
        scheduledAt   || null,
      ]
    );
  } catch (err) {
    // Log failure should never crash the step — just warn
    console.error(`[sequence] Failed to write step log for enrollment ${enrollmentId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Shared helper: given a loaded template row, load steps, guard against
 * duplicates, create the enrollment row, and schedule the first step.
 *
 * Used by both enrollContact (type-cascade) and enrollContactByTemplateId
 * (direct-by-id). Template lookup and active-check are the callers' job —
 * this helper assumes `template` is the one we intend to enroll in.
 *
 * @private
 */
async function _enrollWithTemplate(db, contactId, template, triggerData) {
  // ── Load steps ──
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE template_id = ?
     ORDER BY step_number ASC`,
    [template.id]
  );

  if (!steps.length) {
    throw new Error(`Sequence template "${template.name}" has no steps`);
  }

  // Parse JSON columns
  steps.forEach(s => {
    if (typeof s.timing       === 'string') s.timing       = JSON.parse(s.timing);
    if (typeof s.action_config=== 'string') s.action_config= JSON.parse(s.action_config);
    if (typeof s.condition    === 'string') s.condition    = JSON.parse(s.condition);
    if (typeof s.fire_guard   === 'string') s.fire_guard   = JSON.parse(s.fire_guard);
    if (typeof s.error_policy === 'string') s.error_policy = JSON.parse(s.error_policy);
  });

    // ── Guard: prevent duplicate active enrollments ──
  // For appt-scoped sequences (trigger_data.appt_id present), "duplicate"
  // means same contact + template + same appt. Two different appts for the
  // same contact in the same template are independent enrollments and must
  // both be allowed (e.g., a client has two ISS sessions back to back).
  // For contact-scoped sequences (no appt_id), "duplicate" stays
  // contact-level. MySQL's <=> operator handles both: NULL <=> NULL = 1,
  // any non-equal pair = 0.
  const apptIdForDupCheck = triggerData?.appt_id ? Number(triggerData.appt_id) : null;
  const [existing] = await db.query(
    `SELECT id FROM sequence_enrollments
     WHERE contact_id = ?
       AND template_id = ?
       AND (appt_id <=> ?)
       AND status = 'active'
     LIMIT 1`,
    [contactId, template.id, apptIdForDupCheck]
  );
  if (existing.length) {
    const ctx = apptIdForDupCheck ? ` for appt ${apptIdForDupCheck}` : '';
    console.log(`[sequence] Contact ${contactId} already has active enrollment in "${template.name}"${ctx} (id: ${existing[0].id}) — skipping duplicate`);
    throw new Error(`Contact ${contactId} is already enrolled in sequence "${template.name}"${ctx}`);
  }

  // ── Create enrollment ──
  // appt_id column (added in the appt-scoped-cancellation migration) is
  // populated from trigger_data.appt_id so cancelByApptId can do an indexed
  // lookup instead of JSON_EXTRACT. Coerce 0/'' to NULL via `|| null` —
  // those are not meaningful appt IDs.
  const apptIdCol = triggerData?.appt_id ? Number(triggerData.appt_id) : null;

  const [result] = await db.query(
    `INSERT INTO sequence_enrollments
     (template_id, contact_id, appt_id, trigger_data, status, current_step, total_steps)
     VALUES (?, ?, ?, ?, 'active', 1, ?)`,
    [template.id, contactId, apptIdCol, JSON.stringify(triggerData), steps.length]
  );

  const enrollmentId = result.insertId;
  console.log(`[sequence] Enrolled contact ${contactId} in "${template.name}" (enrollment #${enrollmentId})`);

  // ── Schedule the first placeable step ──
  // scheduleFromStep walks from step 1, skipping any leading steps whose
  // window has already passed (e.g. a 7-day reminder on a short-notice
  // booking) and points current_step / the scheduled job at the first step
  // that places. If none place, the enrollment is completed immediately.
  const enrollmentCtx = {
    id:          enrollmentId,
    template_id: template.id,
    total_steps: steps.length,
  };
  const scheduledAt = await scheduleFromStep(db, enrollmentCtx, 1, triggerData, new Date());

  return {
    enrollmentId,
    templateName:        template.name,
    totalSteps:          steps.length,
    firstJobScheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
  };
}

/**
 * Enroll a contact in a sequence by explicit template ID.
 *
 * Unlike enrollContact, this bypasses type-cascade matching entirely —
 * the caller names the exact template. Useful for hook targets that
 * reference a specific ad-hoc template without needing a unique type.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {number} templateId
 * @param {object} triggerData   — context: { appt_id, appt_time, case_id, enrolled_by, ... }
 * @returns {{ enrollmentId, templateName, totalSteps, firstJobScheduledAt }}
 * @throws if template doesn't exist, is inactive, or has no steps
 */
async function enrollContactByTemplateId(db, contactId, templateId, triggerData = {}) {
  const [templates] = await db.query(
    `SELECT * FROM sequence_templates WHERE id = ? LIMIT 1`,
    [templateId]
  );

  if (!templates.length) {
    throw new Error(`Sequence template #${templateId} not found`);
  }

  const template = templates[0];

  if (!template.active) {
    throw new Error(`Sequence template #${templateId} is inactive`);
  }

  console.log(`[sequence] Enrolling by template ID → "${template.name}" (id: ${template.id})`);

  return _enrollWithTemplate(db, contactId, template, triggerData);
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function getJobScheduledAt(db, enrollmentId, stepNumber) {
  try {
    const [rows] = await db.query(
      `SELECT scheduled_time FROM scheduled_jobs
       WHERE sequence_enrollment_id = ?
         AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.stepNumber')) = ?
       ORDER BY id DESC LIMIT 1`,
      [enrollmentId, String(stepNumber)]
    );
    return rows[0]?.scheduled_time || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// previewEnrollmentSteps — zero-side-effect dry run (Slice 8A)
//
// Computes, for every step of a template, what WOULD happen if a contact were
// enrolled right now: the fire time, the skip verdicts, and the fully resolved
// action_config (i.e. the exact message text the contact would receive).
// Reuses the SAME in-module primitives executeStep uses — checkCondition /
// checkFireGuard / calculateStepTime / buildRefsForStep — plus
// resolverService.resolve, so the preview tracks production behavior instead of
// reimplementing it.
//
// ── ABSOLUTELY NO SIDE EFFECTS ──
// This function performs ONLY reads (SELECTs via db.query). It never calls
// executeJob / executeWebhookAction / executeStartWorkflowAction, never writes
// scheduled_jobs / sequence_enrollments / sequence_step_log, never calls
// logStep, and never dispatches sms / email / webhook / start_workflow. The
// harness proves this by wiring a db that throws on any INSERT/UPDATE/DELETE.
//
// opts — exactly ONE shape:
//   { template_id, contact_id, trigger_data? }   hypothetical enrollment
//   { enrollment_id }                             seed template_id / contact_id
//                                                 / trigger_data from an existing
//                                                 enrollment. Its status is
//                                                 irrelevant — preview always
//                                                 re-derives a fresh "from now"
//                                                 timeline; it does NOT reflect
//                                                 where that enrollment
//                                                 currently sits.
//
// Timing chain (matches production advancement — see scheduleFromStep /
// safeAdvanceToNextStep / _enrollWithTemplate):
//   • calculateStepTime is called with fromDate = the timeline position already
//     reached and floorDate = the same. In production, step 1 is scheduled with
//     from = now / floor = now; each later step is scheduled at advancement with
//     from = new Date() (≈ the prior step's fire time) and floor = the prior
//     *placed* step's scheduled time. In a forward-only preview those collapse
//     to "the previous placed step's computed time" (now for step 1).
//   • A step that PLACES (calculateStepTime → Date) advances the floor for the
//     next step. A step that is unschedulable (calculateStepTime → null) leaves
//     the floor where it was — exactly as production's skip-walk keeps the floor
//     constant while stepping past null steps. Guard-skipped steps still PLACE
//     (guards don't affect timing), so they advance the floor, matching
//     executeStep passing the guard-skipped step's own scheduled time to
//     safeAdvanceToNextStep.
//   • Fidelity notes: production's `from` carries ~1 min job-poll jitter over the
//     floor, which the preview omits — so relative-delay chains read a hair
//     earlier than they fire in practice. Randomized timing (randomizeMinutes /
//     jitter) is a fresh random draw on each preview call.
//   • A timing THROW (e.g. before_appt with no trigger_data.appt_time) would
//     WEDGE the enrollment in production; here it is captured per-step as
//     timing_error with computed_time = null and the preview continues.
//
// @param {object} db
// @param {object} opts   — one of the two shapes above
// @returns {Promise<{ template, contact_id, trigger_data, enrollment_verdict, steps[] }>}
// @throws if the enrollment (enrollment_id path) or the template is not found —
//         the route maps these to 404.
// ─────────────────────────────────────────────────────────────
async function previewEnrollmentSteps(db, opts = {}) {
  let templateId, contactId, triggerData;

  if (opts.enrollment_id != null) {
    const [[enr]] = await db.query(
      `SELECT template_id, contact_id, trigger_data FROM sequence_enrollments WHERE id = ?`,
      [opts.enrollment_id]
    );
    if (!enr) throw new Error(`Enrollment #${opts.enrollment_id} not found`);
    templateId  = enr.template_id;
    contactId   = enr.contact_id;
    triggerData = typeof enr.trigger_data === 'string'
      ? JSON.parse(enr.trigger_data)
      : (enr.trigger_data || {});
  } else {
    templateId  = opts.template_id;
    contactId   = opts.contact_id;
    triggerData = (opts.trigger_data && typeof opts.trigger_data === 'object' && !Array.isArray(opts.trigger_data))
      ? opts.trigger_data
      : {};
  }

  // ── Load template (name, type, condition) ──
  const [[template]] = await db.query(
    `SELECT id, name, type, \`condition\` AS template_condition FROM sequence_templates WHERE id = ?`,
    [templateId]
  );
  if (!template) throw new Error(`Sequence template #${templateId} not found`);

  const templateCondition = typeof template.template_condition === 'string'
    ? JSON.parse(template.template_condition)
    : template.template_condition;

  // ── Load steps ──
  // Reuses the exact loader _enrollWithTemplate uses. NOTE: sequence_steps has
  // NO `active` column — there is no per-step active flag in the schema, so
  // "active steps" == all steps for the template, ordered by step_number.
  const [steps] = await db.query(
    `SELECT * FROM sequence_steps WHERE template_id = ? ORDER BY step_number ASC`,
    [templateId]
  );

  // Parse JSON columns — mirrors _enrollWithTemplate / executeStep.
  steps.forEach(s => {
    if (typeof s.timing        === 'string') s.timing        = JSON.parse(s.timing);
    if (typeof s.action_config === 'string') s.action_config = JSON.parse(s.action_config);
    if (typeof s.condition     === 'string') s.condition     = JSON.parse(s.condition);
    if (typeof s.fire_guard    === 'string') s.fire_guard    = JSON.parse(s.fire_guard);
    if (typeof s.error_policy  === 'string') s.error_policy  = JSON.parse(s.error_policy);
  });

  // ── Template-level condition (production: cancels the whole enrollment) ──
  // Evaluated once. On failure the verdict records the cancel, but we still
  // preview every step for information.
  let enrollmentVerdict = 'would_proceed';
  if (templateCondition) {
    const passes = await checkCondition(db, templateCondition, triggerData);
    if (!passes) enrollmentVerdict = 'would_cancel_at_first_step (template condition failed)';
  }

  // ── Per-step preview ──
  // refs are constant across steps (same triggerData + contactId), so build
  // once. executeStep builds per-step because it runs a single step per call;
  // hoisting here is equivalent and cheaper.
  const refs = buildRefsForStep(triggerData, contactId);

  // Timeline anchor: `now` for step 1; advances to each placed step's computed
  // time (see header). A null / timing_error step does not advance it.
  let prevPlacedTime = new Date();

  const previewSteps = [];
  for (const step of steps) {
    const entry = {
      step_id:     step.id,
      step_number: step.step_number,
      action_type: step.action_type,
    };

    // ── Timing ──
    try {
      const t = await calculateStepTime(step.timing, triggerData, prevPlacedTime, prevPlacedTime);
      entry.computed_time = t ? t.toISOString() : null;
      if (t) prevPlacedTime = t; // placed → advances floor; null → floor unchanged
    } catch (err) {
      entry.computed_time = null;
      entry.timing_error  = err.message;
    }

    // ── Guards (production order: fire_guard first, then step condition) ──
    // Computed independently of the template verdict — informational per step.
    if (!checkFireGuard(step.fire_guard, triggerData)) {
      entry.would_skip = 'fire_guard_failed';
    } else if (step.condition && !(await checkCondition(db, step.condition, triggerData))) {
      entry.would_skip = 'step_condition_failed';
    } else {
      entry.would_skip = null;
    }

    // ── Resolution — mirrors executeStep's resolve block exactly ──
    // (JSON.stringify → resolve strict:false → JSON.parse). Resolution runs for
    // every step, even ones that would skip, so the preview shows what the
    // message WOULD have been.
    try {
      const configStr = JSON.stringify(step.action_config);
      const r = await resolve({ db, text: configStr, refs, strict: false });
      entry.resolved_config = JSON.parse(r.text);
      entry.unresolved      = r.unresolved || [];
    } catch (err) {
      entry.resolved_config  = step.action_config; // raw fallback
      entry.unresolved       = [];
      entry.resolution_error = err.message;
    }

    entry.action_summary = summarizeAction(step.action_type, entry.resolved_config);

    previewSteps.push(entry);
  }

  return {
    template:           { id: template.id, name: template.name, type: template.type },
    contact_id:         contactId,
    trigger_data:       triggerData,
    enrollment_verdict: enrollmentVerdict,
    steps:              previewSteps,
  };
}

// Human-readable digest of a (resolved) action_config. Surfaces the fields an
// operator scans first; the full resolved config always travels alongside in
// resolved_config. Built from the RESOLVED config so it shows real values
// ("Hi John") rather than raw {{placeholders}}. Branches on the real
// action_config shapes: sms/email/task/internal_function carry
// {function_name, params}; webhook is flat {method,url,credential_id,...};
// start_workflow carries {workflow_id, tie_to_contact?, ...}.
function summarizeAction(actionType, cfg) {
  const c = cfg || {};
  if (c.function_name) {
    const fn = c.function_name;
    const p  = c.params || {};
    if (fn === 'send_sms') {
      return { function_name: fn, to: p.to ?? null, from: p.from ?? null, message: p.message ?? null };
    }
    if (fn === 'send_email') {
      return {
        function_name: fn,
        to:           p.to ?? null,
        from:         p.from ?? null,
        subject:      p.subject ?? null,
        body_preview: _truncate(p.text ?? p.html ?? null, 200),
      };
    }
    // task / noop / other internal functions
    return { function_name: fn, params: p };
  }
  if (actionType === 'webhook') {
    return { action_type: 'webhook', method: c.method ?? null, url: c.url ?? null, credential_id: c.credential_id ?? null };
  }
  if (actionType === 'start_workflow') {
    return { action_type: 'start_workflow', workflow_id: c.workflow_id ?? null, tie_to_contact: c.tie_to_contact !== false };
  }
  return { action_type: actionType };
}

function _truncate(v, n) {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  enrollContact,
  enrollContactByTemplateId,
  executeStep,
  previewEnrollmentSteps,  // Slice 8A — zero-side-effect dry run
  cancelSequences,
  cancelEnrollment,        // NEW — was internal-only; now used by cancelByApptId callers and apptService
  cancelByApptId,          // Appt-scoped cancellation — see apptService.cancelApptAutomation
  validateTemplateFilters,
  scheduleStepJob,         // Used by routes/sequences.js POST /enrollments/:id/recover
  // Exported for testing
  checkCondition,
  checkFireGuard,
  calculateStepTime,
  buildRefsForStep,
  resolveTriggerDataPlaceholders,
  applyRandomJitter,
};