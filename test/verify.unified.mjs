/**
 * Browser verification for the UNIFIED converter (js/queue.js + js/main.js + index.html).
 *
 * The converter at "/" now eats ANY image — HEIC/HEIF via libheif, and JPG/PNG/WebP natively
 * via createImageBitmap — and lets you pick the output. This suite asserts, in real headless
 * Chrome and on real bytes (never labels), the four things that change under that refactor:
 *
 *   1. A JPG input converts to a real JPG / PNG / WebP (magic bytes on the actual blob).
 *   2. A HEIC input (test/sample.heic) still converts to a real JPEG.
 *   3. THE LAZY-LOAD WIN: no libheif/WASM resource loads on page load, and none across a
 *      JPG-only conversion. The 1.4 MB decoder loads ONLY once a HEIC is actually processed.
 *      Measured on the PAGE's own resource timeline + captured requests. The service worker
 *      is blocked for this run so its background offline precache can't blur the measurement.
 *   4. /?to=jpg|png|webp preselects the matching output in the live DOM.
 *
 * Run:  "/mnt/c/Program Files/nodejs/node.exe" test/verify.unified.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLE = path.join(HERE, 'sample.heic');
const TMP = path.join(HERE, '.tmp-unified');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.error('FAIL  no Chrome found'); process.exit(1); }

fs.mkdirSync(TMP, { recursive: true });

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const isJpeg = (b) => b && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isWebp = (b) => b && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
const WASM_RE = /libheif|decode\.worker|decode\.js/;

const { server, port } = await listen(ROOT);
const ORIGIN = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 120000,
});

/** An ISOLATED browser context (its own localStorage, so one block's saved format can't leak
 *  into the next) whose page blocks the service worker — so the SW's background offline
 *  precache can't fetch libheif behind our backs and blur the lazy-load measurement — and
 *  records every request the PAGE makes. Close the returned context when done. */
async function freshPage() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const reqs = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    reqs.push(r.url());
    if (/\/sw\.js(\?|$)/.test(r.url())) return r.abort(); // no SW → no background WASM precache
    return r.continue();
  });
  return { context, page, reqs, pageErrors };
}

const pageResources = (page) =>
  page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));

const magicOf = (page, i = 0) => page.evaluate(async (idx) => {
  const item = window.__app.queue.items[idx];
  const buf = new Uint8Array(await item.blob.slice(0, 12).arrayBuffer());
  return { magic: [...buf], name: item.outputName, size: item.blob.size, type: item.blob.type };
}, i);

const waitConverted = (page, n = 1) => page.waitForFunction(
  (want) => {
    const q = window.__app && window.__app.queue;
    return q && q.stats.total >= want && q.stats.running === 0 && q.stats.pending === 0 && q.stats.done >= want;
  },
  { timeout: 60000 }, n);

// Draw a real JPEG in-browser and write it to disk (no fabricated bytes).
async function makeJpg(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1200, 900);
    grad.addColorStop(0, '#2b5a7a'); grad.addColorStop(0.5, '#c98b4b'); grad.addColorStop(1, '#6a3d5a');
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 900);
    for (let i = 0; i < 30; i++) {
      g.globalAlpha = 0.25; g.fillStyle = `hsl(${(i * 37) % 360} 60% 55%)`;
      g.beginPath(); g.arc((i * 197) % 1200, (i * 313) % 900, 40 + (i * 53) % 180, 0, Math.PI * 2); g.fill();
    }
    return c.toDataURL('image/jpeg', 0.92);
  });
  const p = path.join(TMP, 'photo.jpg');
  fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return p;
}

