// Landing-host SUBRESOURCE GUARD (2026-09-04).
//
// WHY THIS FILE EXISTS
// --------------------
// routes/pageLanding.js dead-ends every path not on landingAllowed()'s list.
// For a *navigation* that failure is loud — the visitor lands on the firm
// site instead of the page they asked for. For a *subresource* it is silent:
// the browser asks for /theme.css, gets a 302 to https://legalsolutions.group
// with content-type text/html, quietly refuses to apply it as a stylesheet,
// and renders the page. No console error the staff would ever see, no 500, no
// alert — just a form that looks wrong to whoever opens the SMS link.
//
// That is exactly what happened: the theme arc added
// `<link rel="stylesheet" href="/theme.css">` to public/forms/render.html
// while the origin-separation allowlist (2026-08-16) predated it and had no
// entry for that path. yc-forms.css is fully tokenised, so with the token
// sheet missing every var() in it became invalid-at-computed-value-time and
// the external form rendered with no font, no surfaces and no borders. It
// shipped and sat there because nothing connects "I added a <link> to a page"
// to "that page is served on a gated host".
//
// This test is that connection. It reads the HTML the landing host actually
// serves, pulls out every absolute subresource URL, and asserts each one
// passes the real landingAllowed() predicate.
//
// SCOPE — what this does NOT cover, stated honestly:
//   · Subresources built at runtime in JS. render.html's hook loader does
//     `s.src = '/forms/hooks/' + name + '.js'`; no static scan can see that.
//     HOOK_FILE_RE covers it and pageLanding.originsep.test.js locks it, but a
//     NEW dynamic asset path would slip past this guard. Add it to
//     DYNAMIC_SUBRESOURCES below when you add one.
//   · <a href> navigations. Deliberate: those fail loudly (the visitor sees
//     the firm site), and link targets are frequently built by string
//     concatenation, which produces junk candidates.
//   · Anything the allowlisted pages fetch via XHR — those are /api/ext/*,
//     /api/book/*, /api/m/* and are prefix/pattern-locked in
//     pageLanding.originsep.test.js.
'use strict';

const fs = require('fs');
const path = require('path');

const pageLanding = require('../routes/pageLanding');
const landingAllowed = pageLanding._landingAllowed;

const REPO = path.join(__dirname, '..');

// ── The files the landing host can put in front of a browser ───────────────
// Keep this list in step with landingAllowed(). Every entry is asserted to
// EXIST below, so a rename can't silently drop a file out of coverage.
//
// The three route files are here because they emit HTML inline rather than
// serving a template: taskActions.js (/t/:token), decisionActions.js
// (/d/:token) and videoLanding.js (which renders views/v.html). booking.js
// and manage.js serve public/book.html and public/manage.html respectively.
const LANDING_HTML = [
  'public/forms/render.html',   // /forms/render.html — the external renderer
  'public/book.html',           // /book/:slug, /b/:slug
  'public/manage.html',         // /m, /m/:token
  'views/v.html',               // /v/:slug
  'routes/videoLanding.js',     // inline HTML around views/v.html
  'routes/taskActions.js',      // /t/:token and its confirm pages
  'routes/decisionActions.js',  // /d/:token, /d/:token/:value
  'routes/booking.js',
  'routes/manage.js',
];

// CSS served on the landing host — url() references (fonts, background
// images) are subresources too and die the same silent death.
const LANDING_CSS = [
  'public/theme.css',
  'public/css/yc-forms.css',
];

// Subresource paths assembled at runtime, which the static scan cannot see.
// Listed explicitly so they are still checked against the allowlist.
const DYNAMIC_SUBRESOURCES = [
  '/forms/hooks/_yc_hook_util.js',   // render.html hook loader, HOOK_FILE_RE
];

