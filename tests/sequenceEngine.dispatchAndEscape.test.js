/**
 * tests/sequenceEngine.dispatchAndEscape.test.js
 *
 * Two defects found while planning the Casey automation-authoring family
 * (2026-10-22), both in the sms/email/task/internal_function dispatch path.
 *
 * 1. `type` OVERRIDE. executeStep built the executor payload as
 *    `{ type:'internal_function', ...resolvedConfig }`, so an action_config
 *    carrying its own `type` key won the spread: a step whose action_type says
 *    `sms` dispatched as `custom_code` (vm) or took the webhook path.
 *    `type` is now pinned LAST, and routes/sequences.js refuses the key.
 *
 * 2. UNESCAPED JSON SUBSTITUTION. Resolution is
 *    JSON.stringify(action_config) -> resolve -> JSON.parse. resolverService
 *    substituted each value verbatim, so a resolved value containing a double
 *    quote broke the parse; the catch then ran the step with its config
 *    ENTIRELY unresolved — a client SMS/email body full of literal {{...}}.
 *    resolve() now takes `escape:'json'`, which the two serialized-config
 *    call sites pass. Plain-text callers are unaffected.
 *
 * HARNESS: the real engine and the real resolverService against an in-memory
 * fake that interprets exactly the statements they issue; unrecognized SQL
 * THROWS so drift fails the suite loudly. Only lib/job_executor (the action
 * side effect) and lib/taskQueue (the Cloud Tasks doorbell) are mocked — the
 * modules under test never are. Placeholders use `trigger_data`, the
 * resolver's pseudo-table, so no contacts query is needed.
 *
 *   npx jest tests/sequenceEngine.dispatchAndEscape.test.js
 */

jest.mock('../lib/job_executor', () => ({
  executeJob: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const { executeJob } = require('../lib/job_executor');
const { executeStep } = require('../lib/sequenceEngine');
const { resolve }     = require('../services/resolverService');

// A name that is legal in `contacts` and breaks naive JSON substitution.
const TRICKY = 'Mary "Sue" O\'Brien \\ Jr';

function makeEngineDb({ triggerData, stepConfig, totalSteps = 1 }) {
  const state = {
    enrollments: [{
      id: 7, template_id: 30, template_version: 3, status: 'active',
      contact_id: 55, current_step: 1, total_steps: totalSteps,
      trigger_data: JSON.stringify(triggerData),
      template_condition: null, _tv_version: 3,
      template_name: 'Casey fix', template_type: 'casey_fix',
    }],
    steps: [{
      id: 1000, template_id: 30, version: 3, step_number: 1,
      action_type: 'internal_function',
      timing: JSON.stringify({ type: 'immediate' }),
      action_config: JSON.stringify(stepConfig),
      condition: null, fire_guard: null, error_policy: null,
    }],
    logs: [], sql: [],
  };
  const enr = (id) => state.enrollments.find(e => e.id === id);

  const handlers = [
    [/^SELECT e\.\*, tv\.template_condition AS template_condition, tv\.version AS _tv_version, t\.name AS template_name, t\.type AS template_type FROM sequence_enrollments e JOIN sequence_templates t ON t\.id = e\.template_id LEFT JOIN sequence_template_versions tv ON tv\.template_id = e\.template_id AND tv\.version = e\.template_version WHERE e\.id = \?$/,
      ([id]) => { const e = enr(id); return [e ? [{ ...e }] : []]; }],
    [/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? AND step_number = \?$/,
      ([tid, ver, n]) => [state.steps
        .filter(s => s.template_id === tid && s.version === ver && s.step_number === n)
        .map(s => ({ ...s }))]],
    [/^SELECT scheduled_time FROM scheduled_jobs WHERE sequence_enrollment_id = \? AND JSON_UNQUOTE\(JSON_EXTRACT\(data, '\$\.stepNumber'\)\) = \? ORDER BY id DESC LIMIT 1$/,
      () => [[]]],
    [/^INSERT INTO sequence_step_log \(enrollment_id, step_id, step_number, status, skip_reason, action_config_resolved, output_data, error_message, duration_ms, scheduled_at, executed_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, NOW\(\)\)$/,
      ([enrollment_id, step_id, step_number, status, skip_reason, cfg, out, error_message]) => {
        const id = 100 + state.logs.length;
        state.logs.push({ id, enrollment_id, step_number, status, skip_reason, action_config_resolved: cfg, error_message });
        return [{ insertId: id }];
      }],
    [/^UPDATE sequence_enrollments SET current_step = \?, updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { enr(id).current_step = step; return [{ affectedRows: 1 }]; }],
    [/^UPDATE sequence_enrollments SET status = 'completed', current_step = \?, completed_at = NOW\(\), updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { Object.assign(enr(id), { status: 'completed', current_step: step }); return [{ affectedRows: 1 }]; }],
  ];

  return {
    state,
    query: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(flat);
      for (const [re, fn] of handlers) if (re.test(flat)) return fn(params);
      throw new Error(`dispatchAndEscape harness: unrecognized SQL — ${flat}`);
    },
  };
}

beforeEach(() => executeJob.mockClear());

describe('executeStep — action_config cannot redirect the dispatch', () => {
  test('a `type` key inside action_config does NOT reach the executor as the job type', async () => {
    const db = makeEngineDb({
      triggerData: { case_id: 42 },
      stepConfig: {
        function_name: 'send_sms',
        params: { to: '3135551234', message: 'hi' },
        // The payload that used to win the spread and run vm code instead.
        type: 'custom_code',
        code: 'return { escaped: true };',
      },
    });

    await executeStep(db, 7, 1000, 1);

    expect(executeJob).toHaveBeenCalledTimes(1);
    const jobData = executeJob.mock.calls[0][0].data;
    expect(jobData.type).toBe('internal_function');
    expect(jobData.function_name).toBe('send_sms');
  });
});

describe('executeStep — resolved values survive the JSON round trip', () => {
  test('a quote/backslash-bearing value resolves instead of dropping the whole config', async () => {
    const db = makeEngineDb({
      triggerData: { client_name: TRICKY },
      stepConfig: {
        function_name: 'send_sms',
        params: { to: '3135551234', message: 'Hi {{trigger_data.client_name}}, your case is filed.' },
      },
    });

    const result = await executeStep(db, 7, 1000, 1);
    expect(result.status).toBe('sent');

    const sent = executeJob.mock.calls[0][0].data;
    // The whole point: the real name arrives, and no placeholder leaks.
    expect(sent.params.message).toBe(`Hi ${TRICKY}, your case is filed.`);
    expect(sent.params.message).not.toContain('{{');

    // The stored log carries the same resolved config the action received.
    const logged = JSON.parse(state_of(db).logs[0].action_config_resolved);
    expect(logged.params.message).toBe(`Hi ${TRICKY}, your case is filed.`);
  });
});

function state_of(db) { return db.state; }

describe('no dispatch payload lets config override the step type', () => {
  // The sequence bug above exists wherever a dispatch payload spreads a
  // step's config AFTER its `type`. There are exactly three such builders;
  // all must pin `type` last, or a step saved as one type executes as
  // another — which also side-steps any gate keyed on the declared type.
  // Source-level because two of the three are reached only through a route
  // or an execution row; the behavioural coverage is the sequence test above.
  const fs = require('fs');
  const SITES = [
    ['../lib/sequenceEngine.js', "type: 'internal_function'"],
    ['../lib/workflow_engine.js', 'type: step.type'],
    ['../routes/workflows.js',    'type: step.type'],
  ];

  test.each(SITES)('%s builds its jobData with type last', (rel, typeLiteral) => {
    const src = fs.readFileSync(require.resolve(rel), 'utf8');
    const builders = src.match(/const jobData = \{[\s\S]{0,200}?\};/g) || [];
    expect(builders.length).toBe(1);
    const body = builders[0];
    expect(body).toContain('...');
    // The spread must come BEFORE the type literal.
    expect(body.indexOf('...')).toBeLessThan(body.indexOf(typeLiteral));
  });

  test('both save paths refuse a `type` key in the step config', () => {
    const seq = fs.readFileSync(require.resolve('../routes/sequences.js'), 'utf8');
    const wf  = fs.readFileSync(require.resolve('../routes/workflows.js'), 'utf8');
    expect(seq).toMatch(/hasOwnProperty\.call\(action_config, 'type'\)/);
    expect(wf).toMatch(/hasOwnProperty\.call\(config, 'type'\)/);
  });
});

describe('both serialized-config call sites stay escaped', () => {
  // The preview path (POST /sequences/preview) mirrors executeStep's resolve
  // block by design, and has no dedicated runtime test here. This source guard
  // is what stops it drifting back: every resolve() over a stringified
  // action_config in the engine must pass escape:'json'.
  test('every resolve() of a serialized config in sequenceEngine passes escape', () => {
    const src = require('fs').readFileSync(require.resolve('../lib/sequenceEngine'), 'utf8');
    const calls = src.match(/await resolve\(\{[^}]*text:\s*configStr[^}]*\}\)/g) || [];
    expect(calls.length).toBe(2);           // executeStep + previewEnrollment
    for (const call of calls) expect(call).toContain("escape: 'json'");
  });
});

