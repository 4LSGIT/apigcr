// scripts/courtApproveTest.js
//
// Mock-db unit tests for the court-review "Approve & run" slice.
//   (1) force=true strips needs_review at the rerun layer; force=false keeps it.
//   (2) executor STEP 3 gate: needs_review present → queued; absent → executes.
//   (3) hard gate survives force: needs_review stripped BUT citation_miss → still
//       queued with review_reason citation_miss (force ≠ bypass-citations).
//   (4) /approve endpoint wiring: rerunCalRow called {force:true,allowExtract:false};
//       404 on missing row.
//
// No DB, no express server: courtResolve / courtCitation / settingsService are
// stubbed (patched BEFORE requiring courtExecutor/courtRerun, since those
// destructure them at top-level), and the /approve route handler is pulled out
// of the express router stack and called with fake req/res.
//
// Run:  node scripts/courtApproveTest.js

'use strict';

// ── mutable stub state (closures below read these) ──────────────────────────
let RESOLVE  = { found: true, case_id: 42, case_number: '25-47781',
                 primary_contact_id: 7, primary_contact_name: 'Test Client' };
let CITATION = { pass: true, misses: [] };

// ── patch pure deps BEFORE requiring the modules that destructure them ───────
const courtResolve  = require('../lib/courtResolve');
courtResolve.resolveCase = async () => RESOLVE;

const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => CITATION;

const settingsService = require('../services/settingsService');
settingsService.getSetting = async () => '1'; // court_ingest_live = live → dryRun=false

const courtExecutor = require('../services/courtExecutor');
const courtRerun    = require('../services/courtRerun');

// ── tiny test harness ───────────────────────────────────────────────────────
let passN = 0, failN = 0;
function check(name, cond, extra) {
  if (cond) { passN++; console.log('  \u2713', name); }
  else { failN++; console.log('  \u2717', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ── mock db: records queries, answers the executor's reads/writes ───────────
function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      // STEP 1 processed-marker → no prior processed row
      if (/FROM court_ai_log\s+WHERE message_id = \? AND dry_run = 0 AND outcome IN \('executed','none'\)/i.test(sql))
        return [[], []];
      // fetchEmail (rerunCalRow)
      if (/FROM email_log\s+WHERE message_id = \?/i.test(sql) && /subject, body, from_email/i.test(sql))
        return [[{ subject: 'S', body: 'B', from_email: 'noreply@mieb.uscourts.gov' }], []];
      // create_event natural-key dup-guard → no dupe
      if (/SELECT event_id FROM events/i.test(sql) && /event_title=\?/i.test(sql))
        return [[], []];
      // create_appointment dup-guard → no dupe
      if (/SELECT appt_id FROM appts/i.test(sql))
        return [[], []];
      // update_event match query → none
      if (/SELECT event_id, event_date/i.test(sql) && /FROM events/i.test(sql))
        return [[], []];
      // update_case_fields current-row read
      if (/SELECT case_file_date/i.test(sql))
        return [[{}], []];
      // writes
      if (/INSERT INTO events/i.test(sql))        return [{ insertId: 1001 }, undefined];
      if (/INSERT INTO court_ai_log/i.test(sql))  return [{ insertId: 555 }, undefined];
      if (/INSERT INTO ai_change_log/i.test(sql)) return [{ insertId: 1 }, undefined];
      return [[], []];
    },
  };
}
const insertedEvent = db => db.calls.some(c => /INSERT INTO events/i.test(c.sql));

const cleanAction = {
  type: 'create_event',
  fields: { event_type: 'Hearing', event_title: 'Confirmation Hearing',
            date: '2026-07-15', time: '10:00', location: 'Courtroom 1' },
};

