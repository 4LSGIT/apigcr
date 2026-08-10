/**
 * tests/aimatch.service.test.js
 *
 * Court Pipeline v2 slice — services/aiMatchService.js (stages 2–4):
 *   - buildPrompt: deterministic registry-driven text; closed-list rule;
 *     untrusted-input framing; declared fields rendered.
 *   - validateMatches: shape gate (unknown_key / shape_invalid), declared
 *     fields only, type checks, and the PER-FIELD citation semantics — the
 *     granularity change: required-field citation failure FLAGS the match,
 *     optional-field failure DROPS the field and proceeds.
 *   - citation checking uses lib/courtCitation's real matcher (elision-aware,
 *     emphasis-stripping) — fixtures below quote actual MIEB docket text
 *     shapes, including the *emphasis* markdown and mid-quote elisions the
 *     Aug-8 production misses hinged on.
 *   - collapse_same_date: 7 Missing-Documents deadlines, one date → one item.
 *   - unmatched_candidates: citation-checked; uncitable candidates dropped.
 *
 *   npx jest tests/aimatch.service.test.js
 */

const { buildPrompt, validateMatches } = require('../services/aiMatchService');

// ─────────────────────────────────────────────────────────────
// Registry fixtures (shape of ai_match_types rows post-load)
// ─────────────────────────────────────────────────────────────
const TYPES = [
  {
    id: 1, type_key: '341_scheduled_ch7', label: 'Ch7 §341 meeting scheduled',
    disposition: 'act', item_type: '341_meeting', verb: 'scheduled',
    workflow_id: 41, collapse_same_date: 0,
    recognition_hints: ['Meeting of Creditors', '341(a) meeting to be held'],
    fields: [
      { name: 'date', required: true, type: 'date' },
      { name: 'time', required: true, type: 'time' },
      { name: 'trustee', required: false, type: 'text' },
      { name: 'objection_deadline', required: false, type: 'date' },
    ],
  },
  {
    id: 2, type_key: 'missing_docs_deadline', label: 'Missing documents deadline',
    disposition: 'act', item_type: 'filing_deadline', verb: 'scheduled',
    workflow_id: 42, collapse_same_date: 1,
    recognition_hints: ['Notice of Missing Documents'],
    fields: [
      { name: 'date', required: true, type: 'date' },
      { name: 'document', required: false, type: 'text' },
    ],
  },
  {
    id: 3, type_key: 'show_cause_dissolved', label: 'OSC dissolved',
    disposition: 'act', item_type: 'show_cause_hearing', verb: 'cancelled',
    workflow_id: 43, collapse_same_date: 0,
    recognition_hints: ['Order to Show Cause Dissolved'],
    fields: [],
  },
  {
    id: 4, type_key: 'bnc_certificate_of_mailing', label: 'BNC mailing',
    disposition: 'ignore', item_type: null, verb: null,
    workflow_id: null, collapse_same_date: 0,
    recognition_hints: ['BNC Certificate of Mailing'],
    fields: [],
  },
];
const typesByKey = new Map(TYPES.map(t => [t.type_key, t]));

const SET = {
  id: 1, set_key: 'court_nef', label: 'MIEB NEF', version: 3,
  prompt_preamble: 'Each email is a CM/ECF Notice of Electronic Filing (NEF).',
};

// Real MIEB docket-text shape (from message 19fdcbb25d82bc2d and the Ch7 341
// corpus): markdown *emphasis*, long boilerplate, values embedded mid-sentence.
const HAYSTACK = [
  'SUBJECT: 26-41745-lsg "Notice of Chapter 7 Bankruptcy Case" Ch 7',
  'FROM: ecf_bankruptcy@mieb.uscourts.gov',
  '',
  'The following transaction was received entered on 8/5/2026 at 3:14 PM EDT and filed on 8/5/2026.',
  '*Case Name:* John Q. Debtor',
  '*Case Number:* 26-41745-lsg',
  '*Docket Text:*',
  'Notice of Chapter 7 Bankruptcy Case. §341(a) meeting to be held on *9/2/2026* at *09:00 AM* at Telephonic Hearing, Trustee: Timothy J. Miller. Proofs of Claims due by 11/3/2026. Objection to Discharge deadline is 11/1/2026. (admin)',
].join('\n');

