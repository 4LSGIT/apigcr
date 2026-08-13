/**
 * tests/internal_functions.meta.test.js
 *
 * Tests for the __meta registry and validator on lib/internal_functions.js.
 *
 * Two layers:
 *   1. Shape — every function's meta declaration is well-formed (param names,
 *      types in the allowed set, required fields documented, group references
 *      point at real params).
 *   2. Behavior — fixed input/output table that captures the validator's
 *      contract. New cases get added here when adding a new function or
 *      changing an existing one.
 *
 * Coverage is DERIVED from the registry — there is no hardcoded function-name
 * list to go stale. Functions that intentionally carry no __meta are exempted
 * by name in META_EXEMPT below, and a guard test ensures the exemption list
 * itself can't go stale (every entry must exist and must genuinely lack meta).
 *
 * Run:
 *   npx jest tests/internal_functions.meta.test.js
 */
/*
# jest is a COMMITTED devDependency now (package.json: "jest": "^30.4.2") — it
# is no longer installed/uninstalled around each run. `npm install` is enough.
#
# credentialCrypto (pulled in via internal_functions → emailService → smtp)
# throws at require time without this env var. Any random key works here —
# tests never decrypt real data. Use `export` (inline VAR=… \ continuation
# breaks easily when pasted into interactive shells).
export CREDENTIALS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
npx jest tests/internal_functions.meta.test.js

# Whole jest suite. No ignore flags needed: jest's default testMatch only picks
# up *.test.js / *.spec.js, and this repo names its NON-jest files with a
# test- / test_ prefix (test-oauthService.js is node:test; test-cron.js,
# test-credential-crypto.js, test-timing-extensions.js and test_classifier.js
# are standalone scripts). Keep that convention when adding files here.
npx jest

# The node:test file runs separately:
node --test tests/test-oauthService.js
*/
const internalFunctions = require('../lib/internal_functions');

const ALLOWED_TYPES = new Set([
  'string', 'placeholder_string', 'number', 'integer', 'boolean',
  'enum', 'iso_datetime', 'duration', 'object', 'array',
]);

const ALLOWED_WIDGETS = new Set(['phone_line', 'phone_line_mms', 'email_from']);

// Functions that intentionally carry NO __meta. Each entry must have a
// comment at its definition in lib/internal_functions/ explaining why.
// Currently empty: court_extract (the former lone exception) now carries a
// minimal uiHidden meta so the editors can filter it from pickers via
// metadata instead of a hardcoded exemption. The mechanism (and its guard
// test below) stays so future exceptions get the same stale-proofing.
const META_EXEMPT = new Set([]);

describe('internal_functions __meta registry — shape', () => {
  const allMeta = internalFunctions.__getAllMeta();

  test('every callable function (excluding __ helpers and documented exemptions) has __meta', () => {
    const callable = Object.keys(internalFunctions).filter(
      k => typeof internalFunctions[k] === 'function' && !k.startsWith('__')
    );
    const missing = callable.filter(k => !internalFunctions[k].__meta && !META_EXEMPT.has(k));
    expect(missing).toEqual([]);
  });

  test('META_EXEMPT entries are real functions that genuinely lack meta', () => {
    for (const name of META_EXEMPT) {
      expect(typeof internalFunctions[name]).toBe('function');   // stale name → fail
      expect(internalFunctions[name].__meta).toBeUndefined();    // meta added → remove exemption
    }
  });

  test('registry and callable set agree (no orphan metas)', () => {
    // Every key __getAllMeta returns must be a callable, non-__ function.
    for (const name of Object.keys(allMeta)) {
      expect(name.startsWith('__')).toBe(false);
      expect(typeof internalFunctions[name]).toBe('function');
    }
  });

  test.each(Object.entries(allMeta))(
    '%s has well-formed meta',
    (fnName, meta) => {
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(0);
      expect(Array.isArray(meta.params)).toBe(true);

      const paramNames = new Set();
      for (const p of meta.params) {
        // Required fields on every spec
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
        expect(paramNames.has(p.name)).toBe(false); // no duplicates
        paramNames.add(p.name);

        expect(ALLOWED_TYPES.has(p.type)).toBe(true);
        expect(typeof p.required).toBe('boolean');

        // Optional fields, when present, must be the right shape
        if (p.widget !== undefined) expect(ALLOWED_WIDGETS.has(p.widget)).toBe(true);
        if (p.enum !== undefined) {
          expect(Array.isArray(p.enum)).toBe(true);
          expect(p.enum.length).toBeGreaterThan(0);
          expect(p.type).toBe('enum');
        }
        if (p.type === 'enum') {
          expect(Array.isArray(p.enum)).toBe(true);
        }
        if (p.min !== undefined) expect(typeof p.min).toBe('number');
        if (p.max !== undefined) expect(typeof p.max).toBe('number');
        if (p.placeholderAllowed !== undefined) expect(typeof p.placeholderAllowed).toBe('boolean');
        if (p.multiline !== undefined) expect(typeof p.multiline).toBe('boolean');
        if (p.nullishSkipsBlock !== undefined) expect(typeof p.nullishSkipsBlock).toBe('boolean');
        // Save-time edit-lock slice — per-spec widenings of the `string` case.
        // Both are only meaningful on a string-typed param; asserting that here
        // stops them being sprinkled onto enum/integer specs where the string
        // case never runs and they would silently do nothing.
        if (p.objectAllowed !== undefined) {
          expect(typeof p.objectAllowed).toBe('boolean');
          expect(['string', 'placeholder_string']).toContain(p.type);
        }
        if (p.booleanAllowed !== undefined) {
          expect(typeof p.booleanAllowed).toBe('boolean');
          expect(['string', 'placeholder_string']).toContain(p.type);
        }
        // strictString restores the "string only" contract for params whose
        // runtime hard-rejects a non-string. Meaningless on a non-string type,
        // and it must never co-occur with objectAllowed/booleanAllowed (they
        // pull in opposite directions).
        if (p.strictString !== undefined) {
          expect(typeof p.strictString).toBe('boolean');
          expect(['string', 'placeholder_string']).toContain(p.type);
          if (p.strictString) {
            expect(p.objectAllowed).not.toBe(true);
            expect(p.booleanAllowed).not.toBe(true);
          }
        }

        // description, when present, must be a string
        if (p.description !== undefined) expect(typeof p.description).toBe('string');
      }

      // Group references must point at real params
      for (const group of meta.exclusiveOneOf || []) {
        for (const name of group) expect(paramNames.has(name)).toBe(true);
      }
      for (const group of meta.requiredWith || []) {
        for (const name of group) expect(paramNames.has(name)).toBe(true);
      }

      // Mode groups, if present on any param, should partition cleanly
      const modesByName = new Map();
      for (const p of meta.params) {
        if (p.modeGroup) modesByName.set(p.name, p.modeGroup);
      }
      // Every mode group string is a non-empty string
      for (const m of modesByName.values()) {
        expect(typeof m).toBe('string');
        expect(m.length).toBeGreaterThan(0);
      }
    }
  );
});

describe('validateParamsAgainstMeta — behavior fixtures', () => {
  const meta = internalFunctions.__getAllMeta();
  const v = internalFunctions.__validateParamsAgainstMeta;

  // Each row: [label, fnMetaKey, params, expectedErrorFragment | null]
  const cases = [
    // send_sms — basic required-field flow
    ['send_sms valid',                'send_sms', { from: '2485559999', to: '5551234', message: 'hi' }, null],
    ['send_sms missing message',      'send_sms', { from: '2485559999', to: '5551234' }, 'message is required'],
    ['send_sms placeholder to',       'send_sms', { from: '2485559999', to: '{{contactPhone}}', message: 'hi' }, null],

    // send_email — requiredWith group
    ['send_email no body',            'send_email', { from: 'x@y', to: 'a@b', subject: 'hi' }, 'must include at least one of: text, html'],
    ['send_email with text',          'send_email', { from: 'x@y', to: 'a@b', subject: 'hi', text: 'body' }, null],
    ['send_email with both',          'send_email', { from: 'x@y', to: 'a@b', subject: 'hi', text: 't', html: '<p>h</p>' }, null],

    // wait_for — exclusiveOneOf with nullishSkipsBlock on `at`
    ['wait_for relative valid',       'wait_for', { duration: '2h', nextStep: 5 }, null],
    ['wait_for absolute valid',       'wait_for', { at: '2026-05-01T14:30:00', nextStep: 5 }, null],
    ['wait_for both real',            'wait_for', { duration: '2h', at: '2026-05-01T14:30:00', nextStep: 5 }, 'must include only one'],
    ['wait_for neither',              'wait_for', { nextStep: 5 }, 'must include exactly one'],
    ['wait_for at:null skip pattern', 'wait_for', { at: null, nextStep: 5, skipToStep: 7 }, null],
    ['wait_for at:"" skip pattern',   'wait_for', { at: '', nextStep: 5, skipToStep: 7 }, null],
    ['wait_for at as placeholder',    'wait_for', { at: '{{maybe_null}}', nextStep: 5, skipToStep: 7 }, null],
    ['wait_for randomizeMinutes 9999','wait_for', { duration: '2h', nextStep: 5, randomizeMinutes: 9999 }, 'must be <= 1440'],
    ['wait_for randomizeMinutes -1',  'wait_for', { duration: '2h', nextStep: 5, randomizeMinutes: -1 }, 'must be >= 0'],

    // schedule_resume — required nullishSkipsBlock param
    ['schedule_resume with duration', 'schedule_resume', { resumeAt: '2h', nextStep: 4 }, null],
    ['schedule_resume null skip',     'schedule_resume', { resumeAt: null, nextStep: 4, skipToStep: 6 }, null],
    ['schedule_resume missing',       'schedule_resume', { nextStep: 4 }, 'resumeAt is required'],

    // evaluate_condition — single vs multi mode
    ['eval simple valid',             'evaluate_condition', { variable: 'x', operator: '==', value: 'y', then: 5 }, null],
    ['eval multi valid',              'evaluate_condition', { conditions: [{ variable: 'x', operator: '==', value: 'y' }], match: 'all', then: 5 }, null],
    ['eval neither',                  'evaluate_condition', { then: 5 }, 'must include exactly one'],
    ['eval both modes',               'evaluate_condition', { variable: 'x', operator: '==', conditions: [], then: 5 }, 'must include only one'],
    // `then` moved into requiredWith [['then','branches']] when branch mode
    // landed (court pipeline v2): a step must carry a top-level then OR
    // branches. Same rejection, different message.
    ['eval missing then',             'evaluate_condition', { variable: 'x', operator: '==' }, 'at least one of: then, branches'],
    ['eval bad operator',             'evaluate_condition', { variable: 'x', operator: 'INVALID', then: 5 }, 'must be one of'],

    // enroll_sequence — exclusiveOneOf
    ['enroll by_type',                'enroll_sequence', { contact_id: '1', template_type: 'no_show' }, null],
    ['enroll by_id',                  'enroll_sequence', { contact_id: '1', template_id: 42 }, null],
    ['enroll both',                   'enroll_sequence', { contact_id: '1', template_type: 'foo', template_id: 1 }, 'must include only one'],
    ['enroll neither',                'enroll_sequence', { contact_id: '1' }, 'must include exactly one'],

    // create_log — enum on type
    ['log valid type',                'create_log', { type: 'note' }, null],
    ['log bad type',                  'create_log', { type: 'invalid' }, 'must be one of'],
    ['log missing type',              'create_log', {}, 'type is required'],
    // 'event' was missing from the meta enum while runtime already wrote such
    // rows (11 live). Enum expansion can only ever ACCEPT more, so this is safe.
    ['log type event',                'create_log', { type: 'event' }, null],

    // create_log.extra — declared type:'object', NOT 'string'.
    //
    // The object form is the one the SAVE-TIME validator actually sees: every
    // live validated caller (wf15 s8, wf16 s7 on create_log; wf17–21 on
    // phone_log) passes an object literal. type:'string' would reject all of
    // them ("must be a string"), edit-locking those steps in workflows.html —
    // which also round-trips the value back out AS an object (JSON textarea →
    // JSON.parse on gather), so form and validator would disagree.
    //
    // The JSON-STRING form only ever arrives via params_mapping, and that path
    // is never validated (lib/actionDispatchers.deliverInternalFunction calls
    // fn(params, db) directly). So rejecting it here costs nothing real, and
    // asserting the rejection LOCKS THE DESIGN: at the workflow layer, `extra`
    // must be a real object. Hand-writing it as a JSON string there is a
    // footgun — {{placeholders}} interpolated into a JSON *string* corrupt it
    // the moment a resolved value contains a quote or backslash, and
    // createLogEntry then silently writes SQL NULL.
    ['log extra object',              'create_log', { type: 'note', extra: { provider: 'rc' } }, null],
    ['log extra empty object',        'create_log', { type: 'note', extra: {} }, null],
    ['log extra json-string rejected','create_log', { type: 'note', extra: '{"provider":"rc"}' }, 'must be a JSON object'],
    ['log extra array rejected',      'create_log', { type: 'note', extra: ['rc'] }, 'must be a JSON object'],
    ['log extra omitted',             'create_log', { type: 'note', by: 0 }, null],

    // phone_log — same param contract as create_log (drop-in), incl. `extra`.
    // The pipeline itself writes params.extra.firmToFirm, so `extra` is part of
    // phone_log's contract rather than an incidental passthrough. This row is
    // the regression gate for wf17–21, all of which pass an object literal.
    ['phone_log extra object',        'phone_log',  { type: 'sms', extra: { provider: 'quo' } }, null],
    ['phone_log extra string rejected','phone_log', { type: 'sms', extra: '{"provider":"quo"}' }, 'must be a JSON object'],

    // update_log — re-link only. log_id is integer-typed but MUST accept a
    // {{placeholder}}: the canonical caller is create_log → set_vars logId →
    // update_log { log_id: '{{logId}}' }. The validator's placeholder bypass
    // runs before the type check, so placeholderAllowed works on any type —
    // omitting it (as create_appointment.appt_with does) 400s the step at save.
    ['update_log valid',              'update_log', { log_id: 58197, link_type: 'contact', link_id: '412' }, null],
    ['update_log placeholder log_id', 'update_log', { log_id: '{{logId}}', link_type: 'contact', link_id: '{{contactId}}' }, null],
    ['update_log missing log_id',     'update_log', { link_type: 'contact', link_id: '412' }, 'log_id is required'],
    ['update_log missing link_type',  'update_log', { log_id: 1, link_id: '412' }, 'link_type is required'],
    ['update_log missing link_id',    'update_log', { log_id: 1, link_type: 'contact' }, 'link_id is required'],
    ['update_log bad link_type',      'update_log', { log_id: 1, link_type: 'nonsense', link_id: '412' }, 'must be one of'],
    // 'task'/'event' are valid in the DB column but deliberately NOT re-link
    // targets — machine-written rows. Rejecting them here is the design, not a
    // gap; widening the enum later is additive.
    ['update_log task not relinkable','update_log', { log_id: 1, link_type: 'task', link_id: '5' }, 'must be one of'],
    ['update_log phone value',        'update_log', { log_id: 1, link_type: 'phone', link_id: '3135550100' }, null],

    // query_db — array types, integer with bounds
    ['query_db valid',                'query_db', { select: ['cases.case_id'], from: 'cases' }, null],
    ['query_db missing select',       'query_db', { from: 'cases' }, 'select is required'],
    ['query_db select not array',     'query_db', { select: 'cases.case_id', from: 'cases' }, 'must be a JSON array'],
    ['query_db limit too high',       'query_db', { select: ['*'], from: 'cases', limit: 9999 }, 'must be <= 1000'],

    // create_appointment — enum
    ['appt valid',                    'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Zoom' }, null],
    ['appt bad platform',             'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Carrier Pigeon' }, 'must be one of'],

    // update_contact — object type
    ['update_contact valid',          'update_contact', { contact_id: '1', fields: { contact_type: 'Client' } }, null],
    ['update_contact fields=array',   'update_contact', { contact_id: '1', fields: ['nope'] }, 'must be a JSON object'],

    // update_case — object type + required id
    ['update_case valid',             'update_case', { case_id: '1', fields: { case_stage: 'Filed' } }, null],
    ['update_case placeholder id',    'update_case', { case_id: '{{caseId}}', fields: { case_stage: 'Filed' } }, null],
    ['update_case fields=array',      'update_case', { case_id: '1', fields: ['nope'] }, 'must be a JSON object'],
    ['update_case missing id',        'update_case', { fields: { case_stage: 'Filed' } }, 'case_id is required'],

    // query_ai — required prompt, strict enums, integer bounds
    ['query_ai valid minimal',        'query_ai', { prompt: 'do x' }, null],
    ['query_ai valid full',           'query_ai', { prompt: 'do x', input: '{{trigger.email_body}}', model: 'claude-haiku-4-5-20251001', output_type: 'json', max_tokens: 2048, timeout_ms: 30000, output_var: 'r' }, null],
    ['query_ai missing prompt',       'query_ai', { input: 'text' }, 'prompt is required'],
    ['query_ai bad model',            'query_ai', { prompt: 'x', model: 'gpt-5' }, 'must be one of'],
    ['query_ai placeholder model rejected', 'query_ai', { prompt: 'x', model: '{{aiModel}}' }, 'must be one of'],
    ['query_ai bad output_type',      'query_ai', { prompt: 'x', output_type: 'html' }, 'must be one of'],
    ['query_ai max_tokens too high',  'query_ai', { prompt: 'x', max_tokens: 99999 }, 'must be <= 8192'],
    ['query_ai timeout too low',      'query_ai', { prompt: 'x', timeout_ms: 10 }, 'must be >= 1000'],
    ['query_ai string max_tokens ok', 'query_ai', { prompt: 'x', max_tokens: '512' }, null],

    // query_ai file attachments (Slice B) — text-only regression is the
    // 'query_ai valid minimal'/'valid full' rows above (zero file params
    // stays valid). NOTE: the file_* sources carry NO exclusiveOneOf group —
    // the validator's exclusiveOneOf means EXACTLY one and all four sources
    // are optional here, so at-most-one is enforced at RUN TIME only (see
    // the runtime describe block below). timeout_ms max raised 60000→120000.
    ['query_ai timeout at raised max','query_ai', { prompt: 'x', timeout_ms: 120000 }, null],
    ['query_ai timeout above max',    'query_ai', { prompt: 'x', timeout_ms: 120001 }, 'must be <= 120000'],
    ['query_ai valid file_url',       'query_ai', { prompt: 'summarize the attachment', file_url: 'https://example.com/scan.pdf' }, null],
    ['query_ai valid file_dropbox_path', 'query_ai', { prompt: 'summarize', file_dropbox_path: '/ Cases/scanned-notice.pdf', timeout_ms: 90000, output_var: 'summary' }, null],
    ['query_ai asset with file_type override', 'query_ai', { prompt: 'read it', file_asset_id: 123, file_type: 'document' }, null],
    ['query_ai two file sources pass save-time (runtime-enforced)', 'query_ai', { prompt: 'x', file_url: 'https://example.com/a.pdf', file_dropbox_path: '/b.pdf' }, null],
    ['query_ai bad file_type',        'query_ai', { prompt: 'x', file_url: 'https://example.com/a.pdf', file_type: 'video' }, 'must be one of'],
    ['query_ai file_asset_id non-numeric', 'query_ai', { prompt: 'x', file_asset_id: 'abc' }, 'must be an integer'],

    // parse_pdf — exclusiveOneOf over three sources, option types
    ['parse_pdf valid url',           'parse_pdf', { url: 'https://example.com/doc.pdf' }, null],
    ['parse_pdf valid dropbox_path',  'parse_pdf', { dropbox_path: '/ Cases/petition.pdf', pages: '1-3', output_var: 'petition_text' }, null],
    ['parse_pdf valid dropbox_link',  'parse_pdf', { dropbox_link: 'https://www.dropbox.com/s/abc/petition.pdf', max_length: 5000, normalize_whitespace: false }, null],
    ['parse_pdf placeholder path',    'parse_pdf', { dropbox_path: '{{petition_path}}' }, null],
    ['parse_pdf two sources',         'parse_pdf', { url: 'https://example.com/doc.pdf', dropbox_path: '/x.pdf' }, 'must include only one'],
    ['parse_pdf no source',           'parse_pdf', { pages: '1-3' }, 'must include exactly one'],
    // `pages` carries strictString:true — its runtime (pdfService
    // parsePageRangeSyntax) hard-rejects a non-string with BAD_PAGES, so a bare
    // number must fail at SAVE time, NOT slip through decision-1's global
    // finite-number acceptance and defer to a runtime throw. This is the guard
    // for one of the nine strictString param instances; the dedicated
    // strictString block at the bottom exercises the rest.
    ['parse_pdf pages not string',    'parse_pdf', { url: 'https://example.com/doc.pdf', pages: 3 }, 'must be a string'],
    ['parse_pdf pages array rejected','parse_pdf', { url: 'https://example.com/doc.pdf', pages: [1, 3] }, 'must be a string'],
    ['parse_pdf placeholder pages ok','parse_pdf', { url: 'https://example.com/doc.pdf', pages: '{{pageRange}}' }, null],
    ['parse_pdf normalize=string',    'parse_pdf', { url: 'https://example.com/doc.pdf', normalize_whitespace: 'true' }, 'must be a boolean'],
    ['parse_pdf max_length too low',  'parse_pdf', { url: 'https://example.com/doc.pdf', max_length: 0 }, 'must be >= 1'],

    // run_task_digest — boolean type
    ['digest force=true',             'run_task_digest', { force: true }, null],
    ['digest force=string',           'run_task_digest', { force: 'true' }, 'must be a boolean'],

    // noop — empty params
    ['noop no params',                'noop', {}, null],

    // Generic params shape
    ['set_var array params rejected', 'set_var', [], 'must be a JSON object'],

    // ─────────────────────────────────────────────────────────────
    // SAVE-TIME EDIT-LOCK SLICE
    //
    // 20 of 91 live internal_function workflow steps 400'd on save while the
    // executor ran them fine — the validator rejected three value shapes that
    // are legitimate at run time. The rows below are the regression gate for
    // each shape, PAIRED with the adjacent shape that must still fail so the
    // widenings can't quietly grow.
    // ─────────────────────────────────────────────────────────────

    // (1) FINITE NUMBERS pass a `string` param — global, no flag. Mirrors the
    //     numeric-STRING coercion the number/integer cases already do.
    //     Live: set_next {value: 3|7|8} (wf1/2/15/16), evaluate_condition
    //     {value: 1} (wf15 s5, wf16 s4, wf17 s3), run_task_digest {user: 6}.
    ['string param accepts number',       'set_next', { value: 5 }, null],
    ['string param accepts 0',            'set_next', { value: 0 }, null],
    ['string param accepts negative',     'evaluate_condition', { variable: 'x', operator: '==', value: -1, then: 2 }, null],
    ['string param accepts float',        'evaluate_condition', { variable: 'x', operator: '==', value: 1.5, then: 2 }, null],
    ['string param rejects NaN',          'set_next', { value: NaN }, 'must be a string'],
    ['string param rejects Infinity',     'set_next', { value: Infinity }, 'must be a string'],
    ['string param rejects array',        'send_sms', { from: '1', to: '2', message: ['hi'] }, 'must be a string'],
    ['run_task_digest numeric user',      'run_task_digest', { user: 6 }, null],
    // job179 passes force:"true". NOT absorbed — `boolean` stays strict. At run
    // time `if (!force)` makes the string "true" truthy, but it makes "false"
    // truthy too, so the string form only works by accident. Genuinely bad
    // config; fix the job, not the spec.
    ['run_task_digest force=string still rejected', 'run_task_digest', { force: 'true' }, 'must be a boolean'],

    // (1b) strictString RE-NARROWS (1) for the nine param instances (eight
    //      distinct runtime guards; `table` on both update_db and insert_db)
    //      whose runtime hard-rejects a non-string. A bare number must fail at
    //      SAVE time on these, while every OTHER string param still takes a
    //      number — each strict-reject row is paired with a non-strict accept so
    //      the flag can neither spread nor silently vanish.
    ['strictString query_ai.prompt rejects number',      'query_ai', { prompt: 5 }, 'must be a string'],
    ['strictString query_ai.prompt accepts string',      'query_ai', { prompt: 'do x' }, null],
    ['strictString query_ai.prompt accepts placeholder', 'query_ai', { prompt: '{{instructions}}' }, null],
    ['strictString query_db.from rejects number',        'query_db', { select: ['*'], from: 3 }, 'must be a string'],
    ['strictString update_db.table rejects number',      'update_db', { table: 7, set_column: 'x', set_value: 'y', where_column: 'id', where_value: '1' }, 'must be a string'],
    ['strictString update_db.set_column rejects number', 'update_db', { table: 'checkitems', set_column: 9, set_value: 'y', where_column: 'id', where_value: '1' }, 'must be a string'],
    ['strictString update_db.where_column rejects number','update_db',{ table: 'checkitems', set_column: 'x', set_value: 'y', where_column: 8, where_value: '1' }, 'must be a string'],
    ['strictString insert_db.table rejects number',      'insert_db', { table: 7, values: { a: 1 } }, 'must be a string'],
    ['strictString set_setting.key rejects number',      'set_setting', { key: 42, value: 'v' }, 'must be a string'],
    ['strictString get_setting.key rejects number',      'get_setting', { key: 42 }, 'must be a string'],

    // get_settings — plural read. keys is a csv STRING at save time; a
    // hardcoded array literal is rejected here (arrays only arrive at
    // runtime via placeholder resolution). See system.js.
    ['get_settings valid csv',                'get_settings', { keys: 'court_ingest_live, esign_test_mode' }, null],
    ['get_settings with output_var',          'get_settings', { keys: 'a,b', output_var: 'settings' }, null],
    ['get_settings placeholder keys',         'get_settings', { keys: '{{keyList}}' }, null],
    ['get_settings missing keys',             'get_settings', {}, 'keys is required'],
    ['get_settings rejects number',           'get_settings', { keys: 42 }, 'must be a string'],
    ['get_settings rejects array literal',    'get_settings', { keys: ['a', 'b'] }, 'must be a string'],
    // Placeholder still wins on a strict param (the {{token}} bypass runs before
    // the type check); update_db.table carries placeholderAllowed.
    ['strictString update_db.table accepts placeholder', 'update_db', { table: '{{tbl}}', set_column: 'x', set_value: 'y', where_column: 'id', where_value: '1' }, null],
    // The bound-VALUE params on update_db are NOT strict — a number there is a
    // legitimate scalar the driver parameterizes, so it must still save.
    ['non-strict update_db.set_value accepts number',    'update_db', { table: 'checkitems', set_column: 'qty', set_value: 5, where_column: 'id', where_value: '1' }, null],

    // (2) OBJECTS pass a `string` param ONLY with objectAllowed. create_log.data
    //     / phone_log.data — createLogEntry dual-accepts object-or-string, and
    //     7 live steps pass nested blobs (wf15 s8, wf16 s7, wf17–21).
    ['create_log.data accepts object',    'create_log', { type: 'sms', data: { direction: '{{direction}}', attachments: '{{attachments}}' } }, null],
    ['create_log.data accepts string',    'create_log', { type: 'note', data: 'Auto follow-up sent' }, null],
    ['phone_log.data accepts object',     'phone_log',  { type: 'call', data: { to: '{{to}}', from: '{{from}}' } }, null],
    ['create_log.data rejects array',     'create_log', { type: 'note', data: ['nope'] }, 'must be a string'],
    // The flag is per-spec, never global: an unflagged string param must still
    // reject an object. send_sms.message has no objectAllowed.
    ['unflagged string param rejects object', 'send_sms', { from: '1', to: '2', message: { text: 'hi' } }, 'must be a string'],

    // (3) BOOLEANS pass a `string` param ONLY with booleanAllowed.
    //     evaluate_condition.value is a comparison OPERAND — JSDoc type {any},
    //     applied with loose `==`. wf15 s1 / wf16 s1 gate on
    //     `needs_fetch == true` with a literal boolean, and `true == "true"` is
    //     FALSE in JS, so stringifying the operand would invert the branch.
    ['eval value accepts boolean',        'evaluate_condition', { variable: 'needs_fetch', operator: '==', value: true, then: 2, else: 4 }, null],
    ['eval value accepts false',          'evaluate_condition', { variable: 'x', operator: '==', value: false, then: 2 }, null],
    ['unflagged string param rejects boolean', 'send_sms', { from: '1', to: '2', message: true }, 'must be a string'],
    ['set_next rejects boolean',          'set_next', { value: true }, 'must be a string'],

    // (4) {{placeholder}} on a NON-string spec, via placeholderAllowed (the
    //     bypass runs before the type check, so it works on any type).
    //     Live: create_appointment {appt_with: "{{attorney_user_id}}"} (wf7 s3),
    //     create_log {link_type: "{{link_type}}", direction: "{{direction}}"}
    //     (wf15 s8, wf16 s7), phone_log {direction: "{{direction}}"} (wf18 s1,
    //     wf20 s4, wf21 s1).
    ['appt_with placeholder',             'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Zoom', appt_with: '{{attorney_user_id}}' }, null],
    ['appt_with literal integer',         'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Zoom', appt_with: 22 }, null],
    ['appt_with garbage still rejected',  'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Zoom', appt_with: 'rena' }, 'must be an integer'],
    // Per-spec, never global: an integer param WITHOUT the flag still rejects a
    // token. create_log.by carries no placeholderAllowed.
    ['unflagged integer rejects placeholder', 'create_log', { type: 'note', by: '{{userId}}' }, 'must be an integer'],
    ['create_log.link_type placeholder',  'create_log', { type: 'sms', link_type: '{{link_type}}', link_id: '{{their_number}}' }, null],
    ['create_log.direction placeholder',  'create_log', { type: 'sms', direction: '{{direction}}' }, null],
    ['phone_log.direction placeholder',   'phone_log',  { type: 'sms', direction: '{{direction}}' }, null],
    ['phone_log.link_type placeholder',   'phone_log',  { type: 'sms', link_type: '{{link_type}}' }, null],
    // A real LITERAL is still enum-checked — the bypass only skips {{tokens}},
    // which are unresolvable at save time by definition.
    ['create_log.link_type bad literal',  'create_log', { type: 'sms', link_type: 'nonsense' }, 'must be one of'],
    ['create_log.direction bad literal',  'create_log', { type: 'sms', direction: 'sideways' }, 'must be one of'],

    // (5) set_next {value: null} — the documented "end the workflow normally"
    //     idiom (live on wf28 s6), which required:true had been 400ing.
    //     nullishSkipsBlock switches the required-check to key-presence.
    //     OMISSION is still an error and must stay one: with no `value` the
    //     function returns next_step:undefined, which workflow_engine's
    //     `next_step !== undefined` guard turns into a silent fall-through to
    //     the next step — a different thing entirely from stopping.
    ['set_next explicit null ends wf',    'set_next', { value: null }, null],
    ['set_next empty-string null form',   'set_next', { value: '' }, null],
    ['set_next omitted still required',   'set_next', {}, 'value is required'],
    ['set_next cancel',                   'set_next', { value: 'cancel' }, null],
    ['set_next placeholder',              'set_next', { value: '{{next_step}}' }, null],
    // 'end' — the word form of null (2026-08). The param is type:'string' with
    // no enum, so this always validated; pinned here so a future enum/strict
    // tightening can't quietly lock it out again. Runtime meaning is asserted
    // in tests/control.flow.test.js (normalizeNextStep).
    ['set_next end sentinel',             'set_next', { value: 'end' }, null],
    ['set_next end sentinel (cased)',     'set_next', { value: 'END' }, null],
    ['foreach end_step end sentinel',     'foreach',
      { list: '{{items}}', item_var: 'it', end_step: 'end' }, null],

    // ─────────────────────────────────────────────────────────────
    // lookup_user — one-box staff lookup (lib/internal_functions/users.js).
    //
    // `user` is a plain string param, so it rides decision-(1)'s global
    // finite-number widening: {user: 6} must save, because the canonical
    // config is a bare id and the runtime coerces with Number()/String().
    // `fields` mirrors get_settings.keys exactly — strictString + csv at save
    // time, array only ever via placeholder resolution at run time.
    // ─────────────────────────────────────────────────────────────
    ['lookup_user id number',             'lookup_user', { user: 6 }, null],
    ['lookup_user id zero (Automations)', 'lookup_user', { user: 0 }, null],
    ['lookup_user id string',             'lookup_user', { user: '22' }, null],
    ['lookup_user free text',             'lookup_user', { user: 'rena@4lsg.com' }, null],
    ['lookup_user placeholder',           'lookup_user', { user: '{{task_to}}' }, null],
    ['lookup_user missing user',          'lookup_user', {}, 'user is required'],
    ['lookup_user user object rejected',  'lookup_user', { user: { id: 6 } }, 'must be a string'],
    ['lookup_user user boolean rejected', 'lookup_user', { user: true }, 'must be a string'],
    ['lookup_user match valid',           'lookup_user', { user: 6, match: 'id' }, null],
    ['lookup_user match bad',             'lookup_user', { user: 6, match: 'nickname' }, 'must be one of'],
    ['lookup_user fields csv',            'lookup_user', { user: 6, fields: 'user_name, email' }, null],
    ['lookup_user fields placeholder',    'lookup_user', { user: 6, fields: '{{fieldList}}' }, null],
    ['lookup_user fields number',         'lookup_user', { user: 6, fields: 42 }, 'must be a string'],
    ['lookup_user fields array literal',  'lookup_user', { user: 6, fields: ['user_name'] }, 'must be a string'],
    ['lookup_user missing_ok bool',       'lookup_user', { user: 6, missing_ok: true }, null],
    ['lookup_user missing_ok string',     'lookup_user', { user: 6, missing_ok: 'true' }, 'must be a boolean'],
    ['lookup_user output_var',            'lookup_user', { user: 6, output_var: 'assignee' }, null],
    ['lookup_user full config',           'lookup_user', { user: '{{task_to}}', match: 'id', fields: 'user_name, email, phone_formatted', missing_ok: true, output_var: 'assignee' }, null],

    // ─────────────────────────────────────────────────────────────
    // list_users — the fan-out companion to lookup_user. Returns an ARRAY for
    // foreach, so every param is a filter and every filter is optional.
    //
    // strictString split is deliberate and asserted below: `role` and `fields`
    // carry it (a number is meaningless for either), `ids` and `exclude` do NOT
    // (a bare number is a legitimate single id, and _csvList handles it).
    // ─────────────────────────────────────────────────────────────
    ['list_users no filters',             'list_users', {}, null],
    ['list_users role csv',               'list_users', { role: 'attorney' }, null],
    ['list_users role multi',             'list_users', { role: 'it, admin', role_match: 'all' }, null],
    ['list_users role placeholder',       'list_users', { role: '{{roleFilter}}' }, null],
    ['list_users role number rejected',   'list_users', { role: 5 }, 'must be a string'],
    ['list_users role array rejected',    'list_users', { role: ['attorney'] }, 'must be a string'],
    ['list_users role_match bad',         'list_users', { role_match: 'some' }, 'must be one of'],
    ['list_users does_appts bool',        'list_users', { does_appts: true }, null],
    ['list_users does_appts string',      'list_users', { does_appts: 'true' }, 'must be a boolean'],
    ['list_users allow_sms + has_phone',  'list_users', { allow_sms: true, has_phone: true }, null],
    ['list_users ids csv',                'list_users', { ids: '1, 6, 22' }, null],
    ['list_users ids bare number',        'list_users', { ids: 6 }, null],
    ['list_users ids placeholder',        'list_users', { ids: '{{userIds}}' }, null],
    ['list_users ids array rejected',     'list_users', { ids: [1, 6] }, 'must be a string'],
    ['list_users exclude bare number',    'list_users', { exclude: 6 }, null],
    ['list_users exclude placeholder',    'list_users', { exclude: '{{trigger.user_id}}' }, null],
    ['list_users active_only false',      'list_users', { active_only: false }, null],
    ['list_users include_automation',     'list_users', { include_automation: true }, null],
    ['list_users sort valid',             'list_users', { sort: 'user_lname' }, null],
    ['list_users sort bad',               'list_users', { sort: 'email' }, 'must be one of'],
    ['list_users fields csv',             'list_users', { fields: 'user, user_name, email' }, null],
    ['list_users fields number rejected', 'list_users', { fields: 42 }, 'must be a string'],
    ['list_users require_any',            'list_users', { require_any: true }, null],
    ['list_users output_var + count_var', 'list_users', { output_var: 'attorneys', count_var: 'n' }, null],
    ['list_users full config',            'list_users', { role: 'attorney', role_match: 'any', does_appts: true, allow_sms: true, ringcentral: false, has_email: true, has_phone: true, ids: '1, 6', exclude: '6', active_only: true, include_automation: false, sort: 'user_name', fields: 'user, email', require_any: true, output_var: 'a', count_var: 'n' }, null],
  ];

  test.each(cases)('%s', (label, fnKey, params, expectedFragment) => {
    const result = v(meta[fnKey], params);
    if (expectedFragment === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result.error).toContain(expectedFragment);
    }
  });
});

