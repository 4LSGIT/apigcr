// scripts/test_availability.js
//
// Offline tests for services/availabilityService.js — pure core only,
// zero DB dependency. Run: node scripts/test_availability.js
// Exits nonzero on any failure.
//
// All synthetic data is firm-local (America/Detroit unless a case says
// otherwise). Row shapes match exactly what getSlots' SQL returns, so
// these tests exercise the same normalization path production uses.

process.env.FIRM_TIMEZONE = process.env.FIRM_TIMEZONE || 'America/Detroit';

const {
  unionIntervals,
  subtractIntervals,
  intersectIntervals,
  walkSlots,
  computeProviderDaySlots,
  normalizeBusyForProvider,
  localStrToMs,
} = require('../services/availabilityService');

const ZONE = process.env.FIRM_TIMEZONE;

// ── tiny harness ─────────────────────────────────────────────
let failures = 0;
let current = '';
function caseStart(name) { current = name; }
function check(label, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`  ✗ [${current}] ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
}
function caseEnd() { console.log(`  ✓ ${current}`); }

function ms(s) { return localStrToMs(s, ZONE); }

// Standard 9–23 working week (matches live user_availability shape)
const FULL_WEEK = [0, 1, 2, 3, 4, 5, 6].map(w => ({
  weekday: w, start_time: '09:00:00', end_time: '23:00:00',
  valid_from: null, valid_to: null, active: 1,
}));

function daySlots(dayStr, busy, { lengthMin = 30, granularityMin = 15,
                                  earliestStartMs = -Infinity,
                                  workingRows = FULL_WEEK, restrictRows = null } = {}) {
  return computeProviderDaySlots({
    dayStr, workingRows, busy, lengthMin, granularityMin, earliestStartMs, zone: ZONE,
    restrictRows,
  });
}

// Monday-only 08:00–17:00 working set for restriction cases (2026-06-15 = Mon).
const MON_8_17 = [{ weekday: 1, start_time: '08:00:00', end_time: '17:00:00',
                    valid_from: null, valid_to: null }];

// ═════════════════════════════════════════════════════════════
// Case 1 — plain day: 9–23, no busy, 30-min length, 15-min grid
// ═════════════════════════════════════════════════════════════
caseStart('1. plain day — full grid 09:00..22:30');
{
  const slots = daySlots('2026-06-15', []); // Monday
  check('count = 55', slots.length === 55, `got ${slots.length}`);
  check('first = 09:00', slots[0] === '2026-06-15 09:00', slots[0]);
  check('last = 22:30 (ends 23:00)', slots[slots.length - 1] === '2026-06-15 22:30', slots[slots.length - 1]);
  check('no 22:45', !slots.includes('2026-06-15 22:45'));
  // every 15 min, ascending
  const expected = [];
  for (let m = 9 * 60; m + 30 <= 23 * 60; m += 15) {
    expected.push(`2026-06-15 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  check('exact grid match', JSON.stringify(slots) === JSON.stringify(expected));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 2 — appt subtraction with buffer; padding-only semantics
// ═════════════════════════════════════════════════════════════
caseStart('2. appt 10:00×60 buffer 15 — busy 09:45–11:15, slot may END at 09:45');
{
  const busy = normalizeBusyForProvider(1, {
    appts: [{ appt_with: 1, appt_date: '2026-06-15 10:00:00', appt_length: 60, appt_status: 'Scheduled' }],
    bufferMin: 15, zone: ZONE,
  });
  check('busy = [09:45, 11:15)', busy.length === 1
    && busy[0].start === ms('2026-06-15 09:45:00')
    && busy[0].end === ms('2026-06-15 11:15:00'));

  const slots = daySlots('2026-06-15', busy); // 30-min length
  check('09:15 present (ends exactly at 09:45 pad edge)', slots.includes('2026-06-15 09:15'));
  check('09:30 absent', !slots.includes('2026-06-15 09:30'));
  check('10:45 absent', !slots.includes('2026-06-15 10:45'));
  check('11:00 absent', !slots.includes('2026-06-15 11:00'));
  check('11:15 present (starts exactly at pad end)', slots.includes('2026-06-15 11:15'));
  // padding-only: NOT double-counted — if buffer were also in the fit test,
  // 09:15 (09:15+30+15=10:00 > 09:45) would be excluded.
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 3 — event_with = provider blocks that provider only
// ═════════════════════════════════════════════════════════════
caseStart('3. event_with=1 blocks provider 1 only');
{
  const ev = [{ event_date: '2026-06-15', event_time: '13:00:00', event_all_day: 0,
                event_length: 60, event_status: 'Scheduled', event_with: 1 }];
  const busy1 = normalizeBusyForProvider(1, { events: ev, zone: ZONE });
  const busy2 = normalizeBusyForProvider(22, { events: ev, zone: ZONE });
  const s1 = daySlots('2026-06-15', busy1);
  const s2 = daySlots('2026-06-15', busy2);
  check('provider 1: 13:00 absent', !s1.includes('2026-06-15 13:00'));
  check('provider 1: 13:45 absent', !s1.includes('2026-06-15 13:45'));
  check('provider 1: 14:00 present', s1.includes('2026-06-15 14:00'));
  check('provider 22: 13:00 present', s2.includes('2026-06-15 13:00'));
  check('provider 22 unaffected (full 55)', s2.length === 55, s2.length);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 4 — event_with NULL blocks both providers
// ═════════════════════════════════════════════════════════════
caseStart('4. event_with=NULL blocks both providers');
{
  const ev = [{ event_date: '2026-06-15', event_time: '13:00:00', event_all_day: 0,
                event_length: 60, event_status: 'Scheduled', event_with: null }];
  for (const pid of [1, 22]) {
    const s = daySlots('2026-06-15', normalizeBusyForProvider(pid, { events: ev, zone: ZONE }));
    check(`provider ${pid}: 13:00 absent`, !s.includes('2026-06-15 13:00'));
    check(`provider ${pid}: 14:00 present`, s.includes('2026-06-15 14:00'));
  }
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 5 — Canceled event blocks nobody
// ═════════════════════════════════════════════════════════════
caseStart('5. Canceled event blocks nobody');
{
  const ev = [{ event_date: '2026-06-15', event_time: '13:00:00', event_all_day: 0,
                event_length: 60, event_status: 'Canceled', event_with: null }];
  const busy = normalizeBusyForProvider(1, { events: ev, zone: ZONE });
  check('busy empty', busy.length === 0, JSON.stringify(busy));
  const s = daySlots('2026-06-15', busy);
  check('full day (55 slots)', s.length === 55, s.length);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 6 — NULL event_length blocks exactly 60 minutes
// ═════════════════════════════════════════════════════════════
caseStart('6. NULL event_length → exactly 60 min blocked');
{
  const ev = [{ event_date: '2026-06-15', event_time: '13:00:00', event_all_day: 0,
                event_length: null, event_status: 'Scheduled', event_with: null }];
  const busy = normalizeBusyForProvider(1, { events: ev, zone: ZONE });
  check('busy = [13:00, 14:00)', busy.length === 1
    && busy[0].start === ms('2026-06-15 13:00:00')
    && busy[0].end === ms('2026-06-15 14:00:00'));
  const s = daySlots('2026-06-15', busy, { lengthMin: 15 });
  check('12:45 present (ends at 13:00)', s.includes('2026-06-15 12:45'));
  check('13:00..13:45 absent', ['13:00', '13:15', '13:30', '13:45']
    .every(t => !s.includes(`2026-06-15 ${t}`)));
  check('14:00 present', s.includes('2026-06-15 14:00'));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 7 — firm_block Friday-night shape truncates Friday
// ═════════════════════════════════════════════════════════════
caseStart('7. firm_block Fri 20:30 → Sat 22:23 truncates Friday; Sat tail only');
{
  const fb = [{ block_start: '2026-06-12 20:30:00', block_end: '2026-06-13 22:23:00' }];
  const busy = normalizeBusyForProvider(1, { firmBlocks: fb, zone: ZONE });

  const fri = daySlots('2026-06-12', busy); // 30-min length
  check('Fri last slot = 20:00 (ends exactly at block_start)',
    fri[fri.length - 1] === '2026-06-12 20:00', fri[fri.length - 1]);
  check('Fri 20:15 absent', !fri.includes('2026-06-12 20:15'));

  const sat = daySlots('2026-06-13', busy);
  check('Sat = exactly [22:30]', JSON.stringify(sat) === JSON.stringify(['2026-06-13 22:30']),
    JSON.stringify(sat));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 8 — split windows: gap not spanned; overlapping rows union
// ═════════════════════════════════════════════════════════════
caseStart('8. split 9–12 + 14–17 (no spanning); overlap 9–13 + 12–17 ⇒ 9–17');
{
  const mon = '2026-06-15';
  const splitRows = [
    { weekday: 1, start_time: '09:00:00', end_time: '12:00:00', valid_from: null, valid_to: null },
    { weekday: 1, start_time: '14:00:00', end_time: '17:00:00', valid_from: null, valid_to: null },
  ];
  const s = daySlots(mon, [], { workingRows: splitRows, lengthMin: 60, granularityMin: 30 });
  check('11:00 present (ends 12:00)', s.includes(`${mon} 11:00`));
  check('11:30 absent (would span gap)', !s.includes(`${mon} 11:30`));
  check('nothing in 11:30..13:30', ['11:30', '12:00', '12:30', '13:00', '13:30']
    .every(t => !s.includes(`${mon} ${t}`)));
  check('14:00 present', s.includes(`${mon} 14:00`));
  check('16:00 last', s[s.length - 1] === `${mon} 16:00`, s[s.length - 1]);

  const overlapRows = [
    { weekday: 1, start_time: '09:00:00', end_time: '13:00:00', valid_from: null, valid_to: null },
    { weekday: 1, start_time: '12:00:00', end_time: '17:00:00', valid_from: null, valid_to: null },
  ];
  const o = daySlots(mon, [], { workingRows: overlapRows, lengthMin: 60, granularityMin: 30 });
  const cont = daySlots(mon, [], {
    workingRows: [{ weekday: 1, start_time: '09:00:00', end_time: '17:00:00', valid_from: null, valid_to: null }],
    lengthMin: 60, granularityMin: 30,
  });
  check('overlapping rows ≡ continuous 9–17', JSON.stringify(o) === JSON.stringify(cont));
  check('12:30 present (no false seam at 12/13)', o.includes(`${mon} 12:30`));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 9 — valid_from / valid_to exclude out-of-window dates
// ═════════════════════════════════════════════════════════════
caseStart('9. valid_from/valid_to gating');
{
  const rows = [{ weekday: 1, start_time: '09:00:00', end_time: '17:00:00',
                  valid_from: '2026-06-15', valid_to: '2026-06-15' }];
  check('in-window Monday has slots',
    daySlots('2026-06-15', [], { workingRows: rows }).length > 0);
  check('next Monday (after valid_to) empty',
    daySlots('2026-06-22', [], { workingRows: rows }).length === 0);
  const rows2 = [{ weekday: 1, start_time: '09:00:00', end_time: '17:00:00',
                   valid_from: '2026-06-22', valid_to: null }];
  check('Monday before valid_from empty',
    daySlots('2026-06-15', [], { workingRows: rows2 }).length === 0);
  check('open-ended valid_to allows future Monday',
    daySlots('2026-06-29', [], { workingRows: rows2 }).length > 0);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 10 — min_notice with injected now
// ═════════════════════════════════════════════════════════════
caseStart('10. min_notice 60 @ now=10:07 — earliest 11:07 → first slot 11:15, grid preserved');
{
  const earliest = ms('2026-06-15 10:07:00') + 60 * 60000; // 11:07
  const s = daySlots('2026-06-15', [], { earliestStartMs: earliest });
  check('first = 11:15', s[0] === '2026-06-15 11:15', s[0]);
  check('11:00 absent', !s.includes('2026-06-15 11:00'));
  check('alignment preserved (all :00/:15/:30/:45)',
    s.every(x => ['00', '15', '30', '45'].includes(x.slice(-2))));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 11 — clock-grid alignment after off-grid window start
// ═════════════════════════════════════════════════════════════
caseStart('11. block ends 10:23 → first slot 10:30 (clock grid, not window-offset)');
{
  const busy = normalizeBusyForProvider(1, {
    abBlocks: [{ user: 1, block_start: '2026-06-15 09:00:00', block_end: '2026-06-15 10:23:00' }],
    zone: ZONE,
  });
  const s = daySlots('2026-06-15', busy);
  check('first = 10:30', s[0] === '2026-06-15 10:30', s[0]);
  check('no 10:23 / 10:38 window-offset artifacts',
    !s.some(x => x.endsWith(':23') || x.endsWith(':38')));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 12 — DST spring-forward day (America/Detroit 2027-03-14)
// ═════════════════════════════════════════════════════════════
caseStart('12. DST 2027-03-14 — sane slots, no crash, no 02:xx artifacts');
{
  // Window deliberately spans the 02:00→03:00 jump.
  const rows = [{ weekday: 0, start_time: '00:00:00', end_time: '06:00:00',
                  valid_from: null, valid_to: null }]; // 2027-03-14 is a Sunday
  const s = daySlots('2027-03-14', [], { workingRows: rows, lengthMin: 30, granularityMin: 30 });
  check('no 02:xx starts', !s.some(x => x.includes(' 02:')), JSON.stringify(s));
  check('01:30 present', s.includes('2027-03-14 01:30'));
  check('03:00 present (01:30+30real = 03:00 wall? no — grid step lands 03:00)',
    s.includes('2027-03-14 03:00'));
  check('last = 05:30', s[s.length - 1] === '2027-03-14 05:30', s[s.length - 1]);
  // 00:00,00:30,01:00,01:30 then 03:00..05:30 → 4 + 6 = 10
  check('count = 10 (23-hour day, 02:xx skipped)', s.length === 10, s.length);
  check('strictly ascending', s.every((x, i) => i === 0 || x > s[i - 1]));

  // Normal day with the regular 9–23 week still sane on DST date
  const full = daySlots('2027-03-14', []);
  check('9–23 DST day = normal 55 slots', full.length === 55, full.length);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Supplementary — interval-math edge sanity (cheap insurance)
// ═════════════════════════════════════════════════════════════
caseStart('S. interval math edges');
{
  check('union merges adjacency', JSON.stringify(unionIntervals([
    { start: 0, end: 10 }, { start: 10, end: 20 },
  ])) === JSON.stringify([{ start: 0, end: 20 }]));
  check('union drops empty/inverted', unionIntervals([
    { start: 5, end: 5 }, { start: 9, end: 3 },
  ]).length === 0);
  check('subtract: touching busy removes nothing', JSON.stringify(subtractIntervals(
    [{ start: 0, end: 10 }], [{ start: 10, end: 20 }],
  )) === JSON.stringify([{ start: 0, end: 10 }]));
  check('subtract: busy splits window', JSON.stringify(subtractIntervals(
    [{ start: 0, end: 100 }], [{ start: 40, end: 60 }],
  )) === JSON.stringify([{ start: 0, end: 40 }, { start: 60, end: 100 }]));
  check('subtract: full cover empties', subtractIntervals(
    [{ start: 10, end: 20 }], [{ start: 0, end: 30 }],
  ).length === 0);
  check('walkSlots empty windows → []', walkSlots([], { lengthMin: 30, granularityMin: 15, zone: ZONE }).length === 0);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 13 — intersectIntervals edges (Slice A pure helper)
// ═════════════════════════════════════════════════════════════
caseStart('13. intersectIntervals — disjoint/overlap/containment/touch/multi');
{
  const I = intersectIntervals;
  check('disjoint → []',
    JSON.stringify(I([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])) === '[]');
  check('partial overlap → [5,10)',
    JSON.stringify(I([{ start: 0, end: 10 }], [{ start: 5, end: 15 }]))
      === JSON.stringify([{ start: 5, end: 10 }]));
  check('containment → [40,60)',
    JSON.stringify(I([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]))
      === JSON.stringify([{ start: 40, end: 60 }]));
  check('adjacent touch → [] (half-open)',
    JSON.stringify(I([{ start: 0, end: 10 }], [{ start: 10, end: 20 }])) === '[]');
  check('multi → [5,10)+[20,25)',
    JSON.stringify(I([{ start: 0, end: 10 }, { start: 20, end: 30 }], [{ start: 5, end: 25 }]))
      === JSON.stringify([{ start: 5, end: 10 }, { start: 20, end: 25 }]));
  check('empty operand → []',
    JSON.stringify(I([], [{ start: 0, end: 10 }])) === '[]');
  check('commutative on a sample',
    JSON.stringify(I([{ start: 0, end: 10 }], [{ start: 5, end: 15 }]))
      === JSON.stringify(I([{ start: 5, end: 15 }], [{ start: 0, end: 10 }])));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 14 — restrictRows: weekday not offered by the view → []
// ═════════════════════════════════════════════════════════════
caseStart('14. restrictRows: weekday not offered → [] (Mon working, restrict Thu only)');
{
  const s = daySlots('2026-06-15', [], { workingRows: MON_8_17, restrictRows: [{ weekday: 4 }] });
  check('empty', s.length === 0, JSON.stringify(s));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 15 — restrictRows: window narrowing (the core feature)
// ═════════════════════════════════════════════════════════════
caseStart('15. restrictRows 14:00–16:00 narrows 08–17, 60-min → 14:00..15:00 (5 slots)');
{
  const s = daySlots('2026-06-15', [], {
    workingRows: MON_8_17,
    restrictRows: [{ weekday: 1, start: '14:00', end: '16:00' }],
    lengthMin: 60, granularityMin: 15,
  });
  check('exactly [14:00,14:15,14:30,14:45,15:00]',
    JSON.stringify(s) === JSON.stringify([
      '2026-06-15 14:00', '2026-06-15 14:15', '2026-06-15 14:30',
      '2026-06-15 14:45', '2026-06-15 15:00',
    ]), JSON.stringify(s));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 16 — restrictRows: all-day entry ≡ unrestricted for that weekday
// ═════════════════════════════════════════════════════════════
caseStart('16. restrictRows: all-day entry ≡ unrestricted output for that weekday');
{
  const allDay = daySlots('2026-06-15', [], {
    workingRows: MON_8_17, restrictRows: [{ weekday: 1 }],
    lengthMin: 60, granularityMin: 30,
  });
  const plain = daySlots('2026-06-15', [], {
    workingRows: MON_8_17, lengthMin: 60, granularityMin: 30,
  });
  check('identical output', JSON.stringify(allDay) === JSON.stringify(plain),
    `allDay=${allDay.length} plain=${plain.length}`);
  check('nonempty (sanity)', allDay.length > 0, allDay.length);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 17 — restrictRows: restriction straddling the working edge
// ═════════════════════════════════════════════════════════════
caseStart('17. restrictRows 16:00–19:00 vs working →17:00, 60-min → last start 16:00');
{
  const s = daySlots('2026-06-15', [], {
    workingRows: MON_8_17,
    restrictRows: [{ weekday: 1, start: '16:00', end: '19:00' }],
    lengthMin: 60, granularityMin: 15,
  });
  check('exactly [16:00]', JSON.stringify(s) === JSON.stringify(['2026-06-15 16:00']),
    JSON.stringify(s));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 18 — restrictRows: null → byte-identical to unrestricted
// ═════════════════════════════════════════════════════════════
caseStart('18. restrictRows: null → byte-identical to unrestricted (with a busy appt)');
{
  const busy = normalizeBusyForProvider(1, {
    appts: [{ appt_with: 1, appt_date: '2026-06-15 10:00:00', appt_length: 60, appt_status: 'Scheduled' }],
    bufferMin: 15, zone: ZONE,
  });
  const withNull = daySlots('2026-06-15', busy, { restrictRows: null });
  const plain    = daySlots('2026-06-15', busy);
  check('identical', JSON.stringify(withNull) === JSON.stringify(plain));
  check('same length', withNull.length === plain.length, `${withNull.length} vs ${plain.length}`);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 19 — restrictRows: adjacent same-weekday entries union
// ═════════════════════════════════════════════════════════════
caseStart('19. restrictRows: adjacent 14–15 + 15–16 ≡ single 14–16');
{
  const two = daySlots('2026-06-15', [], {
    workingRows: MON_8_17,
    restrictRows: [
      { weekday: 1, start: '14:00', end: '15:00' },
      { weekday: 1, start: '15:00', end: '16:00' },
    ],
    lengthMin: 60, granularityMin: 15,
  });
  const one = daySlots('2026-06-15', [], {
    workingRows: MON_8_17,
    restrictRows: [{ weekday: 1, start: '14:00', end: '16:00' }],
    lengthMin: 60, granularityMin: 15,
  });
  check('adjacent entries ≡ merged window', JSON.stringify(two) === JSON.stringify(one),
    `two=${JSON.stringify(two)} one=${JSON.stringify(one)}`);
  check('= 5 slots (14:00..15:00)', two.length === 5, two.length);
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 20 — restrict entry with valid_from/valid_to (Slice C)
// ═════════════════════════════════════════════════════════════
caseStart('20. restrict window valid 06-15..06-22 — before → [], within → narrowed, after → []');
{
  const restrict = [{ weekday: 1, start: '10:00', end: '12:00',
                      valid_from: '2026-06-15', valid_to: '2026-06-22' }];
  const opts = { lengthMin: 30, granularityMin: 30 };

  // Monday before valid_from → closed (fail-closed: no valid entry = closed).
  const before = computeProviderDaySlots({
    dayStr: '2026-06-08', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: restrict, ...opts,
  });
  check('Mon 06-08 (before range) empty', before.length === 0, JSON.stringify(before));

  // Mondays within range → narrowed to 10:00–12:00.
  for (const day of ['2026-06-15', '2026-06-22']) {
    const s = computeProviderDaySlots({
      dayStr: day, workingRows: FULL_WEEK, busy: [], zone: ZONE,
      restrictRows: restrict, ...opts,
    });
    check(`Mon ${day} = [10:00, 10:30, 11:00, 11:30]`,
      JSON.stringify(s) === JSON.stringify([`${day} 10:00`, `${day} 10:30`, `${day} 11:00`, `${day} 11:30`]),
      JSON.stringify(s));
  }

  // Monday after valid_to → closed.
  const after = computeProviderDaySlots({
    dayStr: '2026-06-29', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: restrict, ...opts,
  });
  check('Mon 06-29 (after range) empty', after.length === 0, JSON.stringify(after));

  // Independent bounds: valid_from only → open-ended future.
  const fromOnly = [{ weekday: 1, start: '10:00', end: '12:00', valid_from: '2026-06-22' }];
  const fo1 = computeProviderDaySlots({
    dayStr: '2026-06-15', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: fromOnly, ...opts,
  });
  const fo2 = computeProviderDaySlots({
    dayStr: '2026-07-06', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: fromOnly, ...opts,
  });
  check('valid_from-only: earlier Monday empty', fo1.length === 0);
  check('valid_from-only: later Monday has slots', fo2.length === 4, JSON.stringify(fo2));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 21 — two entries same weekday: expired + current → only current
// ═════════════════════════════════════════════════════════════
caseStart('21. same weekday, one expired one current — only current window applies');
{
  const restrict = [
    { weekday: 1, start: '09:00', end: '11:00', valid_to: '2026-06-08' },   // expired by 06-15
    { weekday: 1, start: '14:00', end: '16:00', valid_from: '2026-06-15' }, // current
  ];
  const s = computeProviderDaySlots({
    dayStr: '2026-06-15', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: restrict, lengthMin: 60, granularityMin: 60,
  });
  check('morning window (expired) closed', !s.some(x => x < '2026-06-15 14:00'), JSON.stringify(s));
  check('afternoon = [14:00, 15:00]',
    JSON.stringify(s) === JSON.stringify(['2026-06-15 14:00', '2026-06-15 15:00']),
    JSON.stringify(s));

  // On a date where BOTH were valid (06-08), both windows apply.
  const both = computeProviderDaySlots({
    dayStr: '2026-06-08', workingRows: FULL_WEEK, busy: [], zone: ZONE,
    restrictRows: [
      { weekday: 1, start: '09:00', end: '11:00', valid_to: '2026-06-08' },
      { weekday: 1, start: '14:00', end: '16:00' },
    ],
    lengthMin: 60, granularityMin: 60,
  });
  check('overlap date: both windows open',
    JSON.stringify(both) === JSON.stringify(
      ['2026-06-08 09:00', '2026-06-08 10:00', '2026-06-08 14:00', '2026-06-08 15:00']),
    JSON.stringify(both));
}
caseEnd();

// ═════════════════════════════════════════════════════════════
// Case 22 — entries WITHOUT validity keys ≡ Slice A behavior (regression)
// ═════════════════════════════════════════════════════════════
caseStart('22. no validity keys — identical to Slice A restriction semantics');
{
  const restrict = [
    { weekday: 1, start: '10:00', end: '12:00' }, // timed Monday
    { weekday: 3 },                               // all-day Wednesday
  ];
  const opts = { workingRows: FULL_WEEK, busy: [], zone: ZONE, lengthMin: 30, granularityMin: 30 };

  // Timed entry narrows Monday.
  const mon = computeProviderDaySlots({ dayStr: '2026-06-15', restrictRows: restrict, ...opts });
  check('Mon narrowed to 10:00–12:00',
    JSON.stringify(mon) === JSON.stringify(
      ['2026-06-15 10:00', '2026-06-15 10:30', '2026-06-15 11:00', '2026-06-15 11:30']),
    JSON.stringify(mon));

  // All-day entry leaves Wednesday's full working day.
  const wedRestricted = computeProviderDaySlots({ dayStr: '2026-06-17', restrictRows: restrict, ...opts });
  const wedFree       = computeProviderDaySlots({ dayStr: '2026-06-17', restrictRows: null, ...opts });
  check('all-day Wed ≡ unrestricted Wed', JSON.stringify(wedRestricted) === JSON.stringify(wedFree));

  // Unlisted weekday closed.
  const tue = computeProviderDaySlots({ dayStr: '2026-06-16', restrictRows: restrict, ...opts });
  check('unlisted Tue closed', tue.length === 0, JSON.stringify(tue));

  // restrictRows null → untouched.
  const nullR = computeProviderDaySlots({ dayStr: '2026-06-15', restrictRows: null, ...opts });
  check('null restriction leaves full day', nullR.length > 4);
}
caseEnd();

// ─────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll cases passed.');