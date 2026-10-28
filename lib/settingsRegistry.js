// lib/settingsRegistry.js
//
// Settings registry — the ONE list of app_settings keys the code knows
// (settings-config-split arc, 2026-10; ref/plans.md "Settings vs Config").
//
// Same pattern as lib/capabilities.js and public/js/featureRegistry.js: code,
// not config. A key's METADATA lives here — kind, editor home, section, type,
// label, description, posture — and app_settings keeps only its VALUE. The
// DB's category / label / description / type / sort_order / is_editable
// columns describe UNREGISTERED rows only (automation variables a person
// created through the Firm tab); for a registered key they are ignored.
//
// Growing or changing this map is a deliberate change: tests/settingsRegistry
// pins the classification, and the inventory test fails when code reads a key
// that is not here. A new app_settings key = an entry here in the same slice.
//
// ── Fields ─────────────────────────────────────────────────────────────────
//   kind      what the value IS (and, for YC 3.0, who sets it per tenant):
//               firm    — a firm's own choice (tenant-configured)
//               vocab   — a firm vocabulary list (tenant-configured, Config shell)
//               system  — deployment / platform wiring, kill switches, thresholds
//                         (provisioned per tenant by the platform, edited by IT)
//               secret  — a credential; never served by any settings API, never
//                         readable or writable by automation
//               state   — machine-managed runtime state (watermarks, counters,
//                         latches); shown read-only, never edited by a person
//               access  — an interim access list (users.user ids) that a
//                         capability replaces (access-control A6); console only
//               retired — no longer read by the code; kept so the key is never
//                         reused with another meaning (featureRegistry's rule)
//   home      the ONE editor that owns the key (one editor per setting):
//               firm    — Config shell → Firm tab (sections below)
//               portal  — Portal Manager → Settings (portaladmin/portalSettings.html)
//               config  — Config shell vocabulary tabs (Lists; Types & Subtypes)
//               system  — Config shell → System tab
//               comms   — owned by the comms arc; shown in the System tab
//                         until that arc gives it a home of its own
//               cta     — CTA Links (ctaManager.html)
//               console — no editor: the SU db console (secrets, access lists,
//                         retired keys)
//   section   grouping inside the home (SECTIONS below)
//   type      validator / control: TYPES below
//   edit      'ui' (editable in its home by holders of the home's capability)
//             or 'console' (shown read-only, changed from the SU db console)
//   automation  true = automation (set_setting / update_db) may WRITE it. Only
//             registered keys with this flag; unregistered non-secret rows
//             (automation variables) stay writable. Default false.
//   env       lib/firmConfig.js env fallback (blank value → this env var)
//   editor    the home renders this key with a dedicated editor, not a row
//   options   allowed values for type 'enum' (blank always allowed)
//   required  true = a blank value is refused (blank breaks the feature: the
//             code falls back only when the ROW is missing, never on blank)
//   alsoWrite a capability that may ALSO write this key, beside its home's
//             (additive — the home's holders keep it). Staff JWTs only: a
//             machine key is gated by the home's capability. Legal only on
//             a kind firm / vocab key edited in the UI, not automation-
//             writable, in home firm / portal / config, not read through
//             lib/firmConfig, naming a non-root capability — asserted when
//             this module loads (ALSO_WRITE_RULES).
//
// Read / write capability is derived from the home (HOME_CAPS); a key may
// widen WRITE with alsoWrite, in code, never in the DB — so a grant is a
// reviewed change, and the home's editor stays the one place it is edited.
'use strict';

const ms = require('ms');
const { CAPABILITIES } = require('./capabilities');

// ── Homes → capabilities ───────────────────────────────────────────────────
// read: null = any signed-in staff (GET /api/app-settings serves it, as it
// always has for editable rows); a capability name = holders only.
// write: the capability PUT /api/app-settings/:key requires; null = no writes
// through the settings API at all.
const HOME_CAPS = Object.freeze({
  firm:    Object.freeze({ read: null,              write: 'firm.settings' }),
  portal:  Object.freeze({ read: null,              write: 'firm.settings' }),
  config:  Object.freeze({ read: null,              write: 'firm.settings' }),
  cta:     Object.freeze({ read: null,              write: 'system.settings' }),
  system:  Object.freeze({ read: 'system.settings', write: 'system.settings' }),
  comms:   Object.freeze({ read: 'system.settings', write: 'system.settings' }),
  console: Object.freeze({ read: false,             write: null }),   // false = never served
});

const KINDS = Object.freeze(['firm', 'vocab', 'system', 'secret', 'state', 'access', 'retired']);

// Kinds that are never served or written through the settings API, whatever
// their home says (belt and braces: their home is 'console' anyway).
const NEVER_SERVED = Object.freeze(['secret', 'access', 'retired']);

// ── Sections (order = display order) ───────────────────────────────────────
const SECTIONS = Object.freeze({
  firm: Object.freeze([
    { id: 'identity', title: 'Firm identity',                 icon: 'building' },
    { id: 'senders',  title: 'Senders',                       icon: 'paper-plane' },
    { id: 'routing',  title: 'Notifications & routing',       icon: 'route' },
    { id: 'booking',  title: 'Client self-service & booking', icon: 'calendar-check' },
    { id: 'dropbox',  title: 'Dropbox filing',                icon: 'folder-tree' },
    { id: 'esign',    title: 'E-Sign',                        icon: 'file-signature' },
    // Not a registry section: the UNREGISTERED rows (automation variables a
    // person created) are served here by GET /api/app-settings.
    { id: 'variables', title: 'Automation variables',         icon: 'code' },
  ].map(Object.freeze)),
  portal: Object.freeze([{ id: 'portal', title: 'Client portal', icon: 'door-open' }].map(Object.freeze)),
  config: Object.freeze([
    { id: 'lists', title: 'Lists',      icon: 'list' },
    { id: 'types', title: 'Case types', icon: 'tags' },
  ].map(Object.freeze)),
  system: Object.freeze([
    { id: 'platform',     title: 'Platform',                 icon: 'server' },
    { id: 'switches',     title: 'Switches',                 icon: 'toggle-on' },
    { id: 'alerts',       title: 'Alert thresholds',         icon: 'bell' },
    { id: 'integrations', title: 'Integrations',             icon: 'plug' },
    { id: 'state',        title: 'Runtime state (read-only)', icon: 'gauge' },
  ].map(Object.freeze)),
  comms: Object.freeze([{ id: 'comms', title: 'Comms archive & AI', icon: 'headset' }].map(Object.freeze)),
  cta:   Object.freeze([{ id: 'cta', title: 'CTA link defaults', icon: 'hand-pointer' }].map(Object.freeze)),
  console: Object.freeze([{ id: 'console', title: 'SU console only', icon: 'lock' }].map(Object.freeze)),
});