// ── Extraction ─────────────────────────────────────────────────────────────
// Subresource-bearing tags only. <a> is excluded on purpose (see SCOPE).
const TAG_RE = /<(?:link|script|img|iframe|frame|embed|object|source|track|audio|video|image|use)\b[^>]*>/gi;
// Attribute values, tolerating the backslash-escaped quotes that appear when
// HTML is embedded in a JS string literal.
const ATTR_RE = /\b(?:src|href|poster|data|xlink:href)\s*=\s*\\?["']([^"'\\>]+)/gi;
const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

/**
 * Keep only values that are genuinely same-origin absolute paths.
 * Dropped: external URLs, protocol-relative //, fragments, data:/blob:,
 * relative paths (they resolve against the serving page, which is already
 * allowlisted), and anything carrying template/concat syntax — {{VIDEO_URL}},
 * ${htmlEscape(...)}, "' + token + '" — which is a runtime value, not a path.
 */
function isCheckablePath(v) {
  if (!v.startsWith('/')) return false;   // also excludes {{…}}, ${…}, http(s), data:
  if (v.startsWith('//')) return false;   // protocol-relative → external
  return !/[{}$`'"+\s\\]/.test(v);
}

function subresourcePaths(text) {
  const found = new Set();
  for (const tag of text.match(TAG_RE) || []) {
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(tag)) !== null) found.add(m[1]);
  }
  return [...found].filter(isCheckablePath);
}

function cssUrlPaths(text) {
  const found = new Set();
  CSS_URL_RE.lastIndex = 0;
  let m;
  while ((m = CSS_URL_RE.exec(text)) !== null) found.add(m[1].trim());
  return [...found].filter(isCheckablePath);
}

/** landingAllowed is path-only; a ?v= cache-buster must not defeat the check. */
const allowed = (p) => landingAllowed({ path: p.split(/[?#]/)[0], method: 'GET' });

// ── Sanity: the extractor itself ───────────────────────────────────────────
// A scan that silently matches nothing is worse than no scan, so prove the
// regexes and the filter both work before trusting their verdict.
describe('extractor sanity', () => {
  test('pulls absolute subresources and rejects the rest', () => {
    const sample = `
      <link rel="stylesheet" href="/theme.css">
      <script src="/js/yc-forms.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
      <img src="//cdn.example/x.png">
      <img src="{{POSTER_URL}}">
      <img src="\${htmlEscape(v.gcs_poster_url)}">
      <a href="/login">not a subresource</a>
      <link href="/css/yc-forms.css?v=3" rel="stylesheet">
    `;
    expect(subresourcePaths(sample).sort())
      .toEqual(['/css/yc-forms.css?v=3', '/js/yc-forms.js', '/theme.css']);
  });

  test('pulls css url() targets', () => {
    expect(cssUrlPaths(`a{background:url("/assets/x.png")} b{src:url(https://e/f.woff)}`))
      .toEqual(['/assets/x.png']);
  });

  test('landingAllowed is actually reachable through the router export', () => {
    expect(typeof landingAllowed).toBe('function');
    expect(allowed('/css/yc-forms.css')).toBe(true);
    expect(allowed('/login')).toBe(false);
  });
});

// ── The guard ──────────────────────────────────────────────────────────────
describe('every subresource on the landing host is allowlisted', () => {
  test('the scanned file list is real (a rename must fail loudly, not silently)', () => {
    for (const rel of [...LANDING_HTML, ...LANDING_CSS]) {
      expect({ file: rel, exists: fs.existsSync(path.join(REPO, rel)) })
        .toEqual({ file: rel, exists: true });
    }
  });

  test.each(LANDING_HTML)('%s', (rel) => {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const p of subresourcePaths(text)) {
      // Object form so a failure names the file AND the path, rather than
      // reporting a bare `false !== true` on line N of some test file.
      expect({ file: rel, subresource: p, allowedOnLandingHost: allowed(p) })
        .toEqual({ file: rel, subresource: p, allowedOnLandingHost: true });
    }
  });

  test.each(LANDING_CSS)('%s url() targets', (rel) => {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const p of cssUrlPaths(text)) {
      expect({ file: rel, subresource: p, allowedOnLandingHost: allowed(p) })
        .toEqual({ file: rel, subresource: p, allowedOnLandingHost: true });
    }
  });

  test.each(DYNAMIC_SUBRESOURCES)('runtime-built subresource %s', (p) => {
    expect(allowed(p)).toBe(true);
  });

  // The regression itself, named. render.html is the file that broke and
  // /theme.css is the link that broke it; if either is ever removed the
  // generic scan above would go quiet without anyone noticing the coverage
  // loss, so assert the pairing directly.
  test('LOCK: render.html still links /theme.css, and it is allowlisted', () => {
    const html = fs.readFileSync(path.join(REPO, 'public/forms/render.html'), 'utf8');
    expect(subresourcePaths(html)).toContain('/theme.css');
    expect(allowed('/theme.css')).toBe(true);
  });
});
