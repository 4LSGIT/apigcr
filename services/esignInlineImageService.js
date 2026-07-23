// services/esignInlineImageService.js
//
/**
 * AUTHORING-TIME EXTERNAL-IMAGE INLINER — fetch once, freeze into the template.
 * services/esignInlineImageService.js
 *
 * 2026-07-22 slice. The render pipeline (services/pdfRenderService.js) is
 * NETWORK-LOCKED on purpose — determinism for legal documents, no SSRF from
 * staff-editable HTML inside the container, and a 1GiB memory budget (the
 * rationale lives in that file's header and is NOT to be relitigated). So a
 * template that references an external image fails its render loudly with
 * ESIGN_RENDER_EXTERNAL_REF.
 *
 * The fix belongs at the AUTHORING layer: fetch each image ONCE at
 * template-edit time, hand back data URIs, and let templateAdmin freeze the
 * bytes into the body. The render stays fully offline forever after.
 *
 * ── THIS IS AN SSRF SURFACE — TREAT IT LIKE ONE ─────────────────────────────
 * An authed endpoint that fetches caller-supplied URLs and returns the bytes
 * is a proxy into whatever network the container can see. Guards, all
 * REQUIRED (ratified):
 *
 *   https only            no http, no other scheme, no credentials in the URL
 *   address screening     the hostname is resolved BEFORE fetching and every
 *                         returned address must be public: loopback, private
 *                         (RFC1918), link-local/metadata (169.254/16 — the
 *                         cloud metadata service lives there), unspecified,
 *                         ULA fc00::/7, fe80::/10, ::1 and v4-mapped forms
 *                         are all rejected. Literal-IP hostnames are screened
 *                         directly.
 *   no redirects          a redirect is a second URL nobody screened; the
 *                         response is rejected rather than followed
 *                         (redirect: 'manual' + explicit 3xx check).
 *   content-type          image/* only
 *   size caps             MAX_IMAGE_BYTES per image, MAX_TOTAL_BYTES per
 *                         batch, enforced WHILE streaming (content-length is
 *                         advisory, a lying server is cut off mid-body)
 *   timeout               FETCH_TIMEOUT_MS per image via AbortSignal.timeout
 *
 * Residual risk, documented: DNS is resolved for screening and then resolved
 * AGAIN inside fetch — a rebinding attacker with a sub-second TTL could serve
 * a public address to the screen and a private one to the fetch (TOCTOU).
 * Node's fetch offers no way to pin the connection to the screened address
 * without swapping in a custom Agent. For a staff-authed authoring tool at a
 * 4-person firm this is accepted; revisit if this endpoint ever loosens.
 *
 * ── SIZE BUDGET vs THE SAVE CEILING ─────────────────────────────────────────
 * contract_templates.body is MEDIUMTEXT (16MB, verified live 2026-07-22), so
 * 8MB of image bytes (~10.7MB as base64) fits the COLUMN. The tighter gate is
 * the global express.json 10mb ceiling on the template save itself — a body
 * carrying the full 8MB budget plus HTML may bounce off the SAVE with a 413.
 * templateAdmin's own insert-image flow already warns at 500KB per image for
 * exactly this reason; the caps here are the hard stop, not a target.
 *
 * ── RESULT SHAPE — PER-URL, NEVER ALL-OR-NOTHING ────────────────────────────
 * One bad image must not sink the batch: inlineImages() resolves with a
 * per-URL result array ({url, ok, ...}) and only throws for malformed INPUT
 * (not an array, > MAX_URLS, non-string entries → ESIGN_INLINE_BAD_INPUT).
 * The UI shows what embedded and what failed, and why.
 */

const net = require('net');
const dns = require('dns');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Per-image byte cap — mirrors templateAdmin's insert-image reject line. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Per-batch byte cap. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Most images a single call may name. */
const MAX_URLS = 20;

/** Per-image fetch timeout. */
const FETCH_TIMEOUT_MS = 10 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE GUARDS (exported for jest)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this IP address one we refuse to fetch from?
 *
 * v4: 0.0.0.0/8 (unspecified/"this network"), 10/8, 127/8 (loopback),
 *     169.254/16 (link-local — cloud metadata), 172.16/12, 192.168/16,
 *     255.255.255.255.
 * v6: :: and ::1, fc00::/7 (ULA), fe80::/10 (link-local), and v4-mapped
 *     (::ffff:a.b.c.d) forms screened as their embedded v4.
 *
 * Unparseable input is FORBIDDEN — this is a deny-by-default guard.
 *
 * @param {string} ip
 * @returns {boolean} true = do not fetch
 */
function isForbiddenIp(ip) {
  const s = String(ip == null ? '' : ip).trim().replace(/^\[|\]$/g, '');
  const kind = net.isIP(s);
  if (kind === 4) {
    const parts = s.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10/8
    if (a === 127) return true;                     // 127/8
    if (a === 169 && b === 254) return true;        // 169.254/16 (metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;        // 192.168/16
    if (s === '255.255.255.255') return true;
    return false;
  }
  if (kind === 6) {
    const low = s.toLowerCase();
    if (low === '::' || low === '::1') return true;
    // v4-mapped — screen the embedded v4. Node presents these dotted
    // (::ffff:10.0.0.1); a hex-tail mapped form is rejected as unparseable
    // v4 → forbidden, which is the safe direction.
    if (low.startsWith('::ffff:')) return isForbiddenIp(low.slice(7));
    const firstHextet = low.split(':')[0];
    if (firstHextet === 'fc00' || firstHextet.length === 4) {
      // fc00::/7 → first hextet fc00–fdff
      if (/^f[cd]/.test(firstHextet)) return true;
      // fe80::/10 → first hextet fe80–febf
      if (/^fe[89ab]/.test(firstHextet)) return true;
    } else if (/^f[cd]/.test(firstHextet) || /^fe[89ab]/.test(firstHextet)) {
      return true;
    }
    return false;
  }
  return true; // not an IP at all → never fetchable by address
}

