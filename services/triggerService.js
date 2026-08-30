// services/triggerService.js
//
/**
 * Trigger Service — domain-event trigger engine (Slice T1)
 * services/triggerService.js
 *
 * Third consumer of the shared automation primitives (after YisraHook and the
 * email/phone ingest rules): evaluates active `trigger_rules` for a domain
 * event's type against the event envelope (built by lib/domainEvents.js) and
 * fires each matching rule's ordered `trigger_rule_actions` through
 * lib/actionDispatchers.dispatch() — workflow / sequence / internal_function /
 * http — plus the `hook` action type that re-enters the YisraHook pipeline.
 *
 * SEMANTICS (carried verbatim from services/emailIngestRuleService.js —
 * hard-won rules, do not soften):
 *   - Throwing match rules count as NON-match (fail-safe: a broken rule never
 *     fires actions). T9/GAP-1: they are also RECORDED now — a warning on the
 *     execution row, an error_count bump on the rule, and a
 *     'trigger_match_failed' alert. Previously the fail-safe was silent, which
 *     meant an active-but-unevaluatable rule looked identical to a rule that
 *     honestly didn't match. Fail-safe, not fail-quiet.
 *   - NULL match_config on conditions mode is NON-match, NOT match-all.
 *     Explicit always-match = {operator:'and', conditions:[]}.
 *   - A failed transform → the rule still counts as MATCHED (metrics bump)
 *     but its actions do not fire (never feed garbage to actions); the
 *     failure is recorded as a warning in the execution row.
 *   - Action failures are isolated: one action failing does NOT abort the
 *     remaining actions of the same rule or later rules.
 *   - Live SQL rule edits propagate immediately (no cache).
 *
 * TRIGGER-SPECIFIC:
 *   - Rules are loaded per event_type (idx_event_active).
 *   - Every processed event writes ONE trigger_executions row
 *     (status matched / no_match / no_rules / depth_capped / error) carrying
 *     the envelope — this doubles as the sample-envelope source for the T2
 *     UI's field-discovery panel, which is why no_match/no_rules rows are
 *     kept. A retention sweep lands in T4.
 *   - Each action dispatch runs inside domainEvents.runAsAction(rule.id, …)
 *     so any events re-emitted by the action's side effects carry depth+1 /
 *     the rule id on the chain. processEvent drops events arriving at
 *     depth >= domainEvents.MAX_DEPTH ('depth_capped' row + alert).
 *   - Replay (POST /api/triggers/replay) re-runs a RECORDED envelope through
 *     this same function — real dispatch, new execution row, chain scope
 *     reset. It is execution_id-only (Review S10): a recorded envelope cannot
 *     be forged, whereas a raw one let any staff token synthesise an event for
 *     an arbitrary case. There is no test-envelope GATE (the ingest pipeline's
 *     gate is a deliberate divergence documented there) — the lockdown is the
 *     execution_id requirement instead.
 *
 * R4 ADDITIONS
 *   - trigger_execution_rules: one audit row per MATCHED rule per execution
 *     (rule_name denormalized so it survives rule deletion). Powers the
 *     per-rule "Recent runs" card. Written after the finalize UPDATE, in its
 *     own catch — audit must never disturb the engine.
 *   - trigger_rules.min_interval_s: per-rule cooldown. A rule inside its
 *     cooldown window is NOT matched (no metrics bump, no actions) and logs a
 *     skipped_cooldown warning naming the rule.
 *
 * EVENT REGISTRY
 *   EVENT_TYPES is the authoritative catalog of emittable events + their
 *   envelope field catalogs (consumed by the T2 UI match-builder and by
 *   createRule validation). Adding an event type = adding an emit() call in
 *   a service + a registry entry here — both are code, one deploy.
 */

'use strict';

const vm = require('node:vm');
const { evaluateConditions } = require('./hookFilter');
const hookMapper             = require('./hookMapper');
const actionDispatchers      = require('../lib/actionDispatchers');
const domainEvents           = require('../lib/domainEvents');

// ─────────────────────────────────────────────────────────────
// EVENT REGISTRY
// ─────────────────────────────────────────────────────────────

// Events whose emit sites genuinely have no actor/source use CORE_FIELDS so
// the picker never advertises a path that is always null (Review S5).
//
// R4/S5: caseService.updateCase / addCaseContact / removeCaseContact now
// accept { userId, source } and thread them into their emits, so case.updated
// / case.contact_linked / case.contact_unlinked moved back to COMMON_FIELDS.
// case.created stays on CORE_FIELDS: it fires from the intake and petition
// INSERT sites, which carry a meaningful `source` (declared explicitly below)
// but no acting user. Honesty over aspiration — only publish a path once a
// real writer fills it.
const CORE_FIELDS = [
  { path: 'event',      label: 'Event type' },
  { path: 'ts',         label: 'Timestamp (ISO)' },
  { path: 'depth',      label: 'Trigger chain depth' },
  { path: 'contact_id', label: 'Contact id' },
  { path: 'case_id',    label: 'Case id (null when caseless)' },
];

const COMMON_FIELDS = [
  { path: 'event',      label: 'Event type' },
  { path: 'ts',         label: 'Timestamp (ISO)' },
  { path: 'depth',      label: 'Trigger chain depth' },
  { path: 'source',     label: 'Action source (manual/system/client/…)' },
  { path: 'actor.user_id', label: 'Acting user id (0 = system)' },
  { path: 'contact_id', label: 'Contact id' },
  { path: 'case_id',    label: 'Case id (null when caseless)' },
];

const APPT_DATA_FIELDS = [
  { path: 'data.appt_id',       label: 'Appt id' },
  { path: 'data.appt_type',     label: 'Appt type (free text)' },
  { path: 'data.appt_with',     label: 'Provider user id' },
  { path: 'data.appt_date',     label: 'Appt date (firm-local)' },
  { path: 'data.appt_status',   label: 'Appt status (post-mutation)' },
];