try {
  /* ── 1 + 3: JPG input → JPG/PNG/WebP output, and ZERO WASM the whole time ─────────── */
  console.log('── JPG input → real JPG/PNG/WebP, and the WASM never loads ──');
  {
    const { context, page, reqs, pageErrors } = await freshPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    // (3a) nothing heavy at page load.
    let res = await pageResources(page);
    ok('page load pulls NO libheif/decoder resource',
      !res.some((u) => WASM_RE.test(u)) && !reqs.some((u) => WASM_RE.test(u)),
      res.filter((u) => WASM_RE.test(u)).join(', ') || 'none');

    const jpg = await makeJpg(page);

    // Default output is JPG. A JPG in → a real JPG out.
    await (await page.$('#file-input')).uploadFile(jpg);
    await waitConverted(page, 1);
    let out = await magicOf(page);
    ok('JPG input → real JPEG output (FF D8 FF)', isJpeg(out.magic) && /\.jpg$/.test(out.name),
      out.magic.slice(0, 3).map((n) => n.toString(16)).join(' ') + ' ' + out.name);

    // Switch output to PNG, re-convert the same source.
    await page.evaluate(() => {
      document.querySelector('input[name=format][value="image/png"]').click();
      document.getElementById('reconvert').click();
    });
    await waitConverted(page, 1);
    out = await magicOf(page);
    ok('JPG input → real PNG output (89 50 4E 47)', isPng(out.magic) && /\.png$/.test(out.name),
      out.magic.slice(0, 4).map((n) => n.toString(16)).join(' ') + ' ' + out.name);

    // Switch output to WebP, re-convert.
    await page.evaluate(() => {
      document.querySelector('input[name=format][value="image/webp"]').click();
      document.getElementById('reconvert').click();
    });
    await waitConverted(page, 1);
    out = await magicOf(page);
    ok('JPG input → real WebP output (RIFF…WEBP)', isWebp(out.magic) && /\.webp$/.test(out.name),
      out.magic.map((n) => n.toString(16)).join(' ') + ' ' + out.name);

    // (3b) THE win: three JPG-input conversions and still not a single WASM byte.
    res = await pageResources(page);
    ok('a JPG-only session NEVER loads the 1.4 MB libheif decoder',
      !res.some((u) => WASM_RE.test(u)) && !reqs.some((u) => WASM_RE.test(u)),
      res.filter((u) => WASM_RE.test(u)).join(', ') || 'none');
    ok('no page errors during the JPG session', pageErrors.length === 0, pageErrors[0] || '');
    await context.close();
  }

  /* ── 2: HEIC input still converts, and THAT is when the WASM loads ─────────────────── */
  console.log('\n── HEIC input still converts; the WASM loads only now ──');
  {
    const { context, page, reqs, pageErrors } = await freshPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    let res = await pageResources(page);
    ok('before any HEIC, the decoder is still not loaded', !res.some((u) => WASM_RE.test(u)));

    await (await page.$('#file-input')).uploadFile(SAMPLE);
    await waitConverted(page, 1);
    const out = await page.evaluate(async () => {
      const item = window.__app.queue.items[0];
      const buf = new Uint8Array(await item.blob.slice(0, 3).arrayBuffer());
      const bmp = await createImageBitmap(item.blob); // decodes → proves a real image
      const dims = [bmp.width, bmp.height]; bmp.close();
      return { magic: [...buf], name: item.outputName, dims, type: item.blob.type };
    });
    ok('HEIC input → real JPEG output (FF D8 FF), decodes to 1440×960',
      isJpeg(out.magic) && out.dims[0] === 1440 && out.dims[1] === 960,
      `${out.magic.map((n) => n.toString(16)).join(' ')} ${out.dims.join('×')}`);

    res = await pageResources(page);
    ok('the 1.4 MB decoder loaded ONLY once a HEIC was processed',
      res.some((u) => /libheif|decode\.worker/.test(u)) || reqs.some((u) => /libheif|decode\.worker/.test(u)));
    ok('no page errors during the HEIC session', pageErrors.length === 0, pageErrors[0] || '');
    await context.close();
  }

  /* ── 4: /?to= preselects the matching output in the live DOM ───────────────────────── */
  console.log('\n── /?to= preselects the output in the live DOM ──');
  {
    const CASES = [
      ['?to=jpg', 'image/jpeg'], ['?to=png', 'image/png'], ['?to=webp', 'image/webp'],
      ['?to=jpeg', 'image/jpeg'], ['?to=WEBP', 'image/webp'],
      ['?to=bogus', 'image/jpeg'], ['', 'image/jpeg'], // invalid/absent → saved default (jpeg)
    ];
    const { context, page } = await freshPage();
    // Clear any persisted setting so the "default" cases test the real default.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.removeItem('safelight.settings.v1'));
    for (const [q, expect] of CASES) {
      await page.goto(`${ORIGIN}/${q}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true', { timeout: 20000 });
      const state = await page.evaluate(() => ({
        checked: (document.querySelector('#format input:checked') || {}).value || null,
        setting: window.__app.settings.format,
        persisted: localStorage.getItem('safelight.settings.v1'),
      }));
      const label = `/${q || '(no param)'}`.padEnd(16);
      ok(`${label} DOM radio = ${expect}`, state.checked === expect, `got ${state.checked}`);
      ok(`${label} settings.format = ${expect}`, state.setting === expect, `got ${state.setting}`);
      ok(`${label} did not auto-persist`, state.persisted === null, `persisted=${state.persisted}`);
    }
    await context.close();
  }
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
