'use strict';
// Behavioural tests for the custom_code sandbox. These run the REAL executor,
// which forks the REAL child — nothing here mocks the thing under test. Each
// test asserts an outcome, never a source string: the point of the slice is
// what an escaping script can and cannot reach, and only running it shows that.
//
// A fork costs ~60-120ms, so these are deliberately few and pointed.

const path = require('path');
const { executeJob, customCodeChildOptions, CUSTOM_CODE_KILL_GRACE_MS } = require(path.join(__dirname, '..', 'lib', 'job_executor'));
const { run, revive } = require(path.join(__dirname, '..', 'lib', 'customCodeRunner'));

const job = (code, extra = {}) => ({ id: 'test-job', data: { type: 'custom_code', code, ...extra } });

jest.setTimeout(30000);

// The boundary is behind `custom_code_child_process`, which fails CLOSED:
// only an explicit '0' selects the legacy in-process path; absent, blank or
// anything else is the child (2026-10-26 — it used to be `=== '1'`, so a
// missing row ran every standard step in-process). cfg() reads the env var
// when no DB row overrides it, so the tests select the path the same way
// production will.
beforeEach(() => { process.env.CUSTOM_CODE_CHILD_PROCESS = '1'; });
afterEach(() => { delete process.env.CUSTOM_CODE_CHILD_PROCESS; });

describe('custom_code runs in a scrubbed child process', () => {
  test('a pure transform returns the same value it always did', async () => {
    await expect(executeJob(job('input.a + input.b', { input: { a: 2, b: 3 } }))).resolves.toBe(5);
    await expect(executeJob(job('({ joined: input.xs.join("-"), n: input.xs.length })',
      { input: { xs: ['a', 'b', 'c'] } }))).resolves.toEqual({ joined: 'a-b-c', n: 3 });
    await expect(executeJob(job('"<p>" + input.name + "</p>"', { input: { name: 'Jane' } })))
      .resolves.toBe('<p>Jane</p>');
  });

  test('the escape that reached process.env in-process now reaches nothing', async () => {
    // The classic walk-back. In-process this returned the real `process`,
    // whose env held the DB credentials. The sandbox holds no host-created
    // object, so the walk finds only this context's own intrinsics — and the
    // compiled function throws outright, because this context has no
    // `process` binding to return. Either outcome proves the property; the
    // test asserts what it cannot observe rather than which way it fails.
    const walked = await executeJob(job(`
      var got;
      try { got = String(input.constructor.constructor("return typeof process")()); }
      catch (e) { got = "threw: " + e.message; }
      got;
    `));
    expect(walked).toMatch(/^(undefined|threw: process is not defined)$/);

    // And even reaching a `process` by any other route finds no secrets: the
    // child is given no environment at all.
    await expect(executeJob(job(
      'typeof process === "undefined" ? "no process" : Object.keys(process.env).length'
    ))).resolves.toBe('no process');
  });

  test('the child is given no environment and the hardening preload', () => {
    // Asserted on the options, not probed from inside the sandbox. A probe
    // cannot prove this: a sandbox that could read its own process.env would
    // itself be the bug, so the probe comes back empty either way and proves
    // nothing. (It did exactly that here — the first version of this test
    // asserted the env count inside `if (reached)`, which is never true, and
    // a mutation putting process.env back went unnoticed.)
    const opts = customCodeChildOptions();
    expect(opts.env).toEqual({});
    expect(Object.keys(opts.env)).toHaveLength(0);
    expect(opts.execArgv).toContain('--require');
    expect(opts.execArgv.some((a) => /customCodeHarden\.js$/.test(a))).toBe(true);
    expect(opts.stdio).toContain('ipc');
    expect(CUSTOM_CODE_KILL_GRACE_MS).toBeGreaterThan(0);
  });

  test('the hardening actually refuses the pivots, run in a real child', async () => {
    // Behavioural, in a child loaded exactly as the executor loads it.
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const harden = require.resolve(path.join(__dirname, '..', 'lib', 'customCodeHarden.js'));
    // A real script file, NOT `node -e`: an eval entry has no main module at
    // all, so `process.mainModule === undefined` would hold whether or not
    // the hardening cleared it, and a mutation leaving it in place passed.
    const probe = `
      // Read mainModule after a turn: the preload clears it on setImmediate,
      // because Node assigns it after the preload runs. Step code only ever
      // runs on a later IPC message, so this is the state it sees.
      const out = { mainModule: null, netConnect: null, socketConnect: null, dns: null, cp: null };
      await new Promise((r) => setImmediate(r));
      out.mainModule = process.mainModule === undefined;
      try { require('net').connect(80, '169.254.169.254'); out.netConnect = 'allowed'; }
      catch (e) { out.netConnect = e.code || 'threw'; }
      // Both entry points: patching one and not the other is a hole, and a
      // mutation removing just the prototype patch went unnoticed before.
      try { new (require('net').Socket)().connect(80, '169.254.169.254'); out.socketConnect = 'allowed'; }
      catch (e) { out.socketConnect = e.code || 'threw'; }
      try { require('dns').lookup('metadata.google.internal', () => {}); out.dns = 'allowed'; }
      catch (e) { out.dns = e.code || 'threw'; }
      try { require('child_process'); out.cp = 'allowed'; }
      catch (e) { out.cp = e.code || 'threw'; }
      console.log(JSON.stringify(out));
    `;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-')), 'probe.js');
    fs.writeFileSync(file, `(async () => {${probe}})();`);
    try {
      // The marker the parent passes, without which the preload is inert by
      // design — it patches process globals, so a plain load must do nothing.
      const raw = execFileSync(process.execPath,
        ['--require', harden, file, '--custom-code-child'], { encoding: 'utf8' });
      const out = JSON.parse(raw.trim().split('\n').pop());
      expect(out.mainModule).toBe(true);
      expect(out.netConnect).toBe('CUSTOM_CODE_NO_NETWORK');
      expect(out.socketConnect).toBe('CUSTOM_CODE_NO_NETWORK');
      expect(out.dns).toBe('CUSTOM_CODE_NO_NETWORK');
      expect(out.cp).toBe('CUSTOM_CODE_NO_NETWORK');
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });

  test('a returned Date survives the process boundary as a Date', async () => {
    // 28 of the 97 live steps do date math AND declare set_vars, which resolve
    // against the returned value, so a Date silently becoming an ISO string
    // would be a real behaviour change.
    const out = await executeJob(job('({ when: new Date(1761100000000), n: 1 })'));
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(1761100000000);
    await expect(executeJob(job('new Date(0)'))).resolves.toBeInstanceOf(Date);
    // Non-finite numbers too — plain JSON turns these into null.
    const odd = await executeJob(job('({ a: NaN, b: Infinity, c: -Infinity })'));
    expect(Number.isNaN(odd.a)).toBe(true);
    expect(odd.b).toBe(Infinity);
    expect(odd.c).toBe(-Infinity);
  });

  test('console.log still reaches the parent log, prefixed', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await executeJob(job('console.log("hello", 42); "done"'));
      expect(spy).toHaveBeenCalledWith('[CUSTOM CODE test-job]', 'hello 42');
    } finally { spy.mockRestore(); }
  });

  test('a throwing step reports its own message; a runaway step still times out', async () => {
    await expect(executeJob(job('throw new Error("step said no")'))).rejects.toThrow('step said no');
    await expect(executeJob(job('while (true) {}', { timeout_ms: 300 })))
      .rejects.toMatchObject({ code: 'CUSTOM_CODE_TIMEOUT' });
  });

  // A function (or symbol) final value crosses with NO valueJson. Parsing that
  // in the parent's IPC listener threw where nothing catches it, and
  // server.js's uncaughtException handler exited the process — a one-request
  // instance restart for any staff user via a safe-mode test-step. Unfixed,
  // the promise never settles (finish() had already marked it), so these
  // time out rather than pass.
  test('a final value JSON cannot carry is a step error, in both engines', async () => {
    for (const extra of [{}, { code_mode: 'safe' }]) {
      await expect(executeJob(job('(function () {})', extra)))
        .rejects.toThrow(/cannot be passed on/);
      await expect(executeJob(job('Symbol("s")', extra)))
        .rejects.toThrow(/cannot be passed on|could not be read|symbol/i);
    }
  }, 15000);

  test('undefined and a cyclic return are both handled, not silently changed', async () => {
    await expect(executeJob(job('undefined'))).resolves.toBeUndefined();
    await expect(executeJob(job('var a = {}; a.self = a; a;')))
      .rejects.toThrow(/cycle/);
  });
});

describe('the hardening is inert unless it is preloading the child', () => {
  test('a plain require patches nothing in the importing process', () => {
    // THE bug this file exists to prevent recurring. The preload patches
    // process-global state (module loader, net, dns) and originally did so at
    // IMPORT time, so anything that merely loaded every file under lib/
    // patched the JEST WORKER instead — 6 suites and 231 tests red in an
    // otherwise green tree, every one a route suite that opens a socket, with
    // empty error bodies that read as a broken commit. Seven full-suite runs
    // went on memory, a peer session, a worktree cache and firmConfig before
    // the file was tested on its own.
    //
    // Probed in a child WITHOUT the marker: requiring it here would patch
    // this worker if the guard ever regressed, which is the thing being
    // tested, so it cannot be tested in-process.
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const harden = require.resolve(path.join(__dirname, '..', 'lib', 'customCodeHarden.js'));
    const probe = `
      require(${JSON.stringify(harden)});
      setImmediate(() => {
        let netUsable = false;
        try { require('net').connect(1, '127.0.0.1').destroy(); netUsable = true; } catch (e) { netUsable = false; }
        let cpUsable = false;
        try { require('child_process'); cpUsable = true; } catch (e) { cpUsable = false; }
        console.log(JSON.stringify({
          mainModule: process.mainModule !== undefined,
          netUsable, cpUsable,
        }));
      });
    `;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inert-')), 'probe.js');
    fs.writeFileSync(file, probe);
    try {
      const raw = execFileSync(process.execPath, [file], { encoding: 'utf8' });
      const out = JSON.parse(raw.trim().split('\n').pop());
      expect(out).toEqual({ mainModule: true, netUsable: true, cpUsable: true });
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });
});

describe('the flag', () => {
  test('off is the legacy in-process path, and that path is the vulnerable one', async () => {
    // Pinned deliberately. The flag is a rollback lever, and its off position
    // is NOT equivalent — it is the path an escape walks out of. If this test
    // ever starts failing because the legacy path got safe, delete the path,
    // not the test.
    process.env.CUSTOM_CODE_CHILD_PROCESS = '0';
    const reached = await executeJob(job(
      'typeof input.constructor.constructor("return process")()'
    ));
    expect(reached).toBe('object');           // the host process, in-process
    // Same step, flag on: the escape finds nothing.
    process.env.CUSTOM_CODE_CHILD_PROCESS = '1';
    const walled = await executeJob(job(`
      try { String(input.constructor.constructor("return typeof process")()); }
      catch (e) { "threw"; }
    `));
    expect(walled).not.toBe('object');
  });

  test('fails closed: an absent row (or a blank one) with no env var runs the CHILD, not in-process', async () => {
    // The live value is '1' today, but nothing guaranteed the row: a missing
    // or blanked row used to fall through to null, and `=== '1'` sent every
    // standard step to the escapable in-process path. Driven through the real
    // firmConfig with a fake app_settings pool, so "absent" is a real absent
    // row, not a stubbed cfg().
    const firmConfig = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    const probe = 'typeof input.constructor.constructor("return process")()';
    const walledProbe = `
      try { String(input.constructor.constructor("return typeof process")()); }
      catch (e) { "threw"; }
    `;
    delete process.env.CUSTOM_CODE_CHILD_PROCESS;
    try {
      for (const rows of [[], [{ key: 'custom_code_child_process', value: '' }],
        [{ key: 'custom_code_child_process', value: 'yes' }]]) {
        firmConfig._test({ db: { query: async () => [rows] }, resetCache: true });
        await firmConfig.prime();
        expect(firmConfig.cfg('custom_code_child_process')).not.toBe('0');
        const walled = await executeJob(job(walledProbe));
        expect([rows, walled]).toEqual([rows, expect.stringMatching(/^(undefined|threw)$/)]);
      }
      // Only an explicit '0' row selects the legacy path — pinned so the
      // rollback lever is known to still work.
      firmConfig._test({ db: { query: async () => [[{ key: 'custom_code_child_process', value: '0' }]] }, resetCache: true });
      await firmConfig.prime();
      await expect(executeJob(job(probe))).resolves.toBe('object');
    } finally {
      firmConfig._test({ db: null, resetCache: true });
    }
  });

  test('a blank value falls through to the env var, so the kill switch is 0 and not blank', () => {
    // The sibling cloud_tasks_enabled trap, which the registry desc and the
    // firmConfig descriptor both call out.
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    process.env.CUSTOM_CODE_CHILD_PROCESS = '1';
    expect(cfg('custom_code_child_process')).toBe('1');
    process.env.CUSTOM_CODE_CHILD_PROCESS = '0';
    expect(cfg('custom_code_child_process')).toBe('0');
  });

  test('the key is registered in BOTH places, or every code step throws', () => {
    // cfg() throws on an unknown key, so a registry entry without a
    // firmConfig descriptor would break every code step at runtime while
    // looking complete in the settings UI.
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('custom_code_child_process')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(Object.keys(SETTINGS)).toContain('custom_code_child_process');
    expect(SETTINGS.custom_code_child_process).toMatchObject({ kind: 'system', type: 'bool' });
  });
});

describe('the runner module itself', () => {
  test('importing it installs no message listener on this process', () => {
    // It is the child entry point; a stray listener here would mean the
    // parent could be driven by a message meant for a child.
    expect(process.listenerCount('message')).toBe(0);
    expect(typeof run).toBe('function');
  });

  test('revive is the exact inverse of the in-context tagger', () => {
    expect(revive({ __cc: 'undef' })).toBeUndefined();
    expect(revive({ __cc: 'date', v: 5 })).toEqual(new Date(5));
    expect(revive({ __cc: 'num', v: 'NaN' })).toBeNaN();
    expect(revive({ a: [{ __cc: 'date', v: 0 }] }).a[0]).toBeInstanceOf(Date);
    expect(revive({ plain: 1, s: 'x', n: null })).toEqual({ plain: 1, s: 'x', n: null });
  });
});
