// lib/noteLimits.js
//
// One length limit for every freeform notes field in the app.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────
//
// The session sql_mode deliberately lacks STRICT_TRANS_TABLES — enabling it
// breaks case creation (~41 NOT-NULL columns rely on implicit defaults) and
// listCases' GROUP BY. Under non-strict mode an over-length write to a TEXT
// or VARCHAR column is TRUNCATED SILENTLY: a warning nobody reads, no error
// anywhere in the stack, and a caller that is told it succeeded.
//
// That is not hypothetical. appt_note was varchar(1000) until 2026-08-20, and
// four rows sat at EXACTLY 1000 characters, each cut mid-sentence:
//
//   appt 2604  "…uck is not even working at all so I didn't ask them to come "
//   appt 2857  "…ically taking the money out of my bank monthly? Well this is"
//
// Nobody was told. Those tails are unrecoverable. All four notes columns are
// TEXT as of that date, which raises the ceiling to 65,535 BYTES — it does
// NOT remove the cliff, it moves it. So the guard lives here, in code, where
// it holds regardless of sql_mode.
//
// ── CHARACTERS, NOT BYTES ────────────────────────────────────
//
// The cap is on String.length (UTF-16 code units) because that is the number
// a UI can put in front of a user. The conversion errs safe: a 3-byte UTF-8
// character (CJK, curly quotes — already present in the truncated rows above)
// costs 1 unit, and a 4-byte one (emoji) costs 2, so true byte cost never
// exceeds 3 × length. 10,000 × 3 = 30,000 bytes, comfortably inside 65,535.
//
// ── USER INPUT ONLY ──────────────────────────────────────────
//
// Machine APPEND paths are deliberately not checked: caseService's merge
// concat and apptService's five appt_note CONCAT sites (booking, reschedule,
// cancel audit trails — almost certainly what grew those four rows) add a
// line at a time and are bounded in practice. Failing a reschedule because an
// appointment has been rescheduled often would be a worse bug than a long
// note, and the TEXT ceiling now sits ~6× above this limit with room for them.
//
// Adding a column to NOTE_COLUMNS enforces it at every call site below.

const NOTE_MAX_CHARS = 10000;

const NOTE_COLUMNS = new Set([
  'case_notes',       // cases     — TEXT
  '341_notes',        // cases     — TEXT
  'contact_notes',    // contacts  — TEXT
  'appt_note',        // appts     — TEXT
  'body',             // checklists.body — a note's text where kind='note' (S1)
]);

/**
 * Checks a column → value object for over-length notes fields.
 *
 * Ignores keys that are not notes columns, and values that are not strings:
 * a null clear is legitimate, and a non-string is somebody else's validation
 * problem (api.checklists.js already type-checks `body` before calling this).
 *
 * @param   {object} fields
 * @returns {string|null}  a user-facing message, or null when everything fits
 */
function checkNoteLengths(fields) {
  if (!fields || typeof fields !== 'object') return null;
  for (const key of Object.keys(fields)) {
    if (!NOTE_COLUMNS.has(key)) continue;
    const v = fields[key];
    if (typeof v !== 'string') continue;
    if (v.length > NOTE_MAX_CHARS) {
      return `${key} is ${v.length.toLocaleString()} characters — the limit is `
           + `${NOTE_MAX_CHARS.toLocaleString()}. Shorten it, or split it across `
           + `separate notes.`;
    }
  }
  return null;
}

/**
 * Service-layer variant. Throws an Error carrying `status = 400` so the route
 * can map it without string-matching the message — see the status ladders in
 * routes/api.cases.js and routes/api.contacts.js.
 */
function assertNoteLengths(fields) {
  const msg = checkNoteLengths(fields);
  if (msg) {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }
}

module.exports = { NOTE_MAX_CHARS, NOTE_COLUMNS, checkNoteLengths, assertNoteLengths };
