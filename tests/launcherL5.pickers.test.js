// tests/launcherL5.pickers.test.js
//
/**
 * launcher-nits L5 — uiConfigService.pickers, the tool list per caller. The rows
 * are shaped as mysql2 returns them (visible_to parsed); the column itself is
 * tests/launcherL5.pickers.mysql.test.js. This file is what CI runs: its mysql
 * lane skips.
 */
'use strict';

const { pickers } = require('../services/uiConfigService');

const TOOLS = [
  { tool_key: 'a-open', title: 'A Open', visible_to: null },
  { tool_key: 'b-staff', title: 'B Staff', visible_to: ['staff'] },
  { tool_key: 'c-both', title: 'C Both', visible_to: ['staff', 'attorney'] },
  { tool_key: 'd-nobody', title: 'D Nobody', visible_to: [] },
  { tool_key: 'e-odd', title: 'E Odd', visible_to: 'staff' },
];
const ALL = TOOLS.map((t) => t.tool_key);

function makeDb(items) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      calls.push(sql);
      if (/FROM tools/.test(sql)) return [TOOLS];
      if (/FROM report_definitions/.test(sql)) return [[]];
      if (/FROM ui_config/.test(sql)) return [items ? [{ scope: 'user', config_key: 'items', config: { items } }] : []];
      throw new Error('unscripted ' + sql);
    },
  };
}
const jwtAuth = (roles) => ({ type: 'jwt', userId: 9, roles });
const keys = (list) => list.map((t) => t.key);

describe('who is offered which tool', () => {
  test.each([
    [['staff'], ['a-open', 'b-staff', 'c-both']],
    [['attorney'], ['a-open', 'c-both']],
    [['attorney', 'staff'], ['a-open', 'b-staff', 'c-both']],
    [['form_dev'], ['a-open']],
    [['automation'], ['a-open']],
    [[], ['a-open']],
    [['admin'], ALL],
    [['it'], ALL],
    [['su'], ALL],
  ])('roles %j', async (roles, want) => {
    expect(keys((await pickers(makeDb(), jwtAuth(roles))).tools)).toEqual(want);
  });

  test('no caller, or a token without a roles list, gets the open tools only', async () => {
    expect(keys((await pickers(makeDb())).tools)).toEqual(['a-open']);
    expect(keys((await pickers(makeDb(), { type: 'jwt', userId: 9 })).tools)).toEqual(['a-open']);
  });
});

describe('held: the caller\'s own buttons on tools they are not offered', () => {
  const tool = (key) => ({ id: `user:${key}`, label: key, icon: 'x', action: { type: 'tool', key, present: 'modal' } });

  test('a kept button comes back with its title, and an open tool is not repeated', async () => {
    const r = await pickers(makeDb([tool('b-staff'), tool('a-open')]), jwtAuth(['form_dev']));
    expect(r.held).toEqual([{ key: 'b-staff', title: 'B Staff' }]);
    expect(keys(r.tools)).toEqual(['a-open']);
  });

  test('a saved view that shares a tool\'s key is not a button on that tool', async () => {
    const view = { id: 'user:v', label: 'v', icon: 'x', action: { type: 'view', key: 'b-staff', present: 'modal' } };
    expect((await pickers(makeDb([view]), jwtAuth(['form_dev']))).held).toEqual([]);
  });

  test('a malformed item is skipped, not fatal', async () => {
    expect((await pickers(makeDb([null, { id: 'x' }, tool('b-staff')]), jwtAuth(['form_dev']))).held)
      .toEqual([{ key: 'b-staff', title: 'B Staff' }]);
  });

  test('nothing withheld: the items document is never read', async () => {
    const db = makeDb([tool('b-staff')]);
    expect((await pickers(db, jwtAuth(['su']))).held).toEqual([]);
    expect(db.calls.some((s) => /FROM ui_config/.test(s))).toBe(false);
  });
});
