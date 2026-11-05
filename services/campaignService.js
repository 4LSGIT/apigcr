// services/campaignService.js
//
/**
 * Campaign Service (redesigned)
 * services/campaignService.js
 *
 * All campaign business logic. Routes are thin HTTP wrappers.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  REQUIRED MIGRATION (run before deploy):                             │
 * │                                                                      │
 * │  ALTER TABLE campaign_results                                        │
 * │    ADD UNIQUE KEY uq_campaign_contact (campaign_id, contact_id);     │
 * │                                                                      │
 * │  This is required for the reservation INSERT and recordResult().     │
 * │  See migrations/2026XX_campaign_results_uq.sql for the full migration │
 * │  including a pre-check for any existing duplicate rows.              │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * YisraMail C1 (campaign hardening, ref/YISRAMAIL_DESIGN.md §6.1 / §6.4
 * "As built (C1)"): a campaign has a CLASS (operational | marketing), an
 * operational recipient cap with an audited over-cap path (D16), the
 * marketing kill switch, a send reservation (at most once, every class), a
 * per-transport rate window, a per-campaign pump and a `paused` status.
 *
 * YisraMail C2 (the marketing send path, §4.5 / §6.4 / §6.5 "As built (C2)"):
 * executeSend's marketing branch — consent by topic, the transport HOLD
 * (email_credentials.held_at, set by the §6.5 thresholds or an account-level
 * provider refusal, released only by a superuser — releaseTransport), the
 * send-start snapshot (campaigns.send_snapshot), the per-recipient unsub
 * token, the explicit text part + compliance footer + post-render assert, the
 * marketing headers, email_log without the body; and testSendMarketing.
 *
 * Functions:
 *   getFilteredContacts(db, filters)       — contact selection with tag/case/channel filters
 *   createCampaign(db, opts)               — single-transaction: campaign + contacts + jobs (+ pump)
 *   cancelCampaign(db, campaignId)         — cancel + remove pending jobs
 *   pauseCampaign(db, campaignId)          — status paused; pending jobs stay pending
 *   resumeCampaign(db, campaignId)         — status sending; the pump restarts
 *   getCampaign(db, campaignId)            — single campaign with results summary
 *   listCampaigns(db, opts)                — paginated list for View tab
 *   getCampaignResults(db, campaignId)     — per-contact result details
 *   executeSend(db, campaignId, contactId) — core send logic (called by job_executor)
 *   runPump(db, campaignId, opts)          — one pump tick (called by job_executor)
 *   previewCampaign(db, opts)              — resolve placeholders for preview display
 *   consentOptsFor(type, klass, topicKey)  — the consent question a send asks (shared with the preview)
 *   testSendMarketing(db, opts)            — "send a test to me" (C2)
 *   releaseTransport(db, credentialId, o)  — the SU release of a held transport (C2)
 */

const { resolve }    = require('./resolverService');
// The footer builder, called through the module object (a test can stand in a gutted footer — C2's post-render assert).
const complianceFooter = require('../lib/complianceFooter');
const phoneService = require('./phoneService');
const emailService = require('./emailService');
const { localToUTC } = require('./timezoneService');
const { can } = require('../lib/capabilities');
// Consent is read ONLY through optoutService (YisraMail P1: the destination's
// consent state, dual-read with the row's cache flag). What a campaign asks
// depends on its class (C1, consentOptsFor below): marketing email asks scope
// 'marketing' + the campaign's topic; operational email asks NOTHING (D18 —
// opt-outs gate promotion, not operational mail); SMS asks operational
// (scope 'all' — every STOP), D19, whatever the class.
const optout = require('./optoutService');

// ─────────────────────────────────────────────────────────────
// C1 vocabulary
// ─────────────────────────────────────────────────────────────

/** campaigns.class — exactly these two spellings (the same strictness as type). */
const KLASSES = Object.freeze(['operational', 'marketing']);
/** comm_topics.topic_key shape (it is interpolated into SQL by optoutService). */
const TOPIC_RE = /^[a-z0-9_]{1,40}$/;
/** campaign_operational_cap when blank / absent / not a positive number (ruled 2026-10-22). */
const DEFAULT_OPERATIONAL_CAP = 50;
/** campaign_marketing_rate when blank / absent / not a positive number: per minute, per transport (D12). */
const DEFAULT_MARKETING_RATE = 60;
/** The rate window at dispatch looks back this far. */
const RATE_WINDOW_SECONDS = 60;
/** A job deferred by the rate window comes back after 2–8 s (jittered). */
const RATE_DEFER_MIN_MS = 2000;
const RATE_DEFER_SPREAD_MS = 6000;
/**
 * The BACKSTOP for a paused campaign's job that was already claimed when the
 * pause parked its siblings (pauseCampaign): it defers itself 5 min (+ up to
 * 30 s jitter), consuming no attempt. Long on purpose — a few such stragglers
 * re-deferring every minute would keep taking the cron's campaign-send quota
 * (the C1 review blocker); resume re-staggers them with the parked rows, so
 * the length costs nothing on resume.
 */
const PAUSED_DEFER_MS = 300000;
const PAUSED_DEFER_SPREAD_MS = 30000;
/**
 * PAUSE PARKING: pause moves the campaign's PENDING campaign_send rows this
 * many years out (scheduled_time + INTERVAL 1000 YEAR — relative order and
 * each row's original time kept), so they are never due and never take the
 * cron's quota; resume moves them back (resumeCampaign). A row at or after
 * PARKED_AFTER is a parked row. Pending stays pending: nothing is deleted or
 * deactivated (§6.4).
 */
const PARK_YEARS = 1000;
/** createCampaign refuses a scheduledTime further out than this (keeps PARKED_AFTER unreachable). */
const MAX_SCHEDULE_DAYS = 366;
const PARKED_AFTER = '2900-01-01 00:00:00';
/**
 * The pump re-arms its own row this far out AND rings that row's own
 * doorbell (runPump). 55 s, not 60: the re-arm is measured after the tick's
 * enqueues, and a 60 s re-arm with no doorbell waited for the NEXT cron tick
 * (~120 s effective — the pump ran at half rate, C1 review). 55 s is inside
 * ACCEL_WINDOW_MS (90 s), so ringing it keeps lib/taskQueue invariant 3 (a
 * doorbell, not a calendar).
 */
const PUMP_REARM_MS = 55000;
/** Campaign statuses a straggler job finds after completion. */
const FINISHED_STATUSES = Object.freeze(['sent', 'failed', 'partial_fail']);
/** campaign_results rows a send never touches again. 'sending' is the reservation. */
const TERMINAL_RESULTS = Object.freeze(['sent', 'failed', 'skipped', 'unknown']);

/** A refusal the route maps to an HTTP status (status, code, extra are copied into the body). */
class CampaignError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'CampaignError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * An email attachment URL must be https:// (C2 security fix). The smtp / gmail
 * adapters hand it to nodemailer as an attachment `path`, and nodemailer READS
 * A LOCAL FILE at any path that is not a URL — '/proc/self/environ' would have
 * mailed the server's environment to whoever chose the recipient. Refused,
 * never stripped. (The smtp adapter also sets disableFileAccess — the root fix;
 * this is the fail-closed front door.)
 */
function assertHttpsAttachment(url, code = 'bad_attachment_url') {
  let ok = typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url) && url.length <= 2048;
  if (ok) { try { ok = new URL(url).protocol === 'https:'; } catch (_) { ok = false; } }
  if (!ok) throw new CampaignError(400, code, 'An email attachment must be an https:// URL.');
}

function positiveNumber(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * The three C1 settings, read UNCACHED (one query) — the kill switch's
 * neighbours (documents_sync_enabled, court_ingest_live) read the same way,
 * because a switch flipped off must hold on every instance at once, not after
 * lib/firmConfig's 60 s cache (which also fails OPEN on a refresh error — the
 * wrong posture for a fail-closed switch). A DB error here throws: at create
 * that is a 500, at send a transient retry — never "on".
 *   marketingEnabled  marketing_send_enabled is EXACTLY '1' (absent, blank, anything else = off)
 *   cap               campaign_operational_cap, blank / absent / not > 0 → 50
 *   rate              campaign_marketing_rate (per minute), blank / absent / not > 0 → 60
 */
async function readCampaignSettings(db) {
  const { getSettings } = require('./settingsService'); // lazy require (convention)
  const s = await getSettings(db, ['marketing_send_enabled', 'campaign_operational_cap', 'campaign_marketing_rate']);
  return {
    marketingEnabled: s.marketing_send_enabled === '1',
    cap: Math.floor(positiveNumber(s.campaign_operational_cap, DEFAULT_OPERATIONAL_CAP)),
    rate: positiveNumber(s.campaign_marketing_rate, DEFAULT_MARKETING_RATE),
  };
}

/**
 * The consent question a campaign send asks optoutService (findOptedOut /
 * emailOptedOutSql options) — ONE answer for executeSend, the contact picker
 * (getFilteredContacts) and the compose preview (routes/api.consent.js):
 *   sms                  → {}  operational: scope 'all', every STOP (D19). Marketing
 *                              SMS is refused at create (D1), so no other SMS question exists.
 *   email, marketing     → { klass: 'marketing', topic }  scope 'marketing' + the topic
 *   email, operational   → null  NO consent query (D18 — an operational message reaches a
 *                              marketing opt-out; that is the ruled design, not a gap)
 */
function consentOptsFor(type, klass, topicKey) {
  if (type === 'sms') return {};
  if (klass === 'marketing') return { klass: 'marketing', topic: topicKey || null };
  return null;
}

// ─────────────────────────────────────────────────────────────
// CONTACT SELECTION
// ─────────────────────────────────────────────────────────────

/**
 * Query contacts matching filter criteria.
 *
 * @param {object} db
 * @param {object} filters
 * @param {string[]} [filters.tags]            — OR logic: contact has any of these tags
 * @param {string}   [filters.case_type]       — case CATEGORY, exact, e.g. "Bankruptcy"
 * @param {string}   [filters.case_subtype]    — category refinement, exact, e.g. "Chapter 7"
 *                                               (2026-06 split). Independently optional:
 *                                               case_type alone matches every subtype.
 * @param {string|string[]} [filters.case_stage] — e.g. "Open" or ["Open","Filed"]
 * @param {string}   [filters.case_open_after] — date string YYYY-MM-DD
 * @param {string}   [filters.case_open_before]
 * @param {string}   [filters.channel]         — "sms" or "email": filters by has-phone/email + opt-out
 * @param {string}   [filters.klass]           — the campaign class the selection is for
 *                                               (default 'operational'); decides the email opt-out
 *                                               question (consentOptsFor)
 * @param {string}   [filters.topic]           — marketing topic (marketing class only)
 *
 * @returns {{ contacts, total, excluded }}
 *   contacts — eligible contact rows
 *   total    — total matching (before opt-out / missing-channel exclusion)
 *   excluded — count excluded due to opt-out or missing phone/email
 */
async function getFilteredContacts(db, filters = {}) {
  const { tags, case_type, case_subtype, case_stage, case_open_after, case_open_before, channel } = filters;
  const klass = filters.klass || 'operational';
  const topic = filters.topic || null;

  // ── Build query ──

  // optoutService's predicates — the same question executeSend re-asks per
  // contact at send time (consentOptsFor: SMS operational; email by class —
  // an operational selection excludes no email opt-out, D18).
  const selects = [
    'c.contact_id', 'c.contact_name', 'c.contact_phone', 'c.contact_email',
    'c.contact_tags',
    `${optout.smsOptedOutSql('c.contact_phone')} AS sms_opted_out`,
    `${optout.emailOptedOutSql('c.contact_email', consentOptsFor('email', klass, topic) || {})} AS email_opted_out`
  ];
  const joins  = [];
  const wheres = [];
  const params = [];

  // Case filters require JOINs through case_relate
  const needsCaseJoin = case_type || case_subtype || case_stage || case_open_after || case_open_before;
  if (needsCaseJoin) {
    joins.push('JOIN case_relate cr ON cr.case_relate_client_id = c.contact_id');
    joins.push('JOIN cases cs ON cs.case_id = cr.case_relate_case_id');
  }

  // Tags — OR logic via FIND_IN_SET (exact match within CSV)
  if (tags && tags.length) {
    const tagClauses = tags.map(() => 'FIND_IN_SET(?, c.contact_tags)');
    wheres.push(`(${tagClauses.join(' OR ')})`);
    params.push(...tags);
  }

  if (case_type) {
    wheres.push('cs.case_type = ?');
    params.push(case_type);
  }

  // Subtype (2026-06 split) is EXACT and applied only when present, matching
  // caseService.listCases. Values are opaque free text, so no LIKE here — a
  // subtype may legitimately contain '%'.
  if (case_subtype) {
    wheres.push('cs.case_subtype = ?');
    params.push(case_subtype);
  }

  if (case_stage) {
    const stages = Array.isArray(case_stage) ? case_stage : [case_stage];
    wheres.push(`cs.case_stage IN (${stages.map(() => '?').join(',')})`);
    params.push(...stages);
  }

  if (case_open_after) {
    wheres.push('cs.case_open_date >= ?');
    params.push(case_open_after);
  }

  if (case_open_before) {
    wheres.push('cs.case_open_date <= ?');
    params.push(case_open_before);
  }

  const whereClause = wheres.length ? wheres.join(' AND ') : '1=1';

  const query = `
    SELECT DISTINCT ${selects.join(', ')}
    FROM contacts c
    ${joins.join(' ')}
    WHERE ${whereClause}
    ORDER BY c.contact_name
  `;

  const [allMatching] = await db.query(query, params);

  // ── Separate eligible from excluded ──

  const contacts = [];
  let excluded = 0;

  for (const c of allMatching) {
    if (channel === 'sms') {
      if (!c.contact_phone || Number(c.sms_opted_out) === 1) { excluded++; continue; }
    } else if (channel === 'email') {
      if (!c.contact_email || Number(c.email_opted_out) === 1) { excluded++; continue; }
    }
    contacts.push(c);
  }

  return { contacts, total: allMatching.length, excluded };
}



/**
 * The case-type vocabulary that ACTUALLY EXISTS in cases, as a
 * { Type: [Subtype, ...] } map — the same shape as the fe-case_types setting,
 * so a caller can merge the two with no translation.
 *
 * WHY, given fe-case_types already exists: that setting is the WRITER
 * vocabulary (what staff may create). Every create dialog also offers an
 * 'Other' free-text escape, so cases carry types the registry never listed —
 * 'potato hunting', 'support' and 'Unknown' are all live right now. A filter
 * built from the registry alone cannot reach those rows.
 *
 * Rows with an empty case_type are EXCLUDED: '' is "no type set", not a type,
 * and an empty key would render as a blank option. There are ~63 such cases;
 * reaching them needs a deliberate "(no type set)" affordance, not this.
 *
 * Cheap: one DISTINCT over ~1,100 rows returning well under a dozen pairs.
 * Kept here rather than in caseService because campaign.html is the only
 * consumer today — promote it if the Cases-tab filter ever wants it too.
 */
async function getCaseTypeFacets(db) {
  const [rows] = await db.query(
    `SELECT DISTINCT case_type, case_subtype
       FROM cases
      WHERE case_type IS NOT NULL AND case_type <> ''
      ORDER BY case_type, case_subtype`
  );

  const map = {};
  for (const r of rows) {
    const t = String(r.case_type);
    if (!map[t]) map[t] = [];
    const sub = r.case_subtype == null ? '' : String(r.case_subtype);
    if (sub && !map[t].includes(sub)) map[t].push(sub);
  }
  return map;
}

/**
 * What the compose form needs beyond firm-data (C1): the marketing senders
 * (bulk_ok rows — never in firm-data's emailFrom, the T1 fence), the active
 * email topics (unsubService's own statement — the topics the preference page
 * offers), the operational cap, whether the kill switch is on, and whether
 * the caller holds campaigns.bulk. Display only; createCampaign is the gate.
 */
async function getComposeOptions(db, auth) {
  const settings = await readCampaignSettings(db);
  const { UNSUB_SQL } = require('./unsubService'); // lazy require (convention)
  const [senders] = await db.query(
    'SELECT id, email, from_name, held_at, held_reason FROM email_credentials WHERE bulk_ok = 1 ORDER BY id'
  );
  const [topics] = await db.query(UNSUB_SQL.topics);
  return {
    // held (C2, §6.5): a held transport refuses marketing creates and sends until an SU release.
    marketing_senders: (senders || []).map((r) => ({ id: r.id, email: r.email, from_name: r.from_name, held: r.held_at != null, held_reason: r.held_at != null ? (r.held_reason || null) : null })),
    topics: (topics || []).map((t) => ({ topic_key: t.topic_key, label: t.label, description: t.description, consent_model: t.consent_model })),
    operational_cap: settings.cap,
    marketing_rate: settings.rate,
    marketing_enabled: settings.marketingEnabled,
    can_bulk: can(auth, 'campaigns.bulk'),
    footer_slot: FOOTER_SLOT,
  };
}

// ─────────────────────────────────────────────────────────────
// CREATE CAMPAIGN
// ─────────────────────────────────────────────────────────────

/** The marketing topic check: exists, an EMAIL topic, active — what unsubService.mintUnsubToken requires. */
async function assertMarketingTopic(db, topicKey) {
  if (topicKey == null || topicKey === '') {
    throw new CampaignError(400, 'topic_required', 'A marketing campaign needs a topic (the list recipients can unsubscribe from).');
  }
  if (typeof topicKey !== 'string' || topicKey === 'marketing' || topicKey === 'all' || !TOPIC_RE.test(topicKey)) {
    throw new CampaignError(400, 'bad_topic', `"${String(topicKey).slice(0, 40)}" is not a topic`);
  }
  try {
    // optoutService.assertScope — the check recordConsent and the token mint run.
    await optout.assertScope(db, 'email', topicKey);
  } catch (err) {
    if (err && /^recordConsent: /.test(String(err.message))) {
      throw new CampaignError(400, 'bad_topic', String(err.message).replace(/^recordConsent: /, ''));
    }
    throw err;
  }
  const [[t]] = await db.query(optout.FIND_SQL.topic, [topicKey]);
  if (!t || Number(t.active) !== 1) throw new CampaignError(400, 'bad_topic', `topic "${topicKey}" is not active`);
}

/**
 * Create a campaign with contacts and scheduled send jobs.
 * Runs in a single transaction — all-or-nothing.
 *
 * C1 rules (ref/YISRAMAIL_DESIGN.md §6.1, D13, D16):
 *   - class 'operational' (default) | 'marketing', exactly.
 *   - marketing: refused 422 while marketing_send_enabled is not exactly '1';
 *     never SMS (422, D1); needs campaigns.bulk (403), an active email topic
 *     (400) and a bulk_ok sender (400). Audited (campaign_marketing_create).
 *   - operational: no topic (400). Over campaign_operational_cap DEDUPED
 *     recipients needs campaigns.bulk (403) AND confirmCount === that count
 *     (409 naming the real count, so the UI re-prompts); audited
 *     (campaign_over_cap); may name a bulk_ok email sender (D16 — sent with no
 *     footer). Within the cap a bulk_ok sender is refused (T1 fence).
 *   - marketing and over-cap campaigns are PACED: jobs staggered at
 *     campaign_marketing_rate per minute + one campaign_pump job.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}   opts.type         — "sms" or "email"
 * @param {string}   opts.sender       — phone number or email address
 * @param {string}   [opts.subject]    — email only
 * @param {string}   opts.body         — message body (may contain {{placeholders}})
 * @param {number[]} opts.contactIds   — array of contact IDs
 * @param {string}   [opts.scheduledTime] — firm-local datetime string, null = send now
 * @param {number}   opts.createdBy    — user ID
 * @param {string}   [opts.klass='operational'] — route body `class`
 * @param {string}   [opts.topicKey]   — marketing only
 * @param {number}   [opts.confirmCount] — the typed recipient count (over the cap)
 * @param {object}   [opts.auth]       — req.auth (capability checks)
 * @param {object}   [opts.request]    — { route, method, ip, userAgent } for the audit row
 * @param {number}   [opts.designId]   — email_designs.id the body was composed from (C3; provenance only)
 *
 * @returns {{ campaignId, contactCount, jobsCreated, status, class, overCap, paced }}
 */
async function createCampaign(db, {
  type, sender, subject, body, contactIds, scheduledTime, createdBy, attachmentUrl, includeSignature,
  klass = 'operational', topicKey = null, confirmCount = null, auth = null, request = null, designId = null,
}) {
  if (!type || !sender || !body) {
    throw new Error('Missing required fields: type, sender, body');
  }
  // Exactly these two spellings (T1): executeSend treats any non-'sms' type as
  // email, so a campaign typed 'EMAIL' would otherwise skip the sender check
  // below and still send email.
  if (type !== 'email' && type !== 'sms') {
    throw new Error(`type must be "email" or "sms" (got ${JSON.stringify(String(type)).slice(0, 40)})`);
  }
  // Class: the same strictness as type. A typo must not read as either class.
  if (!KLASSES.includes(klass)) {
    throw new CampaignError(400, 'bad_class', `class must be "operational" or "marketing" (got ${JSON.stringify(String(klass)).slice(0, 40)})`);
  }
  const topic = topicKey == null || topicKey === '' ? null : topicKey;
  if (klass === 'operational' && topic !== null) {
    throw new CampaignError(400, 'topic_not_allowed', 'A topic applies to marketing campaigns only.');
  }
  if (klass === 'marketing' && type === 'sms') {
    throw new CampaignError(422, 'marketing_sms_refused', 'Marketing campaigns are email only — marketing text messages are not offered.');
  }
  if (!contactIds || !contactIds.length) {
    throw new Error('At least one contact is required');
  }
  if (type === 'email' && !subject) {
    throw new Error('Subject is required for email campaigns');
  }

  // Deduplicate contact IDs — the cap counts THIS number.
  const uniqueIds = [...new Set(contactIds.map(Number).filter(id => id > 0))];
  const count = uniqueIds.length;

  const settings = await readCampaignSettings(db);

  if (klass === 'marketing') {
    // The kill switch (§6.1): until gate G1 passes, nothing creates a
    // marketing campaign (C2 built the send path; the switch stays '0' until
    // the checklist passes).
    if (!settings.marketingEnabled) {
      throw new CampaignError(422, 'marketing_disabled',
        'Marketing campaigns are switched off. They open once the compliance checklist passes and a superuser turns on marketing_send_enabled.');
    }
    if (!can(auth, 'campaigns.bulk')) {
      throw new CampaignError(403, 'bulk_capability_required', 'Marketing campaigns need the campaigns.bulk capability (admin role).');
    }
    await assertMarketingTopic(db, topic);
  }

  const overCap = klass === 'operational' && count > settings.cap;
  if (overCap) {
    if (!can(auth, 'campaigns.bulk')) {
      throw new CampaignError(403, 'bulk_capability_required',
        `This campaign has ${count} recipients — over the ${settings.cap}-recipient cap for operational campaigns. Sending over the cap needs the campaigns.bulk capability (admin role).`,
        { count, cap: settings.cap });
    }
    const typed = confirmCount == null || confirmCount === '' ? NaN : Number(confirmCount);
    if (typed !== count) {
      throw new CampaignError(409, 'over_cap_confirmation',
        `This campaign has ${count} recipients — over the ${settings.cap}-recipient cap. Type ${count} to confirm the send.`,
        { count, cap: settings.cap });
    }
  }

  // Email sender: a configured email_credentials row. A marketing (bulk_ok)
  // transport only for a marketing campaign or an over-cap operational one
  // (D16); within the cap the T1 fence refuses it (ref/YISRAMAIL_DESIGN.md
  // §5.2). Before T1 an unknown sender was only discovered by every job
  // failing at send.
  if (type === 'email') {
    const [[senderRow]] = await db.query(
      'SELECT id, bulk_ok, held_at, held_reason FROM email_credentials WHERE email = ? LIMIT 1',
      [sender]
    );
    if (!senderRow) {
      throw new CampaignError(400, 'unknown_sender', `Email sender ${sender} is not a configured sender`);
    }
    const bulkSender = senderRow.bulk_ok != null && Number(senderRow.bulk_ok) !== 0;
    if (klass === 'marketing' && !bulkSender) {
      throw new CampaignError(400, 'marketing_requires_bulk_sender', `Marketing campaigns send only from a marketing transport — ${sender} is not one.`);
    }
    // C2 (§6.5): a HELD transport refuses new marketing campaigns.
    if (klass === 'marketing' && senderRow.held_at != null) {
      throw new CampaignError(422, 'transport_held',
        `Marketing transport ${sender} is held: ${senderRow.held_reason || 'no reason recorded'}. A superuser release lifts it.`,
        { held_reason: senderRow.held_reason || null });
    }
    if (klass === 'operational' && bulkSender && !overCap) {
      throw new CampaignError(400, 'bulk_sender_refused', `Operational campaigns cannot send from a marketing transport (${sender})`);
    }
  }

  // Email attachment: https:// only (assertHttpsAttachment — create time;
  // rows created before C2 are not re-checked).
  if (attachmentUrl && type === 'email') assertHttpsAttachment(attachmentUrl);

  // C3 (§6.3): the Designer design the body was composed from — PROVENANCE
  // only ("duplicate last month's"). It must name an existing, non-archived
  // design; the body stays exactly what the caller sent (the send renders
  // campaigns.body, never the design), and nothing is re-validated here.
  let designIdValue = null;
  if (designId !== null && designId !== undefined && designId !== '') {
    if (type !== 'email') throw new CampaignError(400, 'design_not_email', 'A design applies to email campaigns only.');
    const { toId } = require('./emailDesignService'); // lazy require (convention)
    const n = toId(designId);
    if (!n) throw new CampaignError(400, 'unknown_design', `design_id must be a design id (got ${JSON.stringify(String(designId)).slice(0, 40)})`);
    const [[design]] = await db.query('SELECT id, archived FROM email_designs WHERE id = ?', [n]);
    if (!design) throw new CampaignError(400, 'unknown_design', `Design ${n} does not exist.`);
    if (Number(design.archived)) throw new CampaignError(400, 'design_archived', `Design ${n} is archived — unarchive it to compose from it.`);
    designIdValue = n;
  }

  // MMS validation: attachment requires an MMS-capable line.
  // (Capability lives on phone_lines.mms_capable; checked at send time too.)
  if (attachmentUrl && type === 'sms') {
    const fromClean = sender.toString().replace(/\D/g, '').slice(-10);
    const [[line]] = await db.query(
      'SELECT provider, mms_capable FROM phone_lines WHERE phone_number = ? AND active = 1 LIMIT 1',
      [fromClean]
    );
    if (!line) {
      throw new Error(`Sender ${sender} not found in phone_lines (or inactive)`);
    }
    if (!line.mms_capable) {
      throw new Error(`MMS requires an MMS-capable line. ${sender} (provider=${line.provider}) is not MMS-capable.`);
    }
  }

  // Upstream (the route) validates that contactIds is a non-empty array, but
  // values like [0], [-1], ['abc'], [null] pass that check and become [] after
  // the Number/filter above. An empty VALUES clause in the batch INSERT below
  // would throw a cryptic mysql2 error — fail here with a clear message.
  if (!uniqueIds.length) {
    throw new Error('No valid contact IDs after filtering (all IDs were zero, negative, or non-numeric)');
  }

  // Determine initial status and job scheduled time
  const isScheduled = !!scheduledTime;
  const initialStatus = isScheduled ? 'scheduled' : 'sending';

  // Convert firm-local → UTC for job scheduling
  const jobTime = isScheduled ? localToUTC(scheduledTime) : new Date();
  if (isScheduled && !jobTime) {
    throw new Error('Invalid scheduledTime value');
  }
  // At most MAX_SCHEDULE_DAYS out. Besides catching a year typo ("2926" for
  // "2026"), this makes pause parking's PARKED_AFTER threshold unreachable by
  // construction: a row at or after it is ALWAYS a parked row, never a
  // genuinely far-future send that resume would pull back 1000 years.
  if (isScheduled && jobTime.getTime() - Date.now() > MAX_SCHEDULE_DAYS * 86400000) {
    throw new CampaignError(400, 'schedule_too_far',
      `A campaign can be scheduled at most ${MAX_SCHEDULE_DAYS} days ahead (got ${String(scheduledTime).slice(0, 40)}).`,
      { max_days: MAX_SCHEDULE_DAYS });
  }

  // Paced (marketing, or operational over the cap): one job every 60/rate
  // seconds from jobTime, and ONE pump due at jobTime (§6.4). Within the cap:
  // every job at jobTime, no pump — today's shape.
  const paced = klass === 'marketing' || overCap;
  const intervalMs = paced ? 60000 / settings.rate : 0;
  const jobTimeMs = jobTime.getTime();

  const { campaignId, pumpJobId } = await db.withTransaction(async (conn) => {
    // 1. INSERT campaign
    const [campaignResult] = await conn.query(
      `INSERT INTO campaigns (type, class, topic_key, bulk_confirmed_count, sender, subject, body, attachment_url, include_signature, status, scheduled_time, contact_count, created_by, design_id, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [type, klass, topic, overCap ? count : null, sender, subject || null, body, attachmentUrl || null, includeSignature ? 1 : 0, initialStatus, scheduledTime || null, count, createdBy, designIdValue]
    );
    const campaignId = campaignResult.insertId;

    // 2. Batch INSERT campaign_contacts
    const contactValues = uniqueIds.map(cid => [campaignId, cid]);
    await conn.query(
      'INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ?',
      [contactValues]
    );

    // 3. Batch INSERT scheduled_jobs (one per contact)
    const jobValues = uniqueIds.map((cid, i) => [
      'one_time',                                                          // type
      paced ? new Date(jobTimeMs + Math.round(i * intervalMs)) : jobTime,  // scheduled_time
      'pending',                                                           // status
      `campaign:${campaignId}:send:${cid}`,                                // name
      JSON.stringify({ type: 'campaign_send', campaign_id: campaignId, contact_id: cid }), // data
      3,                                                                   // max_attempts
      60,                                                                  // backoff_seconds
      `campaign:${campaignId}:${cid}`                                      // idempotency_key
    ]);

    await conn.query(
      `INSERT INTO scheduled_jobs
         (type, scheduled_time, status, name, data, max_attempts, backoff_seconds, idempotency_key, created_at, updated_at)
       VALUES ?`,
      [jobValues.map(v => [...v, new Date(), new Date()])]
    );

    // 4. The pump (paced only) — inside the cancel prefix campaign:{id}:%.
    let pumpJobId = null;
    if (paced) {
      pumpJobId = await insertPumpJob(conn, campaignId, jobTime);
    }

    // 5. Audit — in the transaction, so a campaign exists iff its audit row does.
    if (klass === 'marketing' || overCap) {
      const { auditAdminAction } = require('../lib/auth.superuser'); // lazy require (convention)
      await auditAdminAction(conn, {
        tool: klass === 'marketing' ? 'campaign_marketing_create' : 'campaign_over_cap',
        userId: auth?.userId ?? createdBy ?? null,
        username: auth?.username ?? null,
        route: request?.route || 'POST /api/campaigns',
        method: request?.method || 'POST',
        status: 'success',
        ip: request?.ip ?? null,
        userAgent: request?.userAgent ?? null,
        details: {
          campaign_id: campaignId, class: klass, type, sender, count,
          topic_key: topic, cap: settings.cap, rate: settings.rate,
          ...(overCap ? { confirmed_count: count } : {}),
        },
      });
    }

    return { campaignId, pumpJobId };
  });

  // Ring the pump's doorbell when it is due now (NEVER rejects; the cron is
  // the fallback). A scheduled campaign's pump waits for the cron like any
  // far-future job (lib/taskQueue.js invariant 3).
  if (pumpJobId) await ringIfNear(pumpJobId, jobTime);

  console.log(`[CAMPAIGN] Created campaign ${campaignId}: ${type}/${klass}, ${count} contacts, status=${initialStatus}${paced ? `, paced at ${settings.rate}/min` : ''}`);

  return {
    campaignId,
    contactCount: count,
    jobsCreated: count,
    status: initialStatus,
    class: klass,
    overCap,
    paced,
  };
}

/** The pump job row for a campaign (idempotency key = its name). → insertId */
async function insertPumpJob(conn, campaignId, dueAt) {
  const name = `campaign:${campaignId}:pump`;
  // Floored to the second: DATETIME ROUNDS fractional seconds, so an unfloored
  // "now" can land up to 0.5 s in the future and the pump's own doorbell or a
  // same-second claim finds it not yet due.
  dueAt = new Date(Math.floor(new Date(dueAt).getTime() / 1000) * 1000);
  const [r] = await conn.query(
    `INSERT INTO scheduled_jobs
       (type, scheduled_time, status, name, data, max_attempts, backoff_seconds, idempotency_key, created_at, updated_at)
     VALUES ('one_time', ?, 'pending', ?, ?, 5, 30, ?, NOW(), NOW())`,
    [dueAt, name, JSON.stringify({ type: 'campaign_pump', campaign_id: campaignId }), name]
  );
  return r.insertId;
}

async function ringIfNear(jobId, dueAt) {
  const taskQueue = require('../lib/taskQueue'); // lazy require (convention)
  if (new Date(dueAt).getTime() - Date.now() <= taskQueue.ACCEL_WINDOW_MS) {
    await taskQueue.enqueueJobDispatch(jobId, dueAt);
  }
}


// ─────────────────────────────────────────────────────────────
// CANCEL / PAUSE / RESUME
// ─────────────────────────────────────────────────────────────

/**
 * Cancel a campaign. Sets status to 'canceled' and removes pending jobs
 * (the sends and the pump — both carry the campaign:{id}: name prefix).
 *
 * @param {object} db
 * @param {number} campaignId
 * @returns {{ canceled, jobsRemoved }}
 */
async function cancelCampaign(db, campaignId) {
  const [[campaign]] = await db.query(
    'SELECT status FROM campaigns WHERE campaign_id = ?',
    [campaignId]
  );

  if (!campaign) throw new Error('Campaign not found');

  if (!['draft', 'scheduled', 'sending', 'paused'].includes(campaign.status)) {
    throw new Error(`Cannot cancel campaign with status: ${campaign.status}`);
  }

  await db.query(
    "UPDATE campaigns SET status = 'canceled', updated_at = NOW() WHERE campaign_id = ?",
    [campaignId]
  );

  // Remove pending jobs (already-running or completed jobs are unaffected)
  const [result] = await db.query(
    "DELETE FROM scheduled_jobs WHERE name LIKE ? AND status = 'pending'",
    [`campaign:${campaignId}:%`]
  );

  console.log(`[CAMPAIGN] Canceled campaign ${campaignId}, removed ${result.affectedRows} pending jobs`);

  return { canceled: true, jobsRemoved: result.affectedRows };
}

/** The campaign's status, or a 404 CampaignError. */
async function statusOf(db, campaignId) {
  const [[c]] = await db.query('SELECT status FROM campaigns WHERE campaign_id = ?', [campaignId]);
  if (!c) throw new CampaignError(404, 'not_found', 'Campaign not found');
  return c.status;
}

/**
 * Pause (§6.4): status 'paused' from scheduled / sending, and — in the SAME
 * transaction — every PENDING campaign_send row of the campaign PARKED
 * (scheduled_time + PARK_YEARS): never due, so a paused campaign's overdue
 * rows can never hold the cron's campaign-send quota against other campaigns
 * (the C1 review blocker: 15 paused rows starved a within-cap send for three
 * ticks). Pending stays pending (no active=0 flip, nothing deleted). One
 * transaction, so a crash leaves both writes or neither. A row already
 * claimed (running) is not pending and is not parked: when it runs it finds
 * the campaign paused and defers itself (executeSend's backstop). The pump
 * stops on its next tick.
 */
async function pauseCampaign(db, campaignId) {
  const parked = await db.withTransaction(async (conn) => {
    const [r] = await conn.query(
      "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE campaign_id = ? AND status IN ('scheduled', 'sending')",
      [campaignId]
    );
    if (!r.affectedRows) return null;
    const [p] = await conn.query(
      `UPDATE scheduled_jobs SET scheduled_time = scheduled_time + INTERVAL ${PARK_YEARS} YEAR, updated_at = NOW()
        WHERE name LIKE ? AND status = 'pending' AND scheduled_time < ?`,
      [`campaign:${campaignId}:send:%`, PARKED_AFTER]
    );
    return p.affectedRows;
  }, { retries: 1 });
  if (parked === null) {
    const status = await statusOf(db, campaignId);
    throw new CampaignError(409, 'bad_transition', `Cannot pause a campaign with status: ${status}`);
  }
  console.log(`[CAMPAIGN] Paused campaign ${campaignId} (${parked} pending sends parked)`);
  return { paused: true, parked };
}

/**
 * Resume (§6.4): status back to 'sending' from paused only and — in the SAME
 * transaction — every pending campaign_send row PULLED BACK, re-staggered
 * at the campaign's rate: row i (stragglers first, then the parked rows in
 * their original order) goes to base + i × 60/rate s, base = the later of
 * NOW() and the earliest original time. A running campaign restarts paced
 * from now; one paused before its scheduled start keeps its start. Within-cap
 * campaigns are not paced (interval 0: everything is due at base). Then the pump restarts. Rule: a pump is inserted iff the
 * campaign still has pending / running campaign_send jobs and no pump is
 * already PENDING — whatever its class (a within-cap campaign's sends come
 * back at once instead of five per cron tick). Due at the earliest pending
 * send. A pump still RUNNING its last tick does not block the insert: the
 * older pump retires itself on its next tick (runPump: newest live pump
 * wins). Then checkCompletion — every send may have finished while paused.
 * C2: a marketing campaign whose transport is HELD refuses (422 transport_held).
 */
async function resumeCampaign(db, campaignId) {
  const settings = await readCampaignSettings(db);
  // C2 (§6.5): a marketing campaign does not resume onto a HELD transport —
  // only the SU release lifts the hold (its first send would re-pause anyway).
  const [[mk]] = await db.query(
    `SELECT ec.held_at, ec.held_reason, ec.email FROM campaigns c JOIN email_credentials ec ON ec.email = c.sender
      WHERE c.campaign_id = ? AND c.class = 'marketing' AND c.type = 'email' LIMIT 1`, [campaignId]);
  if (mk && mk.held_at != null) {
    throw new CampaignError(422, 'transport_held',
      `Marketing transport ${mk.email} is held: ${mk.held_reason || 'no reason recorded'}. A superuser release lifts it; then resume.`,
      { held_reason: mk.held_reason || null });
  }
  const resumed = await db.withTransaction(async (conn) => {
    const [r] = await conn.query(
      "UPDATE campaigns SET status = 'sending', updated_at = NOW() WHERE campaign_id = ? AND status = 'paused'",
      [campaignId]
    );
    if (!r.affectedRows) return false;
    const [[c]] = await conn.query('SELECT class, bulk_confirmed_count FROM campaigns WHERE campaign_id = ?', [campaignId]);
    const paced = c && (c.class === 'marketing' || c.bulk_confirmed_count != null);
    const stepUs = paced ? Math.round(60e6 / settings.rate) : 0;
    // o: a parked row's original time; any other pending row (a backstop
    // straggler, a retry backing off) counts as due now. base = the later of
    // NOW() and the earliest o — a campaign paused before its start keeps its
    // start (all its rows were parked), anything already running restarts now.
    await conn.query(
      `UPDATE scheduled_jobs sj
         JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY parked, o, id) - 1 AS rn, GREATEST(NOW(), MIN(o) OVER ()) AS base
                 FROM (SELECT id, scheduled_time >= ? AS parked,
                              IF(scheduled_time >= ?, scheduled_time - INTERVAL ${PARK_YEARS} YEAR, NOW()) AS o
                         FROM scheduled_jobs WHERE name LIKE ? AND status = 'pending') y) x ON x.id = sj.id
          SET sj.scheduled_time = x.base + INTERVAL (x.rn * ?) MICROSECOND, sj.updated_at = NOW()
        WHERE sj.status = 'pending'`,
      [PARKED_AFTER, PARKED_AFTER, `campaign:${campaignId}:send:%`, stepUs]
    );
    return true;
  }, { retries: 1 });
  if (!resumed) {
    const status = await statusOf(db, campaignId);
    throw new CampaignError(409, 'bad_transition', `Cannot resume a campaign with status: ${status}`);
  }
  const [[next]] = await db.query(
    "SELECT MIN(scheduled_time) AS due, COUNT(*) AS n FROM scheduled_jobs WHERE name LIKE ? AND status IN ('pending', 'running')",
    [`campaign:${campaignId}:send:%`]
  );
  let pumpJobId = null;
  if (next && Number(next.n) > 0) {
    const [[pending]] = await db.query(
      "SELECT id FROM scheduled_jobs WHERE idempotency_key = ? AND status = 'pending' LIMIT 1",
      [`campaign:${campaignId}:pump`]
    );
    if (!pending) {
      const due = next.due && new Date(next.due).getTime() > Date.now() ? new Date(next.due) : new Date();
      pumpJobId = await insertPumpJob(db, campaignId, due);
      await ringIfNear(pumpJobId, due);
    }
  }
  await checkCompletion(db, campaignId);
  console.log(`[CAMPAIGN] Resumed campaign ${campaignId}${pumpJobId ? ` (pump ${pumpJobId})` : ''}`);
  return { resumed: true, pumpJobId };
}


// ─────────────────────────────────────────────────────────────
// GET CAMPAIGN (single, with results summary)
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {number} campaignId
 * @returns {object|null} campaign with results summary
 */
async function getCampaign(db, campaignId) {
  const [[campaign]] = await db.query(
    `SELECT c.*, u.user_name AS created_by_name
     FROM campaigns c
     LEFT JOIN users u ON c.created_by = u.user
     WHERE c.campaign_id = ?`,
    [campaignId]
  );

  if (!campaign) return null;

  const [[summary]] = await db.query(
    `SELECT
       COUNT(*)                     AS results_total,
       SUM(status = 'sent')         AS sent,
       SUM(status = 'failed')       AS failed,
       SUM(status = 'skipped')      AS skipped,
       SUM(status = 'sending')      AS sending,
       SUM(status = 'unknown')      AS unknown
     FROM campaign_results WHERE campaign_id = ?`,
    [campaignId]
  );

  campaign.results = {
    sent:    Number(summary.sent    || 0),
    failed:  Number(summary.failed  || 0),
    skipped: Number(summary.skipped || 0),
    // In flight: reserved, provider call not finished (C1 send reservation).
    sending: Number(summary.sending || 0),
    // Ambiguous: the provider may or may not have taken it — never resent.
    unknown: Number(summary.unknown || 0),
    pending: campaign.contact_count - Number(summary.results_total || 0)
  };

  // C4 reporting (§6.5): delivery outcomes + the transport's current rates —
  // marketing email only (operational sends carry no result_id tag, so their
  // delivery columns never populate; zeros there would read as "nothing
  // arrived", which is false).
  if (campaign.class === 'marketing' && campaign.type === 'email') {
    // Set-once timestamps, not delivery_status alone: a complaint OUTRANKS
    // delivered (mailEventService RANK), so a complained row still counts as
    // delivered — the complaint came from a delivered mail. Hard bounces are
    // terminal, so delivery_status is the honest count there.
    const [[d]] = await db.query(
      `SELECT
         SUM(delivered_at IS NOT NULL)            AS delivered,
         SUM(delivery_status = 'bounced_hard')    AS bounced,
         SUM(complained_at IS NOT NULL)           AS complained
       FROM campaign_results WHERE campaign_id = ?`,
      [campaignId]
    );
    // Unsubscribes from the ledger by send_ref (§6.5): every email opt-out
    // whose send_ref names one of this campaign's result rows AND came
    // through an unsubscribe surface — one-click, the /u/ page or the
    // preferences form (unsubService's three sources). The source filter is
    // load-bearing: mail_event_ingest writes provider_bounce /
    // provider_complaint opt-outs with the SAME send_ref, which would count
    // every bounce and complaint as an unsubscribe too (review B1,
    // 2026-11-05). No index on send_ref: one hash-join scan of the ledger
    // per Stats click, fine at today's ledger size. The explicit COLLATE
    // pins the CAST to send_ref's utf8mb4_general_ci — a bare CAST takes the
    // connection default and can refuse the join as an illegal collation mix.
    const [[u]] = await db.query(
      `SELECT COUNT(DISTINCT e.destination) AS unsubscribed
         FROM comm_consent_events e
         JOIN campaign_results cr
           ON e.send_ref = CAST(cr.result_id AS CHAR) COLLATE utf8mb4_general_ci
        WHERE cr.campaign_id = ? AND e.channel = 'email' AND e.action = 'opt_out'
          AND e.source IN ('one_click', 'unsub_page', 'pref_page')`,
      [campaignId]
    );
    campaign.delivery = {
      delivered:    Number(d.delivered    || 0),
      bounced:      Number(d.bounced      || 0),
      complained:   Number(d.complained   || 0),
      unsubscribed: Number(u.unsubscribed || 0),
    };
    // The transport's live 24 h rates + held state (the §6.5 hold) — display
    // only; the gate itself runs in executeSend. Sender row gone → null.
    const [[cred]] = await db.query(
      'SELECT id, held_at, held_reason FROM email_credentials WHERE email = ? LIMIT 1',
      [campaign.sender]
    );
    if (cred) {
      const mailEvents = require('./mailEventService'); // lazy require (convention)
      const health = await mailEvents.transportHealth(db, { credentialId: cred.id });
      campaign.transport = { ...health, held: cred.held_at != null, held_reason: cred.held_at != null ? cred.held_reason : null };
    } else {
      campaign.transport = null;
    }
  }

  return campaign;
}


// ─────────────────────────────────────────────────────────────
// LIST CAMPAIGNS (paginated)
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} opts
 * @param {string} [opts.status]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {{ campaigns, total, page, limit }}
 */
async function listCampaigns(db, { status, page = 1, limit = 20 } = {}) {
  const offset   = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const limitInt = Math.min(100, Math.max(1, parseInt(limit)));

  let query = `
    SELECT c.campaign_id, c.type, c.class, c.topic_key, c.bulk_confirmed_count, c.sender, c.subject, c.status,
           c.scheduled_time, c.contact_count, c.created, c.created_by,
           u.user_name AS created_by_name,
           (SELECT SUM(status = 'sent')    FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS sent_count,
           (SELECT SUM(status = 'failed')  FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS failed_count,
           (SELECT SUM(status = 'skipped') FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS skipped_count,
           (SELECT SUM(status = 'sending') FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS sending_count,
           (SELECT SUM(status = 'unknown') FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS unknown_count
    FROM campaigns c
    LEFT JOIN users u ON c.created_by = u.user
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ' AND c.status = ?';
    params.push(status);
  }

  query += ' ORDER BY c.created DESC LIMIT ? OFFSET ?';
  params.push(limitInt, offset);

  const [campaigns] = await db.query(query, params);

  // Total for pagination
  let countQuery = 'SELECT COUNT(*) AS total FROM campaigns';
  const countParams = [];
  if (status) {
    countQuery += ' WHERE status = ?';
    countParams.push(status);
  }
  const [[{ total }]] = await db.query(countQuery, countParams);

  return { campaigns, total, page: parseInt(page), limit: limitInt };
}


// ─────────────────────────────────────────────────────────────
// GET CAMPAIGN RESULTS (per-contact detail)
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {number} campaignId
 * @returns {object[]} result rows with contact info
 */
async function getCampaignResults(db, campaignId) {
  const [results] = await db.query(
    `SELECT cr.result_id, cr.contact_id, cr.status, cr.error, cr.sent_at, cr.result_meta,
            c.contact_name, c.contact_phone, c.contact_email
     FROM campaign_results cr
     JOIN contacts c ON c.contact_id = cr.contact_id
     WHERE cr.campaign_id = ?
     ORDER BY cr.sent_at`,
    [campaignId]
  );

  return results;
}


// ─────────────────────────────────────────────────────────────
// BODY ESCAPING
// ─────────────────────────────────────────────────────────────

/**
 * The resolver escape mode for a campaign body: an email body is an HTML
 * document, so a substituted value (a contact field — staff- or web-form-
 * supplied) is HTML-escaped and can never become markup; an SMS body is
 * plain text and is substituted verbatim. Anything that is not 'sms' is
 * treated as email (fail closed: escaping text is cosmetic, not escaping
 * HTML is an injection).
 */
function bodyEscapeFor(type) {
  return type === 'sms' ? null : 'html';
}

// ─────────────────────────────────────────────────────────────
// PREVIEW CAMPAIGN
// ─────────────────────────────────────────────────────────────

/**
 * Resolve placeholders against a sample contact for preview.
 *
 * An email body is HTML, so its substituted values are HTML-escaped exactly
 * as executeSend escapes them (the preview shows what will be sent, and a
 * contact field carrying markup stays text). An SMS body and every subject
 * are plain text: no escaping — the client renders them as text.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.body
 * @param {string} [opts.subject]
 * @param {number} opts.contactId  — sample contact to resolve against
 * @param {string} [opts.type]     — 'email' (default) | 'sms'
 * @returns {{ body, subject, unresolved }}
 */
async function previewCampaign(db, { body, subject, contactId, type = 'email' }) {
  const refs = { contacts: { contact_id: contactId } };

  const resolvedBody = await resolve({ db, text: body, refs, escape: bodyEscapeFor(type) });

  let resolvedSubject = null;
  if (subject) {
    resolvedSubject = await resolve({ db, text: subject, refs });
  }

  return {
    body:       resolvedBody.text,
    subject:    resolvedSubject ? resolvedSubject.text : null,
    unresolved: [
      ...(resolvedBody.unresolved || []),
      ...(resolvedSubject?.unresolved || [])
    ]
  };
}


// ─────────────────────────────────────────────────────────────
// SEND RESERVATION (C1 — at most once, every class)
// ─────────────────────────────────────────────────────────────

/**
 * Did the provider possibly ACCEPT the message before this error? (§6.4)
 * true  = AMBIGUOUS: the connection dropped or timed out with no reply, so
 *         the message may have been taken — the reservation becomes
 *         'unknown' and the recipient is never sent to again (a missed
 *         message over a duplicate).
 * false = DEFINITE: the provider answered with a refusal (an SMTP reply code
 *         on err.responseCode, an HTTP status on err.status or in a
 *         "<Provider> API|SMS|MMS <status>:" message), the connection never
 *         opened, the login failed, or the error came from our own code
 *         before any provider call (a T1 fence, a missing credential, a bad
 *         number, a DB read). The reservation is cleared and
 *         isTransientError decides retry vs 'failed' exactly as before.
 * Unrecognized errors are DEFINITE: isTransientError calls them permanent,
 * so a definite unrecognized error is recorded 'failed' and never resent
 * either. Post-acceptance DB writes cannot reach here — the adapters log to
 * email_log / phone_log fire-and-forget.
 */
const DEFINITE_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAUTH', 'ETLS', 'EDNS', 'UND_ERR_CONNECT_TIMEOUT',
]);
const AMBIGUOUS_CODES = new Set([
  'ESOCKET', 'ETIMEDOUT', 'ETIME', 'ECONNRESET', 'EPIPE', 'ECONNECTION', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR',
]);
/** Our own refusals before any provider call (emailService's T1 fences) — definite whatever their message says. */
const DEFINITE_OWN_CODES = new Set([
  'bulk_sender_refused', 'bulk_row_requires_marketing_path', 'bulk_requires_bulk_row',
  'marketing_options_require_bulk', 'marketing_header_refused', 'marketing_reply_to_invalid',
  'marketing_tags_invalid', 'adapter_lacks_capability', 'unknown_events_driver', 'events_driver_requires_bulk',
  'marketing_log_body_refused',
]);
function isAmbiguousSendError(err) {
  if (!err) return false;
  if (typeof err.responseCode === 'number') return false;          // an SMTP reply: refused
  const code0 = err.code == null ? '' : String(err.code);
  // Code first, before any message heuristic: a fence's message can say
  // "timeout", and a MySQL server error (a pre-send credential / line lookup)
  // carries an ER_ / PROTOCOL_ code or a sqlState.
  if (DEFINITE_OWN_CODES.has(code0) || /^(ER_|PROTOCOL_)/.test(code0) || err.sqlState) return false;
  if (typeof err.status === 'number' && err.status >= 400) return false; // an HTTP reply: refused
  if (/\b(?:API|SMS|MMS) [1-5]\d\d:/.test(String(err.message || ''))) return false;
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const codes = [err.code, cause && cause.code].filter(Boolean).map(String);
  if (codes.some((c) => DEFINITE_CONNECT_CODES.has(c))) return false;
  if (codes.some((c) => AMBIGUOUS_CODES.has(c))) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const msg = String(err.message || '');
  if (/\b(timed? ?out|socket hang up|closed unexpectedly|connection (?:reset|closed))\b/i.test(msg)) return true;
  return false;
}

/** result_meta of a row (mysql2 parses JSON columns; a string is tolerated). */
function metaOf(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
}

/**
 * A 'sending' row found by a later attempt: the earlier attempt reserved and
 * then died (crash, kill, recovery) — the provider may have the message.
 * → 'unknown', keeping the old meta (its attempt id) plus a note. Conditional
 * on 'sending' and on that attempt id, so it never clobbers a row the
 * earlier attempt managed to finish.
 */
async function markUnknown(db, campaignId, contactId, prevMeta, note, error = null) {
  const meta = { ...prevMeta, unknown_note: note };
  await db.query(
    `UPDATE campaign_results
        SET status = 'unknown', error = ?, result_meta = ?
      WHERE campaign_id = ? AND contact_id = ? AND status = 'sending'
        AND (JSON_UNQUOTE(JSON_EXTRACT(result_meta, '$.attempt_id')) <=> ?)`,
    [error, JSON.stringify(meta), campaignId, contactId, prevMeta.attempt_id == null ? null : String(prevMeta.attempt_id)]
  );
}


// ─────────────────────────────────────────────────────────────
// MARKETING SEND PATH (C2 — ref/YISRAMAIL_DESIGN.md §4.5, §6.4, §6.5 "As built (C2)")
// ─────────────────────────────────────────────────────────────

/**
 * The ONE footer-slot marker. A body that carries it gets the compliance
 * footer AT the marker (the first one) instead of before </body> — C3's
 * builder places it inside a card layout without touching C2 again. Anything
 * else: before the LAST </body>; no </body> → before </html>; neither →
 * appended. Never after </html>.
 */
const FOOTER_SLOT = '<!-- yc:footer-slot -->';
/**
 * The test send's unsubscribe token: a DEAD placeholder. It fails
 * lib/token.PUBLIC_TOKEN_RE (the '.'), so /u/<it> answers the neutral
 * unknown-token page and a one-click on it records nothing — a test send
 * writes no comm_unsub_tokens row.
 */
const TEST_SEND_TOKEN = 'test.send.no-token';
/** lib/complianceFooter's block marker — the post-render assert looks for it in the final html. */
const FOOTER_MARKER = 'data-yc-compliance-footer="1"';
/** The snapshot's template copy names the token by this placeholder (the per-recipient token is minted at send). */
const SNAPSHOT_TOKEN = '{token}';
/** §6.5 thresholds over transportHealth's 24 h window, decided only when `enough` (≥ 200 delivered). */
const COMPLAINT_WARN_RATE = 0.001;   // > 0.1 % → warning, once per transport per UTC day
const COMPLAINT_HOLD_RATE = 0.003;   // > 0.3 % (the Gmail ceiling) → HOLD
const BOUNCE_HOLD_RATE = 0.05;       // hard bounces > 5 % → HOLD
/** email_credentials.held_reason is varchar(255). */
const HOLD_REASON_MAX = 255;

/**
 * SES's ACCOUNT-LEVEL refusal (account or configuration-set sending paused /
 * suspended) — the provider refuses every message until AWS lifts it, so the
 * transport is held instead of failing each remaining recipient as a 5xx.
 * VERIFY(live): AWS documents the condition ("Account is paused", API
 * exceptions SendingPausedException / AccountSendingPausedException /
 * ConfigurationSetSendingPausedException) but not the SMTP reply text; the
 * SMTP shapes below ("554 Sending paused for this account…", "…suspended…",
 * "…paused for this configuration set") are the community-reported ones. We
 * cannot produce one; widen the pattern from the first real reply.
 */
const ACCOUNT_PAUSE_RE = /\b(?:account is paused|sending (?:is )?paused for (?:this|your) (?:account|configuration set)|sending suspended for (?:this|your) account|AccountSendingPaused(?:Exception)?|ConfigurationSetSendingPaused(?:Exception)?|SendingPausedException)\b/i;
function isAccountPausedError(err) {
  if (!err) return false;
  if (typeof err.responseCode === 'number' && (err.responseCode < 400 || err.responseCode >= 600)) return false;
  const text = [err.response, err.message, err.code, err.name].filter((v) => v != null).map(String).join(' ');
  return ACCOUNT_PAUSE_RE.test(text);
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * ASCII-only lowercase: same LENGTH as the input (String#toLowerCase can grow
 * a string — 'İ' becomes two code units — and shift every index after it).
 */
function asciiLower(s) {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * The next `<name` TAG at or after `from` in an asciiLower'd string (followed
 * by whitespace, '>', '/' or the end), or -1. LINEAR: every indexOf advances.
 */
function findTag(lower, name, from) {
  const open = `<${name}`;
  for (let i = from; ;) {
    i = lower.indexOf(open, i);
    if (i === -1) return -1;
    const c = lower.charCodeAt(i + open.length);
    if (Number.isNaN(c) || c === 62 || c === 47 || c <= 32) return i;
    i += 1;
  }
}

/**
 * The footer's insertion window in a body (asciiLower'd): from the end of the
 * <body …> open tag (no <body>: the end of </head>, else 0) to the closing
 * </body> — but never past </html>: a </body> that comes after </html> is
 * ignored, so the footer can never land after </html>. No closer at all → the
 * end (append).
 */
function bodyBounds(lower) {
  const closeHtml = lower.lastIndexOf('</html');
  const lastBody = lower.lastIndexOf('</body');
  const closeBody = lastBody !== -1 && (closeHtml === -1 || lastBody < closeHtml) ? lastBody : -1;
  const end = closeBody !== -1 ? closeBody : closeHtml !== -1 ? closeHtml : lower.length;
  let start = 0;
  const openBody = findTag(lower, 'body', 0);
  if (openBody !== -1 && openBody < end) {
    const gt = lower.indexOf('>', openBody);
    start = gt === -1 || gt + 1 > end ? end : gt + 1;
  } else {
    const closeHead = lower.lastIndexOf('</head', end);
    if (closeHead !== -1) {
      const gt = lower.indexOf('>', closeHead);
      start = gt === -1 || gt + 1 > end ? end : gt + 1;
    }
  }
  return { start, end };
}

/**
 * The footer html into the body: at the FIRST FOOTER_SLOT inside the body
 * window (a marker in <head> / <title> or after </body> is ignored), else at
 * the window's end (before </body>, else before </html>), else appended.
 * Never after </html>. Linear.
 */
function injectFooter(html, footerHtml) {
  const body = String(html == null ? '' : html);
  const { start, end } = bodyBounds(asciiLower(body));
  const slot = body.indexOf(FOOTER_SLOT, start);
  if (slot !== -1 && slot + FOOTER_SLOT.length <= end) return body.slice(0, slot) + footerHtml + body.slice(slot + FOOTER_SLOT.length);
  if (end < body.length) return body.slice(0, end) + footerHtml + '\n' + body.slice(end);
  return body + '\n' + footerHtml;
}

/** Comments removed; an unclosed `<!--` swallows the rest (as a browser does). Linear. */
function stripComments(s) {
  let out = '';
  for (let i = 0; ;) {
    const j = s.indexOf('<!--', i);
    if (j === -1) return out + s.slice(i);
    out += s.slice(i, j);
    const k = s.indexOf('-->', j + 4);
    if (k === -1) return out;
    i = k + 3;
  }
}

/** Every <name …>…</name> element removed; an unclosed one swallows the rest. Linear per name. */
function stripElements(s, names) {
  for (const name of names) {
    const lower = asciiLower(s);
    let out = '';
    let i = 0;
    for (;;) {
      const j = findTag(lower, name, i);
      if (j === -1) { out += s.slice(i); break; }
      out += s.slice(i, j);
      const c = findTag(lower, `/${name}`, j + 1);
      if (c === -1) break;
      const gt = lower.indexOf('>', c);
      i = gt === -1 ? s.length : gt + 1;
    }
    s = out;
  }
  return s;
}

/** Tags stripped; an unclosed `<` and what follows stay as text. Linear. */
function stripTags(s) {
  let out = '';
  for (let i = 0; ;) {
    const j = s.indexOf('<', i);
    if (j === -1) return out + s.slice(i);
    const k = s.indexOf('>', j + 1);
    if (k === -1) return out + s.slice(i);
    out += s.slice(i, j);
    i = k + 1;
  }
}

/** The FIRST href="…" / href='…' attribute of one open tag, or null (an unclosed quote → null). Linear. */
function hrefOf(tag) {
  const lower = asciiLower(tag);
  for (let k = lower.indexOf('href'); k !== -1; k = lower.indexOf('href', k + 4)) {
    const before = lower.charCodeAt(k - 1);
    if (!(before <= 32)) continue;
    let p = k + 4;
    while (p < tag.length && tag.charCodeAt(p) <= 32) p++;
    if (tag[p] !== '=') continue;
    p++;
    while (p < tag.length && tag.charCodeAt(p) <= 32) p++;
    const q = tag[p];
    if (q !== '"' && q !== "'") return null;
    const e = tag.indexOf(q, p + 1);
    return e === -1 ? null : tag.slice(p + 1, e);
  }
  return null;
}

/** <a href>…</a> → "label (url)" / the bare url; a non-http(s)/mailto href keeps only the label. Linear. */
function linkify(s) {
  const lower = asciiLower(s);
  let out = '';
  for (let i = 0; ;) {
    const j = findTag(lower, 'a', i);
    if (j === -1) return out + s.slice(i);
    const gt = s.indexOf('>', j);
    if (gt === -1) return out + s.slice(i);
    const close = findTag(lower, '/a', gt + 1);
    if (close === -1) return out + s.slice(i);
    const closeGt = s.indexOf('>', close);
    const inner = s.slice(gt + 1, close);
    const raw = hrefOf(s.slice(j, gt));
    const href = raw == null ? null : raw.trim();
    out += s.slice(i, j);
    if (href && /^(?:https?:|mailto:)/i.test(href)) {
      const label = stripTags(inner).trim();
      out += !label || label === href ? ` ${href} ` : `${inner} (${href})`;
    } else {
      out += inner;
    }
    i = closeGt === -1 ? s.length : closeGt + 1;
  }
}

/** Trailing spaces / tabs off each line — a loop, not /[ \t]+$/ (quadratic on a long run). */
function trimLineEnds(s) {
  return s.split('\n').map((l) => {
    let e = l.length;
    while (e > 0 && (l.charCodeAt(e - 1) === 32 || l.charCodeAt(e - 1) === 9)) e--;
    return l.slice(0, e);
  }).join('\n');
}

/**
 * The marketing text part of an html body. A link keeps its URL visible
 * ("label (url)", the bare url when the label IS the url); comments and
 * <head> / <style> / <script> / <title> content never leak in as text; line
 * breaks for <br>, </p>, </li>; tags stripped; named and numeric entities
 * decoded. EVERY step is linear (CLAUDE.md: a body any staff member authors
 * runs here per recipient and inside the test-send request) — scans are
 * indexOf loops, the few regexes have no nested or overlapping quantifier.
 * tests/campaignC2.test.js pins the worst cases with a timing bound. The
 * footer's own text part is appended by the caller.
 */
function textPartFor(html) {
  let s = String(html == null ? '' : html);
  s = stripComments(s);
  s = stripElements(s, ['head', 'style', 'script', 'title']);
  s = linkify(s);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n').replace(/<\/li\s*>/gi, '\n');
  s = stripTags(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (m, d) => { const n = Number(d); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; })
    .replace(/&amp;/gi, '&');
  return trimLineEnds(s).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * List-Id (RFC 2919): <topic.sender-domain>, e.g. <newsletter.news.4lsg.com> —
 * stable per topic and transport, '_' in a topic key becomes '-'.
 */
function listIdFor(topicKey, senderEmail) {
  const domain = String(senderEmail || '').split('@').pop().toLowerCase();
  if (!TOPIC_RE.test(String(topicKey || '')) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) {
    throw new Error(`listIdFor: cannot build a List-Id from topic "${String(topicKey).slice(0, 40)}" and sender "${String(senderEmail).slice(0, 80)}"`);
  }
  return `<${String(topicKey).replace(/_/g, '-')}.${domain}>`;
}

/** The three marketing headers (T1's allowlist). */
function marketingHeaders(unsubscribeUrl, listId) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-Id': listId,
  };
}

/**
 * The POST-RENDER ASSERT (§4.5, fail closed) — on the FINAL html and text,
 * where the property has to hold: the html carries the footer block and the
 * unsubscribe URL as an href; the text carries the footer text and the URL.
 * → null when it holds, else what is missing.
 */
function footerHoles({ html, text, footer, unsubscribeUrl }) {
  const holes = [];
  if (!footer || typeof footer.html !== 'string' || typeof footer.text !== 'string') return ['the footer block'];
  // The builder's own marker must be in the html, and never after </html> —
  // independent of whatever footer object reached here.
  const at = String(html).indexOf(FOOTER_MARKER);
  if (at === -1) holes.push('html: footer marker');
  else {
    const closeHtml = asciiLower(String(html)).lastIndexOf('</html');
    if (closeHtml !== -1 && at > closeHtml) holes.push('html: footer after </html>');
  }
  if (!String(html).includes(footer.html)) holes.push('html: footer block');
  if (!String(html).includes(`href="${escAttr(unsubscribeUrl)}"`)) holes.push('html: unsubscribe href');
  if (!String(text).includes(footer.text)) holes.push('text: footer block');
  if (!String(text).includes(unsubscribeUrl)) holes.push('text: unsubscribe URL');
  return holes.length ? holes : null;
}

/** The marketing Reply-To: marketing_reply_to, else firm_email, else none (replies reach the sender address). */
function marketingReplyTo() {
  const { cfg } = require('../lib/firmConfig'); // lazy require (convention)
  const norm = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  return norm(cfg('marketing_reply_to')) || norm(cfg('firm_email'));
}

/** comm_topics row of a marketing topic → { topic_key, label, consent_model, active } | null. */
async function topicRow(db, topicKey) {
  const [[t]] = await db.query('SELECT topic_key, label, consent_model, active, channel FROM comm_topics WHERE topic_key = ?', [topicKey]);
  return t || null;
}

/**
 * Render one marketing email (the campaign send AND the test send — one path).
 *   body / subject     the campaign's (unresolved) copy
 *   contactId          resolver refs.contacts
 *   unsubscribeUrl / preferencesUrl   the token's URLs (the test send: TEST_SEND_TOKEN's)
 *   topic              { topic_key, label, consent_model } the footer states
 *   firm               the send-start snapshot (C2) — refs.firm AND the footer's values
 * → { status: 'ok', html, text, subject, footer }
 *   | { status: 'unresolved', detail }        (a placeholder did not resolve — permanent)
 *   | { status: 'footer_missing', detail }    (the builder threw, or the assert found a hole)
 * A resolver DB error throws (the caller decides retry).
 */
async function renderMarketing(db, { body, subject, contactId, unsubscribeUrl, preferencesUrl, topic, firm }) {
  const refs = {
    contacts: { contact_id: contactId },
    send: { unsubscribe_url: unsubscribeUrl, preferences_url: preferencesUrl, topic_key: topic.topic_key, topic_label: topic.label },
    firm,
  };
  const rb = await resolve({ db, text: body, refs, strict: true, escape: 'html' });
  if (rb.status !== 'success') {
    return { status: 'unresolved', detail: rb.unresolved?.length ? `Unresolved placeholders: ${rb.unresolved.join(', ')}` : (rb.errors?.join('; ') || 'Body placeholder resolution failed') };
  }
  const rs = await resolve({ db, text: subject || '', refs, strict: true });
  if (rs.status !== 'success') {
    return { status: 'unresolved', detail: rs.unresolved?.length ? `Unresolved placeholders in subject: ${rs.unresolved.join(', ')}` : (rs.errors?.join('; ') || 'Subject placeholder resolution failed') };
  }
  let footer;
  try {
    footer = complianceFooter.buildComplianceFooter({ unsubscribeUrl, preferencesUrl, topic, firm });
  } catch (err) {
    return { status: 'footer_missing', detail: String(err.message || err) };
  }
  const html = injectFooter(rb.text, footer.html);
  const text = `${textPartFor(rb.text)}\n\n${footer.text}`;
  const holes = footerHoles({ html, text, footer, unsubscribeUrl });
  if (holes) return { status: 'footer_missing', detail: `post-render check failed: ${holes.join('; ')}` };
  return { status: 'ok', html, text, subject: rs.text, footer };
}

function parseSnapshot(v) {
  if (v == null) return null;
  const o = typeof v === 'object' ? v : (() => { try { return JSON.parse(v); } catch (_) { return null; } })();
  return o && typeof o === 'object' && o.firm && o.topic ? o : null;
}

/**
 * The campaign's SEND-START SNAPSHOT (MRPC 7.2(b): ≥ 2 years, what was sent
 * with the footer as it stood at send start) — campaigns.send_snapshot, written
 * ONCE (the first marketing send to reach here; a concurrent first send loses
 * the conditional UPDATE and both read the winner back). Every recipient
 * renders from it: refs.firm and the footer's values, the topic the footer
 * states, the Reply-To, the List-Id — so a settings edit mid-send cannot
 * split the campaign. Holds the template copy too: the body with the footer
 * injected (token = SNAPSHOT_TOKEN), its text part, the subject.
 * A firm hole (the builder throws) → { error } and nothing is written: the
 * recipient is recorded failed (footer_missing); the next send tries again.
 * → { snapshot } | { error }
 */
async function ensureSendSnapshot(db, campaign) {
  const have = parseSnapshot(campaign.send_snapshot);
  if (have) return { snapshot: have };
  const { firmValues } = complianceFooter;
  const { urlFor, preferencesUrlFor } = require('./unsubService'); // lazy require (convention)
  const t = await topicRow(db, campaign.topic_key);
  if (!t) return { error: `topic "${campaign.topic_key}" does not exist` };
  const topic = { topic_key: String(t.topic_key), label: String(t.label), consent_model: String(t.consent_model) };
  const firm = firmValues();
  let footer;
  try {
    footer = complianceFooter.buildComplianceFooter({ unsubscribeUrl: urlFor(SNAPSHOT_TOKEN), preferencesUrl: preferencesUrlFor(SNAPSHOT_TOKEN), topic, firm });
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const snap = {
    v: 1,
    taken_at: new Date().toISOString(),
    firm,
    topic,
    reply_to: marketingReplyTo(),
    list_id: listIdFor(campaign.topic_key, campaign.sender),
    sender: campaign.sender,
    subject: campaign.subject,
    html: injectFooter(campaign.body, footer.html),
    text: `${textPartFor(campaign.body)}\n\n${footer.text}`,
    token_placeholder: SNAPSHOT_TOKEN,
  };
  await db.query('UPDATE campaigns SET send_snapshot = ? WHERE campaign_id = ? AND send_snapshot IS NULL',
    [JSON.stringify(snap), campaign.campaign_id]);
  const [[row]] = await db.query('SELECT send_snapshot FROM campaigns WHERE campaign_id = ?', [campaign.campaign_id]);
  const stored = parseSnapshot(row && row.send_snapshot);
  if (!stored) throw new Error(`campaign ${campaign.campaign_id}: send_snapshot did not store`);
  return { snapshot: stored };
}

function utcDay() { return new Date().toISOString().slice(0, 10); }

function alertQuietly(db, o) {
  try {
    const { alert } = require('../lib/alerting'); // lazy require (convention)
    return Promise.resolve(alert(db, { source: 'mail', ...o })).catch((e) => console.error('[CAMPAIGN] alert failed:', e.message));
  } catch (e) { return Promise.resolve(); }
}

/** The `error` alert a held transport raises — ONE per transport per UTC day (dedup key). */
function heldAlert(db, row, reason, heldAt = null) {
  // Once per HOLD per UTC day: keyed on the hold's held_at too, so a re-hold
  // after a same-day release raises its own alert.
  const stamp = heldAt ? new Date(heldAt).toISOString() : 'held';
  return alertQuietly(db, {
    kind: 'mail_transport_held', group_key: `mail_transport_held:${row.id}`, severity: 'error',
    dedup_key: `mail_transport_held:${row.id}:${stamp}:${utcDay()}`,
    title: `Marketing email transport ${row.id} (${row.email}) is HELD`,
    message: `Marketing sends on ${row.email} are stopped: ${reason}. Its running marketing campaigns are paused and new ones are refused. `
      + `Only a superuser lifts the hold, through the API — POST /api/campaigns/transports/${row.id}/release (superuser + step-up; there is no button) — `
      + 'after fixing the cause; then resume the paused campaigns one by one (ref/YISRAMAIL_DESIGN.md §6.5).',
  });
}

/**
 * Pause every running (scheduled / sending) MARKETING campaign on a transport
 * (C1's pauseCampaign — the pending sends are parked). → the paused ids.
 */
async function pauseMarketingOnTransport(db, senderEmail) {
  const [rows] = await db.query(
    "SELECT campaign_id FROM campaigns WHERE class = 'marketing' AND sender = ? AND status IN ('scheduled', 'sending') ORDER BY campaign_id",
    [senderEmail]);
  const paused = [];
  for (const r of rows || []) {
    try {
      await pauseCampaign(db, r.campaign_id);
      paused.push(Number(r.campaign_id));
    } catch (err) {
      if (!(err && err.name === 'CampaignError' && err.status === 409)) throw err;   // finished / paused meanwhile
    }
  }
  return paused;
}

/**
 * SET the hold on a transport (§6.5): email_credentials.held_at / held_reason
 * (first setter wins — the reason of the first trip stays), then every running
 * marketing campaign on it is paused and the error alert raised (once a day).
 * No auto-release: only releaseTransport lifts it. → { held, paused }
 */
async function holdTransport(db, row, reason) {
  const why = String(reason).slice(0, HOLD_REASON_MAX);
  const [r] = await db.query(
    'UPDATE email_credentials SET held_at = UTC_TIMESTAMP(), held_reason = ? WHERE id = ? AND held_at IS NULL',
    [why, row.id]);
  const paused = await pauseMarketingOnTransport(db, row.email);
  console.error(`[CAMPAIGN] transport ${row.id} (${row.email}) ${r && r.affectedRows ? 'HELD' : 'already held'}: ${why}; paused ${paused.length ? paused.join(', ') : 'none'}`);
  const [[now]] = await db.query('SELECT held_at, held_reason FROM email_credentials WHERE id = ?', [row.id]);
  await heldAlert(db, row, (now && now.held_reason) || why, now && now.held_at);
  return { held: !!(r && r.affectedRows), paused };
}

/**
 * The transport health gate before a marketing send (§6.5) over
 * mailEventService.transportHealth's 24 h window, rates decided only when
 * `enough`: complaint rate > 0.3 % or hard-bounce rate > 5 % → the hold
 * reason; > 0.1 % → a warning (once per transport per day) and the send goes.
 * → the hold reason, or null.
 */
async function transportHealthGate(db, row) {
  const { transportHealth } = require('./mailEventService'); // lazy require (convention)
  const h = await transportHealth(db, { credentialId: row.id });
  if (!h.enough) return null;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  if (h.complaint_rate != null && h.complaint_rate > COMPLAINT_HOLD_RATE) {
    return `complaint rate ${pct(h.complaint_rate)} over the last ${h.window_h} h (${h.complained} of ${h.delivered} delivered) is above the 0.3% limit`;
  }
  if (h.bounce_rate != null && h.bounce_rate > BOUNCE_HOLD_RATE) {
    return `hard-bounce rate ${pct(h.bounce_rate)} over the last ${h.window_h} h (${h.bounced_hard} hard bounces, ${h.delivered} delivered) is above the 5% limit`;
  }
  if (h.complaint_rate != null && h.complaint_rate > COMPLAINT_WARN_RATE) {
    await alertQuietly(db, {
      kind: 'mail_complaint_rate', group_key: `mail_complaint_rate:${row.id}`, severity: 'warning',
      dedup_key: `mail_complaint_rate:${row.id}:${utcDay()}`,
      title: `Complaint rate ${pct(h.complaint_rate)} on marketing transport ${row.id} (${row.email})`,
      message: `Over the last ${h.window_h} h: ${h.complained} complaint(s), ${h.delivered} delivered — above 0.1%. `
        + 'At 0.3% the transport is held and every marketing campaign on it pauses (ref/YISRAMAIL_DESIGN.md §6.5).',
    });
  }
  return null;
}

/**
 * The SU release of a held transport (§6.5) — audited, in one transaction
 * with the write (a release exists iff its admin_audit_log row does), then an
 * `info` alert. Paused campaigns stay paused: staff resume each one.
 * 404 unknown transport, 409 not held. → { released, credential_id, held_at, held_reason }
 */
async function releaseTransport(db, credentialId, { auth = null, request = null } = {}) {
  const id = Number(credentialId);
  if (!Number.isSafeInteger(id) || id < 1) throw new CampaignError(400, 'bad_id', 'transport id must be a positive integer');
  const out = await db.withTransaction(async (conn) => {
    const [[row]] = await conn.query('SELECT id, email, held_at, held_reason FROM email_credentials WHERE id = ? FOR UPDATE', [id]);
    if (!row) throw new CampaignError(404, 'not_found', 'Email transport not found');
    if (row.held_at == null) throw new CampaignError(409, 'not_held', `Transport ${id} (${row.email}) is not held`);
    await conn.query('UPDATE email_credentials SET held_at = NULL, held_reason = NULL WHERE id = ?', [id]);
    const { auditAdminAction } = require('../lib/auth.superuser'); // lazy require (convention)
    await auditAdminAction(conn, {
      tool: RELEASE_TOOL,
      userId: auth?.userId ?? null,
      username: auth?.username ?? null,
      route: request?.route || `POST /api/campaigns/transports/${id}/release`,
      method: request?.method || 'POST',
      status: 'success',
      ip: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
      details: { credential_id: id, email: row.email, held_at: row.held_at, held_reason: row.held_reason },
    });
    return { email: row.email, held_at: row.held_at, held_reason: row.held_reason };
  }, { retries: 0 });
  await alertQuietly(db, {
    kind: 'mail_transport_released', group_key: `mail_transport_held:${id}`, severity: 'info',
    title: `Marketing email transport ${id} (${out.email}) released by ${auth?.username || 'a superuser'}`,
    message: `The hold (${out.held_reason || 'no reason recorded'}) is lifted. Campaigns it paused stay paused until resumed one by one.`,
  });
  return { released: true, credential_id: id, held_at: out.held_at, held_reason: out.held_reason };
}
/** admin_audit_log.tool of the release (and the superuserOnlyFor tool name). */
const RELEASE_TOOL = 'mail_transport_release';

/**
 * "Send a test to me" (§6.4): the marketing render against a chosen contact,
 * `[TEST] ` before the subject, through the SAME transport, headers and
 * Reply-To as a campaign send — to the caller's own users.email. No token
 * (TEST_SEND_TOKEN, a dead placeholder), no campaign, no campaign_results
 * row, the email_log body kept (not a broadcast), live firm values (no
 * snapshot — nothing has started). Works while marketing_send_enabled is off
 * (staff-to-self, so the footer and headers can be checked before G1); needs
 * campaigns.bulk; refused on a held transport.
 * → { sent: true, to, messageId, providerMessageId }
 */
async function testSendMarketing(db, { auth = null, sender, subject, body, topicKey, contactId, attachmentUrl = null } = {}) {
  if (!can(auth, 'campaigns.bulk')) throw new CampaignError(403, 'bulk_capability_required', 'A marketing test send needs the campaigns.bulk capability (admin role).');
  const userId = Number(auth && auth.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new CampaignError(400, 'test_send_needs_user', 'A test send goes to the signed-in staff member — a staff login is required.');
  if (!sender || !subject || !body) throw new CampaignError(400, 'missing_fields', 'sender, subject and body are required');
  const cid = Number(contactId);
  if (!Number.isSafeInteger(cid) || cid < 1) throw new CampaignError(400, 'contact_required', 'Choose the contact to render the test for.');
  if (attachmentUrl != null && attachmentUrl !== '') assertHttpsAttachment(attachmentUrl);
  await assertMarketingTopic(db, topicKey);
  const [[row]] = await db.query('SELECT * FROM email_credentials WHERE email = ? LIMIT 1', [sender]);
  if (!row) throw new CampaignError(400, 'unknown_sender', `Email sender ${sender} is not a configured sender`);
  if (!emailService.isBulkRow(row)) throw new CampaignError(400, 'marketing_requires_bulk_sender', `Marketing email sends only from a marketing transport — ${sender} is not one.`);
  if (row.held_at != null) throw new CampaignError(422, 'transport_held', `Transport ${sender} is held: ${row.held_reason || 'no reason recorded'}. A superuser release lifts it.`, { held_reason: row.held_reason || null });
  const [[me]] = await db.query('SELECT email FROM users WHERE user = ?', [userId]);
  const to = me && me.email ? String(me.email).trim() : '';
  if (!to) throw new CampaignError(400, 'no_user_email', 'Your user record has no email address to send the test to.');
  const [[contact]] = await db.query('SELECT contact_id FROM contacts WHERE contact_id = ?', [cid]);
  if (!contact) throw new CampaignError(404, 'contact_not_found', 'Contact not found');

  const { firmValues } = complianceFooter;
  const { urlFor, preferencesUrlFor } = require('./unsubService'); // lazy require (convention)
  const t = await topicRow(db, topicKey);
  const topic = { topic_key: String(t.topic_key), label: String(t.label), consent_model: String(t.consent_model) };
  const unsubscribeUrl = urlFor(TEST_SEND_TOKEN);
  const r = await renderMarketing(db, {
    body, subject, contactId: cid, unsubscribeUrl, preferencesUrl: preferencesUrlFor(TEST_SEND_TOKEN), topic, firm: firmValues(),
  });
  if (r.status === 'unresolved') throw new CampaignError(400, 'body_unresolved', r.detail);
  if (r.status !== 'ok') throw new CampaignError(422, 'footer_missing', r.detail);
  const replyTo = marketingReplyTo();
  const opts = {
    from: sender, to, subject: `[TEST] ${r.subject}`, html: r.html, text: r.text,
    bulk: true, headers: marketingHeaders(unsubscribeUrl, listIdFor(topicKey, sender)),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
  if (attachmentUrl) opts.attachment_urls = attachmentUrl;   // once (see executeSend); https-checked above
  let res;
  try {
    res = await emailService.sendEmailDirect(db, row, opts);
  } catch (err) {
    throw new CampaignError(502, 'send_failed', `The test send failed: ${String(err.message || err).slice(0, 500)}`);
  }
  return { sent: true, to, messageId: res?.messageId || null, providerMessageId: res?.providerMessageId || null };
}


/**
 * A TRIGGERED promotional send (C7): ONE recipient, NO campaign row — the
 * second kind of campaign email (Fred, 2026-11-05: "send now to many" vs
 * "send to people as something triggers it"). Driven by a workflow/sequence
 * send_email step with promotional:true; same compliance plumbing as a
 * campaign send: the kill switch (not '1' → 422 marketing_disabled — a
 * promotional automation with marketing off is a configuration error, not a
 * silent skip), consent by topic (opted out → { sent:false,
 * skipped:'opted_out' }, the C7 contract: skip, never fail), a REAL unsub
 * token (campaign_id NULL — the reuse path needs a campaign, so each send
 * mints fresh), renderMarketing (live firm values — no snapshot, single
 * send) + footer + post-render assert, marketing headers + Reply-To, bulk
 * transport only, held transport refused 422.
 *
 * Deliberately NOT here (triggered volume is a handful a day — ref/plans.md
 * "triggered-send reporting"):
 *   - no campaign_results row: no reservation / at-most-once (the engine's
 *     step retry policy owns retries), no delivery correlation (a bounce
 *     still suppresses — mail_event_ingest records the ledger event
 *     uncorrelated), invisible to transportHealth rates and the digest;
 *   - no rate window (it counts campaign_results, which this never writes)
 *     and no transportHealthGate (its rates come from campaign traffic);
 *   - email_log KEEPS the body: there is no campaign snapshot, so the log is
 *     the MRPC 7.2(b) record of what went out.
 *
 * sender: a bulk row's address; null → the ONLY bulk row (refused when none
 * or several — never a silent pick among transports).
 * → { sent:true, to, messageId, providerMessageId }
 *   | { sent:false, skipped:'opted_out' }
 */
async function sendPromotional(db, { sender = null, to, subject, body, topicKey, contactId, attachmentUrls = null, attachmentNames = null } = {}) {
  const dest = typeof to === 'string' ? to.trim() : '';
  if (!dest) throw new CampaignError(400, 'missing_fields', 'to is required');
  if (!subject || !body) throw new CampaignError(400, 'missing_fields', 'subject and body are required');
  const cid = Number(contactId);
  if (!Number.isSafeInteger(cid) || cid < 1) throw new CampaignError(400, 'contact_required', 'A promotional send needs contact_id — merge tags and the unsubscribe token resolve against it.');
  await assertMarketingTopic(db, topicKey);

  const settings = await readCampaignSettings(db);
  if (!settings.marketingEnabled) {
    throw new CampaignError(422, 'marketing_disabled', 'Marketing sends are switched off (marketing_send_enabled is not 1) — a promotional automation send is a marketing send.');
  }

  let row;
  if (sender != null && sender !== '') {
    [[row]] = await db.query('SELECT * FROM email_credentials WHERE email = ? LIMIT 1', [sender]);
    if (!row) throw new CampaignError(400, 'unknown_sender', `Email sender ${sender} is not a configured sender`);
    if (!emailService.isBulkRow(row)) throw new CampaignError(400, 'marketing_requires_bulk_sender', `A promotional send goes out only from a marketing transport — ${sender} is not one.`);
  } else {
    const [rows] = await db.query('SELECT * FROM email_credentials WHERE bulk_ok = 1');
    if (rows.length !== 1) {
      throw new CampaignError(400, rows.length ? 'ambiguous_sender' : 'no_bulk_sender',
        rows.length ? `There are ${rows.length} marketing transports — name one in marketing_sender.` : 'No marketing transport (bulk_ok sender) is configured.');
    }
    row = rows[0];
  }
  if (row.held_at != null) throw new CampaignError(422, 'transport_held', `Transport ${row.email} is held: ${row.held_reason || 'no reason recorded'}. A superuser release lifts it.`, { held_reason: row.held_reason || null });

  const [[contact]] = await db.query('SELECT contact_id FROM contacts WHERE contact_id = ?', [cid]);
  if (!contact) throw new CampaignError(404, 'contact_not_found', `Contact ${cid} not found`);
  if (attachmentUrls != null && attachmentUrls !== '') {
    for (const u of Array.isArray(attachmentUrls) ? attachmentUrls : [attachmentUrls]) {
      assertHttpsAttachment(typeof u === 'object' && u ? u.url : u);
    }
  }

  // The C7 contract: an opted-out recipient is SKIPPED, never a failure —
  // the workflow goes on (a birthday sweep must not die on one opt-out).
  const hits = await optout.findOptedOut(db, 'email', [dest], { klass: 'marketing', topic: topicKey });
  if (hits.length) return { sent: false, skipped: 'opted_out' };

  const unsub = require('./unsubService'); // lazy require (convention)
  const { token } = await unsub.mintOrReuseUnsubToken(db, {
    destination: dest, topicKey, campaignId: null, contactId: cid, sendRef: null,
  });
  const unsubscribeUrl = unsub.urlFor(token);
  const t = await topicRow(db, topicKey);
  const topic = { topic_key: String(t.topic_key), label: String(t.label), consent_model: String(t.consent_model) };
  const r = await renderMarketing(db, {
    body, subject, contactId: cid, unsubscribeUrl, preferencesUrl: unsub.preferencesUrlFor(token),
    topic, firm: complianceFooter.firmValues(),
  });
  if (r.status === 'unresolved') throw new CampaignError(400, 'body_unresolved', r.detail);
  if (r.status !== 'ok') throw new CampaignError(422, 'footer_missing', r.detail);

  const replyTo = marketingReplyTo();
  const opts = {
    from: row.email, to: dest, subject: r.subject, html: r.html, text: r.text,
    bulk: true, headers: marketingHeaders(unsubscribeUrl, listIdFor(topicKey, row.email)),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(attachmentUrls ? { attachment_urls: attachmentUrls } : {}),
    ...(attachmentNames ? { attachment_names: attachmentNames } : {}),
  };
  let res;
  try {
    res = await emailService.sendEmailDirect(db, row, opts);
  } catch (sendErr) {
    // The provider refused at the ACCOUNT level (§6.4): hold the transport —
    // every campaign on it pauses at its next send — then fail THIS step (the
    // engine's error policy owns retries; the default is no retry). Mirrors
    // executeSend's classification: an ambiguous error (no reply) is NOT a
    // pause signal, and the send may have gone out — never auto-resend
    // (promotional steps should carry no retry policy; the manual says so).
    if (!isAmbiguousSendError(sendErr) && isAccountPausedError(sendErr)) {
      await holdTransport(db, row, `the provider refused at the account level: ${String(sendErr.response || sendErr.message || '').slice(0, 180)}`);
      throw new CampaignError(502, 'account_paused', `The provider paused the account — transport ${row.email} is held, every marketing campaign on it pauses, and this send did NOT go out: ${String(sendErr.message || '').slice(0, 300)}`);
    }
    throw sendErr;
  }
  return { sent: true, to: dest, messageId: res?.messageId || null, providerMessageId: res?.providerMessageId || null };
}

/** Delete THIS attempt's 'sending' row (nothing reached the provider). */
async function clearReservation(db, campaignId, contactId, attemptId) {
  await db.query(
    `DELETE FROM campaign_results
      WHERE campaign_id = ? AND contact_id = ? AND status = 'sending'
        AND JSON_UNQUOTE(JSON_EXTRACT(result_meta, '$.attempt_id')) = ?`,
    [campaignId, contactId, attemptId]
  );
}

/** Finalize THIS attempt's 'sending' row as 'failed' — a permanent outcome with no provider call (C2: render / footer). */
async function failReservation(db, campaignId, contactId, attemptId, error, meta) {
  await db.query(
    `UPDATE campaign_results SET status = 'failed', error = ?, result_meta = ?
      WHERE campaign_id = ? AND contact_id = ? AND status = 'sending'
        AND JSON_UNQUOTE(JSON_EXTRACT(result_meta, '$.attempt_id')) = ?`,
    [error, JSON.stringify({ attempt_id: attemptId, ...meta }), campaignId, contactId, attemptId]
  );
}

// ─────────────────────────────────────────────────────────────
// EXECUTE SEND (called by job_executor for each contact)
// ─────────────────────────────────────────────────────────────

/**
 * Core send logic for one contact in a campaign.
 * Called by job_executor when processing a campaign_send job.
 *
 * Order (C1):
 *   1. load the campaign
 *   2. this contact's result row — terminal (sent/failed/skipped/unknown) →
 *      a replay: touch nothing; 'sending' → an earlier attempt reserved and
 *      died: 'unknown', never resend
 *   3. campaign status (§6.4): paused → DEFER (nothing recorded, no attempt);
 *      canceled → skipped; sent/failed/partial_fail → skipped (a straggler;
 *      recorded only when no row exists); scheduled / sending → proceed
 *   4. class marketing: the kill switch (setting not exactly '1' → skipped
 *      marketing_disabled); switch on → the C2 path below
 *   5. contact, consent (consentOptsFor: operational email asks nothing, D18;
 *      marketing asks scope marketing + the topic — an opt_in topic needs
 *      opted_in), channel info, placeholders (marketing: resolved at 7a)
 *   6. a bulk_ok sender (marketing, or over-cap operational). MARKETING
 *      first: the transport HOLD (held, or the §6.5 thresholds trip it) →
 *      pause the campaign + DEFER (nothing recorded); the send-start snapshot
 *      (a firm hole → failed footer_missing). Then the per-transport rate
 *      window (≥ rate sends in the last 60 s → DEFER 2–8 s, no attempt)
 *   7. RESERVE (insert the row as 'sending' with an attempt id)
 *   7a. marketing: mint (or re-use) the unsub token, send_ref = the row's id;
 *      render from the snapshot + the footer + the post-render assert (a hole
 *      → this reservation 'failed' footer_missing, no provider call); flip a
 *      scheduled campaign to sending
 *   8. send (marketing: text part, footer, List-Unsubscribe / -Post / List-Id,
 *      Reply-To, tags, log_body:false); an account-level SES refusal → the
 *      transport held, the recipient back to pending; ambiguous provider error
 *      → 'unknown'; definite → reservation cleared, then the classification below
 *   9. 'sent' + provider_message_id; checkCompletion
 *
 * Error handling (unchanged in shape):
 *   - Skips → record + return normally. Never retried.
 *   - Permanent send errors → record 'failed' + return normally.
 *   - Transient send/infra errors → THROW so the job system retries with
 *     backoff. On the FINAL attempt, transient is treated as permanent.
 *   A deferral returns { deferred: true, retryAtMs, reason } — job_executor
 *   turns it into a job deferral (no attempt consumed).
 *
 * @param {object} db
 * @param {number} campaignId
 * @param {number} contactId
 * @param {object} [jobMeta]
 * @param {number} [jobMeta.attempt=1]      — 1-indexed current attempt
 * @param {number} [jobMeta.maxAttempts=1]  — total attempts allowed
 * @param {number|string} [jobMeta.jobId]   — scheduled_jobs.id (the reservation's attempt id)
 * @returns {object} { sent, skipped, failed, unknown, deferred, replay, reason, messageId }
 */
async function executeSend(db, campaignId, contactId, jobMeta = {}) {
  const { attempt = 1, maxAttempts = 1, jobId = null } = jobMeta;
  const isFinalAttempt = attempt >= maxAttempts;
  // held: this attempt's 'sending' row exists and has not been resolved (sent
  // update / clearing DELETE not yet done) — the outer catch's last resort.
  const reservation = { held: false };
  const attemptId = `${jobId == null ? `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : jobId}:${attempt}`;

  try {
    // ── 1. Load campaign ──

    const [[campaign]] = await db.query(
      'SELECT campaign_id, type, class, topic_key, bulk_confirmed_count, sender, subject, body, attachment_url, include_signature, status, send_snapshot FROM campaigns WHERE campaign_id = ?',
      [campaignId]
    );

    if (!campaign) {
      // Campaign deleted — record skip but DON'T call checkCompletion (the
      // campaign row is gone, so the UPDATE inside checkCompletion would
      // be a no-op anyway). Treat as permanent: no retry.
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'campaign_not_found' });
      return { skipped: true, reason: 'campaign_not_found' };
    }

    // ── 2. This contact's result row (the reservation contract) ──

    const [[prior]] = await db.query(
      'SELECT status, result_meta FROM campaign_results WHERE campaign_id = ? AND contact_id = ?',
      [campaignId, contactId]
    );
    if (prior && TERMINAL_RESULTS.includes(prior.status)) {
      // A replayed job (recovered from 'running', a duplicate dispatch): the
      // outcome is already recorded. Touch nothing; finalize if it is due.
      await checkCompletion(db, campaignId);
      return { replay: true, status: prior.status };
    }
    if (prior && prior.status === 'sending') {
      // An earlier attempt reserved and never finished: the provider may
      // have accepted it. Never resend (§6.4).
      await markUnknown(db, campaignId, contactId, metaOf(prior.result_meta),
        `a later attempt (${attemptId}) found the send reserved and unfinished`);
      await checkCompletion(db, campaignId);
      return { unknown: true, reason: 'reservation_unfinished' };
    }

    // ── 3. Campaign status as the job sees it (§6.4) ──

    if (campaign.status === 'paused') {
      // The BACKSTOP: pause parked every pending sibling; this job was
      // already claimed (or recovered) — it waits PAUSED_DEFER_MS and resume
      // re-staggers it with the rest.
      return { deferred: true, retryAtMs: Date.now() + PAUSED_DEFER_MS + Math.floor(Math.random() * PAUSED_DEFER_SPREAD_MS), reason: 'campaign_paused' };
    }

    if (campaign.status === 'canceled') {
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'campaign_canceled' });
      await checkCompletion(db, campaignId);
      return { skipped: true, reason: 'campaign_canceled' };
    }

    if (FINISHED_STATUSES.includes(campaign.status)) {
      // A straggler after completion. recordResult never overwrites a row.
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'campaign_finished' });
      return { skipped: true, reason: 'campaign_finished' };
    }

    // ── 4. Marketing: the kill switch (read uncached), then the C2 path ──

    let settings = null;
    const marketing = campaign.class === 'marketing';
    if (marketing) {
      settings = await readCampaignSettings(db);
      if (!settings.marketingEnabled) {
        await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'marketing_disabled' });
        await checkCompletion(db, campaignId);
        return { skipped: true, reason: 'marketing_disabled' };
      }
      // createCampaign refuses both; a hand-written row must not reach a send.
      if (campaign.type !== 'email' || !campaign.topic_key) {
        const reason = campaign.type !== 'email' ? 'marketing_sms_refused' : 'topic_missing';
        await recordResult(db, campaignId, contactId, 'failed', `Marketing campaign cannot send: ${reason}`, { reason });
        await checkCompletion(db, campaignId);
        return { failed: true, reason };
      }
    }

    // ── 5. Load contact ──

    const [[contact]] = await db.query(
      'SELECT contact_id, contact_name, contact_phone, contact_email FROM contacts WHERE contact_id = ?',
      [contactId]
    );

    if (!contact) {
      await recordResult(db, campaignId, contactId, 'failed', 'Contact not found', null);
      await checkCompletion(db, campaignId);
      return { failed: true, reason: 'contact_not_found' };
    }

    // ── 5a. Consent — optoutService, re-read at send time, asked by class ──
    // (consentOptsFor: SMS scope 'all'; operational email asks nothing, D18.)

    const consent = consentOptsFor(campaign.type, campaign.class, campaign.topic_key);
    if (campaign.type === 'sms' && (await optout.findOptedOut(db, 'sms', contact.contact_phone, consent)).length) {
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'sms_optout' });
      await checkCompletion(db, campaignId);
      return { skipped: true, reason: 'sms_optout' };
    }

    if (campaign.type === 'email' && consent && (await optout.findOptedOut(db, 'email', contact.contact_email, consent)).length) {
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'email_optout' });
      await checkCompletion(db, campaignId);
      return { skipped: true, reason: 'email_optout' };
    }

    // ── 5b. Check required channel info ──

    if (campaign.type === 'sms' && !contact.contact_phone) {
      await recordResult(db, campaignId, contactId, 'failed', 'No phone number', null);
      await checkCompletion(db, campaignId);
      return { failed: true, reason: 'no_phone' };
    }

    if (campaign.type === 'email' && !contact.contact_email) {
      await recordResult(db, campaignId, contactId, 'failed', 'No email address', null);
      await checkCompletion(db, campaignId);
      return { failed: true, reason: 'no_email' };
    }

    // ── 5c. Resolve placeholders ──
    //
    // We require FULL resolution before sending: any unresolved placeholder
    // (or missing-ref / security failure) means the customer would receive
    // literal `{{...}}` in the body — unacceptable.
    //
    // Note: a DB error inside the resolver now propagates as a thrown error
    // (we removed the catch-and-return-failed pattern in resolverService).
    // It will be caught by the outer try/catch below and classified as
    // transient → retry-able.

    // MARKETING resolves AFTER the reservation instead (C2): its body may name
    // {{send.unsubscribe_url}}, and the token is minted with the reservation's
    // id — renderMarketing below.

    const refs = { contacts: { contact_id: contactId } };

    // Email bodies are HTML: substituted values are escaped (bodyEscapeFor).
    // The subject below is a header, never HTML — resolved unescaped.
    const resolvedBody = marketing ? { status: 'success', text: null }
      : await resolve({ db, text: campaign.body, refs, strict: true, escape: bodyEscapeFor(campaign.type) });

    if (resolvedBody.status !== 'success') {
      // Semantic resolver failure — permanent.
      const errDetail = resolvedBody.unresolved?.length
        ? `Unresolved placeholders: ${resolvedBody.unresolved.join(', ')}`
        : (resolvedBody.errors?.join('; ') || 'Body placeholder resolution failed');
      await recordResult(db, campaignId, contactId, 'failed', errDetail, null);
      await checkCompletion(db, campaignId);
      return { failed: true, reason: 'body_unresolved', detail: errDetail };
    }

    let resolvedSubject = null;
    if (!marketing && campaign.type === 'email' && campaign.subject) {
      resolvedSubject = await resolve({ db, text: campaign.subject, refs, strict: true });

      if (resolvedSubject.status !== 'success') {
        const errDetail = resolvedSubject.unresolved?.length
          ? `Unresolved placeholders in subject: ${resolvedSubject.unresolved.join(', ')}`
          : (resolvedSubject.errors?.join('; ') || 'Subject placeholder resolution failed');
        await recordResult(db, campaignId, contactId, 'failed', errDetail, null);
        await checkCompletion(db, campaignId);
        return { failed: true, reason: 'subject_unresolved', detail: errDetail };
      }
    }

    // ── 6. A bulk_ok row (marketing, or over-cap operational): hold, health,
    //       snapshot (marketing), then the rate window ──
    //
    // Only a marketing or an over-cap operational EMAIL campaign may hold a
    // bulk_ok sender (createCampaign); a within-cap one goes through the
    // public sendEmail, which refuses a bulk row (bulk_sender_refused).
    // Non-bulk transports get no window here — the hub budget covers them.

    let bulkRow = null;
    if (campaign.type === 'email' && (marketing || campaign.bulk_confirmed_count != null)) {
      const [[row]] = await db.query('SELECT * FROM email_credentials WHERE email = ? LIMIT 1', [campaign.sender]);
      if (row && emailService.isBulkRow(row)) bulkRow = row;
    }

    let snapshot = null;
    let sendTopic = null;
    if (marketing) {
      if (!bulkRow) {
        // The sender row stopped being a marketing transport after create.
        await recordResult(db, campaignId, contactId, 'failed', `${campaign.sender} is not a marketing transport`, { reason: 'marketing_requires_bulk_sender' });
        await checkCompletion(db, campaignId);
        return { failed: true, reason: 'marketing_requires_bulk_sender' };
      }
      // §6.5 THE HOLD, before every marketing send: a held transport pauses
      // the campaign (its pending sends parked) and this job waits with them
      // — nothing recorded; resume re-staggers it. The thresholds can SET it.
      let holdReason = bulkRow.held_at != null ? (bulkRow.held_reason || 'held') : null;
      if (!holdReason) {
        const trip = await transportHealthGate(db, bulkRow);
        if (trip) { await holdTransport(db, bulkRow, trip); holdReason = trip; }
      }
      if (holdReason) {
        try { await pauseCampaign(db, campaignId); } catch (err) { if (!(err && err.name === 'CampaignError' && err.status === 409)) throw err; }
        if (bulkRow.held_at != null) await heldAlert(db, bulkRow, holdReason, bulkRow.held_at);   // a fresh trip alerted in holdTransport
        return { deferred: true, retryAtMs: Date.now() + PAUSED_DEFER_MS + Math.floor(Math.random() * PAUSED_DEFER_SPREAD_MS), reason: 'transport_held' };
      }
      const snap = await ensureSendSnapshot(db, campaign);
      if (snap.error) {
        await recordResult(db, campaignId, contactId, 'failed', `footer_missing: ${snap.error}`.slice(0, 1000), { reason: 'footer_missing' });
        await checkCompletion(db, campaignId);
        return { failed: true, reason: 'footer_missing', detail: snap.error };
      }
      snapshot = snap.snapshot;
      // The footer states the snapshot's topic — with the advertisement label
      // whenever EITHER the snapshot or the live topic is opt_out (a topic
      // flipped mid-send never drops the label).
      const live = await topicRow(db, campaign.topic_key);
      sendTopic = { ...snapshot.topic,
        consent_model: snapshot.topic.consent_model === 'opt_out' || (live && String(live.consent_model) === 'opt_out') ? 'opt_out' : 'opt_in' };
    }

    if (bulkRow) {
      settings = settings || await readCampaignSettings(db);
      const [[w]] = await db.query(
        `SELECT COUNT(*) AS n
           FROM campaign_results cr
           JOIN campaigns c ON c.campaign_id = cr.campaign_id
          WHERE c.sender = ? AND cr.status IN ('sending', 'sent')
            AND cr.sent_at >= NOW() - INTERVAL ${RATE_WINDOW_SECONDS} SECOND`,
        [campaign.sender]
      );
      if (Number(w.n) >= settings.rate) {
        return { deferred: true, retryAtMs: Date.now() + RATE_DEFER_MIN_MS + Math.floor(Math.random() * RATE_DEFER_SPREAD_MS), reason: 'rate_window' };
      }
    }

    // ── 7. RESERVE — the row exists as 'sending' BEFORE any provider call ──

    let resultId = null;
    try {
      const [ins] = await db.query(
        `INSERT INTO campaign_results (campaign_id, contact_id, status, error, result_meta, sent_at)
         VALUES (?, ?, 'sending', NULL, ?, NOW())`,
        [campaignId, contactId, JSON.stringify({ attempt_id: attemptId })]
      );
      resultId = ins && ins.insertId ? ins.insertId : null;
      reservation.held = true;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        // Another worker reserved (or recorded) this contact a moment ago —
        // it owns the send. Touch nothing.
        return { replay: true, reason: 'reserved_elsewhere' };
      }
      throw err;
    }

    // ── 7a. Marketing (C2): the unsub token (send_ref = this reservation),
    //        then the render + post-render assert — still before any provider call ──
    //
    // Plain autocommit statements: no transaction holds the campaign_results
    // row while the token row is written (T2's lock order is never in play).
    // Anything THROWN here clears the reservation like a definite send error
    // (nothing reached the provider — a retry re-reserves, and re-uses this
    // unused token); a permanent render outcome finalizes THIS reservation as
    // 'failed' with no provider call.
    let mk = null;
    let unsubscribeUrl = null;
    if (marketing) {
      try {
        if (!resultId) throw new Error('the reservation returned no result id (the token needs it)');
        const unsub = require('./unsubService'); // lazy require (convention)
        const { token } = await unsub.mintOrReuseUnsubToken(db, {
          destination: contact.contact_email, topicKey: campaign.topic_key,
          campaignId, contactId, sendRef: String(resultId),
        });
        unsubscribeUrl = unsub.urlFor(token);
        mk = await renderMarketing(db, {
          body: campaign.body, subject: campaign.subject, contactId,
          unsubscribeUrl, preferencesUrl: unsub.preferencesUrlFor(token), topic: sendTopic, firm: snapshot.firm,
        });
      } catch (err) {
        await clearReservation(db, campaignId, contactId, attemptId);
        reservation.held = false;
        throw err;
      }
      if (mk.status !== 'ok') {
        const reason = mk.status === 'unresolved' ? 'body_unresolved' : 'footer_missing';
        await failReservation(db, campaignId, contactId, attemptId, (reason === 'footer_missing' ? `footer_missing: ${mk.detail}` : mk.detail).slice(0, 1000), { reason });
        reservation.held = false;
        await checkCompletion(db, campaignId);
        return { failed: true, reason, detail: mk.detail };
      }
    }

    // The first send flips a scheduled campaign to sending (§6.4).
    if (campaign.status === 'scheduled') {
      await db.query(
        "UPDATE campaigns SET status = 'sending', updated_at = NOW() WHERE campaign_id = ? AND status = 'scheduled'",
        [campaignId]
      );
    }

    // ── 8. Send ──

    let sendResult;
    try {
      if (campaign.type === 'sms') {
        if (campaign.attachment_url) {
          // MMS — line must be mms_capable (validated at campaign creation)
          sendResult = await phoneService.sendMms(
            db,
            campaign.sender,
            contact.contact_phone,
            resolvedBody.text,
            campaign.attachment_url
          );
        } else {
          sendResult = await phoneService.sendSms(
            db,
            campaign.sender,
            contact.contact_phone,
            resolvedBody.text
          );
        }
      } else {
        const emailOpts = {
          from:    campaign.sender,
          to:      contact.contact_email,
          subject: resolvedSubject ? resolvedSubject.text : campaign.subject,
          html:    resolvedBody.text,
          // Per-campaign flag (campaigns.include_signature, default 0). The
          // append itself lives in emailService.sendEmailDirect and no-ops
          // when the sender row has no stored signature.
          signature: !!campaign.include_signature
        };

        // Email attachment — ONCE, as attachment_urls: every adapter reads it
        // (smtp / gmail turn it into one {filename, path:url}; pabbly sends the
        // URL). Passing it as `attachments` too made smtp and gmail attach the
        // file TWICE (their buildAttachments concatenates both) — fixed in C2.
        if (campaign.attachment_url) emailOpts.attachment_urls = campaign.attachment_url;

        // D16 (Fred, 2026-11-02): an over-cap operational campaign may send
        // through a bulk_ok row — bulk:true and the correlation tags
        // ({campaign_id, result_id}, so an SES event that beats the 'sent'
        // update still finds this row — T2 needs both tags), nothing else: no
        // headers, no reply_to, no footer. Every other email stays on the
        // public sendEmail (which refuses a bulk row).
        if (marketing) {
          // C2: the explicit text part, the footer, the three headers, the
          // snapshot's Reply-To, the correlation tags, no signature, and the
          // email_log row without its body (the snapshot is the copy).
          emailOpts.subject = mk.subject;
          emailOpts.html = mk.html;
          emailOpts.text = mk.text;
          delete emailOpts.signature;
        }
        sendResult = marketing
          ? await emailService.sendEmailDirect(db, bulkRow, {
            ...emailOpts, bulk: true,
            headers: marketingHeaders(unsubscribeUrl, snapshot.list_id),
            ...(snapshot.reply_to ? { reply_to: snapshot.reply_to } : {}),
            tags: { campaign_id: String(campaignId), result_id: String(resultId) },
            log_body: false,
          })
          : bulkRow
          ? await emailService.sendEmailDirect(db, bulkRow, {
            ...emailOpts, bulk: true,
            ...(resultId ? { tags: { campaign_id: String(campaignId), result_id: String(resultId) } } : {}),
          })
          : await emailService.sendEmail(db, emailOpts);
      }
    } catch (sendErr) {
      // Only a DEFINITE refusal: an error that is also ambiguous (no reply —
      // the provider may have accepted it) must stay 'unknown', never re-pend.
      if (marketing && !isAmbiguousSendError(sendErr) && isAccountPausedError(sendErr)) {
        // SES refused at the ACCOUNT level (§6.4) — before acceptance, so the
        // reservation is cleared like a definite error and this recipient goes
        // back to pending (a deferral: no attempt used); the transport is held
        // and every marketing campaign on it — this one included — paused.
        await clearReservation(db, campaignId, contactId, attemptId);
        reservation.held = false;
        await holdTransport(db, bulkRow, `the provider refused at the account level: ${String(sendErr.response || sendErr.message || '').slice(0, 180)}`);
        return { deferred: true, retryAtMs: Date.now() + PAUSED_DEFER_MS + Math.floor(Math.random() * PAUSED_DEFER_SPREAD_MS), reason: 'account_paused' };
      }
      if (isAmbiguousSendError(sendErr)) {
        // The provider may have taken it: 'unknown', never resent.
        console.error(`[CAMPAIGN SEND] campaign=${campaignId} contact=${contactId} ambiguous provider error — recorded unknown: ${sendErr.message}`);
        await markUnknown(db, campaignId, contactId, { attempt_id: attemptId },
          'the provider call failed without a reply (it may have accepted the message)', String(sendErr.message || '').slice(0, 1000));
        reservation.held = false;
        await checkCompletion(db, campaignId);
        return { unknown: true, reason: 'provider_ambiguous' };
      }
      // Definite: nothing was accepted. Clear the reservation so a transient
      // retry re-reserves and resends, and a permanent failure records
      // 'failed' below — today's classification.
      await clearReservation(db, campaignId, contactId, attemptId);
      reservation.held = false;
      throw sendErr;
    }

    // ── 9. Record success (only over this attempt's own reservation) ──

    await db.query(
      `UPDATE campaign_results
          SET status = 'sent', error = NULL, result_meta = ?, sent_at = NOW(),
              provider_message_id = COALESCE(provider_message_id, ?)
        WHERE campaign_id = ? AND contact_id = ? AND status IN ('sending', 'unknown')
          AND JSON_UNQUOTE(JSON_EXTRACT(result_meta, '$.attempt_id')) = ?`,
      [JSON.stringify({ attempt_id: attemptId, messageId: sendResult?.messageId || null, provider: sendResult?.provider || null }),
        sendResult?.providerMessageId || null, campaignId, contactId, attemptId]
    );
    reservation.held = false;

    await checkCompletion(db, campaignId);

    return { sent: true, messageId: sendResult?.messageId };

  } catch (err) {
    // Outer catch — any throw from anywhere above lands here.
    // Possible sources:
    //   - DB query throws (load campaign, load contact, the reservation, the
    //     'sent' update, checkCompletion)
    //   - Resolver DB throw (now propagates after resolverService fix)
    //   - A DEFINITE send error (its reservation already cleared above)
    // A failure AFTER the provider accepted (the 'sent' update, checkCompletion)
    // leaves the row 'sending' or 'sent': a retry finds it and never resends.

    const transient = isTransientError(err);

    if (transient && !isFinalAttempt) {
      // Let the job system retry. Don't record — sibling jobs' checkCompletion
      // calls would otherwise see a 'failed' row and prematurely finalize the
      // campaign as partial_fail.
      console.warn(
        `[CAMPAIGN SEND] campaign=${campaignId} contact=${contactId} ` +
        `transient (attempt ${attempt}/${maxAttempts}): ${err.message}`
      );
      throw err;
    }

    // Permanent error OR final transient attempt — record and return normally.
    const reason = transient
      ? `Transient failure persisted across ${attempt} attempts: ${err.message}`
      : err.message;

    console.error(
      `[CAMPAIGN SEND] campaign=${campaignId} contact=${contactId} ` +
      `${transient ? 'final-attempt' : 'permanent'} (attempt ${attempt}/${maxAttempts}): ${err.message}`
    );

    try {
      if (reservation.held) {
        // THIS attempt's reservation may still be 'sending' (the sent update
        // or the clearing DELETE threw) and no retry is coming (final attempt
        // or permanent): first-wins recordResult would be a no-op on it and
        // the campaign would never finalize. The provider may have the
        // message → 'unknown' (conditional on 'sending' + this attempt id, so
        // a row that did land as 'sent' is untouched).
        await markUnknown(db, campaignId, contactId, { attempt_id: attemptId },
          'the attempt failed after its reservation and no retry follows', String(reason).slice(0, 1000));
        await checkCompletion(db, campaignId);
        return { unknown: true, reason: 'reservation_unresolved', detail: reason };
      }
      await recordResult(db, campaignId, contactId, 'failed', reason, null);
      await checkCompletion(db, campaignId);
    } catch (recordErr) {
      // Even recordResult is throwing. Surface the original error to the job
      // system; it will mark the job failed and we lose the campaign_results
      // row for this contact (campaign stays 'sending' forever for them).
      // This is bad but rare (recordResult is a single-row INSERT) — we'd
      // rather see the original error in logs than mask it.
      console.error(
        `[CAMPAIGN SEND] failed to record result for campaign=${campaignId} ` +
        `contact=${contactId}: ${recordErr.message}`
      );
      throw err;
    }

    return { failed: true, reason };
  }
}


// ─────────────────────────────────────────────────────────────
// THE PUMP (one tick — called by job_executor for a campaign_pump job)
// ─────────────────────────────────────────────────────────────

/**
 * One pump tick (§6.4). The pump NEVER sends — it rings Cloud Tasks
 * doorbells (lib/taskQueue.enqueueJobDispatch) for this campaign's pending
 * campaign_send jobs due within ACCEL_WINDOW_MS (invariant 3: a doorbell,
 * not a calendar), AT MOST `rate` per tick, overdue ones included — bounded
 * catch-up after an outage, never "all of them". Then:
 *   → { deferred: true, retryAtMs }  sends remain (pending or running): the
 *      job_executor defers the SAME row ~60 s out (one row per pump; a crash
 *      mid-tick leaves it 'running' for recoverStuckJobs, never a second row)
 *   → { done: true, reason }         campaign gone / paused (resume re-inserts) /
 *      canceled / finished / superseded by a newer live pump / no sends left
 */
async function runPump(db, campaignId, { jobId = null } = {}) {
  const [[campaign]] = await db.query('SELECT status FROM campaigns WHERE campaign_id = ?', [campaignId]);
  if (!campaign) return { done: true, reason: 'campaign_not_found' };
  if (jobId != null) {
    const [[newer]] = await db.query(
      "SELECT id FROM scheduled_jobs WHERE idempotency_key = ? AND status IN ('pending', 'running') AND id > ? LIMIT 1",
      [`campaign:${campaignId}:pump`, jobId]
    );
    if (newer) return { done: true, reason: 'superseded' };
  }
  if (campaign.status === 'paused') return { done: true, reason: 'paused' };
  if (campaign.status === 'canceled' || FINISHED_STATUSES.includes(campaign.status)) {
    return { done: true, reason: `campaign_${campaign.status}` };
  }

  const taskQueue = require('../lib/taskQueue'); // lazy require (convention)
  const settings = await readCampaignSettings(db);
  const bound = pumpBound(settings.rate);
  const sendPrefix = `campaign:${campaignId}:send:%`;
  const [due] = await db.query(
    `SELECT id, scheduled_time FROM scheduled_jobs
      WHERE name LIKE ? AND status = 'pending' AND active = 1
        AND scheduled_time <= NOW() + INTERVAL ? SECOND
      ORDER BY scheduled_time, id
      LIMIT ?`,
    [sendPrefix, Math.floor(taskQueue.ACCEL_WINDOW_MS / 1000), bound]
  );
  await Promise.all((due || []).map((j) => taskQueue.enqueueJobDispatch(j.id, j.scheduled_time)));

  const [[left]] = await db.query(
    "SELECT COUNT(*) AS n FROM scheduled_jobs WHERE name LIKE ? AND status IN ('pending', 'running')",
    [sendPrefix]
  );
  if (!Number(left.n)) return { done: true, reason: 'no_sends_left', rung: (due || []).length };
  // Re-arm: the job_executor defers THIS row to retryAtMs, and its own
  // doorbell is rung here for that time (55 s < ACCEL_WINDOW_MS — invariant 3
  // holds). The task fires at retryAtMs + DISPATCH_BUFFER_MS, after the row
  // is back to pending (the deferral is written as soon as this returns) and
  // past DATETIME's rounding of retryAt (≤ 0.5 s < the 0.75 s buffer).
  const retryAtMs = Date.now() + PUMP_REARM_MS;
  if (jobId != null) await taskQueue.enqueueJobDispatch(jobId, retryAtMs);
  return { deferred: true, retryAtMs, rung: (due || []).length };
}

/**
 * Doorbells per pump tick: rate (per minute) × the 55 s re-arm interval, at
 * least 1 — measured against the interval the pump actually ticks at, so a
 * backlog catch-up never rings more than the rate per minute.
 */
function pumpBound(rate) {
  return Math.max(1, Math.floor(rate * (PUMP_REARM_MS / 60000)));
}


// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Record a per-contact OUTCOME that involved no provider call (skipped, or
 * failed before / instead of a send).
 *
 * FIRST WINS (C1): INSERT ... ON DUPLICATE KEY UPDATE result_id = result_id
 * on the (campaign_id, contact_id) unique key — an existing row is never
 * overwritten. Before C1 this was latest-wins, because a retry after a
 * recorded send re-sent and re-recorded; now a retry finds the row first
 * (executeSend step 2) and never resends, and the provider path writes its
 * own transitions ('sending' INSERT, 'sent' / 'unknown' UPDATE on that row).
 * First-wins means a replay can never turn a 'sent' into a 'skipped' or a
 * 'failed'.
 *
 * Requires: ALTER TABLE campaign_results ADD UNIQUE KEY uq_campaign_contact
 * (campaign_id, contact_id). Without that index, this falls back to plain
 * INSERT (no dedup), creating duplicate rows.
 */
async function recordResult(db, campaignId, contactId, status, error, meta) {
  await db.query(
    `INSERT INTO campaign_results (campaign_id, contact_id, status, error, result_meta, sent_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE result_id = result_id`,
    [campaignId, contactId, status, error || null, meta ? JSON.stringify(meta) : null]
  );
}

/**
 * Classify an error as transient (retry-able) or permanent.
 *
 * Transient: temporary infra / provider failures. Worth retrying.
 *   - Node/nodemailer network error codes (ESOCKET, ETIMEDOUT, ECONNRESET, ...)
 *   - mysql2 connection / lock errors
 *   - SMTP 4xx response codes (transient negative reply by spec)
 *   - HTTP 429 (rate limit) and 5xx (server error) from providers
 *
 * Permanent: hard failures. Retrying would not help and may cause harm
 * (duplicate sends to a flaky-but-eventually-bouncing recipient, sender
 * reputation damage, SMS cost waste).
 *   - SMTP 5xx response codes (permanent negative reply by spec)
 *   - Auth failures (bad credentials)
 *   - Invalid recipient / sender envelope errors
 *
 * Default for unrecognized errors: PERMANENT. Rationale: better to surface
 * a one-attempt 'failed' row that staff can investigate than to retry an
 * unclassified error 3 times and possibly trigger duplicate sends.
 *
 * Since C1 a send error only reaches this after isAmbiguousSendError said
 * DEFINITE (an ambiguous one is recorded 'unknown' first) — so a network
 * code here means the connection never carried the message.
 */
function isTransientError(err) {
  if (!err) return false;

  // emailService's marketing-transport refusal (T1): the sender row is a
  // bulk_ok row, which no retry changes. Decided by code, not by the message
  // heuristics below — the address it names could contain "timeout" or a 5xx.
  if (err.code === 'bulk_sender_refused') return false;

  // Node / nodemailer error codes (network-layer failures)
  const TRANSIENT_CODES = new Set([
    'ESOCKET', 'ETIMEDOUT', 'ETIME', 'ECONNRESET', 'ECONNREFUSED',
    'EHOSTUNREACH', 'ENETUNREACH', 'ECONNECTION', 'EAI_AGAIN', 'EPIPE'
  ]);

  // mysql2 transient error codes
  const TRANSIENT_MYSQL_CODES = new Set([
    'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_QUERY_INTERRUPTED'
  ]);

  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (err.code && TRANSIENT_MYSQL_CODES.has(err.code)) return true;

  // SMTP response codes (nodemailer surfaces these on err.responseCode).
  // 4xx = transient negative; 5xx = permanent negative.
  if (typeof err.responseCode === 'number') {
    if (err.responseCode >= 400 && err.responseCode < 500) return true;
    if (err.responseCode >= 500 && err.responseCode < 600) return false;
  }

  // Provider HTTP errors come through as plain Error objects with the status
  // baked into the message (RC adapter throws `new Error(\`RingCentral SMS ${status}: ...\`)`,
  // Quo adapter throws `new Error(\`Quo API ${status}: ...\`)`).
  // Best-effort pattern matching as a fallback.
  const msg = (err.message || '').toLowerCase();

  // Explicit network words in the message
  if (/\b(etimedout|econnreset|econnrefused|ehostunreach|enotfound|timeout)\b/.test(msg)) return true;

  // Rate limit
  if (/\b429\b/.test(err.message || '') || /rate ?limit|too many requests/.test(msg)) return true;

  // 5xx in HTTP context (NOT SMTP — SMTP 5xx already handled above and is permanent)
  // Match a standalone 5xx number near "api error", "status", or at start of message.
  if (/\b(50\d|51\d|52\d|53\d|54\d|55\d|56\d|57\d|58\d|59\d)\b/.test(err.message || '')) {
    // Heuristic: if the message contains "smtp" we leave it as permanent
    // (SMTP 5xx is permanent and would have been caught by responseCode above
    // in the well-formed case; this guard catches the ill-formed case).
    if (!/smtp/i.test(err.message || '')) return true;
  }

  // Default: permanent.
  return false;
}

/**
 * Check if all contacts have been processed. If so, finalize campaign status.
 * A 'sending' row (a reservation whose provider call has not finished) is NOT
 * done — counting it would let a sibling finalize the campaign while that
 * send is still in flight. An 'unknown' row IS done.
 * Final status: unknown counts like failed for partial_fail purposes
 * (sent only when nothing failed, was skipped or is unknown; failed when
 * nothing was sent); result_summary carries all four counts.
 * The WHERE status IN (...) guard prevents overwriting a 'canceled' status; a
 * 'paused' campaign whose every send finished is finished too.
 */
async function checkCompletion(db, campaignId) {
  const [[counts]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?) AS total,
       (SELECT COUNT(*) FROM campaign_results  WHERE campaign_id = ? AND status <> 'sending') AS done`,
    [campaignId, campaignId]
  );

  if (Number(counts.done) < Number(counts.total)) return; // still in progress

  // All processed — determine final status from results
  const [[summary]] = await db.query(
    `SELECT
       SUM(status = 'sent')    AS sent,
       SUM(status = 'failed')  AS failed,
       SUM(status = 'skipped') AS skipped,
       SUM(status = 'unknown') AS unknown
     FROM campaign_results WHERE campaign_id = ?`,
    [campaignId]
  );

  // Coerce to Number — mysql2 may return SUM() as string or Decimal
  const sent    = Number(summary.sent    || 0);
  const failed  = Number(summary.failed  || 0);
  const skipped = Number(summary.skipped || 0);
  const unknown = Number(summary.unknown || 0);

  let finalStatus;
  if (failed === 0 && skipped === 0 && unknown === 0) {
    finalStatus = 'sent';
  } else if (sent === 0) {
    finalStatus = 'failed';
  } else {
    finalStatus = 'partial_fail';
  }

  const summaryObj = { sent, failed, skipped, unknown };

  await db.query(
    `UPDATE campaigns
     SET status = ?, result_summary = ?, updated_at = NOW()
     WHERE campaign_id = ? AND status IN ('sending', 'scheduled', 'paused')`,
    [finalStatus, JSON.stringify(summaryObj), campaignId]
  );

  console.log(`[CAMPAIGN] Campaign ${campaignId} complete: ${finalStatus} (sent=${sent}, failed=${failed}, skipped=${skipped}, unknown=${unknown})`);
}


module.exports = {
  getFilteredContacts,
  getCaseTypeFacets,
  getComposeOptions,
  createCampaign,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaign,
  listCampaigns,
  getCampaignResults,
  executeSend,
  runPump,
  previewCampaign,
  consentOptsFor,
  CampaignError,
  // C2
  testSendMarketing,
  // C7
  sendPromotional,
  releaseTransport,
  RELEASE_TOOL,
  FOOTER_SLOT,
  TEST_SEND_TOKEN,
  KLASSES,
  TOPIC_RE,
  DEFAULT_OPERATIONAL_CAP,
  DEFAULT_MARKETING_RATE,
  // TEST SEAMS: the bulk_sender_refused classification is pinned by
  // tests/emailService.marketingOptions.test.js (T1); the C1 reservation
  // classification and the pump bound by tests/campaignC1.*.
  isTransientError,
  isAmbiguousSendError,
  pumpBound,
  checkCompletion,
  PUMP_REARM_MS,
  PAUSED_DEFER_MS,
  PARKED_AFTER,
  MAX_SCHEDULE_DAYS,
  // C2 test seams (tests/campaignC2*.test.js)
  assertHttpsAttachment,
  injectFooter,
  textPartFor,
  listIdFor,
  marketingHeaders,
  footerHoles,
  isAccountPausedError,
  renderMarketing,
  ensureSendSnapshot,
  holdTransport,
  transportHealthGate,
  COMPLAINT_WARN_RATE,
  COMPLAINT_HOLD_RATE,
  BOUNCE_HOLD_RATE,
};
