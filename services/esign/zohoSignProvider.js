// services/esign/zohoSignProvider.js
//
/**
 * Zoho Sign provider — Phase 1B.
 * services/esign/zohoSignProvider.js
 *
 * Implements the neutral EsignProvider contract documented in
 * services/esign/index.js. NOTHING Zoho-shaped crosses this boundary:
 * callers hand in buffers, neutral recipients and neutral placements, and get
 * back our own status vocabulary. Zoho's request_id is the only opaque value
 * that travels outward, and it does so as `providerId`.
 *
 * ── AUTH: why this file does NOT use lib/credentialInjection ────────────────
 * buildHeadersForCredential(db, id, url) is the correct outbound builder for
 * every OTHER service here, but it hardcodes `Authorization: Bearer ${token}`
 * (lib/credentialInjection.js:237). Zoho rejects Bearer; it requires the
 * scheme `Zoho-oauthtoken`. It also swallows failures and returns {}, which
 * would surface as a confusing "no Authorization header" error.
 *
 * So this provider calls oauthService.getValidAccessToken(db, credentialId)
 * directly — VERIFIED signature, services/oauthService.js:584 — and builds its
 * own header. That function still owns refresh, the cross-instance GET_LOCK
 * and the failure alerting, so nothing is lost by skipping the injector.
 *
 * The sync buildAuthHeaders(cred, url) is NEVER used here: it returns {} for
 * oauth2 credentials and breaks silently (AI_CONTEXT §21).
 *
 * ── SETTINGS ARE READ AT CALL TIME ──────────────────────────────────────────
 * Both `esign_credential_id` and `esign_test_mode` are re-read from
 * app_settings on every API call via services/settingsService. No module-level
 * or instance-level cache. Cost is one indexed lookup on a 45-row table;
 * the benefit is that flipping test mode off — the production cutover — takes
 * effect on every Cloud Run instance immediately, with no deploy and no TTL
 * window during which one instance still burns credits and another doesn't.
 *
 * (lib/firmConfig.js is the other settings reader in this repo. It is
 * deliberately NOT used: it is a SYNC reader over a fixed REGISTRY, built for
 * module-load-time consumers. Everything here is async, and firmConfig's 60s
 * TTL is exactly the staleness window test mode must not have.)
 *
 * ── HTTP CLIENT ─────────────────────────────────────────────────────────────
 * Native fetch + AbortController, matching services/dropboxService.js.
 * `axios` is in package.json but is required by ZERO files in the repo —
 * do not reintroduce it here. Multipart uses native FormData + Blob, exactly
 * as services/adapters/phone/ringcentral.js:72 does. NO new dependency.
 *
 * ── ZOHO'S TWO ERROR CHANNELS ───────────────────────────────────────────────
 * A non-2xx status is one. The other is a 2xx body carrying a non-zero `code`
 * (0 means success in every Zoho Sign response). Both are normalized into the
 * same typed error here; checking only res.ok would let failures through.
 */

const oauthService = require('../oauthService');
const { getSettings } = require('../settingsService');
const { validatePlacements, NEUTRAL_PAGE_BASE } = require('./placements');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_NAME = 'zoho_sign';

/**
 * US data center. Pinned by credential 13's config, whose auth_url is
 * https://accounts.zoho.com/oauth/v2/auth (verified live 2026-07-19). An EU /
 * IN / AU account would need sign.zoho.eu / .in / .com.au respectively — if
 * the credential is ever re-pointed to another DC this constant must move
 * with it, which is why it is named and commented rather than inlined.
 */
const API_BASE = 'https://sign.zoho.com/api/v1';

const DEFAULT_TIMEOUT_MS  = 30000;   // spec: 30s default for JSON calls
const DOWNLOAD_TIMEOUT_MS = 60000;   // binaries get longer, same posture as
                                     // dropboxService (RPC 30s / CONTENT 120s)

/** listInProgress paging. row_count is Zoho's page size; CAP is our own guard. */
const LIST_PAGE_SIZE = 100;
const LIST_ROW_CAP   = 500;

/**
 * Default page geometry for the coordinate transform, in PDF points.
 * 612x792 = US Letter. Every federal bankruptcy form this firm sends is
 * Letter; A4 would be 595x842. Callers override per-request via pageInfo.
 */
const DEFAULT_PAGE = Object.freeze({ width: 612, height: 792 });

/**
 * Neutral `page` numbers are 1-BASED (the schema's example is "page":3).
 * Zoho's page_no is 0-BASED (every documented example places on page_no 0).
 * ASSUMPTION — see the assumption block above neutralToZohoFields.
 *
 * The constant itself now lives in ./placements (it is a property of the
 * NEUTRAL schema, not of Zoho) and is imported above. Re-exported unchanged so
 * existing importers of this module see no difference.
 */

