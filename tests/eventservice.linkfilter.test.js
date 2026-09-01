// tests/eventservice.linkfilter.test.js
//
// listEvents' `link_type: 'none'` pseudo-filter — "events attached to nothing".
//
// WHY IT EXISTS SEPARATELY FROM A NULL link_type
//
// `link_type: null` already means "do not filter on link at all". "Show me the
// rows with no link" is a different question, and before this there was no way
// to ask it: the Events tab could filter to case / contact / case_number rows
// and had no expression for the fourth state.
//
// WHY THE FOURTH STATE IS NOT A DEFECT
//
// An event is ALLOWED to be attached to nothing. The columns are nullable;
// _normalizeLink returns { type:null, id:null } for an absent link and throws
// only on a HALF link (a type with no id); listEvents does not filter it out;
// eventform renders an em-dash for it; calendar.html renders it without a case
// line. A firm-wide event — office closed, a CLE seminar, a staff meeting — is
// exactly this shape. The filter is for FINDING those, and equally for finding
// the rows where somebody meant to attach a case and didn't. It does not
// presume which kind a row is.
//
// WHY 'none' MUST NEVER REACH A WRITE
//
// It is a query, not a value. EVENT_LINK_TYPES deliberately excludes it, so
// _normalizeLink rejects it — asserted below, because the day someone "fixes"
// that omission is the day 'none' can be stored in the enum column.

'use strict';

const svc = require('../services/eventService');
const { scriptGuard } = require('./helpers/scriptGuard');

function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

// listEvents runs a count query and a page query; order/shape per the service.
const listScript = (rows = [], total = 0) => [[{ total }], rows];

/** The WHERE of whichever query carries one. */
const whereOf = (sql) => (sql.split(/\bWHERE\b/)[1] || '');

describe("listEvents link_type: 'none'", () => {
  test('filters to rows with no link, and binds no parameter for it', async () => {
    const db = stubDb(listScript());
    await svc.listEvents(db, { link_type: 'none', status: 'all' });
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(/event_link_type IS NULL/);
    expect(where).toMatch(/event_link_id IS NULL/);
    expect(where).toMatch(/TRIM\(e\.event_link_id\) = ''/);
    // Three literal conditions, nothing bound — 'none' is not a value.
    expect(db.calls[0].params).toEqual([]);
  });

  test("a half-written link counts as unlinked", async () => {
    // A type with a blank id points at nothing in particular. The TRIM branch
    // is what catches it; without it such a row would be invisible to both
    // this filter and the positive link_type filters.
    const db = stubDb(listScript());
    await svc.listEvents(db, { link_type: 'none', status: 'all' });
    expect(whereOf(db.calls[0].sql)).toMatch(/TRIM/);
  });

  test('composes with the other filters rather than replacing them', async () => {
    // The whole reason this is a filter on the existing list and not a list of
    // its own: "unlinked Hearings in September" has to be askable.
    const db = stubDb(listScript());
    await svc.listEvents(db, {
      link_type: 'none', status: 'Scheduled', type: 'Hearing',
      from: '2026-09-01', to: '2026-09-30', q: 'motion',
    });
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(/event_link_type IS NULL/);
    expect(where).toMatch(/e\.event_status = \?/);
    expect(where).toMatch(/e\.event_type = \?/);
    expect(where).toMatch(/e\.event_date >= \?/);
    expect(where).toMatch(/e\.event_date <= \?/);
    expect(where).toMatch(/e\.event_title LIKE \?/);
    expect(db.calls[0].params)
      .toEqual(['Scheduled', 'Hearing', '2026-09-01', '2026-09-30', '%motion%']);
  });

  test('link_type null still means NO link filter — the two are different questions', async () => {
    const db = stubDb(listScript());
    await svc.listEvents(db, { link_type: null, status: 'all' });
    expect(whereOf(db.calls[0].sql)).not.toMatch(/event_link_type/);
  });

  test('the positive link types are unaffected', async () => {
    const db = stubDb(listScript());
    await svc.listEvents(db, { link_type: 'contact', status: 'all' });
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(/e\.event_link_type = \?/);
    expect(where).not.toMatch(/IS NULL/);
    expect(db.calls[0].params).toEqual(['contact']);
  });

  test("'none' is NOT a writable link type", async () => {
    // A query, never a value. If this ever passes, 'none' can be stored in the
    // enum column and the filter starts matching rows it did not create.
    await expect(svc.createEvent({ query: async () => [[]] }, {
      event_type: 'Hearing', event_title: 'x', event_date: '2026-09-01',
      event_link_type: 'none', event_link_id: 'none',
    })).rejects.toThrow(/Invalid event_link_type/);
  });
});
