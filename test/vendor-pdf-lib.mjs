/**
 * Copies pdf-lib into vendor/ as a browser-loadable ES module.
 *
 * Run: npm run vendor:pdf-lib   (dev-only; the app ships the copied file)
 *
 * pdf-lib publishes a PREBUILT, self-contained ES module at dist/pdf-lib.esm.min.js: its
 * four npm deps (@pdf-lib/standard-fonts, @pdf-lib/upng, pako, tslib) are all bundled
 * inline, it has zero bare import specifiers, and it references no node builtins. So, like
 * client-zip, this is a verbatim copy — nothing to wrap or transform. That's what lets the
 * app load it with a plain `import` and no bundler.
 *
 * We take the MINIFIED esm build (523 KB) over the unminified one (1.5 MB): identical API,
 * a third of the bytes, and this is loaded on demand so only users who export a PDF pay it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/pdf-lib/package.json'), 'utf8'));

const from = path.join(ROOT, 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js');
const to = path.join(ROOT, 'vendor/pdf-lib.js');

fs.copyFileSync(from, to);
fs.copyFileSync(path.join(ROOT, 'node_modules/pdf-lib/LICENSE.md'), path.join(ROOT, 'vendor/LICENSE.pdf-lib.txt'));

const bytes = fs.statSync(to).size;
console.log(`vendored pdf-lib ${pkg.version} -> vendor/pdf-lib.js (${bytes} bytes, verbatim minified ESM)`);
console.log('vendored LICENSE.md -> vendor/LICENSE.pdf-lib.txt');

// Guard the properties we rely on so a future upgrade can't silently break the app.
const src = fs.readFileSync(to, 'utf8');
const checks = [
  ['exports PDFDocument', /\bas PDFDocument\b/.test(src)],
  ['has embedJpg', /embedJpg/.test(src)],
  ['no bare import specifiers', !/from\s*["'](?!\.\/)[^"']+["']/.test(src.replace(/from"\.\//g, ''))],
  ['no node: imports', !/from\s*["']node:/.test(src)],
  ['no require() of node builtins', !/require\(["'](fs|zlib|crypto|stream|path|buffer)["']\)/.test(src)],
];
let bad = 0;
for (const [label, pass] of checks) {
  if (!pass) { console.error(`  FAIL: ${label}`); bad++; } else console.log(`  ok: ${label}`);
}
process.exit(bad === 0 ? 0 : 1);
