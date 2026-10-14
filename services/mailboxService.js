// services/mailboxService.js
//
/**
 * Mailbox Service — mailbox-system arc, slice S0
 * services/mailboxService.js
 *
 * Pure logic for `mailboxes` and `channel_grants` (ref/MAILBOX_SYSTEM_DESIGN.md
 * §3, D6). No HTTP: routes/api.mailboxes.js is the HTTP layer. Errors carry
 * an HTTP `.status` (httpError) and a user-presentable `.message`.
 *
 * GRANT RESOLUTION IS THE SINGLE SOURCE OF TRUTH. Every later slice (S1 part
 * fetch, S2 inbox, S3 send, S-PH phone) asks getAccess / listReadable /
 * listSendable — never channel_grants directly.
 *
 *   - SU bypass: users.user_auth === 'authorized - SU' (the lib/auth.superuser
 *     string convention) short-circuits to full access. Read from the DB, not
 *     the JWT claim: callers like S1's part fetch hold only a user id, and the
 *     DB value is current where a JWT carries user_auth for up to 24h — a
 *     demoted SU loses the bypass immediately (fail-closed). Routes still
 *     demand step-up elevation before an SU-bypass WRITE (elevation can only
 *     be minted by a JWT-SU), so SU writes need both sources to agree.
 *   - Role bypass (S2; phone lines since S-PH): users.roles containing
 *     'attorney' (READ_BYPASS_ROLES) grants READ on every mailbox AND every
 *     phone line without a grant row — design §1 "SU and SS see everything".
 *     READ ONLY: can_send / can_manage still come from the user's grant row,
 *     and `su` stays
 *     false, so a role reader is never treated as an SU by the routes (no
 *     SU projection, no SU-only diagnostics, no bypass writes). DB-sourced
 *     for the same reason as the SU check: a role removed in the Users pane
 *     takes effect on the next request. Rows carry `role` when it applied.
 *   - SEND (S3, S-PH): the attorney bypass does NOT extend to can_send, on
 *     either channel. Reading is a visibility right; sending AS an identity
 *     (a mailbox, a phone line) is an act, so it needs an explicit can_send
 *     grant. Only the SU bypass sends without a grant row.
 *     listSendable is the set the comms hub's identity picker (mail) and the
 *     staff From pickers (phone: communicate / sending forms) offer.
 *   - Enforcement seat (D6): grant checks run on INTERACTIVE routes only —
 *     never inside emailService / phoneService — so workflow and automation
 *     sends are untouched. Nothing in this file is called from those services.
 *
 * CHANNEL GATE. channel_grants is channel-general (channel_type 'mailbox' |
 * 'phone_line', VARCHAR app-validated). Reads and grant writes accept both
 * since slice S-PH (phone enforcement shipped in the same deploy as the
 * write vocabulary — no inert phone rows). The ONLY channel-specific seams in
 * grant CRUD are the existence check (channelExists: mailboxes vs
 * phone_lines) and the noun in error copy (CHANNEL_NOUNS). A ROUTE pins the
 * channel it serves (a mailbox route never writes a phone_line grant — line
 * and mailbox ids overlap); the service trusts the caller's channelType.
 *
 * IMAP SECRET IS WRITE-ONLY. imap_secret is encrypted with lib/credentialCrypto
 * (ENCv1, the email_credentials.smtp_pass pattern) on the way in and is never
 * SELECTed by this module: every read projection lists its columns explicitly
 * and reports `has_secret` (computed in SQL) instead. The S1 ingest worker is
 * the only future reader that decrypts it.
 *
 * MANAGER SCOPE. A non-SU `can_manage` holder may grant/revoke on that one
 * mailbox and edit its display_name and color. Connection and plumbing fields
 * (address, imap_*, send_credential_id, ingest_*, emit_*, active) are SU-only: re-pointing
 * imap_host would ship the stored secret to an arbitrary server on the next
 * ingest, re-pointing send_credential_id would let grantees send through
 * another mailbox's credential, and ingest_* decides what enters the firm-wide
 * rules pipeline (court mail). Changing imap_host/imap_port requires
 * imap_secret in the same write for everyone (credential-redirect guard).
 *
 * EMISSION OVERRIDE (S1-G). emit_source_name + emit_id_kind decide the
 * identity the ingest worker emits a mailbox's mail under (worker header,
 * EMISSION IDENTITY) — i.e. which email_log dedupe space it lands in, which is
 * what keeps a mailbox from firing court / e-sign rules twice. So: SU-only
 * (never in MANAGER_EDITABLE_FIELDS), PATCH-only (every mailbox starts on the
 * default and runs store-only through the verification gate before it
 * emits), set as a PAIR (both null = default), validated against an ACTIVE
 * email_ingest_sources row, 'provider' never under the shared 'mailbox-imap'
 * source, and one mailbox per source may emit provider ids (a provider id
 * is unique per account, not across accounts — two accounts under one
 * source would log the same email twice).
 *
 * ALIAS BOXES (S3-R). `alias_of` (NOT NULL = a send-as alias of that parent
 * box) is the ONE definition of SEND-ONLY — mailReadService.SEND_ONLY_SQL
 * reads it; the old "ingest off AND no secret" inference is dead. An alias is
 * created through its own create path: address (+ display_name / color /
 * alias_label / send_credential_id) with host/login COPIED from the parent,
 * ingest forced off, no secret — and its connection, ingest and emit fields
 * can never be set afterwards (its mail lives in the parent; an ingest-on
 * alias would double-poll the account). alias_of: SU may RE-PARENT an alias
 * (PATCH it to another real box — the connection is re-copied from the new
 * parent; review 2026-10-12: mailboxes are never deleted and address is
 * UNIQUE, so "delete + recreate" was no path at all), but never clear it,
 * and a full box never becomes an alias. alias_label is the Gmail label whose
 * filter files the alias's mail in the parent (the slice's label half —
 * mailReadService ALIAS SLICE); SU-editable, alias rows only, a USER label —
 * a system label (\Inbox, \Sent …) would hand the alias the parent's whole
 * folder. Never an alias of an alias.
 *
 * COLOUR (S2). `color` is the box's comms-hub colour ('#rrggbb', NULL = none):
 * cosmetic, never an access or routing input, so it sits with display_name in
 * MANAGER_EDITABLE_FIELDS. A create without one gets a random default from
 * public/js/mailboxColor.js PALETTE (an unused entry first); validation and
 * the palette live in that one shared module so the admin pane and this file
 * cannot disagree. Every projection carries it.
 *
 * NO MODULE-SCOPE STATE. No caches of mailbox or grant data, no connections
 * (design §2; tenancy audit A3). Every call reads the DB.
 *
 * Plain single-statement writes — no transaction spans here (each write is
 * one INSERT/UPDATE/DELETE; races on the UNIQUE keys surface as 409s).
 */

'use strict';

