'use strict';

/**
 * A code child that SENT its result and then exited must never read as
 * "exited without a result". Node emits a child's 'exit' from the process
 * handle, apart from the IPC pipe the result travels on: Linux libuv reaps
 * every exited child on any SIGCHLD, so a child's 'exit' can be emitted while
 * its result is still unread in the pipe — and the runner's teardown then
 * disconnects the channel, which drops the message. Seen on the land gate's
 * runner (GitHub Actions run 40438820286, workflowEngine.cancelAndLoopGuard:
 * "custom code child exited without a result (code 0, signal null)"). Both
 * fork sites — job_executor.runCustomCode (workflow custom_code) and
 * guestCode._forkBatch (trigger / ingest / suppression / hook bodies) — settle
 * "no result" on 'close', which Node emits only after the pipe's end-of-file,
 * i.e. after every message the child sent has been emitted.
 *
 * Node documents no order between 'exit' and a child's messages, and the race
 * would not reproduce on demand — not on a Mac, not on the land gate's Linux
 * runner, with the parent's loop held until two real children were zombies.
 * So FAKE children replay the losing order (exit, then message, then close)
 * on every platform. child_process.fork is the lowest layer both runners call
 * and they read it at call time, so it is swapped per test.
 */

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const cp = require('child_process');
const { EventEmitter } = require('events');
const { executeJob } = require('../lib/job_executor');
const guestCode = require('../lib/guestCode');

jest.setTimeout(60000);

const realFork = cp.fork;
afterEach(() => { cp.fork = realFork; });

const job = (code) => ({ id: 1, data: { type: 'custom_code', code } });

// The order the race produces: the process is reaped first, the result is
// read after it, the pipe's end-of-file last.
function exitFirstChild(reply) {
  const c = new EventEmitter();
  Object.assign(c, {
    pid: 990001, connected: true,
    send(m) {
      setImmediate(() => {
        c.emit('exit', 0, null);
        const out = reply(m);
        if (out) c.emit('message', out);
        c.connected = false;
        c.emit('close', 0, null);
      });
    },
    kill() {}, disconnect() { c.connected = false; }, unref() {},
  });
  return c;
}

describe('a result read after the child is reaped still counts', () => {
  test('workflow custom_code (job_executor)', async () => {
    cp.fork = () => exitFirstChild(() => ({ ok: true, valueJson: '2', logs: [] }));
    await expect(executeJob(job('input.a + 1'))).resolves.toBe(2);
  });

  test('code bodies (guestCode)', async () => {
    cp.fork = () => exitFirstChild((m) => ({ ok: true,
      batch: m.batch.map(() => ({ ok: true, valueJson: JSON.stringify({ ok: true, value: 2 }), logs: [] })) }));
    await expect(guestCode.runBody('return 2;', {}, { lane: 'events' })).resolves.toBe(2);
  });

  // The other side of the same handler: a child that really sent nothing must
  // still fail — promptly, on 'close', not at the kill timer.
  test.each([
    ['workflow custom_code (job_executor)', () => executeJob(job('1')), /custom code child exited without a result \(code 0, signal null\)/],
    ['code bodies (guestCode)', () => guestCode.runBody('return 1;', {}, { lane: 'events' }), /code sandbox exited without a result \(code 0, signal null\)/],
  ])('%s: no message at all is still "exited without a result"', async (_label, run, msg) => {
    cp.fork = () => exitFirstChild(() => null);
    const t = Date.now();
    await expect(run()).rejects.toThrow(msg);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
