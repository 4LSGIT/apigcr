/**
 * Timezone Service
 * services/timezoneService.js
 *
 * Converts between the firm's local time and UTC.
 *
 * The firm's timezone is set via env: FIRM_TIMEZONE (IANA format)
 * Example: FIRM_TIMEZONE=America/Detroit
 *
 * Background:
 *   The DB stores most user-facing datetimes in local firm time
 *   (appt_date, log_date, etc.) because staff enter and read them
 *   that way. But scheduled_jobs.scheduled_time must be real UTC
 *   because the claim query compares against NOW() which returns UTC.
 *
 *   mysql2 is configured with timezone: "Z", so when it reads a
 *   datetime column it wraps it in a JS Date labeled as UTC — even
 *   though the value is actually local. These functions correct for
 *   that mismatch.
 *
 * Column reference:
 *   LOCAL (firm time):
 *     appts.appt_date          — entered by staff, displayed to staff
 *     log.log_date             — CONVERT_TZ(NOW()...'EST5EDT') in SQL
 *
 *   UTC:
 *     appts.appt_date_utc      — computed at insert, used for scheduling
 *     appts.appt_create_date   — NOW()
 *     scheduled_jobs.scheduled_time — must be UTC for claim query
 *     tasks.task_date           — NOW()
 *     contacts.contact_created  — NOW()
 *     workflow_executions.*     — NOW()
 *
 * Usage:
 *   const { localToUTC, utcToLocal, FIRM_TZ } = require('../services/timezoneService');
 *   const realUTC = localToUTC(appt.appt_date);      // for scheduling
 *   const localDt = utcToLocal(new Date());           // for display
 */

const { DateTime } = require('luxon');

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/**
 * Convert a local-time datetime (stored as-if-UTC by mysql2)
 * into a real UTC Date.
 *
 * Example (during EDT, UTC-4):
 *   appt_date in DB: "2026-03-19 14:30:00" (means 2:30 PM local)
 *   mysql2 reads as: Date("2026-03-19T14:30:00.000Z") (fake UTC)
 *   this returns:    Date("2026-03-19T18:30:00.000Z") (real UTC)
 *
 * @param {Date|string} localDate - Date from mysql2 or ISO string
 * @returns {Date} real UTC Date
 */
function localToUTC(localDate) {
  if (!localDate) return null;
  const d = localDate instanceof Date ? localDate : new Date(localDate);
  // Strip the fake UTC label — get the raw YYYY-MM-DDTHH:mm:ss
  const naive = d.toISOString().slice(0, 19);
  // Tell luxon "this is firm-local time" → convert to UTC
  const dt = DateTime.fromISO(naive, { zone: FIRM_TZ });
  if (!dt.isValid) {
    console.error(`[TZ] Invalid date for localToUTC: ${localDate} → ${dt.invalidReason}`);
    return null;
  }
  return dt.toUTC().toJSDate();
}

/**
 * Convert a real UTC Date into the firm's local time.
 * Returns a luxon DateTime for flexible formatting.
 *
 * @param {Date|string} utcDate - real UTC Date or ISO string
 * @returns {DateTime} luxon DateTime in firm timezone
 */
function utcToLocal(utcDate) {
  if (!utcDate) return null;
  const d = utcDate instanceof Date ? utcDate : new Date(utcDate);
  return DateTime.fromJSDate(d, { zone: 'utc' }).setZone(FIRM_TZ);
}

/**
 * Get the current time in the firm's local timezone.
 * Returns a luxon DateTime.
 *
 * @returns {DateTime}
 */
function nowLocal() {
  return DateTime.now().setZone(FIRM_TZ);
}

/**
 * Format a local-stored DB date for display.
 * Since the date is already in local time, this just formats it
 * without any timezone conversion.
 *
 * @param {Date|string} localDate - Date from mysql2 (local time stored as-if-UTC)
 * @param {string} format - luxon format string, e.g. 'cccc, MMMM d, yyyy h:mm a'
 * @returns {string}
 */
function formatLocal(localDate, format = 'cccc, MMMM d, yyyy h:mm a') {
  if (!localDate) return '';
  const d = localDate instanceof Date ? localDate : new Date(localDate);
  const naive = d.toISOString().slice(0, 19);
  return DateTime.fromISO(naive).toFormat(format);
}

/**
 * Parse a user-supplied datetime string into a real UTC Date.
 *
 * Distinct from `localToUTC` — that helper is for datetimes coming back
 * from mysql2 (stored as fake UTC). This helper is for free-form strings
 * authored by humans (or pre-computed by upstream code into trigger_data).
 *
 * Accepted shapes:
 *   "2026-05-01T14:30:00Z"           explicit UTC
 *   "2026-05-01T14:30:00-04:00"      explicit offset (colon form)
 *   "2026-05-01T14:30:00"            naive ISO   → FIRM_TZ
 *   "2026-05-01T14:30"               naive ISO without seconds → FIRM_TZ
 *   "2026-05-01 14:30:00"            SQL-ish     → FIRM_TZ
 *   "2026-05-01"                     date-only   → FIRM_TZ midnight
 *
 * Empty/null input returns null (caller decides what that means).
 * Malformed input throws.
 *
 * @param {string|null|undefined} input
 * @returns {Date|null}
 * @throws {Error} when input is a non-empty string that cannot be parsed
 */
function parseUserDateTime(input) {
  if (input == null) return null;
  if (typeof input !== 'string') {
    throw new Error(`parseUserDateTime expects a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;

  // Date-only: YYYY-MM-DD → midnight in FIRM_TZ
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const dt = DateTime.fromISO(trimmed, { zone: FIRM_TZ });
    if (!dt.isValid) {
      throw new Error(`Invalid date "${input}": ${dt.invalidReason || 'unknown'}`);
    }
    return dt.toUTC().toJSDate();
  }

  // Normalize space-separator to T (SQL "YYYY-MM-DD HH:MM:SS" → ISO form)
  const isoForm = trimmed.replace(' ', 'T');

  // Basic shape gate. Avoids accepting things like "2026" or "garbage".
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoForm)) {
    throw new Error(
      `Invalid datetime "${input}": expected ISO 8601 like ` +
      `"2026-05-01T14:30:00Z", "2026-05-01T14:30:00-04:00", ` +
      `"2026-05-01T14:30:00" (firm time), or "2026-05-01"`
    );
  }

  // Detect explicit timezone suffix: Z or ±HH:MM (colon form only — compact
  // ±HHMM is not part of the spec for this slice).
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoForm);

  if (hasOffset) {
    // Preserve the explicit offset by passing setZone: true; luxon will keep
    // the wall time at the given offset and we then convert to UTC.
    const dt = DateTime.fromISO(isoForm, { setZone: true });
    if (!dt.isValid) {
      throw new Error(`Invalid datetime "${input}": ${dt.invalidReason || 'unknown'}`);
    }
    return dt.toUTC().toJSDate();
  }

  // Naive (no offset) → interpret in firm timezone, then convert to UTC.
  const dt = DateTime.fromISO(isoForm, { zone: FIRM_TZ });
  if (!dt.isValid) {
    throw new Error(`Invalid datetime "${input}": ${dt.invalidReason || 'unknown'}`);
  }
  return dt.toUTC().toJSDate();
}

module.exports = {
  localToUTC,
  utcToLocal,
  nowLocal,
  formatLocal,
  parseUserDateTime,
  FIRM_TZ
};