const EVENT_TYPES = {
  'appt.created': {
    label: 'Appointment created',
    description: 'Fires post-commit from apptService.createAppt for every caller (API, booking, workflows, reschedules — the reschedule successor fires this too).',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.appt_platform', label: 'Platform' },
      { path: 'data.appt_source',   label: 'appt_source (row column)' },
      { path: 'data.appt_view_id',  label: 'Booking view id (null = internal)' },
      { path: 'extra.hook_event',   label: "'created' | 'rescheduled' | 'rebooked'" },
      { path: 'extra.rescheduled_from', label: 'Old appt id (reschedule successor only)' },
    ],
  },
  'appt.attended': {
    label: 'Appointment marked Attended',
    description: 'Fires from apptService.markAttended.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.case_type',    label: 'Case type (joined; null when caseless)' },
      { path: 'data.case_subtype', label: 'Case subtype (joined)' },
      { path: 'extra.prior_status', label: 'Status before Attended' },
    ],
  },
  'appt.no_show': {
    label: 'Appointment marked No Show',
    description: 'Fires from apptService.markNoShow. Note: the no_show pipeline advance is (pre-existing) hardcoded in markNoShow itself — do not duplicate it as a rule.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.case_type',    label: 'Case type (joined)' },
      { path: 'data.case_subtype', label: 'Case subtype (joined)' },
      { path: 'extra.prior_status', label: 'Status before No Show' },
      { path: 'extra.enrolled',     label: 'no_show sequence enrolled (bool)' },
    ],
  },
  'appt.cancelled': {
    label: 'Appointment cancelled',
    description: 'Fires from apptService.cancelAppt.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.appt_view_id',  label: 'Booking view id' },
      { path: 'extra.prior_status', label: 'Status before Canceled' },
    ],
  },
  'appt.rescheduled': {
    label: 'Appointment rescheduled (old appt)',
    description: 'Fires from apptService.rescheduleAppt for the OLD appt after its successor exists. The successor separately fires appt.created with extra.hook_event=rescheduled.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'extra.new_appt_id',  label: 'Successor appt id' },
      { path: 'extra.new_appt_date', label: 'Successor appt date' },
    ],
  },
  'appt.reschedule_later': {
    label: 'Appointment marked Reschedule Later',
    description: 'Fires from apptService.rescheduleLater (slot freed, no successor).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.appt_id',   label: 'Appt id' },
      { path: 'data.appt_type', label: 'Appt type (free text)' },
      { path: 'data.appt_date', label: 'Appt date' },
      { path: 'data.appt_with', label: 'Provider user id' },
    ],
  },
  // ── T3 events ────────────────────────────────────────────
  'contact.created': {
    label: 'Contact created',
    description: 'Fires post-commit from contactService.createContact (all callers: intake, orphan-adopt, API).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.contact_type',  label: 'Contact type' },
      { path: 'data.contact_name',  label: 'Full name' },
      { path: 'data.contact_phone', label: 'Primary phone' },
      { path: 'data.contact_email', label: 'Primary email' },
      { path: 'data.contact_tags',  label: 'Tags' },
      { path: 'data.contact_clio_id', label: 'Clio id' },
    ],
  },
  'contact.updated': {
    label: 'Contact updated',
    description: 'Fires post-commit from contactService.updateContact when something actually changed. changes carries per-field {from,to} for scalar columns; aggregate (phones/emails/addresses) reconciles surface as counts in extra. Not fired by direct SQL writers that bypass updateContact.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.contact_type',  label: 'Contact type' },
      { path: 'data.contact_name',  label: 'Full name' },
      { path: 'data.contact_phone', label: 'Primary phone (post-update)' },
      { path: 'data.contact_email', label: 'Primary email (post-update)' },
      { path: 'changes.contact_phone',      label: 'Phone changed (exists = yes)' },
      { path: 'changes.contact_phone.to',   label: 'Phone — new value' },
      { path: 'changes.contact_email',      label: 'Email changed (exists = yes)' },
      { path: 'changes.contact_email.to',   label: 'Email — new value' },
      { path: 'changes.contact_tags',       label: 'Tags changed (exists = yes)' },
      { path: 'changes.contact_tags.to',    label: 'Tags — new value' },
      { path: 'changes.contact_tags.from',  label: 'Tags — old value' },
      { path: 'extra.updated_fields',    label: 'Updated field list' },
      { path: 'extra.phones_changed',    label: 'Aggregate phones changed' },
      { path: 'extra.emails_changed',    label: 'Aggregate emails changed' },
      { path: 'extra.addresses_changed', label: 'Aggregate addresses changed' },
    ],
  },
  'case.created': {
    label: 'Case created',
    description: 'Fires from the intake case-create route and the petition-filing case-create branch (the two case INSERT sites). source distinguishes: intake | petition. No actor on this event.',
    fields: [
      ...CORE_FIELDS,
      { path: 'source', label: "'intake' | 'petition'" },
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'data.case_number',  label: 'Case number (opaque text)' },
      { path: 'data.case_chapter', label: 'Chapter (petition path only)' },
    ],
  },
  'case.updated': {
    label: 'Case updated',
    description: "Fires from caseService.updateCase (detail form + the update_case internal function, which delegates) when something actually changed. Direct SQL writers (court executor field writes, 341 pointer, dropbox path) bypass this deliberately. Stage moves are case.stage_advanced, not case.updated. actor.user_id / source are threaded from the caller (R4/S5): the case-detail PATCH and docket-adopt routes pass the JWT user, update_case passes user 0 + source 'automation', court-review adopt passes source 'court_review'. Callers that pass neither leave actor null — filter defensively. For ANY column: changes.<column> (exists = changed), changes.<column>.from / .to (values) via Custom path.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'data.case_stage',   label: 'case_stage (legacy enum)' },
      { path: 'changes.case_number',        label: 'Docket changed (exists = yes)' },
      { path: 'changes.case_number.to',     label: 'Docket — new value' },
      { path: 'changes.case_subtype',       label: 'Subtype changed (exists = yes)' },
      { path: 'changes.case_subtype.to',    label: 'Subtype — new value' },
      { path: 'changes.case_subtype.from',  label: 'Subtype — old value' },
      { path: 'changes.case_file_date',     label: 'File date changed (exists = yes)' },
      { path: 'changes.case_file_date.to',  label: 'File date — new value' },
      { path: 'extra.updated_fields',  label: 'Updated field list' },
    ],
  },
  'case.stage_advanced': {
    label: 'Case pipeline stage advanced',
    description: 'Fires post-commit from pipelineService.advanceStage for every REAL advance (guard-skips and same-stage no-ops do not fire). advanceStage is the only case_stage_log writer, so this covers all surfaces: board drags, workflows, trigger rules, esign, checklists.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.stage_key',    label: 'New stage key' },
      { path: 'data.status_label', label: 'New stage label' },
      { path: 'data.case_stage',   label: 'New case_stage enum' },
      { path: 'data.template_id',  label: 'Template id' },
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'extra.from_stage',  label: 'Previous stage key (null = first entry)' },
      { path: 'extra.note',        label: 'Advance note' },
    ],
  },
  'case.contact_linked': {
    label: 'Contact linked to case',
    description: 'Fires from caseService.addCaseContact. NOT fired by the intake/petition routes\' direct case_relate INSERTs at creation (case.created covers those). actor.user_id carries the acting JWT user from POST /api/cases/:id/contacts (R4/S5); API-key callers and any future caller that passes no userId leave actor null.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.relate_type', label: 'Relation type (Primary/Secondary/Other/Bystander)' },
    ],
  },
  'case.contact_unlinked': {
    label: 'Contact unlinked from case',
    description: 'Fires from caseService.removeCaseContact when a row was actually removed. actor.user_id carries the acting JWT user from DELETE /api/cases/:id/contacts/:contactId (R4/S5); API-key callers leave actor null.',
    fields: [ ...COMMON_FIELDS ],
  },
  // ── T4 events ────────────────────────────────────────────
  'form.submitted': {
    label: 'Form submitted',
    description: 'Fires from formService.submitForm — both the internal client (case2/contact2 YisraForms) and the external surface. extra.surface = internal | external. The envelope deliberately excludes the submission data payload (large + potentially sensitive); rules needing values should route to a workflow that fetches the submission.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.form_key',      label: 'Form key' },
      { path: 'data.link_type',     label: 'Link type (contact/case/...)' },
      { path: 'data.version',       label: 'Submission version' },
      { path: 'data.submission_id', label: 'form_submissions.id' },
      { path: 'extra.surface',      label: "'internal' | 'external'" },
    ],
  },
  'esign.status_changed': {
    label: 'E-sign status changed',
    description: 'Fires from esignWebhookService.processStatusChange whenever a signing request actually transitions (webhook or reconciliation — source distinguishes). data.status is the INTERNAL status vocabulary: sent, viewed, signed, declined, bounced, recalled, expired, reminded. Filter data.status equals "signed" for completion.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.status',          label: 'New internal status' },
      { path: 'data.provider_status', label: 'Raw provider status' },
      { path: 'data.kind',            label: 'Request kind' },
      { path: 'data.document_name',   label: 'Document name' },
      { path: 'data.request_id',      label: 'signing_requests.id' },
      { path: 'extra.prior_status',   label: 'Status before the transition' },
      { path: 'extra.recipient_email', label: 'Recipient email (when per-recipient)' },
    ],
  },
  'checkitem.completed': {
    label: 'Checklist item completed',
    description: 'Fires from PATCH /checkitems/:id when an item transitions to complete (idempotent re-saves do not fire).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.name',             label: 'Item name' },
      { path: 'data.checklist_id',     label: 'Checklist id' },
      { path: 'data.tag',              label: 'Checklist tag (e.g. docs_needed)' },
      { path: 'data.checklist_status', label: 'Parent status after recompute' },
    ],
  },
  'case.court_processed': {
    label: 'Court email processed for a case',
    description: "Fires from courtExecutor.executeCourtActions after a LIVE run SETTLES — dry_run=0 AND outcome IN ('executed','none'). That is deliberately the same predicate STEP 1's processed marker and courtReview's OPEN_QUEUE_WHERE use to call a message closed, so the Court Review Queue gates this event for free: a run landing 'queued' emits NOTHING, and the emit fires only once the message settles — including when a human resolves it from the queue, which arrives as source 'court_review'. Dry runs and previews never emit. It DOES fire when zero case columns were written (outcome 'none'): a classification can be actionable to the pipeline without having a column to write, and gating on writes would hide exactly those. This is one event per settled RUN — it does NOT un-bypass case.updated, whose court-executor exemption still stands.",
    fields: [
      ...CORE_FIELDS,
      { path: 'source',                  label: "'court_ingest' | 'court_review' | 'court_sweep'" },
      { path: 'data.classification',     label: 'court_extract classification (discharge_granted, case_dismissed, case_closed, case_reopened, plan_confirmed, meeting_ch13, …). Rows logged before court_extract v9 carry the retired fused value discharge_or_close.' },
      { path: 'data.outcome',            label: "'executed' | 'none'" },
      { path: 'data.case_chapter',       label: "Chapter from the CASE row ('7'/'13') — BLANK on ~19% of the live book; a narrowing hint, never the safety (put that in the action's only_from guard)" },
      { path: 'data.case_number',        label: 'Short docket (case row)' },
      { path: 'data.case_number_full',   label: 'Full docket (case row)' },
      { path: 'data.message_id',         label: 'Source email message id' },
      { path: 'data.court_ai_log_id',    label: 'court_ai_log row id for this run' },
      { path: 'extra.applied_fields',    label: 'Case columns actually written (array; empty on outcome none)' },
      { path: 'extra.applied_types',     label: 'Action types applied (array)' },
      { path: 'extra.applied_count',     label: 'Applied action count' },
      { path: 'extra.skipped_count',     label: 'Skipped action count' },
      { path: 'extra.citation_override', label: 'A human force-applied over a citation miss (bool)' },
    ],
  },
  'checklist.completed': {
    label: 'Checklist completed',
    description: 'Fires when a checklist transitions incomplete -> complete via an item status change or item deletion (the two mutation routes). Pairs with the docs pipeline: tag=docs_needed + all items complete is the natural docs-done signal.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.checklist_id', label: 'Checklist id' },
      { path: 'data.title',        label: 'Checklist title' },
      { path: 'data.tag',          label: 'Checklist tag' },
      { path: 'data.link_type',    label: 'Link type' },
    ],
  },
  // ── R1.5 events (pipeline stage keys moved from code to data) ─────────────
  'esign.sent': {
    label: 'E-sign request sent',
    description: "Fires from esignSendService once a signing request has actually gone out: the provider accepted the envelope and markSent committed the row. TWO emit sites, because there are two provider-send paths — sendPipeline (first sends, draft retries after a failed send, and terminal duplicates, which mint a fresh draft and come back through it) and resendPipeline's SAME-ROW bounce resend, which inlines its own provider call and never reaches sendPipeline. Between them that is every send path: template sends (sendFromTemplate), ad-hoc sends (POST /api/esign/send), workflow/sequence sends (esign_send_from_template), and both kinds of resend. Exactly one emission per send — no path emits twice. Tell the three shapes apart with extra: fresh send (resend=false, draft_reused=false), draft retry or terminal duplicate (resend=false, draft_reused=true), bounce same-row resend (resend=true, draft_reused=false). data.kind EQUALS 'contract' is the filter for retainer flows. Fires regardless of test mode — filter data.testing if a rule must exclude test-mode envelopes. OWNERSHIP: the contract_sent pipeline advance formerly hardcoded in sendFromTemplate is now carried by the named rule \"Contract sent → contract_sent stage\" (guards: data.kind=contract + case_id exists, only_from_role 'intake,none'). Do not re-hardcode it, and do not add a second rule that duplicates it.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.request_id',    label: 'signing_requests.id' },
      { path: 'data.kind',          label: "Request kind (filter equals 'contract' for retainers)" },
      { path: 'data.document_name', label: 'Document name (debtor-visible)' },
      { path: 'data.template_id',   label: 'contract_templates.id (null on ad-hoc sends)' },
      { path: 'data.provider',      label: 'Provider slug' },
      { path: 'data.linkable_type', label: "'case' | 'contact'" },
      { path: 'data.linkable_id',   label: 'Linked entity id (raw)' },
      { path: 'data.tracking_id',   label: 'Tracking id stamped on the document' },
      { path: 'data.testing',       label: "Provider reported a TEST-MODE envelope (bool). Not a column — signing_requests stores no test-mode flag; this is sendForSignature's own verdict." },
      { path: 'extra.recipient_count', label: 'Recipients on the envelope' },
      { path: 'extra.draft_reused', label: 'An existing draft row was sent — retry after a failed send, or a terminal-request duplicate (bool)' },
      { path: 'extra.resend',       label: 'Same-row resend after a bounce (bool)' },
    ],
  },
  'checklist.items_upserted': {
    label: 'Checklist items upserted',
    description: "Fires post-response from POST /checklists/upsert-items after the status recompute. The name is generic on purpose: the route only ever touches the case docs checklist today (found by tag='docs_needed'), so every live emission carries data.tag='docs_needed' — but the fact reported is \"items were upserted on a checklist\", and narrowing to docs is the RULE's job. A future upsert path emits this same event with its own tag. This is a BULK event, not per item: data.items_upserted is how many items this one call wrote. It fires repeatedly across a case's whole life (a doc request is re-sent whenever the list changes), so any rule on it must be idempotent or guarded. OWNERSHIP: the retained→docs pipeline advance formerly hardcoded in this route is now carried by the named rule \"Doc request sent → docs stage\" (guards: data.tag=docs_needed + case_id exists, only_from 'retained'). Do not re-hardcode it, and do not add a second rule that duplicates it.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.checklist_id',     label: 'Checklist id' },
      { path: 'data.tag',              label: "Checklist tag (always 'docs_needed' from today's only caller)" },
      { path: 'data.title',            label: 'Checklist title (staff-editable — filter on tag, not this)' },
      { path: 'data.link_type',        label: "Link type (always 'case' from today's only caller)" },
      { path: 'data.items_upserted',   label: 'Items written by this call' },
      { path: 'data.checklist_status', label: 'Checklist status after recompute' },
    ],
  },
  // ── Documents (S1) ───────────────────────────────────────
  //
  // Shared data catalog. It is a PROJECTION of the documents row, not the row:
  // shared_link (a permanent public URL to a client document) and ai_meta are
  // deliberately withheld — envelopes persist into trigger_executions for
  // 30–90 days, readable by any staff JWT/API key and the readonly SQL
  // endpoint. Kept in sync with documentService._eventData.
  'document.created': {
    label: 'Document registered',
    description: "Fires post-commit from documentService.upsertFromEntry when a file is registered for the FIRST time under (source, external_id) — manual POST /api/documents/register today, S2's sync feed later. contact_id and case_id are ALWAYS NULL on this event: at registration time nothing knows which case a file belongs to, and attribution arrives separately as document.linked. Rules that need an owner must key on document.linked, not this. S2's ~150k-row backfill passes { emit: false } and fires NOTHING — a backfilled file is not news. data.source is the STORAGE provider ('dropbox'), which is not the same thing as the envelope's `source`.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.id',          label: 'documents.id' },
      { path: 'data.source',      label: "Storage provider ('dropbox')" },
      { path: 'data.external_id', label: 'Provider handle — Dropbox "id:…", stable across move/rename' },
      { path: 'data.name',        label: 'File name' },
      { path: 'data.path',        label: 'Last-seen path (a cache, not identity — may be stale)' },
      { path: 'data.doc_type',    label: 'Classification (null until set by a human or AI)' },
      { path: 'data.tags',        label: 'Normalized CSV tags' },
      { path: 'data.status',      label: "'active' | 'deleted' | 'missing'" },
    ],
  },
  'document.updated': {
    label: 'Document updated',
    description: "Fires post-commit from documentService in TWO shapes, told apart by extra.via. via='sync': upsertFromEntry saw a real change on a file it already knew — and ONLY for rev, path_lower, name or status, so a re-sync that changes nothing (the overwhelming majority) is silent. A file that had been marked deleted/missing and re-appears comes back through here with changes.status. via='edit': documentService.update wrote title, doc_type, tags or status from a human/AI surface. contact_id / case_id are ALWAYS NULL (see document.created). S2's backfill suppresses emissions entirely. For ANY column in the catalog: changes.<column> (exists = changed), changes.<column>.from / .to via Custom path.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.id',          label: 'documents.id' },
      { path: 'data.source',      label: "Storage provider ('dropbox')" },
      { path: 'data.external_id', label: 'Provider handle' },
      { path: 'data.name',        label: 'File name (post-update)' },
      { path: 'data.path',        label: 'Last-seen path (post-update)' },
      { path: 'data.doc_type',    label: 'Classification (post-update)' },
      { path: 'data.tags',        label: 'Normalized CSV tags (post-update)' },
      { path: 'data.status',      label: "'active' | 'deleted' | 'missing'" },
      { path: 'changes.status',        label: 'Status changed (exists = yes)' },
      { path: 'changes.status.to',     label: 'Status — new value' },
      { path: 'changes.doc_type',      label: 'Classification changed (exists = yes)' },
      { path: 'changes.doc_type.to',   label: 'Classification — new value' },
      { path: 'changes.path_lower',    label: 'File moved or renamed (exists = yes)' },
      { path: 'changes.path_lower.to', label: 'New path (lowercased)' },
      { path: 'changes.rev',           label: 'File contents revised (exists = yes)' },
      { path: 'changes.name',          label: 'File renamed (exists = yes)' },
      { path: 'extra.via',             label: "'sync' (provider feed) | 'edit' (human/AI write)" },
      { path: 'extra.updated_fields',  label: 'Changed field list' },
    ],
  },
  'document.linked': {
    label: 'Document linked to a case or contact',
    description: "Fires post-commit from documentService.link ONLY when a genuinely new link row is written — the unique key (document_id, link_type, link_id) makes re-linking idempotent and silent, so a rule here is safe against retries. THIS is the event that gives a document an owner: case_id is promoted when extra.link_type='case', contact_id when it is 'contact', and BOTH are null for any other link type. document.created / document.updated never carry either, so anything case-scoped (file it, notify, advance a stage) belongs on this event. actor.user_id carries the acting JWT user when the caller threaded one; API-key callers leave actor absent.",
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.id',          label: 'documents.id' },
      { path: 'data.source',      label: "Storage provider ('dropbox')" },
      { path: 'data.external_id', label: 'Provider handle' },
      { path: 'data.name',        label: 'File name' },
      { path: 'data.path',        label: 'Last-seen path' },
      { path: 'data.doc_type',    label: 'Classification' },
      { path: 'data.tags',        label: 'Normalized CSV tags' },
      { path: 'data.status',      label: "'active' | 'deleted' | 'missing'" },
      { path: 'extra.link_type',  label: "'case' | 'contact' | … (drives which id is promoted)" },
      { path: 'extra.link_id',    label: 'Target id (raw string — case_id is varchar, contact_id numeric)' },
      { path: 'extra.relation',   label: 'Optional relation label (null when unset)' },
    ],
  },
  // ── Synthetic events (job-driven, not mutation-driven) ─────
  'case.stage_aged': {
    label: 'Case stage aged (nightly)',
    description: 'SYNTHETIC event from the nightly emit_stage_aged job (13:00 UTC / 9am Detroit — the human/outbound band, since rules on this event send client-facing nudges), not from a mutation: fires when a case\'s CURRENT pipeline stage crosses a day threshold (default ladder 3/7/14/30/60). Filter data.threshold_days EQUALS N — never >=; each rung fires exactly once per stage entry, and re-entering a stage re-arms its rungs. FORWARD-LOOKING ONLY: only crossings within the last grace_days (default 7) fire, so cases imported or backfilled already-stale never fire — already-stale-at-import is a one-time triage report\'s job. The ladder is SPARSE, not continuous: with defaults there is no rung in-window on days 21–29, 37–59, or 67+. Terminal stages and Closed/Concluded cases are excluded. Coverage = cases with case_stage_log history (a handful today; grows with pipeline adoption). source=system, actor user 0, days are whole 24-hour periods.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.stage_key',      label: 'Current stage key' },
      { path: 'data.threshold_days', label: 'Threshold rung that fired (filter equals N)' },
      { path: 'data.days_in_stage',  label: 'Whole days in stage at emission' },
      { path: 'data.template_id',    label: 'Pipeline template id' },
      { path: 'data.case_type',      label: 'Case type' },
      { path: 'data.case_subtype',   label: 'Case subtype' },
      { path: 'data.case_stage',     label: 'case_stage enum (log-row snapshot)' },
      { path: 'data.status_label',   label: 'Stage label (log-row snapshot; can lag template edits)' },
      { path: 'data.entered_at',     label: 'Stage entered at (ISO)' },
      { path: 'extra.stage_log_id',  label: 'case_stage_log row id (the dedup key)' },
    ],
  },
};