/**
 * Shape-level URL screen — everything checkable WITHOUT the network.
 * @param {*} raw
 * @returns {{ok:boolean, reason?:string}}
 */
function validateImageUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'not_a_url' };
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return { ok: false, reason: 'not_a_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https_only' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  if (!u.hostname) return { ok: false, reason: 'not_a_url' };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCHING
// ─────────────────────────────────────────────────────────────────────────────

// Injection seam for jest (firmConfig _test precedent): the suite swaps the
// network out, the production paths never touch this indirection's defaults.
let _fetch  = (...args) => fetch(...args);
let _lookup = (host, opts) => dns.promises.lookup(host, opts);

/**
 * Fetch ONE screened image. Never throws — a per-URL result either way.
 *
 * @param {string} url
 * @param {number} remainingBudget  bytes still available in the batch
 * @returns {Promise<object>} {url, ok:true, content_type, bytes, data_uri}
 *                          | {url, ok:false, error}
 */
async function _fetchOne(url, remainingBudget) {
  const shape = validateImageUrl(url);
  if (!shape.ok) return { url, ok: false, error: shape.reason };

  if (remainingBudget <= 0) return { url, ok: false, error: 'total_budget_exceeded' };

  // ── address screening BEFORE any connection ─────────────────────────────
  const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await _lookup(host, { all: true });
    } catch (_) {
      return { url, ok: false, error: 'dns_failed' };
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    return { url, ok: false, error: 'dns_failed' };
  }
  for (const a of addresses) {
    if (isForbiddenIp(a && a.address)) return { url, ok: false, error: 'forbidden_address' };
  }

  // ── the fetch itself ────────────────────────────────────────────────────
  let res;
  try {
    res = await _fetch(url, {
      redirect: 'manual',                       // a redirect is an unscreened URL
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'image/*' },
    });
  } catch (err) {
    const name = err && (err.name || (err.cause && err.cause.name));
    return { url, ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  }

  if (res.status >= 300 && res.status < 400) return { url, ok: false, error: 'redirect_not_followed' };
  if (!res.ok) return { url, ok: false, error: `http_${res.status}` };

  const contentType = String(res.headers.get('content-type') || '')
    .split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) return { url, ok: false, error: 'not_an_image' };

  const cap = Math.min(MAX_IMAGE_BYTES, remainingBudget);
  const overCapError = (n) => (n > MAX_IMAGE_BYTES ? 'image_too_large' : 'total_budget_exceeded');

  // content-length is advisory — trust it only to fail fast.
  const declared = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > cap) {
    return { url, ok: false, error: overCapError(declared) };
  }

  // Read with a RUNNING cap: a server that lied about (or omitted)
  // content-length is cut off the moment it crosses the line.
  let buf;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) {
          reader.cancel().catch(() => {});
          return { url, ok: false, error: overCapError(total) };
        }
        chunks.push(Buffer.from(value));
      }
      buf = Buffer.concat(chunks);
    } else {
      // Test doubles (and any body-less Response) land here; the cap still
      // holds, just after the read instead of during it.
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > cap) return { url, ok: false, error: overCapError(buf.length) };
    }
  } catch (_) {
    return { url, ok: false, error: 'read_failed' };
  }

  if (!buf.length) return { url, ok: false, error: 'empty_body' };

  return {
    url,
    ok: true,
    content_type: contentType,
    bytes: buf.length,
    data_uri: `data:${contentType};base64,${buf.toString('base64')}`,
  };
}

/**
 * Inline a batch of image URLs as data URIs.
 *
 * Sequential on purpose: the running total-budget check needs an order, and
 * an authoring-time tool for a handful of images gains nothing from
 * parallelism it would pay for in interleaved-cap complexity.
 *
 * @param {string[]} urls
 * @returns {Promise<{images: object[], totalBytes: number}>}
 * @throws  ESIGN_INLINE_BAD_INPUT  urls not an array / too many / non-strings
 */
async function inlineImages(urls) {
  if (!Array.isArray(urls) || !urls.length) {
    throw _err('ESIGN_INLINE_BAD_INPUT', 'Supply `urls` — a non-empty array of image URLs.');
  }
  if (urls.length > MAX_URLS) {
    throw _err('ESIGN_INLINE_BAD_INPUT', `At most ${MAX_URLS} images per call (got ${urls.length}).`);
  }
  if (!urls.every((u) => typeof u === 'string')) {
    throw _err('ESIGN_INLINE_BAD_INPUT', 'Every entry in `urls` must be a string.');
  }

  const images = [];
  let totalBytes = 0;
  for (const url of urls) {
    const out = await _fetchOne(url, MAX_TOTAL_BYTES - totalBytes);
    if (out.ok) totalBytes += out.bytes;
    images.push(out);
  }
  return { images, totalBytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SEAM
// ─────────────────────────────────────────────────────────────────────────────

function _test({ fetchImpl, lookupImpl } = {}) {
  if (fetchImpl)  _fetch  = fetchImpl;
  if (lookupImpl) _lookup = lookupImpl;
  return { _fetchOne };
}

module.exports = {
  inlineImages,
  // pure guards
  validateImageUrl,
  isForbiddenIp,
  // constants
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_URLS,
  FETCH_TIMEOUT_MS,
  // test seam
  _test,
};
