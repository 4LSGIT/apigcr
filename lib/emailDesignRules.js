// lib/emailDesignRules.js
//
/**
 * YisraMail C3a — save-time validation of a Designer email design
 * (ref/YISRAMAIL_DESIGN.md §6.3 "As built (C3a)").
 *
 * Implements the C3 spike's "Server-side validation rules for C3 proper:
 * REJECT on save, never strip" (rules 1–10), applied to `design_json` AND
 * `html` INDEPENDENTLY — the html is never assumed to be compile(design_json).
 * A failure throws DesignRejected { status 400, code 'design_rejected', rule,
 * detail }; nothing is ever removed or repaired. Rule 10's Gmail-clip case is
 * a WARNING returned with the success.
 *
 * WHY THIS IS THE SECURITY BOUNDARY: GrapesJS renders a stored design's
 * component attributes, `content` and `script` straight into its canvas — a
 * same-origin frame inside a pane that reaches parent.apiSend (spike Q4: 12 of
 * 26 payloads ran in the stock editor). The editor's canvas CSP is defence in
 * depth; a crafted save request bypasses the editor entirely, so this module
 * decides. Some component properties render in the PANE itself (outside the
 * canvas and its CSP): a toolbar item's label, a layer `icon` / `name`, a
 * stored trait. GrapesJS 0.23.8's Component.toJSON deletes `toolbar` and
 * `traits` (checked against the pinned grapes.min.js), so a real save never
 * carries them — a stored one is refused (rules 4 / 5, see below).
 *
 * LINEAR (CLAUDE.md validator rule): no regex here has a nested or
 * overlapping quantifier; the html goes through parse5 with two guards that
 * keep parse5 itself linear on hostile input —
 *   - a tree-depth cap (parse5's scope walks are O(depth) per token: 390 KB of
 *     nested <div> + <li> took 13 s unguarded, 2026-11-04), and
 *   - a pre-parse attribute-count scan (parse5's tokenizer checks each new
 *     attribute against the tag's earlier ones — O(a²): one tag with 200k
 *     attributes took 50 s). The scan mirrors the tokenizer's tag / comment /
 *     raw-text states exactly once <script>, <svg>, <math>, <select> and
 *     <frameset> are refused BEFORE the parse: script data has escape states
 *     (`<!--<script>` double-escapes it, so the real end comes after the first
 *     </script> — a scan that ends it there desyncs into a fake raw-text block
 *     and misses a tag: 4.7 s at 506 KB, review round 1), and the other four
 *     change which raw-text tags switch the tokenizer (foreign content and the
 *     select / frameset insertion modes).
 * Worst cases are pinned by tests/emailDesignRules.timing.test.js.
 */

'use strict';

const parse5 = require('parse5');

// ── limits ──────────────────────────────────────────────────────────────────
const MAX_DESIGN_BYTES = 512 * 1024;     // rule 1: design_json size cap (UTF-8 bytes of its JSON)
const MAX_COMPONENT_DEPTH = 40;          // rule 1: component nesting (the wrapper is depth 1)
const MAX_JSON_DEPTH = 200;              // rule 1: any object/array nesting — bounds every walk below
const HTML_WARN_BYTES = 95 * 1024;       // rule 10: warn — Gmail clips at about 102 KB
const HTML_MAX_BYTES = 512 * 1024;       // rule 10: hard ceiling — bounds the parse (5× the clip)
const HTML_MAX_DEPTH = 128;              // rule 7: element nesting in the html (MJML output is ~25)
const HTML_MAX_ATTRS = 256;              // rule 7: attributes on one tag
const MAX_CONDITIONAL_NESTING = 3;       // rule 7: <!--[if …]> inside <!--[if …]> fragments
const MAX_CONDITIONALS = 400;            // rule 7: conditional comments parsed per html (MJML emits ~4 per section)

// ── vocabularies ────────────────────────────────────────────────────────────
const ALLOWED_TOP_KEYS = new Set(['assets', 'styles', 'pages', 'symbols', 'dataSources']);
const PAGE_KEYS = new Set(['id', 'type', 'frames']);
const FRAME_KEYS = new Set(['id', 'component', 'width', 'height']);
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MJ_TYPES = new Set(['wrapper', 'mjml', 'mj-head', 'mj-title', 'mj-preview', 'mj-attributes', 'mj-all', 'mj-body',
  'mj-section', 'mj-column', 'mj-text', 'mj-image', 'mj-button', 'mj-divider', 'mj-spacer', 'mj-group']);
/** Components whose children are inline text (rule 2's "inside mj-text" set). */
const TEXT_CONTAINERS = new Set(['mj-text', 'mj-button']);
const HEAD_TEXT_TAGS = new Set(['mj-title', 'mj-preview']);
/**
 * MJML elements grapesjs-mjml 1.0.8 registers NO component type for (its bundle registers mj-head,
 * mj-body, mj-section, mj-column, mj-text, mj-button, mj-image, mj-divider, mj-spacer, mj-group …
 * but not these): GrapesJS stores them as type 'text' (text-only children — <mj-title> /
 * <mj-preview> in the spike's q1_project.json) or the default type, carrying the tagName. Rule 2's
 * list names them, so they are admitted in that shape, in their MJML place.
 */
const UNREGISTERED_MJ = Object.freeze({ 'mj-title': 'mj-head', 'mj-preview': 'mj-head', 'mj-attributes': 'mj-head', 'mj-all': 'mj-attributes' });
const INLINE_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'a', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'div', 'sup', 'sub']);
const INLINE_TYPES = new Set(['textnode', 'text', 'link']);
/** rule 2's explicit refusals (type or tagName), plus mj-raw. */
const REJECT_TAGS = new Set(['mj-raw', 'script', 'iframe', 'object', 'embed', 'svg', 'input', 'form', 'details',
  'audio', 'video', 'meta', 'link', 'style', 'base']);
/**
 * rule 7's tag refusals in the html: rule 2's list minus meta / style (MJML emits both — rule 7
 * refuses only <meta http-equiv=refresh>, and rule 8 checks every <style>), plus the iframe kin
 * frame / frameset / applet. <math>, <select> and <frameset> are also refused BEFORE the parse
 * (they would desynchronise the attribute scan — see the header).
 */