/**
 * Neutral field type → Zoho field descriptor.
 *
 * field_category is NOT cosmetic: Zoho routes the field to its editor by
 * category, and an omitted/incorrect one is a common cause of a silently
 * misrendered field. Values below are taken verbatim from Zoho's
 * "How to add different signer fields" reference
 * (zoho.com/sign/api/how-tos/signer-fields.html).
 *
 * ── `date` — VERIFIED 2026-07-19, was an assumption in 1B ────────────────────
 *
 * Zoho exposes TWO datefield types, and they are NOT interchangeable:
 *
 *   Date        auto-stamped signing date. "Basic info" in Zoho's own UI
 *               taxonomy, alongside Full Name / Email / Company / Job Title —
 *               populated by the ACT of signing, not typed by the signer.
 *   CustomDate  a signer-editable date picker. "Input fields" in the same
 *               taxonomy, alongside Textfield / Checkbox / Dropdown. Used when
 *               the sender wants an arbitrary past/future date (a DOB, say).
 *
 * The firm wants the signing date, so 'Date' is correct. Both carry
 * field_category 'datefield' — confirmed against GET /api/v1/requests/
 * fieldtypes, which lists field_type_id 2000000000151 as
 * {field_category:'datefield', field_type_name:'Date', is_mandatory:true} and
 * 10696000000005001 as {field_category:'datefield', ..., 'CustomDate'}. So the
 * category below is right for either type and needs no change.
 *
 * `date_format` IS DELIBERATELY NOT SENT. Zoho documents it only under the
 * CustomDate example ("field_category to be set as 'datefield' and date_format
 * param to be passed" — zoho.com/sign/api/how-tos/signer-fields.html, Date
 * category section, whose sole worked example is CustomDate). There is no
 * published example of date_format on a `Date` field, and 1B's smoke run
 * proved Zoho is NOT uniformly tolerant of unrecognized keys — GET /requests
 * returned code 9043 "Extra key found" for exactly that class of mistake. An
 * undocumented param on the one call that spends credits is not worth the
 * cosmetic upside; an auto-stamped date takes its format from the account /
 * document settings anyway.
 *
 * ── FALLBACK LADDER, if the deploy-time checkpoint contradicts the above ─────
 * The checkpoint (scripts/esign_e2e_check.js) is where this gets settled live;
 * nothing here has been sent to Zoho as 'Date' yet. In order:
 *
 *   1. Date renders in a non-US format  → add `date_format: 'MM/dd/yyyy'` back
 *      to the entry below. One line. (Firm is Michigan.)
 *   2. Date 400s, or renders as a signer-EDITABLE picker → revert to
 *      { field_type_name: 'CustomDate', field_category: 'datefield',
 *        date_format: 'MM/dd/yyyy', is_read_only: true }
 *      `is_read_only` is documented — it appears in Zoho's own submit and
 *      update-document field examples — and is the supported way to make a
 *      CustomDate non-editable. neutralToZohoFields already copies
 *      `date_format` through when the entry carries it; `is_read_only` would
 *      need the same one-line passthrough.
 */
const FIELD_TYPES = Object.freeze({
  signature: { field_type_name: 'Signature',  field_category: 'image'     },
  initial:   { field_type_name: 'Initial',    field_category: 'image'     },
  date:      { field_type_name: 'Date',       field_category: 'datefield' },
});

/**
 * Zoho document-level request_status → OUR status vocabulary
 * (esignService.STATUSES).
 *
 * Exported because slice 1C's webhook route must map the SAME strings the same
 * way; two copies of this table would drift and produce a subsystem where the
 * poller and the webhook disagree about what state a document is in.
 *
 * UNKNOWN VALUES MAP TO null, DELIBERATELY. The alternative — defaulting an
 * unrecognized Zoho status to 'sent' — would feed a wrong value into
 * esignService.applyStatus and could drive a real state transition off a
 * string we do not understand. null is loud, non-fatal, and the caller still
 * receives the raw string as `providerStatus`, so nothing is lost.
 */
const ZOHO_REQUEST_STATUS_MAP = Object.freeze({
  draft:       'draft',
  inprogress:  'sent',
  completed:   'signed',
  declined:    'declined',
  recalled:    'recalled',
  expired:     'expired',
});

/**
 * Zoho recipient-level action_status → our per-recipient status.
 *
 * These land in signing_requests.recipients[].status, which esignService
 * stores as free-text String (_normalizeRecipients), so they are not bound by
 * STATUSES — but they are kept aligned with it anyway so one vocabulary reads
 * across the whole subsystem.
 *
 * NOACTION means "sequential signing, not their turn yet". With
 * is_sequential:false it should never appear; mapped anyway because a future
 * sequential document would produce it.
 *
 * UNVERIFIED: 'BOUNCED' and 'EXPIRED' are inferred, not observed — Zoho's
 * docs enumerate only NOACTION / UNOPENED / VIEWED / SIGNED for action_status.
 * They are included because our vocabulary has somewhere sensible to put them;
 * anything genuinely unrecognized falls through to null (same reasoning as
 * the document-level table).
 */
const ZOHO_ACTION_STATUS_MAP = Object.freeze({
  NOACTION:  'pending',
  UNOPENED:  'sent',
  VIEWED:    'viewed',
  SIGNED:    'signed',
  APPROVED:  'signed',    // action_type APPROVER completes the same way
  DECLINED:  'declined',
  RECALLED:  'recalled',
  EXPIRED:   'expired',   // UNVERIFIED
  BOUNCED:   'bounced',   // UNVERIFIED
});

/** Document statuses we consider still outstanding, for listInProgress. */
const ZOHO_IN_PROGRESS_STATUSES = Object.freeze(['inprogress']);

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every non-2xx (and every 2xx carrying a non-zero Zoho `code`) becomes this.
 * The raw fetch/undici error NEVER escapes — callers get one shape to switch
 * on, and .providerCode/.providerMessage preserve Zoho's own diagnosis.
 */
