// tests/settingsRegistry.test.js
//
/**
 * Settings registry — lib/settingsRegistry.js (settings-config-split arc).
 *
 * WHAT IS LOCKED
 *   - The CLASSIFICATION: every registered key's kind / home / section / edit
 *     posture / type (+ "auto" when automation may write it), as one exact
 *     snapshot. Each line is a reviewed decision (S0, Fred's rulings
 *     2026-10-17): which editor owns the key, who may change it, whether it is
 *     a secret, state or an interim access list. Any change fails here until
 *     the snapshot is deliberately updated — the CTA eligible-set pattern.
 *   - Shape invariants: every entry names a known kind, home, section of its
 *     home, type (enum carries options); never-served kinds live at home
 *     'console'; state is never 'ui'-editable; descriptions name no person.
 *   - HOME_CAPS: which capability reads / writes each home.
 *   - automationMayWrite: secrets (either source) never; registered keys only
 *     with automation:true (exactly one today: clio_login_code); unregistered
 *     non-secret rows yes.
 *   - isSecret: the registry OR the row flag.
 *   - Validators: blank always passes; the picker types check shape only;
 *     enum checks options; string/template are verbatim.
 *
 * Run: npx jest tests/settingsRegistry.test.js
 */
'use strict';

const reg = require('../lib/settingsRegistry');
const { CAPABILITIES } = require('../lib/capabilities');

const line = (e) => [e.kind, e.home, e.section, reg.editOf(e), e.type].join(' ')
  + (e.automation ? ' auto' : '') + (e.required ? ' required' : '');

describe('classification snapshot', () => {
  const SNAPSHOT = {
    "alert_cooldown_hours": "system system alerts ui number",
    "alert_critical_sms_to": "firm firm routing ui phone",
    "alert_email_min_severity": "system system alerts ui enum",
    "alert_from_email": "firm firm routing ui email",
    "alert_last_sweep_at": "state system state console date",
    "alert_recipients": "firm firm routing ui csv",
    "app_url": "system system platform console url",
    "assistant_ai_monthly_cap_cents": "firm system integrations console number",
    "billing_tasks_to": "firm firm routing ui user",
    "calendly_webhook_signing_key": "secret console console ui string",
    "casey_code_actions_enabled": "system system platform ui bool",
    "casey_hook_authoring_enabled": "system system platform ui bool",
    "casey_workflow_authoring_enabled": "system system platform ui bool",
    "clio_login_code": "state system state console string auto",
    "cloud_tasks_enabled": "system system platform ui bool",
    "custom_code_child_process": "system system platform ui bool",
    "comms_ai_monthly_cap_cents": "firm comms comms console number",
    "comms_archive_admins": "access console console ui user_csv",
    "comms_archive_bucket": "system system platform console string",
    "comms_archive_enabled": "firm comms comms ui bool",
    "comms_eval_reviewers": "access console console ui user_csv",
    "comms_min_summary_s": "firm comms comms console number",
    "comms_min_transcribe_s": "firm comms comms console number",
    "comms_stt_credential_id": "firm comms comms console credential",
    "comms_stt_keyterms": "firm comms comms console json_array",
    "comms_stt_language_detection": "firm comms comms console bool",
    "comms_stt_max_min_per_call": "firm comms comms console number",
    "comms_stt_max_speakers": "firm comms comms console number",
    "comms_stt_quo_stereo": "firm comms comms console enum",
    "comms_summarize_mode": "firm comms comms ui enum",
    "comms_summary_effort": "firm comms comms console enum",
    "comms_summary_firm_context": "firm comms comms ui string",
    "comms_summary_model": "firm comms comms console string",
    "comms_transcribe_mode": "firm comms comms ui enum",
    "court_ingest_live": "system system switches ui bool",
    "cta_default_timeout_once": "firm cta cta ui duration",
    "cta_default_timeout_repeatable": "firm cta cta ui duration",
    "default_task_assignee": "firm firm routing ui user",
    "documents_sweep_watermark": "state system state console number",
    "documents_sync_enabled": "system system switches ui bool",
    "dropbox_case_folder_templates": "firm firm dropbox ui json",
    "dropbox_credential_id": "system system integrations ui credential",
    "dropbox_unsorted_esign_path": "firm firm dropbox ui string",
    "dropbox_unsorted_forms_path": "firm firm dropbox ui string",
    "dropbox_unsorted_generated_path": "firm firm dropbox ui string",
    "dropbox_unsorted_uploads_path": "firm firm dropbox ui string",
    "email_automations": "firm firm senders ui email",
    "email_default_from": "firm firm senders ui email",
    "email_default_to": "firm firm routing ui email",
    "email_domains": "firm firm senders ui csv",
    "email_it": "firm firm routing ui email",
    "error_sweep_state": "state system state console json",
    "esign_credential_id": "system system integrations ui credential",
    "esign_credit_alert_sent": "state system state console bool",
    "esign_credit_alert_threshold": "firm firm esign ui number",
    "esign_credit_balance": "firm firm esign ui number",
    "esign_reminder_seq_id": "firm firm esign ui sequence",
    "esign_test_mode": "firm firm esign ui bool",
    "esign_webhook_hmac_mode": "retired console console ui string",
    "esign_webhook_last_seen_at": "state system state console date",
    "esign_webhook_secret": "secret console console ui string",
    "esign_webhook_token": "secret console console ui string",
    "event_digest_recipients": "firm firm routing ui user_csv",
    "fe-case_types": "vocab config types ui json",
    "fe-event_types": "vocab config lists ui json_array",
    "fe-firm_logo_url": "firm firm identity ui url",
    "fe-firm_phone": "firm firm identity ui phone",
    "fe-firm_site_url": "firm firm identity ui url",
    "fe-lead_sources": "vocab config lists ui json_array",
    "fe-trustees": "retired console console ui json",
    "firm_address": "firm firm identity ui json_array",
    "firm_attorney_name": "firm firm identity ui string",
    "firm_email": "firm firm identity ui email",
    "firm_name": "firm firm identity ui string",
    "gcal_calendar_id": "system system integrations ui string",
    "gcal_credential_id": "system system integrations ui credential",
    "gcontacts_credential_id": "system system integrations console credential",
    "gcontacts_exclude_email_domains": "system system integrations ui csv",
    "gcontacts_group": "state system state console string",
    "gcs_bucket": "system system platform console string",
    "internal_api_key": "secret console console ui string",
    "internal_api_key_prev": "secret console console ui string",
    "landing_hosts": "system system platform console csv",
    "landing_redirect": "system system platform console bool",
    "mail_send_daily_budget": "system system platform ui json",
    "manage_allow_cancel": "firm firm booking ui bool",
    "manage_allow_rebook": "firm firm booking ui bool",
    "manage_allow_reschedule": "firm firm booking ui bool",
    "manage_cancel_template": "firm firm booking ui template",
    "manage_cutoff_min": "firm firm booking ui number",
    "manage_fallback_url": "firm firm booking ui json",
    "manage_horizon_days": "firm firm booking ui number",
    "manage_reschedule_template": "firm firm booking ui template",
    "min_client_build": "system system platform ui date",
    "office_alerts_to": "firm firm routing ui user_csv",
    "pabbly_internal_url": "secret console console ui url",
    "phone_delivery_failed_workflow_id": "firm comms comms ui number",
    "phone_delivery_sync_enabled": "firm comms comms ui bool",
    "portal_callback_task_to": "firm portal portal ui user required",
    "portal_docs_notify_to": "firm portal portal ui email",
    "portal_email_from": "firm portal portal ui email required",
    "portal_favicon_url": "firm portal portal ui url",
    "portal_live": "firm portal portal ui bool",
    "portal_logo_href": "firm portal portal ui string",
    "portal_logo_url": "firm portal portal ui url",
    "portal_sms_counter": "state system state console json",
    "portal_sms_monthly_cap": "firm portal portal ui number",
    "process_jobs_last_heartbeat_at": "state system state console date",
    "quo_api_key": "secret console console ui string",
    "rc_subscriptions": "secret console console ui json",
    "rc_token": "secret console console ui json",
    "shabbos_end_min": "firm firm booking ui number",
    "shabbos_lead_min": "firm firm booking ui number",
    "sms_default_from": "firm firm senders ui phone",
    "sms_staff_from": "firm firm senders ui phone",
    "trustee_validation_live": "system system switches ui bool",
    "unified_singleton_enabled": "retired console console ui bool",
  };

  test('every registered key, exactly as reviewed', () => {
    const got = {};
    for (const [k, e] of Object.entries(reg.SETTINGS)) got[k] = line(e);
    expect(got).toEqual(SNAPSHOT);
  });

  test('exactly one key is automation-writable', () => {
    const auto = Object.keys(reg.SETTINGS).filter((k) => reg.SETTINGS[k].automation === true);
    expect(auto).toEqual(['clio_login_code']);
  });
});

describe('shape invariants', () => {
  const entries = Object.entries(reg.SETTINGS);

  test.each(entries)('%s is well formed', (key, e) => {
    expect(Object.isFrozen(e)).toBe(true);
    expect(reg.KINDS).toContain(e.kind);
    expect(Object.keys(reg.HOME_CAPS)).toContain(e.home);
    expect(reg.SECTIONS[e.home].map((s) => s.id)).toContain(e.section);
    expect(reg.TYPES).toContain(e.type);
    if (e.type === 'enum') {
      expect(Array.isArray(e.options) && e.options.length > 0).toBe(true);
    } else {
      expect(e.options).toBeUndefined();
    }
    expect(['ui', 'console']).toContain(reg.editOf(e));
    expect(typeof e.label).toBe('string');
    expect(e.label.length).toBeGreaterThan(0);
    expect(typeof e.desc).toBe('string');
    expect(e.desc.length).toBeGreaterThan(0);
    if (reg.NEVER_SERVED.includes(e.kind)) expect(e.home).toBe('console');
    if (e.home === 'console') expect(reg.NEVER_SERVED).toContain(e.kind);
    if (e.kind === 'state') expect(reg.editOf(e)).toBe('console');
    if (e.automation !== undefined) expect(e.automation).toBe(true);
    if (e.required !== undefined) expect(e.required).toBe(true);
  });

  test('descriptions and labels name no person or firm (they are a new tenant\'s hint)', () => {
    const NAMES = /sandweiss|stuart|shoshana|rena\b|rivka|valerie|charmaine|charlie|fred\b|4lsg|legal solutions|metro detroit/i;
    for (const [k, e] of entries) {
      expect([k, NAMES.test(e.label + ' ' + e.desc)]).toEqual([k, false]);
    }
  });

  test('sections are unique per home and every home has at least one', () => {
    for (const home of Object.keys(reg.HOME_CAPS)) {
      const ids = reg.SECTIONS[home].map((s) => s.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of reg.SECTIONS[home]) {
        expect(Object.isFrozen(s)).toBe(true);
        expect(typeof s.title).toBe('string');
        expect(/^[a-z0-9-]+$/.test(s.icon)).toBe(true);
      }
    }
  });

  test('the registry and its sections are frozen', () => {
    expect(Object.isFrozen(reg.SETTINGS)).toBe(true);
    expect(Object.isFrozen(reg.SECTIONS)).toBe(true);
    expect(Object.isFrozen(reg.HOME_CAPS)).toBe(true);
  });
});

describe('HOME_CAPS', () => {
  test('exact map', () => {
    expect(JSON.parse(JSON.stringify(reg.HOME_CAPS))).toEqual({
      firm:    { read: null,              write: 'firm.settings' },
      portal:  { read: null,              write: 'firm.settings' },
      config:  { read: null,              write: 'firm.settings' },
      cta:     { read: null,              write: 'system.settings' },
      system:  { read: 'system.settings', write: 'system.settings' },
      comms:   { read: 'system.settings', write: 'system.settings' },
      console: { read: false,             write: null },
    });
  });

  test('every named capability exists in lib/capabilities', () => {
    for (const c of Object.values(reg.HOME_CAPS)) {
      for (const cap of [c.read, c.write]) {
        if (typeof cap === 'string') expect(Object.keys(CAPABILITIES)).toContain(cap);
      }
    }
  });

  test('capsOf: never-served kinds get the console caps whatever their home', () => {
    expect(reg.capsOf(reg.get('firm_name'))).toBe(reg.HOME_CAPS.firm);
    expect(reg.capsOf(reg.get('app_url'))).toBe(reg.HOME_CAPS.system);
    expect(reg.capsOf(reg.get('quo_api_key'))).toBe(reg.HOME_CAPS.console);
    expect(reg.capsOf({ kind: 'secret', home: 'firm' })).toBe(reg.HOME_CAPS.console);
    expect(reg.capsOf({ kind: 'access', home: 'system' })).toBe(reg.HOME_CAPS.console);
  });
});

describe('lookups', () => {
  test('get / isRegistered', () => {
    expect(reg.get('firm_name').home).toBe('firm');
    expect(reg.get('payment_failed_cooldown_days')).toBeNull();
    expect(reg.get('constructor')).toBeNull();
    expect(reg.get('__proto__')).toBeNull();
    expect(reg.get(undefined)).toBeNull();
    expect(reg.isRegistered('clio_login_code')).toBe(true);
    expect(reg.isRegistered('gate_probe')).toBe(false);
  });

  test('registeredSpelling: the registered key MySQL would match (case and trailing spaces ignored)', () => {
    expect(reg.registeredSpelling('MAIL_SEND_DAILY_BUDGET')).toBe('mail_send_daily_budget');
    expect(reg.registeredSpelling('Firm_Name  ')).toBe('firm_name');
    expect(reg.registeredSpelling('FE-Lead_Sources')).toBe('fe-lead_sources');
    expect(reg.registeredSpelling('firm_name')).toBe('firm_name');
    expect(reg.registeredSpelling(' firm_name')).toBeNull();          // leading spaces count
    expect(reg.registeredSpelling('payment_failed_cooldown_days')).toBeNull();
    expect(reg.registeredSpelling('CONSTRUCTOR')).toBeNull();
    expect(reg.registeredSpelling(undefined)).toBeNull();
    // the fold must be unambiguous: no two registered keys differ only in case
    const folded = Object.keys(reg.SETTINGS).map((k) => k.toLowerCase());
    expect(new Set(folded).size).toBe(folded.length);
  });

  test('isSecret: registry OR row flag', () => {
    expect(reg.isSecret('pabbly_internal_url', 0)).toBe(true);   // registry says so, row does not
    expect(reg.isSecret('firm_name', 1)).toBe(true);             // row says so
    expect(reg.isSecret('firm_name', 0)).toBe(false);
    expect(reg.isSecret('some_variable', '1')).toBe(true);
    expect(reg.isSecret('some_variable', 0)).toBe(false);
  });

  test('automationMayWrite', () => {
    expect(reg.automationMayWrite('clio_login_code', 0)).toEqual({ ok: true });
    expect(reg.automationMayWrite('payment_failed_cooldown_days', 0)).toEqual({ ok: true });
    for (const k of ['landing_hosts', 'comms_archive_admins', 'firm_name', 'min_client_build',
                     'portal_sms_counter', 'fe-case_types', 'unified_singleton_enabled']) {
      const r = reg.automationMayWrite(k, 0);
      expect([k, r.ok]).toEqual([k, false]);
      expect(r.reason).toMatch(/registered setting/);
    }
    expect(reg.automationMayWrite('pabbly_internal_url', 0)).toEqual({ ok: false, reason: 'is a secret' });
    expect(reg.automationMayWrite('some_variable', 1)).toEqual({ ok: false, reason: 'is a secret' });
    expect(reg.automationMayWrite('clio_login_code', 1)).toEqual({ ok: false, reason: 'is a secret' });
  });
});

describe('validators', () => {
  test('blank always passes, every type', () => {
    for (const t of reg.TYPES) {
      expect([t, reg.validateByType(t, '', ['x'])]).toEqual([t, true]);
      expect([t, reg.validateByType(t, '   ', ['x'])]).toEqual([t, true]);
    }
  });

  test('non-strings are refused', () => {
    expect(reg.validateByType('string', 5)).toMatch(/string/);
    expect(reg.validateByType('number', null)).toMatch(/string/);
  });

  test('picker types check shape only', () => {
    expect(reg.validateByType('user', '22')).toBe(true);
    expect(reg.validateByType('user', ' 22 ')).toBe(true);
    expect(reg.validateByType('user', '22,5')).toMatch(/user id/);
    expect(reg.validateByType('user', 'bob')).toMatch(/user id/);
    expect(reg.validateByType('user_csv', '22, 5,1')).toBe(true);
    expect(reg.validateByType('user_csv', '22,,5')).toMatch(/user ids/);
    expect(reg.validateByType('user_csv', '22,x')).toMatch(/user ids/);
    expect(reg.validateByType('credential', '14')).toBe(true);
    expect(reg.validateByType('credential', '-1')).toMatch(/credential/);
    expect(reg.validateByType('sequence', '26')).toBe(true);
    expect(reg.validateByType('sequence', '2.6')).toMatch(/sequence/);
  });

  test('enum checks options (trimmed)', () => {
    expect(reg.validateByType('enum', 'on', ['off', 'on'])).toBe(true);
    expect(reg.validateByType('enum', ' on ', ['off', 'on'])).toBe(true);
    expect(reg.validateByType('enum', 'ON', ['off', 'on'])).toMatch(/one of: off, on/);
    expect(reg.validateByType('enum', 'x', undefined)).toMatch(/one of/);
  });

  test('string / template / unknown types are verbatim', () => {
    expect(reg.validateByType('string', '  /  Law Office/ ')).toBe(true);
    expect(reg.validateByType('template', '{{x}}\n')).toBe(true);
    expect(reg.validateByType('text', 'anything')).toBe(true);
    expect(reg.validateByType(null, 'anything')).toBe(true);
  });

  test('the carried-over validators keep their behaviour', () => {
    expect(reg.validateByType('number', '1.5')).toBe(true);
    expect(reg.validateByType('number', '1,5')).toMatch(/number/);
    expect(reg.validateByType('bool', '1')).toBe(true);
    expect(reg.validateByType('bool', 'true')).toMatch(/1 or 0/);
    expect(reg.validateByType('email', 'a@b.co')).toBe(true);
    expect(reg.validateByType('email', 'a@b')).toMatch(/email/);
    expect(reg.validateByType('csv', 'a,b')).toBe(true);
    expect(reg.validateByType('csv', 'a,,b')).toMatch(/comma-separated/);
    expect(reg.validateByType('phone', '(248) 555-1212')).toBe(true);
    expect(reg.validateByType('phone', '555')).toMatch(/phone/);
    expect(reg.validateByType('url', 'https://x.test')).toBe(true);
    expect(reg.validateByType('url', 'ftp://x.test')).toMatch(/http/);
    expect(reg.validateByType('json', '{"a":1}')).toBe(true);
    expect(reg.validateByType('json', '{a')).toMatch(/JSON/);
    expect(reg.validateByType('json_array', '[1]')).toBe(true);
    expect(reg.validateByType('json_array', '{}')).toMatch(/array/);
    expect(reg.validateByType('date', 'off')).toBe(true);
    expect(reg.validateByType('date', '1783957244000')).toBe(true);
    expect(reg.validateByType('date', 'nope')).toMatch(/date/);
  });

  test('duration: a unit is required, > 0, at most 365 days (ctaService reads these with ms)', () => {
    for (const ok of ['30m', '12h', '3d', '2w', '365d', '1.5h', ' 3d ', '3 days', '26w']) {
      expect([ok, reg.validateByType('duration', ok)]).toEqual([ok, true]);
    }
    for (const bad of ['3', '0d', '3x', 'd3', '-3d', '3d3h']) {
      expect([bad, reg.validateByType('duration', bad)]).toEqual([bad, expect.stringMatching(/with a unit/)]);
    }
    expect(reg.validateByType('duration', '366d')).toMatch(/365 days/);
    expect(reg.validateByType('duration', '1y')).toMatch(/365 days/);   // ms: a year is 365.25d
  });

  test('required: blank refused only for required keys, by validate()', () => {
    expect(reg.validate('portal_email_from', '')).toMatch(/cannot be blank/);
    expect(reg.validate('portal_email_from', '  ')).toMatch(/cannot be blank/);
    expect(reg.validate('portal_callback_task_to', '')).toMatch(/cannot be blank/);
    expect(reg.validate('portal_callback_task_to', '1')).toBe(true);
    expect(reg.validate('portal_docs_notify_to', '')).toBe(true);     // blank = upload emails off, by design
    expect(reg.validate('default_task_assignee', '')).toBe(true);
    expect(reg.validateByType('email', '')).toBe(true);               // the type alone never refuses blank
  });

  test('validate(): a registered key by its own type; unregistered throws', () => {
    expect(reg.validate('alert_email_min_severity', 'warn')).toBe(true);
    expect(reg.validate('alert_email_min_severity', 'loud')).toMatch(/one of: error, warn, info/);
    expect(reg.validate('default_task_assignee', 'Rena')).toMatch(/user id/);
    expect(() => reg.validate('payment_failed_cooldown_days', '6')).toThrow(/unregistered/);
  });
});
