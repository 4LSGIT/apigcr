// tests/helpers/u6aEventsDb.js
//
/**
 * Unified Events U6a — one in-memory `events` / `cases` stub for the four
 * U6a suites (supersede, consumers, resolution, sweep).
 *
 * It EXECUTES the real SQL eventService / the internal functions emit,
 * dispatching on statement shape and evaluating the WHERE it recognises in
 * JS, so a predicate that goes missing from a query fails a test here rather
 * than silently widening a live read. An unrecognised statement throws with
 * the flattened SQL, which is the drift signal.
 *
 * Rows default to the live column shape after U3/E0a: Scheduled, no pointer,
 * no resolution, all-day, unlinked.
 *
 *   const { makeEventsDb } = require('./helpers/u6aEventsDb');
 *   const db = makeEventsDb({ events: [...], cases: [...], tasks: {...} });
 *   db.events.get(42)      // live row object
 *   db.calls               // [{ sql, params }] in order
 *   db.count(/regex/)      // number of calls whose flattened SQL matches
 */

'use strict';

const nullEq = (a, b) => (a == null && b == null) ? true : String(a) === String(b);

function defaults(e) {
  return {
    event_type: null, kind: null, type_key: null,
    event_link_type: null, event_link_id: null,
    event_title: 'T', event_date: '2026-10-01', event_time: null, event_all_day: 1,
    event_length: null, event_location: null, event_link: null, event_note: null,
    event_status: 'Scheduled', event_resolution: null,
    event_gcal: null, event_calendar_id: null, event_with: null,
    event_created_by: null, event_updated_at: 'T0',
    superseded_by_event_id: null, supersede_reason: null,
    ...e,
  };
}

