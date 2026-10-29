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
  case: 'Reviewed case notes, case alerts and contact notes actions are available',
  job: 'reviewed safe code job action is available',
  workflow: 'reviewed workflow-draft action is available',
  hook: 'reviewed hook action is available',
  sequence: 'reviewed sequence-step action is available',
  sms: 'Reviewed direct-send actions are available',
  email: 'Reviewed direct-send actions are available',
  report: 'A reviewed report-draft action is available',
  ingest_rule: 'Reviewed ingest-rule actions are available',
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
    expect(investigatePrompt).toContain('ingest-rule proposals');
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

// A18.3: the sequence-step bullet used to say "publishing a sequence ... not
// available"; a stage still saying so refuses the new kind (the job lesson).
describe('A18.3 — every stage teaches sequence publish, none still excludes it', () => {
  test('the plan carries its own publish bullet and drops the old exclusion', () => {
    expect(planPrompt).toContain('A reviewed sequence publish action is available');
    expect(planPrompt).not.toContain('publishing a sequence');
  });
  test('the answer stage states the stricter class rule and that running enrollments stay put', () => {
    expect(answerPrompt).toContain('Sequence publish rules (A18.3');
    expect(answerPrompt).toContain('content-only means only an action_config change on\n    an unchanged sms/email/task step');
    expect(answerPrompt).toContain('enrollments already running STAY on their version');
  });
});

// A17.7: the workflow family marker in PLAN_FAMILY_MARKERS is the draft
// bullet, so start needs its own pin — a planner that only knows drafting and
// publishing refuses "start the workflow" (the job lesson).
describe('A17.7 — every stage teaches workflow start, published-only and inputless', () => {
  test('the plan carries its own start bullet', () => {
    expect(planPrompt).toContain('A reviewed workflow start action is available');
  });
  test('the answer and repair stages teach published-only, no input, and the standard-code refusal', () => {
    expect(answerPrompt).toContain('Workflow start rules (A17.7');
    expect(answerPrompt).toContain('PUBLISHED VERSION ONLY: never a draft — there is no use_draft key');
    expect(answerPrompt).toContain('NO INPUT: the run starts with empty input');
    expect(repairPrompt).toContain('no use_draft, init_data, contact_id or input key');
  });
});

// A18.4b: the sequence family marker is the step bullet, which used to say
// "enrolling a contact are not available" — a stage still saying so refuses
// the new kind (the job lesson), so the exclusion must be gone everywhere.
describe('A18.4b — every stage teaches sequence enroll, contact-scoped and dataless', () => {
  test('the plan carries its own enroll bullet and drops the old exclusion', () => {
    expect(planPrompt).toContain('A reviewed sequence enroll action is available');
    expect(planPrompt).not.toContain('enrolling a contact are not available');
  });
  test('the answer and repair stages teach both evidence ids, no trigger data, and the published version', () => {
    expect(answerPrompt).toContain('Sequence enroll rules (A18.4b');
    expect(answerPrompt).toContain('Evidence is REQUIRED and must carry BOTH ids');
    expect(answerPrompt).toContain('CONTACT-SCOPED ONLY, NO TRIGGER DATA');
    expect(repairPrompt).toContain('no trigger_data, payload, input, appt_id,\n  signing_request_id, case_id or template_type key');
  });
});

