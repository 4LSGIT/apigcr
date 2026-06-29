// scripts/courtRescheduleTest.js
//
// Mock-db unit tests for the court-executor update_event RECONCILE split
// (the slice that lets a clear-dated reschedule auto-complete instead of
// queuing). Drives executeCourtActions LIVE (dryRun:false, non-test ids) with
// a programmable fake db whose "future Scheduled events of this type" match
// query returns 0 / 1 / 2 rows per scenario.
//
//   (i)   ONE future match  → UPDATE issued in place, NO event_update_ambiguous,
//                             outcome 'executed' (NOT queued), no fresh INSERT.
//   (ii)  ZERO matches       → fresh event created (doCreateEvent ran), NO
//                             event_update_ambiguous, outcome 'executed'.
//   (iii) TWO matches        → fresh event created AND event_update_ambiguous
//                             pushed → outcome 'queued'.
//
// No DB, no express server: courtResolve / courtCitation are stubbed (patched
// BEFORE requiring courtExecutor, which destructures them at top-level).
//
// Run:  node scripts/courtRescheduleTest.js

'use strict';

// ── stub state (closures below read these) ──────────────────────────────────
const RESOLVE  = { found: true, case_id: 42, case_number: '25-47781',
                   primary_contact_id: 7, primary_contact_name: 'Test Client' };
const CITATION = { pass: true, misses: [] };

// ── patch pure deps BEFORE requiring the module that destructures them ───────
const courtResolve  = require('../lib/courtResolve');
courtResolve.resolveCase = async () => RESOLVE;

const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => CITATION;

const courtExecutor = require('../services/courtExecutor');

// ── tiny harness ────────────────────────────────────────────────────────────
let passN = 0, failN = 0;
function check(name, cond, extra) {
  if (cond) { passN++; console.log('  \u2713', name); }
  else { failN++; console.log('  \u2717', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ── mock db: records queries, answers the executor's reads/writes. `matches`
// is the row array the update_event "future Scheduled events of this type"
// SELECT returns (0/1/2 rows per scenario). ─────────────────────────────────
function makeDb(matches) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      // STEP 1 processed-marker → no prior processed row
      if (/FROM court_ai_log\s+WHERE message_id = \? AND dry_run = 0 AND outcome IN \('executed','none'\)/i.test(sql))
        return [[], []];
      // update_event MATCH query (distinct: "event_id, event_date") → scenario rows
      if (/SELECT event_id, event_date/i.test(sql) && /FROM events/i.test(sql))
        return [matches, []];
      // doCreateEvent natural-key dup-guard (has event_title=?) → no dupe
      if (/SELECT event_id FROM events/i.test(sql) && /event_title=\?/i.test(sql))
        return [[], []];
      // writes
      if (/UPDATE events SET event_date/i.test(sql))  return [{ affectedRows: 1 }, undefined];
      if (/INSERT INTO events/i.test(sql))            return [{ insertId: 1001 }, undefined];
      if (/INSERT INTO court_ai_log/i.test(sql))      return [{ insertId: 555 }, undefined];
      if (/INSERT INTO ai_change_log/i.test(sql))     return [{ insertId: 1 }, undefined];
      return [[], []];
    },
  };
}
const insertedEvent = db => db.calls.some(c => /INSERT INTO events/i.test(c.sql));
const updatedEvent  = db => db.calls.some(c => /UPDATE events SET event_date/i.test(c.sql));

// A clear-dated reschedule of a Confirmation Hearing.
const reschedAction = {
  type: 'update_event',
  fields: { event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
            date: '2026-09-15', time: '14:00', location: 'Courtroom 1' },
};
// A single existing future Scheduled Confirmation Hearing (the one to update).
const existingRow = {
  event_id: 700, event_date: '2026-08-01', event_time: '14:00:00',
  event_all_day: 0, event_location: 'Courtroom 1',
};
const mkPayload = (mid) => ({
  message_id: mid, case_number: '25-47781',
  classification: 'hearing_adjourned', needs_review: false,
  actions: [reschedAction],
});

async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(i) ONE future match → update in place, NOT queued');
  {
    const db = makeDb([existingRow]);
    const res = await courtExecutor.executeCourtActions(db, {
      payload: mkPayload('court-rsx-one'), subject: 'S', body: 'B', dryRun: false,
    });
    check('UPDATE events issued', updatedEvent(db), res);
    check('NO fresh INSERT (updated in place)', !insertedEvent(db));
    check('outcome executed (NOT queued)', res.outcome === 'executed', res.outcome);
    check('review_reason null (no event_update_ambiguous)',
      res.review_reason == null, res.review_reason);
    check('event_update_ambiguous NOT present',
      !/event_update_ambiguous/.test(res.review_reason || ''), res.review_reason);
    check('applied has reschedule (update_event)',
      Array.isArray(res.applied) && res.applied.some(a => a.type === 'update_event' && /^reschedule /.test(a.summary || '')), res.applied);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(ii) ZERO matches → clean create, NOT queued');
  {
    const db = makeDb([]);
    const res = await courtExecutor.executeCourtActions(db, {
      payload: mkPayload('court-rsx-zero'), subject: 'S', body: 'B', dryRun: false,
    });
    check('fresh event INSERTed (doCreateEvent ran)', insertedEvent(db), res);
    check('NO UPDATE issued', !updatedEvent(db));
    check('outcome executed (NOT queued)', res.outcome === 'executed', res.outcome);
    check('review_reason null (no event_update_ambiguous)',
      res.review_reason == null, res.review_reason);
    check('event_update_ambiguous NOT present',
      !/event_update_ambiguous/.test(res.review_reason || ''), res.review_reason);
    check('applied has create_event',
      Array.isArray(res.applied) && res.applied.some(a => a.type === 'create_event'), res.applied);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n(iii) TWO matches → fresh create AND flagged → queued');
  {
    const db = makeDb([existingRow, { ...existingRow, event_id: 701, event_date: '2026-08-05' }]);
    const res = await courtExecutor.executeCourtActions(db, {
      payload: mkPayload('court-rsx-two'), subject: 'S', body: 'B', dryRun: false,
    });
    check('fresh event INSERTed (doCreateEvent ran)', insertedEvent(db), res);
    check('outcome queued', res.outcome === 'queued', res.outcome);
    check('review_reason includes event_update_ambiguous',
      /event_update_ambiguous/.test(res.review_reason || ''), res.review_reason);
    check('applied has create_event',
      Array.isArray(res.applied) && res.applied.some(a => a.type === 'create_event'), res.applied);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 ${passN} passed, ${failN} failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
  process.exit(failN ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });