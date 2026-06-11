// scripts/courtReviewTest.js
//
// Mock-db tests for the COURT REVIEW QUEUE. No network, no real DB — a
// programmable fake db.query plus targeted monkeypatches. Run:
//   CREDENTIALS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
//     node scripts/courtReviewTest.js
//
// Covers: (a) openness predicate truth-table, (b) re-run reuses raw_response
// with no AI call + honors absent court_ingest_live ⇒ dryRun=true, (c)
// adopt-rerun docket conflict ⇒ 409 and no executor/updateCase, (d) dismiss
// writes the closing row, (e) sweep re-runs a now-resolving row and leaves a
// still-missing one untouched.

if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra != null ? '— ' + JSON.stringify(extra) : ''); }
}

// Programmable mock db. `routes` = [{ test(sql,params), resp }]. resp is a rows
// array (SELECT) / result object (INSERT/UPDATE) / function(sql,params).
function mockDb(routes) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      for (const r of routes) {
        if (r.test(sql, params)) {
          const out = typeof r.resp === 'function' ? r.resp(sql, params) : r.resp;
          return [out, []];
        }
      }
      return [[], []];
    },
  };
}

// Pull the actual logic handler (last fn) for a method+absolute path out of an
// express router stack, skipping the auth middleware.
function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`handler not found: ${method.toUpperCase()} ${path}`);
}

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function run() {
  // ── (a) Openness predicate truth-table ─────────────────────────────────
  // Mirrors the SQL in routes/courtReview.js OPEN_QUEUE_WHERE: a LATER row
  // closes a queued row iff dry_run=0 AND outcome IN ('executed','none').
  console.log('(a) openness rule');
  const closes = (laterRow) => laterRow.dry_run === 0 && ['executed', 'none'].includes(laterRow.outcome);
  ok('later dry_run=0 executed closes',   closes({ dry_run: 0, outcome: 'executed' }) === true);
  ok('later dry_run=0 none closes',       closes({ dry_run: 0, outcome: 'none' }) === true);
  ok('later dry_run=1 executed does NOT', closes({ dry_run: 1, outcome: 'executed' }) === false);
  ok('later dry_run=1 none does NOT',     closes({ dry_run: 1, outcome: 'none' }) === false);
  ok('later dry_run=0 queued does NOT',   closes({ dry_run: 0, outcome: 'queued' }) === false);

  // ── (b) re-run reuses raw_response, no AI, dryRun from absent flag ──────
  console.log('(b) re-run reuses raw_response (no AI) + honors absent court_ingest_live');
  const courtExecutor = require('../services/courtExecutor');
  const origExec = courtExecutor.executeCourtActions;
  let execArgs = null;
  courtExecutor.executeCourtActions = async (db, args) => { execArgs = args; return { outcome: 'executed', court_ai_log_id: 77, applied: [{}], skipped: [] }; };

  const courtRerun = require('../services/courtRerun');
  const payloadObj = { message_id: 'mX', case_number: '25-47781-prh', actions: [{ type: 'create_event', fields: { date: '2026-08-27' } }] };
  const dbB = mockDb([
    { test: (s) => /FROM app_settings/.test(s), resp: [] },                 // court_ingest_live absent ⇒ dryRun true
    { test: (s) => /FROM email_log/.test(s), resp: [{ subject: 'S', body: 'B', from_email: 'f@x' }] },
  ]);
  const rB = await courtRerun.rerunCalRow(dbB, { id: 5, message_id: 'mX', case_number: '25-47781-prh', raw_response: JSON.stringify(payloadObj) }, { allowExtract: true });
  ok('executeCourtActions was called', !!execArgs);
  ok('dryRun=true (court_ingest_live absent)', execArgs && execArgs.dryRun === true, execArgs && execArgs.dryRun);
  ok('payload reused from raw_response', execArgs && execArgs.payload && execArgs.payload.case_number === '25-47781-prh' && Array.isArray(execArgs.payload.actions));
  ok('subject/body re-fetched from email_log', execArgs && execArgs.subject === 'S' && execArgs.body === 'B');
  ok('result.ai === false (no AI call path)', rB.ai === false);
  ok('new_court_ai_log_id surfaced', rB.new_court_ai_log_id === 77);
  courtExecutor.executeCourtActions = origExec;

  // ── (c) adopt-rerun docket conflict ⇒ 409, no executor/updateCase ──────
  console.log('(c) adopt-rerun conflict ⇒ 409, no re-run / no updateCase');
  const reviewRouter = require('../routes/courtReview');
  const caseService = require('../services/caseService');
  const origUpdate = caseService.updateCase;
  const origCollision = caseService.checkCaseNumberCollision;
  let updateCalled = false, collisionCalled = false;
  caseService.updateCase = async () => { updateCalled = true; return { case_id: 'X', updated_fields: [] }; };
  caseService.checkCaseNumberCollision = async () => { collisionCalled = true; return null; };
  const origRerun = courtRerun.rerunCalRow;
  let rerunCalled = false;
  courtRerun.rerunCalRow = async () => { rerunCalled = true; return { status: 'reran' }; };

  const adoptHandler = getHandler(reviewRouter, 'post', '/api/court-review/adopt-rerun');
  const dbC = mockDb([
    { test: (s) => /FROM court_ai_log WHERE id/.test(s), resp: [{ id: 1, message_id: 'm1', case_number: '25-47781-prh', classification: 'hearing_adjourned', raw_response: '{}' }] },
    { test: (s) => /FROM cases WHERE case_id/.test(s), resp: [{ case_id: 'CASE9', case_number: '99-99999', case_number_full: '99-99999-xyz', case_type: 'Bankruptcy' }] }, // DIFFERENT non-empty docket
  ]);
  const resC = mockRes();
  await adoptHandler({ db: dbC, body: { court_ai_log_id: 1, case_id: 'CASE9' } }, resC);
  ok('status 409', resC.statusCode === 409, resC.statusCode);
  ok('conflict kind=overwrite', resC.body && resC.body.conflict && resC.body.conflict.kind === 'overwrite');
  ok('updateCase NOT called', updateCalled === false);
  ok('checkCaseNumberCollision NOT called (guard 2 short-circuits first)', collisionCalled === false);
  ok('rerun NOT called on conflict', rerunCalled === false);
  caseService.updateCase = origUpdate;
  caseService.checkCaseNumberCollision = origCollision;
  courtRerun.rerunCalRow = origRerun;

  // ── (d) dismiss writes the closing row ─────────────────────────────────
  console.log('(d) dismiss writes a closing court_ai_log row');
  const dismissHandler = getHandler(reviewRouter, 'post', '/api/court-review/dismiss');
  let insert = null;
  const dbD = mockDb([
    { test: (s) => /FROM court_ai_log WHERE id/.test(s), resp: [{ id: 2, message_id: 'm2', classification: 'none', case_number: '25-47781-prh', case_name: 'Brohl' }] },
    { test: (s) => /INSERT INTO court_ai_log/.test(s), resp: (s, p) => { insert = { sql: s, params: p }; return { insertId: 99 }; } },
  ]);
  const resD = mockRes();
  await dismissHandler({ db: dbD, body: { court_ai_log_id: 2, note: 'duplicate notice' } }, resD);
  ok('insert happened', !!insert);
  ok("outcome 'none' literal in INSERT", insert && /'none'/.test(insert.sql));
  ok('dry_run=0 literal in INSERT', insert && /VALUES \(\?, NULL, 0,/.test(insert.sql));
  ok('message_id copied', insert && insert.params[0] === 'm2');
  ok('classification copied', insert && insert.params[1] === 'none');
  ok('case_number copied', insert && insert.params[2] === '25-47781-prh');
  ok("review_reason 'dismissed:duplicate notice'", insert && insert.params[4] === 'dismissed:duplicate notice');
  ok('response ok + new id', resD.body && resD.body.ok === true && resD.body.court_ai_log_id === 99);

  // ── (e) sweep re-runs a now-resolving row, leaves a still-missing one ───
  console.log('(e) sweep: re-run now-resolving, skip still-missing');
  const internalFunctions = require('../lib/internal_functions');
  const courtResolve = require('../lib/courtResolve');
  const origResolve = courtResolve.resolveCase;
  courtResolve.resolveCase = async (db, docket) =>
    docket === '25-1'
      ? { found: true, case_id: 'OK1', case_number: '25-1' }
      : { found: false, case_id: null };
  const origRerun2 = courtRerun.rerunCalRow;
  const reranIds = [];
  courtRerun.rerunCalRow = async (db, row) => { reranIds.push(row.id); return { result: { outcome: 'executed' }, dry_run: false, new_court_ai_log_id: 200 }; };

  const dbE = mockDb([
    { test: (s) => /FROM app_settings/.test(s), resp: [] }, // court_ingest_live absent
    { test: (s) => /review_reason = 'case_not_found'/.test(s), resp: [
        { id: 11, message_id: 'mA', case_number: '25-1', classification: 'hearing_adjourned', raw_response: '{}' }, // resolves
        { id: 12, message_id: 'mB', case_number: '25-2', classification: 'hearing_adjourned', raw_response: '{}' }, // still missing
      ] },
  ]);
  const sweep = await internalFunctions.court_review_retry({}, dbE);
  const out = sweep.output;
  ok('scanned 2', out.scanned === 2, out);
  ok('resolved 1', out.resolved === 1, out);
  ok('still_missing 1', out.still_missing === 1, out);
  ok('executed 1 (live re-run)', out.executed === 1, out);
  ok('rerun called ONLY for the resolving row (id 11)', reranIds.length === 1 && reranIds[0] === 11, reranIds);
  courtResolve.resolveCase = origResolve;
  courtRerun.rerunCalRow = origRerun2;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness error:', e); process.exit(2); });