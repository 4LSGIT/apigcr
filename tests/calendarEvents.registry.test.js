// tests/calendarEvents.registry.test.js
//
/**
 * Unified Events U4 — the calendar.* field catalog cannot drift from the code.
 *
 * ── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
 *
 * EVENT_TYPES is not documentation. It is what the rule builder's field picker
 * offers, what /test and /replay validate against, and what a rule author
 * reads when deciding which path to filter. A `data.*` key that the envelope
 * carries but the catalog omits is invisible — the author never learns it is
 * there. A path the catalog lists but the envelope never produces is worse:
 * the author builds a filter on it, the filter matches nothing, and nothing
 * anywhere crashes to say why. Both failures are silent, which is why they get
 * a test rather than a convention.
 *
 * So: build one envelope PER SOURCE from the two services' own helpers, and
 * assert the path sets and the catalog are the same set. Not a subset in one
 * direction — the same set.
 *
 * The one asymmetry is deliberate and is asserted as such: `data.appt_type`
 * exists only on appt-sourced envelopes and `data.event_type` only on
 * event-sourced ones. Both carry the same string as `data.label`; they are the
 * one-release legacy dual-carry of v0.5 §7.1 rule 4. Everything else must be
 * produced by BOTH sources, or the "one shape, two tables" promise of A5 is
 * already broken.
 *
 * ── AND THE SECRETS CHECK ───────────────────────────────────────────────────
 *
 * domainEvents redacts by SUFFIX DENYLIST at envelope-build time. That is a
 * backstop; the primary guard is that both helpers project explicit key lists
 * instead of spreading rows. This file proves the backstop has nothing to do:
 * a real calendar envelope run through buildEnvelope comes out with every key
 * it went in with. If that ever stops being true, either a helper started
 * spreading a row or somebody published a column named like a credential —
 * and the assertion names which.
 *
 * Run:  npx jest tests/calendarEvents.registry.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const { EVENT_TYPES } = require('../services/triggerService');
const apptService     = require('../services/apptService');
const eventService    = require('../services/eventService');
const domainEvents    = require('../lib/domainEvents');

const CALENDAR_EVENTS = [
  'calendar.scheduled', 'calendar.rescheduled', 'calendar.cancelled', 'calendar.resolved',
];

/** A fully-populated appt row — every column either helper reads. */
const APPT_ROW = {
  appt_id: 3001,
  appt_client_id: 77,
  appt_case_id: 'ABCDEFGH',
  appt_type: '341 Meeting',
  type_key: 'meeting_341',
  appt_length: 30,
  appt_platform: 'Zoom',
  appt_date: '2026-10-01 14:00:00',
  appt_status: 'Scheduled',
  appt_with: 1,
  rescheduled_from_appt_id: 3000,
  // Not published, and the point of the projection:
  appt_manage_token: 'deadbeefdeadbeefdeadbeefdeadbeef',
  appt_note: 'note',
  appt_gcal: 'g',
};

const EVENT_ROW = {
  event_id: 4001,
  event_type: 'Confirmation Hearing',
  kind: 'hearing',
  type_key: 'confirmation_hearing',
  event_link_type: 'case_number',
  event_link_id: '26-48953',
  resolved_case_id: 'ABCDEFGH',
  event_title: 'Confirmation Hearing',
  event_date: '2026-10-01',
  event_time: '10:00:00',
  event_all_day: 0,
  event_length: 60,
  event_status: 'Scheduled',
  event_resolution: null,
  event_with: 2,
  superseded_by_event_id: null,
  event_note: 'note',
  event_gcal: 'g',
};

const apptEnv  = () => apptService._calendarEnvelope(APPT_ROW,  { source: 'manual', actingUserId: 1 });
const eventEnv = () => eventService._calendarEnvelope(EVENT_ROW, { source: 'court',  actingUserId: 1 });

const dataPaths = (env) => new Set(Object.keys(env.data).map((k) => `data.${k}`));
const catalogPaths = (name) =>
  new Set(EVENT_TYPES[name].fields.map((f) => f.path).filter((p) => p.startsWith('data.')));

const sorted = (s) => [...s].sort();

