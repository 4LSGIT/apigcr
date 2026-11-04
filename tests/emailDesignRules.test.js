// tests/emailDesignRules.test.js
//
/**
 * YisraMail C3a — lib/emailDesignRules.validateDesign: the C3 spike's server rules 1–10
 * (local/2026-11-03_YISRAMAIL_C3_SPIKE_FINDINGS.md "Server-side validation rules for C3 proper:
 * REJECT on save, never strip"), applied to design_json AND html independently.
 * Every rule has rejecting and passing cases, named by rule number; the rejecting material is the
 * spike's own (its Q4 payload table and Q1 placements). The fixture (tests/helpers/
 * emailDesignFixture.js) is a valid design in the shape grapesjs-mjml 1.0.8 saves, plus the spike's
 * compiled newsletter with the footer slot holding only the marker.
 * Run: npx jest tests/emailDesignRules.test.js
 */
'use strict';

const parse5 = require('parse5');
const R = require('../lib/emailDesignRules');
const F = require('./helpers/emailDesignFixture');

const { validateDesign, DesignRejected } = R;

// ── fixture navigation ──────────────────────────────────────────────────────
const mjml = (d) => d.pages[0].frames[0].component.components[0];
const head = (d) => mjml(d).components[0];
const body = (d) => mjml(d).components[1];
const firstText = (d) => body(d).components[1].components[0].components[0];   // the mj-text with link / p / ul
const firstColumn = (d) => body(d).components[0].components[0];                // header column (image + text)
const image = (d) => firstColumn(d).components[0];
const slot = (d) => body(d).components[body(d).components.length - 1];
const slotText = (d) => slot(d).components[0].components[0];

