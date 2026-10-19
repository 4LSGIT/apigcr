'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const MANAGER = fs.readFileSync(path.join(ROOT, 'public/automationManager.html'), 'utf8');
const SUBTAB = fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8');
const NAVIGATION = SHELL.slice(
  SHELL.indexOf('    const YC_ASSISTANT_DESTINATIONS'),
  SHELL.indexOf('    // ---- Global auth state ----')
);

function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  const start = match.index;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}

function assignedFnSrc(src, name) {
  const start = src.indexOf(`window.${name} = function`);
  if (start < 0) throw new Error(`window.${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error(`window.${name} unbalanced`);
}

describe('Ask Casey sidebar host', () => {
  test('there is exactly one stable assistant iframe and no workspace panel twin', () => {
    const doc = new JSDOM(SHELL).window.document;
    expect(doc.querySelectorAll('iframe[src="/assistant.html"], iframe[data-src="/assistant.html"]')).toHaveLength(1);
    expect(doc.getElementById('caseyFrame')).not.toBeNull();
    expect(doc.getElementById('assistantDiv')).toBeNull();
    expect(doc.getElementById('askCaseyOpen').textContent).toMatch(/Ask Casey/);
  });

  test('collapse and expand reuse the iframe and never mutate the workspace URL', () => {
    const dom = new JSDOM('<!doctype html><body><iframe id="caseyFrame" data-src="/assistant.html"></iframe></body>', {
      url: 'https://app.test/?files=cCASE1234&open=file%3A0', runScripts: 'outside-only',
    });
    const w = dom.window;
    w.E = (id) => w.document.getElementById(id);
    w.matchMedia = () => ({ matches: false });
    w.caseySidebarPrior = null;
    w.document.body.classList.add('sidebar-skinny');
    w.eval(`${fnSrc(SHELL, 'openCasey')}\n${fnSrc(SHELL, 'closeCasey')}\n${fnSrc(SHELL, 'toggleCaseyExpanded')}`);
    const frame = w.E('caseyFrame');
    const before = w.location.href;
    expect(w.openCasey()).toBe(true);
    expect(frame.getAttribute('src')).toBe('/assistant.html');
    expect(w.closeCasey()).toBe(true);
    expect(w.document.body.classList.contains('sidebar-skinny')).toBe(true);
    expect(w.openCasey({ expanded: true })).toBe(true);
    expect(w.E('caseyFrame')).toBe(frame);
    expect(frame.hasAttribute('data-src')).toBe(false);
    expect(w.document.body.classList.contains('casey-expanded')).toBe(true);
    expect(w.location.href).toBe(before);
  });

  test('the narrow collector parses the canonical URL and keeps display names outside it', () => {
    const dom = new JSDOM('<!doctype html><body><div id="tabOpenFiles"><div class="file-button" title="Ada Case"></div></div></body>', {
      url: 'https://app.test/', runScripts: 'outside-only',
    });
    const w = dom.window;
    w.currentOpenFilesUrl = () => 'https://app.test/?files=cCASE1234%7Edocuments%2Cp42&open=file%3A0&ask=drop-me';
    w.ycSubTab = { normalize: (rest) => rest };
    w.eval(assignedFnSrc(SHELL, 'ycAssistantContext'));
    expect(w.ycAssistantContext()).toEqual({
      snapshot: {
        v: 1,
        canonical_url: '/?files=cCASE1234%7Edocuments%2Cp42&open=file%3A0',
        files: [
          { kind: 'case', id: 'CASE1234', rest: 'documents' },
          { kind: 'contact', id: '42', rest: '' },
        ],
        active: { kind: 'file', index: 0, entity: { kind: 'case', id: 'CASE1234', rest: 'documents' } },
      },
      display_label: 'Ada Case',
    });
    expect(w.ycAssistantContext().snapshot.canonical_url).not.toContain('Ada');
  });

  test('mobile uses the same host as a full-width sheet', () => {
    expect(SHELL).toMatch(/body\.casey-sidebar-open #appSidebar \{ transform: translateX\(0\); width: 100vw !important; \}/);
  });
});

describe('Automations → Court Review semantic navigation proof', () => {
  test('the shell registry is allowlisted and holds the cold rest before launcher execution', () => {
    expect(SHELL).toContain("'automations.court_review': Object.freeze({");
    expect(SHELL.indexOf('ycSubTab.host.hold(frame, spec.rest)')).toBeLessThan(SHELL.indexOf('L.exec(spec.launcher, { page: spec.page })'));
    expect(SHELL).toContain("L.effectiveRegistry().some((item) => item.id === spec.launcher)");
  });

  test('the manager reports child load readiness and exposes only its narrow bridge', () => {
    expect(MANAGER).toContain("iframe.addEventListener('load', () => notifyAssistantDestinationReady(id), { once: true })");
    expect(MANAGER).toContain("{ destination: 'automations.court_review' }");
    expect(MANAGER).toContain("if (rest !== 'courtReview') return false");
    expect(MANAGER).toContain('window.ycAssistantOpenDestination = ycAssistantOpenDestination');
  });

  function navigationWorld(cold) {
    const attr = cold ? ' data-src="/automationManager.html"' : ' src="/automationManager.html"';
    const dom = new JSDOM(`<!doctype html><body><div id="automationsDiv"><iframe${attr}></iframe></div></body>`, {
      url: 'https://app.test/', runScripts: 'outside-only',
    });
    const w = dom.window;
    const frame = w.document.querySelector('iframe');
    w.E = (id) => w.document.getElementById(id);
    w.eval(SUBTAB);
    const exec = jest.fn(() => {
      if (cold) { frame.src = frame.dataset.src; delete frame.dataset.src; }
      return true;
    });
    w.ycLauncher = {
      isReady: () => true,
      effectiveRegistry: () => [{ id: 'moreAutomations' }],
      exec,
    };
    w.eval(NAVIGATION);
    return { dom, w, frame, exec };
  }

  test('cold navigation holds Court Review, opens through the launcher, then waits for child ready', async () => {
    const t = navigationWorld(true);
    const promise = t.w.ycAssistantNavigate('automations.court_review');
    expect(t.exec).toHaveBeenCalledWith('moreAutomations', { page: 'tabMore' });
    expect(t.w.ycSubTab.host.lastRest(t.frame)).toBe('courtReview');
    expect(t.w.ycAssistantChildReady(t.frame, { destination: 'automations.court_review' })).toBe(true);
    await expect(promise).resolves.toEqual({ destination: 'automations.court_review', ready: true });
    t.dom.window.close();
  });

  test('already-loaded navigation calls the same manager bridge and clears the cold hold', async () => {
    const t = navigationWorld(false);
    let opened = null;
    t.frame.contentWindow.ycAssistantOpenDestination = (rest) => {
      opened = rest;
      t.w.ycAssistantChildReady(t.frame, { destination: 'automations.court_review' });
      return true;
    };
    await expect(t.w.ycAssistantNavigate('automations.court_review')).resolves.toMatchObject({ ready: true });
    expect(opened).toBe('courtReview');
    expect(t.w.ycSubTab.host.take(t.frame)).toBeNull();
    t.dom.window.close();
  });

  test('unknown or inaccessible destinations fail closed before launcher execution', async () => {
    const t = navigationWorld(false);
    await expect(t.w.ycAssistantNavigate('evil.selector')).rejects.toThrow(/not available/);
    expect(t.exec).not.toHaveBeenCalled();
    t.dom.window.close();
  });
});
