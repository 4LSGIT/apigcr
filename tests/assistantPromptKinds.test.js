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
  sequence: 'reviewed sequence-step action is available',
  sms: 'Reviewed direct-send actions are available',
  email: 'Reviewed direct-send actions are available',
  report: 'A reviewed report-draft action is available',
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
    expect(investigatePrompt).toContain('sequence-step proposals');
    expect(investigatePrompt).toContain('and direct sends');
    expect(investigatePrompt).toContain('and report drafts');
  });
});

// Ruling 15 (Fred, 2026-10-27): "casey can use placeholder. casey can send
// SMSs and emails!!! its a bad rule to say it cant." A stage still teaching
// the old exclusion is a stage that refuses — the job-kind lesson again.
describe('ruling 15 — no stage still teaches the send exclusion', () => {
  const OLD_WORDING = [
    'any sender (SMS/email/MMS/esign)',
    'senders, webhooks, query_db',
    'senders, webhooks,\n    query_db',
    'no webhook steps, no senders',
    'never a placeholder, never invented',
    'must be a literal firm line or mailbox',
    'must be a literal firm line / mailbox the evidence shows (never a',
    'must be a LITERAL firm line number / firm mailbox',
  ];
  const stages = { answer: answerPrompt, plan: planPrompt, repair: repairPrompt, investigate: investigatePrompt };

  test('the old exclusion wording is gone from every stage', () => {
    for (const [stage, src] of Object.entries(stages)) {
      for (const phrase of OLD_WORDING) {
        expect({ stage, phrase, present: src.includes(phrase) }).toEqual({ stage, phrase, present: false });
      }
    }
  });

  test('the answer and plan stages say sends are authorable, with the per-engine sender forms', () => {
    expect(answerPrompt).toContain('Workflow sender rules');
    expect(answerPrompt).toContain('Casey MAY author sends');
    expect(answerPrompt).toContain('{{users.default_phone}} (sms) / {{users.default_email}} (email)');
    expect(planPrompt).toContain('Casey MAY author sends');
    expect(planPrompt).toContain('external sends send_sms/send_email');
    expect(repairPrompt).toContain('send_sms/send_email ARE allowed');
    expect(repairPrompt).toContain('{{users.default_phone}} (sms) / {{users.default_email}} (email)');
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
    // A18.2: a sequence-only phrase rides the sequence clause.
    expect(svc.taskDraftRequested('Add a text reminder step to the no-show sequence')).toBe(true);
    expect(svc.taskDraftRequested('Please insert an email into sequence 12 two days later')).toBe(true);
    expect(svc.taskDraftRequested('Why did the no-show sequence skip step 3?')).toBe(false);
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

// A14 (ruling 15): direct sends are taught to every stage, the forced-draft
// heuristic fires on a request to message SOMEONE but not on one addressed to
// the user, and the appointment cards' own send-forcing (course correction 3)
// is untouched — a client message is a separate send card.
describe('A14 direct sends across the stages', () => {
  const svc = require(path.join(REPO, 'services', 'assistantService'));

  test('send verbs force the draft path; questions and sends-to-me do not', () => {
    const forced = ['Text the client that her hearing moved to Tuesday', 'Send Jane Doe an email with the 341 date',
      'Email the client the hearing date', 'Please text Mike that we got his paystubs',
      'Can you email Bob Smith about the missing documents?', 'Message the debtor and remind him to sign',
      "Reply to the trustee's email", 'Write an email to the client about the 341'];
    const notForced = ['Email me the list of open cases', 'Send me the list of clients with hearings', 'Text the list to me',
      'Summarize the text messages from John', 'Find the email from the trustee about the 341',
      'What should I text the client?', 'What did the client email about?', 'Show me the last emails from Jane',
      'Who sent the last text?', 'Write a summary of the text'];
    for (const q of forced) expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: true });
    for (const q of notForced) expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: false });
  });

  test('every stage teaches sends as available, and no stage says Casey never sends', () => {
    expect(answerPrompt).toContain('Direct-send rules (A14');
    // The closed SHAPES, not just the names (a name alone appears in prose).
    expect(answerPrompt).toContain('{"kind":"sms.send.v1","contact_id":1309,"phone_id":12,"line_id":6,"message":');
    expect(answerPrompt).toContain('{"kind":"email.send.v1","contact_id":1309,"email_id":13,"mailbox_id":3,"subject":');
    expect(answerPrompt).toContain('cannot be recalled');
    expect(planPrompt).toContain('Do not refuse a request to text, email or message a client as a write');
    expect(repairPrompt).toContain('- sms.send.v1: kind,contact_id,phone_id');
    expect(repairPrompt).toContain('- email.send.v1: kind,contact_id,email_id');
    for (const [stage, src] of Object.entries({ answer: answerPrompt, plan: planPrompt, repair: repairPrompt })) {
      expect({ stage, old: /Ask Casey never sends client/.test(src) }).toEqual({ stage, old: false });
    }
  });

  test('the appointment cards still force their own sends off (course correction 3 unchanged)', () => {
    expect(answerPrompt).toMatch(/always output confirm_sms\/confirm_email false and confirm_message "" \(the server forces this\)/);
    expect(repairPrompt).toContain('confirm_sms/confirm_email/sms/email are false and confirm_message is ""');
    expect(serviceSrc).toContain('// Client SMS/email from an Ask Casey card is OFF');
  });
});