// ── Types ──────────────────────────────────────────────────────────────────
// Validation is PERMISSIVE and NEVER MUTATES (routes/api.appSettings.js
// header): checks run on a trimmed COPY; the stored value is the exact string
// received. A blank value always passes — blank means "unset" and must never
// be un-blankable. string / template are verbatim (no checks) — some values
// carry load-bearing leading/trailing spaces (Dropbox folder names).
const DIGITS_RE = /^\d{1,10}$/;
const MAX_DURATION_MS = ms('365d');   // services/ctaService.js MAX_EXPIRY_MS
const TYPE_VALIDATORS = Object.freeze({
  number(v) {
    return /^-?\d+(\.\d+)?$/.test(v.trim()) || 'must be a number';
  },
  bool(v) {
    return /^[01]$/.test(v.trim()) || 'must be 1 or 0';
  },
  email(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || 'must be a valid email address';
  },
  csv(v) {
    return v.split(',').every((p) => p.trim().length > 0)
      || 'must be a comma-separated list with no empty entries';
  },
  phone(v) {
    const s = v.trim();
    return (/^[+()\d\s.\-]+$/.test(s) && (s.match(/\d/g) || []).length >= 7)
      || 'must be a phone number (digits, spaces, ()+.- allowed)';
  },
  url(v) {
    try {
      const u = new URL(v.trim());
      return (u.protocol === 'http:' || u.protocol === 'https:') || 'must be an http(s) URL';
    } catch {
      return 'must be a valid URL (include https://)';
    }
  },
  json(v) {
    try { JSON.parse(v); return true; }
    catch (e) { return 'must be valid JSON — ' + e.message; }
  },
  json_array(v) {
    try { return Array.isArray(JSON.parse(v)) || 'must be a JSON array'; }
    catch (e) { return 'must be valid JSON — ' + e.message; }
  },
  date(v) {
    // min_client_build semantics (lib/appBuild.js parseMinBuild): off-words,
    // epoch seconds/ms, or anything Date.parse understands.
    const s = v.trim();
    if (/^(0|off|false|no|none|null)$/i.test(s)) return true;
    if (/^\d{10}$/.test(s) || /^\d{13,}$/.test(s)) return true;
    return Number.isFinite(Date.parse(s))
      || 'must be a date (2026-07-12), datetime, epoch ms, or blank/off';
  },
  // Picker types: the client draws a picker; the server only checks the shape.
  user(v)       { return DIGITS_RE.test(v.trim()) || 'must be a user id'; },
  user_csv(v)   {
    return v.split(',').every((p) => DIGITS_RE.test(p.trim())) || 'must be a comma-separated list of user ids';
  },
  credential(v) { return DIGITS_RE.test(v.trim()) || 'must be a credential id'; },
  sequence(v)   { return DIGITS_RE.test(v.trim()) || 'must be a sequence template id'; },
  // A duration the `ms` library reads, WITH a unit: to ms a bare "3" is 3
  // milliseconds, which would mint links that expire at once. > 0, ≤ 365 days
  // (services/ctaService.js reads these with ms() and falls back otherwise).
  duration(v) {
    const s = v.trim();
    if (!/^\d+(\.\d+)?\s*[a-z]+$/i.test(s)) return 'must be a duration with a unit, like 30m, 12h, 3d or 2w';
    const n = ms(s);
    if (!Number.isFinite(n) || n <= 0) return 'must be a duration with a unit, like 30m, 12h, 3d or 2w';
    return n <= MAX_DURATION_MS || 'must be at most 365 days';
  },
});
// string / template / enum have no entry above: string and template are
// verbatim; enum is checked against the entry's options in validate().
const TYPES = Object.freeze(['string', 'template', 'enum', ...Object.keys(TYPE_VALIDATORS)]);

/**
 * Validate a value against a type (the unregistered-row path: the row's own
 * DB type, which may be anything a migration wrote — unknown → verbatim).
 * @returns {true|string}
 */
function validateByType(type, value, options) {
  if (typeof value !== 'string') return 'value must be a string';
  if (value.trim() === '') return true;
  if (type === 'enum') {
    const opts = Array.isArray(options) ? options : [];
    return opts.includes(value.trim()) || `must be one of: ${opts.join(', ')}`;
  }
  const fn = type && TYPE_VALIDATORS[type];
  return fn ? fn(value) : true;
}