const HTML_REJECT_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'svg', 'math', 'input', 'form', 'details',
  'audio', 'video', 'link', 'base', 'frame', 'frameset', 'applet', 'select']);
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'background', 'background-url', 'poster', 'data', 'cite']);
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'xlink:href']);
/** The URL-valued pseudo-table tags a URL may START with (rule 6). firm.* has no URL-valued key today. */
const URL_LEADING_TAGS = Object.freeze(['send.unsubscribe_url', 'send.preferences_url']);
/** What may sit inside the html's footer-slot element besides whitespace and the marker (rule 9). */
const SLOT_HTML_TAGS = new Set(['div', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'p', 'span', 'br', 'center']);
const SLOT_CLASS = 'yc-footer';
/** RAWTEXT / RCDATA elements: their content ends at the first "</name" + [ws / >] (no escape states). <script> is refused, never scanned. */
const RAWTEXT_TAGS = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'title', 'textarea']);
/** Refused before the parse: they would desynchronise the attribute scan from parse5's tokenizer (header). */
const PRE_PARSE_REFUSED = Object.freeze(['script', 'svg', 'math', 'select', 'frameset']);

/** The C2 marker (campaignService.FOOTER_SLOT — tests pin the equality) and its comment body. */
const FOOTER_SLOT = '<!-- yc:footer-slot -->';
const MARKER_CONTENT = FOOTER_SLOT.slice(4, -3);   // ' yc:footer-slot '
const MARKER_TOKEN = 'yc:footer-slot';

// ── errors ──────────────────────────────────────────────────────────────────
class DesignRejected extends Error {
  constructor(rule, detail) {
    super(`Design rejected (rule ${rule}): ${detail}`);
    this.name = 'DesignRejected';
    this.status = 400;
    this.code = 'design_rejected';
    this.rule = rule;
    this.detail = detail;
  }
}
function reject(rule, detail) { throw new DesignRejected(rule, detail); }

// ── small helpers (linear) ──────────────────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (s) => { const t = String(s); return t.length > 60 ? `${t.slice(0, 60)}…` : t; };
/** ASCII-only lowercase: same length as the input (String#toLowerCase can lengthen a string). */
function asciiLower(s) { return s.replace(/[A-Z]+/g, (m) => m.toLowerCase()); }
function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
const isEmptyValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
/** Whitespace, control and zero-width characters — a single character class, so linear. */
const INVISIBLE_RE = /[\u0000- \u007f-\u009f\s​-‍⁠﻿]+/g;
const isBlank = (s) => String(s).replace(INVISIBLE_RE, '') === '';

/**
 * HTML entities decoded exactly as a browser decodes an attribute value: the value is parsed as
 * one double-quoted attribute (its own `"` re-encoded first), so parse5's spec decoder does it.
 */
function decodeAttrEntities(v) {
  const s = String(v);
  if (s.indexOf('&') === -1) return s;
  const frag = parse5.parseFragment(`<a x="${s.split('"').join('&quot;')}">`);
  const a = frag.childNodes && frag.childNodes[0];
  return a && a.attrs && a.attrs[0] ? a.attrs[0].value : s;
}

/** rule 6: → null when allowed, else the reason. `decoded` = entities already decoded (parse5 output). */
function urlProblem(raw, decoded = false) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  let s = String(raw);
  if (!decoded) s = decodeAttrEntities(s);
  s = asciiLower(s.replace(INVISIBLE_RE, ''));
  if (s === '') return null;
  if (s.startsWith('{{')) {
    for (const tag of URL_LEADING_TAGS) if (s.startsWith(`{{${tag}}}`)) return null;
    return `a URL that starts with a merge tag must start with {{send.unsubscribe_url}} or {{send.preferences_url}} — never a contact field (${short(raw)})`;
  }
  if (s.startsWith('https:') || s.startsWith('http:') || s.startsWith('mailto:') || s.startsWith('tel:') || s.startsWith('#')) return null;
  return `URL scheme not allowed — only https:, http:, mailto:, tel: and #… (${short(raw)})`;
}
/** srcset = comma-separated candidates "url [descriptor]" — each url checked. */
function srcsetProblem(raw, decoded = false) {
  const s = decoded ? String(raw) : decodeAttrEntities(raw);
  for (const cand of s.split(',')) {
    const t = cand.trim();
    if (!t) continue;
    const sp = t.search(/\s/);
    const p = urlProblem(sp === -1 ? t : t.slice(0, sp), true);
    if (p) return p;
  }
  return null;
}
function urlAttrProblem(name, value, decoded) {
  return name === 'srcset' ? srcsetProblem(value, decoded) : urlProblem(value, decoded);
}

/** rule 4: → null when the attribute NAME is allowed, else the reason. */
function attrNameProblem(name) {
  const n = asciiLower(String(name));
  if (n.startsWith('on')) return `event-handler attribute "${short(name)}"`;
  if (FORBIDDEN_ATTRS.has(n)) return `attribute "${short(name)}" is not allowed`;
  return null;
}

/**
 * CSS normalised for rule 8: comments removed (an unclosed one swallows the rest), CSS escapes
 * decoded (`\` + 1–6 hex [+ one space], `\` + newline, `\` + char), lowercased, whitespace and
 * control characters removed. Comments go first, so an escape that spells "/*" is never treated
 * as a comment (it stays in the text and is checked). Linear.
 */
function cssNormalize(input) {
  const s = String(input);
  let noComments = '';
  for (let i = 0; ;) {
    const j = s.indexOf('/*', i);
    if (j === -1) { noComments += s.slice(i); break; }
    noComments += s.slice(i, j);
    const k = s.indexOf('*/', j + 2);
    if (k === -1) break;
    i = k + 2;
  }
  let out = '';
  for (let i = 0; i < noComments.length;) {
    const ch = noComments[i];
    if (ch !== '\\') { out += ch; i++; continue; }
    i++;
    if (i >= noComments.length) break;
    let hex = '';
    while (hex.length < 6 && i < noComments.length && /[0-9a-fA-F]/.test(noComments[i])) hex += noComments[i++];
    if (hex) {
      const cp = parseInt(hex, 16);
      out += cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
      if (i < noComments.length && /[ \t\n\r\f]/.test(noComments[i])) i++;
    } else if (noComments[i] === '\n' || noComments[i] === '\r' || noComments[i] === '\f') {
      i++;
    } else {
      out += noComments[i++];
    }
  }
  return asciiLower(out.replace(INVISIBLE_RE, ''));
}

