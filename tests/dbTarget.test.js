// tests/dbTarget.test.js
//
/**
 * lib/dbTarget.js + its two consumers (startup/db.js, startup/dbReadonly.js).
 *
 * WHY THIS TEST EXISTS
 *   INSTANCE_CONNECTION_NAME is the single switch that moves both pools from
 *   SiteGround host TCP to the Cloud SQL Unix socket. Two properties are
 *   load-bearing and each is cheap to break in a later edit:
 *
 *   1. UNSET IS A NO-OP. The var ships to main long before the cutover; with it
 *      absent both pools must build exactly the config they built before
 *      (app pool: host only; readonly pool: host + port with its _ro fallbacks).
 *
 *   2. SET NEVER FALLS BACK TO host. On the cutover revision `host` may still
 *      carry the SiteGround address (gcloud --update-env-vars leaves old vars
 *      in place). A helper that "helpfully" fell back to host on a malformed
 *      name would point a Cloud SQL deploy at the OLD database and split
 *      writes across two systems — so a bad name must warn and fail closed.
 *
 * The pools never connect (mysql2 is lazy), so no network I/O happens here.
 * Each consumer case loads its module in an isolated registry with a scoped
 * env, then ends the pool so the sweeper timer is cleared.
 */

'use strict';

const { dbTarget, SOCKET_DIR } = require('../lib/dbTarget');

const NAME = 'lsg-api-425223:us-east1:yc-mysql';
const ENV_KEYS = [
  'INSTANCE_CONNECTION_NAME', 'INSTANCE_CONNECTION_NAME_RO',
  'host', 'host_ro', 'port', 'port_ro', 'user', 'password', 'database',
  'user_ro', 'password_ro', 'database_ro', 'ENVIRONMENT',
];

describe('dbTarget (pure)', () => {
  test('unset → host TCP, port omitted when not supplied', () => {
    const t = dbTarget({ host: 'db.example.test' });
    expect(t.socket).toBe(false);
    expect(t.config).toEqual({ host: 'db.example.test' });
    expect(t.label).toBe('db.example.test');
    expect(t.warning).toBeNull();
  });

  test('unset → host TCP carries a supplied port through untouched', () => {
    expect(dbTarget({ host: 'h', port: 3307 }).config).toEqual({ host: 'h', port: 3307 });
    expect(dbTarget({ instance: '', host: 'h', port: '3306' }).config).toEqual({ host: 'h', port: '3306' });
    expect(dbTarget({ instance: undefined, host: 'h' }).config).toEqual({ host: 'h' });
    expect(dbTarget({ instance: null, host: 'h' }).config).toEqual({ host: 'h' });
  });

  test('whitespace-only instance counts as unset', () => {
    const t = dbTarget({ instance: '   ', host: 'h' });
    expect(t.socket).toBe(false);
    expect(t.config).toEqual({ host: 'h' });
  });

  test('set → socketPath only; host and port are dropped, not merged', () => {
    const t = dbTarget({ instance: NAME, host: 'old.siteground.test', port: 3306 });
    expect(t.socket).toBe(true);
    expect(t.config).toEqual({ socketPath: `${SOCKET_DIR}/${NAME}` });
    expect(t.config).not.toHaveProperty('host');
    expect(t.config).not.toHaveProperty('port');
    expect(t.label).toBe(`socket:${NAME}`);
    expect(t.warning).toBeNull();
  });

  test('set → surrounding whitespace is trimmed out of the socket path', () => {
    expect(dbTarget({ instance: `  ${NAME}\n` }).config.socketPath).toBe(`/cloudsql/${NAME}`);
  });

  test('legacy four-part (domain-scoped project) names are valid', () => {
    const t = dbTarget({ instance: 'example.com:proj:us-east1:inst' });
    expect(t.socket).toBe(true);
    expect(t.warning).toBeNull();
  });

  test.each([
    ['instance name only', 'yc-mysql'],
    ['two parts', 'us-east1:yc-mysql'],
    ['empty middle part', 'proj::yc-mysql'],
    ['inner whitespace', 'proj:us east1:yc-mysql'],
    ['five parts', 'a:b:c:d:e'],
  ])('malformed name (%s) warns and STILL targets the socket — never host', (_label, bad) => {
    const t = dbTarget({ instance: bad, host: 'old.siteground.test', port: 3306 });
    expect(t.socket).toBe(true);
    expect(t.config).toEqual({ socketPath: `/cloudsql/${bad}` });
    expect(t.config).not.toHaveProperty('host');
    expect(typeof t.warning).toBe('string');
    expect(t.warning).toMatch(/PROJECT:REGION:INSTANCE/);
    expect(t.warning).toMatch(/NOT falling back to host/);
  });

  test('label never leaks credentials (it is built from name/host only)', () => {
    const t = dbTarget({ instance: NAME, host: 'h', user: 'u', password: 'hunter2' });
    expect(JSON.stringify(t)).not.toMatch(/hunter2/);
  });
});