// V2 event candidates (noted, deliberately not emitted yet): checklist.created,
// checkitem.created, checkitem.uncompleted, checklist.uncompleted (reopen
// transitions), event.* (eventService lifecycle — court v2 will define needs),
// contact.opted_out as a discrete event (covered today by contact.updated +
// changes.<field> exists).

const ACTION_TYPES = new Set(['workflow', 'sequence', 'internal_function', 'http', 'hook']);

// Review M7: code mode runs in node:vm with a hard timeout. The bare context
// (no process, require, fetch, console, timers) is defence-in-depth against
// the env-reach problem, and the timeout stops a while(true) from parking the
// event loop until Cloud Run kills the container. NOT a security boundary
// against a determined attacker — the code-mode AUTH question is a
// codebase-wide decision (this pattern exists in 9 other automation
// surfaces) tracked separately.
//
// 2026-08-29: raised 200 -> 15000 and made it env-overridable, matching
// job_executor's CUSTOM_CODE_TIMEOUT_MS idiom.
//
// This is a WALL-CLOCK budget, not a CPU budget, and most trigger chains run
// DETACHED — domainEvents.emit() is fire-and-forget from every mutation site
// (see apptService step 9 for appt.created), so the whole tree executes AFTER
// the HTTP response, under Cloud Run's request-based CPU throttling. Same
// starvation already documented in actionDispatchers' queued-start comment
// ("20-45x slowdowns; vm-watchdog aborts on trivial scripts") and in
// job_executor's custom_code handler (wf27 step 1, 2026-08-19: a ~2ms string
// formatter blew a 5000ms ceiling while detached; the same step re-run
// through the UI took 141ms).
//
// trigger_executions#458 lost rule 4's transform to this. Replayed against
// that exact envelope the script runs in ~8ms, so a ~25x slowdown was enough
// to blow the old 200ms ceiling — and wf27 saw >2500x on a SMALLER script.
// That spread is not a constant multiplier: throttled wall time is real work
// plus however long until something grants the instance CPU again, so the tail
// is unbounded and no ceiling is truly safe. 15000ms buys ~1900x headroom on
// an 8ms script, enough to cover a wf27-class event, while staying 4x tighter
// than job_executor's 60000 — right for a surface that fires on every
// mutation. A stalled rule is still loud and obvious within one event.
//
// The real fix is running the chain with CPU allocated (Cloud Tasks, or
// `--no-cpu-throttling` on the service); with that enabled this never binds.
// Until then TRIGGER_CODE_TIMEOUT_MS can be raised with a config-only
// revision if a legitimate rule trips it again. No per-rule override and no
// upper cap: unlike job_executor's `timeout_ms` (which comes from step config)
// this value is operator-set, so there is nothing to clamp.
const CODE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.TRIGGER_CODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15000;
})();
function _runCode(code, envelope) {
  const ctx = vm.createContext(Object.create(null));
  ctx.input = envelope;
  const script = new vm.Script(`(function(input){ ${code} \n})(input)`);
  const startedAt = Date.now();
  try {
    return script.runInContext(ctx, { timeout: CODE_TIMEOUT_MS });
  } catch (err) {
    // Same enrichment as job_executor's custom_code path: vm names the limit
    // but not the actual elapsed wall time, which is the diagnostic that
    // separates "slow code" from "starved instance". Both callers
    // (_evaluateMatch / _runTransform) interpolate err.message verbatim, so
    // this lands in trigger_executions.outcomes.warnings as-is.
    if (/Script execution timed out/i.test(err.message || '')) {
      const e = new Error(
        `${err.message} (elapsed ${Date.now() - startedAt}ms). ` +
        `A trivial script that exceeds this is almost always a throttled ` +
        `Cloud Run instance, not slow code — check whether the chain ran detached.`
      );
      e.code = 'TRIGGER_CODE_TIMEOUT';
      throw e;
    }
    throw err;
  }
}

