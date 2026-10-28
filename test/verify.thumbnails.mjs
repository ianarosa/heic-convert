/**
 * Browser verification for queue thumbnails (createQueue({ thumbnails: true })).
 *
 * Asserts on real decoded pixels (a thumbnail must decode to a small image at the right
 * longest side), on backwards-compat (no option -> no thumbnail, no cost), and on the
 * object-URL lifecycle by SPYING on URL.createObjectURL/revokeObjectURL and counting — a
 * leak is created != revoked.
 *
 * Run:  node test/verify.thumbnails.mjs   (Windows node; see test/README.md for WSL paths)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
const info = (msg) => console.log(`      ${msg}`);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('FAIL  could not find Chrome. Tried:\n' + CHROME_CANDIDATES.join('\n'));
  process.exit(1);
}
console.log(`Chrome: ${chrome}\n`);

const { server, port } = await listen(path.resolve(HERE, '..'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
  protocolTimeout: 120000,
});

const consoleErrors = [];
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));

  await page.goto(`http://127.0.0.1:${port}/test/harness.encode.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });

  // Spy on object-URL create/revoke for the whole run so we can prove the lifecycle.
  await page.evaluate(() => {
    window.__urls = { created: new Set(), revoked: new Set() };
    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj) => { const u = realCreate(obj); window.__urls.created.add(u); return u; };
    URL.revokeObjectURL = (u) => { window.__urls.revoked.add(u); return realRevoke(u); };
  });

  // ── thumbnails: true — every done item gets a valid small preview ───────────────────
  console.log('── thumbnails: true — real small previews ──────────────');
  const withThumbs = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 8 }, (_, i) =>
      new File([blob], `IMG_${i}.HEIC`, { type: 'image/heic', lastModified: Date.now() }));
    const q = window.__queue.createQueue({ format: 'image/jpeg', thumbnails: true, thumbnailSize: 160 });
    const items = q.addAll(files);
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); res(); }
    }, 10); });

    // Decode each thumbnail back and measure it.
    const dims = [];
    for (const it of items) {
      if (typeof it.thumbnail !== 'string') { dims.push(null); continue; }
      const tb = await (await fetch(it.thumbnail)).blob();
      const bmp = await createImageBitmap(tb);
      dims.push({ w: bmp.width, h: bmp.height, type: tb.type, bytes: tb.size,
                  isBlobUrl: it.thumbnail.startsWith('blob:') });
      bmp.close();
    }
    const out = {
      done: items.filter((i) => i.status === 'done').length,
      allHaveThumb: items.every((i) => typeof i.thumbnail === 'string'),
      dims,
    };
    q.dispose(); // also frees this queue's previews so the whole-run ledger stays honest
    return out;
  });
  ok('all 8 items converted', withThumbs.done === 8, `${withThumbs.done}/8`);
  ok('every done item has an item.thumbnail string', withThumbs.allHaveThumb);
  ok('each thumbnail is a blob: object URL', withThumbs.dims.every((d) => d && d.isBlobUrl));
  ok('each thumbnail decodes to a JPEG', withThumbs.dims.every((d) => d && d.type === 'image/jpeg'));
  ok('each thumbnail longest side is 160 px', withThumbs.dims.every((d) => d && Math.max(d.w, d.h) === 160),
    withThumbs.dims.map((d) => d && `${d.w}x${d.h}`).join(', '));
  ok('each thumbnail is tiny (< 20 KB)', withThumbs.dims.every((d) => d && d.bytes < 20000),
    `avg ${(withThumbs.dims.reduce((n, d) => n + (d ? d.bytes : 0), 0) / withThumbs.dims.length / 1024).toFixed(1)} KB`);

  // ── custom thumbnailSize ────────────────────────────────────────────────────────────
  console.log('\n── thumbnailSize is honoured ───────────────────────────');
  const customSize = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const q = window.__queue.createQueue({ thumbnails: true, thumbnailSize: 64 });
    const item = q.add(new File([blob], 'x.HEIC', { type: 'image/heic' }));
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if (item.status === 'done' || item.status === 'error') { clearInterval(t); res(); }
    }, 10); });
    const tb = await (await fetch(item.thumbnail)).blob();
    const bmp = await createImageBitmap(tb);
    const d = { w: bmp.width, h: bmp.height }; bmp.close();
    q.dispose();
    return d;
  });
  ok('thumbnailSize: 64 -> 64 px longest side', Math.max(customSize.w, customSize.h) === 64,
    `${customSize.w}x${customSize.h}`);

  // ── backwards compatible: no option -> no thumbnail, no cost ─────────────────────────
  console.log('\n── thumbnails OFF (default) — no thumbnail at all ──────');
  const withoutThumbs = await page.evaluate(async () => {
    const createdBefore = window.__urls.created.size;
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 5 }, (_, i) => new File([blob], `n_${i}.HEIC`, { type: 'image/heic' }));
    const q = window.__queue.createQueue({ format: 'image/jpeg' }); // no thumbnails
    const items = q.addAll(files);
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); res(); }
    }, 10); });
    return {
      done: items.filter((i) => i.status === 'done').length,
      anyThumb: items.some((i) => i.thumbnail !== undefined),
      urlsCreated: window.__urls.created.size - createdBefore,
    };
  });
  ok('conversion still works with thumbnails off', withoutThumbs.done === 5, `${withoutThumbs.done}/5`);
  ok('NO item has a thumbnail when the option is off', withoutThumbs.anyThumb === false);
  ok('and NOT ONE object URL was created (zero cost)', withoutThumbs.urlsCreated === 0,
    `${withoutThumbs.urlsCreated} created`);

  // ── lifecycle: clear() revokes every thumbnail URL ─────────────────────────────────
  console.log('\n── lifecycle: clear() revokes all previews (no leak) ───');
  const clearCycle = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 10 }, (_, i) => new File([blob], `c_${i}.HEIC`, { type: 'image/heic' }));
    const q = window.__queue.createQueue({ thumbnails: true });
    const items = q.addAll(files);
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); res(); }
    }, 10); });

    const thumbUrls = items.map((i) => i.thumbnail).filter((u) => typeof u === 'string');
    const revokedBefore = thumbUrls.filter((u) => window.__urls.revoked.has(u)).length;
    q.clear();
    const stillSet = items.filter((i) => i.thumbnail !== undefined).length;
    const revokedAfter = thumbUrls.filter((u) => window.__urls.revoked.has(u)).length;
    return { count: thumbUrls.length, revokedBefore, revokedAfter, stillSet, itemsLen: q.items.length };
  });
  ok('10 thumbnails were created', clearCycle.count === 10, `${clearCycle.count}`);
  ok('none were revoked before clear()', clearCycle.revokedBefore === 0);
  ok('clear() revoked ALL 10 thumbnail URLs', clearCycle.revokedAfter === 10, `${clearCycle.revokedAfter}/10`);
  ok('clear() also unset item.thumbnail', clearCycle.stillSet === 0);
  ok('clear() emptied the queue', clearCycle.itemsLen === 0);

  // ── lifecycle: remove(id) and a full build/clear cycle leak nothing ────────────────
  console.log('\n── lifecycle: remove(id) + overall create==revoke ──────');
  const removeCycle = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const q = window.__queue.createQueue({ thumbnails: true });
    const a = q.add(new File([blob], 'a.HEIC', { type: 'image/heic' }));
    const b = q.add(new File([blob], 'b.HEIC', { type: 'image/heic' }));
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if ([a, b].every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); res(); }
    }, 10); });
    const aUrl = a.thumbnail;
    q.remove(a.id);
    const aRevoked = window.__urls.revoked.has(aUrl);
    const aUnset = a.thumbnail === undefined;
    q.clear();
    return { aRevoked, aUnset };
  });
  ok('remove(id) revokes that item’s thumbnail', removeCycle.aRevoked);
  ok('remove(id) unsets item.thumbnail', removeCycle.aUnset);

  // The whole-run ledger: every object URL this suite created has now been revoked.
  const ledger = await page.evaluate(() => ({
    created: window.__urls.created.size,
    revoked: [...window.__urls.created].filter((u) => window.__urls.revoked.has(u)).length,
  }));
  ok('NO LEAK: every thumbnail object URL created across the whole run was revoked',
    ledger.created > 0 && ledger.revoked === ledger.created, `${ledger.revoked}/${ledger.created} revoked`);

  // ── memory cost of 200 thumbnails ──────────────────────────────────────────────────
  console.log('\n── memory: 200 thumbnails are negligible ───────────────');
  const mem = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 200 }, (_, i) => new File([blob], `m_${i}.HEIC`, { type: 'image/heic' }));
    const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
    let peak = before;
    const s = setInterval(() => { if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize); }, 30);
    const q = window.__queue.createQueue({ thumbnails: true, format: 'image/jpeg' });
    const items = q.addAll(files);
    const t = performance.now();
    await new Promise((res) => { q.start(); const tm = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(tm); res(); }
    }, 10); });
    clearInterval(s);
    const ms = performance.now() - t;
    const withThumb = items.filter((i) => typeof i.thumbnail === 'string').length;
    let thumbBytes = 0;
    for (const i of items.slice(0, 20)) {
      if (typeof i.thumbnail === 'string') thumbBytes += (await (await fetch(i.thumbnail)).blob()).size;
    }
    q.clear();
    return { withThumb, ms, peakMB: peak / 1048576, beforeMB: before / 1048576,
             avgThumbKB: thumbBytes / 20 / 1024 };
  });
  ok('all 200 items got a thumbnail', mem.withThumb === 200, `${mem.withThumb}/200`);
  info(`200 thumbnails: peak JS heap ${mem.peakMB.toFixed(0)} MB (from ${mem.beforeMB.toFixed(0)} MB), avg thumb ${mem.avgThumbKB.toFixed(1)} KB`);
  info(`total thumbnail payload for 200 ~ ${(mem.avgThumbKB * 200 / 1024).toFixed(1)} MB of tiny JPEGs`);
  ok('200 thumbnails cost is small (peak heap grew < 150 MB, and the full images dwarf them)',
    mem.peakMB - mem.beforeMB < 150, `grew ${(mem.peakMB - mem.beforeMB).toFixed(0)} MB`);

  // ── console cleanliness ────────────────────────────────────────────────────────────
  console.log('\n── console cleanliness ─────────────────────────────────');
  ok('zero pageerrors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('zero console errors / failed requests', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
