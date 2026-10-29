// tests/resolverPseudoTables.test.js
//
/**
 * resolverService pseudo-tables (YisraMail P3): trigger_data, send, firm —
 * resolved from refs.<name> by the same dot-path walk, never by SQL.
 *
 * WHAT IS LOCKED
 *   - firm.* resolves from lib/firmConfig (via complianceFooter.firmValues)
 *     when refs.firm is absent; a caller's refs.firm (a send-start snapshot)
 *     wins over the live settings.
 *   - send.* resolves from refs.send ONLY; unset → the placeholder stays
 *     unresolved (partial_success / failed under strict) like trigger_data.
 *   - trigger_data is unchanged (values, nested paths, defaults, soft-fail).
 *   - The SQL is skipped when only pseudo-tables are referenced, and a real
 *     table alongside still issues exactly one query.
 *   - escape:'html' escapes pseudo-table values like any other (an & in a URL
 *     becomes &amp; inside an href — correct there).
 *   - scanExpressionRefs still REPORTS send.* / firm.* as table refs, so the
 *     whitelist validators built on it keep refusing them.
 */
'use strict';

const firmConfig = require('../lib/firmConfig');
const { resolve, scanExpressionRefs, PSEUDO_TABLES } = require('../services/resolverService');

const noSql = () => ({ query: jest.fn(async () => { throw new Error('no SQL expected'); }) });

beforeAll(async () => {
  firmConfig._test({
    db: { query: async () => [[
      { key: 'firm_name', value: 'Test Firm & Co' },
      { key: 'firm_address', value: '["1 Main St.","Town, MI 48000"]' },
      { key: 'fe-firm_phone', value: '2485550100' },
      { key: 'firm_attorney_name', value: 'A. Lawyer' },
    ]] },
    resetCache: true,
  });
  await firmConfig.prime();
});
afterAll(() => firmConfig._test({ db: null, resetCache: true }));

test('the pseudo-table set', () => {
  expect(PSEUDO_TABLES).toEqual(['trigger_data', 'send', 'firm']);
  expect(Object.isFrozen(PSEUDO_TABLES)).toBe(true);
});

