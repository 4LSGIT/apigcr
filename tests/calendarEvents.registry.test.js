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
