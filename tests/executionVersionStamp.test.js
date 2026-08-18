/**
 * tests/executionVersionStamp.test.js
 *
 * Automation-versioning invariant (S2, 2026-08): every INSERT that creates a
 * workflow execution or sequence enrollment must stamp the definition version
 * it started on. An unstamped row falls back to the column DEFAULT 1, which
 * silently pins the run to the wrong definition the moment version 2 of
 * anything exists (S3+).
 *
 * Known creation sites at time of writing (Cookbook §5.21 + audit S1):
 *   workflow_executions — routes/workflows.js (manual start),
 *     lib/actionDispatchers.js (hook→wf), lib/internal_functions/composition.js
 *     (wf→wf), lib/sequenceEngine.js (seq→wf)
 *   sequence_enrollments — lib/sequenceEngine.js _enrollWithTemplate (single
 *     funnel for both enroll paths)
 *
 * The test scans ALL of routes/ lib/ services/ rather than pinning those
 * files, so a fifth creation site added without a stamp fails here instead of
 * shipping.
 *
 *   npx jest tests/executionVersionStamp.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'lib', 'services'];

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Grab the column-list segment of each INSERT INTO <table> ( ... )
function insertColumnLists(src, table) {
  const re = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`, 'g');
  const lists = [];
  let m;
  while ((m = re.exec(src)) !== null) lists.push(m[1]);
  return lists;
}

describe('execution/enrollment inserts stamp their definition version', () => {
  const wfInserts = [];
  const seqInserts = [];

  for (const dir of SCAN_DIRS) {
    for (const file of collectFiles(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const cols of insertColumnLists(src, 'workflow_executions')) {
        wfInserts.push({ file: rel, cols });
      }
      for (const cols of insertColumnLists(src, 'sequence_enrollments')) {
        seqInserts.push({ file: rel, cols });
      }
    }
  }

  test('found the known creation sites (guards against a vacuous pass)', () => {
    expect(wfInserts.length).toBeGreaterThanOrEqual(4);
    expect(seqInserts.length).toBeGreaterThanOrEqual(1);
  });

  test('every INSERT INTO workflow_executions includes workflow_version', () => {
    const missing = wfInserts.filter((i) => !/\bworkflow_version\b/.test(i.cols));
    expect(missing).toEqual([]);
  });

  test('every INSERT INTO sequence_enrollments includes template_version', () => {
    const missing = seqInserts.filter((i) => !/\btemplate_version\b/.test(i.cols));
    expect(missing).toEqual([]);
  });
});