function providerError(method, path, httpStatus, parsed, rawText) {
  const providerCode    = parsed && parsed.code    != null ? parsed.code    : null;
  const providerMessage = parsed && parsed.message != null ? String(parsed.message) : null;
  // Zoho names the offending parameter in `error_param` — e.g. the 9011
  // "too many characters" hunt of 2026-07-20 would have been a one-look
  // diagnosis had this been surfaced. Keep it, and keep the raw body.
  const providerParam   = parsed && parsed.error_param != null ? String(parsed.error_param) : null;
  const detail = providerMessage
    ? (providerParam ? `${providerMessage} (param: ${providerParam})` : providerMessage)
    : (rawText ? String(rawText).slice(0, 500) : '(empty body)');

  const err = new Error(`zoho_sign: ${method} ${path} → ${httpStatus}: ${detail}`);
  err.code            = 'ESIGN_PROVIDER_ERROR';
  err.provider        = PROVIDER_NAME;
  err.httpStatus      = httpStatus;
  err.providerCode    = providerCode;
  err.providerMessage = providerMessage;
  err.providerParam   = providerParam;
  err.providerRaw     = rawText ? String(rawText).slice(0, 2000) : null;
  return err;
}

/** Token acquisition/refresh failure. Wraps oauthService's own message. */
function authError(credentialId, cause) {
  const err = new Error(
    `zoho_sign: could not obtain access token for credential ${credentialId}: ${cause.message}`
  );
  err.code     = 'ESIGN_AUTH_ERROR';
  err.provider = PROVIDER_NAME;
  err.cause    = cause;
  return err;
}