const { encrypt } = require('../lib/credentialCrypto');
const mailboxColor = require('../public/js/mailboxColor');
const { rowIsSuperuser } = require('../lib/auth.superuser');

const SU_AUTH = 'authorized - SU'; // legacy marker (A2b removes); still exported

// users.roles values whose holders READ every mailbox without a grant (S2;
// design §1 "SU and SS see everything" — SS holds 'attorney'). READ ONLY.
const READ_BYPASS_ROLES = Object.freeze(['attorney']);

// Read vocabulary (getAccess / listReadable / listGrants).
const CHANNEL_TYPES = new Set(['mailbox', 'phone_line']);
// Write vocabulary. phone_line joined with slice S-PH (enforcement + pane in
// the same deploy).
const WRITABLE_CHANNEL_TYPES = new Set(['mailbox', 'phone_line']);
// The noun error copy uses per channel ("Grant not found on this phone line").
const CHANNEL_NOUNS = Object.freeze({ mailbox: 'mailbox', phone_line: 'phone line' });

// phone_lines projection for the hub and the From pickers. NEVER credential_id
// or provider_id (connection plumbing — the SU admin route owns those).
const LINE_COLS = 'pl.id, pl.phone_number, pl.display_name, pl.provider, pl.active, pl.mms_capable';

const DEFAULT_INGEST_FOLDERS = Object.freeze({ INBOX: Object.freeze({ emit_to_rules: true }) });
const DEFAULT_EMIT_SOURCE = 'mailbox-imap'; // services/mailbox/mailboxIngestService SOURCE_NAME
const EMIT_ID_KINDS = Object.freeze(['rfc', 'provider']);
const EMIT_FIELDS = ['emit_source_name', 'emit_id_kind'];
const MAX_INGEST_FOLDERS = 25;
const MAX_SECRET_LEN = 1024;
const SMTP_PORTS = Object.freeze([25, 465, 587, 2525]); // never an IMAP port (validation, imap_port)

const MAILBOX_FIELDS = new Set([
  'address', 'display_name', 'color', 'imap_host', 'imap_port', 'imap_user', 'imap_secret',
  'send_credential_id', 'ingest_enabled', 'ingest_folders', 'active',
  'alias_of', 'alias_label',
  ...EMIT_FIELDS,
]);
const MAILBOX_REQUIRED_ON_CREATE = ['address', 'imap_host', 'imap_user'];
// Fields an ALIAS box never carries of its own (S3-R): connection is copied
// from the parent at creation, ingest stays off, emission belongs to the
// polling parent. Refused on an alias create body and on every alias PATCH.
const ALIAS_FORBIDDEN_FIELDS = ['imap_host', 'imap_port', 'imap_user', 'imap_secret',
  'ingest_enabled', 'ingest_folders', ...EMIT_FIELDS];
// What a non-SU can_manage holder may PATCH (see MANAGER SCOPE above).
const MANAGER_EDITABLE_FIELDS = new Set(['display_name', 'color']);

const GRANT_FLAGS = ['can_read', 'can_send', 'can_manage'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hostname or IPv4 literal. No scheme, port, path or whitespace — host and
// port are separate columns.
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
// IMAP folder names: printable, no control characters.
const FOLDER_RE = /^[^\u0000-\u001f\u007f]{1,128}$/;

// ── Read projections. NEVER add imap_secret to either list. ──────────────────
const SU_MAILBOX_SELECT = `
  m.id, m.address, m.domain, m.display_name, m.color, m.imap_host, m.imap_port, m.imap_user,
  (m.imap_secret IS NOT NULL AND m.imap_secret <> '') AS has_secret,
  m.send_credential_id, ec.email AS send_credential_email,
  m.alias_of, m.alias_label, al.address AS alias_of_address,
  m.ingest_enabled, m.ingest_folders, m.ingest_state, m.active,
  m.emit_source_name, m.emit_id_kind,
  m.created_at, m.updated_at,
  (SELECT COUNT(*) FROM channel_grants cg
    WHERE cg.channel_type = 'mailbox' AND cg.channel_id = m.id) AS grant_count`;

const PUBLIC_MAILBOX_SELECT = `
  m.id, m.address, m.domain, m.display_name, m.color, m.active,
  (SELECT COUNT(*) FROM channel_grants cg
    WHERE cg.channel_type = 'mailbox' AND cg.channel_id = m.id) AS grant_count`;


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** JSON column → value|null regardless of driver behavior. */
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function has(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

/** Positive integer id from a route param / body value, else 400. */
function toId(v, label) {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, `${label} must be a positive integer`);
  }
  return Number(s);
}

/** users.user value (signed TINYINT: 0..127 in practice), else 400. */
function toUserId(v, label = 'user') {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) > 127) throw httpError(400, `${label} must be a user id`);
  return Number(s);
}

/** Strict boolean: true/false/1/0 only. */
function toBool(v, label) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw httpError(400, `${label} must be a boolean`);
}

function assertReadChannel(channelType) {
  if (!CHANNEL_TYPES.has(channelType)) {
    throw httpError(400, `channel_type must be one of: ${[...CHANNEL_TYPES].join(', ')}`);
  }
}

function assertWritableChannel(channelType) {
  if (!WRITABLE_CHANNEL_TYPES.has(channelType)) {
    throw httpError(400, `channel_type must be one of: ${[...WRITABLE_CHANNEL_TYPES].join(', ')}`);
  }
}

const nounOf = (channelType) => CHANNEL_NOUNS[channelType] || 'channel';

function fullAccess() {
  return { can_read: true, can_send: true, can_manage: true, su: true };
}

function noAccess() {
  return { can_read: false, can_send: false, can_manage: false, su: false };
}


// ─────────────────────────────────────────────────────────────────────────────
// Identity + grant resolution
// ─────────────────────────────────────────────────────────────────────────────

/** True iff this user is SU per the users table (DB, not JWT) — roles SET
 *  `su` member, or the legacy user_auth marker until A2b. */
async function isSuperuser(db, userId) {
  const n = Number(userId);
  if (!Number.isInteger(n) || n < 0) return false;
  const [[row]] = await db.query('SELECT user_auth, roles FROM users WHERE user = ? LIMIT 1', [n]);
  return rowIsSuperuser(row);
}

/**
 * The READ-bypass role this user holds, or null (S2). users.roles is a MySQL
 * SET ('it','admin','staff','attorney','automation','form_dev') and comes
 * back as a comma-separated string; parsed here rather than with
 * FIND_IN_SET so the check reads exactly like the SU one. Read access only —
 * see the header (Role bypass).
 */
async function roleBypass(db, userId) {
  const n = Number(userId);
  if (!Number.isInteger(n) || n < 0) return null;
  const [[row]] = await db.query('SELECT roles FROM users WHERE user = ? LIMIT 1', [n]);
  if (!row || row.roles == null) return null;
  const held = String(row.roles).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return READ_BYPASS_ROLES.find(r => held.includes(r)) || null;
}

