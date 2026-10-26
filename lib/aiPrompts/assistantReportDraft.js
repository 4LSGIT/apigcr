'use strict';
// A16 — the report-draft rules and the curated schema, appended to the answer
// and repair stages ONLY on a turn that asks for a report (assistantService
// reportDraftRequested / a rejected report.draft.v1). Every other answer pays
// nothing for the ~5k tokens of schema.
//
// Ruling 16 (Fred, 2026-10-27): Casey drafts report SQL. The Reports engine is
// the authority, exactly as for sql.read — the server runs the create route's
// own validators on the draft, previews it on the least-privilege report pool,
// and the route re-validates on save. These rules exist so the draft passes
// first time; they are not the gate. They mirror lib/aiPrompts/reportBuild.js
// (the Reports AI author) where the two overlap — change both together.
//
// SSN (Fred's ruling 2, same day): last-4 by default; the full number only
// when the user's own question names SSNs. The server enforces both halves.

const manifest = require('../reportSchema/manifest');

const REPORT_DRAFT_APPENDIX = `
REPORT DRAFT RULES (report.draft.v1 — this turn asks for a report or an exportable list):
* The card SAVES ONE new report definition in Reports (More → Reports). It changes no client record and sends nothing.
  Reports are firm-wide: every staff member can see and run it, and edit it unless someone locks it. After saving, the
  user opens it in Reports, where it runs and the CSV button exports it. Say this plainly in the answer, and say the
  export contains client personal information.
* The server validates your SQL with the Reports validator, runs it on the read-only report pool, and shows the real
  row count and first rows on the card — so write SQL that runs as-is. If the server refuses it you get one repair turn
  with the exact error.
* sql: exactly ONE SELECT statement, no semicolon, no comments, no CTEs, no SELECT * or t.*. Use ONLY the curated tables
  and columns below. Alias EVERY output column in clean snake_case — the alias is the CSV column header (e.g.
  AS client_name, AS phone, AS case_number). Add an ORDER BY. A LIMIT is optional: row_limit (1-10000, default 1000)
  caps what the saved report returns. Bound anything touching log by log_date. A plan estimated above ~500,000 rows
  examined is refused — filter early, never cross-join.
* For EVERY equality between two text expressions put both sides in utf8mb4_general_ci
  (a.x COLLATE utf8mb4_general_ci = b.y COLLATE utf8mb4_general_ci). Numeric equalities need none.
* The client on a case: FROM cases c LEFT JOIN case_relate cr ON cr.case_relate_case_id = c.case_id AND
  cr.case_relate_type = 'Primary' LEFT JOIN contacts ct ON ct.contact_id = cr.case_relate_client_id.
  For a list of contacts, select contact_id (and case_id when cases are involved) so each row can be traced.
* params: only for values the user will want to change when re-running (a date window, a status). Each is
  {"name":"start","type":"date|datetime|number|string","label":"From","default":"-90d","required":true}; one '?' per
  param, IN ORDER. Date defaults may be today, yesterday, -30d, -90d, -365d, -3m, month_start, last_month_start,
  last_month_end, year_start; a param named end/to/until/before binds to 23:59:59. EVERY param needs a default — the
  card's preview runs on the defaults. Prefer 0-2 params; write fixed criteria from the user's words straight into
  the SQL as literals.
* columns_meta (optional): [{"key":"<an alias your SQL returns>","label":"Header","format":"text|number|date|currency|percent|days"}].
  Every key must be a returned alias; an unknown key or format refuses the card.
* viz (optional — omit it for a plain table): how the saved report opens in Reports, which can switch it there. The
  Reports chart types only: table | bar | line | area | pie | doughnut | combo | stat (figures). Shape:
  {"type":"bar","x":"<a returned label/category alias>","y":"<a returned NUMBER alias>"} or, for several metrics,
  "series":[{"key":"<number alias>","label":"Header","type":"bar|line|area","axis":"y1","format":"number|percent|currency|days"}]
  (every series field but key optional; axis "y1" = a second axis, combo charts). Optional: stacked / horizontal
  (true|false), xLabel / yLabel / y1Label (short text), limit (1-1000, e.g. top 12 slices). bar/line/area/pie/doughnut/
  combo need x and y or series; pie/doughnut plot exactly ONE number column; stat shows number columns as figures
  (series optional); table takes no other field. y / series keys must be NUMBER columns (COUNT(*), SUM(...)) — the card
  refuses a chart that cannot draw. Choose a chart only when the user asks for one or the shape is plainly a
  breakdown / trend (one row per category or per period with counts); a list of people or cases stays a table.
* caveats: short, specific, checkable limits of THIS result (e.g. "contact_city is the legacy address field and can
  disagree with contact_addresses"). description says what it shows AND what it excludes.
* category: Contacts | Cases | Appointments | Activity | Tasks | Campaigns | General.
* SSN / EIN (contacts.contact_ssn): select it ONLY as the last four digits, exactly
  RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),4) (a table prefix is fine: ct.contact_ssn) AS ssn_last4 — and use
  that same expression in any filter, e.g. RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4) <> '' for "has an
  SSN on file". The FULL number is allowed only when the user's own current message asks for SSNs / social security
  numbers; then select ct.contact_ssn and say in the answer that the export contains full SSNs. contact_dob is
  selectable. The card's preview hides SSN and date-of-birth values; the saved report shows them.
* If the user only wants an answer in chat (a few rows, nothing to export or keep), answer from the evidence and offer
  the report as a suggestion instead of a card.
* Ground first when values matter: the investigation's sql.read rows show which case types, statuses, cities or
  dates actually exist — write filters against real values, not guesses.

CURATED SCHEMA AND SEMANTICS (the only tables and columns a report may read):
${manifest.toPromptContext()}`;

module.exports = { REPORT_DRAFT_APPENDIX };