function run(mutDesign, mutHtml) {
  const d = F.design();
  let h = F.html();
  if (mutDesign) { const r = mutDesign(d); if (r !== undefined) return validateDesign({ design_json: r, html: h }); }
  if (mutHtml) h = mutHtml(h);
  return validateDesign({ design_json: d, html: h });
}
function rejects(rule, mutDesign, mutHtml) {
  let err = null;
  try { run(mutDesign, mutHtml); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(DesignRejected);
  expect({ rule: err.rule, code: err.code, status: err.status }).toEqual({ rule, code: 'design_rejected', status: 400 });
  expect(typeof err.detail).toBe('string');
  return err;
}
const passes = (mutDesign, mutHtml) => expect(run(mutDesign, mutHtml)).toMatchObject({ warning: null });
/** Insert markup into the html body, before the first section (outside the footer slot). */
const inBody = (markup) => (h) => h.replace('<div\n         aria-label="4LSG Newsletter"', `${markup}<div\n         aria-label="4LSG Newsletter"`);
const withNode = (node) => (d) => { firstText(d).components.push(node); };

test('the fixture passes every rule, and validateDesign never mutates its input', () => {
  const d = F.design();
  const before = JSON.stringify(d);
  const r = validateDesign({ design_json: d, html: F.html() });
  expect(r.warning).toBeNull();
  expect(r.design).toEqual(d);
  expect(JSON.stringify(d)).toBe(before);
  expect(F.html()).toContain(R.FOOTER_SLOT);
});

test('the marker is campaignService.FOOTER_SLOT (the string C2 injects at)', () => {
  expect(R.FOOTER_SLOT).toBe(require('../services/campaignService').FOOTER_SLOT);
});

test('reject never strips: a rejected design leaves the caller\'s objects untouched', () => {
  const d = F.design();
  firstText(d).components.push({ tagName: 'span', attributes: { onclick: 'parent.apiSend("/api/x")' } });
  const before = JSON.stringify(d);
  expect(() => validateDesign({ design_json: d, html: F.html() })).toThrow(DesignRejected);
  expect(JSON.stringify(d)).toBe(before);
});

describe('rule 1 — design_json shape', () => {
  test('rule 1 rejects: a top-level key outside the five', () => { rejects(1, (d) => { d.scripts = []; }); });
  test('rule 1 rejects: not an object (array, null, number), invalid JSON text', () => {
    for (const v of [[], null, 7, 'not json {']) rejects(1, () => v);
  });
  test('rule 1 rejects: no pages / empty frames / a frame without a component', () => {
    rejects(1, (d) => { d.pages = []; });
    rejects(1, (d) => { d.pages[0].frames = []; });
    rejects(1, (d) => { d.pages[0].frames[0].component = 'x'; });
  });
  test('rule 1 rejects: components nested deeper than 40', () => {
    rejects(1, (d) => {
      let n = { tagName: 'span', components: [] };
      const top = n;
      for (let i = 0; i < 40; i++) { const c = { tagName: 'span', components: [] }; n.components.push(c); n = c; }
      firstText(d).components.push(top);
    });
  });
  test('rule 1 rejects: over 512 KB', () => {
    rejects(1, withNode({ type: 'textnode', content: 'x'.repeat(R.MAX_DESIGN_BYTES) }));
    rejects(1, (d) => JSON.stringify({ ...d, pad: 'x'.repeat(R.MAX_DESIGN_BYTES) }));
  });
  test('rule 1 rejects: `components` as a string (GrapesJS would parse it as HTML)', () => {
    rejects(1, (d) => { firstText(d).components = '<img src=x onerror=alert(1)>'; });
  });
  test('rule 1 rejects: non-empty symbols / dataSources; any JSON nested past 200 levels', () => {
    rejects(1, (d) => { d.symbols = [{ type: 'mj-text' }]; });
    rejects(1, (d) => { d.dataSources = [{ id: 'x', records: [] }]; });
    rejects(1, (d) => { let a = []; const top = a; for (let i = 0; i < 250; i++) { const b = []; a.push(b); a = b; } d.assets.push(top); });
  });
  test('rule 1 rejects: page / frame keys outside the allowlist (frame name renders raw in the pane; frame styles / head / onRender; page name)', () => {
    rejects(1, (d) => { d.pages[0].frames[0].name = '<img src=x onerror=parent.apiSend(1)>'; });
    rejects(1, (d) => { d.pages[0].frames[0].styles = '.x{background:url(javascript:x)}'; });
    rejects(1, (d) => { d.pages[0].frames[0].head = [{ type: 'script', src: 'https://x.test/a.js' }]; });
    rejects(1, (d) => { d.pages[0].frames[0].onRender = 'parent.apiSend(1)'; });
    rejects(1, (d) => { d.pages[0].name = '<img src=x onerror=x()>'; });
    rejects(1, (d) => { d.pages[0].frames[0].width = '100px"><img src=x onerror=x()>'; });
    rejects(1, (d) => { d.pages[0].frames[0].id = '<b>'; });
  });
  test('rule 1 rejects: a __proto__ / constructor / prototype key anywhere (the walks read node[k]; Backbone would adopt it)', () => {
    rejects(1, (d) => JSON.stringify(d).replace('"tagName":"mj-text","type":"mj-text"', '"__proto__":{"custom-name":"<img src=x onerror=x()>"},"tagName":"mj-text","type":"mj-text"'));
    rejects(1, (d) => { image(d).attributes.constructor = 'x'; });
    rejects(1, (d) => { d.styles[0].prototype = {}; });
    const parsed = JSON.parse(JSON.stringify(F.design()).replace('"assets":[', '"assets":[{"__proto__":{"src":"javascript:x"}},'));
    expect(Object.keys(parsed.assets[0])).toEqual(['__proto__']);           // JSON.parse keeps it as an OWN key
    rejects(1, () => parsed);
  });
  test('rule 1 passes: frames with numeric width / height', () => {
    passes((d) => { d.pages[0].frames[0].width = 600; d.pages[0].frames[0].height = 0; });
  });
  test('rule 1 passes: design_json as JSON text; 40 levels exactly; empty symbols / dataSources', () => {
    passes((d) => JSON.stringify(d));
    passes((d) => {
      // wrapper(1) > mjml(2) > body(3) > section(4) > column(5) > mj-text(6) → 34 more spans = 40
      let n = { tagName: 'span', components: [] };
      const top = n;
      for (let i = 0; i < 33; i++) { const c = { tagName: 'span', components: [] }; n.components.push(c); n = c; }
      firstText(d).components.push(top);
    });
  });
});

describe('rule 2 — component types', () => {
  test('rule 2 rejects: mj-raw (spike P6: mj-raw content <img onerror> EXEC)', () => {
    rejects(2, (d) => { firstColumn(d).components.push({ tagName: 'mj-raw', type: 'mj-raw', content: '' }); });
  });
  test('rule 2 rejects: script / iframe / object / embed / svg / input / form / details / audio / video / meta / link / style / base', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'svg', 'input', 'form', 'details', 'audio', 'video', 'meta', 'link', 'style', 'base']) {
      rejects(2, withNode({ tagName: tag }));
    }
    rejects(2, withNode({ type: 'script', content: 'alert(1)' }));       // spike: type:'script' EXEC
    rejects(2, withNode({ type: 'iframe' }));
    rejects(2, withNode({ type: 'video' }));
  });
  test('rule 2 rejects: a plain <img> in mj-text (spike Q4 row 1 — reached parent.parent.apiSend) and type image', () => {
    rejects(2, withNode({ tagName: 'img', attributes: { src: 'https://x.test/a.png' } }));
    rejects(2, withNode({ type: 'image', attributes: { src: 'https://x.test/a.png' } }));
  });
  test('rule 2 rejects: a tagName that is not a plain element name (export injection)', () => {
    rejects(2, withNode({ tagName: 'img src=x onerror=alert(1)' }));
    rejects(2, withNode({ tagName: 7 }));
  });
  test('rule 2 rejects: a link / text / textnode with visible text outside mj-text; mj-title outside mj-head', () => {
    rejects(2, (d) => { firstColumn(d).components.push({ type: 'link', attributes: { href: 'https://x.test' } }); });
    rejects(2, (d) => { firstColumn(d).components.push({ type: 'text', components: [{ type: 'textnode', content: 'x' }] }); });
    rejects(2, (d) => { firstColumn(d).components.push({ type: 'textnode', content: 'visible' }); });
    rejects(2, (d) => { firstColumn(d).components.push({ tagName: 'mj-title', type: 'text', components: [] }); });
    rejects(2, (d) => { firstColumn(d).components.push({ type: 'mj-hero', tagName: 'mj-hero' }); });
  });
  test('rule 2 rejects: a comment that is not the footer-slot marker', () => {
    rejects(2, withNode({ type: 'comment', content: '--><img src=x onerror=alert(1)><!--' }));
  });
  test('rule 2 rejects: markup inside mj-title, a non-inline tag inside mj-text, a mismatched mj type', () => {
    rejects(2, (d) => { head(d).components[0].components.push({ tagName: 'b', components: [] }); });
    rejects(2, withNode({ tagName: 'table' }));
    rejects(2, withNode({ type: 'link', tagName: 'button' }));
    rejects(2, (d) => { firstColumn(d).components.push({ type: 'mj-text', tagName: 'mj-raw' }); });
  });
  test('rule 2 rejects: the wrapper head / docEl holding anything; a root that is not the wrapper', () => {
    rejects(2, (d) => { d.pages[0].frames[0].component.head.components = [{ tagName: 'title' }]; });
    rejects(2, (d) => { d.pages[0].frames[0].component.docEl = { tagName: 'body' }; });
    rejects(2, (d) => { d.pages[0].frames[0].component.type = 'mjml'; });
  });
  test('rule 2 passes: links, p / b / ul / li / br in mj-text, mj-title + mj-preview as type text, mj-attributes / mj-all as default', () => {
    passes();
    passes(withNode({ tagName: 'span', type: 'text', components: [{ tagName: 'em', components: [{ type: 'textnode', content: 'x' }] }] }));
    passes(withNode({ tagName: 'h2', components: [{ type: 'textnode', content: 'Heading' }] }));
    passes((d) => { firstColumn(d).components.push({ type: 'textnode', content: '\n   ' }); });   // whitespace only
  });
});