// ── consumers ────────────────────────────────────────────────────────────────

/**
 * Load `modulePath` in an isolated module registry under exactly `env` (every
 * key in ENV_KEYS is cleared first, so the host shell cannot leak in), hand
 * the pool's resolved connection config to `inspect`, then end the pool.
 */
async function withPool(modulePath, env, inspect) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);

  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let promisePool;
  try {
    jest.isolateModules(() => { promisePool = require(modulePath); });
    // connectionConfig is mysql2's parsed ConnectionConfig — what a new
    // connection will actually use (lib/base/connection.js reads socketPath
    // first, then port/host).
    await inspect(promisePool.pool.config.connectionConfig, { errSpy, warnSpy });
  } finally {
    if (promisePool) await promisePool.end().catch(() => {});
    errSpy.mockRestore();
    warnSpy.mockRestore();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const BASE = { user: 'u', password: 'p', database: 'd', user_ro: 'ro', password_ro: 'rop' };

describe('startup/db.js (app pool)', () => {
  test('INSTANCE_CONNECTION_NAME unset → host TCP, no socket', async () => {
    await withPool('../startup/db', { ...BASE, host: 'sg.example.test' }, (cc) => {
      expect(cc.socketPath).toBeUndefined();
      expect(cc.host).toBe('sg.example.test');
      expect(cc.port).toBe(3306);
    });
  });

  test('INSTANCE_CONNECTION_NAME set → Unix socket, even with a stale host env', async () => {
    await withPool('../startup/db',
      { ...BASE, host: 'sg.example.test', INSTANCE_CONNECTION_NAME: NAME },
      (cc, { errSpy }) => {
        expect(cc.socketPath).toBe(`/cloudsql/${NAME}`);
        expect(cc.host).not.toBe('sg.example.test'); // stale host must not ride along
        expect(errSpy).not.toHaveBeenCalledWith(expect.stringMatching(/does not look like/));
      });
  });

  test('malformed INSTANCE_CONNECTION_NAME → logged, and host is still NOT used', async () => {
    await withPool('../startup/db',
      { ...BASE, host: 'sg.example.test', INSTANCE_CONNECTION_NAME: 'yc-mysql' },
      (cc, { errSpy }) => {
        expect(cc.socketPath).toBe('/cloudsql/yc-mysql');
        expect(cc.host).not.toBe('sg.example.test');
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[db\] .*does not look like/));
      });
  });
});

describe('startup/dbReadonly.js (readonly pool)', () => {
  test('unset → host_ro/port_ro win over host/port (pre-existing fallbacks intact)', async () => {
    await withPool('../startup/dbReadonly',
      { ...BASE, host: 'main.example.test', host_ro: 'ro.example.test', port: '3306', port_ro: '3307' },
      (cc) => {
        expect(cc.socketPath).toBeUndefined();
        expect(cc.host).toBe('ro.example.test');
        expect(Number(cc.port)).toBe(3307);
      });
  });

  test('unset, no _ro overrides → falls back to host and the default port', async () => {
    await withPool('../startup/dbReadonly', { ...BASE, host: 'main.example.test' }, (cc) => {
      expect(cc.socketPath).toBeUndefined();
      expect(cc.host).toBe('main.example.test');
      expect(Number(cc.port)).toBe(3306);
    });
  });

  test('main INSTANCE_CONNECTION_NAME set → readonly pool follows it onto the socket', async () => {
    await withPool('../startup/dbReadonly',
      { ...BASE, host: 'main.example.test', host_ro: 'ro.example.test', INSTANCE_CONNECTION_NAME: NAME },
      (cc) => {
        expect(cc.socketPath).toBe(`/cloudsql/${NAME}`);
        expect(cc.host).not.toBe('ro.example.test');
        expect(cc.host).not.toBe('main.example.test');
      });
  });

  test('INSTANCE_CONNECTION_NAME_RO overrides the main name', async () => {
    const RO = 'lsg-api-425223:us-east1:yc-mysql-replica';
    await withPool('../startup/dbReadonly',
      { ...BASE, host: 'main.example.test', INSTANCE_CONNECTION_NAME: NAME, INSTANCE_CONNECTION_NAME_RO: RO },
      (cc) => { expect(cc.socketPath).toBe(`/cloudsql/${RO}`); });
  });
});
