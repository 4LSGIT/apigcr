'use strict';
/**
 * tests/reportsDeepLink.test.js
 *
 * A16 — the shell destination 'reports.report' {id} and the Reports pane's
 * narrow bridge. The grammar is `report~<digits>` and nothing else: the id is
 * handed to openReport (the same read a click on the report's card does), the
 * shell is told the destination is ready once the open settles — success or
 * the usual error dialog — and a cold pane takes the rest the shell held.
 * Functions run straight out of the pages' own source.
 */

const fs = require('fs');
const path = require('path');

const reportsHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'reports.html'), 'utf8');
const shellHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} unbalanced`);
}

function bridge({ openReport }) {
  const ready = [];
  const frameElement = { id: 'reportsFrame' };
  const window = { frameElement, parent: { ycAssistantChildReady: (frame, detail) => ready.push([frame, detail]) } };
  // eslint-disable-next-line no-new-func
  const open = new Function('openReport', 'window', `${fnSrc(reportsHtml, 'ycAssistantOpenDestination')}\nreturn ycAssistantOpenDestination;`)(openReport, window);
  return { open, ready, frameElement };
}

describe('the Reports deep-link bridge', () => {
  test('report~<id> opens that report on the run panel and then reports ready', async () => {
    const openReport = jest.fn().mockResolvedValue();
    const { open, ready, frameElement } = bridge({ openReport });
    expect(open('report~21')).toBe(true);
    expect(openReport).toHaveBeenCalledWith(21);
    await new Promise((r) => setImmediate(r));
    expect(ready).toEqual([[frameElement, { destination: 'reports.report' }]]);
  });

  test('a failed open still releases the shell\'s readiness wait', async () => {
    const openReport = jest.fn(() => Promise.reject(new Error('404')));
    const { open, ready } = bridge({ openReport });
    open('report~99');
    await new Promise((r) => setImmediate(r));
    expect(ready).toHaveLength(1);
  });

  test.each(['', 'report', 'report~', 'report~abc', 'report~1~x', 'workflows~3', 'report~12345678901', null, undefined, 'report~-1'])(
    'anything but report~<digits> is refused (%p)', (rest) => {
      const openReport = jest.fn().mockResolvedValue();
      const { open } = bridge({ openReport });
      expect(open(rest)).toBe(false);
      expect(openReport).not.toHaveBeenCalled();
    });

  test('a cold pane takes the held rest at boot and the bridge is exposed for a warm one', () => {
    const init = fnSrc(reportsHtml, 'init');
    expect(init).toContain('ycSubTab.leaf.take()');
    expect(init).toContain('ycAssistantOpenDestination(held)');
    expect(reportsHtml).toContain('window.ycAssistantOpenDestination = ycAssistantOpenDestination;');
    expect(reportsHtml).toContain('<script src="/js/ycSubTab.js"></script>');
  });

  // No page hint since launcher-nits C4: the launcher places the panel (the
  // first page showing its tile, else the panel tab), so the entry is exact.
  test('the shell names the destination with its own launcher/panel vocabulary (no page: the launcher places it)', () => {
    const m = /'reports\.report': Object\.freeze\(\{\s*launcher: 'moreReports', panel: 'reportsDiv', sub: 'report',\s*\}\)/.exec(shellHtml);
    expect(m).not.toBe(null);
    expect(shellHtml).toMatch(/<div id="reportsDiv" class="more-panel"[^>]*>\s*<iframe data-src="\/reports\.html"><\/iframe>/);
  });
});