describe('rule 3 — script properties', () => {
  test('rule 3 rejects: script on a default component (spike: EXEC), on mj-text; script-props; script-export', () => {
    rejects(3, withNode({ tagName: 'span', script: 'parent.apiSend("/api/x")' }));
    rejects(3, (d) => { firstText(d).script = 'function(){alert(1)}'; });
    rejects(3, withNode({ tagName: 'span', 'script-props': ['x'] }));
    rejects(3, withNode({ tagName: 'span', 'script-export': 'function(){}' }));
  });
  test('rule 3 passes: empty script values', () => {
    passes(withNode({ tagName: 'span', script: '', 'script-props': [], 'script-export': null }));
  });
});

describe('rule 4 — attribute names', () => {
  test('rule 4 rejects: on* in any case (attributes and the style mirror), srcdoc, formaction, action, xlink:href', () => {
    rejects(4, withNode({ tagName: 'span', attributes: { onclick: 'x()' } }));
    rejects(4, (d) => { image(d).attributes.onerror = 'parent.apiSend("/api/x")'; });
    rejects(4, (d) => { image(d).attributes.OnLoad = 'x()'; });
    rejects(4, (d) => { image(d).style.onerror = 'x()'; });
    for (const a of ['srcdoc', 'formaction', 'action', 'xlink:href', 'SRCDOC']) rejects(4, withNode({ tagName: 'span', attributes: { [a]: 'x' } }));
  });
  test('rule 4 rejects: a name that is not a plain attribute name; an object value (data binding); stored traits', () => {
    rejects(4, withNode({ tagName: 'span', attributes: { 'x onload': 'y' } }));
    rejects(4, withNode({ tagName: 'span', attributes: { 'a"b': 'y' } }));
    rejects(4, withNode({ tagName: 'span', attributes: { title: { type: 'data-variable', path: 'x' } } }));
    rejects(4, withNode({ tagName: 'span', traits: [{ name: 'onclick', value: 'x()' }] }));
    rejects(4, withNode({ tagName: 'span', traits: ['title'] }));
  });
  test('rule 4 passes: data-* / aria-* / title / css-class; traits: []', () => {
    passes(withNode({ tagName: 'span', attributes: { 'data-x': '1', 'aria-label': 'L', title: 'T', id: 'i1' }, traits: [] }));
  });
});

