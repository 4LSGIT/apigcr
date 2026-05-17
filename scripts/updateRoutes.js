// scripts/updateRoutes.js
// Usage:
//   node scripts/updateRoutes.js              # log + write ref/routes.md
//   node scripts/updateRoutes.js --no-write   # log only
//   node scripts/updateRoutes.js --quiet      # write only, no console
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const ANON = '<anonymous>'; // matches what Express stamps on unnamed functions

// ---------- route discovery ----------

/** Best-effort prefix extraction from layer.regexp. Returns '' for root-mounted routers. */
function extractMountPath(layer) {
  if (!layer.regexp) return '';
  const src = layer.regexp.source;
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/([^\\$?]+)/);
  return m ? '/' + m[1] : '';
}

/** Walk app._router.stack -> [{ method, path, middlewares, handler }] */
function listRoutes(app) {
  const out = [];
  function walk(stack, prefix = '') {
    stack.forEach((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
        const names = layer.route.stack.map((l) => l.name || ANON);
        const handler = names.length ? names[names.length - 1] : ANON;
        const middlewares = names.slice(0, -1);
        methods.forEach((method) => {
          out.push({ method, path: prefix + layer.route.path, middlewares, handler });
        });
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + extractMountPath(layer));
      }
    });
  }
  walk(app._router.stack);
  return out;
}

/** App-level middlewares (cors, parsers, static, etc.) */
function listGlobalMiddlewares(app) {
  return app._router.stack
    .filter((l) => !l.route && l.name !== 'router')
    .map((l) => l.name || ANON);
}

// ---------- summary ----------

function summarize(routes) {
  const byMethod = {};
  routes.forEach((r) => { byMethod[r.method] = (byMethod[r.method] || 0) + 1; });
  return { total: routes.length, byMethod };
}

function formatSummary(s) {
  const methods = Object.keys(s.byMethod).sort().map((m) => `${m}: ${s.byMethod[m]}`).join(', ');
  return `${s.total} routes total — ${methods}`;
}

// ---------- markdown rendering ----------

function toMarkdown(app, routes) {
  const globals = listGlobalMiddlewares(app);
  const summary = summarize(routes);

  const groups = {};
  routes.forEach((r) => {
    const seg = (r.path.split('/').filter(Boolean)[0] || '_root').toLowerCase();
    (groups[seg] = groups[seg] || []).push(r);
  });

  let md = '# Routes\n\n';
  md += `_Generated ${new Date().toISOString()}_  \n`;
  md += `_${formatSummary(summary)}_\n\n`;

  md += '## Global middleware chain\n\n';
  md += globals.map((n, i) => `${i + 1}. \`${n}\``).join('\n') + '\n\n';

  Object.keys(groups).sort().forEach((g) => {
    md += `## /${g === '_root' ? '' : g}\n\n`;
    md += '| Method | Path | Middlewares | Handler |\n';
    md += '|--------|------|-------------|---------|\n';
    groups[g]
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
      .forEach((r) => {
        const mws = r.middlewares.length ? r.middlewares.map((m) => `\`${m}\``).join(', ') : '—';
        const h = r.handler === ANON ? '—' : `\`${r.handler}\``;
        md += `| ${r.method} | \`${r.path}\` | ${mws} | ${h} |\n`;
      });
    md += '\n';
  });

  md += `---\n\n_${formatSummary(summary)}_\n`;
  return md;
}

// ---------- run ----------

const args = new Set(process.argv.slice(2));
const skipWrite = args.has('--no-write');
const quiet = args.has('--quiet');

const app = express();
const routesPath = path.join(__dirname, '..', 'routes');

fs.readdirSync(routesPath).forEach((file) => {
  if (file.endsWith('.js')) {
    const route = require(path.join(routesPath, file));
    app.use(route);
  }
});

const routes = listRoutes(app);
const summary = summarize(routes);

if (!quiet) {
  console.log(`\n${routes.length} routes:\n`);
  const pad = Math.max(...routes.map((r) => r.path.length));
  routes.forEach((r) => {
    const mws = r.middlewares.length ? ` [${r.middlewares.join(', ')}]` : '';
    const h = r.handler === ANON ? '' : ` -> ${r.handler}`;
    console.log(`  ${r.method.padEnd(7)} ${r.path.padEnd(pad)}${mws}${h}`);
  });
  console.log(`\n${formatSummary(summary)}`);
}

if (!skipWrite) {
  const outPath = path.join(__dirname, '..', 'ref', 'routes.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, toMarkdown(app, routes));
  if (!quiet) console.log(`Written to ${outPath}`);
}

process.exit(0);