// Runtime checks for query_ai's file-source rules that the save-time
// validator CANNOT express (exclusiveOneOf = exactly-one; the file_*
// sources are optional-exclusive). Every case below throws BEFORE any
// DB/service/API I/O, so db=null is safe.
describe('query_ai file-source runtime checks', () => {
  test('two file sources throws', async () => {
    await expect(internalFunctions.query_ai(
      { prompt: 'x', file_url: 'https://example.com/a.pdf', file_dropbox_path: '/b.pdf' }, null
    )).rejects.toThrow('provide at most one file source');
  });
  test('bad file_type throws', async () => {
    await expect(internalFunctions.query_ai(
      { prompt: 'x', file_url: 'https://example.com/a.pdf', file_type: 'video' }, null
    )).rejects.toThrow('file_type must be');
  });
  test('unsupported extension throws', async () => {
    await expect(internalFunctions.query_ai(
      { prompt: 'x', file_url: 'https://example.com/a.docx' }, null
    )).rejects.toThrow('unsupported file type ".docx"');
  });
  test('undeterminable type without file_type throws', async () => {
    await expect(internalFunctions.query_ai(
      { prompt: 'x', file_url: 'https://example.com/download?id=9' }, null
    )).rejects.toThrow('cannot infer file type');
  });
  test('extension-less url with file_type override passes inference (query string stripped)', async () => {
    // file_type makes the block type determinable for a url source; the call
    // then proceeds to aiService, which fails on the null db — proving
    // inference itself accepted the input.
    await expect(internalFunctions.query_ai(
      { prompt: 'x', file_url: 'https://example.com/download?id=9', file_type: 'document' }, null
    )).rejects.not.toThrow('cannot infer');
  });
});