describe('rule 5 — content with markup', () => {
  test('rule 5 rejects: content holding markup on a default component (spike raw-content EXEC) and on mj-text', () => {
    rejects(5, withNode({ tagName: 'span', content: '<img src=x onerror=alert(1)>' }));
    rejects(5, (d) => { firstText(d).content = '<b>bold</b>'; });
    rejects(5, withNode({ tagName: 'span', content: { x: 1 } }));
  });
  test('rule 5 rejects: pane-rendered labels with markup (icon / name / custom-name) and a stored toolbar', () => {
    rejects(5, withNode({ tagName: 'span', icon: '<svg onload=alert(1)>' }));
    rejects(5, withNode({ tagName: 'span', name: '<img src=x onerror=alert(1)>' }));
    rejects(5, withNode({ tagName: 'span', 'custom-name': '<i>x' }));
    rejects(5, withNode({ tagName: 'span', toolbar: [{ label: '<img src=x onerror=alert(1)>', command: 'core:canvas-clear' }] }));
  });
  test('rule 5 passes: a textnode may hold "<" (GrapesJS escapes textnodes); plain content and names', () => {
    passes(withNode({ type: 'textnode', content: 'if a < b then <c>' }));
    passes(withNode({ tagName: 'span', content: 'plain text', name: 'Intro', toolbar: [] }));
  });
});

describe('rule 6 — URL attributes', () => {
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', '&#x6A;avascript:x', 'java\tscript:x',
    ' javascript:x', 'java&#10;script:x', 'vbscript:msgbox', 'data:text/html,<script>x</script>', 'file:///etc/passwd',
    '/relative/path', '//evil.test/x', '{{contacts.contact_email}}', '{{contacts.website|default:x}}', '{{send.header_image_url}}',
    '{{ contacts.contact_fname }}x', 'javas\u0000cript:x'];
  test('rule 6 rejects: every bad href (decoded, whitespace / control stripped, lowercased) — incl. a leading contact merge tag', () => {
    for (const v of bad) rejects(6, withNode({ type: 'link', attributes: { href: v } }));
  });
  test('rule 6 rejects: src / background-url / srcset / poster / data / cite, the style mirror, and asset URLs', () => {
    rejects(6, (d) => { image(d).attributes.src = 'javascript:alert(1)'; });
    rejects(6, (d) => { image(d).style.href = 'javascript:alert(1)'; });                 // attributes fine, mirror bad
    rejects(6, (d) => { body(d).components[1].attributes['background-url'] = 'data:image/svg+xml,<svg onload=x>'; });
    rejects(6, (d) => { image(d).attributes.srcset = 'https://x.test/a.png 1x, javascript:x 2x'; });
    for (const a of ['poster', 'data', 'cite']) rejects(6, withNode({ tagName: 'span', attributes: { [a]: 'javascript:x' } }));
    rejects(6, (d) => { d.assets.push({ type: 'image', src: 'javascript:alert(1)' }); });
    rejects(6, (d) => { d.assets.push('data:image/png;base64,AAAA'); });
  });
  test('rule 6 rejects: the image model\'s top-level src', () => {
    rejects(6, (d) => { image(d).src = 'javascript:alert(1)'; });
  });
  test('rule 6 passes: the normaliser\'s accept side — whitespace / control around a good scheme, entity-encoded letters, case', () => {
    for (const v of [' https://x.test/a', '\thttp://x.test', '\u0000https://x.test', 'HtTpS://x.test', '&#104;ttps://x.test', 'ht&#x74;ps://x.test',
      'https&#58;//x.test', 'mailto&colon;office@4lsg.com', 'h t t p s://x.test', ' {{send.unsubscribe_url}}']) {
      expect(R.urlProblem(v)).toBeNull();
      passes(withNode({ type: 'link', attributes: { href: v } }));
    }
    passes((d) => { image(d).src = 'https://app.4lsg.com/assets/icon-512.png'; });
  });
  test('rule 6 passes: https / http / mailto / tel / #, the two URL-valued send tags, a merge tag after the scheme, empty', () => {
    for (const v of ['https://x.test/a?b=1&c=2', 'HTTP://x.test', 'mailto:{{contacts.contact_email}}', 'tel:+12485550100', '#top',
      '{{send.unsubscribe_url}}', '{{send.preferences_url}}#prefs', 'https://4lsg.com/b/x?c={{contacts.contact_token}}', '']) {
      passes(withNode({ type: 'link', attributes: { href: v } }));
    }
  });
  test('urlProblem: the allowlist of leading merge tags is exactly the two send URLs (firm.* has no URL-valued key)', () => {
    expect(R.URL_LEADING_TAGS).toEqual(['send.unsubscribe_url', 'send.preferences_url']);
    expect(R.urlProblem('{{firm.name}}')).toMatch(/merge tag/);
    expect(R.urlProblem('{{send.unsubscribe_url}}')).toBeNull();
  });
});