// A6: the relation/role kinds share the `contact` prefix with A5, so the
// family marker above cannot see a stage that forgot them. The plan's own
// bullet must exist and the old "relations/roles" exclusion must be gone from
// the A5 bullet (a stage still excluding them refuses — the job lesson).
describe('A6 — every stage teaches contact relations and roles, and the contact.relations read', () => {
  test('the plan carries its own bullet and the A5 bullet no longer excludes relations/roles', () => {
    expect(planPrompt).toContain('Reviewed contact relation and role actions are available');
    expect(planPrompt).not.toContain('relations/roles, or scalar contact edits');
    expect(planPrompt).toContain('Ending, removing, deactivating or reactivating a relationship');
  });
  test('the investigate stage names the read and the proposal family', () => {
    expect(investigatePrompt).toContain('contact relation / role proposals, which need a contact.relations read');
    // In each stage's "Available kinds" list itself, not only in prose (a
    // stage whose list omits a kind treats it as nonexistent).
    expect(investigatePrompt).toContain('- Available kinds are sql.read, manual.search, comms.search, weather.lookup, contact.relations ({"contact_id"}');
    expect(planPrompt).toContain('Available kinds are sql.read, manual.search, comms.search, weather.lookup,\n  contact.relations ({"contact_id":N}');
  });
  test('the answer and repair stages teach direction, the registry, and the deferred remove', () => {
    expect(answerPrompt).toContain('Contact relation and role rules (A6');
    expect(answerPrompt).toContain('for parent_child contact_a is the PARENT');
    expect(answerPrompt).toContain('type_code / role / status MUST be values from those registry rows');
    expect(answerPrompt).toContain('Ending, deactivating, reactivating or deleting\n    a relation, changing its type');
    expect(repairPrompt).toContain('changes allows ONLY status,start_date,notes');
    expect(repairPrompt).toContain('attrs is the COMPLETE\n  replacement object');
  });
});

// A7 group A: the 'contact' prefix again (contact.notes) plus a new 'case'
// family. Each stage must teach the append-vs-value semantics — a stage that
// thinks "value" is a patch writes a partial note over the whole field.
describe('A7 — every stage teaches case notes / alerts and contact notes, and append vs value', () => {
  test('the plan carries its own bullet and the A5 bullet no longer excludes every scalar contact edit', () => {
    expect(planPrompt).toContain('Reviewed case notes, case alerts and contact notes actions are available');
    expect(planPrompt).toContain('or other scalar contact edits (relations and roles, and contact notes, have their own bullets below)');
    expect(planPrompt).not.toContain('or scalar contact edits (relations and roles are the next bullet)');
  });
  test('the investigate stage names the proposal family', () => {
    expect(investigatePrompt).toContain('case notes / case\n  alerts / contact notes proposals, which need a row carrying the exact case_id or contact_id');
  });
  test('the answer and repair stages teach value XOR append, the complete-text rule, and the caps', () => {
    expect(answerPrompt).toContain('Case notes, case alerts and contact notes rules (A7');
    expect(answerPrompt).toContain('Never send a partial value');
    expect(answerPrompt).toContain('Contact notes belong to the CONTACT, not a case');
    expect(answerPrompt).toContain('case-and-contact-notes');
    expect(repairPrompt).toContain('case.notes.update.v1 / case.alerts.update.v1: kind,case_id,(value XOR append),evidence');
    expect(repairPrompt).toContain('contact.notes.update.v1: kind,contact_id,(value XOR append),evidence');
  });
});

// A8: the 'case' prefix again (case.contact), so the generic family-marker
// check above sees only the A7 bullet — this block pins A8's own bullet and
// that every stage teaches the refusals (a stage that does not know them
// proposes a portal demotion the server then refuses, every time).
describe('A8 — every stage teaches case contact membership and its refusals', () => {
  test('the plan carries its own bullet with the case_relate read', () => {
    expect(planPrompt).toContain('Reviewed case contact actions are available');
    expect(planPrompt).toContain('case_relate_id, case_relate_case_id AS case_id');
    expect(planPrompt).toContain('never demotes below Secondary or removes\n  a contact who has used the client portal');
  });
  test('the investigate stage names the proposal family', () => {
    expect(investigatePrompt).toContain('and case contact proposals, which need the case\'s case_relate rows with\n  case_relate_id');
  });
  test('the answer and repair stages teach the evidence, the explicit role and the portal / Primary / last-contact refusals', () => {
    expect(answerPrompt).toContain('Case contact rules (A8');
    expect(answerPrompt).toContain('relate_type is always explicit');
    expect(answerPrompt).toContain('demoting a contact who has used the client\n    portal from Primary/Secondary to Other/Bystander');
    expect(answerPrompt).toContain('any other contact may be demoted or removed and the card warns that\n    they lose portal sight of the case once the portal is live');
    expect(answerPrompt).toContain('demoting or removing the case\'s ONLY Primary');
    expect(answerPrompt).toContain('removing the case\'s last contact');
    expect(answerPrompt).toContain('case-and-contact-notes/case-contact/case-pipeline/direct-send');
    expect(repairPrompt).toContain('evidence is the\n  case_relate row carrying the exact case_relate_id');
    expect(repairPrompt).toContain('refuse a contact who has used the client portal leaving\n  Primary/Secondary');
  });
});

