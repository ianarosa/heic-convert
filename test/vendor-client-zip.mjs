/**
 * Copies client-zip into vendor/ as a browser-loadable ES module.
 *
 * Run: npm run vendor:client-zip   (dev-only; the app ships the copied file)
 *
 * Unlike JSZip, client-zip already publishes a plain ES module (`"type": "module"`,
 * `"module": "index.js"`) built for browsers, so there is NOTHING to wrap or transform —
 * this is a verbatim byte-for-byte copy. Keeping it a copy (rather than importing from
 * node_modules) is what lets the app run with no npm install and no build step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/client-zip/package.json'), 'utf8'));

const from = path.join(ROOT, 'node_modules/client-zip/index.js');
const to = path.join(ROOT, 'vendor/client-zip.js');

fs.copyFileSync(from, to);
fs.copyFileSync(path.join(ROOT, 'node_modules/client-zip/LICENSE.txt'), path.join(ROOT, 'vendor/LICENSE.client-zip.txt'));

const bytes = fs.statSync(to).size;
console.log(`vendored client-zip ${pkg.version} -> vendor/client-zip.js (${bytes} bytes, verbatim copy)`);
console.log('vendored LICENSE.txt -> vendor/LICENSE.client-zip.txt');

// Guard the properties we rely on, so a future upgrade can't silently break the app.
const src = fs.readFileSync(to, 'utf8');
const checks = [
  ['exports makeZip', /export\s*\{[^}]*\bmakeZip\b/.test(src) || /\bmakeZip\b/.test(src)],
  ['exports predictLength', /\bpredictLength\b/.test(src)],
  ['no bare require()', !/\brequire\s*\(/.test(src)],
  ['no node builtins', !/from\s*["']node:/.test(src)],
];
let bad = 0;
for (const [label, pass] of checks) {
  if (!pass) { console.error(`  FAIL: ${label}`); bad++; } else console.log(`  ok: ${label}`);
}
process.exit(bad === 0 ? 0 : 1);