describe('rule 7 — the html, with a real parser', () => {
  test('rule 7 rejects: <script>, <base>, <form>, <meta http-equiv=refresh>, iframe / object / embed / link / input / details / audio / video', () => {
    for (const m of ['<script>parent.apiSend("/api/x")</script>', '<base href="https://evil.test/">', '<form action="https://evil.test"><button>x</button></form>',
      '<META HTTP-EQUIV=" Refresh " content="0;url=https://evil.test">', '<iframe src="https://x.test"></iframe>', '<object data="https://x.test/x.swf"></object>',
      '<embed src="https://x.test/x">', '<link rel="stylesheet" href="https://x.test/x.css">', '<input autofocus>', '<details open>x</details>',
      '<audio src="https://x.test/a.mp3"></audio>', '<video poster="https://x.test/p.png"></video>', '<frameset></frameset>']) {
      rejects(7, null, inBody(m));
    }
  });
  test('rule 7 rejects: on* / srcdoc / formaction / xlink:href, and bad URLs, in the html', () => {
    for (const m of ['<img src="https://x.test/a.png" onerror="parent.apiSend(1)">', '<div ONMOUSEOVER="x()">x</div>', '<a href="javascript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>', '<a href="  JAVA&#x09;SCRIPT:x">x</a>', '<img src="data:image/svg+xml;base64,AAAA">',
      '<a href="{{contacts.contact_email}}">x</a>', '<table><tr><td background="javascript:x">x</td></tr></table>', '<img srcset="https://x.test/a.png 1x, javascript:x 2x">',
      '<div srcdoc="x">x</div>', '<button formaction="https://x.test">x</button>', '<a xlink:href="https://x.test">x</a>', '<blockquote cite="vbscript:x">q</blockquote>']) {
      rejects(7, null, inBody(m));
    }
  });
  test('rule 7 rejects: the same, hidden in an Outlook conditional comment (Outlook renders it), and in <noscript>', () => {
    rejects(7, null, inBody('<!--[if mso]><img src="https://x.test/a.png" onerror="x()"><![endif]-->'));
    rejects(7, null, inBody('<!--[if mso | IE]><table><tr><td><a href="javascript:x">x</a></td></tr></table><![endif]-->'));
    rejects(7, null, inBody('<!--[if gte mso 9]><v:image src="javascript:x" /><![endif]-->'));
    rejects(7, null, inBody('<noscript><img src="https://x.test/a.png" onerror="x()"></noscript>'));
  });
  test('rule 7 rejects: <svg> / <math> / <select> (refused before the parse), nesting past 128, a tag with over 256 attributes', () => {
    rejects(7, null, inBody('<svg onload="x()"></svg>'));
    rejects(7, null, inBody('<math><mi>x</mi></math>'));
    rejects(7, null, inBody('<select><option>x</option></select>'));
    rejects(7, null, inBody('<div>'.repeat(R.HTML_MAX_DEPTH + 5)));
    rejects(7, null, inBody(`<div ${Array.from({ length: R.HTML_MAX_ATTRS + 1 }, (_, i) => `a${i}=1`).join(' ')}>x</div>`));
  });
  test('rule 7 refuses <script> BEFORE the parse (the attribute scan cannot follow script data\'s escape states)', () => {
    const err = rejects(7, null, inBody('<script><!--<script></script><style></script><a b c></style>'));
    expect(err.detail).toBe('html must not contain <script>');
    expect(rejects(7, null, inBody('<SCRIPT src="https://x.test/a.js"></SCRIPT>')).detail).toBe('html must not contain <script>');
  });
  test('rule 7 rejects: html missing or not a string', () => {
    for (const h of [undefined, null, '', 42, { x: 1 }]) {
      let err = null;
      try { validateDesign({ design_json: F.design(), html: h }); } catch (e) { err = e; }
      expect(err && err.rule).toBe(7);
    }
  });
  test('rule 7 passes: the MJML output (mso conditionals, <style>, meta X-UA-Compatible / viewport, VML-free); 256 attributes; nesting 100 deep', () => {
    passes();
    passes(null, inBody(`<div ${Array.from({ length: R.HTML_MAX_ATTRS - 2 }, (_, i) => `a${i}=1`).join(' ')}>x</div>`));
    passes(null, inBody(`${'<div>'.repeat(100)}x${'</div>'.repeat(100)}`));
    passes(null, inBody('<!--[if mso]><table role="presentation"><tr><td style="width:600px"><![endif]--><p>Hi</p><!--[if mso]></td></tr></table><![endif]-->'));
  });
});

