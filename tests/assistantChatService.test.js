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
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) };
    await svc.addMessage(db, 44, 7, { role: 'assistant', text: 'Ada.', payload: { entities: [{ kind: 'contact', id: '9' }] } });
    expect(db.query.mock.calls[0][1]).toEqual([44, 7]);
    expect(db.query.mock.calls[1][1]).toEqual([44, 'assistant', 'Ada.', '{"entities":[{"kind":"contact","id":"9"}]}']);
    await expect(svc.addMessage(db, 44, 7, { role: 'system', text: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  test('delete includes the owner in the predicate', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    await svc.remove(db, 44, 7);
    expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/id = \? AND user_id = \?/), [44, 7]);
  });
});
