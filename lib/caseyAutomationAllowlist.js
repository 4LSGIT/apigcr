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

module.exports = { CASEY_AUTHORABLE_FUNCTIONS };
