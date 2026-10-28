/**
 * Browser verification for the image compressor (/compress/, js/compress.js, css/compress.css).
 *
 * Drives the REAL user flow in real headless Chrome. Nothing here trusts a label: every
 * claim is checked against actual bytes or actual decoded pixels.
 *
 *   • Test images are REAL — drawn to a <canvas> in the browser and encoded by the browser
 *     (a photographic image, a flat graphic, and a tiny already-small image). No fabricated
 *     image bytes.
 *   • Compression is asserted on bytes: a compressible image must come out SMALLER, and an
 *     already-small image must NOT be handed back larger (the "kept original" path).
 *   • Output format is asserted on magic bytes (FF D8 FF = JPEG, RIFF/WEBP = WebP).
 *   • Resize is asserted on the DECODED output dimensions, not the requested number.
 *   • The privacy claim is asserted from OUTSIDE the page: every request Chrome makes is
 *     recorded, and any third-party host or any request body is a failure.
 *
 * Run:  "/mnt/c/Program Files/nodejs/node.exe" test/verify.compress.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'screenshots');
const TMP = path.join(HERE, '.tmp-compress');

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

const findChrome = () => CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const chrome = findChrome();
if (!chrome) {
  console.error('FAIL  could not find Chrome. Tried:\n' + CHROME_CANDIDATES.join('\n'));
  process.exit(1);
}

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const { server, port } = await listen(ROOT);
const ORIGIN = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 120000,
});

const consoleErrors = [];
const pageErrors = [];
const requests = [];

const waitIdle = (page) =>
  page.waitForFunction(
    () => {
      const s = window.__compress && window.__compress.stats;
      return s && s.total > 0 && s.pending === 0 && s.running === 0;
    },
    { timeout: 30000 }
  );

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), postData: r.postData() || null }));

  console.log('── first load ──────────────────────────────────────────');
  const t0 = Date.now();
  // The static test server (server.mjs, which this harness must not edit) has no
  // directory-index resolution, so it can't map /compress/ -> /compress/index.html the way
  // Cloudflare Pages does in production. Request the file directly; it's the same bytes.
  await page.goto(`${ORIGIN}/compress/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });
  ok('page becomes interactive', true, `${Date.now() - t0} ms wall clock`);

  await page.waitForFunction(
    () => performance.getEntriesByName('first-contentful-paint').length > 0,
    { timeout: 10000 }
  );
  const paint = await page.evaluate(() => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      fcp: fcp ? fcp.startTime : null,
      transferred: performance.getEntriesByType('resource').reduce((n, e) => n + (e.transferSize || 0), 0),
    };
  });
  ok('first contentful paint is fast', paint.fcp !== null && paint.fcp < 1500,
    `FCP = ${paint.fcp === null ? 'n/a' : paint.fcp.toFixed(0) + ' ms'}, ${(paint.transferred / 1024).toFixed(0)} KB at first paint`);

  console.log('\n── the 1.4 MB HEIC WASM decoder never loads ────────────');
  // NOTE: js/encode.js (shared with the HEIC tool, and edited by another agent to add a PDF
  // feature) now statically imports js/decode.js, so a ~10 KB decode.js module rides along
  // as a transitive import of the shared encoder. That is fine: what actually costs first
  // paint is the 1.4 MB libheif WASM bundle and the decode workers, and those stay lazy —
  // the compressor never calls initDecoder(), so they are never fetched. We assert on the
  // heavy payload (the thing that matters), and prove it two ways.
  const heavy = requests.filter((r) => /libheif|decode\.worker|queue\.js|\.wasm/.test(r.url));
  ok('the 1.4 MB libheif WASM bundle + decode workers never load', heavy.length === 0,
    heavy.map((r) => r.url.replace(ORIGIN, '')).join(', ') || 'none');
  ok('first-paint transfer stays small (no big bundle)', paint.transferred < 500 * 1024,
    `${(paint.transferred / 1024).toFixed(0)} KB`);

  // ── Generate REAL test images in the browser (drawn + encoded by Chrome) ──────────
  console.log('\n── generating real test images in-browser ──────────────');
  const made = await page.evaluate(async () => {
    const enc = (canvas, type, q) => canvas.toDataURL(type, q);

    // 1) A photographic image: smooth gradients + soft shapes + light grain. Big at q0.98,
    //    compresses well at 0.8 — the normal compressor case.
    const photo = document.createElement('canvas');
    photo.width = 1600; photo.height = 1200;
    const pc = photo.getContext('2d');
    const g = pc.createLinearGradient(0, 0, 1600, 1200);
    g.addColorStop(0, '#2b5a7a'); g.addColorStop(0.5, '#c98b4b'); g.addColorStop(1, '#6a3d5a');
    pc.fillStyle = g; pc.fillRect(0, 0, 1600, 1200);
    for (let i = 0; i < 40; i++) {
      pc.globalAlpha = 0.25;
      pc.fillStyle = `hsl(${(i * 37) % 360} 60% 55%)`;
      pc.beginPath();
      pc.arc((i * 197) % 1600, (i * 313) % 1200, 60 + (i * 53) % 220, 0, Math.PI * 2);
      pc.fill();
    }
    pc.globalAlpha = 1;
    const grain = pc.getImageData(0, 0, 1600, 1200);
    for (let i = 0; i < grain.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      grain.data[i] += n; grain.data[i + 1] += n; grain.data[i + 2] += n;
    }
    pc.putImageData(grain, 0, 0);

    // 2) A flat graphic: solid blocks, sharp edges. A PNG's home turf.
    const flat = document.createElement('canvas');
    flat.width = 900; flat.height = 700;
    const fc = flat.getContext('2d');
    fc.fillStyle = '#eceef1'; fc.fillRect(0, 0, 900, 700);
    fc.fillStyle = '#b8430f'; fc.fillRect(80, 80, 360, 260);
    fc.fillStyle = '#1c6a56'; fc.fillRect(460, 360, 360, 260);
    fc.fillStyle = '#14161a'; fc.fillRect(80, 360, 360, 260);

    // 3) A tiny, already-small image: 16×16 solid. Re-encoding can only enlarge it —
    //    the kept-original case.
    const tiny = document.createElement('canvas');
    tiny.width = 16; tiny.height = 16;
    const tc = tiny.getContext('2d');
    tc.fillStyle = '#c98b4b'; tc.fillRect(0, 0, 16, 16);

    return {
      photo: enc(photo, 'image/jpeg', 0.98),
      flat: enc(flat, 'image/png'),
      tiny: enc(tiny, 'image/png'),
    };
  });

  const writeDataUrl = (name, dataUrl) => {
    const b64 = dataUrl.split(',')[1];
    const p = path.join(TMP, name);
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    return { path: p, size: fs.statSync(p).size };
  };
  const photoFile = writeDataUrl('photo.jpg', made.photo);
  const flatFile = writeDataUrl('flat.png', made.flat);
  const tinyFile = writeDataUrl('tiny.png', made.tiny);
  console.log(`      photo.jpg ${(photoFile.size / 1024).toFixed(0)} KB · flat.png ${(flatFile.size / 1024).toFixed(0)} KB · tiny.png ${tinyFile.size} B`);

  // ── Phase A: default settings (Keep format, quality 0.8, no resize) ───────────────
  console.log('\n── phase A: compress at defaults (keep / 0.8) ──────────');
  const netBefore = requests.length;
  const input = await page.$('#file-input');
  await input.uploadFile(photoFile.path, flatFile.path, tinyFile.path);
  await waitIdle(page);

  const itemsA = await page.evaluate(() => window.__compress.items);
  ok('all three files finished (no batch death)', itemsA.length === 3 && itemsA.every((i) => i.status === 'done'),
    itemsA.map((i) => `${i.name}:${i.status}`).join(', '));

  const photo = itemsA.find((i) => i.name === 'photo.jpg');
  const flat = itemsA.find((i) => i.name === 'flat.png');
  const tiny = itemsA.find((i) => i.name === 'tiny.png');

  const photoPct = photo ? Math.round((1 - photo.outputSize / photo.inputSize) * 100) : 0;
  ok('the photographic image got SMALLER', !!photo && photo.outputSize < photo.inputSize,
    photo ? `${(photo.inputSize / 1024).toFixed(0)} KB → ${(photo.outputSize / 1024).toFixed(0)} KB  (${photoPct}% saved)` : 'missing');

  const flatPct = flat ? Math.round((1 - flat.outputSize / flat.inputSize) * 100) : 0;
  console.log(`      flat.png: ${(flat.inputSize / 1024).toFixed(1)} KB → ${(flat.outputSize / 1024).toFixed(1)} KB  (${flatPct >= 0 ? flatPct + '% saved' : 'kept'})${flat && flat.kept ? '  [kept original]' : ''}`);

  ok('the tiny already-small image was KEPT, not enlarged',
    !!tiny && tiny.kept === true && tiny.outputSize <= tiny.inputSize,
    tiny ? `kept=${tiny.kept}, ${tiny.inputSize} B → ${tiny.outputSize} B` : 'missing');

  ok('NO finished file was handed back larger than its input (keep/no-resize)',
    itemsA.every((i) => i.outputSize <= i.inputSize),
    itemsA.map((i) => `${i.name}:${i.outputSize <= i.inputSize ? 'ok' : 'BIGGER'}`).join(', '));

  // Magic bytes on the real output blobs.
  const isJpeg = (b) => b && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng = (b) => b && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const photoMagic = await page.evaluate((id) => window.__compress.magic(id), photo.id);
  ok('photo output is a real JPEG (magic FF D8 FF)', isJpeg(photoMagic),
    photoMagic ? photoMagic.slice(0, 3).map((n) => n.toString(16)).join(' ') : 'null');
  const flatMagic = await page.evaluate((id) => window.__compress.magic(id), flat.id);
  ok('flat output keeps PNG format (magic 89 50 4E 47)', isPng(flatMagic),
    flatMagic ? flatMagic.slice(0, 4).map((n) => n.toString(16)).join(' ') : 'null');

  ok('no third-party request during compression', requests.slice(netBefore).every((r) => r.url.startsWith(ORIGIN)),
    requests.slice(netBefore).filter((r) => !r.url.startsWith(ORIGIN)).map((r) => r.url).join(', ') || 'none');
  ok('nothing was uploaded (no request bodies)', requests.every((r) => r.postData === null),
    requests.filter((r) => r.postData !== null).map((r) => r.url).join(', ') || 'none');

  // ── Phase B: the format control is GONE — the compressor no longer converts ────────
  // This tool now only shrinks; changing the file type lives in the converter at "/". So the
  // "Save as" segmented control must be absent, the tool must be pinned to "keep", and a JPEG
  // in must stay a JPEG out.
  console.log('\n── phase B: no format switch (compressor only shrinks) ──');
  const formatUi = await page.evaluate(() => ({
    seg: !!document.getElementById('format'),
    label: !!document.getElementById('format-label'),
    radios: document.querySelectorAll('#format input[name="format"]').length,
    savedFormat: window.__compress.settings.format,
  }));
  ok('the "Save as" format control is gone', !formatUi.seg && !formatUi.label && formatUi.radios === 0,
    JSON.stringify(formatUi));
  ok('the compressor is pinned to the source format (settings.format === "keep")',
    formatUi.savedFormat === 'keep', formatUi.savedFormat);
  ok('a JPEG in stays a JPEG out — no conversion happens', isJpeg(photoMagic),
    photoMagic ? photoMagic.slice(0, 3).map((n) => n.toString(16)).join(' ') : 'null');

  // ── Phase C: resize to 800px longest side, re-compress (format still kept) ─────────
  console.log('\n── phase C: resize longest side to 800 px ──────────────');
  await page.evaluate(() => {
    const sel = document.getElementById('resize');
    sel.value = '800';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('reconvert').click();
  });
  await waitIdle(page);
  const itemsC = await page.evaluate(() => window.__compress.items);
  const photoC = itemsC.find((i) => i.name.startsWith('photo'));
  const tinyC = itemsC.find((i) => i.name.startsWith('tiny'));
  const photoDims = await page.evaluate((id) => window.__compress.decodedDims(id), photoC.id);
  ok('resized photo decodes to 800 px on the longest side', !!photoDims && Math.max(...photoDims) === 800,
    photoDims ? `${photoDims[0]} × ${photoDims[1]}` : 'null');
  ok('resized photo keeps its 4:3 aspect ratio', !!photoDims && photoDims[0] === 800 && photoDims[1] === 600,
    photoDims ? `${photoDims[0]} × ${photoDims[1]}` : 'null');
  const tinyDims = await page.evaluate((id) => window.__compress.decodedDims(id), tinyC.id);
  ok('the 16 px image was NOT upscaled to 800', !!tinyDims && tinyDims[0] === 16 && tinyDims[1] === 16,
    tinyDims ? `${tinyDims[0]} × ${tinyDims[1]}` : 'null');

  // ── Screenshots: desktop + mobile, light + dark ───────────────────────────────────
  console.log('\n── screenshots ─────────────────────────────────────────');
  const shoot = async (name, width, height, scheme) => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setViewport({ width, height, deviceScaleFactor: scheme === 'dark' ? 1 : 1 });
    await new Promise((r) => setTimeout(r, 250));
    const p = path.join(SHOTS, name);
    await page.screenshot({ path: p });
    console.log(`      wrote ${path.relative(ROOT, p)}`);
  };
  await shoot('compress-desktop-light.png', 1280, 1000, 'light');
  await shoot('compress-desktop-dark.png', 1280, 1000, 'dark');
  await shoot('compress-mobile-light.png', 390, 780, 'light');
  await shoot('compress-mobile-dark.png', 390, 780, 'dark');

  console.log('\n── zero errors ─────────────────────────────────────────');
  ok('no pageerror events', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');
} catch (err) {
  console.error('\nUNCAUGHT', err);
  failures++;
} finally {
  await browser.close();
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
