'use strict';
// A17.3 — the functions Casey may put in a workflow DRAFT it authors, each
// with its side-effect class. This is the plan's "A17 needs its own allowlist
// with a side-effect class per function": __meta records no side-effect class
// for any of the 104 registry functions, and the CTA-eligible set is far too
// wide to stand in for one.
//
// DELIBERATELY SMALL. Casey explains every function (A17.0); it AUTHORS only
// these. Excluded by construction (plan, "What Casey cannot author"): every
// EXTERNAL-SEND function (send_sms/send_email/send_mms, forwards, digests,
// esign senders) until A14's send machinery exists; generic writes
// (update_db / insert_db / set_setting); chaining fan-out (start_workflow,
// enroll_sequence, cancel_sequences); create_cta (mints public bearer links);
// record mutations (update_case, update_contact, advance_stage, update_log);
// external-surface writes (gcal_*, dropbox_*, intake_*); ops sweeps; and
// query_db, which is A17.4a's own bounded slice. Adding a function here is a
// deliberate 30-second review — the snapshot test in
// tests/caseyAutomationAllowlist.test.js fails on every change.
//
// (The SEQUENCE list at the bottom is separate and does allow the two
// senders — ruling 14; nothing above changes for workflows.)
//
// Classes: 'none' (pure compute / control flow — no row is touched),
// 'read' (reads firm records, writes nothing),
// 'internal-record' (creates ONE internal record whose native notifications
// may fire — the same operations Casey's reviewed card families already
// perform one at a time).

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

  // Internal record creation — class 'internal-record'. request_decision is
  // the human-in-the-loop control-flow primitive (creates a decision request
  // and pauses); the other three are the operations the A0-A5 card families
  // already let Casey perform singly, under review.
  ['request_decision', 'internal-record'],
  ['create_task', 'internal-record'],
  ['create_event', 'internal-record'],
  ['create_log', 'internal-record'],
]);

// A18.2 — the SEQUENCE allowlist, a separate list on purpose (ruling 14,
// Fred 2026-10-26): what Casey may put in a sequence template's DRAFT, keyed
// by the step's action_type. The function is PINNED per action type — the
// native sequence editor pins the same three (sms → send_sms, email →
// send_email, task → create_task), every one dispatches as an executeJob
// internal_function call keyed on function_name, and the model never
// chooses it. The workflow list above is unchanged: workflow-draft send
// parity is its own follow-up slice.
//
// Class 'external-send' is new here: the step messages a client. It is
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

module.exports = { CASEY_AUTHORABLE_FUNCTIONS, CASEY_SEQUENCE_AUTHORABLE };
