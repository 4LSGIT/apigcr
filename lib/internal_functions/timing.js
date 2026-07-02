// lib/internal_functions/timing.js
const ms = require('ms');
const { parseUserDateTime }       = require('../../services/timezoneService');

// ─────────────────────────────────────────────────────────────
// Timing helpers (used by schedule_resume / wait_for)
// ─────────────────────────────────────────────────────────────

/**
 * Apply symmetric ±N minute jitter to an ISO timestamp string. Mirrors
 * lib/sequenceEngine.applyRandomJitter and the calendar service. We keep
 * the workflow side as a separate function (rather than importing from
 * sequenceEngine) to avoid a new circular-dependency surface.
 *
 * @param {string} iso  — ISO datetime string
 * @param {number?} randomizeMinutes
 * @returns {string} ISO datetime string (possibly the same as input)
 */
function applyJitterIso(iso, randomizeMinutes) {
  const n = Number(randomizeMinutes) || 0;
  if (n <= 0) return iso;
  const jitter = Math.floor(Math.random() * (n * 2 + 1)) - n;
  return new Date(new Date(iso).getTime() + jitter * 60 * 1000).toISOString();
}

const fns = {};

// ─────────────────────────────────────────────────────────────
// TIME / SCHEDULING
// ─────────────────────────────────────────────────────────────

/**
 * schedule_resume
 * Pause execution and resume at a future point in time.
 *
 * params:
 *   resumeAt           {string|number|null}
 *                      ISO datetime, duration string ("2h","10m","1d"),
 *                      milliseconds-from-now, or null (skip-block).
 *                      String forms accepted:
 *                        "2026-05-01T14:30:00Z"        explicit UTC
 *                        "2026-05-01T14:30:00-04:00"   explicit offset
 *                        "2026-05-01T14:30:00"         naive → FIRM_TZ
 *                        "2026-05-01 14:30:00"         SQL-ish → FIRM_TZ
 *                        "2026-05-01"                  date → FIRM_TZ midnight
 *                        "2h" / "10m" / "30s" / "1d"   relative duration
 *   nextStep           {number}  — step number to resume at
 *   skipToStep         {number?} — step to jump to when resumeAt is null
 *                                   (defaults to nextStep)
 *   randomizeMinutes   {number?} — symmetric ±N minute jitter applied to
 *                                   the computed resume time
 *
 * Past times are passed through to scheduled_jobs as-is — the next
 * /process-jobs tick will fire them. We do not throw on past times.
 *
 * example config:
 *   { "function_name": "schedule_resume",
 *     "params": { "resumeAt": "{{resume_24h}}", "nextStep": 4,
 *                 "skipToStep": 6, "randomizeMinutes": 15 } }
 */

fns.schedule_resume = async (params) => {
    // Skip-block path — used when pre-computed timestamps are in the past
    // and set to null by createAppt. Workflow continues to skipToStep
    // (or nextStep if no skipToStep given).
    if (params.resumeAt == null || params.resumeAt === '' || params.resumeAt === 'null') {
      const skipTo = params.skipToStep ?? params.nextStep;
      console.log(`[SCHEDULE_RESUME] resumeAt is null/empty — skipping block, jumping to step ${skipTo}`);
      return { success: true, next_step: skipTo };
    }

    let resumeAt;
    if (typeof params.resumeAt === 'string') {
      // Date-shape strings (start with YYYY-MM-DD) go through the
      // timezone-aware parser. Other strings ("2h", "10m", etc.) go
      // through ms() for relative-duration parsing.
      if (/^\d{4}-\d{2}-\d{2}/.test(params.resumeAt)) {
        const parsed = parseUserDateTime(params.resumeAt);
        if (!parsed) {
          // Should not be reachable — top guard already caught null/""/"null".
          // This handles the edge case of "  " (whitespace-only) which
          // parseUserDateTime returns null for.
          const skipTo = params.skipToStep ?? params.nextStep;
          console.log(`[SCHEDULE_RESUME] resumeAt parsed as empty — skipping block, jumping to step ${skipTo}`);
          return { success: true, next_step: skipTo };
        }
        resumeAt = parsed.toISOString();
      } else {
        const msDelay = ms(params.resumeAt);
        if (msDelay === undefined) {
          throw new Error(
            `Invalid resumeAt: "${params.resumeAt}". Use a duration ` +
            `("10m","2h","1d","30s"), an ISO datetime ` +
            `("2026-05-01T14:30:00Z" or "2026-05-01T14:30:00-04:00"), ` +
            `a naive datetime in firm time ("2026-05-01T14:30:00"), ` +
            `or a date ("2026-05-01")`
          );
        }
        resumeAt = new Date(Date.now() + msDelay).toISOString();
      }
    } else if (typeof params.resumeAt === 'number') {
      resumeAt = new Date(Date.now() + params.resumeAt).toISOString();
    } else {
      throw new Error('resumeAt must be ISO/duration string, number (ms), or null');
    }

    const nextStep = params.nextStep;
    if (nextStep == null) throw new Error('nextStep is required');

    // Apply optional symmetric ±N jitter
    resumeAt = applyJitterIso(resumeAt, params.randomizeMinutes);

    console.log(`[SCHEDULE_RESUME] Resume at ${resumeAt}, step ${nextStep}` +
                (params.randomizeMinutes ? ` (±${params.randomizeMinutes}min)` : ''));
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  };