/**
 * Effective access of one user on one channel.
 * @returns {{can_read:boolean, can_send:boolean, can_manage:boolean, su:boolean, role?:string}}
 *   `su` is true when the SU bypass (not a grant row) produced the access.
 *   `role` is present when the READ bypass applied (every channel — S-PH
 *   ruled phone lines in, 2026-10-12): can_read is then true whatever the
 *   grant says; send/manage are the grant's.
 * Does NOT check that the channel exists: the bypasses answer for any id, so
 * a route checks existence itself (mailboxExists / channelExists).
 */
async function getAccess(db, userId, channelType, channelId) {
  assertReadChannel(channelType);
  const cid = toId(channelId, 'channel_id');
  if (await isSuperuser(db, userId)) return fullAccess();
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 0) return noAccess();
  const role = await roleBypass(db, uid);
  const [[g]] = await db.query(
    `SELECT can_read, can_send, can_manage FROM channel_grants
      WHERE user = ? AND channel_type = ? AND channel_id = ? LIMIT 1`,
    [uid, channelType, cid]
  );
  const access = g
    ? { can_read: !!g.can_read, can_send: !!g.can_send, can_manage: !!g.can_manage, su: false }
    : noAccess();
  if (role) { access.can_read = true; access.role = role; }
  return access;
}

/**
 * What a user can READ on a channel type.
 *   'mailbox'    → [{id, address, domain, display_name, color, active, can_read,
 *                    can_send, can_manage, role?}] — SU: every mailbox; a
 *                    READ-bypass role: every mailbox, can_read true, send /
 *                    manage from their grant rows; others: mailboxes with a
 *                    can_read grant. Inactive boxes included (their stored
 *                    mail stays readable); callers filter.
 *   'phone_line' → (S-PH) the same three branches over phone_lines:
 *                    [{id, phone_number, display_name, provider, active,
 *                    mms_capable, can_read, can_send, can_manage, role?}], id
 *                    order. Inactive lines included (their stored events stay
 *                    readable); never credential_id / provider_id.
 */
async function listReadable(db, userId, channelType = 'mailbox') {
  assertReadChannel(channelType);
  const uid = Number(userId);

  if (channelType === 'mailbox') {
    if (await isSuperuser(db, userId)) {
      const [rows] = await db.query(
        `SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, m.alias_of, m.alias_label
           FROM mailboxes m ORDER BY m.address ASC`
      );
      return rows.map(r => ({ ...shapeFlags(r), can_read: true, can_send: true, can_manage: true }));
    }
    if (!Number.isInteger(uid) || uid < 0) return [];
    const role = await roleBypass(db, uid);
    if (role) {
      const [rows] = await db.query(
        `SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, m.alias_of, m.alias_label,
                g.can_send, g.can_manage
           FROM mailboxes m
           LEFT JOIN channel_grants g
             ON g.channel_type = 'mailbox' AND g.channel_id = m.id AND g.user = ?
          ORDER BY m.address ASC`,
        [uid]
      );
      return rows.map(r => ({ ...shapeFlags(r), ...shapeGrantFlags(r), can_read: true, role }));
    }
    const [rows] = await db.query(
      `SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, m.alias_of, m.alias_label,
              g.can_read, g.can_send, g.can_manage
         FROM channel_grants g
         JOIN mailboxes m ON m.id = g.channel_id
        WHERE g.user = ? AND g.channel_type = 'mailbox' AND g.can_read = 1
        ORDER BY m.address ASC`,
      [uid]
    );
    return rows.map(r => ({ ...shapeFlags(r), ...shapeGrantFlags(r) }));
  }

  // 'phone_line' (S-PH) — the mailbox branches, line-shaped.
  if (await isSuperuser(db, userId)) {
    const [rows] = await db.query(`SELECT ${LINE_COLS} FROM phone_lines pl ORDER BY pl.id ASC`);
    return rows.map(r => ({ ...shapeLine(r), can_read: true, can_send: true, can_manage: true }));
  }
  if (!Number.isInteger(uid) || uid < 0) return [];
  const role = await roleBypass(db, uid);
  if (role) {
    const [rows] = await db.query(
      `SELECT ${LINE_COLS}, g.can_send, g.can_manage
         FROM phone_lines pl
         LEFT JOIN channel_grants g
           ON g.channel_type = 'phone_line' AND g.channel_id = pl.id AND g.user = ?
        ORDER BY pl.id ASC`,
      [uid]
    );
    return rows.map(r => ({ ...shapeLine(r), ...shapeGrantFlags(r), can_read: true, role }));
  }
  const [rows] = await db.query(
    `SELECT ${LINE_COLS}, g.can_read, g.can_send, g.can_manage
       FROM channel_grants g
       JOIN phone_lines pl ON pl.id = g.channel_id
      WHERE g.user = ? AND g.channel_type = 'phone_line' AND g.can_read = 1
      ORDER BY pl.id ASC`,
    [uid]
  );
  return rows.map(r => ({ ...shapeLine(r), ...shapeGrantFlags(r) }));
}

/**
 * What a user can SEND AS.
 *   'mailbox' (S3) → [{id, address, domain, display_name, color, active,
 *     send_credential_id}], address order. SU: every mailbox (the S0 SU
 *     bypass). Everyone else: mailboxes they hold a can_send grant on — NO
 *     role bypass (header, SEND): an attorney without the grant gets nothing
 *     here. Inactive boxes and boxes without a send credential are included;
 *     the caller says why they cannot be used. send_credential_id is for the
 *     send service — routes project it away for non-SU callers.
 *   'phone_line' (S-PH) → [{id, phone_number, display_name, provider,
 *     active, mms_capable}], id order: SU every line, everyone else the lines
 *     they hold a can_send grant on (no role bypass). Inactive lines are
 *     included; the From pickers only ever list active ones anyway.
 */
