// scripts/courtTitleMatchTest.js
//
// Mock-db unit tests for two court-review changes (no DB, no server):
//
//   D1 — title-aware update_event. A reschedule must update the SAME hearing,
//        never a different SAME-TYPE hearing. Drives the REAL executeCourtActions
//        LIVE (dryRun:false, non -test- id) with stubbed match-query rows, so an
//        errant UPDATE would actually be issued — that is what makes case (ii)
//        (the live id-209 regression) a real guard.
//        (i)  one type-match, title MATCHES  → UPDATE in place, no flag, executed.
//        (ii) one type-match, title DIFFERS  → NO update of the existing event,
//             a fresh event created, review_reason includes event_title_mismatch,
//             outcome queued.  [REGRESSION GUARD — assert no UPDATE events.]
//        (iii) zero type-matches             → clean create, no flag, not queued.
//        (iv) two type-matches, none uniquely title-matching → create + flag.
//        (v)  titlesMatch unit cases.
//
//   D2 — re-extract (fresh AI pass). forceExtract:true IGNORES a stored payload
//        and runs court_extract; the stored payload is NOT replayed. /reextract
//        endpoint calls rerunCalRow{forceExtract:true}; 404 on a missing row.
//
// Heavy app leaves (internal_functions, caseService, auth.jwtOrApiKey) are faked
// in require.cache so nothing native loads; pure deps (courtResolve /
// courtCitation / settingsService) are patched BEFORE requiring the modules that
// destructure them. 
// 
// Run:  node scripts/courtTitleMatchTest.js

'use strict';
const path = require('path');

// ── inject fakes for heavy / npm-coupled leaves BEFORE anything requires them ─
function fakeModule(relFromRoot, exports) {
  const abs = path.resolve(__dirname, '..', relFromRoot);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
  return exports;
}
// court_extract is mutated per-test; default no-op shape.
const fakeInternal = fakeModule('lib/internal_functions/index.js', {
  court_extract: async () => ({ output: {} }),
});
fakeModule('services/caseService.js', {
  updateCase: async () => ({}),
  checkCaseNumberCollision: async () => null,
});
fakeModule('lib/auth.jwtOrApiKey.js', (req, res, next) => { if (next) next(); });

// ── patch pure deps BEFORE requiring the modules that destructure them ───────
let RESOLVE  = { found: true, case_id: 42, case_number: '21-50019',
                 primary_contact_id: 7, primary_contact_name: 'Test Client' };
let CITATION = { pass: true, misses: [] };

const courtResolve  = require('../lib/courtResolve');
courtResolve.resolveCase = async () => RESOLVE;
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => CITATION;
const settingsService = require('../services/settingsService');
settingsService.getSetting = async () => '0'; // court_ingest_live off → dryRun true (D2 only)

const courtExecutor = require('../services/courtExecutor');
const courtRerun    = require('../services/courtRerun');
const reviewRouter  = require('../routes/courtReview');
const { titlesMatch } = courtExecutor._internal;

// ── tiny harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713', name); }
  else { fail++; console.log('  \u2717', name, extra !== undefined ? '\u2014 ' + JSON.stringify(extra) : ''); }
}

// ── mock db: programmable update_event match rows + executor reads/writes ─────
let MATCH_ROWS = []; // rows returned for the update_event type-match SELECT
function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      // STEP 1 processed-marker → no prior processed row
      if (/FROM court_ai_log\s+WHERE message_id = \? AND dry_run = 0 AND outcome IN \('executed','none'\)/i.test(sql))
        return [[], []];
      // fetchEmail (rerunCalRow)
      if (/FROM email_log/i.test(sql) && /subject, body, from_email/i.test(sql))
        return [[{ subject: 'S', body: 'B', from_email: 'court@mieb.uscourts.gov' }], []];
      // update_event TYPE-MATCH query (note the comma after event_id) — MUST be
      // tested before the create_event dup-guard below.
      if (/SELECT event_id, event_date/i.test(sql) && /FROM events/i.test(sql))
        return [MATCH_ROWS, []];
      // create_event natural-key dup-guard → no dupe
      if (/SELECT event_id FROM events/i.test(sql) && /event_title=\?/i.test(sql))
        return [[], []];
      // create_appointment dup-guard → no dupe
      if (/SELECT appt_id FROM appts/i.test(sql))
        return [[], []];
      // update_case_fields current-row read
      if (/SELECT case_file_date/i.test(sql))
        return [[{}], []];
      // writes
      if (/INSERT INTO events/i.test(sql))        return [{ insertId: 7777 }, undefined];
      if (/INSERT INTO court_ai_log/i.test(sql))  return [{ insertId: 555 }, undefined];
      if (/INSERT INTO ai_change_log/i.test(sql)) return [{ insertId: 1 }, undefined];
      if (/UPDATE events SET event_date/i.test(sql)) return [{ affectedRows: 1 }, undefined];
      return [[], []];
    },
  };
}
const updEvents = (db) => db.calls.filter((c) => /UPDATE events SET event_date/i.test(c.sql));
const insEvents = (db) => db.calls.filter((c) => /INSERT INTO events/i.test(c.sql));