// A9: the 'case' prefix a third time (case.pipeline), so this block pins A9's
// own bullet and that every stage teaches the refusals — above all that there
// is NO override pathway and an unmet requirement is repeated, never
// summarized (a stage that does not know it proposes an override key the
// server then refuses, every time).
describe('A9 — every stage teaches the pipeline cards, the unmet-requirement refusal and the absent override', () => {
  test('the plan carries its own bullet and no longer lists stage as a field edit', () => {
    expect(planPrompt).toContain('Reviewed case pipeline actions are available');
    expect(planPrompt).toContain('refuses — and the answer says why — any move that would pass over a REQUIRED step not done or N/A (Casey cannot\n  override a requirement');
    expect(planPrompt).toContain('No other case or contact field is editable by Casey (status, dates,');
    expect(planPrompt).toContain("a case's pipeline STAGE moves only through the pipeline actions below, never as a field edit");
  });
  test('the investigate stage names the proposal family', () => {
    expect(investigatePrompt).toContain('and case pipeline proposals, which need only a\n  row carrying the exact case_id');
  });
  test('the answer and repair stages teach the destination, the evidence and every refusal', () => {
    expect(answerPrompt).toContain('Case pipeline rules (A9');
    expect(answerPrompt).toContain('the server picks it; never name one');
    expect(answerPrompt).toContain('a move that would pass over a REQUIRED step\n    that is not done or N/A (the refusal lists every such step word for word — repeat them all, never summarize them\n    away)');
    expect(answerPrompt).toContain('Casey has NO override pathway');
    expect(answerPrompt).toContain('moving a case onto ANOTHER pipeline');
    expect(answerPrompt).toContain('A case\'s pipeline STAGE moves only through the pipeline kinds below.');
    expect(answerPrompt).not.toContain('(status, stage, dates');
    expect(repairPrompt).toContain('the destination is the case\'s NEXT stage (never named)');
    expect(repairPrompt).toContain('never template_id, stage_id or any override / skip / force / requirement key (each\n  is refused by name)');
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
    // A17.7: a start request rides the workflow clause; a question about a run does not.
    expect(svc.taskDraftRequested('Start the daily appointment report workflow')).toBe(true);
    expect(svc.taskDraftRequested('Kick off workflow 5 now please')).toBe(true);
    expect(svc.taskDraftRequested('Run the workflow called daily report')).toBe(true);
    expect(svc.taskDraftRequested('Explain why workflow 5\'s last run failed')).toBe(false);
    expect(svc.taskDraftRequested('When did the workflow last run?')).toBe(false);
    // A18.3: publishing a sequence rides the same clause; asking about one does not.
    expect(svc.taskDraftRequested('Publish the no-show sequence')).toBe(true);
    expect(svc.taskDraftRequested('Make it live — sequence 12 is ready')).toBe(true);
    expect(svc.taskDraftRequested('When was the no-show sequence last published?')).toBe(false);
    // A20.2 / A20.3: ingest-rule-only phrases ride the ingest clause; a bare
    // "rule" (trigger rules are explain-only) and questions do not.
    for (const q of ['Create an email rule that forwards court notices to Shoshana', 'Turn off the phone rule for 202',
      'Deactivate the inbox rule for Clio payments', 'Make a rule for incoming emails from the trustee',
      'Please rename ingest rule 12 to Court notices']) {
      expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: true });
    }
    for (const q of ['What does email rule 12 do?', 'Why did the ingest rule not match?', 'Show me the phone rules',
      'Change the trigger rule for new cases']) {
      expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: false });
    }
    // A6: relation- and role-only phrases (no contact/phone/task noun) ride
    // the new clauses; questions, and a bare trustee/judge case edit, do not.
    for (const q of ['Record Dana as Sam\'s spouse', 'Link Acme Corp as the employer of Dana Client',
      'Add Ruth as the guarantor for Boaz', 'Make Jane Smith a trustee for chapter 13 — add the role',
      'Add Judge Lee as a judge with suffix abc', 'Update relationship 44 to say separated']) {
      expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: true });
    }
    for (const q of ['Who is Dana\'s spouse?', 'Is Acme the employer of Dana?', 'Show me Dana\'s relationships',
      'Update the trustee on case 25-12345', 'What roles does Jane have?']) {
      expect({ q, forced: svc.taskDraftRequested(q) }).toEqual({ q, forced: false });
    }
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
// the user, and the appointment cards carry their own client confirmation
// under the same bar (off unless asked; an opted-out channel refuses — an
// automation send never acknowledges).
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

  test('ruling 17: every stage lets Casey propose a send to an opted-out NUMBER (the card warns, the user confirms); none forbids it', () => {
    expect(answerPrompt).toContain('A number that OPTED OUT of texts may still be proposed when the user');
    expect(answerPrompt).toContain('the card shows the opt-out up front and sends only after');
    expect(planPrompt).toContain('A number opted out of texts');
    expect(repairPrompt).toContain('an opted-out number is allowed (the card shows it and the user confirms past it)');
    for (const [stage, src] of Object.entries({ answer: answerPrompt, plan: planPrompt, repair: repairPrompt })) {
      expect({ stage, old: /never propose a send to an opted-out|never to an opted-out/.test(src) }).toEqual({ stage, old: false });
    }
  });

  test('YisraMail D18: every stage teaches that an email opt-out covers marketing only, and none calls the row flag the only consent field', () => {
    expect(answerPrompt).toContain('An email opt-out covers marketing only: it never blocks or warns on a direct email.');
    expect(answerPrompt).toContain('an email opt-out covers marketing only and never blocks the email one');
    expect(planPrompt).toContain('An email opt-out covers marketing only: a direct email is never blocked or warned by it.');
    expect(planPrompt).toContain('an email opt-out covers marketing only and never blocks it');
    expect(repairPrompt).toContain('an email opt-out covers marketing only and never stops this');
    for (const [stage, src] of Object.entries({ answer: answerPrompt, plan: planPrompt, repair: repairPrompt })) {
      expect({ stage, old: /the only consent (field|flag)|the row's flag is the only/.test(src) }).toEqual({ stage, old: false });
    }
  });

  test('appointment confirmations are taught to every stage: off by default, resolved on the card, opt-out refuses', () => {
    expect(answerPrompt).toContain('Client confirmation (create, cancel, reschedule): OFF by default');
    expect(answerPrompt).toContain('https://4lsg.com/m/{{appts.appt_manage_token|default:}}');
    expect(answerPrompt).toContain('never acknowledge past it here');
    expect(repairPrompt).toContain('stays false with confirm_message "" unless the user');
    expect(repairPrompt).toContain('{{appts.appt_manage_token|default:}}');
    expect(planPrompt).toContain('Create, cancel and reschedule can also send the client a');
    for (const [stage, src] of Object.entries({ answer: answerPrompt, plan: planPrompt, repair: repairPrompt })) {
      expect({ stage, old: /the server forces this|Appointment cards never send their own client|An appointment card never\s+sends its own client/.test(src) })
        .toEqual({ stage, old: false });
    }
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
    expect(repairPrompt).toContain('- report.draft.v1: kind,title,category,description,sql,params,columns_meta,caveats,row_limit,viz?,evidence');
    expect(planPrompt).toContain('Do not refuse a request to make, save or export a report');
    // The chart hint: taught in the shape and in the appendix, with the Reports enum.
    expect(answerPrompt).toContain('"viz":{"type":"table"} or e.g. {"type":"bar","x":"<label column>","y":"<number column>"} (optional)');
    const appendix = require(path.join(REPO, 'lib', 'aiPrompts', 'assistantReportDraft')).REPORT_DRAFT_APPENDIX;
    expect(appendix).toContain('table | bar | line | area | pie | doughnut | combo | stat (figures)');
    expect(appendix).toContain('y / series keys must be NUMBER columns');
    expect(planPrompt).toContain('ALWAYS return a query plan for a report request');
  });
});