async function listSendable(db, userId, channelType = 'mailbox') {
  assertReadChannel(channelType);
  if (channelType === 'phone_line') {
    if (await isSuperuser(db, userId)) {
      const [rows] = await db.query(`SELECT ${LINE_COLS} FROM phone_lines pl ORDER BY pl.id ASC`);
      return rows.map(shapeLine);
    }
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid < 0) return [];
    const [rows] = await db.query(
      `SELECT ${LINE_COLS}
         FROM channel_grants g
         JOIN phone_lines pl ON pl.id = g.channel_id
        WHERE g.user = ? AND g.channel_type = 'phone_line' AND g.can_send = 1
        ORDER BY pl.id ASC`,
      [uid]
    );
    return rows.map(shapeLine);
  }
  if (await isSuperuser(db, userId)) {
    const [rows] = await db.query(
      `SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, m.send_credential_id
         FROM mailboxes m ORDER BY m.address ASC`
    );
    return rows.map(shapeFlags);
  }
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 0) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, m.send_credential_id
       FROM channel_grants g
       JOIN mailboxes m ON m.id = g.channel_id
      WHERE g.user = ? AND g.channel_type = 'mailbox' AND g.can_send = 1
      ORDER BY m.address ASC`,
    [uid]
  );
  return rows.map(shapeFlags);
}


// ─────────────────────────────────────────────────────────────────────────────
// Mailbox shaping
// ─────────────────────────────────────────────────────────────────────────────

function shapeFlags(r) {
  const out = { ...r };
  if (has(out, 'active')) out.active = !!out.active;
  if (has(out, 'ingest_enabled')) out.ingest_enabled = !!out.ingest_enabled;
  if (has(out, 'has_secret')) out.has_secret = !!Number(out.has_secret);
  if (has(out, 'grant_count')) out.grant_count = Number(out.grant_count);
  if (has(out, 'alias_of')) out.alias_of = out.alias_of == null ? null : Number(out.alias_of);
  if (has(out, 'ingest_folders')) out.ingest_folders = parseJson(out.ingest_folders);
  if (has(out, 'ingest_state')) out.ingest_state = parseJson(out.ingest_state);
  return out;
}

function shapeGrantFlags(r) {
  return { can_read: !!r.can_read, can_send: !!r.can_send, can_manage: !!r.can_manage };
}

/** A phone_lines row in the LINE_COLS projection (S-PH). */
function shapeLine(r) {
  return {
    id: Number(r.id),
    phone_number: r.phone_number,
    display_name: r.display_name ?? null,
    provider: r.provider,
    active: !!Number(r.active),
    mms_capable: !!Number(r.mms_capable),
  };
}

/** Defense in depth: no shaped mailbox ever leaves with this key. */
function stripSecret(row) {
  if (row && has(row, 'imap_secret')) delete row.imap_secret;
  return row;
}

/**
 * Mailboxes visible to a user, for GET /api/mailboxes.
 *   SU     → every mailbox, full projection (connection fields, has_secret,
 *            send credential, ingest config, grant_count).
 *   role   → (READ bypass, S2) every mailbox, PUBLIC projection — a role
 *            reader is not an SU — with can_read true and send/manage from
 *            their grant rows.
 *   others → mailboxes they hold ANY grant on (read, send or manage), public
 *            projection (id, address, domain, display_name, color, active) plus
 *            their access flags; grant_count only where they can_manage.
 * Every row carries `access` = the caller's flags.
 */
async function listMailboxesFor(db, userId) {
  if (await isSuperuser(db, userId)) {
    const [rows] = await db.query(
      `SELECT ${SU_MAILBOX_SELECT}
         FROM mailboxes m
         LEFT JOIN email_credentials ec ON ec.id = m.send_credential_id
         LEFT JOIN mailboxes al ON al.id = m.alias_of
        ORDER BY m.address ASC`
    );
    return { su: true, mailboxes: rows.map(r => stripSecret({ ...shapeFlags(r), access: fullAccess() })) };
  }
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 0) return { su: false, mailboxes: [] };
  const role = await roleBypass(db, uid);
  if (role) {
    const [all] = await db.query(
      `SELECT ${PUBLIC_MAILBOX_SELECT}, g.can_send, g.can_manage
         FROM mailboxes m
         LEFT JOIN channel_grants g
           ON g.channel_type = 'mailbox' AND g.channel_id = m.id AND g.user = ?
        ORDER BY m.address ASC`,
      [uid]
    );
    return {
      su: false,
      role,
      mailboxes: all.map(r => {
        const access = { ...shapeGrantFlags(r), can_read: true, su: false, role };
        const out = shapeFlags(r);
        for (const f of GRANT_FLAGS) delete out[f];
        if (!access.can_manage) delete out.grant_count;
        out.access = access;
        return stripSecret(out);
      }),
    };
  }
  const [rows] = await db.query(
    `SELECT ${PUBLIC_MAILBOX_SELECT}, g.can_read, g.can_send, g.can_manage
       FROM channel_grants g
       JOIN mailboxes m ON m.id = g.channel_id
      WHERE g.user = ? AND g.channel_type = 'mailbox'
        AND (g.can_read = 1 OR g.can_send = 1 OR g.can_manage = 1)
      ORDER BY m.address ASC`,
    [uid]
  );
  return {
    su: false,
    mailboxes: rows.map(r => {
      const access = { ...shapeGrantFlags(r), su: false };
      const out = shapeFlags(r);
      for (const f of GRANT_FLAGS) delete out[f];
      if (!access.can_manage) delete out.grant_count;
      out.access = access;
      return stripSecret(out);
    }),
  };
}

/** One mailbox in the caller's projection (SU full / otherwise public). */
async function getMailbox(db, mailboxId, { su = false } = {}) {
  const id = toId(mailboxId, 'mailbox id');
  const [[row]] = su
    ? await db.query(
        `SELECT ${SU_MAILBOX_SELECT}
           FROM mailboxes m
           LEFT JOIN email_credentials ec ON ec.id = m.send_credential_id
           LEFT JOIN mailboxes al ON al.id = m.alias_of
          WHERE m.id = ? LIMIT 1`, [id])
    : await db.query(`SELECT ${PUBLIC_MAILBOX_SELECT} FROM mailboxes m WHERE m.id = ? LIMIT 1`, [id]);
  if (!row) throw httpError(404, 'Mailbox not found');
  return stripSecret(shapeFlags(row));
}

async function mailboxExists(db, mailboxId) {
  const id = toId(mailboxId, 'mailbox id');
  const [[row]] = await db.query('SELECT id FROM mailboxes WHERE id = ? LIMIT 1', [id]);
  return !!row;
}

/**
 * Does the channel row exist (S-PH)? The one channel-specific read in grant
 * CRUD. An INACTIVE row exists: an inactive mailbox's mail and an inactive
 * line's events stay readable, so their grants stay writable.
 */
async function channelExists(db, channelType, channelId) {
  assertReadChannel(channelType);
  if (channelType === 'mailbox') return mailboxExists(db, channelId);
  const id = toId(channelId, 'phone line id');
  const [[row]] = await db.query('SELECT id FROM phone_lines WHERE id = ? LIMIT 1', [id]);
  return !!row;
}


// ─────────────────────────────────────────────────────────────────────────────
// Mailbox validation + CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingest_folders shape: a plain object of folderName → {emit_to_rules: bool,
 * backfill?: bool}, 1..MAX_INGEST_FOLDERS entries, no other keys. backfill
 * (S1-G) defaults to true — store the folder's history at first sight — and
 * is written only when false. Returns a fresh normalized object (insertion
 * order kept).
 */
function validateIngestFolders(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw httpError(400, 'ingest_folders must be an object of folder name → {emit_to_rules: boolean}');
  }
  const names = Object.keys(v);
  if (!names.length) {
    throw httpError(400, 'ingest_folders must name at least one folder (set ingest_enabled false to stop ingest)');
  }
  if (names.length > MAX_INGEST_FOLDERS) {
    throw httpError(400, `ingest_folders allows at most ${MAX_INGEST_FOLDERS} folders`);
  }
  const out = {};
  for (const name of names) {
    if (name.trim() !== name || !FOLDER_RE.test(name)) {
      throw httpError(400, `ingest_folders: invalid folder name ${JSON.stringify(name)} (1-128 printable chars, no surrounding spaces)`);
    }
    const cfg = v[name];
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw httpError(400, `ingest_folders.${name} must be an object {emit_to_rules: boolean}`);
    }
    for (const k of Object.keys(cfg)) {
      if (k !== 'emit_to_rules' && k !== 'backfill') {
        throw httpError(400, `ingest_folders.${name}: unknown property "${k}"`);
      }
    }
    if (!has(cfg, 'emit_to_rules')) {
      throw httpError(400, `ingest_folders.${name}.emit_to_rules is required`);
    }
    if (typeof cfg.emit_to_rules !== 'boolean') {
      throw httpError(400, `ingest_folders.${name}.emit_to_rules must be a boolean`);
    }
    if (has(cfg, 'backfill') && typeof cfg.backfill !== 'boolean') {
      throw httpError(400, `ingest_folders.${name}.backfill must be a boolean`);
    }
    out[name] = cfg.backfill === false
      ? { emit_to_rules: cfg.emit_to_rules, backfill: false }
      : { emit_to_rules: cfg.emit_to_rules };
  }
  return out;
}

/**
 * Validate the mailbox fields present in `body` (all keys must be known).
 * Returns a `clean` object holding only the keys that were present, with
 * DB-shaped values. imap_secret comes back as {secret: 'set', value} |
 * {secret: 'clear'} — never encrypted here; the writer encrypts.
 */
function validateMailboxBody(body, { partial }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'request body must be a JSON object');
  }
  for (const k of Object.keys(body)) {
    if (k === 'domain') throw httpError(400, 'domain is derived from address — send address instead');
    if (!MAILBOX_FIELDS.has(k)) throw httpError(400, `unknown field "${k}"`);
  }
  // ── Alias boxes (S3-R, header: ALIAS BOXES) ──
  // On an alias create the connection/ingest/emit fields are COPIED or
  // forced, never accepted, and only the address is required. A PATCH may
  // re-point alias_of (updateMailbox checks the row is an alias), never clear it.
  if (partial && has(body, 'alias_of') && (body.alias_of === null || body.alias_of === '')) {
    throw httpError(400, 'alias_of cannot be cleared — an alias box stays an alias (point it at another box instead)');
  }
  const aliasMode = !partial && has(body, 'alias_of') && body.alias_of !== null && body.alias_of !== '';
  if (!partial) {
    if (has(body, 'alias_label') && !aliasMode) {
      throw httpError(400, 'alias_label goes with alias_of — it names the Gmail label that files an alias box\'s mail');
    }
    if (aliasMode) {
      const present = ALIAS_FORBIDDEN_FIELDS.filter(f => has(body, f));
      if (present.length) {
        throw httpError(400, `${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} not set on an alias box — ` +
          'its connection is copied from the parent and it never polls (its mail lives in the parent box)');
      }
    }
    for (const f of (aliasMode ? ['address'] : MAILBOX_REQUIRED_ON_CREATE)) {
      if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
        throw httpError(400, `${f} is required`);
      }
    }
  }

  const clean = {};

  if (has(body, 'alias_of')) {
    clean.alias_of = (aliasMode || partial) ? toId(body.alias_of, 'alias_of') : null;
  }
  if (has(body, 'alias_label')) {
    const v = body.alias_label;
    if (v === null || v === '') clean.alias_label = null;
    else if (typeof v !== 'string') throw httpError(400, 'alias_label must be a string');
    else {
      const t = v.trim();
      if (!t || t.length > 255) throw httpError(400, 'alias_label must be 1-255 characters');
      if (t.startsWith('\\')) {
        throw httpError(400, 'alias_label must be one of the account\'s own labels (IT, Rena …) — a Gmail system label ' +
          '(\\Inbox, \\Sent …) would show this alias\'s readers the whole of that folder');
      }
      clean.alias_label = t;
    }
  }

  if (has(body, 'address')) {
    if (typeof body.address !== 'string') throw httpError(400, 'address must be a string');
    const a = body.address.trim().toLowerCase();
    if (a.length > 255 || !EMAIL_RE.test(a)) throw httpError(400, 'address must be a valid email address');
    const domain = a.slice(a.lastIndexOf('@') + 1);
    if (domain.length > 128) throw httpError(400, 'address domain must be at most 128 characters');
    clean.address = a;
    clean.domain = domain;
  }

  if (has(body, 'display_name')) {
    const v = body.display_name;
    if (v === null || v === '') clean.display_name = null;
    else if (typeof v !== 'string') throw httpError(400, 'display_name must be a string');
    else {
      const t = v.trim();
      if (t.length > 128) throw httpError(400, 'display_name must be at most 128 characters');
      clean.display_name = t || null;
    }
  }

  if (has(body, 'color')) {
    const v = body.color;
    if (v === null || v === '') clean.color = null;
    else {
      const c = mailboxColor.normalize(v);
      if (!c) throw httpError(400, 'color must be a hex colour like #2f6fd1 (or null for none)');
      clean.color = c;
    }
  }

  if (has(body, 'imap_host')) {
    if (typeof body.imap_host !== 'string') throw httpError(400, 'imap_host must be a string');
    const h = body.imap_host.trim().toLowerCase();
    if (!h || h.length > 255 || !HOST_RE.test(h) || h.includes('..')) {
      throw httpError(400, 'imap_host must be a hostname (no scheme, port or path)');
    }
    clean.imap_host = h;
  }

  if (has(body, 'imap_port')) {
    const p = body.imap_port;
    const n = typeof p === 'number' ? p : (typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw httpError(400, 'imap_port must be an integer 1-65535');
    // The mail-SENDING ports. An SMTP port copied into the IMAP field fails
    // every poll, the folder listing and the hub's Sent APPEND with a TLS
    // "wrong version number" (live 2026-10-11: mailbox 3 on 587) — say so at
    // save time instead.
    if (SMTP_PORTS.includes(n)) {
      throw httpError(400, `imap_port ${n} is a mail-sending (SMTP) port — IMAP is 993 (TLS) or 143 (STARTTLS)`);
    }
    clean.imap_port = n;
  }

  if (has(body, 'imap_user')) {
    if (typeof body.imap_user !== 'string') throw httpError(400, 'imap_user must be a string');
    const u = body.imap_user.trim();
    if (!u || u.length > 255) throw httpError(400, 'imap_user must be 1-255 characters');
    clean.imap_user = u;
  }

  if (has(body, 'imap_secret')) {
    const s = body.imap_secret;
    if (s === null || s === '') clean.imap_secret = { secret: 'clear' };
    else if (typeof s !== 'string') throw httpError(400, 'imap_secret must be a string');
    else if (s.length > MAX_SECRET_LEN) throw httpError(400, `imap_secret must be at most ${MAX_SECRET_LEN} characters`);
    else clean.imap_secret = { secret: 'set', value: s };
  }

  if (has(body, 'send_credential_id')) {
    const v = body.send_credential_id;
    clean.send_credential_id = (v === null || v === '') ? null : toId(v, 'send_credential_id');
  }

  if (has(body, 'ingest_enabled')) clean.ingest_enabled = toBool(body.ingest_enabled, 'ingest_enabled') ? 1 : 0;
  if (has(body, 'active'))         clean.active         = toBool(body.active, 'active') ? 1 : 0;

  if (has(body, 'ingest_folders')) clean.ingest_folders = validateIngestFolders(body.ingest_folders);

  const emitPresent = EMIT_FIELDS.filter(f => has(body, f));
  if (emitPresent.length) {
    if (!partial) {
      throw httpError(400, 'emit_source_name / emit_id_kind are set with PATCH once the mailbox exists — ' +
        `every mailbox starts on the default (${DEFAULT_EMIT_SOURCE}, RFC Message-ID) and runs store-only first`);
    }
    if (emitPresent.length !== EMIT_FIELDS.length) {
      throw httpError(400, 'emit_source_name and emit_id_kind are set together ' +
        `(both null = the default: ${DEFAULT_EMIT_SOURCE} + RFC Message-ID)`);
    }
    const blank = (v) => v === null || v === '';
    const nameRaw = body.emit_source_name;
    const kindRaw = body.emit_id_kind;
    if (blank(nameRaw) && blank(kindRaw)) {
      clean.emit_source_name = null;
      clean.emit_id_kind = null;
    } else if (blank(nameRaw) || blank(kindRaw)) {
      throw httpError(400, 'emit_source_name and emit_id_kind are both set or both null');
    } else {
      if (typeof nameRaw !== 'string') throw httpError(400, 'emit_source_name must be a string');
      const name = nameRaw.trim();
      if (!name || name.length > 64) throw httpError(400, 'emit_source_name must be 1-64 characters');
      if (typeof kindRaw !== 'string' || !EMIT_ID_KINDS.includes(kindRaw)) {
        throw httpError(400, `emit_id_kind must be one of: ${EMIT_ID_KINDS.join(', ')}`);
      }
      if (kindRaw === 'provider' && name.toLowerCase() === DEFAULT_EMIT_SOURCE) {
        throw httpError(400, `provider ids are never emitted under the shared '${DEFAULT_EMIT_SOURCE}' source ` +
          '— its dedupe key is the RFC Message-ID for every mailbox');
      }
      clean.emit_source_name = name;
      clean.emit_id_kind = kindRaw;
    }
  }

  return clean;
}

/**
 * The emission override against live rows (S1-G): the source must be an
 * ACTIVE email_ingest_sources row (stored under its canonical name), and a
 * provider-keyed source may have only one mailbox. Reads id/name/active only
 * — never api_key. Mutates clean.emit_source_name to the row's spelling.
 */
async function assertEmitOverride(db, mailboxId, clean) {
  if (!has(clean, 'emit_source_name') || clean.emit_source_name == null) return;
  const [[src]] = await db.query(
    'SELECT id, name, active FROM email_ingest_sources WHERE name = ? LIMIT 1', [clean.emit_source_name]
  );
  if (!src) throw httpError(400, `emit_source_name '${clean.emit_source_name}' is not an email_ingest_sources row`);
  if (!Number(src.active)) {
    throw httpError(400, `email_ingest_sources '${src.name}' is inactive — activate it first (it is also that source's kill switch)`);
  }
  clean.emit_source_name = src.name;
  if (clean.emit_id_kind === 'provider') {
    const [[other]] = await db.query(
      `SELECT id, address FROM mailboxes
        WHERE id <> ? AND emit_source_name = ? AND emit_id_kind = 'provider' LIMIT 1`,
      [mailboxId, src.name]
    );
    if (other) {
      throw httpError(409, `mailbox ${other.address} already emits provider ids as '${src.name}' — ` +
        'a provider id is unique within one account only, so one source holds one provider-keyed mailbox');
    }
  }
}