// ── The registry ───────────────────────────────────────────────────────────
// Descriptions are generic (no firm names, no people): they are the operator's
// hint today and a new tenant's tomorrow.
const F = (o) => Object.freeze(o);
const SETTINGS = Object.freeze({
  // ═══ firm → Firm tab ═══
  // identity
  firm_name: F({ kind: 'firm', home: 'firm', section: 'identity', type: 'string', sort: 5,
    label: 'Firm name',
    desc: 'The firm\'s legal / display name on generated documents (e-sign contracts, retainers). Blank falls back to a hardcoded name rather than rendering an empty one.' }),
  'fe-firm_logo_url': F({ kind: 'firm', home: 'firm', section: 'identity', type: 'url', sort: 10, env: 'FIRM_LOGO',
    label: 'Firm logo URL', desc: 'Logo shown in the app and on client-facing pages and emails. Blank falls back to the FIRM_LOGO env var.' }),
  'fe-firm_phone': F({ kind: 'firm', home: 'firm', section: 'identity', type: 'phone', sort: 20, env: 'FIRM_PHONE',
    label: 'Firm phone', desc: 'Main firm phone. Canonical format is 10 digits, no punctuation; display formatting happens at render.' }),
  'fe-firm_site_url': F({ kind: 'firm', home: 'firm', section: 'identity', type: 'url', sort: 30, env: 'FIRM_URL',
    label: 'Firm website', desc: 'Public firm website URL.' }),
  firm_email: F({ kind: 'firm', home: 'firm', section: 'identity', type: 'email', sort: 40, env: 'FIRM_EMAIL',
    label: 'Firm email', desc: 'Public-facing office email, used in client-facing templates and pages.' }),
  firm_address: F({ kind: 'firm', home: 'firm', section: 'identity', type: 'json_array', sort: 50,
    label: 'Firm mailing address', desc: 'One JSON string per line, e.g. ["123 Main St., #100","City, ST 00000"]. Used on generated documents (firm.address_line1 / firm.address_line2, or firm.address inline). Blank = no address renders; a template that requires it refuses to send.' }),
  firm_attorney_name: F({ kind: 'firm', home: 'firm', section: 'identity', type: 'string', sort: 60,
    label: 'Signing attorney name', desc: 'The attorney named on generated documents, and stripped from signer lists when identifying the client. Blank falls back to a hardcoded name.' }),

  // senders
  email_automations: F({ kind: 'firm', home: 'firm', section: 'senders', type: 'email', sort: 10, env: 'AUTO_EMAIL',
    label: 'Automations email', desc: 'From-address used by automated emails.' }),
  email_default_from: F({ kind: 'firm', home: 'firm', section: 'senders', type: 'email', sort: 20,
    label: 'Default email from', desc: 'Default sender when a send names none.' }),
  email_domains: F({ kind: 'firm', home: 'firm', section: 'senders', type: 'csv', sort: 30, env: 'EMAIL_DOMAINS',
    label: 'Firm email domains', desc: 'Comma-separated. An email FROM one of these domains is classified as outgoing by the ingest pipeline. Include the @.' }),
  sms_default_from: F({ kind: 'firm', home: 'firm', section: 'senders', type: 'phone', sort: 40,
    label: 'Default SMS from', desc: 'Line used for client texts when a send names none.' }),
  sms_staff_from: F({ kind: 'firm', home: 'firm', section: 'senders', type: 'phone', sort: 50,
    label: 'Staff SMS from', desc: 'Line used for staff alert texts.' }),

  // routing
  email_it: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'email', sort: 10, env: 'IT_EMAIL',
    label: 'IT email', desc: 'Destination for system / IT notifications.' }),
  email_default_to: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'email', sort: 20,
    label: 'Default email to', desc: 'The firm catch-all inbox: recipient when nothing more specific is set (e.g. the event digest).' }),
  alert_recipients: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'csv', sort: 30,
    label: 'Alert recipients', desc: 'Comma-separated emails that receive system alerts.' }),
  alert_from_email: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'email', sort: 40,
    label: 'Alert from email', desc: 'Sender address of system alert emails.' }),
  alert_critical_sms_to: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'phone', sort: 50,
    label: 'Critical alert SMS to', desc: 'Phone that receives a text for critical alerts.' }),
  office_alerts_to: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'user_csv', sort: 60,
    label: 'Office alerts to', desc: 'Staff who receive office alert texts and e-sign / upload follow-up tasks (the first usable user is the assignee).' }),
  billing_tasks_to: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'user', sort: 70,
    label: 'Billing tasks to', desc: 'Staff member who receives payment-failure and late-fee tasks.' }),
  // Read by the payment-failed workflow (get_settings), not by code — until
  // 2026-10-28 an unregistered automation variable.
  payment_failed_cooldown_days: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'number', sort: 75,
    label: 'Payment-failure drip cooldown (days)', desc: 'A client enrolled in the payment-failed drip within this many days is not enrolled again when another payment fails; the billing task is still created. Blank, negative or not a number = 14.' }),
  default_task_assignee: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'user', sort: 80,
    label: 'Default task assignee', desc: 'Gets appointment follow-up tasks (cancel / reschedule-later) when no staff member did the action, e.g. a client cancellation. Unset or not a user: no task is created and an alert is raised.' }),
  intake_review_assignee: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'user', sort: 85,
    label: 'Contact-match review', desc: 'Gets the review task when an intake (website / Calendly / API lead) matches an existing contact by phone or email but under a different name — nothing on the contact is changed until they decide. Unset: the Default task assignee. Neither set, or not a user: no task is created and an alert is raised.' }),
  event_digest_recipients: F({ kind: 'firm', home: 'firm', section: 'routing', type: 'user_csv', sort: 90,
    label: 'Event digest recipients', desc: 'Staff who receive the upcoming-events digest. Blank = the default email to, then the firm email.' }),

  // booking
  manage_cutoff_min: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'number', sort: 20,
    label: 'Manage cutoff (min)', desc: 'Clients cannot cancel or reschedule within this many minutes of the appointment.' }),
  manage_horizon_days: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'number', sort: 30,
    label: 'Manage horizon (days)', desc: 'How far ahead clients can rebook.' }),
  manage_cancel_template: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'template', sort: 40,
    label: 'Cancel SMS template', desc: 'Text sent to a client who cancels from their manage link.' }),
  manage_reschedule_template: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'template', sort: 50,
    label: 'Reschedule SMS template', desc: 'Text sent after a client reschedules. Placeholders resolve against the appointment.' }),
  manage_fallback_url: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'json', sort: 60,
    label: 'Manage fallback link', desc: '{"url": "...", "button_text": "..."} shown when a manage link has expired.' }),
  manage_allow_cancel: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'bool', sort: 62,
    label: 'Client self-cancel', desc: 'Clients may cancel a scheduled appointment from their manage link (1 = yes, 0 = call the office). The cutoff still applies.' }),
  manage_allow_reschedule: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'bool', sort: 64,
    label: 'Client self-reschedule', desc: 'Clients may reschedule a scheduled appointment from their manage link. Cutoff and horizon still apply.' }),
  manage_allow_rebook: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'bool', sort: 66,
    label: 'Client rebook after cancel', desc: 'A canceled appointment\'s manage page offers "pick a new time". Keep it equal to self-reschedule: rebook on with reschedule off lets clients reschedule by canceling first.' }),
  shabbos_lead_min: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'number', sort: 70,
    label: 'Shabbos lead (min)', desc: 'Minutes before sunset that availability closes on Friday.' }),
  shabbos_end_min: F({ kind: 'firm', home: 'firm', section: 'booking', type: 'number', sort: 80,
    label: 'Shabbos end (min)', desc: 'Minutes after sunset that availability reopens on Saturday night.' }),

  // dropbox
  dropbox_case_folder_templates: F({ kind: 'firm', home: 'firm', section: 'dropbox', type: 'json', sort: 10, editor: 'dropboxTemplates',
    label: 'Folder templates', desc: 'Folder-name templates per case stage. Leading / trailing spaces inside values are load-bearing (manual sort order) and are preserved verbatim.' }),
  dropbox_unsorted_uploads_path: F({ kind: 'firm', home: 'firm', section: 'dropbox', type: 'string', sort: 20,
    label: 'Unsorted client uploads folder', desc: 'Where client uploads land when the case has no working folder and one cannot be created (a per-case subfolder). Leading spaces are load-bearing.' }),
  dropbox_unsorted_forms_path: F({ kind: 'firm', home: 'firm', section: 'dropbox', type: 'string', sort: 30,
    label: 'Unsorted form submissions folder', desc: 'Where form-submission PDFs go when there is no case folder to file into. Leading spaces are load-bearing.' }),
  dropbox_unsorted_generated_path: F({ kind: 'firm', home: 'firm', section: 'dropbox', type: 'string', sort: 40,
    label: 'Unsorted generated documents folder', desc: 'Where documents generated from a template go when there is no case folder to file into. Leading spaces are load-bearing.' }),
  dropbox_unsorted_esign_path: F({ kind: 'firm', home: 'firm', section: 'dropbox', type: 'string', sort: 50,
    label: 'Unsorted e-signed documents folder', desc: 'Where signed documents land when no case folder can be found or created. Leading spaces are load-bearing.' }),

  // esign
  esign_test_mode: F({ kind: 'firm', home: 'firm', section: 'esign', type: 'bool', sort: 10,
    label: 'E-sign test mode', desc: '1 = envelopes are sent in the provider\'s test mode (free, watermarked, capped). 0 = live: each envelope consumes credits.' }),
  esign_reminder_seq_id: F({ kind: 'firm', home: 'firm', section: 'esign', type: 'sequence', sort: 20,
    label: 'Default reminder sequence', desc: 'Sequence enrolled for every e-sign send unless the contract template overrides it. Blank = no automatic reminders by default.' }),
  esign_credit_balance: F({ kind: 'firm', home: 'firm', section: 'esign', type: 'number', sort: 30,
    label: 'Credit balance (estimate)', desc: 'Approximate credits remaining. There is no balance API: the app counts it down per live envelope, so re-enter it after buying credits. Blank disables credit tracking.' }),
  esign_credit_alert_threshold: F({ kind: 'firm', home: 'firm', section: 'esign', type: 'number', sort: 40,
    label: 'Low-credit alert threshold', desc: 'Raise a staff task when the estimated balance falls below this. Only meaningful with a balance entered.' }),

  // ═══ portal → Portal Manager ═══
  portal_live: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'bool', sort: 10,
    label: 'Portal live', desc: 'Client-portal kill switch: 1 = up, 0 = down (logins refused, sessions rejected on the next request). Absent behaves as 1.' }),
  portal_email_from: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'email', sort: 15, required: true,
    label: 'Portal email from', desc: 'Sender of client-portal login-code emails. Must exist as a sending address, or portal login emails fail. Cannot be blank: the default sender applies only when the setting is missing.' }),
  portal_sms_monthly_cap: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'number', sort: 20,
    label: 'Portal SMS monthly cap', desc: 'Maximum login-code texts per calendar month (UTC). At the cap no SMS is sent and one alert fires per month. Cost control, not a security control.' }),
  portal_callback_task_to: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'user', sort: 30, required: true,
    label: 'Callback task assignee', desc: 'Staff member assigned the task a client-portal callback request creates. Must be a valid user or callback requests fail.' }),
  portal_docs_notify_to: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'email', sort: 50,
    label: 'Upload notification to', desc: 'Recipient of the email sent when a client uploads documents. Blank = upload emails off (the case log entry still writes).' }),
  portal_logo_url: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'url', sort: 60,
    label: 'Portal logo URL', desc: 'Logo in the portal header on every page including login. Blank = the firm logo.' }),
  portal_favicon_url: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'url', sort: 70,
    label: 'Portal favicon URL', desc: 'Browser-tab icon for the portal. Blank = the effective portal logo.' }),
  portal_logo_href: F({ kind: 'firm', home: 'portal', section: 'portal', type: 'string', sort: 80,
    label: 'Portal logo link', desc: 'Where the portal header logo links: an http(s) URL or a single-/ site path. Blank = portal home on signed-in pages, not clickable on login.' }),

  // ═══ config → Config shell vocabulary ═══
  'fe-case_types': F({ kind: 'vocab', home: 'config', section: 'types', type: 'json', sort: 10, editor: 'caseTypes',
    label: 'Case types', desc: 'Case type → subtypes. Edited in Types & Subtypes, which checks usage and repoints pipeline templates.' }),
  'fe-lead_sources': F({ kind: 'vocab', home: 'config', section: 'lists', type: 'json_array', sort: 10, alsoWrite: 'firm.lists',
    label: 'Lead sources', desc: 'Marketing lead-source options offered on the case Overview tab. Suggestions only — the field accepts free text.' }),
  'fe-event_types': F({ kind: 'vocab', home: 'config', section: 'lists', type: 'json_array', sort: 20, editor: 'eventTypes',
    label: 'Event types (legacy list)', desc: 'The new-event dialog and the Events tab filter read this list; the event form falls back to it when the calendar-type registry is unreachable. Renaming or removing a type does not change existing events.' }),

  // ═══ cta → CTA Links ═══
  cta_default_timeout_once: F({ kind: 'firm', home: 'cta', section: 'cta', type: 'duration', sort: 10,
    label: 'Default expiry (single-use)', desc: 'Expiry for a single-use CTA link minted without one. Duration like 30m, 12h, 3d, 2w. Max 365d.' }),
  cta_default_timeout_repeatable: F({ kind: 'firm', home: 'cta', section: 'cta', type: 'duration', sort: 20,
    label: 'Default expiry (repeatable)', desc: 'Expiry for a repeatable CTA link minted without one. Duration like 12h, 30d, 26w. Max 365d.' }),

  // ═══ system → System tab ═══
  // platform
  app_url: F({ kind: 'system', home: 'system', section: 'platform', type: 'url', sort: 10, edit: 'console', env: 'APP_URL',
    label: 'App URL', desc: 'Base URL of this app. A wrong value breaks OAuth callbacks and every generated link.' }),
  gcs_bucket: F({ kind: 'system', home: 'system', section: 'platform', type: 'string', sort: 20, edit: 'console', env: 'GCS_BUCKET',
    label: 'Uploads bucket', desc: 'Cloud Storage bucket for file uploads (world-readable objects).' }),
  comms_archive_bucket: F({ kind: 'system', home: 'system', section: 'platform', type: 'string', sort: 25, edit: 'console', env: 'COMMS_ARCHIVE_BUCKET',
    label: 'Comms archive bucket', desc: 'PRIVATE bucket for call recordings, MMS and mail bytes — never the uploads bucket. Unset → the archive sweep stops.' }),
  min_client_build: F({ kind: 'system', home: 'system', section: 'platform', type: 'date', sort: 30,
    label: 'Force reload before', desc: 'Blank = off. Date / datetime / epoch ms: open tabs on builds older than this are force-reloaded. Self-expiring.' }),
  cloud_tasks_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 40, env: 'CLOUD_TASKS_ENABLED',
    label: 'Cloud Tasks accelerator', desc: '1 = due jobs also get a Cloud Tasks push so they fire within seconds. 0 = off; jobs ride the 60s cron (nothing is lost). Kill switch: set 0, NOT blank — blank falls through to the env var. Instances converge within 60s.' }),
  hook_async_ack: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 44, env: 'HOOK_ASYNC_ACK',
    label: 'Webhooks: acknowledge first, process after', desc: '1 = POST /hooks/:slug writes the event and answers the sender at once; filter, transform and targets run a moment later from a Cloud Tasks doorbell (or the 60 s cron). 0 = the previous receiver: filter, transform and the workflow start run BEFORE the answer, each code body waiting at most 1 s for a sandbox (rollback only — a slow code body then makes RingCentral late, and ~10 min of that blacklists the subscription). Unset, blank or any other value = 1. Instances converge within 60 s.' }),
  custom_code_child_process: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 45, env: 'CUSTOM_CODE_CHILD_PROCESS',
    label: 'Run code steps in a child process', desc: '1 = a workflow custom_code step runs in a forked, scrubbed child (no environment, no reachable host object, sockets refused) instead of in this process, where a vm escape reached the DB credentials. 0 = the legacy in-process path (rollback only: it is the path with the escape). Unset, blank or any other value = the child — only an explicit 0 selects the legacy path. Rollback is this flag, not a deploy.' }),
  casey_hook_authoring_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 48, env: 'CASEY_HOOK_AUTHORING_ENABLED',
    label: 'Casey may propose hooks', desc: '0 = the Ask Casey hook.create family is dark. Unset or 1 = a reviewed card may create an INACTIVE inbound hook with one internal target (an existing workflow or sequence template); nothing fires through it until a human activates it in the Hooks editor, and the card never composes or shows a slug, key, or URL. The route itself stays behind automations.manage, so only admin/IT/SU can apply the card. The per-family off switch ruling 4 requires.' }),
  casey_workflow_authoring_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 47, env: 'CASEY_WORKFLOW_AUTHORING_ENABLED',
    label: 'Casey may draft workflows', desc: '0 = the Ask Casey workflow.draft family is dark: the normalizer refuses the kind and no card is produced. Unset or 1 = staff may apply a reviewed card that creates a complete NEVER-PUBLISHED workflow (born version 0, which no dispatch site will start) with steps from the authoring allowlist (lib/caseyAutomationAllowlist.js) plus safe-mode code. Publishing stays a separate human act in the editor. The per-family off switch ruling 4 of the automation-authoring plan requires.' }),
  casey_sequence_authoring_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 49, env: 'CASEY_SEQUENCE_AUTHORING_ENABLED',
    label: 'Casey may draft sequence steps', desc: '0 = the Ask Casey sequence.step_insert family is dark: the normalizer refuses the kind and no card is produced. Unset or 1 = staff may apply a reviewed card that inserts ONE sms, email or task step into a sequence template\'s DRAFT (function pinned per type, timing from the engine\'s own vocabulary). Nothing runs until a human publishes the template, and an SMS/email step messages clients from the first NEW enrollment after that publish. The per-family off switch ruling 4 of the automation-authoring plan requires.' }),
  casey_send_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 51, env: 'CASEY_SEND_ENABLED',
    label: 'Casey may propose direct sends', desc: '0 = the Ask Casey sms.send / email.send family is dark: the normalizer refuses both kinds and no card is produced. Unset or 1 = a reviewed card may send ONE text or ONE email NOW to one active, not-opted-out phone/email row of a contact in the evidence, from a line/mailbox the user can send from, with every placeholder resolved on the card before the user confirms (ruling 15, 2026-10-27). The send runs through the comms hub routes under the user\'s own grants, step-up and rate limit; it cannot be recalled. The per-family off switch ruling 4 requires.' }),
  casey_answer_streaming_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 54, env: 'CASEY_ANSWER_STREAMING_ENABLED',
    label: 'Casey streams its answers', desc: '0 = Ask Casey answers arrive whole, exactly as before streaming: the pane is never offered a stream and an execute that asks for one is answered unstreamed. Unset or 1 = the answer\'s words appear as the model writes them (same model, prompts and final content; the finished answer replaces the streamed text). A broken stream is retried ONCE unstreamed from the sealed evidence, without re-reading anything. Instances converge within 60 s.' }),
  casey_report_authoring_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 52, env: 'CASEY_REPORT_AUTHORING_ENABLED',
    label: 'Casey may draft reports', desc: '0 = the Ask Casey report.draft family is dark: the normalizer refuses the kind and no card is produced. Unset or 1 = a reviewed card may SAVE one new report definition (Casey-written SQL, validated by the Reports validator and previewed on the least-privilege report pool, ruling 16) through POST /api/reports; it opens in Reports, where Run and CSV export live. A saved report reads only what any staff member\'s report can read. The per-family off switch ruling 4 requires.' }),
  casey_ingest_authoring_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 53, env: 'CASEY_INGEST_AUTHORING_ENABLED',
    label: 'Casey may author ingest rules', desc: '0 = the Ask Casey ingest_rule family (email and phone ingest rules) is dark: the normalizer refuses all six kinds and no card is produced. Unset or 1 = a reviewed card may create a rule born INACTIVE, edit a rule\'s name / description / position / match / transform, add, edit or remove one action, or activate / deactivate a rule (A20.2 / A20.3). Every edit carries the rule\'s definition_updated_at as read, so the route refuses it if the rule changed; an ACTIVE rule\'s card says the change applies to the next matching message, and every change lands in the rule\'s change log. Code-mode bodies still need automations.manage at the route. The per-family off switch ruling 4 requires.' }),
  casey_code_actions_enabled: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 46, env: 'CASEY_CODE_ACTIONS_ENABLED',
    label: 'Casey may propose safe code jobs', desc: '0 = the Ask Casey job.code_safe family is dark: the normalizer refuses the kind, so no card is ever produced. Unset or 1 = any staff member may apply a reviewed safe-mode code job card (2026-10-22 ruling). The per-family off switch ruling 4 of the automation-authoring plan requires; the code itself always runs in the QuickJS guest engine regardless of this flag.' }),
  mail_send_daily_budget: F({ kind: 'system', home: 'system', section: 'platform', type: 'json', sort: 50,
    label: 'Mail send daily budget', desc: '{"gmail": n, "smtp": n}: hub sends per sending account per day, counted from the email log. Unset = the code defaults (1500 Gmail / 300 SMTP).' }),
  landing_hosts: F({ kind: 'system', home: 'system', section: 'platform', type: 'csv', sort: 90, edit: 'console', env: 'LANDING_HOSTS',
    label: 'Landing hosts', desc: 'Hostnames served as the public landing origin (pages, /f, /r, /api/ext only). First entry = canonical redirect target. Empty = off. A security boundary: SU console only.' }),
  landing_redirect: F({ kind: 'system', home: 'system', section: 'platform', type: 'bool', sort: 91, edit: 'console', env: 'LANDING_REDIRECT',
    label: 'Landing redirects', desc: '1 = non-landing hosts redirect GET /p/*, /f/* and ext-mode render to the canonical landing host. 0 = instant revert. SU console only.' }),

  // switches
  documents_sync_enabled: F({ kind: 'system', home: 'system', section: 'switches', type: 'bool', sort: 10,
    label: 'Documents sync engine', desc: '1 = the Dropbox → documents sync runs. Anything else = off. Read uncached; turning it off mid-backfill is safe (the cursor waits).' }),
  court_ingest_live: F({ kind: 'system', home: 'system', section: 'switches', type: 'bool', sort: 20,
    label: 'Court ingest live', desc: '1 = the court-email pipeline executes its actions. 0 = review-only.' }),
  trustee_validation_live: F({ kind: 'system', home: 'system', section: 'switches', type: 'bool', sort: 30,
    label: 'Trustee validation live', desc: '1 = validate_case_trustee writes the case and alerts staff. Anything else = dry run (no case writes; alerts IT).' }),

  // alerts
  alert_email_min_severity: F({ kind: 'system', home: 'system', section: 'alerts', type: 'enum', options: ['error', 'warn', 'info'], sort: 10,
    label: 'Min severity for email', desc: 'Alerts below this severity record to System Alerts but send no email.' }),
  alert_cooldown_hours: F({ kind: 'system', home: 'system', section: 'alerts', type: 'number', sort: 20,
    label: 'Alert cooldown (hours)', desc: 'A repeat of the same alert inside this window does not email again.' }),

  // integrations
  dropbox_credential_id: F({ kind: 'system', home: 'system', section: 'integrations', type: 'credential', sort: 10,
    label: 'Dropbox credential', desc: 'Connections credential the Dropbox integration authenticates with.' }),
  esign_credential_id: F({ kind: 'system', home: 'system', section: 'integrations', type: 'credential', sort: 20,
    label: 'E-sign credential', desc: 'Connections credential for the e-sign provider (OAuth2). Blank disables all sending.' }),
  gcal_credential_id: F({ kind: 'system', home: 'system', section: 'integrations', type: 'credential', sort: 30,
    label: 'Google Calendar credential', desc: 'Connections credential for calendar sync and free/busy. Unset = the code\'s built-in default credential.' }),
  gcal_calendar_id: F({ kind: 'system', home: 'system', section: 'integrations', type: 'string', sort: 40,
    label: 'Google Calendar id', desc: 'The firm calendar appointments sync to.' }),
  assistant_ai_monthly_cap_cents: F({ kind: 'firm', home: 'system', section: 'integrations', type: 'number', sort: 25, edit: 'console',
    label: 'Ask Casey AI monthly cap (cents)', desc: 'Month-to-date (UTC) Ask Casey model spend at which new questions are refused until next month or a raise. Missing / blank = the code default (20000 = $200). Present but not a whole number = 0 = every question refused.' }),
  gcontacts_credential_id: F({ kind: 'system', home: 'system', section: 'integrations', type: 'credential', sort: 50, edit: 'console',
    label: 'Google Contacts credential', desc: 'Connections credential for the Google Contacts sync.' }),
  gcontacts_exclude_email_domains: F({ kind: 'system', home: 'system', section: 'integrations', type: 'csv', sort: 60,
    label: 'Google Contacts excluded domains', desc: 'Comma-separated email domains never synced to Google Contacts. Unset = the code default (the firm\'s own domain).' }),

  // ═══ comms → shown in the System tab until the comms arc rehomes it ═══
  comms_archive_enabled: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'bool', sort: 40,
    label: 'Comms archive sweep', desc: '1 = the archive sweep copies call recordings into the private archive. Anything else = off. Turning it off is always safe; the cliff-guard alarm keeps running.' }),
  comms_archive_admins: F({ kind: 'access', home: 'console', section: 'console', type: 'user_csv', sort: 41,
    label: 'Comms archive admins', desc: 'Interim access list (who may restrict / purge archived comms besides SU); replaced by the archives.purge capability (access-control A6). SU console only.' }),
  comms_eval_reviewers: F({ kind: 'access', home: 'console', section: 'console', type: 'user_csv', sort: 42,
    label: 'Comms evaluation reviewers', desc: 'Interim access list for the comms evaluation sample. SU console only.' }),
  comms_transcribe_mode: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'enum', options: ['off', 'sample', 'on'], sort: 50,
    label: 'Transcription', desc: 'off: no new submissions (jobs already sent finish). sample: only the evaluation items. on: every archived recording and voicemail. Restricted calls are never sent. Anything else = off.' }),
  comms_stt_credential_id: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'credential', sort: 51, edit: 'console',
    label: 'STT credential', desc: 'Credential the transcription sweep calls through. Missing → transcription stops (alerted).' }),
  comms_min_transcribe_s: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 52, edit: 'console',
    label: 'Transcribe minimum (s)', desc: 'Audio shorter than this is skipped as short. Not applied to voicemails or in sample mode.' }),
  comms_stt_max_min_per_call: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 53, edit: 'console',
    label: 'STT per-call cap (min)', desc: 'Longer audio is skipped as over cap; an SU releases one from the db console.' }),
  comms_ai_monthly_cap_cents: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 54, edit: 'console',
    label: 'AI monthly cap (cents)', desc: 'Month-to-date transcription + summary spend that stops new submissions; archiving never stops. Missing / not a number = 0 = nothing submitted.' }),
  comms_stt_quo_stereo: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'enum', options: ['diarize', 'multichannel'], sort: 55, edit: 'console',
    label: 'STT stereo mode', desc: 'How a 2-channel recording is transcribed: diarize (one mixed channel + speaker labels) or multichannel (one transcript per channel, billed per channel). Anything else = diarize.' }),
  comms_stt_keyterms: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'json_array', sort: 56, edit: 'console',
    label: 'STT keyterms', desc: 'Words / phrases (≤ 6 words each) the transcriber is primed with. Empty = off; non-empty costs extra per audio hour.' }),
  comms_stt_language_detection: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'bool', sort: 57, edit: 'console',
    label: 'STT language detection', desc: '1 = the vendor detects the language. Anything else = English.' }),
  comms_summarize_mode: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'enum', options: ['off', 'sample', 'on'], sort: 58,
    label: 'Summaries', desc: 'off: no summaries. sample: only the evaluation items. on: every transcribed call and voicemail. Restricted calls are never sent. Anything else = off.' }),
  comms_summary_model: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'string', sort: 59, edit: 'console',
    label: 'Summary model', desc: 'Model id the summaries use; an id the sweep does not accept stops the summaries (alerted).' }),
  comms_summary_effort: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'enum', options: ['low', 'medium', 'high'], sort: 60, edit: 'console',
    label: 'Summary effort', desc: 'The model\'s thinking effort (billed as output). Anything else = the summaries stop (alerted).' }),
  comms_min_summary_s: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 61, edit: 'console',
    label: 'Summary minimum (s)', desc: 'A call with less audio than this is not summarised. Not applied to voicemails or in sample mode.' }),
  comms_stt_max_speakers: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 62, edit: 'console',
    label: 'STT max speakers', desc: '0–10: a hard cap on speaker labels for diarized transcripts. 0 = no cap. Anything else = transcription stops (alerted).' }),
  comms_summary_firm_context: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'string', sort: 63,
    label: 'Summary firm context', desc: 'Facts about how the firm\'s phones sound, for the AI call summaries (the AI receptionist, recorded greetings, call screening, names the transcriber mishears). Staff names come from the users table. At most 2,000 characters — longer stops the summaries (alerted).' }),
  phone_delivery_sync_enabled: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'bool', sort: 70,
    label: 'Phone outbound delivery sync', desc: '1 = the outbound-SMS sync recovers texts the webhooks dropped and stamps delivery status on the phone log (ref/PHONE_DELIVERY_DESIGN.md). Anything else = off. Turning it off is always safe — sends, webhooks and logging all keep running; only recovery and status stamping stop.' }),
  phone_delivery_failed_workflow_id: F({ kind: 'firm', home: 'comms', section: 'comms', type: 'number', sort: 71,
    label: 'Failed-text workflow', desc: 'Workflow started each time an outbound text\'s delivery verdict TRANSITIONS to failed (init data: to/from/body/ts/reason/code; kind=sms_delivery_failed). The workflow decides the action — task, email, nothing. Blank = off. Live sync runs only, never the backfill. Chronically unreachable numbers re-fail on every new send, so expect weekly repeats for the same client (ref/PHONE_DELIVERY_DESIGN.md §5 S3c).' }),

  // ═══ state → read-only in the System tab ═══
  alert_last_sweep_at:            F({ kind: 'state', home: 'system', section: 'state', type: 'date', sort: 10, edit: 'console', label: 'Alert sweep last ran', desc: 'Written by the alert sweep.' }),
  error_sweep_state:              F({ kind: 'state', home: 'system', section: 'state', type: 'json', sort: 20, edit: 'console', label: 'Error sweep watermarks', desc: 'Per-source high-water marks of the error sweep.' }),
  alert_sms_fallback_last_at:     F({ kind: 'state', home: 'system', section: 'state', type: 'date', sort: 25, edit: 'console', label: 'Alert SMS fallback last sent', desc: 'Written when the sweep texts that the alert email failed; one text per hour.' }),
  process_jobs_last_heartbeat_at: F({ kind: 'state', home: 'system', section: 'state', type: 'date', sort: 30, edit: 'console', label: 'Job runner heartbeat', desc: 'Written on every /process-jobs tick.' }),
  documents_sweep_watermark:      F({ kind: 'state', home: 'system', section: 'state', type: 'number', sort: 40, edit: 'console', label: 'Documents sweep watermark', desc: 'Written by the documents sync.' }),
  esign_webhook_last_seen_at:     F({ kind: 'state', home: 'system', section: 'state', type: 'date', sort: 50, edit: 'console', label: 'E-sign webhook last seen', desc: 'Written on every e-sign webhook delivery.' }),
  esign_credit_alert_sent:        F({ kind: 'state', home: 'system', section: 'state', type: 'bool', sort: 60, edit: 'console', label: 'E-sign low-credit latch', desc: '1 = the low-credit task is already raised for this dip; cleared when a send leaves the balance at or above the threshold.' }),
  portal_sms_counter:             F({ kind: 'state', home: 'system', section: 'state', type: 'json', sort: 70, edit: 'console', label: 'Portal SMS counter', desc: 'Month counter of portal login-code texts (ym, count, alerted_ym).' }),
  gcontacts_group:                F({ kind: 'state', home: 'system', section: 'state', type: 'string', sort: 80, edit: 'console', label: 'Google Contacts group', desc: 'Contact group the sync creates on first use.' }),
  // The one key automation writes (phone-ingest rule 4 stores the Clio 2FA
  // code; GET /clio-code reads it). Verified the sole automation writer of
  // app_settings across every live definition, 2026-10-17.
  clio_login_code: F({ kind: 'state', home: 'system', section: 'state', type: 'string', sort: 90, edit: 'console', automation: true,
    label: 'Clio login code', desc: 'The latest Clio 2FA code, captured from an inbound text by a phone-ingest rule.' }),

  // ═══ secret → never served ═══
  internal_api_key:             F({ kind: 'secret', home: 'console', section: 'console', type: 'string', env: 'INTERNAL_API_KEY', label: 'Internal API key', desc: 'App-to-self credential. Managed by the API Keys admin page.' }),
  internal_api_key_prev:        F({ kind: 'secret', home: 'console', section: 'console', type: 'string', label: 'Internal API key (previous)', desc: 'Accepted alongside the current key so rotation never races the config cache.' }),
  quo_api_key:                  F({ kind: 'secret', home: 'console', section: 'console', type: 'string', label: 'Quo API key', desc: 'Former phone provider API key. No code reads it (the phone driver authenticates through its Connections credential) and its row was deleted 2026-10-28; kept registered so the name is never reused.' }),
  calendly_webhook_signing_key: F({ kind: 'secret', home: 'console', section: 'console', type: 'string', label: 'Calendly webhook signing key', desc: 'Former record copy of the Calendly webhook signing secret. No code reads it (each Calendly hook verifies with its own encrypted secret in hooks.auth_config) and its row was deleted 2026-10-28; kept registered so the name is never reused.' }),
  esign_webhook_secret:         F({ kind: 'secret', home: 'console', section: 'console', type: 'string', label: 'E-sign webhook HMAC secret', desc: 'Webhook signature secret from the provider\'s console. Empty disables signature verification.' }),
  esign_webhook_token:          F({ kind: 'secret', home: 'console', section: 'console', type: 'string', label: 'E-sign webhook token', desc: 'Shared secret in the e-sign webhook URL.' }),
  pabbly_internal_url:          F({ kind: 'secret', home: 'console', section: 'console', type: 'url', label: 'Pabbly internal URL', desc: 'Webhook URL with a secret in its query string.' }),
  rc_token:                     F({ kind: 'secret', home: 'console', section: 'console', type: 'json', label: 'RingCentral token (legacy)', desc: 'Legacy RingCentral OAuth token; goes with the RingCentral retirement.' }),
  rc_subscriptions:             F({ kind: 'secret', home: 'console', section: 'console', type: 'json', label: 'RingCentral subscriptions (legacy)', desc: 'Legacy webhook subscriptions, including their verification tokens; goes with the RingCentral retirement.' }),

  // ═══ retired → never reused ═══
  'fe-trustees': F({ kind: 'retired', home: 'console', section: 'console', type: 'json', label: 'Trustee roster (retired)', desc: 'Replaced by contact roles (lib/trusteeRoster).' }),
  // Rollout flags retired at their final value (settings arc, Fred 2026-10-17):
  // the code now always behaves as the flag's last value did. Their rows are
  // deleted AFTER the deploy (scripts/settingsArcMigrate.js stage 2) — deleting
  // first would read as "off" to the old build.
  unified_singleton_enabled: F({ kind: 'retired', home: 'console', section: 'console', type: 'bool', label: 'Calendar singleton supersession (retired)', desc: 'Always on since the settings arc: a new live event of a one-live-per-case calendar type supersedes the prior one.' }),
  esign_webhook_hmac_mode:   F({ kind: 'retired', home: 'console', section: 'console', type: 'string', label: 'E-sign webhook HMAC mode (retired)', desc: 'Always enforce since the settings arc: with a webhook secret set, a delivery whose signature is missing or wrong is rejected.' }),
});

