/**
 * Entity Communications -- integration contract shared by contact.html and
 * case.html.  This is deliberately a source-level wiring test: both entity
 * pages are large, independently boot-tested documents, while the widget has
 * its own behavioural suite.  The assertions here pin the tiny seam between
 * them (workspace token, lazy URL and refresh-on-reentry).
 *
 * Run: npx jest tests/entityCommunications.integration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
const contact = read('contact.html');
const casePage = read('case.html');
const communicate = read('communicate.html');

function documentOf(html) {
  return new JSDOM(html, { runScripts: 'outside-only' }).window.document;
}

function buttonFor(doc, token) {
  return doc.querySelector(`button[data-ws-tab="${token}"]`);
}

describe('contact communications tab wiring', () => {
  const doc = documentOf(contact);

  test('keeps the established workspace token but opens the shared Communications widget', () => {
    const button = buttonFor(doc, 'send');
    expect(button).not.toBeNull();
    expect(button.textContent).toMatch(/Communications?/i);
    expect(button.getAttribute('onclick')).toContain("openTab(this, 'tabSend')");
    expect(doc.querySelector('#tabSend #communicationsFrame')).not.toBeNull();
  });

  test('the iframe is lazy, contact-scoped, and refreshes on re-entry', () => {
    const frame = doc.getElementById('communicationsFrame');
    expect(frame.hasAttribute('src')).toBe(false);
    const onclick = buttonFor(doc, 'send').getAttribute('onclick');
    expect(onclick).toMatch(/if\s*\(\s*!E\(['"]communicationsFrame['"]\)\.src\s*\)/);
    expect(onclick).toContain('entityCommunications.html?link_type=contact&link_id=${encodeURIComponent(clientID)}');
    expect(onclick).toMatch(/contentWindow\?\.reloadCommunications\?\.\(\)/);
    // The old eager compose-only iframe must not overwrite the lazy URL.
    expect(contact).not.toMatch(/communicationsFrame['"]\)\.src\s*=\s*['"]\/?communicate\.html/);
  });
});

describe('case communications tab wiring', () => {
  const doc = documentOf(casePage);

  test('adds one top-level Communications tab and one shared widget iframe', () => {
    const buttons = [...doc.querySelectorAll('button[data-ws-tab="comms"]')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/Communications?/i);
    expect(buttons[0].getAttribute('onclick')).toContain("openTab(this, 'tabComms')");
    expect(doc.querySelectorAll('#tabComms #communicationsFrame')).toHaveLength(1);
    expect(doc.querySelectorAll('#communicationsFrame')).toHaveLength(1);
  });

  test('the iframe is lazy, case-scoped, and refreshes on re-entry', () => {
    const frame = doc.getElementById('communicationsFrame');
    expect(frame.hasAttribute('src')).toBe(false);
    const onclick = buttonFor(doc, 'comms').getAttribute('onclick');
    expect(onclick).toMatch(/if\s*\(\s*!E\(['"]communicationsFrame['"]\)\.src\s*\)/);
    expect(onclick).toContain('entityCommunications.html?link_type=case&link_id=${encodeURIComponent(caseID)}');
    expect(onclick).toMatch(/contentWindow\?\.reloadCommunications\?\.\(\)/);
  });
});

describe('case send/log context bridge', () => {
  test('the legacy composer keeps a selected contact as primary and stamps manual logs about the case', () => {
    expect(communicate).toContain("caseId = P.communicationContext?.case_id || null");
    expect(communicate).toContain("about_type: 'case', about_id: caseId");
    expect(communicate).toMatch(/type: 'email', \.\.\.logScope\(\)/);
    expect(communicate).toMatch(/type: 'call', \.\.\.logScope\(\)/);
  });
});
