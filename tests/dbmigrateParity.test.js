// tests/dbmigrateParity.test.js
//
/**
 * scripts/dbmigrate/parity.js — the pure decision logic of the migration gate.
 *
 * WHY THIS TEST EXISTS
 *   parity.js is the last check before production traffic is pointed at a
 *   migrated database. Its failure mode is not a crash, it is a false PASS —
 *   and every function here has a way to produce one:
 *
 *     contentHashSql  dropping a real column from the hash (it did: a bare
 *                     /GENERATED/ filter also matched EXTRA='DEFAULT_GENERATED',
 *                     i.e. every `created_at DEFAULT CURRENT_TIMESTAMP` and
 *                     cases.custom — a changed cases.custom passed. Caught by a
 *                     real-engine negative control, locked here.)
 *     diffRows        matching by position instead of key, or ignoring a field
 *     diffMaps        treating a table missing on one side as "no difference"
 *     exitCodeFor     letting data drift through under --strict
 *     parseTarget     accepting a password in argv
 *
 * The SQL these build was exercised against two real MySQL 8.0 servers
 * (source → dump.sh → import → parity) with ~20 negative controls on
 * 2026-10-11; CI has no MySQL, so this file locks the logic and the SQL text.
 */

'use strict';

const {
  parseTarget, diffRows, diffMaps, exitCodeFor, countSql, contentHashSql,
  sectionHash, parseArgs, SECTION_KEYS, HARD_SETTINGS, INFO_SETTINGS, fieldDiffText,
} = require('../scripts/dbmigrate/parity');

describe('parseTarget', () => {
  test('parses user, host, port, database; port defaults to 3306', () => {
    expect(parseTarget('mysql://app@db.example.test:3307/yc')).toEqual(
      { host: 'db.example.test', port: 3307, user: 'app', database: 'yc' });
    expect(parseTarget('mysql://app@127.0.0.1/yc').port).toBe(3306);
  });

  test('REFUSES a URL that carries a password, naming the right env var', () => {
    expect(() => parseTarget('mysql://app:hunter2@h/yc', '--src')).toThrow(/SRC_PW/);
    expect(() => parseTarget('mysql://app:hunter2@h/yc', '--dst')).toThrow(/DST_PW/);
    // …and never echoes the secret back into the error text / logs.
    try { parseTarget('mysql://app:hunter2@h/yc', '--src'); } catch (e) {
      expect(e.message).not.toMatch(/hunter2/);
    }
  });

  test.each([
    ['not a url', 'db.example.test/yc'],
    ['wrong scheme', 'postgres://app@h/yc'],
    ['no user', 'mysql://h/yc'],
    ['no database', 'mysql://app@h'],
    ['no database (slash only)', 'mysql://app@h/'],
    ['nested path', 'mysql://app@h/a/b'],
  ])('rejects %s', (_label, url) => {
    expect(() => parseTarget(url, '--src')).toThrow();
  });

  test('percent-encoded user and database are decoded', () => {
    expect(parseTarget('mysql://a%40b@h/my%2Ddb')).toMatchObject({ user: 'a@b', database: 'my-db' });
  });
});

describe('diffRows', () => {
  const K = ['TABLE_NAME', 'COLUMN_NAME'];
  const row = (t, c, extra = {}) => ({ TABLE_NAME: t, COLUMN_NAME: c, COLLATION_NAME: 'utf8mb4_general_ci', ...extra });

  test('identical sets are equal', () => {
    const a = [row('cases', 'id'), row('cases', 'name')];
    expect(diffRows(a, a.map((r) => ({ ...r })), K).equal).toBe(true);
  });

  test('matches by KEY, not position — reordered rows are still equal', () => {
    const a = [row('cases', 'id'), row('cases', 'name')];
    const d = diffRows(a, [a[1], a[0]], K);
    expect(d.equal).toBe(true);
    expect(d.changed).toEqual([]);
  });

  test('names the differing field, with both values', () => {
    const a = [row('documents', 'external_id', { COLLATION_NAME: 'utf8mb4_bin' })];
    const b = [row('documents', 'external_id', { COLLATION_NAME: 'utf8mb4_general_ci' })];
    const d = diffRows(a, b, K);
    expect(d.equal).toBe(false);
    expect(d.changed).toEqual([{
      key: 'documents / external_id',
      fields: [{ col: 'COLLATION_NAME', src: 'utf8mb4_bin', dst: 'utf8mb4_general_ci' }],
    }]);
  });

  test('a row on one side only is reported on that side', () => {
    const a = [row('cases', 'id'), row('cases', 'gone')];
    const b = [row('cases', 'id'), row('cases', 'new')];
    const d = diffRows(a, b, K);
    expect(d.equal).toBe(false);
    expect(d.onlySrc).toEqual(['cases / gone']);
    expect(d.onlyDst).toEqual(['cases / new']);
  });

  test('NULL vs empty string vs missing key are all differences', () => {
    const base = { TABLE_NAME: 't', COLUMN_NAME: 'c' };
    expect(diffRows([{ ...base, D: null }], [{ ...base, D: '' }], K).equal).toBe(false);
    expect(diffRows([{ ...base, D: null }], [{ ...base }], K).equal).toBe(false);
    expect(diffRows([{ ...base, D: 0 }], [{ ...base, D: '0' }], K).equal).toBe(false);
  });

  test('Buffers compare by content (information_schema returns some text as Buffer)', () => {
    const base = { TABLE_NAME: 't', COLUMN_NAME: 'c' };
    expect(diffRows([{ ...base, X: Buffer.from('abc') }], [{ ...base, X: Buffer.from('abc') }], K).equal).toBe(true);
    const d = diffRows([{ ...base, X: Buffer.from('abc') }], [{ ...base, X: Buffer.from('abd') }], K);
    expect(d.changed[0].fields).toEqual([{ col: 'X', src: 'abc', dst: 'abd' }]);
  });

  test('every schemaSections section has a key definition', () => {
    // lib/schemaDump.schemaSections returns exactly these sections; a new one
    // without keys would be silently skipped by the structure loop.
    expect(Object.keys(SECTION_KEYS).sort()).toEqual(
      ['checks', 'columns', 'fks', 'indexes', 'tables', 'triggers', 'views']);
  });
});

describe('fieldDiffText — how a differing field is reported', () => {
  const CRLF = "BEGIN\r\n    IF NEW.x = 1 THEN\r\n        SET NEW.x = NULL;\r\n    END IF;\r\nEND";
  const LF = CRLF.replace(/\r\n/g, '\n');

  test('line endings only (the 2026-10-12 rehearsal): named as such, with the CR counts and the fix', () => {
    const t = fieldDiffText(CRLF, LF);
    expect(t).toMatch(/ONLY in line endings/);
    expect(t).toContain('source 4, dest 0');
    expect(t).toContain('--binary-mode');
    expect(t).not.toContain('IF NEW.x');            // the body is NOT dumped
    // either direction, and a lone CR counts too
    expect(fieldDiffText(LF, CRLF)).toContain('source 0, dest 4');
    expect(fieldDiffText('a\rb', 'a\nb')).toMatch(/ONLY in line endings/);
  });

  test('a real change is never mistaken for a line-ending change, even with CRLF present', () => {
    const t = fieldDiffText(CRLF, LF.replace('SET NEW.x = NULL', 'SET NEW.x = 0'));
    expect(t).not.toMatch(/ONLY in line endings/);
    expect(t).toMatch(/source .* \| dest /);
  });

  test('long text: a window around the FIRST differing character, not both values whole', () => {
    const a = 'a'.repeat(300) + 'X' + 'b'.repeat(500);
    const b = 'a'.repeat(300) + 'Y' + 'b'.repeat(500);
    const t = fieldDiffText(a, b);
    expect(t).toContain('first difference at character 300');
    expect(t).toContain('lengths 801 / 801');
    expect(t).toContain('aX');
    expect(t).toContain('aY');
    expect(t.length).toBeLessThan(400);
  });

  test('long text where one side is a prefix of the other: the difference is at the shorter length', () => {
    expect(fieldDiffText('q'.repeat(200), 'q'.repeat(250))).toContain('first difference at character 200 (lengths 200 / 250)');
  });

  test('short values and non-strings are shown whole, JSON-quoted (NULL vs empty stays visible)', () => {
    expect(fieldDiffText('utf8mb4_bin', 'utf8mb4_general_ci')).toBe('source "utf8mb4_bin" | dest "utf8mb4_general_ci"');
    expect(fieldDiffText(null, '')).toBe('source null | dest ""');
    expect(fieldDiffText(1, '1')).toBe('source 1 | dest "1"');
  });
});

describe('diffMaps', () => {
  test('equal maps', () => {
    expect(diffMaps({ a: '1', b: '2' }, { b: '2', a: '1' }).equal).toBe(true);
  });

  test('numeric vs string of the same value is equal (driver typing)', () => {
    expect(diffMaps({ a: 5 }, { a: '5' }).equal).toBe(true);
  });

  test('a differing value is listed with both sides', () => {
    const d = diffMaps({ log: '10', cases: '3' }, { log: '11', cases: '3' });
    expect(d.equal).toBe(false);
    expect(d.differing).toEqual([{ name: 'log', src: '10', dst: '11' }]);
  });

  test('a name on one side only is NOT equal', () => {
    expect(diffMaps({ a: '1', gone: '2' }, { a: '1' })).toMatchObject({ equal: false, onlySrc: ['gone'] });
    expect(diffMaps({ a: '1' }, { a: '1', extra: '2' })).toMatchObject({ equal: false, onlyDst: ['extra'] });
  });
});

describe('exitCodeFor', () => {
  const c = (status) => ({ name: 'x', status, detail: [] });

  test('all PASS / INFO → 0 in both modes', () => {
    expect(exitCodeFor([c('PASS'), c('INFO')])).toBe(0);
    expect(exitCodeFor([c('PASS'), c('INFO')], { strict: true })).toBe(0);
  });

  test('any FAIL → 1 in both modes', () => {
    expect(exitCodeFor([c('PASS'), c('FAIL')])).toBe(1);
    expect(exitCodeFor([c('PASS'), c('FAIL')], { strict: true })).toBe(1);
  });

  test('DRIFT is tolerated in rehearsal and FAILS under --strict', () => {
    expect(exitCodeFor([c('PASS'), c('DRIFT')])).toBe(0);
    expect(exitCodeFor([c('PASS'), c('DRIFT')], { strict: true })).toBe(1);
  });

  test('FAIL wins over DRIFT in rehearsal', () => {
    expect(exitCodeFor([c('DRIFT'), c('FAIL')])).toBe(1);
  });
});

describe('countSql', () => {
  test('one UNION ALL of exact counts, name as a literal and as an identifier', () => {
    expect(countSql(['cases', 'log'])).toBe(
      "SELECT 'cases' AS t, COUNT(*) AS n FROM `cases` UNION ALL SELECT 'log' AS t, COUNT(*) AS n FROM `log`");
  });

  test('empty list → null (caller skips the query)', () => {
    expect(countSql([])).toBeNull();
  });

  test('quotes and backticks in a table name cannot break out', () => {
    expect(countSql(["a`b'c"])).toBe("SELECT 'a`b''c' AS t, COUNT(*) AS n FROM `a``b'c`");
  });
});

describe('contentHashSql', () => {
  const col = (name, dataType = 'varchar', extra = '') => ({ name, dataType, extra });

  test('hashes every base column, each on its own, NULL as a marker', () => {
    const sql = contentHashSql('t', [col('id', 'int'), col('name')]);
    expect(sql).toBe(
      "SELECT COUNT(*) AS n, COALESCE(SUM(h), 0) AS s, COALESCE(BIT_XOR(h), 0) AS x " +
      "FROM (SELECT CRC32(CONCAT_WS('|', IFNULL(CRC32(`id`), 'N'), IFNULL(CRC32(`name`), 'N'))) AS h FROM `t`) AS r");
  });

  test('JSON columns go through the text round trip a dump performs', () => {
    const sql = contentHashSql('t', [col('data', 'json')]);
    expect(sql).toContain("IFNULL(CRC32(CAST(CAST(CAST(`data` AS CHAR) AS JSON) AS CHAR)), 'N')");
    expect(contentHashSql('t', [col('data', 'JSON')])).toBe(sql); // case-insensitive type
  });

  test('VIRTUAL and STORED generated columns are skipped', () => {
    const sql = contentHashSql('cases', [
      col('case_id'), col('cf_clio_matter', 'varchar', 'VIRTUAL GENERATED'),
      col('total', 'int', 'STORED GENERATED'),
    ]);
    expect(sql).toContain('`case_id`');
    expect(sql).not.toContain('cf_clio_matter');
    expect(sql).not.toContain('`total`');
  });

  test('REGRESSION: DEFAULT_GENERATED is an ordinary column and MUST be hashed', () => {
    // information_schema EXTRA for `created_at datetime DEFAULT CURRENT_TIMESTAMP`
    // and for cases.custom (expression default). A bare /GENERATED/ filter
    // dropped these and a changed cases.custom passed the gate.
    const sql = contentHashSql('cases', [
      col('case_id'),
      col('custom', 'json', 'DEFAULT_GENERATED'),
      col('created_at', 'datetime', 'DEFAULT_GENERATED'),
      col('updated_at', 'datetime', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'),
    ]);
    expect(sql).toContain('`custom`');
    expect(sql).toContain('`created_at`');
    expect(sql).toContain('`updated_at`');
  });

  test('auto_increment and other EXTRA values do not exclude a column', () => {
    const sql = contentHashSql('t', [col('id', 'int', 'auto_increment'), col('v', 'int', 'INVISIBLE')]);
    expect(sql).toContain('`id`');
    expect(sql).toContain('`v`');
  });

  test('a table with only generated columns still returns a count', () => {
    expect(contentHashSql('t', [col('g', 'int', 'VIRTUAL GENERATED')])).toBe(
      'SELECT COUNT(*) AS n, 0 AS s, 0 AS x FROM `t`');
  });

  test('backticks in identifiers are doubled', () => {
    const sql = contentHashSql('we`ird', [col('c`ol')]);
    expect(sql).toContain('FROM `we``ird`');
    expect(sql).toContain('CRC32(`c``ol`)');
  });
});

describe('sectionHash', () => {
  test('stable for equal input, different for different input, Buffers by content', () => {
    const a = [{ x: 1, y: Buffer.from('q') }];
    expect(sectionHash(a)).toBe(sectionHash([{ x: 1, y: Buffer.from('q') }]));
    expect(sectionHash(a)).not.toBe(sectionHash([{ x: 2, y: Buffer.from('q') }]));
    expect(sectionHash(a)).not.toBe(sectionHash([{ x: 1, y: Buffer.from('r') }]));
  });
});

describe('parseArgs', () => {
  test('flags and values', () => {
    expect(parseArgs(['--src', 'A', '--dst', 'B', '--strict', '--checksum', '--expect-definer', 'u@%', '--json']))
      .toEqual({ src: 'A', dst: 'B', strict: true, checksum: true, json: true, expectDefiner: 'u@%' });
  });

  test('defaults are the SAFE rehearsal settings only when asked — strict is opt-in, never implied', () => {
    expect(parseArgs(['--src', 'A', '--dst', 'B'])).toMatchObject({ strict: false, checksum: false, expectDefiner: null });
  });

  test('missing --src/--dst and unknown arguments throw', () => {
    expect(() => parseArgs(['--src', 'A'])).toThrow(/--src and --dst/);
    expect(() => parseArgs(['--src', 'A', '--dst', 'B', '--strct'])).toThrow(/unknown argument/);
  });
});

describe('settings lists', () => {
  test('the settings the app depends on are HARD gates', () => {
    const hard = HARD_SETTINGS.map(([n]) => n);
    // sql_mode: relaxed mode is load-bearing (CLAUDE.md invariants).
    // named_time_zones: after_contact_update calls CONVERT_TZ with a zone name.
    for (const n of ['sql_mode', 'lower_case_table_names', 'collation_server', 'utc_offset', 'named_time_zones']) {
      expect(hard).toContain(n);
    }
  });

  test('no setting is listed twice or in both lists', () => {
    const all = [...HARD_SETTINGS, ...INFO_SETTINGS].map(([n]) => n);
    expect(new Set(all).size).toBe(all.length);
  });

  test('the buffer pool is reported (it is the number the tier decision turns on)', () => {
    expect(INFO_SETTINGS.map(([n]) => n)).toContain('innodb_buffer_pool_size_mb');
  });
});