// Review S6: total-dispatch budget per ROOT event (MAX_DEPTH bounds chain
// length; this bounds total work — 2 rules × 3 re-emitting actions can fan
// to ~3^4 dispatches from one mutation without it).
const MAX_DISPATCHES_PER_ROOT = 50;

// ─────────────────────────────────────────────────────────────
// RULE LOADING
// ─────────────────────────────────────────────────────────────

/**
 * Load active rules for one event type, with their active actions joined in.
 * Two queries (rules, then actions) — same rationale as the ingest service.
 * Rules ordered position ASC, id ASC; actions position ASC, id ASC per rule.
 */
async function listActiveRulesForEvent(db, eventType) {
  // R4/S6: `cooling_down` and `secs_since_match` are computed BY THE DATABASE,
  // deliberately — not in JS from last_matched_at. The pool runs timezone:'Z',
  // so DATETIME columns arrive as Dates whose ISO string is the stored WALL
  // CLOCK (see domainEvents._diffNorm); subtracting that from Date.now() is
  // only correct while the server happens to run UTC. Letting MySQL compare
  // its own NOW() to its own column is exact, free (same query), and survives
  // a server timezone change. Evaluated at load time — a few ms before the
  // match, which is ample precision for a throttle measured in seconds.
  const [rules] = await db.query(
    `SELECT id, event_type, name, match_mode, match_config,
            transform_mode, transform_config, min_interval_s,
            TIMESTAMPDIFF(SECOND, last_matched_at, NOW()) AS secs_since_match,
            CASE WHEN min_interval_s > 0
                  AND last_matched_at IS NOT NULL
                  AND last_matched_at > DATE_SUB(NOW(), INTERVAL min_interval_s SECOND)
                 THEN 1 ELSE 0 END AS cooling_down
       FROM trigger_rules
      WHERE active = 1 AND event_type = ?
      ORDER BY position ASC, id ASC`,
    [eventType]
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT id, rule_id, name, action_type, config, position
       FROM trigger_rule_actions
      WHERE active = 1 AND rule_id IN (${placeholders})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ruleIds
  );

  const actionsByRule = new Map();
  for (const a of actions) {
    if (!actionsByRule.has(a.rule_id)) actionsByRule.set(a.rule_id, []);
    actionsByRule.get(a.rule_id).push(a);
  }
  for (const r of rules) r.actions = actionsByRule.get(r.id) || [];
  return rules;
}

// ─────────────────────────────────────────────────────────────
// MATCH EVALUATION  (semantics verbatim from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {{ matched: boolean, error: string|null }}
 *
 * T9/GAP-1. This used to return a bare boolean, which made FOUR distinct
 * failure modes — unparseable match_config, a throwing conditions evaluation,
 * a throwing code sandbox, and an unknown match_mode — indistinguishable from
 * an honest "this event doesn't match". Each console.warn'd and returned
 * false; the execution row then read `no_match`, green, with nothing in
 * `outcomes.warnings` and NULL in `error`. A rule that could not be evaluated
 * at all left no queryable trace anywhere.
 *
 * That is the T2/F-3/F-8 shape exactly: a failure occurring outside the
 * per-action loop produces no outcome entry. Note the asymmetry it created
 * with the very next block — a failed TRANSFORM was a warning, a failure, and
 * an alert; a failed MATCH was a line on stderr.
 *
 * FAIL-SAFE IS UNCHANGED. `matched` is still false on every error path: a
 * broken rule must never fire actions. Only the reporting changed — the
 * caller now records the reason and alerts on it.
 */
