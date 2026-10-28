/**
 * Browser verification for the HEIC decode foundation.
 *
 * Drives real headless Chrome (puppeteer-core + system Chrome) against a real static
 * server that sends NO COOP/COEP headers, and decodes a REAL HEIC file — asserting real
 * pixel output, not just that a promise resolved.
 *
 * Run:  node test/verify.mjs        (Windows node; see README notes for WSL paths)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'sample.heic');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

// ── ftyp magic-byte check: prove the sample is genuinely HEIC before we trust any decode.
function assertRealHeic(file) {
  const buf = fs.readFileSync(file);
  const boxType = buf.subarray(4, 8).toString('latin1');
  const brand = buf.subarray(8, 12).toString('latin1');
  const compatible = buf.subarray(16, Math.min(buf.length, 40)).toString('latin1');
  const VALID = ['heic', 'heix', 'mif1', 'heim', 'heis', 'hevc', 'msf1'];

  ok('sample.heic has an ftyp box', boxType === 'ftyp', `bytes 4-8 = "${boxType}"`);
  ok(
    'sample.heic declares a HEIC brand',
    VALID.includes(brand) || VALID.some((b) => compatible.includes(b)),
    `major brand "${brand}", compatible "${compatible.replace(/[^\x20-\x7e]/g, '.')}"`
  );
  console.log(`      sample.heic = ${buf.length} bytes`);
  return buf;
}

const chrome = findChrome();
if (!chrome) {
  console.error('FAIL  could not find Chrome. Tried:\n' + CHROME_CANDIDATES.join('\n'));
  process.exit(1);
}
console.log(`Chrome: ${chrome}\n`);

console.log('── sample file ─────────────────────────────────────────');
assertRealHeic(SAMPLE);

const { server, port } = await listen(path.resolve(HERE, '..'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 60000, // fail fast instead of hanging if a decode wedges
});

const consoleErrors = [];
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));

  await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });

  console.log('\n── environment ─────────────────────────────────────────');
  const env = await page.evaluate(() => ({
    crossOriginIsolated: self.crossOriginIsolated,
    hasSAB: typeof SharedArrayBuffer !== 'undefined',
    cores: navigator.hardwareConcurrency,
  }));
  ok('page is NOT cross-origin isolated (no COOP/COEP)', env.crossOriginIsolated === false,
    `crossOriginIsolated=${env.crossOriginIsolated}`);
  console.log(`      hardwareConcurrency=${env.cores}`);

  console.log('\n── native detection ────────────────────────────────────');
  const native = await page.evaluate(() => window.__decode.isNativeHeicSupported());
  ok('isNativeHeicSupported() returns a boolean', typeof native === 'boolean', `-> ${native}`);
  ok('Chrome reports NO native HEIC support (so WASM path is exercised)', native === false);

  console.log('\n── initDecoder ─────────────────────────────────────────');
  const initMs = await page.evaluate(async () => {
    const t = performance.now();
    await window.__decode.initDecoder();
    await window.__decode.initDecoder(); // idempotent
    return performance.now() - t;
  });
  ok('initDecoder() resolves and is safe to call twice', true, `${initMs.toFixed(0)} ms (warms whole pool)`);

  console.log('\n── decode real HEIC ────────────────────────────────────');
  const result = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const file = new File([blob], 'sample.heic', { type: 'image/heic' });

    const t = performance.now();
    const { bitmap, width, height } = await window.__decode.decodeHeic(file);
    const ms = performance.now() - t;

    // Read the real pixels back out of the returned ImageBitmap.
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, width, height).data;

    let nonZero = 0, opaque = 0;
    const hist = new Set();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] || px[i + 1] || px[i + 2]) nonZero++;
      if (px[i + 3] === 255) opaque++;
      if (hist.size < 500) hist.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    }
    return {
      ms, width, height,
      isBitmap: bitmap instanceof ImageBitmap,
      total: width * height,
      nonZero, opaque,
      distinctColors: hist.size,
      corner: [px[0], px[1], px[2], px[3]],
    };
  });

  ok('returns a real ImageBitmap', result.isBitmap);
  ok('non-zero dimensions', result.width > 0 && result.height > 0, `${result.width} x ${result.height}`);
  ok('pixels are NOT all-zero', result.nonZero > 0,
    `${result.nonZero}/${result.total} px non-black (${((result.nonZero / result.total) * 100).toFixed(1)}%)`);
  ok('pixels are NOT all-transparent', result.opaque === result.total, `${result.opaque}/${result.total} px opaque`);
  ok('image has real image content (not a flat fill)', result.distinctColors > 10,
    `${result.distinctColors}+ distinct colours`);
  console.log(`      first px RGBA = [${result.corner.join(', ')}]`);
  console.log(`      DECODE TIME = ${result.ms.toFixed(1)} ms`);

  console.log('\n── concurrency (queue.js calls decodeHeic N-up) ────────');
  const conc = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 8 }, (_, i) => new File([blob], `s${i}.heic`, { type: 'image/heic' }));
    const t = performance.now();
    const out = await Promise.all(files.map((f) => window.__decode.decodeHeic(f)));
    return {
      ms: performance.now() - t,
      count: out.length,
      allGood: out.every((r) => r.bitmap instanceof ImageBitmap && r.width === out[0].width && r.width > 0),
    };
  });
  ok('8 concurrent decodeHeic() calls all resolve correctly', conc.allGood && conc.count === 8,
    `${conc.ms.toFixed(0)} ms total for 8 (${(conc.ms / 8).toFixed(0)} ms/img wall-clock)`);

  console.log('\n── error handling ──────────────────────────────────────');
  const errs = await page.evaluate(async () => {
    const grab = async (fn) => { try { await fn(); return '<<no throw>>'; } catch (e) { return e.message; } };
    const sample = await (await fetch('/test/sample.heic')).arrayBuffer();
    return {
      notHeic: await grab(() => window.__decode.decodeHeic(
        new File([new Uint8Array(3000).fill(65)], 'a.txt', { type: 'text/plain' }))),
      truncated: await grab(() => window.__decode.decodeHeic(
        new File([sample.slice(0, 5000)], 't.heic', { type: 'image/heic' }))),
      empty: await grab(() => window.__decode.decodeHeic(new File([], 'e.heic'))),
      nothing: await grab(() => window.__decode.decodeHeic(null)),
    };
  });
  for (const [name, msg] of Object.entries(errs)) {
    ok(`${name}: throws a human-readable Error`, msg !== '<<no throw>>' && msg.length > 10 && /[a-z]/.test(msg),
      JSON.stringify(msg));
  }

  console.log('\n── still works after errors + dispose ───────────────────');
  const after = await page.evaluate(async () => {
    window.__decode.disposeDecoder();
    const blob = await (await fetch('/test/sample.heic')).blob();
    const r = await window.__decode.decodeHeic(new File([blob], 'again.heic', { type: 'image/heic' }));
    return { w: r.width, h: r.height, ok: r.bitmap instanceof ImageBitmap };
  });
  ok('pool rebuilds after disposeDecoder() and still decodes', after.ok && after.w > 0,
    `${after.w} x ${after.h}`);

  console.log('\n── console cleanliness ─────────────────────────────────');
  // libheif-js logs parse failures with console.log (not console.error), so the
  // deliberate corrupt-file tests above must not dirty this.
  ok('zero pageerrors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('zero console errors / failed requests', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