/** rule 8: → null when the CSS is allowed, else the reason. `decoded` = HTML entities already decoded. */
function cssProblem(raw, decoded = false) {
  if (raw === null || raw === undefined || typeof raw === 'number' || typeof raw === 'boolean') return null;
  const n = cssNormalize(decoded ? String(raw) : decodeAttrEntities(raw));
  if (n.includes('expression(')) return 'CSS expression() is not allowed';
  if (n.includes('javascript:')) return 'javascript: in CSS is not allowed';
  if (n.includes('@import')) return 'CSS @import is not allowed';
  // Each url( … ) once; the next search starts AFTER this one's ')' (a "url(" inside an argument is
  // part of that argument) — so the scan is linear, never one indexOf per nested "url(".
  for (let i = n.indexOf('url('); i !== -1;) {
    const end = n.indexOf(')', i + 4);
    let arg = n.slice(i + 4, end === -1 ? n.length : end);
    if (arg.length >= 2 && (arg[0] === '"' || arg[0] === "'") && arg[arg.length - 1] === arg[0]) arg = arg.slice(1, -1);
    else if (arg[0] === '"' || arg[0] === "'") arg = arg.slice(1);
    if (!(arg.startsWith('https:') || arg.startsWith('http:'))) return `CSS url() must be http(s) (${short(arg)})`;
    if (end === -1) break;
    i = n.indexOf('url(', end + 1);
  }
  return null;
}

/**
 * rule 9's "nothing visible in the slot", for CSS: a background image (url()) paints the slot, and
 * generated content (`content:` — ::before / ::after) writes text into it from a stylesheet.
 */
const GENERATED_CONTENT_RE = /(?:^|[;{])content:/;   // normalised CSS (no whitespace): "content:" as a property, not align-content:
function paintsImage(raw, decoded) { return raw != null && typeof raw !== 'boolean' && cssNormalize(decoded ? String(raw) : decodeAttrEntities(raw)).includes('url('); }
function generatesContent(raw) { return raw != null && GENERATED_CONTENT_RE.test(cssNormalize(String(raw))); }

/**
 * rule 9 (stylesheets, design and html alike): no generated content anywhere, and no rule that
 * names the footer-slot class — either could put something visible in the slot from outside it.
 */
function stylesheetSlotProblem(cssText) {
  const n = cssNormalize(cssText);
  if (GENERATED_CONTENT_RE.test(n)) return 'CSS generated content (content:) is not allowed — it can write visible text into the footer slot';
  if (n.includes(SLOT_CLASS)) return `CSS naming the footer-slot class (${SLOT_CLASS}) is not allowed — the slot holds the marker only`;
  return null;
}

// ── design_json: shape + walk ───────────────────────────────────────────────

/** rule 1, part 1: parse/size/generic depth. → the design object. */
function shapeOf(designJson) {
  let design = designJson;
  let bytes;
  if (typeof designJson === 'string') {
    bytes = Buffer.byteLength(designJson, 'utf8');
    if (bytes > MAX_DESIGN_BYTES) reject(1, `design_json is ${bytes} bytes — over the ${MAX_DESIGN_BYTES}-byte cap`);
    try { design = JSON.parse(designJson); } catch (_) { reject(1, 'design_json is not valid JSON'); }
  }
  if (!isPlainObject(design)) reject(1, 'design_json must be a JSON object (the builder\'s project data)');
  if (bytes === undefined) {
    let json;
    try { json = JSON.stringify(design); } catch (_) { reject(1, 'design_json nests too deeply to measure'); }
    bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_DESIGN_BYTES) reject(1, `design_json is ${bytes} bytes — over the ${MAX_DESIGN_BYTES}-byte cap`);
  }
  // Generic nesting bound (iterative), so every recursive walk below is bounded — and no
  // prototype-named key anywhere: the walks below read node[k], so a literal "__proto__" key is
  // never examined, while the editor's Backbone extend({}, defaults, attrs) turns it into model
  // attributes (custom-name has no default; the layer manager raw-concats getName() into the pane).
  const stack = [[design, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > MAX_JSON_DEPTH) reject(1, `design_json nests deeper than ${MAX_JSON_DEPTH} levels`);
    if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (PROTO_KEYS.has(k)) reject(1, `design_json key "${k}" is not allowed (anywhere)`);
        stack.push([v[k], d + 1]);
      }
    }
  }
  for (const k of Object.keys(design)) {
    if (!ALLOWED_TOP_KEYS.has(k)) reject(1, `design_json key "${short(k)}" is not allowed (allowed: assets, styles, pages, symbols, dataSources)`);
  }
  // symbols / dataSources: C3 uses neither. A symbol is a stored component tree rendered through its
  // instances and a data source feeds values into components — both would be walked paths outside
  // pages[]; refused unless empty.
  for (const k of ['symbols', 'dataSources']) {
    if (design[k] !== undefined && !(Array.isArray(design[k]) && design[k].length === 0)) reject(1, `design_json.${k} must be empty`);
  }
  if (design.assets !== undefined && !Array.isArray(design.assets)) reject(1, 'design_json.assets must be an array');
  if (design.styles !== undefined && !Array.isArray(design.styles)) reject(1, 'design_json.styles must be an array');
  if (!Array.isArray(design.pages) || design.pages.length === 0) reject(1, 'design_json.pages must be a non-empty array');
  // Pages and frames: only the keys a save carries. Everything else is refused — GrapesJS 0.23.8
  // renders a frame's `name` raw into the PANE (FrameWrapView), sends frame `styles` to the
  // CssComposer (around rule 8) and frame `head` entries into the canvas head.
  design.pages.forEach((pg, pi) => {
    if (!isPlainObject(pg)) reject(1, `pages[${pi}] must be an object`);
    for (const k of Object.keys(pg)) if (!PAGE_KEYS.has(k)) reject(1, `pages[${pi}] key "${short(k)}" is not allowed (allowed: id, type, frames)`);
    if (!Array.isArray(pg.frames) || pg.frames.length === 0) reject(1, `pages[${pi}].frames must be a non-empty array`);
    for (const k of ['id', 'type']) if (pg[k] !== undefined && !(typeof pg[k] === 'string' && !pg[k].includes('<'))) reject(1, `pages[${pi}].${k} must be plain text`);
    pg.frames.forEach((fr, fi) => {
      if (!isPlainObject(fr) || !isPlainObject(fr.component)) reject(1, `pages[${pi}].frames[${fi}].component must be an object`);
      for (const k of Object.keys(fr)) if (!FRAME_KEYS.has(k)) reject(1, `pages[${pi}].frames[${fi}] key "${short(k)}" is not allowed (allowed: id, component, width, height)`);
      if (fr.id !== undefined && !(typeof fr.id === 'string' && !fr.id.includes('<'))) reject(1, `pages[${pi}].frames[${fi}].id must be plain text`);
      for (const k of ['width', 'height']) if (fr[k] !== undefined && !(typeof fr[k] === 'number' && Number.isFinite(fr[k]))) reject(1, `pages[${pi}].frames[${fi}].${k} must be a number`);
    });
  });
  return design;
}