function _evaluateMatch(rule, envelope) {
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      const err = `match_config is not parseable JSON: ${e.message}`;
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return { matched: false, error: err };
    }
  }

  if (rule.match_mode === 'conditions') {
    // NULL → non-match (NOT match-all) — hookFilter.evaluateConditions(null,…)
    // returns TRUE, which for an automation rule would silently fire on every
    // event. Explicit always-match = {operator:'and', conditions:[]}.
    if (config == null) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `For an explicit always-match, use {operator:'and', conditions:[]}.`
      );
      // MISCONFIGURATION, not an error: NULL-is-non-match is a documented,
      // deliberate ruling (see the comment above), and a rule saved this way
      // is authored-but-inert rather than broken at runtime. Reporting it as a
      // match failure would alert on every event for a state the author chose.
      return { matched: false, error: null };
    }
    try {
      return { matched: !!evaluateConditions(config, envelope), error: null };
    } catch (err) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}) conditions error: ${err.message}`
      );
      return { matched: false, error: `conditions evaluation threw: ${err.message}` };
    }
  }

  if (rule.match_mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): empty code on code mode — non-match`
      );
      return { matched: false, error: `empty code on code match mode` };
    }
    try {
      return { matched: !!_runCode(code, envelope), error: null };
    } catch (err) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}) code error: ${err.message}`
      );
      return { matched: false, error: `match code threw: ${err.message}` };
    }
  }

  console.warn(
    `[triggerService] rule ${rule.id} (${rule.name}): ` +
    `unknown match_mode '${rule.match_mode}' — treating as non-match`
  );
  return { matched: false, error: `unknown match_mode '${rule.match_mode}'` };
}

// ─────────────────────────────────────────────────────────────
// TRANSFORM EVALUATION  (semantics verbatim from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {{ ok:true, output:object } | { ok:false, error:string }}
 */
function _runTransform(rule, envelope) {
  const mode = rule.transform_mode || 'passthrough';

  if (mode === 'passthrough') {
    return { ok: true, output: envelope };
  }

  let config = rule.transform_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return { ok: false, error: `transform_config is not parseable JSON: ${e.message}` };
    }
  }

  if (mode === 'mapper') {
    if (!Array.isArray(config)) {
      return { ok: false, error: `mapper transform_config must be an array of mapping rules` };
    }
    try {
      const { output, errors } = hookMapper.executeMapper(config, envelope);
      if (errors && errors.length) {
        console.warn(
          `[triggerService] rule ${rule.id} (${rule.name}) mapper warnings: ` + errors.join('; ')
        );
        // Review M4: DIVERGENCE from the ingest copy (which only warns).
        // Every rule errored and nothing mapped → this is a broken transform,
        // not a partial one; feeding {} to actions violates the "never feed
        // garbage" contract. Partial success still passes, with the errors
        // surfaced into the execution row's warnings.
        if (!output || !Object.keys(output).length) {
          return { ok: false, error: `mapper produced no output: ${errors.join('; ')}` };
        }
        return { ok: true, output, warnings: errors };
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `mapper transform threw: ${err.message}` };
    }
  }

  if (mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) return { ok: false, error: `empty code on code transform mode` };
    try {
      const output = _runCode(code, envelope);
      if (output == null || typeof output !== 'object') {
        return { ok: false, error: `code transform must return an object (got ${typeof output})` };
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `code transform threw: ${err.message}` };
    }
  }

  return { ok: false, error: `unknown transform_mode '${mode}'` };
}

// ─────────────────────────────────────────────────────────────
// TARGET SYNTHESIS / HOOK WRAP / RESULT NORMALIZATION
// (verbatim adaptations from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

function _synthesizeTarget(action) {
  const cfg = (action.config && typeof action.config === 'object') ? action.config : {};
  return {
    id:            action.id,
    url:           cfg.url || null,
    method:        cfg.method || 'POST',
    headers:       cfg.headers || {},
    body_mode:     cfg.body_mode || null,
    body_template: cfg.body_template || null,
    credential_id: cfg.credential_id || null,
  };
}

// Hook authors write filter/transform paths against the unified webhook shape
// { body, headers, query, method, meta } — wrap the transformed envelope as
// `body` so trigger-invoked hooks use the identical convention (same ruling
// as ingest Slice 2.3).
function _wrapForHook(transformedInput, rule, action) {
  return {
    body:    transformedInput,
    headers: {},
    query:   {},
    method:  'POST',
    meta: {
      source:         'trigger_rule',
      rule_id:        rule.id,
      rule_action_id: action.id,
      received_at:    new Date().toISOString(),
    },
  };
}

function _normalizeHookResult(hookRet) {
  const status = hookRet && hookRet.status;
  const execId = (hookRet && (hookRet.executionId ?? hookRet.execution_id)) ?? null;

  const SUCCESS = new Set(['delivered', 'filtered', 'captured']);
  const isSuccess = SUCCESS.has(status);

  const out = {
    status: isSuccess ? 'success' : 'failed',
    result: { hook_execution_id: execId, hook_status: status || null },
  };
  if (!isSuccess) {
    out.error = (hookRet && hookRet.error) || `hook returned status '${status || 'unknown'}'`;
  }
  return out;
}

function _extractActionResult(actionType, logData) {
  if (!logData || typeof logData !== 'object') return null;

  let body = null;
  if (typeof logData.response_body === 'string' && logData.response_body) {
    try { body = JSON.parse(logData.response_body); } catch { body = null; }
  }

  switch (actionType) {
    case 'workflow':
      return {
        workflow_execution_id: body?.executionId ?? null,
        workflow_id:           body?.workflowId ?? null,
      };
    case 'sequence':
      return { enrollment_id: body?.enrollmentId ?? body?.enrollment_id ?? null };
    case 'internal_function': {
      // Surface advance_stage-style outputs compactly for the executions view.
      const out = { response_status: logData.response_status ?? null };
      if (body && body.output && typeof body.output === 'object') out.output = body.output;
      return out;
    }
    case 'http':
      // Review M3.4: keep a truncated response body — it's already in logData
      // (10k-capped by the dispatcher) and was being thrown away, leaving
      // failed HTTP actions undiagnosable from the execution row.
      return {
        response_status: logData.response_status ?? null,
        response_body:   typeof logData.response_body === 'string'
                           ? logData.response_body.slice(0, 2000) : null,
      };
    default:
      return { response_status: logData.response_status ?? null };
  }
}

// ─────────────────────────────────────────────────────────────
// METRICS BUMP (fire-and-forget)
// ─────────────────────────────────────────────────────────────

async function _bumpErrorMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE trigger_rules
        SET error_count = error_count + 1, last_error_at = NOW()
      WHERE id IN (${placeholders})`,
    ruleIds
  );
}

async function _bumpMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE trigger_rules
        SET match_count = match_count + 1, last_matched_at = NOW()
      WHERE id IN (${placeholders})`,
    ruleIds
  );
}

// ─────────────────────────────────────────────────────────────
// ACTION DISPATCH — never throws; failures captured into the outcome.
// ─────────────────────────────────────────────────────────────

async function _dispatchAction(db, rule, action, transformedInput) {
  const base = {
    rule_id:        rule.id,
    rule_name:      rule.name,          // denormalized: survives rule deletion (S17e)
    rule_action_id: action.id,
    // DENORMALIZED FOR THE SAME REASON rule_name IS, AND MORE URGENTLY.
    // updateRule replaces a rule's action set wholesale (DELETE all +
    // reinsert), so every edit renumbers the surviving actions. That makes
    // rule_action_id a DANGLING reference the moment anyone touches the rule
    // — and, worse, a silently WRONG one: the id gets reused by an unrelated
    // action, so a reader matching an old execution against today's
    // trigger_rule_actions lands on a real row that had nothing to do with
    // it. Live example (cascade audit 2026-08): executions #242/#249 carry
    // rule_action_id 8/7, ids that now belong to other rules entirely, and
    // the only way to date the edit was to notice the ids could not be right.
    // The name is stable across the reinsert and is what a human reads.
    action_name:    action.name || null,
    action_type:    action.action_type,
  };

  // Review S6: total-dispatch budget for this root event's whole chain.
  const counters = domainEvents.currentCounters();
  if (counters && counters.dispatches >= MAX_DISPATCHES_PER_ROOT) {
    if (!counters.budgetAlerted) {
      counters.budgetAlerted = true;
      try {
        const { alert } = require('../lib/alerting');
        alert(db, {
          source: 'app', kind: 'trigger_budget_exhausted', severity: 'warning',
          group_key: 'trigger_budget',
          title: `Trigger dispatch budget (${MAX_DISPATCHES_PER_ROOT}) exhausted`,
          message: `Rule ${rule.id} (${rule.name}) and later actions skipped for this root event — likely rule fan-out.`,
          // Split-phase dispatch (2026-08-30): budgetAlerted is per-PROCESS
          // and the tree now spans several requests, so the in-memory flag
          // alone would write one alert row per drained node of a runaway
          // fan-out — exactly when the alert table is least useful. rootId
          // rides on the counters object (set by lib/domainEventDrain.js),
          // and lib/alerting.js switches to INSERT IGNORE whenever
          // dedup_key is present, so this collapses the whole tree to one
          // row. Absent rootId (no queue row — dry runs, direct
          // processEvent calls in tests) it stays undefined and the old
          // un-deduped behaviour applies, which is correct there.
          ...(counters.rootId ? { dedup_key: `trigger_budget:${counters.rootId}` } : {}),
        }).catch(() => {});
      } catch (_) {}
    }
    return { ...base, status: 'skipped', error: `dispatch budget (${MAX_DISPATCHES_PER_ROOT}/root event) exhausted` };
  }
  if (counters) counters.dispatches++;

  let config = action.config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return { ...base, status: 'failed', error: `config not parseable JSON: ${e.message}` };
    }
  }
  if (config == null || typeof config !== 'object') config = {};

  try {
    if (action.action_type === 'hook') {
      // Lazy require — hookService transitively reaches delivery engines.
      const hookService = require('./hookService');
      const slug = config.slug;
      if (!slug) {
        return { ...base, status: 'failed', error: `hook action missing config.slug` };
      }
      const wrapped = _wrapForHook(transformedInput, rule, action);
      const hookRet = await hookService.executeHook(db, slug, wrapped);
      const norm = _normalizeHookResult(hookRet);
      return { ...base, status: norm.status, ...(norm.error ? { error: norm.error } : {}), result: norm.result };
    }

    const target = _synthesizeTarget({ ...action, config });
    const ret = await actionDispatchers.dispatch(
      db,
      action.action_type,
      config,
      transformedInput,
      {
        target,
        source:         'trigger_rule',
        rule_id:        rule.id,
        rule_action_id: action.id,
      }
    );
    return {
      ...base,
      status: ret.status === 'success' ? 'success' : 'failed',
      ...(ret.error ? { error: ret.error } : {}),
      result: _extractActionResult(action.action_type, ret.result),
    };
  } catch (err) {
    return { ...base, status: 'failed', error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// EXECUTION LOG
// ─────────────────────────────────────────────────────────────

async function _insertExecution(db, envelope, { status, rulesMatched = 0, outcomes = null, error = null }) {
  try {
    const [res] = await db.query(
      `INSERT INTO trigger_executions
         (event_type, contact_id, case_id, depth, status, rules_matched, outcomes, envelope, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        envelope.event,
        envelope.contact_id ?? null,
        envelope.case_id ?? null,
        envelope.depth ?? 0,
        status,
        rulesMatched,
        outcomes ? JSON.stringify(outcomes) : null,
        JSON.stringify(envelope),
        error,
      ]
    );
    return res.insertId;
  } catch (err) {
    // Never let audit failure disturb anything upstream.
    console.error(`[triggerService] execution log insert failed (${envelope.event}):`, err.message);
    return null;
  }
}

/**
 * no_rules rows exist ONLY as sample-envelope stock for the authoring UI —
 * cap them (Review S7): keep inserting until the event type has 20 recent
 * ones, then stop paying a JSON INSERT per mutation for events nobody
 * consumes. The derived-table wrapper dodges MySQL error 1093
 * (INSERT…SELECT from the target table).
 */
