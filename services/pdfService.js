/**
 * services/pdfService.js
 *
 * PDF text extraction service.
 *
 * Public API:
 *   parsePdf(buffer, opts)          → { text|pages, totalPages, pagesReturned, … }
 *   fetchPdfFromUrl(url, opts)      → Buffer (SSRF-guarded, redirect-aware)
 *
 * Library: pdf-parse (loaded via internal entry to skip its index.js debug
 * harness that tries to read ./test/data on import).
 */

const pdfParse = require('pdf-parse');
const { assertSafeUrl } = require('../lib/ssrfGuard');

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-

// ─── helpers ─────────────────────────────────────────────────

function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.slice(0, 5).equals(PDF_MAGIC);
}

function err(code, message, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

/**
 * Parse a "2-4,6,9-10" syntax string into discrete ranges.
 * Returns { ranges: [{start,end},…], maxPage } or null.
 * Throws on syntax errors. Does NOT clip to total pages (caller does that).
 */
function parsePageRangeSyntax(spec) {
  if (spec == null || spec === '') return null;
  if (typeof spec !== 'string') throw err('BAD_PAGES', 'pages must be a string');

  const parts = spec.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw err('BAD_PAGES', 'pages specification is empty');

  const ranges = [];
  let maxPage = 0;
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1) throw err('BAD_PAGES', `Invalid page number: ${n}`);
      ranges.push({ start: n, end: n });
      if (n > maxPage) maxPage = n;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(part);
      if (!m) throw err('BAD_PAGES', `Invalid page range syntax: "${part}"`);
      const start = parseInt(m[1], 10);
      const end   = parseInt(m[2], 10);
      if (start < 1 || end < 1) throw err('BAD_PAGES', `Invalid page numbers in "${part}"`);
      if (start > end)         throw err('BAD_PAGES', `Range start > end in "${part}"`);
      ranges.push({ start, end });
      if (end > maxPage) maxPage = end;
    }
  }
  return { ranges, maxPage };
}

