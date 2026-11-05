// tests/campaignC6c.ui.test.js
//
/**
 * C6c — the campaign report UI (public/campaign.html): the pure helpers
 * lifted VERBATIM by brace-matching (the workflows.editor.roundtrip pattern)
 * — filter matrix, sort semantics, row escaping — plus source pins for the
 * quick-view columns and the Full report hand-off.
 *
 *   npx jest tests/campaignC6c.ui.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
const SCRIPT = HTML.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`campaign.html: function ${name} not found — did it get renamed?`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`campaign.html: unbalanced braces in ${name}`);
}

// The page's esc is DOM-based (`document.createElement`), so a bare vm can't
// lift it; this stand-in matches its text-position contract (& < > escaped),
// which is the only position the ycRep helpers use it in.
const ctx = vm.createContext({});
vm.runInContext('const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");', ctx);
for (const n of ['ycRepDeliveryCell', 'ycRepClickCell', 'ycRepFilterRows', 'ycRepSortRows', 'ycRepRowsHtml']) {
  vm.runInContext(extractFn(SCRIPT, n), ctx);
}
const call = (fn, ...args) => {
  ctx.__args = args;
  return vm.runInContext(`${fn}(...__args)`, ctx);
};

const ROWS = [
  { result_id: 1, contact_id: 11, contact_name: 'Ann Clicker', contact_email: 'ann@x.test', status: 'sent', delivery_status: 'delivered', opened_at: '2026-11-05T18:00:00Z', clicked_at: '2026-11-05T18:05:00Z', clicks: 3, sent_at: '2026-11-05T15:00:00Z' },
  { result_id: 2, contact_id: 12, contact_name: 'Bob Opener', contact_email: 'bob@x.test', status: 'sent', delivery_status: 'delivered', opened_at: '2026-11-05T17:00:00Z', clicked_at: null, clicks: 0, sent_at: '2026-11-05T15:01:00Z' },
  { result_id: 3, contact_id: 13, contact_name: 'Cid Bounce', contact_email: 'cid@x.test', status: 'sent', delivery_status: 'bounced_hard', opened_at: null, clicked_at: null, clicks: 0, sent_at: '2026-11-05T15:02:00Z' },
  { result_id: 4, contact_id: 14, contact_name: 'Dee Failed <script>', contact_email: 'dee+<img src=x>@x.test', status: 'failed', delivery_status: 'unknown', opened_at: null, clicked_at: null, clicks: 0, sent_at: null },
];

describe('ycRepFilterRows', () => {
  test('the filter matrix: all / clicked / opened / bounced / failed', () => {
    const names = (f) => call('ycRepFilterRows', ROWS, f, '').map((r) => r.contact_id);
    expect(names('all')).toEqual([11, 12, 13, 14]);
    expect(names('clicked')).toEqual([11]);
    expect(names('opened')).toEqual([11, 12]);     // a clicker opened too
    expect(names('bounced')).toEqual([13]);
    expect(names('failed')).toEqual([14]);         // status failed OR unknown
  });

  test('search matches name or email, case-blind; combines with the filter', () => {
    expect(call('ycRepFilterRows', ROWS, 'all', 'BOB@').map((r) => r.contact_id)).toEqual([12]);
    expect(call('ycRepFilterRows', ROWS, 'opened', 'ann').map((r) => r.contact_id)).toEqual([11]);
    expect(call('ycRepFilterRows', ROWS, 'clicked', 'bob')).toEqual([]);
  });
});

describe('ycRepSortRows', () => {
  test('clicked desc puts the heaviest clicker first; contact asc is alphabetical; input order untouched', () => {
    expect(call('ycRepSortRows', ROWS, 'clicked', 'desc')[0].contact_id).toBe(11);
    expect(call('ycRepSortRows', ROWS, 'contact', 'asc').map((r) => r.contact_id)).toEqual([11, 12, 13, 14]);
    expect(call('ycRepSortRows', ROWS, 'contact', 'desc').map((r) => r.contact_id)).toEqual([14, 13, 12, 11]);
    expect(ROWS[0].contact_id).toBe(11);   // slice() — never in place
  });

  test('opened desc: unopened rows sink below every opened one', () => {
    const ids = call('ycRepSortRows', ROWS, 'opened', 'desc').map((r) => r.contact_id);
    expect(ids.slice(0, 2)).toEqual([11, 12]);
  });
});

describe('ycRepRowsHtml / cells', () => {
  test('rows escape contact names AND emails — markup in either can never become markup', () => {
    const html = call('ycRepRowsHtml', ROWS);
    expect(html).toContain('Dee Failed &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('dee+&lt;img src=x&gt;@x.test');   // the email cell escapes too (review N1)
    expect(html).not.toContain('<img');
    expect(html).toContain('(3×)');                 // multi-click count rides the clicked cell
  });

  test('empty set renders the no-match row, never an empty tbody', () => {
    expect(call('ycRepRowsHtml', [])).toContain('No recipients match');
  });

  test('delivery cell: unknown is blank; a hard bounce is danger-colored; clicks cell shows counts', () => {
    expect(call('ycRepDeliveryCell', ROWS[3])).toBe('');
    expect(call('ycRepDeliveryCell', ROWS[2])).toContain('var(--danger)');
    expect(call('ycRepDeliveryCell', ROWS[2])).toContain('bounced hard');
    expect(call('ycRepClickCell', ROWS[0])).toBe('3×');
    expect(call('ycRepClickCell', { clicks: 1 })).toBe('✓');
    expect(call('ycRepClickCell', { clicks: 0 })).toBe('');
  });
});

describe('source pins — the quick view and the hand-off', () => {
  test('the Stats recipient table carries Delivery/Opened/Clicked only for tracked campaigns, inside an overflow wrapper', () => {
    expect(SCRIPT).toContain("${d ? '<th>Delivery</th><th>Opened</th><th>Clicked</th>' : ''}");
    expect(SCRIPT).toContain('ycRepDeliveryCell(r)');
    // 7 columns at phone width: the wrapper contains the overflow (review N4;
    // campaign.html has no mobile-survey surface — plans.md files the debt)
    expect(SCRIPT).toContain('<div style="max-height:45vh;overflow:auto;margin-top:12px"><table class="logTable"');
  });

  test('Full report opens from the Stats dialog deny button, tracked campaigns only', () => {
    expect(SCRIPT).toContain("denyButtonText: 'Full report'");
    expect(SCRIPT).toContain('showDenyButton: !!d');
    expect(SCRIPT).toContain('if (res.isDenied) ycRepOpen()');
  });

  test('the results endpoint feeds clicks per recipient (service pin)', () => {
    const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'campaignService.js'), 'utf8');
    expect(svc).toContain('cc.campaign_id = cr.campaign_id AND cc.result_id = cr.result_id) AS clicks');
  });
});
