/**
 * §Q — `type:"content"` field (display-only image and/or text, EXTERNAL-SAFE).
 *
 * Same harness style as formRender.slice26.test.js: jsdom INTEGRATION tests
 * against the REAL files (render.html with runScripts:'dangerously', the real
 * /js/yc-forms.js via ResourceLoader, apiSend stubbed per test). ZERO
 * yc-forms.js changes in this slice — registration is skipped in the
 * renderer, so collect()/validate()/PATCH never see a content field (the
 * embed 2.6 precedent, re-asserted here).
 *
 * Covers:
 *   M  markup contract: img attrs (src/alt/loading/referrerpolicy/max-width
 *      style), align wrapper, href anchor (target/rel), caption via
 *      textContent, data-yc-content, no .yc-error, label/sublabel, text-only
 *      blocks, non-https src/href degrade (warn, element skipped)
 *   X  exclusion: collect() has no content key, validate passes, byte-identity
 *      proxy (a definition with no content field emits ZERO new artifacts)
 *   V  validateDefinition: content accepted; ≥1 of src/text; https src/href;
 *      maxWidth positive int; align enum; input-shaped keys + height
 *      rejected; repeater reject; condition-target and derive rejects;
 *      fieldSignature exclusion; scanExternalRefusals stays CLEAN (the §Q
 *      point — content is external-safe, unlike embed)
 *   P  PDF omission: buildSubmissionHtml emits neither the image URL nor the
 *      caption (network-blocked chromium — display copy omitted, not
 *      substituted)
 *
 *   npx jest tests/formRender.content.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const svc         = require(path.join(ROOT, 'services/formTemplateService.js'));

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p.startsWith('/forms/hooks/')) return Promise.reject(new Error('404 ' + p));
    return Promise.resolve(Buffer.from(''));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

const IMG  = 'https://storage.googleapis.com/uploads.4lsg.com/logo.png';
const LINK = 'https://www.4lsg.com/';

function contentDef(contentField, extraFields) {
  return {
    dataMode: 'live',
    autosave: false,
    sections: [
      { title: 'Only', rows: [
        { fields: [{ name: 'x1', type: 'text', label: 'X1' }] },
        { fields: [contentField] },
        { fields: (extraFields || []) },
      ].filter((r) => r.fields.length) },
    ],
  };
}

const CASE_ROW = {
  case_id: 'CASEQ1', case_number: '25-50001', case_number_full: '25-50001-mlo',
  case_trustee: '', case_chapter: '', case_subtype: '',
};

function bootPage(opts = {}) {
  const def    = opts.definition;
  const calls  = [];
  const url = 'https://app.test/forms/render.html?form_key=content_test&case_id=CASEQ1';
  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: 'Content Test', link_type: 'case', schema_version: 1, definition: def };
    }
    if (u.startsWith('/api/cases/') && method === 'GET') {
      return { case: CASE_ROW, clients: [], appts: [] };
    }
    if (u.startsWith('/api/cases/') && method === 'PATCH') return { status: 'success' };
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u === '/api/forms/submit') return { id: 91, version: 1, updated_at: new Date().toISOString() };
    if (u.startsWith('/api/forms/draft')) return {};
    throw new Error('unstubbed apiSend: ' + method + ' ' + u);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend = apiSend;
      window.firmData = {};
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document, calls };
}

async function ready(p) {
  for (let i = 0; i < 400; i++) {
    const fatal = p.doc.querySelector('.ycr-fatal');
    if (fatal) throw new Error('fatal: ' + fatal.textContent);
    const ov = p.doc.querySelector('.yc-loading-overlay');
    if (p.win.ycForm && ov && ov.style.display === 'none') break;
    await sleep(10);
  }
  if (!p.win.ycForm) throw new Error('never initialized');
  await sleep(60);
  return p;
}
const q = (p, sel) => p.doc.querySelector(sel);

// ═══════════════════════════════════════════════════════════════════════════
// M — markup contract
// ═══════════════════════════════════════════════════════════════════════════

describe('M content markup', () => {
  test('image + caption + link: full attribute contract', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'firm_logo', type: 'content', label: 'Our Firm', sublabel: 'est. 1998',
      src: IMG, alt: 'Firm logo', maxWidth: 400, align: 'center',
      href: LINK, text: 'Serving Detroit since 1998',
    }) }));

    const box = q(p, '[data-yc-content="firm_logo"]');
    expect(box).toBeTruthy();
    expect(box.getAttribute('style')).toContain('text-align:center');

    const wrap = box.closest('.yc-field');
    expect(wrap.querySelector('.yc-label').textContent).toBe('Our Firm');
    expect(wrap.querySelector('.yc-sublabel').textContent).toBe('est. 1998');
    // §Q carve-out: display-only class — no .yc-error element
    expect(wrap.querySelector('.yc-error')).toBeNull();

    const a = box.querySelector('a');
    expect(a.getAttribute('href')).toBe(LINK);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');

    const img = a.querySelector('img');
    expect(img.getAttribute('src')).toBe(IMG);
    expect(img.getAttribute('alt')).toBe('Firm logo');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('style')).toContain('max-width:min(400px,100%)');

    const cap = box.querySelector('.yc-content-text');
    expect(cap.textContent).toBe('Serving Detroit since 1998');
  });

  test('minimal image: no anchor, empty alt, 100% cap, left align default', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'pic', type: 'content', src: IMG,
    }) }));
    const box = q(p, '[data-yc-content="pic"]');
    expect(box.getAttribute('style')).toContain('text-align:left');
    expect(box.querySelector('a')).toBeNull();
    const img = box.querySelector('img');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('style')).toContain('max-width:100%');
    expect(box.querySelector('.yc-content-text')).toBeNull();
  });

  test('text-only block: no img, caption via textContent (markup inert)', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'blurb', type: 'content', text: '<b>not markup</b> & fine',
    }) }));
    const box = q(p, '[data-yc-content="blurb"]');
    expect(box.querySelector('img')).toBeNull();
    const cap = box.querySelector('.yc-content-text');
    expect(cap.textContent).toBe('<b>not markup</b> & fine');
    expect(cap.querySelector('b')).toBeNull();   // reached the DOM as text
  });

  test('non-https src degrades: image skipped with a warn, caption survives', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'bad', type: 'content', src: 'http://insecure.example/x.png', text: 'cap',
    }) }));
    const box = q(p, '[data-yc-content="bad"]');
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('.yc-content-text').textContent).toBe('cap');
  });

  test('non-https href degrades: bare img, no anchor', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'badlink', type: 'content', src: IMG, href: 'javascript:alert(1)',
    }) }));
    const box = q(p, '[data-yc-content="badlink"]');
    expect(box.querySelector('a')).toBeNull();
    expect(box.querySelector('img').getAttribute('src')).toBe(IMG);
  });

  test('showWhen hides the whole block', async () => {
    const p = await ready(bootPage({ definition: contentDef(
      { name: 'cond_img', type: 'content', src: IMG,
        showWhen: { field: 'ctl', op: 'eq', value: 'Yes' } },
      [{ name: 'ctl', type: 'radio', label: 'Ctl', options: ['Yes', 'No'] }]
    ) }));
    const wrap = q(p, '[data-yc-content="cond_img"]').closest('.yc-field');
    // showWhen rides the field wrapper exactly like any other field
    expect(wrap.getAttribute('data-yc-show-when')).toBe('ctl');
    expect(wrap.getAttribute('data-yc-show-value')).toBe('Yes');
    expect(wrap.style.display).toBe('none');   // hidden initially (ctl unset)
    // flip the controller: block shows
    const yes = p.doc.querySelector('input[name="ctl"][value="Yes"]');
    yes.checked = true;
    yes.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await sleep(30);
    expect(wrap.style.display).not.toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// X — registration exclusion + byte-identity proxy
// ═══════════════════════════════════════════════════════════════════════════

describe('X exclusion & byte-identity proxy', () => {
  test('collect() never sees a content field; validate passes; submit payload clean', async () => {
    const p = await ready(bootPage({ definition: contentDef({
      name: 'firm_logo', type: 'content', src: IMG, text: 'cap',
    }) }));
    const values = p.win.ycForm.collect();
    expect(Object.prototype.hasOwnProperty.call(values, 'firm_logo')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(values, 'x1')).toBe(true);
    expect(p.win.ycForm.validate()).toBe(true);
  });

  test('a definition with no content field emits ZERO new artifacts', async () => {
    const p = await ready(bootPage({ definition: {
      dataMode: 'live', autosave: false,
      sections: [{ title: 'Only', rows: [
        { fields: [{ name: 'x1', type: 'text', label: 'X1' }] },
      ] }],
    } }));
    expect(q(p, '[data-yc-content]')).toBeNull();
    expect(q(p, '.yc-content')).toBeNull();
    expect(q(p, '.yc-content-text')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V — validateDefinition / fieldSignature / scanExternalRefusals
// ═══════════════════════════════════════════════════════════════════════════

describe('V validator', () => {
  const base = (f) => contentDef(f);
  const ok = (f) => expect(() => svc.validateDefinition(base(f), 'case')).not.toThrow();
  const bad = (f, re) => expect(() => svc.validateDefinition(base(f), 'case')).toThrow(re);

  test('accepted shapes', () => {
    ok({ name: 'c1', type: 'content', src: IMG });
    ok({ name: 'c1', type: 'content', text: 'copy only' });
    ok({ name: 'c1', type: 'content', src: IMG, alt: 'a', maxWidth: 400,
         align: 'center', href: LINK, text: 'cap', label: 'L', sublabel: 'S', width: '2x' });
  });

  test('at least one of src/text', () => {
    bad({ name: 'c1', type: 'content' }, /requires at least one of src/);
    bad({ name: 'c1', type: 'content', src: '', text: '' }, /requires at least one of src/);
  });

  test('src must be https, ≤2000', () => {
    bad({ name: 'c1', type: 'content', src: 'http://x.com/a.png' }, /src must be an https URL/);
    bad({ name: 'c1', type: 'content', src: 'not a url' }, /src is not a valid URL/);
    bad({ name: 'c1', type: 'content', src: 'https://x.com/' + 'a'.repeat(2000) }, /at most 2000/);
  });

  test('href must be https when present', () => {
    bad({ name: 'c1', type: 'content', src: IMG, href: 'http://x.com/' }, /href must be an https URL/);
    bad({ name: 'c1', type: 'content', src: IMG, href: 'javascript:alert(1)' }, /href/);
    ok({ name: 'c1', type: 'content', src: IMG, href: LINK });
  });

  test('maxWidth positive int, align enum, text ≤2000, alt string', () => {
    bad({ name: 'c1', type: 'content', src: IMG, maxWidth: 0 }, /maxWidth must be a positive integer/);
    bad({ name: 'c1', type: 'content', src: IMG, maxWidth: 12.5 }, /maxWidth must be a positive integer/);
    bad({ name: 'c1', type: 'content', src: IMG, align: 'justify' }, /align must be one of/);
    bad({ name: 'c1', type: 'content', text: 'a'.repeat(2001) }, /text must be at most 2000/);
    bad({ name: 'c1', type: 'content', src: IMG, alt: 42 }, /alt must be a string/);
  });

  test('input-shaped keys and embed-only height rejected', () => {
    for (const [k, v] of [['required', true], ['apiColumn', 'case_notes'],
                          ['prefill', '{{cases.x}}'], ['mask', 'phone'],
                          ['options', ['a']], ['readonly', true],
                          ['urlParam', 'p'], ['height', 300]]) {
      bad({ name: 'c1', type: 'content', src: IMG, [k]: v },
          new RegExp(`${k} is not allowed on type "content"`));
    }
  });

  test('not allowed inside repeaters', () => {
    const def = {
      sections: [{ repeater: 'items', title: 'Items',
        fields: [{ name: 'c1', type: 'content', src: IMG }] }],
    };
    expect(() => svc.validateDefinition(def, 'case'))
      .toThrow(/type "content" is not allowed inside repeaters/);
  });

  test('cannot be a condition target or a derive endpoint', () => {
    expect(() => svc.validateDefinition(contentDef(
      { name: 'c1', type: 'content', src: IMG },
      [{ name: 'dep', type: 'text', label: 'D',
         showWhen: { field: 'c1', op: 'notEmpty' } }]
    ), 'case')).toThrow(/targets a content field/);

    const dDef = contentDef({ name: 'c1', type: 'content', src: IMG },
      [{ name: 'd1', type: 'date', label: 'D1' }]);
    dDef.derive = [{ target: 'd1', from: 'c1', op: 'addDays', n: 3 }];
    expect(() => svc.validateDefinition(dDef, 'case'))
      .toThrow(/derive cannot reference a content field/);
  });

  test('fieldSignature excludes content (schema_version never bumps for it)', () => {
    const withC    = contentDef({ name: 'c1', type: 'content', src: IMG });
    const withoutC = { sections: [{ title: 'Only', rows: [
      { fields: [{ name: 'x1', type: 'text', label: 'X1' }] },
    ] }] };
    expect(svc.fieldSignature(withC)).toBe(svc.fieldSignature(withoutC));
    expect(svc.fieldSignature(withC)).toContain('x1');
  });

  test('scanExternalRefusals stays CLEAN — content is external-safe (§Q)', () => {
    const def = contentDef({ name: 'c1', type: 'content', src: IMG, text: 'cap' });
    expect(svc.scanExternalRefusals(def)).toEqual([]);
    // …while embed still refuses (the invariant this slice must not weaken)
    const eDef = contentDef({ name: 'e1', type: 'embed', src: IMG });
    expect(svc.scanExternalRefusals(eDef)).toEqual(['embed field "e1"']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E — external surface: projection + submit registry
// ═══════════════════════════════════════════════════════════════════════════

describe('E external surface', () => {
  const ext = require(path.join(ROOT, 'services/extFormService.js'));

  test('projectDefinition keeps every content display key (the block IS the payload)', () => {
    const def = contentDef({
      name: 'firm_logo', type: 'content', label: 'L', sublabel: 'S', width: '2x',
      src: IMG, text: 'cap', alt: 'a', maxWidth: 400, align: 'center', href: LINK,
      showWhen: { field: 'x1', op: 'notEmpty' },
    });
    const out = ext.projectDefinition(def);
    const f = out.sections[0].rows[1].fields[0];
    expect(f).toEqual({
      name: 'firm_logo', type: 'content', label: 'L', sublabel: 'S', width: '2x',
      src: IMG, text: 'cap', alt: 'a', maxWidth: 400, align: 'center', href: LINK,
      showWhen: { field: 'x1', op: 'notEmpty' },
    });
  });

  test('projection still drops private keys from ordinary fields', () => {
    const def = {
      sections: [{ rows: [{ fields: [
        { name: 'x1', type: 'text', label: 'X1', apiColumn: 'case_notes',
          prefill: '{{cases.case_trustee}}' },
      ] }] }],
    };
    const f = ext.projectDefinition(def).sections[0].rows[0].fields[0];
    expect(f.apiColumn).toBeUndefined();
    expect(f.prefill).toBeUndefined();
  });

  test('a submitted value NAMED after a content field is rejected', () => {
    const def = contentDef({ name: 'firm_logo', type: 'content', src: IMG });
    expect(() => ext.validateValues(def, { x1: 'ok' })).not.toThrow();
    expect(() => ext.validateValues(def, { x1: 'ok', firm_logo: 'junk' }))
      .toThrow(/firm_logo is not a field of this form/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P — PDF omission
// ═══════════════════════════════════════════════════════════════════════════

describe('P PDF omits content entirely', () => {
  test('buildSubmissionHtml carries neither the image URL nor the caption', () => {
    const formPdfService = require(path.join(ROOT, 'services/formPdfService.js'));
    const def = contentDef({ name: 'firm_logo', type: 'content', src: IMG,
                             text: 'UNIQUE_CAPTION_SENTINEL' });
    const html = formPdfService.buildSubmissionHtml({
      submission: { id: 7, form_key: 'content_test', link_type: 'case', link_id: 'CASEQ1',
                    version: 1, created_at: '2026-08-14T12:00:00Z',
                    data: { x1: 'hello' } },
      definition: def,
      title: 'Content Test',
      schema_matched: true,
    });
    expect(html).toContain('hello');
    expect(html).not.toContain(IMG);
    expect(html).not.toContain('UNIQUE_CAPTION_SENTINEL');
    expect(html).not.toContain('firm_logo');
  });
});