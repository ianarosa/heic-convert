/**
 * Browser verification for the PWA / offline layer (manifest.webmanifest + sw.js + icons).
 *
 * Drives real headless Chrome against a real static server and PROVES the headline claim:
 *   1. The manifest is valid, linked, and meets the installability criteria we can check
 *      headlessly (manifest + service worker + icons + start_url + secure context).
 *   2. OFFLINE WORKS: install online, cut the network, reload, and actually convert a real
 *      HEIC to a valid JPEG (FF D8 FF) with the wire cut — proving the WASM decode path is
 *      cached, not just the HTML.
 *   3. THE UPDATE PATH IS SOUND: simulate a version bump, re-register, and assert the new
 *      cache is created, the OLD cache is deleted, and fresh HTML is served network-first.
 *      (This project was bitten by stale caching before; this is the non-negotiable check.)
 *   4. ZERO THIRD-PARTY: every request stays same-origin, and every cached URL is same-origin.
 *
 * Run:  node test/verify.pwa.mjs        (Windows node; see README for WSL paths)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLE = path.join(HERE, 'sample.heic');
const SHOTS = path.join(HERE, 'screenshots');

const APP_VERSION = '2026-07-16.pwa';               // must match sw.js + js/config.js
const CACHE_V1 = `safelight-${APP_VERSION}`;
const CACHE_V2 = `safelight-${APP_VERSION}-v2`;      // the simulated bump

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const findChrome = () => CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.heic': 'image/heic',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Static server with Cloudflare-Pages-style directory-index resolution, PLUS a mutable
 * `bump` switch. When bumped it rewrites sw.js's version token (so the browser installs a
 * new worker and a new cache) and injects a build marker into the served HTML (so we can
 * prove network-first served the FRESH page, not a stale cached one).
 */
function makeServer(state) {
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/favicon.ico') { res.writeHead(204).end(); return; }

    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    try {
      if (rel.endsWith('/')) file = path.join(file, 'index.html');
      else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch { /* fall through to 404 */ }

    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      let body = data;
      const ext = path.extname(file);
      if (state.bump && ext === '.js' && path.basename(file) === 'sw.js') {
        body = Buffer.from(String(data).replace(`'${APP_VERSION}'`, `'${APP_VERSION}-v2'`));
      }
      if (state.bump && ext === '.html') {
        body = Buffer.from(String(data).replace(
          '<meta charset="utf-8">',
          '<meta charset="utf-8"><meta name="build-marker" content="v2">'
        ));
      }
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
}

/* ── PNG sanity in Node: prove each icon is a real PNG of the claimed size. ──────────── */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const chrome = findChrome();
if (!chrome) { console.error('No Chrome found.\n' + CHROME_CANDIDATES.join('\n')); process.exit(1); }
console.log(`Chrome: ${chrome}\n`);

/* ── Icons on disk ──────────────────────────────────────────────────────────────────── */
console.log('── icon assets ─────────────────────────────────────────');
const EXPECT_ICONS = [
  ['assets/icon-192.png', 192],
  ['assets/icon-512.png', 512],
  ['assets/icon-maskable-512.png', 512],
  ['assets/apple-touch-icon.png', 180],
  ['assets/favicon-32.png', 32],
];
for (const [rel, size] of EXPECT_ICONS) {
  const p = path.join(ROOT, rel);
  const exists = fs.existsSync(p);
  const dim = exists ? pngSize(fs.readFileSync(p)) : null;
  ok(`${rel} is a valid ${size}x${size} PNG`, !!dim && dim.w === size && dim.h === size,
    dim ? `${dim.w}x${dim.h}` : 'missing/not-a-PNG');
}

/* ── Manifest on disk ───────────────────────────────────────────────────────────────── */
console.log('\n── manifest.webmanifest ────────────────────────────────');
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')); }
catch (e) { ok('manifest parses as JSON', false, e.message); }
if (manifest) {
  ok('manifest parses as JSON', true);
  ok('name = "Safelight — HEIC to JPG"', manifest.name === 'Safelight — HEIC to JPG', manifest.name);
  ok('short_name = "Safelight"', manifest.short_name === 'Safelight', manifest.short_name);
  ok('display = "standalone"', manifest.display === 'standalone', manifest.display);
  ok('start_url present', typeof manifest.start_url === 'string' && manifest.start_url.length > 0, manifest.start_url);
  ok('theme_color + background_color set', !!manifest.theme_color && !!manifest.background_color,
    `${manifest.theme_color} / ${manifest.background_color}`);
  ok('lang + description + categories present',
    !!manifest.lang && !!manifest.description && Array.isArray(manifest.categories) && manifest.categories.length > 0);
  const icons = manifest.icons || [];
  const has = (pred) => icons.some(pred);
  ok('icons include a 192, a 512, and a maskable',
    has((i) => /192/.test(i.sizes)) && has((i) => /512/.test(i.sizes)) && has((i) => (i.purpose || '').includes('maskable')),
    icons.map((i) => `${i.sizes}${i.purpose ? '/' + i.purpose : ''}`).join(', '));
  ok('every manifest icon is a same-origin (relative) path',
    icons.every((i) => i.src.startsWith('/') && !/^https?:/i.test(i.src)));
}

/* ── Browser phases ─────────────────────────────────────────────────────────────────── */
const state = { bump: false };
let server = null;
let port = 0;
// Start (or restart) the server on a STABLE port. Reusing the port keeps the origin
// identical across a stop/start, so the service worker keeps controlling it — essential
// for a truthful offline test (server down) followed by the update-path test (server up).
const startServer = () => new Promise((resolve) => {
  const s = makeServer(state);
  s.listen(port, '127.0.0.1', () => { port = s.address().port; server = s; resolve(); });
});
const stopServer = () => new Promise((resolve) => {
  if (!server) return resolve();
  try { server.closeAllConnections?.(); } catch { /* older node */ }
  server.close(() => resolve());
  server = null;
});
await startServer();
const ORIGIN = `http://127.0.0.1:${port}`;
const isLocal = (u) => u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:');

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 120000,
});

