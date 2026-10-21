'use strict';

const svc = require('../services/assistantChatService');

describe('YisrAI recent chat storage', () => {
  test('titles are whitespace-normalized and bounded', () => {
    expect(svc.titleFor('  Which   cases\nneed attention?  ')).toBe('Which cases need attention?');
    expect(svc.titleFor('x'.repeat(200))).toHaveLength(120);
  });

  test('list is user-scoped, newest first, and capped', async () => {
    const db = { query: jest.fn().mockResolvedValue([[{ id: 3, title: 'Mine' }]]) };
    await expect(svc.list(db, 7)).resolves.toEqual([{ id: 3, title: 'Mine' }]);
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE user_id = \?/);
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY updated_at DESC, id DESC/);
    expect(db.query.mock.calls[0][1]).toEqual([7, 30]);
  });

  test('get refuses a chat not owned by the signed-in user', async () => {
    const db = { query: jest.fn().mockResolvedValue([[]]) };
    await expect(svc.get(db, 12, 7)).rejects.toMatchObject({ status: 404 });
    expect(db.query.mock.calls[0][1]).toEqual([12, 7]);
  });

  test('create saves the first user message and checks the retention tail', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]) };
    await expect(svc.create(db, { userId: 7, question: 'Who emailed about tractors?' }))
      .resolves.toEqual({ id: 44, title: 'Who emailed about tractors?', model_mode: 'better_quality' });
    expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO assistant_chats/);
    expect(db.query.mock.calls[0][1]).toEqual([7, 'Who emailed about tractors?', 'better_quality']);
    expect(db.query.mock.calls[1][0]).toMatch(/'user'/);
    expect(db.query.mock.calls[1][1]).toEqual([44, 'Who emailed about tractors?', null]);
    expect(db.query.mock.calls[2][1]).toEqual([7, 30]);
  });

  test('model mode is allowlisted and updated only on an owned chat', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce([[{ id: 44, title: 'Mine', model_mode: 'better_quality' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) };
    await expect(svc.setModelMode(db, 44, 7, 'faster_speed')).resolves.toMatchObject({ id: 44, model_mode: 'faster_speed' });
    expect(db.query.mock.calls[1][1]).toEqual(['faster_speed', 44, 7]);
    await expect(svc.setModelMode(db, 44, 7, 'claude-opus-5')).rejects.toMatchObject({ status: 400 });
  });

  test('assistant payload is bounded JSON and ownership is rechecked', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce([[{ id: 44, title: 'Mine' }]])
      .mockResolvedValueOnce([[{ n: 3 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) };
    await svc.addMessage(db, 44, 7, { role: 'assistant', text: 'Ada.', payload: { entities: [{ kind: 'contact', id: '9' }] } });
    expect(db.query.mock.calls[0][1]).toEqual([44, 7]);
    expect(db.query.mock.calls[2][1]).toEqual([44, 'assistant', 'Ada.', '{"entities":[{"kind":"contact","id":"9"}]}']);
    await expect(svc.addMessage(db, 44, 7, { role: 'system', text: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  test('normalized action drafts round-trip as ordinary user-private message payload', async () => {
    const draft = { kind: 'task.create.v1', status: 'draft', title: 'Call client', assignee: { user_id: 7, label: 'Fred' } };
    const db = { query: jest.fn()
      .mockResolvedValueOnce([[{ id: 44, title: 'Mine', model_mode: 'better_quality' }]])
      .mockResolvedValueOnce([[{ id: 90, role: 'assistant', message_text: 'Prepared.', payload: JSON.stringify({ action_draft: draft }) }]]) };
    await expect(svc.get(db, 44, 7)).resolves.toMatchObject({
      messages: [{ role: 'assistant', text: 'Prepared.', payload: { action_draft: draft } }],
    });
  });

  test('a full chat refuses more messages but still records an applied-action marker within its headroom', async () => {
    const dbAt = (n) => ({ query: jest.fn(async (sql) => {
      if (/FROM assistant_chats/.test(sql)) return [[{ id: 44, title: 'Mine' }]];
      if (/COUNT\(\*\) AS n FROM assistant_chat_messages/.test(sql)) return [[{ n }]];
      return [{ affectedRows: 1 }];
    }) });
    const full = svc.MAX_CHAT_MESSAGES;
    const inserts = (db) => db.query.mock.calls.filter(([sql]) => /INSERT INTO assistant_chat_messages/.test(sql)).length;
    let db = dbAt(full);
    await expect(svc.addMessage(db, 44, 7, { role: 'user', text: 'One more?' })).rejects.toMatchObject({ status: 409 });
    expect(inserts(db)).toBe(0);
    db = dbAt(full - 1);
    await svc.addMessage(db, 44, 7, { role: 'user', text: 'Last one' });
    expect(inserts(db)).toBe(1);
    db = dbAt(full);
    await svc.addMessage(db, 44, 7, { role: 'assistant', text: 'Applied.', payload: { action_result: { kind: 'task.create.v1', draft_id: 'd', task_id: 9 } } });
    expect(inserts(db)).toBe(1);
    db = dbAt(full + svc.ACTION_RESULT_HEADROOM);
    await expect(svc.addMessage(db, 44, 7, { role: 'assistant', text: 'Applied.', payload: { action_result: { kind: 'task.create.v1', draft_id: 'd', task_id: 9 } } })).rejects.toMatchObject({ status: 409 });
  });

  test('delete includes the owner in the predicate', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    await svc.remove(db, 44, 7);
    expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/id = \? AND user_id = \?/), [44, 7]);
  });
});
