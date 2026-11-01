'use strict';
// style.css's dark `button` rule outranks any class rule, so a selected state
// keeps its class and paints nothing, in dark only. Each row is a control that
// shipped that way: where its state is painted, and what the rule excludes for
// it (the whole class when its rules are tokenised, else the state alone).
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');

const STATES = [
  ['scripts.js', '.na-slot.na-slot-sel', '.na-slot'],
  ['js/ycPager.js', '.yc-page-current', '.yc-page'],
  ['contact.html', '.cseq-scope-btn.active', '.cseq-scope-btn'],
  ['contact.html', '.crel-scope-btn.active', '.crel-scope-btn'],
  ['automation/automationsWidget.html', '.cseq-scope-btn.active', '.cseq-scope-btn'],
  ['checklistView.html', '.ck-kinds button.active', '.ck-kinds button'],
  ['checklistsView.html', '.cx-scope button.active', '.cx-scope button'],
  ['esign/dashboard.html', '.db-toggle button.on', '.db-toggle button'],
  ['index.html', '.pill-button.active', '.pill-button.active'],
  ['style.css', '.yc-filters.open > .yc-f-toggle', '.yc-filters.open > .yc-f-toggle'],
];

// The rule and its :hover twin, each as the list inside its last :not(...).
const exclusions = [...css.matchAll(/html\[data-theme="dark"\] button:not\((?:[^{]*?):not\(\.swal2-styled\):not\(([^{]*?)\)(?::hover:not\(:disabled\))? \{/g)]
  .map((m) => m[1].split(',').map((x) => x.trim()));

describe('dark button rule leaves selected states alone', () => {
  it('finds the rule and its :hover twin', () => {
    expect(exclusions).toHaveLength(2);
  });

  it('the two rules exclude the same controls', () => {
    expect([...exclusions[1]].sort()).toEqual([...exclusions[0]].sort());
  });

  it.each(STATES)('%s paints %s, and the rule excludes %s', (file, state, excluded) => {
    const esc = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(read(file)).toMatch(new RegExp(esc + '(?![\\w-])'));
    expect(exclusions[0]).toContain(excluded);
  });

  it('the open filters toggle keeps a dark border, having none of its own', () => {
    expect(css).toMatch(/html\[data-theme="dark"\] \.yc-filters\.open > \.yc-f-toggle \{\s*border: 1px solid var\(--border\)/);
  });

  it('button:disabled does not dim the current page', () => {
    expect(css).toContain('html[data-theme="dark"] button:disabled:not(.yc-page-current) {');
    expect(css).not.toContain('html[data-theme="dark"] button:disabled {');
  });
});