describe('firm.*', () => {
  test('from firmConfig when refs.firm is absent — no SQL', async () => {
    const db = noSql();
    const r = await resolve({
      db,
      text: '{{firm.name}} | {{firm.postal_address}} | {{firm.phone|phone}} | {{firm.attorney_name}} | {{firm.ad_label}} | {{firm.debt_relief_statement}}',
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(r.status).toBe('success');
    expect(r.text).toBe('Test Firm & Co | 1 Main St., Town, MI 48000 | (248) 555-0100 | A. Lawyer | Advertisement | '
      + 'We are a debt relief agency. We help people file for bankruptcy relief under the Bankruptcy Code.');
  });

  test('a caller\'s refs.firm (a send-start snapshot) wins over the live settings', async () => {
    const r = await resolve({ db: noSql(), text: '{{firm.name}}/{{firm.phone|default:none}}', refs: { firm: { name: 'Snapshot Firm' } } });
    expect(r.text).toBe('Snapshot Firm/none');
  });

  test('an unknown firm key is unresolved (soft) and |default fills it', async () => {
    const r = await resolve({ db: noSql(), text: '{{firm.nope}} {{firm.nope|default:x}}' });
    expect(r.status).toBe('partial_success');
    expect(r.unresolved).toEqual(['{{firm.nope}}']);
    expect(r.text).toBe('{{firm.nope}} x');
  });
});

describe('send.*', () => {
  test('from refs.send only — dot paths, modifiers', async () => {
    const r = await resolve({
      db: noSql(),
      text: '<a href="{{send.unsubscribe_url}}">x</a> {{send.topic_label|upper}}',
      refs: { send: { unsubscribe_url: 'https://4lsg.com/u/Tok', topic_label: 'News' } },
    });
    expect(r.text).toBe('<a href="https://4lsg.com/u/Tok">x</a> NEWS');
  });

  test('unset → unresolved, like trigger_data (partial_success; failed under strict)', async () => {
    const soft = await resolve({ db: noSql(), text: 'u={{send.unsubscribe_url}}' });
    expect(soft.status).toBe('partial_success');
    expect(soft.text).toBe('u={{send.unsubscribe_url}}');
    const strict = await resolve({ db: noSql(), text: 'u={{send.unsubscribe_url}}', strict: true });
    expect(strict.status).toBe('failed');
  });

  test('send.* never computes from anywhere but refs.send (no firm-style fallback)', async () => {
    const r = await resolve({ db: noSql(), text: '{{send.name}}', refs: { firm: { name: 'F' } } });
    expect(r.unresolved).toEqual(['{{send.name}}']);
  });
});

describe('escape:\'html\' applies to pseudo-table values', () => {
  test('firm and send values are escaped; an & in an href becomes &amp;', async () => {
    const r = await resolve({
      db: noSql(), escape: 'html',
      text: '<p>{{firm.name}}</p><a href="{{send.unsubscribe_url}}">u</a>',
      refs: { send: { unsubscribe_url: 'https://4lsg.com/u/T?a=1&b="2"' } },
    });
    expect(r.text).toBe('<p>Test Firm &amp; Co</p><a href="https://4lsg.com/u/T?a=1&amp;b=&quot;2&quot;">u</a>');
  });
});

describe('trigger_data is unchanged', () => {
  test('values, nested paths, defaults, soft-fail, no SQL', async () => {
    const db = noSql();
    const r = await resolve({
      db,
      text: '{{trigger_data.a}} {{trigger_data.b.c}} {{trigger_data.missing|default:dflt}} {{trigger_data.gone}}',
      refs: { trigger_data: { a: 'A', b: { c: 'C' } } },
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(r.text).toBe('A C dflt {{trigger_data.gone}}');
    expect(r.status).toBe('partial_success');
  });

  test('json escape still applies', async () => {
    const r = await resolve({ db: noSql(), text: '{"x":"{{trigger_data.q}}"}', refs: { trigger_data: { q: 'say "hi"' } }, escape: 'json' });
    expect(JSON.parse(r.text)).toEqual({ x: 'say "hi"' });
  });
});

describe('SQL skipping', () => {
  test('only pseudo-tables → no query; a real table alongside → exactly one query', async () => {
    const empty = noSql();
    await resolve({ db: empty, text: '{{firm.name}} {{send.x|default:}} {{trigger_data.y|default:}}', refs: { send: {}, trigger_data: {} } });
    expect(empty.query).not.toHaveBeenCalled();

    const db = { query: jest.fn(async () => [[{ contacts__contact_id: 7, contacts__contact_fname: 'Pat' }]]) };
    const r = await resolve({ db, text: '{{contacts.contact_fname}} at {{firm.name}}', refs: { contacts: { contact_id: 7 } } });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toMatch(/firm|send/);
    expect(r.text).toBe('Pat at Test Firm & Co');
  });

  test('a pseudo-table default inside a real-table placeholder still resolves', async () => {
    const db = { query: jest.fn(async () => [[{ contacts__contact_id: 7, contacts__contact_fname: null }]]) };
    const r = await resolve({ db, text: '{{contacts.contact_fname|default:{{firm.name}}}}', refs: { contacts: { contact_id: 7 } } });
    expect(r.text).toBe('Test Firm & Co');
  });
});

describe('scanExpressionRefs is unchanged: send / firm are still reported as table refs', () => {
  test('so the whitelist validators (esign, portal cards, Casey confirmations) keep refusing them', () => {
    const s = scanExpressionRefs('{{firm.name}} {{send.unsubscribe_url}} {{trigger_data.x}}');
    expect(s.refs).toEqual([{ table: 'firm', column: 'name' }, { table: 'send', column: 'unsubscribe_url' }]);
    expect(s.triggerData).toBe(true);
    expect(s.placeholderCount).toBe(3);
  });
});