// ── alsoWrite: checked when this module loads ──────────────────────────────
// A per-key write grant may only widen a key whose wrong value is
// recoverable and stays in its home's editor. Anything else throws at load —
// the app does not boot with an illegal grant.
const ALSO_WRITE_RULES = Object.freeze({
  kinds: Object.freeze(['firm', 'vocab']),
  homes: Object.freeze(['firm', 'portal', 'config']),
});
/** Throws on the first illegal alsoWrite in `settings` (run below on
 *  SETTINGS; exported so the rules are tested on crafted entries).
 *  firmConfig's REGISTRY is a plain object literal — no db at load. */
function assertAlsoWrite(settings, firmConfigRegistry = require('./firmConfig').REGISTRY) {
  const FIRM_CONFIG = firmConfigRegistry;
  for (const [key, e] of Object.entries(settings)) {
    if (e.alsoWrite === undefined) continue;
    const bad = (why) => { throw new Error(`settingsRegistry: ${key}.alsoWrite ${why}`); };
    // own property only: 'constructor' / 'toString' must not pass for a capability
    if (typeof e.alsoWrite !== 'string' || !Object.prototype.hasOwnProperty.call(CAPABILITIES, e.alsoWrite)) {
      bad('names no capability');
    }
    const cap = CAPABILITIES[e.alsoWrite];
    if (cap.root) bad('names a root capability');
    if (!ALSO_WRITE_RULES.kinds.includes(e.kind)) bad(`is not allowed on kind ${e.kind}`);
    if (!ALSO_WRITE_RULES.homes.includes(e.home)) bad(`is not allowed in home ${e.home}`);
    if ((e.edit || 'ui') !== 'ui') bad('is not allowed on a console-posture key');
    if (e.automation === true) bad('is not allowed on an automation-writable key');
    if (Object.prototype.hasOwnProperty.call(FIRM_CONFIG, key)) bad('is not allowed on a firmConfig key');
  }
}
assertAlsoWrite(SETTINGS);

