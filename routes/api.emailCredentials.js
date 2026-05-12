// routes/api.emailCredentials.js
//
/**
 * Email Credentials API — sender accounts for the Connections system.
 * routes/api.emailCredentials.js
 *
 * GET    /api/email-credentials                       — list, any auth user
 *                                                       (smtp_pass scrubbed;
 *                                                        joins credentials.name)
 * GET    /api/email-credentials/:id                   — admin (full row, smtp_pass scrubbed)
 * GET    /api/email-credentials/:id/reveal            — admin (decrypts smtp_pass)
 * POST   /api/email-credentials                       — admin
 * PUT    /api/email-credentials/:id                   — admin
 * DELETE /api/email-credentials/:id                   — admin
 * POST   /api/email-credentials/:id/test              — admin (sends a real test email)
 * GET    /api/email-credentials/:id/verify-aliases    — admin (gmail rows only — probes Gmail sendAs)
 *
 * Encryption-at-rest change:
 *   - smtp_pass is encrypted via lib/credentialCrypto (ENCv1: envelope) at
 *     POST/PUT time, decrypted only at the SMTP adapter and via the new
 *     /reveal endpoint. GET single no longer returns smtp_pass in the body.
 *     One-time migration of legacy plaintext rows: scripts/encrypt-smtp-passwords.js.
 *
 * Slice 4 changes (kept):
 *   - VALID_PROVIDERS expanded to ['smtp','pabbly','gmail'].
 *   - Field validation is now provider-conditional (see requiredForProvider).
 *   - credential_id wired through CRUD; defaults to NULL for non-gmail.
 *   - For provider='gmail' on save, the referenced credential must exist,
 *     be type='oauth2', and have oauth_status='connected'.
 *   - After a successful gmail save, alias verification is auto-run and
 *     returned in the response body for the UI to surface as a warning.
 *     The save is NEVER blocked — Gmail silently rewrites unrecognized
 *     same-account From: addresses, so the warning is informational, not
 *     gating. (See gmail.js Slice 2 comment block.)
 *   - admin_audit_log details now include a before/after diff for updates
 *     (smtp_pass values redacted).
 *
 * The list endpoint is the dropdown source for hooks/sequences/workflows
 * when configuring an email sender, so it remains jwtOrApiKey (not SU).
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const { encrypt, decrypt, isEncrypted } = require('../lib/credentialCrypto');
const emailService = require('../services/emailService');
const gmailAdapter = require('../services/adapters/email/gmail');

const TOOL = 'connections';

// Columns safe to expose in the list endpoint (any auth user).
// smtp_pass is intentionally omitted — admin GET single returns it.
const LIST_COLUMNS = [
  'id', 'email', 'smtp_host', 'smtp_port', 'smtp_user',
  'smtp_secure', 'provider', 'from_name', 'credential_id',
];

// Full column set for admin GET single. smtp_pass column included in the
// SELECT (so it's available for the audit diff source-of-truth load on
// PUT), but the GET single endpoint strips it from the response body.
const ALL_COLUMNS = [
  'id', 'email', 'smtp_host', 'smtp_port', 'smtp_user',
  'smtp_pass', 'smtp_secure', 'provider', 'from_name', 'credential_id',
];

// Per-provider required fields. Always required: email, provider, from_name.
const BASE_REQUIRED = ['email', 'provider', 'from_name'];
const SMTP_REQUIRED = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass'];
const GMAIL_REQUIRED = ['credential_id'];

function requiredForProvider(provider) {
  if (provider === 'smtp')  return [...BASE_REQUIRED, ...SMTP_REQUIRED];
  if (provider === 'gmail') return [...BASE_REQUIRED, ...GMAIL_REQUIRED];
  // pabbly + any other: just the base set
  return BASE_REQUIRED;
}

// Allowed on PUT.
const UPDATABLE_FIELDS = [
  'email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
  'smtp_secure', 'provider', 'from_name', 'credential_id',
];

// Fields whose old/new values are redacted in the audit diff.
const REDACTED_FIELDS = new Set(['smtp_pass']);

const VALID_PROVIDERS = ['smtp', 'pabbly', 'gmail'];

// Lightweight email-shape check; deliberately permissive. The send itself
// is the ultimate validator.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(db, row) {
  return auditAdminAction(db, row).catch(err =>
    console.error('[email-creds] audit log failed:', err.message)
  );
}

/**
 * Coerce a single input value into its DB-shaped form. Returns null for
 * "blank" credential_id input (undefined/null/empty string).
 *
 * Note: smtp_pass is NOT coerced here — encryption is applied at the
 * route-handler boundary (POST and PUT) so the loop-based PUT path can
 * special-case the "empty string = leave unchanged" behavior cleanly.
 */
