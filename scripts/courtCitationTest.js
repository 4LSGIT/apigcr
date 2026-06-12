// scripts/courtCitationTest.js
//
// Focused tests for lib/courtCitation.js — the null/blank-field exemption plus
// regressions (real missing citation still fails, fabricated quote still fails,
// real value still requires a citation, non-citable fields stay exempt). Pure
// module, no deps:  node scripts/courtCitationTest.js

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);