// routes/campaign.js
//
/**
 * Campaign Routes (redesigned)
 * routes/campaign.js
 *
 * Thin HTTP wrappers around campaignService.
 * All routes use JWT auth via jwtOrApiKey.
 *
 * Replaces the old POST /campaigns/trigger route entirely.
 *
 * Routes:
 *   GET    /campaigns/contacts      — filter contacts for selection
 *   GET    /campaigns/compose-options — marketing senders, topics, cap, switch state (C1)
 *   GET    /campaigns/segments      — saved segments for the Select tab (C4)
 *   POST   /campaigns/segments      — save the current filter as a segment (C4)
 *   PUT    /campaigns/segments/:id  — rename / re-point a segment (C4)
 *   PATCH  /campaigns/segments/:id  — archive / unarchive (C4)
 *   POST   /campaigns/preview       — resolve placeholders for preview
 *   POST   /campaigns               — create campaign + jobs
 *   GET    /campaigns               — list campaigns (paginated)
 *   GET    /campaigns/:id           — single campaign with results summary
 *   GET    /campaigns/:id/results   — per-contact result details
 *   PATCH  /campaigns/:id           — cancel, pause or resume a campaign
 *   POST   /campaigns/test-send     — marketing "send a test to me" (C2; campaigns.bulk)
 *   POST   /campaigns/transports/:id/release — lift a transport HOLD (C2; SU + step-up, audited)
 *
 * C1 (ref/YISRAMAIL_DESIGN.md §6.1): createCampaign is the gate for class,
 * cap, over-cap and the marketing kill switch (API keys reach it too); its
 * CampaignError refusals carry the HTTP status (400 / 403 / 409 / 422), a
 * `code` and extra fields (the over-cap refusal names the real `count`).
 */

const express       = require('express');
const router        = express.Router();
const jwtOrApiKey   = require('../lib/auth.jwtOrApiKey');
const campaignService = require('../services/campaignService');
const segmentService  = require('../services/campaignSegmentService');
const { superuserOnlyFor } = require('../lib/auth.superuser');

