/**
 * tests/sendingformBk.dbkqLink.test.js
 *
 * Guards the Detailed Bankruptcy Questionnaire link that public/sendingform-bk
 * .html emits, and the two side effects that must ride beside it unchanged.
 *
 * WHY THIS FILE EXISTS
 *
 * THE PARAM NAME IS THE WHOLE BUG SURFACE. Three spellings exist historically
 * in this flow — `caseId` (the retired JotForm's field), `id` (the /p/detail
 * interstitial's own input), and `case_id` (YisraForm's credential param, the
 * only one /api/ext/forms reads). A YisraForm link carrying the wrong one does
 * not fail: dbkq is badLink:"degrade", so it renders anonymously, the client
 * fills 252 fields, and the submission lands in the Form Inbox attached to no
 * case. Nothing alerts. The failure is silent, expensive, and only visible
 * days later when the reminder drip keeps running against a case that already
 * answered. So the spelling gets a test.
 *
 * The rest of the questionnaire action is deliberately NOT changing and is
 * asserted as such:
 *   · the `case_detailed_form: null` blanking, which is what keeps template
 *     29's reminder condition (case_detailed_form IS NULL) correct on a RESEND
 *   · the dbkq_reminder enrolment, which the on-submit workflow cancels BY TYPE
 *
 * ON THE APPROACH: sendingform-bk.html is a 1700-line page with hard Quill and
 * SweetAlert dependencies and a parent-frame data source, so booting it whole
 * to read one string would cost far more harness than it buys. Instead the
 * shipped constants block is EXTRACTED and evaluated with a stub caseId — the
 * real template literal, really evaluated — and the surrounding invariants are
 * static assertions over the source (the tests/casePanelCss.test.js idiom).
 *
 *   npx jest tests/sendingformBk.dbkqLink.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '../public/sendingform-bk.html'), 'utf8');

/**
 * SRC with `//` line comments and HTML comments removed.
 *
 * Every "is X still here / is Y gone" assertion below runs against THIS, not
 * the raw source. The block comments in this page name the very things the
 * tests are trying to prove absent — `/p/detail`, `case_detailed_link`,
 * `/internal/sequence/enroll` are all mentioned by the comments explaining why
 * they are not used — so a raw grep asserts the opposite of what it reads like.
 * Block comments are left alone deliberately: nothing here needs to match
 * inside one, and stripping them would also eat the `/*` inside any regex or
 * string literal.
 */
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .map(line => line.replace(/^\s*\/\/.*$/, ''))
  .join('\n');

/**
 * Evaluate the shipped DBKQ constants block against a supplied caseId.
 * Slices from the first `const DBKQ_` declaration to the last one, so the
 * template literals under test are the ones the page actually ships.
 */
function evalDbkqConstants(caseId) {
  const start = SRC.indexOf('const DBKQ_FORM_ID');
  expect(start).toBeGreaterThan(-1);
  const endDecl = SRC.indexOf('const DBKQ_SEQ_TYPE', start);
  expect(endDecl).toBeGreaterThan(start);
  const end = SRC.indexOf('\n', endDecl);
  const block = SRC.slice(start, end);

  const sandbox = { caseId, encodeURIComponent, out: {} };
  vm.createContext(sandbox);
  new vm.Script(
    block + '\n;out = { DBKQ_FORM_ID, DBKQ_FORM_KEY, DBKQ_LINK, DBKQ_SEQ_TYPE };'
  ).runInContext(sandbox);
  return sandbox.out;
}