/** send_credential_id must name an email_credentials row (FK by convention). */
async function assertSendCredential(db, credId) {
  if (credId == null) return;
  const [[row]] = await db.query('SELECT id FROM email_credentials WHERE id = ? LIMIT 1', [credId]);
  if (!row) throw httpError(400, `send_credential_id ${credId} is not an email_credentials row`);
}

/** Column → DB value for an INSERT/UPDATE built from a validated `clean`. */
function toDbAssignments(clean) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(clean)) {
    if (k === 'imap_secret') {
      cols.push('imap_secret');
      vals.push(v.secret === 'set' ? encrypt(v.value) : null);
    } else if (k === 'ingest_folders') {
      cols.push('ingest_folders');
      vals.push(JSON.stringify(v));
    } else {
      cols.push(k);
      vals.push(v);
    }
  }
  return { cols, vals };
}

/**
 * ONE poller per IMAP account (S3.1, 2026-10-12). A second active,
 * ingest-enabled box on the same host + login would store every message
 * twice and — emitting — log it and fire its rules twice. A SEND-ONLY
 * identity (a Google alias such as it@4lsg.com, whose mail lands in the
 * account's own box: Ingest off, no password — design §4.2) may name the
 * same account freely; this refuses only the poll. Compared under the
 * columns' general_ci collation, i.e. case-blind. `row` = the box as it
 * will be after the write.
 */
