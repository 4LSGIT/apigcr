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
  });
});
