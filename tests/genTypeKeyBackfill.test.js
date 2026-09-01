// tests/genTypeKeyBackfill.test.js
//
/**
 * Unified Events U2 — scripts/genTypeKeyBackfill.js ↔ the committed migration.
 *
 * The migration's two GENERATED blocks (seed, backfill) are derived from
 * scripts/calendarTypeSeed.js and scripts/typeKeyVocabulary.js (E1's vocabulary,
 * frozen and moved out of the service at U3). This suite regenerates
 * both and asserts BYTE-EQUALITY with what is committed in
 * ref/2026-09-01_unified_events_u2.sql and tests/fixtures/calendar_item_types.seed.json.
 *
 * If it fails after an intentional change:
 *   node scripts/genTypeKeyBackfill.js --write
 * and commit the result. Never hand-edit the blocks.
 *
 * Also lints the migration for the house rules the prompt lists (no session
 * variables, collation spelled out, kind ENUM byte-identical to E0a's).
 *
 * Run:  npx jest tests/genTypeKeyBackfill.test.js
 */

'use strict';

const fs   = require('fs');
const gen  = require('../scripts/genTypeKeyBackfill');
const { SEED, seedRows } = require('../scripts/calendarTypeSeed');

const migration = fs.readFileSync(gen.MIGRATION_PATH, 'utf8');
const e0b       = fs.readFileSync(gen.E0B_PATH, 'utf8');
const e0a       = fs.readFileSync(gen.E0B_PATH.replace('2026-09-01_unified_events_e0b', '2026-08-27_unified_events_e0a'), 'utf8');

describe('generated blocks are byte-identical to the committed migration', () => {
  test('seed block', () => {
    const committed = gen.extractBlock(migration, 'seed');
    expect(committed).not.toBeNull();
    expect(committed).toBe(gen.generateSeedSql());
  });

  test('backfill block', () => {
    const committed = gen.extractBlock(migration, 'backfill');
    expect(committed).not.toBeNull();
    expect(committed).toBe(gen.generateBackfillSql());
  });

  test('seed fixture JSON', () => {
    const committed = fs.readFileSync(gen.FIXTURE_PATH, 'utf8');
    expect(committed).toBe(JSON.stringify(seedRows(), null, 2) + '\n');
  });
});

describe('backfill content', () => {
  const backfill = gen.generateBackfillSql();

  test('the five E0b kind statements appear VERBATIM in the E0b file', () => {
    expect(gen.E0B_KIND_STATEMENTS).toHaveLength(5);
    for (const s of gen.E0B_KIND_STATEMENTS) {
      expect(e0b.includes(s)).toBe(true);
      expect(backfill.includes(s)).toBe(true);
    }
  });

  test('every bulk UPDATE is guarded by type_key IS NULL; overrides are guarded by id + raw type', () => {
    const stmts = backfill.split('\n').filter((l) => /^UPDATE (events|appts) SET type_key/.test(l));
    expect(stmts.length).toBeGreaterThan(30);
    for (const s of stmts) {
      if (/WHERE event_id = \d+/.test(s)) {
        expect(s).toMatch(/AND event_type = '[^']+';$/);
      } else {
        expect(s).toMatch(/WHERE type_key IS NULL AND (event_type|appt_type) (= '|IN \()/);
      }
    }
  });

  test('the four row overrides are emitted, in id order, with E1 keys', () => {
    expect(backfill).toMatch(/UPDATE events SET type_key = 'test' WHERE event_id = 4 AND event_type = 'Milestone';/);
    expect(backfill).toMatch(/UPDATE events SET type_key = 'test' WHERE event_id = 6 AND event_type = 'Deadline';/);
    expect(backfill).toMatch(/UPDATE events SET type_key = 'filing_fee_deadline' WHERE event_id = 107 AND event_type = 'Order';/);
    expect(backfill).toMatch(/UPDATE events SET type_key = 'trial' WHERE event_id = 134 AND event_type = 'Trial \/ Pre-Trial Hearing';/);
    const ids = [...backfill.matchAll(/WHERE event_id = (\d+)/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([4, 6, 107, 134]);
  });

  test("the literal 'none' appt entry is not backfilled; NULL appt_type rows are never touched", () => {
    const stmts = backfill.split('\n').filter((l) => /^UPDATE/.test(l));
    expect(stmts.some((l) => /'none'/.test(l))).toBe(false);
    expect(stmts.some((l) => /appt_type IS NULL/.test(l))).toBe(false);
  });

  test('raws are lowercase (E1 normalized keys) — the general_ci contract', () => {
    for (const m of backfill.matchAll(/WHERE type_key IS NULL AND (?:event_type|appt_type) (?:= |IN \()([^;]+)/g)) {
      const raws = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      for (const r of raws) expect(r).toBe(r.toLowerCase());
    }
  });
});

describe('migration lint (house rules)', () => {
  test('no session variables, no stored procedures, no cross-statement state', () => {
    // comments may DESCRIBE the rule; statements must not break it
    const code = migration.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    expect(code).not.toMatch(/^\s*SET\s+@/m);
    expect(code).not.toMatch(/LAST_INSERT_ID/);
    expect(code).not.toMatch(/CREATE PROCEDURE/i);
    expect(code).not.toMatch(/DELIMITER/);
  });

  test('registry table + new columns spell out CHARSET and COLLATE (general_ci)', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS calendar_item_types/);
    expect(migration).toMatch(/\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;/);
    const typeKeyCols = migration.match(/ADD COLUMN type_key VARCHAR\(40\) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL/g) || [];
    expect(typeKeyCols).toHaveLength(2);
    expect(migration).toMatch(/type_key\s+VARCHAR\(40\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL/);
    expect(migration).toMatch(/label\s+VARCHAR\(80\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL/);
  });

  test('registry kind ENUM is byte-identical to events.kind as E0a created it (D1)', () => {
    const e0aEnum = /ADD COLUMN kind (ENUM\('[^)]*'\))/.exec(e0a)[1];
    expect(e0aEnum).toBe("ENUM('hearing','meeting','deadline','conference','other')");
    expect(migration).toMatch(new RegExp(`kind\\s+${e0aEnum.replace(/[()]/g, '\\$&')} NOT NULL`));
  });

  test('indexes on both type_key columns; no FK', () => {
    expect(migration).toMatch(/ADD KEY idx_events_type_key \(type_key\)/);
    expect(migration).toMatch(/ADD KEY idx_appts_type_key \(type_key\)/);
    expect(migration).not.toMatch(/FOREIGN KEY/i);
  });

  test('seed: 34 rows, one statement, row-alias ODKU touching label only', () => {
    expect(SEED).toHaveLength(34);
    const seedSql = gen.generateSeedSql();
    expect((seedSql.match(/^INSERT INTO/gm) || []).length).toBe(1);
    expect(seedSql).toMatch(/AS new\nON DUPLICATE KEY UPDATE label = new\.label;/);
    expect(seedSql).not.toMatch(/VALUES\(label\)/);   // deprecated form
  });

  test('the file orders A.1 → seed → A.3 → backfill → VERIFY', () => {
    const i = (re) => migration.search(re);
    expect(i(/CREATE TABLE IF NOT EXISTS calendar_item_types/)).toBeLessThan(i(/BEGIN GENERATED seed/));
    expect(i(/BEGIN GENERATED seed/)).toBeLessThan(i(/ALTER TABLE events\s+ADD COLUMN type_key/));
    expect(i(/ALTER TABLE appts\s+ADD KEY idx_appts_type_key/)).toBeLessThan(i(/BEGIN GENERATED backfill/));
    expect(i(/END GENERATED backfill/)).toBeLessThan(i(/-- 1\. BLOCKING/));
  });
});
