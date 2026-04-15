/**
 * Campaign Service (redesigned)
 * services/campaignService.js
 *
 * All campaign business logic. Routes are thin HTTP wrappers.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  MIGRATION NOTE                                                     │
 * │  Before deploying, add to the Phase 1 migration:                    │
 * │                                                                     │
 * │  ALTER TABLE campaign_results                                       │
 * │    ADD UNIQUE KEY uq_campaign_contact (campaign_id, contact_id);    │
 * │                                                                     │
 * │  This enables INSERT IGNORE dedup in executeSend for job retries.   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Functions:
 *   getFilteredContacts(db, filters)       — contact selection with tag/case/channel filters
 *   createCampaign(db, opts)               — single-transaction: campaign + contacts + jobs
 *   cancelCampaign(db, campaignId)         — cancel + remove pending jobs
 *   getCampaign(db, campaignId)            — single campaign with results summary
 *   listCampaigns(db, opts)                — paginated list for View tab
 *   getCampaignResults(db, campaignId)     — per-contact result details
 *   executeSend(db, campaignId, contactId) — core send logic (called by job_executor)
 *   previewCampaign(db, opts)              — resolve placeholders for preview display
 */

const { resolve }    = require('./resolverService');
const smsService     = require('./smsService');
const emailService   = require('./emailService');
const { localToUTC } = require('./timezoneService');

// ─────────────────────────────────────────────────────────────
// CONTACT SELECTION
// ─────────────────────────────────────────────────────────────

/**
 * Query contacts matching filter criteria.
 *
 * @param {object} db
 * @param {object} filters
 * @param {string[]} [filters.tags]            — OR logic: contact has any of these tags
 * @param {string}   [filters.case_type]       — e.g. "Chapter 7"
 * @param {string|string[]} [filters.case_stage] — e.g. "Open" or ["Open","Filed"]
 * @param {string}   [filters.case_open_after] — date string YYYY-MM-DD
 * @param {string}   [filters.case_open_before]
 * @param {string}   [filters.channel]         — "sms" or "email": filters by has-phone/email + opt-out
 *
 * @returns {{ contacts, total, excluded }}
 *   contacts — eligible contact rows
 *   total    — total matching (before opt-out / missing-channel exclusion)
 *   excluded — count excluded due to opt-out or missing phone/email
 */
async function getFilteredContacts(db, filters = {}) {
  const { tags, case_type, case_stage, case_open_after, case_open_before, channel } = filters;

  // ── Build query ──

  const selects = [
    'c.contact_id', 'c.contact_name', 'c.contact_phone', 'c.contact_email',
    'c.contact_tags', 'c.contact_sms_optout', 'c.contact_email_optout'
  ];
  const joins  = [];
  const wheres = [];
  const params = [];

  // Case filters require JOINs through case_relate
  const needsCaseJoin = case_type || case_stage || case_open_after || case_open_before;
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
      if (!c.contact_phone || c.contact_sms_optout) { excluded++; continue; }
    } else if (channel === 'email') {
      if (!c.contact_email || c.contact_email_optout) { excluded++; continue; }
    }
    contacts.push(c);
  }

  return { contacts, total: allMatching.length, excluded };
}


// ─────────────────────────────────────────────────────────────
// CREATE CAMPAIGN
// ─────────────────────────────────────────────────────────────

/**
 * Create a campaign with contacts and scheduled send jobs.
 * Runs in a single transaction — all-or-nothing.
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
 *
 * @returns {{ campaignId, contactCount, jobsCreated, status }}
 */