async function assertSinglePoller(db, id, row) {
  if (!Number(row.active) || !Number(row.ingest_enabled)) return;
  const [[dup]] = await db.query(
    `SELECT id, address FROM mailboxes
      WHERE id <> ? AND active = 1 AND ingest_enabled = 1 AND imap_host = ? AND imap_user = ? LIMIT 1`,
    [Number(id) || 0, String(row.imap_host || '').toLowerCase(), String(row.imap_user || '')]
  );
  if (dup) {
    throw httpError(409, `${row.imap_user} on ${row.imap_host} is already checked by mailbox #${dup.id} (${dup.address}) — ` +
      'a second box polling it would store, log and fire rules twice. For a send-as address of that account, create it ' +
      `as a send-as address of #${dup.id} instead (Add → Send-as address of an existing box).`);
  }
}

/**
 * The parent an alias points at (S3-R, header: ALIAS BOXES) — it must exist
 * and be a real box (never an alias, never the alias itself) — and the
 * connection the alias copies from it: {imap_host, imap_port, imap_user}.
 */
async function aliasParentConnection(db, parentId, selfId = null) {
  if (selfId != null && Number(parentId) === Number(selfId)) throw httpError(400, 'a mailbox cannot be an alias of itself');
  const [[parent]] = await db.query(
    'SELECT id, address, imap_host, imap_port, imap_user, alias_of FROM mailboxes WHERE id = ? LIMIT 1',
    [parentId]
  );
  if (!parent) throw httpError(400, `alias_of ${parentId} is not a mailbox`);
  if (parent.alias_of != null) {
    throw httpError(400, `${parent.address} is itself an alias box — point alias_of at the real box (#${parent.alias_of})`);
  }
  return {
    imap_host: String(parent.imap_host).toLowerCase(),
    imap_port: Number(parent.imap_port),
    imap_user: parent.imap_user,
  };
}