// ── Lookups ────────────────────────────────────────────────────────────────
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The entry for a key, or null when the key is not registered. */
function get(key) {
  return typeof key === 'string' && has(SETTINGS, key) ? SETTINGS[key] : null;
}

function isRegistered(key) { return get(key) !== null; }

/**
 * The registered key that `key` names under app_settings.key's collation, or
 * null. The column is utf8mb4_general_ci PAD SPACE — case and trailing spaces
 * are ignored, so `WHERE key = 'Firm_Name '` reads the firm_name row — while
 * get() is exact. For refusing to CREATE a key that MySQL would treat as a
 * registered one (POST). A path that READS a row compares the row's own key
 * with the asked key byte for byte instead (api.appSettings writeValue,
 * set_setting).
 */
const FOLDED = new Map(Object.keys(SETTINGS).map((k) => [k.toLowerCase(), k]));
function registeredSpelling(key) {
  return typeof key === 'string' ? FOLDED.get(key.toLowerCase().replace(/ +$/, '')) || null : null;
}

/** 'ui' | 'console' — absent edit means 'ui'. */
function editOf(entry) { return entry.edit || 'ui'; }

/** { read, write } capability names for an entry (derived from its home). */
function capsOf(entry) {
  if (NEVER_SERVED.includes(entry.kind)) return HOME_CAPS.console;
  return HOME_CAPS[entry.home];
}