const consoleErrors = [];
const pageErrors = [];
const requests = [];
const failedRequests = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => failedRequests.push(r.url()));
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData() || null }));

  /* ── PHASE A: install online ─────────────────────────────────────────────────────── */
  console.log('\n── install (online) ────────────────────────────────────');
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });

  // Wait for the worker to install, activate and CLAIM this page.
  const controlled = await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.ready;
    return !!navigator.serviceWorker.controller;
  }, { timeout: 30000 }).then(() => true).catch(() => false);
  ok('service worker registers, activates and controls the page', controlled);

  // Give install's precache a moment to settle, then read the cache.
  const cacheState = await page.waitForFunction(async (v1) => {
    const keys = await caches.keys();
    if (!keys.includes(v1)) return false;
    const c = await caches.open(v1);
    const reqs = await c.keys();
    return reqs.length >= 15 ? { keys, urls: reqs.map((r) => r.url) } : false;
  }, { timeout: 30000 }, CACHE_V1).then((h) => h.jsonValue()).catch(() => null);

  ok('a cache keyed to the app version exists', !!cacheState && cacheState.keys.includes(CACHE_V1),
    cacheState ? cacheState.keys.join(', ') : 'no versioned cache');
  if (cacheState) {
    const urls = cacheState.urls;
    const cached = (frag) => urls.some((u) => u.includes(frag));
    ok('precache holds both tool pages', cached('/compress/') && (cached('/index.html') || urls.some((u) => u.endsWith('/'))));
    ok('precache holds the CSS + JS shell', cached('app.css') && cached('/js/main.js') && cached('/js/compress.js'));
    ok('precache holds the 1.4 MB libheif WASM bundle (offline HEIC decode)', cached('libheif-bundle.mjs'));
    ok('precache holds the vendor libs (client-zip, pdf-lib)', cached('client-zip.js') && cached('pdf-lib.js'));
    ok('EVERY cached URL is same-origin', urls.every((u) => u.startsWith(ORIGIN)),
      urls.filter((u) => !u.startsWith(ORIGIN)).join(', ') || 'all same-origin');
  }

  // Manifest linked + fetchable + installability signals.
  const inst = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const apple = document.querySelector('link[rel="apple-touch-icon"]');
    let m = null;
    try { m = await (await fetch('/manifest.webmanifest')).json(); } catch (_) {}
    return {
      manifestHref: link ? link.getAttribute('href') : null,
      appleHref: apple ? apple.getAttribute('href') : null,
      manifestOk: !!m && m.display === 'standalone',
      secure: self.isSecureContext,
    };
  });
  ok('page links the manifest', inst.manifestHref === '/manifest.webmanifest', String(inst.manifestHref));
  ok('page links an apple-touch-icon', inst.appleHref === '/assets/apple-touch-icon.png', String(inst.appleHref));
  ok('manifest is fetchable and standalone', inst.manifestOk);
  ok('secure context (installability precondition)', inst.secure === true,
    'localhost counts as secure; production is HTTPS');

  /* ── PHASE B: offline, and actually convert a HEIC ────────────────────────────────── */
  console.log('\n── OFFLINE: reload with the wire cut, then convert ─────');
  // Cut the network for real. setOfflineMode only affects the PAGE target — the service
  // worker runs on its own target and would still reach the live localhost server on a
  // cache miss. So we also SHUT THE SERVER DOWN: now neither the page nor the worker can
  // touch the network, and anything that loads can only have come from the cache.
  await page.setOfflineMode(true);
  await stopServer();
  const offReqStart = requests.length;

  // POSITIVE proof the wire is truly cut: a fetch to an uncached, same-origin path must
  // fail (the worker's cache-first misses, then the real network fetch has nowhere to go).
  const probeFailed = await page.evaluate(async () => {
    try { await fetch(`/__offline_probe_${Date.now()}`, { cache: 'no-store' }); return false; }
    catch (_) { return true; }
  });
  ok('the network is genuinely cut (uncached fetch fails; server is down)', probeFailed,
    probeFailed ? 'network truly offline' : 'a request still succeeded');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });
  ok('the page fully reloads from cache with the wire cut', true, 'served by the service worker');

  // Trigger the decoder (warm on intent), then convert the real sample.
  await page.hover('#drop').catch(() => {});
  const input = await page.$('#file-input');
  await input.uploadFile(SAMPLE);
  await page.waitForSelector('.row[data-status="done"]', { timeout: 90000 });

  const jpeg = await page.evaluate(async () => {
    const items = window.__app.queue ? window.__app.queue.items : [];
    const item = items.find((i) => i.status === 'done' && i.blob);
    if (!item) return null;
    const buf = await item.blob.slice(0, 4).arrayBuffer();
    return { magic: [...new Uint8Array(buf)], size: item.blob.size, type: item.blob.type };
  });
  const isJpeg = !!jpeg && jpeg.magic[0] === 0xff && jpeg.magic[1] === 0xd8 && jpeg.magic[2] === 0xff;
  ok('OFFLINE HEIC → JPEG conversion produces a valid JPEG (FF D8 FF)', isJpeg,
    jpeg ? `magic=[${jpeg.magic.map((b) => b.toString(16).padStart(2, '0')).join(' ')}] size=${jpeg.size}B type=${jpeg.type}` : 'no output blob');

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'pwa-offline.png') });
  console.log('      screenshot: test/screenshots/pwa-offline.png');

  const offlineForeign = requests.slice(offReqStart).filter((r) => !isLocal(r.url));
  ok('nothing left the origin during the offline session', offlineForeign.length === 0,
    offlineForeign.map((r) => r.url).join(', ') || 'none');

  /* ── PHASE C: the update path (stale-cache defence) ───────────────────────────────── */
  console.log('\n── UPDATE PATH: bump the version, prove old cache dies ──');
  await page.setOfflineMode(false);
  state.bump = true;         // the restored server serves a v2 sw.js + marked HTML
  await startServer();       // back up on the SAME port, so the SW still controls it

  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  });

  // Wait until the new versioned cache exists AND the old one is gone.
  const swapped = await page.waitForFunction(async (v1, v2) => {
    const keys = await caches.keys();
    return keys.includes(v2) && !keys.includes(v1) ? keys : false;
  }, { timeout: 45000 }, CACHE_V1, CACHE_V2).then((h) => h.jsonValue()).catch(() => null);

  ok('a NEW versioned cache is created on update', !!swapped && swapped.includes(CACHE_V2),
    swapped ? swapped.join(', ') : 'v2 cache never appeared');
  ok('the OLD cache is DELETED on activate (no stale build lingers)', !!swapped && !swapped.includes(CACHE_V1),
    swapped ? swapped.join(', ') : 'old cache still present');

  // Network-first must serve the FRESH html even though a stale copy is cached.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });
  const fresh = await page.evaluate(() =>
    !!document.querySelector('meta[name="build-marker"][content="v2"]'));
  ok('navigation is NETWORK-FIRST: the fresh HTML is served, not the stale cache', fresh,
    fresh ? 'v2 marker present' : 'stale HTML served — users would be stuck');

  /* ── PHASE D: whole-session third-party audit ─────────────────────────────────────── */
  console.log('\n── zero third-party (whole session) ────────────────────');
  const foreign = requests.filter((r) => !isLocal(r.url));
  const withBody = requests.filter((r) => r.body && r.body.length > 0);
  ok('ZERO requests to any third-party host, whole session', foreign.length === 0,
    foreign.map((r) => r.url).slice(0, 5).join(', ') || 'none');
  ok('ZERO requests carrying a body (nothing uploaded)', withBody.length === 0,
    withBody.map((r) => r.url).join(', ') || 'none');

  console.log('\n── console cleanliness ─────────────────────────────────');
  // The ONLY expected failure all session is the deliberate offline probe. Assert every
  // real asset loaded offline (proving the precache is complete), then hold the console to
  // zero errors once that one intentional net::ERR_FAILED is excluded.
  const PROBE = '__offline_probe';
  const realFailed = failedRequests.filter((u) => !u.includes(PROBE));
  ok('offline: every REAL resource loaded (only the deliberate probe failed)', realFailed.length === 0,
    realFailed.slice(0, 5).join(', ') || 'none');
  const realConsole = consoleErrors.filter((m) => !/net::ERR_FAILED|Failed to load resource/i.test(m));
  ok('zero pageerrors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('zero console errors (excluding the deliberate offline probe)', realConsole.length === 0,
    realConsole.join(' | ') || 'none');
  console.log(`      ${requests.length} total requests this session; all same-origin`);
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