/**
 * Create a mailbox (SU-only — the route gates). Required: address, imap_host,
 * imap_user. imap_secret optional (has_secret false until set). No `color` in
 * the body = a random PALETTE default, unused by the other boxes when one is
 * left (an explicit null = none).
 * @returns {{id:number, mailbox:object}} mailbox in the SU projection
 */
async function createMailbox(db, body) {
  const clean = validateMailboxBody(body, { partial: false });
  // S3-R: an alias box copies its connection from the parent and never polls
  // (header, ALIAS BOXES). assertSinglePoller passes trivially (ingest 0).
  if (clean.alias_of != null) {
    Object.assign(clean, await aliasParentConnection(db, clean.alias_of));
    clean.ingest_enabled = 0;
  }
  if (!has(clean, 'ingest_folders')) clean.ingest_folders = JSON.parse(JSON.stringify(DEFAULT_INGEST_FOLDERS));
  if (!has(clean, 'color')) {
    const [used] = await db.query('SELECT color FROM mailboxes WHERE color IS NOT NULL');
    clean.color = mailboxColor.pick(used.map(r => r.color));
  }
  await assertSendCredential(db, clean.send_credential_id);
  await assertSinglePoller(db, null, {
    imap_host: clean.imap_host, imap_user: clean.imap_user,
    active: has(clean, 'active') ? clean.active : 1,                 // the column defaults
    ingest_enabled: has(clean, 'ingest_enabled') ? clean.ingest_enabled : 1,
  });

  const { cols, vals } = toDbAssignments(clean);
  let result;
  try {
    [result] = await db.query(
      `INSERT INTO mailboxes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      vals
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw httpError(409, `a mailbox with address ${clean.address} already exists`);
    }
    throw err;
  }
  const mailbox = await getMailbox(db, result.insertId, { su: true });
  return { id: result.insertId, mailbox, secret_change: clean.imap_secret ? clean.imap_secret.secret : null };
}

/**
 * Update a mailbox. `su` decides the field scope: non-SU (a can_manage holder,
 * already checked by the route) may change MANAGER_EDITABLE_FIELDS only.
 * PATCH semantics: absent field = untouched; imap_secret '' or null = clear.
 * @returns {{mailbox, before, changed:string[], secret_change:'set'|'clear'|null}}
 */
async function updateMailbox(db, mailboxId, body, { su = false } = {}) {
  const id = toId(mailboxId, 'mailbox id');
  const fields = (body && typeof body === 'object' && !Array.isArray(body)) ? Object.keys(body) : [];

  // Scope before validation: a manager probing SU-only fields gets the 403,
  // not a validator's opinion of the value.
  if (!su) {
    const forbidden = fields.filter(f => !MANAGER_EDITABLE_FIELDS.has(f));
    if (forbidden.length) {
      throw httpError(403, `only a superuser can change: ${forbidden.join(', ')}`);
    }
  }
  const clean = validateMailboxBody(body, { partial: true });
  if (!fields.length) throw httpError(400, 'no fields to update');

  // Current row — explicit columns, never imap_secret.
  const [[cur]] = await db.query(
    'SELECT id, address, imap_host, imap_port, alias_of FROM mailboxes WHERE id = ? LIMIT 1', [id]
  );
  if (!cur) throw httpError(404, 'Mailbox not found');

  // S3-R: an alias box's connection/ingest/emit fields are never its own
  // (header, ALIAS BOXES); alias_label belongs to alias rows only.
  if (cur.alias_of != null) {
    const bad = ALIAS_FORBIDDEN_FIELDS.filter(f => has(clean, f));
    if (bad.length) {
      throw httpError(400, `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not set on an alias box — ` +
        'its connection is copied from the parent and it never polls (its mail lives in the parent box)');
    }
  } else if (has(clean, 'alias_label') || has(clean, 'alias_of')) {
    throw httpError(400, `${has(clean, 'alias_of') ? 'alias_of' : 'alias_label'} belongs to an alias box ` +
      '(one created as a send-as address of another box) — a full mailbox never becomes one');
  }

  // Credential-redirect guard: a new host/port must come with the secret it
  // will be sent to (or an explicit clear) in the same write.
  const hostChanged = has(clean, 'imap_host') && clean.imap_host !== String(cur.imap_host).toLowerCase();
  const portChanged = has(clean, 'imap_port') && clean.imap_port !== Number(cur.imap_port);
  if ((hostChanged || portChanged) && !has(clean, 'imap_secret')) {
    throw httpError(400, 'changing imap_host or imap_port requires imap_secret in the same request (re-enter it, or send "" to clear)');
  }

  if (has(clean, 'send_credential_id')) await assertSendCredential(db, clean.send_credential_id);
  await assertEmitOverride(db, id, clean);
  const POLL_KEYS = ['imap_host', 'imap_user', 'active', 'ingest_enabled'];
  if (POLL_KEYS.some(k => has(clean, k))) {
    const [[now]] = await db.query(
      'SELECT imap_host, imap_user, active, ingest_enabled FROM mailboxes WHERE id = ? LIMIT 1', [id]
    );
    const after = { ...now };
    for (const k of POLL_KEYS) if (has(clean, k)) after[k] = clean[k];
    await assertSinglePoller(db, id, after);
  }

  // Re-parent (SU — alias_of is not a manager field): the connection follows
  // the new parent. After the redirect guard on purpose: these host/login
  // columns are copied plumbing on a row with no secret, never a credential
  // destination (ALIAS_FORBIDDEN_FIELDS above refused them from the body).
  if (has(clean, 'alias_of')) Object.assign(clean, await aliasParentConnection(db, clean.alias_of, id));

  const before = await getMailbox(db, id, { su });
  const { cols, vals } = toDbAssignments(clean);
  try {
    await db.query(
      `UPDATE mailboxes SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...vals, id]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw httpError(409, `a mailbox with address ${clean.address} already exists`);
    }
    throw err;
  }
  const mailbox = await getMailbox(db, id, { su });
  return {
    mailbox,
    before,
    changed: fields,
    secret_change: clean.imap_secret ? clean.imap_secret.secret : null,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Grants
// ─────────────────────────────────────────────────────────────────────────────

function shapeGrant(r) {
  return {
    id: r.id,
    user: r.user,
    username: r.username ?? null,
    user_name: r.user_name ?? null,
    user_auth: r.user_auth ?? null,
    channel_type: r.channel_type,
    channel_id: r.channel_id,
    ...shapeGrantFlags(r),
    granted_by: r.granted_by,
    granted_by_username: r.granted_by_username ?? null,
    created_at: r.created_at,
  };
}

const GRANT_SELECT = `
  g.id, g.user, u.username, u.user_name, u.user_auth,
  g.channel_type, g.channel_id, g.can_read, g.can_send, g.can_manage,
  g.granted_by, gb.username AS granted_by_username, g.created_at
  FROM channel_grants g
  LEFT JOIN users u  ON u.user  = g.user
  LEFT JOIN users gb ON gb.user = g.granted_by`;

/** All grants on one channel (any channel type may be READ). */
async function listGrants(db, { channelType = 'mailbox', channelId }) {
  assertReadChannel(channelType);
  const cid = toId(channelId, 'channel_id');
  const [rows] = await db.query(
    `SELECT ${GRANT_SELECT}
      WHERE g.channel_type = ? AND g.channel_id = ?
      ORDER BY u.user_name ASC, g.user ASC`,
    [channelType, cid]
  );
  return rows.map(shapeGrant);
}

async function getGrant(db, grantId) {
  const id = toId(grantId, 'grant id');
  const [[row]] = await db.query(`SELECT ${GRANT_SELECT} WHERE g.id = ? LIMIT 1`, [id]);
  return row ? shapeGrant(row) : null;
}

/** Grant row on THIS channel or 404 (ownership scoping — contactRoles precedent). */
async function ownedGrant(db, grantId, channelType, channelId) {
  const g = await getGrant(db, grantId);
  if (!g || g.channel_type !== channelType || Number(g.channel_id) !== channelId) {
    throw httpError(404, `Grant not found on this ${nounOf(channelType)}`);
  }
  return g;
}

function validateGrantBody(body, { partial }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'request body must be a JSON object');
  }
  for (const k of Object.keys(body)) {
    if (k === 'channel_type') continue; // gated separately (assertWritableChannel)
    if (k === 'user') {
      if (partial) throw httpError(400, 'user is immutable on a grant — delete it and create a new one');
      continue;
    }
    if (k === 'channel_id') throw httpError(400, 'channel_id comes from the URL');
    if (!GRANT_FLAGS.includes(k)) throw httpError(400, `unknown field "${k}"`);
  }
  const flags = {};
  for (const f of GRANT_FLAGS) {
    if (has(body, f)) flags[f] = toBool(body[f], f);
    else if (!partial) flags[f] = false;
  }
  return flags;
}

