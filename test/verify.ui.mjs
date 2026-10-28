/**
 * Browser verification for the UI (index.html + js/main.js + js/ui.js).
 *
 * Drives the REAL user flow in real headless Chrome: load the page, put a real HEIC into
 * the file input, wait for the app's own done state, and read the resulting bytes back to
 * prove they're a JPEG. Nothing here stubs the decoder.
 *
 * It also asserts the product's central claim the only way that's worth anything —
 * by watching the network from outside the page: every request Chrome makes is recorded,
 * and any request to a third-party host, or any request carrying a body, is a failure.
 *
 * Run:  node test/verify.ui.mjs        (Windows node; see README for WSL paths)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLE = path.join(HERE, 'sample.heic');
const SHOTS = path.join(HERE, 'screenshots');
const TMP = path.join(HERE, '.tmp-ui');

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

// A batch needs distinct filenames, and a corrupt file needs to be genuinely corrupt.
const sampleBytes = fs.readFileSync(SAMPLE);
/** 200 is the batch size this product promises to handle, so it's the batch we test. */
const BATCH = 200;
const copies = [];
for (let i = 0; i < BATCH; i++) {
  const p = path.join(TMP, `IMG_${1000 + i}.HEIC`);
  fs.writeFileSync(p, sampleBytes);
  copies.push(p);
}
const CORRUPT = path.join(TMP, 'not-a-photo.heic');
fs.writeFileSync(CORRUPT, Buffer.from('This is a text file wearing a .heic costume.'.repeat(40)));

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
/** Every request Chrome makes, from outside the page — the page can't fake this. */
const requests = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));
  page.on('request', (r) => {
    requests.push({ url: r.url(), method: r.method(), postData: r.postData() || null, t: Date.now() });
  });

  console.log('── first load ──────────────────────────────────────────');
  const t0 = Date.now();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });
  const loadMs = Date.now() - t0;

  // The paint entry can land a frame or two after load — wait for it rather than
  // reading too early and reporting a hopeful "n/a".
  await page.waitForFunction(
    () => performance.getEntriesByName('first-contentful-paint').length > 0,
    { timeout: 10000 }
  );
  const paint = await page.evaluate(() => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      fcp: fcp ? fcp.startTime : null,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      transferred: performance.getEntriesByType('resource')
        .reduce((n, e) => n + (e.transferSize || 0), 0),
    };
  });
  ok('page becomes interactive', true, `${loadMs} ms wall clock`);
  ok('first contentful paint is fast', paint.fcp !== null && paint.fcp < 1000,
    `FCP = ${paint.fcp === null ? 'n/a' : paint.fcp.toFixed(0) + ' ms'}`);
  console.log(`      DOMContentLoaded = ${paint.domContentLoaded?.toFixed(0)} ms, ` +
    `${(paint.transferred / 1024).toFixed(0)} KB transferred at first paint`);

  console.log('\n── the 1.4 MB decoder is NOT loaded at first paint ─────');
  const heavy = (list) => list.filter((r) =>
    /libheif|decode\.worker|decode\.js|queue\.js|jszip/.test(r.url));
  const earlyHeavy = heavy(requests);
  ok('no decoder / queue / wasm requested before interaction', earlyHeavy.length === 0,
    earlyHeavy.map((r) => r.url.replace(ORIGIN, '')).join(', ') || 'none');
  console.log('      requested at first paint: ' +
    requests.map((r) => r.url.replace(ORIGIN, '') || '/').join(', '));

  console.log('\n── warms the ENGINE on intent (hover) — but NOT the WASM ─');
  // The converter is now universal (HEIC, JPG, PNG or WebP in). Hover preloads the engine
  // MODULES — queue.js + encode.js, a few KB — so the first conversion is instant. It must
  // NOT pull the 1.4 MB libheif decoder: a visitor who only converts JPG/PNG/WebP never needs
  // it, and the whole lazy-load win is that they never pay for it. The WASM loads only when a
  // HEIC/HEIF is actually added (verified in the HEIC conversion below, and in
  // test/verify.unified.mjs which proves a JPG-only run never touches it).
  const beforeWarm = requests.length;
  await page.hover('#drop');
  await page.waitForFunction(
    () => performance.getEntriesByType('resource').some((e) => /queue\.js/.test(e.name)),
    { timeout: 15000 }
  );
  const afterHover = await page.evaluate(() => ({
    engine: performance.getEntriesByType('resource').some((e) => /queue\.js|encode\.js/.test(e.name)),
    decoder: performance
      .getEntriesByType('resource')
      .some((e) => /decode\.js|decode\.worker|libheif/.test(e.name)),
  }));
  ok('hovering the drop zone preloads the engine modules', requests.length > beforeWarm && afterHover.engine,
    `${requests.length - beforeWarm} new requests`);
  ok('hovering does NOT load the 1.4 MB HEIC decoder (JPG/PNG/WebP need no WASM)',
    !afterHover.decoder, afterHover.decoder ? 'decoder loaded on hover' : 'decoder stayed lazy');

  console.log('\n── convert one real HEIC, end to end ───────────────────');
  const convertStart = requests.length;
  await (await page.$('#file-input')).uploadFile(SAMPLE);
  await page.waitForSelector('.row[data-status="done"]', { timeout: 60000 });

  const result = await page.evaluate(async () => {
    const item = window.__app.queue.items[0];
    const head = new Uint8Array(await item.blob.slice(0, 4).arrayBuffer());
    const tail = new Uint8Array(await item.blob.slice(-2).arrayBuffer());
    // Decode the OUTPUT back to pixels: proves it's a real image, not just right magic.
    const bitmap = await createImageBitmap(item.blob);
    // Read the dimensions BEFORE closing: a closed ImageBitmap reports 0x0.
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let nonZero = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) nonZero++;
    bitmap.close();
    return {
      magic: [...head], tail: [...tail], type: item.blob.type, size: item.blob.size,
      name: item.outputName, inputSize: item.inputSize,
      width, height, nonZero, total: width * height,
    };
  });

  ok('output starts with the JPEG magic FF D8 FF',
    result.magic[0] === 0xff && result.magic[1] === 0xd8 && result.magic[2] === 0xff,
    result.magic.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
  ok('output ends with the JPEG EOI marker FF D9',
    result.tail[0] === 0xff && result.tail[1] === 0xd9,
    result.tail.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
  ok('blob is typed image/jpeg', result.type === 'image/jpeg', result.type);
  ok('output re-decodes to the source dimensions', result.width === 1440 && result.height === 960,
    `${result.width} x ${result.height}`);
  ok('output has real pixels', result.nonZero > result.total * 0.5,
    `${((result.nonZero / result.total) * 100).toFixed(1)}% non-black`);
  ok('output is named .jpg', /\.jpg$/.test(result.name), result.name);
  console.log(`      ${(result.inputSize / 1024).toFixed(0)} KB HEIC -> ` +
    `${(result.size / 1024).toFixed(0)} KB JPG ` +
    `(${((result.size / result.inputSize) * 100).toFixed(0)}% of input)`);

  // The lazy-load contract, proven the other way round: the WASM decoder DID load, but only
  // now — after an actual HEIC was processed, not on load and not on hover.
  const decoderLoadedAfterHeic = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((e) => /decode\.worker|libheif/.test(e.name)));
  ok('the 1.4 MB decoder loaded only once a real HEIC was processed', decoderLoadedAfterHeic);

  console.log('\n── the UI shows the done state ─────────────────────────');
  const ui = await page.evaluate(() => ({
    rowStatus: document.querySelector('.row').dataset.status,
    rowName: document.querySelector('.row__name').textContent,
    rowMeta: document.querySelector('.row__meta').textContent,
    sizes: document.querySelector('.row__sizes').textContent.replace(/\s+/g, ' ').trim(),
    status: document.getElementById('queue-status').textContent,
    saveAllEnabled: !document.getElementById('save-all').disabled,
    ledgerIn: document.getElementById('ledger-in').textContent,
    ledgerOut: document.getElementById('ledger-out').textContent,
    delta: document.getElementById('ledger-delta').textContent,
    meter: document.getElementById('meter').style.width,
    queueVisible: !document.getElementById('queue').hidden,
  }));
  ok('the row reads done', ui.rowStatus === 'done', `meta = "${ui.rowMeta}"`);
  ok('the row shows the output filename', /\.jpg$/.test(ui.rowName), ui.rowName);
  ok('the queue is visible and the meter is full', ui.queueVisible && ui.meter === '100%', ui.meter);
  ok('"Save all as zip" became available', ui.saveAllEnabled);
  ok('the status line announces the result', /converted/i.test(ui.status), `"${ui.status}"`);
  ok('the size ledger shows input AND output', ui.ledgerIn !== '0 B' && ui.ledgerOut !== '0 B',
    `${ui.ledgerIn} -> ${ui.ledgerOut} ${ui.delta}`);
  ok('the ledger is honest that JPG is bigger', ui.delta.startsWith('+'), ui.delta);

  // `hidden` must actually hide. A class that sets `display` out-specifies the UA's bare
  // [hidden] rule, which once left "Stop" and "Convert again" on screen permanently.
  const hiddenWorks = await page.evaluate(() => {
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    return {
      stop: shown('stop-all'),
      zip: shown('zip-warning'),
      sizeNote: shown('size-note'),
      globalError: shown('global-error'),
    };
  });
  ok('"Stop" is gone once nothing is running', !hiddenWorks.stop);
  ok('the [hidden] notes are genuinely not displayed',
    !hiddenWorks.zip && !hiddenWorks.sizeNote && !hiddenWorks.globalError,
    JSON.stringify(hiddenWorks));
  console.log(`      per-row sizes = "${ui.sizes}"`);

  console.log('\n── PRIVACY: nothing left the origin ────────────────────');
  // data: and blob: are in-page memory, never the network. Thumbnails render from
  // blob: object-URLs, and the encoder inlines its wasm as data:; neither is egress. The
  // claim under test is that nothing reaches a HOST, so exclude both schemes.
  const isLocal = (url) => url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:');
  const during = requests.slice(convertStart).filter((r) => !isLocal(r.url));
  const foreign = requests.filter((r) => !isLocal(r.url));
  const withBody = requests.filter((r) => r.postData && r.postData.length > 0);
  const nonGet = requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('blob:'));
  ok('ZERO requests to any third-party host, whole session', foreign.length === 0,
    foreign.map((r) => r.url.slice(0, 80)).join(', ') || 'none');
  ok('ZERO requests carrying a body (nothing uploaded)', withBody.length === 0,
    withBody.map((r) => r.url).join(', ') || 'none');
  ok('ZERO non-GET requests', nonGet.length === 0,
    nonGet.map((r) => `${r.method} ${r.url}`).join(', ') || 'none');
  ok('ZERO network requests to any host during the conversion itself', during.length === 0,
    during.map((r) => r.url.replace(ORIGIN, '')).join(', ') || 'none');

  const tap = await page.evaluate(() => ({
    uploaded: document.getElementById('tap-uploaded').textContent,
    thirdParty: document.getElementById('tap-thirdparty').textContent,
    local: document.getElementById('tap-local').textContent,
  }));
  ok('the wire tap agrees with the outside observer', tap.uploaded === '0 B' && tap.thirdParty === '0',
    `uploaded=${tap.uploaded}, third-party=${tap.thirdParty}, converted here=${tap.local}`);
  ok('the wire tap counted the local conversion', tap.local === '1', tap.local);

  console.log('\n── it really works offline ─────────────────────────────');
  await page.setOfflineMode(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await (await page.$('#file-input')).uploadFile(copies[0]);
  await page.waitForFunction(
    () => document.querySelectorAll('.row[data-status="done"]').length >= 2,
    { timeout: 60000 }
  );
  const offline = await page.evaluate(() => ({
    done: window.__app.queue.stats.done,
    label: document.getElementById('tap-connection').textContent,
    blobOk: window.__app.queue.items[1].blob.size > 0,
  }));
  ok('converts with the network cut off', offline.done === 2 && offline.blobOk,
    `${offline.done} files done while offline`);
  ok('the panel says so', offline.label === 'Offline', offline.label);
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  console.log('\n── screenshots ─────────────────────────────────────────');
  const shoot = async (name, width, height, scheme, fullPage = false) => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 250));
    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    console.log(`      ${path.relative(ROOT, file)}`);
  };
  await shoot('desktop-light', 1280, 900, 'light');
  await shoot('desktop-dark', 1280, 900, 'dark');
  await shoot('mobile-light', 390, 844, 'light');
  await shoot('mobile-dark', 390, 844, 'dark');
  await shoot('full-light', 1280, 900, 'light', true);
  await shoot('full-dark', 1280, 900, 'dark', true);
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  console.log('\n── a bad file fails alone ──────────────────────────────');
  await page.evaluate(() => document.getElementById('clear-all').click());
  await (await page.$('#file-input')).uploadFile(copies[0], CORRUPT, copies[1]);
  await page.waitForFunction(
    () => window.__app.queue.stats.done + window.__app.queue.stats.errored === 3,
    { timeout: 60000 }
  );
  const isolation = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row')];
    const bad = rows.find((r) => r.dataset.status === 'error');
    return {
      done: window.__app.queue.stats.done,
      errored: window.__app.queue.stats.errored,
      message: bad ? bad.querySelector('.row__meta').textContent : null,
      hasRetry: bad ? !!bad.querySelector('[data-act="retry"]') : false,
      globalErrorShown: !document.getElementById('global-error').hidden,
      saveAllEnabled: !document.getElementById('save-all').disabled,
    };
  });
  ok('the good files still convert', isolation.done === 2, `${isolation.done}/2 done`);
  ok('exactly the bad file fails', isolation.errored === 1);
  ok('its message is human-readable', !!isolation.message && isolation.message.length > 15,
    JSON.stringify(isolation.message));
  ok('the bad row offers Retry', isolation.hasRetry);
  ok('one bad file does NOT look like the app broke', !isolation.globalErrorShown && isolation.saveAllEnabled);
  await page.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, 'error-isolation.png') });

  console.log(`\n── a ${BATCH}-file batch stays calm (windowed rows) ───────`);
  await page.evaluate(() => document.getElementById('clear-all').click());
  const batchStart = Date.now();
  await (await page.$('#file-input')).uploadFile(...copies);
  await page.waitForFunction((n) => window.__app.queue.stats.total === n, { timeout: 60000 }, BATCH);
  const queuedMs = Date.now() - batchStart;
  const windowed = await page.evaluate(() => ({
    total: window.__app.queue.stats.total,
    rendered: document.querySelectorAll('.row').length,
    virtual: document.getElementById('queue-scroll').dataset.virtual,
    boxHeight: document.getElementById('queue-box').style.height,
    more: document.getElementById('queue-more').textContent,
  }));
  ok(`all ${BATCH} files are queued`, windowed.total === BATCH, `accepted in ${queuedMs} ms`);
  ok('but only the visible rows exist in the DOM', windowed.rendered < 30,
    `${windowed.rendered} rows rendered of ${windowed.total}, scroller = ${windowed.boxHeight}`);
  ok('windowing switched on', windowed.virtual === 'true', `"${windowed.more}"`);

  // "Calm, not a hang": the main thread must still be answering while 200 files convert.
  const lag = await page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    let last = performance.now();
    let n = 0;
    const tick = () => {
      const now = performance.now();
      samples.push(now - last);
      last = now;
      if (++n < 60) requestAnimationFrame(tick);
      else resolve(Math.max(...samples));
    };
    requestAnimationFrame(tick);
  }));
  ok('the page keeps painting mid-batch (no frozen tab)', lag < 250,
    `worst frame gap while converting = ${lag.toFixed(0)} ms`);

  await page.waitForFunction((n) => window.__app.queue.stats.done === n, { timeout: 300000 }, BATCH);
  const batchMs = Date.now() - batchStart;
  const batch = await page.evaluate(() => {
    const s = window.__app.queue.stats;
    return { ...s, delta: document.getElementById('ledger-delta').textContent };
  });
  ok(`all ${BATCH} converted, none dropped`, batch.done === BATCH && batch.errored === 0,
    `${(batchMs / 1000).toFixed(1)} s for ${BATCH} files (${(batchMs / BATCH).toFixed(0)} ms/file)`);
  console.log(`      batch ledger: ${(batch.inputBytes / 1048576).toFixed(1)} MB in -> ` +
    `${(batch.outputBytes / 1048576).toFixed(1)} MB out (${batch.delta})`);
  await page.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, 'batch.png') });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOTS, 'batch-dark.png') });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Scroll the windowed list and make sure rows are still correct (the classic
  // virtualization bug is rows going blank or duplicating after a scroll).
  await page.evaluate(() => { document.getElementById('queue-scroll').scrollTop = 900; });
  await new Promise((r) => setTimeout(r, 300));
  const scrolled = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row')];
    const names = rows.map((r) => r.querySelector('.row__name').textContent);
    return {
      count: rows.length,
      unique: new Set(names).size,
      allNamed: names.every((n) => n.length > 0),
      allDone: rows.every((r) => r.dataset.status === 'done'),
    };
  });
  ok('after scrolling, rows are unique, named and correct',
    scrolled.unique === scrolled.count && scrolled.allNamed && scrolled.allDone,
    `${scrolled.count} rows, ${scrolled.unique} unique`);

  console.log('\n── zip really is a zip ─────────────────────────────────');
  // A 25-file slice, not all 200: zipItems() holds the source blobs AND the finished zip
  // alive at once, and the whole batch would sit near Chrome's blob quota — which is a
  // measured limit of the browser (see queue.js) and is already covered by
  // verify.encode.mjs. What's under test here is that the UI's zip path produces a real,
  // fully readable zip.
  const zip = await page.evaluate(async () => {
    const { zipItems } = await import('/js/queue.js');
    const blob = await zipItems(window.__app.queue.items.slice(0, 25));
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    // Read every byte back: a broken Blob still reports the right .size.
    const all = new Uint8Array(await blob.arrayBuffer());
    return { magic: [...head], size: blob.size, readBack: all.length };
  });
  ok('zip has the PK magic', zip.magic[0] === 0x50 && zip.magic[1] === 0x4b,
    zip.magic.map((b) => b.toString(16)).join(' '));
  ok('every byte of the zip reads back', zip.readBack === zip.size,
    `${(zip.size / 1048576).toFixed(1)} MB`);

  // Click the ACTUAL button and catch the ACTUAL file. The zip module is owned by another
  // agent and its API already changed under us once mid-build; the only way to know our
  // call site still matches is to drive the real control and look at what hits the disk.
  //
  // Two paths, because they're both real:
  //   A. Chromium with the File System Access API — the save picker. Headless auto-dismisses
  //      it, which conveniently IS the "user changed their mind" case.
  //   B. Safari / Firefox, which have no picker — the chunked in-memory zip. This is what
  //      most non-Chromium visitors actually get, and it must produce a file.
  console.log('\n── "Save all as zip", picker dismissed (Chromium) ──────');
  const DL = path.join(TMP, 'downloads');
  fs.mkdirSync(DL, { recursive: true });
  const armDownloads = async (target) => {
    const cdp = await target.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DL, eventsEnabled: true,
    });
  };
  const waitForZips = async (expect) => {
    for (let i = 0; i < 120; i++) {
      const done = fs.readdirSync(DL).filter((f) => f.endsWith('.zip'));
      if (done.length >= expect) {
        await new Promise((r) => setTimeout(r, 500)); // let the write flush
        return fs.readdirSync(DL).filter((f) => f.endsWith('.zip'));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return fs.readdirSync(DL).filter((f) => f.endsWith('.zip'));
  };

  await armDownloads(page);
  ok('this browser does offer the streaming save picker',
    await page.evaluate(() => typeof window.showSaveFilePicker === 'function'));
  // Trim to a handful: this is about wiring, not throughput.
  await page.evaluate(() => {
    for (const item of window.__app.queue.items.slice(5)) window.__app.queue.remove(item.id);
  });
  await page.click('#save-all');
  await new Promise((r) => setTimeout(r, 2500));
  ok('dismissing the save dialog saves nothing and says nothing',
    fs.readdirSync(DL).length === 0 &&
      (await page.evaluate(() => document.getElementById('global-error').hidden)),
    'no file, no error — the user changed their mind');
  ok('the button returns to its resting label after a dismissed save',
    (await page.evaluate(() => document.getElementById('save-all').textContent)) === 'Save all as zip');

  console.log('\n── "Save all as zip" on Safari/Firefox (no picker) ─────');
  const noPicker = await browser.newPage();
  noPicker.on('pageerror', (e) => pageErrors.push('[no-picker] ' + String(e)));
  noPicker.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[no-picker] ' + m.text()); });
  // Stand in for a browser without the File System Access API.
  await noPicker.evaluateOnNewDocument(() => {
    delete window.showSaveFilePicker;
  });
  await armDownloads(noPicker);
  await noPicker.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await noPicker.waitForFunction('window.__ready === true');
  ok('the picker really is absent for this check',
    await noPicker.evaluate(() => typeof window.showSaveFilePicker === 'undefined'));
  await (await noPicker.$('#file-input')).uploadFile(copies[0], copies[1], copies[2]);
  let noPickerState = null;
  for (let i = 0; i < 150; i++) {
    noPickerState = await noPicker.evaluate(() => ({
      hasQueue: !!window.__app.queue,
      stats: window.__app.queue ? window.__app.queue.stats : null,
      error: document.getElementById('global-error').textContent,
    }));
    if (noPickerState.stats && noPickerState.stats.done === 3) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('the three photos convert on the no-picker page',
    noPickerState.stats && noPickerState.stats.done === 3, JSON.stringify(noPickerState));
  await noPicker.click('#save-all');
  const files = await waitForZips(1);
  ok('clicking "Save all as zip" downloads a real file', files.length > 0,
    files.join(', ') || 'nothing landed');
  if (files.length) {
    const bytes = fs.readFileSync(path.join(DL, files[0]));
    ok('the downloaded file is a real zip (PK magic, on disk)',
      bytes[0] === 0x50 && bytes[1] === 0x4b, `${files[0]}, ${(bytes.length / 1024).toFixed(0)} KB`);
    // The end-of-central-directory record is the last thing a zip writer emits, so its
    // presence means the archive was finished rather than truncated.
    ok('the zip is complete, not truncated',
      bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'EOCD record present');
    ok('the zip holds all three photos',
      (bytes.toString('latin1').match(/IMG_\d+\.jpg/g) || []).length >= 3,
      [...new Set(bytes.toString('latin1').match(/IMG_\d+\.jpg/g) || [])].join(', '));
    ok('the button recovers its resting label',
      (await noPicker.evaluate(() => document.getElementById('save-all').textContent)) === 'Save all as zip');
    ok('no error surfaced from the save path',
      await noPicker.evaluate(() => document.getElementById('global-error').hidden));
  }
  await noPicker.close();

  console.log('\n── keyboard + a11y basics ──────────────────────────────');
  // Fresh load: scrolling earlier moved Chrome's sequential-focus starting point, so
  // "the first Tab" is only meaningful from the top of an untouched page.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  const a11y = await page.evaluate(() => {
    const focusables = document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([tabindex="-1"]), select'
    );
    const h1 = document.querySelectorAll('h1');
    return {
      focusables: focusables.length,
      h1Count: h1.length,
      h1Text: h1[0] ? h1[0].textContent.replace(/\s+/g, ' ').trim() : null,
      hasSkip: !!document.querySelector('.skip'),
      liveRegion: document.getElementById('queue-status').getAttribute('aria-live'),
      radiogroup: !!document.querySelector('[role="radiogroup"][aria-labelledby]'),
      title: document.title,
      canonical: document.querySelector('link[rel=canonical]')?.href,
      jsonLd: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
      metaDesc: document.querySelector('meta[name=description]')?.content.length,
    };
  });
  ok('exactly one h1', a11y.h1Count === 1, JSON.stringify(a11y.h1Text));
  ok('h1 contains the head keyword', /heic to jpg/i.test(a11y.h1Text || ''));
  ok('skip link exists', a11y.hasSkip);
  ok('batch status is a live region', a11y.liveRegion === 'polite');
  ok('format picker is a labelled radiogroup', a11y.radiogroup);
  ok('title leads with the keyword', /^HEIC to JPG/i.test(a11y.title), a11y.title);
  ok('canonical is set', !!a11y.canonical, a11y.canonical);
  ok('meta description is a sensible length', a11y.metaDesc > 70 && a11y.metaDesc < 175,
    `${a11y.metaDesc} chars`);
  ok('JSON-LD parses and declares SoftwareApplication + FAQPage',
    a11y.jsonLd['@graph']?.some((n) => n['@type'] === 'SoftwareApplication') &&
    a11y.jsonLd['@graph']?.some((n) => n['@type'] === 'FAQPage'),
    `${a11y.jsonLd['@graph']?.length} nodes`);
  console.log(`      ${a11y.focusables} keyboard-reachable controls`);

  // Tab to the first control and make sure focus is actually visible.
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el, ':focus-visible');
    return { tag: el.tagName, cls: el.className, outline: style.outlineWidth };
  });
  ok('tabbing lands on the skip link first', /skip/.test(focused.cls), `${focused.tag}.${focused.cls}`);
  await new Promise((r) => setTimeout(r, 300)); // it slides in over 150ms
  ok('the skip link is visible once focused', await page.evaluate(() => {
    const r = document.querySelector('.skip').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }), await page.evaluate(() => JSON.stringify(document.querySelector('.skip').getBoundingClientRect().top)));

  // A skip link that only scrolls, leaving focus at the top, is a decoration.
  await page.keyboard.press('Enter');
  const skippedTo = await page.evaluate(() => document.activeElement.id);
  ok('activating the skip link moves focus into the tool', skippedTo === 'tool', `focus = #${skippedTo}`);
  await page.keyboard.press('Tab');
  const afterSkip = await page.evaluate(() => document.activeElement.id);
  ok('the next Tab reaches the file picker, not the header', afterSkip === 'pick', `#${afterSkip}`);

  console.log('\n── settings persist ────────────────────────────────────');
  await page.evaluate(() => {
    document.querySelector('input[value="image/webp"]').click();
    const q = document.getElementById('quality');
    q.value = '0.62';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('resize').value = '1920';
    document.getElementById('resize').dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  const persisted = await page.evaluate(() => ({
    ...window.__app.settings,
    checked: document.querySelector('input[name=format]:checked').value,
    resize: document.getElementById('resize').value,
    quality: document.getElementById('quality').value,
  }));
  ok('format, quality and resize survive a reload',
    persisted.checked === 'image/webp' && persisted.resize === '1920' && persisted.quality === '0.62',
    JSON.stringify(persisted));

  // And WebP actually encodes as WebP.
  await (await page.$('#file-input')).uploadFile(SAMPLE);
  await page.waitForSelector('.row[data-status="done"]', { timeout: 60000 });
  const webp = await page.evaluate(async () => {
    const item = window.__app.queue.items[0];
    const head = new Uint8Array(await item.blob.slice(0, 12).arrayBuffer());
    const tag = String.fromCharCode(...head.slice(0, 4)) + String.fromCharCode(...head.slice(8, 12));
    const bitmap = await createImageBitmap(item.blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return { tag, name: item.outputName, size, bytes: item.blob.size, input: item.inputSize };
  });
  ok('WebP output has the RIFF/WEBP magic', webp.tag === 'RIFFWEBP', webp.tag);
  ok('WebP output respects the 1920 px resize cap', webp.size.w === 1440 && webp.size.h === 960,
    `${webp.size.w} x ${webp.size.h} (source is 1440x960, under the cap — not upscaled)`);

  // ── The page makes specific, checkable claims about file size. Check them.
  // Apples to apples: same photo, same quality, all three formats.
  console.log('\n── the size claims on the page are true ────────────────');
  const ratios = await page.evaluate(async () => {
    const { decodeHeic } = await import('/js/decode.js');
    const { encodeBitmap } = await import('/js/encode.js');
    const file = new File([await (await fetch('/test/sample.heic')).blob()], 'sample.heic');
    const out = {};
    for (const format of ['image/jpeg', 'image/webp', 'image/png']) {
      const { bitmap } = await decodeHeic(file);
      const blob = await encodeBitmap(bitmap, { format, quality: 0.85 });
      out[format] = blob.size / file.size;
    }
    return out;
  });
  const pct = (r) => `${(r * 100).toFixed(0)}%`;
  ok('JPG really is ~168% of the HEIC input, as the page says',
    ratios['image/jpeg'] > 1.5 && ratios['image/jpeg'] < 1.9, pct(ratios['image/jpeg']));
  ok('JPG output really is BIGGER than the input — the page must never soften this',
    ratios['image/jpeg'] > 1, pct(ratios['image/jpeg']));
  ok('WebP is smaller than JPG, but only slightly — as the page now says',
    ratios['image/webp'] < ratios['image/jpeg'] && ratios['image/webp'] > ratios['image/jpeg'] * 0.85,
    `WebP ${pct(ratios['image/webp'])} vs JPG ${pct(ratios['image/jpeg'])} of input ` +
    `(WebP saves ${(100 - (ratios['image/webp'] / ratios['image/jpeg']) * 100).toFixed(0)}%)`);
  ok('WebP is still bigger than the HEIC — the page must not claim otherwise',
    ratios['image/webp'] > 1, pct(ratios['image/webp']));
  ok('PNG really is roughly 12x, as the page says', ratios['image/png'] > 8, pct(ratios['image/png']));

  // The page prints specific percentages. Those printed numbers are a promise; check the
  // page against the browser rather than against a comment.
  const claimed = await page.evaluate(() =>
    [...document.querySelectorAll('.compare__row:not(.compare__row--head)')].map((row) => ({
      label: row.firstElementChild.textContent.trim(),
      pct: parseFloat(row.querySelector('.compare__size').textContent),
    }))
  );
  const claim = (label) => claimed.find((c) => c.label === label)?.pct;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  ok('the table\'s JPG number matches the measurement',
    near(claim('JPG out'), ratios['image/jpeg'] * 100, 8),
    `page says ${claim('JPG out')}%, browser produced ${pct(ratios['image/jpeg'])}`);
  ok('the table\'s WebP number matches the measurement',
    near(claim('WebP out'), ratios['image/webp'] * 100, 8),
    `page says ${claim('WebP out')}%, browser produced ${pct(ratios['image/webp'])}`);
  ok('the table\'s PNG number matches the measurement',
    near(claim('PNG out'), ratios['image/png'] * 100, 60),
    `page says ${claim('PNG out')}%, browser produced ${pct(ratios['image/png'])}`);
  ok('the table does not quote a fake 12 MP provenance',
    await page.evaluate(() => !/measured on a 12\s*MP/i.test(document.body.textContent)));

  // ══════════════════════════════════════════════════════════════════════════════════
  // REGRESSION: "picking PNG or WebP still gives you JPG" (reported from real use).
  //
  // Root cause was NOT a bad format id — it was that createQueue() freezes `format` at
  // construction, so changing the setting after a conversion did nothing until you found
  // a "Convert again" button, and newly added files silently reused the old queue's
  // format. Every check below asserts MAGIC BYTES, never the extension: the extension is
  // exactly what lied to the user.
  // ══════════════════════════════════════════════════════════════════════════════════
  console.log('\n── each format produces THAT format (magic bytes) ───────');

  const FORMAT_CASES = [
    { value: 'image/jpeg', ext: '.jpg', label: 'JPEG', magic: 'FF D8 FF',
      ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { value: 'image/png', ext: '.png', label: 'PNG', magic: '89 50 4E 47',
      ok: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { value: 'image/webp', ext: '.webp', label: 'WebP', magic: "'RIFF'…'WEBP'",
      ok: (b) => Buffer.from(b.slice(0, 4)).toString('latin1') === 'RIFF' &&
                 Buffer.from(b.slice(8, 12)).toString('latin1') === 'WEBP' },
  ];
  const hex = (b) => b.slice(0, 4).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  /** Read every finished item's real output bytes out of the live app. */
  const readOutputs = (target) => target.evaluate(async () => {
    const out = [];
    for (const item of (window.__app.queue ? window.__app.queue.items : [])) {
      if (!item.blob) { out.push({ name: item.name, status: item.status, head: null }); continue; }
      out.push({
        name: item.outputName, status: item.status, type: item.blob.type, size: item.blob.size,
        head: [...new Uint8Array(await item.blob.slice(0, 12).arrayBuffer())],
      });
    }
    return out;
  });

  /**
   * DECODE the output and read its true pixel dimensions. Deliberately does not trust
   * item.width/item.height — those are the app's own bookkeeping, i.e. exactly the kind of
   * claim that lied about the format.
   */
  const readDims = (target) => target.evaluate(async () => {
    const out = [];
    for (const item of (window.__app.queue ? window.__app.queue.items : [])) {
      if (!item.blob) { out.push(null); continue; }
      const bitmap = await createImageBitmap(item.blob);
      const w = bitmap.width;
      const h = bitmap.height;
      bitmap.close();
      out.push({ name: item.outputName, w, h, size: item.blob.size, claimedW: item.width, claimedH: item.height });
    }
    return out;
  });

  // A no-picker page so "Save all as zip" writes a file we can open, and localStorage is
  // wiped so earlier tests' persisted settings can't colour these results.
  const fmt = await browser.newPage();
  fmt.on('pageerror', (e) => pageErrors.push('[format] ' + String(e)));
  fmt.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[format] ' + m.text()); });
  await fmt.evaluateOnNewDocument(() => { delete window.showSaveFilePicker; });
  await armDownloads(fmt);
  await fmt.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await fmt.evaluate(() => localStorage.clear());
  await fmt.reload({ waitUntil: 'load' });
  await fmt.waitForFunction('window.__ready === true');

  const settle = async (target, expected) => {
    for (let i = 0; i < 200; i++) {
      const s = await target.evaluate(() =>
        window.__app.queue ? window.__app.queue.stats : null);
      if (s && s.done === expected && s.running === 0 && s.pending === 0) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  for (const test of FORMAT_CASES) {
    await fmt.evaluate(() => document.getElementById('clear-all').click());
    await fmt.evaluate((v) => document.querySelector(`input[value="${v}"]`).click(), test.value);
    await (await fmt.$('#file-input')).uploadFile(SAMPLE);
    await settle(fmt, 1);
    const [out] = await readOutputs(fmt);
    ok(`pick ${test.label} -> the bytes really are ${test.label} (${test.magic})`,
      !!out.head && test.ok(out.head), `${out.name}, magic = ${out.head ? hex(out.head) : 'none'}`);
    ok(`pick ${test.label} -> the filename ends ${test.ext}`, out.name.endsWith(test.ext), out.name);
    ok(`pick ${test.label} -> the blob is typed ${test.value}`, out.type === test.value, out.type);
  }

  console.log('\n── changing the format leaves finished files ALONE ─────');
  // THE MODEL: settings apply to files converted from now on. Finished work stays
  // finished. The hazard is "selector says PNG, file is JPG" — survivable only because
  // every row reports what was actually encoded, and the mismatch is stated out loud.
  await fmt.evaluate(() => document.getElementById('clear-all').click());
  await fmt.evaluate(() => document.querySelector('input[value="image/jpeg"]').click());
  await (await fmt.$('#file-input')).uploadFile(SAMPLE);
  await settle(fmt, 1);
  const asJpeg = (await readOutputs(fmt))[0];
  ok('starts out as real JPEG', asJpeg.head && FORMAT_CASES[0].ok(asJpeg.head), hex(asJpeg.head));

  await fmt.evaluate(() => document.querySelector('input[value="image/png"]').click());
  await new Promise((r) => setTimeout(r, 1200)); // give any rogue re-run time to happen
  const stillJpeg = (await readOutputs(fmt))[0];
  ok('switching to PNG does NOT re-encode the finished file — bytes untouched',
    stillJpeg.head && FORMAT_CASES[0].ok(stillJpeg.head), `still ${hex(stillJpeg.head)}`);
  ok('…and does NOT rename it either (no .png wrapper around JPEG bytes)',
    stillJpeg.name.endsWith('.jpg'), stillJpeg.name);
  ok('…and the byte count is identical (nothing re-ran at all)',
    stillJpeg.size === asJpeg.size, `${asJpeg.size} -> ${stillJpeg.size}`);

  // The notice is the whole reason this model is honest. It must be REAL, not a tooltip.
  const notice = await fmt.evaluate(() => {
    const el = document.getElementById('mismatch');
    return { text: el.textContent.trim(), display: getComputedStyle(el).display, hidden: el.hidden };
  });
  ok('the mismatch is STATED, visibly and permanently',
    notice.display !== 'none' && !notice.hidden && /JPG/.test(notice.text) && /PNG/.test(notice.text),
    `"${notice.text}"`);
  ok('the notice counts the stale files correctly', /1 file as JPG/.test(notice.text), notice.text);

  // Computed style, not the `hidden` attribute — .btn{display:inline-flex} once beat
  // [hidden] and left buttons visible; the inverse mistake would leave this one invisible.
  const btn = await fmt.evaluate(() => {
    const el = document.getElementById('reconvert');
    return { text: el.textContent.trim(), disabled: el.disabled, display: getComputedStyle(el).display,
             box: el.getBoundingClientRect().height };
  });
  ok('the re-convert action is genuinely VISIBLE (computed style, real box)',
    btn.display !== 'none' && btn.box > 0, JSON.stringify(btn));
  ok('it names the target format', /Re-convert all as PNG/.test(btn.text), btn.text);
  ok('and it is enabled when there IS something to re-convert', btn.disabled === false);

  console.log('\n── new files use the new settings; old ones do not ─────');
  await (await fmt.$('#file-input')).uploadFile(copies[0]);
  await settle(fmt, 2);
  const mixed = await readOutputs(fmt);
  ok('one batch, two formats: the original stays JPEG',
    mixed[0].head && FORMAT_CASES[0].ok(mixed[0].head) && mixed[0].name.endsWith('.jpg'),
    `${mixed[0].name} = ${hex(mixed[0].head)}`);
  ok('one batch, two formats: the NEW file is PNG',
    mixed[1].head && FORMAT_CASES[1].ok(mixed[1].head) && mixed[1].name.endsWith('.png'),
    `${mixed[1].name} = ${hex(mixed[1].head)}`);
  ok('every row\'s extension matches its OWN bytes (nothing downstream assumes uniformity)',
    mixed.every((o) => (o.name.endsWith('.jpg') && FORMAT_CASES[0].ok(o.head)) ||
                       (o.name.endsWith('.png') && FORMAT_CASES[1].ok(o.head))),
    mixed.map((o) => `${o.name}=${hex(o.head)}`).join(' | '));
  ok('the app records two runs with the formats actually used',
    JSON.stringify(await fmt.evaluate(() => window.__app.runs.map((r) => r.settings.format))) ===
      JSON.stringify(['image/jpeg', 'image/png']));

  await fmt.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await fmt.screenshot({ path: path.join(SHOTS, 'mixed-formats.png') });

  console.log('\n── the explicit re-convert action ──────────────────────');
  await fmt.click('#reconvert');
  await settle(fmt, 2);
  const reconverted = await readOutputs(fmt);
  ok('"Re-convert all as PNG" makes EVERY row real PNG bytes',
    reconverted.length === 2 && reconverted.every((o) => o.head && FORMAT_CASES[1].ok(o.head)),
    reconverted.map((o) => `${o.name}=${hex(o.head)}`).join(' | '));
  ok('…and every label agrees', reconverted.every((o) => o.name.endsWith('.png')),
    reconverted.map((o) => o.name).join(', '));
  const afterRe = await fmt.evaluate(() => ({
    notice: getComputedStyle(document.getElementById('mismatch')).display,
    disabled: document.getElementById('reconvert').disabled,
    btnDisplay: getComputedStyle(document.getElementById('reconvert')).display,
  }));
  ok('the notice retires once nothing is stale', afterRe.notice === 'none');
  ok('the button stays PRESENT but goes disabled — never vanishes',
    afterRe.btnDisplay !== 'none' && afterRe.disabled === true, JSON.stringify(afterRe));

  console.log('\n── the DOWNLOAD carries the right bytes, per format ────');
  /**
   * Walk a zip via its central directory (not by scanning for PK\x03\x04, which
   * false-positives inside image data) and read the first bytes of each entry's payload.
   * client-zip STOREs, so entry data is the raw file.
   */
  const zipEntries = (buf) => {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1) throw new Error('no EOCD — not a zip');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');
      const local = buf.readUInt32LE(p + 42);
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const data = local + 30 + lNameLen + lExtraLen;
      entries.push({ name, head: [...buf.subarray(data, data + 12)] });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  };

  for (const test of FORMAT_CASES) {
    for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
    await fmt.evaluate(() => document.getElementById('clear-all').click());
    await fmt.evaluate((v) => document.querySelector(`input[value="${v}"]`).click(), test.value);
    await (await fmt.$('#file-input')).uploadFile(copies[0], copies[1]);
    await settle(fmt, 2);
    await fmt.click('#save-all');
    const zips = await waitForZips(1);
    if (!zips.length) { ok(`${test.label}: zip downloads`, false, 'nothing landed'); continue; }
    const entries = zipEntries(fs.readFileSync(path.join(DL, zips[0])));
    ok(`zip of ${test.label}: entries are named ${test.ext}`,
      entries.length === 2 && entries.every((e) => e.name.endsWith(test.ext)),
      entries.map((e) => e.name).join(', '));
    ok(`zip of ${test.label}: the bytes INSIDE the zip are really ${test.label}`,
      entries.length === 2 && entries.every((e) => test.ok(e.head)),
      entries.map((e) => `${e.name}=${hex(e.head)}`).join(' | '));
  }

  // A MIXED batch: the zip must not claim a single format, and every entry's bytes must
  // match its OWN name. One batch, two formats, and nothing downstream may assume
  // uniformity.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await fmt.evaluate(() => document.getElementById('clear-all').click());
  await fmt.evaluate(() => document.querySelector('input[value="image/jpeg"]').click());
  await (await fmt.$('#file-input')).uploadFile(copies[0]);
  await settle(fmt, 1);
  await fmt.evaluate(() => document.querySelector('input[value="image/png"]').click());
  await (await fmt.$('#file-input')).uploadFile(copies[1]);
  await settle(fmt, 2);
  await fmt.click('#save-all');
  const mixedZips = await waitForZips(1);
  ok('a mixed batch still zips', mixedZips.length > 0, mixedZips.join(', ') || 'nothing landed');
  if (mixedZips.length) {
    ok('the mixed zip does NOT claim one format in its name',
      mixedZips[0] === 'photos.zip', mixedZips[0]);
    const entries = zipEntries(fs.readFileSync(path.join(DL, mixedZips[0])));
    ok('the mixed zip holds both formats',
      entries.length === 2 && entries.some((e) => e.name.endsWith('.jpg')) &&
        entries.some((e) => e.name.endsWith('.png')),
      entries.map((e) => e.name).join(', '));
    ok('inside the mixed zip, EVERY entry\'s bytes match its own name',
      entries.every((e) => (e.name.endsWith('.jpg') && FORMAT_CASES[0].ok(e.head)) ||
                           (e.name.endsWith('.png') && FORMAT_CASES[1].ok(e.head))),
      entries.map((e) => `${e.name}=${hex(e.head)}`).join(' | '));
  }

  // …and a uniform batch keeps the specific name, so two saves can't collide.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await fmt.evaluate(() => document.getElementById('clear-all').click());
  await fmt.evaluate(() => document.querySelector('input[value="image/png"]').click());
  await (await fmt.$('#file-input')).uploadFile(copies[0], copies[1]);
  await settle(fmt, 2);
  await fmt.click('#save-all');
  const uniformZips = await waitForZips(1);
  ok('a uniform batch names the zip after its one real format',
    uniformZips[0] === 'photos-png.zip', uniformZips.join(', '));

  // Per-file "Save" button, for the format most likely to be wrong.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await fmt.evaluate(() => document.getElementById('clear-all').click());
  await fmt.evaluate(() => document.querySelector('input[value="image/png"]').click());
  await (await fmt.$('#file-input')).uploadFile(SAMPLE);
  await settle(fmt, 1);
  // Wait for the row to actually paint (view.render is rAF-scheduled) before clicking.
  await fmt.waitForSelector('.row [data-act="download"]', { timeout: 10000 });
  await fmt.click('.row [data-act="download"]');
  let saved = [];
  for (let i = 0; i < 60 && !saved.length; i++) {
    saved = fs.readdirSync(DL).filter((f) => f.endsWith('.png'));
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('the per-file "Save" button writes a real .png', saved.length > 0, saved.join(', ') || 'nothing');
  if (saved.length) {
    const bytes = fs.readFileSync(path.join(DL, saved[0]));
    ok('…and that file on disk contains PNG bytes',
      FORMAT_CASES[1].ok([...bytes.subarray(0, 12)]),
      `${saved[0]}, ${hex([...bytes.subarray(0, 4)])}`);
  }

  await fmt.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await fmt.screenshot({ path: path.join(SHOTS, 'format-png.png') });
  await fmt.close();

  // ══════════════════════════════════════════════════════════════════════════════════
  // The format bug escaped twice, so: no happy paths. Every ordered transition, driven
  // with REAL MOUSE CLICKS (not element.click(), which can mask a control the user
  // physically cannot hit), starting from the state the user actually has — a localStorage
  // that already says PNG.
  // ══════════════════════════════════════════════════════════════════════════════════
  console.log("\n── FULL 3x3 format matrix, from the user's saved state ──");
  const mx = await browser.newPage();
  mx.on('pageerror', (e) => pageErrors.push('[matrix] ' + String(e)));
  mx.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[matrix] ' + m.text()); });
  await mx.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  // His real starting state: already on PNG, restored from disk, before the page loads.
  await mx.evaluate(() => localStorage.setItem('safelight.settings.v1',
    JSON.stringify({ format: 'image/png', quality: 0.85, maxDimension: 0 })));
  await mx.reload({ waitUntil: 'load' });
  await mx.waitForFunction('window.__ready === true');
  ok('a reload restores the saved format onto the right radio',
    (await mx.evaluate(() => document.querySelector('input[name=format]:checked').value)) === 'image/png');

  // A stale cached build is indistinguishable from a code bug from the outside — it cost
  // this project two rounds of chasing a bug that wasn't there. `__app.version` is how you
  // tell them apart in one console line, so it must actually match the source.
  const srcVersion = (await import('../js/config.js')).VERSION;
  ok('__app.version is exposed and matches js/config.js (stale-build check works)',
    (await mx.evaluate(() => window.__app.version)) === srcVersion, srcVersion);

  // The radios are visually a segmented control; click where a finger/mouse would land.
  const ORDER = ['image/jpeg', 'image/webp', 'image/png'];
  const clickFormat = (target, value) => target.click(`.seg__opt:nth-child(${ORDER.indexOf(value) + 1})`);

  for (const from of FORMAT_CASES) {
    for (const to of FORMAT_CASES) {
      await mx.evaluate(() => document.getElementById('clear-all').click());
      await clickFormat(mx, from.value);
      await (await mx.$('#file-input')).uploadFile(SAMPLE);
      await settle(mx, 1);
      const before = (await readOutputs(mx))[0];

      await clickFormat(mx, to.value); // the transition under test — a real click
      await new Promise((r) => setTimeout(r, 500)); // let any rogue re-run try to happen

      // 1. The finished file is untouched, whatever the selector now says.
      const after = (await readOutputs(mx))[0];
      const arrow = `${from.label} -> ${to.label}${from.value === to.value ? ' (same)' : ''}`;
      ok(`${arrow}: the finished file is left alone (still ${from.label} bytes)`,
        !!after.head && from.ok(after.head) && after.name === before.name && after.size === before.size,
        `${after.name} = ${hex(after.head)}`);

      // 2. The NEXT file uses the newly selected format.
      await (await mx.$('#file-input')).uploadFile(copies[0]);
      await settle(mx, 2);
      const rows = await readOutputs(mx);
      ok(`${arrow}: the next file added really is ${to.label}`,
        !!rows[1].head && to.ok(rows[1].head), `${rows[1].name} = ${hex(rows[1].head)}`);
      ok(`${arrow}: both rows' bytes match their own names`,
        rows.every((o) => FORMAT_CASES.some((c) => o.name.endsWith(c.ext) && c.ok(o.head))),
        rows.map((o) => `${o.name}=${hex(o.head)}`).join(' | '));

      // 3. The notice tells the truth about whether they differ.
      const shown = await mx.evaluate(() =>
        getComputedStyle(document.getElementById('mismatch')).display !== 'none');
      ok(`${arrow}: the mismatch notice is ${from.value === to.value ? 'absent' : 'shown'}`,
        shown === (from.value !== to.value), `notice shown = ${shown}`);
    }
  }

  // ── QUALITY ────────────────────────────────────────────────────────────────────────
  // A slider that moves and changes nothing is the same bug in a new outfit. The only
  // honest proof it reaches the encoder is that the bytes change, monotonically.
  console.log('\n── the quality slider reaches the encoder ──────────────');
  const setQuality = (target, q, fire = 'change') => target.evaluate((v, ev) => {
    const s = document.getElementById('quality');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    if (ev === 'change') s.dispatchEvent(new Event('change', { bubbles: true }));
  }, q, fire);

  // Quality reaches the encoder — proven on files converted AFTER each change, since a
  // change no longer touches finished work.
  const qSizes = [];
  for (const q of [0.3, 0.85, 1.0]) {
    await mx.evaluate(() => document.getElementById('clear-all').click());
    await clickFormat(mx, 'image/jpeg');
    await setQuality(mx, q);
    await (await mx.$('#file-input')).uploadFile(SAMPLE);
    await settle(mx, 1);
    qSizes.push((await readOutputs(mx))[0].size);
  }
  ok('JPEG size grows strictly with quality 0.3 < 0.85 < 1.0',
    qSizes[0] < qSizes[1] && qSizes[1] < qSizes[2],
    qSizes.map((s, i) => `q${[0.3, 0.85, 1.0][i]}=${(s / 1024).toFixed(0)}KB`).join('  <  '));

  // WebP is lossy: quality MUST apply. Treating "not JPEG" as "no quality" would be a bug.
  const wSizes = [];
  for (const q of [0.3, 0.9]) {
    await mx.evaluate(() => document.getElementById('clear-all').click());
    await clickFormat(mx, 'image/webp');
    await setQuality(mx, q);
    await (await mx.$('#file-input')).uploadFile(SAMPLE);
    await settle(mx, 1);
    wSizes.push((await readOutputs(mx))[0].size);
  }
  ok('quality applies to WebP too (it is lossy)', wSizes[0] < wSizes[1],
    `q0.3=${(wSizes[0] / 1024).toFixed(0)}KB < q0.9=${(wSizes[1] / 1024).toFixed(0)}KB`);

  // PNG is lossless: quality is genuinely inert. The UI must SAY so, not just go grey.
  await mx.evaluate(() => document.getElementById('clear-all').click());
  await clickFormat(mx, 'image/png');
  await setQuality(mx, 0.9);
  await (await mx.$('#file-input')).uploadFile(SAMPLE);
  await settle(mx, 1);
  const pngQ = await mx.evaluate(() => ({
    disabled: document.getElementById('quality').disabled,
    label: document.getElementById('quality-out').textContent,
  }));
  const pngSizeA = (await readOutputs(mx))[0].size;
  await mx.evaluate(() => document.getElementById('clear-all').click());
  await setQuality(mx, 0.3);
  await (await mx.$('#file-input')).uploadFile(SAMPLE);
  await settle(mx, 1);
  const pngSizeB = (await readOutputs(mx))[0].size;
  ok('PNG ignores quality — and the UI says "lossless" rather than going mutely grey',
    pngQ.disabled && /lossless/i.test(pngQ.label) && pngSizeA === pngSizeB,
    `disabled=${pngQ.disabled}, label="${pngQ.label}", size unchanged at ${(pngSizeA / 1024).toFixed(0)}KB`);

  // ── RESIZE ─────────────────────────────────────────────────────────────────────────
  // Assert DECODED pixels, not the app's bookkeeping. sample.heic is 1440x960 (3:2).
  console.log('\n── the resize select really resizes (decoded pixels) ───');
  await mx.evaluate(() => document.getElementById('clear-all').click());
  await clickFormat(mx, 'image/jpeg');
  await setQuality(mx, 0.85);
  await (await mx.$('#file-input')).uploadFile(SAMPLE);
  await settle(mx, 1);

  const setResize = (target, v) => target.evaluate((val) => {
    const s = document.getElementById('resize');
    s.value = val;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);

  const offered = await mx.evaluate(() =>
    [...document.getElementById('resize').options].map((o) => o.value));
  const RESIZE_EXPECT = {
    '0': [1440, 960], '4032': [1440, 960], '2560': [1440, 960],
    '1920': [1440, 960], '1280': [1280, 853], '800': [800, 533],
  };
  for (const value of offered) {
    // Fresh convert per option: a resize change no longer re-runs finished work.
    await mx.evaluate(() => document.getElementById('clear-all').click());
    await setResize(mx, value);
    await (await mx.$('#file-input')).uploadFile(SAMPLE);
    await settle(mx, 1);
    const [d] = await readDims(mx);
    const [ew, eh] = RESIZE_EXPECT[value] || [];
    const noUpscale = Number(value) === 0 || Number(value) >= 1440;
    ok(`resize "${value}": decoded output is ${ew}x${eh}${noUpscale ? ' (never upscaled)' : ''}`,
      d.w === ew && d.h === eh, `got ${d.w}x${d.h}, ${(d.size / 1024).toFixed(0)}KB`);
    ok(`resize "${value}": aspect ratio preserved (3:2)`,
      Math.abs(d.w / d.h - 1.5) < 0.01, `${(d.w / d.h).toFixed(4)}`);
    // The row must describe the file you actually get. It used to print the SOURCE
    // dimensions, so a resized photo read "1440 × 960" while the bytes were 800 × 533.
    const rowText = await mx.evaluate(() => document.querySelector('.row__meta').textContent);
    ok(`resize "${value}": the row LABEL matches the decoded output, not the source`,
      rowText.trim() === `${d.w} × ${d.h}`, `row says "${rowText.trim()}", bytes are ${d.w}x${d.h}`);
  }

  // Resize follows the same model: finished pixels are not touched; the next file is.
  await mx.evaluate(() => document.getElementById('clear-all').click());
  await setResize(mx, '800');
  await (await mx.$('#file-input')).uploadFile(SAMPLE);
  await settle(mx, 1);
  const small = (await readDims(mx))[0];
  await setResize(mx, '0');
  await new Promise((r) => setTimeout(r, 700));
  const stillSmall = (await readDims(mx))[0];
  ok('changing resize leaves the finished file\'s pixels alone',
    stillSmall.w === 800 && stillSmall.h === 533, `${stillSmall.w}x${stillSmall.h}`);
  ok('…and its row still states its own real size, not the new setting',
    (await mx.evaluate(() => document.querySelector('.row__meta').textContent)).trim() === '800 × 533');
  await (await mx.$('#file-input')).uploadFile(copies[0]);
  await settle(mx, 2);
  const full = (await readDims(mx))[1];
  ok('…while the next file added is full size',
    full.w === 1440 && full.h === 960, `${full.w}x${full.h}`);
  ok('"Original size" genuinely means full size, not a silent cap',
    full.w === 1440 && full.h === 960, `${full.w}x${full.h}`);

  // ── PERSISTENCE ────────────────────────────────────────────────────────────────────
  // A control showing "800 px" while encoding full-size is the format bug in a new outfit.
  console.log('\n── all three controls survive a reload, and are OBEYED ──');
  await mx.evaluate(() => document.getElementById('clear-all').click());
  await clickFormat(mx, 'image/webp');
  await setQuality(mx, 0.42);
  await setResize(mx, '800');
  await mx.reload({ waitUntil: 'load' });
  await mx.waitForFunction('window.__ready === true');
  const restored = await mx.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem('safelight.settings.v1')),
    settings: window.__app.settings,
    checked: document.querySelector('input[name=format]:checked').value,
    slider: document.getElementById('quality').value,
    select: document.getElementById('resize').value,
  }));
  ok('the restored UI shows exactly what was saved',
    restored.checked === 'image/webp' && restored.slider === '0.42' && restored.select === '800',
    JSON.stringify({ checked: restored.checked, slider: restored.slider, select: restored.select }));

  await (await mx.$('#file-input')).uploadFile(SAMPLE);
  await settle(mx, 1);
  const afterReload = (await readDims(mx))[0];
  const afterReloadBytes = (await readOutputs(mx))[0];
  ok('…and the encoder OBEYS the restored settings (WebP @ 800px)',
    FORMAT_CASES[2].ok(afterReloadBytes.head) && afterReload.w === 800 && afterReload.h === 533,
    `${afterReload.name} ${afterReload.w}x${afterReload.h}, magic ${hex(afterReloadBytes.head)}`);
  ok('the restored quality is obeyed too (0.42 is much smaller than 1.0)',
    afterReloadBytes.size < wSizes[1],
    `${(afterReloadBytes.size / 1024).toFixed(0)}KB at q0.42/800px`);

  await mx.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await mx.screenshot({ path: path.join(SHOTS, 'controls-obeyed.png') });
  await mx.close();

  // ══════════════════════════════════════════════════════════════════════════════════
  // NEW CAPABILITIES: PDF format, combine-into-one-PDF, thumbnails, /compress/ link.
  // Same bar as everything above — assert on real bytes and decoded pixels, never labels.
  // ══════════════════════════════════════════════════════════════════════════════════
  const isPdf = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

  const cap = await browser.newPage();
  cap.on('pageerror', (e) => pageErrors.push('[caps] ' + String(e)));
  cap.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[caps] ' + m.text()); });
  await cap.evaluateOnNewDocument(() => { delete window.showSaveFilePicker; });
  await armDownloads(cap);
  await cap.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await cap.evaluate(() => localStorage.clear());
  await cap.reload({ waitUntil: 'load' });
  await cap.waitForFunction('window.__ready === true');
  ok('build version marks this as the PDF/thumbnails build',
    (await cap.evaluate(() => window.__app.version)) === (await import('../js/config.js')).VERSION);

  console.log('\n── PDF as a format radio ───────────────────────────────');
  ok('PDF appears as a format option',
    await cap.evaluate(() => !!document.querySelector('input[value="application/pdf"]')));
  await cap.evaluate(() => document.querySelector('input[value="application/pdf"]').click());
  ok('picking PDF does NOT disable the quality slider (PDF is lossy)',
    (await cap.evaluate(() => document.getElementById('quality').disabled)) === false);
  await cap.evaluate(() => document.querySelector('input[value="image/png"]').click());
  ok('…but PNG still DOES disable it (only PNG is lossless)',
    (await cap.evaluate(() => document.getElementById('quality').disabled)) === true);

  await cap.evaluate(() => document.querySelector('input[value="application/pdf"]').click());
  await (await cap.$('#file-input')).uploadFile(SAMPLE);
  await settle(cap, 1);
  const pdfItem = (await readOutputs(cap))[0];
  ok('convert as PDF → the row is a .pdf', pdfItem.name.endsWith('.pdf'), pdfItem.name);
  ok('convert as PDF → the blob magic is %PDF', !!pdfItem.head && isPdf(pdfItem.head), hex(pdfItem.head));
  ok('convert as PDF → the blob is typed application/pdf', pdfItem.type === 'application/pdf', pdfItem.type);

  console.log('\n── PDF in the mixed-format model ───────────────────────');
  await cap.evaluate(() => document.getElementById('clear-all').click());
  await cap.evaluate(() => document.querySelector('input[value="image/jpeg"]').click());
  await (await cap.$('#file-input')).uploadFile(copies[0]);
  await settle(cap, 1);
  await cap.evaluate(() => document.querySelector('input[value="application/pdf"]').click());
  await (await cap.$('#file-input')).uploadFile(copies[1]);
  await settle(cap, 2);
  const mixPdf = await readOutputs(cap);
  ok('a JPG row and a PDF row coexist, each honest',
    mixPdf[0].name.endsWith('.jpg') && FORMAT_CASES[0].ok(mixPdf[0].head) &&
    mixPdf[1].name.endsWith('.pdf') && isPdf(mixPdf[1].head),
    `${mixPdf[0].name}=${hex(mixPdf[0].head)} | ${mixPdf[1].name}=${hex(mixPdf[1].head)}`);
  await cap.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await cap.screenshot({ path: path.join(SHOTS, 'mixed-jpg-pdf.png') });

  console.log('\n── Combine into one PDF ────────────────────────────────');
  ok('the Combine button is present (API detected)',
    await cap.evaluate(() => {
      const el = document.getElementById('combine-pdf');
      return !el.hidden && getComputedStyle(el).display !== 'none';
    }));
  ok('…and enabled with files present',
    (await cap.evaluate(() => document.getElementById('combine-pdf').disabled)) === false);

  // A real multi-file batch, plus one deliberately corrupt file, so we can prove the
  // corrupt one is SKIPPED, the user is told, and the PDF still builds.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await cap.evaluate(() => document.getElementById('clear-all').click());
  await cap.evaluate(() => document.querySelector('input[value="image/jpeg"]').click());
  await (await cap.$('#file-input')).uploadFile(copies[0], copies[1], copies[2], CORRUPT);
  // 3 good + 1 corrupt: wait until all four have SETTLED (the corrupt one errors).
  for (let i = 0; i < 200; i++) {
    const s = await cap.evaluate(() => window.__app.queue.stats);
    if (s.done + s.errored === 4) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await cap.click('#combine-pdf');
  let pdfs = [];
  for (let i = 0; i < 150 && !pdfs.length; i++) {
    pdfs = fs.readdirSync(DL).filter((f) => f.endsWith('.pdf'));
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('clicking "Combine into one PDF" downloads a file', pdfs.length > 0, pdfs.join(', ') || 'nothing');
  if (pdfs.length) {
    const buf = fs.readFileSync(path.join(DL, pdfs[0]));
    ok('the combined file is named photos.pdf', pdfs[0] === 'photos.pdf', pdfs[0]);
    ok('the combined file really is a PDF (%PDF on disk)', isPdf([...buf.subarray(0, 4)]),
      hex([...buf.subarray(0, 4)]));
    ok('the PDF ends with %%EOF (complete, not truncated)',
      buf.toString('latin1').trimEnd().endsWith('%%EOF'), buf.toString('latin1').trimEnd().slice(-8));
    // Page count from the app's REAL return value (pdf-lib compresses object streams, so a
    // byte-scan for /Type/Page is unreliable). This is the count pdf-lib actually wrote.
    const result = await cap.evaluate(() => window.__app.lastPdf);
    ok('the PDF has one page per GOOD file — corrupt one omitted (pageCount === 3)',
      result && result.pageCount === 3, JSON.stringify(result));
    ok('the app reports exactly one skipped file', result && result.skipped === 1,
      JSON.stringify(result));
  }
  const skipNote = await cap.evaluate(() => {
    const el = document.getElementById('combine-result');
    return { text: el.textContent.trim(), display: getComputedStyle(el).display };
  });
  ok('the user is TOLD a file was skipped (not swallowed)',
    skipNote.display !== 'none' && /skipped/i.test(skipNote.text) && /1 file/.test(skipNote.text),
    `"${skipNote.text}"`);
  ok('the Combine button recovers its resting label',
    (await cap.evaluate(() => document.getElementById('combine-pdf').textContent)) === 'Combine into one PDF');

  // The combine action operates on SOURCE files, so it works even when the batch was
  // converted to something that isn't PDF — the whole point of routing through source.
  ok('Combine is available regardless of the batch\'s output format',
    (await cap.evaluate(() => document.getElementById('combine-pdf').disabled)) === false);

  console.log('\n── thumbnails render, without layout shift ─────────────');
  await cap.evaluate(() => document.getElementById('clear-all').click());
  await cap.evaluate(() => document.querySelector('input[value="image/jpeg"]').click());
  // Capture the row box height BEFORE the thumbnail can exist (pending), then AFTER done —
  // it must not change, proving the reserved box prevents reflow.
  await (await cap.$('#file-input')).uploadFile(SAMPLE);
  await cap.waitForSelector('.row', { timeout: 10000 });
  const rowHeightPending = await cap.evaluate(() =>
    Math.round(document.querySelector('.row').getBoundingClientRect().height));
  await settle(cap, 1);
  await new Promise((r) => setTimeout(r, 300));
  const thumb = await cap.evaluate(async () => {
    const row = document.querySelector('.row');
    const box = row.querySelector('.row__thumb');
    const img = row.querySelector('.row__thumb-img');
    const result = {
      rowHeight: Math.round(row.getBoundingClientRect().height),
      boxW: Math.round(box.getBoundingClientRect().width),
      boxH: Math.round(box.getBoundingClientRect().height),
      hasImg: !!img,
      src: img ? img.src : null,
      lazy: img ? img.loading : null,
    };
    if (img) {
      const bmp = await createImageBitmap(await (await fetch(img.src)).blob());
      result.imgW = bmp.width;
      result.imgH = bmp.height;
      bmp.close();
    }
    return result;
  });
  ok('the done row shows a thumbnail <img>', thumb.hasImg);
  ok('its src is a local blob: object-URL', /^blob:/.test(thumb.src || ''), thumb.src);
  ok('the thumbnail decodes to a small image (≤160px longest side)',
    thumb.imgW > 0 && Math.max(thumb.imgW, thumb.imgH) <= 160, `${thumb.imgW}x${thumb.imgH}`);
  ok('the thumbnail is lazy-loaded', thumb.lazy === 'lazy', thumb.lazy);
  ok('NO layout shift — the row is the same height pending and done',
    thumb.rowHeight === rowHeightPending, `pending ${rowHeightPending}px, done ${thumb.rowHeight}px`);
  ok('the thumbnail box reserves a fixed size', thumb.boxW === 40 && thumb.boxH === 40,
    `${thumb.boxW}x${thumb.boxH}`);
  await cap.evaluate(() => document.getElementById('queue').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await cap.screenshot({ path: path.join(SHOTS, 'thumbnails.png') });

  console.log('\n── graceful when thumbnails are OFF ────────────────────');
  const noThumb = await cap.evaluate(async () => {
    // Build a queue without thumbnails, exactly as an older build would, and render it
    // through the same view code to prove the row survives a missing item.thumbnail.
    const { createQueue } = await import('/js/queue.js');
    const blob = await (await fetch('/test/sample.heic')).blob();
    const q = createQueue({ format: 'image/jpeg' }); // thumbnails default off
    return new Promise((resolve) => {
      q.add(new File([blob], 'x.heic'));
      q.onItemDone = null;
      q.start();
      const check = () => {
        const item = q.items[0];
        if (item.status === 'done') resolve({ thumb: item.thumbnail });
        else setTimeout(check, 100);
      };
      check();
    });
  });
  ok('with thumbnails off, item.thumbnail is undefined (feature-detect path)',
    noThumb.thumb === undefined, String(noThumb.thumb));

  console.log('\n── /compress/ cross-link ───────────────────────────────');
  const compress = await cap.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => /\/compress\//.test(a.href));
    return { count: links.length, texts: links.map((a) => a.textContent.trim()) };
  });
  ok('there is a link to /compress/', compress.count >= 1, JSON.stringify(compress.texts));
  // The href is "/compress/"; on a static host that serves /compress/index.html. The dev
  // server has no directory-index, so verify the actual document the link resolves to.
  const compressResolves = await cap.evaluate(async () => {
    const r = await fetch('/compress/index.html', { method: 'GET' });
    return { status: r.status, type: r.headers.get('content-type'), len: (await r.text()).length };
  });
  ok('the /compress/ tool exists and is HTML',
    compressResolves.status === 200 && /html/.test(compressResolves.type || '') && compressResolves.len > 200,
    JSON.stringify(compressResolves));

  await cap.close();

  console.log('\n── console cleanliness ─────────────────────────────────');
  ok('zero pageerrors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('zero console errors / failed requests', consoleErrors.length === 0,
    consoleErrors.join(' | ') || 'none');
  console.log(`      ${requests.length} total requests this session, all same-origin GETs`);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