describe('rule 8 — CSS', () => {
  test('rule 8 rejects (design): expression(), javascript:, url() with a non-http(s) scheme, @import — style attribute, style object, styles, project CSS', () => {
    rejects(8, (d) => { image(d).attributes.style = 'width:expression(alert(1))'; });
    rejects(8, (d) => { image(d).style.width = 'expression(alert(1))'; });
    rejects(8, (d) => { image(d).attributes.style = 'background:url(javascript:alert(1))'; });
    rejects(8, (d) => { image(d).attributes.style = "background-image:url('data:image/svg+xml,x')"; });
    rejects(8, (d) => { image(d).attributes.style = 'background:url(/relative.png)'; });
    rejects(8, withNode({ tagName: 'span', styles: '@import url(https://x.test/a.css);' }));
    rejects(8, (d) => { d.styles.push({ selectors: [], selectorsAdd: 'p', style: { background: 'url(javascript:x)' } }); });
    rejects(8, (d) => { d.styles.push({ selectors: [], atRuleType: 'import', style: {} }); });
    rejects(8, (d) => { d.styles.push({ selectors: [], selectorsAdd: '@import "x.css"; p', style: {} }); });
  });
  test('rule 8 rejects: obfuscated — CSS escapes, comments, entities, case, whitespace', () => {
    for (const css of ['width:e\\78 pression(alert(1))', 'width:expr/**/ession(alert(1))', 'width:EXPRESSION (alert(1))',
      'background:url( "  JaVaScRiPt:x" )', 'background:url(java\\73 cript:x)', 'background:url(&#106;avascript:x)', '@\\69mport "x.css"']) {
      rejects(8, (d) => { image(d).attributes.style = css; });
    }
  });
  test('rule 8 rejects (html): <style> @import / expression, style attribute url(javascript:), inside a conditional too', () => {
    rejects(8, null, inBody('<style>@import url(https://x.test/a.css);</style>'));
    rejects(8, null, inBody('<div style="width:expression(alert(1))">x</div>'));
    rejects(8, null, inBody("<div style=\"background:url('javascript:x')\">x</div>"));
    rejects(8, null, inBody('<!--[if lte mso 11]><style>.x{behavior:url(javascript:x)}</style><![endif]-->'));
  });
  test('rule 8 passes: http(s) url(), quotes, comments, MJML\'s own CSS', () => {
    passes((d) => { image(d).attributes.style = "background:url('https://x.test/a.png') center / cover; /* note */ color:#fff"; });
    passes(null, inBody('<div style="background:url(&quot;http://x.test/a.png&quot;)">x</div>'));
  });
  test('cssProblem: a url( nested in another url( argument is part of it (the scan never restarts inside)', () => {
    expect(R.cssProblem('background:url(https://x.test/url(a))', true)).toBeNull();
    expect(R.cssProblem('a:url(https://x.test/a.png);b:url(data:x)', true)).toMatch(/http\(s\)/);
  });
});