// Runtime checks for lookup_user's input rules that the save-time validator
// cannot express (they depend on the VALUE, not the shape). Every case below
// throws BEFORE db.query, so db=null is safe — same pattern as the query_ai
// block above.
describe('lookup_user runtime input checks', () => {
  test('blank user throws', async () => {
    await expect(internalFunctions.lookup_user({ user: '   ' }, null))
      .rejects.toThrow('requires user');
  });
  test('match=id on non-numeric throws before any query', async () => {
    await expect(internalFunctions.lookup_user({ user: 'fred', match: 'id' }, null))
      .rejects.toThrow('requires a numeric user id');
  });
  test('match=phone on a non-phone throws before any query', async () => {
    await expect(internalFunctions.lookup_user({ user: 'fred', match: 'phone' }, null))
      .rejects.toThrow('normalizes to 10 digits');
  });
  test('unknown field throws', async () => {
    await expect(internalFunctions.lookup_user({ user: 6, fields: 'user_name, ssn' }, null))
      .rejects.toThrow('unknown field(s): ssn');
  });
  test('a blocked column is not addressable via fields', async () => {
    await expect(internalFunctions.lookup_user({ user: 6, fields: 'password_hash' }, null))
      .rejects.toThrow('unknown field(s): password_hash');
  });
  test('always-present meta key in fields throws a targeted message', async () => {
    await expect(internalFunctions.lookup_user({ user: 6, fields: 'found' }, null))
      .rejects.toThrow('always returned');
  });
  test('no blocked column is reachable through the returned set', () => {
    const returned = new Set([
      ...internalFunctions.__USER_RETURNED_COLUMNS,
      ...internalFunctions.__USER_DERIVED_FIELDS,
    ]);
    for (const c of internalFunctions.__USER_BLOCKED_COLUMNS) {
      expect(returned.has(c)).toBe(false);
    }
  });
});