async function _insertNoRulesCapped(db, envelope) {
  try {
    await db.query(
      `INSERT INTO trigger_executions
         (event_type, contact_id, case_id, depth, status, rules_matched, envelope)
       SELECT ?, ?, ?, ?, 'no_rules', 0, ?
         FROM DUAL
        WHERE (SELECT cnt FROM (
                 SELECT COUNT(*) AS cnt FROM trigger_executions
                  WHERE event_type = ? AND status = 'no_rules'
                    AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
               ) x) < 20`,
      [
        envelope.event,
        envelope.contact_id ?? null,
        envelope.case_id ?? null,
        envelope.depth ?? 0,
        JSON.stringify(envelope),
        envelope.event,
      ]
    );
  } catch (err) {
    console.error(`[triggerService] no_rules insert failed (${envelope.event}):`, err.message);
  }
}

/**
 * R4/P1: one trigger_execution_rules row per MATCHED rule of one execution.
 *
 * Why a table and not a query over trigger_executions.outcomes: "what did
 * THIS rule do lately" against a JSON column means a full scan of a 30–90 day
 * retention window. idx_rule_time answers it with a range read.
 *
 * rule_name is denormalized on purpose — the row must still be readable after
 * the rule is deleted (same contract as the rule_name carried in each action
 * outcome). Rows are cleaned up by the FK's ON DELETE CASCADE when the
 * retention sweep deletes their parent execution.
 *
 * Single batched INSERT, own try: audit failure must never disturb the engine.
 *
 * @param {number|null} execId  parent trigger_executions.id (skip when null —
 *                              the FK has nothing to point at)
 * @param {Array<{rule_id:number, rule_name:string, action_count:number, failed_count:number}>} perRule
 */