function expandPageRanges(ranges, totalPages) {
  const set = new Set();
  for (const { start, end } of ranges) {
    for (let i = start; i <= Math.min(end, totalPages); i++) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Trim a string to a window defined by literal anchors.
 * Returns { text, fromMatched, toMatched }.
 *   fromMatched/toMatched are true|false if the corresponding anchor was
 *   provided, null otherwise.
 */
function applyStringRange(text, { fromText, toText, includeFrom = true, includeTo = false }) {
  let result = text;
  let fromMatched = fromText ? false : null;
  let toMatched   = toText   ? false : null;

  if (fromText) {
    const idx = text.indexOf(fromText);
    if (idx === -1) return { text: '', fromMatched: false, toMatched };
    fromMatched = true;
    result = includeFrom ? text.slice(idx) : text.slice(idx + fromText.length);
  }

  if (toText) {
    const idx = result.indexOf(toText);
    if (idx !== -1) {
      toMatched = true;
      result = includeTo ? result.slice(0, idx + toText.length) : result.slice(0, idx);
    }
    // if not matched: keep what we have (from-to-end behavior)
  }

  return { text: result, fromMatched, toMatched };
}

/**
 * Per-line cleanup. Operates on already-split lines and rejoins.
 */
function cleanupText(text, { normalizeWhitespace, removeEmptyLines, minLineLength }) {
  if (!text) return '';
  let lines = text.split('\n');

  if (normalizeWhitespace) {
    lines = lines.map(l => l.replace(/\s+/g, ' ').trim());
  }

  if (removeEmptyLines || minLineLength > 0) {
    lines = lines.filter(l => {
      const trimmed = normalizeWhitespace ? l : l.trim();
      if (removeEmptyLines && !trimmed) return false;
      if (minLineLength > 0 && trimmed.length < minLineLength) return false;
      return true;
    });
  }

  return lines.join('\n');
}

/**
 * pdf-parse pagerender that captures per-page text into the supplied array.
 * Pages render in order (1..N), so positional push is safe.
 */
function makePageRenderer(pageTexts) {
  return async function render_page(pageData) {
    const tc = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY;
    let text = '';
    for (const item of tc.items) {
      if (lastY === undefined || lastY === item.transform[5]) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = item.transform[5];
    }
    pageTexts.push(text);
    return text;
  };
}

// ─── URL fetch with SSRF re-validation across redirects ─────

/**
 * Fetch a URL, validating safety at every redirect hop.
 * Streams body and aborts if size exceeds maxBytes.
 */
async function fetchPdfFromUrl(urlString, opts = {}) {
  const {
    maxBytes      = 25 * 1024 * 1024,
    timeoutMs     = 30000,
    maxRedirects  = 3,
  } = opts;

  let currentUrl = urlString;
  let response;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      await assertSafeUrl(currentUrl);
    } catch (e) {
      throw err('SSRF_BLOCKED', e.message, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'YisraCase-PDF/1.0' },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw err('FETCH_TIMEOUT', `Fetch timeout after ${timeoutMs}ms`);
      throw err('FETCH_FAILED', `Fetch failed: ${e.message}`);
    }
    clearTimeout(timer);

    // Follow 3xx with re-validation
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) throw err('FETCH_FAILED', `Redirect ${response.status} missing Location header`);
      if (hop === maxRedirects) throw err('FETCH_FAILED', 'Too many redirects');
      try { currentUrl = new URL(loc, currentUrl).toString(); }
      catch (e) { throw err('FETCH_FAILED', `Invalid redirect target: ${loc}`); }
      continue;
    }

    if (!response.ok) {
      throw err('FETCH_HTTP_ERROR', `HTTP ${response.status} ${response.statusText}`);
    }

    break;
  }

  // Pre-check Content-Length if present
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw err('FILE_TOO_LARGE', `File exceeds ${maxBytes} bytes (Content-Length)`);
  }

  // Stream to buffer with running size guard
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw err('FILE_TOO_LARGE', `File exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } catch (e) {
    if (e.code === 'FILE_TOO_LARGE') throw e;
    throw err('FETCH_FAILED', `Stream error: ${e.message}`);
  }

  return Buffer.concat(chunks);
}

// ─── main parser ────────────────────────────────────────────

async function parsePdf(buffer, opts = {}) {
  const {
    pages: pagesSpec      = null,
    fromText              = null,
    toText                = null,
    includeFrom           = true,
    includeTo             = false,
    output                = 'concatenated',  // 'concatenated' | 'per-page'
    includeMetadata       = false,
    maxLength             = null,
    normalizeWhitespace   = true,
    removeEmptyLines      = true,
    minLineLength         = 0,
    maxPages              = 200,
  } = opts;

  if (!isPdfBuffer(buffer)) throw err('NOT_A_PDF', 'Not a valid PDF (magic bytes mismatch)');

  if (output !== 'concatenated' && output !== 'per-page') {
    throw err('BAD_OPTION', `Invalid output mode: "${output}"`);
  }
  if (output === 'per-page' && (fromText || toText)) {
    throw err('INCOMPATIBLE_OPTIONS', 'fromText/toText cannot be combined with output=per-page');
  }

  // Parse pages syntax (no totalPages yet)
  let pageRanges = null;
  let maxPageRequested = 0;
  if (pagesSpec) {
    const parsed = parsePageRangeSyntax(pagesSpec);
    if (parsed) {
      pageRanges = parsed.ranges;
      maxPageRequested = parsed.maxPage;
    }
  }

  // Render cap = lesser of (max page user asked for) or maxPages safety cap
  const renderCap = maxPageRequested > 0 ? Math.min(maxPageRequested, maxPages) : maxPages;

  // Parse PDF, capturing per-page text
  const pageTexts = [];
  let data;
  try {
    data = await pdfParse(buffer, {
      max: renderCap,
      pagerender: makePageRenderer(pageTexts),
    });
  } catch (e) {
    if (/password|encrypt/i.test(e.message) || e.name === 'PasswordException') {
      throw err('ENCRYPTED_PDF', 'PDF is encrypted/password-protected');
    }
    if (/invalid pdf|malformed|invalid-pdf/i.test(e.message) || e.name === 'InvalidPDFException') {
      throw err('NOT_A_PDF', 'Invalid or malformed PDF');
    }
    throw err('PARSE_FAILED', `PDF parse failed: ${e.message}`);
  }

  const actualTotal   = data.numpages;
  const renderedCount = pageTexts.length;
  const renderTruncated = !pagesSpec && renderedCount < actualTotal;

  // Decide which pages to include
  let pagesToInclude;
  if (pageRanges) {
    pagesToInclude = expandPageRanges(pageRanges, Math.min(actualTotal, renderedCount));
  } else {
    pagesToInclude = [];
    for (let i = 1; i <= renderedCount; i++) pagesToInclude.push(i);
  }

  // Build per-page output (cleaned)
  const cleanupOpts = { normalizeWhitespace, removeEmptyLines, minLineLength };
  const selected = pagesToInclude.map(p => ({
    page: p,
    text: cleanupText(pageTexts[p - 1] || '', cleanupOpts),
  }));

  const out = {
    totalPages:    actualTotal,
    pagesReturned: pagesToInclude,
    fromMatched:   fromText ? false : null,
    toMatched:     toText   ? false : null,
    truncated:     renderTruncated,
  };
  if (renderTruncated) out.renderedThroughPage = renderedCount;

  if (output === 'per-page') {
    let pages = selected.map(p => ({ page: p.page, text: p.text, length: p.text.length }));
    if (maxLength != null) {
      let used = 0;
      const capped = [];
      for (const p of pages) {
        if (used + p.length > maxLength) {
          const slice = p.text.slice(0, Math.max(0, maxLength - used));
          capped.push({ page: p.page, text: slice, length: slice.length });
          out.truncated = true;
          break;
        }
        capped.push(p);
        used += p.length;
      }
      pages = capped;
    }
    out.pages = pages;
  } else {
    let concatenated = selected.map(p => p.text).join('\n\n');
    if (fromText || toText) {
      const r = applyStringRange(concatenated, { fromText, toText, includeFrom, includeTo });
      concatenated     = r.text;
      out.fromMatched  = r.fromMatched;
      out.toMatched    = r.toMatched;
    }
    if (maxLength != null && concatenated.length > maxLength) {
      concatenated = concatenated.slice(0, maxLength);
      out.truncated = true;
    }
    out.text       = concatenated;
    out.textLength = concatenated.length;
  }

  if (includeMetadata) {
    const info = data.info || {};
    out.metadata = {
      title:        info.Title        || null,
      author:       info.Author       || null,
      subject:      info.Subject      || null,
      creator:      info.Creator      || null,
      producer:     info.Producer     || null,
      creationDate: info.CreationDate || null,
      modDate:      info.ModDate      || null,
    };
  }

  return out;
}

module.exports = {
  parsePdf,
  fetchPdfFromUrl,
  // Exposed for testing
  parsePageRangeSyntax,
  expandPageRanges,
  applyStringRange,
  cleanupText,
  isPdfBuffer,
};