function updateEventPayload(messageId, title, date) {
  return {
    message_id: messageId,
    case_number: '21-50019',
    actions: [{
      type: 'update_event',
      fields: { event_type: 'Hearing', event_title: title, date, time: '09:00', location: 'Courtroom 1' },
    }],
  };
}
const evRow = (id, title, date) => ({
  event_id: id, event_date: date, event_time: '10:00:00',
  event_all_day: 0, event_location: 'Courtroom 1', event_title: title,
});

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD1 (i) ONE type-match, title MATCHES → UPDATE in place, no flag');
  {
    MATCH_ROWS = [evRow(88, 'Confirmation Hearing', '2026-08-13')];
    const db = makeDb();
    const res = await courtExecutor.executeCourtActions(db, {
      payload: updateEventPayload('m-d1-i', 'Confirmation Hearing', '2026-08-20'),
      subject: 'S', body: 'B', dryRun: false,
    });
    const ups = updEvents(db);
    ok('outcome executed', res.outcome === 'executed', res.outcome);
    ok('NOT queued (no flag)', res.review_reason == null, res.review_reason);
    ok('UPDATE events issued', ups.length === 1, ups.length);
    ok('UPDATE targets the matched event_id (88)', ups.length === 1 && ups[0].params[ups[0].params.length - 1] === 88, ups[0] && ups[0].params);
    ok('no fresh event created', insEvents(db).length === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD1 (ii) ONE type-match, title DIFFERS — id-209 regression guard');
  {
    MATCH_ROWS = [evRow(88, 'Hearing on Chapter 13 Post-Confirmation Plan Modification', '2026-08-13')];
    const db = makeDb();
    const res = await courtExecutor.executeCourtActions(db, {
      payload: updateEventPayload('m-d1-ii', "Hearing on Trustee's Motion to Dismiss Case", '2026-08-27'),
      subject: 'S', body: 'B', dryRun: false,
    });
    ok('REGRESSION GUARD: NO UPDATE of the existing event', updEvents(db).length === 0, updEvents(db).map((c) => c.params));
    ok('a fresh event WAS created', insEvents(db).length === 1, insEvents(db).length);
    ok('review_reason includes event_title_mismatch', /event_title_mismatch/.test(res.review_reason || ''), res.review_reason);
    ok('outcome queued', res.outcome === 'queued', res.outcome);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD1 (iii) ZERO type-matches → clean create, no flag, not queued');
  {
    MATCH_ROWS = [];
    const db = makeDb();
    const res = await courtExecutor.executeCourtActions(db, {
      payload: updateEventPayload('m-d1-iii', 'Confirmation Hearing', '2026-09-01'),
      subject: 'S', body: 'B', dryRun: false,
    });
    ok('no UPDATE issued', updEvents(db).length === 0);
    ok('a fresh event created', insEvents(db).length === 1, insEvents(db).length);
    ok('NOT queued', res.outcome !== 'queued' && res.review_reason == null, res);
    ok('outcome executed', res.outcome === 'executed', res.outcome);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD1 (iv) TWO type-matches, none uniquely title-matching → create + flag');
  {
    MATCH_ROWS = [
      evRow(88, 'Hearing on Plan Modification', '2026-08-13'),
      evRow(89, 'Hearing on Objection to Claim', '2026-08-20'),
    ];
    const db = makeDb();
    const res = await courtExecutor.executeCourtActions(db, {
      payload: updateEventPayload('m-d1-iv', 'Hearing on Motion to Dismiss', '2026-08-27'),
      subject: 'S', body: 'B', dryRun: false,
    });
    ok('NO UPDATE of either event', updEvents(db).length === 0, updEvents(db).map((c) => c.params));
    ok('a fresh event created', insEvents(db).length === 1, insEvents(db).length);
    ok('review_reason includes event_title_mismatch', /event_title_mismatch/.test(res.review_reason || ''), res.review_reason);
    ok('outcome queued', res.outcome === 'queued', res.outcome);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD1 (v) titlesMatch unit cases');
  {
    ok('("Confirmation Hearing","Confirmation Hearing") = true',  titlesMatch('Confirmation Hearing', 'Confirmation Hearing') === true);
    ok('("Plan Modification","Motion to Dismiss") = false',       titlesMatch('Plan Modification', 'Motion to Dismiss') === false);
    ok('("Plan Modification","Modification of Plan") = true',     titlesMatch('Plan Modification', 'Modification of Plan') === true);
    ok('("Show Cause","Show Cause Hearing") = true',              titlesMatch('Show Cause', 'Show Cause Hearing') === true);
    // extra: the id-209 distinguishing pair must be FALSE
    ok('(Plan-Modification hearing vs Motion-to-Dismiss hearing) = false',
      titlesMatch('Hearing on Chapter 13 Post-Confirmation Plan Modification', "Hearing on Trustee's Motion to Dismiss Case") === false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD2 (1) forceExtract:true with a NON-null payload → fresh AI, payload NOT replayed');
  {
    const realExec = courtExecutor.executeCourtActions;
    let calledExec = false, calledExtractArgs = null;
    courtExecutor.executeCourtActions = async () => { calledExec = true; return { outcome: 'executed', court_ai_log_id: 1 }; };
    fakeInternal.court_extract = async (args /*, db */) => {
      calledExtractArgs = args;
      return { output: { outcome: 'executed', court_ai_log_id: 999, review_reason: null, dry_run: false, skipped: null } };
    };

    const row = {
      id: 5, message_id: 'm-d2', case_number: '21-50019',
      raw_response: JSON.stringify(updateEventPayload('m-d2', 'Confirmation Hearing', '2026-08-20')), // NON-null payload
    };
    const r = await courtRerun.rerunCalRow(makeDb(), row, { forceExtract: true });

    ok('court_extract (fresh AI) WAS invoked', !!calledExtractArgs, calledExtractArgs);
    ok('stored payload NOT replayed (executeCourtActions not called)', calledExec === false);
    ok('court_extract got the canonical message_id', calledExtractArgs && calledExtractArgs.message_id === 'm-d2', calledExtractArgs && calledExtractArgs.message_id);
    ok('result.ai === true', r.ai === true, r.ai);
    ok('new_court_ai_log_id from the fresh extract (999)', r.new_court_ai_log_id === 999, r.new_court_ai_log_id);

    courtExecutor.executeCourtActions = realExec;
    fakeInternal.court_extract = async () => ({ output: {} });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\nD2 (2) /reextract endpoint wiring');
  {
    const layer = reviewRouter.stack.find((l) => l.route && l.route.path === '/api/court-review/reextract' && l.route.methods.post);
    ok('route POST /api/court-review/reextract registered', !!layer);
    const st = layer.route.stack;
    const handler = st[st.length - 1].handle; // route fn (auth middleware is earlier)

    const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });
    const realRerun = courtRerun.rerunCalRow;

    // found row → rerunCalRow called with {forceExtract:true}
    let capOpts = null, capRow = null;
    courtRerun.rerunCalRow = async (db, rw, opts) => { capRow = rw; capOpts = opts; return { status: 'reran', ai: true, dry_run: false, new_court_ai_log_id: 888, result: { outcome: 'executed' } }; };
    const foundRow = { id: 99, message_id: 'm-9', raw_response: '{}' };
    const reqFound = { body: { court_ai_log_id: 99 }, db: { query: async () => [[foundRow], []] }, auth: { userId: 1 } };
    const resFound = mkRes();
    await handler(reqFound, resFound);
    ok('found → 200 ok:true', resFound.statusCode === 200 && resFound.body && resFound.body.ok === true, resFound.body);
    ok('found → rerunCalRow called with {forceExtract:true}', capOpts && capOpts.forceExtract === true, capOpts);
    ok('found → loaded row forwarded', capRow && capRow.id === 99);

    // missing row → 404, rerunCalRow NOT called
    courtRerun.rerunCalRow = async () => { throw new Error('rerunCalRow must NOT run on 404'); };
    const req404 = { body: { court_ai_log_id: 12345 }, db: { query: async () => [[], []] }, auth: { userId: 1 } };
    const res404 = mkRes();
    await handler(req404, res404);
    ok('missing row → 404 ok:false', res404.statusCode === 404 && res404.body && res404.body.ok === false, res404.body);

    courtRerun.rerunCalRow = realRerun;
  }

  console.log(`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 ${pass} passed, ${fail} failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });