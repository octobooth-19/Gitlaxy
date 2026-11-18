// Gitlaxy build: inlines src/css/*.css and src/js/*.js (sorted) into src/shell.html → index.html.
// Usage: node build.mjs        (Node built-ins only — zero dependencies)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).sort();

const cssFiles = list('src/css', '.css');
const jsFiles = list('src/js', '.js');

const css = cssFiles.map((f) => `/* ---- ${f} ---- */\n${read(`src/css/${f}`)}`).join('\n');
const js = jsFiles.map((f) => `// ---- ${f} ----\n${read(`src/js/${f}`)}`).join('\n;\n');

// Fail fast on syntax errors, with the offending file name.
for (const f of jsFiles) {
  try {
    new vm.Script(read(`src/js/${f}`), { filename: f });
  } catch (err) {
    console.error(`Syntax error in src/js/${f}:\n${err.stack}`);
    process.exit(1);
  }
}

let html = read('src/shell.html');
for (const marker of ['/*__GLX_STYLES__*/', '/*__GLX_SCRIPTS__*/']) {
  if (!html.includes(marker)) throw new Error(`shell.html is missing ${marker}`);
}
// Function replacers so `$&`-style patterns inside the sources are never interpreted.
html = html
  .replace('/*__GLX_STYLES__*/', () => css.replace(/<\/style/gi, '<\\/style'))
  .replace('/*__GLX_SCRIPTS__*/', () => js.replace(/<\/script/gi, '<\\/script'));

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`index.html → ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB (${jsFiles.length} js: ${jsFiles.join(', ')}; ${cssFiles.length} css)`);
