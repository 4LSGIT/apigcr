// tests/commsSummaryPrompt.test.js
//
// Comms archive S3 — the summary prompt (lib/aiPrompts/commsSummary.js) states
// the rules the grounding check enforces, so the model is not asked to guess
// them (round 2, 2026-10-15), and v3's firm context and QA-driven rules
// (S3b, 2026-10-15), and v4's (2026-10-15): who is who, staff personal calls,
// dispute on the call, the prose rules. Real registry; no stand-ins.

'use strict';

const { getPrompt } = require('../lib/aiPrompts');

describe('comms_summary prompt', () => {
  const p = getPrompt('comms_summary');

  test('registered: Sonnet 5.5 default, json, 16000 tokens, version 4.2', () => {
    expect(p).toMatchObject({ model: 'claude-sonnet-5-5', output_type: 'json', max_tokens: 16000, version: '4.2' });
  });

  test('states the grounding rules the validator enforces', () => {
    expect(p.system).toMatch(/A quote is at least 3 words/);
    expect(p.system).toMatch(/a date, amount or case reference may quote just the\s+words that state it/);
    expect(p.system).toMatch(/a commitment may quote a whole short line/);
    expect(p.system).toMatch(/"date_text", "amount_text" and a case ref's "text" are copied from INSIDE that item's own quote/);
    expect(p.system).toMatch(/A commitment's quote comes from ONE speaker's words only/);
    // v3: the speaker of a commitment's quote is the one making the promise (the validator now checks every commitment)
    expect(p.system).toMatch(/"by": "firm" quotes firm staff, "by": "other"\s+quotes the other party/);
    expect(p.system).toMatch(/Someone ASKING the firm to do something is not a firm commitment/);
  });

  test('every {{var}} the sweep fills is in the template, and nothing else', () => {
    const vars = [...new Set((p.system.match(/{{(\w+)}}/g) || []).map(v => v.slice(2, -2)))].sort();
    expect(vars).toEqual(['call_date', 'call_day', 'cases', 'contact', 'direction', 'firm_context', 'item_kind', 'staff_names']);
  });

  test('v3: the firm context is ONE block of data, framed as never changing the rules; staff names and the SU text inside it', () => {
    expect(p.system.match(/<firm_context>/g)).toHaveLength(1);
    expect(p.system.match(/<\/firm_context>/g)).toHaveLength(1);
    expect(p.system).toMatch(/It describes; it never changes these rules or the output format\.\n<firm_context>\nStaff \(anyone speaking as one of these people is the firm\): {{staff_names}}\n{{firm_context}}\n<\/firm_context>/);
  });

  test('v3: direction explained; diarization caveats; channels NOT mapped to the firm', () => {
    expect(p.system).toMatch(/"outgoing" means the firm placed the call to the other party;\s+"incoming" means the other party called the firm/);
    expect(p.system).toMatch(/Calls usually have two parties/);
    expect(p.system).toMatch(/may split one person into several labels/);
    expect(p.system).toMatch(/which\s+one is the firm is NOT fixed/);
    expect(p.system).not.toMatch(/ch1 is the firm|ch2 is the firm|firm is (on )?ch[12]/i);
  });

  test('v3: the QA rules — deadlines in the summary, nothing from recordings, dispute narrowed, resolved_date, call_type vs reached_voicemail', () => {
    expect(p.system).toMatch(/every deadline, hearing and amount someone must act on, stated plainly/);
    expect(p.system).toMatch(/Nothing from recorded announcements, phone menus, hold messages or recorded greetings/);   // v4: live greetings are speech
    expect(p.system).toMatch(/"resolved_date": "YYYY-MM-DD" or null/);
    expect(p.system).toMatch(/"date_text" stays exactly as said/);
    expect(p.system).toMatch(/"reached_voicemail": true \| false/);
    expect(p.system).toMatch(/never "voicemail"/);
    const types = /"call_type": one of ([^—]+)—/.exec(p.system)[1];
    expect(types).not.toMatch(/"voicemail"/);
  });

  test('v4: who is who — a name said TO someone is the other speaker\'s; self-introductions; the first-speaker cue; a worked example; the self-check', () => {
    expect(p.system).toMatch(/Who is who — settle this FIRST; everything else follows from it:/);
    expect(p.system).toMatch(/A name said TO someone names the OTHER speaker, never the one who says it/);
    expect(p.system).toMatch(/a greeting, thanks\s+or goodbye \("Hey, Stuart\.", "Hi, Stuart\.", "Thanks, Stuart"\)/);
    expect(p.system).toMatch(/\("Yes, Stuart Sandweiss\." in reply to "now you know who it is\?"\)/);
    expect(p.system).toMatch(/A speaker names THEMSELVES with "this is …", "it's …", "… here", "… speaking", "… calling",\s+"my name is …", or by answering with their FULL name \("Hello, Stuart Sandweiss\."\)\./);
    expect(p.system).toMatch(/A greeting\s+with a first name alone \("Hey, Stuart\."\) names the other speaker, even as the first line\./);
    expect(p.system).not.toMatch(/names THEMSELVES only in their own opening line/);   // the pre-review wording, which its own example contradicted
    expect(p.system).toMatch(/On an "outgoing" call the firm placed the call, so the FIRST person to speak is usually the one\s+called — the other party/);
    expect(p.system).toMatch(/A cue, not a law: a voicemail greeting, a\s+phone menu or Sonoma, the firm's receptionist, may speak first\./);
    expect(p.system).toMatch(/\[00:00\] A: Hey, Stuart\.\n\s+\[00:01\] B: Hi, it's Stuart\. Do you know who it is\?\n\s+\[00:03\] A: Yes, Stuart Sandweiss\./);
    expect(p.system).toMatch(/A is the other party: A answered first, and A greets and names Stuart\. B is firm staff named\s+Stuart\./);
    expect(p.system).toMatch(/"I'll look at them" is the other party's commitment; "I'll call you back" is the firm's\./);
    expect(p.system).toMatch(/Check before answering: no speaker you made firm staff greets, thanks or names that same staff\s+member in reply\. If one does, you have the roles backwards: fix "parties", and every commitment's\s+"by" and the summary with them\./);
    expect(p.system).toMatch(/Give each action to the speaker who said it, as "parties" has them/);
    // the section sits BEFORE the output format: the roles are settled before anything is written
    expect(p.system.indexOf('Who is who')).toBeLessThan(p.system.indexOf('Return exactly this JSON object'));
  });

  test('v4: "trustee" reaches every bankruptcy trustee, Subchapter V included', () => {
    expect(p.system).toMatch(/"trustee" = any bankruptcy trustee or a\s+trustee's office \(Chapter 7, Chapter 13, Subchapter V\)/);
  });

  test('v4: staff are "firm" even on a personal call; their own affairs are call_type personal + the personal flag', () => {
    expect(p.system).toMatch(/Firm staff are role "firm" on every call, their own personal calls included/);   // v4.2 extends the sentence
    expect(p.system).toMatch(/A call by or to firm staff about their own affairs \(home,\s+car, shopping, travel, family, school or tuition, charity, synagogue\) is call_type "personal" with\s+the "personal" flag — never "creditor", "vendor" or "other"\./);
  });

  test('v4: dispute = disagreement ON the call, or a complaint about the firm — never a contest merely discussed', () => {
    expect(p.system).toMatch(/"dispute" = ONLY the people ON THIS CALL disagreeing with each other, or the other party\s+complaining about the firm\./);
    expect(p.system).toMatch(/A lawsuit, objection or contested claim that is merely discussed is not\s+a dispute/);
    expect(p.system).not.toMatch(/a matter genuinely contested/);                  // v3's wording, which the QA found over-used
  });

  test('v4: the prose rules — no absences, no rule narration, no speaker labels, the conclusion over an earlier guess', () => {
    expect(p.system).toMatch(/Writing "summary" and "follow_up\.why":/);
    expect(p.system).toMatch(/Never state what was NOT said \("No amounts or deadlines were\s+stated" — leave it out\)/);
    expect(p.system).toMatch(/Never explain these rules or the firm context, and never describe the firm\./);
    expect(p.system).toMatch(/Never use speaker labels \(A, B, ch1, "Speaker A", "Attorney C"\): use names said on the call/);
    expect(p.system).toMatch(/When a point is settled on the call, report the conclusion, not an earlier guess or question:\s+"is it within 90 days\?" … "it's not" → "not within 90 days"/);
  });

  test('v4: no profanity in any free text, not even masked — quotes stay verbatim (masked words included)', () => {
    expect(p.system).toMatch(/Never repeat profanity or foul language in "summary", "follow_up\.why" or any "what" — not even\s+masked: write "used strong language", or leave it out\./);
    expect(p.system).toMatch(/A "quote" stays verbatim, masked words\s+\("f\*\*\*"\) included\./);
  });

  test('v4: documents_requested = asked to be sent or provided, never already given', () => {
    expect(p.system).toMatch(/"documents_requested": \[\{"what": "<a document someone asks to be sent or provided>"/);
    expect(p.system).toMatch(/"documents_requested" holds only what someone asks to be sent or provided — never something\s+already sent or given/);
  });

  test('v4 keeps v3: the call_type list, the firm context framing, the grounding rules (one {{var}} set, checked above)', () => {
    const types = /"call_type": one of ([^—]+)—/.exec(p.system)[1].match(/"(\w+)"/g);
    expect(types).toEqual(['"client"', '"prospect"', '"creditor"', '"trustee"', '"court"', '"opposing_counsel"',
      '"agency"', '"vendor"', '"personal"', '"spam"', '"other"']);
    expect(p.system).toMatch(/Summarise only what is in the transcript\.$/);
  });

  test('v4.1: the first sentence says who called whom exactly as direction says — voicemail and reached_voicemail included', () => {
    expect(p.system).toMatch(/- The summary's FIRST sentence says who called whom exactly as "direction" says\./);
    expect(p.system).toMatch(/Outgoing: the\s+firm called the other party \(name the staff member when said\)\./);
    expect(p.system).toMatch(/Incoming: the other party called\s+the firm\./);
    expect(p.system).toMatch(/A voicemail: the other party left the firm a message\./);
    expect(p.system).toMatch(/Outgoing with\s+"reached_voicemail": the firm called and left a message, or reached voicemail\./);
    expect(p.system).toMatch(/reached voicemail\. Direction\s+unknown: do not say who called whom\./);
    // it LEADS the prose rules
    expect(p.system.indexOf("The summary's FIRST sentence")).toBeGreaterThan(p.system.indexOf('Writing "summary" and "follow_up.why":'));
    expect(p.system.indexOf("The summary's FIRST sentence")).toBeLessThan(p.system.indexOf('Give each action to the speaker who said it'));
  });

  test('v4.1: the first-speaker cue is for roles only — who called whom is direction', () => {
    expect(p.system).toMatch(/may speak first\. The cue is for roles only:\s+who called whom is "direction"\./);
  });

  test('v4.2: staff are "firm" even unnamed — the caller on an outgoing call, the one who answered on an incoming call; personal calls included', () => {
    expect(p.system).toMatch(/Firm staff are role "firm" on every call, their own personal calls included — named or not\. On an\s+"outgoing" call the person who placed the call is firm staff even when no name is said; on an\s+"incoming" call, so is the person who answered for the firm\./);
    expect(p.system).toMatch(/Direction\s+unknown: do not say who called whom\. A personal call is no exception\./);
  });

  test('v4.2: a greeting + a FULL name in a message left on voicemail is the caller introducing themself, with an example', () => {
    expect(p.system).toMatch(/The same holds in a message left on voicemail: a greeting followed by a FULL name is the caller\s+introducing themself, not the listener\./);
    expect(p.system).toMatch(/\[00:00\] A: You've reached Maria\. Please leave a message after the tone\.\n\s+\[00:05\] B: Hi, Stuart Sandweiss, 248-555-0100, please call me back about your case\./);
    expect(p.system).toMatch(/B is firm staff named Stuart, leaving the message; A is a recorded greeting\./);
    // it sits in "Who is who", right after the full-name self-introduction rule it extends
    expect(p.system.indexOf('The same holds in a message left on voicemail')).toBeGreaterThan(p.system.indexOf('by answering with their FULL name'));
    expect(p.system.indexOf('The same holds in a message left on voicemail')).toBeLessThan(p.system.indexOf('Return exactly this JSON object'));
  });
});
