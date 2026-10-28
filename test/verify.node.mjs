/**
 * Pure-node verification of the vendored libheif WASM decode path.
 *
 * This is the SECONDARY test — test/verify.mjs (headless Chrome) is the real one, since
 * the browser is the actual target. This exists to check the vendored bundle itself
 * without a browser, and to guard the properties decode.worker.js relies on.
 *
 * Run:  node test/verify.node.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import libheifFactory from '../vendor/libheif-bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'vendor', 'libheif-bundle.mjs');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ── the vendored bundle must not require cross-origin isolation ─────────────────
console.log('── vendored bundle ─────────────────────────────────────');
const src = fs.readFileSync(BUNDLE, 'utf8');
ok('bundle needs no SharedArrayBuffer', !src.includes('SharedArrayBuffer'));
ok('bundle needs no pthreads', !src.includes('pthread'));
ok('bundle needs no crossOriginIsolated', !src.includes('crossOriginIsolated'));
ok('bundle inlines the .wasm (no extra fetch)', src.includes('data:application/octet-stream;base64'));
console.log(`      vendor/libheif-bundle.mjs = ${fs.statSync(BUNDLE).size} bytes`);

// ── sample must be a genuine HEIC ──────────────────────────────────────────────
console.log('\n── sample files ────────────────────────────────────────');
const VALID_BRANDS = ['heic', 'heix', 'mif1', 'heim', 'heis', 'hevc'];
function checkHeic(file) {
  const buf = fs.readFileSync(path.join(HERE, file));
  const box = buf.subarray(4, 8).toString('latin1');
  const brand = buf.subarray(8, 12).toString('latin1');
  const compat = buf.subarray(16, Math.min(buf.length, 40)).toString('latin1');
  ok(`${file}: real ftyp + HEIC brand`,
    box === 'ftyp' && (VALID_BRANDS.includes(brand) || VALID_BRANDS.some((b) => compat.includes(b))),
    `ftyp="${box}" brand="${brand}" ${buf.length} bytes`);
  return buf;
}
const sample = checkHeic('sample.heic');
const tiny = checkHeic('tiny.heic');

const mod = await libheifFactory();

function decodePrimary(bytes) {
  const ctx = mod.heif_context_alloc();
  const err = mod.heif_context_read_from_memory(ctx, bytes);
  if (err && err.code !== mod.heif_error_code.heif_error_Ok) throw new Error(err.message);
  const handle = mod.heif_js_context_get_primary_image_handle(ctx);
  if (!handle || handle.code) throw new Error('no primary image');
  const image = new mod.HeifImage(handle);
  const width = image.get_width(), height = image.get_height();
  const imageData = { data: new Uint8ClampedArray(width * height * 4), width, height };
  return new Promise((resolve, reject) => {
    image.display(imageData, (d) => {
      mod.heif_context_free(ctx);
      d ? resolve({ imageData, width, height }) : reject(new Error('corrupt or truncated'));
    });
  });
}

const stats = (d) => {
  let nonZero = 0, opaque = 0;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] | d[i + 1] | d[i + 2]) nonZero++;
    if (d[i + 3] === 255) opaque++;
    if (colors.size < 500) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  return { nonZero, opaque, colors: colors.size };
};

console.log('\n── decode sample.heic (primary image) ──────────────────');
const t0 = performance.now();
const r = await decodePrimary(sample);
const ms = performance.now() - t0;
const s = stats(r.imageData.data);
ok('non-zero dimensions', r.width > 0 && r.height > 0, `${r.width} x ${r.height}`);
ok('pixels not all-zero', s.nonZero > 0, `${s.nonZero}/${r.width * r.height} non-black`);
ok('pixels not all-transparent', s.opaque === r.width * r.height);
ok('real image content', s.colors > 10, `${s.colors}+ distinct colours`);
console.log(`      DECODE TIME = ${ms.toFixed(1)} ms`);

console.log('\n── decode tiny.heic (the native-detection probe) ───────');
const t1 = performance.now();
const rt = await decodePrimary(tiny);
ok('probe decodes to exactly 64x64', rt.width === 64 && rt.height === 64, `${rt.width} x ${rt.height}`);
ok('probe has real pixels', stats(rt.imageData.data).nonZero > 0, `${(performance.now() - t1).toFixed(1)} ms`);

console.log('\n── error paths ─────────────────────────────────────────');
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
ok('non-HEIC input rejects',
  !!(await throws(() => decodePrimary(Buffer.from('x'.repeat(3000))))),
  JSON.stringify(await throws(() => decodePrimary(Buffer.from('x'.repeat(3000))))));
ok('truncated HEIC rejects',
  !!(await throws(() => decodePrimary(sample.subarray(0, 5000)))),
  JSON.stringify(await throws(() => decodePrimary(sample.subarray(0, 5000)))));

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