async function _insertExecutionRules(db, execId, perRule) {
  if (execId == null || !Array.isArray(perRule) || !perRule.length) return;
  try {
    const values = [];
    const params = [];
    for (const r of perRule) {
      values.push('(?, ?, ?, ?, ?)');
      params.push(execId, r.rule_id, String(r.rule_name ?? '').slice(0, 255),
                  r.action_count | 0, r.failed_count | 0);
    }
    await db.query(
      `INSERT INTO trigger_execution_rules
         (execution_id, rule_id, rule_name, action_count, failed_count)
       VALUES ${values.join(', ')}`,
      params
    );
  } catch (err) {
    console.error(`[triggerService] execution-rules audit insert failed (exec ${execId}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR — called by domainEvents.emit (fire-and-forget path)
// ─────────────────────────────────────────────────────────────

/**
 * Process one domain event: depth-cap check → load rules for the event type →
 * match → transform → dispatch actions → execution row + metrics.
 *
 * May throw only on truly unexpected engine errors; domainEvents.emit catches
 * and alerts. Per-rule / per-action failures never throw out of here.
 */
async function processEvent(db, envelope) {
  // Depth cap — the loop-guard backstop.
  if ((envelope.depth ?? 0) >= domainEvents.MAX_DEPTH) {
    console.warn(
      `[triggerService] DEPTH CAP: dropping ${envelope.event} at depth ${envelope.depth} ` +
      `(chain: ${JSON.stringify(envelope.chain)})`
    );
    await _insertExecution(db, envelope, {
      status: 'depth_capped',
      error:  `depth ${envelope.depth} >= MAX_DEPTH ${domainEvents.MAX_DEPTH}; chain ${JSON.stringify(envelope.chain)}`,
    });
    try {
      const { alert } = require('../lib/alerting');
      alert(db, {
        source: 'app', kind: 'trigger_depth_capped', severity: 'warning',
        group_key: 'trigger_depth',
        title: `Trigger chain depth cap hit on ${envelope.event}`,
        message: `Likely a rule loop. Chain: ${JSON.stringify(envelope.chain)}`,
        context: { event: envelope.event, chain: envelope.chain },
      }).catch(() => {});
    } catch (_) {}
    return { status: 'depth_capped' };
  }

  let rules;
  try {
    rules = await listActiveRulesForEvent(db, envelope.event);
  } catch (err) {
    await _insertExecution(db, envelope, { status: 'error', error: `rule load failed: ${err.message}` });
    throw err;
  }

  if (!rules.length) {
    await _insertNoRulesCapped(db, envelope);
    return { status: 'no_rules' };
  }

  // ── Phase 1: match + transform every rule (no side effects yet) ──────────
  const matchedRuleIds = [];
  const warnings       = [];
  const planned        = [];   // [{ rule, transformed }] — rules whose actions will dispatch
  const failedTransformRules = [];
  // T9/GAP-1: rules that could not be EVALUATED (as distinct from rules that
  // evaluated to false). Deliberately NOT folded into `failures` below: a
  // rule that never got evaluated never matched, so counting it there would
  // make `partial`/`error` mean something other than "actions of a matched
  // rule failed". These get their own warning and their own alert kind.
  const failedMatchRules = [];   // [{ rule, error }]

  for (const rule of rules) {
    const mv = _evaluateMatch(rule, envelope);
    if (mv.error) {
      const w = `rule ${rule.id} (${rule.name}) match failed: ${mv.error} — rule did not run`;
      console.warn(`[triggerService] ${w}`);
      warnings.push(w);
      failedMatchRules.push({ rule, error: mv.error });
    }
    if (!mv.matched) continue;

    // R4/S6 cooldown. RULING: a cooldown-suppressed rule is NOT matched — no
    // match_count bump, no last_matched_at refresh, no actions. Counting it as
    // matched would both inflate the metric and (worse) re-arm the window on
    // every suppressed event, so a rule under sustained load could never fire
    // again. Suppression is a warning, not a failure: error_count is untouched
    // and the alerting path is not involved. Throttling is the intent.
    if (rule.cooling_down) {
      const w = `rule ${rule.id} (${rule.name}) skipped_cooldown: matched ` +
                `${rule.secs_since_match}s ago, min_interval_s=${rule.min_interval_s}`;
      console.log(`[triggerService] ${w}`);
      warnings.push(w);
      continue;
    }

    // Matched (regardless of transform/action outcomes) — same contract as
    // the ingest service: matched reflects MATCH.
    matchedRuleIds.push(rule.id);

    const tr = _runTransform(rule, envelope);
    if (tr.warnings && tr.warnings.length) {
      warnings.push(...tr.warnings.map(w => `rule ${rule.id} (${rule.name}) mapper: ${w}`));
    }
    if (!tr.ok) {
      const w = `rule ${rule.id} (${rule.name}) transform failed: ${tr.error} — actions skipped`;
      console.warn(`[triggerService] ${w}`);
      warnings.push(w);
      failedTransformRules.push(rule);
      continue;
    }
    planned.push({ rule, transformed: tr.output });
  }

  // ── Phase 2: write the execution row BEFORE dispatching (Review S12) —
  // if the process dies or Cloud Run throttles mid-dispatch, the event was
  // still SEEN. Status here is provisional; Phase 4 finalizes it.
  const execId = await _insertExecution(db, envelope, {
    status: matchedRuleIds.length ? 'matched' : 'no_match',
    rulesMatched: matchedRuleIds.length,
    outcomes: {
      matched_rule_ids: matchedRuleIds,
      action_outcomes:  [],
      ...(warnings.length ? { warnings } : {}),
      ...(planned.length ? { dispatch_pending: true } : {}),
    },
  });

  // ── Phase 3: dispatch ────────────────────────────────────────────────────
  const actionOutcomes = [];
  for (const { rule, transformed } of planned) {
    for (const action of rule.actions) {
      // ALS child scope: any emit() reached through this action's side
      // effects carries depth+1 and this rule on the chain.
      const outcome = await domainEvents.runAsAction(rule.id, () =>
        _dispatchAction(db, rule, action, transformed)
      );
      actionOutcomes.push(outcome);
    }
  }

  // ── Phase 4: derive the FINAL status from what actually happened
  // (Review M3 — a rule whose every action failed must not read as a green
  // `matched` row). Failed transforms count as failures too: the rule was
  // supposed to do something and did nothing.
  const failures  = actionOutcomes.filter(o => o.status !== 'success').length
                  + failedTransformRules.length;
  const successes = actionOutcomes.filter(o => o.status === 'success').length;
  let status = 'no_match';
  if (matchedRuleIds.length) {
    if (failures > 0 && successes === 0) status = 'error';
    else if (failures > 0)               status = 'partial';
    else                                 status = 'matched';
  }

  let errorSummary = null;
  if (status === 'error' || status === 'partial') {
    const parts = [];
    for (const o of actionOutcomes) {
      if (o.status !== 'success') parts.push(`rule ${o.rule_id} ${o.action_type}: ${o.error || o.status}`);
    }
    for (const r of failedTransformRules) parts.push(`rule ${r.id} transform failed`);
    errorSummary = parts.join(' | ').slice(0, 500) || null;
  }

  const finalOutcomes = {
    matched_rule_ids: matchedRuleIds,
    action_outcomes:  actionOutcomes,
    ...(warnings.length ? { warnings } : {}),
  };

  if (execId != null) {
    await db.query(
      `UPDATE trigger_executions SET status = ?, outcomes = ?, error = ? WHERE id = ?`,
      [status, JSON.stringify(finalOutcomes), errorSummary, execId]
    ).catch(err => console.error('[triggerService] execution finalize failed:', err.message));

    // ── R4/P1: per-rule audit rows (after finalize; own catch inside) ──────
    // One row per MATCHED rule. action_count = outcomes dispatched for that
    // rule; failed_count = its non-success outcomes ('failed' and 'skipped' —
    // a budget-skipped action did not do its job either). A rule whose
    // transform failed dispatched nothing: 0 actions / 1 failure, which is
    // what "the rule was supposed to do something and did nothing" means in
    // the Phase-4 status derivation above.
    const perRule = new Map();
    for (const rid of matchedRuleIds) {
      const rule = rules.find(r => r.id === rid);
      perRule.set(rid, {
        rule_id: rid,
        rule_name: rule ? rule.name : `(rule ${rid})`,
        action_count: 0,
        failed_count: 0,
      });
    }
    for (const o of actionOutcomes) {
      const e = perRule.get(o.rule_id);
      if (!e) continue;                       // defensive; every outcome has a matched rule
      e.action_count++;
      if (o.status !== 'success') e.failed_count++;
    }
    for (const r of failedTransformRules) {
      const e = perRule.get(r.id);
      if (e) e.failed_count++;
    }
    await _insertExecutionRules(db, execId, [...perRule.values()]);
  }

  // ── Phase 5: metrics + alerting ──────────────────────────────────────────
  if (matchedRuleIds.length) {
    _bumpMetrics(db, matchedRuleIds)
      .catch(err => console.error('[triggerService] metrics bump failed:', err.message));
  }

  // T9/GAP-1: an unevaluatable rule is a broken rule — bump its error metric
  // alongside transform/action failures so the T2 UI's per-rule error_count and
  // last_error_at tell the truth about it. It is kept OUT of `failures` above
  // (see failedMatchRules) so the execution STATUS keeps its meaning; only the
  // rule-level metric and the alert below report it.
  if (failedMatchRules.length) {
    _bumpErrorMetrics(db, [...new Set(failedMatchRules.map(m => m.rule.id))])
      .catch(err => console.error('[triggerService] match-error metrics bump failed:', err.message));

    // Dedicated kind. NOT folded into 'trigger_action_failed': that kind feeds
    // dedup_key and group_key on existing rows and its title says "action
    // failure", which this is not. Adding a kind is safe — the standing
    // constraint is against RENAMING one (which orphans every existing
    // system_alerts row), not against introducing a new one.
    //
    // Date-bucketed dedup_key (same idiom as alerting.js's sweep scan_error
    // sites): a permanently corrupt rule fires on EVERY event of its type, so
    // without this a single bad match_config would insert thousands of rows a
    // day. One row per rule per UTC day — bounded, and it re-arms tomorrow so a
    // fixed-then-re-broken rule alerts again. group_key matches
    // trigger_action_failed's `trigger_rule_${id}` so the digest and the shell
    // banner see one ongoing condition per rule regardless of how it is failing.
    try {
      const { alert } = require('../lib/alerting');
      const day = new Date().toISOString().slice(0, 10);
      for (const { rule, error } of failedMatchRules) {
        alert(db, {
          source: 'app', kind: 'trigger_match_failed', severity: 'warning',
          group_key: `trigger_rule_${rule.id}`,
          title: `Trigger rule ${rule.id} (${rule.name}) could not be evaluated on ${envelope.event}`,
          message:
            `${error}. The rule is active but cannot run, so it is silently ` +
            `firing on nothing — its match config needs fixing.`,
          context: { execution_id: execId, rule_id: rule.id, event: envelope.event,
                     match_mode: rule.match_mode, error },
          dedup_key: `trigger:match_failed:${rule.id}:${day}`,
        }).catch(() => {});
      }
    } catch (_) { /* alerting unavailable — the warning is already on the row */ }
  }

  const failedRuleIds = [...new Set([
    ...actionOutcomes.filter(o => o.status !== 'success').map(o => o.rule_id),
    ...failedTransformRules.map(r => r.id),
  ])];
  if (failedRuleIds.length) {
    _bumpErrorMetrics(db, failedRuleIds)
      .catch(err => console.error('[triggerService] error metrics bump failed:', err.message));
    // One alert per failing rule, grouped so the hourly sweep and shell
    // banner see a persistent failure as ONE ongoing condition (Review M3.2).
    try {
      const { alert } = require('../lib/alerting');
      for (const rid of failedRuleIds) {
        const rule = rules.find(r => r.id === rid);
        alert(db, {
          source: 'app', kind: 'trigger_action_failed', severity: 'warning',
          group_key: `trigger_rule_${rid}`,
          title: `Trigger rule ${rid} (${rule ? rule.name : '?'}) action failure on ${envelope.event}`,
          message: errorSummary || 'see execution row outcomes',
          context: { execution_id: execId, event: envelope.event, case_id: envelope.case_id, contact_id: envelope.contact_id },
        }).catch(() => {});
      }
    } catch (_) {}
  }

  return {
    status, matchedRuleIds, actionOutcomes, warnings, execution_id: execId,
    // T9/GAP-1: rule ids that could not be evaluated. Additive — existing
    // consumers branch on status/matchedRuleIds only.
    failedMatchRuleIds: failedMatchRules.map(m => m.rule.id),
  };
}

// ─────────────────────────────────────────────────────────────
// DRY RUN — match + transform only; NOTHING dispatches, no execution row,
// no metrics. Backs POST /api/triggers/test.
// ─────────────────────────────────────────────────────────────

async function evaluateDryRun(db, envelope) {
  const rules = await listActiveRulesForEvent(db, envelope.event);
  const report = [];

  for (const rule of rules) {
    const mv = _evaluateMatch(rule, envelope);
    const entry = {
      rule_id: rule.id,
      name:    rule.name,
      matched: mv.matched,
      // T9/GAP-1: surface WHY a rule didn't match when the reason is a broken
      // config rather than an honest false. The test panel is where an author
      // is most likely to be looking at a rule they just broke; `matched:false`
      // with no explanation sent them hunting the envelope instead.
      ...(mv.error ? { match_error: mv.error } : {}),
    };
    if (entry.matched) {
      const tr = _runTransform(rule, envelope);
      entry.transform_ok = tr.ok;
      if (!tr.ok) {
        entry.transform_error = tr.error;
      } else {
        entry.transformed = tr.output;
        entry.would_fire = rule.actions.map(a => ({
          rule_action_id: a.id,
          name:           a.name,
          action_type:    a.action_type,
        }));
      }
    }
    report.push(entry);
  }
  return { rules_evaluated: rules.length, report };
}

/**
 * Evaluate a DRAFT (unsaved) match+transform config against one envelope —
 * the ingest test-match precedent (Slice 10A) applied to triggers: the T2
 * editor tests its CURRENT state without saving. Pure function, no DB, no
 * dispatch, no rows.
 *
 * @param {{match_mode, match_config, transform_mode, transform_config}} draft
 * @param {object} envelope
 * @returns {{matched:boolean, match_error?:string, transform_ok?:boolean, transformed?:object, transform_error?:string}}
 */
function evaluateDraft(draft, envelope) {
  const rule = {
    id: 0,
    name: '(draft)',
    match_mode:       draft.match_mode || 'conditions',
    match_config:     draft.match_config ?? null,
    transform_mode:   draft.transform_mode || 'passthrough',
    transform_config: draft.transform_config ?? null,
  };
  const mv = _evaluateMatch(rule, envelope);
  const out = { matched: mv.matched, ...(mv.error ? { match_error: mv.error } : {}) };
  if (out.matched) {
    const tr = _runTransform(rule, envelope);
    out.transform_ok = tr.ok;
    if (tr.ok) out.transformed = tr.output;
    else out.transform_error = tr.error;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// CRUD — backs routes/api.triggers.js
// ─────────────────────────────────────────────────────────────

function _badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function _notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }

function _validateRuleFields(fields, { partial = false } = {}) {
  if (!partial || fields.event_type !== undefined) {
    if (!fields.event_type || !EVENT_TYPES[fields.event_type]) {
      throw _badRequest(
        `event_type must be one of: ${Object.keys(EVENT_TYPES).join(', ')}`
      );
    }
  }
  if (!partial || fields.name !== undefined) {
    if (!fields.name || !String(fields.name).trim()) throw _badRequest('name is required');
  }
  if (fields.match_mode !== undefined && !['conditions', 'code'].includes(fields.match_mode)) {
    throw _badRequest(`match_mode must be 'conditions' or 'code'`);
  }
  if (fields.transform_mode !== undefined &&
      !['passthrough', 'mapper', 'code'].includes(fields.transform_mode)) {
    throw _badRequest(`transform_mode must be 'passthrough', 'mapper', or 'code'`);
  }
  // R4/S6. The column is NOT NULL DEFAULT 0 and sql_mode lacks
  // STRICT_TRANS_TABLES, so a negative or non-numeric value would be coerced
  // silently rather than rejected — validate at the door instead.
  if (fields.min_interval_s !== undefined && fields.min_interval_s !== null) {
    const n = Number(fields.min_interval_s);
    if (!Number.isFinite(n) || n < 0) {
      throw _badRequest('min_interval_s must be a number >= 0 (0 = no cooldown)');
    }
  }
}

function _validateActions(actions) {
  if (!Array.isArray(actions)) throw _badRequest('actions must be an array');
  actions.forEach((a, i) => {
    if (!a || !ACTION_TYPES.has(a.action_type)) {
      throw _badRequest(
        `actions[${i}].action_type must be one of: ${[...ACTION_TYPES].join(', ')}`
      );
    }
    if (a.config == null || typeof a.config !== 'object') {
      throw _badRequest(`actions[${i}].config must be an object`);
    }
    // Review S4: required-config checks at WRITE time — a rule that can only
    // fail at dispatch (after a live event fired) is a booby trap. The empty
    // UI select produces Number('') = 0 — reject non-positive ids too.
    const c = a.config;
    switch (a.action_type) {
      case 'workflow':
        if (!(Number(c.workflow_id) > 0)) throw _badRequest(`actions[${i}]: workflow_id required`);
        break;
      case 'sequence':
        if (!(Number(c.template_id) > 0) && !c.template_type) {
          throw _badRequest(`actions[${i}]: template_id (or template_type) required`);
        }
        break;
      case 'hook':
        if (!c.slug || !String(c.slug).trim()) throw _badRequest(`actions[${i}]: slug required`);
        break;
      case 'internal_function': {
        if (!c.function_name || !String(c.function_name).trim()) {
          throw _badRequest(`actions[${i}]: function_name required`);
        }
        // Same booby-trap argument as the id checks above, one level deeper: a
        // params_mapping can be syntactically fine and still resolve to a value
        // the function must reject, and until it is dispatched nothing says so.
        // Currently covers csvList params (advance_stage guards) — see the
        // CSV LIST PARAMS block in lib/internal_functions/index.js.
        // Lazy require (house convention, and it keeps triggerService's module
        // init off the 70-file internal_functions graph — that graph eagerly
        // reaches lib/domainEvents, which lazily reaches back here).
        const internalFunctions = require('../lib/internal_functions');
        const pmErr = internalFunctions.__validateParamsMapping(
          String(c.function_name).trim(), c.params_mapping
        );
        if (pmErr) throw _badRequest(`actions[${i}]: ${pmErr.error}`);
        break;
      }
      case 'http':
        if (!c.url || !String(c.url).trim()) throw _badRequest(`actions[${i}]: url required`);
        break;
    }
  });
}

async function listRules(db, { event_type = null } = {}) {
  const where = [];
  const params = [];
  if (event_type) { where.push('event_type = ?'); params.push(event_type); }
  const [rules] = await db.query(
    `SELECT * FROM trigger_rules
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY event_type ASC, position ASC, id ASC`,
    params
  );
  if (!rules.length) return rules;
  const ids = rules.map(r => r.id);
  const [actions] = await db.query(
    `SELECT * FROM trigger_rule_actions
      WHERE rule_id IN (${ids.map(() => '?').join(',')})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ids
  );
  const byRule = new Map();
  for (const a of actions) {
    if (!byRule.has(a.rule_id)) byRule.set(a.rule_id, []);
    byRule.get(a.rule_id).push(a);
  }
  for (const r of rules) r.actions = byRule.get(r.id) || [];
  return rules;
}

async function getRule(db, id) {
  const [[rule]] = await db.query(`SELECT * FROM trigger_rules WHERE id = ?`, [id]);
  if (!rule) throw _notFound(`trigger rule ${id} not found`);
  const [actions] = await db.query(
    `SELECT * FROM trigger_rule_actions WHERE rule_id = ? ORDER BY position ASC, id ASC`,
    [id]
  );
  rule.actions = actions;
  return rule;
}

/**
 * Create a rule (+ optional actions array in the same call).
 */
async function createRule(db, fields, { userId = null } = {}) {
  _validateRuleFields(fields);
  if (fields.actions !== undefined) _validateActions(fields.actions);

  const {
    event_type, name, description = null, active = 1, position = 0,
    min_interval_s = 0,
    match_mode = 'conditions', match_config = null,
    transform_mode = 'passthrough', transform_config = null,
    actions = [],
  } = fields;

  return db.withTransaction(async (conn) => {
    const [res] = await conn.query(
      `INSERT INTO trigger_rules
         (event_type, name, description, active, position, min_interval_s,
          match_mode, match_config, transform_mode, transform_config, last_modified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event_type, String(name).trim(), description, active ? 1 : 0, position,
        Math.max(0, parseInt(min_interval_s, 10) || 0),
        match_mode, match_config == null ? null : JSON.stringify(match_config),
        transform_mode, transform_config == null ? null : JSON.stringify(transform_config),
        userId,
      ]
    );
    const ruleId = res.insertId;
    for (const [i, a] of actions.entries()) {
      await conn.query(
        `INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ruleId, a.name || null, a.position ?? i, a.active === false ? 0 : 1,
         a.action_type, JSON.stringify(a.config)]
      );
    }
    return ruleId;
  }).then(ruleId => getRule(db, ruleId));
}