fns.schedule_resume.__meta = {
  category: 'timing',
  workflowOnly: true,
  controlFlow: true,
  description: 'Pause execution and resume at a future point in time.',
  params: [
    { name: 'resumeAt', type: 'iso_datetime', required: true, placeholderAllowed: true,
      nullishSkipsBlock: true,
      description: 'ISO datetime, duration string ("2h"), milliseconds-from-now, or null (skip-block path — jumps to skipToStep).',
      example: '{{resume_24h}}' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step number to resume at.', example: 4 },
    { name: 'skipToStep', type: 'integer', required: false,
      description: 'Step to jump to when resumeAt is null/empty. Defaults to nextStep.',
      example: 6 },
    { name: 'randomizeMinutes', type: 'integer', required: false, min: 0, max: 1440,
      description: '±N minute jitter applied to resume time. Max 1440 (24h).',
      example: 15 },
  ],
  example: { resumeAt: '2h', nextStep: 4 }
};

/**
 * wait_for
 * Pause for a duration OR until a specific time, then continue.
 *
 * params:
 *   duration           {string|number?} — relative ("2h","30m") or ms number
 *   at                 {string?}        — absolute ISO datetime; same
 *                                          parsing as schedule_resume.resumeAt
 *                                          (FIRM_TZ for naive forms)
 *   nextStep           {number}         — step to resume at
 *   skipToStep         {number?}        — used when `at` resolves to null
 *                                          (parity with schedule_resume)
 *   randomizeMinutes   {number?}        — symmetric ±N minute jitter
 *
 * Exactly one of `duration` or `at` is required.
 *
 * example configs:
 *   { "function_name": "wait_for", "params": { "duration": "48h", "nextStep": 5 } }
 *   { "function_name": "wait_for",
 *     "params": { "at": "2026-05-01T14:30:00", "nextStep": 5,
 *                 "randomizeMinutes": 10 } }
 */

fns.wait_for = async (params) => {
    const { duration, at, nextStep } = params;
    if (nextStep == null) throw new Error('wait_for requires nextStep');

    // Skip-block path — when `at` is explicitly present in params with a
    // nullish/empty value. Parity with schedule_resume's null-skip semantics.
    // Triggered by precompute-and-gate patterns like apptService.createAppt
    // ("the time we wanted to wait until is already past, so don't wait").
    //
    // We check `'at' in params` to distinguish "explicitly null" (skip) from
    // "at key missing" (use duration instead) — those are different inputs
    // and need different behavior.
    if ('at' in params && (at === null || at === '' || at === 'null')) {
      const skipTo = params.skipToStep ?? nextStep;
      console.log(`[WAIT_FOR] at is null/empty — skipping block, jumping to step ${skipTo}`);
      return { success: true, next_step: skipTo };
    }

    const hasDuration = duration !== undefined && duration !== null && duration !== '';
    const hasAt       = at       !== undefined && at       !== null && at       !== '';
    if (hasDuration && hasAt) {
      throw new Error('wait_for accepts exactly one of `duration` or `at`, not both');
    }
    if (!hasDuration && !hasAt) {
      throw new Error('wait_for requires either `duration` or `at`');
    }

    let resumeAt;
    if (hasAt) {
      // Absolute mode. Whitespace-only or otherwise unparseable `at` falls
      // through to the skip path below — exact null/""/"null" was already
      // handled by the top guard.
      if (typeof at !== 'string') {
        throw new Error('wait_for.at must be a string');
      }
      const parsed = parseUserDateTime(at);
      if (!parsed) {
        const skipTo = params.skipToStep ?? nextStep;
        console.log(`[WAIT_FOR] at parsed as empty — skipping block, jumping to step ${skipTo}`);
        return { success: true, next_step: skipTo };
      }
      resumeAt = parsed.toISOString();
    } else {
      // Relative mode — preserves existing behavior.
      if (typeof duration === 'number') {
        resumeAt = new Date(Date.now() + duration).toISOString();
      } else {
        const msDelay = ms(String(duration));
        if (msDelay === undefined) throw new Error(`Invalid duration: "${duration}"`);
        resumeAt = new Date(Date.now() + msDelay).toISOString();
      }
    }

    resumeAt = applyJitterIso(resumeAt, params.randomizeMinutes);

    const label = hasAt ? `at ${at}` : `duration ${duration}`;
    console.log(`[WAIT_FOR] Waiting (${label}) → resume step ${nextStep} at ${resumeAt}` +
                (params.randomizeMinutes ? ` (±${params.randomizeMinutes}min)` : ''));
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  };

fns.wait_for.__meta = {
  category: 'timing',
  workflowOnly: true,
  description: 'Pause for a duration OR until a specific time, then continue.',
  params: [
    { name: 'duration', type: 'duration', required: false, placeholderAllowed: true,
      modeGroup: 'relative',
      description: 'Relative wait — "30s", "5m", "2h", "1d", or millisecond number.',
      example: '2h' },
    { name: 'at', type: 'iso_datetime', required: false, placeholderAllowed: true,
      nullishSkipsBlock: true, modeGroup: 'absolute',
      description: 'Absolute datetime; naive forms use FIRM_TZ. Explicit null/empty triggers skip-block path (jump to skipToStep).',
      example: '2026-05-01T14:30:00' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step to resume at.', example: 5 },
    { name: 'skipToStep', type: 'integer', required: false,
      description: 'Step to jump to when `at` resolves to null. Defaults to nextStep.',
      example: 7 },
    { name: 'randomizeMinutes', type: 'integer', required: false, min: 0, max: 1440,
      description: '±N minute jitter. Max 1440 (24h).', example: 10 },
  ],
  exclusiveOneOf: [['duration', 'at']],
  example: { duration: '2h', nextStep: 5 }
};

/**
 * wait_until_time
 * Resume at the next occurrence of a specific time of day.
 * Useful for "send this at 9am the next business day" patterns.
 *
 * params:
 *   time      {string}  — "HH:MM" in 24h format, e.g. "09:00"
 *   timezone  {string}  — IANA timezone, e.g. "America/Detroit" (default: UTC)
 *   nextStep  {number}  — step to resume at
 *
 * example config:
 *   {
 *     "function_name": "wait_until_time",
 *     "params": { "time": "09:00", "timezone": "America/Detroit", "nextStep": 6 }
 *   }
 */

fns.wait_until_time = async (params) => {
    const { time, timezone = process.env.FIRM_TIMEZONE || 'America/Detroit', nextStep } = params;
    if (!time)            throw new Error('wait_until_time requires time (HH:MM)');
    if (nextStep == null) throw new Error('wait_until_time requires nextStep');

    const [hours, minutes] = time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time format: "${time}". Use HH:MM`);

    const now = new Date();
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    tzDate.setHours(hours, minutes, 0, 0);

    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    if (tzDate <= nowInTz) {
      tzDate.setDate(tzDate.getDate() + 1);
    }

    const utcEquivalent = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = now - utcEquivalent;
    const resumeAt = new Date(tzDate.getTime() + offsetMs).toISOString();

    console.log(`[WAIT_UNTIL_TIME] Resume at ${time} ${timezone} → ${resumeAt}, step ${nextStep}`);
    return { success: true, delayed_until: resumeAt, next_step: nextStep };
  };

fns.wait_until_time.__meta = {
  category: 'timing',
  workflowOnly: true,
  description: 'Resume at the next occurrence of a specific time of day.',
  params: [
    { name: 'time', type: 'string', required: true,
      description: '"HH:MM" 24h format.', example: '09:00' },
    { name: 'timezone', type: 'string', required: false,
      description: 'IANA timezone. Defaults to FIRM_TIMEZONE (America/Detroit).',
      example: 'America/Detroit' },
    { name: 'nextStep', type: 'integer', required: true,
      description: 'Step to resume at.', example: 6 },
  ],
  example: { time: '09:00', timezone: 'America/Detroit', nextStep: 6 }
};

module.exports = fns;
