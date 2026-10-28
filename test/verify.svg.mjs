/**
 * Browser verification for SVG vector-trace output (js/encode.js traceToSvg + vendor/
 * imagetracer.js + the js/main.js photo-guard), driven in real headless Chrome on real bytes.
 *
 * Asserts the four things the SVG feature promises:
 *   1. A FLAT-GRAPHIC input traces to a REAL vector SVG — the blob parses, starts with
 *      `<svg`, contains `<path`, is typed image/svg+xml, and the filename ends `.svg`.
 *   2. /?to=svg preselects SVG in the live DOM.
 *   3. ImageTracer LAZY-LOADS: no request on page load, none on a JPG→JPG run; it loads only
 *      when SVG output is actually produced. Measured on the page's own resource timeline +
 *      captured requests (the service worker is blocked so its background caching can't blur it).
 *   4. The photo-guard fires on a photo-like input (test/sample.heic) and stays quiet on a
 *      small flat graphic — honest, and never blocking.
 *
 * Run:  "/mnt/c/Program Files/nodejs/node.exe" test/verify.svg.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLE = path.join(HERE, 'sample.heic');
const TMP = path.join(HERE, '.tmp-svg');

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

const TRACER_RE = /imagetracer/i;

const { server, port } = await listen(ROOT);
const ORIGIN = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 120000,
});

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
    if (/\/sw\.js(\?|$)/.test(r.url())) return r.abort(); // no SW → no background precache noise
    return r.continue();
  });
  return { context, page, reqs, pageErrors };
}

const resources = (page) => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
const waitConverted = (page, n = 1) => page.waitForFunction(
  (want) => {
    const q = window.__app && window.__app.queue;
    return q && q.stats.total >= want && q.stats.running === 0 && q.stats.pending === 0 &&
      (q.stats.done + q.stats.errored) >= want;
  },
  { timeout: 60000 }, n);

// A genuinely FLAT graphic: a few solid rectangles, hard edges, tiny canvas → tiny clean SVG.
async function makeFlatPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#eceef1'; g.fillRect(0, 0, 400, 300);
    g.fillStyle = '#b8430f'; g.fillRect(40, 40, 150, 110);
    g.fillStyle = '#1c6a56'; g.fillRect(220, 150, 140, 110);
    g.fillStyle = '#14161a'; g.fillRect(40, 170, 120, 90);
    return c.toDataURL('image/png');
  });
  const p = path.join(TMP, 'logo.png');
  fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return p;
}
async function makeSmallJpg(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 400, 300);
    grad.addColorStop(0, '#2b5a7a'); grad.addColorStop(1, '#6a3d5a');
    g.fillStyle = grad; g.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/jpeg', 0.9);
  });
  const p = path.join(TMP, 'pic.jpg');
  fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return p;
}

try {
  /* ── 1 + 3: flat graphic → real SVG; tracer lazy-loads (not on load, not on JPG→JPG) ── */
  console.log('── flat graphic → real SVG; ImageTracer lazy-loads ──');
  {
    const { context, page, reqs, pageErrors } = await freshPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    let res = await resources(page);
    ok('page load pulls NO ImageTracer',
      !res.some((u) => TRACER_RE.test(u)) && !reqs.some((u) => TRACER_RE.test(u)),
      res.filter((u) => TRACER_RE.test(u)).join(', ') || 'none');

    const flatPng = await makeFlatPng(page);
    const smallJpg = await makeSmallJpg(page);

    // JPG → JPG (default output): must not touch the tracer.
    await (await page.$('#file-input')).uploadFile(smallJpg);
    await waitConverted(page, 1);
    res = await resources(page);
    ok('a JPG→JPG conversion NEVER loads ImageTracer',
      !res.some((u) => TRACER_RE.test(u)) && !reqs.some((u) => TRACER_RE.test(u)),
      res.filter((u) => TRACER_RE.test(u)).join(', ') || 'none');

    // Now switch output to SVG and trace the FLAT graphic.
    await page.evaluate(() => document.getElementById('clear-all').click());
    await page.evaluate(() => document.querySelector('input[name=format][value="image/svg+xml"]').click());
    await (await page.$('#file-input')).uploadFile(flatPng);
    await waitConverted(page, 1);

    const out = await page.evaluate(async () => {
      const item = window.__app.queue.items[0];
      const text = await item.blob.text();
      return {
        type: item.blob.type, name: item.outputName, size: item.blob.size,
        head: text.slice(0, 400), hasSvg: text.includes('<svg'), hasPath: text.includes('<path'),
        status: item.status,
      };
    });
    ok('flat graphic → output is typed image/svg+xml', out.type === 'image/svg+xml', out.type);
    ok('flat graphic → SVG starts with <svg and has <path (real vector)',
      out.hasSvg && out.hasPath, `hasSvg=${out.hasSvg} hasPath=${out.hasPath}`);
    ok('flat graphic → SVG parses as XML', await page.evaluate(async () => {
      const t = await window.__app.queue.items[0].blob.text();
      const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
      return !doc.querySelector('parsererror') && doc.documentElement.tagName.toLowerCase() === 'svg';
    }));
    ok('the output filename ends .svg', /\.svg$/.test(out.name), out.name);

    res = await resources(page);
    ok('ImageTracer loaded ONLY once SVG was produced',
      res.some((u) => TRACER_RE.test(u)) || reqs.some((u) => TRACER_RE.test(u)));
    ok('no page errors', pageErrors.length === 0, pageErrors[0] || '');
    await context.close();
  }

  /* ── 4: photo-guard — quiet on flat graphic, fires on a photo ─────────────────────── */
  console.log('\n── photo-guard: quiet on flat art, fires on a photo ──');
  {
    const { context, page } = await freshPage();
    // SVG output preselected via ?to=svg.
    await page.goto(`${ORIGIN}/?to=svg`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    // Flat graphic first — the guard must stay quiet (this is the case SVG is FOR).
    const flatPng = await makeFlatPng(page);
    await (await page.$('#file-input')).uploadFile(flatPng);
    await waitConverted(page, 1);
    const quiet = await page.evaluate(() => {
      const el = document.getElementById('svg-warning');
      return { hidden: el.hidden, text: el.textContent };
    });
    ok('photo-guard stays QUIET on a small flat graphic', quiet.hidden === true,
      quiet.hidden ? 'hidden' : `shown: "${quiet.text}"`);

    // Clear, then a real photo (sample.heic, a camera format) — the guard must fire.
    await page.evaluate(() => document.getElementById('clear-all').click());
    await (await page.$('#file-input')).uploadFile(SAMPLE);
    await waitConverted(page, 1);
    const fired = await page.evaluate(() => {
      const el = document.getElementById('svg-warning');
      return { hidden: el.hidden, text: el.textContent };
    });
    ok('photo-guard FIRES on a photo (sample.heic)', fired.hidden === false,
      fired.hidden ? 'stayed hidden' : 'shown');
    ok('photo-guard message names the photo problem plainly',
      /photo/i.test(fired.text) && /(blurr|posteris|large)/i.test(fired.text), `"${fired.text}"`);
    await context.close();
  }

  /* ── 2: /?to=svg preselects SVG in the live DOM ───────────────────────────────────── */
  console.log('\n── /?to=svg preselects SVG in the live DOM ──');
  {
    const { context, page } = await freshPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.removeItem('safelight.settings.v1'));
    await page.goto(`${ORIGIN}/?to=svg`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    const state = await page.evaluate(() => ({
      checked: (document.querySelector('#format input:checked') || {}).value || null,
      setting: window.__app.settings.format,
      persisted: localStorage.getItem('safelight.settings.v1'),
    }));
    ok('/?to=svg checks the SVG radio', state.checked === 'image/svg+xml', `got ${state.checked}`);
    ok('/?to=svg sets settings.format to SVG', state.setting === 'image/svg+xml', `got ${state.setting}`);
    ok('/?to=svg does not auto-persist', state.persisted === null, `persisted=${state.persisted}`);
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
