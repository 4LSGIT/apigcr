// scripts/courtCitationTest.js
//
// Focused tests for lib/courtCitation.js — the null/blank-field exemption, ECF
// *emphasis*-marker stripping, plus regressions (real missing citation still
// fails, fabricated quote still fails, real value still requires a citation,
// non-citable fields stay exempt). Pure module, no deps:
//   node scripts/courtCitationTest.js

const { checkCitations } = require('../lib/courtCitation');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra != null ? '— ' + JSON.stringify(extra) : ''); }
}

// The real #24 email (adversary proceeding 25-04172-prh, no location stated).
const SUBJECT = '25-04172-prh "Minute Entry" Ch';
const BODY = 'Minute Entry. Status Conference Hearing Held - Final Pre-trial Conference ' +
             'scheduled for 08/10/26 at 10:00 AM; Trial scheduled 08/17/26 at 10:00 AM';

// 1) #24 reproduction: two events with location:null → must PASS now.
const r24 = checkCitations(SUBJECT, BODY, [
  { type: 'create_event',
    fields: { date: '2026-08-10', time: '10:00', all_day: false, location: null,
              event_type: 'Pre-trial Conference', event_title: 'Final Pre-trial Conference' },
    citations: { date: 'Final Pre-trial Conference scheduled for 08/10/26 at 10:00 AM',
                 time: '08/10/26 at 10:00 AM' } },
  { type: 'create_event',
    fields: { date: '2026-08-17', time: '10:00', all_day: false, location: null,
              event_type: 'Trial', event_title: 'Trial' },
    citations: { date: 'Trial scheduled 08/17/26 at 10:00 AM',
                 time: '08/17/26 at 10:00 AM' } },
]);
ok('#24 (location:null on both) now PASSES', r24.pass === true, r24.misses);

// 2) Blank-string value is also exempt.
const rBlank = checkCitations(SUBJECT, BODY, [
  { type: 'create_event',
    fields: { date: '2026-08-10', location: '   ', event_type: 'X', event_title: 'Y' },
    citations: { date: 'Final Pre-trial Conference scheduled for 08/10/26 at 10:00 AM' } },
]);
ok('blank/whitespace location exempt', rBlank.pass === true, rBlank.misses);

// 3) REGRESSION — a real (non-null) field value with NO citation still fails.
const rMissing = checkCitations(SUBJECT, BODY, [
  { type: 'create_event',
    fields: { date: '2026-08-10', location: 'Courtroom 1925', event_type: 'X', event_title: 'Y' },
    citations: { date: 'Final Pre-trial Conference scheduled for 08/10/26 at 10:00 AM' } },
]);
ok('real value, missing citation still FAILS', rMissing.pass === false &&
   rMissing.misses.some(m => m.field === 'location' && m.value === null), rMissing.misses);

// 4) REGRESSION — fabricated (non-substring) citation still fails.
const rFab = checkCitations(SUBJECT, BODY, [
  { type: 'create_event',
    fields: { date: '2026-08-10', location: 'Courtroom 1925', event_type: 'X', event_title: 'Y' },
    citations: { date: 'Final Pre-trial Conference scheduled for 08/10/26 at 10:00 AM',
                 location: 'Held at Courtroom 1925 on the 7th floor' } }, // not in haystack
]);
ok('fabricated location quote still FAILS', rFab.pass === false &&
   rFab.misses.some(m => m.field === 'location' && m.value != null), rFab.misses);

// 5) REGRESSION — real value WITH a valid substring citation passes.
const rGood = checkCitations(SUBJECT, BODY, [
  { type: 'create_event',
    fields: { date: '2026-08-17', event_type: 'Trial', event_title: 'Trial' },
    citations: { date: 'Trial scheduled 08/17/26 at 10:00 AM' } },
]);
ok('real value + valid citation PASSES', rGood.pass === true, rGood.misses);

// 6) REGRESSION — non-citable-only action (e.g. all_day/event_type) passes with no citations.
const rNonCitable = checkCitations(SUBJECT, BODY, [
  { type: 'create_event', fields: { event_type: 'Trial', event_title: 'Trial', all_day: true }, citations: {} },
]);
ok('non-citable-only action passes', rNonCitable.pass === true, rNonCitable.misses);

// ── ECF *emphasis*-marker stripping (live row 329, 26-40794-mar) ───────────
// ECF NEF bodies carry markdown-style *asterisk* emphasis. The model copies the
// docket text "verbatim" but drops the asterisks, so a faithful quote used to
// fail a raw substring test purely on formatting punctuation.
const ECF_SUBJECT = '26-40794-mar "Order Discharging Debtor(s)" Ch 7';
const ECF_BODY =
  'The following transaction was received from REW entered on 07/13/2026 at\n' +
  '12:09PM EDT and filed on 07/13/2026\n' +
  '*Case Name:* Charles Penny\n' +
  '*Case Number:* 26-40794-mar\n' +
  '*Docket Text:*\n' +
  'Order Discharging *Debtor* . (ADI: REW)';

// 7) The exact live-329 payload: model stripped the asterisks → must PASS now.
const rEcf = checkCitations(ECF_SUBJECT, ECF_BODY, [
  { type: 'update_case_fields',
    fields: { case_close_date: '2026-07-13' },
    citations: { case_close_date: 'Order Discharging Debtor . (ADI: REW)' } },
]);
ok('ECF asterisk-stripped citation now PASSES', rEcf.pass === true, rEcf.misses);

// 8) SAFETY — a citation differing from the source by MORE than asterisks
//    (wrong ADI + injected words) must STILL FAIL. Stripping '*' cannot rescue
//    a genuine fabrication.
const rEcfFab = checkCitations(ECF_SUBJECT, ECF_BODY, [
  { type: 'update_case_fields',
    fields: { case_close_date: '2026-07-13' },
    citations: { case_close_date: 'Order Discharging Debtor and closing case (ADI: XYZ)' } },
]);
ok('non-asterisk fabrication still FAILS', rEcfFab.pass === false &&
   rEcfFab.misses.some(m => m.field === 'case_close_date' && m.value != null), rEcfFab.misses);

// 9) SYMMETRY — a citation that copied the asterisks verbatim must ALSO pass.
//    Guards the "strip BOTH haystack and needle" decision: a one-sided strip
//    (haystack only) would regress this case.
const rEcfVerbatim = checkCitations(ECF_SUBJECT, ECF_BODY, [
  { type: 'update_case_fields',
    fields: { case_close_date: '2026-07-13' },
    citations: { case_close_date: 'Order Discharging *Debtor* . (ADI: REW)' } },
]);
ok('verbatim-with-asterisks citation PASSES', rEcfVerbatim.pass === true, rEcfVerbatim.misses);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);