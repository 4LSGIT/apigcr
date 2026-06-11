// services/firmBlocksService.js
//
/**
 * Firm Blocks Service — Scheduler Slice 2
 *
 * Materializes Shabbos / Yom Tov "closed" intervals from Hebcal into the
 * firm_blocks table, maintaining a rolling horizon (default 12 months).
 * Later scheduler slices READ this table; this module only writes it.
 *
 * Driven by the `generate_firm_blocks` internal function on a daily
 * recurring scheduled job. Idempotent: re-running over the same window
 * upserts the same rows (dedupe key = (source, generated_for) — the
 * UNIQUE KEY uq_fb_source_for on firm_blocks).
 *
 * Block construction:
 *   - Hebcal is queried with c=on (candle lighting) for zip 48075, with
 *     b=<shabbos_lead_min> minutes before sunset for candle lighting and
 *     m=<shabbos_end_min> minutes after sunset for havdalah.
 *   - Items are paired chronologically: a `candles` item OPENS a block
 *     (a `candles` item while a block is already open is mid-yontif
 *     candle-lighting — ignored); the next `havdalah` item CLOSES it.
 *     This naturally yields single blocks for 2-day Yom Tov and for
 *     3-day Shabbos-adjacent spans.
 *   - A block whose civil-date span includes any Yom Tov-restricted date
 *     (same list + matching rules as calendarService.YOM_TOV_HOLIDAYS)
 *     gets source='yom_tov'; otherwise source='shabbos'.
 *
 * Timezone: Hebcal returns zoned ISO timestamps. firm_blocks stores
 * firm-local naive DATETIMEs (matches appts.appt_date convention), so
 * timestamps are converted to FIRM_TZ wall time before writing.
 *
 * Failure posture: a Hebcal fetch failure THROWS (the scheduled-job
 * system owns retry/visibility) — this deliberately differs from
 * calendarService.fetchHebcalEvents' fail-open behavior, because here a
 * silent empty result would mean missing closed intervals, i.e. the
 * availability engine would offer slots during Shabbos. Existing rows are
 * never deleted; manual rows (source='manual', generated_for NULL) are
 * never touched.
 *
 * Exports:
 *   generateFirmBlocks(db, { horizonMonths = 12 })
 *     → { blocksUpserted, shabbosBlocks, yomTovBlocks, windowStart, windowEnd }
 *
 * Internal helpers (exported for testing):
 *   fetchHebcalCandleEvents, pairCandleHavdalah, buildYomTovDateMap,
 *   shapeBlock
 */

const { DateTime } = require('luxon');
const { getSettings } = require('./settingsService');
const { FIRM_TZ } = require('./timezoneService');
const { YOM_TOV_HOLIDAYS } = require('./calendarService');

const HEBCAL_ZIP        = '48075';
const HEBCAL_TIMEOUT_MS = 10000; // larger windows than calendarService's 5s
const CHUNK_DAYS        = 180;   // Hebcal may cap very long ranges — chunk ≤6 months
const MAX_BLOCK_HOURS   = 5 * 24; // sanity cap; longest legit span (3-day) ≈ 74h

// ─────────────────────────────────────────────────────────────
// Hebcal fetch (chunked, throwing)
// ─────────────────────────────────────────────────────────────

async function _fetchChunk(startStr, endStr, leadMin, endMin) {
  const url =
    `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on` +
    `&c=on&zip=${HEBCAL_ZIP}&b=${leadMin}&m=${endMin}` +
    `&start=${startStr}&end=${endStr}`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), HEBCAL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new Error(`Hebcal fetch failed for ${startStr}..${endStr}: ${err.message}`);
  } finally {
    clearTimeout(tid);
  }

  if (!response.ok) {
    throw new Error(`Hebcal API returned ${response.status} for ${startStr}..${endStr}`);
  }

  const data = await response.json();
  return data.items || [];
}

/**
 * Fetch candle/havdalah/holiday items for [windowStart, windowEnd]
 * (luxon DateTimes in FIRM_TZ), chunked into ≤CHUNK_DAYS requests and
 * merged with dedupe. Throws on any chunk failure.
 *
 * @returns {object[]} Hebcal items, sorted by date ascending
 */
async function fetchHebcalCandleEvents(windowStart, windowEnd, leadMin, endMin) {
  const all = [];
  let cursor = windowStart;
  while (cursor <= windowEnd) {
    const chunkEnd = DateTime.min(cursor.plus({ days: CHUNK_DAYS }), windowEnd);
    const items = await _fetchChunk(
      cursor.toFormat('yyyy-LL-dd'),
      chunkEnd.toFormat('yyyy-LL-dd'),
      leadMin, endMin
    );
    all.push(...items);
    cursor = chunkEnd.plus({ days: 1 });
  }

  // Dedupe (defensive — chunks are contiguous, but a boundary-day item
  // could appear in both if Hebcal treats ranges inclusively).
  const seen = new Set();
  const merged = [];
  for (const it of all) {
    const k = `${it.category}|${it.date}|${it.title || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }

  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return merged;
}

// ─────────────────────────────────────────────────────────────
// Yom Tov classification
// ─────────────────────────────────────────────────────────────

/**
 * Same matching rules as calendarService.buildRestrictedSet: holiday-category
 * items, excluding 'Erev *', where the title is in YOM_TOV_HOLIDAYS (Rosh
 * Hashana matched by substring to catch "Rosh Hashana 5787" / "Rosh Hashana II").
 *
 * @param {object[]} items — merged Hebcal items
 * @returns {Map<string,string>} 'yyyy-LL-dd' → holiday title
 */
function buildYomTovDateMap(items) {
  const map = new Map();
  for (const ev of items) {
    if (ev.category !== 'holiday') continue;
    if (!ev.title || ev.title.startsWith('Erev')) continue;
    const isYomTov = YOM_TOV_HOLIDAYS.some(h =>
      h === 'Rosh Hashana'
        ? ev.title.includes('Rosh Hashana')
        : ev.title === h
    );
    if (!isYomTov) continue;
    const dateStr = String(ev.date).slice(0, 10);
    if (!map.has(dateStr)) map.set(dateStr, ev.title);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// Pairing
// ─────────────────────────────────────────────────────────────

/**
 * Pair candles/havdalah items chronologically into raw blocks.
 *   - `candles` with no open block → opens one.
 *   - `candles` while a block is open → mid-yontif candle-lighting, ignored.
 *   - `havdalah` with an open block → closes it.
 *   - `havdalah` with no open block → window started mid-block (e.g. the
 *     generator ran on Shabbos); that block was materialized by a prior
 *     run — ignored.
 *   - A trailing open block (window ended mid-span) is dropped; tomorrow's
 *     rolling window completes it.
 *
 * @param {object[]} items — sorted Hebcal items
 * @returns {{startISO:string, endISO:string}[]}
 */
function pairCandleHavdalah(items) {
  const blocks = [];
  let open = null;
  for (const it of items) {
    if (it.category === 'candles') {
      if (!open) open = { startISO: it.date };
      // else: mid-yontif candle lighting — block already open, skip
    } else if (it.category === 'havdalah') {
      if (open) {
        blocks.push({ startISO: open.startISO, endISO: it.date });
        open = null;
      }
      // else: leading havdalah from a block that started before the window
    }
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// Shaping (classification, label, local conversion)
// ─────────────────────────────────────────────────────────────

/**
 * Convert one raw block into a firm_blocks row shape, or null if the block
 * fails sanity checks (logged).
 *
 * @param {{startISO:string, endISO:string}} raw
 * @param {Map<string,string>} ytDateMap — from buildYomTovDateMap
 * @returns {{block_start:string, block_end:string, label:string,
 *            source:'shabbos'|'yom_tov', generated_for:string}|null}
 */
function shapeBlock(raw, ytDateMap) {
  const start = DateTime.fromISO(raw.startISO, { setZone: true }).setZone(FIRM_TZ);
  const end   = DateTime.fromISO(raw.endISO,   { setZone: true }).setZone(FIRM_TZ);

  if (!start.isValid || !end.isValid) {
    console.error(`[firmBlocks] invalid timestamps: ${raw.startISO} / ${raw.endISO} — skipped`);
    return null;
  }
  const hours = end.diff(start, 'hours').hours;
  if (hours <= 0 || hours > MAX_BLOCK_HOURS) {
    console.error(`[firmBlocks] implausible block span ${hours.toFixed(1)}h ` +
                  `(${raw.startISO} → ${raw.endISO}) — skipped`);
    return null;
  }

  // Walk the civil-date span. The start date is erev (never itself the
  // restricted day that opened the block); the end date is the last
  // restricted day. Collect Yom Tov titles in order; note any Saturday
  // inside the restricted portion for combined labels.
  const ytTitles = [];
  let hasShabbos = false;
  for (let d = start.startOf('day'); d <= end.startOf('day'); d = d.plus({ days: 1 })) {
    const ds = d.toFormat('yyyy-LL-dd');
    const yt = ytDateMap.get(ds);
    if (yt) {
      if (!ytTitles.includes(yt)) ytTitles.push(yt);
    } else if (d.weekday === 6 && !d.hasSame(start, 'day')) {
      // Saturday in-span that is not itself Yom Tov (skip the erev start
      // date — a Saturday erev is impossible, belt-and-braces only)
      hasShabbos = true;
    }
  }

  const source = ytTitles.length ? 'yom_tov' : 'shabbos';
  let label;
  if (source === 'shabbos') {
    label = 'Shabbos';
  } else {
    label = (hasShabbos ? ['Shabbos', ...ytTitles] : ytTitles).join(', ');
    if (label.length > 120) label = label.slice(0, 119) + '…';
  }

  return {
    block_start: start.toFormat('yyyy-LL-dd HH:mm:ss'),
    block_end:   end.toFormat('yyyy-LL-dd HH:mm:ss'),
    label,
    source,
    generated_for: start.toFormat('yyyy-LL-dd'), // erev civil date — dedupe key with source
  };
}

// ─────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────

/**
 * Generate/refresh firm_blocks for [today, today + horizonMonths].
 *
 * Never deletes. Upserts on (source, generated_for) so sunset-time
 * refinements (or a changed shabbos_lead_min/shabbos_end_min setting)
 * update existing rows in place on the next run.
 *
 * @param {object} db — mysql2 pool
 * @param {object} [opts]
 * @param {number} [opts.horizonMonths=12]
 * @returns {Promise<{blocksUpserted:number, shabbosBlocks:number,
 *                    yomTovBlocks:number, windowStart:string, windowEnd:string}>}
 * @throws on Hebcal fetch failure or DB write failure
 */
async function generateFirmBlocks(db, { horizonMonths = 12 } = {}) {
  const months = Number(horizonMonths) > 0 ? Number(horizonMonths) : 12;

  // 1. Settings (defaults 40 / 72 if missing)
  const settings = await getSettings(db, ['shabbos_lead_min', 'shabbos_end_min']);
  const leadMin = parseInt(settings.shabbos_lead_min, 10) || 40;
  const endMin  = parseInt(settings.shabbos_end_min, 10)  || 72;

  // 2. Window in firm-local civil dates
  const windowStart = DateTime.now().setZone(FIRM_TZ).startOf('day');
  const windowEnd   = windowStart.plus({ months });

  // 3. Fetch + pair + classify
  const items    = await fetchHebcalCandleEvents(windowStart, windowEnd, leadMin, endMin);
  const ytDates  = buildYomTovDateMap(items);
  const rawPairs = pairCandleHavdalah(items);
  const blocks   = rawPairs.map(r => shapeBlock(r, ytDates)).filter(Boolean);

  // 4. Empty-result alarm: ≥1-month window with zero blocks is always wrong
  //    (every week has a Shabbos). Alert and return — do NOT throw, so the
  //    explicit alert is the single signal rather than a retry storm that
  //    also rides the error sweep.
  if (blocks.length === 0 && windowEnd.diff(windowStart, 'months').months >= 1) {
    const { alert } = require('../lib/alerting'); // deferred require (circular-dep safety convention)
    await alert(db, {
      source:    'app',
      kind:      'firm_blocks_generation_empty',
      group_key: 'app:firm_blocks_generation_empty',
      severity:  'error',
      title:     'firm_blocks generation produced ZERO blocks',
      message:   `Window ${windowStart.toFormat('yyyy-LL-dd')} → ${windowEnd.toFormat('yyyy-LL-dd')} ` +
                 `(${items.length} Hebcal items fetched). A ≥1-month window must contain Shabbos blocks — ` +
                 `check Hebcal response shape / candles+havdalah params.`,
    });
    return {
      blocksUpserted: 0, shabbosBlocks: 0, yomTovBlocks: 0,
      windowStart: windowStart.toFormat('yyyy-LL-dd'),
      windowEnd:   windowEnd.toFormat('yyyy-LL-dd'),
    };
  }

  // 5. Upsert. Never DELETE; manual rows (source='manual', generated_for
  //    NULL) are structurally unreachable by this statement.
  let shabbosBlocks = 0, yomTovBlocks = 0;
  for (const b of blocks) {
    await db.query(
      `INSERT INTO firm_blocks (block_start, block_end, label, source, generated_for)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         block_start = VALUES(block_start),
         block_end   = VALUES(block_end),
         label       = VALUES(label)`,
      [b.block_start, b.block_end, b.label, b.source, b.generated_for]
    );
    if (b.source === 'yom_tov') yomTovBlocks++; else shabbosBlocks++;
  }

  const result = {
    blocksUpserted: blocks.length,
    shabbosBlocks,
    yomTovBlocks,
    windowStart: windowStart.toFormat('yyyy-LL-dd'),
    windowEnd:   windowEnd.toFormat('yyyy-LL-dd'),
  };
  console.log(`[firmBlocks] upserted ${result.blocksUpserted} blocks ` +
              `(${shabbosBlocks} shabbos, ${yomTovBlocks} yom_tov) for ` +
              `${result.windowStart} → ${result.windowEnd}`);
  return result;
}

module.exports = {
  generateFirmBlocks,
  // exported for testing
  fetchHebcalCandleEvents,
  pairCandleHavdalah,
  buildYomTovDateMap,
  shapeBlock,
};