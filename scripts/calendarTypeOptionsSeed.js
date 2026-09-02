// scripts/calendarTypeOptionsSeed.js
//
/**
 * calendar_type_options — the U2b SEED, as data (Unified Events U2b).
 *
 * This is the same row set ref/2026-09-02_unified_events_u2b.sql inserts. It
 * is NOT a runtime source — the table is — and it is deliberately NOT merged
 * into scripts/calendarTypeSeed.js, whose column list is the INSERT column
 * order scripts/genTypeKeyBackfill.js emits for calendar_item_types.
 *
 * Consumed by tests/unifiedEventsU2b.options.test.js, which asserts
 *   (a) the migration seeds exactly these rows,
 *   (b) resolving them for surface=new_client / follow_up reproduces the two
 *       <option> lists that were hardcoded in public/scripts.js before U2b
 *       (DIALOG_LISTS_2026_09_02), plus the "seed all" ruling additions.
 *
 * Ruling (Fred, 2026-09-02): every active meeting type gets an option except
 * meeting_341 (court is source of truth; singleton; never hand-booked from a
 * dialog). `meeting` (generic) is follow_up only; the rest go on both.
 *
 * File order == the migration's INSERT order == AUTO_INCREMENT id order.
 */

'use strict';

/** Closed vocabulary. Mirror of services/calendarTypeService.SURFACES. */
const SURFACES = ['new_client', 'follow_up'];

const BOTH = ['new_client', 'follow_up'];
const FU   = ['follow_up'];

/** { type_key, label (override|null), length, surfaces, sort_order } */
const OPTIONS_SEED = [
  { type_key: 'iss',               label: null, length: 15, surfaces: ['new_client'], sort_order: 10 },
  { type_key: 'ss',                label: null, length: 15, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'ss_follow_up',      label: null, length: 15, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'ss_follow_up',      label: null, length: 30, surfaces: BOTH,           sort_order: 20 },
  { type_key: 'consultation',      label: null, length: 30, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'pre_filing',        label: null, length: 30, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'schedules_meeting', label: null, length: 45, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'schedules_meeting', label: null, length: 20, surfaces: FU,             sort_order: 20 },
  { type_key: 'docs_meeting',      label: null, length: 30, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'matrix_meeting',    label: null, length: 15, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'pre_lawsuit',       label: null, length: 30, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'tax_consult',       label: null, length: 30, surfaces: BOTH,           sort_order: 10 },
  { type_key: 'meeting',           label: null, length: 15, surfaces: FU,             sort_order: 10 },
];

/**
 * The two hardcoded <option> lists as they stood in public/scripts.js on
 * 2026-09-02, as `type_key:length`, in dialog order. Every entry survives;
 * one ordering difference is deliberate — "Schedules Completion Meeting
 * (20 min)" was appended at the END of the follow-up list and now sits next
 * to its 45-minute sibling (options order within their type).
 */
const DIALOG_LISTS_2026_09_02 = {
  new_client: ['iss:15', 'ss:15', 'ss_follow_up:15', 'ss_follow_up:30', 'pre_filing:30',
               'schedules_meeting:45', 'docs_meeting:30', 'matrix_meeting:15'],
  follow_up:  ['ss:15', 'ss_follow_up:15', 'ss_follow_up:30', 'pre_filing:30',
               'schedules_meeting:45', 'docs_meeting:30', 'matrix_meeting:15', 'schedules_meeting:20'],
};

module.exports = { SURFACES, OPTIONS_SEED, DIALOG_LISTS_2026_09_02 };