describe('DBKQ link', () => {

  test('points at the YisraForm external route with the case_id credential', () => {
    const { DBKQ_LINK } = evalDbkqConstants('uT7EU36v');
    expect(DBKQ_LINK).toBe('https://4lsg.com/f/dbkq?case_id=uT7EU36v');
  });

  test('emits case_id — never caseId, never bare id', () => {
    const { DBKQ_LINK } = evalDbkqConstants('uT7EU36v');
    const qs = new URLSearchParams(DBKQ_LINK.split('?')[1]);
    expect(qs.get('case_id')).toBe('uT7EU36v');
    expect(qs.has('caseId')).toBe(false);
    expect(qs.has('id')).toBe(false);
  });

  test('the case_id value is encoded', () => {
    const { DBKQ_LINK } = evalDbkqConstants('a b&c');
    expect(DBKQ_LINK).toBe('https://4lsg.com/f/dbkq?case_id=a%20b%26c');
  });

  test('a missing caseId still yields a well-formed link, not "undefined"', () => {
    const { DBKQ_LINK } = evalDbkqConstants(null);
    expect(DBKQ_LINK).toBe('https://4lsg.com/f/dbkq?case_id=');
  });

  test('the form key matches the published template', () => {
    const { DBKQ_FORM_KEY } = evalDbkqConstants('X');
    expect(DBKQ_FORM_KEY).toBe('dbkq');
  });

  test('the sequence type still matches what the on-submit workflow cancels', () => {
    const { DBKQ_SEQ_TYPE } = evalDbkqConstants('X');
    expect(DBKQ_SEQ_TYPE).toBe('dbkq_reminder');
  });

  test('no JotForm host or /p/detail interstitial survives in the code', () => {
    // Both are still NAMED in the constants block's comment, which is the
    // point of CODE — see its doc block.
    expect(CODE).not.toMatch(/form\.jotform\.com/);
    expect(CODE).not.toMatch(/p\/detail/);
  });

  test('both channels send the same DBKQ_LINK — no second link shape', () => {
    // The SMS body, the email anchor, and the preview pane. If a fourth link
    // shape ever appears it will not be this constant, and the /p/detail and
    // jotform assertions above will not necessarily catch it.
    const uses = SRC.match(/\$\{DBKQ_LINK\}|=\s*DBKQ_LINK\b/g) || [];
    expect(uses.length).toBe(3);
  });

});

describe('the rest of the questionnaire action is unchanged', () => {

  /**
   * The `if (action.type === 'questionnaire')` SEND branch (not the preview),
   * comment-stripped. The banner comments that delimit it are stripped too, so
   * the slice is anchored on the code either side of them instead.
   */
  function sendBranch() {
    const COND = "if (action.type === 'questionnaire') {";
    // TWO branches share this condition: the preview pane's (which only pushes
    // description lines) and the send path's. lastIndexOf takes the send one —
    // the preview comes first in the file. The PATCH assertion below is the
    // proof we sliced the right one; it exists in no other branch.
    expect(CODE.split(COND).length - 1).toBe(2);
    const start = CODE.lastIndexOf(COND);
    const end = CODE.indexOf("if (action.type === 'other') {", start);
    expect(end).toBeGreaterThan(start);
    const slice = CODE.slice(start, end);
    expect(slice).toContain("P.apiSend");
    return slice;
  }

  test('still blanks case_detailed_form before sending', () => {
    // Template 29's condition is `case_detailed_form IS NULL`; without this a
    // resend to a client who submitted months ago cancels at step 1 silently.
    expect(sendBranch()).toContain(
      "PATCH', { case_detailed_form: null }");
  });

  test('the blanking still runs BEFORE the sends', () => {
    const b = sendBranch();
    expect(b.indexOf('case_detailed_form: null'))
      .toBeLessThan(b.indexOf('DBKQ_LINK'));
  });

  test('still leaves case_detailed_link alone', () => {
    // Deliberate: the tab keeps showing the last PDF while a new request is
    // outstanding. tests/caseUi.detTab.test.js locks the reading end of this.
    expect(sendBranch()).not.toContain('case_detailed_link');
  });

  test('still enrols in dbkq_reminder via the internal sequence engine', () => {
    const b = sendBranch();
    expect(b).toContain("'/sequences/enroll', 'POST'");
    expect(b).toContain('template_type: DBKQ_SEQ_TYPE');
    expect(b).toContain('trigger_data:  { case_id: caseId');
    // NOT /internal/sequence/enroll — that one is the Pabbly relay and would
    // enroll into nothing.
    expect(b).not.toContain('/internal/sequence/enroll');
  });

});
