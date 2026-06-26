// scripts/courtSummaryTest.js
//
// Pre-flip verification for the court ACTIVITY SUMMARY digest. Two parts:
//
//   1. Summarizer unit tests — exercises the REAL internalFunctions
//      __summarizeCourtActions against the two real action payloads that exist
//      in court_ai_log (ids 16 and 129), embedded here as fixtures so the
//      assertions are deterministic and run with no DB/key.
//
//   2. Live render — pulls the REAL window query (days=30) from the live DB via
//      the readonly SQL API, feeds the rows into the REAL __buildCourtSummaryHtml,
//      and writes scripts/out/court_summary_preview.html so the digest can be
//      eyeballed before flipping. Prints the tally line. NO email is sent.
//
// Run:
//   summarizer only (no key needed):
//     node scripts/courtSummaryTest.js
//   summarizer + live render:
//     RO_KEY=ycro_xxx node scripts/courtSummaryTest.js
//
// (RO_KEY may also be passed as READONLY_API_KEY. The render step is skipped
//  with a notice if no key is present.)

const fs   = require('fs');
const path = require('path');

// Requiring internal_functions pulls the credentialInjection chain, which can
// validate this env var at load. Mirror scripts/courtReviewTest.js and stub it.
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
}

const { __summarizeCourtActions, __buildCourtSummaryHtml } = require('../lib/internal_functions');

const KEY = process.env.RO_KEY || process.env.READONLY_API_KEY || null;
const API = 'https://app.4lsg.com/api/readonly/sql';

// ── real payload fixtures (verbatim from court_ai_log.actions_json) ───────────
const ID16_ACTIONS = [
  { type: 'create_appointment', fields: {
      date: '2026-07-24', time: '09:00', trustee: 'Krispen S. Carroll', platform: 'Zoom',
      appt_type: '341 Meeting',
      connection_info: 'Meeting ID 949 724 7977, Passcode 2718849134, Phone 1 313 331 6488' } },
  { type: 'create_event', fields: {
      date: '2026-09-02', time: '14:00', all_day: false,
      location: 'Courtroom 1825, 211 W. Fort St.',
      event_type: 'Confirmation Hearing',
      event_title: 'Confirmation Hearing - Moneika Nashay Brown' } },
  { type: 'update_case_fields', fields: {
      case_chapter: '13', case_trustee: 'Krispen S. Carroll', case_objection: '2026-09-22' } },
];
const ID129_ACTIONS = [
  { type: 'create_event', fields: {
      date: '2026-07-16', time: '10:00', all_day: false,
      location: 'Courtroom 1975, 211 W. Fort St.',
      event_type: 'Show Cause Hearing',
      event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay Filing Fee' } },
  { type: 'update_case_fields', fields: { case_chapter: '13' } },
];

let pass = 0, fail = 0;
const ok = (name, got, exp) => {
  if (got === exp) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n     got:', JSON.stringify(got), '\n     exp:', JSON.stringify(exp)); }
};

async function sql(query, params = []) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Readonly-Api-Key': KEY },
    body: JSON.stringify({ sql: query, params }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('readonly SQL error: ' + JSON.stringify(j));
  return j.rows;
}

// Identical to the query inside court_activity_summary (subject via correlated
// subquery, not a JOIN — email_log holds duplicate message_id rows that a JOIN
// would fan out; COLLATE coerces court_ai_log's unicode_ci to email_log's
// general_ci). Dedupe keeps the latest row per message_id.
const WINDOW_SQL = `
  SELECT cal.id, cal.created_at, cal.message_id, cal.classification, cal.outcome,
         cal.review_reason, cal.case_number, cal.case_name, cal.dry_run, cal.actions_json,
         (SELECT el.subject FROM email_log el
            WHERE el.message_id = cal.message_id COLLATE utf8mb4_general_ci
            ORDER BY el.id DESC LIMIT 1) AS subject
    FROM court_ai_log cal
   WHERE cal.created_at >= (NOW() - INTERVAL ? DAY)
     AND NOT EXISTS (
       SELECT 1 FROM court_ai_log c2
        WHERE c2.message_id = cal.message_id AND c2.id > cal.id)
   ORDER BY cal.created_at DESC`;

(async () => {
  // ── 1. summarizer ──────────────────────────────────────────────────────────
  console.log('Summarizer assertions (real payloads, ids 16 & 129):');
  ok('id 16', __summarizeCourtActions(ID16_ACTIONS),
     'scheduled 341 Meeting; added event: Confirmation Hearing; updated case (chapter, trustee, objection)');
  ok('id 129', __summarizeCourtActions(ID129_ACTIONS),
     'added event: Show Cause Hearing; updated case (chapter)');
  // edge cases
  ok('empty -> (no actions)', __summarizeCourtActions([]), '(no actions)');
  ok('null -> (no actions)',  __summarizeCourtActions(null), '(no actions)');
  ok('unknown type passes through', __summarizeCourtActions([{ type: 'frobnicate', fields: {} }]), 'frobnicate');

  // ── 2. live render ─────────────────────────────────────────────────────────
  if (!KEY) {
    console.log('\n[render] skipped — set RO_KEY (or READONLY_API_KEY) to render the live preview.');
  } else {
    const rows = await sql(WINDOW_SQL, [30]);
    const { html, counts } = __buildCourtSummaryHtml(rows, { days: 30, firmTz: 'America/Detroit' });

    const tally = `${counts.processed} processed — ${counts.actioned} actioned, ` +
      `${counts.queued} queued for review, ${counts.ignored} ignored, ${counts.errors} errors`;
    console.log('\nTally line (days=30):\n  ' + tally);
    console.log('  dry-run mode: allDry=' + counts.allDry + ' anyDry=' + counts.anyDry);

    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'court_summary_preview.html');
    fs.writeFileSync(outFile, html);
    console.log('\nHTML file written: ' + outFile + ' (' + html.length + ' bytes)');
    console.log('  §A Actioned:', html.includes('Actioned'),
                '| §B Needs Review:', html.includes('Needs Review'),
                '| §C Ignored:', html.includes('Ignored / No Action'));
  }

  console.log('\n' + (fail === 0 ? 'ALL ASSERTIONS PASS' : fail + ' ASSERTION(S) FAILED') + ` (pass=${pass} fail=${fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