/**
 * Create a grant on a mailbox or (S-PH) a phone line. The channel row must
 * exist (channelExists — inactive counts). The target user must exist and
 * must not be user 0 (automations bypass grants, D6). At least one flag must
 * be true. A written grant is effective on the next request: getAccess /
 * listReadable read channel_grants directly (no cache).
 */
async function createGrant(db, { channelType = 'mailbox', channelId, body, grantedBy }) {
  assertWritableChannel(channelType);
  const cid = toId(channelId, 'channel_id');
  const flags = validateGrantBody(body, { partial: false });
  if (!has(body, 'user')) throw httpError(400, 'user is required');
  const uid = toUserId(body.user);
  if (uid === 0) {
    throw httpError(400, 'user 0 (automations) cannot hold grants — automation bypasses grants (D6)');
  }
  if (!GRANT_FLAGS.some(f => flags[f])) {
    throw httpError(400, 'a grant needs at least one of can_read, can_send, can_manage');
  }
  const granter = toUserId(grantedBy, 'granted_by');

  const noun = nounOf(channelType);
  if (!(await channelExists(db, channelType, cid))) {
    throw httpError(404, `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found`);
  }
  const [[u]] = await db.query('SELECT user FROM users WHERE user = ? LIMIT 1', [uid]);
  if (!u) throw httpError(400, `user ${uid} does not exist`);

  let result;
  try {
    [result] = await db.query(
      `INSERT INTO channel_grants
         (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid, channelType, cid, flags.can_read ? 1 : 0, flags.can_send ? 1 : 0, flags.can_manage ? 1 : 0, granter]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw httpError(409, `user ${uid} already has a grant on this ${noun} — edit it instead`);
    }
    throw err;
  }
  return { grant: await getGrant(db, result.insertId) };
}

/** Change flags on an existing grant (ownership-scoped). Never empties it. */
async function updateGrant(db, { channelType = 'mailbox', channelId, grantId, body }) {
  assertWritableChannel(channelType);
  const cid = toId(channelId, 'channel_id');
  const flags = validateGrantBody(body, { partial: true });
  if (!Object.keys(flags).length) {
    throw httpError(400, 'nothing to update — send can_read, can_send and/or can_manage');
  }
  const before = await ownedGrant(db, grantId, channelType, cid);
  const merged = { ...shapeGrantFlags(before), ...flags };
  if (!GRANT_FLAGS.some(f => merged[f])) {
    throw httpError(400, 'a grant must keep at least one of can_read, can_send, can_manage — DELETE it instead');
  }
  const cols = Object.keys(flags);
  await db.query(
    `UPDATE channel_grants SET ${cols.map(c => `${c} = ?`).join(', ')}
      WHERE id = ? AND channel_type = ? AND channel_id = ?`,
    [...cols.map(c => (flags[c] ? 1 : 0)), before.id, channelType, cid]
  );
  return { grant: await getGrant(db, before.id), before };
}

/** Hard DELETE (grants carry no history; admin_audit_log keeps the trail). */
async function deleteGrant(db, { channelType = 'mailbox', channelId, grantId }) {
  assertWritableChannel(channelType);
  const cid = toId(channelId, 'channel_id');
  const before = await ownedGrant(db, grantId, channelType, cid);
  const [result] = await db.query(
    'DELETE FROM channel_grants WHERE id = ? AND channel_type = ? AND channel_id = ?',
    [before.id, channelType, cid]
  );
  if (!result.affectedRows) throw httpError(404, `Grant not found on this ${nounOf(channelType)}`);
  return { removed: result.affectedRows, before };
}


module.exports = {
  // resolution
  isSuperuser,
  roleBypass,
  getAccess,
  listReadable,
  listSendable,
  // mailboxes
  listMailboxesFor,
  getMailbox,
  mailboxExists,
  channelExists,
  createMailbox,
  updateMailbox,
  // grants
  listGrants,
  getGrant,
  createGrant,
  updateGrant,
  deleteGrant,
  // vocabulary / helpers (routes + tests)
  httpError,
  validateIngestFolders,
  CHANNEL_TYPES,
  WRITABLE_CHANNEL_TYPES,
  CHANNEL_NOUNS,
  MANAGER_EDITABLE_FIELDS,
  ALIAS_FORBIDDEN_FIELDS,
  DEFAULT_INGEST_FOLDERS,
  DEFAULT_EMIT_SOURCE,
  EMIT_ID_KINDS,
  SU_AUTH,
  READ_BYPASS_ROLES,
};
