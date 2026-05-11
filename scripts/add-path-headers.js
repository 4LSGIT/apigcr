#!/usr/bin/env node
// scripts/add-path-headers.js
//
// Ensures every .js file under lib/, routes/, services/ starts with
//   // <relative-path>
//   //
// followed by its original content. Idempotent.
//
// Usage:
//   node scripts/add-path-headers.js --dry-run [path ...]
//   node scripts/add-path-headers.js --write   [path ...]

const fs = require("fs");
const path = require("path");

const ROOTS = ["lib", "routes", "services", "scripts"];
const EXTS = new Set([".js", ".mjs", ".cjs"]);
const STALE_PATH_RE = /^\/\/\s*[\w./-]+\.(?:js|mjs|cjs)\s*$/;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(name))) out.push(p);
  }
  return out;
}

function classify(file) {
  const rel = file.replace(/^\.\//, "");
  const src = fs.readFileSync(file, "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const wanted = `// ${rel}`;

  // Shebangs must stay on line 1; the path header goes on line 2.
  if (lines[0].startsWith("#!")) {
    if (lines[1] === wanted) return { rel, action: "ok", src, eol };
    const shebangLen = lines[0].length + eol.length;
    const head = src.slice(0, shebangLen);
    const tail = src.slice(shebangLen);
    if (STALE_PATH_RE.test(lines[1] || "")) {
      const tailFirstLineLen = lines[1].length;
      const next = head + wanted + tail.slice(tailFirstLineLen);
      return { rel, action: "replace", src, next, firstLine: lines[1], eol };
    }
    const next = `${head}${wanted}${eol}//${eol}${tail}`;
    return { rel, action: "prepend", src, next, firstLine: lines[1] || "", eol };
  }

  const firstLine = lines[0];
  if (firstLine === wanted) return { rel, action: "ok", src, eol };
  if (STALE_PATH_RE.test(firstLine)) {
    const rest = src.slice(firstLine.length); // keeps the trailing newline if any
    const next = wanted + rest;
    return { rel, action: "replace", src, next, firstLine, eol };
  }
  const next = `${wanted}${eol}//${eol}${src}`;
  return { rel, action: "prepend", src, next, firstLine, eol };
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const write = args.includes("--write");
if (!dry && !write) {
  console.error("pass --dry-run or --write");
  process.exit(2);
}
const explicit = args.filter((a) => !a.startsWith("--"));

const files = explicit.length
  ? explicit
  : ROOTS.flatMap((r) => walk(r));

const counts = { ok: 0, replace: 0, prepend: 0 };
for (const f of files) {
  const r = classify(f);
  counts[r.action]++;
  if (r.action === "ok") continue;
  if (dry) {
    console.log(`\n--- ${r.action.toUpperCase()}  ${r.rel}`);
    console.log(`  line1 was: ${JSON.stringify(r.firstLine)}`);
    console.log(`  line1 new: ${JSON.stringify("// " + r.rel)}`);
    if (r.action === "prepend") {
      console.log(`  (original content pushed down 2 lines)`);
    }
  } else {
    fs.writeFileSync(f, r.next);
    console.log(`${r.action.padEnd(7)} ${r.rel}`);
  }
}
console.log(
  `\nok=${counts.ok}  replace=${counts.replace}  prepend=${counts.prepend}  total=${files.length}`,
);