function makeEventsDb({ events = [], cases = [], tasks = {} } = {}) {
  const table = new Map(events.map((e) => [Number(e.event_id), defaults(e)]));
  const calls = [];
  const unmatched = [];
  let nextId = Math.max(500, ...[...table.keys()].map((k) => k + 1));

  const resolveCase = (linkType, linkId) => {
    if (linkType === 'case') return cases.find((c) => c.case_id === String(linkId)) || null;
    if (linkType === 'case_number') {
      return cases.find((c) => c.case_number === String(linkId) || c.case_number_full === String(linkId)) || null;
    }
    return null;
  };
  const resolvedCaseId = (row) =>
    row.event_link_type === 'case_number' ? (resolveCase('case_number', row.event_link_id) || {}).case_id || null : null;

  const rowsSorted = () => [...table.values()].sort((a, b) => a.event_id - b.event_id);

  /**
   * Consume link params off the front of `params` according to the emitted
   * link clause (the three forms findDuplicateEvent / _singletonPriors /
   * listEvents produce). Returns { pred, i }.
   */
  function linkPredicate(sql, params, i) {
    let pred;
    if (/event_link_id IN \(/i.test(sql)) {                               // case + dockets
      const inCount = (sql.match(/IN \(([^)]*)\)/i)[1].match(/\?/g) || []).length;
      const caseId  = params[i++];
      const dockets = params.slice(i, i + inCount); i += inCount;
      pred = (e) =>
        (e.event_link_type === 'case' && String(e.event_link_id) === String(caseId)) ||
        (e.event_link_type === 'case_number' && dockets.includes(e.event_link_id));
    } else if (/\(e\.event_link_type = 'case' AND e\.event_link_id = \?\)/i.test(sql)
            || /e\.event_link_type = 'case' AND e\.event_link_id = \?/i.test(sql)) {
      const caseId = params[i++];
      pred = (e) => e.event_link_type === 'case' && String(e.event_link_id) === String(caseId);
    } else if (/e\.event_link_type = \? AND e\.event_link_id = \?/i.test(sql)
            || /events\.event_link_type = \? AND events\.event_link_id = \?/i.test(sql)) {
      const lt = params[i++], lid = params[i++];
      pred = (e) => e.event_link_type === lt && String(e.event_link_id) === String(lid);
    } else if (/event_link_type IS NULL/i.test(sql)) {
      pred = (e) => e.event_link_type == null || e.event_link_id == null || String(e.event_link_id).trim() === '';
    } else if (/e\.event_link_type = \?/i.test(sql) || /events\.event_link_type = \?/i.test(sql)) {
      const lt = params[i++];
      pred = (e) => e.event_link_type === lt;
    } else {
      pred = () => true;
    }
    return { pred, i };
  }

  /** The U6a "hide live-superseded" predicate, as written in listEvents / get_events. */
  const hidesLiveSuperseded = (sql) =>
    /NOT \((?:e|events)\.superseded_by_event_id IS NOT NULL AND (?:e|events)\.event_status = 'Scheduled'\)/i.test(sql);

  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params: [...params] });

    // ── createEvent INSERT ─────────────────────────────────────────────────
    if (/^INSERT INTO events/i.test(flat)) {
      const id = nextId++;
      table.set(id, defaults({
        event_id: id,
        event_type: params[0], event_link_type: params[1], event_link_id: params[2],
        event_title: params[3], event_date: params[4], event_time: params[5],
        event_all_day: params[6], event_length: params[7], event_location: params[8],
        event_link: params[9], event_note: params[10],
        event_calendar_id: params[11], event_with: params[12], event_created_by: params[13],
        kind: params[14], type_key: params[15],
      }));
      return [{ insertId: id, affectedRows: 1 }];
    }

    // ── getEvent ───────────────────────────────────────────────────────────
    if (/joined_case_id/i.test(flat)) {
      const row = table.get(Number(params[0]));
      if (!row) return [[]];
      return [[{ ...row, resolved_case_id: resolvedCaseId(row),
                 link_type: row.event_link_type, link_id: row.event_link_id, link_label: null }]];
    }

    // ── supersedeEvent — the guarded pointer write ─────────────────────────
    //
    // U6c: a reschedule sets event_status='Rescheduled' in the SAME statement,
    // so the shape is one of two literals. The status clause is matched as an
    // OPTIONAL group rather than loosened to `.*`, so a future edit that drops
    // it (or writes it on the 'duplicate' path, where it does not belong)
    // falls through to `unmatched` and fails the suite.
    {
      const m = flat.match(/^UPDATE events SET superseded_by_event_id = \?, supersede_reason = \?,(?: (event_status = 'Rescheduled'),)? event_updated_at = event_updated_at WHERE event_id = \? AND superseded_by_event_id IS NULL$/i);
      if (m) {
        const row = table.get(Number(params[2]));
        if (!row || row.superseded_by_event_id != null) return [{ affectedRows: 0 }];
        row.superseded_by_event_id = Number(params[0]);
        row.supersede_reason = params[1];
        if (m[1]) row.event_status = 'Rescheduled';
        return [{ affectedRows: 1 }];
      }
    }

    // ── gcal id writes ─────────────────────────────────────────────────────
    if (/^UPDATE events SET event_gcal = NULL/i.test(flat)) {
      const row = table.get(Number(params[0]));
      if (row) row.event_gcal = null;
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^UPDATE events SET event_gcal = \?/i.test(flat)) {
      const row = table.get(Number(params[1]));
      if (row) row.event_gcal = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }

    // ── completeEvent / cancelEvent — status + resolution in one statement ─
    if (/^UPDATE events SET event_status = '(Completed|Canceled)', event_resolution = \? WHERE event_id = \?$/i.test(flat)) {
      const row = table.get(Number(params[1]));
      if (!row) return [{ affectedRows: 0 }];
      row.event_status = /Completed/.test(flat) ? 'Completed' : 'Canceled';
      row.event_resolution = params[0];
      row.event_updated_at = 'T1';
      return [{ affectedRows: 1 }];
    }

    // ── updateEvent — generic backticked column writer ─────────────────────
    if (/^UPDATE events SET `\w+` = \?/i.test(flat)) {
      const row = table.get(Number(params[params.length - 1]));
      if (!row) return [{ affectedRows: 0 }];
      const cols = [...flat.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]);
      cols.forEach((c, i) => { row[c] = params[i]; });
      row.event_updated_at = 'T1';
      return [{ affectedRows: 1 }];
    }

    // ── collaborators ──────────────────────────────────────────────────────
    if (/FROM users WHERE user = \? AND does_appts = 1/i.test(flat)) {
      return [Number(params[0]) === 1 ? [{ user: 1 }] : []];
    }
    if (/SELECT task_id FROM tasks/i.test(flat)) {
      const ids = tasks[String(params[0])] || [];
      return [ids.map((task_id) => ({ task_id }))];
    }
    if (/FROM cases WHERE case_id = \? LIMIT 1/i.test(flat)) {
      const c = resolveCase('case', params[0]);
      return [c ? [{ ...c }] : []];
    }
    if (/FROM cases WHERE case_number = \? OR case_number_full = \? LIMIT 1/i.test(flat)) {
      const c = resolveCase('case_number', params[0]);
      return [c ? [{ ...c }] : []];
    }
    if (/^SELECT case_number, case_number_full FROM cases WHERE case_id = \?$/i.test(flat)) {
      const c = resolveCase('case', params[0]);
      return [c ? [{ case_number: c.case_number, case_number_full: c.case_number_full }] : []];
    }
    if (/FROM case_relate cr/i.test(flat)) return [[]];

    // ── _singletonPriors ───────────────────────────────────────────────────
    if (/^SELECT e\.event_id, e\.event_date, e\.event_time, e\.event_all_day, e\.type_key FROM events e WHERE/i.test(flat)) {
      const { pred, i } = linkPredicate(flat, params, 0);
      const typeKey = params[i], excl = Number(params[i + 1]);
      const hasStatus = /e\.event_status = 'Scheduled'/.test(flat);
      const hasPtr    = /e\.superseded_by_event_id IS NULL/.test(flat);
      const rows = rowsSorted().filter((e) =>
        pred(e) && String(e.type_key) === String(typeKey) && e.event_id !== excl &&
        (!hasStatus || e.event_status === 'Scheduled') &&
        (!hasPtr || e.superseded_by_event_id == null));
      return [rows.map((e) => ({ event_id: e.event_id, event_date: e.event_date, event_time: e.event_time,
                                 event_all_day: e.event_all_day, type_key: e.type_key }))];
    }

    // ── findDuplicateEvent RULE 1 ──────────────────────────────────────────
    if (/^SELECT e\.\* FROM events e WHERE e\.event_link_type <=> \?/i.test(flat)) {
      const [lt, lid, ty, date, title] = params;
      const hasExcl = /event_id <> \?/i.test(flat);
      const excl = hasExcl ? Number(params[5]) : null;
      const hasPtr = /e\.superseded_by_event_id IS NULL/.test(flat);
      const rows = rowsSorted().filter((e) =>
        e.event_status === 'Scheduled' &&
        (!hasPtr || e.superseded_by_event_id == null) &&
        nullEq(e.event_link_type, lt) && nullEq(e.event_link_id, lid) &&
        nullEq(e.event_type, ty) && e.event_date === date && e.event_title === title &&
        (excl == null || e.event_id !== excl));
      return [rows.slice(0, 1).map((e) => ({ ...e }))];
    }
    // ── findDuplicateEvent SLOT set ────────────────────────────────────────
    if (/^SELECT e\.\* FROM events e WHERE .*e\.event_date = \? AND e\.event_time <=> \?/i.test(flat)) {
      const { pred, i } = linkPredicate(flat, params, 0);
      const date = params[i], time = params[i + 1];
      const hasExcl = /event_id <> \?/i.test(flat);
      const excl = hasExcl ? Number(params[i + 2]) : null;
      const hasPtr = /e\.superseded_by_event_id IS NULL/.test(flat);
      const rows = rowsSorted().filter((e) =>
        e.event_status === 'Scheduled' && (!hasPtr || e.superseded_by_event_id == null) &&
        pred(e) && e.event_date === date && nullEq(e.event_time, time) &&
        (excl == null || e.event_id !== excl));
      return [rows.map((e) => ({ ...e }))];
    }

    // ── getEventsForDigest (before listEvents: both join contacts co) ──────
    if (/^SELECT e\.event_id, e\.event_type, e\.kind, e\.type_key, e\.event_title/i.test(flat) && /ORDER BY e\.event_date ASC, e\.event_all_day DESC/i.test(flat)) {
      const hasPtr = /e\.superseded_by_event_id IS NULL/.test(flat);
      const [from, to] = params;
      const rows = rowsSorted().filter((e) =>
        e.event_status === 'Scheduled' && (!hasPtr || e.superseded_by_event_id == null) &&
        e.event_date >= from && e.event_date <= to);
      return [rows.map((e) => ({ ...e, resolved_case_id: resolvedCaseId(e) }))];
    }

    // ── listEvents COUNT + SELECT ──────────────────────────────────────────
    if (/^SELECT COUNT\(\*\) AS total FROM events e/i.test(flat) || /^SELECT e\.\*, co\.contact_name, COALESCE/i.test(flat)) {
      const rows = evalListWhere(flat, params);
      if (/^SELECT COUNT/i.test(flat)) return [[{ total: rows.length }]];
      const limit = Number(params[params.length - 2]), offset = Number(params[params.length - 1]);
      return [rows.slice(offset, offset + limit).map((e) => ({ ...e, resolved_case_id: resolvedCaseId(e), contact_name: null, case_number_display: null }))];
    }

    // ── get_events (internal function) ─────────────────────────────────────
    if (/FROM events LEFT JOIN contacts ON/i.test(flat)) {
      const rows = evalListWhere(flat, params.slice(0, -1), 'events');
      return [rows.slice(0, Number(params[params.length - 1])).map((e) => ({ ...e, contact_name: null, contact_id: null, case_number: null }))];
    }

    // ── sweep_calendar_missed population ───────────────────────────────────
    if (/e\.kind = 'deadline' AND e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL AND e\.event_date < \? AND e\.event_date >= \?/i.test(flat)) {
      const [today, since, limit] = params;
      const rows = rowsSorted()
        .filter((e) => e.kind === 'deadline' && e.event_status === 'Scheduled' &&
                       e.superseded_by_event_id == null && e.event_date < today && e.event_date >= since)
        .sort((a, b) => a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : a.event_id - b.event_id)
        .slice(0, Number(limit));
      return [rows.map((e) => ({ event_id: e.event_id, event_date: e.event_date, type_key: e.type_key,
                                 event_title: e.event_title, event_link_type: e.event_link_type, event_link_id: e.event_link_id }))];
    }

    unmatched.push(flat);
    throw new Error(`u6aEventsDb: unscripted SQL: ${flat.slice(0, 140)}`);
  };

  /**
   * Evaluate a listEvents / get_events WHERE. Supports the fragments those two
   * functions emit; params are consumed in SQL order. Unknown fragments throw.
   */
  function evalListWhere(flat, params, alias = 'e') {
    // The LAST top-level WHERE: listEvents' SELECT carries RESOLVED_CASE_SUBQUERY
    // (its own WHERE) in the select list, ahead of the real one.
    const wi = flat.lastIndexOf(' WHERE ');
    let where = wi === -1 ? '' : flat.slice(wi + 7);
    where = where.replace(/ ORDER BY .*$/i, '').replace(/ LIMIT .*$/i, '');
    const preds = [];
    // Fragments in order of appearance, each consuming its own params.
    const frags = [];
    const push = (re, consume, make) => {
      const hit = where.search(re);
      if (hit !== -1) frags.push({ at: hit, consume, make });
    };
    const a = alias.replace('.', '\\.');
    push(new RegExp(`NOT \\(${a}\\.superseded_by_event_id IS NOT NULL AND ${a}\\.event_status = 'Scheduled'\\)`), 0,
      () => (e) => !(e.superseded_by_event_id != null && e.event_status === 'Scheduled'));
    push(new RegExp(`${a}\\.event_link_id IN \\(`), 0, (_p, sql, i) => {
      const r = linkPredicate(sql, _p, i); return [r.pred, r.i];
    });
    if (!/event_link_id IN \(/.test(where)) {
      push(new RegExp(`${a}\\.event_link_type = 'case' AND ${a}\\.event_link_id = \\?`), 1, (p, _s, i) => {
        const id = p[i]; return [(e) => e.event_link_type === 'case' && String(e.event_link_id) === String(id), i + 1];
      });
      push(new RegExp(`${a}\\.event_link_type = \\? AND ${a}\\.event_link_id = \\?`), 2, (p, _s, i) => {
        const lt = p[i], lid = p[i + 1]; return [(e) => e.event_link_type === lt && String(e.event_link_id) === String(lid), i + 2];
      });
      push(new RegExp(`\\(${a}\\.event_link_type IS NULL`), 0,
        () => (e) => e.event_link_type == null || e.event_link_id == null || String(e.event_link_id).trim() === '');
      if (!new RegExp(`${a}\\.event_link_type = (\\?|'case') AND`).test(where)) {
        push(new RegExp(`${a}\\.event_link_type = \\?`), 1, (p, _s, i) => { const lt = p[i]; return [(e) => e.event_link_type === lt, i + 1]; });
      }
    }
    push(new RegExp(`${a}\\.event_status = \\?`), 1, (p, _s, i) => { const st = p[i]; return [(e) => e.event_status === st, i + 1]; });
    push(new RegExp(`${a}\\.event_type = \\?`), 1, (p, _s, i) => { const t = p[i]; return [(e) => e.event_type === t, i + 1]; });
    push(new RegExp(`${a}\\.event_date >= \\?`), 1, (p, _s, i) => { const d = p[i]; return [(e) => e.event_date >= d, i + 1]; });
    push(new RegExp(`${a}\\.event_date <= \\?`), 1, (p, _s, i) => { const d = p[i]; return [(e) => e.event_date <= d, i + 1]; });
    push(new RegExp(`${a}\\.event_title LIKE \\?`), 1, (p, _s, i) => { const q = String(p[i]).replace(/%/g, ''); return [(e) => String(e.event_title).includes(q), i + 1]; });
    frags.sort((x, y) => x.at - y.at);
    let i = 0;
    for (const f of frags) {
      const r = f.make(params, where, i);
      if (Array.isArray(r)) { preds.push(r[0]); i = r[1]; } else { preds.push(r); }
    }
    return rowsSorted().filter((e) => preds.every((p) => p(e)));
  }

  return {
    query, calls, unmatched, events: table, cases,
    count: (re) => calls.filter((c) => re.test(c.sql)).length,
    hidesLiveSuperseded,
  };
}

module.exports = { makeEventsDb };
