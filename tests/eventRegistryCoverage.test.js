// tests/eventRegistryCoverage.test.js
//
// Every event type the codebase emits MUST have an EVENT_TYPES registry
// entry (Review F1/F7, stage_aged round): the registry gates rule authoring,
// /test, /replay, /samples, and both UI dropdowns — an emitted-but-
// unregistered event fires forever into a void that can never be wired up,
// and nothing crashes to say so.
//
// Static scan: every literal event-type string passed to domainEvents.emit
// in services/, routes/, and lib/ must be a key of
// triggerService.EVENT_TYPES. Variable event types (none exist outside
// tests) are invisible to this scan — keep emit sites literal.

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const fs = require('fs');
const path = require('path');
const { EVENT_TYPES } = require('../services/triggerService');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes', 'lib'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      yield* walk(p);
    } else if (e.name.endsWith('.js')) {
      yield p;
    }
  }
}

// Matches: domainEvents.emit(<anything without , ( )>, 'event.type'
// (first arg may be db / req.db / dbArg, possibly across newlines).
const EMIT_RE = /domainEvents\s*\.\s*emit\s*\(\s*[^,()]+,\s*['"]([A-Za-z0-9_.]+)['"]/g;

test('every event type emitted in services/routes/lib is registered in EVENT_TYPES', () => {
  const missing = [];
  let found = 0;
  for (const dir of SCAN_DIRS) {
    for (const f of walk(path.join(ROOT, dir))) {
      const src = fs.readFileSync(f, 'utf8');
      EMIT_RE.lastIndex = 0;
      let m;
      while ((m = EMIT_RE.exec(src))) {
        found++;
        if (!EVENT_TYPES[m[1]]) {
          missing.push(`${path.relative(ROOT, f)} emits '${m[1]}' — not in EVENT_TYPES`);
        }
      }
    }
  }
  // Guard against the regex silently rotting: there are ~19 emit sites today.
  expect(found).toBeGreaterThanOrEqual(10);
  expect(missing).toEqual([]);
});