describe('rule 9 — the footer slot', () => {
  test('rule 9 rejects (design): no slot; two slots; the slot not last; not directly in mj-body; not an mj-section', () => {
    rejects(9, (d) => { delete slot(d).attributes['css-class']; });
    rejects(9, (d) => { body(d).components[0].attributes['css-class'] = 'yc-footer'; });
    rejects(9, (d) => { body(d).components.push(body(d).components.splice(0, 1)[0]); });     // a section after the slot
    rejects(9, (d) => { const s = body(d).components.pop(); body(d).components.push({ tagName: 'mj-group', type: 'mj-group', components: [s] }); });
    rejects(9, (d) => { slot(d).type = 'mj-column'; slot(d).tagName = 'mj-column'; });
  });
  test('rule 9 rejects (design): marker missing, duplicated, outside the slot, or only in an attribute', () => {
    rejects(9, (d) => { slotText(d).components = []; });
    rejects(9, (d) => { firstText(d).components.push({ type: 'comment', content: ' yc:footer-slot ' }); });
    rejects(9, (d) => { firstText(d).components.push(slotText(d).components.pop()); });
    rejects(9, (d) => { image(d).attributes.alt = 'yc:footer-slot'; });
    rejects(9, (d) => { slotText(d).components = []; image(d).attributes.alt = 'yc:footer-slot'; });
  });
  test('rule 9 rejects (design): visible content in the slot — a placeholder line beside the marker (Fred\'s A/B eyeball), an image, mj-text content', () => {
    rejects(9, (d) => { slotText(d).components.push({ type: 'textnode', content: '[Footer slot — the compliance footer is injected here at send]' }); });
    rejects(9, (d) => { slot(d).components[0].components.push({ tagName: 'mj-image', type: 'mj-image', attributes: { src: 'https://x.test/a.png' } }); });
    rejects(9, (d) => { slotText(d).content = 'Footer goes here'; });
    rejects(9, (d) => { slotText(d).components.push({ tagName: 'b', components: [] }); });
  });
  test('rule 9 rejects (design): a background image in the slot (background-url, a CSS url()); generated content or the slot class in any stylesheet', () => {
    rejects(9, (d) => { slot(d).attributes['background-url'] = 'https://x.test/footer-text.png'; });
    rejects(9, (d) => { slot(d).components[0].style = { 'background-image': "url('https://x.test/a.png')" }; });
    rejects(9, (d) => { slotText(d).attributes.style = 'background-image:url(https://x.test/a.png)'; });
    rejects(9, (d) => { d.styles.push({ selectors: [], selectorsAdd: '.yc-footer div::after', style: { content: '"Fake footer"' } }); });
    rejects(9, (d) => { d.styles.push({ selectors: [], selectorsAdd: 'td::before', style: { content: '"x"' } }); });
    rejects(9, (d) => { d.styles.push({ selectors: ['yc-footer'], style: { color: 'red' } }); });
    rejects(9, withNode({ tagName: 'span', styles: 'div::after{content:"x"}' }));
  });
  test('rule 9 passes (design): align-content / justify-content are not generated content; a background colour in the slot', () => {
    passes((d) => { d.styles.push({ selectors: ['x'], style: { 'align-content': 'center', 'justify-content': 'center' } }); });
    passes((d) => { slot(d).attributes['background-color'] = '#ffffff'; });
  });
  test('rule 9 rejects (design): two mj-bodies', () => {
    rejects(9, (d) => { mjml(d).components.push(JSON.parse(JSON.stringify({ ...body(d), components: [] }))); });
  });
  test('rule 9 passes (design): slot holding only the marker, with whitespace; css-class with other tokens', () => {
    passes((d) => { slotText(d).components.push({ type: 'textnode', content: '  \n ' }); });
    passes((d) => { slot(d).attributes['css-class'] = 'brand yc-footer'; });
  });
  const FOOTER_TEXT = '><!-- yc:footer-slot --></div>';
  test('rule 9 rejects (html): marker missing, duplicated, a near-miss spelling, in an attribute, a <title>, a conditional, after </body>', () => {
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '></div>'));
    rejects(9, null, (h) => inBody('<!-- yc:footer-slot -->')(h));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><!--yc:footer-slot--></div>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><img alt="<!-- yc:footer-slot -->"></div>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '></div>').replace('<title>4LSG Newsletter</title>', '<title><!-- yc:footer-slot --></title>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><!--[if mso]><!-- yc:footer-slot --><![endif]--></div>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '></div>').replace('</html>', '</html><!-- yc:footer-slot -->'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '></div>').replace('</head>', '<!-- yc:footer-slot --></head>'));
  });
  test('rule 9 rejects (html): visible text / an image beside the marker (the spike placeholder line), text in the slot\'s Outlook branch, marker outside the slot element, two slot elements', () => {
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '>[Footer slot — the compliance footer is injected here at send]<!-- yc:footer-slot --></div>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><!-- yc:footer-slot --><img src="https://x.test/a.png"></div>'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><!-- yc:footer-slot --><!--[if mso]><p>Outlook only text</p><![endif]--></div>'));
    rejects(9, null, (h) => inBody('<!-- yc:footer-slot -->')(h.replace(FOOTER_TEXT, '></div>')));
    rejects(9, null, (h) => inBody('<div class="yc-footer"></div>')(h));
  });
  test('rule 9 rejects (html): a background image on / inside the slot element; generated content or the slot class in a <style>', () => {
    rejects(9, null, (h) => h.replace('<div  class="yc-footer" style="background:#f9fafb;', '<div  class="yc-footer" style="background:url(https://x.test/a.png);'));
    rejects(9, null, (h) => h.replace(FOOTER_TEXT, '><table><tr><td background="https://x.test/a.png"><!-- yc:footer-slot --></td></tr></table></div>'));
    rejects(9, null, inBody('<style>.yc-footer div::after{content:"Unsubscribe here"}</style>'));
    rejects(9, null, inBody('<style>td::before{content:"x"}</style>'));
    rejects(9, null, inBody('<style>.yc-footer{display:none}</style>'));
  });
  test('rule 9 passes (html): justify-content in a <style>; a background colour on the slot', () => {
    passes(null, inBody('<style>.x{justify-content:center;align-content:start}</style>'));
  });
  test('rule 9 (html) rides C2\'s own reading: a marker campaignService.injectFooter would skip is refused', () => {
    // No <body> tag (the parser implies one, so the marker IS a comment in body) and a "</head>"
    // inside an attribute AFTER the marker: C2's string-searched window starts after that "</head>",
    // past the marker — C2 would put the footer before </html> instead. Refused.
    const cs = require('../services/campaignService');
    const h = F.html().replace(/<body[^>]*>/, '').replace('</body>', '<p title="</head>">x</p>');
    const at = h.indexOf(R.FOOTER_SLOT);
    expect(cs.injectFooter(h, 'PROBE')).not.toBe(h.slice(0, at) + 'PROBE' + h.slice(at + R.FOOTER_SLOT.length));
    const err = rejects(9, null, () => h);
    expect(err.detail).toMatch(/send path would not inject/);
  });
  test('rule 9 passes (html): the MJML slot (div.yc-footer > table > … > div > marker, with its Outlook conditionals)', () => { passes(); });
});