/**
 * Every component, depth-first in document order: visit(node, info) with
 * info = { where() (the path, built only when asked — a refusal), depth, parent,
 * role ('root'|'child'|'head'|'docEl'), ctx ('struct'|'text'|'headtext'), parentType }.
 * Only called after rule 1 passed (arrays checked, depth ≤ MAX_COMPONENT_DEPTH).
 */
function walkComponents(design, visit) {
  const segs = [];
  const where = () => segs.join('');
  design.pages.forEach((pg, pi) => pg.frames.forEach((fr, fi) => {
    const rec = (node, info) => {
      visit(node, info);
      const t = typeOf(node);
      const el = elementOf(node);
      let ctx = info.ctx;
      if (ctx === 'struct' && TEXT_CONTAINERS.has(el)) ctx = 'text';
      else if (ctx === 'struct' && HEAD_TEXT_TAGS.has(el)) ctx = 'headtext';
      const kids = Array.isArray(node.components) ? node.components : [];
      kids.forEach((k, i) => {
        segs.push(`.components[${i}]`);
        rec(k, { where, depth: info.depth + 1, parent: node, role: 'child', ctx, parentType: el });
        segs.pop();
      });
      for (const role of ['head', 'docEl']) {
        if (node[role] === undefined) continue;
        segs.push(`.${role}`);
        rec(node[role], { where, depth: info.depth + 1, parent: node, role, ctx: 'struct', parentType: t });
        segs.pop();
      }
    };
    segs.length = 0;
    segs.push(`pages[${pi}].frames[${fi}].component`);
    rec(fr.component, { where, depth: 1, parent: null, role: 'root', ctx: 'struct', parentType: null });
  }));
}
const typeOf = (n) => (n.type === undefined || n.type === null || n.type === '' ? 'default' : String(n.type));
const tagOf = (n) => (typeof n.tagName === 'string' ? asciiLower(n.tagName) : null);
/** The MJML element a component stands for: its type, or — for an unregistered mj-* tag stored as default / text — its tagName. */
function elementOf(n) {
  const t = typeOf(n);
  const tag = tagOf(n);
  return (t === 'default' || t === 'text') && tag && Object.prototype.hasOwnProperty.call(UNREGISTERED_MJ, tag) ? tag : t;
}

/** rule 1, part 2: every component an object, `components` an array, depth ≤ 40. */
function checkComponentShape(design) {
  design.pages.forEach((pg, pi) => pg.frames.forEach((fr, fi) => {
    const segs = [`pages[${pi}].frames[${fi}].component`];
    const path = () => segs.join('');
    const rec = (node, depth) => {
      if (!isPlainObject(node)) reject(1, `${path()} must be a component object`);
      if (depth > MAX_COMPONENT_DEPTH) reject(1, `components nest deeper than ${MAX_COMPONENT_DEPTH} (${path()})`);
      if (node.components !== undefined && !Array.isArray(node.components)) reject(1, `${path()}.components must be an array (a string would be parsed as HTML)`);
      (node.components || []).forEach((k, i) => { segs.push(`.components[${i}]`); rec(k, depth + 1); segs.pop(); });
      for (const role of ['head', 'docEl']) if (node[role] !== undefined) { segs.push(`.${role}`); rec(node[role], depth + 1); segs.pop(); }
    };
    rec(fr.component, 1);
  }));
}

/** rule 2: the type / tagName allowlist. */
function checkTypes(design) {
  walkComponents(design, (node, { where, role, ctx, parentType }) => {
    const t = typeOf(node);
    const tag = tagOf(node);
    if (node.tagName !== undefined && (typeof node.tagName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/.test(node.tagName))) {
      reject(2, `${where()}: tagName "${short(node.tagName)}" is not a plain element name`);
    }
    // By tagName, and by type — except type 'link', which is GrapesJS's <a> component (rule 2 admits it).
    if ((t !== 'link' && REJECT_TAGS.has(asciiLower(t))) || (tag && REJECT_TAGS.has(tag))) reject(2, `${where()}: <${tag || t}> is not allowed`);
    if (t === 'comment') {
      // Only the footer-slot marker (its count and place are rule 9's).
      if (node.content !== MARKER_CONTENT) reject(2, `${where()}: a comment component is allowed only as the footer-slot marker`);
      if (!isEmptyValue(node.components)) reject(2, `${where()}: a comment has no children`);
      return;
    }
    if (role === 'root') {
      if (t !== 'wrapper') reject(2, `${where()}: the frame's root must be the wrapper`);
      return;
    }
    if (role === 'head') {
      if (t !== 'head' || (tag && tag !== 'head') || !isEmptyValue(node.components)) reject(2, `${where()}: the wrapper's head must be an empty head component`);
      return;
    }
    if (role === 'docEl') {
      if (t !== 'default' || tag !== 'html' || !isEmptyValue(node.components)) reject(2, `${where()}: the wrapper's docEl must be an empty <html> component`);
      return;
    }
    if (t === 'textnode') {
      if (tag || !isEmptyValue(node.components)) reject(2, `${where()}: a textnode has no tagName or children`);
      if (ctx === 'struct' && !isBlank(node.content == null ? '' : node.content)) reject(2, `${where()}: text outside mj-text / mj-button`);
      return;
    }
    if (ctx === 'headtext') reject(2, `${where()}: only text belongs inside <${parentType}>`);
    if (ctx === 'text') {
      if (!(INLINE_TYPES.has(t) || t === 'default')) reject(2, `${where()}: type "${short(t)}" is not allowed inside mj-text / mj-button`);
      if (t === 'link' && tag && tag !== 'a') reject(2, `${where()}: a link must be <a>`);
      if (tag && !INLINE_TAGS.has(tag)) reject(2, `${where()}: <${tag}> is not allowed inside mj-text / mj-button`);
      return;
    }
    // structural
    const el = elementOf(node);
    if (el !== t) {                         // an unregistered mj-* tag (default / text type)
      if (parentType !== UNREGISTERED_MJ[el]) reject(2, `${where()}: <${el}> belongs inside ${UNREGISTERED_MJ[el]}`);
      return;
    }
    if (!MJ_TYPES.has(t) || t === 'wrapper') reject(2, `${where()}: type "${short(t)}" is not allowed here`);
    if (tag && tag !== t) reject(2, `${where()}: type ${t} with tagName ${tag}`);
  });
}

