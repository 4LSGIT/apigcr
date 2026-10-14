// tests/helpers/shellHtml.js
//
/**
 * The shell's HTML as the browser ends up with it.
 *
 * Since ui-custom S1 the launcher buttons (Home tiles, the sidebar's Records /
 * Actions / Settings sections, the More Features and Admin grids) are no longer
 * written in public/index.html: each surface is a one-line
 * `<script>ycLauncher.mount('<surface>')</script>` that the page's own
 * renderer (the `<script id="ycLauncher">` block in its head) expands from
 * public/js/featureRegistry.js while the page parses. A test that greps the
 * raw file for a sidebar item or a grid tile finds nothing — and a `not.toMatch`
 * on it passes for the wrong reason.
 *
 * expandedShellHtml() runs that same renderer, unmodified, over the real
 * registry (in a bare vm: it is pure string-building, no DOM) and splices each
 * surface's markup in place of its mount — the text the parser actually
 * sees. Anything the renderer would skip at runtime (an unknown item id, an
 * entry the surface cannot draw) THROWS here instead, so a broken layout fails
 * the suites that read the shell rather than quietly dropping a button.
 *
 * rawShellHtml() is the file on disk, for checks about the file itself (every
 * inline script block parses, the mounts included).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SHELL = path.join(ROOT, 'public/index.html');
const REGISTRY = path.join(ROOT, 'public/js/featureRegistry.js');
const MOUNT = /<script>ycLauncher\.mount\('(\w+)'\)<\/script>/g;

function rawShellHtml() {
  return fs.readFileSync(SHELL, 'utf8');
}

/** The page's ycLauncher, run over the real registry. */
function loadLauncher(html = rawShellHtml()) {
  const block = html.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/);
  if (!block) throw new Error('shellHtml: no <script id="ycLauncher"> block in public/index.html');
  const warnings = [];
  const ctx = vm.createContext({ console: { error: (m) => warnings.push(String(m)) } });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(REGISTRY, 'utf8'), ctx, { filename: REGISTRY });
  vm.runInContext(block[1], ctx, { filename: 'index.html#ycLauncher' });
  return { launcher: ctx.window.ycLauncher, registry: ctx.window.FEATURE_REGISTRY, layouts: ctx.window.DEFAULT_LAYOUTS, warnings };
}

function expandedShellHtml() {
  const html = rawShellHtml();
  const { launcher, warnings } = loadLauncher(html);
  let mounts = 0;
  const out = html.replace(MOUNT, (_, surface) => { mounts++; return launcher.build(surface); });
  if (!mounts) throw new Error('shellHtml: no ycLauncher.mount() sites in public/index.html');
  if (warnings.length) throw new Error('shellHtml: the launcher renderer skipped entries:\n  ' + warnings.join('\n  '));
  return out;
}

module.exports = { rawShellHtml, expandedShellHtml, loadLauncher, MOUNT };