function fsRead(p) { return require('fs').readFileSync(path.join(REPO, p), 'utf8'); }

// A16 (ruling 16, Fred 2026-10-27): Casey drafts report SQL. A request to MAKE
// a report / an exportable list forces the draft path; a plain list question
// stays a read answered in chat; the answer and repair stages get the report
// appendix (schema + SQL rules) only on a report turn.
describe('A16 report drafts across the stages', () => {
  const svc = require(path.join(REPO, 'services', 'assistantService'));

  test('making / exporting a report or list forces the draft path; plain list questions do not', () => {
    const forced = ['Make a report of contacts with chapter 7 cases filed this year',
      'Can you export a list of contacts in Detroit?', 'Give me a spreadsheet of clients with 341s next month',
      'Export the contacts with no email on file', 'Please put together a CSV of open cases by stage',
      'Build me an Excel list of clients missing paystubs', 'I need a list I can download of every lead from October',
      'Save this as a report', 'Can I get a CSV of every client with a 341 this month?', 'Could we pull a report of no-shows?',
      'I need a spreadsheet of every Chapter 13 client'];
    const notForced = ['List my tasks', 'Show me the contacts in Detroit', 'Which clients have a 341 next week?',
      'What reports do we have?', 'How do locked reports work?', 'Email me the report', 'Tell me about the reports page',
      'Give me the phone number for Jane Doe', 'List the open cases for Mike'];
    for (const q of forced) {
      expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: true });
      expect({ q, report: svc.reportDraftRequested(q) }).toEqual({ q, report: true });
    }
    for (const q of notForced) expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: false });
    // The report test stands alone too (it also selects the answer appendix):
    // a question about making reports is not a request for one.
    for (const q of ['How do I make a report?', 'Can reports export to CSV?', 'What does the export button do?']) {
      expect({ q, report: svc.reportDraftRequested(q) }).toEqual({ q, report: false });
    }
  });

  test('a pronoun follow-up keeps the report noun from the conversation', () => {
    const history = [{ role: 'user', text: 'I want a report of contacts with no email' }, { role: 'assistant', text: 'Which cases?' }];
    expect(svc.reportDraftRequested('Make it chapter 13 only', history)).toBe(true);
    expect(svc.reportDraftRequested('How many are there?', history)).toBe(false);
  });

  test('the report appendix and the larger answer budget ride only report turns', () => {
    const approved = (question) => ({ question, history: [], viewer: { user_id: 7, display_name: 'S', initials: 'SS', roles: 'staff' }, workspace: null });
    const plain = svc.answerSystemAppend(approved('List my tasks'), [{ kind: 'sql.read', rows: [] }]);
    const report = svc.answerSystemAppend(approved('Make a report of contacts in Detroit'), [{ kind: 'sql.read', rows: [] }]);
    expect(plain).not.toMatch(/REPORT DRAFT RULES/);
    expect(report).toMatch(/REPORT DRAFT RULES/);
    expect(report).toMatch(/CURATED SCHEMA AND SEMANTICS/);
    expect(report).toContain("RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),4)");
    expect(svc.answerMaxTokens([{ kind: 'sql.read', rows: [] }], approved('List my tasks'))).toBeUndefined();
    expect(svc.answerMaxTokens([{ kind: 'sql.read', rows: [] }], approved('Make a report of contacts in Detroit'))).toBeGreaterThanOrEqual(8000);
  });

  test('every stage teaches the kind, and the answer stage may emit SQL only in its sql field', () => {
    expect(answerPrompt).toContain('{"kind":"report.draft.v1","title":"1-150 chars"');
    expect(answerPrompt).toContain('Do not output SQL (except the sql field of a report.draft.v1 action_draft)');
    expect(repairPrompt).toContain('- report.draft.v1: kind,title,category,description,sql,params,columns_meta,caveats,row_limit,evidence');
    expect(planPrompt).toContain('Do not refuse a request to make, save or export a report');
    expect(planPrompt).toContain('ALWAYS return a query plan for a report request');
  });
});