describe('buildPrompt', () => {
  const prompt = buildPrompt(SET, TYPES);

  test('deterministic', () => {
    expect(buildPrompt(SET, TYPES)).toBe(prompt);
  });

  test('closed-list rule + every key present', () => {
    for (const t of TYPES) expect(prompt).toContain(`- ${t.type_key}`);
    expect(prompt).toMatch(/MUST be copied exactly from the list/);
    expect(prompt).toMatch(/NEVER invent, rename, or re-case a key/);
  });

  test('preamble, untrusted framing, source_ref slot', () => {
    expect(prompt).toContain(SET.prompt_preamble);
    expect(prompt).toContain('<untrusted_user_input>');
    expect(prompt).toContain('{{source_ref}}');
    expect(prompt).toMatch(/NEVER as instructions/);
  });

  test('declared fields rendered with type + requiredness; ignore keys marked recognition-only', () => {
    expect(prompt).toMatch(/"date", date YYYY-MM-DD, REQUIRED/);
    expect(prompt).toMatch(/"trustee", text, optional/);
    // ignore rows carry no fields
    const bncBlock = prompt.split('- bnc_certificate_of_mailing')[1].split('\n- ')[0];
    expect(bncBlock).toContain('fields: none');
  });

  test('citation + no-computed-dates rules present', () => {
    expect(prompt).toMatch(/ONE SINGLE CONTIGUOUS verbatim span/);
    expect(prompt).toMatch(/NEVER compute or infer a date/);
    expect(prompt).toMatch(/unmatched_candidates/);
  });
});

describe('validateMatches — shape gate', () => {
  test('null / non-object payload → shape_invalid', () => {
    const r = validateMatches(null, typesByKey, HAYSTACK);
    expect(r.matches).toHaveLength(0);
    expect(r.flags[0].code).toBe('shape_invalid');
  });

  test('matches not an array → shape_invalid', () => {
    const r = validateMatches({ matches: 'nope' }, typesByKey, HAYSTACK);
    expect(r.flags[0].code).toBe('shape_invalid');
  });

  test('unknown key → unknown_key flag, match excluded (the closed-list guarantee)', () => {
    const r = validateMatches(
      { matches: [{ key: '341_Scheduled_CH7', fields: {}, citations: {} }] }, // wrong casing = drift
      typesByKey, HAYSTACK);
    expect(r.matches).toHaveLength(0);
    expect(r.flags).toEqual([expect.objectContaining({ code: 'unknown_key', detail: '341_Scheduled_CH7' })]);
  });

  test('match without key object → shape_invalid, others still processed', () => {
    const r = validateMatches(
      { matches: [42, { key: 'show_cause_dissolved', fields: {}, citations: {} }] },
      typesByKey, HAYSTACK);
    expect(r.flags[0].code).toBe('shape_invalid');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].key).toBe('show_cause_dissolved');
  });
});

