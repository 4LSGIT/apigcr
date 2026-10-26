'use strict';
// A17.3 — the functions Casey may put in a workflow DRAFT it authors, each
// with its side-effect class. This is the plan's "A17 needs its own allowlist
// with a side-effect class per function": __meta records no side-effect class
// for any of the 104 registry functions, and the CTA-eligible set is far too
// wide to stand in for one.
//
// DELIBERATELY SMALL. Casey explains every function (A17.0); it AUTHORS only
// these. Excluded by construction (plan, "What Casey cannot author"): the
// other external senders (send_mms — its attachment_url is fetched at send
// time — forwards, digests, esign senders); generic writes (update_db /
// insert_db / set_setting); chaining fan-out (start_workflow, enroll_sequence,
// cancel_sequences); create_cta (mints public bearer links); record mutations
// (update_case, update_contact, advance_stage, update_log); external-surface
// writes (gcal_*, dropbox_*, intake_*); ops sweeps; and query_db, which is
// A17.4a's own bounded slice. Adding a function here is a deliberate
// 30-second review — the snapshot test in tests/caseyWorkflowDraft.test.js
// fails on every change.
//
// Classes: 'none' (pure compute / control flow — no row is touched),
// 'read' (reads firm records, writes nothing),
// 'internal-record' (creates ONE internal record whose native notifications
// may fire — the same operations Casey's reviewed card families already
// perform one at a time),
// 'external-send' (messages someone outside the system when the step runs —
// ruling 15, Fred 2026-10-27: Casey may author sends, because every Casey
// action is read and approved by a user. A draft runs nothing; the human
// publish is the review gate for the send, and the cards say so).

const CASEY_AUTHORABLE_FUNCTIONS = new Map([
  // Control flow / pure compute — class 'none'.
  ['noop', 'none'],
  ['set_var', 'none'],
  ['format_string', 'none'],
  ['set_next', 'none'],
  ['evaluate_condition', 'none'],
  ['foreach', 'none'],
  ['wait_for', 'none'],
  ['schedule_resume', 'none'],
  ['wait_until_time', 'none'],
  ['business_deadline', 'none'],

  // Reads — class 'read'.
  ['lookup_contact', 'read'],
  ['find_contact', 'read'],
  ['lookup_appointment', 'read'],
  ['get_appointments', 'read'],
  ['find_live_calendar_item', 'read'],
  ['lookup_event', 'read'],
  ['get_events', 'read'],
  ['lookup_user', 'read'],
  ['list_users', 'read'],

  // Firm settings reads — class 'read' (manager ruling under ruling 15,
  // 2026-10-27). Both functions refuse a secret (settingsRegistry.isSecret)
  // and an unknown key at run time; the normalizer refuses the same at
  // proposal time for the literal keys Casey writes. They let a NEW draft
  // carry the canonical sender pair: get_settings {keys: 'email_automations',
  // output_var: 'settings'} then a send from {{settings.email_automations}}.
  ['get_setting', 'read'],
  ['get_settings', 'read'],

  // Internal record creation — class 'internal-record'. request_decision is
  // the human-in-the-loop control-flow primitive (creates a decision request
  // and pauses); the other three are the operations the A0-A5 card families
  // already let Casey perform singly, under review.
  ['request_decision', 'internal-record'],
  ['create_task', 'internal-record'],
  ['create_event', 'internal-record'],
  ['create_log', 'internal-record'],

  // External sends — class 'external-send' (ruling 15). The sender is held
  // to a closed rule in services/assistantService.js (a literal active firm
  // line / configured mailbox, or a placeholder the workflow resolver can
  // actually resolve — WORKFLOW_SENDER_SETTING_KEYS below); email
  // attachment_urls are refused (fetched at send time — no model-invented
  // fetched URL).
  ['send_sms', 'external-send'],
  ['send_email', 'external-send'],
]);