// ─────────────────────────────────────────────────────────────────────────────
describe('the four names exist and share one data shape', () => {
  test.each(CALENDAR_EVENTS)('%s is registered with a label and a description', (name) => {
    expect(EVENT_TYPES[name]).toBeDefined();
    expect(typeof EVENT_TYPES[name].label).toBe('string');
    expect(EVENT_TYPES[name].description.length).toBeGreaterThan(40);
    expect(Array.isArray(EVENT_TYPES[name].fields)).toBe(true);
  });

  test('all four publish the SAME data.* path set — one shape, four transitions', () => {
    const [first, ...rest] = CALENDAR_EVENTS;
    for (const name of rest) {
      expect(sorted(catalogPaths(name))).toEqual(sorted(catalogPaths(first)));
    }
  });

  test('every field entry is {path,label} with a non-empty label', () => {
    for (const name of CALENDAR_EVENTS) {
      for (const f of EVENT_TYPES[name].fields) {
        expect(Object.keys(f).sort()).toEqual(['label', 'path']);
        expect(String(f.label).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('no duplicate paths within an entry', () => {
    for (const name of CALENDAR_EVENTS) {
      const paths = EVENT_TYPES[name].fields.map((f) => f.path);
      expect(paths.length).toBe(new Set(paths).size);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('catalog ↔ envelope: the drift guard', () => {
  const produced = () => new Set([...dataPaths(apptEnv()), ...dataPaths(eventEnv())]);

  test.each(CALENDAR_EVENTS)(
    '%s publishes exactly the data.* keys the two helpers produce',
    (name) => {
      expect(sorted(catalogPaths(name))).toEqual(sorted(produced()));
    }
  );

  test('nothing an envelope carries is missing from the catalog', () => {
    const cat = catalogPaths('calendar.scheduled');
    const missing = [...produced()].filter((p) => !cat.has(p));
    expect(missing).toEqual([]);
  });

  test('nothing the catalog lists is absent from both envelopes', () => {
    const prod = produced();
    const phantom = [...catalogPaths('calendar.scheduled')].filter((p) => !prod.has(p));
    expect(phantom).toEqual([]);
  });

  test('the ONLY source-specific keys are the legacy dual-carry pair', () => {
    const a = dataPaths(apptEnv());
    const e = dataPaths(eventEnv());
    const apptOnly  = [...a].filter((p) => !e.has(p)).sort();
    const eventOnly = [...e].filter((p) => !a.has(p)).sort();
    expect(apptOnly).toEqual(['data.appt_type']);
    expect(eventOnly).toEqual(['data.event_type']);
  });

  test('the dual-carry keys mirror data.label exactly (that is what makes them legacy)', () => {
    const a = apptEnv().data;
    const e = eventEnv().data;
    expect(a.appt_type).toBe(a.label);
    expect(e.event_type).toBe(e.label);
  });

  test('both helpers agree on the top-level envelope keys', () => {
    expect(Object.keys(apptEnv()).sort()).toEqual(Object.keys(eventEnv()).sort());
    expect(Object.keys(apptEnv()).sort())
      .toEqual(['actor', 'case_id', 'contact_id', 'data', 'extra', 'source']);
  });

  test('the two sources agree on source/source_id and disagree on nothing structural', () => {
    expect(apptEnv().data.source).toBe('appt');
    expect(eventEnv().data.source).toBe('event');
    expect(apptEnv().data.source_id).toBe(3001);
    expect(eventEnv().data.source_id).toBe(4001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('secrets never reach the envelope', () => {
  test('buildEnvelope redacts NOTHING from a calendar payload — the projection got there first', () => {
    for (const [name, payload] of [['calendar.scheduled', apptEnv()], ['calendar.scheduled', eventEnv()]]) {
      const built = domainEvents.buildEnvelope(name, payload);
      expect(Object.keys(built.data).sort()).toEqual(Object.keys(payload.data).sort());
    }
  });

  test('the appt manage token is absent from the payload, not merely stripped from it', () => {
    const payload = apptEnv();
    expect(Object.keys(payload.data)).not.toContain('appt_manage_token');
    expect(JSON.stringify(payload)).not.toContain('deadbeef');
  });

  test('no published path is named like a credential', () => {
    const DENY = /(_token|_secret|_password|password|_pin|pin_hash|api_key|apikey|_ssn)$/i;
    for (const name of CALENDAR_EVENTS) {
      const bad = EVENT_TYPES[name].fields.map((f) => f.path).filter((p) => DENY.test(p));
      expect(bad).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the values a rule author will actually filter on', () => {
  test('appt envelope: keys, state and anchor', () => {
    const env = apptEnv();
    expect(env).toMatchObject({ contact_id: 77, case_id: 'ABCDEFGH', source: 'manual' });
    expect(env.data).toMatchObject({
      type_key: 'meeting_341', kind: 'meeting', label: '341 Meeting',
      starts_at: '2026-10-01 14:00', all_day: false, length_min: 30, with_user_id: 1,
      status: 'Scheduled', state: 'live', resolution: null,
      link_type: 'case', link_id: 'ABCDEFGH', docket: null,
      rescheduled_from_appt_id: 3000, superseded_by_event_id: null,
    });
  });

  test('event envelope: a docket-anchored hearing resolves its case', () => {
    const env = eventEnv();
    expect(env).toMatchObject({ contact_id: null, case_id: 'ABCDEFGH', source: 'court' });
    expect(env.data).toMatchObject({
      type_key: 'confirmation_hearing', kind: 'hearing', label: 'Confirmation Hearing',
      starts_at: '2026-10-01 10:00', all_day: false, length_min: 60, with_user_id: 2,
      status: 'Scheduled', state: 'live', resolution: null,
      link_type: 'case_number', link_id: '26-48953', docket: '26-48953',
      rescheduled_from_appt_id: null, superseded_by_event_id: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (U5) THE APPT CATALOG CARRIES THE REGISTRY KEY
//
// Every appt.* emit's `data` is a row that has a type_key column
// (createAppt / rescheduleAppt SELECT *; cancelAppt's fetchApptWithContact
// takes appts.*; markAttended / markNoShow / rescheduleLater name it
// explicitly), so publishing data.type_key is a statement of fact, not an
// aspiration — and the reverse test below proves the catalog is not inventing
// a path either.
// ─────────────────────────────────────────────────────────────────────────────

const APPT_EVENTS = [
  'appt.created', 'appt.attended', 'appt.no_show',
  'appt.cancelled', 'appt.rescheduled', 'appt.reschedule_later',
];

describe('appt.* catalog: data.type_key (U5)', () => {
  test.each(APPT_EVENTS)('%s publishes data.type_key', (name) => {
    const paths = EVENT_TYPES[name].fields.map((f) => f.path);
    expect(paths).toContain('data.type_key');
  });

  test('data.appt_type is still published, labelled as the legacy field', () => {
    for (const name of APPT_EVENTS) {
      const f = EVENT_TYPES[name].fields.find((x) => x.path === 'data.appt_type');
      expect(f).toBeDefined();
      // A rule author reading the picker must be told which one to prefer;
      // "free text" told them nothing about the alternative.
      expect(f.label).toMatch(/legacy/i);
      expect(f.label).toMatch(/type_key/);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// (U5) extra.* IS ONE-DIRECTIONAL: EVERY EMITTED KEY IS CATALOGUED
//
// U4 shipped a SET-EQUALITY guard on `data.*` — the two helpers project one
// shape, so the catalog can be held to it exactly. `extra.*` cannot work that
// way: it is per-EMIT-SITE, not per-helper, and several sites contribute
// disjoint key sets to one event name (calendar.cancelled gets
// {legacy_event, prior_status} from apptService, {via, prior_status} from
// updateEvent, and {via, prior_status, delete_gcal} from cancelEvent). No
// single envelope carries the union, so "the catalog lists nothing an envelope
// never produces" is not a checkable claim in that direction.
//
// The direction that IS checkable is the one that matters: an emitted key
// MISSING from the catalog is invisible — the field picker never offers it and
// the author never learns it exists. So: subset, extra → catalog.
//
// Two layers, because each catches what the other cannot:
//
//   SITE_EXTRAS   binds key → event name, so a key catalogued on the wrong
//                 event fails. Hand-maintained, and therefore able to fall
//                 behind the code.
//   the scan      reads the two services and extracts every `extra:` object
//                 literal inside a domainEvents.emit(...) call, so a key added
//                 at a NEW site fails even if nobody updates the table. It is
//                 coarser (it re-derives the same binding independently), and
//                 the two are asserted to agree.
//
// The scan is paren/brace-balanced and string-aware rather than a bare regex,
// because `extra: extra || {}` inside _calendarEnvelope and
// `extra: source ? { source } : null` inside insertApptLog are both `extra:`
// occurrences that are NOT domain-event extras — a loose match would drag
// `source` into the expected set and the guard would be asserting fiction.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

/** Every emit site's `extra` keys, by event name. Mirrors the code; the scan
 *  below is what stops it drifting. */
const SITE_EXTRAS = [
  { event: 'appt.created',          site: 'apptService.createAppt',        keys: ['hook_event', 'rescheduled_from'] },
  { event: 'appt.attended',         site: 'apptService.markAttended',      keys: ['prior_status'] },
  { event: 'appt.no_show',          site: 'apptService.markNoShow',        keys: ['prior_status', 'enrolled'] },
  { event: 'appt.cancelled',        site: 'apptService.cancelAppt',        keys: ['prior_status'] },
  { event: 'appt.rescheduled',      site: 'apptService.rescheduleAppt',    keys: ['new_appt_id', 'new_appt_date'] },
  { event: 'appt.reschedule_later', site: 'apptService.rescheduleLater',   keys: [] },
  { event: 'calendar.scheduled',    site: 'apptService.createAppt',        keys: ['legacy_event', 'hook_event', 'rescheduled_from'] },
  { event: 'calendar.resolved',     site: 'apptService.markAttended',      keys: ['legacy_event'] },
  { event: 'calendar.resolved',     site: 'apptService.markNoShow',        keys: ['legacy_event'] },
  { event: 'calendar.cancelled',    site: 'apptService.cancelAppt',        keys: ['legacy_event', 'prior_status'] },
  { event: 'calendar.rescheduled',  site: 'apptService.rescheduleAppt',    keys: ['legacy_event', 'new_source_id', 'new_starts_at', 'prior_starts_at'] },
  { event: 'calendar.scheduled',    site: 'eventService.createEvent',      keys: ['deduped', 'created_by_source'] },
  { event: 'calendar.scheduled',    site: 'eventService.updateEvent',      keys: ['via', 'reopened', 'prior_status'] },
  { event: 'calendar.rescheduled',  site: 'eventService.updateEvent',      keys: ['via', 'prior_starts_at', 'prior_all_day'] },
  { event: 'calendar.cancelled',    site: 'eventService.updateEvent',      keys: ['via', 'prior_status'] },
  { event: 'calendar.cancelled',    site: 'eventService.cancelEvent',      keys: ['via', 'prior_status', 'delete_gcal'] },
  { event: 'calendar.resolved',     site: 'eventService.updateEvent',      keys: ['via', 'prior_status'] },
  { event: 'calendar.resolved',     site: 'eventService.completeEvent',    keys: ['via', 'prior_status'] },
  // U6a — the supersession writer (v0.5 §3.4).
  { event: 'calendar.rescheduled',  site: 'eventService.supersedeEvent',   keys: ['via', 'superseded_by', 'reason', 'prior_starts_at', 'new_starts_at'] },
];

// ── the scanner ─────────────────────────────────────────────────────────────

/** Index just past a string/template/comment starting at i, or -1. */
function _skip(src, i) {
  const c = src[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n === -1 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i); return n === -1 ? src.length : n + 2; }
  return -1;
}

/** Text inside the balanced (...) whose '(' is at `open`. */
function _balanced(src, open) {
  let depth = 0, i = open;
  while (i < src.length) {
    const s = _skip(src, i);
    if (s !== -1) { i = s; continue; }
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    i++;
  }
  return null;
}

/** Top-level keys of the object literal whose '{' is at `open`. */
function _objectKeys(src, open) {
  const segs = []; let depth = 0, i = open, start = open + 1;
  while (i < src.length) {
    const s = _skip(src, i);
    if (s !== -1) { i = s; continue; }
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) { segs.push(src.slice(start, i)); break; }
      i++; continue;
    }
    if (c === ',' && depth === 1) { segs.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  const keys = [];
  for (const raw of segs) {
    const seg = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim();
    if (!seg || seg.startsWith('...')) continue;   // a spread contributes no literal key
    const m = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(?::|$)/.exec(seg);
    keys.push(m ? (m[1] || m[2] || m[3]) : `<UNPARSED:${seg.slice(0, 40)}>`);
  }
  return keys;
}

/** [{ file, event, keys }] for every domainEvents.emit(...) in `file`. */
function scanEmitExtras(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /domainEvents\s*\.\s*emit\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const args = _balanced(src, m.index + m[0].length - 1);
    if (args == null) continue;
    const nm = /['"]([A-Za-z0-9_.]+)['"]/.exec(args);
    if (!nm) continue;
    const ei = args.search(/\bextra\s*:/);
    let keys = [];
    if (ei !== -1) {
      const colon = ei + args.slice(ei).indexOf(':');
      const brace = args.indexOf('{', colon);
      // Only an object LITERAL counts. `extra: cond ? {…} : null` is not one,
      // and is flagged rather than silently read.
      keys = (brace !== -1 && /^\s*$/.test(args.slice(colon + 1, brace)))
        ? _objectKeys(args, brace)
        : ['<NON-LITERAL>'];
    }
    out.push({ file: path.basename(file), event: nm[1], keys });
  }
  return out;
}

const SCANNED = ['apptService.js', 'eventService.js']
  .flatMap((f) => scanEmitExtras(path.join(__dirname, '..', 'services', f)));

const extraPaths = (name) =>
  new Set((EVENT_TYPES[name] ? EVENT_TYPES[name].fields : [])
    .map((f) => f.path).filter((p) => p.startsWith('extra.')));

describe('extra.* one-directional guard (U4 open item 2, landed at U5)', () => {
  test.each(SITE_EXTRAS.map((s) => [`${s.event} @ ${s.site}`, s]))(
    '%s — every extra key it emits is in that event\'s catalog',
    (_label, s) => {
      const cat = extraPaths(s.event);
      const missing = s.keys.filter((k) => !cat.has(`extra.${k}`));
      expect(missing).toEqual([]);
    }
  );

  test('the SOURCE SCAN finds every emit site, and parses every extra literal', () => {
    // Guard against the scanner silently rotting into a no-op.
    expect(SCANNED.length).toBeGreaterThanOrEqual(19);   // U6a added supersedeEvent
    const unparsed = SCANNED.filter((r) => r.keys.some((k) => k.startsWith('<')));
    expect(unparsed).toEqual([]);
  });

  test('every extra key found IN THE CODE is catalogued on the event it is emitted with', () => {
    const missing = [];
    for (const r of SCANNED) {
      const cat = extraPaths(r.event);
      for (const k of r.keys) {
        if (!cat.has(`extra.${k}`)) missing.push(`${r.file}: ${r.event} emits extra.${k} — not in EVENT_TYPES`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the hand-written table has not fallen behind the code', () => {
    // Same claim, derived twice. If a new emit site appears and only the scan
    // sees it, this is what says so.
    const norm = (list) => [...new Set(list.map((r) => `${r.event}|${[...r.keys].sort().join(',')}`))].sort();
    expect(norm(SCANNED)).toEqual(norm(SITE_EXTRAS));
  });

  test('NOT set-equality: the catalog may list keys no SINGLE envelope carries', () => {
    // calendar.cancelled is the proof — three sites, three disjoint sets, one
    // catalog entry that is the union. Asserting equality per site would be
    // asserting that every site emits every key, which is false by design.
    const sites = SITE_EXTRAS.filter((s) => s.event === 'calendar.cancelled');
    expect(sites.length).toBeGreaterThan(1);
    const union = new Set(sites.flatMap((s) => s.keys));
    expect(union.size).toBeGreaterThan(Math.min(...sites.map((s) => s.keys.length)));
  });
});