// list_users runtime behavior. Driven off a stub db so the filter/sort/roll-up
// logic is exercised without a live connection — the function issues exactly
// one unfiltered SELECT and does everything else in JS (users.user is a tinyint
// PK, so the table is hard-capped at 128 rows).
describe('list_users runtime behavior', () => {
  const U = (o) => ({
    user: 0, username: 'u', user_name: 'U', user_real_name: 'U',
    user_fname: 'U', user_lname: 'U', user_initials: 'UU',
    user_type: 1, user_auth: 'authorized', roles: 'staff',
    email: null, default_email: null, phone: null, default_phone: null,
    allow_sms: 0, does_appts: 0, ringcentral: 0,
    task_remind_freq: null, user_gcal_id: null, freebusy_calendar_ids: null,
    ...o,
  });

  const ROWS = [
    U({ user: 0,  username: 'automations', user_name: 'Automations', user_lname: 'Mations',
        user_type: 0, roles: 'automation', email: 'admin@4lsg.com' }),
    U({ user: 1,  username: 'Ssandweiss', user_name: 'Stuart Sandweiss', user_lname: 'Sandweiss',
        roles: 'staff,attorney', email: 'stuart@4lsg.com', phone: '2485592400',
        allow_sms: 1, does_appts: 1 }),
    U({ user: 3,  username: 'RR', user_name: 'Rivka Rosen', user_lname: 'Rosen',
        user_auth: 'disabled', email: 'rivka@example.com' }),
    U({ user: 6,  username: 'IT', user_name: 'Fred Ross', user_lname: 'Ross',
        user_auth: 'authorized - SU', roles: 'it,admin', email: 'it@4lsg.com',
        phone: '2486213656', allow_sms: 1, does_appts: 1 }),
    U({ user: 22, username: 'RENA', user_name: 'Rena Grunberger', user_lname: 'Grunberger',
        email: 'rena@4lsg.com', phone: '2489655355', does_appts: 1 }),
  ];
  const db = { query: async () => [ROWS.map(r => ({ ...r }))] };
  const ids = (out) => out.ids;

  test('defaults drop the disabled user AND the automations pseudo-user', async () => {
    const { output } = await fns_list({}, db);
    expect(ids(output)).toEqual([6, 22, 1]);       // sorted by user_name
    expect(output.ids).not.toContain(3);            // user_auth = 'disabled'
    expect(output.ids).not.toContain(0);            // user_type = 0
  });

  test('active_only:false readmits the disabled user', async () => {
    const { output } = await fns_list({ active_only: false }, db);
    expect(output.ids).toContain(3);
  });

  test('role filter, any vs all', async () => {
    expect(ids((await fns_list({ role: 'attorney' }, db)).output)).toEqual([1]);
    expect(ids((await fns_list({ role: 'it, admin', role_match: 'all' }, db)).output)).toEqual([6]);
    expect(ids((await fns_list({ role: 'attorney, it', role_match: 'all' }, db)).output)).toEqual([]);
  });

  test('role=automation implies include_automation; explicit false still wins', async () => {
    expect(ids((await fns_list({ role: 'automation' }, db)).output)).toEqual([0]);
    expect(ids((await fns_list({ role: 'automation', include_automation: false }, db)).output)).toEqual([]);
  });

  test('ids does NOT imply include_automation (machine-generated lists carry user 0)', async () => {
    expect(ids((await fns_list({ ids: '0,1' }, db)).output)).toEqual([1]);
    expect(ids((await fns_list({ ids: '0,1', include_automation: true }, db)).output)).toEqual([0, 1]);
  });

  test('unknown role throws with the available list', async () => {
    await expect(fns_list({ role: 'paralegal' }, db)).rejects.toThrow('unknown role(s): paralegal');
  });

  test('tri-state booleans: omitted = no filter, string forms coerce', async () => {
    expect((await fns_list({}, db)).output.count).toBe(3);
    expect(ids((await fns_list({ does_appts: true }, db)).output)).toEqual([6, 22, 1]);
    expect(ids((await fns_list({ does_appts: 'false' }, db)).output)).toEqual([]);
    expect((await fns_list({ does_appts: '' }, db)).output.count).toBe(3);
    await expect(fns_list({ does_appts: 'maybe' }, db)).rejects.toThrow('must be a boolean');
  });

  test('has_phone checks the contact column and normalizes', async () => {
    expect(ids((await fns_list({ has_phone: true }, db)).output)).toEqual([6, 22, 1]);
  });

  test('exclude drops by id; bad ids throw', async () => {
    expect(ids((await fns_list({ exclude: 6 }, db)).output)).toEqual([22, 1]);
    await expect(fns_list({ ids: '1,abc' }, db)).rejects.toThrow('must contain user ids');
  });

  test('sort modes, with a stable id tiebreak', async () => {
    expect(ids((await fns_list({ sort: 'user' }, db)).output)).toEqual([1, 6, 22]);
    expect(ids((await fns_list({ sort: 'user_lname' }, db)).output)).toEqual([22, 6, 1]);
  });

  test('roll-ups are built from full rows, so `fields` cannot empty them', async () => {
    const { output } = await fns_list({ role: 'attorney', fields: 'user, user_name' }, db);
    expect(Object.keys(output.users[0])).toEqual(['user', 'user_name']);
    expect(output.emails).toEqual(['stuart@4lsg.com']);
    expect(output.emails_csv).toBe('stuart@4lsg.com');
    expect(output.phones).toEqual(['2485592400']);
  });

  test('output_var stores the ARRAY (foreach-ready), count_var the count', async () => {
    const r = await fns_list({ role: 'attorney', output_var: 'attorneys', count_var: 'n' }, db);
    expect(Array.isArray(r.set_vars.attorneys)).toBe(true);
    expect(r.set_vars.attorneys).toHaveLength(1);
    expect(r.set_vars.n).toBe(1);
  });

  test('the users array is a legal foreach list', async () => {
    const { set_vars } = await fns_list({ role: 'staff', output_var: 'staff' }, db);
    const variables = { staff: set_vars.staff };
    const walked = [];
    for (let guard = 0; guard < 20; guard++) {
      const fr = await internalFunctions.foreach({
        list: variables.staff, item_var: 'u', end_step: 9,
        _variables: variables, _step_number: 4,
      });
      Object.assign(variables, fr.set_vars);
      if (fr.output.done) break;
      walked.push(variables.u.user);
    }
    expect(walked).toEqual([22, 1]);
  });

  test('empty result is not an error unless require_any is set', async () => {
    const { output } = await fns_list({ role: 'it', does_appts: false }, db);
    expect(output.count).toBe(0);
    expect(output.has_users).toBe(false);
    expect(output.users).toEqual([]);
    await expect(fns_list({ role: 'it', does_appts: false, require_any: true }, db))
      .rejects.toThrow('require_any');
  });

  test('a blocked column never appears in any returned user map', async () => {
    const { output } = await fns_list({ active_only: false, include_automation: true }, db);
    for (const u of output.users) {
      for (const c of internalFunctions.__USER_BLOCKED_COLUMNS) {
        expect(c in u).toBe(false);
      }
    }
  });

  function fns_list(params, conn) { return internalFunctions.list_users(params, conn); }
});

describe('__getMeta — single fetch', () => {
  test('returns meta for known function', () => {
    const m = internalFunctions.__getMeta('send_sms');
    expect(m).toBeTruthy();
    expect(m.category).toBe('communication');
  });
  test('returns null for unknown function', () => {
    expect(internalFunctions.__getMeta('does_not_exist')).toBeNull();
  });
});