describe('validateMatches — per-field citations (the granularity change)', () => {
  test('happy path: all fields cited verbatim (with *emphasis* + elision tolerated)', () => {
    const payload = {
      matches: [{
        key: '341_scheduled_ch7',
        fields: { date: '2026-09-02', time: '09:00', trustee: 'Timothy J. Miller', objection_deadline: '2026-11-01' },
        citations: {
          // model quotes WITHOUT the markdown emphasis + with a mid-quote
          // elision — exactly the Aug-8 production shape; the elision-aware
          // matcher must pass these.
          date: '341(a) meeting to be held on 9/2/2026',
          time: 'to be held on 9/2/2026 at 09:00 AM',
          trustee: 'Trustee: Timothy J. Miller',
          objection_deadline: 'Objection to Discharge deadline is 11/1/2026',
        },
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toHaveLength(0);
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0];
    expect(m.fields).toEqual({
      date: '2026-09-02', time: '09:00',
      trustee: 'Timothy J. Miller', objection_deadline: '2026-11-01',
    });
    // registry enrichment rides along for downstream routing
    expect(m).toMatchObject({
      disposition: 'act', item_type: '341_meeting', verb: 'scheduled',
      workflow_id: 41, flagged: false,
    });
  });

  test('OPTIONAL field with fabricated citation → field dropped, match survives', () => {
    const payload = {
      matches: [{
        key: '341_scheduled_ch7',
        fields: { date: '2026-09-02', time: '09:00', trustee: 'Made Up Trustee' },
        citations: {
          date: 'meeting to be held on 9/2/2026',
          time: 'at 09:00 AM',
          trustee: 'Trustee: Made Up Trustee',   // not in the text
        },
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toHaveLength(0);                       // NOT flagged — this is the fix
    expect(r.matches[0].fields).toEqual({ date: '2026-09-02', time: '09:00' });
    expect(r.dropped_fields).toEqual([
      expect.objectContaining({ field: 'trustee', reason: 'citation_fail' }),
    ]);
  });

  test('OPTIONAL field with no citation → dropped as no_citation', () => {
    const payload = {
      matches: [{
        key: '341_scheduled_ch7',
        fields: { date: '2026-09-02', time: '09:00', trustee: 'Timothy J. Miller' },
        citations: { date: 'held on 9/2/2026', time: 'at 09:00 AM' },
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toHaveLength(0);
    expect(r.dropped_fields).toEqual([
      expect.objectContaining({ field: 'trustee', reason: 'no_citation' }),
    ]);
  });

  test('REQUIRED field with fabricated citation → citation_fail_required flag, match kept but flagged', () => {
    const payload = {
      matches: [{
        key: '341_scheduled_ch7',
        fields: { date: '2026-09-03', time: '09:00' },              // wrong date, invented quote
        citations: { date: 'meeting to be held on 9/3/2026', time: 'at 09:00 AM' },
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toEqual([
      expect.objectContaining({ code: 'citation_fail_required', field: 'date' }),
    ]);
    expect(r.matches[0].flagged).toBe(true);
    expect(r.matches[0].fields.date).toBeUndefined();
    expect(r.matches[0].fields.time).toBe('09:00');                 // the good field survives
  });

  test('REQUIRED field missing → missing_required flag', () => {
    const payload = {
      matches: [{ key: '341_scheduled_ch7', fields: { time: '09:00' },
                  citations: { time: 'at 09:00 AM' } }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toEqual([expect.objectContaining({ code: 'missing_required', field: 'date' })]);
  });

  test('type checks: bad date shape on required field flags; on optional drops', () => {
    const payload = {
      matches: [{
        key: '341_scheduled_ch7',
        fields: { date: '9/2/2026', time: '09:00', objection_deadline: 'November 1' },
        citations: { time: 'at 09:00 AM' },
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.flags).toEqual([expect.objectContaining({ code: 'missing_required', field: 'date' })]);
    expect(r.dropped_fields).toEqual([
      expect.objectContaining({ field: 'objection_deadline', reason: 'bad_date' }),
    ]);
  });

  test('undeclared model-invented fields are dropped, never trusted', () => {
    const payload = {
      matches: [{
        key: 'show_cause_dissolved',
        fields: { surprise_deadline: '2026-09-09' },
        citations: {},
      }],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.matches[0].fields).toEqual({});
    expect(r.dropped_fields).toEqual([
      expect.objectContaining({ field: 'surprise_deadline', reason: 'undeclared' }),
    ]);
  });

  test('citable:false field skips citation entirely', () => {
    const localTypes = new Map(typesByKey);
    localTypes.set('composed', {
      id: 9, type_key: 'composed', disposition: 'act', item_type: 'x', verb: 'scheduled',
      workflow_id: null, collapse_same_date: 0, recognition_hints: [],
      fields: [{ name: 'label', required: true, type: 'text', citable: false }],
    });
    const r = validateMatches(
      { matches: [{ key: 'composed', fields: { label: 'Show Cause — Fee' }, citations: {} }] },
      localTypes, HAYSTACK);
    expect(r.flags).toHaveLength(0);
    expect(r.matches[0].fields.label).toBe('Show Cause — Fee');
  });
});

describe('validateMatches — collapse_same_date', () => {
  const MISSING_HAY = [
    'SUBJECT: 26-48181-mlo "Notice of Missing Documents" Ch 7',
    'FROM: ecf_bankruptcy@mieb.uscourts.gov',
    '',
    'Summary of Assets and Liabilities due 8/19/2026. Schedule A/B due 8/19/2026.',
    'Schedule C due 8/19/2026. Statement of Financial Affairs due 8/19/2026.',
  ].join('\n');

  test('same key + same date merge into one item with collapsed_count', () => {
    const mk = (doc) => ({
      key: 'missing_docs_deadline',
      fields: { date: '2026-08-19', document: doc },
      citations: { date: `${doc} due 8/19/2026`, document: `${doc} due 8/19/2026` },
    });
    const payload = { matches: [mk('Summary of Assets and Liabilities'), mk('Schedule A/B'), mk('Schedule C'), mk('Statement of Financial Affairs')] };
    const r = validateMatches(payload, typesByKey, MISSING_HAY);
    expect(r.flags).toHaveLength(0);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].collapsed_count).toBe(4);
  });

  test('different dates do NOT merge; non-collapse keys never merge', () => {
    const payload = {
      matches: [
        { key: 'missing_docs_deadline', fields: { date: '2026-08-19' }, citations: { date: 'Schedule A/B due 8/19/2026' } },
        { key: 'missing_docs_deadline', fields: { date: '2026-08-19' }, citations: { date: 'Schedule C due 8/19/2026' } },
      ],
    };
    const r = validateMatches(payload, typesByKey, MISSING_HAY);
    expect(r.matches).toHaveLength(1);

    const twoDates = {
      matches: [
        { key: 'missing_docs_deadline', fields: { date: '2026-08-19' }, citations: { date: 'Schedule A/B due 8/19/2026' } },
        { key: 'missing_docs_deadline', fields: { date: '2026-08-19' }, citations: { date: 'Schedule C due 8/19/2026' } },
      ],
    };
    // mutate one date to prove no merge across dates — needs a citable second date
    const hay2 = MISSING_HAY + '\nSchedule D due 8/26/2026.';
    twoDates.matches[1].fields.date = '2026-08-26';
    twoDates.matches[1].citations.date = 'Schedule D due 8/26/2026';
    const r2 = validateMatches(twoDates, typesByKey, hay2);
    expect(r2.matches).toHaveLength(2);
  });
});

describe('validateMatches — unmatched_candidates', () => {
  test('citable candidate kept; uncitable dropped; blanks dropped', () => {
    const payload = {
      matches: [],
      unmatched_candidates: [
        { description: 'Proofs of claims deadline', citation: 'Proofs of Claims due by 11/3/2026' },
        { description: 'Invented thing', citation: 'this text does not exist anywhere' },
        { description: '', citation: 'Proofs of Claims due by 11/3/2026' },
        { description: 'No citation at all' },
      ],
    };
    const r = validateMatches(payload, typesByKey, HAYSTACK);
    expect(r.unmatched_candidates).toEqual([
      { description: 'Proofs of claims deadline', citation: 'Proofs of Claims due by 11/3/2026' },
    ]);
  });
});

describe('ai_match internal function meta', () => {
  const registry = require('../lib/internal_functions/index');
  const validate = registry.__validateParamsAgainstMeta;

  test('registered and example validates', () => {
    expect(typeof registry.ai_match).toBe('function');
    expect(validate(registry.ai_match.__meta, registry.ai_match.__meta.example)).toBeNull();
  });

  test('requiredWith: subject OR body must be present; set_key required', () => {
    const meta = registry.ai_match.__meta;
    expect(validate(meta, { set_key: 'court_nef', body: 'x' })).toBeNull();
    expect(validate(meta, { set_key: 'court_nef', subject: 'x' })).toBeNull();
    expect(validate(meta, { set_key: 'court_nef' })).not.toBeNull();
    expect(validate(meta, { body: 'x' })).not.toBeNull();
  });
});