function coerceField(field, value) {
  if (field === 'smtp_port')     return Number(value);
  if (field === 'smtp_secure')   return value ? 1 : 0;
  if (field === 'credential_id') {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return value;
}

/**
 * Validate that a credential_id references a usable gmail credential.
 * Returns { ok: true, cred } or { ok: false, status, message }.
 *
 * "Usable" = exists, type='oauth2', oauth_status='connected'.
 */
async function validateGmailCredential(db, credentialId) {
  if (credentialId == null) {
    return { ok: false, status: 400, message: 'credential_id is required for provider=gmail' };
  }
  const [[cred]] = await db.query(
    `SELECT id, name, type, oauth_status FROM credentials WHERE id = ?`,
    [credentialId]
  );
  if (!cred) {
    return { ok: false, status: 400, message: `credential ${credentialId} not found` };
  }
  if (cred.type !== 'oauth2') {
    return {
      ok: false, status: 400,
      message: `credential ${credentialId} (${cred.name}) is type=${cred.type}, not oauth2`,
    };
  }
  if (cred.oauth_status !== 'connected') {
    return {
      ok: false, status: 400,
      message: `credential ${credentialId} (${cred.name}) is not connected ` +
               `(oauth_status=${cred.oauth_status ?? 'null'}) — authorize it in Connections first`,
    };
  }
  return { ok: true, cred };
}

/**
 * Probe Gmail's sendAs list for an email_credentials row and compare its
 * .email against the verified alias list. Used by both the auto-verify-on-
 * save path and the GET /:id/verify-aliases endpoint.
 *
 * Returns:
 *   { ok: true, row_email, matches, matched_entry, all_aliases }   on success
 *   { ok: false, error }                                           on Gmail API failure
 *
 * Never throws — callers can fold the result into a response unconditionally.
 */
async function runAliasVerification(db, emailRow) {
  if (!emailRow || emailRow.provider !== 'gmail' || !emailRow.credential_id) {
    // Don't make this an error — auto-verify only runs when applicable. The
    // endpoint enforces gmail-only at its own boundary.
    return null;
  }
  try {
    const aliases = await gmailAdapter.listSendAs(db, emailRow.credential_id);
    const lc = String(emailRow.email || '').toLowerCase();
    const matched = aliases.find(a =>
      String(a?.sendAsEmail || '').toLowerCase() === lc
    ) || null;
    return {
      ok: true,
      row_email: emailRow.email,
      matches: !!matched,
      matched_entry: matched,
      all_aliases: aliases,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Build the data row for INSERT / UPDATE from a (validated) body. Forces
 * credential_id to null when provider is not gmail. Defaults missing SMTP
 * fields to empty/zero for non-smtp providers, since the schema is NOT NULL.
 *
 * For provider=smtp, body.smtp_pass is encrypted here before insertion —
 * it has already been validated as a non-empty string by the caller.
 *
 * The caller has already validated REQUIRED fields per provider.
 */
function buildDataRow(body) {
  const data = {
    email:     body.email,
    provider:  body.provider,
    from_name: body.from_name,
  };

  // SMTP block — required only for smtp provider. Default to empty/zero
  // for other providers (schema is NOT NULL).
  if (body.provider === 'smtp') {
    data.smtp_host   = body.smtp_host;
    data.smtp_port   = Number(body.smtp_port);
    data.smtp_user   = body.smtp_user;
    // Caller has validated smtp_pass is a non-empty string. Encrypt at the
    // route boundary; SMTP adapter decrypts at send time.
    data.smtp_pass   = encrypt(body.smtp_pass);
    data.smtp_secure = body.smtp_secure !== undefined ? (body.smtp_secure ? 1 : 0) : 1;
  } else {
    data.smtp_host   = body.smtp_host   ?? '';
    data.smtp_port   = body.smtp_port   != null ? Number(body.smtp_port) : 0;
    data.smtp_user   = body.smtp_user   ?? '';
    // Don't encrypt an empty string — the schema default for non-smtp.
    data.smtp_pass   = body.smtp_pass   ?? '';
    data.smtp_secure = body.smtp_secure !== undefined ? (body.smtp_secure ? 1 : 0) : 0;
  }

  // credential_id — only meaningful for gmail
  if (body.provider === 'gmail') {
    data.credential_id = coerceField('credential_id', body.credential_id);
  } else {
    data.credential_id = null;
  }

  return data;
}

/**
 * Build an audit-safe before/after diff. smtp_pass values are redacted
 * (replaced with the literal string '(redacted)' on either side when the
 * field appears in the diff). Fields whose values are unchanged are
 * omitted.
 */
function buildAuditDiff(before, after, touchedFields) {
  const diff = {};
  for (const f of touchedFields) {
    const a = before?.[f];
    const b = after?.[f];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (REDACTED_FIELDS.has(f)) {
      diff[f] = { from: '(redacted)', to: '(redacted)' };
    } else {
      diff[f] = { from: a ?? null, to: b ?? null };
    }
  }
  return diff;
}

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials   — list (any auth user)
//
// LEFT JOINs credentials so the UI can show the credential's name next
// to gmail rows. credential_name is null for non-gmail rows and for any
// gmail row whose credential row has been deleted (FK is not enforced
// today; if/when SET NULL semantics are wanted, add the FK).
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials', jwtOrApiKey, async (req, res) => {
  try {
    const selectCols = LIST_COLUMNS.map(c => `ec.${c}`).join(', ');
    const [rows] = await req.db.query(
      `SELECT ${selectCols}, c.name AS credential_name
         FROM email_credentials ec
         LEFT JOIN credentials c ON c.id = ec.credential_id
        ORDER BY ec.email ASC`
    );
    res.json({ status: 'success', email_credentials: rows });
  } catch (err) {
    console.error('[email-creds] list error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials/:id   — admin (row WITHOUT smtp_pass)
//
// smtp_pass is scrubbed from the response. Use the /reveal endpoint
// to retrieve the decrypted value.
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT ${ALL_COLUMNS.join(', ')} FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    // Scrub the ciphertext from the response body — clients should call
    // /:id/reveal explicitly to get the decrypted plaintext (audited).
    delete row.smtp_pass;

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { email_credential_id: row.id, email: row.email, action: 'read' },
    });

    res.json({ status: 'success', email_credential: row });
  } catch (err) {
    console.error('[email-creds] get error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials/:id/reveal   — admin (decrypts smtp_pass)
//
// SU-only. Audited. Mirrors the pattern of GET /api/credentials/:id/reveal:
// response body carries the plaintext, audit log carries only metadata.
//
// Three terminal cases:
//   - smtp_pass null/empty:      200 { revealed: { smtp_pass: null } }, empty=true in audit
//   - smtp_pass not ENCv1:        500 "not encrypted; run scripts/..." (defense — shouldn't happen post-migration)
//   - decrypt() throws:           500 with generic message, error='decrypt_failed' in audit
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials/:id/reveal', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT id, email, smtp_pass FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    // Empty / null smtp_pass — not an error (non-smtp rows have empty
    // smtp_pass by design). Audit with empty=true so the trail is clear.
    if (row.smtp_pass == null || row.smtp_pass === '') {
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'success',
        ...meta,
        details: {
          email_credential_id: row.id,
          email: row.email,
          action: 'reveal_smtp_pass',
          empty: true,
        },
      });
      return res.json({ status: 'success', revealed: { smtp_pass: null } });
    }

    // Defense-in-depth: post-migration this branch should never trigger.
    // If it does, surface loudly so the operator runs the migration.
    if (!isEncrypted(row.smtp_pass)) {
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'failed',
        errorMessage: 'smtp_pass not encrypted',
        ...meta,
        details: {
          email_credential_id: row.id,
          email: row.email,
          action: 'reveal_smtp_pass',
          error: 'not_encrypted',
        },
      });
      return res.status(500).json({
        status: 'error',
        message: 'smtp_pass is not encrypted; run scripts/encrypt-smtp-passwords.js',
      });
    }

    let plaintext;
    try {
      plaintext = decrypt(row.smtp_pass);
    } catch (decryptErr) {
      console.error('[email-creds] reveal decrypt failed:', decryptErr);
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'failed',
        errorMessage: `decrypt failed: ${decryptErr.message}`,
        ...meta,
        details: {
          email_credential_id: row.id,
          email: row.email,
          action: 'reveal_smtp_pass',
          error: 'decrypt_failed',
        },
      });
      return res.status(500).json({
        status: 'error',
        message: 'Decryption failed (corrupt data or wrong CREDENTIALS_ENCRYPTION_KEY)',
      });
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: row.id,
        email: row.email,
        action: 'reveal_smtp_pass',
      },
    });

    res.json({ status: 'success', revealed: { smtp_pass: plaintext } });
  } catch (err) {
    console.error('[email-creds] reveal error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/email-credentials   — admin
// ─────────────────────────────────────────────────────────────

router.post('/api/email-credentials', superuserOnlyFor(TOOL), async (req, res) => {
  const meta = reqMeta(req);
  try {
    const body = req.body || {};

    if (!VALID_PROVIDERS.includes(body.provider)) {
      return res.status(400).json({
        status: 'error',
        message: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    const required = requiredForProvider(body.provider);
    for (const f of required) {
      const v = body[f];
      if (v === undefined || v === null || v === '') {
        return res.status(400).json({ status: 'error', message: `${f} is required` });
      }
    }

    // Gmail-specific credential validation. Same call is repeated on PUT.
    if (body.provider === 'gmail') {
      const credId = coerceField('credential_id', body.credential_id);
      const check = await validateGmailCredential(req.db, credId);
      if (!check.ok) {
        return res.status(check.status).json({ status: 'error', message: check.message });
      }
    }

    const data = buildDataRow(body);
    const [result] = await req.db.query(`INSERT INTO email_credentials SET ?`, [data]);
    const insertId = result.insertId;

    // Auto-verify aliases for gmail rows. Result is informational only —
    // we don't block the save even if matches=false (documented Gmail
    // silent-rewrite behavior; see gmail.js Slice 2 comment).
    let aliasVerification = null;
    if (data.provider === 'gmail') {
      aliasVerification = await runAliasVerification(req.db, {
        id: insertId, ...data,
      });
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: insertId,
        email: data.email,
        provider: data.provider,
        credential_id: data.credential_id,
        action: 'create',
        alias_verified: aliasVerification?.ok ? aliasVerification.matches : null,
      },
    });

    res.json({ status: 'success', id: insertId, alias_verification: aliasVerification });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        status: 'error',
        message: 'A sender with this email already exists',
      });
    }
    console.error('[email-creds] create error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: null, email: req.body?.email ?? null, action: 'create', error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/email-credentials/:id   — admin
//
// Body may include any subset of UPDATABLE_FIELDS. Provider-conditional
// validation runs against the FINAL state (current row + body overlay).
//
// smtp_pass semantics:
//   - body.smtp_pass === undefined  → leave row's smtp_pass untouched
//   - body.smtp_pass === ''         → leave row's smtp_pass untouched
//                                     (UI sends '' when user opens the
//                                     editor but doesn't retype the pw)
//   - body.smtp_pass === '<plain>'  → encrypt('<plain>'), write to DB
// ─────────────────────────────────────────────────────────────

router.put('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const body = req.body || {};

    // Load existing row (used for provider-switch logic, validation,
    // and the audit diff).
    const [[existing]] = await req.db.query(
      `SELECT ${ALL_COLUMNS.join(', ')} FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    // Overlay body onto existing to compute the final state.
    const finalProvider = body.provider !== undefined ? body.provider : existing.provider;
    if (!VALID_PROVIDERS.includes(finalProvider)) {
      return res.status(400).json({
        status: 'error',
        message: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    // For switching provider TO smtp, ensure the resulting state has
    // SMTP fields populated — either from the body OR from the existing
    // row. (Switching from gmail/pabbly to smtp without re-supplying
    // credentials should fail loudly.)
    //
    // Note: existing.smtp_pass is ciphertext (ENCv1:…) post-migration,
    // which is truthy/non-empty — so the merged check passes when body
    // omits smtp_pass and the row already has one. ✓
    if (finalProvider === 'smtp') {
      const merged = {
        smtp_host: body.smtp_host ?? existing.smtp_host,
        smtp_port: body.smtp_port ?? existing.smtp_port,
        smtp_user: body.smtp_user ?? existing.smtp_user,
        smtp_pass: body.smtp_pass ?? existing.smtp_pass,
      };
      for (const f of SMTP_REQUIRED) {
        if (merged[f] === undefined || merged[f] === null || merged[f] === '') {
          return res.status(400).json({
            status: 'error',
            message: `${f} is required when provider=smtp`,
          });
        }
      }
    }

    // Gmail: validate the final credential_id (body override OR existing,
    // unless the provider just switched to gmail in which case body MUST
    // supply credential_id — we never inherit a previously-null id).
    if (finalProvider === 'gmail') {
      let finalCredId;
      if (body.credential_id !== undefined) {
        finalCredId = coerceField('credential_id', body.credential_id);
      } else if (existing.provider === 'gmail') {
        finalCredId = existing.credential_id;
      } else {
        finalCredId = null;
      }
      const check = await validateGmailCredential(req.db, finalCredId);
      if (!check.ok) {
        return res.status(check.status).json({ status: 'error', message: check.message });
      }
      // Stamp the validated value back onto the body so the data-builder
      // picks it up even if it wasn't explicitly supplied.
      body.credential_id = finalCredId;
      body.provider = 'gmail';
    }

    // Build the partial update. Only fields explicitly present in the body
    // are included — EXCEPT when provider is switching, in which case we
    // also force credential_id reset so smtp/pabbly rows don't leak a
    // dangling credential_id from a prior gmail config.
    //
    // smtp_pass is special-cased:
    //   - undefined or empty string → skip (leave row unchanged)
    //   - non-empty string          → encrypt before writing
    const data = {};
    const touchedFields = [];
    for (const f of UPDATABLE_FIELDS) {
      if (body[f] === undefined) continue;
      if (f === 'smtp_pass') {
        if (typeof body.smtp_pass !== 'string') continue;   // defensive
        if (body.smtp_pass === '') continue;                // "unchanged" sentinel
        data.smtp_pass = encrypt(body.smtp_pass);
        touchedFields.push('smtp_pass');
      } else {
        data[f] = coerceField(f, body[f]);
        touchedFields.push(f);
      }
    }

if (body.provider !== undefined && body.provider !== existing.provider) {
      // Provider switch: defensively reset credential_id when switching
      // AWAY from gmail. (We can't simply unconditionally reset because
      // a same-provider edit of credential_id should be allowed.)
      if (body.provider !== 'gmail' && existing.credential_id != null) {
        data.credential_id = null;
        if (!touchedFields.includes('credential_id')) touchedFields.push('credential_id');
      }

      // Provider switch: reset smtp_* columns when switching AWAY from
      // smtp. Prevents stale (and potentially still-valid) SMTP credentials
      // from sitting in the row after a switch to gmail/pabbly. Matches
      // buildDataRow's empty/zero defaults for new non-smtp rows.
      //
      // These overwrite any smtp_* values the loop above set from the
      // body. That's intentional: provider switch wins. If the caller
      // really wants to set smtp_* fields, they shouldn't also be
      // switching the provider in the same call.
      if (existing.provider === 'smtp' && body.provider !== 'smtp') {
        data.smtp_host   = '';
        data.smtp_port   = 0;
        data.smtp_user   = '';
        data.smtp_pass   = '';
        data.smtp_secure = 0;
        for (const f of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure']) {
          if (!touchedFields.includes(f)) touchedFields.push(f);
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ status: 'error', message: 'No fields to update' });
    }

    await req.db.query(`UPDATE email_credentials SET ? WHERE id = ?`, [data, id]);

    // Load the post-update row for auto-verify + diff.
    const [[after]] = await req.db.query(
      `SELECT ${ALL_COLUMNS.join(', ')} FROM email_credentials WHERE id = ?`,
      [id]
    );

    let aliasVerification = null;
    if (after.provider === 'gmail') {
      aliasVerification = await runAliasVerification(req.db, after);
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: Number(id),
        email: after.email,
        provider: after.provider,
        credential_id: after.credential_id,
        action: 'update',
        diff: buildAuditDiff(existing, after, touchedFields),
        alias_verified: aliasVerification?.ok ? aliasVerification.matches : null,
      },
    });

    res.json({ status: 'success', alias_verification: aliasVerification });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        status: 'error',
        message: 'A sender with this email already exists',
      });
    }
    console.error('[email-creds] update error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: Number(id), email: req.body?.email ?? null, action: 'update', error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/email-credentials/:id   — admin (hard delete)
// ─────────────────────────────────────────────────────────────

router.delete('/api/email-credentials/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[existing]] = await req.db.query(
      `SELECT id, email, provider, credential_id FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    await req.db.query(`DELETE FROM email_credentials WHERE id = ?`, [id]);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: Number(id),
        email: existing.email,
        provider: existing.provider,
        credential_id: existing.credential_id,
        action: 'delete',
      },
    });

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[email-creds] delete error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: Number(id), email: null, action: 'delete', error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/email-credentials/:id/verify-aliases   — admin
//
// Gmail-only. Probes Gmail's settings.sendAs.list API for the linked
// credential and reports whether the row's email is a verified alias.
//
// Response (success):
//   {
//     ok: true,
//     row_email: 'foo@4lsg.com',
//     matches:   true | false,
//     matched_entry: { sendAsEmail, displayName, isPrimary,
//                      verificationStatus, ... } | null,
//     all_aliases: [ { ... } ]
//   }
//
// Response (Gmail API failure — e.g. token revoked, scope missing):
//   { ok: false, error: '<message>' }
//
// Response (non-gmail row):
//   400 { status: 'error', message: 'verify-aliases is gmail-only' }
//
// Audit: logged regardless of outcome; alias-match result captured.
// ─────────────────────────────────────────────────────────────

router.get('/api/email-credentials/:id/verify-aliases', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT id, email, provider, credential_id FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }
    if (row.provider !== 'gmail') {
      return res.status(400).json({
        status: 'error',
        message: 'verify-aliases is gmail-only',
      });
    }
    if (!row.credential_id) {
      return res.status(400).json({
        status: 'error',
        message: 'this gmail row has no credential_id linked',
      });
    }

    const result = await runAliasVerification(req.db, row);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: result?.ok ? 'success' : 'failed',
      errorMessage: result?.ok ? null : (result?.error || 'unknown'),
      ...meta,
      details: {
        email_credential_id: row.id,
        email: row.email,
        credential_id: row.credential_id,
        action: 'verify_aliases',
        alias_matches: result?.ok ? result.matches : null,
        error: result?.ok ? null : result?.error,
      },
    });

    res.json(result || { ok: false, error: 'no result' });
  } catch (err) {
    console.error('[email-creds] verify-aliases error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { email_credential_id: Number(id), action: 'verify_aliases', error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/email-credentials/:id/test   — admin (live test send)
//
// emailService.sendEmail dispatches by the row's provider, so gmail rows
// are tested through the gmail adapter automatically. The SMTP adapter
// decrypts smtp_pass internally before opening the nodemailer transport.
// ─────────────────────────────────────────────────────────────

router.post('/api/email-credentials/:id/test', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  const to = (req.body && typeof req.body.to === 'string') ? req.body.to.trim() : '';

  if (!to || !EMAIL_RE.test(to)) {
    return res.status(400).json({ status: 'error', message: 'A valid recipient email is required' });
  }

  try {
    const [[row]] = await req.db.query(
      `SELECT id, email, from_name FROM email_credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Email credential not found' });
    }

    const sentAt = new Date().toISOString();
    const subject = `YisraCase email sender test — ${row.email}`;
    const text =
      `This is a test email from YisraCase Connections, sent at ${sentAt} ` +
      `to verify the "${row.from_name} <${row.email}>" sender configuration. ` +
      `If you received this, the sender works.`;
    const html =
      `<p>This is a test email from <strong>YisraCase Connections</strong>, ` +
      `sent at ${sentAt} to verify the "${row.from_name} &lt;${row.email}&gt;" sender configuration.</p>` +
      `<p>If you received this, the sender works.</p>`;

    try {
      await emailService.sendEmail(req.db, {
        from: row.email,
        to,
        subject,
        text,
        html,
      });
    } catch (sendErr) {
      console.error('[email-test]', sendErr);
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'failed', errorMessage: sendErr.message,
        ...meta,
        details: {
          email_credential_id: Number(id),
          from_email: row.email,
          to_email: to,
          action: 'test_send',
          error: sendErr.message,
        },
      });
      return res.status(500).json({ status: 'error', message: sendErr.message });
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        email_credential_id: Number(id),
        from_email: row.email,
        to_email: to,
        action: 'test_send',
      },
    });

    res.json({ status: 'success', sent_at: sentAt, recipient: to });
  } catch (err) {
    console.error('[email-test]', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: {
        email_credential_id: Number(id),
        from_email: null,
        to_email: to,
        action: 'test_send',
        error: err.message,
      },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;