/**
 * tests/startupInit.maintenance.test.js
 *
 * startup/init.js under MAINTENANCE_MODE=1.
 *
 * WHAT IS LOCKED SHUT
 *   - A maintenance revision NEVER schedules the custom-field reconcile at
 *     boot. That reconcile is DDL; the database is meant to be frozen.
 *   - It DOES warm the hook spool (captured webhooks depend on that channel,
 *     and the warmup's log line is how the operator learns the spool queue is
 *     missing or not paused).
 *   - Off = exactly the boot it has always been: reconcile scheduled, spool
 *     untouched.
 *
 * Run: npx jest tests/startupInit.maintenance.test.js
 */

'use strict';

const taskQueue = require('../lib/taskQueue');
const hookSpool = require('../lib/hookSpool');
const reconciler = require('../services/fieldDefReconciler');
const init = require('../startup/init');

let savedMode, tqSpy, spoolSpy, recSpy, warnSpy;
const pool = { marker: 'pool' };

beforeEach(() => {
  savedMode = process.env.MAINTENANCE_MODE;
  delete process.env.MAINTENANCE_MODE;
  tqSpy = jest.spyOn(taskQueue, 'warmup').mockImplementation(() => {});
  spoolSpy = jest.spyOn(hookSpool, 'warmup').mockImplementation(async () => 'paused');
  recSpy = jest.spyOn(reconciler, 'scheduleReconcile').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.MAINTENANCE_MODE; else process.env.MAINTENANCE_MODE = savedMode;
  jest.restoreAllMocks();
});

test('maintenance OFF: the ordinary boot — reconcile scheduled, spool not touched', async () => {
  await init(pool);
  expect(tqSpy).toHaveBeenCalledTimes(1);
  expect(recSpy).toHaveBeenCalledTimes(1);
  expect(recSpy).toHaveBeenCalledWith(pool, { trigger: 'boot' });
  expect(spoolSpy).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
});

test('maintenance ON: no reconcile (DDL on a frozen database); the spool is warmed; says so loudly', async () => {
  process.env.MAINTENANCE_MODE = '1';
  await init(pool);
  expect(recSpy).not.toHaveBeenCalled();
  expect(spoolSpy).toHaveBeenCalledTimes(1);
  expect(tqSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/MAINTENANCE_MODE=1/);
});

test("MAINTENANCE_MODE='0' is the ordinary boot", async () => {
  process.env.MAINTENANCE_MODE = '0';
  await init(pool);
  expect(recSpy).toHaveBeenCalledTimes(1);
  expect(spoolSpy).not.toHaveBeenCalled();
});

test('a spool warmup that rejects does not reject boot', async () => {
  process.env.MAINTENANCE_MODE = '1';
  spoolSpy.mockImplementation(() => Promise.reject(new Error('metadata server down')));
  await expect(init(pool)).resolves.toBeUndefined();
  // let the rejection settle; an unhandled one would fail the run
  await new Promise((r) => setImmediate(r));
});