/** Every capability that may write the entry: its home's, plus alsoWrite
 *  (staff JWTs). [] when nothing may (console home, never-served kinds). */
function writeCapsOf(entry) {
  const home = capsOf(entry).write;
  if (!home) return [];
  return entry.alsoWrite ? [home, entry.alsoWrite] : [home];
}

/**
 * Secret if EITHER source says so: the registry (kind secret) or the row's
 * is_secret flag. A fat-fingered flag can never expose a registered secret,
 * and an unregistered row keeps its own flag.
 */
function isSecret(key, dbIsSecret) {
  const e = get(key);
  if (e && e.kind === 'secret') return true;
  return Number(dbIsSecret) === 1;
}

/**
 * May automation (set_setting, update_db) WRITE this key?
 *   secret (either source)          → no
 *   registered                      → only with automation: true
 *   unregistered                    → yes (an automation variable a person
 *                                     created; nothing in the code reads it —
 *                                     the inventory test guarantees that)
 * @returns {{ ok: boolean, reason?: string }}
 */
function automationMayWrite(key, dbIsSecret) {
  if (isSecret(key, dbIsSecret)) return { ok: false, reason: 'is a secret' };
  const e = get(key);
  if (!e) return { ok: true };
  if (e.automation === true) return { ok: true };
  return { ok: false, reason: 'is a registered setting automation may not write (lib/settingsRegistry.js)' };
}

/** Validate a value against a REGISTERED key's type (and `required`). */
function validate(key, value) {
  const e = get(key);
  if (!e) throw new Error(`settingsRegistry.validate: unregistered key ${JSON.stringify(key)}`);
  if (e.required === true && typeof value === 'string' && value.trim() === '') return 'cannot be blank';
  return validateByType(e.type, value, e.options);
}

module.exports = {
  SETTINGS, SECTIONS, HOME_CAPS, KINDS, TYPES, NEVER_SERVED, TYPE_VALIDATORS, ALSO_WRITE_RULES, assertAlsoWrite,
  get, isRegistered, registeredSpelling, editOf, capsOf, writeCapsOf, isSecret, automationMayWrite, validate, validateByType,
};