/**
 * Partial update. If `actions` is present it REPLACES the rule's full action
 * set (delete-all + reinsert, transactional) — same "authoritative array"
 * semantics as the contact aggregate reconcilers, but simpler because
 * actions have no cross-table references.
 */
async function updateRule(db, id, fields, { userId = null } = {}) {
  await getRule(db, id); // 404 guard
  _validateRuleFields(fields, { partial: true });
  if (fields.actions !== undefined) _validateActions(fields.actions);

  // The rule-column whitelist for partial updates. Anything not listed here is
  // ignored by PUT — adding a rule column means adding it here too (R4/S6
  // added min_interval_s).
  const COLS = ['event_type', 'name', 'description', 'active', 'position',
                'min_interval_s',
                'match_mode', 'match_config', 'transform_mode', 'transform_config'];
  const JSON_COLS = new Set(['match_config', 'transform_config']);

  const sets = [];
  const vals = [];
  for (const c of COLS) {
    if (fields[c] === undefined) continue;
    sets.push(`\`${c}\` = ?`);
    if (JSON_COLS.has(c)) {
      vals.push(fields[c] == null ? null : JSON.stringify(fields[c]));
    } else if (c === 'active') {
      vals.push(fields[c] ? 1 : 0);
    } else if (c === 'min_interval_s') {
      vals.push(Math.max(0, parseInt(fields[c], 10) || 0));
    } else {
      vals.push(fields[c]);
    }
  }
  sets.push('last_modified_by = ?');
  vals.push(userId);

  await db.withTransaction(async (conn) => {
    await conn.query(
      `UPDATE trigger_rules SET ${sets.join(', ')} WHERE id = ?`,
      [...vals, id]
    );
    if (fields.actions !== undefined) {
      await conn.query(`DELETE FROM trigger_rule_actions WHERE rule_id = ?`, [id]);
      for (const [i, a] of fields.actions.entries()) {
        await conn.query(
          `INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, a.name || null, a.position ?? i, a.active === false ? 0 : 1,
           a.action_type, JSON.stringify(a.config)]
        );
      }
    }
  });
  return getRule(db, id);
}

async function deleteRule(db, id) {
  await getRule(db, id); // 404 guard
  await db.withTransaction(async (conn) => {
    await conn.query(`DELETE FROM trigger_rule_actions WHERE rule_id = ?`, [id]);
    await conn.query(`DELETE FROM trigger_rules WHERE id = ?`, [id]);
  });
  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────
// EXECUTIONS (read-only)
// ─────────────────────────────────────────────────────────────

async function listExecutions(db, {
  event_type = null, status = null, case_id = null, contact_id = null,
  limit = 50, before_id = null, since = null, until = null,
} = {}) {
  const where = [];
  const params = [];
  if (event_type) { where.push('event_type = ?'); params.push(event_type); }
  if (status)     { where.push('status = ?');     params.push(status); }
  if (case_id)    { where.push('case_id = ?');    params.push(String(case_id)); }
  if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
  if (before_id)  { where.push('id < ?');         params.push(before_id); }
  // T7 created_at window. since inclusive, until EXCLUSIVE (<) so a time-
  // cursor pager never gets back the row it paged from. The route hands in
  // pre-formatted UTC 'YYYY-MM-DD HH:MM:SS' literals (DB runs UTC); ORDER BY
  // id DESC below is created_at-monotonic (autoincrement insert order).
  if (since)      { where.push('created_at >= ?'); params.push(since); }
  if (until)      { where.push('created_at < ?');  params.push(until); }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const [rows] = await db.query(
    `SELECT id, event_type, contact_id, case_id, depth, status, rules_matched,
            error, created_at
       FROM trigger_executions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ${lim}`,
    params
  );
  return rows;
}

async function getExecution(db, id) {
  const [[row]] = await db.query(`SELECT * FROM trigger_executions WHERE id = ?`, [id]);
  if (!row) throw _notFound(`execution ${id} not found`);
  return row;
}

/**
 * R4/P1: recent runs OF ONE RULE — backs the editor's "Recent runs" card.
 *
 * Joined to the parent execution for the event/status/time context the card
 * shows. INNER JOIN is safe: the FK cascade means an audit row cannot outlive
 * its execution. Ordered by ter.id DESC (idx_rule_time) rather than by
 * created_at — same ordering, but it reads straight off the index.
 *
 * Note this returns rows for rules that have since been DELETED too, if the
 * caller knows the id; rule_name is the denormalized survivor.
 */
async function listRuleHistory(db, ruleId, { limit = 20 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const [rows] = await db.query(
    `SELECT ter.id, ter.execution_id, ter.rule_id, ter.rule_name,
            ter.action_count, ter.failed_count,
            ex.event_type, ex.status, ex.case_id, ex.contact_id, ex.created_at
       FROM trigger_execution_rules ter
       JOIN trigger_executions ex ON ex.id = ter.execution_id
      WHERE ter.rule_id = ?
      ORDER BY ter.id DESC
      LIMIT ${lim}`,
    [ruleId]
  );
  return rows;
}

/**
 * Recent envelopes for one event type — the T2 field-discovery/sample panel
 * source (mirrors the ingest UIs' sample blocks).
 */
async function listRecentEnvelopes(db, eventType, { limit = 10 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const [rows] = await db.query(
    `SELECT id, envelope, status, created_at
       FROM trigger_executions
      WHERE event_type = ?
      ORDER BY id DESC
      LIMIT ${lim}`,
    [eventType]
  );
  return rows;
}

module.exports = {
  EVENT_TYPES,
  processEvent,
  evaluateDryRun,
  evaluateDraft,
  listActiveRulesForEvent,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  listExecutions,
  getExecution,
  listRuleHistory,
  listRecentEnvelopes,
};