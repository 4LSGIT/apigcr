// routes/api.freelook.js
//
// Free-look court-document capture (TEST build — self-contained).
//
// An automation parses the doc1 magic_num URL out of an NEF and POSTs
// { url, case_number, title } here (jwtOrApiKey). We fetch the PDF — which
// CONSUMES the one-shot free look — then store it in the case's Dropbox folder
// under court_docs/<title>. Because the look can't be re-taken for free, any
// failure on the primary path falls back to a fixed Dropbox folder so the
// document is never lost.
//
// If this proves out, lift fetchFreeLook() into services/ (+ maybe an
// internal_function). Auto-mounted by the routes loader.

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const dropbox     = require('../services/dropboxService');

// ── Config ───────────────────────────────────────────────────────────────────
// Where docs we can't file on their case land. Leading spaces are
// sort-significant in the firm tree — SET THIS to a real folder; it auto-creates
// on first write. Fallback filename carries case_number + timestamp.
const FALLBACK_DIR        = '/  Law Office/   Cases/ _Unfiled Court Docs';
const COURT_SUBFOLDER     = 'court_docs';
const ALLOWED_HOST_SUFFIX = '.uscourts.gov'; // SSRF guard on the inbound url
const FETCH_TIMEOUT_MS    = 30000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function hostAllowed(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'uscourts.gov' || h.endsWith(ALLOWED_HOST_SUFFIX);
  } catch { return false; }
}

