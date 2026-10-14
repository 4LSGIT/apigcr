#!/usr/bin/env node
// scripts/secret-scan.js
//
/**
 * Pre-commit secret scan (access-control B4, ref/ACCESS_CONTROL_DESIGN.md §5.5).
 * Run by .githooks/pre-commit BEFORE anything else; scans the STAGED DIFF
 * only — the lines this commit ADDS — never the tree.
 *
 * WHAT IT REFUSES
 *   App keys — the real minted shapes only:
 *     yci_ / yck_ / ycro_  + ≥32 hex chars          (today's format: 64 hex)
 *     yci_ / yck_ / ycro_  + EXACTLY 22 base62 chars, then no further
 *                            alphanumeric            (the B3 format; ycro_'s
 *                            "_<stamp>" suffix may follow). No character-class
 *                            requirement: a random 22-char body sometimes lacks
 *                            a digit or a case, and the prefix is the signal.
 *   Common provider secrets: private-key blocks, AWS access key ids, Anthropic
 *   (sk-ant-…) and OpenAI (sk-…/sk-proj-…) keys, Google API keys (AIza…),
 *   GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_), Slack tokens
 *   (xox?-) and incoming-webhook URLs, Stripe live keys, and literal JWTs.
 *
 * FIXTURE DISCRIMINATION (deliberate): tests mint key-SHAPED strings —
 * 'yck_not_a_real_key', 'yci_test_internal', 'ycro_legacy'. Those are words
 * (underscores break the run; never 22 alphanumerics then a stop, never 32+
 * hex), so the BODY-SHAPE rules above pass them. A fixture that genuinely needs a realistic-looking key opts out per
 * line with the marker  secret-scan: allow  (in a comment on that line).
 *
 * OVERRIDE: SKIP_SECRET_SCAN=1 git commit … — warns and skips the whole scan.
 *
 * Usage:
 *   node scripts/secret-scan.js            # scan `git diff --cached` (the hook)
 *   node scripts/secret-scan.js --tree     # scan every tracked file (audit run)
 * Exit 1 on any finding, 0 otherwise.
 */

'use strict';

const { execFileSync } = require('child_process');

const ALLOW_MARKER = 'secret-scan: allow';

// Files never scanned: the three generated files the hook itself stages, and
// lockfiles (integrity hashes are base64 blobs, not secrets).
const SKIP_FILES = [
  /^ref\/database\.sql$/, /^ref\/routes\.md$/, /^TRACKED_FILES\.txt$/,
  /(^|\/)package-lock\.json$/,
];

const RULES = [
  { name: 'YisraCase key (hex body)', re: /\b(?:yci|yck|ycro)_[0-9a-f]{32,}/ },
  { name: 'YisraCase key (base62 body)', re: /\b(?:yci|yck|ycro)_[A-Za-z0-9]{22}(?![A-Za-z0-9])/ },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack webhook URL', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ },
];

/** Show enough of a hit to find it, never the whole secret. */
function redact(s) {
  return s.length <= 12 ? s.slice(0, 4) + '…' : s.slice(0, 8) + '…' + s.slice(-4);
}

function skipped(file) {
  return SKIP_FILES.some(re => re.test(file));
}

/** Findings in one added line: [{ rule, match }]. */
function scanLine(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  const out = [];
  for (const r of RULES) {
    const m = line.match(r.re);
    if (m) out.push({ rule: r.name, match: m[0] });
  }
  return out;
}

/**
 * Parse `git diff --cached -U0` output into findings with file + NEW-file
 * line numbers. Only '+' lines count (additions); binary files are skipped.
 */
function scanDiff(diff) {
  const findings = [];
  let file = null;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { lineNo = Number(h[1]); continue; }
    if (!file || skipped(file)) continue;
    if (raw.startsWith('+')) {
      for (const f of scanLine(raw.slice(1))) findings.push({ file, line: lineNo, ...f });
      lineNo++;
    }
    // '-' lines don't advance the new-file counter; -U0 has no context lines.
  }
  return findings;
}

function scanTree() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const fs = require('fs');
  const findings = [];
  for (const file of files) {
    if (skipped(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (text.includes('\u0000')) continue;   // binary
    text.split('\n').forEach((l, i) => {
      for (const f of scanLine(l)) findings.push({ file, line: i + 1, ...f });
    });
  }
  return findings;
}

function report(findings) {
  console.error('\npre-commit: SECRET SCAN refused this commit — the staged changes add what looks like a secret:\n');
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.rule}  ${redact(f.match)}`);
  console.error(`
  If it IS a secret: unstage it (git restore --staged <file>), remove it, and rotate it if it
  was ever pushed or pasted anywhere. Secrets belong in Secret Manager / app_settings, never
  in the repo (CLAUDE.md, "Two one-way doors").
  If it is a deliberate FAKE (a test fixture): put the marker  ${ALLOW_MARKER}  in a
  comment on that line.
  To skip the scan for one commit (you are sure):  SKIP_SECRET_SCAN=1 git commit …
`);
}

if (require.main === module) {
  if (process.env.SKIP_SECRET_SCAN) {
    console.error('pre-commit: SKIP_SECRET_SCAN set — secret scan SKIPPED for this commit.');
    process.exit(0);
  }
  let findings;
  if (process.argv.includes('--tree')) {
    findings = scanTree();
  } else {
    const diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    findings = scanDiff(diff);
  }
  if (findings.length) { report(findings); process.exit(1); }
  process.exit(0);
}

module.exports = { RULES, ALLOW_MARKER, scanLine, scanDiff, redact, skipped };
