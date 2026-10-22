'use strict';
/**
 * tests/assistantPromptKinds.test.js
 *
 * Every shipped action kind must be taught to EVERY model stage, not just the
 * answerer. Shipped bug this pins (safe-mode S3, 2026-10-22): the job kind was
 * added to the ANSWER prompt only, so the PLANNER — whose prompt enumerates
 * the reviewed families and says "Unlisted writes remain unavailable" —
 * refused "schedule a job" before the answer stage ever saw it. Casey told
 * Fred the capability did not exist an hour after it landed; one turn later a
 * manual-search hit made it claim the opposite, and the next planning pass
 * refused again. A kind the planner does not know is a kind that flip-flops.
 *
 * The kind sets are read from services/assistantService.js SOURCE (they are
 * module-private), the same structural-read idiom as the codeStepGate suite's
 * route table. If a set is added or a kind renamed, these assertions chase it.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const serviceSrc = read('services/assistantService.js');
const answerPrompt = read('lib/aiPrompts/assistantAnswer.js');
const planPrompt = read('lib/aiPrompts/assistantPlan.js');
const repairPrompt = read('lib/aiPrompts/assistantTaskDraftRepair.js');
const investigatePrompt = read('lib/aiPrompts/assistantInvestigate.js');

// Every `const *_ACTION_KINDS = new Set([...])` in the service, flattened.
function shippedKinds() {
  const kinds = [];
  const sets = [...serviceSrc.matchAll(/const\s+\w+_ACTION_KINDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/g)];
  expect(sets.length).toBeGreaterThanOrEqual(5);
  for (const m of sets) kinds.push(...[...m[1].matchAll(/'([a-z_.]+\.v\d+)'/g)].map((k) => k[1]));
  return kinds;
}

// The plan prompt teaches FAMILIES in prose, not kind ids, so each kind maps
// to the family bullet's marker phrase. A kind whose prefix has no entry here
// means a new family landed without a plan-prompt bullet — add both.
const PLAN_FAMILY_MARKERS = {
  task: 'Reviewed task actions are available',
  event: 'Reviewed event actions are available',
  appt: 'Reviewed appointment actions are available',
  contact: 'Reviewed contact phone, email, and address subrecord actions are available',
  job: 'reviewed safe code job action is available',
  workflow: 'reviewed workflow-draft action is available',
  hook: 'reviewed hook action is available',
};

describe('every shipped action kind is taught to every model stage', () => {
  const kinds = shippedKinds();

  test('the kind inventory is sane', () => {
    expect(kinds).toContain('task.create.v1');
    expect(kinds).toContain('job.code_safe.create.v1');
    expect(kinds.length).toBeGreaterThanOrEqual(27);
  });

  test('the ANSWER prompt names every kind literally', () => {
    for (const kind of kinds) {
      expect({ kind, taught: answerPrompt.includes(kind) }).toEqual({ kind, taught: true });
    }
  });

  test('the REPAIR prompt names every kind literally', () => {
    for (const kind of kinds) {
      expect({ kind, taught: repairPrompt.includes(kind) }).toEqual({ kind, taught: true });
    }
  });

  test('the PLAN prompt carries every family\'s availability bullet', () => {
    for (const kind of kinds) {
      const family = kind.split('.')[0];
      const marker = PLAN_FAMILY_MARKERS[family];
      expect({ kind, hasMarker: !!marker }).toEqual({ kind, hasMarker: true });
      expect({ family, taught: planPrompt.includes(marker) }).toEqual({ family, taught: true });
    }
  });

  test('the ACTION LEDGER accepts every kind — it is a registry too, found the hard way', () => {
    // Third enumeration, third live failure (2026-10-22): the P5 ledger's
    // KINDS map is built from template literals, so the arc-wide grep for the
    // kind strings never saw it, and issue() refused the job kind at proposal
    // time with 'Unavailable action kind' — AFTER the prompts and normalizer
    // all knew it. Inventory by the claim, not the literal.
    const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
    for (const kind of kinds) {
      expect({ kind, inLedger: ledger.KINDS.has(kind) }).toEqual({ kind, inLedger: true });
      expect(typeof ledger.KINDS.get(kind)).toBe('string');
    }
  });

  test('the INVESTIGATE prompt does not enumerate families more narrowly than the plan', () => {
    // It only needs to not contradict: the old text said "task or event
    // proposal", which read as an exhaustive list to the model.
    expect(investigatePrompt).toContain('task, event, appointment, contact subrecord, or safe code job');
  });
});

describe('a job request forces the draft-required path like the other families', () => {
  const svc = require(path.join(REPO, 'services', 'assistantService'));

  test('scheduling a job is a forced-draft request; asking about jobs is not', () => {
    expect(svc.taskDraftRequested('Schedule a job in 10 minutes that computes X from input Y')).toBe(true);
    expect(svc.taskDraftRequested('Please set up a job tonight to total these amounts')).toBe(true);
    expect(svc.taskDraftRequested('What jobs are scheduled for tonight?')).toBe(false);
    expect(svc.taskDraftRequested('Build a workflow that chases missing documents')).toBe(true);
    expect(svc.taskDraftRequested('What does workflow 27 do?')).toBe(false);
    // A hook-only phrase (no other family noun), so the hook clause itself is
    // what passes it — 'make a hook for workflow 27' would ride the workflow
    // clause and prove nothing.
    expect(svc.taskDraftRequested('Set up a hook for inbound site form submissions')).toBe(true);
    expect(svc.taskDraftRequested('What hooks do we have?')).toBe(false);
  });
});

describe('a direct planner answer cannot swallow an action request (chat-27 live bug, 2026-10-22)', () => {
  // The planner's {"action":"answer"} shape has NO action_draft slot: only the
  // execute flow's answer stage can emit (and repair) the reviewed card. The
  // prompt says always plan for an action request; this pins the SERVER
  // backstop that converts a direct answer into a one-step carrier plan when
  // the model skips the rule — found live as two confident, cardless
  // "approve it through the review card" answers.
  const svc = require(path.join(REPO, 'services', 'assistantService'));
  const aiService = require(path.join(REPO, 'services', 'aiService'));
  const staffDb = () => ({
    query: jest.fn().mockResolvedValue([[{ user: 7, user_name: 'Stuart Sandweiss', user_initials: 'SS', roles: 'staff' }]]),
  });
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'prompt-kinds-test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });
  afterEach(() => jest.restoreAllMocks());

  test('an action request the planner answers directly becomes a carrier plan with a ticket', async () => {
    jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 1,
      json: { action: 'answer', answer: 'Here is a job you can approve on the review card.' } });
    const made = await svc.plan(staffDb(), {
      question: 'Schedule a job in 10 minutes that computes X from input Y', history: [], userId: 7 });
    expect(made.outcome).toBe('plan');
    expect(made.steps).toHaveLength(1);
    expect(made.steps[0]).toMatchObject({ kind: 'automation.list' });
    expect(typeof made.ticket).toBe('string');
    expect(made.ticket.length).toBeGreaterThan(20);
  });

  test('a plain question keeps the direct answer', async () => {
    jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 1,
      json: { action: 'answer', answer: 'That date is a Thursday.' } });
    const made = await svc.plan(staffDb(), {
      question: 'What day of the week is 2026-11-05?', history: [], userId: 7 });
    expect(made.outcome).toBe('answer');
    expect(made.answer).toBe('That date is a Thursday.');
  });

  test('the plan prompt no longer invites the cardless path for jobs', () => {
    const planPrompt = fsRead('lib/aiPrompts/assistantPlan.js');
    expect(planPrompt).not.toMatch(/action=answer directly/);
    expect(planPrompt).toMatch(/ALWAYS return a query plan for a safe-code-job request/);
  });
});

function fsRead(p) { return require('fs').readFileSync(path.join(REPO, p), 'utf8'); }
