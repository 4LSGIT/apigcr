#!/usr/bin/env node
/* eslint-disable no-console */
// scripts/test_court_revert.js
//
// Slice 4b harness — read-through mock pattern (real SELECT shapes answered from
// seeded in-memory tables; writes intercepted/applied to those tables). NO live
// DB, NO API. Covers:
//   T1  harden #1 — a mid-dispatch write throws (live-sim) → an 'error'
//       court_ai_log row is written AND the change rows buffered before the
//       throw are flushed.
//   T3a revert preview (dryRun=true) writes/stamps nothing.
//   T3b revert real (dryRun=false) restores case col, cancels created event,
//       silently cancels created appt, stamps undone_at/undone_by.
//   T3c modified-since guard skips a case row whose current value changed.
//
// Run: node scripts/test_court_revert.js   (exit 0 = all pass)

const assert = require('assert');
const { executeCourtActions, revertCourtActions } = require('../services/courtExecutor');
const apptStub = require('../services/apptService');

let PASS = 0, FAIL = 0;
const ok = (m) => { console.log('  PASS:', m); PASS++; };
const no = (m) => { console.log('  FAIL:', m); FAIL++; };
const eq = (m, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(`${m} (=${JSON.stringify(a)})`) : no(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));

// ── Stateful mock DB ──────────────────────────────────────────────────────
function makeDb(seed) {
  const T = {
    cases: seed.cases,        // { case_id: {col:val} }
    events: seed.events,      // { event_id: {..} }
    appts: seed.appts,        // { appt_id: {appt_status} }
    case_relate: seed.case_relate || [],
    court_ai_log: [],
    ai_change_log: seed.ai_change_log || [],
    _ailSeq: (seed.ai_change_log && seed.ai_change_log.length) || 0,
    _calSeq: 1000,
    _evSeq: 5000,
  };
  const throwOn = seed.throwOn || (() => false);
  const db = {
    __appts: T.appts,        // apptStub reads this to flip status
    _T: T,
    async query(sql, params = []) {
      if (throwOn(sql, params)) throw new Error('simulated dispatch write failure');

      // resolveCase: q1
      if (/FROM cases\s+WHERE case_number_full = \? OR case_number = \?/.test(sql)) {
        const [full, bare] = params;
        const row = Object.values(T.cases).find(c => c.case_number_full === full || c.case_number === bare);
        return [row ? [{ case_id: row.case_id, case_number: row.case_number, case_number_full: row.case_number_full, case_chapter: row.case_chapter }] : []];
      }
      // resolveCase: bare fallback
      if (/FROM cases\s+WHERE case_number = \?\s+LIMIT 1/.test(sql)) {
        const [bare] = params;
        const row = Object.values(T.cases).find(c => c.case_number === bare);
        return [row ? [{ case_id: row.case_id, case_number: row.case_number, case_number_full: row.case_number_full, case_chapter: row.case_chapter }] : []];
      }
      // resolveCase: primary contact
      if (/FROM case_relate cr/.test(sql)) {
        return [T.case_relate];
      }
      // STEP1 processed marker
      if (/FROM court_ai_log\s+WHERE message_id = \? AND dry_run = 0/.test(sql)) {
        return [[]];
      }
      // insertCourtAiLog
      if (/INSERT INTO court_ai_log/.test(sql)) {
        const row = {
          id: 700 + T.court_ai_log.length + 1,
          message_id: params[0], ai_call_id: params[1], dry_run: params[2],
          classification: params[3], case_number: params[4], resolved_case_id: params[5],
          case_name: params[6], actions_json: params[7], citations_json: params[8],
          outcome: params[9], review_reason: params[10], raw_response: params[11],
        };
        T.court_ai_log.push(row);
        return [{ insertId: row.id }];
      }
      // flushChangeRows
      if (/INSERT INTO ai_change_log/.test(sql)) {
        const row = {
          id: ++T._ailSeq,
          source_message_id: params[0], ai_call_id: params[1], court_ai_log_id: params[2],
          entity_type: params[3], entity_id: params[4], field: params[5],
          old_value: params[6], new_value: params[7], dry_run: params[8],
          undone_at: null, undone_by: null,
        };
        T.ai_change_log.push(row);
        return [{ insertId: row.id }];
      }
      // appt dupe guard
      if (/SELECT appt_id FROM appts\s+WHERE appt_case_id=\?/.test(sql)) return [[]];
      // create_event dupe guard
      if (/SELECT event_id\s+FROM events\s+WHERE event_link_type='case_number'[\s\S]*event_title=\?/.test(sql)) return [[]];
      // create_event INSERT
      if (/INSERT INTO events/.test(sql)) {
        const id = ++T._evSeq;
        T.events[id] = {
          event_id: id, event_type: params[0], event_link_id: params[2], event_title: params[3],
          event_date: params[4], event_time: params[5], event_all_day: params[6],
          event_location: params[7], event_status: params[8],
        };
        return [{ insertId: id }];
      }
      // update_event match SELECT
      if (/SELECT event_id, event_date, event_time, event_all_day, event_location FROM events\s+WHERE event_link_type/.test(sql)) {
        const evs = Object.values(T.events).filter(e => e.event_status === 'Scheduled');
        return [evs.map(e => ({ event_id: e.event_id, event_date: e.event_date, event_time: e.event_time, event_all_day: e.event_all_day, event_location: e.event_location }))];
      }
      // update_case_fields current row
      if (/SELECT case_file_date, case_judge, case_close_date,\s+case_chapter, case_trustee, case_objection\s+FROM cases WHERE case_id=\?/.test(sql)) {
        const c = T.cases[params[0]] || {};
        return [[{ case_file_date: c.case_file_date ?? null, case_judge: c.case_judge ?? null, case_close_date: c.case_close_date ?? null, case_chapter: c.case_chapter ?? null, case_trustee: c.case_trustee ?? null, case_objection: c.case_objection ?? null }]];
      }
      // UPDATE cases SET `col`=? WHERE case_id=?
      let m = sql.match(/UPDATE cases SET `(\w+)`=\? WHERE case_id=\?/);
      if (m) { const col = m[1]; const [val, cid] = params; if (T.cases[cid]) T.cases[cid][col] = val; return [{ affectedRows: 1 }]; }
      // UPDATE events full restore / reschedule (executor wraps the reschedule
      // form across two lines, so tolerate any whitespace before WHERE)
      if (/UPDATE events SET event_date=\?, event_time=\?, event_all_day=\?, event_location=\?\s+WHERE event_id=\?/.test(sql)) {
        const [d, t, ad, loc, eid] = params; const e = T.events[eid];
        if (e) { e.event_date = d; e.event_time = t; e.event_all_day = ad; e.event_location = loc; }
        return [{ affectedRows: 1 }];
      }
      // UPDATE events SET event_status='Canceled'
      if (/UPDATE events SET event_status='Canceled' WHERE event_id=\?/.test(sql)) {
        const e = T.events[params[0]]; if (e) e.event_status = 'Canceled'; return [{ affectedRows: 1 }];
      }
      // revert target select (ids)
      if (/FROM ai_change_log\s+WHERE id IN \(\?\) AND dry_run=0 AND undone_at IS NULL/.test(sql)) {
        const ids = params[0];
        const rows = T.ai_change_log.filter(r => ids.includes(r.id) && r.dry_run === 0 && r.undone_at == null)
          .sort((a, b) => b.id - a.id)
          .map(r => ({ id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, field: r.field, old_value: r.old_value, new_value: r.new_value }));
        return [rows];
      }
      // revert target select (messageId)
      if (/FROM ai_change_log\s+WHERE source_message_id=\? AND dry_run=0 AND undone_at IS NULL/.test(sql)) {
        const mid = params[0];
        const rows = T.ai_change_log.filter(r => r.source_message_id === mid && r.dry_run === 0 && r.undone_at == null)
          .sort((a, b) => b.id - a.id)
          .map(r => ({ id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, field: r.field, old_value: r.old_value, new_value: r.new_value }));
        return [rows];
      }
      // stamp
      if (/UPDATE ai_change_log SET undone_at=NOW\(\), undone_by=\? WHERE id=\?/.test(sql)) {
        const [uby, id] = params; const r = T.ai_change_log.find(x => x.id === id);
        if (r) { r.undone_at = 'NOW'; r.undone_by = uby; } return [{ affectedRows: 1 }];
      }
      // revert: case current single col
      m = sql.match(/SELECT `(\w+)` AS v FROM cases WHERE case_id=\?/);
      if (m) { const col = m[1]; const c = T.cases[params[0]]; return [c ? [{ v: c[col] ?? null }] : []]; }
      // revert: event/create status
      if (/SELECT event_status FROM events WHERE event_id=\?/.test(sql)) {
        const e = T.events[params[0]]; return [e ? [{ event_status: e.event_status }] : []];
      }
      // revert: event/update current
      if (/SELECT event_date, event_time, event_all_day, event_location FROM events WHERE event_id=\?/.test(sql)) {
        const e = T.events[params[0]]; return [e ? [{ event_date: e.event_date, event_time: e.event_time, event_all_day: e.event_all_day, event_location: e.event_location }] : []];
      }
      // revert: appt status
      if (/SELECT appt_status FROM appts WHERE appt_id=\?/.test(sql)) {
        const a = T.appts[params[0]]; return [a ? [{ appt_status: a.appt_status }] : []];
      }
      throw new Error('UNHANDLED SQL in mock: ' + sql.replace(/\s+/g, ' ').slice(0, 120));
    },
  };
  return db;
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────
  // T1 — harden #1: mid-dispatch throw → error log + partial change flushed
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nT1 — audit-on-error (mid-dispatch write throws, live)');
  {
    const db = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13', case_judge: null } },
      events: {},
      appts: {},
      // throw on the events INSERT (the 2nd action), AFTER the case UPDATE+flush-buffer of action 1
      throwOn: (sql) => /INSERT INTO events/.test(sql),
    });
    const subject = 'Notice of Hearing Ch 13 26-42040-mar';
    const body = 'Judge: Hon. Test Judge. Hearing set 2026-08-15.';
    const payload = {
      message_id: 'errtest-1@x', classification: 'hearing', case_number: '26-42040-mar',
      actions: [
        { type: 'update_case_fields', fields: { case_judge: 'Hon. Test Judge' }, citations: { case_judge: 'Hon. Test Judge' } },
        { type: 'create_event', fields: { event_type: 'hearing', event_title: 'Hearing', date: '2026-08-15' }, citations: { date: '2026-08-15' } },
      ],
    };
    const res = await executeCourtActions(db, { payload, subject, body, dryRun: false });
    eq('T1 outcome=error', res.outcome, 'error');
    eq('T1 error flag', res.error, true);
    (res.review_reason || '').startsWith('error:') ? ok('T1 review_reason starts "error:"') : no('T1 review_reason: ' + res.review_reason);
    const log = db._T.court_ai_log;
    eq('T1 one court_ai_log row', log.length, 1);
    eq('T1 court_ai_log.outcome=error', log[0].outcome, 'error');
    log[0].citations_json != null ? ok('T1 citations_json captured on error row') : no('T1 citations_json missing');
    const cl = db._T.ai_change_log;
    eq('T1 one change row flushed (the case judge write)', cl.length, 1);
    eq('T1 change row entity/field', [cl[0].entity_type, cl[0].field], ['case', 'case_judge']);
    eq('T1 change row links to error court_ai_log', cl[0].court_ai_log_id, log[0].id);
    eq('T1 case_judge actually written before throw', db._T.cases['12345'].case_judge, 'Hon. Test Judge');
  }

  // ───────────────────────────────────────────────────────────────────────
  // T3 — live execute (case update + event create + appt create), then revert
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nT3 — live execute → revert preview → revert real');
  {
    const MID = 'revtest-1@x';
    const db = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13', case_trustee: 'Old Trustee' } },
      events: {},
      appts: {},
      case_relate: [{ contact_id: 555, contact_name: 'Jane Debtor' }],
    });
    const subject = 'Meeting of Creditors Ch 13 26-42040-mar';
    const body = 'Trustee: New Trustee. 341 Meeting set 2026-09-01 at 10:00 AM. Confirmation hearing 2026-10-15.';
    const payload = {
      message_id: MID, classification: 'meeting_ch13', case_number: '26-42040-mar',
      actions: [
        { type: 'update_case_fields', fields: { case_trustee: 'New Trustee' }, citations: { case_trustee: 'New Trustee' } },
        { type: 'create_event', fields: { event_type: 'confirmation_hearing', event_title: 'Confirmation', date: '2026-10-15' }, citations: { date: '2026-10-15' } },
        { type: 'create_appointment', fields: { date: '2026-09-01', time: '10:00' }, citations: { date: '2026-09-01', time: '10:00' } },
      ],
    };
    apptStub._calls.cancelAppt.length = 0;
    const ex = await executeCourtActions(db, { payload, subject, body, dryRun: false });
    eq('T3 execute outcome=executed', ex.outcome, 'executed');
    const cl = db._T.ai_change_log;
    eq('T3 three live change rows', cl.length, 3);
    eq('T3 all dry_run=0', [...new Set(cl.map(r => r.dry_run))], [0]);
    const evRow = cl.find(r => r.entity_type === 'event');
    eq('T3 event change is create', evRow.field, 'create');
    const apptRow = cl.find(r => r.entity_type === 'appt');
    eq('T3 appt change is create, entity_id=9001', [apptRow.field, apptRow.entity_id], ['create', '9001']);
    // seed appt into appts store so revert can read its status
    db._T.appts['9001'] = { appt_status: 'Scheduled' };
    eq('T3 case_trustee written', db._T.cases['12345'].case_trustee, 'New Trustee');

    // T3a preview
    const prev = await revertCourtActions(db, { messageId: MID, dryRun: true, actingUserId: 22 });
    eq('T3a preview dryRun true', prev.dryRun, true);
    eq('T3a preview plans 3 reverts', prev.reverted.length, 3);
    eq('T3a preview wrote nothing to case', db._T.cases['12345'].case_trustee, 'New Trustee');
    eq('T3a preview stamped nothing', cl.filter(r => r.undone_at != null).length, 0);
    eq('T3a preview did not cancel appt', apptStub._calls.cancelAppt.length, 0);

    // T3b real revert
    const real = await revertCourtActions(db, { messageId: MID, dryRun: false, actingUserId: 22 });
    eq('T3b real dryRun false', real.dryRun, false);
    eq('T3b reverted 3', real.reverted.length, 3);
    eq('T3b case_trustee restored', db._T.cases['12345'].case_trustee, 'Old Trustee');
    const createdEv = Object.values(db._T.events)[0];
    eq('T3b created event Canceled', createdEv.event_status, 'Canceled');
    eq('T3b appt cancelAppt called once', apptStub._calls.cancelAppt.length, 1);
    const ca = apptStub._calls.cancelAppt[0];
    eq('T3b appt cancel SILENT (sms=false,email=false)', [ca.sms, ca.email], [false, false]);
    eq('T3b appt status Canceled', db._T.appts['9001'].appt_status, 'Canceled');
    eq('T3b all rows stamped undone', cl.filter(r => r.undone_at != null && r.undone_by === 22).length, 3);

    // idempotency: re-revert finds nothing (undone_at set)
    const again = await revertCourtActions(db, { messageId: MID, dryRun: false, actingUserId: 22 });
    eq('T3b re-revert is a no-op', [again.reverted.length, again.skipped.length], [0, 0]);
  }

  // ───────────────────────────────────────────────────────────────────────
  // T3c — modified-since guard SKIPS a case row changed between execute & revert
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nT3c — modified-since guard skips externally-changed case col');
  {
    const MID = 'revtest-2@x';
    const db = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13', case_trustee: 'Orig' } },
      events: {}, appts: {}, case_relate: [{ contact_id: 555, contact_name: 'Jane' }],
    });
    const subject = 'Meeting of Creditors Ch 13 26-42040-mar';
    const body = 'Trustee: Changed Trustee here.';
    const payload = {
      message_id: MID, classification: 'meeting_ch13', case_number: '26-42040-mar',
      actions: [{ type: 'update_case_fields', fields: { case_trustee: 'Changed Trustee' }, citations: { case_trustee: 'Changed Trustee' } }],
    };
    await executeCourtActions(db, { payload, subject, body, dryRun: false });
    eq('T3c trustee written', db._T.cases['12345'].case_trustee, 'Changed Trustee');
    // a human edits the column AFTER the executor wrote it
    db._T.cases['12345'].case_trustee = 'Human Override';
    const r = await revertCourtActions(db, { messageId: MID, dryRun: false, actingUserId: 1 });
    eq('T3c nothing reverted', r.reverted.length, 0);
    eq('T3c skipped modified_since', r.skipped.map(s => s.reason), ['modified_since']);
    eq('T3c human value untouched', db._T.cases['12345'].case_trustee, 'Human Override');
    eq('T3c row NOT stamped', db._T.ai_change_log.filter(x => x.undone_at != null).length, 0);
  }

  // ───────────────────────────────────────────────────────────────────────
  // T3d — D4: event UPDATE persists structured JSON; revert restores from it
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nT3d — event/update structured-JSON change row + revert restore');
  {
    const MID = 'revtest-3@x';
    const db = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13' } },
      events: { 8000: { event_id: 8000, event_type: 'confirmation_hearing', event_link_id: '26-42040', event_title: 'Confirmation', event_date: '2026-10-15', event_time: '10:00:00', event_all_day: 0, event_location: 'Room 1', event_status: 'Scheduled' } },
      appts: {}, case_relate: [{ contact_id: 555, contact_name: 'Jane' }],
    });
    const subject = 'Order Adjourning Hearing Ch 13 26-42040-mar';
    const body = 'Confirmation hearing rescheduled to 2026-11-20 at 13:30 in Room 2.';
    const payload = {
      message_id: MID, classification: 'adjourned', case_number: '26-42040-mar',
      actions: [{ type: 'update_event', fields: { event_type: 'confirmation_hearing', date: '2026-11-20', time: '13:30', location: 'Room 2' },
        citations: { date: '2026-11-20', time: '13:30', location: 'Room 2' } }],
    };
    await executeCourtActions(db, { payload, subject, body, dryRun: false });
    const upd = db._T.ai_change_log.find(r => r.entity_type === 'event' && r.field === 'update');
    upd ? ok('T3d event/update change row exists') : no('T3d no event/update row');
    const oldJson = JSON.parse(upd.old_value), newJson = JSON.parse(upd.new_value);
    eq('T3d old_value is structured JSON', oldJson, { date: '2026-10-15', time: '10:00', all_day: 0, location: 'Room 1' });
    eq('T3d new_value is structured JSON', newJson, { date: '2026-11-20', time: '13:30', all_day: 0, location: 'Room 2' });
    eq('T3d event row rescheduled', [db._T.events[8000].event_date, db._T.events[8000].event_location], ['2026-11-20', 'Room 2']);

    const r = await revertCourtActions(db, { messageId: MID, dryRun: false, actingUserId: 7 });
    eq('T3d reverted 1', r.reverted.length, 1);
    eq('T3d event restored to original', [db._T.events[8000].event_date, db._T.events[8000].event_time, db._T.events[8000].event_location], ['2026-10-15', '10:00', 'Room 1']);

    // modified-since: external edit then revert → skip
    const MID2 = 'revtest-4@x';
    const db2 = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13' } },
      events: { 8100: { event_id: 8100, event_type: 'confirmation_hearing', event_link_id: '26-42040', event_title: 'Confirmation', event_date: '2026-10-15', event_time: '10:00:00', event_all_day: 0, event_location: 'Room 1', event_status: 'Scheduled' } },
      appts: {}, case_relate: [{ contact_id: 555, contact_name: 'Jane' }],
    });
    await executeCourtActions(db2, { payload: { ...payload, message_id: MID2 }, subject, body, dryRun: false });
    db2._T.events[8100].event_location = 'Room 99'; // human moves it after the executor
    const r2 = await revertCourtActions(db2, { messageId: MID2, dryRun: false, actingUserId: 7 });
    eq('T3d modified-since skips event/update', r2.skipped.map(s => s.reason), ['modified_since']);
    eq('T3d human edit untouched', db2._T.events[8100].event_location, 'Room 99');
  }

  // ───────────────────────────────────────────────────────────────────────
  // T3e — cancelAppt THROWS mid-batch → skip that row, don't abort the batch
  // (appt killed by another path between the status SELECT and the cancel)
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nT3e — cancelAppt throw skips row, batch survives, row not stamped');
  {
    apptStub._calls.cancelAppt.length = 0;
    const MID = 'revtest-5@x';
    const db = makeDb({
      cases: { '12345': { case_id: '12345', case_number: '26-42040', case_number_full: '26-42040-mar', case_chapter: '13', case_trustee: 'Orig Trustee' } },
      events: {}, appts: {}, case_relate: [{ contact_id: 555, contact_name: 'Jane' }],
    });
    const subject = 'Meeting of Creditors Ch 13 26-42040-mar';
    const body = 'Trustee: New Trustee. 341 meeting on 2026-10-15 at 09:30.';
    const payload = {
      message_id: MID, classification: 'meeting_ch13', case_number: '26-42040-mar',
      actions: [
        { type: 'update_case_fields', fields: { case_trustee: 'New Trustee' }, citations: { case_trustee: 'New Trustee' } },
        { type: 'create_appointment', fields: { date: '2026-10-15', time: '09:30' }, citations: { date: '2026-10-15', time: '09:30' } },
      ],
    };
    await executeCourtActions(db, { payload, subject, body, dryRun: false });
    // appt 9001 still Scheduled at revert time → passes the status guard …
    db._T.appts['9001'] = { appt_status: 'Scheduled' };
    // … but cancelAppt throws (e.g. a concurrent path canceled it first)
    apptStub._setThrowOnNextCancel('appt already Canceled');

    let threw = false, r;
    try { r = await revertCourtActions(db, { messageId: MID, dryRun: false, actingUserId: 9 }); }
    catch (_) { threw = true; }

    eq('T3e revert returned (no throw)', threw, false);
    eq('T3e cancelAppt was attempted once', apptStub._calls.cancelAppt.length, 1);
    eq('T3e appt row skipped cancel_failed', r.skipped.map(s => s.reason), ['cancel_failed']);
    // the OTHER row (case trustee) still reverted despite the appt failure
    eq('T3e case row still reverted', r.reverted.map(x => `${x.entity_type}/${x.field}`), ['case/case_trustee']);
    eq('T3e case_trustee restored', db._T.cases['12345'].case_trustee, 'Orig Trustee');
    // failed appt row left UNSTAMPED → eligible for a later retry
    const apptRow = db._T.ai_change_log.find(x => x.entity_type === 'appt' && x.field === 'create');
    eq('T3e failed appt row NOT stamped', apptRow.undone_at, null);
  }

  console.log(`\n==== ${PASS} passed, ${FAIL} failed ====`);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });