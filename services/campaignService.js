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
 */

const { resolve }    = require('./resolverService');
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
    'SELECT email, from_name FROM email_credentials WHERE bulk_ok = 1 ORDER BY id'
  );
  const [topics] = await db.query(UNSUB_SQL.topics);
  return {
    marketing_senders: (senders || []).map((r) => ({ email: r.email, from_name: r.from_name })),
    topics: (topics || []).map((t) => ({ topic_key: t.topic_key, label: t.label, description: t.description, consent_model: t.consent_model })),
    operational_cap: settings.cap,
    marketing_rate: settings.rate,
    marketing_enabled: settings.marketingEnabled,
    can_bulk: can(auth, 'campaigns.bulk'),
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
 *
 * @returns {{ campaignId, contactCount, jobsCreated, status, class, overCap, paced }}
 */
async function createCampaign(db, {
  type, sender, subject, body, contactIds, scheduledTime, createdBy, attachmentUrl, includeSignature,
  klass = 'operational', topicKey = null, confirmCount = null, auth = null, request = null,
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
    // marketing campaign — C1's executeSend has no footer/token/header path.
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
      'SELECT id, bulk_ok FROM email_credentials WHERE email = ? LIMIT 1',
      [sender]
    );
    if (!senderRow) {
      throw new CampaignError(400, 'unknown_sender', `Email sender ${sender} is not a configured sender`);
    }
    const bulkSender = senderRow.bulk_ok != null && Number(senderRow.bulk_ok) !== 0;
    if (klass === 'marketing' && !bulkSender) {
      throw new CampaignError(400, 'marketing_requires_bulk_sender', `Marketing campaigns send only from a marketing transport — ${sender} is not one.`);
    }
    if (klass === 'operational' && bulkSender && !overCap) {
      throw new CampaignError(400, 'bulk_sender_refused', `Operational campaigns cannot send from a marketing transport (${sender})`);
    }
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
      `INSERT INTO campaigns (type, class, topic_key, bulk_confirmed_count, sender, subject, body, attachment_url, include_signature, status, scheduled_time, contact_count, created_by, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [type, klass, topic, overCap ? count : null, sender, subject || null, body, attachmentUrl || null, includeSignature ? 1 : 0, initialStatus, scheduledTime || null, count, createdBy]
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
 */
async function resumeCampaign(db, campaignId) {
  const settings = await readCampaignSettings(db);
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
 *      marketing_disabled); switch on → skipped marketing_path_unbuilt (C2
 *      builds that path — never the operational send)
 *   5. contact, consent (consentOptsFor: operational email asks nothing, D18),
 *      channel info, placeholders — as before
 *   6. over-cap operational on a bulk_ok sender: the per-transport rate window
 *      (≥ rate sends in the last 60 s → DEFER 2–8 s, no attempt)
 *   7. RESERVE (insert the row as 'sending' with an attempt id), flip a
 *      scheduled campaign to sending
 *   8. send; ambiguous provider error → 'unknown'; definite → reservation
 *      cleared, then the classification below
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
      'SELECT campaign_id, type, class, topic_key, bulk_confirmed_count, sender, subject, body, attachment_url, include_signature, status FROM campaigns WHERE campaign_id = ?',
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

    // ── 4. Marketing: the kill switch, then fail closed (C2 builds the path) ──

    let settings = null;
    if (campaign.class === 'marketing') {
      settings = await readCampaignSettings(db);
      const reason = settings.marketingEnabled ? 'marketing_path_unbuilt' : 'marketing_disabled';
      await recordResult(db, campaignId, contactId, 'skipped', null, { reason });
      await checkCompletion(db, campaignId);
      return { skipped: true, reason };
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

    const refs = { contacts: { contact_id: contactId } };

    // Email bodies are HTML: substituted values are escaped (bodyEscapeFor).
    // The subject below is a header, never HTML — resolved unescaped.
    const resolvedBody = await resolve({ db, text: campaign.body, refs, strict: true, escape: bodyEscapeFor(campaign.type) });

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
    if (campaign.type === 'email' && campaign.subject) {
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

    // ── 6. Over-cap operational on a bulk_ok row: the rate window ──
    //
    // Only an over-cap operational EMAIL campaign may hold a bulk_ok sender
    // (createCampaign); a within-cap one goes through the public sendEmail,
    // which refuses a bulk row (bulk_sender_refused). Non-bulk transports get
    // no window here — the hub budget covers them.

    let bulkRow = null;
    if (campaign.type === 'email' && campaign.bulk_confirmed_count != null) {
      const [[row]] = await db.query('SELECT * FROM email_credentials WHERE email = ? LIMIT 1', [campaign.sender]);
      if (row && emailService.isBulkRow(row)) bulkRow = row;
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

        // Email attachment — pass in both formats so emailService routes correctly
        if (campaign.attachment_url) {
          const fname = campaign.attachment_url.split('/').pop().split('?')[0] || 'attachment';
          emailOpts.attachments     = [{ filename: fname, path: campaign.attachment_url }]; // SMTP (nodemailer)
          emailOpts.attachment_urls = campaign.attachment_url;                              // Pabbly/Gmail
        }

        // D16 (Fred, 2026-11-02): an over-cap operational campaign may send
        // through a bulk_ok row — bulk:true and the correlation tags
        // ({campaign_id, result_id}, so an SES event that beats the 'sent'
        // update still finds this row — T2 needs both tags), nothing else: no
        // headers, no reply_to, no footer. Every other email stays on the
        // public sendEmail (which refuses a bulk row).
        sendResult = bulkRow
          ? await emailService.sendEmailDirect(db, bulkRow, {
            ...emailOpts, bulk: true,
            ...(resultId ? { tags: { campaign_id: String(campaignId), result_id: String(resultId) } } : {}),
          })
          : await emailService.sendEmail(db, emailOpts);
      }
    } catch (sendErr) {
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
      await db.query(
        `DELETE FROM campaign_results
          WHERE campaign_id = ? AND contact_id = ? AND status = 'sending'
            AND JSON_UNQUOTE(JSON_EXTRACT(result_meta, '$.attempt_id')) = ?`,
        [campaignId, contactId, attemptId]
      );
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
};
