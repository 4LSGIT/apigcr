/**
 * Comms archive S2c-2 — the redo request's pure parts (services/commsArchiveRedo.js):
 * parseRequest (every 400) and whyNot (the eligibility rules). The DB paths are in
 * tests/commsTranscribe.mysql.test.js (RD*) and the route in tests/commsArchive.s4.mysql.test.js (R*).
 */

'use strict';

const { parseRequest, whyNot, MAX_IDS, MAX_LIMIT, DEFAULT_LIMIT } = require('../services/commsArchiveRedo');

describe('parseRequest', () => {
  const ok = (b) => parseRequest(b);
  const bad = (b, re) => expect(() => parseRequest(b)).toThrow(expect.objectContaining({ status: 400, expose: true, message: expect.stringMatching(re) }));

  test('the four selectors, the default limit, a dry run unless apply: true', () => {
    expect(ok({ mode: 'transcript', select: { quo_stereo_diarized: true } }))
      .toEqual({ mode: 'transcript', select: { kind: 'quo_stereo_diarized', value: true }, limit: DEFAULT_LIMIT, apply: false });
    expect(ok({ mode: 'transcript', select: { mono_min_speakers: 3 }, limit: 7, apply: true }))
      .toEqual({ mode: 'transcript', select: { kind: 'mono_min_speakers', value: 3 }, limit: 7, apply: true });
    expect(ok({ mode: 'summary', select: { summary_model: 'claude-haiku-5-5' } }).select).toEqual({ kind: 'summary_model', value: 'claude-haiku-5-5' });
    expect(ok({ mode: 'transcript', select: { capped: true } }).select).toEqual({ kind: 'capped', value: true });
    expect(ok({ mode: 'summary', select: { media_ids: [5, 5, 9] } }).select).toEqual({ kind: 'media_ids', value: [5, 9] });
    expect(ok({ mode: 'transcript', select: { media_ids: [1] }, limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
  });

  test('mode, select shape and selector/mode pairing are checked', () => {
    bad(null, /mode/);
    bad({ mode: 'both', select: { media_ids: [1] } }, /mode/);
    bad({ mode: 'transcript' }, /exactly one/);
    bad({ mode: 'transcript', select: {} }, /exactly one/);
    bad({ mode: 'transcript', select: [1] }, /exactly one/);
    bad({ mode: 'transcript', select: { media_ids: [1], mono_min_speakers: 3 } }, /exactly one/);
    bad({ mode: 'transcript', select: { everything: true } }, /unknown selector/);
    bad({ mode: 'summary', select: { quo_stereo_diarized: true } }, /transcript selector/);
    bad({ mode: 'summary', select: { mono_min_speakers: 3 } }, /transcript selector/);
    bad({ mode: 'summary', select: { capped: true } }, /transcript selector/);
    bad({ mode: 'transcript', select: { summary_model: 'claude-haiku-5-5' } }, /summary selector/);
  });

  test('selector values', () => {
    bad({ mode: 'transcript', select: { quo_stereo_diarized: 'yes' } }, /must be true/);
    for (const v of ['yes', 1, false]) bad({ mode: 'transcript', select: { capped: v } }, /capped must be true/);
    for (const v of [1, 51, 2.5, '3', null]) bad({ mode: 'transcript', select: { mono_min_speakers: v } }, /2–50/);
    for (const v of ['', 'Claude Haiku', 'x'.repeat(49), 5]) bad({ mode: 'summary', select: { summary_model: v } }, /model name/);
    for (const v of [[], [0], [-1], [1.5], ['7'], 'all', Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1)]) {
      bad({ mode: 'transcript', select: { media_ids: v } }, /media_ids/);
    }
    expect(ok({ mode: 'transcript', select: { media_ids: Array.from({ length: MAX_IDS }, (_, i) => i + 1) } }).select.value.length).toBe(MAX_IDS);
  });

  test('limit and apply', () => {
    for (const l of [0, MAX_LIMIT + 1, 1.5, '10']) bad({ mode: 'transcript', select: { media_ids: [1] }, limit: l }, /limit/);
    for (const a of ['yes', 1, 'true']) bad({ mode: 'transcript', select: { media_ids: [1] }, apply: a }, /apply/);
    expect(ok({ mode: 'transcript', select: { media_ids: [1] }, apply: false }).apply).toBe(false);
  });
});

describe('whyNot', () => {
  const row = (o = {}) => ({ state: 'transcribed', m_state: 'archived', restricted: 0, no_transcribe: 0, is_eval: 0, s_state: null, ...o });
  const T = { mode: 'transcript', explicit: false };

  test('an ordinary transcribed / summarized row is eligible for a transcript redo', () => {
    expect(whyNot(row(), T)).toBeNull();
    expect(whyNot(row({ state: 'summarized', s_state: 'done' }), T)).toBeNull();
  });

  test('each rule, in order', () => {
    for (const st of ['pending', 'transcribing', 'skipped', 'failed', 'purged']) expect(whyNot(row({ state: st }), T)).toBe('state');
    expect(whyNot(row({ m_state: 'purged' }), T)).toBe('not_archived');
    expect(whyNot(row({ restricted: 1 }), T)).toBe('restricted');
    expect(whyNot(row({ no_transcribe: 1 }), T)).toBe('no_transcribe');
    expect(whyNot(row({ is_eval: 1 }), T)).toBe('eval');
    expect(whyNot(row({ s_state: 'calling' }), T)).toBe('busy');
    expect(whyNot(row({ state: 'purged', restricted: 1 }), T)).toBe('state');
  });

  test('a NAMED evaluation item is taken; a busy one never', () => {
    expect(whyNot(row({ is_eval: 1 }), { mode: 'transcript', explicit: true })).toBeNull();
    expect(whyNot(row({ is_eval: 1, s_state: 'calling' }), { mode: 'transcript', explicit: true })).toBe('busy');
  });

  test('a summary redo needs a summarized row', () => {
    const S = { mode: 'summary', explicit: true };
    expect(whyNot(row({ state: 'summarized' }), S)).toBeNull();
    expect(whyNot(row({ state: 'transcribed' }), S)).toBe('state');
  });
});