/** rule 3: no script / script-props / script-export. */
function checkScripts(design) {
  walkComponents(design, (node, { where }) => {
    for (const k of ['script', 'script-props', 'script-export']) {
      if (!isEmptyValue(node[k])) reject(3, `${where()}: "${k}" is not allowed`);
    }
  });
}

/** rule 4: attribute names (on*, srcdoc, formaction, action, xlink:href; plain names only; scalar values) and traits. */
function checkAttributeNames(design) {
  walkComponents(design, (node, { where }) => {
    if (node.attributes !== undefined) {
      if (!isPlainObject(node.attributes)) reject(4, `${where()}.attributes must be an object`);
      for (const [name, value] of Object.entries(node.attributes)) {
        if (!/^[a-zA-Z_:][a-zA-Z0-9_:.-]{0,63}$/.test(name)) reject(4, `${where()}: attribute name "${short(name)}" is not a plain name`);
        const p = attrNameProblem(name);
        if (p) reject(4, `${where()}: ${p}`);
        if (value !== null && typeof value === 'object') reject(4, `${where()}: attribute "${short(name)}" must be a plain value (no data bindings)`);
      }
    }
    if (isPlainObject(node.style)) {
      for (const [name, value] of Object.entries(node.style)) {
        const p = attrNameProblem(name);
        if (p) reject(4, `${where()}.style: ${p}`);
        if (value !== null && typeof value === 'object') reject(4, `${where()}.style "${short(name)}" must be a plain value`);
      }
    }
    // GrapesJS's toJSON never writes traits (they are code, not data); a stored one renders as a
    // control in the pane's trait manager — refused, whatever its name or value.
    if (!isEmptyValue(node.traits)) reject(4, `${where()}: stored traits are not allowed`);
  });
}

/** rule 5: `content` holding markup (innerHTML) on anything but a textnode; pane-rendered labels. */
function checkContent(design) {
  walkComponents(design, (node, { where }) => {
    const t = typeOf(node);
    if (node.content !== undefined && node.content !== null && typeof node.content !== 'string') reject(5, `${where()}: content must be text`);
    if (t !== 'textnode' && t !== 'comment' && typeof node.content === 'string' && node.content.includes('<')) {
      reject(5, `${where()}: content with markup is not allowed (it is written as innerHTML)`);
    }
    // Rendered as innerHTML in the PANE (layer manager / toolbar), outside the canvas CSP.
    for (const k of ['icon', 'name', 'custom-name']) {
      if (node[k] !== undefined && node[k] !== null && (typeof node[k] !== 'string' || node[k].includes('<'))) reject(5, `${where()}: "${k}" must be plain text`);
    }
    if (!isEmptyValue(node.toolbar)) reject(5, `${where()}: a stored toolbar is not allowed`);
  });
}

/** rule 6: URL-valued attributes (and their style mirrors) + asset URLs. */
function checkUrls(design) {
  walkComponents(design, (node, { where }) => {
    // The image model keeps its URL in a top-level `src` property as well as the attribute.
    if (node.src !== undefined) { const p = urlProblem(node.src, false); if (p) reject(6, `${where()} src: ${p}`); }
    for (const bag of ['attributes', 'style']) {
      if (!isPlainObject(node[bag])) continue;
      for (const [name, value] of Object.entries(node[bag])) {
        const n = asciiLower(name);
        if (!URL_ATTRS.has(n)) continue;
        const p = urlAttrProblem(n, value, false);
        if (p) reject(6, `${where()}${bag === 'style' ? '.style' : ''} ${n}: ${p}`);
      }
    }
  });
  (design.assets || []).forEach((a, i) => {
    const src = typeof a === 'string' ? a : isPlainObject(a) ? a.src : undefined;
    if (!(typeof a === 'string' || isPlainObject(a))) reject(6, `assets[${i}] must be a URL or an asset object`);
    const p = urlProblem(src, false);
    if (p) reject(6, `assets[${i}]: ${p}`);
  });
}

/** rule 8 (design side): component style / styles / style attribute, and the project's styles. */
function checkDesignCss(design) {
  walkComponents(design, (node, { where }) => {
    if (typeof node.style === 'string') { const p = cssProblem(node.style); if (p) reject(8, `${where()}.style: ${p}`); }
    if (isPlainObject(node.style)) {
      for (const [k, v] of Object.entries(node.style)) { const p = cssProblem(v); if (p) reject(8, `${where()}.style ${short(k)}: ${p}`); }
    }
    if (node.styles !== undefined && node.styles !== null) {
      if (typeof node.styles !== 'string') reject(8, `${where()}.styles must be CSS text`);
      const p = cssProblem(node.styles, true);
      if (p) reject(8, `${where()}.styles: ${p}`);
    }
    if (isPlainObject(node.attributes) && node.attributes.style !== undefined) {
      const p = cssProblem(node.attributes.style);
      if (p) reject(8, `${where()} style attribute: ${p}`);
    }
  });
  // The project's CSS rules: every string (keys and values), and no @import rule.
  const stack = (design.styles || []).map((v, i) => [v, `styles[${i}]`]);
  while (stack.length) {
    const [v, path] = stack.pop();
    if (typeof v === 'string') { const p = cssProblem(v, true); if (p) reject(8, `${path}: ${p}`); continue; }
    if (v === null || typeof v !== 'object') continue;
    for (const k of Object.keys(v)) {
      const pk = cssProblem(k, true);
      if (pk) reject(8, `${path}: ${pk}`);
      if (k === 'atRuleType' && typeof v[k] === 'string' && asciiLower(v[k].trim()) === 'import') reject(8, `${path}: CSS @import is not allowed`);
      stack.push([v[k], `${path}.${short(k)}`]);
    }
  }
}

function classTokens(node) {
  const out = [];
  if (isPlainObject(node.attributes) && typeof node.attributes['css-class'] === 'string') out.push(...node.attributes['css-class'].split(/\s+/));
  if (isPlainObject(node.attributes) && typeof node.attributes.class === 'string') out.push(...node.attributes.class.split(/\s+/));
  if (Array.isArray(node.classes)) for (const c of node.classes) out.push(typeof c === 'string' ? c : isPlainObject(c) ? String(c.name) : '');
  return out;
}