describe('rule 10 — size', () => {
  test('rule 10 warns over ~95 KB (Gmail clips at ~102 KB): the save passes with a warning', () => {
    const r = run(null, inBody(`<div>${'x'.repeat(100 * 1024)}</div>`));
    expect(r.warning).toMatch(/Gmail clips/);
  });
  test('rule 10 passes without a warning under the line', () => {
    expect(run(null, inBody(`<div>${'x'.repeat(60 * 1024)}</div>`)).warning).toBeNull();
  });
  test('rule 10 rejects past the hard ceiling (512 KB — bounds the parse)', () => {
    const err = rejects(10, null, inBody(`<div>${'x'.repeat(R.HTML_MAX_BYTES)}</div>`));
    expect(err.detail).toMatch(/ceiling/);
  });
});

describe('maxTagAttributes mirrors parse5\'s tokenizer (the linear guard\'s premise)', () => {
  const parse5Max = (src) => {
    let max = 0;
    const walk = (n) => { if (n.attrs) max = Math.max(max, n.attrs.length); (n.childNodes || []).forEach(walk); if (n.content) walk(n.content); };
    walk(parse5.parse(src, { scriptingEnabled: false }));
    return max;
  };
  const cases = [
    '<div a b c>', '<div a=1 b="2" c=\'3\'>', '<div a/b/c/d>', '<div a="x"b c>', '<div a = 1 b=2>', '<div =a b>',
    '<div a="1>2" b c>', '<div a=x>y b c>', '<style><div a b c d e></style><p x>', '<title><i a b c></title><p x y>',
    '<textarea><i a b c d></textarea><b q>', '<!--><div a b c>-->', '<!---><div a b c>-->', '<!-- --!><div a b>', '<!-- x --><p a>',
    '<!DOCTYPE html><p a b>', '<?x <p a b c>?><i z>', '</p a b c>', '<p a b\n c\td>', '<div a="unclosed', '<style><!--</style><div a b c d>-->',
    '<script><!--<div a b c>--></script><p z>', '<p a=1 a=2 a=3 b>',
    // review round 1: double-escaped script data runs PAST the first </script> — the scan must not
    // resume there (it would read <style> as raw text and miss the <a> tag's attributes)
    `<script><!--<script></script><style></script><a ${Array.from({ length: 300 }, (_, i) => `a${i}`).join(' ')}></style>`,
  ];
  test.each(cases)('%s → at least parse5\'s count (equal when no attribute repeats)', (src) => {
    const mine = R.maxTagAttributes(src);
    const theirs = parse5Max(src);
    expect(mine).toBeGreaterThanOrEqual(theirs);
    // Exact unless an attribute repeats (parse5 keeps the first), the tag is an END tag or never
    // closes (the tokenizer still does the work, but no element keeps the attributes), or <script>.
    if (!/a=1 a=2|<\/p a|unclosed|<script/.test(src)) expect(mine).toBe(theirs);
  });
});