describe('resolverService escape option', () => {
  // refs with a trigger_data pseudo-table need no SQL at all.
  const refs = { trigger_data: { name: TRICKY } };
  const noDb = { query: async (sql) => { throw new Error(`no SQL expected — ${sql}`); } };

  test("escape:'json' keeps serialized JSON parseable and round-trips the value", async () => {
    const text = JSON.stringify({ message: 'Hi {{trigger_data.name}}' });
    const r = await resolve({ db: noDb, text, refs, strict: false, escape: 'json' });
    expect(r.unresolved).toEqual([]);
    expect(JSON.parse(r.text).message).toBe(`Hi ${TRICKY}`);
  });

  test('without the option the same substitution breaks the parse — why the option exists', async () => {
    const text = JSON.stringify({ message: 'Hi {{trigger_data.name}}' });
    const r = await resolve({ db: noDb, text, refs, strict: false });
    expect(() => JSON.parse(r.text)).toThrow();
  });

  test('plain-text callers are untouched: no escaping without the option', async () => {
    const r = await resolve({ db: noDb, text: 'Dear {{trigger_data.name}},', refs });
    expect(r.text).toBe(`Dear ${TRICKY},`);
  });

  test('an unresolved placeholder still survives as its literal token', async () => {
    const text = JSON.stringify({ message: 'Hi {{trigger_data.missing}}' });
    const r = await resolve({ db: noDb, text, refs, strict: false, escape: 'json' });
    expect(r.unresolved).toContain('{{trigger_data.missing}}');
    expect(JSON.parse(r.text).message).toBe('Hi {{trigger_data.missing}}');
  });

  test('an unsupported escape mode fails loudly rather than silently not escaping', async () => {
    // 'html' became a real mode (campaign email bodies, 2026-10-29) — any
    // other unknown mode must still throw.
    await expect(resolve({ db: noDb, text: '{{trigger_data.name}}', refs, escape: 'xml' }))
      .rejects.toThrow(/unsupported escape mode/);
  });
});