// A18.2 — the SEQUENCE allowlist, a separate list on purpose (ruling 14,
// Fred 2026-10-26): what Casey may put in a sequence template's DRAFT, keyed
// by the step's action_type. The function is PINNED per action type — the
// native sequence editor pins the same three (sms → send_sms, email →
// send_email, task → create_task), every one dispatches as an executeJob
// internal_function call keyed on function_name, and the model never
// chooses it. (The workflow list above admits the same two senders since
// ruling 15.)
//
// Class 'external-send': the step messages a client. It is
// allowed in a sequence DRAFT because nothing in a draft runs — a human
// publishes the template (the review gate for the send), and even then an
// inserted step is a structural change, so enrollments already in flight
// cannot migrate onto it; only a NEW enrollment reaches it. The card says
// exactly that. The allowlist snapshot in tests/caseyWorkflowDraft.test.js
// pins this map beside the workflow list and fails on every change.
const CASEY_SEQUENCE_AUTHORABLE = new Map([
  ['sms', { function_name: 'send_sms', side_effect: 'external-send' }],
  ['email', { function_name: 'send_email', side_effect: 'external-send' }],
  ['task', { function_name: 'create_task', side_effect: 'internal-record' }],
]);

// Ruling 15 — the CLOSED sets of sender placeholders Casey may write, one per
// engine, because the two engines template differently and a sender that
// resolves to nothing must never be authored on a guess.
//
// SEQUENCE steps resolve through services/resolverService (lib/sequenceEngine
// buildRefsForStep): `users` is anchored on the enrollment's trigger_data
// user → user_id → appt_with, `trigger_data` is the enrollment payload, and
// NO settings namespace exists (a {{settings.x}} stays literal). Live
// 2026-10-27: 12 steps send SMS from {{users.default_phone}}; every user with
// a default_phone / default_email holds an active line / configured mailbox.
// An unresolved sequence placeholder stays LITERAL in the config, and
// send_sms / send_email then throw (no line / no mailbox for "{{…}}") — the
// step fails, nothing is sent. A {{trigger_data.X}} sender is admitted only
// when the SAME template's editing version already sends from exactly that
// placeholder on the same channel (live: template 28's
// {{trigger_data.automationsFrom}}, which its enrolling workflow supplies) —
// trigger_data keys are an enroller convention the card cannot verify.
const CASEY_SEQUENCE_SENDER_PLACEHOLDERS = Object.freeze({
  sms: Object.freeze({
    '{{users.default_phone}}': "sender resolved per enrollment — e.g. the enrolling user's default phone (the enrollment's user: trigger_data.user, else user_id, else the appointment's host). An enrollment with no such user, or a user with no default phone, fails this step without sending.",
  }),
  email: Object.freeze({
    '{{users.default_email}}': "sender resolved per enrollment — e.g. the enrolling user's default email (the enrollment's user: trigger_data.user, else user_id, else the appointment's host). It must be a configured firm mailbox; otherwise the step fails without sending.",
  }),
});

// WORKFLOW steps resolve through lib/workflow_engine resolvePlaceholders:
// variables only (plus env.* / this.*), no modifiers, no tables, and an
// unresolved placeholder blanks to '' silently — send_sms / send_email then
// throw "requires from" (the step fails per its error_policy; nothing is
// sent). So a workflow sender placeholder is resolvable only when an EARLIER
// step stores a firm SENDER setting in a variable: {{V}} after
// get_setting {key, output_var: V}, or {{V.key}} after get_settings
// {keys, output_var: V} — the two live forms ({{automationsFrom}} ×4,
// {{settings.email_automations}} ×7, 2026-10-27). The admissible keys are the
// registry's 'senders' section, by channel — derived, not hand-listed.
const WORKFLOW_SENDER_SETTING_KEYS = (() => {
  const { SETTINGS } = require('./settingsRegistry');
  const out = { sms: [], email: [] };
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.section !== 'senders') continue;
    if (def.type === 'phone') out.sms.push(key);
    else if (def.type === 'email') out.email.push(key);
  }
  return Object.freeze({ sms: Object.freeze(out.sms.sort()), email: Object.freeze(out.email.sort()) });
})();

module.exports = {
  CASEY_AUTHORABLE_FUNCTIONS, CASEY_SEQUENCE_AUTHORABLE,
  CASEY_SEQUENCE_SENDER_PLACEHOLDERS, WORKFLOW_SENDER_SETTING_KEYS,
};
