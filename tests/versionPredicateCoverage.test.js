/**
 * tests/versionPredicateCoverage.test.js
 *
 * Automation-versioning invariant (S2, 2026-08): every SQL statement that
 * touches workflow_steps / sequence_steps must either
 *   (a) carry a `version` predicate / column,
 *   (b) join by step row id (per-version rows make ids version-specific), or
 *   (c) be on the explicit exempt list below with its audit class.
 *
 * WHY A STATIC TEST
 * The failure mode this arc exists to kill is an UNVERSIONED read silently
 * resolving against the wrong version (or, post-S3, against a draft). A missed
 * site doesn't crash — it misbehaves. So the suite scans the shipped source
 * for every template literal mentioning the step tables and fails loudly on
 * any statement it can't account for. New query sites must either include the
 * predicate or be added to EXEMPT with a reason.
 *
 * LIMITS (known, accepted): the scanner sees template literals as written —
 * SQL assembled from concatenated fragments would evade it. House style is
 * single template literals (dynamic SET lists still live inside one literal,
 * which the scanner does see). The second describe() covers the residual gap
 * the scanner can't: context OBJECTS that feed version-scoped functions
 * (review finding D6 — a `version` predicate binding `undefined` passes any
 * SQL-text scan while matching zero rows at runtime).
 *
 *   npx jest tests/versionPredicateCoverage.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'lib', 'services'];

// ── Exempt statements, identified by a distinctive substring ────────────────
// Every entry needs an audit class + reason (see ref/AUTOMATION_VERSIONING_AUDIT.md).
const EXEMPT = [
  { // routes/workflows.js DELETE /workflows/:id — whole-entity delete
    match: 'DELETE FROM workflow_steps WHERE workflow_id = ?',
    klass: 'ALL-VERSIONS',
    reason: 'deleting the workflow removes every version\'s rows',
  },
  { // lib/sequenceEngine.js executeStep — load by scheduled job's stepId
    match: 'SELECT * FROM sequence_steps WHERE id = ?',
    klass: 'ID-JOIN',
    reason: 'row id is version-specific by construction',
  },
  { // routes/workflows.js remapBranchTargets config rewrite — by row id
    match: 'UPDATE workflow_steps SET config = ?, updated_at = NOW() WHERE id = ?',
    klass: 'ID-JOIN',
    reason: 'row id is version-specific by construction',
  },
];

// Any statement whose step-table reference is a join keyed on the step row id.
const ID_JOIN_RE = /JOIN\s+(?:workflow_steps|sequence_steps)\s+(\w+)\s+ON\s+\1\.id\s*=/i;

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Extract backtick template literals (tolerates ${...} interpolation).
function extractTemplateLiterals(src) {
  const literals = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      let j = i + 1, depth = 0, buf = '';
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { buf += src[j] + (src[j + 1] || ''); j += 2; continue; }
        if (c === '$' && src[j + 1] === '{') { depth++; buf += '${'; j += 2; continue; }
        if (depth > 0) { if (c === '}') depth--; buf += c; j++; continue; }
        if (c === '`') break;
        buf += c; j++;
      }
      literals.push(buf);
      i = j + 1;
    } else i++;
  }
  return literals;
}

function isSqlTouchingStepTables(lit) {
  if (!/\b(workflow_steps|sequence_steps)\b/.test(lit)) return false;
  // must look like SQL, not a comment/doc string
  return /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(lit);
}

describe('version predicate coverage — workflow_steps / sequence_steps SQL', () => {
  const offenders = [];

  for (const dir of SCAN_DIRS) {
    for (const file of collectFiles(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/workflow_steps|sequence_steps/.test(src)) continue;
      for (const lit of extractTemplateLiterals(src)) {
        if (!isSqlTouchingStepTables(lit)) continue;
        const rel = path.relative(ROOT, file);
        const exempt = EXEMPT.find((e) => lit.includes(e.match));
        if (exempt) continue;
        if (ID_JOIN_RE.test(lit)) continue; // joins keyed on step row id
        if (/\bversion\b/.test(lit)) continue; // predicate / column present
        offenders.push({ file: rel, sql: lit.replace(/\s+/g, ' ').slice(0, 160) });
      }
    }
  }

  test('every step-table statement is versioned, id-joined, or exempt', () => {
    if (offenders.length) {
      const msg = offenders.map((o) => `  ${o.file}: ${o.sql}`).join('\n');
      throw new Error(
        `Unversioned step-table SQL found (add a version predicate, or an EXEMPT entry with audit class + reason):\n${msg}`
      );
    }
  });

  test('scanner sanity — it actually finds step-table SQL', () => {
    // Guards against the scanner regressing into a vacuous pass.
    const engine = fs.readFileSync(path.join(ROOT, 'lib/sequenceEngine.js'), 'utf8');
    const lits = extractTemplateLiterals(engine).filter(isSqlTouchingStepTables);
    expect(lits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('context-construction sites carry the pinned version (review D6)', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'lib/sequenceEngine.js'), 'utf8');
  const wfEngineSrc = fs.readFileSync(path.join(ROOT, 'lib/workflow_engine.js'), 'utf8');
  const seqRoutesSrc = fs.readFileSync(path.join(ROOT, 'routes/sequences.js'), 'utf8');

  test('scheduleFromStep fails loudly on a missing template_version', () => {
    // The guard is what turns "silently completes at step 1" into a thrown
    // error when a context object forgets the version.
    expect(engineSrc).toMatch(/scheduleFromStep: enrollment\.template_version must be a positive integer/);
  });

  test('enrollmentCtx (hand-built context in _enrollWithTemplate) carries template_version', () => {
    const idx = engineSrc.indexOf('const enrollmentCtx = {');
    expect(idx).toBeGreaterThan(-1);
    const block = engineSrc.slice(idx, engineSrc.indexOf('};', idx));
    expect(block).toMatch(/template_version:/);
  });

  test('loadWorkflowStep takes version as an explicit parameter and guards it', () => {
    expect(wfEngineSrc).toMatch(/function loadWorkflowStep\(workflowId, stepNumber, version, db\)/);
    expect(wfEngineSrc).toMatch(/loadWorkflowStep: version must be a positive integer/);
    // Both callers pass the execution's pinned version.
    const calls = wfEngineSrc.match(/loadWorkflowStep\(execution\.workflow_id[^)]*\)/g) || [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/execution\.workflow_version/);
  });

  test('recover route selects template_version into its explicit enrollment column list', () => {
    expect(seqRoutesSrc).toMatch(
      /SELECT id, template_id, template_version, status, current_step FROM sequence_enrollments/
    );
  });
});