/** rule 9 (design side): exactly one footer slot, last child of mj-body, holding the marker only. */
function checkDesignSlot(design) {
  let json;
  try { json = JSON.stringify(design); } catch (_) { reject(9, 'design_json cannot be measured'); }
  const markers = countOf(asciiLower(json), MARKER_TOKEN);
  if (markers !== 1) reject(9, `the footer-slot marker must appear exactly once in design_json (found ${markers})`);
  const bodies = [];
  const slots = [];
  let markerNode = null;
  const parents = new Map();
  walkComponents(design, (node, { where, parent }) => {
    parents.set(node, parent);
    if (typeOf(node) === 'mj-body') bodies.push(node);
    if (classTokens(node).includes(SLOT_CLASS)) slots.push({ node, path: where() });
    if (typeOf(node) === 'comment' && node.content === MARKER_CONTENT) markerNode = node;
  });
  if (bodies.length !== 1) reject(9, `the design must have exactly one mj-body (found ${bodies.length})`);
  if (slots.length !== 1) reject(9, `exactly one footer-slot block (css-class ${SLOT_CLASS}) is required (found ${slots.length})`);
  const [{ node: slot, path: slotPath }] = slots;
  const body = bodies[0];
  if (typeOf(slot) !== 'mj-section' || parents.get(slot) !== body) reject(9, `the footer slot must be an mj-section directly inside mj-body (${slotPath})`);
  const kids = body.components || [];
  if (kids[kids.length - 1] !== slot) reject(9, 'the footer slot must be the LAST block of mj-body');
  if (!markerNode) reject(9, 'the footer-slot marker must be a comment component <!-- yc:footer-slot -->');
  let inside = false;
  for (let p = parents.get(markerNode); p; p = parents.get(p)) if (p === slot) { inside = true; break; }
  if (!inside) reject(9, 'the footer-slot marker must sit inside the footer slot');
  // Marker only: columns / texts holding nothing visible — no text, no other block, no background
  // image (the slot section's own included).
  const noImage = (n) => {
    for (const bag of ['attributes', 'style']) {
      if (!isPlainObject(n[bag])) continue;
      for (const [k, v] of Object.entries(n[bag])) {
        const key = asciiLower(k);
        if (key === 'background-url' && typeof v === 'string' && !isBlank(v)) reject(9, 'the footer slot has a background image — it must hold the marker only');
        if (paintsImage(v, false)) reject(9, 'the footer slot has a background image (url()) — it must hold the marker only');
      }
    }
  };
  noImage(slot);
  const stack = [...(slot.components || [])];
  while (stack.length) {
    const n = stack.pop();
    const t = typeOf(n);
    if (t === 'comment') continue;   // the marker (rule 2 admits no other comment)
    if (t === 'textnode') { if (!isBlank(n.content == null ? '' : n.content)) reject(9, 'the footer slot holds visible text — it must hold the marker only'); continue; }
    if (t !== 'mj-column' && t !== 'mj-text') reject(9, `the footer slot holds a ${short(t)} — it must hold the marker only`);
    if (typeof n.content === 'string' && !isBlank(n.content)) reject(9, 'the footer slot holds visible text — it must hold the marker only');
    noImage(n);
    for (const k of n.components || []) stack.push(k);
  }
  // Stylesheets (the project's rules, any component's `styles`): no generated content, no rule
  // naming the slot class.
  const sheets = [];
  walkComponents(design, (node) => { if (typeof node.styles === 'string') sheets.push(node.styles); });
  const st = [...(design.styles || [])];
  while (st.length) {
    const v = st.pop();
    if (typeof v === 'string') { sheets.push(v); continue; }
    if (v === null || typeof v !== 'object') continue;
    for (const k of Object.keys(v)) {
      if (asciiLower(k) === 'content') reject(9, 'CSS generated content (content:) is not allowed — it can write visible text into the footer slot');
      sheets.push(k);
      st.push(v[k]);
    }
  }
  for (const css of sheets) { const p = stylesheetSlotProblem(css); if (p) reject(9, p); }
}

// ── html ────────────────────────────────────────────────────────────────────

const WS = new Set([' ', '\t', '\n', '\r', '\f']);
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/**
 * The most attributes parse5's tokenizer will see on any one tag in `src` — exact on input with no
 * <script>, <svg>, <math>, <select> or <frameset> (parseGuarded refuses those first). A <script>
 * START TAG returns Infinity here too: its script-data escape states cannot be followed by this
 * scan, so its count is unbounded (refused), never an under-estimate.
 * Mirrors the HTML tokenizer: data, tag open, tag name, the attribute states, comments (with the
 * abrupt <!--> / <!---> forms and --!>), bogus comments, and the RAWTEXT / RCDATA / PLAINTEXT
 * switches. Stops counting past `stopAt`. Linear: every index only moves forward.
 */