/** { route, method, ip, userAgent } for an audit row. */
function requestInfo(req) {
  return {
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

/** A CampaignError → its status + { error, code, ...extra }; anything else → null. */
function campaignErrorBody(err) {
  if (!err || err.name !== 'CampaignError') return null;
  return { status: err.status, body: { error: err.message, code: err.code, ...(err.extra || {}) } };
}

/** ?class= / ?topic= (contacts search, consent preview): validated, or a 400 message. */
function readClassTopic(klass, topic) {
  const k = klass == null || klass === '' ? 'operational' : klass;
  if (!campaignService.KLASSES.includes(k)) return { error: 'class must be "operational" or "marketing"' };
  const t = topic == null || topic === '' ? null : topic;
  if (t !== null && (typeof t !== 'string' || !campaignService.TOPIC_RE.test(t))) return { error: 'topic must be a topic key' };
  if (t !== null && k !== 'marketing') return { error: 'a topic applies to marketing campaigns only' };
  return { klass: k, topic: t };
}

// ─────────────────────────────────────────────────────────────
// GET /campaigns/contacts — filter contacts for campaign selection
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/contacts', jwtOrApiKey, async (req, res) => {
  try {
    const filters = {};

    if (req.query.tags) {
      filters.tags = req.query.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (req.query.case_type)       filters.case_type       = req.query.case_type;
    // 2026-06 type/subtype split: case_type is the CATEGORY ("Bankruptcy"),
    // case_subtype the refinement ("Chapter 7"). Independently optional —
    // type alone means "every subtype of that type".
    if (req.query.case_subtype)    filters.case_subtype    = req.query.case_subtype;
    if (req.query.case_stage)      filters.case_stage       = req.query.case_stage.split(',').map(s => s.trim());
    if (req.query.case_open_after) filters.case_open_after  = req.query.case_open_after;
    if (req.query.case_open_before) filters.case_open_before = req.query.case_open_before;
    if (req.query.channel)         filters.channel          = req.query.channel;
    // C1: the class (and marketing topic) decide the email opt-out question
    // (campaignService.consentOptsFor) — operational excludes no opt-out (D18).
    const ct = readClassTopic(req.query.class, req.query.topic);
    if (ct.error) return res.status(400).json({ error: ct.error });
    filters.klass = ct.klass;
    filters.topic = ct.topic;

    const result = await campaignService.getFilteredContacts(req.db, filters);
    res.json(result);
  } catch (err) {
    console.error('[GET /campaigns/contacts]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /campaigns/case-types — the case-type vocabulary that EXISTS
//
// Returns { case_types: { Type: [Subtype, ...] } } in fe-case_types shape, so
// the caller merges it straight over the registry map. Feeds the campaign
// contact filter, which must offer what the data contains rather than what
// the registry configures — the create dialogs' 'Other' free-text path means
// those two sets differ.
//
// MUST stay above /campaigns/:id, or 'case-types' is captured as an id.
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/case-types', jwtOrApiKey, async (req, res) => {
  try {
    res.json({ case_types: await campaignService.getCaseTypeFacets(req.db) });
  } catch (err) {
    console.error('[GET /campaigns/case-types]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /campaigns/compose-options — what the compose form offers (C1)
//
// { marketing_senders, topics, operational_cap, marketing_rate,
//   marketing_enabled, can_bulk }. The marketing senders are the bulk_ok rows
// firm-data's emailFrom leaves out (the T1 fence stays where it is: this is
// a separate, campaign-only source). Display only — createCampaign decides.
// MUST stay above /campaigns/:id.
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/compose-options', jwtOrApiKey, async (req, res) => {
  try {
    res.json(await campaignService.getComposeOptions(req.db, req.auth));
  } catch (err) {
    console.error('[GET /campaigns/compose-options]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Saved segments (C4, §6.2) — a named compose filter, re-run when
// picked; validation (unknown keys refused) in campaignSegmentService.
// MUST stay above /campaigns/:id, or 'segments' is captured as an id.
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/segments', jwtOrApiKey, async (req, res) => {
  try {
    const segments = await segmentService.listSegments(req.db, {
      q: req.query.q, includeArchived: req.query.include_archived === '1',
    });
    res.json({ segments });
  } catch (err) {
    console.error('[GET /campaigns/segments]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/campaigns/segments', jwtOrApiKey, async (req, res) => {
  try {
    res.json({ success: true, ...(await segmentService.createSegment(req.db, req.body, { userId: req.auth.userId })) });
  } catch (err) {
    const known = segmentService.segmentErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[POST /campaigns/segments]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/campaigns/segments/:id', jwtOrApiKey, async (req, res) => {
  try {
    res.json({ success: true, ...(await segmentService.updateSegment(req.db, req.params.id, req.body)) });
  } catch (err) {
    const known = segmentService.segmentErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[PUT /campaigns/segments/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/campaigns/segments/:id', jwtOrApiKey, async (req, res) => {
  try {
    await segmentService.setArchived(req.db, req.params.id, req.body ? req.body.archived : undefined);
    res.json({ success: true });
  } catch (err) {
    const known = segmentService.segmentErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[PATCH /campaigns/segments/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /campaigns/preview — resolve placeholders for one contact
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns/preview', jwtOrApiKey, async (req, res) => {
  const { body, subject, contactId, type } = req.body;

  if (!body || !contactId) {
    return res.status(400).json({ error: 'body and contactId are required' });
  }

  try {
    // type: 'email' (default — values HTML-escaped) | 'sms' (verbatim text)
    const result = await campaignService.previewCampaign(req.db, {
      body, subject, contactId, type: type === 'sms' ? 'sms' : 'email'
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /campaigns/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /campaigns — create a new campaign
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns', jwtOrApiKey, async (req, res) => {
  const { type, sender, subject, body, contactIds, scheduledTime, attachmentUrl, includeSignature, confirmCount } = req.body;

  if (!type || !sender || !body) {
    return res.status(400).json({ error: 'type, sender, and body are required' });
  }
  if (!contactIds || !Array.isArray(contactIds) || !contactIds.length) {
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  }

  try {
    const result = await campaignService.createCampaign(req.db, {
      type,
      sender,
      subject,
      body,
      contactIds,
      scheduledTime: scheduledTime || null,
      createdBy: req.auth.userId,
      attachmentUrl: attachmentUrl || null,
      includeSignature: includeSignature === true,
      // C1: absent class = operational; createCampaign validates the spelling.
      klass: req.body.class === undefined ? 'operational' : req.body.class,
      topicKey: req.body.topic_key ?? null,
      confirmCount: confirmCount ?? null,
      // C3: the Designer design the body came from (provenance; createCampaign validates it).
      designId: req.body.design_id ?? null,
      auth: req.auth,
      request: {
        route: req.originalUrl,
        method: req.method,
        ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });
    res.json(result);
  } catch (err) {
    const known = campaignErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[POST /campaigns]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /campaigns — list campaigns (paginated)
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns', jwtOrApiKey, async (req, res) => {
  try {
    const result = await campaignService.listCampaigns(req.db, {
      status: req.query.status || null,
      page:   req.query.page,
      limit:  req.query.limit
    });
    res.json(result);
  } catch (err) {
    console.error('[GET /campaigns]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /campaigns/:id — single campaign with results summary
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/:id', jwtOrApiKey, async (req, res) => {
  try {
    const campaign = await campaignService.getCampaign(req.db, parseInt(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (err) {
    console.error('[GET /campaigns/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /campaigns/:id/results — per-contact result details
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/:id/results', jwtOrApiKey, async (req, res) => {
  try {
    const results = await campaignService.getCampaignResults(req.db, parseInt(req.params.id));
    res.json(results);
  } catch (err) {
    console.error('[GET /campaigns/:id/results]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /campaigns/:id — cancel, pause or resume a campaign
//
//   { status: 'canceled' }  from draft / scheduled / sending / paused
//   { status: 'paused' }    from scheduled / sending (C1 — pending sends stay
//                           pending and defer themselves; the pump stops)
//   { status: 'sending' }   resume, from paused only (the pump restarts)
// Not found → 404; a transition the status does not allow → 409.
// ─────────────────────────────────────────────────────────────
router.patch('/api/campaigns/:id', jwtOrApiKey, async (req, res) => {
  const { status } = req.body;

  if (status !== 'canceled' && status !== 'paused' && status !== 'sending') {
    return res.status(400).json({ error: 'status must be "canceled", "paused" or "sending" (resume)' });
  }

  try {
    const id = parseInt(req.params.id);
    const result = status === 'canceled' ? await campaignService.cancelCampaign(req.db, id)
                 : status === 'paused'   ? await campaignService.pauseCampaign(req.db, id)
                 :                         await campaignService.resumeCampaign(req.db, id);
    res.json(result);
  } catch (err) {
    const known = campaignErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[PATCH /campaigns/:id]', err);

    const code = err.message.includes('not found') ? 404
               : err.message.includes('Cannot cancel') ? 409
               : 500;
    res.status(code).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /campaigns/test-send — marketing "send a test to me" (YisraMail C2)
//
// { sender, subject, body, topic_key, contactId, attachmentUrl? } → the
// marketing render for that contact, "[TEST] " subject, the same transport /
// headers / Reply-To, sent to the caller's own users.email. No token, no
// campaign row, no result row. Works while marketing_send_enabled is off
// (staff-to-self, before gate G1); needs campaigns.bulk (createCampaign's
// rule for marketing); 422 on a held transport.
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns/test-send', jwtOrApiKey, async (req, res) => {
  const { sender, subject, body, topic_key, contactId, attachmentUrl } = req.body || {};
  try {
    const result = await campaignService.testSendMarketing(req.db, {
      auth: req.auth, sender, subject, body, topicKey: topic_key ?? null, contactId, attachmentUrl: attachmentUrl || null,
    });
    res.json(result);
  } catch (err) {
    const known = campaignErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[POST /campaigns/test-send]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /campaigns/transports/:id/release — lift a marketing transport HOLD
//
// §6.5: the hold (email_credentials.held_at) is set by the complaint / bounce
// thresholds or an account-level provider refusal and is NEVER lifted
// automatically. SU + step-up (superuserOnlyFor, the consent-import pattern);
// the release and its admin_audit_log row commit together; an `info` alert
// follows. Paused campaigns stay paused (resume each). 404 / 409 not held.
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns/transports/:id/release', ...superuserOnlyFor(campaignService.RELEASE_TOOL), async (req, res) => {
  try {
    res.json(await campaignService.releaseTransport(req.db, req.params.id, { auth: req.auth, request: requestInfo(req) }));
  } catch (err) {
    const known = campaignErrorBody(err);
    if (known) return res.status(known.status).json(known.body);
    console.error('[POST /campaigns/transports/:id/release]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;