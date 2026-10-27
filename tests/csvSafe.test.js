'use strict';
/**
 * tests/csvSafe.test.js
 *
 * CSV / TSV formula injection across EVERY human export (OWASP "CSV
 * Injection"; Fred's GO 2026-10-27 with A16, extended by the manager's ruling
 * to "every human export"). A spreadsheet runs a cell that starts with
 * = + - @ — or a tab / carriage return some importers strip first — as a
 * formula, and exported text (contact names, notes, intake answers, SMS and
 * email bodies) is partly client-written. public/js/csvSafe.js is the one
 * rule: such a cell gets a leading single quote; a plain number
 * (/^[+-]?\d+(?:\.\d+)?$/) keeps its value. Pinned here:
 *   1. the rule set itself (cell / line / tsvCell / tsvLine);
 *   2. each exporter, RUN out of its page's own source, writes neutralised
 *      cells and headers: reports.html csvText, customView.html exportCsv,
 *      scripts.js buildLogCsv (the log export), dbConsole.html's CSV button and
 *      its TSV Copy (the other list exports share buildLogCsv's buildCsv —
 *      tests/listCsvExport.test.js runs each of them);
 *   3. every page that runs one of them loads /js/csvSafe.js, and no page
 *      under public/ keeps a private CSV quoting routine (a fifth exporter
 *      would have to come through here).
 */

const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const csvSafe = require(path.join(PUB, 'js', 'csvSafe.js'));

// The block that starts at `marker` and ends at its matching close brace.
function block(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${marker}`);
}
// `const NAME = [ … ];` at bracket depth 0.
function constSrc(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if ('([{'.includes(src[i])) depth++;
    else if (')]}'.includes(src[i])) depth--;
    else if (src[i] === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}

// One captured download: the Blob's text, from a page's own export code.
function captureEnv() {
  const files = [];
  class Blob { constructor(parts, opts) { files.push({ text: parts.join(''), type: opts && opts.type }); } }
  const document = { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } };
  const URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  return { files, Blob, document, URL };
}

const EVIL = '=HYPERLINK("http://x","click")';

describe('the rule set (public/js/csvSafe.js)', () => {
  test.each([
    ['=1+1', "'=1+1"],
    [EVIL, `"'=HYPERLINK(""http://x"",""click"")"`],
    ['+cmd|calc', "'+cmd|calc"],
    ["-2+3+cmd|' /C calc'!A0", "'-2+3+cmd|' /C calc'!A0"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', `"'\r=1+1"`],
    ['-', "'-"],
    ['- 5', "'- 5"],
    ['-1e5', "'-1e5"],
  ])('cell(%j) → %j', (input, want) => {
    expect(csvSafe.cell(input)).toBe(want);
  });

  // The numeric carve-out, pinned exactly: /^[+-]?\d+(?:\.\d+)?$/.
  test.each([
    ['-12.50', '-12.50'], ['+3', '+3'], ['-7', '-7'], [-7, '-7'], [12.5, '12.5'], ['0', '0'],
    ['Pat One', 'Pat One'], ['a,b', '"a,b"'], ['say "hi"', '"say ""hi"""'], ['line\nbreak', '"line\nbreak"'],
    [null, ''], [undefined, ''], [{ a: 1 }, '"{""a"":1}"'], ['', ''], ['2026-10-27', '2026-10-27'],
  ])('ordinary value %j stays %j', (input, want) => {
    expect(csvSafe.cell(input)).toBe(want);
  });

  test('line and the TSV variant', () => {
    expect(csvSafe.line(['=a', 'b,c', -1])).toBe(`'=a,"b,c",-1`);
    expect(csvSafe.tsvCell('=1+1')).toBe("'=1+1");
    expect(csvSafe.tsvCell('\t=x')).toBe("'    =x");
    expect(csvSafe.tsvCell('a\tb\nc\r\nd\re')).toBe('a    b c d e');
    expect(csvSafe.tsvCell('-3.5')).toBe('-3.5');
    expect(csvSafe.tsvLine(['@x', 'y'])).toBe("'@x\ty");
  });
});

describe('every exporter writes neutralised cells and headers', () => {
  test('reports.html csvText (saved-report runs)', () => {
    const src = read('reports.html');
    // eslint-disable-next-line no-new-func
    const csvText = new Function('ycCsvSafe', `${block(src, 'function csvText(')}\nreturn csvText;`)(csvSafe);
    expect(csvText([{ '=evil': '=1+1', name: 'Pat' }, { '=evil': '-5', name: '@x' }]))
      .toBe("'=evil,name\n'=1+1,Pat\n-5,'@x");
    expect(block(src, 'function downloadCsv(')).toContain('csvText(lastRows)');
  });

  test('customView.html exportCsv (views)', () => {
    const src = read('customView.html');
    const env = captureEnv();
    const run = new Function('ycCsvSafe', 'Blob', 'document', 'URL', 'lastResult', 'displayCols', 'sortedRows', 'RC', 'currentView', // eslint-disable-line no-new-func
      `${block(src, 'function exportCsv(')}\nreturn exportCsv;`)(
      csvSafe, env.Blob, env.document, env.URL,
      { rows: [1] },
      [{ key: 'client', label: '=Label' }, { key: 'opened', label: 'Opened', format: 'date' }, { key: 'n', label: 'N' }],
      () => [{ client: '@evil', opened: '2026-10-01', n: -4 }, { client: 'Pat', opened: '+bad', n: '12' }],
      { shortDate: (v) => v }, { report_key: 'v1' });
    run();
    expect(env.files).toHaveLength(1);
    expect(env.files[0].text).toBe("'=Label,Opened,N\n'@evil,2026-10-01,-4\nPat,'+bad,12");
  });

  test('scripts.js buildLogCsv (the log export from case, contact and the log tab)', () => {
    const src = read('scripts.js');
    // eslint-disable-next-line no-new-func
    const build = new Function('ycCsvSafe', 'logEnteredCsv', `${constSrc(src, 'LOG_CSV_COLUMNS')}\n${block(src, 'function buildLogCsv(')}\n${block(src, 'function buildCsv(')}\nreturn { buildLogCsv, LOG_CSV_COLUMNS };`)(
      csvSafe, () => '');
    const { buildLogCsv, LOG_CSV_COLUMNS } = build;
    const subjectIdx = LOG_CSV_COLUMNS.findIndex((c) => c.key === 'log_subject');
    const messageIdx = LOG_CSV_COLUMNS.findIndex((c) => c.key === 'log_message');
    const csv = buildLogCsv([{ log_id: 7, log_subject: '=cmd|calc', log_message: '@SUM(1)', log_data: 'ok, fine' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    const [header, row] = csv.slice(1).split('\r\n');
    expect(header.split(',')[0]).toBe('Log ID');
    const cells = row.split(',');
    expect(cells[0]).toBe('7');
    expect(cells[subjectIdx]).toBe("'=cmd|calc");
    expect(cells[messageIdx]).toBe("'@SUM(1)");
    expect(row).toContain('"ok, fine"');
  });

  test('dbConsole.html CSV button and TSV Copy (SU database console)', async () => {
    const src = read('dbConsole.html');
    const env = captureEnv();
    const csvHandler = block(src, 'btnCsv.addEventListener("click", () => {').replace(/^btnCsv\.addEventListener\("click", /, '');
    const rows = [{ '=h': '=1+1', b: '-2' }, { '=h': 'x\ty', b: '+q' }];
    // eslint-disable-next-line no-new-func
    new Function('ycCsvSafe', 'Blob', 'document', 'URL', 'lastRows', 'lastFields', `return (${csvHandler});`)(
      csvSafe, env.Blob, env.document, env.URL, rows, null)();
    expect(env.files[0].text).toBe("'=h,b\n'=1+1,-2\nx\ty,'+q");

    const copyHandler = block(src, 'btnCopy.addEventListener("click", async () => {').replace(/^btnCopy\.addEventListener\("click", /, '');
    let copied = null;
    const navigator = { clipboard: { writeText: async (t) => { copied = t; } } };
    // eslint-disable-next-line no-new-func
    await new Function('ycCsvSafe', 'navigator', 'lastReportMarkdown', 'lastRows', 'lastFields', 'setCopyHint', `return (${copyHandler});`)(
      csvSafe, navigator, null, rows, null, () => {})();
    expect(copied).toBe("'=h\tb\n'=1+1\t-2\nx    y\t'+q");
  });
});

describe('every exporting page loads the helper; no private CSV quoting remains', () => {
  const TAG = '<script src="/js/csvSafe.js"></script>';

  test('the four exporter pages and every list-export caller load /js/csvSafe.js', () => {
    for (const page of ['reports.html', 'customView.html', 'dbConsole.html']) {
      expect({ page, loads: read(page).includes(TAG) }).toEqual({ page, loads: true });
    }
    // Every page that calls a list export (scripts.js defines them).
    const callers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.html') && /export(?:Log|List|Rows)Csv\(/.test(fs.readFileSync(p, 'utf8'))) callers.push(p);
      }
    };
    walk(PUB);
    expect(callers.map((p) => path.relative(PUB, p)).sort()).toEqual(['case.html', 'contact.html', 'index.html', 'tasks.html']);
    for (const p of callers) {
      const html = fs.readFileSync(p, 'utf8');
      const rel = path.relative(PUB, p);
      expect({ rel, loads: html.includes(TAG) }).toEqual({ rel, loads: true });
      // Before scripts.js, so the helper exists whatever runs first.
      expect({ rel, before: html.indexOf(TAG) < html.indexOf('<script src="/scripts.js"></script>') }).toEqual({ rel, before: true });
    }
  });

  test('only csvSafe.js doubles quotes for CSV — no exporter keeps a private quoting routine', () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
        if (!/\.(html|js)$/.test(e.name)) continue;
        if (/replace\(\/"\/g,\s*(['"`])""\1\)/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(PUB, p));
      }
    };
    walk(PUB);
    expect(hits).toEqual(['js/csvSafe.js']);
  });
});