function maxTagAttributes(src, stopAt = HTML_MAX_ATTRS) {
  const s = src;
  const lower = asciiLower(s);
  const len = s.length;
  // The scan only moves forward, so "the next '-->' / '--!>' at or after i" is memoised: without
  // it, a needle that never occurs again is searched to the end once per comment (quadratic —
  // 12k comments took 1.7 s).
  const nextOf = (needle) => {
    let pos = -2;                                   // -2 unknown, -1 none left
    return (from) => {
      if (pos === -1) return -1;
      if (pos === -2 || pos < from) pos = s.indexOf(needle, from);
      return pos;
    };
  };
  const nextClose = nextOf('-->');
  const nextBangClose = nextOf('--!>');
  let max = 0;
  let i = 0;
  while (i < len) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    const c1 = s[lt + 1];
    if (c1 === '!') {
      if (s.startsWith('<!--', lt)) {
        if (s[lt + 4] === '>') { i = lt + 5; continue; }
        if (s[lt + 4] === '-' && s[lt + 5] === '>') { i = lt + 6; continue; }
        const a = nextClose(lt + 4);
        const b = nextBangClose(lt + 4);
        if (a === -1 && b === -1) break;
        i = a !== -1 && (b === -1 || a < b) ? a + 3 : b + 4;
        continue;
      }
      const gt = s.indexOf('>', lt + 2);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    if (c1 === '?') { const gt = s.indexOf('>', lt + 2); if (gt === -1) break; i = gt + 1; continue; }
    let j;
    let isEnd = false;
    if (c1 === '/') {
      const c2 = s[lt + 2];
      if (c2 === '>') { i = lt + 3; continue; }
      if (c2 === undefined) break;
      if (!isAlpha(c2)) { const gt = s.indexOf('>', lt + 2); if (gt === -1) break; i = gt + 1; continue; }
      isEnd = true;
      j = lt + 2;
    } else if (c1 !== undefined && isAlpha(c1)) {
      j = lt + 1;
    } else {
      i = lt + 1;
      continue;
    }
    // tag name
    const nameStart = j;
    while (j < len && !WS.has(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
    const name = lower.slice(nameStart, j);
    // attributes
    let count = 0;
    let state = 'before';
    let done = false;
    while (j < len && !done) {
      const c = s[j];
      switch (state) {
        case 'before':                    // before attribute name
          if (WS.has(c)) { j++; break; }
          if (c === '/') { state = 'selfclose'; j++; break; }
          if (c === '>') { done = true; j++; break; }
          count++; state = 'name'; j++;    // '=' here starts a name too
          break;
        case 'name':                      // attribute name
          if (WS.has(c)) { state = 'after'; j++; break; }
          if (c === '/') { state = 'selfclose'; j++; break; }
          if (c === '>') { done = true; j++; break; }
          if (c === '=') { state = 'beforeValue'; j++; break; }
          j++;
          break;
        case 'after':                     // after attribute name
          if (WS.has(c)) { j++; break; }
          if (c === '/') { state = 'selfclose'; j++; break; }
          if (c === '=') { state = 'beforeValue'; j++; break; }
          if (c === '>') { done = true; j++; break; }
          count++; state = 'name'; j++;
          break;
        case 'beforeValue':
          if (WS.has(c)) { j++; break; }
          if (c === '"' || c === "'") {
            const q = s.indexOf(c, j + 1);
            if (q === -1) { j = len; break; }
            j = q + 1; state = 'afterQuoted';
            break;
          }
          if (c === '>') { done = true; j++; break; }
          state = 'unquoted';
          break;
        case 'unquoted':
          if (WS.has(c)) { state = 'before'; j++; break; }
          if (c === '>') { done = true; j++; break; }
          j++;
          break;
        case 'afterQuoted':
          if (WS.has(c)) { state = 'before'; j++; break; }
          if (c === '/') { state = 'selfclose'; j++; break; }
          if (c === '>') { done = true; j++; break; }
          state = 'before';                // reconsume
          break;
        case 'selfclose':
          if (c === '>') { done = true; j++; break; }
          state = 'before';                // reconsume
          break;
        default:
          j = len;
      }
      if (count > max) { max = count; if (max > stopAt) return max; }
    }
    if (!done) break;                     // EOF inside a tag: the tokenizer drops it
    i = j;
    if (!isEnd && name === 'plaintext') break;
    if (!isEnd && name === 'script') return Infinity;
    if (!isEnd && RAWTEXT_TAGS.has(name)) {
      // RAWTEXT / RCDATA: up to the appropriate end tag "</name" + [ws / >].
      let k = j;
      for (;;) {
        k = lower.indexOf(`</${name}`, k);
        if (k === -1) return max;
        const after = s[k + 2 + name.length];
        if (after === undefined || WS.has(after) || after === '/' || after === '>') break;
        k += 2;
      }
      i = k;
    }
  }
  return max;
}

const TOO_DEEP = Symbol('too deep');

/** parse5 with the two linear guards; rule 7 refusals for what makes them necessary. */
function parseGuarded(src, fragment) {
  const lower = asciiLower(src);
  for (const t of PRE_PARSE_REFUSED) {
    if (lower.includes(`<${t}`)) reject(7, `html must not contain <${t}>`);
  }
  const attrs = maxTagAttributes(src);
  if (attrs > HTML_MAX_ATTRS) reject(7, `an html tag carries more than ${HTML_MAX_ATTRS} attributes`);
  let depth = 0;
  const treeAdapter = {
    ...parse5.defaultTreeAdapter,
    onItemPush() { depth++; if (depth > HTML_MAX_DEPTH) throw TOO_DEEP; },
    onItemPop() { depth--; },
  };
  const opts = { scriptingEnabled: false, treeAdapter };
  try {
    return fragment ? parse5.parseFragment(src, opts) : parse5.parse(src, opts);
  } catch (err) {
    if (err === TOO_DEEP) reject(7, `html nests deeper than ${HTML_MAX_DEPTH} elements`);
    throw err;
  }
}

/** <!--[if …]> … <![endif]--> → the inner markup Outlook renders, or null when not conditional. */
function conditionalInner(data) {
  if (!/^\s*\[if\b/i.test(data)) return null;
  const open = data.indexOf(']>');
  if (open === -1) return '';
  let inner = data.slice(open + 2);
  const close = inner.lastIndexOf('<![endif]');
  if (close !== -1) inner = inner.slice(0, close);
  return inner;
}

const attrFull = (a) => asciiLower(a.prefix ? `${a.prefix}:${a.name}` : a.name);
const getAttr = (el, name) => { const a = (el.attrs || []).find((x) => attrFull(x) === name); return a ? a.value : null; };
function textOf(el) {
  let out = '';
  for (const c of el.childNodes || []) if (c.nodeName === '#text') out += c.value;
  return out;
}

/**
 * rules 7 (tags, on*, srcdoc…, URLs — rules 2 / 4 / 6 applied to the html) and 8 (CSS) over a parsed
 * tree. `budget.conditionals` counts the conditional comments parsed (each is its own fragment
 * parse — a fixed cost per comment, so the count is capped: 12k of them took 1.8 s).
 */
function checkHtmlTree(root, level, budget = { conditionals: 0 }) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeName === '#comment') {
      const inner = conditionalInner(n.data);
      if (inner !== null && inner !== '') {
        if (level >= MAX_CONDITIONAL_NESTING) reject(7, 'conditional comments nest too deeply');
        if (++budget.conditionals > MAX_CONDITIONALS) reject(7, `the html holds more than ${MAX_CONDITIONALS} conditional comments`);
        checkHtmlTree(parseGuarded(inner, true), level + 1, budget);
      }
      continue;
    }
    if (n.tagName) {
      const tag = asciiLower(n.tagName);
      if (HTML_REJECT_TAGS.has(tag)) reject(7, `html: <${tag}> is not allowed`);
      if (tag === 'meta') {
        const he = getAttr(n, 'http-equiv');
        if (he !== null && asciiLower(he.trim()) === 'refresh') reject(7, 'html: <meta http-equiv=refresh> is not allowed');
      }
      for (const a of n.attrs || []) {
        const full = attrFull(a);
        const p4 = attrNameProblem(full);
        if (p4) reject(7, `html <${tag}>: ${p4}`);
        const local = asciiLower(a.name);
        if (URL_ATTRS.has(local) || URL_ATTRS.has(full)) {
          const p6 = urlAttrProblem(local, a.value, true);
          if (p6) reject(7, `html <${tag}> ${local}: ${p6}`);
        }
        if (full === 'style') { const p8 = cssProblem(a.value, true); if (p8) reject(8, `html <${tag}> style: ${p8}`); }
      }
      if (tag === 'style') {
        const css = textOf(n);
        const p8 = cssProblem(css, true);
        if (p8) reject(8, `html <style>: ${p8}`);
        const p9 = stylesheetSlotProblem(css);
        if (p9) reject(9, `html <style>: ${p9}`);
      }
    }
    if (n.content) stack.push(n.content);            // <template> contents
    for (const c of n.childNodes || []) stack.push(c);
  }
}