async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(1) force strips needs_review at the rerun layer');
  {
    const realExec = courtExecutor.executeCourtActions;
    const row = {
      id: 1, message_id: 'm-1', case_number: '25-47781',
      raw_response: JSON.stringify({
        needs_review: true, review_reason: 'hearing_adjourned', actions: [cleanAction],
      }),
    };

    let capForce;
    courtExecutor.executeCourtActions = async (db, args) => { capForce = args; return { outcome: 'executed', court_ai_log_id: 1 }; };
    await courtRerun.rerunCalRow(makeDb(), row, { force: true, allowExtract: false });
    check('force=true → payload.needs_review stripped before executor',
      capForce && capForce.payload && capForce.payload.needs_review === undefined,
      { needs_review: capForce && capForce.payload && capForce.payload.needs_review });
    check('force=true → actions still present (only needs_review removed)',
      Array.isArray(capForce.payload.actions) && capForce.payload.actions.length === 1);

    let capNo;
    courtExecutor.executeCourtActions = async (db, args) => { capNo = args; return { outcome: 'queued', court_ai_log_id: 2 }; };
    await courtRerun.rerunCalRow(makeDb(), row, { force: false, allowExtract: false });
    check('force=false (default) → payload.needs_review preserved (===true)',
      capNo && capNo.payload && capNo.payload.needs_review === true,
      { needs_review: capNo && capNo.payload && capNo.payload.needs_review });

    courtExecutor.executeCourtActions = realExec; // restore for real-executor tests
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(2) executor STEP 3 gate — needs_review is the only difference');
  {
    RESOLVE = { found: true, case_id: 42, case_number: '25-47781', primary_contact_id: 7, primary_contact_name: 'Test Client' };
    CITATION = { pass: true, misses: [] };

    // (a) flag present → queued, nothing written
    const dbA = makeDb();
    const resQ = await courtExecutor.executeCourtActions(dbA, {
      payload: { message_id: 'm-2a', case_number: '25-47781', needs_review: true, review_reason: 'hearing_adjourned', actions: [cleanAction] },
      subject: 'S', body: 'B', dryRun: false,
    });
    check('needs_review=true → outcome queued (STEP 3)', resQ.outcome === 'queued', resQ);
    check('needs_review=true → review_reason carried from payload', resQ.review_reason === 'hearing_adjourned', resQ.review_reason);
    check('needs_review=true → NO event written', !insertedEvent(dbA));

    // (b) flag absent → executes, event written
    const dbB = makeDb();
    const resE = await courtExecutor.executeCourtActions(dbB, {
      payload: { message_id: 'm-2b', case_number: '25-47781', actions: [cleanAction] },
      subject: 'S', body: 'B', dryRun: false,
    });
    check('needs_review absent → outcome executed', resE.outcome === 'executed', resE);
    check('needs_review absent → event written (reached dispatch)', insertedEvent(dbB));
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(3) hard gate survives force — citation_miss still queues');
  {
    CITATION = { pass: false, misses: [{ field: 'date' }] }; // simulate a citation miss
    const dbC = makeDb();
    // payload already has needs_review stripped (what force produces); a clean
    // STEP 3 pass must NOT skip STEP 4 citations.
    const resC = await courtExecutor.executeCourtActions(dbC, {
      payload: { message_id: 'm-3', case_number: '25-47781', actions: [cleanAction] },
      subject: 'S', body: 'B', dryRun: false,
    });
    check('stripped flag + citation miss → still queued', resC.outcome === 'queued', resC);
    check('review_reason = citation_miss:* (force ≠ bypass-citations)', /^citation_miss/.test(resC.review_reason || ''), resC.review_reason);
    check('citation miss → NO event written', !insertedEvent(dbC));
    CITATION = { pass: true, misses: [] }; // reset
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(4) /approve endpoint wiring');
  {
    const router = require('../routes/courtReview');
    const layer = router.stack.find(l => l.route && l.route.path === '/api/court-review/approve' && l.route.methods.post);
    check('route POST /api/court-review/approve registered', !!layer);
    const st = layer.route.stack;
    const handler = st[st.length - 1].handle; // route fn (jwtOrApiKey is earlier in the stack)

    const realRerun = courtRerun.rerunCalRow;
    const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });

    // found row → rerunCalRow called with force:true, allowExtract:false
    let capRow, capOpts;
    courtRerun.rerunCalRow = async (db, row, opts) => { capRow = row; capOpts = opts; return { status: 'reran', ai: false, dry_run: false, new_court_ai_log_id: 777, result: { outcome: 'executed' } }; };
    const foundRow = { id: 99, message_id: 'm-9', raw_response: '{}' };
    const reqFound = { body: { court_ai_log_id: 99 }, db: { query: async () => [[foundRow], []] }, auth: { userId: 1 } };
    const resFound = mkRes();
    await handler(reqFound, resFound);
    check('found → 200 ok:true', resFound.statusCode === 200 && resFound.body && resFound.body.ok === true, resFound.body);
    check('found → rerunCalRow called with {force:true, allowExtract:false}',
      capOpts && capOpts.force === true && capOpts.allowExtract === false, capOpts);
    check('found → loaded row forwarded to rerunCalRow', capRow && capRow.id === 99);

    // missing row → 404, rerunCalRow NOT called
    courtRerun.rerunCalRow = async () => { throw new Error('rerunCalRow must NOT run on 404'); };
    const req404 = { body: { court_ai_log_id: 12345 }, db: { query: async () => [[], []] }, auth: { userId: 1 } };
    const res404 = mkRes();
    await handler(req404, res404);
    check('missing row → 404 ok:false', res404.statusCode === 404 && res404.body && res404.body.ok === false, res404.body);

    courtRerun.rerunCalRow = realRerun;
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n──────── ${passN} passed, ${failN} failed ────────`);
  process.exit(failN ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });