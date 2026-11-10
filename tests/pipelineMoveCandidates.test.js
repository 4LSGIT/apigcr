/**
 * "Move to another pipeline…" — which pipelines the dialog offers (2026-11-10).
 *
 * movePipeline is two writes: the type/subtype (membership) first, then the
 * stage advance. When the advance fails after the first write, the case
 * already RESOLVES to the destination while its latest stage-log row is still
 * on the old pipeline, and the route's own error says "retry the move". Both
 * move dialogs used to filter the resolved pipeline out of the picker, so the
 * one retry the error asked for was the one move the UI could not make (A9.3
 * worker finding, 2026-11-09). Now:
 *   - case.html `pwMoveCandidates(templates, pipelinePayload)`: when the
 *     case's current stage_key is not among its resolved pipeline's stages,
 *     the resolved pipeline is offered FIRST, flagged `pwFinish`; otherwise
 *     every active template but the resolved one, as before;
 *   - pipelineBoard.html `xMoveCandidates(templates, boardTemplateId,
 *     unstaged)`: an UNSTAGED card (no position on this board's pipeline) gets
 *     the board's own pipeline first, flagged `xFinish`;
 *   - each dialog's pipeline <option> carries the flag as text, and the
 *     dialogs call these functions (source pins).
 * A same-template move is legal to movePipeline (its membership diff is
 * empty, only the advance runs) — pinned on the real engine in
 * tests/caseyPipelineTransfer.mysql.test.js's torn-state test.
 *
 * The functions are lifted from the pages by name and run bare: they are pure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CASE = fs.readFileSync(path.join(ROOT, 'public/case.html'), 'utf8');
const BOARD = fs.readFileSync(path.join(ROOT, 'public/pipelineBoard.html'), 'utf8');

function fnSrc(html, name) {
  const re = new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`);
  const m = re.exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}
const lift = (html, name) => new Function(`${fnSrc(html, name)}; return ${name};`)(); // eslint-disable-line no-new-func

const T = [
  { id: 1, name: 'Intake', role: 'intake' },
  { id: 2, name: 'Chapter 7', role: 'case' },
  { id: 3, name: 'Chapter 13', role: 'case' },
];
const STAGES = [{ stage_key: 'filed' }, { stage_key: 'discharged' }, { stage_key: 'dismissed', lane: 'offramp' }];

describe('case.html pwMoveCandidates', () => {
  const pwMoveCandidates = lift(CASE, 'pwMoveCandidates');

  test('a case on its pipeline: every active template but the resolved one, in order, unflagged', () => {
    const out = pwMoveCandidates(T, { template: { id: 3 }, current: { stage_key: 'filed' }, stages: STAGES });
    expect(out.map((t) => [t.id, !!t.pwFinish])).toEqual([[1, false], [2, false]]);
    expect(T[2].pwFinish).toBeUndefined();
  });

  test('a position OFF the resolved pipeline (the torn move): the resolved pipeline first, flagged, then the others', () => {
    const out = pwMoveCandidates(T, { template: { id: 3 }, current: { stage_key: 'intake_consult' }, stages: STAGES });
    expect(out.map((t) => [t.id, !!t.pwFinish])).toEqual([[3, true], [1, false], [2, false]]);
    expect(out[0].name).toBe('Chapter 13');
    expect(T[2].pwFinish).toBeUndefined(); // a copy is flagged, never the cached template row
  });

  test('an off-ramp position is ON the pipeline; no current position, no resolved template, or no stages are not the torn shape', () => {
    expect(pwMoveCandidates(T, { template: { id: 3 }, current: { stage_key: 'dismissed' }, stages: STAGES }).map((t) => t.id)).toEqual([1, 2]);
    expect(pwMoveCandidates(T, { template: { id: 3 }, current: null, stages: STAGES }).map((t) => t.id)).toEqual([1, 2]);
    expect(pwMoveCandidates(T, { template: null, current: { stage_key: 'filed' }, stages: [] }).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(pwMoveCandidates(T, null).map((t) => t.id)).toEqual([1, 2, 3]);
    // No stages at all (a template with none active) with a position: off it, so finish is offered.
    expect(pwMoveCandidates(T, { template: { id: 2 }, current: { stage_key: 'filed' }, stages: [] }).map((t) => [t.id, !!t.pwFinish])).toEqual([[2, true], [1, false], [3, false]]);
    expect(pwMoveCandidates([], { template: { id: 2 }, current: { stage_key: 'x' }, stages: [] })).toEqual([]);
  });

  test('the dialog uses it and labels the flagged option', () => {
    expect(CASE).toContain('const tpls = pwMoveCandidates(pwMoveTemplates, pwData);');
    expect(CASE).not.toMatch(/pwMoveTemplates\.filter\(t => Number\(t\.id\) !== curTplId\)/);
    expect(CASE).toMatch(/\$\{escAttr\(t\.name\)\}\$\{t\.pwFinish\s*\? ' — finish the move: the case resolves here but its stage is not on this pipeline' : ''\}<\/option>/);
  });
});

describe('pipelineBoard.html xMoveCandidates', () => {
  const xMoveCandidates = lift(BOARD, 'xMoveCandidates');

  test('a staged card: every active template but the board\'s, unflagged', () => {
    expect(xMoveCandidates(T, 3, false).map((t) => [t.id, !!t.xFinish])).toEqual([[1, false], [2, false]]);
    expect(xMoveCandidates(T, '3', false).map((t) => t.id)).toEqual([1, 2]); // the select's string value
  });

  test('an unstaged card: the board\'s own pipeline first, flagged, then the others', () => {
    const out = xMoveCandidates(T, 3, true);
    expect(out.map((t) => [t.id, !!t.xFinish])).toEqual([[3, true], [1, false], [2, false]]);
    expect(T[2].xFinish).toBeUndefined();
    expect(xMoveCandidates(T, 99, true).map((t) => t.id)).toEqual([1, 2, 3]); // a board template not in the list: nothing to finish
  });

  test('the dialog uses it, reads the column before it, and labels the flagged option', () => {
    expect(BOARD).toMatch(/const curKey = findCardColumnKey\(caseId\);\n\s*const tpls = xMoveCandidates\(templates, curTplId, curKey == null\);/);
    expect(BOARD).not.toMatch(/templates\.filter\(t => Number\(t\.id\) !== curTplId\)/);
    expect(BOARD).toMatch(/\$\{escAttr\(t\.name\)\}\$\{t\.xFinish\s*\? ' — finish the move: the case resolves here but has no stage on this pipeline' : ''\}<\/option>/);
  });
});
