'use strict';

const ticket = require('../lib/assistantTicket');

describe('assistant plan tickets', () => {
  const old = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'assistant-test-secret'; });
  afterAll(() => {
    if (old === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = old;
  });

  test('round-trips a plan and stamps an expiry', () => {
    const signed = ticket.sign({ uid: 7, plan: { steps: [{ id: 'q1' }] } }, 5000);
    expect(ticket.verify(signed)).toMatchObject({ uid: 7, plan: { steps: [{ id: 'q1' }] } });
  });

  test('rejects a one-character mutation', () => {
    const signed = ticket.sign({ uid: 7 }, 5000);
    const mutated = `${signed[0] === 'a' ? 'b' : 'a'}${signed.slice(1)}`;
    expect(() => ticket.verify(mutated)).toThrow(/invalid or has expired/);
  });

  test('rejects an expired ticket', () => {
    const signed = ticket.sign({ uid: 7 }, -1);
    expect(() => ticket.verify(signed)).toThrow(/invalid or has expired/);
  });
});