function sanitizeName(s, fallback) {
  let v = String(s == null ? '' : s)
    .replace(/[\/\\:*?"<>|\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) v = fallback;
  return v.slice(0, 150).trim();
}

const ensurePdf = (name) => (/\.pdf$/i.test(name) ? name : `${name}.pdf`);
const nowStamp  = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

/** Collect set-cookie name=value pairs into one Cookie header value. */
function cookieHeader(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  return list.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

/**
 * Fetch a CM/ECF free-look PDF. The magic_num link returns an HTML viewer whose
 * iframe points at a session-bound show_temp.pl temp file; that must be fetched
 * in the SAME cookie session. CONSUMES the one free look. Throws Error w/ .code.
 */
async function fetchFreeLook(nefDocUrl) {
  const origin = new URL(nefDocUrl).origin;
  const UA  = 'Mozilla/5.0 (compatible; YisraCase/1.0 free-look fetch)';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Step 1 — viewer page (consumes look, sets session cookie, builds temp PDF)
    const r1  = await fetch(nefDocUrl, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA } });
    const ct1 = (r1.headers.get('content-type') || '').toLowerCase();
    if (ct1.includes('application/pdf')) return Buffer.from(await r1.arrayBuffer()); // some courts serve PDF directly

    const cookies = cookieHeader(r1.headers);
    const html    = await r1.text();

    if (/login|cso-?login|pacer.*password/i.test(html) && !/show_temp\.pl/i.test(html)) {
      const e = new Error('magic_num spent or invalid — login page returned'); e.code = 'LOOK_CONSUMED'; throw e;
    }
    const m = html.match(/(?:src|href)\s*=\s*["']([^"']*show_temp\.pl\?[^"']+)["']/i);
    if (!m) {
      const e = new Error('no show_temp.pl link — multi-doc menu or unexpected layout'); e.code = 'NOT_SINGLE_DOC'; throw e;
    }
    const pdfUrl = new URL(m[1].replace(/&amp;/g, '&'), origin).href;

    // Step 2 — the real PDF, same session
    const r2 = await fetch(pdfUrl, {
      redirect: 'follow', signal: ctl.signal,
      headers: { 'User-Agent': UA, Referer: nefDocUrl, ...(cookies ? { Cookie: cookies } : {}) },
    });
    const ct2    = (r2.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await r2.arrayBuffer());
    if (!ct2.includes('pdf') && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      const e = new Error(`expected PDF, got ${ct2 || 'unknown'} (${buffer.length} bytes)`); e.code = 'NOT_PDF'; throw e;
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

// ── Route ────────────────────────────────────────────────────────────────────
// POST /api/court/free-look   { url, case_number, title }
router.post('/api/court/free-look', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { url, case_number, title } = req.body || {};

  // 1. Validate
  if (!url || typeof url !== 'string')
    return res.status(400).json({ status: 'error', stage: 'validate', message: 'url is required' });
  if (!hostAllowed(url))
    return res.status(400).json({ status: 'error', stage: 'validate', message: 'url host must be *.uscourts.gov' });
  if (!case_number || typeof case_number !== 'string')
    return res.status(400).json({ status: 'error', stage: 'validate', message: 'case_number is required' });

  const safeTitle = ensurePdf(sanitizeName(title, `court-doc-${nowStamp()}`));

  // 2. Look up the case's Dropbox folder (cheap; before we consume the look)
  let caseDropbox = null;
  let fallbackReason = null;
  try {
    const [rows] = await db.query(
      'SELECT case_dropbox FROM cases WHERE case_number = ? LIMIT 1',
      [case_number]
    );
    if (!rows || rows.length === 0)  fallbackReason = 'no_case_row';
    else if (!rows[0].case_dropbox)  fallbackReason = 'no_case_dropbox';
    else                             caseDropbox = rows[0].case_dropbox;
  } catch (e) {
    console.error('[free-look] case lookup failed:', e.message);
    fallbackReason = 'case_lookup_failed';
  }

  // 3. Fetch — CONSUMES THE ONE-SHOT FREE LOOK
  let buffer;
  try {
    buffer = await fetchFreeLook(url);
  } catch (e) {
    const code = e.code || 'FETCH_FAILED';
    const http = code === 'LOOK_CONSUMED' ? 409
               : (code === 'NOT_PDF' || code === 'NOT_SINGLE_DOC') ? 422
               : 502;
    console.error(`[free-look] fetch failed (${code}) for ${case_number}: ${e.message}`);
    return res.status(http).json({ status: 'error', stage: 'fetch', code, message: e.message });
  }

  // 4. Store: primary (case folder / court_docs / title) → fallback on any failure
  if (caseDropbox) {
    try {
      const meta = await dropbox.uploadFile(db, {
        sharedLink: caseDropbox,
        subfolder:  COURT_SUBFOLDER,
        filename:   safeTitle,
        content:    buffer,
      });
      return res.json({
        status: 'success', target: 'case', case_number,
        dropbox_path: meta?.path_display || meta?.path_lower || null,
        size_bytes: buffer.length,
      });
    } catch (e) {
      console.error(`[free-look] primary upload failed for ${case_number}: ${e.message} — falling back`);
      fallbackReason = 'primary_upload_failed';
    }
  }

  // 5. Fallback — the consumed doc must not be lost
  const fbFile = ensurePdf(`${sanitizeName(case_number, 'unknown-case')} - ${sanitizeName(title, 'court-doc')} - ${nowStamp()}`);
  try {
    const meta = await dropbox.uploadFile(db, {
      path:    `${FALLBACK_DIR.replace(/\/+$/, '')}/${fbFile}`,
      content: buffer,
    });
    return res.json({
      status: 'success', target: 'fallback', reason: fallbackReason || 'unknown', case_number,
      dropbox_path: meta?.path_display || meta?.path_lower || null,
      size_bytes: buffer.length,
    });
  } catch (e) {
    console.error(`[free-look] FALLBACK upload ALSO failed for ${case_number}: ${e.message}. Fetched ${buffer.length} bytes, NOT stored.`);
    return res.status(500).json({
      status: 'error', stage: 'storage', reason: fallbackReason || 'unknown',
      message: `Fetched ${buffer.length} bytes but both primary and fallback Dropbox writes failed: ${e.message}`,
    });
  }
});

module.exports = router;