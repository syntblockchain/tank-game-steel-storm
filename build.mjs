// Bundles the game into single self-contained HTML files (no dependencies):
//   dist/steel-storm.html           full document; double-click to play offline
//   dist/steel-storm.artifact.html  page body for publishing as a claude.ai Artifact
//
// Each ES module becomes a function scope in a small registry, in dependency
// order; imports become reads from that registry. Fonts are inlined as data URIs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');

const IMPORT = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+'\.\/([\w-]+)\.js';\s*$/;
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+(\w+)/;

function parseModule(name) {
  const code = readFileSync(join(src, name + '.js'), 'utf8');
  const deps = [];
  const exports = [];
  const lines = code.split('\n').map((line, i) => {
    const imp = line.match(IMPORT);
    if (imp) {
      const [, names, star, dep] = imp;
      deps.push(dep);
      if (star) return `const ${star} = __mods[${JSON.stringify(dep)}];`;
      const fields = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'));
      return `const { ${fields.join(', ')} } = __mods[${JSON.stringify(dep)}];`;
    }
    const exp = line.match(EXPORT_DECL);
    if (exp) {
      exports.push(exp[1]);
      return line.replace(/^export\s+/, '');
    }
    if (/^\s*(import|export)\b/.test(line)) throw new Error(`${name}.js:${i + 1}: unsupported module syntax: ${line.trim()}`);
    return line;
  });
  return { name, deps, exports, body: lines.join('\n') };
}

// Depth-first topological order starting from the entry module.
function collect(entry) {
  const order = [];
  const state = new Map(); // undefined | 'visiting' | 'done'
  const mods = new Map();
  const visit = (name, chain) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`Import cycle: ${[...chain, name].join(' -> ')}`);
    state.set(name, 'visiting');
    const m = parseModule(name);
    mods.set(name, m);
    for (const d of m.deps) visit(d, [...chain, name]);
    state.set(name, 'done');
    order.push(m);
  };
  visit(entry, []);
  return order;
}

function bundleJs() {
  const order = collect('main');
  const parts = order.map(
    (m) => `// ---- ${m.name}.js ----\n__mods[${JSON.stringify(m.name)}] = (() => {\n${m.body}\nreturn { ${m.exports.join(', ')} };\n})();`
  );
  const js = `(() => {\n'use strict';\nconst __mods = {};\n${parts.join('\n\n')}\n})();\n`;
  if (/<\/script/i.test(js)) throw new Error('Bundle contains "</script", which would end the inline script early');
  return { js, modules: order.map((m) => m.name) };
}

function inlineFonts() {
  const dir = join(root, 'assets', 'fonts');
  const css = readFileSync(join(dir, 'fonts.css'), 'utf8');
  return css.replace(/url\(([\w.-]+\.woff2)\)/g, (_, file) => {
    const b64 = readFileSync(join(dir, file)).toString('base64');
    return `url(data:font/woff2;base64,${b64})`;
  });
}

const { js, modules } = bundleJs();
const fonts = inlineFonts();
const html = readFileSync(join(root, 'index.html'), 'utf8');
const pageStyle = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const favicon = html.match(/<link rel="icon"[^>]*>/)[0];
const title = html.match(/<title>(.*?)<\/title>/)[1];

const body = `<canvas id="screen"></canvas>
<div id="loading">GENERATING BATTLEFIELD…</div>
<script>
${js}</script>`;

// The game is a single deliberately dark look, so the artifact sets its own
// background and colour scheme rather than following the viewer's theme.
const style = `<style>
${fonts}
:root { color-scheme: dark; }
html, body { height: 100%; }
${pageStyle.trim()}
</style>`;

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>${title}</title>
${favicon}
${style}
</head>
<body>
${body}
</body>
</html>
`;

// Artifact pages are wrapped in a document skeleton at publish time.
const fragment = `<title>${title}</title>
${style}
${body}
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'steel-storm.html'), full);
writeFileSync(join(root, 'dist', 'steel-storm.artifact.html'), fragment);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
console.log(`Bundled ${modules.length} modules (${modules.join(', ')})`);
console.log(`dist/steel-storm.html           ${kb(full)}`);
console.log(`dist/steel-storm.artifact.html  ${kb(fragment)}`);