/** Caller-side misuse (bad placement, missing recipient, ...). */
function inputError(message) {
  const err = new Error(`zoho_sign: ${message}`);
  err.code     = 'ESIGN_INVALID_INPUT';
  err.provider = PROVIDER_NAME;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Neutral placements → Zoho field objects, grouped by signer.
 *
 * PURE. No ids, no network, no db — so it is fully unit-testable, and so that
 * a wrong assumption below is a localized edit rather than a rewrite.
 * sendForSignature calls bindFieldsToActions() afterwards to stamp the
 * document_id / action_id that only exist post-create.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY ASSUMPTION IN THIS TRANSFORM — the smoke run verifies these.        ║
 * ║                                                                          ║
 * ║ 1. ORIGIN CORNER. Neutral is pdf_user_space: origin BOTTOM-left, y grows ║
 * ║    upward. Zoho is TOP-left, y grows downward — stated outright in       ║
 * ║    zoho.com/sign/api/getting-started-guide/basic-concepts/actions.html:  ║
 * ║    "The coordinate system of documents has the origin positioned at the  ║
 * ║    top left corner of the PDF."  So the y axis is FLIPPED here.          ║
 * ║                                                                          ║
 * ║ 2. WHICH CORNER THE POINT NAMES. Neutral (x,y) is the BOTTOM-left corner ║
 * ║    of the field box (PDF rect convention). Zoho's (x_coord,y_coord) is   ║
 * ║    taken to be the TOP-left corner. Hence  y_zoho = pageH - y - h,       ║
 * ║    not  pageH - y.  If fields land exactly one field-height too LOW,     ║
 * ║    this is the wrong assumption: drop the "- h".                         ║
 * ║                                                                          ║
 * ║ 3. UNITS. Neutral is PDF points (72dpi). Zoho's x_coord/y_coord/         ║
 * ║    abs_width/abs_height are ALSO points — derived, not assumed. In       ║
 * ║    Zoho's own get-document-details response:                             ║
 * ║        x_coord 454 ÷ x_value 74.11568%  = 612.5                          ║
 * ║        abs_width 135 ÷ width 22.045263% = 612.4   → page width  612      ║
 * ║        y_coord  66 ÷ y_value  8.354922% = 790.0   → page height 792      ║
 * ║    612x792 is US Letter in points. Confirmed a second time against the   ║
 * ║    self-sign example, which resolves to 595x842 (A4). So points it is,   ║
 * ║    and NO scaling factor is applied.                                     ║
 * ║                                                                          ║
 * ║ 4. ABSOLUTE **AND** PERCENT ARE BOTH SENT. Zoho accepts x_coord/abs_*    ║
 * ║    (points) and x_value/width (percent of page). Its how-to examples use ║
 * ║    percent only; its self-sign example sends both. Both are emitted      ║
 * ║    here, computed from the same page geometry so they cannot disagree,   ║
 * ║    which means the field still lands correctly whichever pair Zoho       ║
 * ║    actually honours. If the smoke run shows one pair being ignored,      ║
 * ║    delete the other — the placement is unaffected.                       ║
 * ║                                                                          ║
 * ║ 5. PAGE INDEX BASE. Neutral page is 1-BASED; Zoho page_no is 0-BASED.    ║
 * ║    Subtracted via NEUTRAL_PAGE_BASE. If the field lands on the page      ║
 * ║    BEFORE the intended one, set NEUTRAL_PAGE_BASE = 0.                   ║
 * ║                                                                          ║
 * ║ 6. SIGNER BINDING. Neutral `signer` is 1-based and matches the           ║
 * ║    recipient's `order`, NOT an array index. Field n attaches to the      ║
 * ║    action whose recipient order === signer.                              ║
 * ║                                                                          ║
 * ║ 7. PAGE GEOMETRY IS NOT READ FROM THE PDF. Percent coords need page      ║
 * ║    dimensions and this layer never parses the buffer, so it trusts       ║
 * ║    pageInfo and falls back to US Letter. A non-Letter page silently      ║
 * ║    skews only the PERCENT pair; the absolute pair stays correct.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * @param {object} placements  neutral schema:
 *   { coord_space: 'pdf_user_space',
 *     fields: [{ page, x, y, w, h, type: 'signature'|'initial'|'date', signer }] }
 * @param {object} [pageInfo]  { width, height } in points, and/or
 *                             { pages: { <1-based page>: {width,height} } }.
 *                             Defaults to US Letter.
 * @returns {object} { bySigner: { <signer>: [zohoField, ...] }, count }
 */
function neutralToZohoFields(placements, pageInfo) {
  // Schema validation lives in ./placements so the send service can run the
  // SAME rules before it mints a draft row. Throws ESIGN_INVALID_INPUT, which
  // is what this function threw before the extraction — callers unchanged.
  validatePlacements(placements);
  const { fields } = placements;

  const defaultPage = {
    width:  Number(pageInfo?.width)  > 0 ? Number(pageInfo.width)  : DEFAULT_PAGE.width,
    height: Number(pageInfo?.height) > 0 ? Number(pageInfo.height) : DEFAULT_PAGE.height,
  };
  const perPage = pageInfo?.pages || {};

  const bySigner = {};
  let count = 0;

  fields.forEach((f, i) => {
    // Shape, type, page base and geometry finiteness were all settled by
    // validatePlacements above. What remains here is transform, not checking.

    // TEXT fields (Phase 2E) are filled locally by services/esign/pdfFill.js
    // before the document is uploaded — the value is already ink on the page
    // by the time Zoho sees it. Transmitting them would put an empty editable
    // box ON TOP of the filled value. They are not this provider's business.
    if (f.type === 'text') return;

    const spec = FIELD_TYPES[f.type];

    const signer = Number.isInteger(f.signer) ? f.signer : 1;
    const page   = Number.isInteger(f.page)   ? f.page   : NEUTRAL_PAGE_BASE;
    const pageNo = page - NEUTRAL_PAGE_BASE;

    const geom = perPage[page] || perPage[String(page)] || defaultPage;
    const pw = Number(geom.width)  > 0 ? Number(geom.width)  : defaultPage.width;
    const ph = Number(geom.height) > 0 ? Number(geom.height) : defaultPage.height;

    const x = Number(f.x), y = Number(f.y), w = Number(f.w), h = Number(f.h);

    // THE FLIP (assumptions 1 + 2).
    const yTop = ph - y - h;

    const field = {
      field_name:       `${spec.field_type_name}_${i + 1}`,  // unique per document
      field_label:      spec.field_type_name,
      field_type_name:  spec.field_type_name,
      field_category:   spec.field_category,
      is_mandatory:     f.required === false ? false : true,
      page_no:          pageNo,
      // absolute, points — INTEGERS, not round2. Zoho's columns for the
      // absolute set reject decimal values with 9011 "You have entered too
      // many characters" (error_param: x_coord) — proven live 2026-07-20 by
      // an A/B submit pair on request …49119: identical payloads, decimal
      // x_coord 400s, integer x_coord sends. The 1B/1C smokes never tripped
      // it because their hand-written placements were integer points; every
      // editor-drawn box has decimals. The percent set below carries the
      // sub-point precision (Zoho's own docs show 6-decimal percents), so
      // rounding here loses nothing visible at signing.
      x_coord:          Math.round(x),
      y_coord:          Math.round(yTop),
      abs_width:        Math.round(w),
      abs_height:       Math.round(h),
      // percent of page — same geometry, so these can never contradict the above
      x_value:          round4((x    / pw) * 100),
      y_value:          round4((yTop / ph) * 100),
      width:            round4((w    / pw) * 100),
      height:           round4((h    / ph) * 100),
    };
    if (spec.date_format) field.date_format = spec.date_format;

    (bySigner[signer] || (bySigner[signer] = [])).push(field);
    count += 1;
  });

  return { bySigner, count };
}

/**
 * Stamp the ids that only exist after POST /requests onto transformed fields.
 * Split out from neutralToZohoFields so the geometry stays pure and testable.
 *
 * @param {object} bySigner   from neutralToZohoFields
 * @param {Array}  actions    Zoho actions from the create response
 * @param {Array}  recipients neutral recipients, index-aligned with actions
 * @param {string} documentId Zoho document (file) id the fields sit on
 * @returns {Array} actions payload for the submit call
 */
function bindFieldsToActions(bySigner, actions, recipients, documentId) {
  return actions.map((action, idx) => {
    const recip  = recipients[idx] || {};
    const order  = Number.isInteger(recip.order) ? recip.order : idx + 1;
    const fields = (bySigner[order] || []).map((f) => ({
      ...f,
      document_id: documentId,
      action_id:   action.action_id,
    }));

    return {
      action_id:        action.action_id,
      action_type:      action.action_type || 'SIGN',
      recipient_name:   action.recipient_name,
      recipient_email:  action.recipient_email,
      verify_recipient: false,
      fields,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS MAPPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Document status, refined by recipient progress.
 *
 * Zoho has ONE in-flight status ('inprogress'); we distinguish 'sent' from
 * 'viewed'. So the table gives the base answer and this promotes 'sent' to
 * 'viewed' the moment any recipient has opened it. esignService's transition
 * table allows sent → viewed, so the promotion is always a legal move.
 *
 * @returns {string|null} our status, or null for an unrecognized Zoho status
 */
function mapRequestStatus(zohoStatus, actions = []) {
  const base = ZOHO_REQUEST_STATUS_MAP[String(zohoStatus || '').toLowerCase()];
  if (base === undefined) {
    console.warn(`[zohoSignProvider] unmapped request_status "${zohoStatus}" → null`);
    return null;
  }
  if (base === 'sent' && Array.isArray(actions)) {
    const anyViewed = actions.some(
      (a) => ZOHO_ACTION_STATUS_MAP[String(a?.action_status || '').toUpperCase()] === 'viewed'
    );
    if (anyViewed) return 'viewed';
  }
  return base;
}

/** Recipient status. null (with a warn) for anything unrecognized. */
function mapActionStatus(zohoActionStatus) {
  const mapped = ZOHO_ACTION_STATUS_MAP[String(zohoActionStatus || '').toUpperCase()];
  if (mapped === undefined) {
    console.warn(`[zohoSignProvider] unmapped action_status "${zohoActionStatus}" → null`);
    return null;
  }
  return mapped;
}

/** Zoho epoch-ms or "May 21 2019 14:01 IST" → ISO string, or null. */
function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return new Date(n).toISOString();
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

class ZohoSignProvider {
  /**
   * @param {object} db                 mysql2 promise pool
   * @param {object} opts
   * @param {number|string} opts.credentialId  resolved by the factory; used as
   *        the fallback if the app_settings row is deleted mid-flight
   */
  constructor(db, { credentialId } = {}) {
    if (!db) throw inputError('db is required');
    this.db = db;
    this.name = PROVIDER_NAME;
    this.credentialId = credentialId;
  }

  // ── config / auth ─────────────────────────────────────────────────────────

  /** Re-read both settings. Called per API call — see header note. */
  async _config() {
    let rows = {};
    try {
      rows = await getSettings(this.db, ['esign_credential_id', 'esign_test_mode']);
    } catch (err) {
      // A settings read failure must not silently flip test mode OFF and start
      // spending credits. Fall back to the factory-resolved credential and to
      // testing=true, the safe direction.
      console.warn(`[zohoSignProvider] settings read failed, using safe defaults: ${err.message}`);
      return { credentialId: this.credentialId, testing: true };
    }
    const credRaw = rows.esign_credential_id;
    const credentialId =
      credRaw != null && String(credRaw).trim() !== '' ? String(credRaw).trim() : this.credentialId;

    // Anything other than an explicit '0' means test mode. A typo'd or blank
    // value therefore costs nothing instead of costing 5 credits an envelope.
    const testing = String(rows.esign_test_mode ?? '1').trim() !== '0';

    return { credentialId, testing };
  }

  async _authHeader(credentialId) {
    let token;
    try {
      token = await oauthService.getValidAccessToken(this.db, credentialId);
    } catch (err) {
      throw authError(credentialId, err);
    }
    if (!token) throw authError(credentialId, new Error('empty access token'));
    return { Authorization: `Zoho-oauthtoken ${token}` };
  }

  // ── transport ─────────────────────────────────────────────────────────────

  /**
   * One request. Normalizes BOTH Zoho error channels (non-2xx, and 2xx with
   * non-zero `code`) into a typed ESIGN_PROVIDER_ERROR.
   *
   * @param {string} method
   * @param {string} path        e.g. '/requests/123/submit'
   * @param {object} [o]
   * @param {object} [o.query]   query params
   * @param {FormData} [o.form]  multipart body (Content-Type auto-set by undici)
   * @param {object} [o.form_urlencoded]  x-www-form-urlencoded body
   * @param {'json'|'buffer'} [o.expect='json']
   */
  async _request(method, path, {
    query, form, form_urlencoded: urlencoded, expect = 'json', timeoutMs,
  } = {}) {
    const { credentialId } = await this._config();
    const headers = await this._authHeader(credentialId);

    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let body;
    if (form) {
      // DO NOT set Content-Type — undici derives multipart boundary from the
      // FormData body. Same note as services/adapters/phone/ringcentral.js.
      body = form;
    } else if (urlencoded) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(urlencoded)) p.set(k, String(v));
      body = p.toString();
    }

    const controller = new AbortController();
    const budget = timeoutMs ?? (expect === 'buffer' ? DOWNLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const tHandle = setTimeout(() => controller.abort(), budget);

    let res;
    try {
      res = await fetch(url.toString(), { method, headers, body, signal: controller.signal });
    } catch (err) {
      // Network/abort. Still a typed provider error — the raw undici error
      // never escapes this module.
      const wrapped = providerError(method, path, 0, null,
        err.name === 'AbortError' ? `timed out after ${budget}ms` : err.message);
      throw wrapped;
    } finally {
      clearTimeout(tHandle);
    }

    if (expect === 'buffer') {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw providerError(method, path, res.status, safeJson(text), text);
      }
      return Buffer.from(await res.arrayBuffer());
    }

    const text = await res.text();
    const parsed = safeJson(text);

    if (!res.ok) throw providerError(method, path, res.status, parsed, text);

    // Channel two: HTTP 200 with a non-zero Zoho code.
    if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
      throw providerError(method, path, res.status, parsed, text);
    }
    return parsed;
  }

  // ── contract: sendForSignature ────────────────────────────────────────────

  /**
   * Upload + send. TWO Zoho calls: create (multipart) then submit.
   *
   * The split is not optional — Zoho mints action_id and document_id during
   * create, and field placements cannot be expressed without them.
   *
   * @param {object} o
   * @param {Buffer} o.pdfBuffer
   * @param {string} o.documentName
   * @param {Array}  o.recipients   [{name, email, order}]
   * @param {object} o.placements   neutral schema (see neutralToZohoFields)
   * @param {number} [o.expirationDays=14]  matches contract_templates
   *        .expiration_days DEFAULT 14 (verified live), so a template that
   *        does not override it and a caller that passes nothing agree.
   * @param {boolean} [o.testing]   overrides the esign_test_mode setting
   * @param {object} [o.pageInfo]   page geometry for the percent coords
   * @returns {Promise<{providerId:string, status:string|null, providerStatus:string, raw:object}>}
   */
  async sendForSignature({
    pdfBuffer, documentName, recipients, placements,
    expirationDays = 14, testing, pageInfo,
  } = {}) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
      throw inputError('pdfBuffer must be a non-empty Buffer');
    }
    if (!documentName || typeof documentName !== 'string') {
      throw inputError('documentName is required');
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw inputError('at least one recipient is required');
    }

    const cfg = await this._config();
    const isTesting = testing === undefined ? cfg.testing : Boolean(testing);
    // Zoho ignores unknown query params, so sending testing=true on BOTH calls
    // is safe; omitting it on submit (the call that actually spends credits)
    // would not be.
    const testQuery = isTesting ? { testing: 'true' } : {};

    // Transform BEFORE the network call — a bad placement should cost zero
    // API calls and zero credits.
    const { bySigner } = neutralToZohoFields(placements || { fields: [] }, pageInfo);

    // ── 1. create ───────────────────────────────────────────────────────────
    const actionsIn = recipients.map((r, i) => {
      const email = String(r?.email || '').trim();
      if (!email) throw inputError(`recipients[${i}].email is required`);
      return {
        recipient_name:  r.name == null ? '' : String(r.name),
        recipient_email: email,
        action_type:     'SIGN',
        // Neutral order is 1-based; Zoho signing_order is 0-based.
        // Immaterial while is_sequential is false, correct if it ever isn't.
        signing_order:   (Number.isInteger(r.order) ? r.order : i + 1) - 1,
        verify_recipient: false,
      };
    });

    const createPayload = {
      requests: {
        request_name:   documentName,
        expiration_days: expirationDays,
        // FALSE by design: joint debtors sign in parallel, not in a queue.
        is_sequential:  false,
        actions:        actionsIn,
      },
    };

    const form = new FormData();
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `${documentName}.pdf`);
    form.append('data', JSON.stringify(createPayload));

    const created = await this._request('POST', '/requests', { query: testQuery, form });

    const req = created?.requests || {};
    const providerId = req.request_id != null ? String(req.request_id) : null;
    if (!providerId) {
      throw providerError('POST', '/requests', 200, created,
        'create succeeded but no requests.request_id in response');
    }

    const actions = Array.isArray(req.actions) ? req.actions : [];
    const docs    = Array.isArray(req.document_ids) ? req.document_ids : [];
    const documentId = docs[0]?.document_id != null ? String(docs[0].document_id) : null;
    if (!documentId) {
      throw providerError('POST', '/requests', 200, created,
        `create succeeded (request_id ${providerId}) but returned no document_ids`);
    }

    // ── 2. submit ───────────────────────────────────────────────────────────
    // NOTE: Zoho REQUIRES every non-VIEW action to carry at least one field or
    // the submit is rejected. A caller sending zero placements will therefore
    // get a provider error from Zoho, which is the correct outcome — better a
    // loud 4xx than an envelope nobody can sign.
    const submitPayload = {
      requests: { actions: bindFieldsToActions(bySigner, actions, recipients, documentId) },
    };

    const submitted = await this._request('POST', `/requests/${encodeURIComponent(providerId)}/submit`, {
      query: testQuery,
      form_urlencoded: { data: JSON.stringify(submitPayload) },
    });

    const sReq = submitted?.requests || {};
    const providerStatus = sReq.request_status || 'inprogress';

    return {
      providerId,
      status: mapRequestStatus(providerStatus, sReq.actions),
      providerStatus,
      testing: isTesting,
      raw: submitted,
    };
  }

  // ── contract: recall ──────────────────────────────────────────────────────

  /**
   * Cancel an in-flight envelope.
   *
   * VERIFIED: POST /api/v1/requests/{id}/recall, no body, no parameters
   * (zoho.com/sign/api/document-managment/recall-document.html).
   *
   * `reason` IS NOT SENT — Zoho's recall endpoint accepts no such field, a
   * limitation users have raised on their forum and Zoho has not addressed.
   * It stays in this signature because the neutral contract wants it and
   * because 1C should record it locally on the signing_request_events row.
   * (PUT /requests/{id}/delete does take a reason, but it DELETES the
   * document rather than recalling it — not a substitute.)
   */
  async recall(providerId, reason) {
    if (!providerId) throw inputError('providerId is required');
    const raw = await this._request('POST', `/requests/${encodeURIComponent(String(providerId))}/recall`);
    return { status: 'recalled', reasonSentToProvider: false, reason: reason ?? null, raw };
  }

  // ── contract: remind ──────────────────────────────────────────────────────

  /**
   * Re-send the signing invitation.
   *
   * VERIFIED IN DOCS: POST /api/v1/requests/{id}/remind, no parameters
   * (zoho.com/sign/api/document-managment/remind-recipient.html).
   *
   * §12 OPEN ITEM — the docs say it exists; whether it is enabled on this
   * firm's API-ONLY plan is exactly what the smoke script settles. On a 4xx
   * the caller receives the normal typed error with .httpStatus and
   * .providerCode intact, so the smoke output shows the raw verdict.
   *
   * `recipientEmail` IS NOT SENT — Zoho reminds every pending recipient and
   * exposes no per-recipient parameter. Kept in the signature for the neutral
   * contract; `remindedAll: true` in the return makes the behaviour explicit
   * so a caller never believes it nudged one person.
   */
  async remind(providerId, recipientEmail) {
    if (!providerId) throw inputError('providerId is required');
    const raw = await this._request('POST', `/requests/${encodeURIComponent(String(providerId))}/remind`);
    return { ok: true, remindedAll: true, recipientEmail: recipientEmail ?? null, raw };
  }

  // ── contract: getStatus ───────────────────────────────────────────────────

  /**
   * VERIFIED: GET /api/v1/requests/{id}
   * (zoho.com/sign/api/document-managment/get-details-of-a-particular-document.html)
   *
   * @returns {Promise<{status, providerStatus, recipients:Array, raw}>}
   */
  async getStatus(providerId) {
    if (!providerId) throw inputError('providerId is required');
    const raw = await this._request('GET', `/requests/${encodeURIComponent(String(providerId))}`);
    const req = raw?.requests || {};
    const actions = Array.isArray(req.actions) ? req.actions : [];

    return {
      status:         mapRequestStatus(req.request_status, actions),
      providerStatus: req.request_status ?? null,
      recipients: actions.map((a, i) => ({
        name:      a.recipient_name ?? null,
        email:     String(a.recipient_email || '').trim().toLowerCase(),
        // Zoho signing_order is 0-based; our neutral order is 1-based.
        order:     Number.isFinite(Number(a.signing_order)) ? Number(a.signing_order) + 1 : i + 1,
        status:    mapActionStatus(a.action_status),
        signed_at: toIso(a.signed_time ?? a.action_time ?? null),
        // Zoho does not return signer IP on this endpoint; it lives only in
        // the completion certificate PDF. null, not invented.
        ip:        a.ip_address ?? null,
      })),
      raw,
    };
  }

  // ── contract: downloads ───────────────────────────────────────────────────

  /**
   * VERIFIED: GET /api/v1/requests/{id}/pdf
   * (zoho.com/sign/api/document-managment/download-pdf.html)
   * Optional params: with_coc, merge, password.
   *
   * WARNING for 1D/Dropbox filing: if the envelope holds MULTIPLE files Zoho
   * returns a ZIP, not a PDF. Single-file envelopes — all this firm sends —
   * return application/pdf. Caller should sniff the magic bytes before
   * assuming; %PDF vs PK.
   */
  async downloadSignedPdf(providerId, { withCoc = false, merge = false } = {}) {
    if (!providerId) throw inputError('providerId is required');
    const query = {};
    if (withCoc) query.with_coc = 'true';
    if (merge)   query.merge    = 'true';
    return this._request('GET', `/requests/${encodeURIComponent(String(providerId))}/pdf`, {
      query, expect: 'buffer',
    });
  }

  /**
   * VERIFIED: GET /api/v1/requests/{id}/completioncertificate
   * (zoho.com/sign/api/document-managment/download-completion-certificate.html)
   * Note the path is `completioncertificate` — one word, no separator, and
   * NOT `/certificate`.
   */
  async downloadCompletionCertificate(providerId) {
    if (!providerId) throw inputError('providerId is required');
    return this._request('GET',
      `/requests/${encodeURIComponent(String(providerId))}/completioncertificate`,
      { expect: 'buffer' });
  }

  // ── contract: getCreditBalance ────────────────────────────────────────────

  /**
   * ⚠ NO DOCUMENTED CREDIT-BALANCE ENDPOINT EXISTS.
   *
   * Zoho Sign's public API reference documents no credits/balance call. The
   * only account-scoped endpoint is GET /api/v1/accounts (referenced in
   * zoho.com/sign/api/getting-started.html), whose response shape Zoho does
   * not publish. Credential 13 holds ZohoSign.account.READ, so we can call it.
   *
   * Strategy: call it, walk the response for a plausibly credit-shaped
   * numeric key, and return null if none is found. `raw` always comes back so
   * the smoke run can settle it by inspection.
   *
   * 1C's low-credit alert depends on this answer. If the smoke output shows no
   * credit field, that alert CANNOT be built on the API and must instead be
   * driven from a manual figure in app_settings plus an envelope counter — the
   * API-only plan bills 5 credits per envelope, so a local counter is a viable
   * substitute. Decide that after the smoke run, not before.
   */
  async getCreditBalance() {
    let raw;
    try {
      raw = await this._request('GET', '/accounts');
    } catch (err) {
      // Not fatal: a missing/forbidden endpoint answers the question too.
      return { credits: null, supported: false, error: err.message, raw: null };
    }
    const credits = findCreditNumber(raw);
    return {
      credits,
      supported: credits !== null,
      raw,
    };
  }

  // ── contract: listInProgress ──────────────────────────────────────────────

  /**
   * VERIFIED: GET /api/v1/requests with a `data` param carrying page_context
   * (zoho.com/sign/api/document-managment/get-document-list.html).
   * start_index is 1-BASED (per the getting-started example).
   *
   * ── WHY page_context CARRIES ONLY TWO KEYS ──────────────────────────────
   * 1B shipped this sending four: row_count, start_index, search_columns
   * ({request_status:'inprogress'}), sort_column and sort_order. Live, that
   * 400'd with Zoho code 9043 "Extra key found" — so Zoho VALIDATES this
   * object against an allowlist rather than ignoring what it does not know.
   * (Contrast the QUERY string, where unknown params really are ignored —
   * that is why sending testing=true on both send calls is safe. The two
   * behaviours are not the same and must not be reasoned about as one.)
   *
   * Rather than bisect which of the three keys Zoho objects to — a live
   * experiment costing API calls to answer a question we do not need
   * answered — page_context is reduced to the two keys the documentation
   * actually publishes. Nothing is lost:
   *
   *   - the status filter was NEVER load-bearing. The client-side re-filter
   *     below was written precisely so an ignored/rejected server-side
   *     filter could not produce wrong results, and it is now the only
   *     filter. Cost is reading more pages, not reading wrong rows.
   *   - sort_column/sort_order only affected WHICH rows survive truncation
   *     at the rowCap. `capped` already tells the caller the result is
   *     partial, and the reconciliation job iterates OUR outstanding rows
   *     and asks getStatus per row — it never treats absence from this list
   *     as evidence a document finished. See the cap warning below.
   *
   * If a future need makes server-side filtering worth having, add ONE key
   * back at a time and watch for 9043 — do not restore the block wholesale.
   *
   * @returns {Promise<{items:Array<{providerId,status,providerStatus,documentName}>,
   *                    capped:boolean, pagesFetched:number}>}
   */
  async listInProgress({ rowCap = LIST_ROW_CAP, pageSize = LIST_PAGE_SIZE } = {}) {
    const items = [];
    let startIndex = 1;
    let capped = false;
    let pagesFetched = 0;

    for (;;) {
      // Two documented keys ONLY — see the 9043 note above before adding any.
      const data = JSON.stringify({
        page_context: {
          row_count:   pageSize,
          start_index: startIndex,
        },
      });

      const raw = await this._request('GET', '/requests', { query: { data } });
      pagesFetched += 1;

      const rows = Array.isArray(raw?.requests) ? raw.requests : [];
      for (const r of rows) {
        const providerStatus = r?.request_status;
        if (!ZOHO_IN_PROGRESS_STATUSES.includes(String(providerStatus || '').toLowerCase())) {
          continue;  // THE status filter — nothing narrows this server-side
        }
        if (items.length >= rowCap) { capped = true; break; }
        items.push({
          providerId:     String(r.request_id),
          status:         mapRequestStatus(providerStatus, r.actions),
          providerStatus,
          documentName:   r.request_name ?? null,
        });
      }

      if (capped) break;
      if (rows.length < pageSize) break;      // last page
      startIndex += pageSize;
      if (startIndex > rowCap * 4) {          // pathological-loop stop
        capped = true;
        break;
      }
    }

    if (capped) {
      console.warn(`[zohoSignProvider] listInProgress hit the ${rowCap}-row cap — result is truncated`);
    }
    return { items, capped, pagesFetched };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Best-effort hunt for a credit balance in an undocumented payload. Shallow
 * BFS, max 4 levels; matches keys containing "credit" (but not "credit_card")
 * whose value is a number. Returns null rather than guessing wildly.
 */
function findCreditNumber(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (key.includes('credit') && !key.includes('card') && typeof v === 'number') return v;
    if (key.includes('credit') && !key.includes('card') && typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
      return Number(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findCreditNumber(v, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

module.exports = {
  ZohoSignProvider,
  PROVIDER_NAME,
  API_BASE,
  // test hook (firmConfig._test precedent): providerError's error_param /
  // raw-body preservation is a diagnosis lifeline — pin it directly.
  _test: { providerError },
  // transform + mapping — exported so slice 1C's webhook shares one source of truth
  neutralToZohoFields,
  bindFieldsToActions,
  mapRequestStatus,
  mapActionStatus,
  ZOHO_REQUEST_STATUS_MAP,
  ZOHO_ACTION_STATUS_MAP,
  FIELD_TYPES,
  DEFAULT_PAGE,
  NEUTRAL_PAGE_BASE,
  // test seams
  _internals: { findCreditNumber, toIso, providerError, authError, inputError },
};