async function createCampaign(db, { type, sender, subject, body, contactIds, scheduledTime, createdBy }) {
  if (!type || !sender || !body) {
    throw new Error('Missing required fields: type, sender, body');
  }
  if (!contactIds || !contactIds.length) {
    throw new Error('At least one contact is required');
  }
  if (type === 'email' && !subject) {
    throw new Error('Subject is required for email campaigns');
  }

  // Deduplicate contact IDs
  const uniqueIds = [...new Set(contactIds.map(Number).filter(id => id > 0))];

  // Determine initial status and job scheduled time
  const isScheduled = !!scheduledTime;
  const initialStatus = isScheduled ? 'scheduled' : 'sending';

  // Convert firm-local → UTC for job scheduling
  const jobTime = isScheduled ? localToUTC(scheduledTime) : new Date();
  if (isScheduled && !jobTime) {
    throw new Error('Invalid scheduledTime value');
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    // 1. INSERT campaign
    const [campaignResult] = await conn.query(
      `INSERT INTO campaigns (type, sender, subject, body, status, scheduled_time, contact_count, created_by, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [type, sender, subject || null, body, initialStatus, scheduledTime || null, uniqueIds.length, createdBy]
    );
    const campaignId = campaignResult.insertId;

    // 2. Batch INSERT campaign_contacts
    const contactValues = uniqueIds.map(cid => [campaignId, cid]);
    await conn.query(
      'INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ?',
      [contactValues]
    );

    // 3. Batch INSERT scheduled_jobs (one per contact)
    const jobValues = uniqueIds.map(cid => [
      'one_time',                                                          // type
      jobTime,                                                             // scheduled_time
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

    await conn.commit();

    console.log(`[CAMPAIGN] Created campaign ${campaignId}: ${type}, ${uniqueIds.length} contacts, status=${initialStatus}`);

    return {
      campaignId,
      contactCount: uniqueIds.length,
      jobsCreated: uniqueIds.length,
      status: initialStatus
    };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// CANCEL CAMPAIGN
// ─────────────────────────────────────────────────────────────

/**
 * Cancel a campaign. Sets status to 'canceled' and removes pending jobs.
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

  if (!['draft', 'scheduled', 'sending'].includes(campaign.status)) {
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
       SUM(status = 'skipped')      AS skipped
     FROM campaign_results WHERE campaign_id = ?`,
    [campaignId]
  );

  campaign.results = {
    sent:    summary.sent    || 0,
    failed:  summary.failed  || 0,
    skipped: summary.skipped || 0,
    pending: campaign.contact_count - (summary.results_total || 0)
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
    SELECT c.campaign_id, c.type, c.sender, c.subject, c.status,
           c.scheduled_time, c.contact_count, c.created, c.created_by,
           u.user_name AS created_by_name,
           (SELECT SUM(status = 'sent')    FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS sent_count,
           (SELECT SUM(status = 'failed')  FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS failed_count,
           (SELECT SUM(status = 'skipped') FROM campaign_results cr WHERE cr.campaign_id = c.campaign_id) AS skipped_count
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
// PREVIEW CAMPAIGN
// ─────────────────────────────────────────────────────────────

/**
 * Resolve placeholders against a sample contact for preview.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.body
 * @param {string} [opts.subject]
 * @param {number} opts.contactId  — sample contact to resolve against
 * @returns {{ body, subject, unresolved }}
 */
async function previewCampaign(db, { body, subject, contactId }) {
  const refs = { contacts: { contact_id: contactId } };

  const resolvedBody = await resolve({ db, text: body, refs });

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
// EXECUTE SEND (called by job_executor for each contact)
// ─────────────────────────────────────────────────────────────

/**
 * Core send logic for one contact in a campaign.
 * Called by job_executor when processing a campaign_send job.
 *
 * Error handling strategy:
 *   - Infrastructure errors (DB down) → THROW → job system retries
 *   - Send errors (SMTP fail, bad number) → CATCH → record 'failed', return normally
 *   - Skips (canceled, opted out, missing phone/email) → record 'skipped', return normally
 *
 * @param {object} db
 * @param {number} campaignId
 * @param {number} contactId
 * @returns {object} { sent, skipped, failed, reason, messageId }
 */
async function executeSend(db, campaignId, contactId) {

  // ── 1. Load campaign ──

  const [[campaign]] = await db.query(
    'SELECT campaign_id, type, sender, subject, body, status FROM campaigns WHERE campaign_id = ?',
    [campaignId]
  );

  if (!campaign) {
    // Campaign deleted — record and move on
    await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'campaign_not_found' });
    return { skipped: true, reason: 'campaign_not_found' };
  }

  // ── 2. Check campaign status ──

  if (campaign.status === 'canceled') {
    await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'campaign_canceled' });
    await checkCompletion(db, campaignId);
    return { skipped: true, reason: 'campaign_canceled' };
  }

  // ── 3. Load contact ──

  const [[contact]] = await db.query(
    'SELECT contact_id, contact_name, contact_phone, contact_email, contact_sms_optout, contact_email_optout FROM contacts WHERE contact_id = ?',
    [contactId]
  );

  if (!contact) {
    await recordResult(db, campaignId, contactId, 'failed', 'Contact not found', null);
    await checkCompletion(db, campaignId);
    return { failed: true, reason: 'contact_not_found' };
  }

  // ── 4. Check opt-out ──

  if (campaign.type === 'sms' && contact.contact_sms_optout) {
    await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'sms_optout' });
    await checkCompletion(db, campaignId);
    return { skipped: true, reason: 'sms_optout' };
  }

  if (campaign.type === 'email' && contact.contact_email_optout) {
    await recordResult(db, campaignId, contactId, 'skipped', null, { reason: 'email_optout' });
    await checkCompletion(db, campaignId);
    return { skipped: true, reason: 'email_optout' };
  }

  // ── 5. Check required channel info ──

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

  // ── 6. Resolve placeholders ──

  const refs = { contacts: { contact_id: contactId } };

  const resolvedBody = await resolve({ db, text: campaign.body, refs });

  let resolvedSubject = null;
  if (campaign.type === 'email' && campaign.subject) {
    resolvedSubject = await resolve({ db, text: campaign.subject, refs });
  }

  // ── 7. Send ──

  try {
    let sendResult;

    if (campaign.type === 'sms') {
      sendResult = await smsService.sendSms(
        db,
        campaign.sender,
        contact.contact_phone,
        resolvedBody.text
      );
    } else {
      sendResult = await emailService.sendEmail(db, {
        from:    campaign.sender,
        to:      contact.contact_email,
        subject: resolvedSubject ? resolvedSubject.text : campaign.subject,
        html:    resolvedBody.text
      });
    }

    // ── 8. Record success ──

    await recordResult(db, campaignId, contactId, 'sent', null, {
      messageId: sendResult?.messageId || null,
      provider:  sendResult?.provider || null
    });

    await checkCompletion(db, campaignId);

    return { sent: true, messageId: sendResult?.messageId };

  } catch (sendErr) {
    // Send failed — record and return normally (don't throw).
    // Job system treats this as a successful execution.
    console.error(`[CAMPAIGN SEND] campaign=${campaignId} contact=${contactId} error:`, sendErr.message);

    await recordResult(db, campaignId, contactId, 'failed', sendErr.message, null);
    await checkCompletion(db, campaignId);

    return { failed: true, reason: sendErr.message };
  }
}


// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Record a per-contact result.
 * INSERT IGNORE prevents duplicates on job retry (requires UNIQUE on campaign_id + contact_id).
 */
async function recordResult(db, campaignId, contactId, status, error, meta) {
  await db.query(
    `INSERT IGNORE INTO campaign_results (campaign_id, contact_id, status, error, result_meta, sent_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [campaignId, contactId, status, error || null, meta ? JSON.stringify(meta) : null]
  );
}

/**
 * Check if all contacts have been processed. If so, finalize campaign status.
 * The WHERE status = 'sending' guard prevents overwriting a 'canceled' status.
 */
async function checkCompletion(db, campaignId) {
  const [[counts]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?) AS total,
       (SELECT COUNT(*) FROM campaign_results  WHERE campaign_id = ?) AS done`,
    [campaignId, campaignId]
  );

  if (counts.done < counts.total) return; // still in progress

  // All processed — determine final status from results
  const [[summary]] = await db.query(
    `SELECT
       SUM(status = 'sent')    AS sent,
       SUM(status = 'failed')  AS failed,
       SUM(status = 'skipped') AS skipped
     FROM campaign_results WHERE campaign_id = ?`,
    [campaignId]
  );

  // Coerce to Number — mysql2 may return SUM() as string or Decimal
  const sent    = Number(summary.sent    || 0);
  const failed  = Number(summary.failed  || 0);
  const skipped = Number(summary.skipped || 0);

  let finalStatus;
  if (failed === 0 && skipped === 0) {
    finalStatus = 'sent';
  } else if (sent === 0) {
    finalStatus = 'failed';
  } else {
    finalStatus = 'partial_fail';
  }

  const summaryObj = { sent, failed, skipped };

  await db.query(
    `UPDATE campaigns
     SET status = ?, result_summary = ?, updated_at = NOW()
     WHERE campaign_id = ? AND status IN ('sending', 'scheduled')`,
    [finalStatus, JSON.stringify(summaryObj), campaignId]
  );

  console.log(`[CAMPAIGN] Campaign ${campaignId} complete: ${finalStatus} (sent=${sent}, failed=${failed}, skipped=${skipped})`);
}


module.exports = {
  getFilteredContacts,
  createCampaign,
  cancelCampaign,
  getCampaign,
  listCampaigns,
  getCampaignResults,
  executeSend,
  previewCampaign
};