/** The element's class tokens (html). */
const htmlClasses = (el) => { const c = getAttr(el, 'class'); return c ? c.split(/[ \t\n\r\f]+/) : []; };

/** Nothing visible inside the html footer slot (incl. its Outlook conditionals). */
function checkSlotContents(root, level) {
  const noImage = (el) => {
    for (const a of el.attrs || []) {
      const name = attrFull(a);
      if (name === 'background' && !isBlank(a.value)) reject(9, 'the html footer slot has a background image — it must hold the marker only');
      if (name === 'style' && paintsImage(a.value, true)) reject(9, 'the html footer slot has a background image (url()) — it must hold the marker only');
    }
  };
  noImage(root);
  const stack = [...(root.childNodes || [])];
  if (root.content) stack.push(root.content);
  while (stack.length) {
    const n = stack.pop();
    if (n.tagName) noImage(n);
    if (n.nodeName === '#comment') {
      const inner = conditionalInner(n.data);
      if (inner) {
        if (level >= MAX_CONDITIONAL_NESTING) reject(9, 'the footer slot nests conditional comments too deeply');
        checkSlotContents(parseGuarded(inner, true), level + 1);
      }
      continue;
    }
    if (n.nodeName === '#text') { if (!isBlank(n.value)) reject(9, 'the html footer slot holds visible text — it must hold the marker only'); continue; }
    if (n.tagName && !SLOT_HTML_TAGS.has(asciiLower(n.tagName))) reject(9, `the html footer slot holds a <${asciiLower(n.tagName)}> — it must hold the marker only`);
    if (n.content) stack.push(n.content);
    for (const c of n.childNodes || []) stack.push(c);
  }
}

/** rule 9 (html side): exactly one marker, a real comment inside <body> and the slot element, where C2 injects. */
function checkHtmlSlot(html, doc) {
  const lower = asciiLower(html);
  const tokens = countOf(lower, MARKER_TOKEN);
  const exact = countOf(html, FOOTER_SLOT);
  if (tokens !== 1 || exact !== 1) reject(9, `the html must hold exactly one ${FOOTER_SLOT} marker (found ${exact} exact, ${tokens} in all)`);
  let marker = null;
  const slotEls = [];
  const stack = [doc];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeName === '#comment' && n.data === MARKER_CONTENT) marker = n;
    if (n.tagName && htmlClasses(n).includes(SLOT_CLASS)) slotEls.push(n);
    if (n.content) stack.push(n.content);
    for (const c of n.childNodes || []) stack.push(c);
  }
  if (!marker) reject(9, 'the html marker must be a real comment (not inside an attribute, a <title>, a <style> or a conditional comment)');
  let inBody = false;
  let inSlot = null;
  for (let p = marker.parentNode; p; p = p.parentNode) {
    if (p.tagName && asciiLower(p.tagName) === 'body') inBody = true;
    if (!inSlot && p.tagName && htmlClasses(p).includes(SLOT_CLASS)) inSlot = p;
  }
  if (!inBody) reject(9, 'the html marker must sit inside <body>');
  if (slotEls.length !== 1) reject(9, `the html must hold exactly one footer-slot element (class ${SLOT_CLASS}) (found ${slotEls.length})`);
  if (inSlot !== slotEls[0]) reject(9, `the html marker must sit inside the footer-slot element (class ${SLOT_CLASS})`);
  checkSlotContents(slotEls[0], 0);
  // The send path's own reading: C2 must inject AT this marker (not before </body>).
  const { injectFooter } = require('../services/campaignService'); // lazy require (convention)
  const probe = '\u0000yc-c3-footer-probe\u0000';
  const at = html.indexOf(FOOTER_SLOT);
  if (injectFooter(html, probe) !== html.slice(0, at) + probe + html.slice(at + FOOTER_SLOT.length)) {
    reject(9, 'the send path would not inject the compliance footer at this marker (it must be inside the <body> window)');
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * → { design (the parsed design_json object), warning (string | null) }; throws DesignRejected.
 * Runs on the raw request payload, before any DB write.
 */
function validateDesign({ design_json: designJson, html } = {}) {
  // design_json leg
  const design = shapeOf(designJson);           // 1
  checkComponentShape(design);                  // 1
  checkTypes(design);                           // 2
  checkScripts(design);                         // 3
  checkAttributeNames(design);                  // 4
  checkContent(design);                         // 5
  checkUrls(design);                            // 6
  checkDesignCss(design);                       // 8
  checkDesignSlot(design);                      // 9
  // html leg — independent of design_json
  if (typeof html !== 'string' || html.length === 0) reject(7, 'html must be a non-empty string');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > HTML_MAX_BYTES) reject(10, `html is ${bytes} bytes — over the ${HTML_MAX_BYTES}-byte ceiling (Gmail clips at about 102 KB)`);
  const doc = parseGuarded(html, false);        // 7
  checkHtmlTree(doc, 0);                        // 7, 8
  checkHtmlSlot(html, doc);                     // 9
  const warning = bytes > HTML_WARN_BYTES       // 10
    ? `The html is ${Math.round(bytes / 1024)} KB: Gmail clips messages over about 102 KB (the footer and unsubscribe link would sit behind "[Message clipped]"). Trim images or sections.`
    : null;
  return { design, warning };
}

module.exports = {
  validateDesign,
  DesignRejected,
  // test seams
  urlProblem,
  cssProblem,
  cssNormalize,
  maxTagAttributes,
  decodeAttrEntities,
  FOOTER_SLOT,
  MARKER_CONTENT,
  SLOT_CLASS,
  URL_LEADING_TAGS,
  MAX_DESIGN_BYTES,
  MAX_COMPONENT_DEPTH,
  MAX_CONDITIONALS,
  HTML_WARN_BYTES,
  HTML_MAX_BYTES,
  HTML_MAX_DEPTH,
  HTML_MAX_ATTRS,
};
